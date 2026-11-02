// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Unified Series Hierarchy
 *
 * Tests the full flow: series creation, season/episode dedup,
 * external ID enrichment, and file linking to episode-level items.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from './setup/test-database.js';
import { truncateTables, TEST_TABLES } from './helpers/cleanup.js';
import {
    findOrCreateSeries,
    findOrCreatePersonalSeason,
    findOrCreatePersonalEpisode,
} from '$lib/server/database/queries/media-items.queries.js';
import {
    upsertMediaFile,
    attachFileToItem,
} from '$lib/server/database/queries/media-files.queries.js';

describe('Unified series hierarchy (Integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media, ...TEST_TABLES.watchStatus]);
    });

    it('creates series → season → episode hierarchy and links file to episode', async () => {
        const seriesId = await findOrCreateSeries(sql, {
            title: 'The Orbit Crew',
            year: 2006,
        });
        const seasonId = await findOrCreatePersonalSeason(sql, {
            seriesId,
            seasonNumber: 1,
        });
        const { id: episodeId } = await findOrCreatePersonalEpisode(sql, {
            seasonId,
            seasonNumber: 1,
            episodeNumber: 1,
            title: 'S01E01',
        });

        const { id: fileId } = await upsertMediaFile(sql, {
            filePath: '/data/series/IT Crowd/S01E01.mkv',
        });
        await attachFileToItem(sql, fileId, episodeId);

        // Verify file is linked to episode, not series
        const linked = await sql`
            SELECT mfi.media_item_id, mi.media_type
            FROM media_file_items mfi
            JOIN media_items mi ON mi.id = mfi.media_item_id
            WHERE mfi.file_id = ${fileId}
        `;
        expect(linked).toHaveLength(1);
        expect(linked[0].media_type).toBe('episode');
    });

    it('reuses existing TMDB-synced series when external ID matches', async () => {
        // Pre-create a TMDB-synced series (as Jellyfin/TMDB sync would)
        const [tmdbSeries] = await sql`
            INSERT INTO media_items (title, media_type, year)
            VALUES ('The Orbit Crew', 'tv', 2006)
            RETURNING id
        `;
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
            VALUES (${tmdbSeries.id}, 'tmdb', '12235', 'tv', true)
        `;

        // Scanner calls findOrCreateSeries with the TMDB match
        const seriesId = await findOrCreateSeries(sql, {
            title: 'The Orbit Crew',
            year: 2006,
            externalId: { provider: 'tmdb', id: '12235', mediaType: 'tv' },
        });

        // Should reuse the existing series, not create a duplicate
        expect(seriesId).toBe(tmdbSeries.id);
    });

    it('enriches personal series with external ID on first match', async () => {
        // First scan: no TMDB match → personal series
        const seriesId1 = await findOrCreateSeries(sql, {
            title: 'The Orbit Crew',
            year: 2006,
        });

        // Second scan: TMDB matches → should find same series by title
        const seriesId2 = await findOrCreateSeries(sql, {
            title: 'The Orbit Crew',
            year: 2006,
            externalId: { provider: 'tmdb', id: '12235', mediaType: 'tv' },
        });

        expect(seriesId2).toBe(seriesId1);
    });

    it('deduplicates episodes within same season via unique constraint', async () => {
        const seriesId = await findOrCreateSeries(sql, { title: 'Test Show' });
        const seasonId = await findOrCreatePersonalSeason(sql, {
            seriesId,
            seasonNumber: 1,
        });

        const ep1 = await findOrCreatePersonalEpisode(sql, {
            seasonId,
            seasonNumber: 1,
            episodeNumber: 1,
            title: 'First',
        });
        const ep2 = await findOrCreatePersonalEpisode(sql, {
            seasonId,
            seasonNumber: 1,
            episodeNumber: 1,
            title: 'Duplicate',
        });

        expect(ep2.id).toBe(ep1.id);
    });

    it('creates episodes under TMDB series for file linking', async () => {
        // TMDB sync created enriched series + seasons
        const [tmdbSeries] = await sql`
            INSERT INTO media_items (title, media_type, year)
            VALUES ('The Orbit Crew', 'tv', 2006)
            RETURNING id
        `;
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
            VALUES (${tmdbSeries.id}, 'tmdb', '12235', 'tv', true)
        `;
        // TMDB sync also created a season
        const [tmdbSeason] = await sql`
            INSERT INTO media_items (title, media_type, parent_id, season_number)
            VALUES ('Season 1', 'season', ${tmdbSeries.id}, 1)
            RETURNING id
        `;

        // Scanner resolves series by TMDB ID, then creates episode under existing season
        const seriesId = await findOrCreateSeries(sql, {
            title: 'The Orbit Crew',
            externalId: { provider: 'tmdb', id: '12235', mediaType: 'tv' },
        });
        expect(seriesId).toBe(tmdbSeries.id);

        const seasonId = await findOrCreatePersonalSeason(sql, {
            seriesId,
            seasonNumber: 1,
        });
        expect(seasonId).toBe(tmdbSeason.id); // Reuses TMDB-created season

        const { id: episodeId } = await findOrCreatePersonalEpisode(sql, {
            seasonId,
            seasonNumber: 1,
            episodeNumber: 1,
            title: "Yesterday's Jam",
        });

        // Verify episode is under the TMDB hierarchy
        const [episode] = await sql`
            SELECT parent_id FROM media_items WHERE id = ${episodeId}
        `;
        expect(episode.parent_id).toBe(tmdbSeason.id);
    });
});
