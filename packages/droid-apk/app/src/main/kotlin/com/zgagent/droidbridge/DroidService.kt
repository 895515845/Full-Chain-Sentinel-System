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
				"screencap" -> answerStream(obj) { Handlers.screencap().let { (file, r) -> if (!r.ok) throw IllegalStateException("截屏失败: ${r.stderr}"); file.readBytes() to r } }
				"pull" -> answerStream(obj) { Handlers.readFile(it.path, it.maxBytes) to ExecResult(0, "", "") }
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

