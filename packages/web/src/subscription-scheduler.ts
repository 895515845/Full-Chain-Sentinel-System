/**
 * Scheduled subscription refresh.
 *
 * A subscription URL is a moving target: the provider rotates nodes, and a
 * profile that was read once keeps working until the nodes die. The alternative
 * to refreshing is the operator remembering to press 刷新, which they will not.
 *
 * Two rules shape this:
 *
 * - **Nothing is fetched while a container starts.** The refresh runs on a timer
 *   and writes the cached nodes; a provider that is down changes nothing about
 *   what a project can start with.
 * - **A failed refresh keeps the previous nodes.** It records the error on the
 *   profile and leaves the working configuration alone, so an outage at the
 *   provider is not an outage at the console.
 */

import type { SentinelProxy } from "./protocol.ts";
import { readProxies, refreshProxySubscription } from "./proxy.ts";

/** How often the due list is checked. The granularity that matters is hours. */
const TICK_MS = 5 * 60 * 1000;

/** Hours a subscription can ask to be refreshed at. */
export const SUBSCRIPTION_INTERVALS = [0, 1, 6, 12, 24, 72] as const;

/** Clamp whatever the page sent to a value the timer can act on. */
export function normalizeIntervalHours(value: unknown): number {
	const hours = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
	return (SUBSCRIPTION_INTERVALS as readonly number[]).includes(hours) ? hours : 0;
}

/**
 * The profiles whose interval has elapsed.
 *
 * `updatedAt` is the last *successful* read, so a subscription that keeps failing
 * is retried every tick rather than being pushed out by the failure itself. The
 * tick is five minutes, so a provider that is down is retried that often — cheap,
 * and it recovers on its own.
 */
export function dueSubscriptions(proxies: SentinelProxy[], now: number): SentinelProxy[] {
	return proxies.filter((proxy) => {
		if (proxy.mode !== "subscription" || !proxy.subscription) return false;
		const hours = proxy.subscription.intervalHours;
		if (!hours || hours <= 0) return false;
		return proxy.subscription.updatedAt + hours * 3600_000 <= now;
	});
}

export class SubscriptionScheduler {
	private readonly agentDir: string;
	private readonly onRefreshed: () => void;
	private timer: ReturnType<typeof setInterval> | undefined;
	/** A refresh already running, so a slow provider cannot stack ticks. */
	private running = false;

	constructor(agentDir: string, onRefreshed: () => void) {
		this.agentDir = agentDir;
		this.onRefreshed = onRefreshed;
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.tick(), TICK_MS);
		// Do not hold the process open for a timer nobody is waiting on.
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/** One pass: refresh everything that is due, then tell the page once. */
	async tick(now = Date.now()): Promise<number> {
		if (this.running) return 0;
		const due = dueSubscriptions(readProxies(this.agentDir).proxies, now);
		if (due.length === 0) return 0;
		this.running = true;
		try {
			for (const proxy of due) {
				await refreshProxySubscription(this.agentDir, proxy.id);
			}
		} finally {
			this.running = false;
		}
		this.onRefreshed();
		return due.length;
	}
}
