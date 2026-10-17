import { useEffect, useState } from "react";
import type { SentinelPluginApi } from "./sentinel-plugin";

export function App() {
	const [api, setApi] = useState<SentinelPluginApi | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [args, setArgs] = useState("{}");
	const [result, setResult] = useState<string>("等待一次调用…");

	useEffect(() => {
		window.SentinelPlugin.connect()
			.then(setApi)
			.catch((reason: unknown) => {
				setError(reason instanceof Error ? reason.message : String(reason));
			});
	}, []);

	if (error) {
		return (
			<div className="pui-page">
				<div className="pui-card">
					<h2>连接失败</h2>
					<p className="pui-hint">{error}</p>
				</div>
			</div>
		);
	}
	if (!api) {
		return (
			<div className="pui-page">
				<p className="pui-sub">正在连接控制台…</p>
			</div>
		);
	}

	const tool = api.context.tools[0]?.name;

	const call = async (): Promise<void> => {
		if (!tool) {
			setResult("这个插件没有声明工具。");
			return;
		}
		try {
			const parsed = JSON.parse(args) as Record<string, unknown>;
			setResult(JSON.stringify(await api.callTool(tool, parsed), null, 2));
		} catch (reason) {
			setResult(`调用失败：${reason instanceof Error ? reason.message : String(reason)}`);
		}
	};

	return (
		<div className="pui-page">
			<div className="pui-bar">
				<div>
					<h1>{api.context.plugin.name}</h1>
					<p className="pui-sub">
						{api.context.plugin.id} v{api.context.plugin.version} · {api.context.host.name} · 项目{" "}
						{api.context.project ?? "未选择"}
					</p>
				</div>
				<span className="pui-pill ok">已连接</span>
			</div>

			<section className="pui-card">
				<h2>调用 {tool ?? "工具"}</h2>
				<label className="pui-field">
					<span className="pui-label">参数（JSON）</span>
					<textarea
						className="pui-textarea"
						rows={5}
						value={args}
						onChange={(event) => setArgs(event.target.value)}
					/>
				</label>
				<div className="pui-row">
					<button type="button" className="pui-btn primary" onClick={() => void call()}>
						调用
					</button>
				</div>
			</section>

			<section className="pui-card">
				<h2>结果</h2>
				<pre className="pui-output">{result}</pre>
			</section>
		</div>
	);
}
