/**
 * Call history for the MemShellParty plugin.
 *
 * It talks to the console only through the plugin UI SDK: one `list_calls`
 * bridge call returns the last N entries the adapter recorded. No direct HTTP,
 * no access to the console session.
 */
(function () {
	"use strict";

	var statusEl = document.getElementById("status");
	var metaEl = document.getElementById("meta");
	var rowsEl = document.getElementById("rows");
	var tableEl = document.getElementById("table");
	var countEl = document.getElementById("count");
	var emptyEl = document.getElementById("empty");
	var autoEl = document.getElementById("auto");
	var detailCard = document.getElementById("detail-card");
	var detailEl = document.getElementById("detail");
	var detailTitle = document.getElementById("detail-title");
	var calls = [];
	var ui = null;

	function setStatus(text, tone) {
		statusEl.textContent = text;
		statusEl.className = "pui-pill" + (tone ? " " + tone : "");
	}

	function textOf(result) {
		return (result && result.content ? result.content : [])
			.map(function (part) {
				return part && typeof part.text === "string" ? part.text : "";
			})
			.join("\n");
	}

	function formatTime(at) {
		var date = new Date(at);
		function pad(value) {
			return String(value).padStart(2, "0");
		}
		return (
			pad(date.getMonth() + 1) +
			"-" +
			pad(date.getDate()) +
			" " +
			pad(date.getHours()) +
			":" +
			pad(date.getMinutes()) +
			":" +
			pad(date.getSeconds())
		);
	}

	function showDetail(entry) {
		detailCard.hidden = false;
		detailTitle.textContent = entry.tool + " · " + formatTime(entry.at);
		detailEl.textContent = JSON.stringify(
			{
				id: entry.id,
				target: entry.target,
				args: entry.args,
				artifacts: entry.artifacts,
				error: entry.error || null,
			},
			null,
			2,
		);
		detailCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
	}

	function render() {
		rowsEl.textContent = "";
		countEl.textContent = calls.length > 0 ? "共 " + calls.length + " 条" : "";
		tableEl.hidden = calls.length === 0;
		emptyEl.hidden = calls.length > 0;
		calls.forEach(function (entry) {
			var row = document.createElement("tr");
			row.className = entry.ok ? "is-ok" : "is-bad";
			row.title = "点击查看参数与产物";

			var time = document.createElement("td");
			time.className = "mono pui-sub";
			time.textContent = formatTime(entry.at);
			row.appendChild(time);

			var tool = document.createElement("td");
			var toolName = document.createElement("code");
			toolName.textContent = entry.tool;
			tool.appendChild(toolName);
			row.appendChild(tool);

			var target = document.createElement("td");
			target.textContent = entry.target;
			row.appendChild(target);

			var result = document.createElement("td");
			var pill = document.createElement("span");
			pill.className = "pui-pill " + (entry.ok ? "ok" : "bad");
			pill.textContent = entry.ok ? "成功" : "失败";
			result.appendChild(pill);
			row.appendChild(result);

			var duration = document.createElement("td");
			duration.className = "num mono";
			duration.textContent = entry.durationMs + " ms";
			row.appendChild(duration);

			var size = document.createElement("td");
			size.className = "num mono";
			size.textContent = entry.resultSize + " B";
			row.appendChild(size);

			var artifacts = document.createElement("td");
			artifacts.className = "num mono";
			artifacts.textContent = String((entry.artifacts || []).length);
			row.appendChild(artifacts);

			row.addEventListener("click", function () {
				showDetail(entry);
			});
			rowsEl.appendChild(row);
		});
	}

	async function refresh() {
		if (!ui) return;
		try {
			var value = await ui.callTool("list_calls", { limit: 50 });
			var payload = JSON.parse(textOf(value) || "{}");
			calls = Array.isArray(payload.calls) ? payload.calls : [];
			setStatus("已连接", "ok");
			render();
		} catch (error) {
			setStatus("读取失败", "bad");
			rowsEl.textContent = "";
			tableEl.hidden = true;
			emptyEl.hidden = true;
			var row = document.createElement("tr");
			var cell = document.createElement("td");
			cell.colSpan = 7;
			cell.className = "pui-empty";
			cell.textContent = "读取历史失败：" + (error && error.message ? error.message : String(error));
			row.appendChild(cell);
			rowsEl.appendChild(row);
			tableEl.hidden = false;
		}
	}

	document.getElementById("refresh").addEventListener("click", function () {
		void refresh();
	});

	(async function () {
		try {
			ui = await SentinelPlugin.connect();
			metaEl.textContent =
				ui.context.plugin.id +
				" · " +
				ui.context.host.name +
				" · 项目 " +
				(ui.context.project || "未选择");
			await refresh();
			window.setInterval(function () {
				if (!document.hidden && autoEl.checked) void refresh();
			}, 5000);
		} catch (error) {
			setStatus("连接失败", "bad");
			metaEl.textContent = error && error.message ? error.message : String(error);
		}
	})();
})();
