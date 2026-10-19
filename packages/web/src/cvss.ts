/**
 * CVSS v3.1 base metrics and the official base-score formula.
 *
 * The reviewer LLM judges the eight base metrics; the score and the five-level
 * label are computed here. Asking a model for `severity` + `cvss` +
 * `cvss_vector` in one JSON object invites three internally inconsistent
 * answers, which is exactly what the hub's `severityMismatch` warning exists to
 * catch — so the model no longer gets to write a number at all.
 */

/** The eight CVSS v3.1 base metrics, each with its spec abbreviation as value. */
export interface CvssMetrics {
	av: "N" | "A" | "L" | "P";
	ac: "L" | "H";
	pr: "N" | "L" | "H";
	ui: "N" | "R";
	s: "U" | "C";
	c: "H" | "L" | "N";
	i: "H" | "L" | "N";
	a: "H" | "L" | "N";
}

const AV_WEIGHT: Record<CvssMetrics["av"], number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const AC_WEIGHT: Record<CvssMetrics["ac"], number> = { L: 0.77, H: 0.44 };
const UI_WEIGHT: Record<CvssMetrics["ui"], number> = { N: 0.85, R: 0.62 };
const IMPACT_WEIGHT: Record<CvssMetrics["c"], number> = { H: 0.56, L: 0.22, N: 0 };

/** PR depends on scope: a low-privileged attacker across a scope change is worse. */
function prWeight(pr: CvssMetrics["pr"], scopeChanged: boolean): number {
	if (pr === "N") return 0.85;
	if (pr === "L") return scopeChanged ? 0.68 : 0.62;
	return scopeChanged ? 0.5 : 0.27;
}

/** The canonical vector string, so the UI and the export always agree. */
export function cvssVector(metrics: CvssMetrics): string {
	return `CVSS:3.1/AV:${metrics.av}/AC:${metrics.ac}/PR:${metrics.pr}/UI:${metrics.ui}/S:${metrics.s}/C:${metrics.c}/I:${metrics.i}/A:${metrics.a}`;
}

/**
 * The spec's Roundup: up to one decimal, computed on integers so a score like
 * 8.6 does not come out as 8.599999999999999 and round down.
 */
function roundUp(value: number): number {
	const scaled = Math.round(value * 100000);
	return scaled % 10000 === 0 ? scaled / 100000 : (Math.floor(scaled / 10000) + 1) / 10;
}

/** CVSS v3.1 base score, 0.0-10.0, one decimal. */
export function cvssBaseScore(metrics: CvssMetrics): number {
	const scopeChanged = metrics.s === "C";
	const iss = 1 - (1 - IMPACT_WEIGHT[metrics.c]) * (1 - IMPACT_WEIGHT[metrics.i]) * (1 - IMPACT_WEIGHT[metrics.a]);
	const impact = scopeChanged ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
	if (impact <= 0) return 0;
	const exploitability =
		8.22 * AV_WEIGHT[metrics.av] * AC_WEIGHT[metrics.ac] * prWeight(metrics.pr, scopeChanged) * UI_WEIGHT[metrics.ui];
	const raw = scopeChanged ? 1.08 * (impact + exploitability) : impact + exploitability;
	return roundUp(Math.min(raw, 10));
}

/** The values the spec allows for each metric. */
const ALLOWED: Record<keyof CvssMetrics, readonly string[]> = {
	av: ["N", "A", "L", "P"],
	ac: ["L", "H"],
	pr: ["N", "L", "H"],
	ui: ["N", "R"],
	s: ["U", "C"],
	c: ["H", "L", "N"],
	i: ["H", "L", "N"],
	a: ["H", "L", "N"],
};

/**
 * The words a model reaches for when it does not use the spec's abbreviation.
 *
 * Per metric, because the same word means different things: "L" is Local for
 * AV but Low for AC, and "None" is not a valid AV at all.
 */
const VALUE_ALIASES: Record<keyof CvssMetrics, Record<string, string>> = {
	av: { network: "N", adjacent: "A", local: "L", physical: "P" },
	ac: { low: "L", high: "H" },
	pr: { none: "N", low: "L", high: "H" },
	ui: { none: "N", required: "R", "user interaction": "R", "needs interaction": "R" },
	s: { unchanged: "U", changed: "C" },
	c: { high: "H", low: "L", none: "N" },
	i: { high: "H", low: "L", none: "N" },
	a: { high: "H", low: "L", none: "N" },
};

/** The names a model uses for a metric, beyond the spec's two letters. */
const KEY_ALIASES: Record<string, keyof CvssMetrics> = {
	av: "av",
	attackvector: "av",
	ac: "ac",
	attackcomplexity: "ac",
	pr: "pr",
	privilegesrequired: "pr",
	permissionsrequired: "pr",
	ui: "ui",
	userinteraction: "ui",
	s: "s",
	scope: "s",
	scopechanged: "s",
	c: "c",
	confidentiality: "c",
	i: "i",
	integrity: "i",
	a: "a",
	availability: "a",
};

/** One metric's value, in whatever shape the model wrote it. */
function normalizeValue(metric: keyof CvssMetrics, value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (ALLOWED[metric].includes(trimmed)) return trimmed;
	return VALUE_ALIASES[metric][trimmed.toLowerCase()];
}

/**
 * The eight metrics out of a CVSS vector string.
 *
 * A vector is the other shape a model answers in, and one that is complete by
 * construction: `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H`.
 */
export function parseCvssVector(vector: string): CvssMetrics | undefined {
	const trimmed = vector.trim();
	if (!/^CVSS:3\.[01]\//i.test(trimmed)) return undefined;
	const found: Partial<Record<keyof CvssMetrics, string>> = {};
	for (const part of trimmed.split("/")) {
		const [rawKey, rawValue] = part.split(":");
		if (!rawKey || !rawValue) continue;
		const metric = KEY_ALIASES[rawKey.trim().toLowerCase()];
		if (!metric) continue;
		const value = normalizeValue(metric, rawValue);
		if (value) found[metric] = value;
	}
	const keys = Object.keys(ALLOWED) as Array<keyof CvssMetrics>;
	if (keys.some((key) => !found[key])) return undefined;
	return found as CvssMetrics;
}

/**
 * Read the eight metrics out of a model reply.
 *
 * The values are checked against the spec's allowed set, so a reply that says
 * `AV:Network` still fails loudly rather than scoring as one of the metrics.
 * What it no longer does is fail on shape: a model that answers in words, in
 * a different casing, or with a vector string instead of eight keys used to
 * lose the whole review — and the record then kept the agent's own rating as
 * if it had been checked.
 */
export function parseCvssMetrics(raw: Record<string, unknown>): CvssMetrics {
	// A vector, wherever the model put it, carries all eight metrics by itself.
	for (const value of Object.values(raw)) {
		if (typeof value !== "string") continue;
		const vector = parseCvssVector(value);
		if (vector) return vector;
	}
	const metrics: Partial<Record<keyof CvssMetrics, string>> = {};
	for (const [rawKey, rawValue] of Object.entries(raw)) {
		const metric = KEY_ALIASES[rawKey.trim().toLowerCase()];
		if (!metric || metrics[metric] !== undefined) continue;
		const value = normalizeValue(metric, rawValue);
		if (value) metrics[metric] = value;
	}
	function pick<K extends keyof CvssMetrics>(key: K): CvssMetrics[K] {
		const value = metrics[key];
		if (value === undefined) throw new Error(`CVSS 指标 ${key.toUpperCase()} 无效：undefined`);
		return value as CvssMetrics[K];
	}
	return {
		av: pick("av"),
		ac: pick("ac"),
		pr: pick("pr"),
		ui: pick("ui"),
		s: pick("s"),
		c: pick("c"),
		i: pick("i"),
		a: pick("a"),
	};
}

/**
 * What the attacker can actually do with a finding, as the reviewer reads it
 * off the evidence.
 *
 * These four answers are the part of a rating a model can get right: they ask
 * about the evidence instead of about how serious the finding sounds. The
 * impact axes are then a consequence of them, which is why they are applied in
 * code rather than trusted from the reply.
 */
export interface ReviewCapabilities {
	/** How much confidential data the attacker ends up with: none, part of it, or the lot. */
	read: "none" | "partial" | "total";
	/** Whether data or state can be changed, including by acting as someone else. */
	write: boolean;
	/** Whether the service can be made unavailable or its data destroyed. */
	down: boolean;
	/** Whether the effect leaves the security authority the finding lives in. */
	cross: boolean;
}

/**
 * Clip the impact axes to what the capabilities allow.
 *
 * Asked for eight CVSS metrics in one reply, a model tends to answer them
 * together: a finding that sounds serious gets H on all three axes, and a
 * read-only finding ends up with an integrity impact it never had — an
 * information leak rated 9.1 because nothing told it to stop. The capability
 * answers are the narrower question, so the program takes back what they
 * contradict.
 *
 * The clip only ever lowers. It never invents an impact the reviewer did not
 * claim, and it leaves every axis the capabilities do not speak about alone.
 */
export function applyCapabilityLimits(metrics: CvssMetrics, capabilities: ReviewCapabilities): CvssMetrics {
	const limited = { ...metrics };
	// Integrity needs the power to change something, availability needs the
	// power to take the service down, a scope change needs a second authority.
	if (!capabilities.write) limited.i = "N";
	if (!capabilities.down) limited.a = "N";
	if (!capabilities.cross) limited.s = "U";
	// Confidentiality follows how much confidential data actually leaks.
	if (capabilities.read === "none") limited.c = "N";
	else if (capabilities.read === "partial" && limited.c === "H") limited.c = "L";
	return limited;
}

/**
 * The highest score a finding whose evidence did not hold up may carry.
 *
 * A record the reviewer could not corroborate never climbs into the high or
 * critical bucket: the impact axes give way until the score fits, and the
 * vector is rewritten to match, so the number on the record and the vector
 * beside it never disagree.
 */
export const DUBIOUS_MAX_SCORE = 6.9;

/** The three impact axes, in the order CVSS multiplies them. */
const IMPACT_LEVELS = ["H", "L", "N"] as const;

/**
 * The highest-scoring variant of `metrics` that stays at or below `maxScore`.
 *
 * The impact axes are what a rating model inflates, so they are the ones that
 * give ground. The closest fit is returned, which keeps as much of the model's
 * own assessment as the cap allows — a finding that was already medium is
 * left untouched.
 */
export function capMetricsToScore(metrics: CvssMetrics, maxScore: number): CvssMetrics {
	if (cvssBaseScore(metrics) <= maxScore) return metrics;
	let best: CvssMetrics | undefined;
	let bestScore = -1;
	for (const c of IMPACT_LEVELS) {
		for (const i of IMPACT_LEVELS) {
			for (const a of IMPACT_LEVELS) {
				const candidate: CvssMetrics = { ...metrics, c, i, a };
				const score = cvssBaseScore(candidate);
				if (score > maxScore) continue;
				if (score > bestScore) {
					best = candidate;
					bestScore = score;
				}
			}
		}
	}
	// All three axes at N leaves only exploitability, which never exceeds 3.9,
	// so a fit always exists; the fallback only guards against a change to the
	// formula that would break that.
	return best ?? { ...metrics, c: "N", i: "N", a: "N" };
}
