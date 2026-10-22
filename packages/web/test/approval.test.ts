/**
 * The auto-allow list is per project. Approving "always allow nmap" while
 * working in one engagement must not silence the approval prompt for the same
 * command in another: projects are separate engagements, and a background
 * session from one must not inherit an allowance granted for the one on screen.
 */

import { expect, test } from "vitest";
import { ApprovalGate } from "../src/approval.ts";

test("an allowed prefix applies only to the project it was granted in", () => {
	const gate = new ApprovalGate(() => {});
	gate.allowPrefix("nmap", "project-a");
	expect(gate.isAutoAllowed("nmap -sV 10.0.0.1", "project-a")).toBe(true);
	expect(gate.isAutoAllowed("nmap -sV 10.0.0.1", "project-b")).toBe(false);
	expect(gate.isAutoAllowed("nmap -sV 10.0.0.1", null)).toBe(false);
	expect(gate.getAllowedPrefixes("project-a")).toEqual(["nmap"]);
	expect(gate.getAllowedPrefixes("project-b")).toEqual([]);
});

test("removing a prefix leaves the other project's list alone", () => {
	const gate = new ApprovalGate(() => {});
	gate.allowPrefix("nmap", "project-a");
	gate.allowPrefix("nmap", "project-b");
	gate.removeAllowedPrefix("nmap", "project-a");
	expect(gate.getAllowedPrefixes("project-a")).toEqual([]);
	expect(gate.getAllowedPrefixes("project-b")).toEqual(["nmap"]);
});

test("always-allow on a decision lands in the project that issued the command", async () => {
	const gate = new ApprovalGate(() => {});
	const pending = gate.request("nmap -sV 10.0.0.1", "/work", undefined, "主代理", "project-a");
	const request = gate.listPending()[0];
	expect(request).toBeDefined();
	expect(gate.decide(request?.id ?? "", true, undefined, true)).toBe(true);
	await expect(pending).resolves.toEqual({ approved: true, command: "nmap -sV 10.0.0.1" });
	expect(gate.isAutoAllowed("nmap -sV 10.0.0.2", "project-a")).toBe(true);
	expect(gate.isAutoAllowed("nmap -sV 10.0.0.2", "project-b")).toBe(false);
});

test("a prefix never covers a compound command in any project", () => {
	const gate = new ApprovalGate(() => {});
	gate.allowPrefix("nmap", "project-a");
	expect(gate.isAutoAllowed("nmap -sV 10.0.0.1 && id", "project-a")).toBe(false);
});
