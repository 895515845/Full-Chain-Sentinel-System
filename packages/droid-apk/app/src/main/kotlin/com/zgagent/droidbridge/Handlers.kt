package com.zgagent.droidbridge

import android.util.Base64
import java.io.File

/** 一条来自服务器的请求（JSON 已解析）。字段与 packages/web/src/droid-protocol.ts 一致。 */
data class Request(
	val t: String,
	val reqId: String,
	val cmd: String = "",
	val asRoot: Boolean = false,
	val timeoutMs: Int = 30_000,
	val path: String = "",
	val maxBytes: Long = 0,
	val b64: String = "",
	val lines: Int = 200,
	val filter: String? = null,
	val thirdPartyOnly: Boolean = true,
	val iface: String = "any",
	val seconds: Int = 30,
)

/** 一次执行的完整结果（exec/logcat/packages 用 stdout，文件类用 data 分片）。 */
data class ExecResult(val code: Int, val stdout: String, val stderr: String) {
	val ok: Boolean get() = code == 0
}

object Shell {
	/** 执行一条 shell 命令。asRoot 时经 su（Magisk 会弹一次授权）。 */
	fun run(cmd: String, asRoot: Boolean, timeoutMs: Int, workDir: String = "/data/local/tmp"): ExecResult {
		val argv = if (asRoot) listOf("su", "-c", cmd) else listOf("sh", "-c", cmd)
		val proc = ProcessBuilder(argv).directory(File(workDir)).start()
		val out = StringBuilder()
		val err = StringBuilder()
		val done = Thread {
			proc.inputStream.use { input ->
				val buf = ByteArray(8192)
				while (true) {
					val n = input.read(buf)
					if (n < 0) break
					out.append(String(buf, 0, n))
				}
			}
		}
		val errThread = Thread {
			proc.errorStream.use { input ->
				val buf = ByteArray(8192)
				while (true) {
					val n = input.read(buf)
					if (n < 0) break
					err.append(String(buf, 0, n))
				}
			}
		}
		done.start()
		errThread.start()
		val finished = proc.waitFor(timeoutMs.toLong(), java.util.concurrent.TimeUnit.MILLISECONDS)
		if (!finished) proc.destroyForcibly()
		done.join(2_000)
		errThread.join(2_000)
		// 超时的输出仍然有用：把已收到的部分带回去。
		return ExecResult(if (finished) proc.exitValue() else 124, out.toString(), err.toString())
	}

	/** root 可用性探测：`su -c id` 的 uid 里带 root 即可。 */
	fun rootAvailable(): Boolean = try {
		run("id -u", asRoot = true, timeoutMs = 5_000).let { it.code == 0 && it.stdout.contains("0") }
	} catch (_: Exception) {
		false
	}
}

/**
 * 命令实现：每个函数把 Request 变成 result 帧，或产出需要分片回传的字节。
 * 全部实现都基于 shell + root，这是「测试机必须 root」换来的简单性。
 */
object Handlers {
	const val CHUNK = 256 * 1024
	const val CAPTURE_PATH = "/data/local/tmp/droid-capture.pcap"

	fun exec(req: Request): ExecResult = Shell.run(req.cmd, req.asRoot, req.timeoutMs)

	fun logcat(req: Request): ExecResult {
		val filter = req.filter?.trim().orEmpty()
		val cmd = buildString {
			append("logcat -d -t ").append(req.lines)
			if (filter.isNotEmpty()) append(" | grep -i '").append(filter.replace("'", "")).append("'")
		}
		return Shell.run(cmd, asRoot = true, timeoutMs = 20_000)
	}

	fun packages(req: Request): ExecResult =
		Shell.run(if (req.thirdPartyOnly) "pm list packages -3" else "pm list packages", asRoot = false, timeoutMs = 20_000)

	fun screencap(): Pair<File, ExecResult> {
		val tmp = File("/data/local/tmp/droid-screencap-${System.currentTimeMillis()}.png")
		val result = Shell.run("screencap -p '${tmp.absolutePath}'", asRoot = true, timeoutMs = 15_000)
		return tmp to result
	}

	fun captureStart(req: Request): ExecResult {
		// 先停旧的，避免 tcpdump 叠加；抓包写在 /data/local/tmp，pull 后由服务端保存。
		Shell.run("pkill -f droid-capture.pcap", asRoot = true, timeoutMs = 5_000)
		val cmd = "nohup tcpdump -i '${req.iface.ifEmpty { "any" }}' -s0 -w '$CAPTURE_PATH' > /dev/null 2>&1 &"
		return Shell.run(cmd, asRoot = true, timeoutMs = 5_000)
	}

	fun captureStop(): ExecResult {
		val stop = Shell.run("pkill -f droid-capture.pcap", asRoot = true, timeoutMs = 5_000)
		return stop
	}

	fun captureStatus(): ExecResult = Shell.run("ls -l '$CAPTURE_PATH' 2>/dev/null || echo none", asRoot = true, timeoutMs = 5_000)

	/** pull：读文件字节，交给调用方分片。超限拒绝（上限由服务端下发）。 */
	fun readFile(path: String, maxBytes: Long): ByteArray {
		val file = File(path)
		if (!file.exists()) throw IllegalArgumentException("文件不存在: $path")
		if (file.length() > maxBytes) throw IllegalArgumentException("文件超过上限: ${file.length()} > $maxBytes")
		return file.readBytes()
	}

	/** push：把 base64 写到目标路径。 */
	fun writeFile(path: String, b64: String): Long {
		val bytes = Base64.decode(b64, Base64.DEFAULT)
		val file = File(path)
		file.parentFile?.mkdirs()
		file.writeBytes(bytes)
		return bytes.size.toLong()
	}
}
