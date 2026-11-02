// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    computeNextFireAt,
    minIntervalMs,
    nextTriggerTime,
    validateTriggers,
    MIN_TRIGGER_INTERVAL_MS,
} from './triggers.js';

// Local-time arithmetic: pin the zone so the expectations below are exact.
const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
    process.env.TZ = 'Europe/Berlin';
});
afterAll(() => {
    process.env.TZ = ORIGINAL_TZ;
});

/** Local wall-clock → epoch ms in the pinned zone. */
function local(y: number, mo: number, d: number, h = 0, mi = 0): number {
    return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

describe('nextTriggerTime', () => {
    it('interval: one interval after the last fire, even if that is in the past (catch-up)', () => {
        const last = local(2026, 9, 27, 1);
        expect(
            nextTriggerTime({ kind: 'interval', every: '6h' }, local(2026, 9, 27, 9), last),
        ).toBe(local(2026, 9, 27, 7));
    });

    it('interval without a previous fire: one interval from now', () => {
        const now = local(2026, 9, 27, 9);
        expect(nextTriggerTime({ kind: 'interval', every: '30m' }, now, null)).toBe(
            local(2026, 9, 27, 9, 30),
        );
    });

    it('daily: later today, else tomorrow — a missed time is skipped, never fired late', () => {
        const t = { kind: 'daily' as const, at: '03:00' };
        expect(nextTriggerTime(t, local(2026, 9, 27, 1), null)).toBe(local(2026, 9, 27, 3));
        // Booted at 19:00 after being down over 03:00 → next is tomorrow, not now.
        expect(nextTriggerTime(t, local(2026, 9, 27, 19), local(2026, 9, 25, 3))).toBe(
            local(2026, 9, 28, 3),
        );
        // Exactly at the time → strictly later, so tomorrow.
        expect(nextTriggerTime(t, local(2026, 9, 27, 3), null)).toBe(local(2026, 9, 28, 3));
    });

    it('weekly: the next matching weekday at the time', () => {
        // 2026-09-27 is a Sunday.
        const sunday4 = { kind: 'weekly' as const, weekday: 0, at: '04:00' };
        expect(nextTriggerTime(sunday4, local(2026, 9, 27, 2), null)).toBe(local(2026, 9, 27, 4));
        expect(nextTriggerTime(sunday4, local(2026, 9, 27, 5), null)).toBe(local(2026, 10, 4, 4));
        const wednesday = { kind: 'weekly' as const, weekday: 3, at: '22:30' };
        expect(nextTriggerTime(wednesday, local(2026, 9, 27, 5), null)).toBe(
            local(2026, 9, 30, 22, 30),
        );
    });

    it('daily keeps its wall-clock time across a DST change', () => {
        // Europe/Berlin leaves summer time on 2026-10-25.
        const t = { kind: 'daily' as const, at: '03:00' };
        const next = nextTriggerTime(t, local(2026, 10, 24, 12), null)!;
        expect(new Date(next).getHours()).toBe(3);
        expect(new Date(next).getDate()).toBe(25);
    });

    it('daily across spring-forward: a skipped local time moves forward, once', () => {
        // Europe/Berlin skips 02:00–03:00 on 2026-03-29.
        const t = { kind: 'daily' as const, at: '02:30' };
        const next = nextTriggerTime(t, local(2026, 3, 28, 12), null)!;
        const d = new Date(next);
        expect(d.getDate()).toBe(29);
        expect(d.getHours()).toBe(3); // 02:30 does not exist that night
        // The following day is back at 02:30, not skipped or doubled.
        const after = nextTriggerTime(t, next, null)!;
        expect(new Date(after).getDate()).toBe(30);
        expect(new Date(after).getHours()).toBe(2);
    });

    it('an out-of-range time is refused, never rolled into another day', () => {
        expect(
            nextTriggerTime({ kind: 'daily', at: '25:99' }, local(2026, 9, 27), null),
        ).toBeNull();
    });

    it('startup has no time of its own', () => {
        expect(nextTriggerTime({ kind: 'startup' }, local(2026, 9, 27), null)).toBeNull();
    });
});

describe('computeNextFireAt', () => {
    it('is the earliest over all timed triggers and ignores startup', () => {
        const now = local(2026, 9, 27, 9);
        const next = computeNextFireAt(
            [
                { kind: 'startup' },
                { kind: 'daily', at: '03:00' },
                { kind: 'interval', every: '6h' },
            ],
            now,
            local(2026, 9, 27, 8),
        );
        expect(next).toBe(local(2026, 9, 27, 14));
    });

    it('is null when only a startup trigger is set', () => {
        expect(computeNextFireAt([{ kind: 'startup' }], local(2026, 9, 27), null)).toBeNull();
    });
});

describe('interval floor', () => {
    it('is 15 minutes, or the declared interval when shorter', () => {
        expect(minIntervalMs('6h')).toBe(MIN_TRIGGER_INTERVAL_MS);
        expect(minIntervalMs('1m')).toBe(60_000);
        expect(minIntervalMs(undefined)).toBe(MIN_TRIGGER_INTERVAL_MS);
    });

    it('rejects intervals below the floor and non-durations', () => {
        const min = minIntervalMs('6h');
        expect(validateTriggers([{ kind: 'interval', every: '5m' }], min)).toMatch(/at least 15/);
        expect(validateTriggers([{ kind: 'interval', every: 'soon' }], min)).toMatch(
            /not a duration/,
        );
        expect(validateTriggers([{ kind: 'interval', every: '30m' }], min)).toBeNull();
        expect(validateTriggers([{ kind: 'daily', at: '03:00' }], min)).toBeNull();
    });
});

describe('TaskTriggerSchema', () => {
    it('accepts each kind with exactly its own fields', async () => {
        const { TaskTriggerSchema } = await import('$lib/schemas/task-definition.schema.js');
        for (const t of [
            { kind: 'interval', every: '6h' },
            { kind: 'daily', at: '03:00' },
            { kind: 'weekly', weekday: 0, at: '04:30' },
            { kind: 'startup' },
        ]) {
            expect(TaskTriggerSchema.safeParse(t).success).toBe(true);
        }
    });

    it('refuses missing and stray fields', async () => {
        const { TaskTriggerSchema } = await import('$lib/schemas/task-definition.schema.js');
        for (const t of [
            { kind: 'interval' },
            { kind: 'weekly', at: '03:00' },
            { kind: 'daily', at: '03:00', every: '6h' },
            { kind: 'startup', every: '5m' },
            { kind: 'interval', every: '6h', weekday: 2 },
            { kind: 'daily', at: '24:00' },
        ]) {
            expect(TaskTriggerSchema.safeParse(t).success).toBe(false);
        }
    });
});
