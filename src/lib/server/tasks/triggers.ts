// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Task triggers — pure time arithmetic (spec 2026-09-27 Part 2).
 *
 * A task's operator triggers replace its declared `schedule.every`:
 *   - interval  every N (catch-up semantics unchanged: due at lastFired + N)
 *   - daily     at HH:MM
 *   - weekly    on a weekday at HH:MM
 *   - startup   once when the server starts (no time of its own)
 *
 * The scheduler stores ONE `next_fire_at` per task; it is the earliest
 * upcoming instant over the task's timed triggers. Daily/weekly times are
 * evaluated in the process's local time zone — the container's `TZ`.
 * There is no separate Lumastra setting; the editor states the zone. Date's local
 * setters handle DST: a skipped local time moves forward, a repeated one
 * fires once.
 *
 * No I/O here, so every rule is unit-testable with a fixed clock.
 */

import type { TaskTrigger } from '$lib/schemas/task-definition.schema.js';
import { parseDurationMs } from './duration.js';

/** Shortest interval an operator may set, unless the task's own default is shorter. */
export const MIN_TRIGGER_INTERVAL_MS = 15 * 60_000;

/** A trigger that has a time of its own (everything but `startup`). */
export function isTimed(t: TaskTrigger): boolean {
    return t.kind !== 'startup';
}

export function hasStartupTrigger(triggers: readonly TaskTrigger[]): boolean {
    return triggers.some((t) => t.kind === 'startup');
}

/** IANA zone daily/weekly triggers are evaluated in. */
export function serverTimeZone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
        return 'UTC';
    }
}

/**
 * The floor for interval triggers on a task: 15 minutes, or the task's own
 * declared interval when that is shorter (a 1-minute housekeeping task may
 * keep its cadence; a library scan may not be made to run every 5 minutes on
 * a spinning-disk NAS — the reason the old control only offered presets).
 */
export function minIntervalMs(declaredEvery: string | undefined): number {
    const declared = parseDurationMs(declaredEvery);
    return declared !== null
        ? Math.min(declared, MIN_TRIGGER_INTERVAL_MS)
        : MIN_TRIGGER_INTERVAL_MS;
}

/** Why a trigger list can't be saved, or null. Assumes the zod schema already passed. */
export function validateTriggers(triggers: readonly TaskTrigger[], minMs: number): string | null {
    for (const t of triggers) {
        if (t.kind !== 'interval') continue;
        const ms = parseDurationMs(t.every);
        if (ms === null) return `'${t.every ?? ''}' is not a duration (use e.g. 30m, 6h, 1d)`;
        if (ms < minMs) return `An interval must be at least ${Math.round(minMs / 60_000)} minutes`;
    }
    return null;
}

function parseAt(at: string | undefined): { h: number; m: number } | null {
    const match = /^(\d{2}):(\d{2})$/.exec(at ?? '');
    if (!match) return null;
    const h = Number(match[1]);
    const m = Number(match[2]);
    // Out of range would make setHours roll into another day — refuse instead.
    return h < 24 && m < 60 ? { h, m } : null;
}

/** First local `HH:MM` on or after the day of `afterMs` that is strictly later than it. */
function nextDaily(at: { h: number; m: number }, afterMs: number): number {
    const d = new Date(afterMs);
    d.setHours(at.h, at.m, 0, 0);
    while (d.getTime() <= afterMs) {
        // Advance by calendar day, then re-pin the wall-clock time: adding
        // 86_400_000 ms would drift by an hour across a DST change.
        d.setDate(d.getDate() + 1);
        d.setHours(at.h, at.m, 0, 0);
    }
    return d.getTime();
}

function nextWeekly(weekday: number, at: { h: number; m: number }, afterMs: number): number {
    const d = new Date(afterMs);
    d.setHours(at.h, at.m, 0, 0);
    d.setDate(d.getDate() + ((weekday - d.getDay() + 7) % 7));
    d.setHours(at.h, at.m, 0, 0);
    while (d.getTime() <= afterMs) {
        d.setDate(d.getDate() + 7);
        d.setHours(at.h, at.m, 0, 0);
    }
    return d.getTime();
}

/**
 * The instant one trigger fires next, or null (startup, or malformed).
 *
 * Interval: `lastFiredAt + every` — may lie in the past, which makes the
 * task due now: the same catch-up the default schedule has. With no last
 * fire, the first run is one interval from `now`.
 *
 * Daily/weekly: the next occurrence strictly after `now`. A time missed while
 * the server was down is SKIPPED, never fired late (matching Jellyfin
 * behaviour; a 03:00 job must not start at 19:00 because the server
 * booted then).
 */
export function nextTriggerTime(
    t: TaskTrigger,
    now: number,
    lastFiredAt: number | null,
): number | null {
    switch (t.kind) {
        case 'interval': {
            const every = parseDurationMs(t.every);
            if (every === null) return null;
            return (lastFiredAt ?? now) + every;
        }
        case 'daily': {
            const at = parseAt(t.at);
            return at ? nextDaily(at, now) : null;
        }
        case 'weekly': {
            const at = parseAt(t.at);
            if (!at || typeof t.weekday !== 'number') return null;
            return nextWeekly(t.weekday, at, now);
        }
        case 'startup':
            return null;
    }
}

/** Earliest upcoming instant over a task's timed triggers; null when none has a time. */
export function computeNextFireAt(
    triggers: readonly TaskTrigger[],
    now: number,
    lastFiredAt: number | null,
): number | null {
    let best: number | null = null;
    for (const t of triggers) {
        const at = nextTriggerTime(t, now, lastFiredAt);
        if (at !== null && (best === null || at < best)) best = at;
    }
    return best;
}
