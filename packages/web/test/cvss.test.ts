/**
 * The reviewer no longer writes a score: it judges the eight CVSS v3.1 metrics
 * and this code computes the number. These vectors are the ones the CVSS 3.1
 * specification and well-known CVEs publish, so a regression in the formula
 * (Roundup, the PR scope rule, the impact sub-score) shows up as a wrong
 * severity in the hub rather than as a silently different decimal.
 */

import { expect, test } from "vitest";
import { type CvssMetrics, cvssBaseScore, cvssVector, parseCvssMetrics } from "../src/cvss.ts";
import { severityForCvss } from "../src/vulnerabilities.ts";

const metrics = (over: Partial<CvssMetrics> = {}): CvssMetrics => ({
	av: "N",
	ac: "L",
	pr: "N",
	ui: "N",
	s: "U",
	c: "H",
	i: "H",
	a: "H",
	...over,
});

test("base scores match the published values", () => {
	const cases: Array<[CvssMetrics, number]> = [
		// Unauthenticated remote code execution, unchanged scope.
		[metrics(), 9.8],
		// Log4Shell: the same thing with a scope change (10.0).
		[metrics({ s: "C" }), 10.0],
		// Information disclosure with no integrity or availability impact.
		[metrics({ i: "N", a: "N" }), 7.5],
		// Denial of service only.
		[metrics({ c: "N", i: "N" }), 7.5],
		// Reflected XSS (scope change, low impact).
		[metrics({ ui: "R", s: "C", c: "L", i: "L", a: "N" }), 6.1],
		// Hard-to-exploit information leak.
		[metrics({ ac: "H", c: "L", i: "N", a: "N" }), 3.7],
		// Local privilege escalation with low privileges already held.
		[metrics({ av: "L", pr: "L" }), 7.8],
		// Authenticated remote code execution.
		[metrics({ pr: "L" }), 8.8],
		// Admin-only remote code execution.
		[metrics({ pr: "H" }), 7.2],
		// Physical access, full impact.
		[metrics({ av: "P" }), 6.8],
		// Medium: two low impacts.
		[metrics({ c: "L", i: "L", a: "N" }), 6.5],
	];
	for (const [input, expected] of cases) {
		expect(cvssBaseScore(input), cvssVector(input)).toBe(expected);
	}
});

test("no impact is 0.0 no matter how easy the vector looks", () => {
	expect(cvssBaseScore(metrics({ c: "N", i: "N", a: "N" }))).toBe(0);
	expect(severityForCvss(0)).toBe("info");
});

test("severity buckets follow the spec's qualitative scale", () => {
	expect(severityForCvss(0)).toBe("info");
	expect(severityForCvss(0.1)).toBe("low");
	expect(severityForCvss(3.9)).toBe("low");
	expect(severityForCvss(4)).toBe("medium");
	expect(severityForCvss(6.9)).toBe("medium");
	expect(severityForCvss(7)).toBe("high");
	expect(severityForCvss(8.9)).toBe("high");
	expect(severityForCvss(9)).toBe("critical");
	expect(severityForCvss(10)).toBe("critical");
});

test("the vector string is the canonical v3.1 form", () => {
	expect(cvssVector(metrics())).toBe("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H");
	expect(cvssVector(metrics({ av: "L", ac: "H", pr: "H", ui: "R", s: "C", c: "L", i: "N", a: "N" }))).toBe(
		"CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:C/C:L/I:N/A:N",
	);
});

test("metrics are validated against the spec's allowed values", () => {
	const ok = { av: "N", ac: "L", pr: "N", ui: "N", s: "U", c: "H", i: "H", a: "H" };
	expect(parseCvssMetrics(ok)).toEqual(ok);
	// A model that spells the metric out, drops one, or lowercases it fails loudly.
	expect(() => parseCvssMetrics({ ...ok, av: "Network" })).toThrow(/AV/);
	expect(() => parseCvssMetrics({ ...ok, pr: "h" })).toThrow(/PR/);
	expect(() => parseCvssMetrics({ ...ok, s: undefined })).toThrow(/S/);
});
