(function () {
	"use strict";
	var ui = null;
	var calls = [];
	var page = 0;
	var PAGE_SIZE = 10;
	var statusEl = document.getElementById("status");
	var metaEl = document.getElementById("meta");

	function setStatus(text, tone) {
		statusEl.textContent = text;
		statusEl.className = "pui-pill" + (tone ? " " + tone : "");
	}
	function textOf(result) {
		return (result && result.content ? result.content : [])
			.map(function (part) { return part && typeof part.text === "string" ? part.text : ""; })
			.join("\n");
	}
	async function call(name, args) {
		var result = await ui.callTool(name, args || {});
		var text = textOf(result);
		if (result && result.isError) throw new Error(text || "工具调用失败");
		return text;
	}
	async function jsonCall(name, args) {
		var text = await call(name, args);
		try { return JSON.parse(text); } catch { return text; }
	}
	function esc(value) {
		var div = document.createElement("div");
		div.textContent = value === undefined || value === null ? "" : String(value);
		return div.innerHTML;
	}
	function pad(value) { return String(value).padStart(2, "0"); }
	function formatTime(at) {
		var date = new Date(at);
		if (Number.isNaN(date.getTime())) return "";
		return pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " +
			pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
	}
	function formatSize(bytes) {
		if (typeof bytes !== "number" || Number.isNaN(bytes)) return "";
		if (bytes < 1024) return bytes + " B";
		return (bytes / 1024).toFixed(1) + " KB";
	}
	function closeDetail() { document.getElementById("detail").hidden = true; }
	function showDetail(entry) {
		document.getElementById("detail-title").textContent = entry.tool + " · " + formatTime(entry.at);
		var status = entry.ok ? "<span class='is-ok'>成功</span>" : "<span class='is-bad'>失败</span>";
		document.getElementById("detail-meta").innerHTML =
			status + "<span>" + esc(entry.durationMs) + " ms</span><span>" + formatSize(entry.resultSize) + "</span>" +
			(entry.artifacts && entry.artifacts.length ? "<span>产物 " + entry.artifacts.length + "</span>" : "");
		var body = {
			args: entry.args || {},
			result: entry.result || "",
			error: entry.error || null,
			artifacts: entry.artifacts || [],
		};
		document.getElementById("detail-body").textContent = JSON.stringify(body, null, 2);
		document.getElementById("detail").hidden = false;
	}
	document.getElementById("detail-close").onclick = closeDetail;
	document.getElementById("detail-backdrop").onclick = closeDetail;
	document.addEventListener("keydown", function (event) { if (event.key === "Escape") closeDetail(); });

	function render() {
		var rows = document.getElementById("rows");
		var pageCount = Math.max(1, Math.ceil(calls.length / PAGE_SIZE));
		if (page >= pageCount) page = pageCount - 1;
		var start = page * PAGE_SIZE;
		var visible = calls.slice(start, start + PAGE_SIZE);
		rows.textContent = "";
		document.getElementById("count").textContent = calls.length ? "共 " + calls.length + " 条" : "";
		document.getElementById("table").hidden = calls.length === 0;
		document.getElementById("empty").hidden = calls.length > 0;
		document.getElementById("pager").hidden = calls.length <= PAGE_SIZE;
		document.getElementById("page-info").textContent = "第 " + (page + 1) + " / " + pageCount + " 页";
		document.getElementById("prev").disabled = page === 0;
		document.getElementById("next").disabled = page >= pageCount - 1;
		visible.forEach(function (entry) {
			var row = document.createElement("tr");
			if (!entry.ok) row.className = "is-bad";
			row.innerHTML =
				"<td class='mono'>" + esc(formatTime(entry.at)) + "</td>" +
				"<td><code>" + esc(entry.tool) + "</code></td>" +
				"<td>" + esc(entry.target || "") + "</td>" +
				"<td>" + (entry.ok ? "<span class='pui-pill ok'>成功</span>" : "<span class='pui-pill bad'>失败</span>") + "</td>" +
				"<td class='num mono'>" + esc(entry.durationMs) + " ms</td>" +
				"<td class='num mono'>" + esc(formatSize(entry.resultSize)) + "</td>" +
				"<td class='num mono'>" + (entry.artifacts ? entry.artifacts.length : 0) + "</td>";
			row.onclick = function () { showDetail(entry); };
			rows.appendChild(row);
		});
	}

	async function refresh() {
		if (!ui) return;
		setStatus("刷新中");
		try {
			var data = await jsonCall("list_calls", { limit: 200 });
			calls = data && Array.isArray(data.calls) ? data.calls : [];
			render();
			setStatus("已连接", "ok");
		} catch (error) {
			setStatus("读取失败", "bad");
			calls = [];
			render();
			document.getElementById("rows").innerHTML =
				"<tr><td colspan='7' class='pui-empty'>读取历史失败：" + esc(error.message) + "</td></tr>";
		}
	}

	document.getElementById("refresh").onclick = function () { void refresh(); };
	document.getElementById("prev").onclick = function () { if (page > 0) { page -= 1; render(); } };
	document.getElementById("next").onclick = function () { page += 1; render(); };

	(async function () {
		try {
			ui = await SentinelPlugin.connect();
			var context = ui.context;
			metaEl.textContent = context.plugin.id + " · " + context.host.name;
			await refresh();
			window.setInterval(function () {
				if (!document.hidden && document.getElementById("auto").checked) void refresh();
			}, 5000);
		} catch (error) {
			setStatus("连接失败", "bad");
			metaEl.textContent = error && error.message ? error.message : String(error);
		}
	})();
})();
