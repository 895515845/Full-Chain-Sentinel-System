/**
 * The demo UI: it uses only the SDK, so it works the same whether the console
 * opened it locally or on a VPS. No direct network access, no console APIs.
 */
(function () {
	"use strict";

	var output = document.getElementById("output");

	function show(value) {
		output.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
	}

	function renderArtifacts(items) {
		var list = document.getElementById("artifacts");
		list.textContent = "";
		if (!items || items.length === 0) {
			var empty = document.createElement("li");
			empty.className = "pui-empty";
			empty.textContent = "还没有产物";
			list.appendChild(empty);
			return;
		}
		items.forEach(function (item) {
			var row = document.createElement("li");
			var name = document.createElement("code");
			name.textContent = item.path;
			var size = document.createElement("span");
			size.className = "pui-sub";
			size.textContent = item.size + " B";
			row.appendChild(name);
			row.appendChild(size);
			list.appendChild(row);
		});
	}

	function renderContext(ui) {
		var context = ui.context;
		document.getElementById("meta").textContent =
			context.plugin.id + " · " + context.host.name + " · 项目 " + (context.project || "未选择");
		var dl = document.getElementById("context");
		dl.textContent = "";
		var rows = [
			["插件 id", context.plugin.id],
			["作者", context.plugin.author],
			["主机", context.host.name],
			["项目", context.project || "未选择"],
			["工具", context.tools.map(function (tool) { return tool.name; }).join(", ") || "无"],
			["已配置", context.configKeys.join(", ") || "无"],
		];
		rows.forEach(function (row) {
			var dt = document.createElement("dt");
			dt.textContent = row[0];
			var dd = document.createElement("dd");
			dd.textContent = row[1];
			dl.appendChild(dt);
			dl.appendChild(dd);
		});
	}

	(async function () {
		try {
			var ui = await SentinelPlugin.connect();
			document.getElementById("status").className = "pui-pill ok";
			document.getElementById("status").textContent = "已连接";
			renderContext(ui);
			show("已连接控制台桥。点上面的按钮试试。");

			document.getElementById("echo").addEventListener("click", async function () {
				try {
					var text = document.getElementById("text").value;
					var result = await ui.callTool("hello_echo", { text: text });
					show(result);
				} catch (error) {
					show("调用失败：" + error.message);
				}
			});

			document.getElementById("write").addEventListener("click", async function () {
				try {
					var result = await ui.callTool("hello_artifact", { note: "written by " + ui.context.plugin.id });
					show(result);
					await refresh();
				} catch (error) {
					show("写产物失败：" + error.message);
				}
			});

			document.getElementById("list").addEventListener("click", function () {
				void refresh();
			});

			async function refresh() {
				try {
					renderArtifacts(await ui.listArtifacts());
				} catch (error) {
					show("读取产物失败：" + error.message);
				}
			}
		} catch (error) {
			show("连接失败：" + error.message);
		}
	})();
})();
