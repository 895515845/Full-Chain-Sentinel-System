package com.sentinel.droidbridge

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
	/** 每次心跳顺带做一件事（拉起/刷新守护进程）；抛异常不能影响心跳。 */
	private val onTick: () -> Unit = {},
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

	/** 待发送字节数：流式回传靠它做背压，队列不排空就不喂下一片。 */
	fun queueSize(): Long = ws?.queueSize() ?: 0L

	private fun loopReconnect() {
		var backoff = 1_000L
		while (!closed) {
			onState("连接中", "退避 ${backoff / 1000}s")
			// 这道闩只由「断开」放行（onFailure/onClosed），onOpen 绝不放行。
			// newWebSocket 是异步的：它返回时 onOpen 一定还没跑，所以绝不能在这里
			// 用任何「当前连接还是空的」判断提前放行——一旦提前放行，循环会在连接
			// 健康时每秒再拨一条新连接，网关只好用 4003 把旧连接换掉，手机侧就是
			// 「在线 / 已关闭」每秒闪一次。
			val disconnected = java.util.concurrent.CountDownLatch(1)
			val request = Request.Builder().url("$url?token=$token&deviceId=$deviceId").build()
			try {
				ws = client.newWebSocket(
					request,
					object : WebSocketListener() {
						override fun onOpen(webSocket: WebSocket, response: Response) {
							backoff = 1_000L
							report(webSocket, "连接中", "握手中")
							// hello 必须最先发（网关要求 hello 优先），而 rooted 要跑 su、
							// 第一次还要等 Magisk 弹窗，可能几十秒：放后台线程，绝不能占住
							// OkHttp 的回调线程——那条线程同时负责读 pong，堵住它会让
							// pingInterval(20s) 超时，把一条好连接误判成断开。
							Thread {
								val hello = try {
									JSONObject().put("t", "hello")
										.put("token", token)
										.put("deviceId", deviceId)
										.put("model", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
										.put("androidVersion", Build.VERSION.RELEASE)
										.put("sdkInt", Build.VERSION.SDK_INT)
										.put("rooted", Shell.rootAvailable())
										.toString()
								} catch (_: Exception) {
									return@Thread
								}
								// 探测期间这条连接可能已经被换掉/关掉了。
								if (closed || webSocket !== ws) return@Thread
								val sent = try {
									webSocket.send(hello)
								} catch (_: Exception) {
									false
								}
								// 发失败说明这条 socket 已经废了：交给 onFailure/onClosed 走重连。
								if (!sent) return@Thread
								report(webSocket, "在线", "")
								// 心跳只能在 hello 之后起：抢在握手帧前面发 hb，网关会以 4001 关闭。
								startHeartbeat(webSocket)
							}.apply { isDaemon = true }.start()
						}

						override fun onMessage(webSocket: WebSocket, text: String) {
							onFrame(text)
						}

						override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
							report(webSocket, "断开", t.message ?: "")
							disconnected.countDown()
						}

						override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
							report(webSocket, "已关闭", "$code $reason")
							disconnected.countDown()
						}
					},
				)
			} catch (e: Exception) {
				// 地址非法之类：不能把重连线程带走，退避后再来。
				ws = null
				onState("断开", e.message ?: "连接失败")
				disconnected.countDown()
			}
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

	/**
	 * 只有「当前这条连接」的起落才更新状态。被网关 4003 换掉的旧 socket 稍后关闭时
	 * 也会回调，如果不管是谁都喊一声，通知栏就会在「在线」和「已关闭」之间来回跳；
	 * 已经 `close()` 掉的旧 client（改地址后重建）同样不该再往通知栏写字。
	 */
	private fun report(socket: WebSocket, state: String, detail: String) {
		if (!closed && socket === ws) onState(state, detail)
	}

	private fun startHeartbeat(socket: WebSocket) {
		Thread {
			while (!closed && socket === ws) {
				try {
					TimeUnit.SECONDS.sleep(15)
				} catch (_: InterruptedException) {
					return@Thread
				}
				if (!closed && socket === ws) {
					// close() 会关掉 OkHttp 的 dispatcher，晚到的 send 会抛
					// RejectedExecutionException；线程里未捕获的异常会把进程带走。
					try {
						socket.send(JSONObject().put("t", "hb").toString())
					} catch (_: Exception) {
						return@Thread
					}
					try {
						onTick()
					} catch (_: Exception) {
					}
				}
			}
		}.apply { isDaemon = true }.start()
	}
}
