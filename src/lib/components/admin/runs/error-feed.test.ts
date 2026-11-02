// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { aggregateErrorEvents } from './error-feed.js';
import { mergeTickerEvents } from './ticker.js';
import type { BusEvent } from '$lib/schemas/mission-control.schema.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function ev(seq: number, ts: number, over: Partial<BusEvent> = {}): BusEvent {
    return {
        seq,
        ts,
        kind: 'run.failed',
        severity: 'error',
        summary: 'trickplay-generation: timed out',
        ...over,
    };
}

describe('aggregateErrorEvents', () => {
    it('collapses identical summaries into one row with a count', () => {
        const now = 10 * DAY;
        const events = [ev(1, now - 3 * HOUR), ev(2, now - 2 * HOUR), ev(3, now - 1 * HOUR)];
        const rows = aggregateErrorEvents(events, now);
        expect(rows).toHaveLength(1);
        expect(rows[0].count).toBe(3);
        expect(rows[0].latestTs).toBe(now - 1 * HOUR);
    });

    it('keeps distinct summaries as separate rows, sorted newest-first', () => {
        const now = 10 * DAY;
        const events = [
            ev(1, now - 5 * HOUR, { summary: 'a' }),
            ev(2, now - 1 * HOUR, { summary: 'b' }),
        ];
        const rows = aggregateErrorEvents(events, now);
        expect(rows.map((r) => r.summary)).toEqual(['b', 'a']);
    });

    it('excludes events outside the window', () => {
        const now = 10 * DAY;
        const events = [ev(1, now - 25 * HOUR), ev(2, now - 1 * HOUR)];
        const rows = aggregateErrorEvents(events, now, DAY);
        expect(rows).toHaveLength(1);
        expect(rows[0].count).toBe(1);
        expect(rows[0].latestTs).toBe(now - 1 * HOUR);
    });

    it('excludes info-severity events (run.completed) — this is an error feed', () => {
        const now = 10 * DAY;
        const events = [ev(1, now - HOUR, { kind: 'run.completed', severity: 'info' })];
        expect(aggregateErrorEvents(events, now)).toHaveLength(0);
    });

    it('excludes scheduler-tick meta heartbeats via isTickerWorthy', () => {
        const now = 10 * DAY;
        const events = [
            ev(1, now - HOUR, { kind: 'meta', severity: 'warn', metaType: 'scheduler-tick' }),
        ];
        expect(aggregateErrorEvents(events, now)).toHaveLength(0);
    });

    it('does not inflate the count when the same occurrence arrives via both the seed and live path (via mergeTickerEvents)', () => {
        const now = 10 * DAY;
        // The seed row (REST audit-feed history) and a live SSE delivery of
        // the SAME real run failure — same runId, same summary, different
        // seq domains. Piped through mergeTickerEvents first (as the rail
        // does) before aggregation.
        const seed = [
            {
                seq: -7,
                ts: now - HOUR,
                kind: 'run.failed' as const,
                severity: 'error' as const,
                summary: 'trickplay-generation: timed out',
                runId: 'run-xyz',
            },
        ];
        const live = [
            {
                seq: 3,
                ts: now - HOUR + 500,
                kind: 'run.failed' as const,
                severity: 'error' as const,
                summary: 'trickplay-generation: timed out',
                runId: 'run-xyz',
            },
        ];
        const merged = mergeTickerEvents(seed, live);
        const rows = aggregateErrorEvents(merged, now);
        expect(rows).toHaveLength(1);
        expect(rows[0].count).toBe(1); // NOT 2 — same occurrence, not two failures
    });

    it('updates taskId/runId/instanceId to the MOST RECENT occurrence in a group', () => {
        const now = 10 * DAY;
        const events = [
            ev(1, now - 2 * HOUR, { runId: 'run-old' }),
            ev(2, now - 1 * HOUR, { runId: 'run-new' }),
        ];
        const rows = aggregateErrorEvents(events, now);
        expect(rows[0].runId).toBe('run-new');
        expect(rows[0].count).toBe(2);
    });
});
