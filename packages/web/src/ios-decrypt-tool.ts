/**
 * FairPlay decryption and keychain access.
 *
 * Decryption follows the design in docs/ios-agent-qa.md §11: the dump happens
 * on the device, driven by the `ios_decrypt_dump` frida script, and the console
 * only unpacks, replaces binaries, clears `cryptid`, repackages and writes the
 * evidence report. Nothing large crosses the WebSocket as a memory blob: each
 * dumped image is pulled to disk in chunks.
 *
 * The tool is deliberately honest about failure: an encrypted app that exits on
 * launch, a framework that never loaded, or a frida-server that is not running
 * each produce their own message instead of a generic "解密失败".
 */

import { createHash } from "node:crypto";
import {
	chmodSync,
	createReadStream,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { missingImages, scanBundleImages } from "./ios-bundle.ts";
import { runFrida } from "./ios-frida-tool.ts";
import { type IosToolContext, pullAppBundle, pullToFile, zipPayload } from "./ios-tool.ts";
import { machoInfo, patchCryptid } from "./macho.ts";

export const IOS_DECRYPT_TOOL_NAMES: readonly string[] = ["ios_decrypt", "ios_keychain"];

const DEVICE_DUMP_DIR = "/tmp/sentinel-decrypt";
const KEYCHAIN_DB = "/var/Keychains/keychain-2.db";
const KEYCHAIN_DUMPERS = ["/var/jb/usr/bin/keychain_dumper", "/usr/bin/keychain_dumper"];

function failure(text: string): AgentToolResult<{ ok: boolean }> {
	return { content: [{ type: "text", text }], details: { ok: false }, isError: true };
}

function pickDevice(ctx: IosToolContext, device: string | undefined) {
	const gateway = ctx.gateway();
	if (!gateway) return "设备网关未启动" as const;
	const online = gateway.onlineDevices();
	if (online.length === 0) return "没有在线的 iOS 设备：先在越狱设备上打开 SentinelBridge 并等待反连成功" as const;
	if (device?.trim()) {
		const needle = device.trim();
		const found =
			online.find((candidate) => candidate.id === needle) ?? online.find((candidate) => candidate.name === needle);
		if (!found) return `设备「${needle}」不在线` as const;
		return found;
	}
	if (online.length > 1) return "多台设备在线，请用 device 参数指定" as const;
	return online[0]!;
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Hash a possibly large IPA without loading it into memory. */
async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

interface DumpEntry {
	rel: string;
	out: string;
	size: number;
	cryptid: number;
}

interface PatchedBinary {
	rel: string;
	bytes: Buffer;
	cryptidBefore: number;
	cryptidAfter: number;
	patched: number;
}

const LDID_CANDIDATES = ["/var/jb/usr/bin/ldid", "/usr/bin/ldid"];
const BFDECRYPT_CANDIDATES = ["/var/jb/usr/bin/bfdecrypt", "/usr/bin/bfdecrypt"];

async function probeTool(
	gateway: NonNullable<ReturnType<IosToolContext["gateway"]>>,
	deviceId: string,
	candidates: string[],
	marker: string,
): Promise<string | null> {
	const command = candidates.map((path) => `[ -x ${shellQuote(path)} ] && echo "${marker} ${path}"`).join("; ");
	const result = await gateway.request(
		deviceId,
		{ t: "exec", cmd: command, asRoot: false, timeoutMs: 15_000 },
		{
			timeoutMs: 25_000,
		},
	);
	if (!result.ok) return null;
	const match = (result.stdout ?? "").match(new RegExp(`${marker} (\\S+)`));
	return match?.[1] ?? null;
}

/**
 * Read each encrypted binary's entitlements before the dump replaces it.
 * `ldid -S` with the saved plist keeps app groups, associated domains and the
 * keychain-access-group that the app was installed with. When ldid is absent
 * the map stays empty and the caller reports that re-signing was skipped.
 */
async function readEntitlements(
	gateway: NonNullable<ReturnType<IosToolContext["gateway"]>>,
	deviceId: string,
	appPath: string,
	rels: string[],
): Promise<{ ldid: string | null; map: Map<string, string> }> {
	const ldid = await probeTool(gateway, deviceId, LDID_CANDIDATES, "LDID");
	const map = new Map<string, string>();
	if (!ldid) return { ldid: null, map };
	for (const rel of rels) {
		const result = await gateway.request(
			deviceId,
			{
				t: "exec",
				cmd: `${shellQuote(ldid)} -e ${shellQuote(`${appPath}/${rel}`)} 2>/dev/null`,
				asRoot: false,
				timeoutMs: 20_000,
			},
			{ timeoutMs: 30_000 },
		);
		const text = (result.stdout ?? "").trim();
		if (result.ok && (result.code ?? 0) === 0 && text.length > 0) map.set(rel, text);
	}
	return { ldid, map };
}

/**
 * Re-sign the binaries the dump replaced. Only those files changed, so the
 * untouched frameworks keep their original signatures; `_CodeSignature` still
 * hashes the old files, which is why the caller reports the limitation and lets
 * the optional install check decide whether the target jailbreak cares.
 */
async function signPatchedBinaries(
	gateway: NonNullable<ReturnType<IosToolContext["gateway"]>>,
	deviceId: string,
	ldid: string,
	appDir: string,
	binaries: PatchedBinary[],
	entitlements: Map<string, string>,
): Promise<{ signed: number; failures: string[] }> {
	const remoteDir = "/var/tmp/sentinel-sign";
	await gateway.request(
		deviceId,
		{ t: "exec", cmd: `rm -rf ${remoteDir}; mkdir -p ${remoteDir}`, asRoot: false, timeoutMs: 15_000 },
		{ timeoutMs: 25_000 },
	);
	let signed = 0;
	const failures: string[] = [];
	for (let index = 0; index < binaries.length; index += 1) {
		const binary = binaries[index]!;
		const remote = `${remoteDir}/${index}`;
		const push = await gateway.pushFile(deviceId, remote, binary.bytes, { mode: "0755", timeoutMs: 180_000 });
		if (!push.ok) {
			failures.push(`${binary.rel}: 推送失败 ${push.error ?? ""}`.trim());
			continue;
		}
		let command = `${shellQuote(ldid)} -S ${shellQuote(remote)}`;
		const ent = entitlements.get(binary.rel);
		if (ent) {
			const entRemote = `${remote}.plist`;
			const entPush = await gateway.pushFile(deviceId, entRemote, Buffer.from(ent, "utf8"), {
				mode: "0644",
				timeoutMs: 60_000,
			});
			if (entPush.ok) command = `${shellQuote(ldid)} -S${shellQuote(entRemote)} ${shellQuote(remote)}`;
		}
		const run = await gateway.request(
			deviceId,
			{ t: "exec", cmd: `${command} 2>&1`, asRoot: false, timeoutMs: 120_000 },
			{ timeoutMs: 150_000 },
		);
		if (!run.ok || (run.code ?? 0) !== 0) {
			failures.push(`${binary.rel}: ldid 退出码 ${run.code ?? "?"} ${(run.stderr ?? "").slice(0, 200)}`.trim());
			continue;
		}
		const target = join(appDir, binary.rel);
		try {
			await pullToFile(gateway, deviceId, remote, target, 180_000);
			chmodSync(target, 0o755);
			signed += 1;
		} catch (error) {
			failures.push(`${binary.rel}: 拉回失败 ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { signed, failures };
}

/** Fallback for devices that carry bfdecrypt: it produces a decrypted IPA directly. */
async function tryBfdecrypt(
	gateway: NonNullable<ReturnType<IosToolContext["gateway"]>>,
	deviceId: string,
	bundleId: string,
	target: string,
): Promise<{ ok: true; log: string } | { ok: false; error: string }> {
	const bf = await probeTool(gateway, deviceId, BFDECRYPT_CANDIDATES, "BF");
	if (!bf) return { ok: false, error: "设备上没有 bfdecrypt" };
	const dir = "/var/tmp/sentinel-bfdecrypt";
	const run = await gateway.request(
		deviceId,
		{
			t: "exec",
			cmd: `rm -rf ${dir}; mkdir -p ${dir}; ${shellQuote(bf)} -o ${dir} ${shellQuote(bundleId)} 2>&1`,
			asRoot: false,
			timeoutMs: 600_000,
		},
		{ timeoutMs: 650_000 },
	);
	if (!run.ok || (run.code ?? 0) !== 0) {
		return { ok: false, error: `bfdecrypt 失败（退出码 ${run.code ?? "?"}）：${(run.stdout ?? "").slice(-800)}` };
	}
	const list = await gateway.request(
		deviceId,
		{
			t: "exec",
			cmd: `ls -1 ${dir}/*.ipa 2>/dev/null | head -1`,
			asRoot: false,
			timeoutMs: 15_000,
		},
		{ timeoutMs: 25_000 },
	);
	const ipa = (list.stdout ?? "").trim();
	if (!ipa) return { ok: false, error: "bfdecrypt 没有产出 IPA" };
	try {
		await pullToFile(gateway, deviceId, ipa, target, 600_000);
	} catch (error) {
		return { ok: false, error: `拉取 bfdecrypt 产物失败：${error instanceof Error ? error.message : String(error)}` };
	}
	return { ok: true, log: `${bf} -o ${dir} ${bundleId}\n${(run.stdout ?? "").slice(-1000)}` };
}

/** Install the decrypted IPA on a second device and read the app back. */
async function verifyOnDevice(
	ctx: IosToolContext,
	gateway: NonNullable<ReturnType<IosToolContext["gateway"]>>,
	device: { id: string; name: string },
	ipaPath: string,
	bundleId: string,
): Promise<{ ok: boolean; text: string }> {
	const remote = `/var/tmp/sentinel-verify-${Date.now()}.ipa`;
	let bytes: Buffer;
	try {
		bytes = readFileSync(ipaPath);
	} catch (error) {
		return { ok: false, text: `读取产物失败：${error instanceof Error ? error.message : String(error)}` };
	}
	const push = await gateway.pushFile(device.id, remote, bytes, { mode: "0644", timeoutMs: 600_000 });
	if (!push.ok) return { ok: false, text: `推送到验证设备失败：${push.error ?? "未知错误"}` };
	try {
		await ctx.guard(device.name, `appinst ${shellQuote(remote)}`);
	} catch (error) {
		return { ok: false, text: `安装未获批准：${error instanceof Error ? error.message : String(error)}` };
	}
	const install = await gateway.request(device.id, { t: "install", path: remote }, { timeoutMs: 600_000 });
	if (!install.ok) return { ok: false, text: `安装失败：${install.error ?? "未知错误"}` };
	const info = await gateway.request(device.id, { t: "app_info", bundleId }, { timeoutMs: 60_000 });
	if (!info.ok) return { ok: false, text: `安装后读取应用失败：${info.error ?? "未知错误"}` };
	let parsed: { cryptid?: number; path?: string };
	try {
		parsed = JSON.parse(info.stdout ?? "{}") as typeof parsed;
	} catch {
		return { ok: false, text: "安装后 app_info 不是 JSON" };
	}
	if ((parsed.cryptid ?? 1) !== 0) {
		return { ok: false, text: `安装成功但 cryptid 仍为 ${parsed.cryptid}（可能装回了原包）` };
	}
	return {
		ok: true,
		text: `已安装到 ${device.name}，cryptid 0，路径 ${parsed.path ?? "?"}`,
	};
}

export function createIosDecryptTools(ctx: IosToolContext): ToolDefinition[] {
	const decrypt = defineTool({
		name: "ios_decrypt",
		label: "Decrypt a FairPlay-encrypted iOS app",
		defaultActive: false,
		description:
			"Decrypt an installed FairPlay-encrypted app and repackage it as evidence/ios/ipas/<name>-decrypted.ipa. The console scans every Mach-O in the pulled bundle first, so frameworks and app extensions that never loaded are reported instead of silently missed. The device-side dump uses the ios_decrypt_dump frida script; when frida fails and the device has bfdecrypt, that fallback is tried. The original encrypted IPA is preserved, both artifacts are SHA-256 hashed, changed binaries are re-signed with ldid when present (entitlements read before the dump), and verifyDevice installs the result on a second device and checks cryptid back from app_info. Requires frida-server (ios_frida_setup) and an app that launches.",
		promptSnippet: "Decrypt an encrypted iOS app into a new IPA",
		promptGuidelines: [
			"Check ios_app_info first: cryptid 0 does not prove every framework is decrypted; the tool still scans the whole bundle",
			"Apps with jailbreak/frida detection exit on launch: run ios_frida with ios_jailbreak_bypass first, or pass seconds high enough to see the log",
			"Pass verifyDevice with a second online device to prove the IPA installs and still reads cryptid 0",
			"Large apps take minutes; the dump, the pull and the optional install are bounded separately",
		],
		parameters: Type.Object({
			bundleId: Type.String({ description: "Bundle id，例如 com.example.app" }),
			device: Type.Optional(Type.String({ description: "目标设备（单台在线时可省略）" })),
			seconds: Type.Optional(Type.Number({ description: "设备端 dump 的秒数预算，默认 120，上限 600" })),
			resign: Type.Optional(
				Type.Boolean({ description: "替换过的二进制用设备上的 ldid 重签，默认 true（没有 ldid 时跳过并告警）" }),
			),
			verifyDevice: Type.Optional(
				Type.String({ description: "第二台在线设备的 id/名称：装上去并读回 cryptid 做交付验证" }),
			),
			fallback: Type.Optional(Type.Boolean({ description: "frida 失败时尝试设备上的 bfdecrypt，默认 true" })),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean; path?: string }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");

			// 1. Facts from the device: bundle path, executable, encryption state.
			const infoResult = await gateway.request(
				picked.id,
				{ t: "app_info", bundleId: params.bundleId },
				{ timeoutMs: 60_000 },
			);
			if (!infoResult.ok) return failure(`读取应用信息失败：${infoResult.error ?? "未知错误"}`);
			let info: { path?: string; executable?: string; cryptid?: number; version?: string };
			try {
				info = JSON.parse(infoResult.stdout ?? "{}") as typeof info;
			} catch {
				return failure("app_info 返回的不是 JSON");
			}
			if (!info.path) return failure("app_info 没有返回应用路径，无法定位 .app");
			const appPath = info.path;
			const cryptidBefore = info.cryptid ?? 0;

			// 2. Stage the bundle. The scan tells us what exists before the dump;
			// the dump can only see images the target process actually loaded.
			const pulled = await pullAppBundle(ctx, picked.id, params.bundleId, 120_000);
			if (!pulled.ok) return failure(pulled.error);
			const ipasDir = join(ctx.workDir(), "evidence", "ios", "ipas");
			mkdirSync(ipasDir, { recursive: true });
			const safe = params.bundleId.replace(/[^A-Za-z0-9._-]/g, "_");
			const decryptedIpa = join(ipasDir, `${safe}-decrypted.ipa`);
			const encryptedIpa = join(ipasDir, `${safe}-encrypted.ipa`);
			const reportPath = join(ipasDir, `${safe}-decrypted.json`);

			const warnings: string[] = [];
			const report: Record<string, unknown> = {
				bundleId: params.bundleId,
				appPath,
				version: info.version ?? "",
				cryptidBefore,
				device: {
					name: picked.name,
					model: picked.model,
					osVersion: picked.osVersion,
					arch: picked.arch,
					jailbreakForm: picked.jailbreakForm,
				},
				time: new Date().toISOString(),
				binaries: [],
				missing: [],
				warnings,
				note: "解密仅用于本次授权测试；产物不传播、不公开。",
			};
			const cleanup = (): void => rmSync(pulled.staging, { recursive: true, force: true });
			const abort = (text: string): AgentToolResult<{ ok: boolean; path?: string }> => {
				cleanup();
				return failure(text);
			};

			const images = scanBundleImages(pulled.appDir);
			const encrypted = images.filter((image) => image.cryptid !== 0);
			report.images = images;
			report.encryptedImages = encrypted;
			report.cryptidBefore = cryptidBefore;
			let method = "none";
			let dumps: DumpEntry[] = [];
			const patched: PatchedBinary[] = [];
			let fridaText = "";

			// The device's app_info cryptid is only the main executable. A main
			// binary at 0 does not prove frameworks are decrypted, so the scan is
			// authoritative; app_info still triggers a dump when the scan could not
			// read any Mach-O (for example a restricted container), preserving the
			// pre-scan behavior.
			const wantsDump = encrypted.length > 0 || cryptidBefore !== 0;
			if (wantsDump) {
				const seconds = Math.min(Math.max(Math.round(params.seconds ?? 120), 20), 600);
				const spec = `ios_decrypt_dump?app=${encodeURIComponent(appPath)}&out=${encodeURIComponent(DEVICE_DUMP_DIR)}&exit=1`;
				const run = await runFrida(ctx, picked, params.bundleId, [spec], "spawn", seconds);
				if (run.ok) fridaText = run.text;
				let manifestError = "";
				if (run.ok) {
					const manifestPull = await gateway.request(
						picked.id,
						{ t: "pull", path: `${DEVICE_DUMP_DIR}/manifest.json`, maxBytes: 8 * 1024 * 1024 },
						{ timeoutMs: 60_000 },
					);
					if (!manifestPull.ok || !manifestPull.bytes || manifestPull.bytes.length === 0) {
						manifestError = "设备端没有写出 manifest.json（App 启动即退出、PT_DENY_ATTACH，或脚本未命中）";
					} else {
						try {
							const parsed = JSON.parse(manifestPull.bytes.toString("utf8")) as unknown;
							if (!Array.isArray(parsed)) throw new Error("manifest 不是数组");
							dumps = parsed as DumpEntry[];
						} catch (error) {
							manifestError = `manifest.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`;
						}
					}
				}
				const dumpFailed =
					!run.ok || manifestError !== "" || ((encrypted.length > 0 || cryptidBefore !== 0) && dumps.length === 0);
				if (dumpFailed) {
					const fridaError = run.ok ? manifestError : run.error;
					const fallbackOn = params.fallback !== false;
					const bf = fallbackOn
						? await tryBfdecrypt(gateway, picked.id, params.bundleId, decryptedIpa)
						: { ok: false as const, error: "已禁用 bfdecrypt 回退" };
					if (!bf.ok) {
						// Even when decryption fails, keep the encrypted bundle as
						// evidence. The archive error is appended, not substituted, so
						// the original failure remains the actionable message.
						let archiveNote = "";
						try {
							await zipPayload(ctx, pulled.staging, encryptedIpa);
						} catch (error) {
							archiveNote = `\n原包归档也失败：${error instanceof Error ? error.message : String(error)}`;
						}
						return abort(
							`设备端 dump 失败：${fridaError}\n前置检查：frida-server 是否已用 ios_frida_setup 启动、App 是否能正常启动、是否检测越狱/frida（先跑 ios_jailbreak_bypass）。\n回退 bfdecrypt 失败：${bf.error}${fridaText ? `\nfrida 输出：\n${fridaText.slice(-2000)}` : ""}${archiveNote}`,
						);
					}
					// Preserve the untouched encrypted bundle before bfdecrypt's
					// output becomes the decrypted artifact.
					try {
						await zipPayload(ctx, pulled.staging, encryptedIpa);
					} catch (error) {
						return abort(`原包归档失败：${error instanceof Error ? error.message : String(error)}`);
					}
					method = "bfdecrypt";
					warnings.push(`frida 失败后回退 bfdecrypt：${bf.log.slice(0, 500)}`);
					warnings.push("bfdecrypt 产物按原样交付，未做 ldid 重签；安装失败时先在设备上重签");
				} else {
					// Archive the encrypted bundle before any file is replaced.
					try {
						await zipPayload(ctx, pulled.staging, encryptedIpa);
					} catch (error) {
						return abort(`原包归档失败：${error instanceof Error ? error.message : String(error)}`);
					}
					method = dumps.length > 0 ? "frida" : "none";
				}
			}

			if (method === "frida") {
				const byRel = new Map(images.map((image) => [image.rel, image]));
				const binariesReport: Array<Record<string, unknown>> = [];
				for (const dump of dumps) {
					const rel = dump.rel.replace(/^\.?\//, "");
					if (!rel || rel.startsWith("/") || rel.split("/").includes("..")) {
						warnings.push(`${dump.rel}: 非法相对路径，跳过`);
						continue;
					}
					const target = join(pulled.appDir, rel);
					const expected = byRel.get(rel)?.size;
					let original: Buffer;
					try {
						original = readFileSync(target);
					} catch (error) {
						warnings.push(
							`${rel}: bundle 中找不到原文件（${error instanceof Error ? error.message : String(error)}）`,
						);
						continue;
					}
					try {
						await pullToFile(gateway, picked.id, dump.out, target, 600_000);
					} catch (error) {
						warnings.push(`${rel}: 拉取失败 ${error instanceof Error ? error.message : String(error)}`);
						continue;
					}
					let bytes = readFileSync(target);
					if (bytes.length < original.length) {
						// FairPlay only covers the executable prefix; frida's
						// Module.size can stop before __LINKEDIT. Put the original
						// tail back so the signature/entitlements blob stays intact.
						const tail = original.subarray(bytes.length);
						bytes = Buffer.concat([bytes, tail]);
						writeFileSync(target, bytes);
						warnings.push(
							`${rel}: dump ${bytes.length - tail.length} 字节小于原文件 ${original.length}，已用原文件尾部补齐 ${tail.length} 字节`,
						);
					}
					if (expected !== undefined && bytes.length !== expected) {
						warnings.push(`${rel}: 补齐后大小 ${bytes.length} 仍与 bundle 原文件 ${expected} 不一致`);
					}
					const before = machoInfo(bytes);
					if (!before) {
						warnings.push(`${rel}: dump 不是可解析的 Mach-O`);
						continue;
					}
					const patch = patchCryptid(bytes);
					writeFileSync(target, bytes);
					chmodSync(target, 0o755);
					const after = machoInfo(bytes);
					binariesReport.push({
						rel,
						bytes: bytes.length,
						cryptidBefore: before.cryptid,
						cryptidAfter: after?.cryptid ?? 0,
						patched: patch.patched,
						sha256: sha256(bytes),
					});
					if (patch.patched > 0) {
						patched.push({
							rel,
							bytes,
							cryptidBefore: before.cryptid,
							cryptidAfter: after?.cryptid ?? 0,
							patched: patch.patched,
						});
					}
					if ((after?.cryptid ?? 0) !== 0) warnings.push(`${rel}: cryptid 仍为 ${after?.cryptid}`);
				}
				report.binaries = binariesReport;
				const missing = missingImages(
					images,
					dumps.map((dump) => dump.rel),
				);
				report.missing = missing;
				for (const image of missing) {
					warnings.push(`${image.rel}: 未 dump（cryptid ${image.cryptid}，进程未加载该镜像）`);
				}

				const entRels = encrypted.length > 0 ? encrypted.map((image) => image.rel) : dumps.map((dump) => dump.rel);
				const ent = await readEntitlements(gateway, picked.id, appPath, entRels);
				report.entitlements = { ldid: ent.ldid ?? "", captured: ent.map.size };
				if (params.resign !== false && patched.length > 0) {
					if (!ent.ldid) {
						warnings.push("设备上没有 ldid：替换过的二进制未重签，依赖 TrollStore/appinst 的签名容忍");
					} else {
						const signed = await signPatchedBinaries(
							gateway,
							picked.id,
							ent.ldid,
							pulled.appDir,
							patched,
							ent.map,
						);
						report.signing = { tool: ent.ldid, signed: signed.signed, failures: signed.failures };
						warnings.push(...signed.failures);
					}
				}

				// Re-scan what is actually in the staged bundle. This is the check
				// that catches a framework the dump missed even though the main
				// executable came back at cryptid 0.
				const afterImages = scanBundleImages(pulled.appDir);
				report.afterImages = afterImages;
				const stillEncrypted = afterImages.filter((image) => image.cryptid !== 0);
				report.stillEncrypted = stillEncrypted;
				for (const image of stillEncrypted) {
					warnings.push(`${image.rel}: 替换后 cryptid 仍为 ${image.cryptid}`);
				}

				try {
					await zipPayload(ctx, pulled.staging, decryptedIpa);
				} catch (error) {
					return abort(`解密包打包失败：${error instanceof Error ? error.message : String(error)}`);
				}
			} else if (method === "none") {
				warnings.push(
					encrypted.length === 0
						? "没有扫描到加密 Mach-O（可能已解密或 bundle 不完整），跳过 frida dump，仅重打包"
						: "扫描到的 Mach-O 全部 cryptid 0（未加密），跳过 frida dump，仅重打包",
				);
				try {
					await zipPayload(ctx, pulled.staging, encryptedIpa);
					await zipPayload(ctx, pulled.staging, decryptedIpa);
				} catch (error) {
					return abort(`打包失败：${error instanceof Error ? error.message : String(error)}`);
				}
			}

			if (!existsSync(decryptedIpa) || statSync(decryptedIpa).size === 0) {
				return abort("解密产物为空：frida/bfdecrypt 没有产出可用 IPA");
			}
			if (!existsSync(encryptedIpa) || statSync(encryptedIpa).size === 0) {
				return abort("原密文包为空：归档失败，未生成解密产物");
			}
			const encryptedHash = await hashFile(encryptedIpa);
			const decryptedHash = await hashFile(decryptedIpa);
			report.method = method;
			report.artifacts = {
				encrypted: { path: encryptedIpa, sha256: encryptedHash },
				decrypted: { path: decryptedIpa, sha256: decryptedHash },
			};
			report.frida = fridaText.slice(-2000);

			let verification = "未请求（传 verifyDevice 可在第二台设备上装并读回 cryptid）";
			if (params.verifyDevice?.trim()) {
				const needle = params.verifyDevice.trim();
				const online = gateway.onlineDevices();
				const target = online.find((candidate) => candidate.id === needle || candidate.name === needle);
				if (!target) {
					verification = `验证设备「${needle}」不在线`;
					warnings.push(verification);
				} else if (target.id === picked.id) {
					verification = "验证设备不能与来源设备相同：安装会覆盖原 App";
					warnings.push(verification);
				} else {
					const verified = await verifyOnDevice(ctx, gateway, target, decryptedIpa, params.bundleId);
					verification = verified.text;
					report.verification = { device: target.name, ok: verified.ok, text: verified.text };
					if (!verified.ok) warnings.push(`交付验证失败：${verified.text}`);
				}
			}
			report.verification = report.verification ?? verification;

			cleanup();
			writeFileSync(reportPath, JSON.stringify(report, null, 2));
			const binaries = report.binaries as Array<{ rel: string; cryptidAfter: number }>;
			const missing = report.missing as Array<{ rel: string }>;
			const summary =
				binaries.length > 0
					? binaries.map((binary) => `${binary.rel} → cryptid ${binary.cryptidAfter}`).join("\n")
					: "（没有替换任何二进制）";
			const missingLine =
				missing.length > 0 ? `\n未 dump（进程未加载）：${missing.map((image) => image.rel).join("、")}` : "";
			const warningLine = warnings.length > 0 ? `\n告警：\n- ${warnings.join("\n- ")}` : "";
			return {
				content: [
					{
						type: "text",
						text: `解密产物：${decryptedIpa}\n原密文包：${encryptedIpa}\n报告：${reportPath}\n方法：${method} · 原 cryptid：${cryptidBefore}\n${summary}${missingLine}\n验证：${verification}${warningLine}`,
					},
				],
				details: { ok: true, path: decryptedIpa },
			};
		},
	});

	const keychain = defineTool({
		name: "ios_keychain",
		label: "Check or dump the iOS keychain",
		defaultActive: false,
		description:
			"Report whether the keychain can be dumped and, when the device has keychain_dumper, run it and save the output under evidence/ios/keychain/. The keychain database is encrypted, so a plain read of /var/Keychains/keychain-2.db is useless: without a dumper the tool says so and points at the frida route (hook SecItemCopyMatching). With a bundleId it also reports the app's keychain-access-groups entitlements.",
		promptSnippet: "Check or dump the iPhone keychain",
		promptGuidelines: [
			"Pass the target bundleId to see which keychain groups the app can read",
			"keychain_dumper output can contain live credentials: treat the saved file as sensitive evidence",
		],
		parameters: Type.Object({
			device: Type.Optional(Type.String({ description: "目标设备（单台在线时可省略）" })),
			bundleId: Type.Optional(
				Type.String({ description: "目标 App 的 bundle id，用于读取 keychain-access-groups" }),
			),
		}),
		async execute(_toolCallId, params): Promise<AgentToolResult<{ ok: boolean; path?: string }>> {
			const picked = pickDevice(ctx, params.device);
			if (typeof picked === "string") return failure(picked);
			const gateway = ctx.gateway();
			if (!gateway) return failure("设备网关未启动");
			const lines: string[] = [];

			if (params.bundleId?.trim()) {
				const infoResult = await gateway.request(
					picked.id,
					{ t: "app_info", bundleId: params.bundleId.trim() },
					{ timeoutMs: 60_000 },
				);
				if (infoResult.ok) {
					try {
						const info = JSON.parse(infoResult.stdout ?? "{}") as {
							provisionEntitlements?: Record<string, unknown>;
							entitlements?: string;
						};
						const groups = info.provisionEntitlements?.["keychain-access-groups"];
						if (Array.isArray(groups) && groups.length > 0) {
							lines.push(`描述文件 keychain-access-groups：${groups.join(", ")}`);
						} else {
							lines.push("描述文件里没有 keychain-access-groups");
						}
						if (typeof info.entitlements === "string") {
							const matched = info.entitlements.match(/keychain-access-groups[\\s\\S]{0,400}/);
							if (matched) lines.push(`ldid entitlements 片段：\n${matched[0].slice(0, 400)}`);
						}
					} catch {
						lines.push("app_info 返回的不是 JSON，跳过 entitlements");
					}
				} else {
					lines.push(`读取 ${params.bundleId} 的 entitlements 失败：${infoResult.error ?? "未知错误"}`);
				}
			}

			const probeScript = [
				`ls -l ${KEYCHAIN_DB} 2>/dev/null || echo "DB none"`,
				`for p in ${KEYCHAIN_DUMPERS.join(" ")}; do [ -x "$p" ] && echo "DUMPER $p"; done`,
				`echo DONE`,
			].join("; ");
			const probe = await gateway.request(
				picked.id,
				{ t: "exec", cmd: probeScript, asRoot: false, timeoutMs: 15_000 },
				{ timeoutMs: 25_000 },
			);
			if (!probe.ok) return failure(`探测失败：${probe.error ?? "未知错误"}`);
			const output = probe.stdout ?? "";
			lines.push(`keychain 数据库：\n${output.split("DUMPER")[0]?.trim() || "（无输出）"}`);
			const dumper = KEYCHAIN_DUMPERS.find((path) => output.includes(`DUMPER ${path}`));
			if (!dumper) {
				lines.push(
					"结论：不可 dump。设备上没有 keychain_dumper；数据库本身加密，直接读无用。下一步：用 ios_frida 加载自定义脚本 hook SecItemCopyMatching，或在 Sileo 安装 keychain_dumper 后重试。",
				);
				return { content: [{ type: "text", text: lines.join("\n") }], details: { ok: true } };
			}
			const dump = await gateway.request(
				picked.id,
				{ t: "exec", cmd: `${dumper} -a 2>&1`, asRoot: false, timeoutMs: 120_000 },
				{ timeoutMs: 150_000 },
			);
			if (!dump.ok) return failure(`keychain_dumper 运行失败：${dump.error ?? "未知错误"}`);
			const body = `${dump.stdout ?? ""}${dump.stderr ?? ""}`.trim();
			if (!body) return failure("keychain_dumper 没有输出（App 沙箱/权限限制？）");
			const dir = join(ctx.workDir(), "evidence", "ios", "keychain");
			mkdirSync(dir, { recursive: true });
			const target = join(dir, `keychain-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);
			writeFileSync(target, body);
			return {
				content: [
					{
						type: "text",
						text: `${lines.join("\n")}\n\n已用 ${dumper} dump keychain → ${target}（${body.length} 字符）\n\n${body.slice(0, 4000)}`,
					},
				],
				details: { ok: true, path: target },
			};
		},
	});

	return [decrypt, keychain];
}
