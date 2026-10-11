/**
 * Loop-hygiene detection for the loop-guard extension.
 *
 * Two failure modes, both "the run is spinning without progress":
 *
 * - A stuttering model. The stream repeats one line, or a short cycle, instead of
 *   continuing; nothing in the runtime notices, so it runs to the token limit and
 *   the repeated text then sits in the context, inviting more of the same.
 *   `StutterDetector` folds the growing text and reports where the repetition
 *   started.
 * - A tool loop: the same call with the same arguments, over and over.
 *   `RepeatChain` counts consecutive identical calls and reports the configured
 *   thresholds.
 *
 * Both are pure: no session, no I/O, so thresholds and canonicalization are
 * testable on their own.
 */

export interface StutterSignal {
	/** `lines` is the same non-blank line repeated; `cycle` is a periodic tail. */
	kind: "lines" | "cycle";
	/** The repeated text, trimmed for display. */
	preview: string;
	/** How often it had repeated when the signal tripped. */
	count: number;
	/** Offset in the scanned text where the repetition starts, for truncating it. */
	offset: number;
}

export interface StutterOptions {
	/** Consecutive identical non-blank lines that trip the detector. */
	repeatLines: number;
	/** Length of the tail window scanned for a periodic cycle. */
	cycleWindow: number;
	/** Longest repeating unit treated as a cycle. */
	cycleMaxPeriod: number;
	/** Minimum repetitions of the unit inside the window. */
	cycleMinRepeats: number;
	/** How much new text to accumulate between cycle scans. */
	cycleScanStride: number;
	/** Fraction of the window allowed to differ before a period is not a cycle. */
	cycleTolerance: number;
}

export const STUTTER_DEFAULTS: StutterOptions = {
	repeatLines: 6,
	cycleWindow: 600,
	cycleMaxPeriod: 50,
	cycleMinRepeats: 12,
	cycleScanStride: 200,
	cycleTolerance: 0.03,
};

/**
 * Watches one message's text as it streams.
 *
 * The line signal ignores blank lines: a model that repeats `Kingston.` separated
 * by blank lines is looping just as much as one that repeats it without them.
 */
export class StutterDetector {
	private readonly options: StutterOptions;
	private consumed = 0;
	private lineStart = 0;
	private previousLine: string | null = null;
	private run = 0;
	private runStart = 0;
	private lastCycleScan = 0;

	constructor(options: StutterOptions = STUTTER_DEFAULTS) {
		this.options = options;
	}

	/** Forget everything: a new message, or a run that was already interrupted. */
	reset(): void {
		this.consumed = 0;
		this.lineStart = 0;
		this.previousLine = null;
		this.run = 0;
		this.runStart = 0;
		this.lastCycleScan = 0;
	}

	/** Fold the text so far and report a repetition the first time one trips. */
	push(text: string): StutterSignal | undefined {
		for (;;) {
			const newline = text.indexOf("\n", this.consumed);
			if (newline === -1) break;
			const start = this.lineStart;
			const line = text.slice(start, newline).trim();
			this.lineStart = newline + 1;
			this.consumed = newline + 1;
			const signal = this.observeLine(line, start);
			if (signal) return signal;
		}
		if (text.length - this.lastCycleScan < this.options.cycleScanStride) return undefined;
		this.lastCycleScan = text.length;
		return this.observeCycle(text);
	}

	private observeLine(line: string, start: number): StutterSignal | undefined {
		// Blank lines are transparent: they separate the repeats in practice without
		// breaking the run.
		if (line.length < 2) return undefined;
		if (line === this.previousLine) {
			this.run += 1;
		} else {
			this.previousLine = line;
			this.run = 1;
			this.runStart = start;
		}
		if (this.run < this.options.repeatLines) return undefined;
		return { kind: "lines", preview: line.slice(0, 80), count: this.run, offset: this.runStart };
	}

	/**
	 * A periodic tail, for repetition that never reaches a newline: `**(c**(c…`, or
	 * the same sentence emitted over and over inside one paragraph.
	 */
	private observeCycle(text: string): StutterSignal | undefined {
		const { cycleWindow, cycleMaxPeriod, cycleMinRepeats, cycleTolerance } = this.options;
		if (text.length < cycleWindow) return undefined;
		const window = text.slice(-cycleWindow);
		for (let period = 1; period <= cycleMaxPeriod; period += 1) {
			if (window.length / period < cycleMinRepeats) break;
			const total = window.length - period;
			const allowed = Math.floor(total * cycleTolerance);
			let mismatches = 0;
			for (let index = period; index < window.length; index += 1) {
				if (window[index] !== window[index - period] && ++mismatches > allowed) break;
			}
			if (mismatches > allowed) continue;
			return {
				kind: "cycle",
				preview: window
					.slice(window.length - period * 3)
					.trim()
					.slice(0, 80),
				count: Math.floor(window.length / period),
				offset: Math.max(0, text.length - period * cycleMinRepeats),
			};
		}
		return undefined;
	}
}

export interface RepeatThresholdHit {
	/** The run length this call reached. */
	count: number;
	/** Canonical arguments, for quoting in the reminder. */
	canonical: string;
	/** The first configured threshold reads as a nudge, later ones as a report. */
	detailed: boolean;
}

export interface RepeatOptions {
	/** Consecutive-repeat counts that trigger a reminder. */
	thresholds: number[];
	/** Tool-name patterns to track; empty means every tool is tracked. */
	include: string[];
	/** Tool-name patterns transparent to the chain: they neither count nor reset. */
	exclude: string[];
}

export const REPEAT_DEFAULTS: RepeatOptions = { thresholds: [3, 5, 8], include: [], exclude: [] };

/**
 * One consecutive-repeat chain: the last tracked call's identity and its run
 * length. Untracked calls are transparent, so a record-keeping tool in the middle
 * of a loop does not hide it.
 */
export class RepeatChain {
	private readonly include: RegExp[];
	private readonly exclude: RegExp[];
	private readonly thresholds: Set<number>;
	private readonly firstThreshold: number;
	private key: string | null = null;
	private count = 0;

	constructor(options: RepeatOptions = REPEAT_DEFAULTS) {
		this.include = options.include.map(wildcardToRegExp);
		this.exclude = options.exclude.map(wildcardToRegExp);
		const thresholds = [...new Set(options.thresholds)].sort((a, b) => a - b);
		this.thresholds = new Set(thresholds);
		this.firstThreshold = thresholds[0] ?? 3;
	}

	reset(): void {
		this.key = null;
		this.count = 0;
	}

	/** Fold one call and report the threshold it just reached, if any. */
	observe(toolName: string, args: unknown): RepeatThresholdHit | undefined {
		if (!this.tracked(toolName)) return undefined;
		const canonical = canonicalizeArguments(args);
		const key = `${toolName}\u0000${canonical}`;
		this.count = this.key === key ? this.count + 1 : 1;
		this.key = key;
		if (!this.thresholds.has(this.count)) return undefined;
		return { count: this.count, canonical, detailed: this.count !== this.firstThreshold };
	}

	private tracked(toolName: string): boolean {
		if (this.include.length > 0 && !this.include.some((pattern) => pattern.test(toolName))) return false;
		return !this.exclude.some((pattern) => pattern.test(toolName));
	}
}

/**
 * Canonical string form of a call's arguments: deep key-sort, then stringify, so
 * two calls that differ only in property order compare equal. Arguments arrive as
 * parsed JSON, so JSON's value domain is the whole input domain.
 */
export function canonicalizeArguments(value: unknown): string {
	return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJsonValue);
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) sorted[key] = sortJsonValue(record[key]);
		return sorted;
	}
	return value;
}

/** Compile one `*`-wildcard pattern to an anchored RegExp; every other metacharacter is literal. */
export function wildcardToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`);
	return new RegExp(`^${escaped.replaceAll("*", ".*")}$`);
}
