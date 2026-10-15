import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	buildArgs,
	CHINA_SOURCES,
	DEFAULT_BASE_IMAGE,
	EMPTY_SOURCES,
	effectiveSources,
	normalizeSources,
	readSources,
	sourcesPath,
	writeSources,
} from "../src/sources.ts";

let root = "";

function freshAgentDir(): string {
	root = mkdtempSync(join(tmpdir(), "sentinel-sources-"));
	return root;
}

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

describe("normalizeSources", () => {
	test("expands a bare registry to the official repository on it", () => {
		const sources = normalizeSources({ baseImage: "docker.m.daocloud.io" });
		expect(sources.baseImage).toBe(`docker.m.daocloud.io/${DEFAULT_BASE_IMAGE}`);
	});

	test("keeps a full image reference and drops a scheme and trailing slash", () => {
		expect(normalizeSources({ baseImage: "https://harbor.internal:5000/kali/toolbox:1/" }).baseImage).toBe(
			"harbor.internal:5000/kali/toolbox:1",
		);
	});

	test("adds http to an apt mirror and https to the others", () => {
		const sources = normalizeSources({
			aptMirror: "mirrors.tuna.tsinghua.edu.cn/kali/",
			pipIndex: "pypi.tuna.tsinghua.edu.cn/simple",
			npmRegistry: "registry.npmmirror.com",
		});
		expect(sources.aptMirror).toBe("http://mirrors.tuna.tsinghua.edu.cn/kali");
		expect(sources.pipIndex).toBe("https://pypi.tuna.tsinghua.edu.cn/simple");
		expect(sources.npmRegistry).toBe("https://registry.npmmirror.com");
	});

	test("keeps an explicit scheme and the direct keyword in a go proxy list", () => {
		expect(normalizeSources({ goProxy: "goproxy.cn, direct" }).goProxy).toBe("https://goproxy.cn,direct");
		expect(normalizeSources({ goProxy: "http://goproxy.io,off" }).goProxy).toBe("http://goproxy.io,off");
	});

	test("an empty input means the official sources", () => {
		expect(normalizeSources({})).toEqual(EMPTY_SOURCES);
		expect(effectiveSources(EMPTY_SOURCES).baseImage).toBe(DEFAULT_BASE_IMAGE);
	});
});

describe("buildArgs", () => {
	test("always passes the base image and only the mirrors that are set", () => {
		expect(buildArgs(EMPTY_SOURCES)).toEqual(["--build-arg", `BASE_IMAGE=${DEFAULT_BASE_IMAGE}`]);
	});

	test("passes every configured mirror as a build arg", () => {
		const args = buildArgs(CHINA_SOURCES);
		expect(args).toContain(`BASE_IMAGE=${CHINA_SOURCES.baseImage}`);
		expect(args).toContain(`APT_MIRROR=${CHINA_SOURCES.aptMirror}`);
		expect(args).toContain(`PIP_INDEX=${CHINA_SOURCES.pipIndex}`);
		expect(args).toContain(`NPM_REGISTRY=${CHINA_SOURCES.npmRegistry}`);
		expect(args).toContain(`GO_PROXY=${CHINA_SOURCES.goProxy}`);
		// build args must be normalized too, so the build never sees a bare host
		expect(buildArgs({ ...EMPTY_SOURCES, aptMirror: "mirrors.ustc.edu.cn/kali" })).toContain(
			"APT_MIRROR=http://mirrors.ustc.edu.cn/kali",
		);
	});
});

describe("readSources and writeSources", () => {
	test("round-trips through <agentDir>/sources.json", () => {
		const agentDir = freshAgentDir();
		writeSources(agentDir, CHINA_SOURCES);
		expect(sourcesPath(agentDir)).toBe(join(agentDir, "sources.json"));
		expect(readSources(agentDir)).toEqual(CHINA_SOURCES);
	});

	test("a missing file means the official sources", () => {
		expect(readSources(freshAgentDir())).toEqual(EMPTY_SOURCES);
	});

	test("a malformed or unexpected file does not throw", () => {
		const agentDir = freshAgentDir();
		writeFileSync(sourcesPath(agentDir), "{ not json");
		expect(readSources(agentDir)).toEqual(EMPTY_SOURCES);
		writeFileSync(sourcesPath(agentDir), JSON.stringify({ aptMirror: 42, baseImage: null }));
		expect(readSources(agentDir)).toEqual(EMPTY_SOURCES);
	});

	test("writeSources creates the agent directory", () => {
		const agentDir = join(freshAgentDir(), "nested", "agent");
		mkdirSync(agentDir, { recursive: true });
		writeSources(agentDir, { ...EMPTY_SOURCES, aptMirror: "mirrors.ustc.edu.cn/kali" });
		expect(readSources(agentDir).aptMirror).toBe("http://mirrors.ustc.edu.cn/kali");
	});
});
