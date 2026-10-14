/**
 * The capture evidence store: HAR / Burp / text imports, querying, project purge,
 * and the Droid platform fields on vulnerability records.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { CaptureStore, capturesDbPath } from "../src/captures.ts";
import { VulnerabilityStore, vulnerabilityDbPath } from "../src/vulnerabilities.ts";

let dir: string;
let store: CaptureStore;
let vulns: VulnerabilityStore;

const HAR = JSON.stringify({
	log: {
		entries: [
			{
				request: {
					method: "POST",
					url: "https://api.example.com/api/order/create",
					headers: [
						{ name: "Cookie", value: "SID=admin" },
						{ name: "Content-Type", value: "application/json" },
					],
					postData: { text: '{"orderId":1001}' },
				},
				response: {
					status: 200,
					headers: [{ name: "Content-Type", value: "application/json" }],
					content: { text: '{"code":0,"data":{"orderId":1001}}' },
				},
			},
			{
				request: { method: "GET", url: "https://api.example.com/api/user/info?id=2" },
				response: { status: 401, content: { text: '{"code":2}' } },
			},
		],
	},
});

const BURP = `<?xml version="1.0"?>
<items>
<item>
<url>https://api.example.com/api/pay/transfer</url>
<host ip="1.2.3.4">api.example.com</host>
<method>POST</method>
<status>200</status>
<request base64="true">${Buffer.from("POST /api/pay/transfer HTTP/1.1\r\nHost: api.example.com\r\n\r\namount=1").toString("base64")}</request>
<response base64="true">${Buffer.from('HTTP/1.1 200 OK\r\n\r\n{"code":0}').toString("base64")}</response>
</item>
</items>`;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "zg-captures-"));
	store = new CaptureStore(capturesDbPath(dir));
	vulns = new VulnerabilityStore(vulnerabilityDbPath(dir));
});

afterAll(() => {
	store.close();
	vulns.close();
	rmSync(dir, { recursive: true, force: true });
});

test("HAR import lands queryable request/response pairs", () => {
	const result = store.importHar("p1", "traffic.har", HAR);
	expect(result.imported).toBe(2);
	expect(result.skipped).toBe(0);

	const rows = store.list("p1");
	expect(rows).toHaveLength(2);
	expect(rows[0]?.method).toBe("GET");

	const entry = store.get(rows[1]?.id as string, "p1");
	expect(entry?.host).toBe("api.example.com");
	expect(entry?.requestBody).toContain("orderId");
	expect(entry?.requestHeaders).toContain("SID=admin");
	expect(entry?.responseBody).toContain('"code":0');
});

test("Burp XML (base64 bodies) imports decoded", () => {
	const result = store.importBurp("p1", "burp.xml", BURP);
	expect(result.imported).toBe(1);
	const rows = store.list("p1", { host: "api.example.com" });
	expect(rows.some((row) => row.path === "/api/pay/transfer")).toBe(true);
});

test("search filters by host and free text, project-scoped", () => {
	expect(store.list("p1", { q: "orderId" })).toHaveLength(1);
	expect(store.list("p1", { host: "nope.example.com" })).toHaveLength(0);
	// Another project sees nothing: evidence is project-scoped.
	expect(store.list("p2")).toHaveLength(0);
	expect(store.count("p1")).toBe(3);
});

test("vuln records carry the Droid platform fields", () => {
	const created = vulns.create({
		projectId: "p1",
		projectName: "演示项目",
		source: "主代理",
		title: "订单接口水平越权",
		severity: "high",
		cvss: 7.5,
		target: "https://api.example.com/api/order/create",
		description: "替换 orderId 即可读取他人订单",
		packet: "POST /api/order/create HTTP/1.1",
		platform: "android",
		appPackage: "com.example.shop",
		appVersion: "3.2.1",
	});
	expect(created.platform).toBe("android");
	expect(created.appPackage).toBe("com.example.shop");
	// An old-style submission without the fields stays web.
	const web = vulns.create({
		projectId: "p1",
		projectName: "演示项目",
		source: "主代理",
		title: "后台未授权访问",
		severity: "high",
		cvss: 8.1,
		target: "https://api.example.com/admin",
		description: "无需登录即可访问",
		packet: "GET /admin HTTP/1.1",
	});
	expect(web.platform).toBe("web");
	expect(web.appPackage).toBeUndefined();
	// A database from before the columns existed upgrades and reports the defaults.
	const reopened = new VulnerabilityStore(vulnerabilityDbPath(dir));
	const fetched = reopened.get(created.id);
	expect(fetched?.appPackage).toBe("com.example.shop");
	reopened.close();
});
