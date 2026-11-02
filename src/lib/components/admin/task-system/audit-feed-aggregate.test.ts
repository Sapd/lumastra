// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { aggregateAuditEvents, aggregatedWindowHours } from './audit-feed-aggregate.js';
import type { AuditEventRow } from '$lib/schemas/task-system-observability.schema.js';

function row(overrides: Partial<AuditEventRow> & { id: number; ts: string }): AuditEventRow {
    return {
        category: 'reconciler',
        action: 'orphans-reclaimed',
        severity: 'info',
        summary: 'Reclaimed 3 orphaned runs',
        detail: {},
        instanceId: 'web-1',
        ...overrides,
    };
}

describe('aggregateAuditEvents', () => {
    it('collapses identical (category, action, summary) events into one group', () => {
        const events = [
            row({ id: 3, ts: '2026-07-10T12:00:00Z' }),
            row({ id: 2, ts: '2026-07-10T11:00:00Z' }),
            row({ id: 1, ts: '2026-07-10T10:00:00Z' }),
        ];
        const groups = aggregateAuditEvents(events);
        expect(groups).toHaveLength(1);
        expect(groups[0].events).toHaveLength(3);
        // newest-first
        expect(groups[0].events[0].id).toBe(3);
    });

    it('keeps distinct summaries as separate groups, sorted newest-group-first', () => {
        const events = [
            row({ id: 1, ts: '2026-07-10T09:00:00Z', summary: 'A' }),
            row({ id: 2, ts: '2026-07-10T10:00:00Z', summary: 'B' }),
        ];
        const groups = aggregateAuditEvents(events);
        expect(groups.map((g) => g.summary)).toEqual(['B', 'A']);
    });

    it('does not merge events with the same summary but different category/action', () => {
        const events = [
            row({ id: 1, ts: '2026-07-10T09:00:00Z', category: 'dispatcher', summary: 'X' }),
            row({ id: 2, ts: '2026-07-10T09:00:00Z', category: 'reconciler', summary: 'X' }),
        ];
        expect(aggregateAuditEvents(events)).toHaveLength(2);
    });

    it('returns an empty array for no events', () => {
        expect(aggregateAuditEvents([])).toEqual([]);
    });
});

describe('aggregatedWindowHours', () => {
    it('returns 1 for a single-occurrence group (never "in 0h")', () => {
        const groups = aggregateAuditEvents([row({ id: 1, ts: '2026-07-10T10:00:00Z' })]);
        expect(aggregatedWindowHours(groups[0])).toBe(1);
    });

    it('rounds the real observed span between oldest and newest occurrence', () => {
        const groups = aggregateAuditEvents([
            row({ id: 2, ts: '2026-07-10T15:00:00Z' }),
            row({ id: 1, ts: '2026-07-10T10:00:00Z' }),
        ]);
        expect(aggregatedWindowHours(groups[0])).toBe(5);
    });

    it('floors at 1h for a sub-hour burst', () => {
        const groups = aggregateAuditEvents([
            row({ id: 2, ts: '2026-07-10T10:05:00Z' }),
            row({ id: 1, ts: '2026-07-10T10:00:00Z' }),
        ]);
        expect(aggregatedWindowHours(groups[0])).toBe(1);
    });
});
