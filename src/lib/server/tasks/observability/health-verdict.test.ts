// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the rollup health verdict (Slice 1).
 *
 * Pure function — no DB/Valkey — so this runs in the standard unit suite.
 */

import { describe, it, expect } from 'vitest';
import {
    computeHealthVerdict,
    deriveValkeyAvailable,
    type HealthVerdictInputs,
    type InvariantFinding,
} from './health-verdict.js';
import type { ClassLeader, HeartbeatView } from '$lib/schemas/task-system-observability.schema.js';
import type { ScheduleOverdueView } from '$lib/schemas/task-system-health.schema.js';

function hb(name: string, over: Partial<HeartbeatView> = {}): HeartbeatView {
    return { name, alive: true, ...over };
}

function leader(resourceClass: string, holder: string | null, ttlMs: number | null): ClassLeader {
    return {
        resourceClass,
        holderInstanceId: holder,
        heldByThisReplica: holder === 'web-1',
        ttlMs,
    };
}

function sched(over: Partial<ScheduleOverdueView> = {}): ScheduleOverdueView {
    return {
        taskId: 'some-task',
        resourceClass: 'io',
        nextFireAt: new Date().toISOString(),
        lastFiredAt: null,
        paused: false,
        overdueByMs: 0,
        countdownMs: 60_000,
        overdue: false,
        ...over,
    };
}

function finding(status: InvariantFinding['status'], id = 'inv'): InvariantFinding {
    return { status, id, label: `${id} label` };
}

const ALIVE_SUBSYSTEMS = [hb('scheduler'), hb('reconciler')];
const HELD_LEADERS = [leader('cpu', 'web-1', 4_000), leader('io', 'web-1', 4_000)];

function base(over: Partial<HealthVerdictInputs> = {}): HealthVerdictInputs {
    return {
        heartbeats: ALIVE_SUBSYSTEMS,
        leaders: HELD_LEADERS,
        schedules: [],
        invariants: [],
        inputsAvailable: { valkey: true, db: true },
        now: Date.parse('2026-06-02T14:00:00Z'),
        ...over,
    };
}

describe('computeHealthVerdict', () => {
    it('all-healthy inputs → healthy with empty reasons', () => {
        const v = computeHealthVerdict(base());
        expect(v.status).toBe('healthy');
        expect(v.reasons).toEqual([]);
        expect(v.generatedAt).toBe('2026-06-02T14:00:00.000Z');
    });

    it('one dead required heartbeat → unhealthy + subsystem-dead', () => {
        const v = computeHealthVerdict(
            base({
                heartbeats: [hb('scheduler', { alive: false, ageMs: 240_000 }), hb('reconciler')],
            }),
        );
        expect(v.status).toBe('unhealthy');
        expect(
            v.reasons.some((r) => r.code === 'subsystem-dead' && r.subsystem === 'scheduler'),
        ).toBe(true);
    });

    it('a degraded heartbeat → degraded + subsystem-degraded', () => {
        const v = computeHealthVerdict(
            base({
                heartbeats: [hb('scheduler'), hb('pending-write-drain', { status: 'degraded' })],
            }),
        );
        expect(v.status).toBe('degraded');
        expect(v.reasons.some((r) => r.code === 'subsystem-degraded')).toBe(true);
    });

    it('a class with no leader → unhealthy + class-no-leader', () => {
        const v = computeHealthVerdict({
            ...base(),
            leaders: [leader('cpu', null, null), leader('io', 'web-1', 4_000)],
        });
        expect(v.status).toBe('unhealthy');
        expect(
            v.reasons.some((r) => r.code === 'class-no-leader' && r.subsystem === 'leader:cpu'),
        ).toBe(true);
    });

    it('a leader ttl below the warn threshold → degraded + leader-expiring', () => {
        const v = computeHealthVerdict({
            ...base(),
            leaders: [leader('cpu', 'web-1', 500), leader('io', 'web-1', 4_000)],
        });
        expect(v.status).toBe('degraded');
        expect(v.reasons.some((r) => r.code === 'leader-expiring')).toBe(true);
    });

    it('a red finding → unhealthy + invariant-red', () => {
        const v = computeHealthVerdict(base({ invariants: [finding('red', 'stuck-stage')] }));
        expect(v.status).toBe('unhealthy');
        expect(v.reasons.some((r) => r.code === 'invariant-red')).toBe(true);
    });

    it('an amber finding → degraded + invariant-amber', () => {
        const v = computeHealthVerdict(base({ invariants: [finding('amber')] }));
        expect(v.status).toBe('degraded');
        expect(v.reasons.some((r) => r.code === 'invariant-amber')).toBe(true);
    });

    it('an unknown finding → degraded + invariant-unknown', () => {
        const v = computeHealthVerdict(base({ invariants: [finding('unknown', 'stuck-running')] }));
        expect(v.status).toBe('degraded');
        expect(v.reasons.some((r) => r.code === 'invariant-unknown')).toBe(true);
    });

    it('an overdue schedule → degraded + schedule-overdue', () => {
        const v = computeHealthVerdict(
            base({
                schedules: [sched({ overdue: true, overdueByMs: 360_000 })],
            }),
        );
        expect(v.status).toBe('degraded');
        expect(v.reasons.some((r) => r.code === 'schedule-overdue')).toBe(true);
    });

    it('a paused-overdue schedule emits no reason (overdue:false)', () => {
        // The schedule-overdue helper sets overdue:false for paused; the verdict
        // only reads `overdue`. A paused row with overdueByMs but overdue:false
        // must not produce a reason.
        const v = computeHealthVerdict(
            base({
                schedules: [
                    sched({
                        paused: true,
                        overdue: false,
                        overdueByMs: 360_000,
                    }),
                ],
            }),
        );
        expect(v.status).toBe('healthy');
        expect(v.reasons).toEqual([]);
    });

    it('valkey unreadable → unknown with a single inputs-unreadable reason', () => {
        const v = computeHealthVerdict(
            base({
                inputsAvailable: { valkey: false, db: true },
                // Spurious dead subsystems must NOT surface when valkey is down.
                heartbeats: [hb('scheduler', { alive: false })],
            }),
        );
        expect(v.status).toBe('unknown');
        expect(v.reasons).toHaveLength(1);
        expect(v.reasons[0].code).toBe('inputs-unreadable');
        expect(v.reasons.some((r) => r.code === 'subsystem-dead')).toBe(false);
    });

    it('db unreadable → unknown with a single inputs-unreadable reason', () => {
        const v = computeHealthVerdict(base({ inputsAvailable: { valkey: true, db: false } }));
        expect(v.status).toBe('unknown');
        expect(v.reasons[0].code).toBe('inputs-unreadable');
    });

    it('worst-wins: simultaneous warn + error → unhealthy, reasons error-first', () => {
        const v = computeHealthVerdict(
            base({
                heartbeats: [hb('scheduler', { alive: false })],
                invariants: [finding('amber')],
            }),
        );
        expect(v.status).toBe('unhealthy');
        expect(v.reasons[0].severity).toBe('error');
        // Last reason should be the warn one.
        expect(v.reasons[v.reasons.length - 1].severity).toBe('warn');
    });
});

describe('deriveValkeyAvailable', () => {
    it('valkey component ok → available (true)', () => {
        expect(
            deriveValkeyAvailable({
                valkey: { status: 'pass' },
                database: { status: 'pass' },
            }),
        ).toBe(true);
    });

    it('valkey component failing PING → unavailable (false) — regression: a Valkey outage previously mis-reported as unhealthy', () => {
        expect(
            deriveValkeyAvailable({
                valkey: { status: 'fail' },
                database: { status: 'pass' },
            }),
        ).toBe(false);
    });

    it('valkey component missing → unavailable (false)', () => {
        expect(deriveValkeyAvailable({ database: { status: 'pass' } })).toBe(false);
    });

    it('end-to-end: a Valkey outage routes to unknown, not unhealthy', () => {
        // Mirrors the endpoint: derive the flag from components, feed the verdict.
        const components = { valkey: { status: 'fail' }, database: { status: 'pass' } };
        const v = computeHealthVerdict(
            base({
                // Readers returned "dead" views because Valkey is down…
                heartbeats: [hb('scheduler', { alive: false })],
                // …but the authoritative PING flag makes it `unknown`, not `unhealthy`.
                inputsAvailable: {
                    valkey: deriveValkeyAvailable(components),
                    db: true,
                },
            }),
        );
        expect(v.status).toBe('unknown');
        expect(v.reasons[0].code).toBe('inputs-unreadable');
        expect(v.reasons.some((r) => r.code === 'subsystem-dead')).toBe(false);
    });
});
