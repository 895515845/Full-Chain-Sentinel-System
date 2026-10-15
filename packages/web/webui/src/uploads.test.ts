/**
 * Chat attachment helpers: the block of paths the model reads, and the guard
 * that keeps a path from pointing into a project that is no longer active.
 *
 * Pure functions only. The transfer itself needs a browser, so what is pinned
 * here is the text the message carries and the decision to refuse it.
 */

import { expect, test } from "vitest";
import { formatSize } from "./transcript.ts";
import { attachmentManifest, MAX_UPLOAD_BYTES, planAttachments, staleUploads, type UploadedFile } from "./uploads.ts";

function file(name: string, path: string, size: number, projectId = "p1"): UploadedFile {
	return { name, path, size, projectId };
}

test("the manifest hands the model paths it can read", () => {
	expect(attachmentManifest([])).toBe("");
	// One line per file, in the order they were attached, each with its size so
	// the model can decide how to open it.
	const block = attachmentManifest([
		file("a.txt", "/work/uploads/a.txt", 10),
		file("b.bin", "/work/uploads/b.bin", 2 * 1024 * 1024),
	]);
	expect(block.split("\n")).toEqual([
		"已上传文件（可用 read/bash 直接读）：",
		"- /work/uploads/a.txt（10 B）",
		"- /work/uploads/b.bin（2.0 MB）",
	]);
});

test("sizes read the way the file panel writes them", () => {
	expect(formatSize(0)).toBe("0 B");
	expect(formatSize(1023)).toBe("1023 B");
	expect(formatSize(1024)).toBe("1.0 KB");
	expect(formatSize(64 * 1024 * 1024)).toBe("64.0 MB");
});

test("attachments of a project that is no longer active are flagged", () => {
	const files = [file("a", "/p1/uploads/a", 1, "p1"), file("b", "/p2/uploads/b", 1, "p2")];
	expect(staleUploads(files, "p1").map((entry) => entry.name)).toEqual(["b"]);
	// No active project means every attachment is unreachable.
	expect(staleUploads(files, null).map((entry) => entry.name)).toEqual(["a", "b"]);
	expect(staleUploads([], "p1")).toEqual([]);
});

test("images go to the vision path, other files are uploaded, refusals are kept", () => {
	// Only name, type and size are read, so a plain object stands in for a File.
	const fake = (name: string, type: string, size: number) => ({ name, type, size }) as File;
	const image = fake("shot.png", "image/png", 2048);
	const doc = fake("report.pdf", "application/pdf", 4096);
	const huge = fake("big.bin", "application/octet-stream", MAX_UPLOAD_BYTES + 1);

	expect(planAttachments([image, doc], "p1")).toEqual([
		{ kind: "image", file: image },
		{ kind: "upload", file: doc, projectId: "p1" },
	]);
	// No project selected: an upload has nowhere to go, and the chip says why.
	expect(planAttachments([doc], null)).toEqual([{ kind: "refused", file: doc, reason: "请先选择项目" }]);
	// Over the cap: refused with the limit in the reason. An image is not capped —
	// it is inlined into the message rather than uploaded.
	const plans = planAttachments([huge, image], "p1");
	expect(plans[0].kind).toBe("refused");
	if (plans[0].kind === "refused") expect(plans[0].reason).toContain("64.0 MB");
	expect(plans[1].kind).toBe("image");
});
