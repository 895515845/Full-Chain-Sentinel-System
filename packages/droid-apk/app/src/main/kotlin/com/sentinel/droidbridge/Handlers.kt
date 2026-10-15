package com.sentinel.droidbridge

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
	val seq: Int = 0,
	val done: Boolean = true,
	val mode: String = "0700",
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
	/**
	 * 执行一条 shell 命令。asRoot 时经 su（Magisk 会弹一次授权）。
	 *
	 * 不设置工作目录：普通应用 uid 无权进入 /data/local/tmp（那是 adb shell 的
	 * 工作目录），指定它会让 ProcessBuilder.start() 直接抛 IOException，su 都
	 * 轮不到执行。命令一律用绝对路径。
	 */
	fun run(cmd: String, asRoot: Boolean, timeoutMs: Int): ExecResult {
		val argv = if (asRoot) listOf("su", "-c", cmd) else listOf("sh", "-c", cmd)
		val proc = ProcessBuilder(argv).start()
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

	/**
	 * root 可用性探测：`su -c id -u` 的输出为 0 即可。
	 *
	 * 第一次 su 会触发 Magisk 授权弹窗，而探测结果随 hello 帧一次性上报——
	 * 所以这里重试几次、把超时放宽到 10s，给操作员留出点「允许」的时间。
	 */
	fun rootAvailable(): Boolean {
		repeat(3) { attempt ->
			try {
				val result = run("id -u", asRoot = true, timeoutMs = 10_000)
				if (result.code == 0 && result.stdout.contains("0")) return true
			} catch (_: Exception) {
			}
			if (attempt < 2) Thread.sleep(1_500)
		}
		return false
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

	/** 一个文件字节来源：直读文件，或 root cat 的原始 stdout。 */
	private class FileSource(val input: java.io.InputStream, val finish: (Long) -> String?, val close: () -> Unit)

	/**
	 * pull：把文件按块读出来交给 sink，全程只留当前这一块。
	 *
	 * 这里必须流式：之前是先 `readBytes()` 把整个文件读进内存、再
	 * `toList().chunked()` 切片，20MB 的文件要摊 20MB 源数组 + 2100 万个装箱引用
	 * （约 80MB）+ 77 个分片数组，还没发出第一帧就把堆顶穿，进程被 OOM 杀掉，
	 * 服务端只看到「设备连接已断开」。
	 *
	 * 直读拿不到（root 建的文件、其他应用的私有目录）时走 `su cat`，读的是
	 * **原始字节流**——不能用 Shell.run：它把 stdout 当字符串收，跨 8KB 边界的
	 * 多字节序列会被拆坏、非法 UTF-8 字节会被替换成 U+FFFD，二进制拉下来就是坏的。
	 */
	fun streamFile(path: String, maxBytes: Long, sink: (chunk: ByteArray, length: Int, done: Boolean) -> Unit) {
		val source = openSource(path, maxBytes)
		// 双缓冲轮换：只有读到下一块才知道上一块是不是最后一块，所以手里要压着一块。
		val buffers = arrayOf(ByteArray(CHUNK), ByteArray(CHUNK))
		var pending: ByteArray? = null
		var pendingLength = 0
		var slot = 0
		var total = 0L
		try {
			while (true) {
				val current = buffers[slot]
				val n = readChunk(source.input, current)
				if (n < 0) break
				total += n
				if (total > maxBytes) throw IllegalArgumentException("文件超过上限: $total > $maxBytes")
				val previous = pending
				if (previous != null) sink(previous, pendingLength, false)
				pending = current
				pendingLength = n
				slot = 1 - slot
			}
			source.finish(total)?.let { throw IllegalArgumentException(it) }
			// 空文件也要发一片 done，服务端才有一个 seq=0 可收。
			sink(pending ?: ByteArray(0), pendingLength, true)
		} finally {
			try {
				source.close()
			} catch (_: Exception) {
			}
		}
	}

	private fun openSource(path: String, maxBytes: Long): FileSource {
		val file = File(path)
		if (file.isFile) {
			// 直读前先看大小：超限就没必要先传 256MB 再报错。
			if (file.length() > maxBytes) throw IllegalArgumentException("文件超过上限: ${file.length()} > $maxBytes")
			try {
				return FileSource(file.inputStream(), { null }, {})
			} catch (_: Exception) {
				// 读不到（root-only）：落到 su cat。
			}
		}
		val proc = try {
			ProcessBuilder(listOf("su", "-c", "cat '$path'")).start()
		} catch (e: Exception) {
			throw IllegalArgumentException("读取失败: ${e.message ?: "无法启动 su"}")
		}
		return FileSource(
			proc.inputStream,
			{ total ->
				// 一个字节都没读到又非 0 退出：把 stderr 带回去当错误信息。
				if (total > 0L) {
					null
				} else if (!proc.waitFor(5, java.util.concurrent.TimeUnit.SECONDS) || proc.exitValue() != 0) {
					val err = try {
						proc.errorStream.readBytes().toString(Charsets.UTF_8).trim()
					} catch (_: Exception) {
						""
					}
					"读取失败: ${err.ifEmpty { "文件不存在或无权限" }}"
				} else {
					null
				}
			},
			{ proc.destroyForcibly() },
		)
	}

	/** 尽量填满缓冲区：管道一次只给 64KB，不填满会退化成几百个小分片。 */
	private fun readChunk(input: java.io.InputStream, buffer: ByteArray): Int {
		var filled = 0
		while (filled < buffer.size) {
			val n = input.read(buffer, filled, buffer.size - filled)
			if (n < 0) break
			filled += n
		}
		return if (filled == 0) -1 else filled
	}

	/**
	 * 一条分片推送的落盘状态：先写应用私有缓存，done 时再搬到目标路径。
	 *
	 * 应用 uid 写不了 /data/local/tmp（那是 shell 的 0771 目录），搬位因此和
	 * readFile 读不到就走 root cat 一样，必要时经 su。分片只留在磁盘上，
	 * 内存里始终只有当前这一片。
	 */
	class PushTarget(val tmp: File, val out: java.io.OutputStream) {
		var bytes = 0L
		var nextSeq = 0
	}

	private val pushes = java.util.concurrent.ConcurrentHashMap<String, PushTarget>()

	/** seq=0：开（截断）目标对应的缓存文件并写入第一片。 */
	fun pushOpen(reqId: String, cacheDir: File, seq: Int, b64: String): Long {
		if (seq != 0) throw IllegalStateException("推送分片乱序：期望 0，收到 $seq")
		pushAbort(reqId)
		val safe = reqId.replace(Regex("[^A-Za-z0-9_.-]"), "_")
		val tmp = File(cacheDir, "push-$safe.part")
		pushes[reqId] = PushTarget(tmp, tmp.outputStream())
		return pushAppend(reqId, seq, b64)
	}

	/** 追加一片，返回已写入的总字节数。乱序即失败，绝不写歪。 */
	fun pushAppend(reqId: String, seq: Int, b64: String): Long {
		val target = pushes[reqId] ?: throw IllegalStateException("推送分片丢失了打开状态")
		if (seq != target.nextSeq) throw IllegalStateException("推送分片乱序：期望 ${target.nextSeq}，收到 $seq")
		target.nextSeq += 1
		val bytes = Base64.decode(b64, Base64.DEFAULT)
		target.out.write(bytes)
		target.bytes += bytes.size
		return target.bytes
	}

	/** done：关流并把缓存文件搬到目标路径（应用能直接写就直接写，否则经 su）。 */
	fun pushFinish(reqId: String, path: String, mode: String): Long {
		val target = pushes.remove(reqId) ?: throw IllegalStateException("推送分片丢失了打开状态")
		target.out.close()
		val chmod = mode.ifEmpty { "0700" }
		try {
			val file = File(path)
			val direct = try {
				file.parentFile?.mkdirs()
				target.tmp.copyTo(file, overwrite = true)
				Shell.run("chmod $chmod '${path.replace("'", "")}'", asRoot = false, timeoutMs = 10_000)
				true
			} catch (_: Exception) {
				false
			}
			if (!direct) {
				val dir = path.substringBeforeLast('/', "")
				val cmd = buildString {
					if (dir.isNotEmpty()) append("mkdir -p '").append(dir).append("'; ")
					append("cat '").append(target.tmp.absolutePath).append("' > '").append(path).append("'; ")
					append("chmod ").append(chmod).append(" '").append(path).append("'; ")
					append("ls -l '").append(path).append("'")
				}
				val result = Shell.run(cmd, asRoot = true, timeoutMs = 120_000)
				if (result.code != 0) throw IllegalStateException(result.stderr.ifEmpty { "写入失败（退出码 ${result.code}）" })
			}
			return target.bytes
		} finally {
			target.tmp.delete()
		}
	}

	/** 丢掉一条未完成的推送（失败、乱序、或服务停止）。 */
	fun pushAbort(reqId: String) {
		val target = pushes.remove(reqId) ?: return
		try {
			target.out.close()
		} catch (_: Exception) {
		}
		target.tmp.delete()
	}

	fun abortAllPushes() {
		for (reqId in pushes.keys.toList()) pushAbort(reqId)
	}
}
