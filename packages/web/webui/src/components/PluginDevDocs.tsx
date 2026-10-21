import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { t } from "../i18n.ts";
import { PLUGIN_DEV_GUIDE } from "../plugin-dev-guide.ts";

/**
 * The AI-ready developer guide, as the second tab of the plugin page.
 *
 * The text is written for a coding AI: one copy gives it the whole contract and
 * a skeleton. The Markdown rendering below is only for the operator reading it;
 * the clipboard always receives the raw text.
 */
export function PluginDevDocs() {
	const [copied, setCopied] = useState(false);

	const copy = (): void => {
		const markCopied = (): void => {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 2000);
		};
		const fallback = (): void => {
			const area = document.createElement("textarea");
			area.value = PLUGIN_DEV_GUIDE;
			document.body.appendChild(area);
			area.select();
			document.execCommand("copy");
			area.remove();
			markCopied();
		};
		if (!navigator.clipboard?.writeText) {
			fallback();
			return;
		}
		void navigator.clipboard.writeText(PLUGIN_DEV_GUIDE).then(markCopied).catch(fallback);
	};

	return (
		<div className="plugin-dev-docs">
			<div className="plugin-dev-bar">
				<span className="hint">
					{t("整段复制给 AI，它会拿到契约、约束、可运行骨架和验收清单；写完后回到「已安装」上传 zip 安装。")}
				</span>
				<button type="button" className="primary" onClick={copy}>
					{copied ? t("已复制") : t("复制全文")}
				</button>
			</div>
			<div className="plugin-dev-md">
				<Markdown
					remarkPlugins={[remarkGfm]}
					components={{ a: (props) => <a {...props} target="_blank" rel="noreferrer" /> }}
				>
					{PLUGIN_DEV_GUIDE}
				</Markdown>
			</div>
		</div>
	);
}
