/**
 * Docker environment check.
 *
 * The console is a front end to a toolbox container: every bash call is a
 * `docker exec` into a project container, so without a working Docker daemon and
 * the toolbox image nothing in the console works. This module answers, before the
 * operator types anything, whether the machine can actually run a task, and what
 * to fix when it cannot.
 *
 * Each item states whether it is blocking. `ok` means every blocking item passed;
 * the console refuses prompts until that is true.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runDocker, ZG_IMAGE } from "./docker.ts";
import { resolveLibraryRole } from "./model-library.ts";
import { listProjects } from "./projects.ts";
import type { ZGEnvItem, ZGEnvReport } from "./protocol.ts";
import { DEFAULT_BASE_IMAGE, EMPTY_SOURCES, effectiveSources, readSources } from "./sources.ts";

const GROUP_RUNTIME = "Docker 运行时";
const GROUP_IMAGE = "工具镜像";
const GROUP_CONTAINER = "容器能力";
const GROUP_HOST = "宿主环境";

/** Below this the image build and container layers can run out of room. */
const MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024;

interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

function runCommand(file: string, args: string[], timeoutMs: number): Promise<CommandResult> {
	return new Promise((resolve) => {
		const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		const finish = (code: number): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		};
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("close", (code) => finish(code ?? 1));
		child.on("error", (error) => {
			stderr = String(error);
			finish(1);
		});
	});
}

function passed(id: string, group: string, label: string, detail: string, blocking = false): ZGEnvItem {
	return { id, group, label, status: "ok", detail, blocking };
}

function failed(id: string, group: string, label: string, detail: string, hint: string): ZGEnvItem {
	return { id, group, label, status: "fail", detail, hint, blocking: true };
}

function warned(id: string, group: string, label: string, detail: string, hint?: string): ZGEnvItem {
	return { id, group, label, status: "warn", detail, hint, blocking: false };
}

function skipped(id: string, group: string, label: string, detail: string, blocking = false): ZGEnvItem {
	return { id, group, label, status: "skipped", detail, blocking };
}

/** Docker reports `aarch64`/`x86_64` where images are tagged `arm64`/`amd64`. */
function normalizeArch(arch: string): string {
	const value = arch.trim().toLowerCase();
	if (value === "aarch64" || value === "arm64") return "arm64";
	if (value === "x86_64" || value === "amd64") return "amd64";
	return value;
}

/** Writable means: create the directory if needed, then write and remove a file. */
function checkWritable(dir: string): { ok: boolean; error?: string } {
	try {
		mkdirSync(dir, { recursive: true });
		const probe = join(dir, ".zgagent-write-probe");
		writeFileSync(probe, "");
		unlinkSync(probe);
		return { ok: true };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "未知";
	const gb = bytes / 1024 / 1024 / 1024;
	return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function formatTimestamp(value: string): string {
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? "时间未知" : new Date(parsed).toLocaleString("zh-CN");
}

async function freeDiskBytes(path: string): Promise<number | undefined> {
	const result = await runCommand("df", ["-k", path], 10000);
	if (result.code !== 0) return undefined;
	const line = result.stdout.trim().split("\n")[1];
	if (!line) return undefined;
	const available = Number(line.split(/\s+/)[3]);
	return Number.isFinite(available) ? available * 1024 : undefined;
}

function projectsRoot(): string {
	return process.env.ZG_PROJECTS_DIR ?? join(homedir(), ".zgagent", "projects");
}

interface RuntimeProbe {
	item: ZGEnvItem;
	/** `linux/arm64`-style host platform, when the daemon reported one. */
	hostPlatform?: string;
}

async function checkDockerRuntime(): Promise<RuntimeProbe> {
	const cli = await runDocker(["--version"], { timeoutMs: 15000 });
	if (cli.code !== 0) {
		const missing = /ENOENT|not found/i.test(cli.stderr);
		return {
			item: failed(
				"docker-cli",
				GROUP_RUNTIME,
				"docker 命令",
				missing ? "未找到 docker 命令" : cli.stderr.trim() || `退出码 ${cli.code}`,
				"安装 Docker Engine 或 Docker Desktop，并确认 docker 在 PATH 中",
			),
		};
	}
	const version = cli.stdout.trim() || "版本未知";

	const info = await runDocker(["info", "--format", "{{.ServerVersion}}|{{.OSType}}|{{.Architecture}}"], {
		timeoutMs: 30000,
	});
	if (info.code !== 0) {
		const stderr = info.stderr.trim();
		const hint = /permission denied|dial unix|connect/i.test(stderr)
			? "Docker 守护进程不可达：启动 Docker Desktop / dockerd，或把当前用户加入 docker 组"
			: "Docker 守护进程未响应，先启动 Docker 再复检";
		return {
			item: failed("docker-daemon", GROUP_RUNTIME, "Docker 守护进程", stderr || `退出码 ${info.code}`, hint),
		};
	}
	const [serverVersion, osType, arch] = info.stdout.trim().split("|");
	const hostPlatform = osType && arch ? `${osType}/${normalizeArch(arch)}` : undefined;
	return {
		item: passed(
			"docker-daemon",
			GROUP_RUNTIME,
			"Docker 守护进程",
			`${version} · 服务端 ${serverVersion || "版本未知"}${hostPlatform ? ` · ${hostPlatform}` : ""}`,
			true,
		),
		hostPlatform,
	};
}

async function checkImage(hostPlatform: string | undefined): Promise<ZGEnvItem[]> {
	const inspect = await runDocker(
		["image", "inspect", ZG_IMAGE, "--format", "{{.Os}}/{{.Architecture}}|{{.Size}}|{{.Created}}"],
		{ timeoutMs: 20000 },
	);
	if (inspect.code !== 0) {
		return [
			failed(
				"image-present",
				GROUP_IMAGE,
				`工具镜像 ${ZG_IMAGE}`,
				"本地不存在该镜像",
				"点下方「构建镜像」（需要网络下载 Kali 软件包）；也可在能联网的机器上 docker build 后导入镜像",
			),
		];
	}
	const [platform, size, created] = inspect.stdout.trim().split("|");
	const items = [
		passed(
			"image-present",
			GROUP_IMAGE,
			`工具镜像 ${ZG_IMAGE}`,
			`${platform || "平台未知"} · ${formatBytes(Number(size))} · 构建于 ${formatTimestamp(created ?? "")}`,
			true,
		),
	];
	if (!platform || !hostPlatform) {
		items.push(skipped("image-platform", GROUP_IMAGE, "镜像与宿主架构", "无法读取镜像或宿主的平台信息"));
		return items;
	}
	if (platform.trim().toLowerCase() === hostPlatform.toLowerCase()) {
		items.push(passed("image-platform", GROUP_IMAGE, "镜像与宿主架构", `与宿主一致（${hostPlatform}）`));
	} else {
		items.push(
			warned(
				"image-platform",
				GROUP_IMAGE,
				"镜像与宿主架构",
				`镜像 ${platform}，宿主 ${hostPlatform}`,
				"架构不一致的容器只能靠模拟运行，速度慢且部分工具不可用；建议在目标机器上重新构建镜像",
			),
		);
	}
	return items;
}

async function checkContainerRun(): Promise<ZGEnvItem> {
	// Exit code is the signal: it is non-zero when the image cannot start at all.
	// `--pull=never` keeps a missing image from turning into a registry download.
	const result = await runDocker(
		["run", "--rm", "--pull=never", "--network", "none", "--entrypoint", "sh", ZG_IMAGE, "-c", "echo zgagent-env-ok"],
		{ timeoutMs: 120000 },
	);
	if (result.code !== 0) {
		return failed(
			"container-run",
			GROUP_CONTAINER,
			"启动一次性容器",
			result.stderr.trim().slice(-400) || `退出码 ${result.code}`,
			"检查 Docker 资源（内存、磁盘）与镜像完整性；必要时删除镜像后重新构建",
		);
	}
	const echoed = result.stdout.includes("zgagent-env-ok");
	return passed(
		"container-run",
		GROUP_CONTAINER,
		"启动一次性容器",
		echoed ? "容器可启动，镜像内 shell 可用" : "容器可启动",
		true,
	);
}

async function checkProjectContainers(agentDir: string | undefined): Promise<ZGEnvItem> {
	if (!agentDir) {
		return skipped("project-containers", GROUP_CONTAINER, "项目容器", "未配置配置目录");
	}
	const { projects } = listProjects(agentDir);
	if (projects.length === 0) {
		return passed("project-containers", GROUP_CONTAINER, "项目容器", "尚未创建项目");
	}
	const stale: string[] = [];
	for (const project of projects) {
		const inspect = await runDocker(["inspect", "-f", "{{.State.Status}}", project.container], { timeoutMs: 15000 });
		const status = inspect.code === 0 ? inspect.stdout.trim() || "未知" : "已丢失";
		if (status !== "running") stale.push(`${project.name}（${status}）`);
	}
	if (stale.length === 0) {
		return passed("project-containers", GROUP_CONTAINER, "项目容器", `全部运行中（${projects.length} 个）`);
	}
	return warned(
		"project-containers",
		GROUP_CONTAINER,
		"项目容器",
		`${stale.length}/${projects.length} 个未运行：${stale.join("、")}`,
		"在「项目」页重新创建或启动这些项目；容器已丢失时重新创建即可",
	);
}

/**
 * Verify the containers carry the project directory at its host path as well as at
 * /work. Without it, a bash command that uses the absolute path the model is given
 * writes into the container's own layer: the file never reaches the host, the file
 * tools and the file panel cannot see it, and recreating the container loses it.
 */
async function checkProjectMounts(agentDir: string | undefined): Promise<ZGEnvItem> {
	if (!agentDir) {
		return skipped("project-mounts", GROUP_CONTAINER, "工作目录挂载", "未配置配置目录");
	}
	const { projects } = listProjects(agentDir);
	if (projects.length === 0) {
		return passed("project-mounts", GROUP_CONTAINER, "工作目录挂载", "尚未创建项目");
	}
	const legacy: string[] = [];
	let inspected = 0;
	for (const project of projects) {
		const inspect = await runDocker(
			["inspect", "-f", "{{range .Mounts}}{{.Source}}->{{.Destination}} {{end}}", project.container],
			{ timeoutMs: 15000 },
		);
		const line = inspect.stdout.trim();
		// A format string the backend cannot answer yields no mount data (the test
		// suite's fake docker answers everything with "true"), so skip instead of
		// reporting a failure that is really an unknown.
		if (inspect.code !== 0 || !line.includes("->")) continue;
		inspected += 1;
		const mounts = line.split(/\s+/);
		if (!mounts.includes(`${project.workDir}->${project.workDir}`)) legacy.push(project.name);
	}
	if (inspected === 0) {
		return skipped("project-mounts", GROUP_CONTAINER, "工作目录挂载", "无法读取挂载信息");
	}
	if (legacy.length === 0) {
		return passed(
			"project-mounts",
			GROUP_CONTAINER,
			"工作目录挂载",
			`项目目录同时挂在宿主路径（${inspected} 个容器）`,
		);
	}
	return warned(
		"project-mounts",
		GROUP_CONTAINER,
		"工作目录挂载",
		`${legacy.length} 个容器缺少同路径挂载：${legacy.join("、")}`,
		"在「项目」页重建这些容器；重建前先用 docker cp 把容器内该路径下的文件复制出来，容器一删就没了",
	);
}

/**
 * Report the sources the next image build will use. Informational: a mirror is a
 * choice, not a requirement, so this item never blocks.
 */
function checkBuildSources(agentDir: string | undefined): ZGEnvItem {
	if (!agentDir) {
		return skipped("build-sources", GROUP_IMAGE, "构建源", "未配置配置目录");
	}
	const sources = effectiveSources(readSources(agentDir));
	const custom =
		sources.baseImage !== DEFAULT_BASE_IMAGE ||
		Boolean(sources.aptMirror || sources.pipIndex || sources.npmRegistry || sources.goProxy);
	if (!custom) {
		return passed(
			"build-sources",
			GROUP_IMAGE,
			"构建源",
			`全部使用官方源（基础镜像 ${DEFAULT_BASE_IMAGE}）· 可在「设置 → 环境」切换国内镜像源`,
		);
	}
	const parts = [`基础镜像 ${sources.baseImage}`];
	parts.push(sources.aptMirror ? `apt ${sources.aptMirror}` : "apt 官方源");
	parts.push(sources.pipIndex ? `pip ${sources.pipIndex}` : "pip 官方源");
	parts.push(sources.npmRegistry ? `npm ${sources.npmRegistry}` : "npm 官方源");
	parts.push(sources.goProxy ? `go ${sources.goProxy}` : "go 官方代理");
	return passed("build-sources", GROUP_IMAGE, "构建源", parts.join(" · "));
}

function checkProjectsDir(): ZGEnvItem {
	const root = projectsRoot();
	const result = checkWritable(root);
	if (!result.ok) {
		return failed(
			"projects-dir",
			GROUP_HOST,
			"项目目录可写",
			`${root}：${result.error ?? "不可写"}`,
			"修正目录权限，或用 ZG_PROJECTS_DIR 指向一个可写目录",
		);
	}
	return passed("projects-dir", GROUP_HOST, "项目目录可写", root, true);
}

function checkAgentDir(agentDir: string | undefined): ZGEnvItem {
	if (!agentDir) {
		return skipped("agent-dir", GROUP_HOST, "配置目录可写", "未配置配置目录");
	}
	const result = checkWritable(agentDir);
	if (!result.ok) {
		return failed(
			"agent-dir",
			GROUP_HOST,
			"配置目录可写",
			`${agentDir}：${result.error ?? "不可写"}`,
			"修正目录权限，或用 ZGAGENT_CODING_AGENT_DIR 指向一个可写目录",
		);
	}
	return passed("agent-dir", GROUP_HOST, "配置目录可写", agentDir, true);
}

async function checkDisk(): Promise<ZGEnvItem> {
	const root = projectsRoot();
	const free = await freeDiskBytes(existsSync(root) ? root : homedir());
	if (free === undefined) {
		return skipped("disk-space", GROUP_HOST, "可用磁盘空间", "无法读取磁盘空间");
	}
	if (free < MIN_FREE_BYTES) {
		return warned(
			"disk-space",
			GROUP_HOST,
			"可用磁盘空间",
			`剩余 ${formatBytes(free)}`,
			"工具镜像约 1.5 GB，容器还要额外空间；建议清理磁盘后重试",
		);
	}
	return passed("disk-space", GROUP_HOST, "可用磁盘空间", `剩余 ${formatBytes(free)}`);
}

function checkModelConfig(agentDir: string | undefined): ZGEnvItem {
	if (!agentDir) {
		return skipped("model-config", GROUP_HOST, "模型端点", "未配置配置目录");
	}
	try {
		const config = resolveLibraryRole(agentDir, "main")?.config ?? null;
		if (!config || !config.baseUrl || !config.modelId) {
			return warned(
				"model-config",
				GROUP_HOST,
				"模型端点",
				"尚未配置模型端点",
				"在「设置 → 模型」中填写 API 地址、模型 ID 与密钥",
			);
		}
		return passed("model-config", GROUP_HOST, "模型端点", `${config.modelId} @ ${config.baseUrl}`);
	} catch (error) {
		return warned(
			"model-config",
			GROUP_HOST,
			"模型端点",
			error instanceof Error ? error.message : String(error),
			"在「设置 → 模型」中检查配置",
		);
	}
}

export interface EnvCheckOptions {
	agentDir?: string;
	url: string;
}

/** Run every check. Never throws: a failing check becomes a report item. */
export async function checkEnvironment(options: EnvCheckOptions): Promise<ZGEnvReport> {
	const runtime = await checkDockerRuntime();
	const dockerReady = runtime.item.status === "ok";
	const items: ZGEnvItem[] = [runtime.item];

	const imageItems = dockerReady
		? await checkImage(runtime.hostPlatform)
		: [
				skipped("image-present", GROUP_IMAGE, `工具镜像 ${ZG_IMAGE}`, "Docker 不可用", true),
				skipped("image-platform", GROUP_IMAGE, "镜像与宿主架构", "Docker 不可用"),
			];
	items.push(
		...imageItems,
		skipped("build-network", GROUP_IMAGE, "构建镜像需要网络", "构建镜像时验证（apt 需要访问配置的软件源）"),
		checkBuildSources(options.agentDir),
	);

	const imageReady = imageItems[0]?.status === "ok";
	items.push(
		imageReady
			? await checkContainerRun()
			: skipped(
					"container-run",
					GROUP_CONTAINER,
					"启动一次性容器",
					dockerReady ? "工具镜像不可用" : "Docker 不可用",
					true,
				),
		await checkProjectContainers(options.agentDir),
		await checkProjectMounts(options.agentDir),
		checkProjectsDir(),
		checkAgentDir(options.agentDir),
		await checkDisk(),
		checkModelConfig(options.agentDir),
	);

	return {
		at: new Date().toISOString(),
		ok: items.every((entry) => !entry.blocking || entry.status === "ok"),
		items,
		url: options.url,
		sources: options.agentDir ? readSources(options.agentDir) : { ...EMPTY_SOURCES },
	};
}
