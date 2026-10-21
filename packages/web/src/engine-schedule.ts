/**
 * Pure schedule state machine for engineering runs.
 *
 * One plan is a single absolute timeline: start, an optional pause/resume pair,
 * and an optional deadline. The manager owns the timer and the engine lifecycle;
 * this module only validates the input and answers "what is due now?" so the
 * same rules can be unit-tested without a commander or a container.
 */

import { t } from "./i18n.ts";
import type {
	SentinelEngineSchedule,
	SentinelEngineScheduleAction,
	SentinelEngineScheduleFinishReason,
	SentinelEngineScheduleInput,
} from "./protocol.ts";

/** How late a missed start may still run. Beyond this, the plan is paused. */
export const SCHEDULE_START_GRACE_MS = 10 * 60_000;

export interface DueScheduleAction {
	action: SentinelEngineScheduleAction;
	/** The planned instant, used to pick the earliest due engine first. */
	at: number;
}

function optionalTime(value: number | null | undefined, field: string): number | null {
	if (value === null || value === undefined) return null;
	if (!Number.isFinite(value)) throw new Error(t("{field}不是有效时间", { field }));
	return Math.round(value);
}

export function isValidScheduleTimezone(timezone: string): boolean {
	const value = timezone.trim();
	if (!value || value.length > 64) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

/**
 * Validate an operator's plan and attach the scheduler fields. The caller supplies
 * `now` so tests and the scheduler share one clock.
 */
export function normalizeSchedule(input: SentinelEngineScheduleInput, now: number): SentinelEngineSchedule {
	if (!input || typeof input !== "object") throw new Error(t("定时计划无效"));
	const timezone = typeof input.timezone === "string" ? input.timezone.trim() : "";
	if (!isValidScheduleTimezone(timezone)) throw new Error(t("计划时区无效，请重新打开页面后再试"));
	const startAt = optionalTime(input.startAt, t("开始时间"));
	if (startAt === null || startAt <= now) throw new Error(t("开始时间必须晚于当前时间"));
	const pauseAt = optionalTime(input.pauseAt, t("暂停时间"));
	const resumeAt = optionalTime(input.resumeAt, t("恢复时间"));
	const deadlineAt = optionalTime(input.deadlineAt, t("最晚停止时间"));
	if ((pauseAt === null) !== (resumeAt === null)) {
		throw new Error(t("暂停时间和恢复时间必须同时填写，或同时留空"));
	}
	if (pauseAt !== null && pauseAt <= startAt) throw new Error(t("暂停时间必须晚于开始时间"));
	if (resumeAt !== null && pauseAt !== null && resumeAt <= pauseAt) {
		throw new Error(t("恢复时间必须晚于暂停时间"));
	}
	if (deadlineAt !== null) {
		const lastStep = resumeAt ?? pauseAt ?? startAt;
		if (deadlineAt <= lastStep) throw new Error(t("最晚停止时间必须晚于最后一次计划动作"));
	}
	return {
		timezone,
		startAt,
		pauseAt,
		resumeAt,
		deadlineAt,
		phase: "waiting_start",
		applied: [],
		finishedReason: null,
		finishedAt: null,
	};
}

function applied(schedule: SentinelEngineSchedule, action: SentinelEngineScheduleAction): boolean {
	return schedule.applied.includes(action);
}

/** The next instant the scheduler should wake for this plan. */
export function nextScheduleAt(schedule: SentinelEngineSchedule): number | null {
	if (schedule.phase === "finished") return null;
	const times: number[] = [];
	if (schedule.phase === "waiting_start") {
		if (!applied(schedule, "start")) times.push(schedule.startAt);
	} else if (schedule.phase === "running") {
		if (schedule.deadlineAt !== null && !applied(schedule, "deadline")) times.push(schedule.deadlineAt);
		if (schedule.pauseAt !== null && !applied(schedule, "pause")) times.push(schedule.pauseAt);
	} else if (schedule.phase === "paused") {
		if (schedule.deadlineAt !== null && !applied(schedule, "deadline")) times.push(schedule.deadlineAt);
		if (schedule.resumeAt !== null && !applied(schedule, "resume")) times.push(schedule.resumeAt);
	}
	return times.length > 0 ? Math.min(...times) : null;
}

/** What the plan wants to do at or before `now`; deadline beats pause/resume. */
export function dueScheduleAction(schedule: SentinelEngineSchedule, now: number): DueScheduleAction | null {
	if (schedule.phase === "finished") return null;
	if (schedule.phase === "waiting_start") {
		if (!applied(schedule, "start") && now >= schedule.startAt) {
			return { action: "start", at: schedule.startAt };
		}
		return null;
	}
	if (schedule.deadlineAt !== null && !applied(schedule, "deadline") && now >= schedule.deadlineAt) {
		return { action: "deadline", at: schedule.deadlineAt };
	}
	if (
		schedule.phase === "running" &&
		schedule.pauseAt !== null &&
		!applied(schedule, "pause") &&
		now >= schedule.pauseAt
	) {
		return { action: "pause", at: schedule.pauseAt };
	}
	if (
		schedule.phase === "paused" &&
		schedule.resumeAt !== null &&
		!applied(schedule, "resume") &&
		now >= schedule.resumeAt
	) {
		return { action: "resume", at: schedule.resumeAt };
	}
	return null;
}

/** Advance the persisted phase after an action ran. */
export function applyScheduleAction(
	schedule: SentinelEngineSchedule,
	action: SentinelEngineScheduleAction,
	at: number,
): SentinelEngineSchedule {
	const next: SentinelEngineSchedule = {
		...schedule,
		applied: schedule.applied.includes(action) ? schedule.applied : [...schedule.applied, action],
	};
	if (action === "start" || action === "resume") return { ...next, phase: "running" };
	if (action === "pause") return { ...next, phase: "paused" };
	return { ...next, phase: "finished", finishedReason: "deadline", finishedAt: at };
}

/** Stop the plan from driving the engine again, keeping the timeline for display. */
export function finishSchedule(
	schedule: SentinelEngineSchedule,
	reason: SentinelEngineScheduleFinishReason,
	at: number,
): SentinelEngineSchedule {
	return { ...schedule, phase: "finished", finishedReason: reason, finishedAt: at };
}
