// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for schedule countdown / overdue detection (Slice 1).
 *
 * Pure function — no DB — runs in the standard unit suite.
 */

import { describe, it, expect } from 'vitest';
import { computeScheduleOverdue, SCHEDULE_OVERDUE_GRACE_MS } from './schedule-overdue.js';
import type { SchedulerState } from '$lib/server/tasks/scheduler-state.js';

const NOW = Date.parse('2026-06-02T14:00:00Z');

function state(over: Partial<SchedulerState> = {}): SchedulerState {
    return {
        taskId: 'task-a',
        lastFiredAt: new Date(NOW - 600_000),
        nextFireAt: new Date(NOW + 60_000),
        paused: false,
        pausedBy: null,
        pausedAt: null,
        ...over,
    };
}

describe('computeScheduleOverdue', () => {
    it('past next_fire_at beyond grace, not paused → overdue', () => {
        const past = new Date(NOW - SCHEDULE_OVERDUE_GRACE_MS - 120_000);
        const [view] = computeScheduleOverdue([state({ nextFireAt: past })], NOW);
        expect(view.overdue).toBe(true);
        expect(view.overdueByMs).toBeGreaterThan(0);
        expect(view.countdownMs).toBe(0);
    });

    it('within grace → not overdue', () => {
        // 30s past next_fire_at, well within the 60s grace.
        const recent = new Date(NOW - 30_000);
        const [view] = computeScheduleOverdue([state({ nextFireAt: recent })], NOW);
        expect(view.overdue).toBe(false);
        expect(view.overdueByMs).toBe(0);
    });

    it('paused & past due → not overdue', () => {
        const past = new Date(NOW - SCHEDULE_OVERDUE_GRACE_MS - 120_000);
        const [view] = computeScheduleOverdue([state({ nextFireAt: past, paused: true })], NOW);
        expect(view.overdue).toBe(false);
        // overdueByMs is still computed (grace-banded), only `overdue` is gated.
        expect(view.overdueByMs).toBeGreaterThan(0);
    });

    it('future next_fire_at → countdownMs > 0, not overdue', () => {
        const [view] = computeScheduleOverdue(
            [state({ nextFireAt: new Date(NOW + 134_000) })],
            NOW,
        );
        expect(view.countdownMs).toBe(134_000);
        expect(view.overdue).toBe(false);
    });

    it('no rows → empty array', () => {
        expect(computeScheduleOverdue([], NOW)).toEqual([]);
    });

    it('resolves resourceClass from the provided map; null when absent', () => {
        const map = new Map([['task-a', 'bulk']]);
        const [withClass] = computeScheduleOverdue([state()], NOW, undefined, map);
        expect(withClass.resourceClass).toBe('bulk');

        const [withoutClass] = computeScheduleOverdue(
            [state({ taskId: 'task-z' })],
            NOW,
            undefined,
            map,
        );
        expect(withoutClass.resourceClass).toBe(null);
    });

    describe('orphan filtering via scheduledTaskIds', () => {
        const overdue = () =>
            state({ nextFireAt: new Date(NOW - SCHEDULE_OVERDUE_GRACE_MS - 120_000) });

        it('drops rows whose task id is not in the scheduled set (renamed/removed task)', () => {
            // `arr-calendar-sync`-style orphan: stale row, no matching registered task.
            const views = computeScheduleOverdue(
                [overdue()],
                NOW,
                undefined,
                undefined,
                new Set(['some-other-task']),
            );
            expect(views).toEqual([]);
        });

        it('keeps rows whose task id IS in the scheduled set', () => {
            const views = computeScheduleOverdue(
                [overdue()],
                NOW,
                undefined,
                undefined,
                new Set(['task-a']),
            );
            expect(views).toHaveLength(1);
            expect(views[0].overdue).toBe(true);
        });

        it('fails OPEN when the set is undefined (registry not populated)', () => {
            const [view] = computeScheduleOverdue(
                [overdue()],
                NOW,
                undefined,
                undefined,
                undefined,
            );
            expect(view.overdue).toBe(true);
        });

        it('empty set drops everything (all tasks unscheduled)', () => {
            expect(
                computeScheduleOverdue([overdue()], NOW, undefined, undefined, new Set()),
            ).toEqual([]);
        });
    });

    it('serializes lastFiredAt to ISO or null', () => {
        const [fired] = computeScheduleOverdue([state({ lastFiredAt: new Date(NOW) })], NOW);
        expect(fired.lastFiredAt).toBe('2026-06-02T14:00:00.000Z');
        const [never] = computeScheduleOverdue([state({ lastFiredAt: null })], NOW);
        expect(never.lastFiredAt).toBe(null);
    });
});
