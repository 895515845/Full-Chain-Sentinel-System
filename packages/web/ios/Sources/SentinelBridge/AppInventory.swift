/**
 * Installed-app inventory and provisioning profiles.
 *
 * Everything here is read-only except install/uninstall, which are thin
 * wrappers around the jailbreak's installer. The device never builds an IPA:
 * `bundleManifest` returns a file list and the console pulls the files and zips
 * them, so a phone without `zip` can still produce an IPA.
 */

import Foundation

extension DeviceOperations {
	/// Roots scanned for `.app` bundles. The env override exists for the host
	/// contract test; on a device the two defaults cover user and system apps.
	func appRoots(_ explicit: [String]?) -> [(path: String, system: Bool)] {
		if let explicit, !explicit.isEmpty {
			return explicit.map { ($0, $0.hasPrefix("/Applications")) }
		}
		if let env = ProcessInfo.processInfo.environment["SENTINELBRIDGE_APP_ROOTS"], !env.isEmpty {
			return env.split(separator: ":").map { (String($0), String($0).hasPrefix("/Applications")) }
		}
		return [("/var/containers/Bundle/Application", false), ("/Applications", true)]
	}

	func listApps(system: Bool, roots: [String]?) throws -> [[String: Any]] {
		var records: [[String: Any]] = []
		for root in appRoots(roots) {
			if !system && root.system { continue }
			for app in appBundles(under: root.path) {
				guard let plist = infoPlist(at: app + "/Info.plist") else { continue }
				guard let bundleId = plist["CFBundleIdentifier"] as? String, !bundleId.isEmpty else { continue }
				records.append([
					"bundleId": bundleId,
					"name": displayName(plist) ,
					"version": plist["CFBundleShortVersionString"] as? String ?? "",
					"build": plist["CFBundleVersion"] as? String ?? "",
					"minimumOS": plist["MinimumOSVersion"] as? String ?? "",
					"executable": plist["CFBundleExecutable"] as? String ?? "",
					"path": app,
					"type": root.system ? "system" : "user",
				])
			}
		}
		return records.sorted { ($0["bundleId"] as? String ?? "") < ($1["bundleId"] as? String ?? "") }
	}

	func appInfo(bundleId: String, roots: [String]?) throws -> [String: Any] {
		let app = try findApp(bundleId: bundleId, roots: roots)
		guard let plist = infoPlist(at: app + "/Info.plist") else {
			throw DeviceError.message("读不到 Info.plist：\(app)")
		}
		let executable = plist["CFBundleExecutable"] as? String ?? ""
		let executablePath = executable.isEmpty ? "" : app + "/" + executable
		var info: [String: Any] = [
			"bundleId": bundleId,
			"name": displayName(plist),
			"version": plist["CFBundleShortVersionString"] as? String ?? "",
			"build": plist["CFBundleVersion"] as? String ?? "",
			"minimumOS": plist["MinimumOSVersion"] as? String ?? "",
			"platform": plist["CFBundleSupportedPlatforms"] as? [String] ?? [],
			"deviceFamily": plist["UIDeviceFamily"] as? [Int] ?? [],
			"executable": executable,
			"path": app,
			"bundleSize": directorySize(app),
			"frameworks": frameworks(app),
			"urlSchemes": urlSchemes(plist),
			"hasEmbeddedProvision": FileManager.default.fileExists(atPath: app + "/embedded.mobileprovision"),
			"hasCodeSignature": FileManager.default.fileExists(atPath: app + "/_CodeSignature/CodeResources"),
			"containerPath": dataContainer(bundleId: bundleId) ?? "",
		]
		if !executablePath.isEmpty, let mach = MachO.read(path: executablePath) {
			info["arch"] = mach.arch
			info["cryptid"] = mach.cryptid
			info["is64"] = mach.is64
			info["pie"] = mach.pie
		}
		if !executablePath.isEmpty, let entitlements = entitlements(path: executablePath) {
			info["entitlements"] = entitlements
		}
		if let provision = profilePlist(at: app + "/embedded.mobileprovision") {
			info["provisionUUID"] = provision["UUID"] as? String ?? ""
			info["provisionName"] = provision["Name"] as? String ?? ""
			info["provisionExpiration"] = jsonSafe(provision["ExpirationDate"] ?? "")
			if let entitlements = provision["Entitlements"] as? [String: Any] {
				info["provisionEntitlements"] = jsonSafe(entitlements)
				info["provisionApplicationIdentifier"] = entitlements["application-identifier"] as? String ?? ""
			}
		}
		return info
	}

	/// Files that make up the app bundle, for the console to pull and zip.
	func bundleManifest(bundleId: String, roots: [String]?) throws -> [String: Any] {
		let app = try findApp(bundleId: bundleId, roots: roots)
		guard let enumerator = FileManager.default.enumerator(atPath: app) else {
			throw DeviceError.message("无法遍历 \(app)")
		}
		var entries: [[String: Any]] = []
		var total = 0
		for case let relative as String in enumerator {
			let full = app + "/" + relative
			var isDirectory: ObjCBool = false
			guard FileManager.default.fileExists(atPath: full, isDirectory: &isDirectory) else { continue }
			if isDirectory.boolValue { continue }
			if let link = try? FileManager.default.destinationOfSymbolicLink(atPath: full) {
				entries.append(["rel": relative, "symlink": link, "size": 0, "mode": "120777"])
				continue
			}
			let attributes = try FileManager.default.attributesOfItem(atPath: full)
			let size = (attributes[.size] as? NSNumber)?.intValue ?? 0
			let permissions = (attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0o644
			total += size
			entries.append(["rel": relative, "size": size, "mode": String(format: "%o", permissions)])
			if entries.count >= 20_000 || total > 2_147_483_648 {
				throw DeviceError.message("应用文件太多或太大（\(entries.count) 个 / \(total) 字节），M2 只支持常规大小的 App")
			}
		}
		return ["appPath": app, "bundleId": bundleId, "entries": entries]
	}

	func listProfiles() -> [[String: Any]] {
		var directories = ["/var/MobileDevice/ProvisioningProfiles"]
		if let groups = try? FileManager.default.contentsOfDirectory(atPath: "/var/containers/Shared/SystemGroup") {
			for group in groups {
				directories.append("/var/containers/Shared/SystemGroup/\(group)/Library/MobileDevice/ProvisioningProfiles")
			}
		}
		var records: [[String: Any]] = []
		for directory in directories {
			guard let names = try? FileManager.default.contentsOfDirectory(atPath: directory) else { continue }
			for name in names where !name.hasPrefix(".") {
				let path = directory + "/" + name
				let attributes = try? FileManager.default.attributesOfItem(atPath: path)
				var record: [String: Any] = [
					"file": name,
					"path": path,
					"size": (attributes?[.size] as? NSNumber)?.intValue ?? 0,
				]
				if let modified = attributes?[.modificationDate] as? Date {
					record["modified"] = ISO8601DateFormatter().string(from: modified)
				}
				if let plist = profilePlist(at: path) {
					record["uuid"] = plist["UUID"] as? String ?? ""
					record["name"] = plist["Name"] as? String ?? ""
					record["team"] = (plist["TeamIdentifier"] as? [String])?.first ?? ""
					if let expiration = plist["ExpirationDate"] as? Date {
						record["expiration"] = ISO8601DateFormatter().string(from: expiration)
					} else {
						record["expiration"] = plist["ExpirationDate"] as? String ?? ""
					}
					record["provisionsAllDevices"] = plist["ProvisionsAllDevices"] as? Bool ?? false
				}
				records.append(record)
			}
		}
		return records.sorted { ($0["file"] as? String ?? "") < ($1["file"] as? String ?? "") }
	}

	func installIPA(path: String) throws -> [String: Any] {
		guard FileManager.default.fileExists(atPath: path) else {
			throw DeviceError.message("设备上没有这个文件：\(path)")
		}
		let tools = [
			"/var/jb/usr/bin/appinst",
			"/usr/bin/appinst",
			"/var/jb/usr/bin/ipainstaller",
			"/usr/bin/ipainstaller",
		]
		guard let tool = tools.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
			throw DeviceError.message("设备上找不到 appinst 或 ipainstaller；请先安装（Sileo 搜索 appinst）")
		}
		let outcome = try runShell("\(tool) \(shellQuote(path))", timeout: 300)
		return ["tool": tool, "code": Int(outcome.code), "stdout": outcome.stdout, "stderr": outcome.stderr]
	}

	func uninstallApp(bundleId: String) throws -> [String: Any] {
		let tools = [
			("/var/jb/usr/bin/appinst", "-u"),
			("/usr/bin/appinst", "-u"),
			("/var/jb/usr/bin/ipainstaller", "-u"),
			("/usr/bin/ipainstaller", "-u"),
		]
		guard let (tool, flag) = tools.first(where: { FileManager.default.isExecutableFile(atPath: $0.0) }) else {
			throw DeviceError.message("设备上找不到 appinst 或 ipainstaller；无法卸载")
		}
		let outcome = try runShell("\(tool) \(flag) \(shellQuote(bundleId))", timeout: 120)
		return ["tool": tool, "code": Int(outcome.code), "stdout": outcome.stdout, "stderr": outcome.stderr]
	}

	// MARK: - Helpers

	private func appBundles(under root: String) -> [String] {
		guard let entries = try? FileManager.default.contentsOfDirectory(atPath: root) else { return [] }
		var bundles: [String] = []
		for entry in entries {
			let path = root + "/" + entry
			if entry.hasSuffix(".app") {
				bundles.append(path)
				continue
			}
			var isDirectory: ObjCBool = false
			guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue else { continue }
			if let nested = try? FileManager.default.contentsOfDirectory(atPath: path) {
				for child in nested where child.hasSuffix(".app") {
					bundles.append(path + "/" + child)
				}
			}
		}
		return bundles
	}

	private func findApp(bundleId: String, roots: [String]?) throws -> String {
		if bundleId.contains("/"), FileManager.default.fileExists(atPath: bundleId) {
			return bundleId
		}
		for root in appRoots(roots) {
			for app in appBundles(under: root.path) {
				guard let plist = infoPlist(at: app + "/Info.plist") else { continue }
				if plist["CFBundleIdentifier"] as? String == bundleId { return app }
			}
		}
		throw DeviceError.message("找不到已安装的 App：\(bundleId)")
	}

	private func infoPlist(at path: String) -> [String: Any]? {
		guard let data = FileManager.default.contents(atPath: path) else { return nil }
		if let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] {
			return plist
		}
		return nil
	}

	/// Provisioning profiles are CMS/PKCS#7 signed: the plist is embedded as a
	/// byte string, not as a bare plist. iOS has no public CMSDecoder, so scan
	/// for the embedded XML (the common form) or a binary plist header.
	private func profilePlist(at path: String) -> [String: Any]? {
		guard let data = FileManager.default.contents(atPath: path) else { return nil }
		if let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] {
			return plist
		}
		if let start = data.range(of: Data("<?xml".utf8)) {
			let tail = data.subdata(in: start.lowerBound ..< data.count)
			if let end = tail.range(of: Data("</plist>".utf8)) {
				let xml = tail.subdata(in: 0 ..< end.upperBound)
				if let plist = try? PropertyListSerialization.propertyList(from: xml, format: nil) as? [String: Any] {
					return plist
				}
			}
		}
		if let start = data.range(of: Data("bplist00".utf8)) {
			let tail = data.subdata(in: start.lowerBound ..< data.count)
			if let plist = try? PropertyListSerialization.propertyList(from: tail, format: nil) as? [String: Any] {
				return plist
			}
		}
		return nil
	}

	/// JSONSerialization refuses Date, so plist dates are turned into ISO strings
	/// before they reach a result frame.
	private func jsonSafe(_ value: Any) -> Any {
		if let date = value as? Date { return ISO8601DateFormatter().string(from: date) }
		if let dict = value as? [String: Any] {
			var out: [String: Any] = [:]
			for (key, item) in dict { out[key] = jsonSafe(item) }
			return out
		}
		if let array = value as? [Any] { return array.map { jsonSafe($0) } }
		return value
	}

	private func displayName(_ plist: [String: Any]) -> String {
		plist["CFBundleDisplayName"] as? String ?? plist["CFBundleName"] as? String ?? plist["CFBundleIdentifier"] as? String ?? ""
	}

	private func urlSchemes(_ plist: [String: Any]) -> [String] {
		guard let types = plist["CFBundleURLTypes"] as? [[String: Any]] else { return [] }
		return types.flatMap { ($0["CFBundleURLSchemes"] as? [String]) ?? [] }
	}

	private func frameworks(_ app: String) -> [String] {
		guard let names = try? FileManager.default.contentsOfDirectory(atPath: app + "/Frameworks") else { return [] }
		return names.filter { $0.hasSuffix(".framework") || $0.hasSuffix(".dylib") }.sorted()
	}

	private func directorySize(_ path: String) -> Int {
		guard let enumerator = FileManager.default.enumerator(atPath: path) else { return 0 }
		var total = 0
		for case let relative as String in enumerator {
			let full = path + "/" + relative
			if let attributes = try? FileManager.default.attributesOfItem(atPath: full),
			   (attributes[.type] as? FileAttributeType) == .typeRegular {
				total += (attributes[.size] as? NSNumber)?.intValue ?? 0
			}
			if total > 2_147_483_648 { break }
		}
		return total
	}

	private func dataContainer(bundleId: String) -> String? {
		let root = "/var/mobile/Containers/Data/Application"
		guard let containers = try? FileManager.default.contentsOfDirectory(atPath: root) else { return nil }
		for container in containers {
			let metadata = root + "/" + container + "/.com.apple.mobile_container_manager.metadata.plist"
			guard let plist = infoPlist(at: metadata) else { continue }
			if plist["MCMMetadataIdentifier"] as? String == bundleId { return root + "/" + container }
		}
		return nil
	}

	private func entitlements(path: String) -> String? {
		guard let ldid = ["/var/jb/usr/bin/ldid", "/usr/bin/ldid"].first(where: { FileManager.default.isExecutableFile(atPath: $0) })
		else { return nil }
		guard let outcome = try? runShell("\(ldid) -e \(shellQuote(path))", timeout: 20), outcome.code == 0 else { return nil }
		return outcome.stdout.isEmpty ? nil : String(outcome.stdout.prefix(32_768))
	}

	private func shellQuote(_ value: String) -> String {
		"'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
	}
}
