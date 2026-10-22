/**
 * First-run setup, served only on 127.0.0.1:9945.
 *
 * The deb has no App, so this local page is the only place to enter the token.
 * After install, Safari on the phone opens this page; the page asks for the
 * console's wss URL and an operator-created token, verifies the console's
 * self-signed certificate fingerprint, writes `sentinelbridge.json`, and
 * exits. launchd's KeepAlive restarts the daemon in normal mode.
 *
 * The listener is deliberately loopback-only: it is a root configuration
 * endpoint, and the token is the only secret it accepts. It disappears as soon
 * as pairing succeeds.
 */

import CryptoKit
import Foundation
import Network
import Security

struct ConsoleTarget {
	let origin: URL
	let websocket: String
}

final class SetupServer {
	private let context: BridgeSetupContext
	private let queue = DispatchQueue(label: "com.zgsfsec.sentinelbridge.setup")
	private var listener: NWListener?
	private var attempts = 0
	private var lockedUntil = Date.distantPast

	init(context: BridgeSetupContext) {
		self.context = context
	}

	func start() throws {
		guard let port = NWEndpoint.Port(rawValue: 9945) else {
			throw SetupError.message("配对端口 9945 不可用")
		}
		let parameters = NWParameters.tcp
		parameters.allowLocalEndpointReuse = true
		// Bind only the device's loopback; no LAN client may reach the root
		// configuration endpoint.
		parameters.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host("127.0.0.1"), port: port)
		let listener = try NWListener(using: parameters)
		self.listener = listener

		let ready = DispatchSemaphore(value: 0)
		var startError: Error?
		listener.stateUpdateHandler = { state in
			switch state {
			case .ready:
				ready.signal()
			case .failed(let error):
				startError = error
				ready.signal()
			default:
				break
			}
		}
		listener.newConnectionHandler = { [weak self] connection in
			self?.accept(connection)
		}
		listener.start(queue: queue)
		if ready.wait(timeout: .now() + 4) == .timedOut {
			listener.cancel()
			throw SetupError.message("配对页启动超时（端口 9945 可能被占用）")
		}
		if let startError {
			throw SetupError.message("配对页无法监听 127.0.0.1:9945：\(startError.localizedDescription)")
		}
	}

	private func accept(_ connection: NWConnection) {
		connection.start(queue: queue)
		read(connection, buffer: Data())
	}

	private func read(_ connection: NWConnection, buffer: Data) {
		connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
			guard let self else { return }
			var next = buffer
			if let data { next.append(data) }
			if next.count > 128 * 1024 {
				self.sendJSON(connection, status: 413, object: ["error": "请求过大"])
				return
			}
			if let headerEnd = next.range(of: Data("\r\n\r\n".utf8)) {
				let head = String(data: next[..<headerEnd.lowerBound], encoding: .utf8) ?? ""
				let contentLength = self.contentLength(head)
				let bodyStart = headerEnd.upperBound
				let available = next.count - bodyStart
				if available < contentLength {
					if error != nil || isComplete {
						connection.cancel()
						return
					}
					self.read(connection, buffer: next)
					return
				}
				let body = next.subdata(in: bodyStart ..< (bodyStart + contentLength))
				self.route(connection, head: head, body: body)
				return
			}
			if error != nil || isComplete {
				connection.cancel()
				return
			}
			self.read(connection, buffer: next)
		}
	}

	private func contentLength(_ head: String) -> Int {
		for line in head.split(separator: "\r\n") {
			let parts = line.split(separator: ":", maxSplits: 1)
			guard parts.count == 2, parts[0].trimmingCharacters(in: .whitespaces).lowercased() == "content-length" else {
				continue
			}
			return Int(parts[1].trimmingCharacters(in: .whitespaces)) ?? 0
		}
		return 0
	}

	private func route(_ connection: NWConnection, head: String, body: Data) {
		let requestLine = head.split(separator: "\r\n").first.map(String.init) ?? ""
		let parts = requestLine.split(separator: " ")
		guard parts.count >= 2 else {
			sendJSON(connection, status: 400, object: ["error": "非法请求"])
			return
		}
		let method = String(parts[0])
		let path = String(parts[1])
		if method == "GET", path == "/" || path == "/setup" {
			sendHTML(connection, html: Self.page)
			return
		}
		guard method == "POST" else {
			sendJSON(connection, status: 404, object: ["error": "not found"])
			return
		}
		let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
		switch path {
		case "/api/setup/probe":
			let raw = (json["url"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
			probe(raw) { [weak self] result in
				guard let self else { return }
				switch result {
				case .success(let target):
					self.probeCertificate(target) { probe in
						switch probe {
						case .success(let fingerprint):
							self.sendJSON(connection, status: 200, object: [
								"ok": true,
								"fingerprint": fingerprint,
								"websocket": target.websocket,
								"host": target.origin.host ?? "",
							])
						case .failure(let error):
							self.sendJSON(connection, status: 502, object: ["error": error.localizedDescription])
						}
					}
				case .failure(let error):
					self.sendJSON(connection, status: 400, object: ["error": error.localizedDescription])
				}
			}
		case "/api/setup/pair":
			let raw = (json["url"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
			let token = (json["token"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
			let fingerprint = (json["fingerprint"] as? String ?? "").lowercased().replacingOccurrences(of: ":", with: "")
			guard token.range(of: "^ios_[A-Za-z0-9]{8,}$", options: .regularExpression) != nil else {
				sendJSON(connection, status: 400, object: ["error": "token 格式不对，应形如 ios_..." ])
				return
			}
			guard fingerprint.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
				sendJSON(connection, status: 400, object: ["error": "请先检测证书指纹，并确认与控制台一致"])
				return
			}
			guard !pairLocked() else {
				sendJSON(connection, status: 429, object: ["error": "尝试过于频繁，请稍后再试"])
				return
			}
			probe(raw) { [weak self] result in
				guard let self else { return }
				switch result {
				case .success(let target):
					self.probeCertificate(target, expected: fingerprint) { probe in
						switch probe {
						case .success:
							do {
								try self.writeConfig(target: target, token: token, fingerprint: fingerprint)
								self.sendJSON(connection, status: 200, object: ["ok": true])
								log("配对成功，配置已写入；准备重启")
								DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { exit(0) }
							} catch {
								self.sendJSON(connection, status: 500, object: ["error": "写入配置失败：\(error.localizedDescription)"])
							}
						case .failure(let error):
							self.sendJSON(connection, status: 400, object: ["error": error.localizedDescription])
						}
					}
				case .failure(let error):
					self.sendJSON(connection, status: 400, object: ["error": error.localizedDescription])
				}
			}
		default:
			sendJSON(connection, status: 404, object: ["error": "not found"])
		}
	}

	private func pairLocked() -> Bool {
		if Date() < lockedUntil { return true }
		attempts += 1
		if attempts > 10 {
			lockedUntil = Date().addingTimeInterval(60)
			attempts = 0
			return true
		}
		return false
	}

	// MARK: - URL parsing

	private func probe(_ raw: String, completion: @escaping (Result<ConsoleTarget, Error>) -> Void) {
		do {
			let target = try Self.parseConsoleURL(raw)
			completion(.success(target))
		} catch {
			completion(.failure(error))
		}
	}

	static func parseConsoleURL(_ raw: String) throws -> ConsoleTarget {
		guard var components = URLComponents(string: raw), let scheme = components.scheme?.lowercased(),
		      scheme == "https" || scheme == "wss",
		      let host = components.host, !host.isEmpty
		else {
			throw SetupError.message("iOS 强制 wss：控制台地址必须是 https:// 或 wss://")
		}
		components.scheme = "https"
		components.query = nil
		components.fragment = nil
		var path = components.path
		if path.hasSuffix("/ws/ios") { path = String(path.dropLast("/ws/ios".count)) }
		if path.hasSuffix("/") { path = String(path.dropLast()) }
		components.path = path
		guard let origin = components.url else {
			throw SetupError.message("控制台地址不合法")
		}
		var ws = URLComponents(url: origin, resolvingAgainstBaseURL: false)
		ws?.scheme = "wss"
		ws?.path = path + "/ws/ios"
		guard let websocket = ws?.url?.absoluteString else {
			throw SetupError.message("控制台地址不合法")
		}
		return ConsoleTarget(origin: origin, websocket: websocket)
	}

	// MARK: - TLS fingerprint

	private func probeCertificate(
		_ target: ConsoleTarget,
		expected: String? = nil,
		completion: @escaping (Result<String, Error>) -> Void
	) {
		let delegate = PinSessionDelegate(allowAny: expected == nil, expected: expected)
		let configuration = URLSessionConfiguration.ephemeral
		configuration.timeoutIntervalForRequest = 8
		let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
		let task = session.dataTask(with: target.origin) { _, _, _ in
			session.finishTasksAndInvalidate()
			guard let fingerprint = delegate.fingerprint else {
				completion(.failure(SetupError.message("无法读取控制台证书：请确认地址可达、端口正确")))
				return
			}
			if let expected, fingerprint != expected {
				completion(.failure(SetupError.message("证书指纹与控制台显示不一致")))
				return
			}
			completion(.success(fingerprint))
		}
		task.resume()
	}

	private func writeConfig(target: ConsoleTarget, token: String, fingerprint: String) throws {
		var config = BridgeConfig()
		config.url = target.websocket
		config.token = token
		config.pinnedCertSha256 = fingerprint.isEmpty ? nil : fingerprint
		config.deviceId = context.deviceId
		config.jailbreakName = context.config.jailbreakName
		config.jailbreakVersion = context.config.jailbreakVersion
		let directory = (context.path as NSString).deletingLastPathComponent
		try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
		let data = try JSONEncoder().encode(config)
		try data.write(to: URL(fileURLWithPath: context.path), options: .atomic)
		try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: context.path)
	}

	// MARK: - HTTP responses

	private func sendJSON(_ connection: NWConnection, status: Int, object: [String: Any]) {
		let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
		send(connection, status: status, contentType: "application/json; charset=utf-8", body: data)
	}

	private func sendHTML(_ connection: NWConnection, html: String) {
		send(connection, status: 200, contentType: "text/html; charset=utf-8", body: Data(html.utf8))
	}

	private func send(_ connection: NWConnection, status: Int, contentType: String, body: Data) {
		let head = "HTTP/1.1 \(status) \(status == 200 ? "OK" : "Error")\r\nContent-Type: \(contentType)\r\nContent-Length: \(body.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
		var payload = Data(head.utf8)
		payload.append(body)
		connection.send(content: payload, completion: .contentProcessed { _ in
			connection.cancel()
		})
	}

	private static let page = """
<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SentinelBridge 配对</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#0d1117;color:#c9d1d9;font:15px/1.6 -apple-system,system-ui,sans-serif}
main{max-width:560px;margin:0 auto;padding:24px 18px 48px}h1{font-size:22px;margin:8px 0 4px}p{color:#8b949e;margin:8px 0}
label{display:block;margin:16px 0 6px;font-size:13px;color:#8b949e}input{width:100%;padding:11px 12px;border:1px solid #30363d;border-radius:8px;background:#161b22;color:#c9d1d9;font-size:16px}
input[readonly]{color:#58a6ff}button{width:100%;margin-top:14px;padding:12px;border:0;border-radius:8px;background:#238636;color:#fff;font-size:16px}
button.secondary{background:#21262d;border:1px solid #30363d}button:disabled{opacity:.45}
.row{display:flex;gap:10px}.row>*{flex:1}
.note{margin-top:18px;padding:12px;border:1px solid #30363d;border-radius:8px;background:#161b22;color:#8b949e;font-size:13px}
.ok{color:#3fb950}.err{color:#f85149}code{color:#58a6ff}
</style></head><body><main>
<h1>SentinelBridge 配对</h1>
<p>只在本机回环地址监听。iOS 强制 wss：填入控制台 wss 地址、控制台创建的 token，确认证书指纹后写入配置。</p>
<label>控制台地址</label>
<input id="url" placeholder="https://console.example.com:9443" autocomplete="off" spellcheck="false">
<label>访问令牌 token</label>
<input id="token" placeholder="ios_..." autocomplete="off" spellcheck="false">
<label>控制台证书 SHA-256</label>
<input id="fingerprint" readonly placeholder="先点“检测证书”">
<div class="row"><button class="secondary" id="probe">检测证书</button><button id="pair" disabled>配对</button></div>
<label style="display:flex;gap:8px;align-items:flex-start;margin-top:16px"><input type="checkbox" id="confirm" style="width:18px;margin-top:4px"> 我已核对指纹与控制台“iOS 设备”页显示的一致</label>
<div class="note" id="status">等待操作。</div>
<script>
const $ = (id) => document.getElementById(id);
const statusEl = $("status");
function show(text, ok) { statusEl.textContent = text; statusEl.className = "note " + (ok ? "ok" : "err"); }
async function post(path, body) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || "请求失败");
  return data;
}
$("probe").onclick = async () => {
  $("pair").disabled = true;
  try {
    const data = await post("/api/setup/probe", { url: $("url").value.trim() });
    $("fingerprint").value = data.fingerprint || "";
    show("证书指纹已读取，请与控制台显示的值核对。", true);
  } catch (error) { show(error.message, false); }
};
$("confirm").onchange = () => { $("pair").disabled = !($("confirm").checked && $("fingerprint").value && $("token").value.trim()); };
$("token").oninput = () => { $("pair").disabled = !($("confirm").checked && $("fingerprint").value && $("token").value.trim()); };
$("pair").onclick = async () => {
  $("pair").disabled = true;
  try {
    await post("/api/setup/pair", { url: $("url").value.trim(), token: $("token").value.trim(), fingerprint: $("fingerprint").value.trim() });
    show("配对成功，设备将重启并连接控制台。", true);
    $("pair").textContent = "已配对";
  } catch (error) { show(error.message, false); $("pair").disabled = false; }
};
</script></main></body></html>
"""
}

final class PinSessionDelegate: NSObject, URLSessionDelegate {
	private let allowAny: Bool
	private let expected: String?
	private let lock = NSLock()
	private var stored: String?

	init(allowAny: Bool, expected: String?) {
		self.allowAny = allowAny
		self.expected = expected?.lowercased().replacingOccurrences(of: ":", with: "")
	}

	var fingerprint: String? {
		lock.lock()
		defer { lock.unlock() }
		return stored
	}

	func urlSession(
		_ session: URLSession,
		didReceive challenge: URLAuthenticationChallenge,
		completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
	) {
		guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
		      let trust = challenge.protectionSpace.serverTrust
		else {
			completionHandler(.performDefaultHandling, nil)
			return
		}
		let leaf: SecCertificate?
		if #available(iOS 15.0, macOS 12.0, *) {
			leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first
		} else {
			leaf = SecTrustGetCertificateAtIndex(trust, 0)
		}
		guard let leaf else {
			completionHandler(.cancelAuthenticationChallenge, nil)
			return
		}
		let data = SecCertificateCopyData(leaf) as Data
		let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
		lock.lock()
		stored = digest
		lock.unlock()
		if allowAny || expected == digest {
			completionHandler(.useCredential, URLCredential(trust: trust))
		} else {
			completionHandler(.cancelAuthenticationChallenge, nil)
		}
	}
}

enum SetupError: Error, LocalizedError {
	case message(String)

	var errorDescription: String? {
		switch self {
		case .message(let text): return text
		}
	}
}
