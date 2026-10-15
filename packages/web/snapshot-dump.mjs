import { writeFileSync } from "node:fs";
import WebSocket from "ws";

const socket = new WebSocket("ws://127.0.0.1:7777/ws");
const out = {};
const done = () => {
	writeFileSync("/tmp/user-data.json", JSON.stringify(out));
	console.log("captured:", Object.keys(out).join(","));
	socket.close();
	process.exit(0);
};
socket.on("error", (e) => {
	console.error("ws error:", e.message);
	process.exit(1);
});
socket.on("message", (data) => {
	const m = JSON.parse(data.toString());
	if (m.type === "vulns") {
		out.vulns = m.items;
		out.vulnStats = m.stats;
		if (m.items[0]) socket.send(JSON.stringify({ type: "get_vuln", id: m.items[0].id }));
		else done();
	}
	if (m.type === "vuln") {
		out.vulnDetail = m.vuln;
		done();
	}
	if (m.type === "engines") {
		out.engines = m.engines;
		socket.send(JSON.stringify({ type: "list_vulns" }));
	}
	if (m.type === "doctrines") out.doctrines = m.doctrines;
	if (m.type === "commander_config") {
		out.commanderConfig = m.config;
		socket.send(JSON.stringify({ type: "list_doctrines" }));
	}
});
socket.on("open", () => {
	socket.send(JSON.stringify({ type: "list_engines" }));
	socket.send(JSON.stringify({ type: "get_commander_config" }));
});
setTimeout(() => {
	writeFileSync("/tmp/user-data.json", JSON.stringify(out));
	console.error("timeout:", Object.keys(out));
	process.exit(2);
}, 8000);
