plugins {
	id("com.android.application")
	id("org.jetbrains.kotlin.android")
}

android {
	namespace = "com.zgagent.droidbridge"
	compileSdk = 34

	defaultConfig {
		applicationId = "com.zgagent.droidbridge"
		// minSdk 26 (Android 8.0)：前台服务类型与通知渠道都按现代行为走。
		minSdk = 26
		targetSdk = 34
		// 版本号是"手机上装的是哪次构建"的唯一外部标识：装机后可用
		// `dumpsys package com.zgagent.droidbridge | grep versionName` 或系统应用信息页核对。
		versionCode = 3
		versionName = "0.1.2"
	}

	buildTypes {
		release {
			isMinifyEnabled = false
		}
	}
	compileOptions {
		sourceCompatibility = JavaVersion.VERSION_17
		targetCompatibility = JavaVersion.VERSION_17
	}
	kotlinOptions { jvmTarget = "17" }
	packaging { resources.excludes += "META-INF/*" }
}

dependencies {
	implementation("androidx.core:core-ktx:1.13.1")
	implementation("androidx.appcompat:appcompat:1.7.0")
	implementation("com.squareup.okhttp3:okhttp:4.12.0")
	implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
	// 扫码填入反连地址（二维码由控制台「安卓设备」页生成）
	implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
