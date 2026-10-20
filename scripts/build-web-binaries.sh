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
#   <out>/windows-x64/sentinel-web.exe     Windows (published as a direct .exe)

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

echo "==> Creating archives..."
cd "$OUTPUT_DIR"
for platform in "${PLATFORMS[@]}"; do
	if [[ "$platform" == windows-* ]]; then
		# One self-contained .exe: the release publishes it directly, so a tar/zip
		# wrapper would only add an extraction step for the operator.
		echo "Leaving sentinel-web-$platform.exe unarchived"
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
