package com.zgagent.droidbridge

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/** 设置页：填服务器反连地址与 token，启动/停止前台服务。 */
class MainActivity : AppCompatActivity() {
	private lateinit var prefs: Prefs
	private lateinit var status: TextView

	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		prefs = Prefs(this)

		val pad = (16 * resources.displayMetrics.density).toInt()
		val root = LinearLayout(this).apply {
			orientation = LinearLayout.VERTICAL
			setPadding(pad, pad, pad, pad)
		}

		root.addView(TextView(this).apply { text = "服务器反连地址（ws://IP:端口/ws/droid）" })
		val urlInput = EditText(this).apply {
			hint = "ws://192.168.1.10:8080/ws/droid"
			setText(prefs.serverUrl)
		}
		root.addView(urlInput)

		root.addView(TextView(this).apply { text = "token（控制台「安卓设备」页创建）" })
		val tokenInput = EditText(this).apply {
			hint = "droid_…"
			setText(prefs.token)
		}
		root.addView(tokenInput)

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
			val intent = Intent(this, DroidService::class.java)
			ContextCompat.startForegroundService(this, intent)
			status.text = "已启动，状态见通知栏"
		}
		stop.setOnClickListener {
			stopService(Intent(this, DroidService::class.java))
			status.text = "已停止"
		}
	}
}
