/**
 * Built-in Frida scripts for the droid_frida and droid_unpack tools.
 *
 * They are starting points, not magic: obfuscated or custom crypto needs the
 * script adjusted, and the agent should read the target's decompiled code before
 * trusting a hook name. Each script prints what it observes to stdout, which is
 * what the tool returns to the model.
 *
 * Scripts read operator-tunable parameters through `sp(key, fallback)`, a helper
 * the tool injects before the script body: `crypto_log?alg=AES` runs crypto_log
 * with SENTINEL_PARAMS = { alg: "AES" }. Every parameter is optional; a script
 * must work with defaults alone.
 */

export interface FridaScript {
	name: string;
	summary: string;
	source: string;
}

/** JS prelude injected ahead of every builtin script body. */
function prelude(params: Record<string, string>): string {
	return `var SENTINEL_PARAMS = ${JSON.stringify(params)};\nfunction sp(k, d) { return SENTINEL_PARAMS[k] !== undefined ? SENTINEL_PARAMS[k] : d; }\n`;
}

/**
 * Parse a script spec: "name", "name?param=value&param=value", or a bare
 * work-directory path (no params). Never throws; unknown names are passed back
 * so the caller can treat them as file paths.
 */
export function parseScriptSpec(spec: string): { name: string; params: Record<string, string> } {
	const queryAt = spec.indexOf("?");
	if (queryAt < 0) return { name: spec, params: {} };
	const params: Record<string, string> = {};
	for (const pair of spec.slice(queryAt + 1).split("&")) {
		const eq = pair.indexOf("=");
		if (eq <= 0) continue;
		params[pair.slice(0, eq).trim()] = decodeURIComponent(pair.slice(eq + 1).trim());
	}
	return { name: spec.slice(0, queryAt), params };
}

/** Output marker injected before each script; the tool splits sections on it. */
export function scriptBanner(name: string): string {
	return `===== sentinel: ${name} =====`;
}

export const FRIDA_SCRIPTS: Record<string, FridaScript> = {
	okhttp_log: {
		name: "okhttp_log",
		summary:
			"打印 OkHttp 每个请求/响应的明文（方法、URL、头、体）。参数：url=子串过滤（只打印 URL 含该子串的请求）。适用 OkHttp3/4 网络库；自定义 socket/自研协议看不到",
		source: `Java.perform(function () {
  var filter = sp("url", "");
  var Builder = Java.use("okhttp3.Request$Builder");
  Builder.build.overload().implementation = function () {
    var req = this.build();
    try {
      var url = req.url().toString();
      if (filter === "" || url.indexOf(filter) >= 0) {
        console.log("[okhttp] " + req.method() + " " + url);
        var body = req.body();
        if (body !== null) {
          var buf = Java.use("okio.Buffer").$new();
          body.writeTo(buf);
          console.log("[okhttp][body] " + buf.readUtf8());
        }
      }
    } catch (e) { console.log("[okhttp][err] " + e); }
    return req;
  };
  console.log("[*] okhttp request logger installed" + (filter ? " (url contains '" + filter + "')" : ""));
});`,
	},
	ssl_pinning_bypass: {
		name: "ssl_pinning_bypass",
		summary:
			"通用证书校验绕过：TrustManager/HostnameVerifier/OkHttp CertificatePinner（含 4.x check$okhttp）/NetworkSecurityConfig 一起打。Java 层通用；native 层 pinning 请另跑 native_ssl_bypass",
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
  try {
    // OkHttp 4.x: the Kotlin compiler renamed check to check$okhttp.
    Java.use("okhttp3.CertificatePinner")["check$okhttp"].overload(
      "java.lang.String",
      "kotlin.jvm.functions.Function0",
      "java.util.Set",
    ).implementation = function (hostname) {
      console.log("[*] OkHttp check$okhttp bypassed: " + hostname);
    };
  } catch (e) {}
  try {
    // NetworkSecurityConfig: stop rejecting user-added CAs.
    var NSC = Java.use("android.security.net.config.NetworkSecurityTrustManager");
    NSC.checkServerTrusted.overload("[Ljava.security.cert.X509Certificate;", "java.lang.String", "java.net.Socket")
      .implementation = function () {};
  } catch (e) {}
  console.log("[*] SSL pinning bypass installed");
});`,
	},
	root_detection_bypass: {
		name: "root_detection_bypass",
		summary:
			"常见 root 检测绕过：File.exists 拦 su/magisk/ksu 路径、Runtime.exec 单参数与 String[] 两种都拦、build tag 改 release-keys、PackageManager 隐藏 magisk/supersu 包名",
		source: `Java.perform(function () {
  var File = Java.use("java.io.File");
  var paths = ["/system/bin/su", "/system/xbin/su", "/sbin/su", "/system/app/Superuser.apk",
    "/system/bin/magisk", "/data/adb/magisk", "/sbin/.magisk", "/data/adb/ksu", "/data/adb/ksud",
    "/system/bin/busybox", "/debug_ramdisk", "/su/bin/su"];
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
  Runtime.exec.overload("[Ljava.lang.String;").implementation = function (argv) {
    for (var i = 0; i < argv.length; i++) {
      var a = argv[i];
      if (a === "su" || a === "which" || a.indexOf("magisk") >= 0 || a.indexOf("busybox") >= 0) {
        console.log("[*] blocked exec[]: " + argv.join(" "));
        return this.exec("echo");
      }
    }
    return this.exec(argv);
  };
  var Build = Java.use("android.os.Build");
  Build.TAGS.value = "release-keys";
  try {
    var PM = Java.use("android.app.ApplicationPackageManager");
    var hidden = ["com.topjohnwu.magisk", "eu.chainfire.supersu", "com.koushikdutta.superuser", "me.weishu.kernelsu"];
    PM.getPackageInfo.overload("java.lang.String", "int").implementation = function (pkg, flags) {
      if (hidden.indexOf(pkg) >= 0) {
        console.log("[*] hid package from getPackageInfo: " + pkg);
        throw Java.use("android.content.pm.PackageManager$NameNotFoundException").$new(pkg);
      }
      return this.getPackageInfo(pkg, flags);
    };
  } catch (e) {}
  console.log("[*] root detection bypass installed");
});`,
	},
	crypto_log: {
		name: "crypto_log",
		summary:
			"打印 javax.crypto 的算法、密钥与明文（Cipher 与 Mac 的 doFinal）——用于还原自定义加解密。参数：alg=算法子串过滤（例如 AES、DES、HmacSHA256）",
		source: `Java.perform(function () {
  var algFilter = sp("alg", "");
  function b64(bytes) {
    return Java.use("android.util.Base64").encodeToString(bytes, 2);
  }
  function logCipher(cipher, input, result) {
    try {
      var alg = cipher.getAlgorithm();
      if (algFilter !== "" && alg.indexOf(algFilter) < 0) return;
      var mode = cipher._sentinelMode === 1 ? "ENCRYPT" : cipher._sentinelMode === 2 ? "DECRYPT" : "UNKNOWN";
      console.log("[crypto] " + alg + " " + mode);
      console.log("[crypto][in ] " + b64(input));
      console.log("[crypto][out] " + b64(result));
    } catch (e) {}
  }
  // Cipher has no public opmode getter: remember it from init. The first
  // init overload takes opmode as its own first argument, the spec variants as
  // their second.
  var Cipher = Java.use("javax.crypto.Cipher");
  Cipher.init.overload("int", "java.security.Key").implementation = function (opmode, key) {
    this._sentinelMode = opmode;
    try { console.log("[crypto][key] " + this.getAlgorithm() + " " + b64(key.getEncoded())); } catch (e) {}
    return this.init(opmode, key);
  };
  Cipher.init.overload("int", "java.security.Key", "java.security.spec.AlgorithmParameterSpec").implementation =
    function (opmode, key, spec) {
      this._sentinelMode = opmode;
      try { console.log("[crypto][key] " + this.getAlgorithm() + " " + b64(key.getEncoded())); } catch (e) {}
      try { console.log("[crypto][spec] " + spec); } catch (e) {}
      return this.init(opmode, key, spec);
    };
  Cipher.doFinal.overload("[B").implementation = function (input) {
    var result = this.doFinal(input);
    logCipher(this, input, result);
    return result;
  };
  try {
    var Mac = Java.use("javax.crypto.Mac");
    Mac.doFinal.overload("[B").implementation = function (input) {
      var result = this.doFinal(input);
      try {
        var alg = this.getAlgorithm();
        if (algFilter === "" || alg.indexOf(algFilter) >= 0) {
          console.log("[mac] " + alg + " in=" + b64(input) + " out=" + b64(result));
        }
      } catch (e) {}
      return result;
    };
  } catch (e) {}
  console.log("[*] crypto logger installed" + (algFilter ? " (alg contains '" + algFilter + "')" : ""));
});`,
	},
	native_ssl_bypass: {
		name: "native_ssl_bypass",
		summary:
			"native 层证书校验绕过：hook libssl/boringssl 的 SSL_CTX_set_verify 与 SSL_get_verify_result。覆盖 Unity/xlua/自编译 curl/部分 Flutter；纯 Java 层校验请用 ssl_pinning_bypass",
		source: `(function () {
  ["libssl.so", "libcrypto.so", "libconscrypt_jni.so"].forEach(function (lib) {
    var mod = Process.findModuleByName(lib);
    if (!mod) return;
    ["SSL_CTX_set_verify", "SSL_set_verify"].forEach(function (fn) {
      var addr = Module.findExportByName(lib, fn);
      if (addr) {
        Interceptor.replace(addr, new NativeCallback(function () {}, "void", ["pointer", "int", "pointer"]));
        console.log("[*] " + lib + "!" + fn + " -> no-op");
      }
    });
    var gv = Module.findExportByName(lib, "SSL_get_verify_result");
    if (gv) {
      Interceptor.replace(gv, new NativeCallback(function () { return 0; }, "long", ["pointer"]));
      console.log("[*] " + lib + "!SSL_get_verify_result -> X509_V_OK");
    }
  });
  console.log("[*] native ssl bypass installed");
})();`,
	},
	flutter_bypass: {
		name: "flutter_bypass",
		summary:
			"Flutter（dart:io）证书校验绕过：在 libflutter.so 里 pattern 扫描 ssl_verify 并把返回值置 0。只对未改动过的官方 flutter 引擎 so 有效；release 且换过引擎的包会扫不到",
		source: `(function () {
  var mod = Process.findModuleByName("libflutter.so");
  if (!mod) { console.log("[!] libflutter.so 未加载：确认这是 Flutter 应用，或用 spawn 模式重试"); return; }
  // BoringSSL ssl_x509.cc ssl_verify prologues (arm64), community-standard.
  var patterns = [
    "FF 03 01 D1 FD 7B 01 A9 3F C3 00 91 FA 67 01 A9 F8 5F 02 A9 F6 57 03 A9 F4 4F 04 A9",
    "F4 4F 04 A9 FD 7B 05 A9 FD C3 01 91 B5 00 00 34 C0 02 00 34"
  ];
  for (var i = 0; i < patterns.length; i++) {
    var matches;
    try {
      matches = Memory.scanSync(mod.base, mod.size, patterns[i]);
    } catch (e) { continue; }
    if (matches.length > 0) {
      matches.forEach(function (m) {
        Interceptor.attach(m.address, { onLeave: function (ret) { ret.replace(0); } });
        console.log("[*] ssl_verify patched @ " + m.address + " (pattern " + i + ")");
      });
      return;
    }
  }
  console.log("[!] 两个 pattern 都没命中：flutter 版本过新或引擎被改动，可改用 reFlutter 重打包方案");
})();`,
	},
	anti_frida_bypass: {
		name: "anti_frida_bypass",
		summary:
			"反调试/反 frida 绕过：ptrace 恒 0、strstr 拦 frida/gum/gadget 字符串、27042 端口 connect 探测失效。app 闪退或自行检测到 frida 时先跑这个（放在脚本列表第一个）",
		source: `(function () {
  var ptrace = Module.findExportByName(null, "ptrace");
  if (ptrace) {
    Interceptor.replace(ptrace, new NativeCallback(function () { return 0; }, "long", ["int", "int", "pointer", "pointer"]));
    console.log("[*] ptrace -> 0");
  }
  var strstr = Module.findExportByName(null, "strstr");
  if (strstr) {
    var needles = ["frida", "gum-js", "gadget", "linjector"];
    Interceptor.attach(strstr, {
      onEnter: function (args) { this.needleStr = Memory.readCString(args[1]); },
      onLeave: function (ret) {
        if (!this.needleStr) return;
        for (var i = 0; i < needles.length; i++) {
          if (this.needleStr.indexOf(needles[i]) >= 0) { ret.replace(ptr(0)); return; }
        }
      },
    });
    console.log("[*] strstr filter installed");
  }
  var connect = Module.findExportByName(null, "connect");
  if (connect) {
    Interceptor.attach(connect, {
      onEnter: function (args) {
        // sockaddr_in: family(u16), port(u16, big-endian). 27042 = 0x69A2.
        this.blocked =
          Memory.readU16(args[1]) === 2 &&
          Memory.readU8(args[1].add(2)) === 0x69 &&
          Memory.readU8(args[1].add(3)) === 0xa2;
        if (this.blocked) console.log("[*] blocked connect to 27042 (frida port probe)");
      },
      onLeave: function (ret) { if (this.blocked) ret.replace(-1); },
    });
  }
  console.log("[*] anti-frida bypass installed");
})();`,
	},
	dex_dump: {
		name: "dex_dump",
		summary:
			"内存脱壳（FRIDA-DEXDump 风格）：扫描进程内存中的 dex magic 并落盘到 /data/local/tmp/sentinel-unpack/。配合 spawn 模式在壳解密完成后收集；抽取壳（函数体 nop）dump 出的方法体仍是空的",
		source: `(function () {
  var SAVE_DIR = "/data/local/tmp/sentinel-unpack";
  var dumped = {};
  var count = 0;
  function dumpDex(addr) {
    try {
      var magic = new Uint8Array(Memory.readByteArray(addr, 4));
      if (magic[0] !== 0x64 || magic[1] !== 0x65 || magic[2] !== 0x78 || magic[3] !== 0x0a) return;
      var fileSize = Memory.readU32(addr.add(32));
      if (fileSize < 112 || fileSize > 120 * 1024 * 1024) return;
      var key = addr.toString() + ":" + fileSize;
      if (dumped[key]) return;
      dumped[key] = true;
      var path = SAVE_DIR + "/classes_" + addr.toString(16) + "_" + fileSize + ".dex";
      var f = new File(path, "wb");
      f.write(Memory.readByteArray(addr, fileSize));
      f.close();
      count++;
      console.log("[dexdump] saved " + path);
    } catch (e) {}
  }
  function scan() {
    var ranges = Process.enumerateRanges("r--").concat(Process.enumerateRanges("rw-"));
    ranges.forEach(function (range) {
      if (range.size < 112 || range.size > 120 * 1024 * 1024) return;
      try {
        Memory.scan(range.base, range.size, "64 65 78 0a 30 33", {
          onMatch: function (addr) { dumpDex(addr); },
          onComplete: function () {},
        });
      } catch (e) {}
    });
  }
  Java.perform(function () {
    try {
      Java.use("java.lang.Runtime").getRuntime().exec(["mkdir", "-p", SAVE_DIR]);
    } catch (e) {}
    // One pass now (the class loader holds decrypted dex) and one later: late
    // plugins and multidex land between the passes.
    setTimeout(scan, 500);
    setTimeout(scan, 8000);
    setTimeout(function () { console.log("[dexdump] finished, " + count + " dex saved to " + SAVE_DIR); }, 9000);
  });
})();`,
	},
};

export function builtinScriptNames(): string[] {
	return Object.keys(FRIDA_SCRIPTS);
}

export function builtinScript(name: string): FridaScript | undefined {
	return FRIDA_SCRIPTS[name];
}

/**
 * Resolve one spec ("name", "name?key=value", or a custom path) into JS source.
 * Builtin names get the parameter prelude and an output banner; anything else
 * is returned unchanged so the caller can treat it as a work-directory path.
 */
export function resolveBuiltinScript(
	spec: string,
): { name: string; source: string } | { path: string } | { error: string } {
	const parsed = parseScriptSpec(spec);
	const builtin = FRIDA_SCRIPTS[parsed.name];
	if (!builtin) {
		// A "?" means the caller meant a builtin with parameters; an unknown name
		// then is a mistake worth reporting, not a file path.
		if (spec.includes("?")) return { error: `未知内建脚本：${parsed.name}` };
		return { path: parsed.name };
	}
	return {
		name: builtin.name,
		source: `${prelude(parsed.params)}console.log("\\n===== ${scriptBanner(builtin.name)} =====");\n${builtin.source}`,
	};
}
