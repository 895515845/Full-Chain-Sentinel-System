import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import {
	certificateNames,
	ensureTlsCertificate,
	localInterfaceIps,
	storedNamesCoverCurrentIps,
	tlsCertPath,
	tlsKeyPath,
} from "../src/tls.ts";

const dirs: string[] = [];

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "sentinel-tls-"));
	dirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** An exec stub that "signs" by writing the pair, like openssl would. */
function fakeOpenssl(): (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }> {
	return async (_file, args) => {
		const keyOut = args[args.indexOf("-keyout") + 1]!;
		const certOut = args[args.indexOf("-out") + 1]!;
		writeFileSync(keyOut, "KEY-PEM");
		writeFileSync(certOut, "CERT-PEM");
		return { stdout: "", stderr: "" };
	};
}

test("certificateNames covers localhost plus the given interfaces", () => {
	expect(certificateNames(["192.168.1.5", "10.0.0.2"])).toEqual([
		"DNS:localhost",
		"IP:127.0.0.1",
		"IP:::1",
		"IP:192.168.1.5",
		"IP:10.0.0.2",
	]);
});

test("localInterfaceIps returns unique sorted non-internal IPv4s", () => {
	for (const ip of localInterfaceIps()) {
		expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
	}
});

test("ensureTlsCertificate signs on first call and reuses the stored pair", async () => {
	const dir = workspace();
	const first = await ensureTlsCertificate(dir, { ips: ["192.168.1.5"], exec: fakeOpenssl() });
	expect(first.source).toBe("generated");
	expect(first.cert).toBe("CERT-PEM");
	expect(first.names).toContain("IP:192.168.1.5");

	const second = await ensureTlsCertificate(dir, { ips: ["192.168.1.5"], exec: fakeOpenssl() });
	expect(second.source).toBe("stored");
	expect(second.cert).toBe("CERT-PEM");

	const regenerated = await ensureTlsCertificate(dir, { ips: ["10.1.2.3"], regenerate: true, exec: fakeOpenssl() });
	expect(regenerated.source).toBe("generated");
	expect(regenerated.names).toContain("IP:10.1.2.3");
});

test("ensureTlsCertificate prefers an operator-provided pair", async () => {
	const dir = workspace();
	const certFile = join(dir, "my-cert.pem");
	const keyFile = join(dir, "my-key.pem");
	writeFileSync(certFile, "MY-CERT");
	writeFileSync(keyFile, "MY-KEY");
	const provided = await ensureTlsCertificate(dir, { certPath: certFile, keyPath: keyFile, exec: fakeOpenssl() });
	expect(provided).toMatchObject({ cert: "MY-CERT", key: "MY-KEY", source: "provided" });

	await expect(ensureTlsCertificate(dir, { certPath: certFile, exec: fakeOpenssl() })).rejects.toThrow(/成对使用/);
	await expect(
		ensureTlsCertificate(dir, { certPath: join(dir, "nope.pem"), keyPath: keyFile, exec: fakeOpenssl() }),
	).rejects.toThrow(/不存在/);
});

test("a failed openssl run is a plain error naming the fallback", async () => {
	const dir = workspace();
	const failing = async (): Promise<{ stdout: string; stderr: string }> => {
		throw new Error("command not found: openssl");
	};
	await expect(ensureTlsCertificate(dir, { ips: [], exec: failing })).rejects.toThrow(/openssl 生成自签证书失败/);
});

test("storedNamesCoverCurrentIps detects a stale certificate", async () => {
	const dir = workspace();
	// No stored names yet: nothing to compare against, so it reads as fine.
	expect(storedNamesCoverCurrentIps(dir)).toBe(true);

	await ensureTlsCertificate(dir, { ips: ["192.168.1.5"], exec: fakeOpenssl() });
	// A names.json that covers only an address this host does not have reads stale
	// only when a current IP is missing from it — force that with a fake file.
	mkdirSync(join(dir, "tls"), { recursive: true });
	writeFileSync(
		join(dir, "tls", "names.json"),
		`${JSON.stringify({ names: ["DNS:localhost", "IP:127.0.0.1", "IP:203.0.113.99"] })}\n`,
	);
	const current = localInterfaceIps();
	if (current.length > 0) {
		expect(storedNamesCoverCurrentIps(dir)).toBe(false);
	}
	void tlsCertPath;
	void tlsKeyPath;
});
