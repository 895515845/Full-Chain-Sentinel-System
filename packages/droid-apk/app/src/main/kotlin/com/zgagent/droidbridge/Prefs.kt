package com.zgagent.droidbridge

import android.content.Context
import android.content.SharedPreferences

/** 服务器地址、token 与设备 ID 的本地存储。deviceId 首次生成后永久使用。 */
class Prefs(context: Context) {
	private val sp: SharedPreferences = context.getSharedPreferences("droid", Context.MODE_PRIVATE)

	var serverUrl: String
		get() = sp.getString("serverUrl", "") ?: ""
		set(value) = sp.edit().putString("serverUrl", value.trim()).apply()

	var token: String
		get() = sp.getString("token", "") ?: ""
		set(value) = sp.edit().putString("token", value.trim()).apply()

	val deviceId: String
		get() {
			val existing = sp.getString("deviceId", null)
			if (existing != null) return existing
			val generated = java.util.UUID.randomUUID().toString()
			sp.edit().putString("deviceId", generated).apply()
			return generated
		}
}
