package com.sentinel.droidbridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.Process
import android.util.Base64
import org.json.JSONObject
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * 反连前台服务：维持到控制台的 WebSocket（断线指数退避重连），把服务器下发的
 * 请求分发给 Handlers，并把结果/分片回传。协议即 packages/web/src/droid-protocol.ts。
 */
class DroidService : Service() {
	companion object {
		/** 回传时的发送队列水位：超过就等排空，避免整个文件排在内存里。 */
		private const val SEND_QUEUE_LIMIT = 4L * 1024 * 1024
	}

	private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
	private val tcpSockets = java.util.concurrent.ConcurrentHashMap<String, java.net.Socket>()
	/** 连接建立前早到的下行字节，tcp_open 完成后冲刷（frida 一连上就发首包）。 */
	private val tcpPending = java.util.concurrent.ConcurrentHashMap<String, MutableList<ByteArray>>()
	/**
	 * 分片必须按序落盘，而 scope 是多线程的 IO 池：push 走这条单线程，
	 * 同一文件的分片就不会互相插队（其他请求仍在 scope 上并发）。
	 */
	private val pushDispatcher = java.util.concurrent.Executors.newSingleThreadExecutor { runnable ->
		Thread(runnable, "droid-push").apply { isDaemon = true }
	}
	private lateinit var prefs: Prefs
	private lateinit var client: WsClient

	override fun onCreate() {
		super.onCreate()
		prefs = Prefs(this)
		// 上次没传完的推送分片：进程重启后没人会再来收尾，留着只占空间。
		cacheDir.listFiles { file -> file.name.startsWith("push-") && file.name.endsWith(".part") }?.forEach {
			it.delete()
		}
		startForeground()
	}

	override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
		connect()
		startGuard()
		return START_STICKY
	}

	/**
	 * 拉起/刷新守护进程（另一个进程里的前台服务）。心跳每 15s 顺带调一次：守护进程被
	 * 系统回收时能重新起来，主进程换了 pid 也能及时告诉它。操作员点了「停止反连」时
	 * 由 [onDestroy] 把守护进程一起停掉，所以它不会把操作员主动停掉的服务又拉起来。
	 */
	private fun startGuard() {
		if (!prefs.guardEnabled) return
		GuardService.start(this, Process.myPid())
	}

	override fun onBind(intent: Intent?): IBinder? = null

	override fun onDestroy() {
		// 操作员点了「停止反连」，或系统停掉了这个服务：守护进程一起停，否则它会在
		// 15s 后把这个服务又拉起来。
		stopService(Intent(this, GuardService::class.java))
		scope.cancel()
		pushDispatcher.shutdownNow()
		Handlers.abortAllPushes()
		for (socket in tcpSockets.values) socket.close()
		tcpSockets.clear()
		if (this::client.isInitialized) client.close()
		super.onDestroy()
	}

	private fun startForeground() {
		val manager = getSystemService(NotificationManager::class.java)
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
			manager.createNotificationChannel(
				NotificationChannel("droid", getString(R.string.notif_channel), NotificationManager.IMPORTANCE_LOW),
			)
		}
		startForeground(1, builder("启动中").build())
	}

	/** 连接状态直接写进前台通知：操作员在通知栏就能看到在线/重连中。 */
	private fun onState(state: String, detail: String) {
		getSystemService(NotificationManager::class.java).notify(1, builder("$state $detail").build())
	}

	private fun builder(contentText: String = ""): Notification.Builder {
		val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
			Notification.Builder(this, "droid")
		} else {
			@Suppress("DEPRECATION") Notification.Builder(this)
		}
		b.setContentTitle(getString(R.string.notif_title)).setContentText(contentText)
			.setSmallIcon(android.R.drawable.stat_sys_download)
		return b
	}

	private fun notify(notification: Notification) {
		getSystemService(NotificationManager::class.java).notify(1, notification)
	}

	private fun connect() {
		val url = prefs.serverUrl
		val token = prefs.token
		if (url.isEmpty() || token.isEmpty()) {
			onState("未配置", "请先填写地址与 token")
			return
		}
		// onStartCommand 会被重复触发（再点一次「启动反连」、系统重启服务）：旧 client
		// 必须先停，否则两条连接抢同一个 deviceId，网关只能用 4003 不停替换，手机侧就是
		// 「断开重连」刷屏。
		if (this::client.isInitialized) client.close()
		client = WsClient(url, token, prefs.deviceId, onFrame = ::onFrame, onState = ::onState, onTick = ::startGuard)
		client.connect()
	}

	/** 收到服务器帧：welcome 忽略，其余按 t 分发；一切都在 IO 线程里跑。 */
	private fun onFrame(text: String) {
		val obj = JSONObject(text)
		// push 在进 scope 之前就交给单线程：scope 是多线程的，绕一圈可能让
		// 同一文件的分片提交乱序，而分片顺序就是文件内容。
		if (obj.optString("t") == "push") {
			pushDispatcher.execute { onPush(obj) }
			return
		}
		scope.launch {
			when (obj.optString("t")) {
				"exec" -> answer(obj) { resultOf(it, Handlers.exec(it)) }
				"logcat" -> answer(obj) { resultOf(it, Handlers.logcat(it)) }
				"packages" -> answer(obj) { resultOf(it, Handlers.packages(it)) }
				"capture_start" -> answer(obj) { resultOf(it, Handlers.captureStart(it)) }
				"capture_stop" -> answer(obj) { resultOf(it, Handlers.captureStop()) }
				"capture_status" -> answer(obj) { resultOf(it, Handlers.captureStatus()) }
				"screencap" -> {
					val req = parseRequest(obj)
					try {
						val (file, r) = Handlers.screencap()
						if (!r.ok) throw IllegalStateException("截屏失败: ${r.stderr}")
						// root 建的文件应用 uid 读不到，streamFile 自己会走 su cat。
						answerStreamFile(req, file.absolutePath, 32L * 1024 * 1024)
						Shell.run("rm -f '${file.absolutePath}'", asRoot = true, timeoutMs = 5_000)
					} catch (e: Exception) {
						client.send(errorFrame(req, e.message ?: "截屏失败").toString())
					}
				}
				"pull" -> {
					val req = parseRequest(obj)
					answerStreamFile(req, req.path, req.maxBytes)
				}
				"tcp_open" -> scope.launch { onTcpOpen(obj) }
				"tcp_send" -> scope.launch { onTcpSend(obj) }
				"tcp_close" -> scope.launch { onTcpClose(obj) }
			}
		}
	}

	/**
	 * 一条 push 分片：seq=0 开文件，之后追加；只有 done 那一片回 result
	 * （服务端一次推送 = 一个请求 = 一个应答）。出错就丢掉临时文件并回报。
	 */
	private fun onPush(obj: JSONObject) {
		val req = parseRequest(obj)
		try {
			if (req.seq == 0) {
				Handlers.pushOpen(req.reqId, cacheDir, req.seq, req.b64)
			} else {
				Handlers.pushAppend(req.reqId, req.seq, req.b64)
			}
			if (!req.done) return
			val size = Handlers.pushFinish(req.reqId, req.path, req.mode)
			client.send(
				JSONObject().put("t", "result").put("reqId", req.reqId).put("ok", true).put("code", 0)
					.put("stdout", "写入 $size 字节").toString(),
			)
		} catch (e: Exception) {
			Handlers.pushAbort(req.reqId)
			client.send(errorFrame(req, e.message ?: "写入失败").toString())
		}
	}

	private fun parseRequest(obj: JSONObject): Request = Request(
		t = obj.optString("t"),
		reqId = obj.optString("reqId"),
		cmd = obj.optString("cmd"),
		asRoot = obj.optBoolean("asRoot"),
		timeoutMs = obj.optInt("timeoutMs", 30_000),
		path = obj.optString("path"),
		maxBytes = obj.optLong("maxBytes", 256L * 1024 * 1024),
		b64 = obj.optString("b64"),
		seq = obj.optInt("seq", 0),
		done = obj.optBoolean("done", true),
		mode = obj.optString("mode", "0700"),
		lines = obj.optInt("lines", 200),
		filter = if (obj.has("filter")) obj.getString("filter") else null,
		thirdPartyOnly = obj.optBoolean("thirdPartyOnly", true),
		iface = obj.optString("iface", "any"),
		seconds = obj.optInt("seconds", 30),
	)

	private fun resultOf(req: Request, r: ExecResult): JSONObject =
		JSONObject().put("t", "result").put("reqId", req.reqId).put("ok", r.ok).put("code", r.code)
			.put("stdout", r.stdout).put("stderr", r.stderr)

	private fun errorFrame(req: Request, message: String): JSONObject =
		JSONObject().put("t", "result").put("reqId", req.reqId).put("ok", false).put("error", message)

	/** 文本型请求：handler 产出 result 帧；抛异常时回传失败结果，绝不挂掉通道。 */
	private inline fun answer(obj: JSONObject, crossinline body: (Request) -> JSONObject) {
		val req = parseRequest(obj)
		try {
			client.send(body(req).toString())
		} catch (e: Exception) {
			client.send(errorFrame(req, e.message ?: "处理失败").toString())
		}
	}

	/**
	 * 字节流型请求（pull/screencap）：从文件里读一片发一片，最后补一条 result。
	 *
	 * 之前是 `Handlers.readFile` 先把整个文件读进内存、再 `toList().chunked()` 切片：
	 * 20MB 的文件要摊 20MB 源数组 + 2100 万个装箱引用（约 80MB）+ 77 个分片数组，
	 * 还没发出第一帧就把堆顶穿，进程被 OOM 杀掉，服务端只看到「设备连接已断开」。
	 */
	private fun answerStreamFile(req: Request, path: String, maxBytes: Long) {
		try {
			var seq = 0
			Handlers.streamFile(path, maxBytes) { chunk, length, done ->
				// OkHttp 的发送队列没有上限：慢链路上不背压就等于把整个文件排进内存。
				waitForSendQueue()
				client.send(
					JSONObject().put("t", "data").put("reqId", req.reqId).put("seq", seq++)
						.put("b64", Base64.encodeToString(chunk, 0, length, Base64.NO_WRAP))
						.put("done", done).toString(),
				)
			}
			client.send(resultOf(req, ExecResult(0, "", "")).toString())
		} catch (e: Exception) {
			client.send(errorFrame(req, e.message ?: "读取失败").toString())
		}
	}

	/**
	 * 发送队列超过 4MB 就等它排空。最多等 60s：socket 半死时不能在这里卡到天荒地老，
	 * 后面的 send 会自然失败，服务端按超时收场。
	 */
	private fun waitForSendQueue() {
		var waited = 0L
		while (client.queueSize() > SEND_QUEUE_LIMIT && waited < 60_000) {
			Thread.sleep(20)
			waited += 20
		}
	}

	/**
	 * TCP 隧道：tcp_open 在设备上连目标端口，之后 tcp_send/tcp_data 双向透传，
	 * tcp_close/tcp_closed 任一侧关闭。connId = tunnelId:connId 定向一条流。
	 * frida-server(27042) 就是通过这条隧道被容器里的 frida-cli 摸到的。
	 */
	private fun onTcpOpen(obj: JSONObject) {
		val reqId = obj.optString("reqId")
		val tunnelId = obj.optString("tunnelId")
		val connId = obj.optString("connId")
		val host = obj.optString("host")
		val port = obj.optInt("port")
		val key = "$tunnelId:$connId"
		try {
			val socket = java.net.Socket(host, port)
			tcpSockets[key] = socket
			tcpPending.remove(key)?.forEach { socket.getOutputStream().write(it) }
			socket.getOutputStream().flush()
			client.send(JSONObject().put("t", "tcp_opened").put("reqId", reqId).put("tunnelId", tunnelId)
				.put("connId", connId).put("ok", true).toString())
			val input = socket.getInputStream()
			val buf = ByteArray(16 * 1024)
			Thread {
				try {
					while (true) {
						val n = input.read(buf)
						if (n < 0) break
						client.send(
							JSONObject().put("t", "tcp_data").put("tunnelId", tunnelId).put("connId", connId)
								.put("b64", Base64.encodeToString(buf, 0, n, Base64.NO_WRAP)).toString(),
						)
					}
				} catch (_: Exception) {
				} finally {
					tcpSockets.remove(key)
					socket.close()
					try {
						client.send(JSONObject().put("t", "tcp_closed").put("tunnelId", tunnelId).put("connId", connId).toString())
					} catch (_: Exception) {
					}
				}
			}.apply { isDaemon = true }.start()
		} catch (e: Exception) {
			client.send(
				JSONObject().put("t", "tcp_opened").put("reqId", reqId).put("tunnelId", tunnelId)
					.put("connId", connId).put("ok", false).put("error", e.message ?: "连接失败").toString(),
			)
		}
	}

	private fun onTcpSend(obj: JSONObject) {
		val key = "${obj.optString("tunnelId")}:${obj.optString("connId")}"
		val socket = tcpSockets[key] ?: return
		try {
			socket.getOutputStream().write(Base64.decode(obj.optString("b64"), Base64.DEFAULT))
			socket.getOutputStream().flush()
		} catch (_: Exception) {
			socket.close()
			tcpSockets.remove(key)
		}
	}

	private fun onTcpClose(obj: JSONObject) {
		val key = "${obj.optString("tunnelId")}:${obj.optString("connId")}"
		tcpSockets.remove(key)?.close()
	}
}

