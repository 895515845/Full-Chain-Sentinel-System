/**
 * The environment page.
 *
 * The console is a front end to a toolbox container, so this page answers the one
 * question that decides whether anything can run: is there a working Docker
 * daemon with the toolbox image behind it. It is also where the image gets built,
 * because a machine that has Docker but no image is the normal first-run state.
 *
 * Blocking items are listed first within their group and the page says plainly
 * that the chat is locked until they pass.
 */

import { useEffect, useRef, useState } from "react";
import type { SentinelContainerNetwork, SentinelEnvItem, SentinelEnvReport, SentinelSources } from "../types.ts";
import { t } from "../i18n.ts";
import { RefreshIcon } from "./icons.tsx";

/** One-click Chinese mirrors; the server normalizes whatever is saved. */
const CHINA_SOURCES: SentinelSources = {
	baseImage: "docker.m.daocloud.io/kalilinux/kali-rolling:latest",
	aptMirror: "http://mirrors.tuna.tsinghua.edu.cn/kali",
	pipIndex: "https://pypi.tuna.tsinghua.edu.cn/simple",
	npmRegistry: "https://registry.npmmirror.com",
	goProxy: "https://goproxy.cn,direct",
};

const EMPTY_SOURCES: SentinelSources = {
	baseImage: "",
	aptMirror: "",
	pipIndex: "",
	npmRegistry: "",
	goProxy: "",
};

const SOURCE_FIELDS: Array<{ key: keyof SentinelSources; label: string; placeholder: string }> = [
	{
		key: "baseImage",
		label: t("基础镜像"),
		placeholder: t("kalilinux/kali-rolling:latest（可只填 registry，如 docker.m.daocloud.io）"),
	},
	{ key: "aptMirror", label: t("apt 源"), placeholder: t("http://http.kali.org/kali（官方）") },
	{ key: "pipIndex", label: t("pip 源"), placeholder: t("https://pypi.org/simple（官方）") },
	{ key: "npmRegistry", label: t("npm 源"), placeholder: t("https://registry.npmjs.org（官方）") },
	{ key: "goProxy", label: t("go 代理"), placeholder: t("https://proxy.golang.org,direct（官方）") },
];

/**
 * Build sources: the base image and the package mirrors baked into the image.
 * Mounted with a key derived from the saved values, so a save or a refresh
 * re-seeds the fields without discarding edits in progress.
 */
function SourcesForm({
	initial,
	savedAt,
	busy,
	onSave,
}: {
	initial: SentinelSources;
	savedAt: number | null;
	busy: boolean;
	onSave: (sources: SentinelSources) => void;
}) {
	const [draft, setDraft] = useState<SentinelSources>(initial);
	const dirty = SOURCE_FIELDS.some((field) => draft[field.key] !== initial[field.key]);
	const set = (key: keyof SentinelSources, value: string) => setDraft((current) => ({ ...current, [key]: value }));

	return (
		<section className="env-sources">
			<div className="env-sources-head">
				<h3>{t("构建源")}</h3>
				<span className="composer-spacer" />
				{!dirty && savedAt !== null ? <span className="env-note">{t("已保存，重建镜像后生效")}</span> : null}
				{dirty ? <span className="env-note">{t("有未保存的修改")}</span> : null}
			</div>
			<p className="settings-hint">
				{t("这些值会烘焙进工具镜像，所以保存后需要重建镜像；pip / npm / go 三项在容器内运行时（pip install、npm install、go install）同样生效。留空表示使用官方源。")}
			</p>
			<div className="env-source-grid">
				{SOURCE_FIELDS.map((field) => (
					<label key={field.key}>
						{field.label}
						<input
							value={draft[field.key]}
							onChange={(event) => set(field.key, event.target.value)}
							placeholder={field.placeholder}
							spellCheck={false}
						/>
					</label>
				))}
			</div>
			<div className="env-source-actions">
				<button type="button" className="ghost small" onClick={() => setDraft(CHINA_SOURCES)} disabled={busy}>
					{t("中国镜像源")}
				</button>
				<button type="button" className="ghost small" onClick={() => setDraft(EMPTY_SOURCES)} disabled={busy}>
					{t("清空（用官方源）")}
				</button>
				<span className="composer-spacer" />
				<button type="button" className="primary" onClick={() => onSave(draft)} disabled={busy || !dirty}>
					{t("保存")}
				</button>
			</div>
		</section>
	);
}

/**
 * Container network: whether a project container shares the host's network stack
 * or keeps Docker's own. Host is the default because it is what makes a listener
 * inside the container reachable from the target, and because a real LAN, VPN and
 * internal DNS are what the tools need to see.
 */
const NETWORK_OPTIONS: Array<{ value: SentinelContainerNetwork; label: string; detail: string }> = [
	{
		value: "host",
		label: t("host（默认）"),
		detail:
			t("容器直接用宿主机的网络：里面起的监听端口（反向 shell、payload 服务、handler）目标机器能连回来，127.0.0.1 就是宿主机（Burp、本地靶场），内网、VPN 与内网 DNS 都是真实的。代价是与宿主机抢端口，且不再有 Docker 的网络隔离。"),
	},
	{
		value: "bridge",
		label: t("bridge（Docker 默认隔离）"),
		detail:
			t("容器有自己的地址，只能通过 host.docker.internal 访问宿主机，且不对外发布任何端口——目标机器连不回容器里的监听。需要隔离、也不需要反弹时用它。"),
	},
];

/**
 * Network mode for new and rebuilt containers. Mounted with a key derived from the
 * saved value, like the sources form, so a save or a refresh re-seeds the choice.
 */
function NetworkForm({
	initial,
	savedAt,
	busy,
	onSave,
}: {
	initial: SentinelContainerNetwork;
	savedAt: number | null;
	busy: boolean;
	onSave: (network: SentinelContainerNetwork) => void;
}) {
	const [draft, setDraft] = useState<SentinelContainerNetwork>(initial);
	const dirty = draft !== initial;

	return (
		<section className="env-sources">
			<div className="env-sources-head">
				<h3>{t("容器网络")}</h3>
				<span className="composer-spacer" />
				{!dirty && savedAt !== null ? <span className="env-note">{t("已保存，重建容器后生效")}</span> : null}
				{dirty ? <span className="env-note">{t("有未保存的修改")}</span> : null}
			</div>
			<p className="settings-hint">
				{t("新建项目和重建的容器用这个模式；已经在跑的容器保持原样，要到「项目」页点「重建容器」才会切换（上面「项目容器」那一项会写明它们现在用的是哪个）。")}
			</p>
			<div className="env-network-options">
				{NETWORK_OPTIONS.map((option) => (
					<label key={option.value} className={draft === option.value ? "selected" : undefined}>
						<input
							type="radio"
							name="container-network"
							checked={draft === option.value}
							onChange={() => setDraft(option.value)}
							disabled={busy}
						/>
						<span className="env-network-label">{option.label}</span>
						<span className="env-network-detail">{option.detail}</span>
					</label>
				))}
			</div>
			<div className="env-source-actions">
				<span className="composer-spacer" />
				<button type="button" className="primary" onClick={() => onSave(draft)} disabled={busy || !dirty}>
					{t("保存")}
				</button>
			</div>
		</section>
	);
}

const STATUS_LABEL: Record<SentinelEnvItem["status"], string> = {
	ok: t("通过"),
	warn: t("警告"),
	fail: t("失败"),
	skipped: t("跳过"),
};

/** Stable group order, independent of the order the server emitted items in. */
const GROUP_ORDER = ["Docker 运行时", "工具镜像", "容器能力", "宿主环境"];

function grouped(items: SentinelEnvItem[]): { group: string; items: SentinelEnvItem[] }[] {
	const names = [...new Set([...GROUP_ORDER, ...items.map((item) => item.group)])];
	return names
		.map((group) => ({ group, items: items.filter((item) => item.group === group) }))
		.filter((entry) => entry.items.length > 0);
}

function diagnostics(report: SentinelEnvReport): string {
	const lines = [
		t("全链哨兵 环境诊断"),
		t("时间: {time}", { time: new Date(report.at).toLocaleString("zh-CN") }),
		t("地址: {url}", { url: report.url }),
		t("结论: {result}", { result: report.ok ? t("通过") : t("未通过") }),
		"",
	];
	for (const { group, items } of grouped(report.items)) {
		lines.push(`[${t(group)}]`);
		for (const item of items) {
			lines.push(`${STATUS_LABEL[item.status]}${item.blocking ? t("(阻断)") : ""} ${item.label}: ${item.detail}`);
			if (item.hint) lines.push(`  ${t("建议: {hint}", { hint: item.hint })}`);
		}
	}
	return lines.join("\n");
}

export function EnvironmentPanel({
	report,
	building,
	buildLog,
	onRefresh,
	onBuild,
	onAbortBuild,
	onSaveSources,
	sourcesSavedAt,
	onSaveContainerNetwork,
	containerNetworkSavedAt,
}: {
	report: SentinelEnvReport | null;
	building: boolean;
	buildLog: string[];
	onRefresh: () => void;
	onBuild: () => void;
	onAbortBuild: () => void;
	onSaveSources: (sources: SentinelSources) => void;
	sourcesSavedAt: number | null;
	onSaveContainerNetwork: (network: SentinelContainerNetwork) => void;
	containerNetworkSavedAt: number | null;
}) {
	const [confirming, setConfirming] = useState(false);
	const [copyNote, setCopyNote] = useState<string | null>(null);
	const [fallback, setFallback] = useState<string | null>(null);
	const logRef = useRef<HTMLPreElement | null>(null);

	// Keep the newest build output in view; the build streams for minutes.
	useEffect(() => {
		const node = logRef.current;
		if (node) node.scrollTop = node.scrollHeight;
	}, [buildLog]);

	const copyDiagnostics = async () => {
		if (!report) return;
		const text = diagnostics(report);
		try {
			await navigator.clipboard.writeText(text);
			setFallback(null);
			setCopyNote(t("已复制"));
		} catch {
			// Clipboard access needs a secure context; a LAN address over http is not one.
			setFallback(text);
			setCopyNote(t("复制失败，请手动选择下面的文本"));
		}
		window.setTimeout(() => setCopyNote(null), 4000);
	};

	if (!report) {
		return (
			<div className="env">
				<p className="settings-hint">{t("正在检查 Docker 环境…")}</p>
			</div>
		);
	}

	const failures = report.items.filter((entry) => entry.blocking && entry.status !== "ok");
	const warnings = report.items.filter((entry) => entry.status === "warn");

	return (
		<div className="env">
			<div className="env-head">
				<span className={`env-verdict ${report.ok ? "ok" : "fail"}`}>{report.ok ? t("环境可用") : t("环境不可用")}</span>
				<span className="env-meta">
					{t("检查于")} {new Date(report.at).toLocaleString("zh-CN")} · {report.url}
				</span>
				<span className="composer-spacer" />
				{copyNote ? <span className="env-note">{copyNote}</span> : null}
				<button type="button" className="ghost small" onClick={copyDiagnostics} title={t("复制全部检查项，便于排障")}>
					{t("复制诊断")}
				</button>
				<button type="button" className="ghost small" onClick={onRefresh} disabled={building} title={t("重新检查")}>
					<RefreshIcon />
					{t("复检")}
				</button>
				{building ? (
					<button type="button" className="ghost small danger" onClick={onAbortBuild}>
						{t("中止构建")}
					</button>
				) : confirming ? (
					<>
						<button type="button" className="ghost small" onClick={() => setConfirming(false)}>
							{t("取消")}
						</button>
						<button
							type="button"
							className="primary"
							onClick={() => {
								setConfirming(false);
								onBuild();
							}}
						>
							{t("确认构建")}
						</button>
					</>
				) : (
					<button
						type="button"
						className="primary"
						onClick={() => setConfirming(true)}
						title={t("用内置的 Dockerfile 构建 sentinel:latest")}
					>
						{t("构建镜像")}
					</button>
				)}
			</div>

			{report.ok ? (
				<p className="settings-hint">
					{t("Docker 环境正常，工具调用会在项目容器内执行。镜像更新、切换机器或修改 Dockerfile 后回来复检即可。")}
				</p>
			) : (
				<div className="env-blocked">
					<strong>{t("对话已锁定：")}</strong>
					{t("{count} 项阻断检查未通过，Agent 无法执行任何工具。", { count: failures.length })}
					{failures.some((entry) => entry.id === "image-present") ? (
						<span> {t("镜像不存在时点右上角「构建镜像」，首次构建约 5–15 分钟并需要网络。")}</span>
					) : null}
				</div>
			)}

			<SourcesForm
				key={JSON.stringify(report.sources)}
				initial={report.sources}
				savedAt={sourcesSavedAt}
				busy={building}
				onSave={onSaveSources}
			/>

			<NetworkForm
				key={report.containerNetwork}
				initial={report.containerNetwork}
				savedAt={containerNetworkSavedAt}
				busy={building}
				onSave={onSaveContainerNetwork}
			/>

			{building || buildLog.length > 0 ? (
				<section className="env-build">
					<h3>{building ? t("正在构建工具镜像…") : t("上次构建输出")}</h3>
					<pre className="env-build-log" ref={logRef}>
						{buildLog.length > 0 ? buildLog.join("\n") : t("等待 docker build 输出…")}
					</pre>
				</section>
			) : null}

			{grouped(report.items).map(({ group, items }) => (
				<section key={group} className="env-group">
					<h3>{t(group)}</h3>
					{items.map((item) => (
						<div key={item.id} className={`env-row status-${item.status}`}>
							<span className={`env-chip status-${item.status}`}>{STATUS_LABEL[item.status]}</span>
							<span className="env-body">
								<span className="env-label">
									{item.label}
									{item.blocking ? <span className="env-blocking">{t("阻断")}</span> : null}
								</span>
								<span className="env-detail">{item.detail}</span>
								{item.hint ? <span className="env-hint">{item.hint}</span> : null}
							</span>
						</div>
					))}
				</section>
			))}

			{warnings.length > 0 ? (
				<p className="settings-hint">{t("警告项不影响运行，但可能让工具变慢或缺少能力，建议一并处理。")}</p>
			) : null}

			{fallback ? (
				<>
					<p className="settings-hint">{t("诊断信息（手动复制）：")}</p>
					<textarea className="env-diag" readOnly value={fallback} rows={12} />
				</>
			) : null}
		</div>
	);
}
