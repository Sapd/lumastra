// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the watch-sync pending-resolution buffer + drain.
 *
 * Proves the bug fix end-to-end against a real Postgres: a watch-state item for
 * media that is NOT yet ingested is buffered (not dropped); once the matching
 * media_item + tmdb external_id exist, the drain resolves and imports it as
 * watch state, and the buffer row is removed.
 *
 * Requires TEST_DATABASE_URL (or DATABASE_URL) on a live PostgreSQL with the
 * lumastra schema (incl. migration 16.58.0) applied.
 *
 * Run with:
 *   npm run test:integration src/lib/server/services/watch-sync-pending-drain.integration.test.ts
 *   # or against preprod:
 *   npm run test:integration -- src/lib/server/services/watch-sync-pending-drain.integration.test.ts
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    generateTestUserId,
    ensureTestUser,
} from '../../../../tests/integration/fixtures/index.js';
import { drainPendingResolution } from './watch-sync-pending-drain.service.js';
import {
    upsertPendingResolution,
    countPendingResolution,
} from '../database/queries/watch-state-pending.queries.js';
import { PENDING_MAX_AGE_MS, type PendingResolutionInsert } from './watch-sync-pending.js';

const SKIP = !process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL;

const TABLES = [
    'watch_state_pending_resolution',
    'user_media_events',
    'user_media_state',
    'user_media_flags',
    'external_ids',
    'media_items',
] as const;

function bufferRow(
    userId: string,
    tmdbId: number,
    overrides: Partial<PendingResolutionInsert> = {},
): PendingResolutionInsert {
    return {
        user_id: userId,
        provider: 'jellyfin',
        media_type: 'movie',
        provider_id: `jf-${tmdbId}`,
        tmdb_id: String(tmdbId),
        imdb_id: null,
        internal_media_id: null,
        series_tmdb_id: null,
        season_number: null,
        episode_number: null,
        is_watched: true,
        resume_position_ms: 0,
        runtime_ms: 7_200_000,
        watch_count: 1,
        last_watched_at: new Date('2026-01-01T00:00:00.000Z'),
        first_watched_at: new Date('2026-01-01T00:00:00.000Z'),
        ...overrides,
    };
}

async function stateRow(
    sql: postgres.Sql,
    userId: string,
    mediaId: string,
): Promise<{ is_watched: boolean; resume_position_ms: number } | null> {
    const rows = await sql<{ is_watched: boolean; resume_position_ms: number }[]>`
        SELECT is_watched, resume_position_ms
        FROM user_media_state
        WHERE user_id = ${userId} AND media_id = ${mediaId}
    `;
    return rows[0] ?? null;
}

describe.skipIf(SKIP)('watch-sync pending resolution drain (integration)', () => {
    let sql: postgres.Sql;
    let userId: string;

    beforeAll(async () => {
        sql = await getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TABLES]);
        userId = generateTestUserId();
        await ensureTestUser(sql, userId);
    });

    it.each([
        [3, 3],
        [1000, 100],
    ])('imports %i buffered plays capped at %i, idempotently', async (count, expected) => {
        const { id: mediaId, tmdbId } = await createAndInsertTestMovie(sql, {
            title: 'Buffered repeats',
        });
        const row = bufferRow(userId, tmdbId, { watch_count: count });
        for (let pass = 0; pass < 2; pass++) {
            await upsertPendingResolution(sql, [row]);
            await drainPendingResolution('jellyfin', { sql });
            const [state] = await sql<{ watch_count: number }[]>`
                SELECT watch_count FROM user_media_state WHERE user_id = ${userId} AND media_id = ${mediaId}
            `;
            expect(state.watch_count).toBe(expected);
        }
    });

    it('keeps an unresolved buffered item pending (media not ingested yet)', async () => {
        const tmdbId = 770001;
        await upsertPendingResolution(sql, [bufferRow(userId, tmdbId)]);

        const stats = await drainPendingResolution('jellyfin', { sql });

        expect(stats.loaded).toBe(1);
        expect(stats.imported).toBe(0);
        expect(stats.bumped).toBe(1);
        expect(stats.deleted).toBe(0);
        // Still buffered, attempts bumped — not lost.
        expect(await countPendingResolution(sql, 'jellyfin')).toBe(1);
    });

    it('treats an empty eligible audience as nobody', async () => {
        await upsertPendingResolution(sql, [bufferRow(userId, 770010)]);

        const stats = await drainPendingResolution('jellyfin', { sql, onlyUserIds: [] });

        expect(stats.loaded).toBe(0);
        expect(await countPendingResolution(sql, 'jellyfin')).toBe(1);
    });

    it('loads pending rows only for the eligible pull audience', async () => {
        const otherUserId = generateTestUserId();
        await ensureTestUser(sql, otherUserId);
        await upsertPendingResolution(sql, [
            bufferRow(userId, 770011),
            bufferRow(otherUserId, 770012),
        ]);

        const stats = await drainPendingResolution('jellyfin', {
            sql,
            onlyUserIds: [userId],
        });

        expect(stats.loaded).toBe(1);
        expect(stats.bumped).toBe(1);
        expect(await countPendingResolution(sql, 'jellyfin')).toBe(2);
    });

    it.each(['disabled_at', 'deleted_at'] as const)(
        'does not drain rows belonging to a user with %s set',
        async (column) => {
            await upsertPendingResolution(sql, [bufferRow(userId, 770013)]);
            await sql.unsafe(`UPDATE users SET ${column} = NOW() WHERE id = $1::uuid`, [userId]);

            const stats = await drainPendingResolution('jellyfin', {
                sql,
                onlyUserIds: [userId],
            });

            expect(stats.loaded).toBe(0);
            expect(await countPendingResolution(sql, 'jellyfin')).toBe(1);
        },
    );

    it('imports + removes the buffered item once the media is ingested', async () => {
        const tmdbId = 770002;
        await upsertPendingResolution(sql, [bufferRow(userId, tmdbId)]);

        // First drain: nothing resolves yet.
        await drainPendingResolution('jellyfin', { sql });
        expect(await stateRow(sql, userId, '00000000-0000-0000-0000-000000000000')).toBeNull();

        // Media is ingested now (movie + tmdb external_id).
        const { id: mediaId } = await createAndInsertTestMovie(sql, { tmdbId });

        // Second drain: resolves, imports watched state, deletes the buffer row.
        const stats = await drainPendingResolution('jellyfin', { sql });
        expect(stats.imported).toBe(1);
        expect(stats.deleted).toBe(1);
        expect(await countPendingResolution(sql, 'jellyfin')).toBe(0);

        const state = await stateRow(sql, userId, mediaId);
        expect(state?.is_watched).toBe(true);
    });

    it('resolves a buffered item by IMDB id when TMDB is absent', async () => {
        const tmdbId = 770010;
        // Buffer with NO tmdb_id, only an imdb id.
        await upsertPendingResolution(sql, [
            bufferRow(userId, tmdbId, { tmdb_id: null, imdb_id: `tt${tmdbId}` }),
        ]);

        // Nothing resolves before ingest.
        await drainPendingResolution('jellyfin', { sql });
        expect(await countPendingResolution(sql, 'jellyfin')).toBe(1);

        // Ingest the movie; createAndInsertTestMovie writes an imdb id `tt<tmdbId>`.
        const { id: mediaId } = await createAndInsertTestMovie(sql, { tmdbId });

        const stats = await drainPendingResolution('jellyfin', { sql });
        expect(stats.imported).toBe(1);
        expect(await countPendingResolution(sql, 'jellyfin')).toBe(0);
        expect((await stateRow(sql, userId, mediaId))?.is_watched).toBe(true);
    });

    it('drops an unresolved row that has aged out past the max age', async () => {
        const tmdbId = 770003;
        await upsertPendingResolution(sql, [bufferRow(userId, tmdbId)]);
        // Backdate created_at beyond the cutoff so it ages out.
        await sql`
            UPDATE watch_state_pending_resolution
            SET created_at = NOW() - (${PENDING_MAX_AGE_MS + 86_400_000} || ' milliseconds')::interval
            WHERE provider = 'jellyfin'
        `;

        const stats = await drainPendingResolution('jellyfin', { sql });

        expect(stats.dropped).toBe(1);
        expect(stats.imported).toBe(0);
        expect(await countPendingResolution(sql, 'jellyfin')).toBe(0);
    });

    it('upsert dedupes on (provider,user,media_type,provider_id) and refreshes watch fields', async () => {
        const tmdbId = 770004;
        await upsertPendingResolution(sql, [bufferRow(userId, tmdbId, { is_watched: false })]);
        await upsertPendingResolution(sql, [bufferRow(userId, tmdbId, { is_watched: true })]);

        expect(await countPendingResolution(sql, 'jellyfin')).toBe(1);
        const rows = await sql<{ is_watched: boolean; attempts: number }[]>`
            SELECT is_watched, attempts FROM watch_state_pending_resolution WHERE provider = 'jellyfin'
        `;
        expect(rows[0].is_watched).toBe(true);
        expect(rows[0].attempts).toBe(0);
    });

    it('resolves a buffered EPISODE via series-TMDB + season/episode drill-down once ingested', async () => {
        const seriesTmdb = 880001;
        // Buffer an episode whose series isn't ingested yet (tmdb/imdb absent so
        // only the drill-down can resolve it).
        await upsertPendingResolution(sql, [
            {
                user_id: userId,
                provider: 'jellyfin',
                media_type: 'episode',
                provider_id: 'jf-ep-1',
                tmdb_id: null,
                imdb_id: null,
                internal_media_id: null,
                series_tmdb_id: String(seriesTmdb),
                season_number: 2,
                episode_number: 5,
                is_watched: true,
                resume_position_ms: 0,
                runtime_ms: 1_500_000,
                watch_count: 1,
                last_watched_at: new Date('2026-01-01T00:00:00.000Z'),
                first_watched_at: new Date('2026-01-01T00:00:00.000Z'),
            },
        ]);

        // Nothing to resolve against yet.
        await drainPendingResolution('jellyfin', { sql });
        expect(await countPendingResolution(sql, 'jellyfin')).toBe(1);

        // Ingest series → season → episode (tmdb external id on the series).
        const seriesId = randomUUID();
        const seasonId = randomUUID();
        const episodeId = randomUUID();
        await sql`INSERT INTO media_items (id, title, media_type, status) VALUES (${seriesId}::uuid, 'S', 'tv', 'active')`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary) VALUES (${seriesId}::uuid, 'tmdb', ${String(seriesTmdb)}, 'tv', true)`;
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, season_number, status) VALUES (${seasonId}::uuid, 'Season 2', 'season', ${seriesId}::uuid, 2, 'active')`;
        await sql`INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number, status) VALUES (${episodeId}::uuid, 'E5', 'episode', ${seasonId}::uuid, 2, 5, 'active')`;

        const stats = await drainPendingResolution('jellyfin', { sql });
        expect(stats.imported).toBe(1);
        expect(await countPendingResolution(sql, 'jellyfin')).toBe(0);
        expect((await stateRow(sql, userId, episodeId))?.is_watched).toBe(true);
    });

    it('uses a buffered internal_media_id only once that media row exists (Strategy 0)', async () => {
        const targetId = randomUUID();
        // Buffer with ONLY a pre-resolved internal id (no tmdb/imdb), pointing at
        // media that does not exist yet.
        await upsertPendingResolution(sql, [
            {
                user_id: userId,
                provider: 'jellyfin',
                media_type: 'movie',
                provider_id: 'jf-internal-1',
                tmdb_id: null,
                imdb_id: null,
                internal_media_id: targetId,
                series_tmdb_id: null,
                season_number: null,
                episode_number: null,
                is_watched: true,
                resume_position_ms: 0,
                runtime_ms: 6_000_000,
                watch_count: 1,
                last_watched_at: new Date('2026-01-01T00:00:00.000Z'),
                first_watched_at: new Date('2026-01-01T00:00:00.000Z'),
            },
        ]);

        // Phantom UUID → NOT resolved (must not FK-fail); stays buffered.
        const first = await drainPendingResolution('jellyfin', { sql });
        expect(first.imported).toBe(0);
        expect(await countPendingResolution(sql, 'jellyfin')).toBe(1);

        // The media row is created with that exact id → now resolves.
        await sql`INSERT INTO media_items (id, title, media_type, status) VALUES (${targetId}::uuid, 'M', 'movie', 'active')`;
        const second = await drainPendingResolution('jellyfin', { sql });
        expect(second.imported).toBe(1);
        expect(await countPendingResolution(sql, 'jellyfin')).toBe(0);
        expect((await stateRow(sql, userId, targetId))?.is_watched).toBe(true);
    });
});
