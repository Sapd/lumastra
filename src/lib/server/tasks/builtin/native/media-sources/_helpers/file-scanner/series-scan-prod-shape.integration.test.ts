// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * The prod failure shape of the Shorefolk 2001/2026 bleed: two same-title series
 * folders carrying IMDb tags (one with a doubled year), the REAL title matcher
 * and a REAL per-scan search cache. Only TMDB is stubbed: /find by IMDb id and
 * title search keyed by the QUERY string, as the provider sees it — so both
 * folders' episodes hit the same "Shorefolk" search, exactly as on prod.
 *
 * Real PostgreSQL, catalog, files and ffprobe.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import {
    closeTestDb,
    getTestDb,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import {
    TEST_TABLES,
    truncateTables,
} from '../../../../../../../../../tests/integration/helpers/cleanup.js';
import type { LibraryPathRow } from '../../../../../../database/queries/library-paths.queries.js';
import type { MetadataCandidate } from '../../../../../../providers/types.js';
import { createCatalogService } from '../../../../../../services/catalog.service.js';
import { listScanIssues } from '../../../../../../database/queries/media-files.queries.js';
import { parseMediaFilename } from '../../../../../../utils/filename-parser.js';
import type { FileScannerContext } from './shared.js';
import type { MetadataSearchCache } from './video-processor.js';
import { Logger } from '../../../../../../utils/logger.js';

const tmdb = vi.hoisted(() => ({
    /** IMDb id → /find result; a missing key is a /find miss. */
    find: new Map<string, MetadataCandidate>(),
    /** Title query → raw TMDB search results. */
    search: new Map<string, unknown[]>(),
    queries: [] as string[],
    afterMatched: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
}));

vi.mock('../../../../../plugin-context.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    isProviderConfigured: vi.fn(async () => true),
    invokeProviderSearch: vi.fn(async (_providerId: string, query: { query: string }) => {
        tmdb.queries.push(query.query);
        return tmdb.search.get(query.query) ?? [];
    }),
}));
vi.mock('../../../../../../providers/implementations/tmdb/resolve-external.js', () => ({
    tmdbResolveExternalId: vi.fn(async (imdbId: string) => tmdb.find.get(imdbId) ?? null),
}));
vi.mock('../../../../../../services/media-lifecycle.service.js', async (importOriginal) => {
    const actual = await importOriginal<{ MediaLifecycleService: object }>();
    return {
        ...actual,
        MediaLifecycleService: Object.assign(Object.create(actual.MediaLifecycleService), {
            afterMatched: tmdb.afterMatched,
        }),
    };
});

const { processVideoFile, findOrCreateSeriesHierarchy } = await import('./video-processor.js');
const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'test-video.mp4');
const TMDB = 'tmdb-metadata-provider';

const ORIGINAL = {
    folder: 'Shorefolk (2001) [imdbid-tt0285403]',
    tmdb: '4556',
    imdb: 'tt0285403',
    year: 2001,
    firstAir: '2001-10-02',
} as const;
const REVIVAL = {
    folder: 'Shorefolk (2026) (2026) [imdbid-tt37017338]',
    tmdb: '290001',
    imdb: 'tt37017338',
    year: 2026,
    firstAir: '2026-02-25',
} as const;
type Show = typeof ORIGINAL | typeof REVIVAL;

interface Linked {
    file_path: string;
    episode_id: string;
    season_id: string;
    series_id: string;
    series_year: number | null;
}

describe('series scan, prod-shaped Shorefolk 2001/2026 (real matcher, cache, PG, ffprobe)', () => {
    let sql: postgres.Sql;
    let root: string;
    let libraryPath: LibraryPathRow;
    let context: FileScannerContext;
    let caches: {
        search: MetadataSearchCache;
        series: Map<string, string>;
        season: Map<string, string>;
        announced: Set<string>;
    };
    const freshCaches = (): typeof caches => ({
        search: new Map(),
        series: new Map(),
        season: new Map(),
        announced: new Set(),
    });

    beforeAll(() => {
        sql = getTestDb();
        context = { sql, logger: Logger.for('SeriesScanProdShapeTest') };
        vi.spyOn(context.logger, 'warn').mockImplementation(() => undefined);
    });

    afterAll(async () => closeTestDb());

    beforeEach(async () => {
        tmdb.find.clear();
        tmdb.search.clear();
        tmdb.queries.length = 0;
        tmdb.afterMatched.mockClear();
        caches = freshCaches();
        await truncateTables(sql, TEST_TABLES.media);
        root = await mkdtemp(join(tmpdir(), 'lumastra-series-prod-shape-'));
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name)
            VALUES (${`series-prod-shape-${Date.now()}`}) RETURNING id
        `;
        const [path] = await sql<LibraryPathRow[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled, provider)
            VALUES (${root}, 'tv', ${group.id}, true, 'tmdb') RETURNING *
        `;
        libraryPath = path;
        return async () => {
            await rm(root, { recursive: true, force: true });
            await sql`DELETE FROM library_paths WHERE id = ${path.id}`;
            await sql`DELETE FROM library_groups WHERE id = ${group.id}`;
        };
    });

    function tmdbProvider(opts: { revivalFound: boolean; revivalSearchable: boolean }): void {
        const candidate = (show: Show): MetadataCandidate => ({
            externalId: show.tmdb,
            provider: 'tmdb',
            title: 'Shorefolk',
            year: show.year,
            mediaType: 'tv',
            confidence: 1,
        });
        tmdb.find.set(ORIGINAL.imdb, candidate(ORIGINAL));
        if (opts.revivalFound) tmdb.find.set(REVIVAL.imdb, candidate(REVIVAL));
        // The original is the far more popular entry: an unscored search picks it.
        const raw = (show: Show, popularity: number) => ({
            id: Number(show.tmdb),
            name: 'Shorefolk',
            first_air_date: show.firstAir,
            popularity,
        });
        tmdb.search.set(
            'Shorefolk',
            opts.revivalSearchable ? [raw(ORIGINAL, 90), raw(REVIVAL, 12)] : [raw(ORIGINAL, 90)],
        );
    }

    async function episode(show: Show, number: number): Promise<string> {
        const directory = join(root, show.folder, 'Season 01');
        await mkdir(directory, { recursive: true });
        // Prod naming: no year and no id in the episode filename.
        const filePath = join(directory, `Shorefolk - S01E${String(number).padStart(2, '0')}.mp4`);
        await copyFile(FIXTURE, filePath);
        return filePath;
    }

    const scan = (filePath: string) =>
        processVideoFile(
            sql,
            filePath,
            libraryPath,
            [TMDB],
            context,
            undefined,
            undefined,
            caches.search,
            false,
            caches.series,
            caches.season,
            caches.announced,
        );

    async function runOrder(order: string, original: string[], revival: string[]) {
        const files =
            order === 'original-first'
                ? [...original, ...revival]
                : order === 'revival-first'
                  ? [...revival, ...original]
                  : original.flatMap((file, i) => [file, revival[i]]);
        return Promise.all(files.map(scan));
    }

    async function linked(files: string[]): Promise<Linked[]> {
        return sql<Linked[]>`
            SELECT mf.file_path, ep.id AS episode_id, season.id AS season_id,
                   series.id AS series_id, series.year AS series_year
            FROM media_files mf
            JOIN media_file_items mfi ON mfi.file_id = mf.id
            JOIN media_items ep ON ep.id = mfi.media_item_id AND ep.media_type = 'episode'
            JOIN media_items season ON season.id = ep.parent_id
            JOIN media_items series ON series.id = season.parent_id AND series.media_type = 'tv'
            WHERE mf.file_path = ANY(${files})
            ORDER BY mf.file_path
        `;
    }

    async function externalIds(seriesId: string): Promise<Record<string, string>> {
        const rows = await sql<{ provider: string; external_id: string }[]>`
            SELECT provider, external_id FROM external_ids
            WHERE media_id = ${seriesId}::uuid AND media_type = 'tv'
        `;
        return Object.fromEntries(rows.map((row) => [row.provider, row.external_id]));
    }

    async function expectRescanKeepsIds(files: string[], first: Linked[]): Promise<void> {
        // A later scan with fresh per-scan caches takes the linked-file fast path
        // and keeps every series, season and episode id.
        caches = freshCaches();
        expect(await Promise.all([...files].reverse().map(scan))).toEqual(
            files.map(() => 'skipped'),
        );
        expect(await linked(files)).toEqual(first);
    }

    const ORDERS = ['original-first', 'revival-first', 'interleaved'] as const;

    it.each(ORDERS)(
        '%s: /find resolves both tags → two series with their own ids',
        async (order) => {
            tmdbProvider({ revivalFound: true, revivalSearchable: true });
            const original = await Promise.all([1, 2].map((n) => episode(ORIGINAL, n)));
            const revival = await Promise.all([1, 2].map((n) => episode(REVIVAL, n)));
            expect(await runOrder(order, original, revival)).toEqual([
                'added',
                'added',
                'added',
                'added',
            ]);

            const first = await linked([...original, ...revival]);
            expect(first).toHaveLength(4);
            const originalSeries = new Set(
                first.filter((r) => original.includes(r.file_path)).map((r) => r.series_id),
            );
            const revivalSeries = new Set(
                first.filter((r) => revival.includes(r.file_path)).map((r) => r.series_id),
            );
            expect(originalSeries.size).toBe(1);
            expect(revivalSeries.size).toBe(1);
            const [originalId] = originalSeries;
            const [revivalId] = revivalSeries;
            expect(revivalId).not.toBe(originalId);
            expect(await externalIds(originalId)).toEqual({
                tmdb: ORIGINAL.tmdb,
                imdb: ORIGINAL.imdb,
            });
            expect(await externalIds(revivalId)).toEqual({
                tmdb: REVIVAL.tmdb,
                imdb: REVIVAL.imdb,
            });

            await expectRescanKeepsIds([...original, ...revival], first);
        },
    );

    it.each(ORDERS)(
        '%s: /find misses the revival → the year-scored search finds it; its IMDb tag never reaches the original',
        async (order) => {
            tmdbProvider({ revivalFound: false, revivalSearchable: true });
            const original = await Promise.all([1, 2].map((n) => episode(ORIGINAL, n)));
            const revival = await Promise.all([1, 2].map((n) => episode(REVIVAL, n)));
            expect(await runOrder(order, original, revival)).toEqual([
                'added',
                'added',
                'added',
                'added',
            ]);

            const first = await linked([...original, ...revival]);
            const originalId = first.find((r) => r.file_path === original[0])!.series_id;
            const revivalId = first.find((r) => r.file_path === revival[0])!.series_id;
            expect(revivalId).not.toBe(originalId);
            expect(first.filter((r) => r.series_id === originalId).map((r) => r.file_path)).toEqual(
                [...original].sort(),
            );
            expect(await externalIds(originalId)).toEqual({
                tmdb: ORIGINAL.tmdb,
                imdb: ORIGINAL.imdb,
            });
            // The unconfirmed folder tag is not written; the match stands alone.
            expect(await externalIds(revivalId)).toEqual({ tmdb: REVIVAL.tmdb });
            expect(await listScanIssues(sql)).toEqual([]);

            await expectRescanKeepsIds([...original, ...revival], first);
        },
    );

    it.each(ORDERS)(
        '%s: TMDB knows nothing of the revival → its episodes stay off the original series',
        async (order) => {
            tmdbProvider({ revivalFound: false, revivalSearchable: false });
            const original = await Promise.all([1, 2].map((n) => episode(ORIGINAL, n)));
            const revival = await Promise.all([1, 2].map((n) => episode(REVIVAL, n)));
            expect(await runOrder(order, original, revival)).toEqual([
                'added',
                'added',
                'added',
                'added',
            ]);

            const first = await linked([...original, ...revival]);
            const originalId = first.find((r) => r.file_path === original[0])!.series_id;
            const revivalRows = first.filter((r) => revival.includes(r.file_path));
            expect(new Set(revivalRows.map((r) => r.series_id)).size).toBe(1);
            expect(revivalRows[0].series_id).not.toBe(originalId);
            // An unmatched series named by its folder year, without provider ids.
            expect(revivalRows[0].series_year).toBe(2026);
            expect(await externalIds(revivalRows[0].series_id)).toEqual({});
            expect(await externalIds(originalId)).toEqual({
                tmdb: ORIGINAL.tmdb,
                imdb: ORIGINAL.imdb,
            });

            await expectRescanKeepsIds([...original, ...revival], first);
        },
    );

    it('keeps the search cache apart for the two folder years', async () => {
        tmdbProvider({ revivalFound: false, revivalSearchable: true });
        // No IMDb tags at all: both folders reach title search.
        const originalDir = join(root, 'Shorefolk (2001)', 'Season 01');
        const revivalDir = join(root, 'Shorefolk (2026)', 'Season 01');
        await mkdir(originalDir, { recursive: true });
        await mkdir(revivalDir, { recursive: true });
        const files = [
            join(originalDir, 'Shorefolk - S01E01.mp4'),
            join(revivalDir, 'Shorefolk - S01E01.mp4'),
            join(originalDir, 'Shorefolk - S01E02.mp4'),
            join(revivalDir, 'Shorefolk - S01E02.mp4'),
        ];
        for (const file of files) await copyFile(FIXTURE, file);
        for (const file of files) expect(await scan(file)).toBe('added');
        // One search per folder year, then cache hits.
        expect(tmdb.queries).toEqual(['Shorefolk', 'Shorefolk']);
        const rows = await linked(files);
        const byFolder = (dir: string) =>
            new Set(rows.filter((r) => r.file_path.startsWith(dir)).map((r) => r.series_id));
        expect(byFolder(originalDir).size).toBe(1);
        expect(byFolder(revivalDir).size).toBe(1);
        const [originalId] = byFolder(originalDir);
        const [revivalId] = byFolder(revivalDir);
        expect(revivalId).not.toBe(originalId);
        expect((await externalIds(originalId)).tmdb).toBe(ORIGINAL.tmdb);
        expect((await externalIds(revivalId)).tmdb).toBe(REVIVAL.tmdb);
    });

    it('keeps untagged, unmatched "Show (2001)" and "Show (2026)" apart by folder year', async () => {
        // No search result at all: both folders become unmatched series.
        const files: string[] = [];
        for (const year of [2001, 2026, 2001, 2026]) {
            const dir = join(root, `Untagged Show (${year})`, 'Season 01');
            await mkdir(dir, { recursive: true });
            const file = join(dir, `Untagged Show - S01E0${files.length + 1}.mp4`);
            await copyFile(FIXTURE, file);
            files.push(file);
        }
        for (const file of files) expect(await scan(file)).toBe('added');
        const rows = await linked(files);
        const years = new Map(rows.map((r) => [r.series_id, r.series_year]));
        expect([...years.values()].sort()).toEqual([2001, 2026]);

        await expectRescanKeepsIds(files, rows);
    });

    describe('provider ids that change or disagree do not block new episodes', () => {
        const J1 = 'a1bc9a3d39d68698370bbcd45cfb9c11';
        const J2 = 'b2cd0b4e40e79709481ccde56d0ac22';

        async function seriesWith(ids: Record<string, string>): Promise<string> {
            const [series] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, year, library_group_id)
                VALUES ('Shorefolk', 'tv', 2001, ${libraryPath.library_group_id}) RETURNING id
            `;
            const catalog = createCatalogService(sql);
            for (const [provider, id] of Object.entries(ids)) {
                await catalog.upsertExternalIdDetailed(
                    series.id,
                    { provider, id, mediaType: 'tv', source: 'scanner' },
                    provider === 'jellyfin',
                );
            }
            // Written by an earlier scan, well outside the convergence window.
            await sql`
                UPDATE external_ids SET created_at = now() - interval '2 days'
                WHERE media_id = ${series.id}::uuid
            `;
            return series.id;
        }

        const hierarchy = (filePath: string, candidate: MetadataCandidate) =>
            findOrCreateSeriesHierarchy(
                sql,
                filePath,
                parseMediaFilename(filePath),
                context,
                {
                    candidate,
                    libraryGroupId: libraryPath.library_group_id,
                    libraryRoot: root,
                },
                new Map(),
                new Map(),
                new Set(),
            );

        it('a Jellyfin item re-assigned a new id (TMDB unchanged) still lands on its series', async () => {
            const seriesId = await seriesWith({ jellyfin: J1, tmdb: ORIGINAL.tmdb });
            const filePath = await episode(ORIGINAL, 3);
            const result = await hierarchy(filePath, {
                externalId: J2,
                provider: 'jellyfin',
                title: 'Shorefolk',
                year: 2001,
                mediaType: 'tv',
                confidence: 1,
                externalIds: { tmdb: ORIGINAL.tmdb },
            });
            expect(result).toMatchObject({ outcome: 'added', seriesId });
            expect(await externalIds(seriesId)).toEqual({ jellyfin: J2, tmdb: ORIGINAL.tmdb });
        });

        it('a secondary TVDB id that disagrees with the stored one is skipped, not fatal', async () => {
            const seriesId = await seriesWith({ tmdb: ORIGINAL.tmdb, tvdb: '76156' });
            const filePath = await episode(ORIGINAL, 4);
            const result = await hierarchy(filePath, {
                externalId: ORIGINAL.tmdb,
                provider: 'tmdb',
                title: 'Shorefolk',
                year: 2001,
                mediaType: 'tv',
                confidence: 1,
                externalIds: { tvdb: '999999' },
            });
            expect(result).toMatchObject({ outcome: 'added', seriesId });
            expect(await externalIds(seriesId)).toEqual({ tmdb: ORIGINAL.tmdb, tvdb: '76156' });
        });
    });

    describe('movies: a folder IMDb tag only joins a match the provider confirmed', () => {
        const DAWN = { tmdb: '438631', imdb: 'tt1160419' } as const;
        let movieLibrary: LibraryPathRow;

        beforeEach(async () => {
            const [path] = await sql<LibraryPathRow[]>`
                INSERT INTO library_paths (path, media_type, library_group_id, enabled, provider)
                VALUES (${join(root, 'movies')}, 'movie', ${libraryPath.library_group_id}, true, 'tmdb')
                RETURNING *
            `;
            movieLibrary = path;
            tmdb.search.set('Dawn', [
                {
                    id: Number(DAWN.tmdb),
                    title: 'Dawn',
                    release_date: '2021-09-15',
                    popularity: 80,
                },
            ]);
            return async () => {
                await sql`DELETE FROM library_paths WHERE id = ${path.id}`;
            };
        });

        async function movieFile(): Promise<string> {
            const dir = join(movieLibrary.path, `Dawn (2021) [imdbid-${DAWN.imdb}]`);
            await mkdir(dir, { recursive: true });
            const filePath = join(dir, 'Dawn (2021).mp4');
            await copyFile(FIXTURE, filePath);
            return filePath;
        }

        async function movieIds(filePath: string): Promise<Record<string, string>> {
            const rows = await sql<{ provider: string; external_id: string }[]>`
                SELECT ei.provider, ei.external_id
                FROM media_files mf
                JOIN media_file_items mfi ON mfi.file_id = mf.id
                JOIN external_ids ei ON ei.media_id = mfi.media_item_id AND ei.media_type = 'movie'
                WHERE mf.file_path = ${filePath}
            `;
            return Object.fromEntries(rows.map((row) => [row.provider, row.external_id]));
        }

        const scanMovie = (filePath: string) =>
            processVideoFile(
                sql,
                filePath,
                movieLibrary,
                [TMDB],
                context,
                undefined,
                undefined,
                caches.search,
                false,
            );

        it('/find confirms the tag → the movie gets both ids', async () => {
            tmdb.find.set(DAWN.imdb, {
                externalId: DAWN.tmdb,
                provider: 'tmdb',
                title: 'Dawn',
                year: 2021,
                mediaType: 'movie',
                confidence: 1,
            });
            const filePath = await movieFile();
            expect(await scanMovie(filePath)).toBe('added');
            expect(await movieIds(filePath)).toEqual({ tmdb: DAWN.tmdb, imdb: DAWN.imdb });
        });

        it('a provider item naming a different IMDb id is refused and shown on the Ingest Map', async () => {
            const [jellyfinLibrary] = await sql<LibraryPathRow[]>`
                INSERT INTO library_paths (path, media_type, library_group_id, enabled, provider)
                VALUES (${join(root, 'jf-movies')}, 'movie', ${libraryPath.library_group_id}, true, 'jellyfin')
                RETURNING *
            `;
            try {
                // Jellyfin's search item carries its own ProviderIds; the folder
                // tag names another film.
                tmdb.search.set('Solaris', [
                    {
                        Id: 'c3de1c5f51f80810592ddef67e1bd333',
                        Name: 'Solaris',
                        ProductionYear: 1972,
                        ProviderIds: { Imdb: 'tt0069293', Tmdb: '593' },
                    },
                ]);
                const dir = join(jellyfinLibrary.path, 'Solaris (1972) [imdbid-tt0307479]');
                await mkdir(dir, { recursive: true });
                const filePath = join(dir, 'Solaris (1972).mp4');
                await copyFile(FIXTURE, filePath);
                let reason: string | undefined;
                const outcome = await processVideoFile(
                    sql,
                    filePath,
                    jellyfinLibrary,
                    ['jellyfin-metadata-provider'],
                    context,
                    undefined,
                    undefined,
                    caches.search,
                    false,
                    undefined,
                    undefined,
                    undefined,
                    (r) => {
                        reason = r;
                    },
                );
                expect(outcome).toBe('error');
                expect(reason).toContain('tt0307479');
                expect(reason).toContain('tt0069293');
                expect(await movieIds(filePath)).toEqual({});
                const issues = await listScanIssues(sql);
                expect(issues.map((row) => row.file_path)).toEqual([filePath]);
                expect(issues[0].issues?.map((issue) => issue.type)).toEqual([
                    'movie_identity_conflict',
                ]);
                const [{ movies }] = await sql<{ movies: number }[]>`
                    SELECT count(*)::int AS movies FROM media_items WHERE media_type = 'movie'
                `;
                expect(movies).toBe(0);
            } finally {
                await sql`DELETE FROM library_paths WHERE id = ${jellyfinLibrary.id}`;
            }
        });

        it('/find misses → the title-search match is kept without the unconfirmed tag', async () => {
            const filePath = await movieFile();
            expect(await scanMovie(filePath)).toBe('added');
            expect(await movieIds(filePath)).toEqual({ tmdb: DAWN.tmdb });
        });
    });
});
