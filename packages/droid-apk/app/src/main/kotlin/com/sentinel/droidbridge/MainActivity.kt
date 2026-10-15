package com.sentinel.droidbridge

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.zxing.integration.android.IntentIntegrator

/** 设置页：扫码或手动填服务器反连地址与 token，启动/停止前台服务。 */
class MainActivity : Activity() {
	private lateinit var prefs: Prefs
	private lateinit var status: TextView
	private lateinit var urlInput: EditText
	private lateinit var tokenInput: EditText

	/** 请求码：相机权限（通知权限用 1，扫码结果由 zxing 自己的固定请求码返回）。 */
	private val cameraRequest = 2

	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		prefs = Prefs(this)

		val pad = (16 * resources.displayMetrics.density).toInt()
		val root = LinearLayout(this).apply {
			orientation = LinearLayout.VERTICAL
			setPadding(pad, pad, pad, pad)
		}

		root.addView(TextView(this).apply { text = "服务器反连地址（ws://IP:端口/ws/droid）" })
		urlInput = EditText(this).apply {
			hint = "ws://192.168.1.10:9944/ws/droid"
			setText(prefs.serverUrl)
		}
		root.addView(urlInput)

		root.addView(TextView(this).apply { text = "token（控制台「安卓设备」页创建）" })
		tokenInput = EditText(this).apply {
			hint = "droid_…"
			setText(prefs.token)
		}
		root.addView(tokenInput)

		root.addView(
			Button(this).apply {
				text = "扫码填入（扫控制台二维码）"
				setOnClickListener { initiateScan() }
			},
		)

		root.addView(TextView(this).apply { text = "设备 ID（自动生成，无需修改）" })
		root.addView(TextView(this).apply { text = prefs.deviceId; setTextIsSelectable(true) })

		val start = Button(this).apply { text = "启动反连" }
		val stop = Button(this).apply { text = "停止反连" }
		root.addView(start)
		root.addView(stop)

		// 守护进程是独立进程：单个进程被冻结（模拟器/系统节能策略）或被杀时由它恢复。
		// 关掉它就是不要第二个前台通知，代价是被冻后只能等控制台侧的看门狗报无响应。
		root.addView(
			CheckBox(this).apply {
				text = "守护进程（独立进程，被冻结/被杀后自动恢复）"
				isChecked = prefs.guardEnabled
				setOnCheckedChangeListener { _, checked ->
					prefs.guardEnabled = checked
					if (checked) {
						GuardService.start(this@MainActivity, Process.myPid())
					} else {
						stopService(Intent(this@MainActivity, GuardService::class.java))
					}
				}
			},
		)

		status = TextView(this).apply { text = "状态见通知栏" }
		root.addView(status)

		setContentView(root)

		start.setOnClickListener {
			prefs.serverUrl = urlInput.text.toString()
			prefs.token = tokenInput.text.toString()
			// Android 13+ 通知权限：前台服务要有通知，先请求。
			if (Build.VERSION.SDK_INT >= 33 &&
				ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
			) {
				ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
			}
			ContextCompat.startForegroundService(this, Intent(this, DroidService::class.java))
			status.text = "已启动，状态见通知栏"
		}
		stop.setOnClickListener {
			stopService(Intent(this, DroidService::class.java))
			status.text = "已停止"
		}
	}

	/** 扫控制台「安卓设备」页的二维码：ws(s)://host:port/ws/droid?token=droid_… */
	private fun initiateScan() {
		if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
			ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), cameraRequest)
			return
		}
		val integrator = IntentIntegrator(this)
		integrator.setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
		integrator.setPrompt("对准控制台「安卓设备」页的二维码")
		integrator.setBeepEnabled(false)
		integrator.initiateScan()
	}

	/** 相机权限刚被授予时直接开扫，否则操作员得再点一次「扫码填入」才有效果。 */
	override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
		super.onRequestPermissionsResult(requestCode, permissions, grantResults)
		if (requestCode != cameraRequest) return
		if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
			initiateScan()
		} else {
			status.text = "未获得相机权限，无法扫码"
		}
	}

	/** 解析二维码内容：反连地址 + token 一键填入。 */
	private fun applyScanned(text: String) {
		val trimmed = text.trim()
		if (!trimmed.startsWith("ws://") && !trimmed.startsWith("wss://")) {
			status.text = "二维码内容不是反连地址"
			return
		}
		val uri = Uri.parse(trimmed)
		val base = uri.scheme + "://" + uri.authority + uri.path
		val token = uri.getQueryParameter("token") ?: ""
		urlInput.setText(base)
		tokenInput.setText(token)
		prefs.serverUrl = base
		prefs.token = token
		status.text = "已填入，点「启动反连」"
	}

	override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
		// zxing 的 IntentIntegrator 用它自己的固定请求码（IntentIntegrator.REQUEST_CODE）
		// 启动扫码 Activity；此前这里比对的是一个自定义值 42，永远不相等，扫码结果
		// 被当成别人的结果直接丢掉，所以「扫码填入」看着完全没反应。
		if (requestCode == IntentIntegrator.REQUEST_CODE) {
			val result = IntentIntegrator.parseActivityResult(resultCode, data)
			val contents = result?.contents
			if (!contents.isNullOrEmpty()) {
				applyScanned(contents)
			} else {
				status.text = "扫码取消"
			}
			return
		}
		super.onActivityResult(requestCode, resultCode, data)
	}
}
