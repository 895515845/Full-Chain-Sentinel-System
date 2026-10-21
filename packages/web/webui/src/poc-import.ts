/** HTTP upload and job polling for the POC library. */

import { t } from "./i18n.ts";
import type { SentinelPocImportJobView, SentinelPocImportOutcome, SentinelPocImportProgress } from "./types.ts";

/** Must match `POC_IMPORT_MAX_BYTES` on the server. */
export const POC_UPLOAD_MAX_BYTES = 512 * 1024 * 1024;
const POLL_INTERVAL_MS = 400;
const IMPORT_TIMEOUT_MS = 30 * 60 * 1000;

async function responseError(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { error?: unknown };
		if (typeof body.error === "string") return body.error;
	} catch {
		// Fall through to the status line.
	}
	return `HTTP ${response.status}`;
}

/** Stream one file as the raw request body and return its import job id. */
export async function uploadPocFile(file: File, signal?: AbortSignal): Promise<string> {
	const response = await fetch(`/api/pocs/import?name=${encodeURIComponent(file.name)}`, {
		method: "POST",
		headers: { "content-type": "application/octet-stream" },
		body: file,
		signal,
	});
	if (!response.ok) throw new Error(await responseError(response));
	const body = (await response.json()) as { id?: unknown };
	if (typeof body.id !== "string" || body.id === "") throw new Error(t("服务端没有返回导入任务 id"));
	return body.id;
}

/** Poll one job until it settles; progress is reported while it runs. */
export async function waitForPocImport(
	id: string,
	onProgress?: (progress: SentinelPocImportProgress) => void,
	signal?: AbortSignal,
): Promise<SentinelPocImportOutcome> {
	const deadline = Date.now() + IMPORT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error(t("导入已取消"));
		const response = await fetch(`/api/pocs/import/${encodeURIComponent(id)}`, {
			headers: { accept: "application/json" },
			cache: "no-store",
			signal,
		});
		if (!response.ok) throw new Error(await responseError(response));
		const job = (await response.json()) as SentinelPocImportJobView;
		onProgress?.(job.progress);
		if (job.status === "done") {
			if (!job.outcome) throw new Error(t("导入完成但没有返回结果"));
			return job.outcome;
		}
		if (job.status === "error") throw new Error(job.error ?? t("导入失败"));
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
	throw new Error(t("导入超时，请检查服务端是否仍在处理"));
}

/** Combine one file's outcome per request into the page's single summary. */
export function mergePocImportOutcomes(outcomes: SentinelPocImportOutcome[]): SentinelPocImportOutcome {
	return {
		imported: outcomes.reduce((total, outcome) => total + outcome.imported, 0),
		replaced: outcomes.reduce((total, outcome) => total + outcome.replaced, 0),
		skipped: outcomes.flatMap((outcome) => outcome.skipped),
	};
}
