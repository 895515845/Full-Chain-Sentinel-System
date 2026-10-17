/**
 * Self-signed TLS certificate for the console listener.
 *
 * The console serves HTTPS by default: the login cookie, the chat traffic and
 * the WebSocket all ride one listener, and on a LAN or a public bind that must
 * not be plaintext. The certificate is generated once with the local openssl
 * binary (Node's stdlib cannot sign X.509) and stored under the agent config
 * directory; `--tls-cert` / `--tls-key` bypass generation for an operator-owned
 * certificate.
 *
 * The SAN covers localhost plus every non-internal IPv4 the host currently has,
 * so a phone or another laptop on the same LAN reaches the console without a
 * hostname mismatch. Changing networks can invalidate that list — `--tls-regen`
 * re-runs the generation with the current addresses.
 */

import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Where the generated pair lives, relative to the agent config directory. */
export function tlsDir(agentDir: string): string {
	return join(agentDir, "tls");
}

export function tlsCertPath(agentDir: string): string {
	return join(tlsDir(agentDir), "cert.pem");
}

export function tlsKeyPath(agentDir: string): string {
	return join(tlsDir(agentDir), "key.pem");
}

/** Every non-internal IPv4 the host currently answers on. */
export function localInterfaceIps(): string[] {
	const ips: string[] = [];
	for (const addresses of Object.values(networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family === "IPv4" && !address.internal) ips.push(address.address);
		}
	}
	return [...new Set(ips)].sort();
}

/** The SAN entries a generated certificate carries. */
export function certificateNames(ips: readonly string[]): string[] {
	return ["DNS:localhost", "IP:127.0.0.1", "IP:::1", ...ips.map((ip) => `IP:${ip}`)];
}

export interface TlsCertificate {
	/** PEM contents, handed to https.createServer. */
	cert: string;
	key: string;
	/** Where the pair was read from, for the startup log. */
	source: "generated" | "stored" | "provided";
	/** SAN entries of a generated certificate (recorded at signing time). */
	names: string[];
}

export interface EnsureTlsOptions {
	/** Operator-provided PEM paths; both or neither. */
	certPath?: string;
	keyPath?: string;
	/** Re-run generation even when a stored pair exists (network changed). */
	regenerate?: boolean;
	/** Override interface discovery (tests); defaults to localInterfaceIps(). */
	ips?: string[];
	/** Injected runner for tests. */
	exec?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * Return a usable certificate pair, generating one when needed.
 *
 * Priority: explicit --tls-cert/--tls-key, then the stored pair, then a fresh
 * openssl run. A missing openssl binary or a failed signing is a plain error —
 * the caller decides whether to fall back to HTTP or refuse to start.
 */
export async function ensureTlsCertificate(agentDir: string, options: EnsureTlsOptions = {}): Promise<TlsCertificate> {
	const exec = options.exec ?? run;
	if (options.certPath || options.keyPath) {
		if (!options.certPath || !options.keyPath) {
			throw new Error("--tls-cert 与 --tls-key 必须成对使用");
		}
		if (!existsSync(options.certPath) || !existsSync(options.keyPath)) {
			throw new Error(`证书文件不存在：${options.certPath} / ${options.keyPath}`);
		}
		return {
			cert: readFileSync(options.certPath, "utf8"),
			key: readFileSync(options.keyPath, "utf8"),
			source: "provided",
			names: [],
		};
	}

	const certFile = tlsCertPath(agentDir);
	const keyFile = tlsKeyPath(agentDir);
	if (!options.regenerate && existsSync(certFile) && existsSync(keyFile)) {
		const names = readStoredNames(agentDir);
		return { cert: readFileSync(certFile, "utf8"), key: readFileSync(keyFile, "utf8"), source: "stored", names };
	}

	const ips = options.ips ?? localInterfaceIps();
	const names = certificateNames(ips);
	const dir = tlsDir(agentDir);
	mkdirSync(dir, { recursive: true });
	try {
		await exec("openssl", [
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-sha256",
			"-days",
			"825",
			"-nodes",
			"-keyout",
			keyFile,
			"-out",
			certFile,
			"-subj",
			"/CN=sentinel-console",
			"-addext",
			`subjectAltName=${names.join(",")}`,
		]);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`openssl 生成自签证书失败（${detail.trim()}）。请安装 openssl，或用 --tls-cert/--tls-key 指定已有证书。`,
		);
	}
	chmodSync(keyFile, 0o600);
	chmodSync(certFile, 0o644);
	// Remember what was signed: the startup log shows it, and a future start can
	// say "the stored certificate no longer matches this machine's addresses".
	writeFileSync(join(dir, "names.json"), `${JSON.stringify({ names, at: new Date().toISOString() }, null, "\t")}\n`);
	return { cert: readFileSync(certFile, "utf8"), key: readFileSync(keyFile, "utf8"), source: "generated", names };
}

function readStoredNames(agentDir: string): string[] {
	try {
		const parsed = JSON.parse(readFileSync(join(tlsDir(agentDir), "names.json"), "utf8")) as {
			names?: unknown;
		};
		return Array.isArray(parsed.names) ? parsed.names.filter((name): name is string => typeof name === "string") : [];
	} catch {
		return [];
	}
}

/**
 * Whether the stored certificate still covers every current interface address.
 * An address gained after signing (new Wi-Fi, hotspot, VPN) would throw a
 * hostname mismatch in the browser, so the caller regenerates then.
 */
export function storedNamesCoverCurrentIps(agentDir: string): boolean {
	const names = readStoredNames(agentDir);
	if (names.length === 0) return true;
	const ips = localInterfaceIps();
	return ips.every((ip) => names.includes(`IP:${ip}`));
}
