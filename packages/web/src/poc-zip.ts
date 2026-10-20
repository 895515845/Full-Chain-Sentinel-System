/**
 * Minimal ZIP reader for POC imports.
 *
 * The console runs on hosts that have no `unzip` guarantee and the web package
 * carries no zip dependency (and should not gain one for this), so the two
 * things nuclei template archives actually use — stored and deflate entries —
 * are read directly: the central directory is located through the end-of-
 * central-directory record, each entry's data offset comes from its local file
 * header (whose name/extra lengths can differ from the central directory's),
 * and deflate is decompressed with zlib's raw inflate.
 *
 * Archives over 65535 entries put the real count in a zip64 record and stamp
 * `0xFFFF` into the end-of-central-directory field. That record is read here:
 * without it a whole `nuclei-templates` archive reports 65535 templates and the
 * rest disappear with no error, which is silent data loss, not a limit. A
 * zip64 field the reader genuinely cannot use (a per-entry 64-bit size or
 * offset) is skipped with a reason instead of being read as garbage.
 *
 * Entries are yielded one at a time (`openZip`) so an import can parse and
 * store each template as it arrives instead of holding every template in
 * memory at once.
 */

import { inflateRawSync } from "node:zlib";

/** Largest single entry accepted; a nuclei template is kilobytes. */
export const MAX_ZIP_ENTRY_BYTES = 4 * 1024 * 1024;
/**
 * Largest archive accepted, so a stray upload cannot exhaust memory: the
 * archive is held whole in the process while it is read.
 */
export const MAX_ZIP_TOTAL_BYTES = 512 * 1024 * 1024;
/**
 * Largest total uncompressed payload accepted across one archive. The compressed
 * size cap alone does not bound a high-ratio archive: 18MB can expand into
 * gigabytes across thousands of entries, and every inflated byte blocks the
 * event loop until the entry is stored or skipped.
 */
export const MAX_ZIP_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;

/** One readable entry. */
export interface ZipEntry {
	name: string;
	data: Buffer;
}

/** Why an entry was not read. */
export interface ZipSkip {
	name: string;
	reason: string;
}

/** A zip being read: pull `entries` to inflate one template at a time. */
export interface ZipStream {
	entries: Generator<ZipEntry>;
	/** Filled while `entries` is drained. */
	skipped: ZipSkip[];
}

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** The 64-bit sentinel a zip64 field leaves in its 32-bit slot. */
const ZIP64_SENTINEL = 0xffffffff;

function findEocd(buffer: Buffer): number {
	// The comment is capped at 65535 bytes, so scanning the last 64KB + 22
	// bytes of the file is always enough to find the EOCD record.
	const searchStart = Math.max(0, buffer.length - (65535 + 22));
	for (let offset = buffer.length - 22; offset >= searchStart; offset--) {
		if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
	}
	return -1;
}

interface CentralDirectory {
	entryCount: number;
	offset: number;
	size: number;
}

/**
 * Where the central directory starts and how many entries it holds, following
 * the zip64 record when the 32-bit fields are sentinels. Throws when the file
 * says zip64 but carries no usable zip64 directory: reading on would report
 * 65535 entries as if that were the whole archive.
 */
function centralDirectory(buffer: Buffer, eocd: number): CentralDirectory {
	const entryCount16 = buffer.readUInt16LE(eocd + 10);
	const size32 = buffer.readUInt32LE(eocd + 12);
	const offset32 = buffer.readUInt32LE(eocd + 16);
	if (entryCount16 !== 0xffff && size32 !== ZIP64_SENTINEL && offset32 !== ZIP64_SENTINEL) {
		return { entryCount: entryCount16, offset: offset32, size: size32 };
	}
	const locator = eocd - 20;
	if (locator < 0 || buffer.readUInt32LE(locator) !== ZIP64_LOCATOR_SIGNATURE) {
		throw new Error("zip 使用了 zip64，但缺少 zip64 目录定位记录，无法确定条目总数");
	}
	const record = Number(buffer.readBigUInt64LE(locator + 8));
	if (record + 56 > buffer.length || buffer.readUInt32LE(record) !== ZIP64_EOCD_SIGNATURE) {
		throw new Error("zip 的 zip64 目录记录损坏");
	}
	const entryCount = Number(buffer.readBigUInt64LE(record + 32));
	const size = Number(buffer.readBigUInt64LE(record + 40));
	const offset = Number(buffer.readBigUInt64LE(record + 48));
	if (!Number.isSafeInteger(entryCount) || entryCount < 0 || !Number.isSafeInteger(offset) || offset < 0) {
		throw new Error("zip 的 zip64 目录字段超出可读范围");
	}
	return { entryCount, offset, size };
}

/** Walk the central directory, inflating each entry only when it is pulled. */
function* walkCentralDirectory(buffer: Buffer, directory: CentralDirectory, skipped: ZipSkip[]): Generator<ZipEntry> {
	let offset = directory.offset;
	let totalUncompressed = 0;
	for (let index = 0; index < directory.entryCount; index++) {
		if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
			skipped.push({ name: `#${index}`, reason: "zip 目录损坏" });
			return;
		}
		const flags = buffer.readUInt16LE(offset + 8);
		const method = buffer.readUInt16LE(offset + 10);
		const compressedSize = buffer.readUInt32LE(offset + 20);
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const localOffset = buffer.readUInt32LE(offset + 42);
		const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
		offset += 46 + nameLength + extraLength + commentLength;

		if (name.endsWith("/")) continue; // directory entry
		if (compressedSize === ZIP64_SENTINEL || localOffset === ZIP64_SENTINEL) {
			skipped.push({ name, reason: "条目的 64 位长度或偏移未支持" });
			continue;
		}
		if ((flags & 0x1) !== 0) {
			skipped.push({ name, reason: "加密的条目" });
			continue;
		}
		if (compressedSize > MAX_ZIP_ENTRY_BYTES) {
			skipped.push({ name, reason: "文件过大" });
			continue;
		}
		// The local header's own name/extra lengths decide where the data
		// starts; the central directory's copies are not always equal.
		if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
			skipped.push({ name, reason: "本地头损坏" });
			continue;
		}
		const localNameLength = buffer.readUInt16LE(localOffset + 26);
		const localExtraLength = buffer.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		const raw = buffer.subarray(dataStart, dataStart + compressedSize);
		if (raw.length < compressedSize) {
			skipped.push({ name, reason: "数据不完整" });
			continue;
		}
		try {
			// `maxOutputLength` bounds a deflate bomb: a few KB of compressed
			// data must not inflate to gigabytes before the size check sees it.
			const data =
				method === 0
					? Buffer.from(raw)
					: method === 8
						? inflateRawSync(raw, { maxOutputLength: MAX_ZIP_ENTRY_BYTES })
						: null;
			if (!data) {
				skipped.push({ name, reason: `不支持的压缩方式 ${method}` });
				continue;
			}
			totalUncompressed += data.length;
			if (totalUncompressed > MAX_ZIP_UNCOMPRESSED_BYTES) {
				skipped.push({ name, reason: "解压后总大小超过上限" });
				return;
			}
			yield { name, data };
		} catch {
			skipped.push({ name, reason: "解压失败或解压后过大" });
		}
	}
}

/** Open an archive for entry-at-a-time reading. Throws if it is not readable. */
export function openZip(buffer: Buffer): ZipStream {
	if (buffer.length < 22) throw new Error("不是有效的 zip 文件（太小）");
	if (buffer.length > MAX_ZIP_TOTAL_BYTES) {
		throw new Error(`zip 文件过大（上限 ${Math.round(MAX_ZIP_TOTAL_BYTES / 1024 / 1024)}MB）`);
	}
	const eocd = findEocd(buffer);
	if (eocd < 0) throw new Error("找不到 zip 目录（可能不是 zip 文件）");
	const directory = centralDirectory(buffer, eocd);
	if (directory.offset + directory.size > buffer.length) throw new Error("zip 目录越界");
	const skipped: ZipSkip[] = [];
	return { entries: walkCentralDirectory(buffer, directory, skipped), skipped };
}

/** Read an archive into memory; `openZip` is the streaming form. */
export function readZip(buffer: Buffer): { entries: ZipEntry[]; skipped: ZipSkip[] } {
	const stream = openZip(buffer);
	const entries = [...stream.entries];
	return { entries, skipped: stream.skipped };
}
