// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import { getTestDatabaseUrl } from '../../../../tests/integration/setup/test-database.js';
import { truncateAllTestTables } from '../../../../tests/integration/helpers/cleanup.js';

// Mock ONLY the TMDB client so loadTmdbCatalog returns a fixed catalog (no
// network) - same pattern as episode-reconciliation.apply.integration.test.ts.
const mockCatalogHolder = {
    failSecondSeason: false,
    onFetch: undefined as (() => Promise<void>) | undefined,
    episodes: [] as {
        id: number;
        name: string;
        overview: string;
        seasonNumber: number;
        episodeNumber: number;
        stillPath: string | null;
    }[],
};

vi.mock('$lib/server/providers/implementations/tmdb/index.js', async (importActual) => {
    const actual =
        await importActual<typeof import('$lib/server/providers/implementations/tmdb/index.js')>();
    const mockClient = {
        isAvailable: () => true,
        getTVShowSeasons: async () => [
            ...(mockCatalogHolder.failSecondSeason ? [{ seasonNumber: 2, episodeCount: 1 }] : []),
            {
                seasonNumber: 1,
                episodeCount: mockCatalogHolder.episodes.length,
            },
        ],
        getSeasonEpisodes: async (_id: string, season: number) => {
            if (season === 2) throw new Error('invented provider outage');
            await mockCatalogHolder.onFetch?.();
            return mockCatalogHolder.episodes;
        },
        getSeasonEpisodesInLanguage: async () => [],
    };
    return {
        ...actual,
        tmdbApi: mockClient,
        createTMDBApi: () => mockClient,
    };
});

const URL = getTestDatabaseUrl();

describe('automatically retiring obsolete reconciliation warnings', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = postgres(URL, { max: 2 });
    });
    beforeEach(async () => {
        await truncateAllTestTables(sql);
        mockCatalogHolder.failSecondSeason = false;
        mockCatalogHolder.onFetch = undefined;
        mockCatalogHolder.episodes = [
            {
                id: 990501,
                name: 'The Clockmaker Calls',
                overview: 'A brass bell',
                seasonNumber: 1,
                episodeNumber: 1,
                stillPath: null,
            },
        ];
    });
    afterAll(async () => {
        await sql.end();
    });

    async function fixture(
        chapter = 'Main',
    ): Promise<{ seriesId: string; episodeId: string; fileId: string; warningId: string }> {
        const { quarantineWrite } =
            await import('$lib/server/database/queries/sync-quarantine.queries.js');
        const [{ id: seriesId }] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title, media_type, status) VALUES ('Brass Lantern Dispatch', 'tv', 'active') RETURNING id`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type) VALUES (${seriesId}, 'tmdb', '990500', 'tv')`;
        const [{ id: seasonId }] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title, media_type, parent_id, season_number, status) VALUES ('Season 1', 'season', ${seriesId}, 1, 'active') RETURNING id`;
        const [{ id: episodeId }] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, status) VALUES ('Old Brass Story', 'episode', ${seasonId}, 1, 1, 'active') RETURNING id`;
        const [{ id: fileId }] = await sql<
            { id: string }[]
        >`INSERT INTO media_files (file_path) VALUES (${`/test/${seriesId}/Brass Lantern - S01E01 - Episode 51.mkv`}) RETURNING id`;
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default) VALUES (${episodeId}, ${fileId}, true)`;
        await sql`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source) VALUES (${fileId}, 0, ${chapter}, 0, 'file')`;
        const warningId = await quarantineWrite(sql, {
            provider: 'lumastra-reconcile',
            externalId: episodeId,
            mediaType: 'episode',
            expectedSeriesId: seriesId,
            payload: {
                seriesMediaId: seriesId,
                proposedTitle: 'Old Clockmaker Story',
                matchedTmdbEpisodeId: '990599',
            },
            reason: 'reconcile-backfill:matched',
            source: 'fixture',
        });
        return { seriesId, episodeId, fileId, warningId };
    }

    it('closes a warning whose supporting proposal disappeared without deleting its evidence', async () => {
        const { reevaluateQuarantineBacklog } = await import('./episode-reconciliation.service.js');
        const { warningId } = await fixture();
        const [before] =
            await sql`SELECT payload, reason FROM sync_quarantine WHERE id = ${warningId}`;
        await reevaluateQuarantineBacklog(sql, { cap: 10 });
        const [after] = await sql`SELECT * FROM sync_quarantine WHERE id = ${warningId}`;
        expect(after.resolved_at).toBeInstanceOf(Date);
        expect(after.resolution).toBe('dismissed');
        expect(after.resolved_by).toContain('superseded');
        expect(after.payload).toEqual(before.payload);
        expect(after.reason).toBe(before.reason);
    });

    it('keeps a real low confidence proposal open', async () => {
        const { backfillReconcileSeries } = await import('./episode-reconciliation.service.js');
        const { seriesId, warningId } = await fixture('The Clockmaker Call');
        await backfillReconcileSeries(sql, seriesId, { minConfidence: 1 });
        const [after] =
            await sql`SELECT resolved_at, payload FROM sync_quarantine WHERE id = ${warningId}`;
        expect(after.resolved_at).toBeNull();
        expect(after.payload.matchedTmdbEpisodeId).toBe('990501');
    });

    it.each([
        'empty catalog',
        'partial catalog',
        'rewritten warning',
        'changed file',
        'locked episode',
    ])('keeps warnings open for %s', async (kind) => {
        const { backfillReconcileSeries } = await import('./episode-reconciliation.service.js');
        const { seriesId, episodeId, fileId, warningId } = await fixture();
        if (kind === 'partial catalog') mockCatalogHolder.failSecondSeason = true;
        if (kind === 'empty catalog') mockCatalogHolder.episodes = [];
        if (kind === 'locked episode')
            await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${episodeId}`;
        mockCatalogHolder.onFetch = async () => {
            mockCatalogHolder.onFetch = undefined;
            if (kind === 'rewritten warning')
                await sql`UPDATE sync_quarantine SET source = 'concurrent-review' WHERE id = ${warningId}`;
            if (kind === 'changed file')
                await sql`UPDATE media_files SET file_path = file_path || '.changed' WHERE id = ${fileId}`;
        };
        await backfillReconcileSeries(sql, seriesId, { minConfidence: 1 });
        const [after] = await sql`SELECT resolved_at FROM sync_quarantine WHERE id = ${warningId}`;
        expect(after.resolved_at).toBeNull();
    });
});
