/**
 * Owns the live GatewayClient and the persisted config.
 *
 * The local control page can start, stop and reload the bridge without killing
 * the launchd job. GatewayClient itself is single-use (stop() sets `stopping`),
 * so every start creates a fresh client and the controller keeps the process
 * alive while the page stays reachable.
 */

import Foundation

final class BridgeController {
	private let context: BridgeSetupContext
	private let queue = DispatchQueue(label: "com.zgsfsec.sentinelbridge.control")
	private let lock = NSLock()
	private var client: GatewayClient?
	private var generation = 0
	private var current: BridgeConfig?
	private var connected = false
	private var state = "未配置"
	private var lastError: String?

	init(context: BridgeSetupContext) {
		self.context = context
	}

	/// Start automatically when the persisted config is usable.
	func startIfConfigured() {
		guard (try? loadConfig()) != nil else {
			setStatus(false, "未配置：请填写 wss 地址和 token")
			return
		}
		start()
	}

	func start() {
		queue.async { self.startLocked() }
	}

	func stop() {
		queue.async {
			self.stopLocked()
			self.setStatus(false, "已停止（控制页仍在运行）")
		}
	}

	func reload() {
		start()
	}

	/// Persist a new config, then restart the connection with it.
	func save(url: String, token: String, pin: String) throws {
		let cleanURL = url.trimmingCharacters(in: .whitespacesAndNewlines)
		let cleanToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
		let cleanPin = pin.lowercased().replacingOccurrences(of: ":", with: "")
		guard var components = URLComponents(string: cleanURL),
		      components.scheme?.lowercased() == "wss",
		      let host = components.host, !host.isEmpty
		else {
			throw SetupError.message("iOS 强制 wss：地址必须是 wss://")
		}
		guard cleanToken.range(of: "^ios_[A-Za-z0-9]{8,}$", options: .regularExpression) != nil else {
			throw SetupError.message("token 格式不对，应形如 ios_...")
		}
		guard cleanPin.isEmpty || cleanPin.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
			throw SetupError.message("证书指纹必须是 64 位十六进制")
		}
		components.query = nil
		components.fragment = nil
		var config = BridgeConfig()
		config.url = components.url?.absoluteString ?? cleanURL
		config.token = cleanToken
		config.pinnedCertSha256 = cleanPin.isEmpty ? nil : cleanPin
		config.deviceId = context.deviceId
		config.jailbreakName = context.config.jailbreakName
		config.jailbreakVersion = context.config.jailbreakVersion
		let directory = (context.path as NSString).deletingLastPathComponent
		try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
		let data = try JSONEncoder().encode(config)
		try data.write(to: URL(fileURLWithPath: context.path), options: .atomic)
		try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: context.path)
		start()
	}

	func status() -> [String: Any] {
		lock.lock()
		defer { lock.unlock() }
		var value: [String: Any] = [
			"configured": current != nil,
			"connected": connected,
			"state": state,
		]
		if let current {
			value["url"] = displayURL(current.url)
			value["deviceId"] = context.deviceId
		}
		if let lastError { value["error"] = lastError }
		return value
	}

	func logTail() -> String {
		let path = "/var/log/sentinelbridge.log"
		guard let handle = FileHandle(forReadingAtPath: path) else { return "" }
		defer { try? handle.close() }
		let end = handle.seekToEndOfFile()
		let start = end > 8192 ? end - 8192 : 0
		handle.seek(toFileOffset: start)
		return String(data: handle.readDataToEndOfFile(), encoding: .utf8) ?? ""
	}

	private func loadConfig() throws -> (BridgeConfig, String) {
		var options = Options()
		options.configPath = context.path
		options.stateDir = context.stateDir
		options.deviceId = context.deviceId
		let (config, stateDir, _) = try ConfigLoader.load(options)
		return (config, stateDir)
	}

	private func startLocked() {
		stopLocked()
		do {
			let (config, stateDir) = try loadConfig()
			generation += 1
			let gen = generation
			let next = GatewayClient(config: config, deviceId: context.deviceId)
			next.onStateChange = { [weak self] online, text in
				guard let self else { return }
				self.lock.lock()
				if gen == self.generation {
					self.connected = online
					self.state = text
					self.lastError = online ? nil : text
				}
				self.lock.unlock()
			}
			lock.lock()
			current = config
			lastError = nil
			state = "连接中…"
			connected = false
			lock.unlock()
			client = next
			log("control: starting bridge to \(displayURL(config.url)) (state dir: \(stateDir))")
			next.start()
		} catch {
			setStatus(false, "配置错误：\(error)")
		}
	}

	private func stopLocked() {
		generation += 1
		client?.stop()
		client = nil
		lock.lock()
		connected = false
		lock.unlock()
	}

	private func setStatus(_ online: Bool, _ text: String) {
		lock.lock()
		connected = online
		state = text
		lastError = online ? nil : text
		lock.unlock()
	}

	private func displayURL(_ raw: String) -> String {
		guard var components = URLComponents(string: raw) else { return raw }
		components.query = nil
		return components.url?.absoluteString ?? raw
	}
}
