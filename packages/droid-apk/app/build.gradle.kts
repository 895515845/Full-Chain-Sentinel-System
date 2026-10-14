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
		versionCode = 1
		versionName = "0.1.0"
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
}
