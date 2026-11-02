// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import { getTestDatabaseUrl } from '../../../../tests/integration/setup/test-database.js';
import { truncateAllTestTables } from '../../../../tests/integration/helpers/cleanup.js';

// Mock ONLY the TMDB client so loadTmdbCatalog returns a fixed catalog (no
// network) - same pattern as episode-reconciliation.apply.integration.test.ts.
const mockCatalogHolder = {
    translatedTitles: [] as {
        id: number;
        name: string;
        seasonNumber: number;
        episodeNumber: number;
    }[],
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
            {
                seasonNumber: 1,
                episodeCount: mockCatalogHolder.episodes.length,
            },
        ],
        getSeasonEpisodes: async () => mockCatalogHolder.episodes,
        getSeasonEpisodesInLanguage: async (_id: string, _season: number, language: string) =>
            language === 'de' ? mockCatalogHolder.translatedTitles : [],
    };
    return {
        ...actual,
        tmdbApi: mockClient,
        createTMDBApi: () => mockClient,
    };
});

const URL = getTestDatabaseUrl();

describe('automatic exact filename reconciliation (invented stories)', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = postgres(URL, { max: 2 });
    });
    beforeEach(async () => {
        await truncateAllTestTables(sql);
        mockCatalogHolder.translatedTitles = [];
        mockCatalogHolder.episodes = [
            {
                id: 990301,
                name: 'The Clockmaker Calls',
                overview: 'A brass bell',
                seasonNumber: 1,
                episodeNumber: 1,
                stillPath: '/clock.jpg',
            },
            {
                id: 990302,
                name: 'The Copper Moon',
                overview: 'A quiet moon',
                seasonNumber: 1,
                episodeNumber: 2,
                stillPath: null,
            },
        ];
    });
    afterAll(async () => {
        await sql.end();
    });

    async function fixture(
        titles: string[],
        identities: string[],
    ): Promise<{ seriesId: string; episodeIds: string[]; fileIds: string[] }> {
        const [{ id: seriesId }] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title, media_type, status) VALUES ('Amber Lantern Couriers', 'tv', 'active') RETURNING id`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type) VALUES (${seriesId}, 'tmdb', '990300', 'tv')`;
        const [{ id: seasonId }] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title, media_type, parent_id, season_number, status) VALUES ('Season 1', 'season', ${seriesId}, 1, 'active') RETURNING id`;
        const episodeIds: string[] = [],
            fileIds: string[] = [];
        for (const [index, title] of titles.entries()) {
            const [{ id: episodeId }] = await sql<
                { id: string }[]
            >`INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, status, title_binding)
                VALUES ('Old Lantern Story', 'episode', ${seasonId}, 1, ${index + 1}, 'active', 'position') RETURNING id`;
            const [{ id: fileId }] = await sql<
                { id: string }[]
            >`INSERT INTO media_files (file_path) VALUES (${`/test/${seriesId}/Amber Lantern - S01E0${index + 1} - ${title}.mkv`}) RETURNING id`;
            await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default) VALUES (${episodeId}, ${fileId}, true)`;
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type) VALUES (${episodeId}, 'tmdb', ${identities[index]}, 'episode')`;
            episodeIds.push(episodeId);
            fileIds.push(fileId);
        }
        return { seriesId, episodeIds, fileIds };
    }

    it('applies a unique normalized exact filename automatically and records a usable undo', async () => {
        const { backfillReconcileSeries } = await import('./episode-reconciliation.service.js');
        const { undoReconciliationMove } = await import('./episode-reconciliation-undo.service.js');
        const { seriesId, episodeIds, fileIds } = await fixture(
            ['004 - The Clockmaker Calls!'],
            ['990399'],
        );
        const result = await backfillReconcileSeries(sql, seriesId, { minConfidence: 1 });
        expect(result.appliedExternalIds).toBe(1);
        expect(result.quarantined).toBe(0);
        const [move] =
            await sql`SELECT * FROM episode_reconciliation_moves WHERE series_id = ${seriesId}`;
        expect(move).toMatchObject({
            service: 'filename-title',
            episode_id: episodeIds[0],
            tmdb_episode_id: '990301',
            prev_tmdb_episode_id: '990399',
            prev_title: 'Old Lantern Story',
        });
        await undoReconciliationMove(sql, move.id, 'filename-test');
        const [restored] =
            await sql`SELECT title, title_binding FROM media_items WHERE id = ${episodeIds[0]}`;
        expect(restored).toMatchObject({ title: 'Old Lantern Story', title_binding: 'position' });
        const [identity] =
            await sql`SELECT external_id FROM external_ids WHERE media_id = ${episodeIds[0]} AND provider = 'tmdb'`;
        expect(identity.external_id).toBe('990399');
        const [link] =
            await sql`SELECT file_id FROM media_file_items WHERE media_item_id = ${episodeIds[0]}`;
        expect(link.file_id).toBe(fileIds[0]);
        expect(
            (await backfillReconcileSeries(sql, seriesId, { minConfidence: 1 })).appliedExternalIds,
        ).toBe(0);
    });

    it('applies an exact German catalog alias from the filename', async () => {
        const { backfillReconcileSeries } = await import('./episode-reconciliation.service.js');
        const { seriesId, fileIds, episodeIds } = await fixture(
            ['Die Uhrmacherin ruft!'],
            ['990399'],
        );
        mockCatalogHolder.translatedTitles = [
            { id: 990301, name: 'Die Uhrmacherin ruft', seasonNumber: 1, episodeNumber: 1 },
        ];
        await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, language) VALUES (${fileIds[0]}, 'audio', 0, 'ger')`;
        const result = await backfillReconcileSeries(sql, seriesId, { minConfidence: 1 });
        expect(result.appliedExternalIds).toBe(1);
        const [identity] =
            await sql`SELECT external_id FROM external_ids WHERE media_id = ${episodeIds[0]} AND provider = 'tmdb'`;
        expect(identity.external_id).toBe('990301');
    });

    it('keeps another file-backed owner when its filename has no matching proposal', async () => {
        const { backfillReconcileSeries } = await import('./episode-reconciliation.service.js');
        const { seriesId, episodeIds } = await fixture(
            ['The Clockmaker Calls', 'Episode 2'],
            ['990399', '990301'],
        );
        expect(
            (await backfillReconcileSeries(sql, seriesId, { minConfidence: 1 })).appliedExternalIds,
        ).toBe(0);
        const ids =
            await sql`SELECT media_id, external_id FROM external_ids WHERE media_id = ANY(${episodeIds}::uuid[]) ORDER BY external_id`;
        expect(ids).toHaveLength(2);
        expect(ids.find((r) => r.media_id === episodeIds[1])?.external_id).toBe('990301');
        expect(
            await sql`SELECT id FROM episode_reconciliation_moves WHERE series_id = ${seriesId}`,
        ).toHaveLength(0);
    });

    it('applies a complete two-owner swap with an undo record per preserved UUID', async () => {
        const { backfillReconcileSeries } = await import('./episode-reconciliation.service.js');
        const { seriesId, episodeIds } = await fixture(
            ['The Clockmaker Calls', 'The Copper Moon'],
            ['990302', '990301'],
        );
        expect(
            (await backfillReconcileSeries(sql, seriesId, { minConfidence: 1 })).appliedExternalIds,
        ).toBe(2);
        const moves =
            await sql`SELECT episode_id, prev_tmdb_episode_id FROM episode_reconciliation_moves WHERE series_id = ${seriesId}`;
        expect(moves).toHaveLength(2);
        expect(moves.find((m) => m.episode_id === episodeIds[0])?.prev_tmdb_episode_id).toBe(
            '990302',
        );
        expect(
            await sql`SELECT id FROM sync_quarantine WHERE expected_series_id = ${seriesId}`,
        ).toHaveLength(0);
    });
    it.each([2, 3])(
        'undoes a %i-owner identity cycle from either move as one group',
        async (size) => {
            const { backfillReconcileSeries } = await import('./episode-reconciliation.service.js');
            const { undoReconciliationMove } =
                await import('./episode-reconciliation-undo.service.js');
            if (size === 3)
                mockCatalogHolder.episodes.push({
                    id: 990303,
                    name: 'The Glass Postbox',
                    overview: 'A glass letter',
                    seasonNumber: 1,
                    episodeNumber: 3,
                    stillPath: null,
                });
            const titles = mockCatalogHolder.episodes.map((e) => e.name);
            const previous = size === 2 ? ['990302', '990301'] : ['990302', '990303', '990301'];
            const { seriesId, episodeIds } = await fixture(titles, previous);
            expect(
                (await backfillReconcileSeries(sql, seriesId, { minConfidence: 1 }))
                    .appliedExternalIds,
            ).toBe(size);
            const moves =
                await sql`SELECT * FROM episode_reconciliation_moves WHERE series_id = ${seriesId} ORDER BY episode_id`;
            expect(moves).toHaveLength(size);
            // Reach the broken undo itself before asserting the new group metadata.
            await undoReconciliationMove(sql, moves[size - 1].id, 'cycle-test');
            expect(moves[0].group_id).toBeTruthy();
            expect(new Set(moves.map((m) => m.group_id)).size).toBe(1);
            for (const [index, episodeId] of episodeIds.entries()) {
                const [episode] =
                    await sql`SELECT title, title_binding FROM media_items WHERE id = ${episodeId}`;
                expect(episode).toMatchObject({
                    title: 'Old Lantern Story',
                    title_binding: 'position',
                });
                const [identity] =
                    await sql`SELECT external_id FROM external_ids WHERE media_id = ${episodeId} AND provider = 'tmdb'`;
                expect(identity.external_id).toBe(previous[index]);
            }
            expect(
                await sql`SELECT id FROM episode_reconciliation_moves WHERE series_id = ${seriesId} AND undone_at IS NULL`,
            ).toHaveLength(0);
            expect(
                (await backfillReconcileSeries(sql, seriesId, { minConfidence: 1 }))
                    .appliedExternalIds,
            ).toBe(0);
        },
    );

    it.each([0, 2])(
        'does not automatically bind a season %i filename to a regular season title',
        async (season) => {
            const { backfillReconcileSeries } = await import('./episode-reconciliation.service.js');
            const { seriesId, episodeIds, fileIds } = await fixture(
                ['The Clockmaker Calls'],
                ['990399'],
            );
            await sql`UPDATE media_items SET season_number = ${season} WHERE id = ${episodeIds[0]}`;
            await sql`UPDATE media_items SET season_number = ${season} WHERE id = (SELECT parent_id FROM media_items WHERE id = ${episodeIds[0]})`;
            await sql`UPDATE media_files SET file_path = ${`/test/${seriesId}/Amber Lantern - S0${season}E01 - The Clockmaker Calls.mkv`} WHERE id = ${fileIds[0]}`;
            expect(
                (await backfillReconcileSeries(sql, seriesId, { minConfidence: 1 }))
                    .appliedExternalIds,
            ).toBe(0);
            const [identity] =
                await sql`SELECT external_id FROM external_ids WHERE media_id = ${episodeIds[0]} AND provider = 'tmdb'`;
            expect(identity.external_id).toBe('990399');
        },
    );

    it('allows a flat catalog target corroborated by the stored absolute file number', async () => {
        const { backfillReconcileSeries } = await import('./episode-reconciliation.service.js');
        const { seriesId, episodeIds, fileIds } = await fixture(['The Copper Moon'], ['990399']);
        await sql`UPDATE media_items SET season_number = 2 WHERE id = ${episodeIds[0]}`;
        await sql`UPDATE media_items SET season_number = 2 WHERE id = (SELECT parent_id FROM media_items WHERE id = ${episodeIds[0]})`;
        await sql`UPDATE media_files SET absolute_episode = 2, file_path = ${`/test/${seriesId}/Amber Lantern - S02E01 - 002 - The Copper Moon.mkv`} WHERE id = ${fileIds[0]}`;
        expect(
            (await backfillReconcileSeries(sql, seriesId, { minConfidence: 1 })).appliedExternalIds,
        ).toBe(1);
    });

    it('records and restores a fuzzy filename correction and its released file-less holder', async () => {
        const { backfillReconcileSeries } = await import('./episode-reconciliation.service.js');
        const { undoReconciliationMove } = await import('./episode-reconciliation-undo.service.js');
        const { seriesId, episodeIds } = await fixture(['The Clockmaker Call'], ['990399']);
        const [{ id: holderId }] =
            await sql`INSERT INTO media_items (title, media_type, status, parent_id, season_number, episode_number, title_binding)
            VALUES ('The Clockmaker Calls', 'episode', 'active', (SELECT parent_id FROM media_items WHERE id = ${episodeIds[0]}), 1, 8, 'position') RETURNING id`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type) VALUES (${holderId}, 'tmdb', '990301', 'episode')`;
        expect(
            (await backfillReconcileSeries(sql, seriesId, { minConfidence: 0.9 }))
                .appliedExternalIds,
        ).toBe(1);
        const moves =
            await sql`SELECT * FROM episode_reconciliation_moves WHERE series_id = ${seriesId}`;
        expect(moves).toHaveLength(2);
        const move = moves.find((m) => m.episode_id === episodeIds[0])!;
        await undoReconciliationMove(sql, move.id, 'fuzzy-test');
        const identities =
            await sql`SELECT media_id, external_id FROM external_ids WHERE media_id = ANY(${[...episodeIds, holderId]}::uuid[]) AND provider = 'tmdb'`;
        expect(identities.find((i) => i.media_id === holderId)?.external_id).toBe('990301');
        expect(identities.find((i) => i.media_id === episodeIds[0])?.external_id).toBe('990399');
    });

    it('refuses a whole group if its partner changed, without partially undoing it', async () => {
        const { backfillReconcileSeries } = await import('./episode-reconciliation.service.js');
        const { undoReconciliationMove } = await import('./episode-reconciliation-undo.service.js');
        const { seriesId, episodeIds } = await fixture(
            ['The Clockmaker Calls', 'The Copper Moon'],
            ['990302', '990301'],
        );
        await backfillReconcileSeries(sql, seriesId, { minConfidence: 1 });
        const [move] =
            await sql`SELECT id FROM episode_reconciliation_moves WHERE episode_id = ${episodeIds[0]}`;
        await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${episodeIds[1]}`;
        const before =
            await sql`SELECT media_id, external_id FROM external_ids WHERE media_id = ANY(${episodeIds}::uuid[]) ORDER BY media_id`;
        await expect(undoReconciliationMove(sql, move.id, 'atomic-test')).rejects.toMatchObject({
            code: 'locked',
        });
        expect(
            await sql`SELECT media_id, external_id FROM external_ids WHERE media_id = ANY(${episodeIds}::uuid[]) ORDER BY media_id`,
        ).toEqual(before);
        expect(
            await sql`SELECT id FROM episode_reconciliation_moves WHERE series_id = ${seriesId} AND undone_at IS NOT NULL`,
        ).toHaveLength(0);
    });

    it('keeps independent filename moves independently undoable', async () => {
        const { backfillReconcileSeries } = await import('./episode-reconciliation.service.js');
        const { undoReconciliationMove } = await import('./episode-reconciliation-undo.service.js');
        const { seriesId, episodeIds } = await fixture(
            ['The Clockmaker Calls', 'The Copper Moon'],
            ['990398', '990399'],
        );
        await backfillReconcileSeries(sql, seriesId, { minConfidence: 1 });
        const moves =
            await sql`SELECT * FROM episode_reconciliation_moves WHERE series_id = ${seriesId}`;
        expect(moves.every((m) => m.group_id === null)).toBe(true);
        await undoReconciliationMove(
            sql,
            moves.find((m) => m.episode_id === episodeIds[0])!.id,
            'single-test',
        );
        const [partner] =
            await sql`SELECT external_id FROM external_ids WHERE media_id = ${episodeIds[1]} AND provider = 'tmdb'`;
        expect(partner.external_id).toBe('990302');
        expect(
            await sql`SELECT id FROM episode_reconciliation_moves WHERE series_id = ${seriesId} AND undone_at IS NULL`,
        ).toHaveLength(1);
    });
    it('honors undo markers for chapter-backed identity changes too', async () => {
        const { backfillReconcileSeries } = await import('./episode-reconciliation.service.js');
        const { undoReconciliationMove } = await import('./episode-reconciliation-undo.service.js');
        const { seriesId, fileIds } = await fixture(['Episode 1'], ['990399']);
        await sql`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source)
            VALUES (${fileIds[0]}, 0, 'The Clockmaker Calls', 0, 'ffprobe')`;
        expect(
            (await backfillReconcileSeries(sql, seriesId, { minConfidence: 1 })).appliedExternalIds,
        ).toBe(1);
        const [move] =
            await sql`SELECT id FROM episode_reconciliation_moves WHERE series_id = ${seriesId}`;
        await undoReconciliationMove(sql, move.id, 'chapter-undo-test');
        expect(
            (await backfillReconcileSeries(sql, seriesId, { minConfidence: 1 })).appliedExternalIds,
        ).toBe(0);
    });
});
