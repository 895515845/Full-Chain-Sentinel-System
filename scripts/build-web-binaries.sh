#!/usr/bin/env bash
#
# Build the Full Chain Sentinel web console as single-file binaries.
#
# A binary carries the whole console: server code, browser UI, and the toolbox
# Dockerfile. It still needs a Docker daemon and the sentinel:latest image on the
# target machine, which the console checks at startup and can build for itself.
#
# Usage:
#   ./scripts/build-web-binaries.sh [--skip-build] [--platform <name>] [--out <dir>]
#
# Options:
#   --skip-build       Skip npm build steps (reuse existing dist output)
#   --platform <name>  Build only for one platform
#   --out <dir>        Output directory (default: packages/web/binaries)
#
# Platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64
#
# Output:
#   <out>/sentinel-web-<platform>.tar.gz   Unix platforms
#   <out>/sentinel-web-windows-x64.zip     Windows (the published asset: exe + replayd/)
#   <out>/windows-x64/sentinel-web.exe     Windows executable (the zip's content)

set -euo pipefail

cd "$(dirname "$0")/.."

SKIP_BUILD=false
PLATFORM=""
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
	case $1 in
		--skip-build)
			SKIP_BUILD=true
			shift
			;;
		--platform)
			PLATFORM="$2"
			shift 2
			;;
		--out)
			OUTPUT_DIR="$2"
			shift 2
			;;
		*)
			echo "Unknown option: $1"
			exit 1
			;;
	esac
done

if [[ -n "$PLATFORM" ]]; then
	case "$PLATFORM" in
		darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64) ;;
		*)
			echo "Invalid platform: $PLATFORM"
			echo "Valid platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64"
			exit 1
			;;
	esac
fi

if [[ -z "$OUTPUT_DIR" ]]; then
	OUTPUT_DIR="packages/web/binaries"
fi
if [[ "$OUTPUT_DIR" != /* ]]; then
	OUTPUT_DIR="$(pwd)/$OUTPUT_DIR"
fi

if ! command -v bun >/dev/null 2>&1; then
	echo "bun is required to compile the binary (https://bun.sh)"
	exit 1
fi

if [[ "$SKIP_BUILD" == "false" ]]; then
	# The console imports the coding-agent packages, so their dist output has to
	# exist first. The root build does not cover packages/web.
	echo "==> Building packages..."
	npm run build
	echo "==> Building the web console (frontend + embedded assets)..."
	npm --prefix packages/web run build
else
	echo "==> Skipping builds (--skip-build)"
fi

for required in \
	packages/web/dist/bun-entry.js \
	packages/web/webui/dist/index.html \
	packages/coding-agent/dist/index.js; do
	if [[ ! -f "$required" ]]; then
		echo "Missing $required; run without --skip-build"
		exit 1
	fi
done

# Bun embeds extra entrypoints at their path relative to the common directory of
# all entrypoints, and the runtime resolves workers by those relative paths
# ("src/extensions/codemode/worker.ts"). Staging the console under the
# coding-agent package keeps that common directory at packages/coding-agent, so
# the embedded worker layout matches what the runtime asks for.
#
# Absolute: the compile below cds into packages/coding-agent, so a relative path
# would resolve against that directory when the cleanup trap runs.
STAGE="$(pwd)/packages/coding-agent/dist/web"
cleanup() {
	rm -rf "$STAGE"
}
trap cleanup EXIT

# The console pushes a Linux replayd into each project container for the packet
# replay / render feature (see packages/web/src/replayd.ts). It is not embedded in
# the console: the artifacts are large and already gitignored build output, so they
# travel next to the executable, in `replayd/`.
#
# Go and the checked-out service are needed only here: without them the release
# still builds, and the replay toolset reports why it is unavailable instead.
REPLAYD_SOURCE="MITM_Fuzz_Render"
REPLAYD_DIR="$(pwd)/packages/web/replayd"
CONSOLE_VERSION="$(node -p "require('./packages/web/package.json').version" 2>/dev/null || echo "0.0.0")"
rm -rf "$REPLAYD_DIR"
mkdir -p "$REPLAYD_DIR"

# The service's own web UI is embedded into its binary (`-tags embedui`) and that
# build output is not tracked. Build it when it is missing, so a release never
# ships a replayd whose Repeater page — the thing the screenshot is taken of — is
# blank. pnpm is what the project uses; npm is the fallback on a runner without it.
build_replayd_frontend() {
	if command -v pnpm >/dev/null 2>&1; then
		(cd "$REPLAYD_SOURCE/web" && pnpm install --config.confirmModulesPurge=false && pnpm build)
	elif command -v corepack >/dev/null 2>&1 && corepack pnpm --version >/dev/null 2>&1; then
		(cd "$REPLAYD_SOURCE/web" && corepack pnpm install --config.confirmModulesPurge=false && corepack pnpm build)
	elif command -v npm >/dev/null 2>&1; then
		# --no-package-lock: the project's lockfile is pnpm's, and npm must not
		# drop its own next to it.
		(cd "$REPLAYD_SOURCE/web" && npm install --no-package-lock --ignore-scripts --no-audit --no-fund && npm run build)
	else
		return 1
	fi
}

if [[ "${SENTINEL_SKIP_REPLAYD:-}" == "1" ]]; then
	echo "==> replayd: skipped (SENTINEL_SKIP_REPLAYD=1); the replay toolset will report itself unavailable"
elif [[ ! -d "$REPLAYD_SOURCE/cmd/replayd" ]]; then
	echo "==> replayd: $REPLAYD_SOURCE is missing; shipping no container binaries"
elif ! command -v go >/dev/null 2>&1; then
	echo "==> replayd: no Go toolchain; shipping no container binaries"
	echo "           (the replay toolset will report itself unavailable; build with 'make dist' in $REPLAYD_SOURCE)"
else
	echo "==> Building replayd for the container platforms..."
	if [[ ! -f "$REPLAYD_SOURCE/internal/api/dist/index.html" ]]; then
		echo "  building the replayd frontend (embedded into the binary)..."
		if ! build_replayd_frontend; then
			echo "  error: cannot build the replayd UI (pnpm or npm required); it is part of the screenshot feature" >&2
			exit 1
		fi
	fi
	for arch in amd64 arm64; do
		# The version the operator sees in the console status is the console's, so a
		# shipped replayd is always identifiable as the one that pushed it.
		if (cd "$REPLAYD_SOURCE" && CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -tags embedui -trimpath \
			-ldflags "-s -w -X main.version=$CONSOLE_VERSION -X main.buildTime=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
			-o "$REPLAYD_DIR/replayd_linux_$arch" ./cmd/replayd); then
			echo "  replayd linux/$arch ($CONSOLE_VERSION)"
		else
			echo "  error: replayd linux/$arch failed to build (see the Go output above)." >&2
			echo "         Fix the toolchain/cache, or pass SENTINEL_SKIP_REPLAYD=1 to ship the console alone." >&2
			exit 1
		fi
	done
fi

echo "==> Staging the console for the bundler..."
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R packages/web/dist/. "$STAGE/"

if [[ -n "$PLATFORM" ]]; then
	PLATFORMS=("$PLATFORM")
else
	PLATFORMS=(darwin-arm64 linux-x64)
fi

echo "==> Compiling binaries..."
cd packages/coding-agent
for platform in "${PLATFORMS[@]}"; do
	echo "Building for $platform..."
	bun_target="bun-$platform"
	# Baseline is a separate Bun build, so targeting it makes Bun download that
	# build. On Windows the download is extracted under the workspace drive and
	# renamed into the install cache on another drive, which Bun 1.3.14 fails
	# with "Failed to extract executable". Target the runner's standard x64 build
	# instead: Bun then reuses itself and downloads nothing.
	if [[ "$platform" == *-x64 && "$platform" != windows-* ]]; then
		bun_target="${bun_target}-baseline"
	fi
	mkdir -p "$OUTPUT_DIR/$platform"
	outfile="$OUTPUT_DIR/$platform/sentinel-web"
	if [[ "$platform" == windows-* ]]; then
		# Bun would append .exe itself; naming it here keeps the archive and the
		# release asset on one path.
		outfile="$outfile.exe"
	fi
	# Disable cwd bunfig.toml/.env autoload so a project's files cannot change how
	# the console starts, the same way the pi CLI binary is built.
	bun build --compile \
		--no-compile-autoload-bunfig \
		--no-compile-autoload-dotenv \
		--target="$bun_target" \
		./dist/web/bun-entry.js \
		./src/utils/image-resize-worker.ts \
		./src/extensions/codemode/worker.ts \
		--outfile "$outfile"
done

# The console looks for the container binaries at <executable dir>/replayd, so each
# platform directory carries the same folder: inside the tarball that puts them at
# sentinel-web/replayd/, next to the sentinel-web executable.
if [[ -n "$(ls -A "$REPLAYD_DIR" 2>/dev/null)" ]]; then
	for platform in "${PLATFORMS[@]}"; do
		rm -rf "$OUTPUT_DIR/$platform/replayd"
		cp -R "$REPLAYD_DIR" "$OUTPUT_DIR/$platform/replayd"
	done
fi

echo "==> Creating archives..."
cd "$OUTPUT_DIR"
for platform in "${PLATFORMS[@]}"; do
	if [[ "$platform" == windows-* ]]; then
		# Windows publishes one asset, and it is this zip: the replay toolset needs the
		# Linux binaries that go into the containers, and those have to sit next to the
		# executable. The .exe stays on disk because it is the zip's content (and what
		# the workflow smoke-tests), but it is not uploaded on its own — a bare .exe
		# looked complete and only reported the missing binaries at first use.
		if [[ -d "$platform/replayd" ]]; then
			rm -f "sentinel-web-$platform.zip"
			if command -v zip >/dev/null 2>&1; then
				(cd "$platform" && zip -qr "../sentinel-web-$platform.zip" sentinel-web.exe replayd)
			elif command -v powershell >/dev/null 2>&1 || command -v pwsh >/dev/null 2>&1; then
				# Relative paths with the platform directory as the working directory:
				# Compress-Archive then stores sentinel-web.exe and replayd/ at the root
				# of the zip instead of nesting them under the build directory.
				ps="$(command -v powershell || command -v pwsh)"
				(cd "$platform" && "$ps" -NoProfile -Command "Compress-Archive -Path 'sentinel-web.exe','replayd' -DestinationPath '../sentinel-web-$platform.zip' -Force")
			else
				echo "  warning: no zip tool; the .exe ships without replayd/ (set SENTINEL_REPLAYD_DIR)"
			fi
			if [[ -f "sentinel-web-$platform.zip" ]]; then
				echo "  sentinel-web-$platform.zip (exe + replayd/)"
			fi
		fi
		echo "  sentinel-web-$platform.exe (zip content, not published on its own)"
		continue
	fi
	echo "Creating sentinel-web-$platform.tar.gz..."
	mv "$platform" sentinel-web
	tar -czf "sentinel-web-$platform.tar.gz" sentinel-web
	mv sentinel-web "$platform"
done

echo ""
echo "==> Build complete!"
for platform in "${PLATFORMS[@]}"; do
	if [[ "$platform" == windows-* ]]; then
		ls -lh "$OUTPUT_DIR/$platform/sentinel-web.exe"
		if [[ -f "sentinel-web-$platform.zip" ]]; then
			ls -lh "sentinel-web-$platform.zip"
		fi
	else
		ls -lh "sentinel-web-$platform.tar.gz"
	fi
done
echo ""
echo "Extracted executables:"
for platform in "${PLATFORMS[@]}"; do
	if [[ "$platform" == windows-* ]]; then
		echo "  $OUTPUT_DIR/$platform/sentinel-web.exe"
	else
		echo "  $OUTPUT_DIR/$platform/sentinel-web"
	fi
done
echo ""
first="${PLATFORMS[0]}"
first_suffix=""
[[ "$first" == windows-* ]] && first_suffix=".exe"
echo "Run one with: $OUTPUT_DIR/$first/sentinel-web$first_suffix --check"
