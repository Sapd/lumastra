// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the Mission Control error-ticker pure transforms (Slice 4 §9
 * "ticker filter"): audit-row → BusEvent mapping + the seed/live merge.
 */

import { describe, it, expect } from 'vitest';
import { auditRowToBusEvent, isTickerWorthy, mergeTickerEvents } from './ticker.js';
import type { BusEvent } from '$lib/schemas/mission-control.schema.js';
import type { AuditEventRow } from '$lib/schemas/task-system-observability.schema.js';

function auditRow(over: Partial<AuditEventRow> = {}): AuditEventRow {
    return {
        id: 42,
        ts: '2026-06-03T10:00:00.000Z',
        instanceId: 'web-1',
        category: 'reconciler',
        action: 'reclaim',
        severity: 'warn',
        summary: 'reclaimed orphan',
        detail: {},
        ...over,
    };
}

function busEvent(seq: number, ts: number, over: Partial<BusEvent> = {}): BusEvent {
    return {
        seq,
        ts,
        kind: 'run.failed',
        severity: 'error',
        summary: `e${seq}`,
        ...over,
    };
}

describe('auditRowToBusEvent', () => {
    it('maps fields and uses a negative seq so history sorts before live', () => {
        const ev = auditRowToBusEvent(auditRow({ detail: { taskId: 't1', runId: 'r1' } }));
        expect(ev.seq).toBe(-42);
        expect(ev.kind).toBe('meta');
        expect(ev.severity).toBe('warn');
        expect(ev.summary).toBe('reclaimed orphan');
        expect(ev.taskId).toBe('t1');
        expect(ev.runId).toBe('r1');
        expect(ev.instanceId).toBe('web-1');
        expect(ev.ts).toBe(Date.parse('2026-06-03T10:00:00.000Z'));
    });

    it('tolerates an unparseable ts (→ 0) and missing detail ids', () => {
        const ev = auditRowToBusEvent(auditRow({ ts: 'not-a-date', detail: {} }));
        expect(ev.ts).toBe(0);
        expect(ev.taskId).toBeUndefined();
        expect(ev.runId).toBeUndefined();
    });
});

describe('mergeTickerEvents', () => {
    it('merges seed + live newest-first and de-dupes by seq', () => {
        const seed = [busEvent(-1, 100, { kind: 'meta' }), busEvent(-2, 50, { kind: 'meta' })];
        const live = [busEvent(0, 200), busEvent(1, 300)];
        const merged = mergeTickerEvents(seed, live);
        expect(merged.map((e) => e.seq)).toEqual([1, 0, -1, -2]); // ts desc
    });

    it('caps the output to the given limit, keeping newest', () => {
        const live: BusEvent[] = [];
        for (let i = 0; i < 100; i++) live.push(busEvent(i, i));
        const merged = mergeTickerEvents([], live, 10);
        expect(merged).toHaveLength(10);
        expect(merged[0].ts).toBe(99); // newest first
        expect(merged[9].ts).toBe(90);
    });

    it('ties broken by seq desc (live > seed at equal ts)', () => {
        const merged = mergeTickerEvents(
            [busEvent(-5, 100, { kind: 'meta' })],
            [busEvent(7, 100)],
            10,
        );
        expect(merged.map((e) => e.seq)).toEqual([7, -5]);
    });

    it('de-dupes the SAME run.failed occurrence delivered via both seed and live (identity, not seq)', () => {
        // Same real failure, two representations: a seed row (negative,
        // row-id-derived seq, DB-write ts) and a live SSE delivery (positive,
        // client-assigned seq, later client-receipt ts). Both carry the same
        // runId — the previous by-seq dedup let both survive (seq domains
        // never intersect); identity-based dedup keeps only one.
        const seed = [
            busEvent(-10, 1000, {
                kind: 'run.failed',
                runId: 'run-abc',
                taskId: 'trickplay-generation',
                summary: 'Trickplay Generation: timed out',
            }),
        ];
        const live = [
            busEvent(5, 1300, {
                kind: 'run.failed',
                runId: 'run-abc',
                taskId: 'trickplay-generation',
                summary: 'Trickplay Generation: timed out',
            }),
        ];
        const merged = mergeTickerEvents(seed, live);
        expect(merged).toHaveLength(1);
        // Live representation wins the identity slot.
        expect(merged[0].seq).toBe(5);
    });

    it('keeps two DIFFERENT runs failing with an identical summary as separate rows', () => {
        const seed = [
            busEvent(-1, 1000, { kind: 'run.failed', runId: 'run-a', summary: 'timed out' }),
        ];
        const live = [
            busEvent(1, 1300, { kind: 'run.failed', runId: 'run-b', summary: 'timed out' }),
        ];
        const merged = mergeTickerEvents(seed, live);
        expect(merged.map((e) => e.runId).sort()).toEqual(['run-a', 'run-b']);
    });

    it('de-dupes a run-less meta occurrence seen on both paths within the coarse time bucket', () => {
        const seed = [
            busEvent(-20, 5_000, {
                kind: 'meta',
                taskId: undefined,
                summary: 'Reconciler reclaimed 2 orphan(s)',
            }),
        ];
        const live = [
            busEvent(9, 5_800, {
                kind: 'meta',
                taskId: undefined,
                summary: 'Reconciler reclaimed 2 orphan(s)',
            }),
        ];
        const merged = mergeTickerEvents(seed, live);
        expect(merged).toHaveLength(1);
    });

    it('keeps genuinely-separate repeats of the same meta summary distinct once outside the bucket', () => {
        const live = [
            busEvent(1, 0, { kind: 'meta', summary: 'Reconciler reclaimed 2 orphan(s)' }),
            // 30s later — the reconciler's own tick interval — a real repeat.
            busEvent(2, 30_000, { kind: 'meta', summary: 'Reconciler reclaimed 2 orphan(s)' }),
        ];
        const merged = mergeTickerEvents([], live);
        expect(merged).toHaveLength(2);
    });

    it('suppresses pure-heartbeat scheduler-tick meta events but keeps real actions', () => {
        const tick = busEvent(1, 100, {
            kind: 'meta',
            severity: 'info',
            metaType: 'scheduler-tick',
        });
        const reclaim = busEvent(2, 200, {
            kind: 'meta',
            severity: 'warn',
            metaType: 'orphans-reclaimed',
        });
        const fail = busEvent(3, 300, {
            kind: 'run.failed',
            severity: 'error',
        });
        const merged = mergeTickerEvents([], [tick, reclaim, fail]);
        expect(merged.map((e) => e.seq)).toEqual([3, 2]); // scheduler-tick dropped
    });
});

describe('isTickerWorthy', () => {
    it('drops scheduler-tick meta, keeps other meta and run events', () => {
        expect(isTickerWorthy(busEvent(1, 1, { kind: 'meta', metaType: 'scheduler-tick' }))).toBe(
            false,
        );
        expect(
            isTickerWorthy(busEvent(2, 1, { kind: 'meta', metaType: 'orphans-reclaimed' })),
        ).toBe(true);
        expect(isTickerWorthy(busEvent(3, 1, { kind: 'meta' }))).toBe(true); // no metaType
        expect(isTickerWorthy(busEvent(4, 1, { kind: 'run.failed' }))).toBe(true);
    });
});
