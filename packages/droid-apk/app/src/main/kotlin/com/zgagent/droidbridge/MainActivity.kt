package com.zgagent.droidbridge

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.Button
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

	private val scanRequest = 42

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
			ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), 2)
			return
		}
		val integrator = IntentIntegrator(this)
		integrator.setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
		integrator.setPrompt("对准控制台「安卓设备」页的二维码")
		integrator.setBeepEnabled(false)
		integrator.initiateScan()
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
		if (requestCode == scanRequest) {
			val result = IntentIntegrator.parseActivityResult(requestCode, resultCode, data)
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
