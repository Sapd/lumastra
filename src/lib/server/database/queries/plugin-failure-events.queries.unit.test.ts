// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import type { FailureEventRow, FailureAggregateRow } from './plugin-failure-events.queries';

describe('plugin-failure-events types', () => {
    it('FailureEventRow accepts the documented shape', () => {
        const row: FailureEventRow = {
            id: 'uuid-here',
            plugin_id: 'tmdb-metadata',
            item_id: 'media-uuid',
            reason: 'tmdb-empty-response',
            run_id: 'job-123',
            task_run_id: null,
            occurred_at: new Date(),
        };
        expect(row.plugin_id).toBe('tmdb-metadata');
    });

    it('FailureAggregateRow accepts the documented shape', () => {
        const agg: FailureAggregateRow = {
            plugin_id: 'music-analysis',
            item_id: 'track-uuid',
            failure_count: 3,
            first_seen: new Date(),
            last_seen: new Date(),
        };
        expect(agg.failure_count).toBe(3);
    });
});
