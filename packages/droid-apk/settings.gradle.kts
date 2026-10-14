// 阿里云镜像优先：国内网络拉 AGP/Kotlin/依赖不走 google() / mavenCentral 的原站。
pluginManagement {
	repositories {
		maven("https://maven.aliyun.com/repository/gradle-plugin")
		maven("https://maven.aliyun.com/repository/google")
		maven("https://maven.aliyun.com/repository/public")
		google()
		mavenCentral()
		gradlePluginPortal()
	}
}
dependencyResolutionManagement {
	repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
	repositories {
		maven("https://maven.aliyun.com/repository/google")
		maven("https://maven.aliyun.com/repository/public")
		google()
		mavenCentral()
	}
}
rootProject.name = "DroidBridge"
include(":app")
