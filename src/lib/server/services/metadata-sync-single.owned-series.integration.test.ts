// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for the owned-series child-creation rule of
 * syncSeriesWithChildren (real `lumastra_tests` database, provider mocked).
 *
 *   - An owned series (has_files, library_added_at or a file below it) gets
 *     its missing seasons/episodes created (FEATURE_SHOW_MISSING_EPISODES).
 *   - A fileless discovery series gets NO season/episode row, with or without
 *     `force`. Existing children of it are still updated.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import postgres from 'postgres';
import { mockContext } from '@sapd/lumastra-plugin-sdk-testing';
import { getTestDatabaseUrl } from '../../../../tests/integration/setup/test-database.js';
import { config } from '$lib/server/config.js';
import { CatalogService } from './catalog.service.js';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';

const mocks = vi.hoisted(() => ({
    providerEnabled: true,
    getTVShowDetails: vi.fn(),
    getSeriesChildren: vi.fn(),
}));

// Same firewall as embedding-operations.service.integration.test.ts: keep the
// orchestrator, lifecycle hooks and stage-state writes out of the TRUNCATE.
vi.mock('$lib/server/services/media-lifecycle.service.js', () => ({
    MediaLifecycleService: {
        afterCreated: vi.fn().mockResolvedValue(undefined),
        afterExternalIdChanged: vi.fn().mockResolvedValue(undefined),
        afterMatched: vi.fn().mockResolvedValue(undefined),
        afterMetadataChanged: vi.fn().mockResolvedValue(undefined),
        afterContentChanged: vi.fn().mockResolvedValue(undefined),
        afterReclaimed: vi.fn().mockResolvedValue(undefined),
        onFileContentChanged: vi.fn().mockResolvedValue({ invalidatedMediaItemIds: [] }),
    },
}));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: {
        startRun: vi.fn().mockResolvedValue(undefined),
        isAnyLeader: vi.fn().mockReturnValue(false),
    },
}));
vi.mock('$lib/server/services/stage-state.service.js', () => ({
    StageStateService: vi.fn().mockImplementation(() => ({
        seedRowsForCreate: vi.fn().mockResolvedValue(undefined),
        seedRowsForCreateBatch: vi.fn().mockResolvedValue(undefined),
        invalidateByEvent: vi.fn().mockResolvedValue(undefined),
        seedForDeletedItems: vi.fn().mockResolvedValue(undefined),
    })),
    publishStageStateChange: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/server/cache', () => ({
    cacheInvalidation: { onContentAdded: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('$lib/server/plugins/runtime/field-authority-loader.js', () => ({
    buildFieldAuthorityConfigFromDefinitions: vi.fn().mockReturnValue({}),
    loadProviderSettingsCached: vi.fn().mockResolvedValue({}),
}));
vi.mock('$lib/server/services/season-artwork-enqueue.js', () => ({
    SEASON_ARTWORK_TASK_ID: 'provider-artwork-season-poster',
    enqueueSeasonArtworkMaterialization: vi.fn().mockResolvedValue(0),
}));

// Provider seam: TMDB is the only enabled provider and returns a fixed tree.
vi.mock('$lib/server/tasks/plugin-context.js', () => ({
    getProvidersByPriority: vi.fn(() =>
        mocks.providerEnabled
            ? [
                  {
                      id: 'tmdb-metadata-provider',
                      manifest: { id: 'tmdb-metadata-provider', name: 'TMDB' },
                  },
              ]
            : [],
    ),
    invokeProviderDetail: vi.fn().mockResolvedValue(null),
    isProviderConfigured: vi.fn().mockResolvedValue(false),
    invokeProviderSearch: vi.fn().mockResolvedValue([]),
}));
vi.mock('$lib/server/providers/implementations/tmdb/index.js', () => ({
    tmdbApi: {
        isAvailable: () => true,
        getTVShowDetails: mocks.getTVShowDetails,
        getSeasonEpisodesInLanguage: async () => [
            { id: 990002, name: 'Die Entscheidung', seasonNumber: 1, episodeNumber: 2 },
        ],
    },
    createTMDBApi: vi.fn(() => ({
        getTVShowDetails: mocks.getTVShowDetails,
        getTVShowSeasons: async () => [{ seasonNumber: 1 }],
        getSeasonEpisodes: async () => [
            { id: 990002, name: 'The Decision', seasonNumber: 1, episodeNumber: 2 },
        ],
    })),
}));
vi.mock('$lib/server/providers/implementations/tmdb/series-children.js', () => ({
    getSeriesChildren: (id: string, _signal: unknown, language?: string, options?: unknown) =>
        mocks.getSeriesChildren(id, language, options),
}));

import { syncSeriesWithChildren, syncSingleItem } from './metadata-sync-single.service.js';

const CLEANUP_TABLES = [
    'provider_metadata',
    'external_ids',
    'media_file_items',
    'media_files',
    'media_items',
] as const;

const TREE = {
    seasons: [
        {
            seasonNumber: 1,
            name: 'Season 1',
            overview: null,
            airDate: '2020-01-01',
            episodes: [1, 2].map((episode) => ({
                seriesExternalId: '880001',
                season: 1,
                episode,
                title: `Provider Episode ${episode}`,
                overview: null,
                airDate: '2020-01-01',
                runtime: 40,
                externalId: String(990000 + episode),
            })),
        },
    ],
};

describe('syncSeriesWithChildren owned-series rule (integration)', () => {
    let sql: postgres.Sql;
    let tmdbCounter = 880000;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        mocks.providerEnabled = true;
        await truncateTables(sql, CLEANUP_TABLES);
        mocks.getTVShowDetails.mockResolvedValue({
            name: 'Rule Show',
            first_air_date: '2020-01-01',
            overview: 'Overview',
        });
        mocks.getSeriesChildren.mockResolvedValue(TREE);
    });

    async function seedSeries(opts: {
        hasFiles: boolean;
        libraryAdded?: boolean;
    }): Promise<string> {
        const tmdbId = String(++tmdbCounter);
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, year, has_files, library_added_at)
            VALUES ('Rule Show', 'tv', 2020, ${opts.hasFiles},
                    ${opts.libraryAdded ? sql`NOW()` : null})
            RETURNING id
        `;
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
            VALUES (${row.id}, 'tmdb', ${tmdbId}, 'tv', TRUE, 'sync')
        `;
        return row.id;
    }

    async function childCounts(seriesId: string): Promise<{ seasons: number; episodes: number }> {
        const [row] = await sql<{ seasons: number; episodes: number }[]>`
            SELECT
                COUNT(*) FILTER (WHERE media_type = 'season')::int AS seasons,
                COUNT(*) FILTER (WHERE media_type = 'episode')::int AS episodes
            FROM media_items
            WHERE parent_id = ${seriesId}
               OR parent_id IN (SELECT id FROM media_items WHERE parent_id = ${seriesId})
        `;
        return row;
    }

    it('does real child sync after assigning identity to a previously unresolved series', async () => {
        const [series] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, library_added_at)
            VALUES ('Unidentified show', 'tv', now()) RETURNING id
        `;
        const unresolved = await syncSeriesWithChildren(sql, series.id, { force: false });
        expect(unresolved.prerequisiteMissing).toBe('provider-identity');
        expect(await childCounts(series.id)).toEqual({ seasons: 0, episodes: 0 });

        await new CatalogService(sql).upsertExternalId(
            series.id,
            {
                provider: 'tmdb',
                id: String(++tmdbCounter),
                mediaType: 'tv',
            },
            true,
        );
        const resolved = await syncSeriesWithChildren(sql, series.id, { force: false });
        expect(resolved.prerequisiteMissing).toBeUndefined();
        expect(resolved.episodesSynced).toBe(2);
        expect(await childCounts(series.id)).toEqual({ seasons: 1, episodes: 2 });
    });

    it('resumes actual child sync when a disabled provider returns, without changing identity', async () => {
        const seriesId = await seedSeries({ hasFiles: false, libraryAdded: true });
        mocks.providerEnabled = false;
        await expect(syncSeriesWithChildren(sql, seriesId, { force: false })).rejects.toThrow(
            /provider.*unavailable/i,
        );
        expect(await childCounts(seriesId)).toEqual({ seasons: 0, episodes: 0 });
        mocks.providerEnabled = true;
        const restored = await syncSeriesWithChildren(sql, seriesId, { force: false });
        expect(restored.prerequisiteMissing).toBeUndefined();
        expect(await childCounts(seriesId)).toEqual({ seasons: 1, episodes: 2 });
    });

    it('preserves discovery keep stamps through single-item and series refreshes', async () => {
        const id = await seedSeries({ hasFiles: false });
        const stamp = new Date().toISOString();
        await sql`INSERT INTO provider_metadata (media_id, provider, metadata)
            VALUES (${id}, 'tmdb', ${sql.json({ discovery_detail_synced_at: stamp })})`;
        await syncSeriesWithChildren(sql, id, { force: true });
        const [row] =
            await sql`SELECT metadata FROM provider_metadata WHERE media_id = ${id} AND provider = 'tmdb'`;
        expect(row.metadata.discovery_detail_synced_at).toBe(stamp);
        expect(row.metadata.overview).toBe('Overview');
    });

    it('creates the missing season and episodes for an owned series (has_files)', async () => {
        const seriesId = await seedSeries({ hasFiles: true });

        await syncSeriesWithChildren(sql, seriesId, { force: false });

        expect(await childCounts(seriesId)).toEqual({ seasons: 1, episodes: 2 });
    });

    it('preserves a conflicting positional target and file-backed identity owner while updating a sibling', async () => {
        const seriesId = await seedSeries({ hasFiles: true });
        const seasons = await sql<{ id: string; season_number: number }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number)
            VALUES ('Season 1', 'season', ${seriesId}, 1),
                   ('Local Season 2', 'season', ${seriesId}, 2)
            RETURNING id, season_number
        `;
        const season1 = seasons.find((season) => season.season_number === 1)!;
        const season2 = seasons.find((season) => season.season_number === 2)!;
        const [target] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number)
            VALUES ('Original target title', 'episode', ${season1.id}, 1, 1) RETURNING id
        `;
        const [owner] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, has_files)
            VALUES ('Original owner title', 'episode', ${season2.id}, 2, 1, TRUE) RETURNING id
        `;
        const [sibling] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number)
            VALUES ('Original sibling title', 'episode', ${season1.id}, 1, 2) RETURNING id
        `;
        const [file] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path)
            VALUES (${'/test/metadata-identity-owner-' + owner.id + '.mkv'}) RETURNING id
        `;
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default)
            VALUES (${file.id}, ${owner.id}, TRUE)`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
            VALUES (${target.id}, 'tmdb', '990010', 'episode', TRUE, 'sync'),
                   (${owner.id}, 'tmdb', '990001', 'episode', TRUE, 'sync'),
                   (${sibling.id}, 'tmdb', '990002', 'episode', TRUE, 'sync')`;

        const result = await syncSeriesWithChildren(sql, seriesId, { force: true });

        expect(result.episodesSynced).toBe(1);
        const rows = await sql<{ id: string; title: string; external_id: string }[]>`
            SELECT mi.id, mi.title, ei.external_id FROM media_items mi
            JOIN external_ids ei ON ei.media_id = mi.id
                AND ei.provider = 'tmdb' AND ei.media_type = 'episode'
            WHERE mi.id = ANY(${[target.id, owner.id, sibling.id]}::uuid[])
        `;
        expect(rows).toHaveLength(3);
        expect(rows.find((row) => row.id === target.id)).toEqual({
            id: target.id,
            title: 'Original target title',
            external_id: '990010',
        });
        expect(rows.find((row) => row.id === owner.id)).toEqual({
            id: owner.id,
            title: 'Original owner title',
            external_id: '990001',
        });
        expect(rows.find((row) => row.id === sibling.id)).toEqual({
            id: sibling.id,
            title: 'Provider Episode 2',
            external_id: '990002',
        });
        const links = await sql<{ media_item_id: string }[]>`
            SELECT media_item_id FROM media_file_items WHERE file_id = ${file.id}
        `;
        expect(links).toEqual([{ media_item_id: owner.id }]);
    });

    it('creates the missing children for a series with library_added_at set', async () => {
        const seriesId = await seedSeries({ hasFiles: false, libraryAdded: true });

        await syncSeriesWithChildren(sql, seriesId, { force: false });

        expect(await childCounts(seriesId)).toEqual({ seasons: 1, episodes: 2 });
    });

    it('creates no child for a fileless discovery series', async () => {
        const seriesId = await seedSeries({ hasFiles: false });

        const result = await syncSeriesWithChildren(sql, seriesId, { force: false });

        expect(result.phantomSkipped).toBe(true);
        expect(await childCounts(seriesId)).toEqual({ seasons: 0, episodes: 0 });
    });

    it('creates no child for a fileless discovery series even with force', async () => {
        const seriesId = await seedSeries({ hasFiles: false });

        const result = await syncSeriesWithChildren(sql, seriesId, { force: true });

        expect(await childCounts(seriesId)).toEqual({ seasons: 0, episodes: 0 });
        expect(result.childrenSkipped).toBe('not-owned');
    });

    it('preserves an editing lock saved while a forced fresh response is in flight', async () => {
        const id = await seedSeries({ hasFiles: false });
        const [before] = await sql`SELECT title FROM media_items WHERE id=${id}`;
        mocks.getTVShowDetails.mockImplementationOnce(async () => {
            await sql`UPDATE media_items SET metadata_locked=true WHERE id=${id}`;
            return {
                name: 'The Lantern Observatory',
                first_air_date: '2026-10-01',
                overview: 'Fresh provider details',
            };
        });
        expect((await syncSingleItem(sql, id, { force: true, respectLocks: true })).updated).toBe(
            false,
        );
        expect((await sql`SELECT title FROM media_items WHERE id=${id}`)[0].title).toBe(
            before.title,
        );
    });
    it('creates the children of a fileless series with forceCreateChildren (explicit admin re-sync)', async () => {
        const seriesId = await seedSeries({ hasFiles: false });

        const result = await syncSeriesWithChildren(sql, seriesId, {
            force: true,
            forceCreateChildren: true,
            respectLocks: true,
        });

        expect(await childCounts(seriesId)).toEqual({ seasons: 1, episodes: 2 });
        expect(result.childrenSkipped).toBeUndefined();
    });

    it('does not re-create a child deleted between the sync and its update (update-only)', async () => {
        const seriesId = await seedSeries({ hasFiles: false });
        const [season] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number)
            VALUES ('Old Season', 'season', ${seriesId}, 1) RETURNING id
        `;
        await sql`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number)
            VALUES ('Old Episode 1', 'episode', ${season.id}, 1, 1)
        `;
        // The provider tree is fetched, then the GC deletes episode 1 before the
        // season's episodes are written: the sync must not bring it back.
        mocks.getSeriesChildren.mockImplementation(async () => {
            await sql`DELETE FROM media_items WHERE media_type = 'episode' AND parent_id = ${season.id}`;
            return TREE;
        });

        await syncSeriesWithChildren(sql, seriesId, { force: true });

        expect(await childCounts(seriesId)).toEqual({ seasons: 1, episodes: 0 });
    });

    it('updates a locked existing episode id lookup without touching it (update-only, no force)', async () => {
        const seriesId = await seedSeries({ hasFiles: false });
        const [season] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number)
            VALUES ('Old Season', 'season', ${seriesId}, 1) RETURNING id
        `;
        await sql`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, metadata_locked)
            VALUES ('Locked Episode 1', 'episode', ${season.id}, 1, 1, TRUE)
        `;

        // force:true on the series row, but children are only forced by forceChildren.
        await syncSeriesWithChildren(sql, seriesId, { force: true });

        expect(await childCounts(seriesId)).toEqual({ seasons: 1, episodes: 1 });
        const [ep] = await sql<{ title: string }[]>`
            SELECT title FROM media_items WHERE parent_id = ${season.id} AND episode_number = 1
        `;
        expect(ep.title).toBe('Locked Episode 1');
    });

    it('still updates an existing child of a fileless series but adds no new one (force)', async () => {
        const seriesId = await seedSeries({ hasFiles: false });
        const [season] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number)
            VALUES ('Old Season', 'season', ${seriesId}, 1) RETURNING id
        `;
        await sql`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number)
            VALUES ('Old Episode 1', 'episode', ${season.id}, 1, 1)
        `;

        await syncSeriesWithChildren(sql, seriesId, { force: true });

        expect(await childCounts(seriesId)).toEqual({ seasons: 1, episodes: 1 });
        const [ep] = await sql<{ title: string }[]>`
            SELECT title FROM media_items
            WHERE parent_id = ${season.id} AND episode_number = 1
        `;
        expect(ep.title).toBe('Provider Episode 1');
    });
    it.each(['stable', 'language-race', 'identity-race'] as const)(
        'iteration5 carries the real localized producer catalog through series-sync (%s)',
        async (kind) => {
            const seriesId = await seedSeries({ hasFiles: true });
            const [{ id: group }] = await sql<
                { id: string }[]
            >`INSERT INTO library_groups(name) VALUES (${crypto.randomUUID()}) RETURNING id`;
            await sql`UPDATE media_items SET library_group_id=${group} WHERE id=${seriesId}`;
            await sql`INSERT INTO library_paths(path,media_type,language,library_group_id) VALUES (${`/test/${crypto.randomUUID()}`},'tv','de-DE',${group})`;
            const [{ id: season }] = await sql<
                { id: string }[]
            >`INSERT INTO media_items(title,media_type,parent_id,season_number,status) VALUES ('Season','season',${seriesId},1,'active') RETURNING id`;
            const [{ id: episode }] = await sql<
                { id: string }[]
            >`INSERT INTO media_items(title,media_type,parent_id,season_number,episode_number,status,title_binding) VALUES ('Before','episode',${season},1,1,'active','position') RETURNING id`;
            const [{ id: file }] = await sql<
                { id: string }[]
            >`INSERT INTO media_files(file_path) VALUES (${`/test/${crypto.randomUUID()}.mkv`}) RETURNING id`;
            await sql`INSERT INTO media_file_items(media_item_id,file_id,is_default) VALUES (${episode},${file},true)`;
            await sql`INSERT INTO episode_chapters(file_id,chapter_index,chapter_name,start_ticks,source) VALUES (${file},0,'Die Entscheidung',0,'file')`;
            const rival = postgres(getTestDatabaseUrl(), { max: 1 });
            vi.spyOn(config, 'TMDB_LANGUAGE', 'get').mockReturnValue('en-US');
            mocks.getSeriesChildren.mockImplementationOnce(
                async (_id: string, language: string) => {
                    expect(language).toBe('de-DE');
                    if (kind === 'language-race')
                        await rival`UPDATE library_paths SET language='fr' WHERE library_group_id=${group}`;
                    if (kind === 'identity-race') {
                        const catalog = new CatalogService(rival);
                        await catalog.deleteExternalId(seriesId, 'tmdb', 'tv');
                        await catalog.upsertExternalId(
                            seriesId,
                            { provider: 'tmdb', id: '889999', mediaType: 'tv' },
                            true,
                        );
                    }
                    return {
                        seasons: [
                            {
                                ...TREE.seasons[0],
                                episodes: TREE.seasons[0].episodes.map((ep, i) => ({
                                    ...ep,
                                    title: i === 0 ? 'Der Anfang' : 'Die Entscheidung',
                                })),
                            },
                        ],
                    };
                },
            );
            try {
                const { seriesSyncTask } =
                    await import('../tasks/builtin/native/media-item-tasks.js');
                const ctx = mockContext({ sql, input: { mediaItemId: seriesId, force: true } });
                vi.spyOn(ctx.logger, 'warn');
                const taskResult = await seriesSyncTask.execute(ctx);
                expect(taskResult).toMatchObject({ success: true });
                const [row] = await sql<
                    { title: string; title_binding: string }[]
                >`SELECT title,title_binding FROM media_items WHERE id=${episode}`;
                if (kind === 'stable') {
                    expect(row).toEqual({ title: 'Die Entscheidung', title_binding: 'identity' });
                    expect(
                        await sql`SELECT external_id FROM external_ids WHERE media_id=${episode} AND provider='tmdb' AND media_type='episode'`,
                    ).toEqual([{ external_id: '990002' }]);
                } else {
                    expect(row.title_binding).not.toBe('identity');
                    expect(taskResult).toMatchObject({
                        result: {
                            reconciliationSkipped: { status: 'skipped', reason: 'stale-catalog' },
                        },
                    });
                    expect(ctx.logger.warn).toHaveBeenCalledWith(
                        'series-sync: auto-reconciliation skipped (non-fatal)',
                        { mediaItemId: seriesId, reason: 'stale-catalog' },
                    );
                    const [beforeRecovery] =
                        await sql`SELECT reconcile_backfill_at FROM media_items WHERE id=${seriesId}`;
                    expect(beforeRecovery.reconcile_backfill_at).toBeNull();
                    const { backfillReconcileSeries } =
                        await import('./episode-reconciliation.service.js');
                    const recovery = await backfillReconcileSeries(sql, seriesId, {
                        minConfidence: 0.9,
                    });
                    expect(recovery.appliedExternalIds).toBe(1);
                    const [recovered] =
                        await sql`SELECT title,title_binding FROM media_items WHERE id=${episode}`;
                    expect(recovered).toEqual({ title: 'The Decision', title_binding: 'identity' });
                    const [afterRecovery] =
                        await sql`SELECT reconcile_backfill_at FROM media_items WHERE id=${seriesId}`;
                    expect(afterRecovery.reconcile_backfill_at).not.toBeNull();
                }
            } finally {
                vi.restoreAllMocks();
                await rival.end();
            }
        },
    );
});

describe('syncSeriesWithChildren season refresh plan (integration)', () => {
    let sql: postgres.Sql;

    let seedCounter = 770_000;

    async function childCountsOf(seriesId: string): Promise<number> {
        const [row] = await sql<{ n: number }[]>`
            SELECT COUNT(*)::int AS n FROM media_items e JOIN media_items s ON s.id = e.parent_id
            WHERE s.parent_id = ${seriesId} AND e.media_type = 'episode'`;
        return row.n;
    }

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });

    type Selector = (
        l: Array<{ season_number: number; episode_count?: number; air_date?: string }>,
    ) => ReadonlySet<number>;

    /** Owned series with seasons 1..5, 10 TMDB-identified episodes each. */
    async function seedLongRunning(): Promise<string> {
        const [series] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, year, has_files, library_added_at)
            VALUES ('Long Runner', 'tv', 2010, TRUE, NOW()) RETURNING id
        `;
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
            VALUES (${series.id}, 'tmdb', ${String(++seedCounter)}, 'tv', TRUE, 'sync')
        `;
        const tmdbEpBase = 5_000_000 + seedCounter * 100;
        let tmdbEp = tmdbEpBase;
        for (let n = 1; n <= 5; n++) {
            const [season] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, parent_id, season_number, premiere_date)
                VALUES (${`Season ${n}`}, 'season', ${series.id}, ${n}, ${`${2010 + n}-09-01`})
                RETURNING id
            `;
            for (let e = 1; e <= 10; e++) {
                const [ep] = await sql<{ id: string }[]>`
                    INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number)
                    VALUES (${`S${n}E${e}`}, 'episode', ${season.id}, ${n}, ${e}) RETURNING id
                `;
                await sql`
                    INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
                    VALUES (${ep.id}, 'tmdb', ${String(++tmdbEp)}, 'episode', TRUE, 'sync')
                `;
            }
        }
        return series.id;
    }

    const listing = (
        overrides: Record<number, { episode_count?: number; air_date?: string }> = {},
    ) => {
        const rows = [1, 2, 3, 4, 5].map((n) => ({
            season_number: n,
            episode_count: 10,
            air_date: `${2010 + n}-09-01`,
            ...overrides[n],
        }));
        if (overrides[6]) rows.push({ season_number: 6, ...overrides[6] } as (typeof rows)[number]);
        return rows;
    };

    async function planFor(
        flags: { force?: boolean; forceChildren?: boolean; forceCreateChildren?: boolean },
        l = listing(),
        fullFetchAgeDays: number | null = 1,
    ): Promise<number[] | 'all'> {
        const seriesId = await seedLongRunning();
        // Last full season fetch stamp (null = never recorded).
        if (fullFetchAgeDays != null) {
            const at = new Date(Date.now() - fullFetchAgeDays * 86_400_000).toISOString();
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata)
                VALUES (${seriesId}, 'tmdb', ${sql.json({ seasons_full_fetch_at: at })})
            `;
        }
        mocks.getSeriesChildren.mockClear();
        await syncSeriesWithChildren(sql, seriesId, { force: false, ...flags });
        const options = mocks.getSeriesChildren.mock.calls.at(-1)?.[2] as
            { selectSeasons?: Selector } | undefined;
        if (!options?.selectSeasons) return 'all';
        return [...options.selectSeasons(l)].sort((a, b) => a - b);
    }

    beforeEach(async () => {
        mocks.providerEnabled = true;
        await truncateTables(sql, CLEANUP_TABLES);
        mocks.getTVShowDetails.mockResolvedValue({ name: 'Long Runner', overview: 'x' });
        mocks.getSeriesChildren.mockResolvedValue({ seasons: [] });
    });

    it('(a) routine re-sync of a long-running show asks for only the latest seasons', async () => {
        expect(await planFor({})).toEqual([4, 5]);
    });

    it('(b) routine re-sync picks up a new season next to the latest', async () => {
        expect(
            await planFor({}, listing({ 6: { episode_count: 8, air_date: '2026-09-01' } })),
        ).toEqual([5, 6]);
    });

    it('(c) routine re-sync refetches an older season whose episode count changed', async () => {
        expect(await planFor({}, listing({ 2: { episode_count: 11 } }))).toEqual([2, 4, 5]);
    });

    it('refreshes every season when the last full fetch is older than 30 days, or was never recorded', async () => {
        expect(await planFor({}, listing(), 31)).toEqual([1, 2, 3, 4, 5]);
        expect(await planFor({}, listing(), null)).toEqual([1, 2, 3, 4, 5]);
    });

    it('a stamp from the previous sync survives the series metadata rewrite (carry-forward)', async () => {
        const seriesId = await seedLongRunning();
        const at = new Date(Date.now() - 2 * 86_400_000).toISOString();
        await sql`INSERT INTO provider_metadata (media_id, provider, metadata)
            VALUES (${seriesId}, 'tmdb', ${sql.json({ seasons_full_fetch_at: at })})`;
        mocks.getSeriesChildren.mockResolvedValue({ seasons: [], partial: true });
        await syncSeriesWithChildren(sql, seriesId, { force: false });
        const [row] = await sql`SELECT metadata FROM provider_metadata
            WHERE media_id = ${seriesId} AND provider = 'tmdb'`;
        expect(row.metadata.seasons_full_fetch_at).toBe(at);
        expect(row.metadata.overview).toBe('x');
    });

    it('records the time after a complete season fetch, not after a partial or incomplete one', async () => {
        const stamp = async (id: string) =>
            (
                await sql`SELECT metadata->>'seasons_full_fetch_at' AS at FROM provider_metadata
                    WHERE media_id = ${id} AND provider = 'tmdb'`
            )[0]?.at as string | null;

        const partial = await seedLongRunning();
        mocks.getSeriesChildren.mockResolvedValue({ seasons: [], partial: true });
        await syncSeriesWithChildren(sql, partial, { force: false });
        expect(await stamp(partial)).toBeNull();

        const incomplete = await seedLongRunning();
        mocks.getSeriesChildren.mockResolvedValue({ seasons: [], incompleteSeasons: [3] });
        await syncSeriesWithChildren(sql, incomplete, { force: true });
        expect(await stamp(incomplete)).toBeNull();

        const full = await seedLongRunning();
        mocks.getSeriesChildren.mockResolvedValue({ seasons: [] });
        await syncSeriesWithChildren(sql, full, { force: true });
        const at = await stamp(full);
        expect(at).not.toBeNull();
        expect(Math.abs(Date.parse(at!) - Date.now())).toBeLessThan(60_000);
    });

    it('series-sync does not claim coverage while a season is incomplete, and writes nothing for it', async () => {
        const seriesId = await seedLongRunning();
        mocks.getSeriesChildren.mockResolvedValue({ seasons: [], incompleteSeasons: [5] });
        const { seriesSyncTask } = await import('../tasks/builtin/native/media-item-tasks.js');
        const ctx = mockContext({ sql, input: { mediaItemId: seriesId, force: true } });
        const result = await seriesSyncTask.execute(ctx);
        expect(result).toMatchObject({ success: false });
        expect(result).not.toMatchObject({ permanent: true });
        expect(await childCountsOf(seriesId)).toBe(50);
    });

    it('a partial fetch reconciles only episodes of the fetched seasons', async () => {
        const seriesId = await seedLongRunning();
        // Season 1 episode: file-backed, positional title, chapter "Finale".
        const [ep] = await sql<{ id: string; season_id: string }[]>`
            SELECT e.id, e.parent_id AS season_id FROM media_items e
            WHERE e.season_number = 1 AND e.episode_number = 1
              AND e.parent_id IN (SELECT id FROM media_items WHERE parent_id = ${seriesId})`;
        await sql`UPDATE media_items SET title = 'Before', title_binding = 'position' WHERE id = ${ep.id}`;
        await sql`DELETE FROM external_ids WHERE media_id = ${ep.id} AND media_type = 'episode'`;
        const [{ id: file }] = await sql<{ id: string }[]>`
            INSERT INTO media_files(file_path) VALUES (${`/test/${crypto.randomUUID()}.mkv`}) RETURNING id`;
        await sql`INSERT INTO media_file_items(media_item_id,file_id,is_default) VALUES (${ep.id},${file},true)`;
        await sql`INSERT INTO episode_chapters(file_id,chapter_index,chapter_name,start_ticks,source)
            VALUES (${file},0,'Finale',0,'file')`;
        // The routine fetch only covers season 5, which has a lookalike "Finale".
        mocks.getSeriesChildren.mockResolvedValue({
            partial: true,
            seasons: [
                {
                    seasonNumber: 5,
                    name: 'Season 5',
                    overview: null,
                    airDate: '2015-09-01',
                    episodes: [
                        {
                            seriesExternalId: '770001',
                            season: 5,
                            episode: 3,
                            title: 'Finale',
                            overview: null,
                            airDate: '2015-09-01',
                            runtime: 40,
                            externalId: '991003',
                        },
                    ],
                },
            ],
        });
        const { seriesSyncTask } = await import('../tasks/builtin/native/media-item-tasks.js');
        const ctx = mockContext({ sql, input: { mediaItemId: seriesId } });
        await seriesSyncTask.execute(ctx);

        const [row] = await sql<{ title: string; title_binding: string }[]>`
            SELECT title, title_binding FROM media_items WHERE id = ${ep.id}`;
        expect(row).toEqual({ title: 'Before', title_binding: 'position' });
        expect(
            await sql`SELECT 1 FROM external_ids WHERE media_id = ${ep.id} AND provider = 'tmdb'`,
        ).toHaveLength(0);
    });

    it.each([['force'], ['forceChildren'], ['forceCreateChildren']])(
        '(d) %s = explicit sync: no selector, every season is fetched',
        async (flag) => {
            expect(await planFor({ [flag]: true })).toBe('all');
        },
    );

    it('fetches everything while a file-backed episode has no TMDB identity', async () => {
        const seriesId = await seedLongRunning();
        await sql`
            UPDATE media_items SET has_files = TRUE
            WHERE id = (SELECT e.id FROM media_items e JOIN media_items s ON s.id = e.parent_id
                        WHERE s.parent_id = ${seriesId} AND e.episode_number = 1 AND e.season_number = 2)
        `;
        await sql`
            DELETE FROM external_ids WHERE media_type = 'episode' AND media_id =
                (SELECT e.id FROM media_items e JOIN media_items s ON s.id = e.parent_id
                 WHERE s.parent_id = ${seriesId} AND e.episode_number = 1 AND e.season_number = 2)
        `;
        mocks.getSeriesChildren.mockClear();
        await syncSeriesWithChildren(sql, seriesId, { force: false });
        const options = mocks.getSeriesChildren.mock.calls.at(-1)?.[2] as {
            selectSeasons: Selector;
        };
        expect([...options.selectSeasons(listing())]).toEqual([1, 2, 3, 4, 5]);
    });
});
