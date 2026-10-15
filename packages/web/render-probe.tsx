import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageView } from "./webui/src/components/MessageView.tsx";
import { groupRuns } from "./webui/src/transcript.ts";

const g = globalThis as unknown as {
	localStorage?: { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void };
};
g.localStorage = { getItem: () => null, setItem: () => {} };

const messages = JSON.parse(readFileSync("/tmp/messages.json", "utf8")) as never[];
console.log("messages:", messages.length);
for (const [i, message] of messages.entries()) {
	try {
		renderToStaticMarkup(<MessageView message={message} />);
	} catch (error) {
		console.error("CRASH at", i, JSON.stringify(message).slice(0, 300));
		console.error("  ", error instanceof Error ? error.stack?.split("\n").slice(0, 4).join("\n   ") : error);
	}
}
try {
	const groups = groupRuns(messages);
	groups.forEach((group, gi) => {
		try {
			renderToStaticMarkup(
				<div>
					{group.marker ? <MessageView message={group.marker} goalElapsedMs={60000} /> : null}
					{group.body.map((m, i) => (
						<MessageView key={i} message={m} />
					))}
				</div>,
			);
		} catch (error) {
			console.error(`GROUP ${gi} CRASH:`, error instanceof Error ? error.message : error);
		}
	});
	console.log("done");
} catch (error) {
	console.error("GROUPRUNS CRASH:", error instanceof Error ? error.stack : error);
}
