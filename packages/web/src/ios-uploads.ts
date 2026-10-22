/**
 * Out-of-band upload sessions for large iOS pulls.
 *
 * The WebSocket carries control frames only. Bulk file bytes go over a separate
 * HTTPS POST so iOS URLSession can stream the file from disk instead of queueing
 * the whole payload in the daemon's process (jetsam kills it at the per-process
 * memory limit).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface IosUpload {
	id: string;
	/** Final path on the console host; the tool moves it into the project. */
	path: string;
	/** Partial body while the device is still uploading. */
	partPath: string;
	maxBytes: number;
	createdAt: number;
}

const UPLOAD_TTL_MS = 60 * 60 * 1000;

export class IosUploads {
	private readonly directory: string;
	private readonly uploads = new Map<string, IosUpload>();

	constructor(directory = join(tmpdir(), "sentinel-ios-uploads")) {
		this.directory = directory;
		mkdirSync(directory, { recursive: true, mode: 0o700 });
	}

	create(maxBytes: number): IosUpload {
		this.prune();
		const id = randomUUID();
		const path = join(this.directory, id);
		const upload: IosUpload = {
			id,
			path,
			partPath: `${path}.part`,
			maxBytes,
			createdAt: Date.now(),
		};
		this.uploads.set(id, upload);
		return upload;
	}

	get(id: string): IosUpload | undefined {
		return this.uploads.get(id);
	}

	/** Finish a successful body write. The file is ready for the tool to move. */
	finish(id: string): string | undefined {
		const upload = this.uploads.get(id);
		if (!upload) return undefined;
		try {
			renameSync(upload.partPath, upload.path);
		} catch {
			return undefined;
		}
		return upload.path;
	}

	/** Hand ownership to the tool; the record is removed but the file is kept. */
	take(id: string): string | undefined {
		const upload = this.uploads.get(id);
		if (!upload) return undefined;
		this.uploads.delete(id);
		try {
			return statSync(upload.path).isFile() ? upload.path : undefined;
		} catch {
			return undefined;
		}
	}

	discard(id: string): void {
		const upload = this.uploads.get(id);
		if (!upload) return;
		this.uploads.delete(id);
		try {
			rmSync(upload.partPath, { force: true });
		} catch {
			// best effort
		}
		try {
			rmSync(upload.path, { force: true });
		} catch {
			// best effort
		}
	}

	private prune(): void {
		const cutoff = Date.now() - UPLOAD_TTL_MS;
		for (const upload of [...this.uploads.values()]) {
			if (upload.createdAt >= cutoff) continue;
			this.discard(upload.id);
		}
	}
}
