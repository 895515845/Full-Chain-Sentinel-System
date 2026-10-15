/**
 * Unit tests for the container file layer.
 *
 * `execInContainer` is mocked: these tests pin the contract the console relies on
 * (path bounds, argument passing, exit-code mapping, preview classification)
 * without needing Docker. The listing runs against the host side of the /work
 * mount, so it is tested with a real temporary directory; the scripts themselves
 * run for real in e2e.test.ts.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";

const { execInContainer } = vi.hoisted(() => ({ execInContainer: vi.fn() }));
vi.mock("../src/docker.ts", () => ({ execInContainer }));

import {
	deletePath,
	downloadFile,
	guessMimeType,
	listFiles,
	listFilesInContainer,
	makeDirectory,
	readFilePreview,
	renamePath,
	resolveWorkPath,
	writeFile,
} from "../src/files.ts";

/** One successful container run. */
function ok(stdout = "", stderr = ""): { code: number; stdout: string; stdoutBytes: Buffer; stderr: string } {
	return { code: 0, stdout, stdoutBytes: Buffer.from(stdout, "binary"), stderr };
}

/** One failed container run. */
function bad(code: number, stderr = ""): { code: number; stdout: string; stdoutBytes: Buffer; stderr: string } {
	return { code, stdout: "", stdoutBytes: Buffer.alloc(0), stderr };
}

beforeEach(() => {
	execInContainer.mockReset();
	execInContainer.mockResolvedValue(ok());
});

test("resolveWorkPath accepts work-directory paths and collapses dot segments", () => {
	expect(resolveWorkPath("/work")).toBe("/work");
	expect(resolveWorkPath("/work/reports")).toBe("/work/reports");
	expect(resolveWorkPath("/work/reports/../notes.txt")).toBe("/work/notes.txt");
	expect(resolveWorkPath("/work/./a//b")).toBe("/work/a/b");
	// A bare relative path is resolved against the work directory.
	expect(resolveWorkPath("reports")).toBe("/work/reports");
	expect(resolveWorkPath("")).toBe("/work");
});

test("resolveWorkPath rejects anything that leaves the work directory", () => {
	expect(() => resolveWorkPath("/etc/passwd")).toThrow(/路径越界/);
	expect(() => resolveWorkPath("/work/../etc/passwd")).toThrow(/路径越界/);
	expect(() => resolveWorkPath("/work/../../tmp/x")).toThrow(/路径越界/);
	expect(() => resolveWorkPath("../secrets")).toThrow(/路径越界/);
	// Prefix lookalikes must not pass the /work boundary check.
	expect(() => resolveWorkPath("/workshop/notes.txt")).toThrow(/路径越界/);
	expect(() => resolveWorkPath("/work/..")).toThrow(/路径越界/);
	expect(() => resolveWorkPath("/work/a\0b")).toThrow(/非法字符/);
});

test("guessMimeType maps images, text formats, and falls back to a blob", () => {
	expect(guessMimeType("/work/shot.PNG")).toBe("image/png");
	expect(guessMimeType("/work/notes.txt")).toBe("text/plain; charset=utf-8");
	expect(guessMimeType("/work/report.md")).toBe("text/markdown; charset=utf-8");
	expect(guessMimeType("/work/dump.bin")).toBe("application/octet-stream");
	expect(guessMimeType("/work/archive")).toBe("application/octet-stream");
});

test("listFiles reads the host side of the mount and puts directories first", async () => {
	const root = mkdtempSync(join(tmpdir(), "sentinel-files-"));
	try {
		mkdirSync(join(root, "reports", "sub"), { recursive: true });
		mkdirSync(join(root, ".hidden"));
		writeFileSync(join(root, "my notes.txt"), "12345678");
		writeFileSync(join(root, "z.sh"), "012345678901");
		symlinkSync("my notes.txt", join(root, "link.txt"));

		const listed = await listFiles(root, "/work");
		expect(listed.path).toBe("/work");
		// Directories first, and they are listed at all: a directory whose size was
		// asked of `wc` used to break the record framing and vanish.
		expect(listed.entries.slice(0, 2).every((entry) => entry.type === "dir")).toBe(true);
		expect(
			listed.entries
				.filter((entry) => entry.type === "dir")
				.map((entry) => entry.name)
				.sort(),
		).toEqual([".hidden", "reports"]);
		expect(
			listed.entries
				.filter((entry) => entry.type === "file")
				.map((entry) => entry.name)
				.sort(),
		).toEqual(["link.txt", "my notes.txt", "z.sh"]);
		expect(listed.entries.find((entry) => entry.name === "reports")).toMatchObject({
			path: "/work/reports",
			type: "dir",
			size: 0,
		});
		expect(listed.entries.find((entry) => entry.name === "my notes.txt")).toMatchObject({
			path: "/work/my notes.txt",
			type: "file",
			size: 8,
		});
		// stat(2) follows symlinks, which is what the container's `[ -d ]` did.
		expect(listed.entries.find((entry) => entry.name === "link.txt")?.type).toBe("file");
		expect(listed.entries.find((entry) => entry.name === "z.sh")?.mtime).toBeGreaterThan(0);
		// The container is not consulted while the host can read the directory.
		expect(execInContainer).not.toHaveBeenCalled();

		// A subdirectory is a path the panel can then open.
		const nested = await listFiles(root, "/work/reports");
		expect(nested).toEqual({
			path: "/work/reports",
			entries: [expect.objectContaining({ name: "sub", path: "/work/reports/sub", type: "dir" })],
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("listFiles reports a missing directory", async () => {
	const root = mkdtempSync(join(tmpdir(), "sentinel-files-"));
	try {
		await expect(listFiles(root, "/work/gone")).rejects.toThrow(/目录不存在或不可读/);
		await expect(listFiles(root, "/work/notes.txt/inside")).rejects.toThrow(/目录不存在或不可读/);
		// The bound check runs before anything touches the filesystem.
		await expect(listFiles(root, "/etc")).rejects.toThrow(/路径越界/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// A root process ignores the mode bits, so there is nothing to fall back from.
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

test.skipIf(asRoot)("listFiles asks the container when the host cannot read the directory", async () => {
	const root = mkdtempSync(join(tmpdir(), "sentinel-files-"));
	const secret = join(root, "secret");
	mkdirSync(secret);
	chmodSync(secret, 0o000);
	try {
		execInContainer.mockResolvedValue(ok("f\t1\t1700000001\tproof.txt\n"));
		const listed = await listFiles(root, "/work/secret", { container: "sentinel-test" });
		expect(execInContainer).toHaveBeenCalledTimes(1);
		expect(listed.entries).toEqual([
			{ name: "proof.txt", path: "/work/secret/proof.txt", type: "file", size: 1, mtime: 1700000001 },
		]);
	} finally {
		chmodSync(secret, 0o700);
		rmSync(root, { recursive: true, force: true });
	}
});

test("listFilesInContainer parses the tab-separated listing and maps exit codes", async () => {
	execInContainer.mockResolvedValue(
		ok("f\t8\t1700000001\tmy notes.txt\nd\t0\t1700000002\treports\nf\t12\t1700000003\tz.sh\n"),
	);

	const listed = await listFilesInContainer("sentinel-test", "/work");
	expect(listed.path).toBe("/work");
	expect(listed.entries).toEqual([
		{ name: "reports", path: "/work/reports", type: "dir", size: 0, mtime: 1700000002 },
		{ name: "my notes.txt", path: "/work/my notes.txt", type: "file", size: 8, mtime: 1700000001 },
		{ name: "z.sh", path: "/work/z.sh", type: "file", size: 12, mtime: 1700000003 },
	]);

	// The path is passed as a positional parameter, never interpolated.
	const [container, script, args] = execInContainer.mock.calls[0];
	expect(container).toBe("sentinel-test");
	expect(script).toContain('cd "$1"');
	expect(script).not.toContain("/work");
	expect(args).toEqual(["/work"]);
	// A directory's size is never asked of `wc`: on Linux `wc -c < dir` prints a 0
	// and exits non-zero, so a `|| echo 0` fallback would emit two lines and shift
	// the record that follows it.
	expect(script).toContain('if [ -d "$entry" ]; then kind=d; size=0;');

	execInContainer.mockResolvedValue(bad(2));
	await expect(listFilesInContainer("c", "/work/gone")).rejects.toThrow(/目录不存在或不可读/);

	execInContainer.mockResolvedValue(bad(1, "permission denied"));
	await expect(listFilesInContainer("c", "/work/secret")).rejects.toThrow(/读取目录失败：permission denied/);
});

test("readFilePreview returns text, classifies binaries, and truncates", async () => {
	execInContainer.mockResolvedValue({ code: 0, stdout: "hello", stdoutBytes: Buffer.from("hello"), stderr: "5" });
	expect(await readFilePreview("c", "/work/notes.txt")).toEqual({
		path: "/work/notes.txt",
		kind: "text",
		size: 5,
		truncated: false,
		text: "hello",
	});

	// A NUL byte marks a binary file; without an image extension it is not inlined.
	const binaryBytes = Buffer.from([0x50, 0x4b, 0x00, 0x01]);
	execInContainer.mockResolvedValue({ code: 0, stdout: "", stdoutBytes: binaryBytes, stderr: "4" });
	expect(await readFilePreview("c", "/work/blob.bin")).toEqual({
		path: "/work/blob.bin",
		kind: "binary",
		size: 4,
		truncated: false,
	});

	// The same bytes with an image extension come back as base64 for <img>.
	execInContainer.mockResolvedValue({ code: 0, stdout: "", stdoutBytes: binaryBytes, stderr: "4" });
	const image = await readFilePreview("c", "/work/shot.png");
	expect(image.kind).toBe("image");
	expect(image.data).toBe(binaryBytes.toString("base64"));
	expect(image.mimeType).toBe("image/png");

	// Beyond the inline limit only the first chunk is returned, and it is flagged.
	const big = Buffer.alloc(256 * 1024 + 10, 0x41);
	execInContainer.mockResolvedValue({
		code: 0,
		stdout: "",
		stdoutBytes: big,
		stderr: String(big.length),
	});
	const truncated = await readFilePreview("c", "/work/big.log");
	expect(truncated.truncated).toBe(true);
	expect(truncated.size).toBe(big.length);
	expect(truncated.text?.length).toBe(256 * 1024);
});

test("writeFile streams bytes to the container and creates parents", async () => {
	const content = Buffer.from("payload");
	const written = await writeFile("c", "/work/deep/dir/file.txt", content);
	expect(written).toEqual({ path: "/work/deep/dir/file.txt", size: 7 });

	const [, script, args, options] = execInContainer.mock.calls[0];
	expect(script).toContain('mkdir -p "$(dirname "$1")"');
	expect(args).toEqual(["/work/deep/dir/file.txt"]);
	expect(options.stdin).toBe(content);
});

test("writeFile refuses an oversized upload without touching the container", async () => {
	const oversized = Buffer.alloc(32 * 1024 * 1024 + 1);
	await expect(writeFile("c", "/work/big.bin", oversized)).rejects.toThrow(/超过 32MB 上限/);
	expect(execInContainer).not.toHaveBeenCalled();
});

test("mutations refuse the work root and map container exit codes", async () => {
	await expect(deletePath("c", "/work")).rejects.toThrow(/不允许操作 \/work 根目录/);
	await expect(renamePath("c", "/work", "/work/x")).rejects.toThrow(/不允许操作 \/work 根目录/);
	await expect(makeDirectory("c", "/work")).rejects.toThrow(/目录已存在/);
	expect(execInContainer).not.toHaveBeenCalled();

	execInContainer.mockResolvedValue(bad(5));
	await expect(renamePath("c", "/work/a.txt", "/work/b.txt")).rejects.toThrow(/目标已存在/);

	execInContainer.mockResolvedValue(bad(3));
	await expect(downloadFile("c", "/work/huge.bin")).rejects.toThrow(/超过 32MB 上限/);

	execInContainer.mockResolvedValue(bad(2));
	await expect(deletePath("c", "/work/gone.txt")).rejects.toThrow(/删除失败：文件不存在或不可读/);
});
