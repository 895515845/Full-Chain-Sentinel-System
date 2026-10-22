// swift-tools-version:5.9
/**
 * SentinelBridge daemon.
 *
 * The same sources build two ways:
 *   - `swift build` on macOS, for the protocol smoke test against the console's
 *     Node gateway (exec/pull/push/tunnel; screencap is iOS-only);
 *   - `xcrun --sdk iphoneos swiftc ...` in scripts/build-ios.sh, for the real
 *     arm64 jailbroken binary.
 *
 * No third-party dependencies: a daemon that has to survive on a phone should
 * not drag a package graph behind it.
 */
import PackageDescription

let package = Package(
	name: "SentinelBridge",
	platforms: [.macOS(.v13)],
	targets: [
		.executableTarget(
			name: "SentinelBridge",
			path: "Sources/SentinelBridge",
			swiftSettings: [.unsafeFlags(["-strict-concurrency=minimal"])]
		),
	]
)
