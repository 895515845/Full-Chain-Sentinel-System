/**
 * Minimal plugin frontend.
 *
 * The only interface is `window.SentinelPlugin`; see sdk.js. Everything below
 * runs inside a sandboxed iframe, so there is no fetch to the console and no
 * access to its session.
 */
(function () {
	"use strict";

	var result = document.getElementById("result");
	var contextView = document.getElementById("context");
	var toolSelect = document.getElementById("tool");

	function show(value) {
		result.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
	}

	(async function () {
		try {
			var ui = await SentinelPlugin.connect();
			var context = ui.context;

			document.getElementById("title").textContent = context.plugin.name;
			document.getElementById("status").className = "pui-pill ok";
			document.getElementById("status").textContent = "已连接";
			document.getElementById("meta").textContent =
				context.plugin.id + " v" + context.plugin.version + " · " + context.host.name;
			contextView.textContent = JSON.stringify(context, null, 2);

			context.tools.forEach(function (tool) {
				var option = document.createElement("option");
				option.value = tool.name;
				option.textContent = tool.name;
				toolSelect.appendChild(option);
			});

			document.getElementById("run").addEventListener("click", async function () {
				var name = toolSelect.value;
				if (!name) {
					show("这个插件没有声明工具。");
					return;
				}
				var args;
				try {
					args = JSON.parse(document.getElementById("args").value || "{}");
				} catch (error) {
					show("参数不是合法 JSON：" + error.message);
					return;
				}
				try {
					show(await ui.callTool(name, args));
				} catch (error) {
					show("调用失败：" + error.message);
				}
			});
		} catch (error) {
			show("连接失败：" + error.message);
		}
	})();
})();
