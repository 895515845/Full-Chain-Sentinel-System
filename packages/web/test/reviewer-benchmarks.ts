/**
 * Calibration benchmarks for the reviewer LLM.
 *
 * The reviewer re-derives the CVSS metrics of a finding from its evidence.
 * Without a rubric it drifts high: it read 「普通用户即可触发」 as "no
 * privileges required" and pulled the three impact axes up together, so a
 * read-only IDOR came back as 9.8. These cases pin down what a right answer
 * looks like.
 *
 * The expected values are a human reading of CVSS v3.1, deliberately not the
 * model's: the point of a benchmark is to disagree with the model where the
 * model is wrong. They are the yardstick a prompt change is measured against.
 */

import type { SentinelVulnerability } from "../src/protocol.ts";

export interface ReviewerBenchmark {
	/** What the case is called in a regression report. */
	name: string;
	/** The bucket a competent assessor gives this finding. */
	expectedSeverity: "critical" | "high" | "medium" | "low" | "info";
	/** The score those metrics produce. */
	expectedCvss: number;
	/** Why the case sits where it does. */
	note: string;
	/** The finding, in the shape the reviewer is shown it. */
	finding: {
		title: string;
		target: string;
		category: string;
		description: string;
		packet: string;
		repro?: string;
	};
}

export const REVIEWER_BENCHMARKS: ReviewerBenchmark[] = [
	{
		name: "A 公开页面的版本号泄露",
		expectedSeverity: "info",
		expectedCvss: 0,
		note: "只暴露版本号，没有敏感数据、没有修改、没有服务影响。",
		finding: {
			title: "首页返回服务端版本号",
			category: "信息泄露",
			target: "https://shop.example.com/",
			description:
				"未登录访问首页时，响应头里带有 X-Powered-By: Express/4.18.2 和 Server 版本号。攻击者据此判断技术栈与可查公开 CVE。没有任何敏感数据泄露，也没有修改任何数据。",
			packet:
				"GET / HTTP/1.1\nHost: shop.example.com\n\nHTTP/1.1 200 OK\nServer: nginx/1.24.0\nX-Powered-By: Express/4.18.2\nContent-Type: text/html\n\n<html>...</html>",
		},
	},
	{
		name: "B 需要用户自己触发的反射型 XSS",
		expectedSeverity: "low",
		expectedCvss: 4.4,
		note: "UI=R，攻击者拿不到受害者数据，机密性最多 L，完整性与可用性无影响。",
		finding: {
			title: "搜索框反射型 XSS（需用户点击）",
			category: "XSS",
			target: "https://shop.example.com/search",
			description:
				"搜索参数 q 未转义直接回显，构造 ?q=<script>alert(1)</script> 可以执行。攻击者必须诱导受害者点击自己构造的链接，XSS 运行在受害者自己的浏览器里，攻击者读不到数据，站点也不受影响。",
			packet:
				"GET /search?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E HTTP/1.1\nHost: shop.example.com\n\nHTTP/1.1 200 OK\nContent-Type: text/html\n\n<div>未找到 “<script>alert(1)</script>”</div>",
			repro: "1. 构造链接 https://shop.example.com/search?q=<script>alert(1)</script>\n2. 让受害者点击\n3. 受害者浏览器弹出 alert(1)",
		},
	},
	{
		name: "C 已登录用户改 id 读别人的订单",
		expectedSeverity: "medium",
		expectedCvss: 6.5,
		note: "需要任意普通账号（PR:L），只能读不能改：机密性高、完整性无、可用性无。",
		finding: {
			title: "订单详情接口越权读他人订单",
			category: "越权",
			target: "https://shop.example.com/api/order/detail",
			description:
				"普通用户登录后，把 /api/order/detail?id=10021 改成 id=10022、10023 就能读到其他用户的收货人姓名、手机号和地址。只能读不能改，攻击者需要先有一个普通账号。",
			packet:
				'GET /api/order/detail?id=10022 HTTP/1.1\nHost: shop.example.com\nCookie: sid=<普通用户 B 的 session>\n\nHTTP/1.1 200 OK\nContent-Type: application/json\n\n{"id":10022,"receiver":"张三","phone":"138****0000","address":"杭州市…"}\n\n(同样的请求用 id=10021 返回的是 A 用户自己的订单，属于越权)',
			repro: "1. 用账号 B 登录\n2. GET /api/order/detail?id=10021 拿到自己的订单\n3. 改成 id=10022，返回了别人的订单",
		},
	},
	{
		name: "D 后台 SQL 注入（需管理员登录）",
		expectedSeverity: "high",
		expectedCvss: 8.8,
		// The one genuinely arguable case, and it stays arguable on purpose:
		// PR:H (the attacker needs an admin account) with C:H/I:H gives 7.2,
		// PR:L gives 9.1, and I:N (judging only the read the packet shows)
		// takes it down to 6.4. 8.8 is the reading this benchmark holds — a
		// reviewer that lands anywhere in the high bucket is not wrong, and
		// one that lands in the critical bucket without evidence is.
		note: "需要管理员会话（PR:L 或 H），能读全站用户表：机密性高、完整性高、可用性无。",
		finding: {
			title: "后台订单搜索处 SQL 注入",
			category: "SQL 注入",
			target: "https://shop.example.com/admin/order/search",
			description:
				"后台订单搜索的 keyword 参数直接拼进 SQL，单引号闭合后可以 UNION 读取 users 表。用 admin 账号登录后触发，可以拖取全站用户表。影响限于本站数据库，没有跨到其他系统。",
			packet:
				'GET /admin/order/search?keyword=a\' UNION SELECT id,username,password,email FROM users-- HTTP/1.1\nHost: shop.example.com\nCookie: sid=<admin session>\n\nHTTP/1.1 200 OK\nContent-Type: application/json\n\n{"rows":[{"id":1,"username":"admin","password":"5f4dcc3b5aa765d61d8327deb882cf99","email":"a@x.com"}]}',
			repro: "1. 用 admin 登录后台\n2. GET /admin/order/search?keyword=a' UNION SELECT ... --\n3. 返回 users 表内容",
		},
	},
	{
		name: "E 未授权 RCE",
		expectedSeverity: "critical",
		expectedCvss: 9.8,
		note: "未登录即可执行系统命令，三个影响轴都是高。",
		finding: {
			title: "上传接口未授权命令执行",
			category: "命令执行",
			target: "https://shop.example.com/api/upload",
			description: "未登录即可调用 /api/upload，filename 参数直接拼进 shell 命令，可以执行任意系统命令。",
			packet:
				'POST /api/upload HTTP/1.1\nHost: shop.example.com\nContent-Type: multipart/form-data\n\n...filename="a;id"\n\nHTTP/1.1 200 OK\n\nuid=0(root) gid=0(root)',
		},
	},
	{
		name: "F 前端硬编码超管口令",
		expectedSeverity: "critical",
		expectedCvss: 9.1,
		// An authentication bypass is a takeover, not a read: the attacker ends
		// up holding the administrator's account, so confidentiality and
		// integrity are both high. Availability is not, because nothing in the
		// evidence shows the service can be brought down — the account being
		// an admin does not by itself prove the attacker will delete the
		// database.
		note: "未登录即可拿到管理员账号：机密性高、完整性高、可用性无。",
		finding: {
			title: "前端 JS 硬编码后台管理员口令",
			category: "硬编码凭据",
			target: "https://shop.example.com/",
			description:
				"站点自带的 main.js 里明文写着后台 admin 的账号和口令，未登录的任何人下载这个 js 就能直接以管理员身份登录后台，读取全部订单和用户数据，也能以管理员身份修改订单状态。",
			packet:
				'GET /static/main.js HTTP/1.1\nHost: shop.example.com\n\nHTTP/1.1 200 OK\nContent-Type: application/javascript\n\nconst cfg={adminUser:"admin",adminPass:"Adm1n@2024"};',
		},
	},
	{
		name: "G 只能盲注的 SQL 注入",
		expectedSeverity: "high",
		expectedCvss: 7.5,
		// Read-only means read-only: a boolean-blind injection extracts data
		// but cannot change it and cannot stop the service, so only
		// confidentiality is affected.
		note: "未登录即可盲注读库：机密性高、完整性无、可用性无。",
		finding: {
			title: "文章详情接口 name 参数盲注",
			category: "SQL 注入",
			target: "https://shop.example.com/api/article/detail",
			description:
				"未登录即可调用 /api/article/detail，name 参数拼进 SQL，只能靠布尔条件逐位猜解，没有联合查询也没有报错回显，读得出文章表里的内容但改不了任何数据。",
			packet:
				"GET /api/article/detail?name=x' AND (SELECT SUBSTR(password,1,1) FROM users LIMIT 1)='a' HTTP/1.1\nHost: shop.example.com\n\nHTTP/1.1 200 OK\nContent-Length: 0\n\n(条件为真时返回 200，为假时返回 500)",
		},
	},
	{
		name: "H 硬编码的 API Key 泄露",
		expectedSeverity: "high",
		expectedCvss: 7.5,
		// The leaked key is the confidential thing, and the attacker's reach
		// stops there: no data can be changed and no service can be stopped.
		note: "密钥本身就是机密：机密性高、完整性无、可用性无。",
		finding: {
			title: "前端 JS 硬编码第三方 API Key",
			category: "硬编码凭据",
			target: "https://shop.example.com/",
			description:
				"站点自己的 js 里写死了调用地图服务的 API Key，任何人下载这个 js 就能拿走这个 Key 去调用该 Key 的配额。没有泄露任何业务数据，也改不了站点的任何数据。",
			packet:
				'GET /static/app.js HTTP/1.1\nHost: shop.example.com\n\nHTTP/1.1 200 OK\nContent-Type: application/javascript\n\nconst MAP_KEY="a1b2c3d4e5f6";',
		},
	},
];

/** The finding as the reviewer sees it, minus the fields the prompt never reads. */
export function benchmarkVuln(benchmark: ReviewerBenchmark): SentinelVulnerability {
	return {
		title: benchmark.finding.title,
		target: benchmark.finding.target,
		category: benchmark.finding.category,
		source: "主代理",
		description: benchmark.finding.description,
		packet: benchmark.finding.packet,
		repro: benchmark.finding.repro ?? "",
		evidence: [],
	} as unknown as SentinelVulnerability;
}

/** How far a score sits from the benchmark's, in CVSS points. */
export function scoreDelta(actual: number, expected: number): number {
	return Math.round((actual - expected) * 10) / 10;
}
