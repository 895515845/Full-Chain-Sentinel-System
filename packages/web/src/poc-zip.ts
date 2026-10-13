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
 * Everything else (encrypted, zip64, other compressions) is reported as
 * skipped rather than crashing the import.
 */

import { inflateRawSync } from "node:zlib";

/** Largest single entry accepted; a nuclei template is kilobytes. */
export const MAX_ZIP_ENTRY_BYTES = 4 * 1024 * 1024;
/** Largest archive accepted, so a stray upload cannot exhaust memory. */
export const MAX_ZIP_TOTAL_BYTES = 256 * 1024 * 1024;

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

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function findEocd(buffer: Buffer): number {
	// The comment is capped at 65535 bytes, so scanning the last 64KB + 22
	// bytes of the file is always enough to find the EOCD record.
	const searchStart = Math.max(0, buffer.length - (65535 + 22));
	for (let offset = buffer.length - 22; offset >= searchStart; offset--) {
		if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
	}
	return -1;
}

/** Read a zip archive into entries; unreadable entries land in `skipped`. */
export function readZip(buffer: Buffer): { entries: ZipEntry[]; skipped: ZipSkip[] } {
	if (buffer.length < 22) throw new Error("不是有效的 zip 文件（太小）");
	if (buffer.length > MAX_ZIP_TOTAL_BYTES) throw new Error("zip 文件过大");
	const eocd = findEocd(buffer);
	if (eocd < 0) throw new Error("找不到 zip 目录（可能不是 zip 文件）");
	const entryCount = buffer.readUInt16LE(eocd + 10);
	const directoryOffset = buffer.readUInt32LE(eocd + 16);

	const entries: ZipEntry[] = [];
	const skipped: ZipSkip[] = [];
	let offset = directoryOffset;
	for (let index = 0; index < entryCount; index++) {
		if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
			skipped.push({ name: `#${index}`, reason: "zip 目录损坏" });
			break;
		}
		const method = buffer.readUInt16LE(offset + 10);
		const compressedSize = buffer.readUInt32LE(offset + 20);
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const localOffset = buffer.readUInt32LE(offset + 42);
		const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
		offset += 46 + nameLength + extraLength + commentLength;

		if (name.endsWith("/")) continue; // directory entry
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
			const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : null;
			if (!data) {
				skipped.push({ name, reason: `不支持的压缩方式 ${method}` });
				continue;
			}
			entries.push({ name, data });
		} catch {
			skipped.push({ name, reason: "解压失败" });
		}
	}
	return { entries, skipped };
}
