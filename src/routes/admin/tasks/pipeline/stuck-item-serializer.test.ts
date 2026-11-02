// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { serializeStuckItem } from './stuck-item-serializer.js';

describe('serializeStuckItem', () => {
    it('keeps the SQL-selected reason in the initial page/cache snapshot', () => {
        const serialized = serializeStuckItem({
            media_item_id: 'fictional-item',
            title: 'Fictional source',
            series_title: null,
            season_number: null,
            episode_number: null,
            media_type: 'movie',
            stage_id: 'probe',
            status: 'running',
            attempt: 3,
            reason: 'running_stale',
            last_error: null,
            stuck_since: new Date('2026-10-25T10:00:00.000Z'),
            stuck_age_sec: 900,
        });

        expect(serialized.reason).toBe('running_stale');
        expect(serialized.stuck_since).toBe('2026-10-25T10:00:00.000Z');
    });
});
