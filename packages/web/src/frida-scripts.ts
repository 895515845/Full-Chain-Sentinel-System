/**
 * Built-in Frida scripts for the droid_frida tool.
 *
 * They are starting points, not magic: obfuscated or custom crypto needs the
 * script adjusted, and the agent should read the target's decompiled code before
 * trusting a hook name. Each script prints what it observes to stdout, which is
 * what the tool returns to the model.
 */

export interface FridaScript {
	name: string;
	summary: string;
	source: string;
}

export const FRIDA_SCRIPTS: Record<string, FridaScript> = {
	okhttp_log: {
		name: "okhttp_log",
		summary: "打印 OkHttp 每个请求/响应的明文（方法、URL、头、体）——HTTPS 抓包的最短路径",
		source: `Java.perform(function () {
  var Builder = Java.use("okhttp3.Request$Builder");
  Builder.build.overload().implementation = function () {
    var req = this.build();
    try {
      console.log("[okhttp] " + req.method() + " " + req.url());
      var body = req.body();
      if (body !== null) {
        var buf = Java.use("okio.Buffer").$new();
        body.writeTo(buf);
        console.log("[okhttp][body] " + buf.readUtf8());
      }
    } catch (e) { console.log("[okhttp][err] " + e); }
    return req;
  };
  console.log("[*] okhttp request logger installed");
});`,
	},
	ssl_pinning_bypass: {
		name: "ssl_pinning_bypass",
		summary: "通用证书校验绕过：TrustManager/HostnameVerifier/OkHttp CertificatePinner 三处一起打",
		source: `Java.perform(function () {
  var X509TrustManager = Java.use("javax.net.ssl.X509TrustManager");
  var SSLContext = Java.use("javax.net.ssl.SSLContext");
  var TrustManager = Java.registerClass({
    name: "com.sentinel.TrustAll",
    implements: [X509TrustManager],
    methods: {
      checkClientTrusted: function () {},
      checkServerTrusted: function () {},
      getAcceptedIssuers: function () { return []; },
    },
  });
  SSLContext.init.overload("[javax.net.ssl.KeyManager[]", "[javax.net.ssl.TrustManager[]", "java.security.SecureRandom")
    .implementation = function (km, tm, sr) {
      console.log("[*] SSLContext.init -> trust all");
      this.init(km, [TrustManager.$new()], sr);
    };
  var HostnameVerifier = Java.use("javax.net.ssl.HostnameVerifier");
  var VerifyAll = Java.registerClass({
    name: "com.sentinel.VerifyAll",
    implements: [HostnameVerifier],
    methods: { verify: function () { return true; } },
  });
  try {
    Java.use("javax.net.ssl.HttpsURLConnection").setHostnameVerifier.implementation = function (v) {
      this.setHostnameVerifier(VerifyAll.$new());
    };
  } catch (e) {}
  try {
    var pinner = Java.use("okhttp3.CertificatePinner");
    pinner.check.overload("java.lang.String", "java.util.List").implementation = function () {
      console.log("[*] OkHttp CertificatePinner.check bypassed: " + arguments[0]);
    };
  } catch (e) {}
  console.log("[*] SSL pinning bypass installed");
});`,
	},
	root_detection_bypass: {
		name: "root_detection_bypass",
		summary: "常见 root 检测绕过：File.exists 拦 su/superuser 路径、Runtime.exec 拦 which、build tag 改 release",
		source: `Java.perform(function () {
  var File = Java.use("java.io.File");
  var paths = ["/system/bin/su", "/system/xbin/su", "/sbin/su", "/system/app/Superuser.apk",
    "/system/bin/magisk", "/data/adb/magisk", "/system/bin/busybox"];
  File.$init.overload("java.lang.String").implementation = function (path) {
    for (var i = 0; i < paths.length; i++) if (path === paths[i]) path = "/nonexistent";
    return this.$init(path);
  };
  var Runtime = Java.use("java.lang.Runtime");
  Runtime.exec.overload("java.lang.String").implementation = function (cmd) {
    if (cmd.indexOf("which") >= 0 && (cmd.indexOf("su") >= 0 || cmd.indexOf("magisk") >= 0)) {
      console.log("[*] blocked exec: " + cmd);
      return this.exec("echo");
    }
    return this.exec(cmd);
  };
  var Build = Java.use("android.os.Build");
  Build.TAGS.value = "release-keys";
  console.log("[*] root detection bypass installed");
});`,
	},
	crypto_log: {
		name: "crypto_log",
		summary: "打印 javax.crypto 的算法、密钥与明文（AES/DES 的 doFinal）——用于还原自定义加解密",
		source: `Java.perform(function () {
  var Cipher = Java.use("javax.crypto.Cipher");
  Cipher.doFinal.overload("[B").implementation = function (input) {
    var result = this.doFinal(input);
    try {
      var mode = this.getOpmode === 1 ? "ENCRYPT" : "DECRYPT";
      console.log("[crypto] " + this.getAlgorithm() + " " + mode);
      console.log("[crypto][in ] " + bytesToB64(input));
      console.log("[crypto][out] " + bytesToB64(result));
    } catch (e) {}
    return result;
  };
  function bytesToB64(bytes) {
    var b64 = Java.use("android.util.Base64");
    return b64.encodeToString(bytes, 2);
  }
  console.log("[*] crypto logger installed");
});`,
	},
};

export function builtinScriptNames(): string[] {
	return Object.keys(FRIDA_SCRIPTS);
}

export function builtinScript(name: string): FridaScript | undefined {
	return FRIDA_SCRIPTS[name];
}
