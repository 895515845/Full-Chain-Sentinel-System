/**
 * Built-in Frida scripts for the iOS tools.
 *
 * Same contract as the Android registry: a script is a starting point, prints
 * what it sees to stdout, and reads optional parameters through `sp()`. The
 * hooks are Objective-C / C level because that is what iOS targets expose;
 * Swift-only code needs symbols or Swift demangling, which is out of scope.
 */

import { type FridaScript, parseScriptSpec, prelude, scriptBanner } from "./frida-scripts.ts";

/**
 * Frida 17 removed `Module.findExportByName`; keep one helper so the built-in
 * scripts work on both 16.x and 17.x servers.
 */
const IOS_EXPORT_COMPAT = `function sentinelFindExport(name, moduleName) {
  try {
    if (moduleName) {
      var mod = Process.findModuleByName(moduleName);
      return mod ? mod.findExportByName(name) : null;
    }
    if (Module.findGlobalExportByName) return Module.findGlobalExportByName(name);
    if (Module.findExportByName) return Module.findExportByName(null, name);
  } catch (e) {}
  return null;
}
`;

export const IOS_FRIDA_SCRIPTS: Record<string, FridaScript> = {
	ios_ssl_bypass: {
		name: "ios_ssl_bypass",
		summary:
			"绕过 iOS 证书校验：Security.framework 的 SecTrustEvaluate / SecTrustEvaluateWithError 直接返回通过，并让 BoringSSL 的 SSL_CTX_set_custom_verify 始终回调 ssl_verify_ok。参数：quiet=1 只打印安装结果",
		source: `function installTrustBypass() {
  var quiet = sp("quiet", "") === "1";
  function log(msg) { if (!quiet) console.log("[ssl] " + msg); }
  var evaluate = sentinelFindExport("SecTrustEvaluate", "Security");
  if (evaluate) {
    Interceptor.replace(evaluate, new NativeCallback(function (trust, result) {
      if (!result.isNull()) result.writeU32(1); // kSecTrustResultProceed
      return 0; // errSecSuccess
    }, "int", ["pointer", "pointer"]));
    log("SecTrustEvaluate replaced");
  }
  var evaluateWithError = sentinelFindExport("SecTrustEvaluateWithError", "Security");
  if (evaluateWithError) {
    Interceptor.replace(evaluateWithError, new NativeCallback(function (trust, error) {
      if (!error.isNull()) error.writePointer(ptr(0));
      return 1; // true
    }, "bool", ["pointer", "pointer"]));
    log("SecTrustEvaluateWithError replaced");
  }
  var customVerify = sentinelFindExport("SSL_CTX_set_custom_verify");
  if (customVerify) {
    Interceptor.replace(customVerify, new NativeCallback(function () { return 0; }, "void", []));
    log("SSL_CTX_set_custom_verify neutralized");
  }
  var setVerify = sentinelFindExport("SSL_CTX_set_verify");
  if (setVerify) {
    Interceptor.attach(setVerify, {
      onEnter: function (args) { args[1] = ptr(0); }, // SSL_VERIFY_NONE
    });
    log("SSL_CTX_set_verify forced to NONE");
  }
}
if (ObjC.available) installTrustBypass();
else console.log("[ssl] ObjC 不可用：确认目标是 App 进程而不是系统守护进程");
console.log("[*] ios_ssl_bypass installed");`,
	},
	ios_jailbreak_bypass: {
		name: "ios_jailbreak_bypass",
		summary:
			"绕过越狱检测：NSFileManager fileExistsAtPath / stat / access / fopen / lstat 对越狱路径返回不存在，canOpenURL 对 cydia 等 scheme 返回 false。参数：path=额外要隐藏的路径子串（多个用逗号分隔）",
		source: `function installJailbreakBypass() {
  var extra = sp("path", "").split(",").filter(function (item) { return item.length > 0; });
  var suspicious = ["/Applications/Cydia.app", "/Applications/Sileo.app", "/Library/MobileSubstrate", "/bin/bash", "/usr/sbin/sshd", "/etc/apt", "/var/jb", "/var/lib/dpkg", "/private/var/lib/apt"].concat(extra);
  function looksJailbroken(path) {
    for (var i = 0; i < suspicious.length; i++) {
      if (path.indexOf(suspicious[i]) >= 0) return true;
    }
    return false;
  }
  var exists = sentinelFindExport("access");
  if (exists) {
    Interceptor.attach(exists, {
      onEnter: function (args) { this.path = args[0].readUtf8String(); },
      onLeave: function (retval) { if (this.path && looksJailbroken(this.path)) retval.replace(ptr(-1)); },
    });
    console.log("[jb] access hooked");
  }
  ["stat", "lstat", "fopen", "open"].forEach(function (name) {
    var fn = sentinelFindExport(name);
    if (!fn) return;
    Interceptor.attach(fn, {
      onEnter: function (args) { this.path = args[0].readUtf8String(); },
      onLeave: function (retval) {
        if (this.path && looksJailbroken(this.path)) retval.replace(ptr(-1));
      },
    });
    console.log("[jb] " + name + " hooked");
  });
  if (ObjC.available) {
    var FileManager = ObjC.classes.NSFileManager;
    if (FileManager) {
      Interceptor.attach(FileManager["- fileExistsAtPath:"].implementation, {
        onEnter: function (args) { this.path = new ObjC.Object(args[2]).toString(); },
        onLeave: function (retval) { if (looksJailbroken(this.path)) retval.replace(ptr(0)); },
      });
      console.log("[jb] NSFileManager fileExistsAtPath: hooked");
    }
    var UIApplication = ObjC.classes.UIApplication;
    if (UIApplication && UIApplication["- canOpenURL:"]) {
      Interceptor.attach(UIApplication["- canOpenURL:"].implementation, {
        onEnter: function (args) {
          var url = new ObjC.Object(args[2]).toString();
          this.blocked = /cydia|sileo|zbra|filza|undecimus/i.test(url);
        },
        onLeave: function (retval) { if (this.blocked) retval.replace(ptr(0)); },
      });
      console.log("[jb] canOpenURL: hooked");
    }
  }
}
installJailbreakBypass();
console.log("[*] ios_jailbreak_bypass installed");`,
	},
	ios_nslog: {
		name: "ios_nslog",
		summary:
			"采集日志：hook NSLog 与 os_log 打印格式串（变参无法完整格式化），可选 hook -[NSObject description] 观察对象。参数：filter=只打印含该子串的日志",
		source: `function installLogging() {
  var filter = sp("filter", "");
  function emit(kind, text) {
    if (!text) return;
    if (filter && text.indexOf(filter) < 0) return;
    console.log("[" + kind + "] " + text);
  }
  var NSLogFn = sentinelFindExport("NSLog");
  if (NSLogFn) {
    Interceptor.attach(NSLogFn, {
      onEnter: function (args) {
        try { emit("NSLog", new ObjC.Object(args[0]).toString()); } catch (e) { emit("NSLog", args[0].readUtf8String()); }
      },
    });
    console.log("[log] NSLog hooked");
  }
  ["os_log", "os_log_with_type", "_os_log", "_os_log_impl"].forEach(function (name) {
    var fn = sentinelFindExport(name);
    if (!fn) return;
    Interceptor.attach(fn, {
      onEnter: function (args) {
        // os_log(format, ...) and _os_log_impl(dso, log, format, ...) put the
        // format string in different slots; read whichever looks like a string.
        for (var i = 0; i < 4; i++) {
          try {
            var text = args[i].readUtf8String();
            if (text && text.length > 1) { emit(name, text); return; }
          } catch (e) { /* not a string pointer */ }
        }
      },
    });
    console.log("[log] " + name + " hooked");
  });
}
if (ObjC.available) installLogging();
else console.log("[log] ObjC 不可用，只能看到 os_log 格式串");
console.log("[*] ios_nslog installed");`,
	},
	ios_http_log: {
		name: "ios_http_log",
		summary:
			"在 NSURLSession/NSURLConnection 层记录明文请求与响应：方法、URL、头、body、状态码，输出 SENTINEL_HTTP JSON 行供控制台入库。参数：filter=URL 子串、host=host 子串、maxBody=单条 body 上限字节（默认 65536）",
		source: `if (!ObjC.available) {
  console.log("[http] ObjC 不可用：确认目标是 App 进程");
} else {
  var filter = sp("filter", "");
  var hostFilter = sp("host", "");
  var maxBody = parseInt(sp("maxBody", "65536"), 10);
  if (!(maxBody > 0)) maxBody = 65536;
  var seq = 0;
  var taskIds = {};
  var buffers = {};
  var skipped = {};
  var hookedDelegates = {};

  function inFilter(url) {
    if (!url) return false;
    if (hostFilter && url.indexOf(hostFilter) < 0) return false;
    if (filter && url.indexOf(filter) < 0) return false;
    return true;
  }

  function nextId() { seq += 1; return seq; }

  function asObject(value) {
    if (!value) return null;
    try {
      if (typeof value.length === "function" && typeof value.bytes === "function") return value;
      return new ObjC.Object(value);
    } catch (e) {
      return null;
    }
  }

  function headersOf(dict) {
    var out = {};
    if (!dict) return out;
    try {
      var keys = dict.allKeys();
      var count = keys.count();
      for (var i = 0; i < count; i++) {
        var key = keys.objectAtIndex_(i);
        var value = dict.objectForKey_(key);
        out[key.toString()] = value ? value.toString() : "";
      }
    } catch (e) { /* not a dictionary */ }
    return out;
  }

  function b64(ab) {
    if (!ab) return "";
    var bytes = new Uint8Array(ab);
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var out = "";
    for (var i = 0; i < bytes.length; i += 3) {
      var a = bytes[i];
      var b = i + 1 < bytes.length ? bytes[i + 1] : 0;
      var c = i + 2 < bytes.length ? bytes[i + 2] : 0;
      out += chars[a >> 2];
      out += chars[((a & 3) << 4) | (b >> 4)];
      out += i + 1 < bytes.length ? chars[((b & 15) << 2) | (c >> 6)] : "=";
      out += i + 2 < bytes.length ? chars[c & 63] : "=";
    }
    return out;
  }

  function bodyOf(data) {
    var obj = asObject(data);
    if (!obj) return { text: "", b64: "", size: 0 };
    var size = 0;
    try { size = obj.length(); } catch (e) { return { text: "", b64: "", size: 0 }; }
    if (size === 0) return { text: "", b64: "", size: 0 };
    var take = Math.min(size, maxBody);
    var ptr = null;
    try { ptr = obj.bytes(); } catch (e) { return { text: "", b64: "", size: size }; }
    if (!ptr || ptr.isNull()) return { text: "", b64: "", size: size };
    var ab = null;
    try { ab = ptr.readByteArray(take); } catch (e) { /* unreadable */ }
    var text = "";
    try {
      var s = ObjC.classes.NSString.alloc().initWithBytes_length_encoding_(ptr, take, 4);
      if (s) {
        var candidate = s.toString();
        if (candidate && candidate.indexOf("\\u0000") < 0) text = candidate;
      }
    } catch (e) { /* not UTF-8 */ }
    return { text: text, b64: b64(ab), size: size };
  }

  function emit(kind, id, payload) {
    payload.kind = kind;
    payload.id = id;
    console.log("SENTINEL_HTTP " + JSON.stringify(payload));
  }

  function requestInfo(request, bodyPtr) {
    var url = "";
    var method = "GET";
    var headers = {};
    var body = { text: "", b64: "", size: 0 };
    try {
      var req = asObject(request);
      if (req) {
        var u = req.URL();
        if (u) url = u.absoluteString().toString();
        var m = req.HTTPMethod();
        if (m) method = m.toString();
        headers = headersOf(req.allHTTPHeaderFields());
        body = bodyPtr ? bodyOf(bodyPtr) : bodyOf(req.HTTPBody());
        if (!bodyPtr && !req.HTTPBody()) {
          var stream = req.HTTPBodyStream();
          if (stream) body = { text: "", b64: "", size: 0, note: "body 是 HTTPBodyStream，未读取" };
        }
      }
    } catch (e) { /* malformed request */ }
    return { url: url, method: method, headers: headers, body: body };
  }

  function emitRequest(id, info) {
    emit("request", id, {
      method: info.method,
      url: info.url,
      headers: info.headers,
      bodyText: info.body.text,
      bodyB64: info.body.b64,
      bodySize: info.body.size,
      bodyNote: info.body.note || "",
    });
  }

  function emitResponse(id, data, response, error) {
    if (!id) return;
    var status = null;
    var headers = {};
    var resp = asObject(response);
    if (resp) {
      try {
        if (resp.isKindOfClass_(ObjC.classes.NSHTTPURLResponse)) {
          status = resp.statusCode();
          headers = headersOf(resp.allHeaderFields());
        }
      } catch (e) { /* not an HTTP response */ }
    }
    var body = bodyOf(data);
    var message = "";
    var err = asObject(error);
    if (err) {
      try { message = err.localizedDescription().toString(); } catch (e) { message = String(err); }
    }
    emit("response", id, {
      status: status,
      headers: headers,
      bodyText: body.text,
      bodyB64: body.b64,
      bodySize: body.size,
      error: message,
    });
  }

  function wrapCompletion(blockPtr, id) {
    if (!blockPtr || blockPtr.isNull()) return;
    try {
      var block = new ObjC.Block(blockPtr);
      var original = block.implementation;
      block.implementation = function (data, response, error) {
        try { emitResponse(id, data, response, error); } catch (e) { console.log("[http][err] response: " + e); }
        return original.call(this, data, response, error);
      };
    } catch (e) {
      console.log("[http][err] block: " + e);
    }
  }

  // NSURLConnection's async completion is (response, data, error), the opposite
  // order from NSURLSession's (data, response, error).
  function wrapConnectionCompletion(blockPtr, id) {
    if (!blockPtr || blockPtr.isNull()) return;
    try {
      var block = new ObjC.Block(blockPtr);
      var original = block.implementation;
      block.implementation = function (response, data, error) {
        try { emitResponse(id, data, response, error); } catch (e) { console.log("[http][err] connection response: " + e); }
        return original.call(this, response, data, error);
      };
    } catch (e) {
      console.log("[http][err] connection block: " + e);
    }
  }

  function taskKey(task) { return task.handle.toString(); }

  function ensureTask(task) {
    var key = taskKey(task);
    if (skipped[key]) return 0;
    if (taskIds[key]) return taskIds[key];
    var info = requestInfo(task.originalRequest(), null);
    if (!inFilter(info.url)) { skipped[key] = true; return 0; }
    var id = nextId();
    taskIds[key] = id;
    emitRequest(id, info);
    return id;
  }

  function appendBuffer(task, data) {
    var key = taskKey(task);
    if (!buffers[key]) buffers[key] = ObjC.classes.NSMutableData.data();
    var md = buffers[key];
    if (md.length() >= maxBody) return;
    var chunk = asObject(data);
    if (chunk) {
      try { md.appendData_(chunk); } catch (e) { /* ignore */ }
    }
  }

  function hookTaskWithBlock(selector, blockIndex, bodyIndex) {
    var method = ObjC.classes.NSURLSession[selector];
    if (!method) { console.log("[http] 未找到 " + selector); return; }
    Interceptor.attach(method.implementation, {
      onEnter: function (args) {
        try {
          var info = requestInfo(args[2], bodyIndex >= 0 ? args[bodyIndex] : null);
          if (!inFilter(info.url)) return;
          var id = nextId();
          emitRequest(id, info);
          this.id = id;
          wrapCompletion(args[blockIndex], id);
        } catch (e) { console.log("[http][err] " + selector + ": " + e); }
      },
      onLeave: function (retval) {
        if (!this.id || !retval || retval.isNull()) return;
        try { taskIds[taskKey(new ObjC.Object(retval))] = this.id; } catch (e) { /* ignore */ }
      },
    });
    console.log("[http] hooked " + selector);
  }

  function hookTaskNoBlock(selector, bodyIndex) {
    var method = ObjC.classes.NSURLSession[selector];
    if (!method) { console.log("[http] 未找到 " + selector); return; }
    Interceptor.attach(method.implementation, {
      onEnter: function (args) {
        try {
          var info = requestInfo(args[2], bodyIndex >= 0 ? args[bodyIndex] : null);
          if (!inFilter(info.url)) return;
          var id = nextId();
          this.id = id;
          emitRequest(id, info);
        } catch (e) { console.log("[http][err] " + selector + ": " + e); }
      },
      onLeave: function (retval) {
        if (!this.id || !retval || retval.isNull()) return;
        try { taskIds[taskKey(new ObjC.Object(retval))] = this.id; } catch (e) { /* ignore */ }
      },
    });
    console.log("[http] hooked " + selector);
  }

  hookTaskWithBlock("- dataTaskWithRequest:completionHandler:", 3, -1);
  hookTaskWithBlock("- uploadTaskWithRequest:fromData:completionHandler:", 4, 3);
  hookTaskWithBlock("- downloadTaskWithRequest:completionHandler:", 3, -1);
  hookTaskNoBlock("- dataTaskWithRequest:", -1);
  hookTaskNoBlock("- downloadTaskWithRequest:", -1);
  hookTaskNoBlock("- uploadTaskWithRequest:fromFile:", -1);

  var resume = ObjC.classes.NSURLSessionTask["- resume"];
  if (resume) {
    Interceptor.attach(resume.implementation, {
      onEnter: function (args) {
        try {
          var task = new ObjC.Object(args[0]);
          var key = taskKey(task);
          var id = ensureTask(task);
          if (id && !buffers[key]) buffers[key] = ObjC.classes.NSMutableData.data();
        } catch (e) { /* ignore */ }
      },
    });
    console.log("[http] hooked NSURLSessionTask resume");
  }

  function hookDelegate(delegatePtr) {
    if (!delegatePtr || delegatePtr.isNull()) return;
    try {
      var delegate = new ObjC.Object(delegatePtr);
      var name = "";
      try { name = delegate.$className; } catch (e) { name = "delegate"; }
      var cls = null;
      try { cls = delegate.class; } catch (e) { cls = null; }
      if (!cls && name && ObjC.classes[name]) cls = ObjC.classes[name];
      if (!cls) return;
      var key = name + ":urlsession";
      if (!name || hookedDelegates[key]) return;
      hookedDelegates[key] = true;
      var receive = cls["- URLSession:dataTask:didReceiveData:"];
      if (receive) {
        Interceptor.attach(receive.implementation, {
          onEnter: function (args) {
            try { appendBuffer(new ObjC.Object(args[3]), args[4]); } catch (e) { /* ignore */ }
          },
        });
      }
      var complete = cls["- URLSession:task:didCompleteWithError:"];
      if (complete) {
        Interceptor.attach(complete.implementation, {
          onEnter: function (args) {
            try {
              var task = new ObjC.Object(args[3]);
              var key = taskKey(task);
              var id = ensureTask(task);
              emitResponse(id, buffers[key], task.response(), args[4]);
              delete buffers[key];
            } catch (e) { /* ignore */ }
          },
        });
      }
      var download = cls["- URLSession:downloadTask:didFinishDownloadingToURL:"];
      if (download) {
        Interceptor.attach(download.implementation, {
          onEnter: function (args) {
            try {
              var task = new ObjC.Object(args[3]);
              var id = ensureTask(task);
              var fileUrl = new ObjC.Object(args[4]);
              var data = ObjC.classes.NSData.dataWithContentsOfFile_(fileUrl.path());
              emitResponse(id, data, task.response(), null);
            } catch (e) { /* ignore */ }
          },
        });
      }
      console.log("[http] hooked delegate " + name);
    } catch (e) { console.log("[http][err] delegate: " + e); }
  }

  var session = ObjC.classes.NSURLSession["+ sessionWithConfiguration:delegate:delegateQueue:"];
  if (session) {
    Interceptor.attach(session.implementation, {
      onEnter: function (args) { hookDelegate(args[3]); },
    });
    console.log("[http] hooked NSURLSession session factory");
  }

  var sync = ObjC.classes.NSURLConnection["+ sendSynchronousRequest:returningResponse:error:"];
  if (sync) {
    Interceptor.attach(sync.implementation, {
      onEnter: function (args) {
        try {
          var info = requestInfo(args[2], null);
          if (!inFilter(info.url)) return;
          this.id = nextId();
          this.responsePtr = args[3];
          emitRequest(this.id, info);
        } catch (e) { /* ignore */ }
      },
      onLeave: function (retval) {
        if (!this.id) return;
        try {
          var response = this.responsePtr ? this.responsePtr.readPointer() : null;
          emitResponse(this.id, retval, response, null);
        } catch (e) { /* ignore */ }
      },
    });
    console.log("[http] hooked NSURLConnection sendSynchronousRequest");
  }

  var async = ObjC.classes.NSURLConnection["+ sendAsynchronousRequest:queue:completionHandler:"];
  if (async) {
    Interceptor.attach(async.implementation, {
      onEnter: function (args) {
        try {
          var info = requestInfo(args[2], null);
          if (!inFilter(info.url)) return;
          var id = nextId();
          emitRequest(id, info);
          wrapConnectionCompletion(args[4], id);
        } catch (e) { /* ignore */ }
      },
    });
    console.log("[http] hooked NSURLConnection sendAsynchronousRequest");
  }

  console.log("[*] ios_http_log installed");
}`,
	},
	ios_decrypt_dump: {
		name: "ios_decrypt_dump",
		summary:
			"FairPlay 解密：spawn 后遍历已加载的 App 内 Mach-O，把整个镜像按 4MB 分块读出（内核在读加密页时解密）写到 /tmp/sentinel-decrypt，并写 manifest.json。参数：app=App 包绝对路径（必须）、out=输出目录（默认 /tmp/sentinel-decrypt）、chunk=分块字节（默认 4194304）、exit=1 时 dump 完退出进程（默认 1）",
		source: `function dumpEncryptedImages() {
  var app = sp("app", "");
  if (app === "") { console.log("[decrypt] 缺少 app 参数（App 包绝对路径）"); return; }
  var outDir = sp("out", "/tmp/sentinel-decrypt");
  var chunkSize = parseInt(sp("chunk", "4194304"), 10);
  var shouldExit = sp("exit", "1") === "1";
  var mkdirFn = sentinelFindExport("mkdir");
  if (mkdirFn) {
    var mkdir = new NativeFunction(mkdirFn, "int", ["pointer", "int"]);
    mkdir(Memory.allocUtf8String(outDir), 511);
  }
  function cryptInfo(base) {
    try {
      var magic = base.readU32();
      var is64 = magic === 0xfeedfacf;
      var ncmds = base.add(16).readU32();
      var cursor = base.add(is64 ? 32 : 28);
      for (var i = 0; i < ncmds && i < 4096; i++) {
        var cmd = cursor.readU32();
        var size = cursor.add(4).readU32();
        if (cmd === 0x21 || cmd === 0x2c) {
          return { cryptid: cursor.add(16).readU32(), cryptoff: cursor.add(8).readU32(), cryptsize: cursor.add(12).readU32() };
        }
        if (size < 8) break;
        cursor = cursor.add(size);
      }
    } catch (e) { console.log("[decrypt][err] " + e); }
    return null;
  }
  var manifest = [];
  function normalizePath(path) {
    // /var is a symlink to /private/var on iOS; frida reports the real path.
    return path.replace(/^\\/private\\/var\\//, "/var/");
  }
  var appNorm = normalizePath(app).replace(/\\/+$/, "");
  var modules = Process.enumerateModules();
  modules.forEach(function (module) {
    var modulePath = normalizePath(module.path);
    if (modulePath.indexOf(appNorm + "/") !== 0 && modulePath !== appNorm) return;
    var rel = modulePath === appNorm ? module.name : modulePath.substring(appNorm.length + 1);
    var info = cryptInfo(module.base);
    if (!info || info.cryptid === 0) {
      console.log("[decrypt] 跳过（已解密）" + rel);
      return;
    }
    try {
      var out = outDir + "/" + rel;
      var slash = out.lastIndexOf("/");
      if (slash > 0 && mkdirFn) {
        // Create parent directories one level at a time; File() cannot.
        var parts = out.substring(0, slash).split("/");
        var built = "";
        parts.forEach(function (part) {
          if (part === "") return;
          built = built + "/" + part;
          mkdir(Memory.allocUtf8String(built), 511);
        });
      }
      var file = new File(out, "wb");
      var written = 0;
      for (var off = 0; off < module.size; off += chunkSize) {
        var n = Math.min(chunkSize, module.size - off);
        var bytes = module.base.add(off).readByteArray(n);
        if (bytes === null) break;
        file.write(bytes);
        written += n;
      }
      file.flush();
      file.close();
      manifest.push({ rel: rel, out: out, size: written, cryptid: info.cryptid });
      console.log("[decrypt] dumped " + rel + " (" + written + " bytes, cryptid " + info.cryptid + ")");
    } catch (e) {
      console.log("[decrypt][err] " + rel + ": " + e);
    }
  });
  try {
    var manifestFile = new File(outDir + "/manifest.json", "wb");
    manifestFile.write(JSON.stringify(manifest));
    manifestFile.flush();
    manifestFile.close();
  } catch (e) { console.log("[decrypt][err] manifest: " + e); }
  console.log("[decrypt] 完成：" + manifest.length + " 个镜像");
  if (shouldExit) {
    setTimeout(function () {
      try {
        // Frida 17 removed Process.exit; the C exit() is still reachable.
        var exitFn = sentinelFindExport("exit");
        if (exitFn) new NativeFunction(exitFn, "void", ["int"])(0);
        else console.log("[decrypt] 无法自动退出，等待 frida 超时");
      } catch (e) { console.log("[decrypt][err] exit: " + e); }
    }, 500);
  }
}
dumpEncryptedImages();`,
	},
	ios_class_dump: {
		name: "ios_class_dump",
		summary:
			"枚举 Objective-C 类与实例方法，用于确定 hook 名称。参数：class=类名（可省略，省略时只列类名）、match=类名子串过滤、limit=最多列出的类数（默认 200）",
		source: `if (!ObjC.available) {
  console.log("[dump] ObjC 不可用");
} else {
  var target = sp("class", "");
  var match = sp("match", "");
  var limit = parseInt(sp("limit", "200"), 10);
  var names = Object.keys(ObjC.classes).filter(function (name) { return match === "" || name.indexOf(match) >= 0; }).sort();
  if (target === "") {
    console.log("[dump] " + names.length + " 个类匹配" + (match ? " '" + match + "'" : ""));
    names.slice(0, limit).forEach(function (name) { console.log("[class] " + name); });
  } else {
    var cls = ObjC.classes[target];
    if (!cls) { console.log("[dump] 找不到类 " + target); }
    else {
      console.log("[dump] " + target + " 方法：");
      var methods = cls.$ownMethods.slice(0, limit);
      methods.forEach(function (method) { console.log("[method] " + method); });
      console.log("[dump] 共 " + cls.$ownMethods.length + " 个自有方法，显示 " + methods.length);
    }
  }
}`,
	},
};

export function iosBuiltinScriptNames(): string[] {
	return Object.keys(IOS_FRIDA_SCRIPTS);
}

/**
 * Resolve an iOS script spec ("name", "name?key=value", or a custom path).
 * Mirrors `resolveBuiltinScript` for the Android registry; the two registries
 * stay separate so a name that only exists on one platform is a clear error.
 */
export function resolveIosBuiltinScript(
	spec: string,
): { name: string; source: string } | { path: string } | { error: string } {
	const parsed = parseScriptSpec(spec);
	const builtin = IOS_FRIDA_SCRIPTS[parsed.name];
	if (!builtin) {
		if (spec.includes("?")) return { error: `未知 iOS 内建脚本：${parsed.name}` };
		return { path: parsed.name };
	}
	return {
		name: builtin.name,
		source: `${prelude(parsed.params)}${IOS_EXPORT_COMPAT}console.log("\\n===== ${scriptBanner(builtin.name)} =====");\n${builtin.source}`,
	};
}
