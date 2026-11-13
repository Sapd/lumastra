// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Repro test for F13 — Jellyfin TotalRecordCount leak in episodes endpoint.
 *
 * Finding: Episode rows are scoped by `denied` filters, but the TotalRecordCount
 * COUNT query omits the same filter, leaking the number of hidden episodes to
 * age-restricted callers.
 *
 * Citation: src/routes/j/Shows/[seriesId]/Episodes/+server.ts:45-145
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';

const mockLogger = vi.hoisted(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => mockLogger),
    },
}));

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

describe.runIf(RUN)('F13 — Jellyfin episode count leaks denied episodes', () => {
    let sql: postgres.Sql;
    let cleanupIds: string[] = [];

    beforeAll(async () => {
        sql = getTestDb();
        try {
            await sql`SELECT 1 FROM media_items LIMIT 0`;
        } catch {
            throw new Error('media_items table missing — run db:test:migrate first');
        }
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        if (cleanupIds.length > 0) {
            await sql`DELETE FROM media_items WHERE id = ANY(${cleanupIds}::uuid[])`;
            cleanupIds = [];
        }
    });

    async function setupSeriesWithEpisodes(): Promise<{
        seriesId: string;
        seasonId: string;
        kidEpisodeId: string;
        adultEpisodeId: string;
    }> {
        const seriesId = crypto.randomUUID();
        const seasonId = crypto.randomUUID();
        const kidEpisodeId = crypto.randomUUID();
        const adultEpisodeId = crypto.randomUUID();
        cleanupIds.push(seriesId, seasonId, kidEpisodeId, adultEpisodeId);

        await sql`
            INSERT INTO media_items (id, media_type, title)
            VALUES
                (${seriesId}, 'tv', 'Repro Series'),
                (${seasonId}, 'season', 'Repro Season'),
                (${kidEpisodeId}, 'episode', 'Kid Episode'),
                (${adultEpisodeId}, 'episode', 'Adult Episode')
        `;

        // Set up hierarchy: series -> season -> episodes
        await sql`UPDATE media_items SET parent_id = ${seriesId} WHERE id = ${seasonId}`;
        await sql`UPDATE media_items SET parent_id = ${seasonId}, season_number = 1, episode_number = 1 WHERE id = ${kidEpisodeId}`;
        await sql`UPDATE media_items SET parent_id = ${seasonId}, season_number = 1, episode_number = 2, age_rating = 18 WHERE id = ${adultEpisodeId}`;

        return { seriesId, seasonId, kidEpisodeId, adultEpisodeId };
    }

    it('COUNT query matches row query when both apply the same access filters', async () => {
        const { seriesId } = await setupSeriesWithEpisodes();

        const { buildAgeRatingFilter } =
            await import('$lib/server/database/queries/builders/age-rating.builder.js');
        const ageRatingFilter = buildAgeRatingFilter(sql, {
            maxAgeRating: 8,
            allowUnrated: true,
        });

        // Fixed COUNT query — applies the same age-rating filter as the row query.
        const countResult = (await sql`
            SELECT COUNT(*) as count
            FROM media_items mi
            JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
            JOIN media_items series ON series.id = season.parent_id AND series.media_type IN ('tv', 'series')
            WHERE mi.media_type = 'episode'
              AND mi.status = 'active'
              AND series.id = ${seriesId}
              ${ageRatingFilter}
        `) as [{ count: string }];
        const totalCount = parseInt(countResult[0]?.count ?? '0', 10);

        // Row query with the same age restriction (maxAgeRating = 8).
        const rowsResult = await sql`
            SELECT mi.id
            FROM media_items mi
            JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
            JOIN media_items series ON series.id = season.parent_id AND series.media_type IN ('tv', 'series')
            WHERE mi.media_type = 'episode'
              AND mi.status = 'active'
              AND series.id = ${seriesId}
              ${ageRatingFilter}
        `;

        // After the fix: TotalRecordCount matches the number of visible rows (1).
        // The adult episode (age_rating=18) is excluded from both COUNT and rows.
        expect(totalCount).toBe(1);
        expect(rowsResult.length).toBe(1);
        expect(totalCount).toBe(rowsResult.length);
    });
});
