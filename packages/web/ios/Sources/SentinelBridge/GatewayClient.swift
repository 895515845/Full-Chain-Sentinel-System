/**
 * The reverse WebSocket client.
 *
 * SentinelBridge dials the console (never the other way around), says hello,
 * then answers requests until the socket dies and reconnects with backoff. All
 * device work runs on one serial ioQueue: exec/pull/push are stateful on the
 * device side (push keeps a file handle), so serialising them is the simple
 * correct choice for M1.
 *
 * Sends are synchronous from ioQueue. The completion handler runs on the
 * URLSession delegate queue, which is not the ioQueue, so this cannot deadlock;
 * it does apply backpressure, which is exactly what a 200 MB pull needs.
 */

import CryptoKit
import Foundation
import Network
import Security

final class GatewayClient: NSObject, URLSessionWebSocketDelegate, URLSessionTaskDelegate {
	private let config: BridgeConfig
	private let deviceId: String
	private let operations = DeviceOperations()
	private let ioQueue = DispatchQueue(label: "com.zgsfsec.sentinelbridge.io")
	private let stateQueue = DispatchQueue(label: "com.zgsfsec.sentinelbridge.state")

	private var session: URLSession?
	private var task: URLSessionWebSocketTask?
	private var heartbeat: Timer?
	private var reconnectAttempt = 0
	private var stopping = false
	private var tunnels: [String: Tunnel] = [:]

	init(config: BridgeConfig, deviceId: String) {
		self.config = config
		self.deviceId = deviceId
		super.init()
	}

	func start() {
		stateQueue.async { self.connect() }
	}

	func stop() {
		stateQueue.async {
			self.stopping = true
			self.heartbeat?.invalidate()
			self.heartbeat = nil
			self.task?.cancel(with: .goingAway, reason: nil)
			self.task = nil
			self.session?.invalidateAndCancel()
			self.session = nil
			self.resetDeviceState()
		}
	}

	// MARK: - Connection lifecycle

	private func connect() {
		guard !stopping else { return }
		guard let url = URL(string: config.url) else {
			log("invalid url \(config.url)")
			return
		}
		let configuration = URLSessionConfiguration.default
		configuration.timeoutIntervalForRequest = 20
		configuration.waitsForConnectivity = false
		let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
		let task = session.webSocketTask(with: url)
		self.session = session
		self.task = task
		task.resume()
		sendHello()
		receive()
		scheduleHeartbeat()
		let display = URLComponents(url: url, resolvingAgainstBaseURL: false).map { components in
			var text = "\(components.scheme ?? "")://\(components.host ?? "")"
			if let port = components.port { text += ":\(port)" }
			return text + components.path
		} ?? config.url
		log("connecting to \(display) as \(deviceId)")
	}

	private func scheduleHeartbeat() {
		DispatchQueue.main.async { [weak self] in
			guard let self else { return }
			self.heartbeat?.invalidate()
			self.heartbeat = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
				self?.sendAsync(["t": "hb"])
			}
		}
	}

	private func handleDisconnect(_ error: Error?) {
		stateQueue.async {
			guard !self.stopping else { return }
			guard self.task != nil else { return }
			self.task = nil
			self.session?.invalidateAndCancel()
			self.session = nil
			self.heartbeat?.invalidate()
			self.heartbeat = nil
			self.resetDeviceState()
			self.reconnectAttempt += 1
			let backoff = [1.0, 2.0, 5.0, 10.0, 30.0]
			let delay = backoff[min(self.reconnectAttempt - 1, backoff.count - 1)]
			let reason = error?.localizedDescription ?? "closed"
			if let close = error as? CloseReason {
				// Server-side rejections (401 token at upgrade, 4002 protocol, 4005
				// roothide) are the common cause of a reconnect loop; name them.
				log("server closed the socket: code=\(close.code) reason=\(close.reason)")
			}
			log("disconnected: \(reason); retrying in \(Int(delay))s")
			self.onStateChange?(false, "已断开：\(reason)；\(Int(delay))s 后重试")
			self.stateQueue.asyncAfter(deadline: .now() + delay) { self.connect() }
		}
	}

	/// Tunnels and pushes belong to the dead socket: drop them before reconnecting
	/// so a later tcp_open with the same ids cannot resurrect a stale NWConnection.
	private func resetDeviceState() {
		ioQueue.async {
			for tunnel in self.tunnels.values { tunnel.cancel() }
			self.tunnels.removeAll()
			self.operations.abortAllPushes()
		}
	}

	// MARK: - URLSession delegate

	func urlSession(
		_ session: URLSession,
		webSocketTask: URLSessionWebSocketTask,
		didOpenWithProtocol protocol: String?
	) {
		guard webSocketTask === task else { return }
		stateQueue.async { self.reconnectAttempt = 0 }
		log("connected")
		onStateChange?(true, "已连接，等待 hello")
	}

	func urlSession(
		_ session: URLSession,
		webSocketTask: URLSessionWebSocketTask,
		didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
		reason: Data?
	) {
		guard webSocketTask === task else { return }
		let text = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
		handleDisconnect(CloseReason(code: closeCode.rawValue, reason: text))
	}

	func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
		// A cancelled old task can report completion after a reconnect started;
		// only the current task may tear the connection down.
		guard task === self.task else { return }
		handleDisconnect(error)
	}

	/// The app target shows connection state; the CLI leaves this nil.
	var onStateChange: ((Bool, String) -> Void)?

	/// Pin the console's leaf certificate when the config carries a fingerprint.
	/// Release builds are expected to set one; without it the system trust store
	/// applies, which is why the config also refuses plaintext ws:// off-loopback.
	func urlSession(
		_ session: URLSession,
		didReceive challenge: URLAuthenticationChallenge,
		completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
	) {
		guard let pin = config.pinnedCertSha256?.lowercased().replacingOccurrences(of: ":", with: ""),
		      !pin.isEmpty,
		      challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
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
			completionHandler(.performDefaultHandling, nil)
			return
		}
		let data = SecCertificateCopyData(leaf) as Data
		let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
		if digest == pin {
			completionHandler(.useCredential, URLCredential(trust: trust))
		} else {
			log("TLS pin mismatch: got \(digest)")
			completionHandler(.cancelAuthenticationChallenge, nil)
		}
	}

	// MARK: - Frames

	private func sendHello() {
		let hello: [String: Any] = [
			"t": "hello",
			"protocol": 1,
			"platform": "ios",
			"token": config.token,
			"deviceId": deviceId,
			"model": Platform.model,
			"osVersion": Platform.osVersion,
			"build": Platform.build,
			"arch": Platform.arch,
			"jailbreak": [
				"form": Platform.form,
				"name": config.jailbreakName ?? "unknown",
				"version": config.jailbreakVersion ?? "unknown",
			],
			"hasRoot": Platform.isRoot,
			"appVersion": "0.1.4",
			"capabilities": capabilities(),
		]
		sendAsync(hello)
	}

	private func capabilities() -> [String] {
		#if canImport(UIKit)
		return ["exec", "pull", "push", "screencap", "tcp"]
		#else
		return ["exec", "pull", "push", "tcp"]
		#endif
	}

	private func receive() {
		guard let task else { return }
		task.receive { [weak self] result in
			guard let self else { return }
			switch result {
			case .success(let message):
				switch message {
				case .string(let text):
					self.handle(text)
				case .data(let data):
					if let text = String(data: data, encoding: .utf8) { self.handle(text) }
				@unknown default:
					break
				}
				self.receive()
			case .failure(let error):
				self.handleDisconnect(error)
			}
		}
	}

	private func handle(_ text: String) {
		guard let data = text.data(using: .utf8),
		      let object = try? JSONSerialization.jsonObject(with: data),
		      let frame = object as? [String: Any]
		else { return }
		ioQueue.async { self.process(frame) }
	}

	private func process(_ frame: [String: Any]) {
		guard let type = frame["t"] as? String else { return }
		switch type {
		case "welcome":
			log("hello accepted")
		case "exec":
			handleExec(frame)
		case "pull":
			handlePull(frame)
		case "push":
			handlePush(frame)
		case "screencap":
			handleScreencap(frame)
		case "apps_list":
			handleAppsList(frame)
		case "app_info":
			handleAppInfo(frame)
		case "app_bundle":
			handleAppBundle(frame)
		case "profiles_list":
			handleProfilesList(frame)
		case "install":
			handleInstall(frame)
		case "uninstall":
			handleUninstall(frame)
		case "tcp_open":
			handleTcpOpen(frame)
		case "tcp_send":
			handleTcpSend(frame)
		case "tcp_close":
			handleTcpClose(frame)
		default:
			break
		}
	}

	// MARK: - Request handlers

	private func handleExec(_ frame: [String: Any]) {
		guard let reqId = frame["reqId"] as? String, let command = frame["cmd"] as? String else { return }
		let asRoot = frame["asRoot"] as? Bool ?? false
		let timeout = ((frame["timeoutMs"] as? NSNumber)?.doubleValue ?? 30_000) / 1000
		do {
			let outcome = try operations.exec(command: command, asRoot: asRoot, timeout: timeout)
			sendResult(reqId, ok: true, code: outcome.code, stdout: outcome.stdout, stderr: outcome.stderr)
		} catch {
			sendResult(reqId, ok: false, error: String(describing: error))
		}
	}

	private func handlePull(_ frame: [String: Any]) {
		guard let reqId = frame["reqId"] as? String, let path = frame["path"] as? String else { return }
		let maxBytes = (frame["maxBytes"] as? NSNumber)?.intValue ?? 268_435_456
		var seq = 0
		do {
			let sent = try operations.pull(path: path, maxBytes: maxBytes) { data, done in
				try self.sendData(reqId, seq: seq, data: data, done: done)
				seq += 1
			}
			sendResult(reqId, ok: true, stdout: "\(sent)")
		} catch {
			sendResult(reqId, ok: false, error: String(describing: error))
		}
	}

	private func handlePush(_ frame: [String: Any]) {
		guard let reqId = frame["reqId"] as? String,
		      let path = frame["path"] as? String,
		      let b64 = frame["b64"] as? String,
		      let data = Data(base64Encoded: b64)
		else { return }
		let seq = (frame["seq"] as? NSNumber)?.intValue ?? 0
		let done = frame["done"] as? Bool ?? false
		let mode = frame["mode"] as? String
		do {
			let total = try operations.push(reqId: reqId, path: path, seq: seq, data: data, done: done, mode: mode)
			if done { sendResult(reqId, ok: true, stdout: "写入 \(total) 字节") }
		} catch {
			operations.abortPush(reqId: reqId, path: path)
			sendResult(reqId, ok: false, error: String(describing: error))
		}
	}

	private func handleScreencap(_ frame: [String: Any]) {
		guard let reqId = frame["reqId"] as? String else { return }
		do {
			let data = try operations.screencap()
			var seq = 0
			var offset = 0
			while offset < data.count {
				let end = min(offset + 524_288, data.count)
				try sendData(reqId, seq: seq, data: data.subdata(in: offset ..< end), done: end == data.count)
				seq += 1
				offset = end
			}
			sendResult(reqId, ok: true, stdout: "\(data.count)")
		} catch {
			sendResult(reqId, ok: false, error: String(describing: error))
		}
	}

	// MARK: - App inventory

	private func handleAppsList(_ frame: [String: Any]) {
		guard let reqId = frame["reqId"] as? String else { return }
		let system = frame["system"] as? Bool ?? false
		let roots = frame["roots"] as? [String]
		do {
			sendJSON(reqId, try operations.listApps(system: system, roots: roots))
		} catch {
			sendResult(reqId, ok: false, error: String(describing: error))
		}
	}

	private func handleAppInfo(_ frame: [String: Any]) {
		guard let reqId = frame["reqId"] as? String, let bundleId = frame["bundleId"] as? String else { return }
		do {
			sendJSON(reqId, try operations.appInfo(bundleId: bundleId, roots: frame["roots"] as? [String]))
		} catch {
			sendResult(reqId, ok: false, error: String(describing: error))
		}
	}

	private func handleAppBundle(_ frame: [String: Any]) {
		guard let reqId = frame["reqId"] as? String, let bundleId = frame["bundleId"] as? String else { return }
		do {
			sendJSON(reqId, try operations.bundleManifest(bundleId: bundleId, roots: frame["roots"] as? [String]))
		} catch {
			sendResult(reqId, ok: false, error: String(describing: error))
		}
	}

	private func handleProfilesList(_ frame: [String: Any]) {
		guard let reqId = frame["reqId"] as? String else { return }
		sendJSON(reqId, operations.listProfiles())
	}

	private func handleInstall(_ frame: [String: Any]) {
		guard let reqId = frame["reqId"] as? String, let path = frame["path"] as? String else { return }
		do {
			sendJSON(reqId, try operations.installIPA(path: path))
		} catch {
			sendResult(reqId, ok: false, error: String(describing: error))
		}
	}

	private func handleUninstall(_ frame: [String: Any]) {
		guard let reqId = frame["reqId"] as? String, let bundleId = frame["bundleId"] as? String else { return }
		do {
			sendJSON(reqId, try operations.uninstallApp(bundleId: bundleId))
		} catch {
			sendResult(reqId, ok: false, error: String(describing: error))
		}
	}

	private func sendJSON(_ reqId: String, _ value: Any) {
		guard JSONSerialization.isValidJSONObject(value),
		      let data = try? JSONSerialization.data(withJSONObject: value, options: [.withoutEscapingSlashes]),
		      let text = String(data: data, encoding: .utf8)
		else {
			sendResult(reqId, ok: false, error: "结果不是合法 JSON")
			return
		}
		sendResult(reqId, ok: true, stdout: text)
	}

	// MARK: - TCP tunnel

	private func tunnelKey(_ frame: [String: Any]) -> String? {
		guard let tunnelId = frame["tunnelId"] as? String, let connId = frame["connId"] as? String else { return nil }
		return "\(tunnelId):\(connId)"
	}

	private func handleTcpOpen(_ frame: [String: Any]) {
		guard let key = tunnelKey(frame),
		      let reqId = frame["reqId"] as? String,
		      let host = frame["host"] as? String,
		      let port = (frame["port"] as? NSNumber)?.uint16Value
		else { return }
		let tunnelId = frame["tunnelId"] as? String ?? ""
		let connId = frame["connId"] as? String ?? ""
		var opened = false
		let tunnel = Tunnel(
			host: host,
			port: port,
			queue: ioQueue,
			onReady: {
				opened = true
				self.sendAsync(["t": "tcp_opened", "reqId": reqId, "tunnelId": tunnelId, "connId": connId, "ok": true])
			},
			onData: { data in
				guard opened else { return }
				self.sendAsync([
					"t": "tcp_data",
					"tunnelId": tunnelId,
					"connId": connId,
					"b64": data.base64EncodedString(),
				])
			},
			onClose: {
				self.tunnels.removeValue(forKey: key)
				if opened {
					self.sendAsync(["t": "tcp_closed", "tunnelId": tunnelId, "connId": connId])
				} else {
					self.sendAsync([
						"t": "tcp_opened",
						"reqId": reqId,
						"tunnelId": tunnelId,
						"connId": connId,
						"ok": false,
						"error": "连接 \(host):\(port) 失败",
					])
				}
			}
		)
		tunnels[key] = tunnel
		tunnel.start()
	}

	private func handleTcpSend(_ frame: [String: Any]) {
		guard let key = tunnelKey(frame), let b64 = frame["b64"] as? String, let data = Data(base64Encoded: b64) else {
			return
		}
		tunnels[key]?.send(data)
	}

	private func handleTcpClose(_ frame: [String: Any]) {
		guard let key = tunnelKey(frame) else { return }
		tunnels.removeValue(forKey: key)?.cancel()
	}

	// MARK: - Sending

	private final class ErrorBox {
		var error: Error?
	}

	private func encode(_ frame: [String: Any]) throws -> String {
		let data = try JSONSerialization.data(withJSONObject: frame, options: [.withoutEscapingSlashes])
		guard let text = String(data: data, encoding: .utf8) else {
			throw DeviceError.message("frame is not valid UTF-8")
		}
		return text
	}

	private func sendSync(_ frame: [String: Any]) throws {
		guard let task else { throw DeviceError.message("not connected") }
		let text = try encode(frame)
		let semaphore = DispatchSemaphore(value: 0)
		let box = ErrorBox()
		task.send(.string(text)) { error in
			box.error = error
			semaphore.signal()
		}
		if semaphore.wait(timeout: .now() + 30) == .timedOut {
			throw DeviceError.message("send timed out")
		}
		if let error = box.error { throw error }
	}

	private func sendAsync(_ frame: [String: Any]) {
		guard let task else { return }
		guard let text = try? encode(frame) else { return }
		task.send(.string(text)) { error in
			if let error { log("send failed: \(error.localizedDescription)") }
		}
	}

	private func sendData(_ reqId: String, seq: Int, data: Data, done: Bool) throws {
		try sendSync([
			"t": "data",
			"reqId": reqId,
			"seq": seq,
			"b64": data.base64EncodedString(),
			"done": done,
		])
	}

	private func sendResult(
		_ reqId: String,
		ok: Bool,
		code: Int32? = nil,
		stdout: String? = nil,
		stderr: String? = nil,
		error: String? = nil
	) {
		var frame: [String: Any] = ["t": "result", "reqId": reqId, "ok": ok]
		if let code { frame["code"] = Int(code) }
		if let stdout { frame["stdout"] = stdout }
		if let stderr { frame["stderr"] = stderr }
		if let error { frame["error"] = error }
		do {
			try sendSync(frame)
		} catch {
			log("result send failed: \(error.localizedDescription)")
		}
	}
}

/// A close reason that survives as an Error for the reconnect log.
struct CloseReason: Error, LocalizedError {
	let code: Int
	let reason: String
	var errorDescription: String? { "websocket closed \(code) \(reason)" }
}

/// A TCP connection on the device side, bridged from the console over the WS.
final class Tunnel {
	private let host: String
	private let port: UInt16
	private let queue: DispatchQueue
	private let onReady: () -> Void
	private let onData: (Data) -> Void
	private let onClose: () -> Void
	private var connection: NWConnection?
	private var closed = false

	init(
		host: String,
		port: UInt16,
		queue: DispatchQueue,
		onReady: @escaping () -> Void,
		onData: @escaping (Data) -> Void,
		onClose: @escaping () -> Void
	) {
		self.host = host
		self.port = port
		self.queue = queue
		self.onReady = onReady
		self.onData = onData
		self.onClose = onClose
	}

	func start() {
		guard let port = NWEndpoint.Port(rawValue: port) else {
			finish()
			return
		}
		let connection = NWConnection(host: NWEndpoint.Host(host), port: port, using: .tcp)
		self.connection = connection
		connection.stateUpdateHandler = { [weak self] state in
			guard let self else { return }
			switch state {
			case .ready:
				self.onReady()
				self.receive()
			case .failed, .cancelled:
				self.finish()
			default:
				break
			}
		}
		connection.start(queue: queue)
	}

	func send(_ data: Data) {
		connection?.send(content: data, completion: .contentProcessed { _ in })
	}

	func cancel() {
		closed = true
		connection?.cancel()
	}

	private func receive() {
		connection?.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, isComplete, error in
			guard let self else { return }
			if let data, !data.isEmpty { self.onData(data) }
			if isComplete || error != nil {
				self.cancel()
				return
			}
			self.receive()
		}
	}

	private func finish() {
		if closed { return }
		closed = true
		onClose()
	}
}

/// The app target installs a sink to show the same lines in its UI; the CLI
/// leaves it nil and keeps writing to stderr.
var logSink: ((String) -> Void)?

func log(_ message: String) {
	let stamp = ISO8601DateFormatter().string(from: Date())
	FileHandle.standardError.write(Data("[\(stamp)] \(message)\n".utf8))
	logSink?("[\(stamp)] \(message)")
}
