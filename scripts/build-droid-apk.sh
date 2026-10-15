#!/usr/bin/env bash
# 构建 DroidBridge APK（Mac，国内镜像）。
#
# 前置：JDK 17（/Library/Java/JavaVirtualMachines/jdk-17.jdk）。
# SDK 与 Gradle 都来自腾讯镜像，脚本会在 ~/sentinel-tools 下就位，重复执行幂等：
#   - Gradle 8.7:  mirrors.cloud.tencent.com/gradle/gradle-8.7-bin.zip
#   - platform-34: mirrors.cloud.tencent.com/AndroidSDK/platform-34-ext7_r03.zip
#   - build-tools: mirrors.cloud.tencent.com/AndroidSDK/build-tools_r34-macosx.zip
# AGP/Kotlin/依赖走 settings.gradle.kts 里的阿里云 maven 镜像。
set -euo pipefail

TOOLS_DIR="${HOME}/sentinel-tools"
SDK_DIR="${TOOLS_DIR}/sdk"
DEFAULT_JAVA_HOME="/Library/Java/JavaVirtualMachines/jdk-17.jdk/Contents/Home"
# 脚本的前置是 JDK 17，但 shell 里常见的 JAVA_HOME 指向 JDK 8，而 AGP 8.5 需要 11+
# —— 那样 Gradle 只会抛一个「No matching variant … compatible with Java 8」的报错，
# 看不出是 JDK 的问题。这里只在 JAVA_HOME 缺失或确实是 Java 8 时兜底到 JDK 17。
if [ -z "${JAVA_HOME:-}" ] || ! [ -x "${JAVA_HOME}/bin/java" ]; then
	JAVA_HOME="${DEFAULT_JAVA_HOME}"
elif "${JAVA_HOME}/bin/java" -version 2>&1 | grep -q 'version "1\.8'; then
	echo "[sentinel] JAVA_HOME 指向 Java 8，改用 ${DEFAULT_JAVA_HOME}" >&2
	JAVA_HOME="${DEFAULT_JAVA_HOME}"
fi
GRADLE_BIN="${TOOLS_DIR}/gradle-8.7/bin/gradle"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fetch() { # fetch <url> <dest>
	local url="$1" dest="$2"
	[ -s "$dest" ] || curl -sSLo "$dest" "$url"
}

mkdir -p "${TOOLS_DIR}" "${SDK_DIR}/platforms" "${SDK_DIR}/build-tools" "${SDK_DIR}/licenses"

if [ ! -x "${GRADLE_BIN}" ]; then
	fetch "https://mirrors.cloud.tencent.com/gradle/gradle-8.7-bin.zip" "${TOOLS_DIR}/gradle.zip"
	unzip -q -o "${TOOLS_DIR}/gradle.zip" -d "${TOOLS_DIR}"
fi

if [ ! -f "${SDK_DIR}/platforms/android-34/android.jar" ]; then
	fetch "https://mirrors.cloud.tencent.com/AndroidSDK/platform-34-ext7_r03.zip" "${SDK_DIR}/platform-34.zip"
	unzip -q -o "${SDK_DIR}/platform-34.zip" -d "${SDK_DIR}"
	mv "${SDK_DIR}/android-34" "${SDK_DIR}/platforms/android-34"
fi

if [ ! -x "${SDK_DIR}/build-tools/34.0.0/aapt2" ]; then
	fetch "https://mirrors.cloud.tencent.com/AndroidSDK/build-tools_r34-macosx.zip" "${SDK_DIR}/build-tools-34.zip"
	unzip -q -o "${SDK_DIR}/build-tools-34.zip" -d "${SDK_DIR}"
	mv "${SDK_DIR}/android-14" "${SDK_DIR}/build-tools/34.0.0"
	chmod +x "${SDK_DIR}/build-tools/34.0.0"/*
fi

# AGP 校验这些 license 哈希；没有它们 Gradle 会拒绝使用手工就位的 SDK。
printf '8933bad161af4178b1185d1a37fbf41ea5269c55\nd56f5187479451eabf01fb78af6dfcb131a6481e\n24333f8a63b6825ea9c5514f83c2829b004d1fee' \
	> "${SDK_DIR}/licenses/android-sdk-license"

export JAVA_HOME
export ANDROID_HOME="${SDK_DIR}"
cd "${REPO_ROOT}/packages/droid-apk"
"${GRADLE_BIN}" -p . --no-daemon assembleDebug
echo "APK: ${REPO_ROOT}/packages/droid-apk/app/build/outputs/apk/debug/app-debug.apk"
