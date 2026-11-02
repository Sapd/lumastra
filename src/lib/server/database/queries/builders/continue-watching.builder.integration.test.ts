// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { closeTestDb, getTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    ensureTestUser,
    generateTestUserId,
} from '../../../../../../tests/integration/fixtures/index.js';
import { getContinueWatchingFromDb } from '../watch-state.queries.js';
import { getExactContinueWatchingPageFromDb } from '$lib/server/api/defs/recommendations/continue-watching-page.query.js';

interface EventFixture {
    type: 'progress' | 'mark_watched' | 'mark_unwatched' | 'completed';
    occurredAgeMinutes: number;
    recordedAgeMinutes: number;
    archived?: boolean;
    repudiated?: boolean;
}
interface RewatchFixture {
    name: string;
    visible: boolean;
    source: string | null;
    lastEventAgeMinutes?: number;
    events: EventFixture[];
}

const cases: RewatchFixture[] = [
    {
        name: 'legacy rewatch with unknown source and no retained events',
        visible: true,
        source: null,
        events: [],
    },
    {
        name: 'progress after completion with a different materialized position',
        visible: true,
        source: 'lumastra-player',
        events: [
            { type: 'completed', occurredAgeMinutes: 1440, recordedAgeMinutes: 1440 },
            { type: 'progress', occurredAgeMinutes: 10, recordedAgeMinutes: 10 },
        ],
    },
    // The completion survives only in materialized state; a backdated upload
    // proves renewed playback by recorded_at, not last_event_at/occurred_at.
    {
        name: 'progress recorded after a materialized completion despite an older occurred_at',
        visible: true,
        source: 'lumastra-offline',
        lastEventAgeMinutes: 2880,
        events: [{ type: 'progress', occurredAgeMinutes: 2880, recordedAgeMinutes: 10 }],
    },
    {
        name: 'archived progress after completion',
        visible: true,
        source: 'jellyfin-sync',
        events: [
            { type: 'completed', occurredAgeMinutes: 1440, recordedAgeMinutes: 1440 },
            { type: 'progress', occurredAgeMinutes: 10, recordedAgeMinutes: 10, archived: true },
        ],
    },
    {
        name: 'a later imported completion beats stale progress even when archived',
        visible: false,
        source: 'lumastra-player',
        events: [
            { type: 'progress', occurredAgeMinutes: 10, recordedAgeMinutes: 10 },
            {
                type: 'mark_watched',
                occurredAgeMinutes: 1440,
                recordedAgeMinutes: 5,
                archived: true,
            },
        ],
    },
    {
        name: 'a later decisive event by occurred_at still beats progress',
        visible: false,
        source: 'lumastra-player',
        events: [
            { type: 'progress', occurredAgeMinutes: 10, recordedAgeMinutes: 10 },
            { type: 'mark_unwatched', occurredAgeMinutes: 5, recordedAgeMinutes: 20 },
        ],
    },
    {
        name: 'a simultaneous decisive event beats progress',
        visible: false,
        source: 'jellyfin-sync',
        events: [
            { type: 'mark_unwatched', occurredAgeMinutes: 10, recordedAgeMinutes: 11 },
            { type: 'progress', occurredAgeMinutes: 10, recordedAgeMinutes: 10 },
        ],
    },
    {
        name: 'repudiated archived progress is not rewatch evidence',
        visible: false,
        source: 'jellyfin-sync',
        events: [
            {
                type: 'progress',
                occurredAgeMinutes: 10,
                recordedAgeMinutes: 10,
                archived: true,
                repudiated: true,
            },
        ],
    },
    {
        name: 'a repudiated decisive event does not suppress a rewatch',
        visible: true,
        source: 'lumastra-player',
        events: [
            { type: 'progress', occurredAgeMinutes: 10, recordedAgeMinutes: 10 },
            {
                type: 'mark_watched',
                occurredAgeMinutes: 5,
                recordedAgeMinutes: 5,
                archived: true,
                repudiated: true,
            },
        ],
    },
];

describe('shared Continue Watching completion filter (real PG)', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = getTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, [
            'user_media_events_archive',
            'user_media_events',
            'user_media_state',
            'user_media_flags',
            'media_file_items',
            'media_files',
            'external_ids',
            'media_items',
        ]);
    });
    afterAll(async () => {
        await truncateTables(sql, ['user_media_events_archive']);
        await closeTestDb();
    });

    it.each(cases)('$name on both the Home strip and CW page', async (fixture) => {
        const userId = generateTestUserId('cw_completion_filter');
        await ensureTestUser(sql, userId);
        const movie = await createAndInsertTestMovie(sql, { withFileItem: true });
        // One exact database timestamp keeps equality cases equal across inserts.
        const [{ anchor }] = await sql<{ anchor: string }[]>`SELECT NOW()::text AS anchor`;
        await sql`UPDATE media_items SET has_files = true WHERE id = ${movie.id}`;
        await sql`
            INSERT INTO user_media_state (user_id, media_id, is_watched, resume_position_ms,
                runtime_ms, last_watched_at, last_event_at, last_event_source)
            VALUES (${userId}, ${movie.id}, true, 1200000, 3600000,
                ${anchor}::timestamptz - INTERVAL '1 day',
                ${anchor}::timestamptz - (${fixture.lastEventAgeMinutes ?? 10} * INTERVAL '1 minute'), ${fixture.source})
        `;
        for (const event of fixture.events) {
            await sql`
                INSERT INTO ${sql(event.archived ? 'user_media_events_archive' : 'user_media_events')}
                    (id, user_id, media_id, event_type, source, position_ms, occurred_at,
                     recorded_at, repudiated_at)
                VALUES (${randomUUID()}, ${userId}, ${movie.id}, ${event.type},
                    ${fixture.source ?? 'lumastra-player'},
                    ${event.type === 'progress' ? 476056 : null},
                    ${anchor}::timestamptz - (${event.occurredAgeMinutes} * INTERVAL '1 minute'),
                    ${anchor}::timestamptz - (${event.recordedAgeMinutes} * INTERVAL '1 minute'),
                    CASE WHEN ${event.repudiated ?? false} THEN NOW() END)
            `;
        }
        const options = { userId, limit: 10, minMs: 30000, minPercent: 10, maxAgeDays: 365 };
        const strip = await getContinueWatchingFromDb.all(sql, {
            ...options,
            collapsePerSeries: true,
        });
        const page = await getExactContinueWatchingPageFromDb.all(sql, {
            ...options,
            deniedGroupIds: null,
            ageRating: null,
            page: {
                offset: 0,
                mediaTypes: null,
                staleAfterDays: 30,
                audiobookStaleAfterDays: 30,
                minProgressPercent: 10,
            },
        });
        expect(strip.map((row) => row.media_id)).toEqual(fixture.visible ? [movie.id] : []);
        expect(page.map((row) => row.media_id)).toEqual(fixture.visible ? [movie.id] : []);
    });
});
