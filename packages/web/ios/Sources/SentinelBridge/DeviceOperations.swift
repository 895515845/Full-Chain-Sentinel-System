/**
 * What the daemon does to the phone: exec, pull, push, screencap.
 *
 * Everything runs from a process that launchd already started as root, so
 * `asRoot` does not shell out to sudo — it only refuses when the daemon is not
 * root (the TrollStore-only restricted mode), which is the failure the operator
 * needs to see instead of a silent permission error.
 */

import Foundation
#if canImport(UIKit)
import UIKit
#endif

struct ExecOutcome {
	let code: Int32
	let stdout: String
	let stderr: String
}

enum DeviceError: Error, CustomStringConvertible {
	case message(String)

	var description: String {
		switch self {
		case .message(let text): return text
		}
	}
}

final class DeviceOperations {
	private let outputLimit = 1_048_576
	/// Open push targets by request id; the last chunk closes and chmods them.
	private var pushHandles: [String: FileHandle] = [:]
	private var pushBytes: [String: Int] = [:]
	private var pushPaths: [String: String] = [:]

	func exec(command: String, asRoot: Bool, timeout: TimeInterval) throws -> ExecOutcome {
		if asRoot && !Platform.isRoot {
			throw DeviceError.message("daemon 不是 root（TrollStore 受限模式），不能以 root 执行")
		}
		return try runShell(command, timeout: timeout)
	}

	/// Run a command without the root guard; app install/uninstall and the
	/// entitlement probe reuse this from the inventory extension.
	func runShell(_ command: String, timeout: TimeInterval) throws -> ExecOutcome {
		// Foundation's Process is macOS-only; posix_spawn is the one API that
		// exists in both the iOS SDK and the host build, so the smoke test runs
		// the same code path as the phone.
		var outPipe: [Int32] = [0, 0]
		var errPipe: [Int32] = [0, 0]
		guard pipe(&outPipe) == 0, pipe(&errPipe) == 0 else {
			throw DeviceError.message("创建管道失败：\(String(cString: strerror(errno)))")
		}

		var actions: posix_spawn_file_actions_t?
		posix_spawn_file_actions_init(&actions)
		defer { posix_spawn_file_actions_destroy(&actions) }
		posix_spawn_file_actions_adddup2(&actions, outPipe[1], STDOUT_FILENO)
		posix_spawn_file_actions_adddup2(&actions, errPipe[1], STDERR_FILENO)
		// Close the original write ends after the dup2: background children must
		// not inherit them, or the daemon waits for EOF for as long as tcpdump
		// (or any other daemon) keeps running.
		posix_spawn_file_actions_addclose(&actions, outPipe[1])
		posix_spawn_file_actions_addclose(&actions, errPipe[1])
		posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0)
		posix_spawn_file_actions_addclose(&actions, outPipe[0])
		posix_spawn_file_actions_addclose(&actions, errPipe[0])

		var attributes: posix_spawnattr_t?
		posix_spawnattr_init(&attributes)
		defer { posix_spawnattr_destroy(&attributes) }
		// Own process group, so a timeout can kill the shell and its children
		// together instead of leaving `sleep 600` holding the pipes open.
		posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP))
		posix_spawnattr_setpgroup(&attributes, 0)

		let shell = Platform.shellPath
		var argv: [UnsafeMutablePointer<CChar>?] = [
			strdup(shell),
			strdup("-c"),
			strdup(command),
			nil,
		]
		defer { for argument in argv { free(argument) } }

		var pid: pid_t = 0
		let spawned = posix_spawn(&pid, shell, &actions, &attributes, &argv, environ)
		close(outPipe[1])
		close(errPipe[1])
		guard spawned == 0 else {
			close(outPipe[0])
			close(errPipe[0])
			throw DeviceError.message("启动 shell 失败：\(String(cString: strerror(spawned)))")
		}

		let group = DispatchGroup()
		var stdout = Data()
		var stderr = Data()
		group.enter()
		DispatchQueue.global(qos: .userInitiated).async {
			let handle = FileHandle(fileDescriptor: outPipe[0], closeOnDealloc: true)
			stdout = handle.readDataToEndOfFile()
			group.leave()
		}
		group.enter()
		DispatchQueue.global(qos: .userInitiated).async {
			let handle = FileHandle(fileDescriptor: errPipe[0], closeOnDealloc: true)
			stderr = handle.readDataToEndOfFile()
			group.leave()
		}

		let deadline = Date().addingTimeInterval(max(1, timeout))
		var waitStatus: Int32 = 0
		while true {
			let result = waitpid(pid, &waitStatus, WNOHANG)
			if result == pid { break }
			if result < 0 { break }
			if Date() >= deadline {
				kill(-pid, SIGKILL)
				waitpid(pid, &waitStatus, 0)
				break
			}
			usleep(50_000)
		}
		group.wait()

		// The WIF* macros are not importable into Swift; decode the wait status
		// directly: low 7 bits are the signal, the next byte the exit code.
		let signal = waitStatus & 0x7f
		let code: Int32
		if signal == 0 {
			code = (waitStatus >> 8) & 0xff
		} else if signal != 0x7f {
			code = 128 + signal
		} else {
			code = -1
		}
		return ExecOutcome(
			code: code,
			stdout: String(decoding: stdout.prefix(outputLimit), as: UTF8.self),
			stderr: String(decoding: stderr.prefix(outputLimit), as: UTF8.self)
		)
	}

	/// Stream a file through the caller's send callback, one 1 MB chunk at a time.
	/// Returns the number of bytes sent; a directory or a special file is refused.
	func pull(path: String, maxBytes: Int, send: (Data, Bool) throws -> Void) throws -> Int {
		let attributes = try FileManager.default.attributesOfItem(atPath: path)
		guard let type = attributes[.type] as? FileAttributeType, type == .typeRegular else {
			throw DeviceError.message("不是普通文件：\(path)")
		}
		guard let size = (attributes[.size] as? NSNumber)?.intValue else {
			throw DeviceError.message("读不到文件大小：\(path)")
		}
		if size > maxBytes {
			throw DeviceError.message("文件 \(size) 字节超过上限 \(maxBytes)")
		}
		let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: path))
		defer { try? handle.close() }

		var pending: Data?
		var sent = 0
		while true {
			let chunk = try handle.read(upToCount: 524_288) ?? Data()
			if chunk.isEmpty { break }
			sent += chunk.count
			if sent > maxBytes { throw DeviceError.message("读取超过上限 \(maxBytes) 字节") }
			if let previous = pending { try send(previous, false) }
			pending = chunk
		}
		if let last = pending { try send(last, true) }
		return sent
	}

	/// Append one push chunk. seq 0 truncates/creates; the done chunk closes and
	/// chmods. The daemon keeps the handle so a 200 MB push is not reopened 200
	/// times, and so a failed transfer leaves a recognisable partial file.
	func push(reqId: String, path: String, seq: Int, data: Data, done: Bool, mode: String?) throws -> Int {
		if seq == 0 {
			if let existing = pushHandles.removeValue(forKey: reqId) { try? existing.close() }
			pushBytes[reqId] = 0
			pushPaths[reqId] = path
			if FileManager.default.fileExists(atPath: path) {
				try FileManager.default.removeItem(atPath: path)
			}
			guard FileManager.default.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
				throw DeviceError.message("无法创建文件：\(path)")
			}
		}
		let handle: FileHandle
		if let open = pushHandles[reqId] {
			handle = open
		} else {
			handle = try FileHandle(forWritingTo: URL(fileURLWithPath: path))
			try handle.seekToEnd()
			pushHandles[reqId] = handle
		}
		try handle.write(contentsOf: data)
		let total = (pushBytes[reqId] ?? 0) + data.count
		pushBytes[reqId] = total
		if done {
			try? handle.close()
			pushHandles.removeValue(forKey: reqId)
			pushBytes.removeValue(forKey: reqId)
			pushPaths.removeValue(forKey: reqId)
			if let mode, let value = Int(mode, radix: 8) {
				chmod(path, mode_t(value))
			}
		}
		return total
	}

	/// Abort a push that failed midway; the partial file is removed so a later
	/// pull does not mistake it for a complete artifact.
	func abortPush(reqId: String, path: String) {
		if let handle = pushHandles.removeValue(forKey: reqId) { try? handle.close() }
		pushBytes.removeValue(forKey: reqId)
		pushPaths.removeValue(forKey: reqId)
		try? FileManager.default.removeItem(atPath: path)
	}

	/// Close every half-finished push and delete its partial file; the socket died,
	/// so no further chunk is coming and a partial file must not look complete.
	func abortAllPushes() {
		for (reqId, handle) in pushHandles {
			try? handle.close()
			if let path = pushPaths[reqId] { try? FileManager.default.removeItem(atPath: path) }
		}
		pushHandles.removeAll()
		pushBytes.removeAll()
		pushPaths.removeAll()
	}

	func screencap() throws -> Data {
		#if canImport(UIKit)
		// Private but stable across jailbroken iOS versions; it is the only way to
		// capture another app's screen from a daemon (UIGraphics cannot see it).
		guard let framework = dlopen("/System/Library/Frameworks/UIKit.framework/UIKit", RTLD_LAZY) else {
			throw DeviceError.message("无法加载 UIKit")
		}
		defer { dlclose(framework) }
		guard let symbol = dlsym(framework, "_UICreateScreenUIImage") else {
			throw DeviceError.message("当前系统没有 _UICreateScreenUIImage，截屏不可用")
		}
		typealias CreateImage = @convention(c) () -> AnyObject?
		let create = unsafeBitCast(symbol, to: CreateImage.self)
		guard let image = create() as? UIImage, let data = image.pngData() else {
			throw DeviceError.message(
				"截屏返回空图片：_UICreateScreenUIImage 在当前进程没有 UI 会话，iOS 16+ 真机的 launchd daemon 常见此问题。改用 frida 在 SpringBoard 内截图，或在宿主机用 idevicescreenshot。"
			)
		}
		return data
		#else
		throw DeviceError.message("截屏只在 iOS 设备上可用")
		#endif
	}
}
