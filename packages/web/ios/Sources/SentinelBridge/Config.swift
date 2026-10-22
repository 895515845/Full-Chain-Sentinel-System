/**
 * Configuration and platform facts.
 *
 * The daemon has to find the same things on two jailbreak layouts and on a
 * developer's Mac (the host smoke test), so every path decision lives here
 * rather than being scattered through the transport.
 *
 * rootful:   /usr/bin, /Library/LaunchDaemons, /etc/sentinelbridge.json
 * rootless:  /var/jb/usr/bin, /var/jb/Library/LaunchDaemons,
 *            /var/jb/etc/sentinelbridge.json
 *
 * roothide is refused by the console at hello; the daemon still probes it and
 * reports "roothide" so the failure is visible on the device too.
 */

import Foundation
#if canImport(UIKit)
import UIKit
#endif

struct BridgeConfig: Codable {
	var url: String = ""
	var token: String = ""
	var pinnedCertSha256: String?
	var jailbreakName: String?
	var jailbreakVersion: String?
	var deviceId: String?
}

struct Options {
	var configPath: String?
	var stateDir: String?
	var url: String?
	var token: String?
	var deviceId: String?
	var pin: String?
	var setup = false
	var showHelp = false
}

enum ConfigError: Error, CustomStringConvertible {
	case message(String)

	var description: String {
		switch self {
		case .message(let text): return text
		}
	}
}

enum Platform {
	static var isRootless: Bool {
		FileManager.default.fileExists(atPath: "/var/jb")
	}

	static var isRoot: Bool {
		geteuid() == 0
	}

	static var form: String {
		// roothide randomises the jailbreak root per process; nothing under
		// /var/jb is stable, so reporting it is more honest than guessing.
		if FileManager.default.fileExists(atPath: "/var/jb") {
			if FileManager.default.fileExists(atPath: "/var/jb/.roothide") { return "roothide" }
			return "rootless"
		}
		if FileManager.default.fileExists(atPath: "/usr/libexec/cydia") { return "rootful" }
		if isRoot && FileManager.default.fileExists(atPath: "/Library/LaunchDaemons") { return "rootful" }
		return "unknown"
	}

	static var defaultConfigPath: String {
		if isRootless { return "/var/jb/etc/sentinelbridge.json" }
		return "/etc/sentinelbridge.json"
	}

	static func defaultStateDir() -> String {
		if isRootless { return "/var/jb/var/lib/sentinelbridge" }
		if isRoot { return "/var/lib/sentinelbridge" }
		// Host smoke test: never write to /var/lib as a normal user.
		return NSTemporaryDirectory() + "sentinelbridge"
	}

	static var shellPath: String {
		let rootless = "/var/jb/usr/bin/sh"
		if FileManager.default.fileExists(atPath: rootless) { return rootless }
		return "/bin/sh"
	}

	static var osVersion: String {
		#if canImport(UIKit)
		return UIDevice.current.systemVersion
		#else
		let version = ProcessInfo.processInfo.operatingSystemVersion
		return "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
		#endif
	}

	static var build: String {
		sysctlString("kern.osversion")
	}

	static var model: String {
		#if canImport(UIKit)
		let machine = sysctlString("hw.machine")
		return machine.isEmpty ? UIDevice.current.model : machine
		#else
		return sysctlString("hw.machine")
		#endif
	}

	static var arch: String {
		#if arch(arm64)
		return "arm64"
		#elseif arch(x86_64)
		return "x86_64"
		#else
		return "unknown"
		#endif
	}

	/// Read a sysctl string; empty when the key is absent (macOS lacks some iOS keys).
	static func sysctlString(_ name: String) -> String {
		var size = 0
		guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return "" }
		var buffer = [CChar](repeating: 0, count: size + 1)
		guard sysctlbyname(name, &buffer, &size, nil, 0) == 0 else { return "" }
		return String(cString: buffer)
	}
}

struct BridgeSetupContext {
	let path: String
	let stateDir: String
	let deviceId: String
	let config: BridgeConfig
}

enum ConfigLoader {
	static func parse(_ arguments: [String]) throws -> Options {
		var options = Options()
		var index = 1
		func value(_ flag: String, _ inline: String?) throws -> String {
			if let inline, !inline.isEmpty { return inline }
			guard index + 1 < arguments.count else { throw ConfigError.message("\(flag) 缺少参数值") }
			index += 1
			return arguments[index]
		}
		while index < arguments.count {
			let argument = arguments[index]
			let parts = argument.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
			let flag = String(parts[0])
			let inline = parts.count > 1 ? String(parts[1]) : nil
			switch flag {
			case "--config":
				options.configPath = try value(flag, inline)
			case "--state-dir":
				options.stateDir = try value(flag, inline)
			case "--url":
				options.url = try value(flag, inline)
			case "--token":
				options.token = try value(flag, inline)
			case "--device-id":
				options.deviceId = try value(flag, inline)
					case "--pin":
				options.pin = try value(flag, inline)
			case "--setup":
				options.setup = true
			case "--help", "-h":
				options.showHelp = true
			default:
				throw ConfigError.message("未知参数：\(flag)（--help 查看用法）")
			}
			index += 1
		}
		return options
	}

	static func usage() -> String {
		"""
		sentinelbridged — SentinelBridge iOS daemon

		用法：
		  sentinelbridged [--config 路径] [--state-dir 目录]
		                  [--url ws(s)://控制台/ws/ios] [--token ios_...]
		                  [--device-id id] [--pin SHA256]

		默认配置路径（rootless 优先）：
		  /var/jb/etc/sentinelbridge.json
		  /etc/sentinelbridge.json

		配置示例：
		  {
		    "url": "wss://console.example.com/ws/ios",
		    "token": "ios_...",
		    "pinnedCertSha256": "控制台证书叶证书的 SHA-256（十六进制）",
		    "jailbreakName": "Dopamine",
		    "jailbreakVersion": "2.0"
		  }
		"""
	}

	/// The pieces setup mode needs before a valid config exists: config path,
	/// state directory, device ID, and whatever config is already on disk.
	static func context(_ options: Options) throws -> BridgeSetupContext {
		let path = options.configPath ?? Platform.defaultConfigPath
		var config = BridgeConfig()
		if let data = FileManager.default.contents(atPath: path),
		   let decoded = try? JSONDecoder().decode(BridgeConfig.self, from: data) {
			config = decoded
		}
		let stateDir = options.stateDir ?? Platform.defaultStateDir()
		do {
			try FileManager.default.createDirectory(atPath: stateDir, withIntermediateDirectories: true)
		} catch {
			throw ConfigError.message("无法创建状态目录 \(stateDir)：\(error.localizedDescription)")
		}
		if let id = options.deviceId, !id.isEmpty {
			return BridgeSetupContext(path: path, stateDir: stateDir, deviceId: id, config: config)
		}
		if let id = config.deviceId, !id.isEmpty {
			return BridgeSetupContext(path: path, stateDir: stateDir, deviceId: id, config: config)
		}
		let idPath = stateDir + "/device-id"
		if let existing = try? String(contentsOfFile: idPath, encoding: .utf8)
			.trimmingCharacters(in: .whitespacesAndNewlines), !existing.isEmpty {
			return BridgeSetupContext(path: path, stateDir: stateDir, deviceId: existing, config: config)
		}
		let generated = UUID().uuidString
		do {
			try generated.write(toFile: idPath, atomically: true, encoding: .utf8)
			try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: idPath)
		} catch {
			throw ConfigError.message("无法写入 device-id：\(error.localizedDescription)")
		}
		return BridgeSetupContext(path: path, stateDir: stateDir, deviceId: generated, config: config)
	}

	static func load(_ options: Options) throws -> (BridgeConfig, String, String) {
		var config = BridgeConfig()
		let path = options.configPath ?? Platform.defaultConfigPath
		if options.configPath != nil || FileManager.default.fileExists(atPath: path) {
			guard let data = FileManager.default.contents(atPath: path) else {
				throw ConfigError.message("读不到配置文件：\(path)")
			}
			do {
				config = try JSONDecoder().decode(BridgeConfig.self, from: data)
			} catch {
				throw ConfigError.message("配置文件不是合法 JSON：\(path)（\(error.localizedDescription)）")
			}
		}
		if let url = options.url { config.url = url }
		if let token = options.token { config.token = token }
		if let pin = options.pin { config.pinnedCertSha256 = pin }
		if let id = options.deviceId { config.deviceId = id }

		guard var parsed = URL(string: config.url), let scheme = parsed.scheme,
		      scheme == "wss", parsed.host != nil
		else {
			throw ConfigError.message("iOS 强制 wss：配置里的 url 必须是 wss:// 地址")
		}
		guard !config.token.isEmpty else {
			throw ConfigError.message("配置里缺少 token（在控制台「iOS 设备」页创建）")
		}
		// The console authenticates the upgrade by query token, before the hello
		// frame exists. Accept a URL that already carries one, but make the config
		// token authoritative so a rotated token only has to change in one place.
		if var components = URLComponents(url: parsed, resolvingAgainstBaseURL: false) {
			var items = (components.queryItems ?? []).filter { $0.name != "token" }
			items.append(URLQueryItem(name: "token", value: config.token))
			components.queryItems = items
			if let built = components.url { parsed = built; config.url = built.absoluteString }
		}

		let stateDir = options.stateDir ?? Platform.defaultStateDir()
		do {
			try FileManager.default.createDirectory(atPath: stateDir, withIntermediateDirectories: true)
		} catch {
			throw ConfigError.message("无法创建状态目录 \(stateDir)：\(error.localizedDescription)")
		}
		if let id = config.deviceId, !id.isEmpty {
			return (config, stateDir, id)
		}
		let idPath = stateDir + "/device-id"
		if let existing = try? String(contentsOfFile: idPath, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
		   !existing.isEmpty {
			return (config, stateDir, existing)
		}
		let generated = UUID().uuidString
		do {
			try generated.write(toFile: idPath, atomically: true, encoding: .utf8)
			try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: idPath)
		} catch {
			throw ConfigError.message("无法写入 device-id：\(error.localizedDescription)")
		}
		return (config, stateDir, generated)
	}
}
