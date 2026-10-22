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

// A fresh deb has no config: keep the launchd job alive but serve the local
// setup page instead of exiting into a throttle loop. Once pairing writes the
// config, the process exits and launchd restarts it in normal mode.
let configured = (options.url != nil && options.token != nil)
	|| (!setupContext.config.url.isEmpty && !setupContext.config.token.isEmpty)
if options.setup || !configured {
	let server = SetupServer(context: setupContext)
	do {
		try server.start()
	} catch {
		FileHandle.standardError.write(Data("无法启动配对页：\(error)\n".utf8))
		exit(2)
	}
	log("SentinelBridge setup mode · \(Platform.model) · iOS \(Platform.osVersion) · root=\(Platform.isRoot)")
	log("setup page: http://127.0.0.1:9945/setup")
	RunLoop.main.run()
	exit(0)
}

let config: BridgeConfig
let stateDir: String
let deviceId: String
do {
	(config, stateDir, deviceId) = try ConfigLoader.load(options)
} catch {
	FileHandle.standardError.write(Data("配置错误：\(error)\n".utf8))
	exit(2)
}

log("SentinelBridge starting · \(Platform.model) · iOS \(Platform.osVersion) · \(Platform.arch) · \(Platform.form) · root=\(Platform.isRoot)")
log("state dir: \(stateDir)")

let client = GatewayClient(config: config, deviceId: deviceId)
client.start()

signal(SIGPIPE, SIG_IGN)
// Dispatch sources are cancelled when released; keep them alive for the process
// lifetime or launchd's SIGTERM would be ignored and the daemon would linger.
var signalSources: [DispatchSourceSignal] = []
for number in [SIGTERM, SIGINT] {
	let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
	source.setEventHandler {
		client.stop()
		exit(0)
	}
	source.resume()
	signal(number, SIG_IGN)
	signalSources.append(source)
}

RunLoop.main.run()
