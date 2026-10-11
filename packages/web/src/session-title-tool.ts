/**
 * set_session_title: lets the agent give the conversation a searchable,
 * descriptive title. The sidebar shows first-message snippets until a name
 * exists, which makes a working set of parallel tasks hard to tell apart; the
 * agent knows what the conversation is about, so it names it — early, and again
 * when the scope changes (the prompt guidelines say so).
 *
 * The operator's manual rename stays exactly as it is; both write the same
 * session entry, last writer wins.
 */

import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Sidebar names get ellipsized anyway; longer than this is noise. */
const MAX_TITLE_LENGTH = 80;

const titleSchema = Type.Object({
	title: Type.String({
		minLength: 1,
		maxLength: MAX_TITLE_LENGTH,
		description: "The new session title: short, specific, searchable — e.g. 「10.0.0.5 SQL 注入验证」.",
	}),
});

interface TitleDetails {
	ok: boolean;
	title?: string;
	error?: string;
}

export function createSessionTitleTool(options: {
	/** Applies the new name to the session. */
	rename(title: string): void;
}): ToolDefinition {
	return defineTool({
		name: "set_session_title",
		label: "Rename session",
		description:
			"Set this conversation's title. The operator's session list shows snippets until a title exists, so name the work once the task is clear, and again if the scope changes. The operator can rename too; last write wins.",
		promptSnippet: "Name the current session after the task it is working on",
		promptGuidelines: [
			"Call set_session_title early, as soon as the task of this conversation is clear, with a specific searchable title (target + work, e.g. 「10.0.0.5 SQL 注入验证」)",
			"Update the title with set_session_title when the scope changes materially; do not retitle for every step",
		],
		parameters: titleSchema,
		async execute(_toolCallId, params): Promise<AgentToolResult<TitleDetails>> {
			const title = params.title.trim();
			if (!title) {
				return {
					content: [{ type: "text", text: "标题不能为空。" }],
					details: { ok: false, error: "empty" },
					isError: true,
				};
			}
			options.rename(title);
			return {
				content: [{ type: "text", text: `会话标题已更新：${title}` }],
				details: { ok: true, title },
			};
		},
	});
}
