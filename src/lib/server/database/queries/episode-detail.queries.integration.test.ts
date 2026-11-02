// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Episode Detail Query Module
 *
 * Tests getSeriesEpisodesWithWatchState against a real PostgreSQL test database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import { ensureTestUser } from '../../../../../tests/integration/fixtures/index.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';

import { getSeriesEpisodesWithWatchState } from './episode-detail.queries.js';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Episode Detail Queries', () => {
    let sql: postgres.Sql;
    let seriesId: string;
    let seasonId: string;
    let episodeIds: string[];
    const testUser: UserId = toUserId(randomUUID());

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await truncateTables(sql, [
            'user_media_state',
            'media_streams',
            'external_subtitle_files',
            'media_file_items',
            'media_files',
            ...TEST_TABLES.media,
        ]);
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'user_media_state',
            'media_streams',
            'external_subtitle_files',
            'media_file_items',
            'media_files',
            ...TEST_TABLES.media,
        ]);

        seriesId = crypto.randomUUID();
        seasonId = crypto.randomUUID();
        episodeIds = [crypto.randomUUID(), crypto.randomUUID()];

        // Series
        await sql`
            INSERT INTO media_items (id, title, media_type, status)
            VALUES (${seriesId}::uuid, ${'Test Series'}, 'tv', 'active')
        `;

        // Season
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, season_number, status)
            VALUES (${seasonId}::uuid, ${'Season 1'}, 'season', ${seriesId}::uuid, 1, 'active')
        `;

        // Episodes
        for (let i = 0; i < episodeIds.length; i++) {
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number, runtime_seconds, status)
                VALUES (
                    ${episodeIds[i]}::uuid,
                    ${`Episode ${i + 1}`},
                    'episode',
                    ${seasonId}::uuid,
                    1,
                    ${i + 1},
                    ${45 * 60},
                    'active'
                )
            `;
        }
    });

    // ========================================================================
    // getSeriesEpisodesWithWatchState
    // ========================================================================

    describe('getSeriesEpisodesWithWatchState', () => {
        it('inherits the series original language before episode metadata', async () => {
            await sql`INSERT INTO provider_metadata (media_id, provider, metadata) VALUES (${seriesId}, 'tmdb', '{"original_language":"ja"}'), (${episodeIds[0]}, 'tmdb', '{"original_language":"en"}')`;
            const rows = await getSeriesEpisodesWithWatchState(sql, seriesId, undefined, undefined);
            expect(rows.length).toBeGreaterThan(0);
            expect(rows.every((row) => row.original_language === 'ja')).toBe(true);
        });

        it('returns episodes for a series by internal UUID', async () => {
            const rows = await getSeriesEpisodesWithWatchState(sql, seriesId, undefined, undefined);
            expect(rows.length).toBe(2);
            expect(rows[0].season_number).toBe(1);
            expect(rows[0].episode_number).toBe(1);
            expect(rows[1].episode_number).toBe(2);
        });

        it('filters by season number when provided', async () => {
            const season2Id = crypto.randomUUID();
            const ep2s2 = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, season_number, status)
                VALUES (${season2Id}::uuid, ${'Season 2'}, 'season', ${seriesId}::uuid, 2, 'active')
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number, status)
                VALUES (${ep2s2}::uuid, ${'S2E1'}, 'episode', ${season2Id}::uuid, 2, 1, 'active')
            `;

            const rows = await getSeriesEpisodesWithWatchState(sql, seriesId, undefined, 2);
            expect(rows.length).toBe(1);
            expect(rows[0].season_number).toBe(2);
        });

        it('includes watch state when username is provided', async () => {
            await ensureTestUser(sql, testUser);
            await sql`
                INSERT INTO user_media_state (user_id, media_id, is_watched, resume_position_ms, runtime_ms, last_watched_at, last_event_at)
                VALUES (${testUser}::uuid, ${episodeIds[0]}::uuid, true, 0, ${45 * 60 * 1000}, NOW(), NOW())
            `;

            const rows = await getSeriesEpisodesWithWatchState(sql, seriesId, testUser, undefined);
            const ep1Row = rows.find((r) => r.id === episodeIds[0]);
            expect(ep1Row).toBeDefined();
            expect(ep1Row!.is_watched).toBe(true);
        });

        it('returns has_file true when media file exists', async () => {
            const fileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, created_at, updated_at)
                VALUES (${fileId}::uuid, ${'/test/ep.mkv'}, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${episodeIds[0]}::uuid)
            `;

            const rows = await getSeriesEpisodesWithWatchState(sql, seriesId, undefined, undefined);
            const ep1Row = rows.find((r) => r.id === episodeIds[0]);
            expect(ep1Row!.has_file).toBe(true);
        });

        it('returns empty array when series has no episodes', async () => {
            const emptySeriesId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${emptySeriesId}::uuid, ${'Empty Series'}, 'tv', 'active')
            `;

            const rows = await getSeriesEpisodesWithWatchState(
                sql,
                emptySeriesId,
                undefined,
                undefined,
            );
            expect(rows).toEqual([]);
        });

        it('includes audio and subtitle languages when streams exist', async () => {
            const fileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, created_at, updated_at)
                VALUES (${fileId}::uuid, ${'/test/ep.mkv'}, NOW(), NOW())
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id, is_default)
                VALUES (${fileId}::uuid, ${episodeIds[0]}::uuid, true)
            `;
            await sql`
                INSERT INTO media_streams (file_id, stream_type, language, codec, stream_index)
                VALUES
                    (${fileId}::uuid, 'audio', 'en', 'aac', 0),
                    (${fileId}::uuid, 'subtitle', 'es', 'srt', 1)
            `;

            const rows = await getSeriesEpisodesWithWatchState(sql, seriesId, undefined, undefined);
            const ep1Row = rows.find((r) => r.id === episodeIds[0]);
            expect(ep1Row!.audio_languages).toContain('en');
            expect(ep1Row!.subtitle_languages).toContain('es');
        });
    });
});
