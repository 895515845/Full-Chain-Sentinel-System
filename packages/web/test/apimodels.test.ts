/**
 * Unit tests for the business-modeling store.
 *
 * The store is what makes a modeling run a durable artifact rather than a chat
 * message: the document, the entities, the counters and the audit trail. The
 * tests are mostly about refusal — a document that a Swagger tool could not
 * open must not be stored, and a refused submission must not half-update a
 * record.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
	ApiModelStore,
	apiModelExportName,
	apiModelsDbPath,
	buildApiModelExport,
	countOperations,
	mergeOpenApiDraft,
	normalizeEntities,
	normalizeModelTitle,
	validateOpenApiDocument,
} from "../src/apimodels.ts";

const DOC = (paths: Record<string, unknown> = {}): Record<string, unknown> => ({
	openapi: "3.0.3",
	info: { title: "商城前台 API", version: "1.0.0" },
	paths,
});

let dir: string;
let store: ApiModelStore;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "sentinel-apimodels-"));
	store = new ApiModelStore(apiModelsDbPath(dir));
});

afterAll(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

test("the database lives in the agent directory, not the mounted work directory", () => {
	expect(apiModelsDbPath("/home/zg/.sentinel/agent")).toBe("/home/zg/.sentinel/agent/apimodels.db");
});

test("countOperations counts methods, not keys", () => {
	expect(countOperations({ "/a": { get: {}, post: {}, parameters: [] } })).toBe(2);
	expect(countOperations({ "/a": { get: {} }, "/b": { delete: {} } })).toBe(2);
	expect(countOperations({ "/a": { summary: "x" } })).toBe(0);
	expect(countOperations(null)).toBe(0);
});

test("validation names every reason a document cannot be opened", () => {
	expect(validateOpenApiDocument(DOC())).toEqual([]);
	expect(validateOpenApiDocument("nope")).toEqual(["文档必须是一个 JSON 对象。"]);
	expect(validateOpenApiDocument({})).toEqual([
		'缺少 openapi 字段：必须是 "3.0.0" 这类 3.x 版本号（本控制台只接受 OpenAPI 3.x）。',
		"缺少 info 对象：至少要写 info.title 与 info.version。",
		"缺少 paths 对象：没有接口时也要写空的 paths: {}。",
	]);
	expect(validateOpenApiDocument({ openapi: "2.0", info: { title: "x", version: "1" }, paths: {} })).toEqual([
		'openapi 版本 2.0 不受支持：必须是 3.x（例如 "3.0.3"）。',
	]);
	expect(
		validateOpenApiDocument({ openapi: "3.1.0", info: { title: " ", version: "1" }, paths: { users: {} } }),
	).toEqual(["info.title 不能为空。", "paths 的键必须以 / 开头：users 不合法。"]);
	expect(validateOpenApiDocument({ ...DOC(), components: [] })).toEqual(["components 必须是对象。"]);
});

test("merging a shard replaces only the paths it names", () => {
	const base = DOC({ "/a": { get: {} }, "/b": { get: {} } });
	const merged = mergeOpenApiDraft(base, { paths: { "/b": { post: {} }, "/c": { get: {} } } });
	expect(Object.keys(merged.paths as Record<string, unknown>)).toEqual(["/a", "/b", "/c"]);
	expect((merged.paths as Record<string, Record<string, unknown>>)["/b"]).toEqual({ post: {} });
	// The base object is not mutated: the caller keeps its draft.
	expect((base.paths as Record<string, Record<string, unknown>>)["/b"]).toEqual({ get: {} });
});

test("merging components merges inside each section", () => {
	const merged = mergeOpenApiDraft(
		{ ...DOC(), components: { schemas: { User: { type: "object" } }, securitySchemes: { cookie: {} } } },
		{ components: { schemas: { Order: { type: "object" } } } },
	);
	const components = merged.components as Record<string, Record<string, unknown>>;
	expect(Object.keys(components.schemas)).toEqual(["User", "Order"]);
	expect(components.securitySchemes).toEqual({ cookie: {} });
});

test("an unnamed entity is reported, not dropped silently", () => {
	const result = normalizeEntities([
		{
			name: "订单",
			description: "客户下单产生的单据",
			fields: [{ name: "id", type: "string" }],
			relations: [{ target: "用户", kind: "N:1" }],
		},
		{ description: "缺名字" },
		{ name: "用户", fields: "nope" },
	]);
	expect(result.entities.map((entity) => entity.name)).toEqual(["订单", "用户"]);
	expect(result.entities[0].relations).toEqual([{ target: "用户", kind: "N:1" }]);
	expect(result.errors).toEqual(["entities[1] 缺少 name。", "实体「用户」的 fields 必须是数组。"]);
	expect(normalizeEntities(undefined)).toEqual({ entities: [], errors: [] });
	expect(normalizeEntities("nope").errors).toEqual(["entities 必须是数组。"]);
});

test("titles are trimmed to something one row can show", () => {
	expect(normalizeModelTitle("【业务建模】商城前台 API。")).toBe("商城前台 API");
	expect(normalizeModelTitle("   ")).toBe("");
	expect(normalizeModelTitle("x".repeat(200))).toHaveLength(80);
});

test("a run exists before the agent submits anything", () => {
	const run = store.beginRun({
		projectId: "p1",
		sessionId: "s1",
		sessionPath: "/tmp/s1.jsonl",
		title: "【业务建模】商城",
	});
	expect(run.status).toBe("modeling");
	expect(run.title).toBe("商城");
	expect(run.pathCount).toBe(0);
	expect(run.entities).toEqual([]);
	// The draft is a valid document from the start, so the page can render it.
	expect(validateOpenApiDocument(run.openapi)).toEqual([]);
	expect(store.events(run.id).map((event) => event.kind)).toEqual(["created"]);
});

test("a refused submission writes nothing", () => {
	const run = store.beginRun({ projectId: "p1", sessionId: "s1", sessionPath: null });
	const refused = store.submit(run.id, { openapi: { openapi: "2.0", paths: {} } });
	expect(refused.model).toBeUndefined();
	expect(refused.errors?.length).toBeGreaterThan(0);
	const stored = store.get(run.id) as NonNullable<ReturnType<ApiModelStore["get"]>>;
	expect(stored.submissions).toBe(0);
	expect(stored.openapi.openapi).toBe("3.0.3");
	expect(stored.entities).toEqual([]);
});

test("submitting shards accumulates the document, the entities and the counters", () => {
	const run = store.beginRun({ projectId: "p1", sessionId: "s2", sessionPath: null, title: "商城" });
	const first = store.submit(run.id, {
		paths: { "/api/users": { get: { summary: "用户列表" }, post: { summary: "创建用户" } } },
		target: "https://shop.example.com",
		entities: [{ name: "用户", fields: [{ name: "id" }] }],
		note: "先交用户模块",
	});
	expect(first.model?.pathCount).toBe(1);
	expect(first.model?.operationCount).toBe(2);
	expect(first.model?.entities.length).toBe(1);
	expect(first.model?.target).toBe("https://shop.example.com");

	const second = store.submit(run.id, { paths: { "/api/orders": { get: {} } } });
	expect(second.model?.pathCount).toBe(2);
	expect(second.model?.operationCount).toBe(3);
	// A submission without entities keeps the stored list.
	expect(second.model?.entities.map((entity) => entity.name)).toEqual(["用户"]);
	expect(second.model?.submissions).toBe(2);

	const events = store.events(run.id);
	expect(events.map((event) => event.kind)).toEqual(["created", "submitted", "submitted"]);
	expect(events[1].note).toBe("先交用户模块");
	expect(events[2].pathCount).toBe(2);
});

test("a whole-document submission replaces the draft", () => {
	const run = store.beginRun({ projectId: "p1", sessionId: "s3", sessionPath: null });
	store.submit(run.id, { paths: { "/old": { get: {} } } });
	const replaced = store.submit(run.id, { openapi: DOC({ "/new": { get: {} } }) });
	expect(Object.keys(replaced.model?.openapi.paths as Record<string, unknown>)).toEqual(["/new"]);
});

test("entity problems come back as warnings on a stored document", () => {
	const run = store.beginRun({ projectId: "p1", sessionId: "s4", sessionPath: null });
	const result = store.submit(run.id, { paths: { "/a": { get: {} } }, entities: [{ description: "无名" }] });
	expect(result.model?.pathCount).toBe(1);
	expect(result.errors).toEqual(["entities[0] 缺少 name。"]);
});

test("finishing records the outcome and its audit line", () => {
	const run = store.beginRun({ projectId: "p2", sessionId: "s5", sessionPath: null });
	store.submit(run.id, { paths: { "/a": { get: {} } } });
	const done = store.finish(run.id, "done", { note: "覆盖用户与订单模块" });
	expect(done?.status).toBe("done");
	expect(done?.doneAt).not.toBeNull();
	expect(store.events(run.id).map((event) => event.kind)).toEqual(["created", "submitted", "done"]);
	expect(store.events(run.id)[2].note).toBe("覆盖用户与订单模块");
	// Finishing twice is not an error: the agent's tool and the operator's button race.
	expect(store.finish(run.id, "manual")?.status).toBe("manual");
	expect(store.finish("api-missing", "manual")).toBeUndefined();
});

test("listing filters by project, status and search text, newest first", () => {
	const older = store.beginRun({ projectId: "p3", sessionId: "s6", sessionPath: null, title: "旧站点" });
	store.submit(older.id, { target: "https://old.example.com", paths: { "/a": { get: {} } } });
	const newer = store.beginRun({ projectId: "p3", sessionId: "s7", sessionPath: null, title: "新站点" });
	store.submit(newer.id, { target: "https://new.example.com" });
	store.finish(newer.id, "manual");

	expect(store.list({ projectId: "p3" }).map((item) => item.title)).toEqual(["新站点", "旧站点"]);
	expect(store.list({ projectId: "p3", status: "manual" }).map((item) => item.title)).toEqual(["新站点"]);
	expect(store.list({ projectId: "p3", search: "old.example" }).map((item) => item.title)).toEqual(["旧站点"]);
	expect(store.list({ projectId: "p3", search: "没有这个" })).toEqual([]);
	expect(store.list({ projectId: "p3" })[0].entityCount).toBe(0);
	expect(store.countProject("p3")).toBe(2);
	expect(store.countProject("nope")).toBe(0);
});

test("deleting a run takes its audit trail with it", () => {
	const run = store.beginRun({ projectId: "p4", sessionId: "s8", sessionPath: null });
	expect(store.delete(run.id)).toBe(true);
	expect(store.get(run.id)).toBeUndefined();
	expect(store.events(run.id)).toEqual([]);
	expect(store.delete(run.id)).toBe(false);
});

test("removing a project removes its runs and leaves the others", () => {
	const kept = store.beginRun({ projectId: "p5", sessionId: "s9", sessionPath: null });
	const doomed = store.beginRun({ projectId: "p6", sessionId: "s10", sessionPath: null });
	expect(store.purgeProject("p6")).toBe(1);
	expect(store.get(doomed.id)).toBeUndefined();
	expect(store.get(kept.id)?.projectId).toBe("p5");
	expect(store.purgeProject("p6")).toBe(0);
});

test("export produces a file a Swagger tool can open", () => {
	const run = store.beginRun({ projectId: "p7", sessionId: "s11", sessionPath: null, title: "商城 前台/API" });
	const model = store.submit(run.id, { paths: { "/a": { get: { summary: "x" } } } }).model as NonNullable<
		ReturnType<ApiModelStore["get"]>
	>;
	const json = buildApiModelExport(model, "json");
	expect(json.filename).toMatch(/^商城-前台-api-[0-9a-f]{8}\.json$/);
	expect(JSON.parse(json.text).paths["/a"].get.summary).toBe("x");

	const yaml = buildApiModelExport(model, "yaml");
	expect(yaml.filename.endsWith(".yaml")).toBe(true);
	expect(yaml.text).toContain("openapi: 3.0.3");
	expect(yaml.text).toContain("/a:");

	// A record with neither title nor target still gets a usable name.
	expect(apiModelExportName({ ...model, title: "", target: "" }, "json")).toBe(
		`api-model-${model.id.slice(4, 12)}.json`,
	);
});
