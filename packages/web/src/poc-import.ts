/**
 * Streamed POC uploads and their import jobs.
 *
 * The browser sends one file as the raw HTTP body, so an 18MB archive is copied
 * to disk instead of becoming a base64 JSON frame on the WebSocket. The actual
 * unzip/parse/SQLite work then runs as a queued job; the page polls the job while
 * the store yields between entry chunks.
 *
 * One job runs at a time because the library is a single SQLite writer. The
 * queue is deliberately short: a console is a single-operator tool, and extra
 * jobs only make progress reporting confusing.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { open, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { t } from "./i18n.ts";
import type { PocImportProgress } from "./pocs.ts";
import type { SentinelPocImportOutcome } from "./protocol.ts";
import { safeFileName } from "./upload.ts";

/** Largest raw upload accepted; the zip reader has its own compressed-size cap. */
export const POC_IMPORT_MAX_BYTES = 512 * 1024 * 1024;
/** Keep the endpoint from hoarding requests while an import runs. */
const MAX_QUEUED = 8;
/** A finished job stays pollable long enough for a slow browser to read it. */
const JOB_TTL_MS = 10 * 60 * 1000;

export type PocImportJobStatus = "queued" | "running" | "done" | "error";

export interface PocImportJobView {
	id: string;
	name: string;
	status: PocImportJobStatus;
	progress: PocImportProgress;
	outcome?: SentinelPocImportOutcome;
	error?: string;
}

export type PocImportAcceptResult = { ok: true; id: string } | { ok: false; status: number; error: string };

export type PocImportRunner = (
	file: { name: string; bytes: Buffer },
	onProgress: (progress: PocImportProgress) => void,
	signal: AbortSignal,
) => Promise<SentinelPocImportOutcome>;

interface Job extends PocImportJobView {
	filePath: string;
	controller: AbortController;
	createdAt: number;
	finishedAt?: number;
}

const EMPTY_PROGRESS: PocImportProgress = {
	processed: 0,
	imported: 0,
	replaced: 0,
	skipped: 0,
	current: "",
};

function toView(job: Job): PocImportJobView {
	return {
		id: job.id,
		name: job.name,
		status: job.status,
		progress: { ...job.progress },
		...(job.outcome ? { outcome: job.outcome } : {}),
		...(job.error ? { error: job.error } : {}),
	};
}

export class PocImportManager {
	private readonly dir = mkdtempSync(join(tmpdir(), "sentinel-poc-import-"));
	private readonly jobs = new Map<string, Job>();
	private readonly queue: Job[] = [];
	private readonly run: PocImportRunner;
	private readonly maxBytes: number;
	private running: Job | undefined;
	private closed = false;

	constructor(run: PocImportRunner, maxBytes = POC_IMPORT_MAX_BYTES) {
		this.run = run;
		this.maxBytes = maxBytes;
	}

	/** Stream one request body to a private temp file, then enqueue its import. */
	async accept(name: string, body: AsyncIterable<Buffer | Uint8Array>): Promise<PocImportAcceptResult> {
		if (this.closed) return { ok: false, status: 503, error: t("服务正在停止") };
		if (this.queue.length + (this.running ? 1 : 0) >= MAX_QUEUED) {
			return { ok: false, status: 429, error: t("已有太多导入任务，请稍后再试") };
		}
		const id = randomUUID();
		const filePath = join(this.dir, `${id}.upload`);
		let handle: Awaited<ReturnType<typeof open>>;
		try {
			handle = await open(filePath, "wx", 0o600);
		} catch {
			return { ok: false, status: 500, error: t("无法创建导入临时文件") };
		}
		let size = 0;
		try {
			for await (const chunk of body) {
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				size += buffer.byteLength;
				if (size > this.maxBytes) {
					await handle.close();
					await unlink(filePath).catch(() => {});
					return {
						ok: false,
						status: 413,
						error: t("文件超过 {max}MB 上限", { max: Math.round(this.maxBytes / 1024 / 1024) }),
					};
				}
				let written = 0;
				while (written < buffer.byteLength) {
					const { bytesWritten } = await handle.write(buffer, written, buffer.byteLength - written);
					written += bytesWritten;
				}
			}
			await handle.close();
		} catch {
			await handle.close().catch(() => {});
			await unlink(filePath).catch(() => {});
			return { ok: false, status: 400, error: t("上传中断，未完成的文件已清理") };
		}
		if (this.closed) {
			await unlink(filePath).catch(() => {});
			return { ok: false, status: 503, error: t("服务正在停止") };
		}
		const job: Job = {
			id,
			name: safeFileName(name || "poc.zip"),
			status: "queued",
			progress: { ...EMPTY_PROGRESS },
			filePath,
			controller: new AbortController(),
			createdAt: Date.now(),
		};
		this.jobs.set(id, job);
		this.queue.push(job);
		void this.pump();
		return { ok: true, id };
	}

	/** The latest state of one job, or null when it never existed or has expired. */
	get(id: string): PocImportJobView | null {
		const job = this.jobs.get(id);
		if (!job) return null;
		if (
			(job.status === "done" || job.status === "error") &&
			Date.now() - (job.finishedAt ?? job.createdAt) > JOB_TTL_MS
		) {
			this.jobs.delete(id);
			return null;
		}
		return toView(job);
	}

	/**
	 * Stop the current job and remove its temp files. The server calls this before
	 * closing the runtime; an in-flight store call notices the signal at its next
	 * entry boundary and rolls back the open chunk.
	 */
	close(): void {
		this.closed = true;
		for (const job of this.queue.splice(0)) {
			job.status = "error";
			job.error = t("服务正在停止");
		}
		this.running?.controller.abort();
		try {
			rmSync(this.dir, { recursive: true, force: true });
		} catch {
			// A temp file may still be open on Windows; the OS cleans it up.
		}
	}

	private async pump(): Promise<void> {
		if (this.running || this.closed) return;
		const job = this.queue.shift();
		if (!job) return;
		this.running = job;
		job.status = "running";
		try {
			const bytes = await readFile(job.filePath);
			const outcome = await this.run(
				{ name: job.name, bytes },
				(progress) => {
					job.progress = { ...progress };
				},
				job.controller.signal,
			);
			job.outcome = outcome;
			job.status = "done";
			job.finishedAt = Date.now();
		} catch (error) {
			job.status = "error";
			job.finishedAt = Date.now();
			job.error = job.controller.signal.aborted
				? t("导入已取消")
				: error instanceof Error
					? error.message
					: String(error);
		} finally {
			await unlink(job.filePath).catch(() => {});
			this.running = undefined;
			void this.pump();
		}
	}
}
