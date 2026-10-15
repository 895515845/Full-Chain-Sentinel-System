package com.sentinel.droidbridge

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Process
import android.system.OsConstants
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * 兄弟进程守护：另一个进程（`:guard`）里的前台服务，负责把被冻住或被杀掉的反连进程
 * 拽回来。
 *
 * Android 与模拟器可以给整个 app 进程发 SIGSTOP：所有线程停住、TCP 连接却仍是
 * ESTABLISHED，控制台于是看到一个「在线但什么都不回」的设备。被冻的进程自己救不了
 * 自己（SIGCONT 必须由外部发），而第二个进程是唯一不需要 root、不需要 adb 的「外部」：
 * 同 uid，内核允许它给兄弟进程发信号（`Process.sendSignal`，公开 API）；它自己带前台
 * 服务，平台也不会把它当缓存进程冻掉。这正是宿主侧 adb 看门狗在做的事，只是搬进了
 * app，于是任何机器、任何设备都成立，不需要 adb，也不需要设备已 root。
 *
 * 救不了「整个包一起被冻」：那时它同样被冻住，app 侧无解（只能靠设备外的看门狗，或者
 * 关掉模拟器的后台冻结）。它能救的是「单个进程被冻」和「反连进程被杀」两种情况。
 *
 * 每 [TICK_MS] 给主进程盲发一个 SIGCONT：没被冻时它是空操作，被冻时这一下就让它继续
 * 跑，所以不需要先读状态（同 uid 读 /proc 在各版本上限制不一，读不到不该成为救不回来
 * 的理由）。信号发失败（进程已经不在）或进程表里找不到反连进程时，重新拉起反连服务。
 */
class GuardService : Service() {
	companion object {
		/** 主进程 pid：主进程每次启动/刷新守护进程都会带过来。 */
		private const val EXTRA_MAIN_PID = "mainPid"
		/** 轮询间隔：被冻住后最坏这么久恢复，也是这个进程的唤醒频率。 */
		private const val TICK_MS = 15_000L
		/** 反连进程的进程名；守护进程自己是 `<包名>:guard`。 */
		private const val MAIN_PROCESS = "com.sentinel.droidbridge"
		private const val TAG = "DroidGuard"

		/** 启动或刷新守护进程：已经活着时只是更新主进程 pid。 */
		fun start(context: Context, mainPid: Int) {
			val intent = Intent(context, GuardService::class.java).putExtra(EXTRA_MAIN_PID, mainPid)
			try {
				ContextCompat.startForegroundService(context, intent)
			} catch (_: Exception) {
				// Android 12+ 的后台前台服务限制：退回普通 startService（app 自己有前台
				// 服务，不会被后台服务限制拦住）。两条都失败就算了——平台的 START_STICKY
				// 通常已经先把反连服务拉起来了。
				try {
					context.startService(intent)
				} catch (_: Exception) {
				}
			}
		}
	}

	private lateinit var thread: HandlerThread
	private lateinit var handler: Handler
	private var mainPid = 0
	/** 拉起过几次反连服务，写进通知栏，方便判断是不是在反复重启。 */
	private var restarts = 0

	override fun onCreate() {
		super.onCreate()
		startForeground()
		thread = HandlerThread("droid-guard").apply { start() }
		handler = Handler(thread.looper)
		handler.postDelayed(tick, TICK_MS)
	}

	override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
		val pid = intent?.getIntExtra(EXTRA_MAIN_PID, 0) ?: 0
		if (pid > 0 && pid != Process.myPid()) mainPid = pid
		return START_STICKY
	}

	override fun onBind(intent: Intent?): IBinder? = null

	override fun onDestroy() {
		handler.removeCallbacksAndMessages(null)
		thread.quitSafely()
		super.onDestroy()
	}

	private val tick = object : Runnable {
		override fun run() {
			keepMainAlive()
			handler.postDelayed(this, TICK_MS)
		}
	}

	private fun keepMainAlive() {
		if (mainPid <= 0) mainPid = runningMainPid()
		if (mainPid > 0) {
			// 状态只用于日志：读不到（SELinux 限制）就记成未知，救的动作照发不误。
			val frozen = stateOf(mainPid) == "T"
			try {
				Process.sendSignal(mainPid, OsConstants.SIGCONT)
				if (frozen) Log.i(TAG, "反连进程 $mainPid 被冻住（STAT=T），已 SIGCONT")
				return
			} catch (e: Exception) {
				// pid 已经不存在（或不再是我们的进程）：落到下面重新拉起。
				Log.w(TAG, "给 $mainPid 发 SIGCONT 失败：${e.message}")
				mainPid = 0
			}
		}
		restartMain()
	}

	/** 进程状态（`T` = 被冻住）；读不到返回空串。 */
	private fun stateOf(pid: Int): String = try {
		java.io.File("/proc/$pid/stat").readText().substringAfterLast(')').trim().split(' ').firstOrNull() ?: ""
	} catch (_: Exception) {
		""
	}

	/** 反连进程（不含 `:guard`）的 pid；进程表拿不到时返回 0。 */
	private fun runningMainPid(): Int {
		val manager = getSystemService(ActivityManager::class.java) ?: return 0
		val self = Process.myPid()
		return manager.runningAppProcesses?.firstOrNull { it.processName == MAIN_PROCESS && it.pid != self }?.pid ?: 0
	}

	private fun restartMain() {
		restarts += 1
		Log.i(TAG, "反连进程不在，拉起反连服务（第 $restarts 次）")
		onState("反连进程不在，正在拉起（第 $restarts 次）")
		try {
			ContextCompat.startForegroundService(this, Intent(this, DroidService::class.java))
		} catch (_: Exception) {
			try {
				startService(Intent(this, DroidService::class.java))
			} catch (_: Exception) {
			}
		}
	}

	private fun startForeground() {
		val manager = getSystemService(NotificationManager::class.java)
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
			// IMPORTANCE_MIN：守护进程的通知默认折叠，不打扰操作员。
			manager.createNotificationChannel(
				NotificationChannel("droid-guard", getString(R.string.guard_channel), NotificationManager.IMPORTANCE_MIN),
			)
		}
		startForeground(2, builder("盯着反连进程").build())
	}

	private fun onState(text: String) {
		getSystemService(NotificationManager::class.java).notify(2, builder(text).build())
	}

	private fun builder(contentText: String): Notification.Builder {
		val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
			Notification.Builder(this, "droid-guard")
		} else {
			@Suppress("DEPRECATION") Notification.Builder(this)
		}
		b.setContentTitle(getString(R.string.guard_title)).setContentText(contentText)
			.setSmallIcon(android.R.drawable.stat_sys_download_done)
		return b
	}
}
