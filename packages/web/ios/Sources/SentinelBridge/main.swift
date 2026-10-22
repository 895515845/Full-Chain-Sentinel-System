/**
 * Entry point. launchd starts this with no arguments; a developer can pass
 * --url/--token/--state-dir to run the same binary against a local console.
 */

import Darwin
import Foundation

let options: Options
do {
	options = try ConfigLoader.parse(CommandLine.arguments)
} catch {
	FileHandle.standardError.write(Data("参数错误：\(error)\n".utf8))
	exit(2)
}
if options.showHelp {
	print(ConfigLoader.usage())
	exit(0)
}

let setupContext: BridgeSetupContext
do {
	setupContext = try ConfigLoader.context(options)
} catch {
	FileHandle.standardError.write(Data("配置错误：\(error)\n".utf8))
	exit(2)
}

// The local control page is always available: it can save config, start, stop
// and reload the bridge without restarting the launchd job. If a valid config
// already exists, start the connection immediately as well.
let controller = BridgeController(context: setupContext)
controller.startIfConfigured()

let server = SetupServer(context: setupContext, controller: controller)
do {
	try server.start()
	log("SentinelBridge control · \(Platform.model) · iOS \(Platform.osVersion) · root=\(Platform.isRoot)")
	log("control page: http://127.0.0.1:9945/setup")
} catch {
	// A second instance or a port conflict must not take the bridge down; the
	// launchd job can still connect, just without the local page.
	FileHandle.standardError.write(Data("控制页未启动：\(error)\n".utf8))
}

// The watchdog LaunchDaemon uses this file to distinguish a live control loop
// from a suspended process whose socket is still open.
let heartbeatPath = setupContext.stateDir + "/watchdog-heartbeat"
let heartbeatTimer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "com.zgsfsec.sentinelbridge.heartbeat"))
heartbeatTimer.schedule(deadline: .now(), repeating: 5)
heartbeatTimer.setEventHandler {
	let value = "\(Date().timeIntervalSince1970)\n"
	try? Data(value.utf8).write(to: URL(fileURLWithPath: heartbeatPath), options: .atomic)
}
heartbeatTimer.resume()

signal(SIGPIPE, SIG_IGN)
// Dispatch sources are cancelled when released; keep them alive for the process
// lifetime or launchd's SIGTERM would be ignored and the daemon would linger.
var signalSources: [DispatchSourceSignal] = []
for number in [SIGTERM, SIGINT] {
	let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
	source.setEventHandler {
		controller.stop()
		exit(0)
	}
	source.resume()
	signal(number, SIG_IGN)
	signalSources.append(source)
}

RunLoop.main.run()
