/**
 * VShell console for the plugin iframe.
 *
 * Every operation goes through the plugin bridge to the 28 MCP tools; no direct
 * HTTP to VShell and no access to console storage. Files the adapter downloads
 * or generates land in /artifacts and are fetched through the artifact bridge.
 */
(function () {
	"use strict";

	var ui = null;
	var state = {
		info: null,
		hosts: [],
		tunnels: [],
		hostId: null,
		path: "/",
		files: [],
		commandLog: [],
	};

	var statusEl = document.getElementById("status");
	var metaEl = document.getElementById("meta");

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

	async function call(name, args) {
		var result = await ui.callTool(name, args || {});
		var text = textOf(result);
		if (result && result.isError) throw new Error(text || "工具调用失败");
		return text;
	}

	async function jsonCall(name, args) {
		var text = await call(name, args);
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}

	function fmtSize(bytes) {
		if (typeof bytes !== "number" || Number.isNaN(bytes)) return "";
		if (bytes < 1024) return bytes + " B";
		if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
		return (bytes / 1024 / 1024).toFixed(1) + " MB";
	}

	function fmtTime(value) {
		if (value === undefined || value === null || value === "") return "";
		var date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
		if (Number.isNaN(date.getTime())) return String(value);
		return date.toLocaleString("zh-CN", { hour12: false });
	}

	function esc(value) {
		var div = document.createElement("div");
		div.textContent = value === undefined || value === null ? "" : String(value);
		return div.innerHTML;
	}

	function notice(message, tone) {
		var el = document.getElementById("meta");
		el.textContent = message;
		if (tone) el.className = "pui-sub " + tone;
	}

	function showModal(title, body) {
		document.getElementById("modal-title").textContent = title;
		var container = document.getElementById("modal-body");
		container.textContent = "";
		if (typeof body === "string") {
			var pre = document.createElement("pre");
			pre.className = "pui-output";
			pre.textContent = body;
			container.appendChild(pre);
		} else {
			container.appendChild(body);
		}
		document.getElementById("modal").hidden = false;
	}

	var dialogCancel = null;

	function closeModal() {
		document.getElementById("modal").hidden = true;
		if (dialogCancel) {
			var cancel = dialogCancel;
			dialogCancel = null;
			cancel();
		}
	}

	// window.prompt/confirm are blocked in a sandboxed iframe (no allow-modals),
	// so all dialogs are built in the plugin's own modal.
	function askValue(title, label, value) {
		return new Promise(function (resolve) {
			dialogCancel = function () {
				resolve(null);
			};
			var form = document.createElement("div");
			form.className = "vsh-modal-form";
			var field = document.createElement("label");
			field.className = "vsh-field";
			field.textContent = label;
			var input = document.createElement("input");
			input.className = "pui-input";
			input.value = value || "";
			field.appendChild(input);
			form.appendChild(field);
			var actions = document.createElement("div");
			actions.className = "vsh-modal-actions";
			var cancel = document.createElement("button");
			cancel.type = "button";
			cancel.className = "pui-btn";
			cancel.textContent = "取消";
			cancel.addEventListener("click", function () {
				dialogCancel = null;
				closeModal();
				resolve(null);
			});
			var ok = document.createElement("button");
			ok.type = "button";
			ok.className = "pui-btn primary";
			ok.textContent = "确定";
			ok.addEventListener("click", function () {
				var result = input.value.trim();
				dialogCancel = null;
				closeModal();
				resolve(result);
			});
			actions.appendChild(cancel);
			actions.appendChild(ok);
			form.appendChild(actions);
			showModal(title, form);
			input.focus();
			input.select();
		});
	}

	function confirmDialog(message) {
		return new Promise(function (resolve) {
			dialogCancel = function () {
				resolve(false);
			};
			var wrap = document.createElement("div");
			wrap.className = "vsh-modal-form";
			var text = document.createElement("p");
			text.textContent = message;
			wrap.appendChild(text);
			var actions = document.createElement("div");
			actions.className = "vsh-modal-actions";
			var cancel = document.createElement("button");
			cancel.type = "button";
			cancel.className = "pui-btn";
			cancel.textContent = "取消";
			cancel.addEventListener("click", function () {
				dialogCancel = null;
				closeModal();
				resolve(false);
			});
			var ok = document.createElement("button");
			ok.type = "button";
			ok.className = "pui-btn danger";
			ok.textContent = "确认";
			ok.addEventListener("click", function () {
				dialogCancel = null;
				closeModal();
				resolve(true);
			});
			actions.appendChild(cancel);
			actions.appendChild(ok);
			wrap.appendChild(actions);
			showModal("确认操作", wrap);
		});
	}

	document.getElementById("modal-close").addEventListener("click", closeModal);
	document.getElementById("modal-backdrop").addEventListener("click", closeModal);
	document.addEventListener("keydown", function (event) {
		if (event.key === "Escape") closeModal();
	});

	// --- tabs -------------------------------------------------------------

	var tabButtons = Array.prototype.slice.call(document.querySelectorAll("#tabs button"));
	function showTab(tab) {
		tabButtons.forEach(function (button) {
			button.classList.toggle("active", button.dataset.tab === tab);
		});
		Array.prototype.forEach.call(document.querySelectorAll("[data-pane]"), function (pane) {
			pane.hidden = pane.dataset.pane !== tab;
		});
		if (tab === "files") void loadFiles();
	}
	tabButtons.forEach(function (button) {
		button.addEventListener("click", function () {
			showTab(button.dataset.tab);
		});
	});

	// --- overview ---------------------------------------------------------


	function renderHosts() {
		var body = document.getElementById("hosts");
		var query = (document.getElementById("host-query").value || "").trim().toLowerCase();
		var onlineOnly = document.getElementById("host-online").checked;
		var visible = state.hosts.filter(function (host) {
			if (onlineOnly && host.IsConnect !== true) return false;
			if (!query) return true;
			return [host.HostName, host.Addr, host.LocalIP, host.UserName, host.OsName, host.Remark]
				.join(" ")
				.toLowerCase()
				.indexOf(query) >= 0;
		});
		body.textContent = "";
		var onlineCount = state.hosts.filter(function (host) {
			return host.IsConnect === true;
		}).length;
		document.getElementById("host-count").textContent =
			visible.length === state.hosts.length
				? state.hosts.length + " 台 · " + onlineCount + " 在线"
				: visible.length + " / " + state.hosts.length + " 台";
		visible.forEach(function (host) {
			var on = host.IsConnect === true;
			var card = document.createElement("button");
			card.type = "button";
			card.className = "vsh-host" + (host.Id === state.hostId ? " is-selected" : "");
			var initial = (host.OsName || "?").toLowerCase().indexOf("windows") >= 0 ? "W" : "L";
			card.innerHTML =
				"<span class='vsh-host__avatar" + (on ? "" : " is-off") + "'>" + initial + "</span>" +
				"<span class='vsh-host__info'>" +
				"<b>" + esc(host.HostName || "—") + "</b>" +
				"<span>" + esc(host.OsName || "") + (host.UserName ? " · " + esc(host.UserName) : "") + "</span>" +
				"<span class='mono'>" + esc(host.Addr || host.LocalIP || "") +
				(host.LocalIP && host.LocalIP !== host.Addr ? " / " + esc(host.LocalIP) : "") + "</span>" +
				"</span>" +
				"<span class='vsh-host__state'>" +
				"<span class='pui-pill " + (on ? "ok" : "") + "'>" + (on ? "在线" : "离线") + "</span>" +
				"<span class='mono'>#" + esc(host.Id) + "</span></span>";
			card.addEventListener("click", function () {
				state.hostId = host.Id;
				renderHosts();
				renderCommandLog();
				renderFileHosts();
			});
			body.appendChild(card);
		});
		if (visible.length === 0) {
			body.innerHTML = "<p class='pui-empty'>没有匹配的主机。</p>";
		}

		var current = state.hosts.find(function (host) {
			return host.Id === state.hostId;
		});
		var badge = document.getElementById("cmd-host");
		if (current) {
			badge.textContent = "#" + current.Id + " " + (current.HostName || "");
			badge.className = "pui-pill " + (current.IsConnect ? "ok" : "");
			document.getElementById("term-host").textContent = "#" + current.Id + " " + (current.HostName || "");
			document.getElementById("cmd-run").disabled = current.IsConnect !== true;
		} else {
			badge.textContent = "未选择";
			badge.className = "pui-pill";
		}

		var select = document.getElementById("file-host");
		select.textContent = "";
		state.hosts.forEach(function (host) {
			var option = document.createElement("option");
			option.value = host.Id;
			option.textContent = "#" + host.Id + " " + (host.HostName || host.Addr || "") + (host.IsConnect ? "（在线）" : "");
			select.appendChild(option);
		});
		if (state.hostId !== null) select.value = String(state.hostId);
	}

	function commandRow(entry) {
		var wrap = document.createElement("div");
		wrap.className = "vsh-term-entry" + (entry.ok ? "" : " is-bad");
		var head = document.createElement("div");
		head.className = "vsh-term-entry__head";
		head.innerHTML =
			"<span class='vsh-term-entry__cmd'><span class='mono'>PS&gt;</span> " + esc(entry.command) + "</span>" +
			"<span class='vsh-term-entry__meta'>" + esc(entry.time) + (entry.workdir ? " · " + esc(entry.workdir) : "") + "</span>";
		var copy = document.createElement("button");
		copy.type = "button";
		copy.className = "pui-btn";
		copy.textContent = "复制";
		copy.addEventListener("click", function () {
			void navigator.clipboard.writeText(entry.output);
		});
		head.appendChild(copy);
		wrap.appendChild(head);
		var pre = document.createElement("pre");
		pre.className = "vsh-term-entry__out";
		pre.textContent = entry.output;
		wrap.appendChild(pre);
		return wrap;
	}

	function renderFileHosts() {
		var select = document.getElementById("file-host");
		if (!select.options.length) return;
		if (state.hostId === null) state.hostId = Number(select.value);
		select.value = String(state.hostId);
	}

	function commandRow(entry) {
		var wrap = document.createElement("div");
		wrap.className = "vsh-cmd-entry " + (entry.ok ? "" : "is-bad");
		var head = document.createElement("div");
		head.className = "vsh-cmd-head";
		head.innerHTML =
			"<code>$ " + esc(entry.command) + "</code><span class='pui-sub'>" +
			esc(entry.time) + (entry.workdir ? " · " + esc(entry.workdir) : "") + "</span>";
		var copy = document.createElement("button");
		copy.type = "button";
		copy.className = "pui-btn";
		copy.textContent = "复制输出";
		copy.addEventListener("click", function () {
			void navigator.clipboard.writeText(entry.output);
		});
		head.appendChild(copy);
		wrap.appendChild(head);
		var pre = document.createElement("pre");
		pre.className = "pui-output";
		pre.textContent = entry.output;
		wrap.appendChild(pre);
		return wrap;
	}

	function renderCommandLog() {
		var log = document.getElementById("cmd-log");
		log.textContent = "";
		if (state.commandLog.length === 0) {
			var host = state.hosts.find(function (entry) {
				return entry.Id === state.hostId;
			});
			log.innerHTML =
				"<p class='vsh-term__empty'>" +
				(host
					? host.IsConnect
						? "已选择 #" + esc(host.Id) + " " + esc(host.HostName || "") + "，输入命令后按 Enter 执行。"
						: "已选择 #" + esc(host.Id) + "，但主机离线，不能执行命令。"
					: "先在左侧选择一台主机。") +
				"</p>";
			return;
		}
		state.commandLog.forEach(function (entry) {
			log.appendChild(commandRow(entry));
		});
	}

	async function runCommand() {
		var hostId = state.hostId;
		if (hostId === null) return;
		var input = document.getElementById("cmd-input");
		var command = input.value.trim();
		if (!command) return;
		var workdir = document.getElementById("cmd-workdir").value.trim();
		var timeout = Number(document.getElementById("cmd-timeout").value) || undefined;
		var args = { host_id: String(hostId), command: command };
		if (workdir) args.workdir = workdir;
		if (timeout) args.timeout_seconds = timeout;
		var entry = { command: command, workdir: workdir, time: new Date().toLocaleTimeString("zh-CN"), ok: true, output: "运行中…" };
		state.commandLog.unshift(entry);
		renderCommandLog();
		try {
			var text = await call("execute_command", args);
			try {
				var data = JSON.parse(text);
				entry.output = typeof data.output === "string" ? data.output : text;
			} catch {
				entry.output = text;
			}
		} catch (error) {
			entry.ok = false;
			entry.output = String(error.message || error);
		}
		renderCommandLog();
		input.value = "";
	}

	document.getElementById("host-query").addEventListener("input", renderHosts);
	document.getElementById("host-online").addEventListener("change", renderHosts);
	document.getElementById("cmd-clear").addEventListener("click", function () {
		state.commandLog = [];
		renderCommandLog();
	});
	document.getElementById("cmd-run").addEventListener("click", function () {
		void runCommand();
	});
	document.getElementById("cmd-input").addEventListener("keydown", function (event) {
		if (event.key === "Enter") void runCommand();
	});

	// --- files ------------------------------------------------------------

	function joinPath(base, name) {
		if (name === "..") {
			var parts = base.split("/").filter(Boolean);
			parts.pop();
			return "/" + parts.join("/");
		}
		return (base === "/" ? "" : base.replace(/\/$/, "")) + "/" + name;
	}

	async function loadFiles() {
		var hostId = Number(document.getElementById("file-host").value || state.hostId);
		if (!hostId) return;
		state.hostId = hostId;
		state.path = document.getElementById("file-path").value.trim() || "/";
		var body = document.getElementById("files");
		body.innerHTML = "<tr><td colspan='6' class='pui-empty'>正在读取…</td></tr>";
		try {
			var data = await jsonCall("list_directory", { host_id: String(hostId), path: state.path });
			state.files = data && Array.isArray(data.items) ? data.items : Array.isArray(data) ? data : [];
			renderFiles();
			document.getElementById("file-status").textContent = state.files.length + " 项";
		} catch (error) {
			body.innerHTML = "<tr><td colspan='6' class='pui-empty'>读取失败：" + esc(error.message) + "</td></tr>";
		}
	}

	function renderFiles() {
		var body = document.getElementById("files");
		body.textContent = "";
		state.files.forEach(function (file) {
			var row = document.createElement("tr");
			var name = file.name || file.Name || "";
			var isDir = file.isDir === true || file.IsDir === true;
			row.innerHTML =
				"<td><code>" + esc(name) + "</code></td>" +
				"<td>" + (isDir ? "目录" : "文件") + "</td>" +
				"<td class='num mono'>" + (isDir ? "" : fmtSize(file.size ?? file.Size)) + "</td>" +
				"<td class='mono'>" + esc(fmtTime(file.time ?? file.Time)) + "</td>" +
				"<td class='mono'>" + esc(file.mode || file.Mode || "") + "</td>" +
				"<td class='vsh-actions'></td>";
			var actions = row.querySelector(".vsh-actions");
			if (isDir) {
				var enter = document.createElement("button");
				enter.type = "button";
				enter.className = "pui-btn";
				enter.textContent = "进入";
				enter.addEventListener("click", function () {
					state.path = joinPath(state.path, name);
					document.getElementById("file-path").value = state.path;
					void loadFiles();
				});
				actions.appendChild(enter);
			} else {
				var read = document.createElement("button");
				read.type = "button";
				read.className = "pui-btn";
				read.textContent = "查看";
				read.addEventListener("click", function () {
					void readRemoteFile(name);
				});
				actions.appendChild(read);
				var edit = document.createElement("button");
				edit.type = "button";
				edit.className = "pui-btn";
				edit.textContent = "编辑";
				edit.addEventListener("click", function () {
					void editRemoteFile(name);
				});
				actions.appendChild(edit);
				var download = document.createElement("button");
				download.type = "button";
				download.className = "pui-btn";
				download.textContent = "下载";
				download.addEventListener("click", function () {
					void downloadRemoteFile(name);
				});
				actions.appendChild(download);
			}
			var rename = document.createElement("button");
			rename.type = "button";
			rename.className = "pui-btn";
			rename.textContent = "重命名";
			rename.addEventListener("click", function () {
				void renameRemote(name);
			});
			actions.appendChild(rename);
			var del = document.createElement("button");
			del.type = "button";
			del.className = "pui-btn danger";
			del.textContent = "删除";
			del.addEventListener("click", function () {
				void deleteRemote(name);
			});
			actions.appendChild(del);
			body.appendChild(row);
		});
		if (state.files.length === 0) body.innerHTML = "<tr><td colspan='6' class='pui-empty'>目录为空。</td></tr>";
	}

	async function readRemoteFile(name) {
		try {
			var data = await jsonCall("read_file", { host_id: String(state.hostId), path: state.path, filename: name });
			var content = typeof data === "string" ? data : data.content;
			if (data && data.base64_encoded) {
				showModal(name + "（二进制，base64）", content);
			} else {
				showModal(name, content);
			}
		} catch (error) {
			showModal("读取失败", String(error.message || error));
		}
	}

	async function editRemoteFile(name) {
		var data;
		try {
			data = await jsonCall("read_file", { host_id: String(state.hostId), path: state.path, filename: name });
		} catch (error) {
			showModal("读取失败", String(error.message || error));
			return;
		}
		var content = typeof data === "string" ? data : data.content || "";
		var area = document.createElement("textarea");
		area.className = "pui-textarea";
		area.rows = 16;
		area.value = content;
		var save = document.createElement("button");
		save.type = "button";
		save.className = "pui-btn primary";
		save.textContent = "保存";
		save.addEventListener("click", async function () {
			try {
				await call("write_file", {
					host_id: String(state.hostId),
					path: state.path,
					filename: name,
					content: area.value,
				});
				closeModal();
				await loadFiles();
			} catch (error) {
				notice("保存失败：" + (error.message || error), "is-bad");
			}
		});
		var wrap = document.createElement("div");
		wrap.className = "vsh-modal-form";
		wrap.appendChild(area);
		wrap.appendChild(save);
		showModal("编辑 " + name, wrap);
	}

	async function downloadRemoteFile(name) {
		try {
			var data = await jsonCall("download_file", {
				host_id: String(state.hostId),
				path: state.path,
				filename: name,
			});
			notice("已下载到：" + (data.local_path || name) + "，请到「插件 → 详情 → 产物」下载。");
		} catch (error) {
			notice("下载失败：" + (error.message || error), "is-bad");
		}
	}

	async function renameRemote(name) {
		var next = await askValue("重命名", "新名称", name);
		if (!next || next === name) return;
		try {
			await call("rename_file", { host_id: String(state.hostId), path: state.path, target: name, new_name: next });
			await loadFiles();
		} catch (error) {
			notice("重命名失败：" + (error.message || error), "is-bad");
		}
	}

	async function deleteRemote(name) {
		if (!(await confirmDialog("删除 " + name + "？"))) return;
		try {
			await call("delete_file", { host_id: String(state.hostId), path: state.path, filename: name });
			await loadFiles();
		} catch (error) {
			notice("删除失败：" + (error.message || error), "is-bad");
		}
	}

	document.getElementById("file-host").addEventListener("change", function () {
		state.hostId = Number(this.value);
		void loadFiles();
	});
	document.getElementById("file-go").addEventListener("click", function () {
		void loadFiles();
	});
	document.getElementById("file-refresh").addEventListener("click", function () {
		void loadFiles();
	});
	document.getElementById("file-up").addEventListener("click", function () {
		state.path = joinPath(state.path, "..");
		document.getElementById("file-path").value = state.path;
		void loadFiles();
	});
	document.getElementById("file-disks").addEventListener("click", function () {
		void (async function () {
			try {
				var data = await jsonCall("get_disks", { host_id: String(state.hostId) });
				showModal("磁盘信息", JSON.stringify(data, null, 2));
			} catch (error) {
				notice("读取磁盘失败：" + (error.message || error), "is-bad");
			}
		})();
	});
	document.getElementById("file-mkdir").addEventListener("click", function () {
		void (async function () {
			var name = await askValue("新建目录", "目录名", "");
			if (!name) return;
			try {
				await call("create_directory", { host_id: String(state.hostId), path: state.path, dirname: name });
				await loadFiles();
			} catch (error) {
				notice("新建目录失败：" + (error.message || error), "is-bad");
			}
		})();
	});
	document.getElementById("file-touch").addEventListener("click", function () {
		void (async function () {
			var name = await askValue("新建文件", "文件名", "");
			if (!name) return;
			try {
				await call("create_file", { host_id: String(state.hostId), path: state.path, filename: name });
				await loadFiles();
			} catch (error) {
				notice("新建文件失败：" + (error.message || error), "is-bad");
			}
		})();
	});
	document.getElementById("file-wget").addEventListener("click", function () {
		void (async function () {
			var url = await askValue("URL 下载", "下载地址", "https://");
			if (!url) return;
			try {
				await call("wget_file", { host_id: String(state.hostId), path: state.path, url: url });
				await loadFiles();
			} catch (error) {
				notice("URL 下载失败：" + (error.message || error), "is-bad");
			}
		})();
	});
	document.getElementById("file-upload").addEventListener("click", function () {
		document.getElementById("file-upload-input").click();
	});
	document.getElementById("file-upload-input").addEventListener("change", function () {
		var file = this.files && this.files[0];
		if (!file) return;
		var reader = new FileReader();
		reader.onload = function () {
			var dataUrl = String(reader.result);
			var base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
			void call("upload_file_base64", {
				host_id: String(state.hostId),
				path: state.path,
				filename: file.name,
				content_base64: base64,
			})
				.then(function () {
					notice("已上传 " + file.name);
					return loadFiles();
				})
				.catch(function (error) {
					notice("上传失败：" + (error.message || error), "is-bad");
				});
		};
		reader.readAsDataURL(file);
		this.value = "";
	});

	// --- tunnels ----------------------------------------------------------

	function renderTunnels() {
		var body = document.getElementById("tunnels");
		body.textContent = "";
		document.getElementById("tunnel-count").textContent = state.tunnels.length + " 条";
		state.tunnels.forEach(function (tunnel) {
			var on = tunnel.Status === true || tunnel.status === true || tunnel.Enable === true;
			var row = document.createElement("tr");
			row.innerHTML =
				"<td class='mono'>" + esc(tunnel.Id ?? tunnel.id) + "</td>" +
				"<td class='mono'>" + esc(tunnel.ClientId ?? tunnel.clientId ?? "") + "</td>" +
				"<td>" + esc(tunnel.Mode ?? tunnel.mode ?? "") + "</td>" +
				"<td class='num mono'>" + esc(tunnel.Port ?? tunnel.port ?? "") + "</td>" +
				"<td class='mono'>" + esc(tunnel.Target ?? tunnel.target ?? "") + "</td>" +
				"<td><span class='pui-pill " + (on ? "ok" : "") + "'>" + (on ? "启用" : "停用") + "</span></td>" +
				"<td>" + esc(tunnel.Remark ?? tunnel.remark ?? "") + "</td>" +
				"<td class='vsh-actions'></td>";
			var actions = row.querySelector(".vsh-actions");
			var id = tunnel.Id ?? tunnel.id;
			function action(label, fn, danger) {
				var button = document.createElement("button");
				button.type = "button";
				button.className = "pui-btn" + (danger ? " danger" : "");
				button.textContent = label;
				button.addEventListener("click", fn);
				actions.appendChild(button);
			}
			action(on ? "停用" : "启用", function () {
				void call(on ? "stop_tunnel" : "start_tunnel", { id: id }).then(refreshTunnels);
			});
			action("编辑", function () {
				editTunnel(tunnel);
			});
			action("备注", function () {
				void (async function () {
					var remark = await askValue("隧道备注", "新备注", tunnel.Remark ?? "");
					if (remark === null) return;
					await call("set_tunnel_remark", { id: id, remark: remark });
					await refreshTunnels();
				})();
			});
			action("删除", function () {
				void (async function () {
					if (!(await confirmDialog("删除隧道 " + id + "？"))) return;
					await call("delete_tunnel", { id: id });
					await refreshTunnels();
				})();
			}, true);
			body.appendChild(row);
		});
		if (state.tunnels.length === 0) body.innerHTML = "<tr><td colspan='8' class='pui-empty'>还没有隧道。</td></tr>";
	}

	function editTunnel(tunnel) {
		var fields = [
			["client_id", "客户端 Id", tunnel.ClientId ?? tunnel.clientId ?? ""],
			["mode", "模式", tunnel.Mode ?? tunnel.mode ?? "socks5"],
			["port", "端口", tunnel.Port ?? tunnel.port ?? ""],
			["target", "目标", tunnel.Target ?? tunnel.target ?? ""],
			["username", "用户名", tunnel.Username ?? tunnel.username ?? ""],
			["password", "密码", tunnel.Password ?? tunnel.password ?? ""],
			["remark", "备注", tunnel.Remark ?? tunnel.remark ?? ""],
		];
		var form = document.createElement("div");
		form.className = "vsh-modal-form";
		var inputs = {};
		fields.forEach(function (field) {
			var label = document.createElement("label");
			label.className = "vsh-field";
			label.textContent = field[1];
			var input = document.createElement("input");
			input.className = "pui-input";
			input.value = field[2];
			label.appendChild(input);
			form.appendChild(label);
			inputs[field[0]] = input;
		});
		var save = document.createElement("button");
		save.type = "button";
		save.className = "pui-btn primary";
		save.textContent = "保存";
		save.addEventListener("click", function () {
			var args = { id: tunnel.Id ?? tunnel.id };
			Object.keys(inputs).forEach(function (key) {
				var value = inputs[key].value.trim();
				if (value !== "") args[key] = key === "port" ? Number(value) : value;
			});
			void call("edit_tunnel", args)
				.then(function () {
					closeModal();
					return refreshTunnels();
				})
				.catch(function (error) {
					notice("编辑失败：" + (error.message || error), "is-bad");
				});
		});
		form.appendChild(save);
		showModal("编辑隧道 #" + (tunnel.Id ?? tunnel.id), form);
	}

	async function refreshTunnels() {
		try {
			var data = await jsonCall("list_tunnels", {});
			state.tunnels = data && Array.isArray(data.tunnels) ? data.tunnels : [];
		} catch (error) {
			state.tunnels = [];
			notice("读取隧道失败：" + (error.message || error), "is-bad");
		}
		renderTunnels();
	}

	document.getElementById("tun-add").addEventListener("click", function () {
		var args = {
			client_id: document.getElementById("tun-client").value.trim(),
			port: Number(document.getElementById("tun-port").value) || 0,
			mode: document.getElementById("tun-mode").value,
			target: document.getElementById("tun-target").value.trim(),
			username: document.getElementById("tun-username").value.trim(),
			password: document.getElementById("tun-password").value,
			remark: document.getElementById("tun-remark").value.trim(),
		};
		void call("add_tunnel", args)
			.then(function () {
				notice("隧道已新增");
				return refreshTunnels();
			})
			.catch(function (error) {
				notice("新增失败：" + (error.message || error), "is-bad");
			});
	});

	// --- boot -------------------------------------------------------------

	async function refreshAll() {
		setStatus("刷新中");
		try {
			var info = null;
			try {
				info = await jsonCall("get_server_info", {});
			} catch {
				info = null;
			}
			var connection = info && info.connection ? info.connection : {};
			var server = info && info.server ? info.server : {};
			if (connection.base_url || server.version) {
				metaEl.textContent =
					(connection.base_url || "") + (server.version ? " · v" + server.version : "");
			}
			state.hosts = await jsonCall("list_hosts", {});
			var tunnels = await jsonCall("list_tunnels", {});
			state.tunnels = tunnels && Array.isArray(tunnels.tunnels) ? tunnels.tunnels : [];
			if (state.hostId === null && state.hosts.length > 0) {
				var online = state.hosts.find(function (host) {
					return host.IsConnect === true;
				});
				state.hostId = (online || state.hosts[0]).Id;
			}
			renderHosts();
			renderTunnels();
			renderCommandLog();
			setStatus("已连接", "ok");
		} catch (error) {
			setStatus("连接失败", "bad");
			notice("读取失败：" + (error.message || error), "is-bad");
		}
	}

	document.getElementById("refresh").addEventListener("click", function () {
		void refreshAll();
	});

	(async function () {
		try {
			ui = await SentinelPlugin.connect();
			var context = ui.context;
			metaEl.textContent =
				context.plugin.id + " · " + context.host.name + " · 项目 " + (context.project || "未选择");
			await refreshAll();
		} catch (error) {
			setStatus("连接失败", "bad");
			metaEl.textContent = error && error.message ? error.message : String(error);
		}
	})();
})();
