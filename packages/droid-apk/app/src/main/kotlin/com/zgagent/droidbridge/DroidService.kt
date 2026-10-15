package com.zgagent.droidbridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
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
	private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
	private val tcpSockets = java.util.concurrent.ConcurrentHashMap<String, java.net.Socket>()
	/** 连接建立前早到的下行字节，tcp_open 完成后冲刷（frida 一连上就发首包）。 */
	private val tcpPending = java.util.concurrent.ConcurrentHashMap<String, MutableList<ByteArray>>()
	private lateinit var prefs: Prefs
	private lateinit var client: WsClient

	override fun onCreate() {
		super.onCreate()
		prefs = Prefs(this)
		startForeground()
	}

	override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
		connect()
		return START_STICKY
	}

	override fun onBind(intent: Intent?): IBinder? = null

	override fun onDestroy() {
		scope.cancel()
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
		client = WsClient(url, token, prefs.deviceId, onFrame = ::onFrame, onState = ::onState)
		client.connect()
	}

	/** 收到服务器帧：welcome 忽略，其余按 t 分发；一切都在 IO 线程里跑。 */
	private fun onFrame(text: String) {
		val obj = JSONObject(text)
		scope.launch {
			when (obj.optString("t")) {
				"exec" -> answer(obj) { resultOf(it, Handlers.exec(it)) }
				"logcat" -> answer(obj) { resultOf(it, Handlers.logcat(it)) }
				"packages" -> answer(obj) { resultOf(it, Handlers.packages(it)) }
				"capture_start" -> answer(obj) { resultOf(it, Handlers.captureStart(it)) }
				"capture_stop" -> answer(obj) { resultOf(it, Handlers.captureStop()) }
				"capture_status" -> answer(obj) { resultOf(it, Handlers.captureStatus()) }
				"screencap" -> answerStream(obj) {
					val (file, r) = Handlers.screencap()
					if (!r.ok) throw IllegalStateException("截屏失败: ${r.stderr}")
					// root 建的文件应用 uid 可能读不到，走 root cat。
					val bytes = try {
						file.readBytes()
					} catch (_: Exception) {
						Handlers.readFile(file.absolutePath, 32L * 1024 * 1024)
					}
					Shell.run("rm -f '${file.absolutePath}'", asRoot = true, timeoutMs = 5_000)
					bytes to r
				}
				"pull" -> answerStream(obj) { Handlers.readFile(it.path, it.maxBytes) to ExecResult(0, "", "") }
				"tcp_open" -> scope.launch { onTcpOpen(obj) }
				"tcp_send" -> scope.launch { onTcpSend(obj) }
				"tcp_close" -> scope.launch { onTcpClose(obj) }
				"push" -> answer(obj) {
					val size = Handlers.writeFile(it.path, it.b64)
					JSONObject().put("t", "result").put("reqId", it.reqId).put("ok", true).put("code", 0)
						.put("stdout", "写入 $size 字节")
				}
			}
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

	/** 字节流型请求（pull/screencap）：data 分片回传后补一条 result 收尾。 */
	private inline fun answerStream(obj: JSONObject, crossinline body: (Request) -> Pair<ByteArray, ExecResult>) {
		val req = parseRequest(obj)
		try {
			val (bytes, r) = body(req)
			streamBytes(req, bytes)
			client.send(resultOf(req, r).toString())
		} catch (e: Exception) {
			client.send(errorFrame(req, e.message ?: "处理失败").toString())
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

	/** 256KB 原始字节一片，base64 后约 350KB，远低于网关单帧上限。 */
	private fun streamBytes(req: Request, bytes: ByteArray) {
		val chunks = if (bytes.isEmpty()) listOf(ByteArray(0)) else bytes.toList().chunked(Handlers.CHUNK).map { it.toByteArray() }
		chunks.forEachIndexed { index, chunk ->
			val frame = JSONObject()
				.put("t", "data")
				.put("reqId", req.reqId)
				.put("seq", index)
				.put("b64", Base64.encodeToString(chunk, Base64.NO_WRAP))
				.put("done", index == chunks.size - 1)
			client.send(frame.toString())
		}
	}
}

