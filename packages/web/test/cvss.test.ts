/**
 * The reviewer no longer writes a score: it judges the eight CVSS v3.1 metrics
 * and this code computes the number. These vectors are the ones the CVSS 3.1
 * specification and well-known CVEs publish, so a regression in the formula
 * (Roundup, the PR scope rule, the impact sub-score) shows up as a wrong
 * severity in the hub rather than as a silently different decimal.
 */

import { expect, test } from "vitest";
import {
	applyCapabilityLimits,
	type CvssMetrics,
	cvssBaseScore,
	cvssVector,
	parseCvssMetrics,
	parseCvssVector,
	type ReviewCapabilities,
} from "../src/cvss.ts";
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
	// The spec's words are accepted too: a reply that spells the metric out
	// used to lose the whole review, and the record then kept the agent's own
	// rating as if it had been checked.
	expect(parseCvssMetrics({ ...ok, av: "Network", pr: "Low" })).toEqual({ ...ok, av: "N", pr: "L" });
	// What is neither the letter nor the word still fails loudly, and so does a
	// metric that is missing altogether.
	expect(() => parseCvssMetrics({ ...ok, av: "某处" })).toThrow(/AV/);
	expect(() => parseCvssMetrics({ ...ok, pr: "h" })).toThrow(/PR/);
	expect(() => parseCvssMetrics({ ...ok, s: undefined })).toThrow(/S/);
});

test("a vector string carries all eight metrics", () => {
	const fromVector = parseCvssVector("CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N");
	expect(fromVector).toEqual({ av: "N", ac: "L", pr: "L", ui: "N", s: "U", c: "H", i: "N", a: "N" });
	// A vector missing an axis is not a vector.
	expect(parseCvssVector("CVSS:3.1/AV:N/AC:L")).toBeUndefined();
	// A vector quoted in the middle of a sentence is prose, not an answer.
	expect(parseCvssVector("理由是 CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H 这么写")).toBeUndefined();
});

test("the capability answers clip the axes the model inflated", () => {
	// The production pattern: a read-only finding came back with all three
	// impact axes high, and a weak-password finding carried availability
	// impact it never had. The capabilities say what the attacker can do, and
	// the axes that contradict them are taken back.
	const inflated = metrics();
	const readOnly: ReviewCapabilities = { read: "partial", write: false, down: false, cross: false };
	const clipped = applyCapabilityLimits(inflated, readOnly);
	expect(clipped.i).toBe("N");
	expect(clipped.a).toBe("N");
	expect(clipped.s).toBe("U");
	// "partial" caps confidentiality at low: an information leak is not a total
	// loss of confidentiality.
	expect(clipped.c).toBe("L");
	expect(cvssBaseScore(clipped)).toBe(5.3);
	// The clip only ever lowers: it never invents an impact the reviewer did
	// not claim, and it leaves the axes it says nothing about alone.
	const lowImpact = metrics({ c: "L", i: "N", a: "N" });
	expect(applyCapabilityLimits(lowImpact, { read: "none", write: false, down: false, cross: false })).toEqual({
		...lowImpact,
		c: "N",
	});
});

test("the clip leaves a finding whose capabilities match its axes alone", () => {
	// Unauthenticated RCE: the attacker gets the lot, can change everything,
	// can take the service down, and the effect leaves the web app.
	const rce = metrics({ s: "C" });
	const full: ReviewCapabilities = { read: "total", write: true, down: true, cross: true };
	expect(applyCapabilityLimits(rce, full)).toEqual(rce);
	expect(cvssBaseScore(rce)).toBe(10);
});

test("a score and the vector still agree after a clip", () => {
	const clipped = applyCapabilityLimits(metrics(), { read: "partial", write: false, down: false, cross: false });
	const decoded = parseCvssMetrics(
		Object.fromEntries(
			cvssVector(clipped)
				.split("/")
				.slice(1)
				.map((part) => part.split(":")),
		),
	);
	expect(cvssBaseScore(decoded)).toBe(cvssBaseScore(clipped));
	expect(severityForCvss(cvssBaseScore(clipped))).toBe("medium");
});
