// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the sync-quarantine self-draining re-evaluation pass
 * (`reevaluateQuarantineBacklog`) and the bulk-triage "accept" action
 * (`acceptQuarantinedMatchesForSeries`) — see deliverable 2 / deliverable 1
 * of the sync-quarantine review queue long-term fix.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { getTestDatabaseUrl } from '../../../../tests/integration/setup/test-database.js';
import { truncateAllTestTables } from '../../../../tests/integration/helpers/cleanup.js';

// Mock ONLY the TMDB client so loadTmdbCatalog returns a fixed catalog (no
// network) — same technique as episode-reconciliation.apply.integration.test.ts.
const mockCatalogHolder = {
    episodes: [
        {
            id: 88001,
            name: 'The Confident Match',
            overview: 'O1',
            seasonNumber: 1,
            episodeNumber: 1,
        },
    ] as {
        id: number;
        name: string;
        overview: string;
        seasonNumber: number;
        episodeNumber: number;
    }[],
};

vi.mock('$lib/server/providers/implementations/tmdb/index.js', async (importActual) => {
    const actual =
        await importActual<typeof import('$lib/server/providers/implementations/tmdb/index.js')>();
    const mockClient = {
        isAvailable: () => true,
        getTVShowSeasons: async () => [
            { seasonNumber: 1, episodeCount: mockCatalogHolder.episodes.length },
        ],
        getSeasonEpisodes: async () => mockCatalogHolder.episodes,
        getSeasonEpisodesInLanguage: async () => [],
    };
    return {
        ...actual,
        tmdbApi: mockClient,
        createTMDBApi: () => mockClient,
    };
});

const URL = getTestDatabaseUrl();

describe('reevaluateQuarantineBacklog + acceptQuarantinedMatchesForSeries (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = postgres(URL, { max: 2 });
        await truncateAllTestTables(sql);
    });
    afterAll(async () => {
        await sql.end();
    });

    it('dismisses a quarantine row whose episode row no longer exists', async () => {
        const { reevaluateQuarantineBacklog } = await import('./episode-reconciliation.service.js');
        const { quarantineWrite, getQuarantineById } =
            await import('$lib/server/database/queries/sync-quarantine.queries.js');

        const ghostEpisodeId = randomUUID();
        const id = await quarantineWrite(sql, {
            provider: 'lumastra-reconcile',
            externalId: ghostEpisodeId,
            mediaType: 'episode',
            payload: { seriesMediaId: randomUUID() },
            reason: 'reconcile-backfill:below-threshold',
            source: 'reconciliation-backfill',
        });

        const result = await reevaluateQuarantineBacklog(sql, { cap: 10 });

        expect(result.dismissedGone).toBe(1);
        const after = await getQuarantineById(sql, id);
        expect(after?.resolvedAt).toBeInstanceOf(Date);
        expect(after?.resolution).toBe('dismissed');
    });

    it('reattaches a quarantine row once a fresh series re-match is confident', async () => {
        const { reevaluateQuarantineBacklog } = await import('./episode-reconciliation.service.js');
        const { quarantineWrite, listUnresolvedQuarantineForSeries } =
            await import('$lib/server/database/queries/sync-quarantine.queries.js');

        const [{ id: seriesId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status) VALUES ('ReevalReattach', 'tv', 'active') RETURNING id`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                  VALUES (${seriesId}, 'tmdb', '990100', 'tv', true)`;
        const [{ id: seasonId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, status)
            VALUES ('S1', 'season', ${seriesId}, 1, 'active') RETURNING id`;
        const [{ id: epId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, status)
            VALUES ('Wrong Title', 'episode', ${seasonId}, 1, 1, 'active') RETURNING id`;
        const [{ id: fileId }] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path) VALUES ('/x/reeval-reattach.mkv') RETURNING id`;
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default) VALUES (${epId}, ${fileId}, true)`;
        // Chapter now matches the mocked catalog exactly — a fresh re-match is confident.
        await sql`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source)
                  VALUES (${fileId}, 0, 'The Confident Match', 0, 'file')`;

        // Simulate a prior below-threshold quarantine row for this episode.
        await quarantineWrite(sql, {
            provider: 'lumastra-reconcile',
            externalId: epId,
            mediaType: 'episode',
            expectedSeriesId: seriesId,
            payload: {
                seriesMediaId: seriesId,
                seasonNumber: 1,
                episodeNumber: 1,
                matchedTmdbEpisodeId: '88001',
                proposedTitle: 'The Confident Match',
            },
            reason: 'reconcile-backfill:below-threshold',
            source: 'reconciliation-backfill',
        });

        try {
            const result = await reevaluateQuarantineBacklog(sql, { cap: 10 });

            expect(result.seriesRevisited).toBe(1);
            expect(result.reattached).toBe(1);

            const stillUnresolved = await listUnresolvedQuarantineForSeries(sql, seriesId);
            expect(stillUnresolved).toHaveLength(0);

            const [epRow] = await sql<{ title: string; title_binding: string }[]>`
                SELECT title, title_binding FROM media_items WHERE id = ${epId}`;
            expect(epRow.title).toBe('The Confident Match');
            expect(epRow.title_binding).toBe('identity');
        } finally {
            await sql`DELETE FROM external_ids WHERE media_id IN (${seriesId}, ${seasonId}, ${epId})`;
            await sql`DELETE FROM media_items WHERE id = ${seriesId}`;
            await sql`DELETE FROM media_files WHERE id = ${fileId}`;
        }
    });

    it('acceptQuarantinedMatchesForSeries applies matched near-misses and leaves other reasons untouched', async () => {
        const { acceptQuarantinedMatchesForSeries } =
            await import('./episode-reconciliation.service.js');
        const { quarantineWrite, getQuarantineById } =
            await import('$lib/server/database/queries/sync-quarantine.queries.js');

        const [{ id: seriesId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status) VALUES ('AcceptSeries', 'tv', 'active') RETURNING id`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                  VALUES (${seriesId}, 'tmdb', '990200', 'tv', true)`;
        const [{ id: seasonId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, status)
            VALUES ('S1', 'season', ${seriesId}, 1, 'active') RETURNING id`;

        // Episode A: a near-miss 'matched' candidate — its chapter matches the
        // catalog exactly, so a threshold=0 re-preview registers 'matched'.
        const [{ id: epA }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, status)
            VALUES ('Wrong Title A', 'episode', ${seasonId}, 1, 1, 'active') RETURNING id`;
        const [{ id: fileA }] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path) VALUES ('/x/accept-a.mkv') RETURNING id`;
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default) VALUES (${epA}, ${fileA}, true)`;
        await sql`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source)
                  VALUES (${fileA}, 0, 'The Confident Match', 0, 'file')`;

        // Episode B: no usable chapters at all — stays 'no-usable-chapters', not
        // a candidate 'accept' should touch.
        const [{ id: epB }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, status)
            VALUES ('Untouched B', 'episode', ${seasonId}, 1, 2, 'active') RETURNING id`;

        const quarantineIdA = await quarantineWrite(sql, {
            provider: 'lumastra-reconcile',
            externalId: epA,
            mediaType: 'episode',
            expectedSeriesId: seriesId,
            payload: {
                seriesMediaId: seriesId,
                seasonNumber: 1,
                episodeNumber: 1,
                matchedTmdbEpisodeId: '88001',
                proposedTitle: 'The Confident Match',
            },
            reason: 'reconcile-backfill:matched',
            source: 'reconciliation-backfill',
        });
        const quarantineIdB = await quarantineWrite(sql, {
            provider: 'lumastra-reconcile',
            externalId: epB,
            mediaType: 'episode',
            expectedSeriesId: seriesId,
            payload: { seriesMediaId: seriesId, seasonNumber: 1, episodeNumber: 2 },
            reason: 'reconcile-backfill:below-threshold',
            source: 'reconciliation-backfill',
        });

        try {
            const preview = await acceptQuarantinedMatchesForSeries(sql, seriesId, 'test-admin', {
                preview: true,
            });
            const result = await acceptQuarantinedMatchesForSeries(sql, seriesId, 'test-admin', {
                reviewed: preview.review,
                reviewedPage: preview.reviewedPage,
            });

            expect(result.accepted).toBe(1);
            expect(result.appliedExternalIds).toBe(1);

            const rowA = await getQuarantineById(sql, quarantineIdA);
            expect(rowA?.resolvedAt).toBeInstanceOf(Date);
            expect(rowA?.resolution).toBe('reattached');
            expect(rowA?.resolvedBy).toBe('test-admin');

            // Untouched: no candidate to accept, still unresolved.
            const rowB = await getQuarantineById(sql, quarantineIdB);
            expect(rowB?.resolvedAt).toBeNull();

            const [epARow] = await sql<{ title_binding: string }[]>`
                SELECT title_binding FROM media_items WHERE id = ${epA}`;
            expect(epARow.title_binding).toBe('identity');
        } finally {
            await sql`DELETE FROM external_ids WHERE media_id IN (${seriesId}, ${seasonId}, ${epA}, ${epB})`;
            await sql`DELETE FROM media_items WHERE id = ${seriesId}`;
            await sql`DELETE FROM media_files WHERE id = ${fileA}`;
        }
    });
});
