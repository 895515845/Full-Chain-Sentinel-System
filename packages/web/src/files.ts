/**
 * Container file access for the console's file panel.
 *
 * The panel works on the same directory the container mounts at /work, so the
 * listing is done with node:fs on the host side of that mount: sizes and mtimes
 * come from stat(2) instead of from a container command whose output this code
 * would have to parse. Content operations (preview, write, upload, download,
 * delete, rename) still run through `docker exec`, because the container runs as
 * root and a file it created as root stays reachable that way on hosts where the
 * bind mount is not user-mapped.
 *
 * Paths are normalized textually against /work and passed to the container as
 * positional parameters, never interpolated into a script.
 */

import { lstatSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { execInContainer } from "./docker.ts";
import type { ZGFileEntry, ZGFilePreview } from "./protocol.ts";

/** Mount point of the project work directory inside the container. */
export const WORK_ROOT = "/work";

/** Bytes returned for an inline preview (text or image). */
const PREVIEW_MAX_BYTES = 256 * 1024;

/** Largest single upload or download. */
const TRANSFER_MAX_BYTES = 32 * 1024 * 1024;

const IMAGE_MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".svg": "image/svg+xml",
};

/** Text-ish types get a readable type on download instead of a generic blob. */
const TEXT_MIME_TYPES: Record<string, string> = {
	".txt": "text/plain; charset=utf-8",
	".log": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".csv": "text/csv; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".xml": "application/xml; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".sh": "text/x-shellscript; charset=utf-8",
	".py": "text/x-python; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".ts": "text/plain; charset=utf-8",
	".yaml": "text/plain; charset=utf-8",
	".yml": "text/plain; charset=utf-8",
	".conf": "text/plain; charset=utf-8",
};

/** Best-effort content type for a download, by extension. */
export function guessMimeType(path: string): string {
	const extension = posix.extname(path).toLowerCase();
	return IMAGE_MIME_TYPES[extension] ?? TEXT_MIME_TYPES[extension] ?? "application/octet-stream";
}

/**
 * Resolve an operator-supplied path to an absolute path inside /work.
 * `..` segments are collapsed before the check, so traversal outside the work
 * directory is rejected. Symlinks are not followed here; the operator already
 * holds container root through the approval-gated bash tool.
 */
export function resolveWorkPath(input: string): string {
	const trimmed = (input ?? "").trim();
	if (trimmed.includes("\0")) throw new Error("路径包含非法字符");
	const absolute = trimmed === "" ? WORK_ROOT : trimmed.startsWith("/") ? trimmed : posix.join(WORK_ROOT, trimmed);
	const normalized = posix.normalize(absolute);
	if (normalized !== WORK_ROOT && !normalized.startsWith(`${WORK_ROOT}/`)) {
		throw new Error("路径越界：只能访问容器 /work 目录内的文件");
	}
	return normalized;
}

/** Map a container exit code to a readable failure. */
function fail(action: string, code: number, stderr: string): never {
	const detail = stderr.trim();
	if (code === 2) throw new Error(`${action}失败：文件不存在或不可读`);
	if (code === 3) throw new Error(`${action}失败：文件超过 ${TRANSFER_MAX_BYTES / 1024 / 1024}MB 上限`);
	if (code === 4) throw new Error(`${action}失败：不允许操作 /work 根目录`);
	if (code === 5) throw new Error(`${action}失败：目标已存在`);
	throw new Error(`${action}失败${detail ? `：${detail}` : `（退出码 ${code}）`}`);
}

/**
 * List one directory level.
 *
 * The host side of the /work mount is listed with node:fs: reading a directory,
 * and stat(2) on its entries, needs no permission the host user lacks, and the
 * metadata then comes from the kernel instead of from a shell command whose
 * output would have to be parsed back apart.
 *
 * `container` is the fallback for a directory the host user cannot read: the
 * container runs as root, so a root-owned 0700 directory is still reachable
 * there. That path keeps the shell listing below, which is why a directory's
 * size is never asked of `wc`: on Linux `wc -c < dir` prints a 0 *and* exits
 * non-zero, so `$(...) || echo 0` would emit two lines and split the record.
 */
export async function listFiles(
	workDir: string,
	path: string,
	options: { container?: string | null; signal?: AbortSignal } = {},
): Promise<{ path: string; entries: ZGFileEntry[] }> {
	const target = resolveWorkPath(path);
	try {
		return { path: target, entries: readHostDirectory(hostPathOf(workDir, target), target) };
	} catch (error) {
		if (!isPermissionError(error)) throw describeListError(error);
		if (!options.container) throw describeListError(error);
		return await listFilesInContainer(options.container, target, options.signal);
	}
}

/** Host path of a container path below /work; the container mounts both names. */
function hostPathOf(workDir: string, target: string): string {
	return target === WORK_ROOT ? workDir : join(workDir, target.slice(WORK_ROOT.length + 1));
}

function isPermissionError(error: unknown): boolean {
	const code = (error as { code?: string }).code;
	return code === "EACCES" || code === "EPERM";
}

function describeListError(error: unknown): Error {
	const code = (error as { code?: string }).code;
	if (code === "ENOENT" || code === "ENOTDIR") return new Error("目录不存在或不可读");
	if (isPermissionError(error)) return new Error("读取目录失败：权限不足");
	return error instanceof Error ? error : new Error(String(error));
}

function readHostDirectory(hostDir: string, target: string): ZGFileEntry[] {
	const entries = readdirSync(hostDir, { withFileTypes: true }).map((dirent) =>
		describeEntry(hostDir, target, dirent.name),
	);
	entries.sort(byTypeThenName);
	return entries;
}

/**
 * One entry's metadata. stat(2) follows symlinks, which is what the container's
 * `[ -d ]` test did; a dangling symlink is still part of the listing.
 */
function describeEntry(hostDir: string, target: string, name: string): ZGFileEntry {
	const full = join(hostDir, name);
	let type: ZGFileEntry["type"] = "file";
	let size = 0;
	let mtime = 0;
	try {
		const info = statSync(full);
		type = info.isDirectory() ? "dir" : "file";
		size = info.isDirectory() ? 0 : info.size;
		mtime = Math.floor(info.mtimeMs / 1000);
	} catch {
		try {
			const info = lstatSync(full);
			size = info.size;
			mtime = Math.floor(info.mtimeMs / 1000);
		} catch {
			// It disappeared between readdir and stat; list it with zeroes.
		}
	}
	return { name, path: posix.join(target, name), type, size, mtime };
}

function byTypeThenName(a: ZGFileEntry, b: ZGFileEntry): number {
	return a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1;
}

/**
 * Fallback listing inside the container. The loop is POSIX sh with `date -r`
 * instead of GNU `find -printf`, so the same script works in the Kali container
 * and under the test's host-side fake docker. Names containing a tab or newline
 * are the known limitation of this encoding.
 */
const LIST_SCRIPT = [
	'cd "$1" 2>/dev/null || exit 2',
	"for entry in * .[!.]* ..?*; do",
	'  [ -e "$entry" ] || [ -L "$entry" ] || continue',
	'  if [ -d "$entry" ]; then kind=d; size=0; else kind=f; size=$(wc -c < "$entry" 2>/dev/null | tr -d " \\t\\n"); fi',
	'  [ -n "$size" ] || size=0',
	'  mtime=$(date -r "$entry" +%s 2>/dev/null || echo 0)',
	'  printf \'%s\\t%s\\t%s\\t%s\\n\' "$kind" "$size" "$mtime" "$entry"',
	"done",
].join("\n");

/** Directory listing through the container, for entries the host user cannot read. */
export async function listFilesInContainer(
	container: string,
	path: string,
	signal?: AbortSignal,
): Promise<{ path: string; entries: ZGFileEntry[] }> {
	const target = resolveWorkPath(path);
	const result = await execInContainer(container, LIST_SCRIPT, [target], { signal, timeoutMs: 30000 });
	if (result.code !== 0) {
		if (result.code === 2) throw new Error("目录不存在或不可读");
		fail("读取目录", result.code, result.stderr);
	}
	const entries: ZGFileEntry[] = [];
	for (const line of result.stdout.split("\n")) {
		if (!line) continue;
		const [kind, size, mtime, ...rest] = line.split("\t");
		const name = rest.join("\t");
		if (!name) continue;
		entries.push({
			name,
			path: posix.join(target, name),
			type: kind === "d" ? "dir" : "file",
			size: Number.parseInt(size ?? "0", 10) || 0,
			mtime: Number.parseInt(mtime ?? "0", 10) || 0,
		});
	}
	entries.sort(byTypeThenName);
	return { path: target, entries };
}

// The byte count goes to stderr so stdout stays the file's own bytes.
const PREVIEW_SCRIPT = ['size=$(wc -c < "$1" 2>/dev/null) || exit 2', 'echo "$size" >&2', 'head -c "$2" "$1"'].join(
	"\n",
);

/** Read a bounded preview: text inline, images as base64, anything else flagged binary. */
export async function readFilePreview(container: string, path: string, signal?: AbortSignal): Promise<ZGFilePreview> {
	const target = resolveWorkPath(path);
	const result = await execInContainer(container, PREVIEW_SCRIPT, [target, String(PREVIEW_MAX_BYTES + 1)], {
		signal,
		timeoutMs: 30000,
	});
	if (result.code !== 0) fail("读取文件", result.code, result.stderr);
	const size = Number.parseInt(result.stderr.trim(), 10) || 0;
	const truncated = size > PREVIEW_MAX_BYTES;
	const bytes = truncated ? result.stdoutBytes.subarray(0, PREVIEW_MAX_BYTES) : result.stdoutBytes;
	const mimeType = IMAGE_MIME_TYPES[posix.extname(target).toLowerCase()];
	if (isBinary(bytes)) {
		if (mimeType) {
			return { path: target, kind: "image", size, truncated, data: bytes.toString("base64"), mimeType };
		}
		return { path: target, kind: "binary", size, truncated };
	}
	return { path: target, kind: "text", size, truncated, text: bytes.toString("utf-8") };
}

/** NUL byte in the first chunk is the usual binary signal, as `git diff` uses. */
function isBinary(bytes: Buffer): boolean {
	return bytes.subarray(0, 8000).includes(0);
}

const DOWNLOAD_SCRIPT = [
	'size=$(wc -c < "$1" 2>/dev/null) || exit 2',
	'[ "$size" -le "$2" ] || exit 3',
	'cat "$1"',
].join("\n");

export async function downloadFile(
	container: string,
	path: string,
	signal?: AbortSignal,
): Promise<{ path: string; size: number; data: string }> {
	const target = resolveWorkPath(path);
	const result = await execInContainer(container, DOWNLOAD_SCRIPT, [target, String(TRANSFER_MAX_BYTES)], {
		signal,
		timeoutMs: 120000,
	});
	if (result.code !== 0) fail("下载", result.code, result.stderr);
	return { path: target, size: result.stdoutBytes.length, data: result.stdoutBytes.toString("base64") };
}

const WRITE_SCRIPT = ['mkdir -p "$(dirname "$1")" || exit 2', 'cat > "$1" || exit 2'].join("\n");

/** Create or overwrite a file; missing parent directories are created. */
export async function writeFile(
	container: string,
	path: string,
	content: Buffer,
	signal?: AbortSignal,
): Promise<{ path: string; size: number }> {
	const target = resolveWorkPath(path);
	if (content.length > TRANSFER_MAX_BYTES) {
		throw new Error(`上传失败：文件超过 ${TRANSFER_MAX_BYTES / 1024 / 1024}MB 上限`);
	}
	const result = await execInContainer(container, WRITE_SCRIPT, [target], {
		stdin: content,
		signal,
		timeoutMs: 120000,
	});
	if (result.code !== 0) fail("写入", result.code, result.stderr);
	return { path: target, size: content.length };
}

const DELETE_SCRIPT = ['[ "$1" != "/work" ] || exit 4', 'rm -r -- "$1" || exit 2'].join("\n");

export async function deletePath(container: string, path: string, signal?: AbortSignal): Promise<void> {
	const target = resolveWorkPath(path);
	if (target === WORK_ROOT) throw new Error("删除失败：不允许操作 /work 根目录");
	const result = await execInContainer(container, DELETE_SCRIPT, [target], { signal, timeoutMs: 60000 });
	if (result.code !== 0) fail("删除", result.code, result.stderr);
}

const RENAME_SCRIPT = [
	'[ "$1" != "/work" ] || exit 4',
	'[ -e "$1" ] || exit 2',
	'[ -e "$2" ] && exit 5',
	'mkdir -p "$(dirname "$2")" || exit 2',
	'mv -- "$1" "$2" || exit 2',
].join("\n");

export async function renamePath(
	container: string,
	from: string,
	to: string,
	signal?: AbortSignal,
): Promise<{ from: string; to: string }> {
	const source = resolveWorkPath(from);
	const target = resolveWorkPath(to);
	if (source === WORK_ROOT || target === WORK_ROOT) throw new Error("重命名失败：不允许操作 /work 根目录");
	const result = await execInContainer(container, RENAME_SCRIPT, [source, target], { signal, timeoutMs: 60000 });
	if (result.code !== 0) fail("重命名", result.code, result.stderr);
	return { from: source, to: target };
}

const MKDIR_SCRIPT = ['mkdir -p "$1" || exit 2'].join("\n");

export async function makeDirectory(container: string, path: string, signal?: AbortSignal): Promise<{ path: string }> {
	const target = resolveWorkPath(path);
	if (target === WORK_ROOT) throw new Error("新建目录失败：目录已存在");
	const result = await execInContainer(container, MKDIR_SCRIPT, [target], { signal, timeoutMs: 30000 });
	if (result.code !== 0) fail("新建目录", result.code, result.stderr);
	return { path: target };
}
