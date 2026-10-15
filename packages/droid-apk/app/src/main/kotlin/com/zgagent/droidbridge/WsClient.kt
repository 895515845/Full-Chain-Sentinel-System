package com.zgagent.droidbridge

import android.os.Build
import org.json.JSONObject
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * 反连 WebSocket：断线指数退避重连（1s → 30s 封顶），每 15s 发一次心跳帧。
 * 服务器地址写的是完整 ws(s)://host:port/ws/droid，token 走查询串。
 */
class WsClient(
	private val url: String,
	private val token: String,
	private val deviceId: String,
	private val onFrame: (String) -> Unit,
	private val onState: (state: String, detail: String) -> Unit,
) {
	// 渗透工具自用：wss 允许自签名证书（服务器常见自签部署）。明文 ws 不受影响。
	private val trustAll = object : X509TrustManager {
		override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
		override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}
		override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
	}
	private val client = OkHttpClient.Builder()
		.pingInterval(20, TimeUnit.SECONDS)
		.connectTimeout(15, TimeUnit.SECONDS)
		.sslSocketFactory(
			SSLContext.getInstance("TLS").apply { init(null, arrayOf<TrustManager>(trustAll), SecureRandom()) }.socketFactory,
			trustAll,
		)
		.hostnameVerifier { _, _ -> true }
		.build()
	private var ws: WebSocket? = null
	@Volatile private var closed = false
	private val retryThread = Thread { loopReconnect() }
	@Volatile private var started = false

	fun connect() {
		if (started) return
		started = true
		retryThread.isDaemon = true
		retryThread.start()
	}

	fun close() {
		closed = true
		ws?.close(1000, "bye")
		client.dispatcher.executorService.shutdown()
		client.connectionPool.evictAll()
	}

	fun send(text: String): Boolean {
		val socket = ws ?: return false
		return socket.send(text)
	}

	private fun loopReconnect() {
		var backoff = 1_000L
		while (!closed) {
			onState("连接中", "退避 ${backoff / 1000}s")
			// 这道闩只在连接「断开」时放行（onFailure/onClosed）。onOpen 绝不放行：
			// 否则循环会在连接健康时立刻再拨一条新连接，旧连接被网关替换，
			// OkHttp 的 ping 就会发在死socket上（sent ping but didn't receive pong）。
			val disconnected = java.util.concurrent.CountDownLatch(1)
			var current: WebSocket? = null
			val request = Request.Builder().url("$url?token=$token&deviceId=$deviceId").build()
			ws = client.newWebSocket(
				request,
				object : WebSocketListener() {
					override fun onOpen(webSocket: WebSocket, response: Response) {
						current = webSocket
						backoff = 1_000L
						onState("在线", "")
						// 握手帧：任何其他帧都必须在这之后（网关要求 hello 优先）。
						webSocket.send(
							JSONObject().put("t", "hello")
								.put("token", token)
								.put("deviceId", deviceId)
								.put("model", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
								.put("androidVersion", Build.VERSION.RELEASE)
								.put("sdkInt", Build.VERSION.SDK_INT)
								.put("rooted", Shell.rootAvailable())
								.toString(),
						)
						startHeartbeat(webSocket)
					}

					override fun onMessage(webSocket: WebSocket, text: String) {
						onFrame(text)
					}

					override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
						onState("断开", t.message ?: "")
						disconnected.countDown()
					}

					override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
						onState("已关闭", "$code $reason")
						disconnected.countDown()
					}
				},
			)
			if (current == null) disconnected.countDown()
			// 卡在这里直到这条连接真正断开。
			while (!closed && disconnected.count > 0) {
				TimeUnit.MILLISECONDS.sleep(200)
			}
			if (closed) break
			var waited = 0L
			while (!closed && waited < backoff) {
				TimeUnit.MILLISECONDS.sleep(200)
				waited += 200
			}
			backoff = (backoff * 2).coerceAtMost(30_000L)
		}
	}

	private fun startHeartbeat(socket: WebSocket) {
		Thread {
			while (!closed && socket === ws) {
				try {
					TimeUnit.SECONDS.sleep(15)
				} catch (_: InterruptedException) {
					return@Thread
				}
				if (socket === ws) socket.send(JSONObject().put("t", "hb").toString())
			}
		}.apply { isDaemon = true }.start()
	}
}
