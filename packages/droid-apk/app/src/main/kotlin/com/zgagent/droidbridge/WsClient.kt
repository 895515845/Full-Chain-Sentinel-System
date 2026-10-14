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
			val attempt = backoff
			onState("连接中", "退避 ${attempt / 1000}s")
			val opened = java.util.concurrent.CountDownLatch(1)
			val request = Request.Builder().url("$url?token=$token&deviceId=$deviceId").build()
			var socket: WebSocket? = null
			ws = client.newWebSocket(
				request,
				object : WebSocketListener() {
					override fun onOpen(webSocket: WebSocket, response: Response) {
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
						opened.countDown()
					}

					override fun onMessage(webSocket: WebSocket, text: String) {
						onFrame(text)
					}

					override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
						onState("断开", t.message ?: "")
						opened.countDown()
					}

					override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
						onState("已关闭", "$code $reason")
						opened.countDown()
					}
				},
			)
			socket ?: run { opened.countDown() }
			// 等这条连接断开（onFailure/onClosed 放行），再退避重连。
			while (!closed && opened.count > 0) {
				TimeUnit.MILLISECONDS.sleep(200)
			}
			if (closed) break
			var waited = 0L
			while (!closed && waited < attempt) {
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
