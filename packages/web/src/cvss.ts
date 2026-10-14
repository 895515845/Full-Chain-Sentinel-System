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

/**
 * Read the eight metrics out of a model reply. Every value is checked against
 * the spec's allowed set: a reply that says `AV:Network` or `pr:H` fails the
 * review loudly instead of silently scoring as one of the metrics.
 */
export function parseCvssMetrics(raw: Record<string, unknown>): CvssMetrics {
	function pick<K extends keyof CvssMetrics>(key: K, allowed: readonly CvssMetrics[K][]): CvssMetrics[K] {
		const value = raw[key];
		if (typeof value !== "string" || !allowed.includes(value as CvssMetrics[K])) {
			throw new Error(`CVSS 指标 ${key.toUpperCase()} 无效：${String(value)}`);
		}
		return value as CvssMetrics[K];
	}
	return {
		av: pick("av", ["N", "A", "L", "P"]),
		ac: pick("ac", ["L", "H"]),
		pr: pick("pr", ["N", "L", "H"]),
		ui: pick("ui", ["N", "R"]),
		s: pick("s", ["U", "C"]),
		c: pick("c", ["H", "L", "N"]),
		i: pick("i", ["H", "L", "N"]),
		a: pick("a", ["H", "L", "N"]),
	};
}
