// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Real scanner, PostgreSQL hierarchy/catalog, files and ffprobe. Only provider
 * search and lifecycle enqueue are stubbed, so no external network is needed. */
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
import {
    CatalogService,
    createCatalogService,
} from '../../../../../../services/catalog.service.js';
import { listScanIssues } from '../../../../../../database/queries/media-files.queries.js';
import { parseMediaFilename } from '../../../../../../utils/filename-parser.js';
import type { FileScannerContext } from './shared.js';
import { Logger } from '../../../../../../utils/logger.js';

const provider = vi.hoisted(() => ({
    candidates: new Map<string, MetadataCandidate>(),
    afterMatched: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
}));

vi.mock('../../../../../plugin-context.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    isProviderConfigured: vi.fn(async () => true),
}));
vi.mock('../../../../../../services/metadata-matching.service.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    matchFileToMetadata: vi.fn(async (filePath: string) => {
        const candidate = provider.candidates.get(filePath);
        if (!candidate) throw new Error(`Missing provider fixture: ${filePath}`);
        return { matched: true, candidate };
    }),
}));
vi.mock('../../../../../../services/media-lifecycle.service.js', async (importOriginal) => {
    const actual = await importOriginal<{ MediaLifecycleService: object }>();
    return {
        ...actual,
        MediaLifecycleService: Object.assign(Object.create(actual.MediaLifecycleService), {
            afterMatched: provider.afterMatched,
        }),
    };
});

const { processVideoFile, findOrCreateSeriesHierarchy } = await import('./video-processor.js');
const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'test-video.mp4');
const TMDB = 'tmdb-metadata-provider';
const TITLE = 'Scanner Identity Fixture';
const SHOWS = [
    { year: 1998, tmdb: '910001', imdb: 'tt0910001', tvdb: '920001' },
    { year: 2024, tmdb: '910002', imdb: 'tt0910002', tvdb: '920002' },
] as const;

interface EpisodeFile {
    filePath: string;
    year: number;
    season: number;
    episode: number;
}

interface FileHierarchy {
    file_path: string;
    episode_id: string;
    episode_number: number;
    season_id: string;
    season_number: number;
    series_id: string;
    title: string;
    year: number;
    external_id: string;
}

describe('series scan matching (real PG, catalog and ffprobe)', () => {
    let sql: postgres.Sql;
    let root: string;
    let libraryPath: LibraryPathRow;
    let context: FileScannerContext;
    let seriesCache: Map<string, string>;
    let seasonCache: Map<string, string>;
    let announcements: Set<string>;

    beforeAll(() => {
        sql = getTestDb();
        context = {
            sql,
            logger: Logger.for('SeriesScanMatchingTest'),
        };
        vi.spyOn(context.logger, 'warn').mockImplementation(() => undefined);
    });

    afterAll(async () => closeTestDb());

    beforeEach(async () => {
        provider.candidates.clear();
        provider.afterMatched.mockClear();
        seriesCache = new Map();
        seasonCache = new Map();
        announcements = new Set();
        await truncateTables(sql, TEST_TABLES.media);
        root = await mkdtemp(join(tmpdir(), 'lumastra-series-matching-'));
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name)
            VALUES (${`series-matching-${Date.now()}`}) RETURNING id
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

    async function episodeFile(
        show: (typeof SHOWS)[number],
        season: number,
        episode: number,
        candidate?: MetadataCandidate,
    ): Promise<EpisodeFile> {
        const directory = join(root, `${TITLE} (${show.year})`, `Season ${season}`);
        await mkdir(directory, { recursive: true });
        const filePath = join(
            directory,
            `${TITLE} (${show.year}) S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}.mp4`,
        );
        await copyFile(FIXTURE, filePath);
        provider.candidates.set(
            filePath,
            candidate ?? {
                title: TITLE,
                year: show.year,
                provider: 'tmdb',
                externalId: show.tmdb,
                mediaType: 'tv',
                confidence: 1,
                externalIds: { imdb: show.imdb, tvdb: show.tvdb },
            },
        );
        return { filePath, year: show.year, season, episode };
    }

    const scan = (file: EpisodeFile) =>
        processVideoFile(
            sql,
            file.filePath,
            libraryPath,
            [TMDB],
            context,
            undefined,
            undefined,
            undefined,
            false,
            seriesCache,
            seasonCache,
            announcements,
        );

    async function hierarchies(files: EpisodeFile[]): Promise<FileHierarchy[]> {
        const links = await sql<{ file_path: string; links: number }[]>`
            SELECT mf.file_path, count(mfi.media_item_id)::int AS links
            FROM media_files mf
            LEFT JOIN media_file_items mfi ON mfi.file_id = mf.id
            WHERE mf.file_path = ANY(${files.map((file) => file.filePath)})
            GROUP BY mf.file_path
        `;
        expect(links).toHaveLength(files.length);
        expect(links.filter((row) => row.links !== 1)).toEqual([]);
        return sql<FileHierarchy[]>`
            SELECT mf.file_path, ep.id AS episode_id, ep.episode_number,
                   season.id AS season_id, season.season_number,
                   series.id AS series_id, series.title, series.year, ei.external_id
            FROM media_files mf
            JOIN media_file_items mfi ON mfi.file_id = mf.id
            JOIN media_items ep ON ep.id = mfi.media_item_id AND ep.media_type = 'episode'
            JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
            JOIN media_items series ON series.id = season.parent_id AND series.media_type = 'tv'
            JOIN external_ids ei ON ei.media_id = series.id AND ei.provider = 'tmdb'
                               AND ei.media_type = 'tv'
            WHERE mf.file_path = ANY(${files.map((file) => file.filePath)})
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

    it.each([
        'original-first',
        'reboot-first',
        'interleaved',
        'serial-original-first',
        'serial-reboot-first',
    ] as const)(
        '%s concurrent scans keep two seasons of originals/reboots on distinct hierarchies',
        async (order) => {
            const files = await Promise.all(
                SHOWS.flatMap((show) =>
                    [1, 2].flatMap((season) =>
                        [1, 2].map((episode) => episodeFile(show, season, episode)),
                    ),
                ),
            );
            const ordered = order.endsWith('reboot-first')
                ? [...files].reverse()
                : order === 'interleaved'
                  ? [files[0], files[4], files[1], files[5], files[2], files[6], files[3], files[7]]
                  : files;
            const outcomes: string[] = [];
            if (order.startsWith('serial')) {
                for (const file of ordered) outcomes.push(await scan(file));
            } else outcomes.push(...(await Promise.all(ordered.map(scan))));
            expect(outcomes).toEqual(files.map(() => 'added'));

            const first = await hierarchies(files);
            expect(first).toHaveLength(files.length);
            expect(new Set(first.map((row) => row.episode_id)).size).toBe(8);
            expect(new Set(first.map((row) => row.season_id)).size).toBe(4);
            expect(new Set(first.map((row) => row.series_id)).size).toBe(2);
            for (const file of files) {
                const links = first.filter((row) => row.file_path === file.filePath);
                expect(links).toHaveLength(1);
                expect(links[0]).toMatchObject({
                    title: TITLE,
                    year: file.year,
                    season_number: file.season,
                    episode_number: file.episode,
                    external_id: SHOWS.find((show) => show.year === file.year)!.tmdb,
                });
            }
            const [{ series, seasons, episodes }] = await sql<
                { series: number; seasons: number; episodes: number }[]
            >`
                SELECT count(*) FILTER (WHERE media_type = 'tv')::int AS series,
                       count(*) FILTER (WHERE media_type = 'season')::int AS seasons,
                       count(*) FILTER (WHERE media_type = 'episode')::int AS episodes
                FROM media_items
            `;
            expect({ series, seasons, episodes }).toEqual({ series: 2, seasons: 4, episodes: 8 });
            for (const show of SHOWS) {
                const seriesId = first.find((row) => row.year === show.year)!.series_id;
                expect(await externalIds(seriesId)).toEqual({
                    tmdb: show.tmdb,
                    imdb: show.imdb,
                    tvdb: show.tvdb,
                });
                expect(
                    provider.afterMatched.mock.calls.filter((args) => args[0] === seriesId),
                ).toHaveLength(1);
            }

            // A fresh scan has fresh per-library caches; persisted ownership must
            // survive the opposite traversal order and keep every episode UUID.
            seriesCache = new Map();
            seasonCache = new Map();
            announcements = new Set();
            expect(await Promise.all([...ordered].reverse().map(scan))).toEqual(
                files.map(() => 'skipped'),
            );
            expect(await hierarchies(files)).toEqual(first);
        },
    );

    it('backfills an adopted discovery group, preserves manual provenance and leaves unchanged skipped matches quiet', async () => {
        const show = SHOWS[0];
        const [target] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, year)
            VALUES (${TITLE}, 'tv', ${show.year}) RETURNING id
        `;
        const catalog = createCatalogService(sql);
        const primary: import('../../../../../../providers/provider-types.js').ExternalIdWrite = {
            provider: 'tmdb',
            id: show.tmdb,
            mediaType: 'tv',
            source: 'manual',
        };
        await catalog.upsertExternalIdDetailed(target.id, primary, true);
        expect(
            await catalog.upsertExternalIdDetailed(
                target.id,
                { ...primary, source: 'scanner' },
                true,
                { preserveExisting: true },
            ),
        ).toEqual({ written: true, changed: false });
        const files = await Promise.all([1, 2].map((episode) => episodeFile(show, 1, episode)));
        for (const file of files) expect(await scan(file)).toBe('added');
        expect((await hierarchies(files)).every((row) => row.series_id === target.id)).toBe(true);
        const [row] = await sql<{ library_group_id: string; source: string }[]>`
            SELECT mi.library_group_id, ei.source FROM media_items mi
            JOIN external_ids ei ON ei.media_id = mi.id AND ei.provider = 'tmdb'
            WHERE mi.id = ${target.id}
        `;
        expect(row).toEqual({ library_group_id: libraryPath.library_group_id, source: 'manual' });
        provider.afterMatched.mockClear();
        const rangePath = join(
            root,
            `${TITLE} (${show.year})`,
            'Season 1',
            `${TITLE} S01E01E02.mp4`,
        );
        await copyFile(FIXTURE, rangePath);
        const result = await findOrCreateSeriesHierarchy(
            sql,
            rangePath,
            parseMediaFilename(rangePath),
            context,
            {
                candidate: provider.candidates.get(files[0].filePath),
                libraryGroupId: libraryPath.library_group_id,
                libraryRoot: root,
            },
            new Map(),
            new Map(),
            new Set(),
        );
        expect(result.outcome).toBe('skipped');
        expect(provider.afterMatched).not.toHaveBeenCalled();
        expect(
            await catalog.upsertExternalIdDetailed(
                target.id,
                { ...primary, source: 'scanner' },
                true,
                { preserveExisting: true },
            ),
        ).toEqual({ written: true, changed: false });
    });

    it('rejects dashed Jellyfin evidence owned by a different series before creating file links', async () => {
        const targets = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, year)
            VALUES (${TITLE}, 'tv', ${SHOWS[0].year}), (${TITLE}, 'tv', ${SHOWS[1].year}) RETURNING id
        `;
        const catalog = createCatalogService(sql);
        const jellyfin = 'a1bc9a3d39d68698370bbcd45cfb9c11';
        await catalog.upsertExternalIdDetailed(targets[0].id, {
            provider: 'jellyfin',
            id: jellyfin,
            mediaType: 'tv',
        });
        await catalog.upsertExternalIdDetailed(targets[1].id, {
            provider: 'tmdb',
            id: SHOWS[1].tmdb,
            mediaType: 'tv',
        });
        const file = await episodeFile(SHOWS[0], 1, 1, {
            title: TITLE,
            year: SHOWS[0].year,
            provider: 'jellyfin',
            externalId: 'a1bc9a3d-39d6-8698-370b-bcd45cfb9c11',
            mediaType: 'tv',
            confidence: 1,
            externalIds: { tmdb: SHOWS[1].tmdb },
        });
        // Refused, and visible: the file gets a stub row with the reason, so it
        // shows on the Ingest Map instead of only in the run's error list.
        expect(await scan(file)).toBe('error');
        const [{ count }] = await sql<
            { count: number }[]
        >`SELECT count(*)::int AS count FROM media_file_items`;
        expect(count).toBe(0);
        expect(seriesCache.size).toBe(0);
        const issues = await listScanIssues(sql);
        expect(issues.map((row) => row.file_path)).toEqual([file.filePath]);
        expect(issues[0].issues).toEqual([
            expect.objectContaining({
                type: 'series_identity_conflict',
                detail: expect.stringContaining('Conflicting series identity evidence'),
            }),
        ]);
    });

    it('skips a secondary identity a concurrent foreign owner claims and still links the file', async () => {
        const [foreign] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, year) VALUES ('Foreign fixture', 'tv', 2024) RETURNING id
        `;
        const catalog = createCatalogService(sql);
        const originalRead = CatalogService.prototype.getExternalIds;
        const readSpy = vi.spyOn(CatalogService.prototype, 'getExternalIds');
        readSpy.mockImplementationOnce(async function (this: CatalogService, mediaId: string) {
            const before = await originalRead.call(this, mediaId);
            await catalog.upsertExternalIdDetailed(foreign.id, {
                provider: 'tvdb',
                id: SHOWS[0].tvdb,
                mediaType: 'tv',
                source: 'manual',
            });
            return before;
        });
        const file = await episodeFile(SHOWS[0], 1, 1);
        try {
            expect(await scan(file)).toBe('added');
        } finally {
            readSpy.mockRestore();
        }
        // The TVDB id stays with its owner; the series keeps its own ids and the
        // episode is linked to it.
        const [row] = await hierarchies([file]);
        expect(await externalIds(row.series_id)).toEqual({
            tmdb: SHOWS[0].tmdb,
            imdb: SHOWS[0].imdb,
        });
        expect(await externalIds(foreign.id)).toEqual({ tvdb: SHOWS[0].tvdb });
    });

    it('later compatible evidence and another provider persist on one series with one announcement', async () => {
        const show = SHOWS[0];
        const base: MetadataCandidate = {
            title: TITLE,
            year: show.year,
            provider: 'tmdb',
            externalId: show.tmdb,
            mediaType: 'tv',
            confidence: 1,
        };
        const first = await episodeFile(show, 1, 1, base);
        expect(await scan(first)).toBe('added');
        const [{ series_id: seriesId }] = await hierarchies([first]);
        expect(await externalIds(seriesId)).toEqual({ tmdb: show.tmdb });

        const later = await episodeFile(show, 1, 2, {
            ...base,
            externalIds: { imdb: show.imdb, tvdb: show.tvdb, trakt: '930001' },
        });
        const anotherProvider = await episodeFile(show, 2, 1, {
            ...base,
            provider: 'jellyfin',
            externalId: '00000000000000000000000000910001',
            externalIds: { tmdb: show.tmdb, imdb: show.imdb, mal: '940001' },
        });
        expect(await Promise.all([later, anotherProvider].map(scan))).toEqual(['added', 'added']);
        const rows = await hierarchies([first, later, anotherProvider]);
        expect(rows).toHaveLength(3);
        expect(rows.every((row) => row.series_id === seriesId)).toBe(true);
        expect(await externalIds(seriesId)).toEqual({
            tmdb: show.tmdb,
            imdb: show.imdb,
            tvdb: show.tvdb,
            trakt: '930001',
            mal: '940001',
            jellyfin: '00000000000000000000000000910001',
        });
        expect(provider.afterMatched).toHaveBeenCalledTimes(1);
    });

    it('atomically preserves a provider mapping introduced after the scanner pre-check', async () => {
        const [target] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, year, library_group_id)
            VALUES (${TITLE}, 'tv', ${SHOWS[0].year}, ${libraryPath.library_group_id})
            RETURNING id
        `;
        const catalog = createCatalogService(sql);
        const originalRead = CatalogService.prototype.getExternalIds;
        const readSpy = vi.spyOn(CatalogService.prototype, 'getExternalIds');
        readSpy.mockImplementationOnce(originalRead);
        readSpy.mockImplementationOnce(async function (this: CatalogService, mediaId: string) {
            const before = await originalRead.call(this, mediaId);
            await catalog.upsertExternalIdDetailed(target.id, {
                provider: 'tmdb',
                id: SHOWS[1].tmdb,
                mediaType: 'tv',
                source: 'manual',
            });
            return before;
        });
        try {
            const file = await episodeFile(SHOWS[0], 1, 1);
            await findOrCreateSeriesHierarchy(
                sql,
                file.filePath,
                parseMediaFilename(file.filePath),
                context,
                {
                    resolvedSeriesId: target.id,
                    candidate: provider.candidates.get(file.filePath),
                    libraryGroupId: libraryPath.library_group_id,
                    libraryRoot: root,
                },
                seriesCache,
                seasonCache,
                announcements,
            );
        } finally {
            readSpy.mockRestore();
        }
        // Preservation is independent of the legacy freshness guard, which
        // manual writes bypass. Even that bypass cannot replace a mapping when
        // the caller explicitly requests preservation.
        expect(
            await catalog.upsertExternalIdDetailed(
                target.id,
                { provider: 'tmdb', id: SHOWS[0].tmdb, mediaType: 'tv', source: 'manual' },
                false,
                { preserveExisting: true },
            ),
        ).toEqual({ written: false, changed: false });
        expect((await externalIds(target.id)).tmdb).toBe(SHOWS[1].tmdb);
        expect(context.logger.warn).toHaveBeenCalledWith(
            '[FileScanner] Series identity write rejected',
            expect.objectContaining({ seriesId: target.id }),
        );
    });

    it('explicit resolution preserves historical mappings and foreign ID owners while enriching compatible IDs', async () => {
        const [target, foreign] = await sql<{ id: string; year: number }[]>`
            INSERT INTO media_items (title, media_type, year, library_group_id)
            VALUES (${TITLE}, 'tv', ${SHOWS[0].year}, ${libraryPath.library_group_id}),
                   (${TITLE}, 'tv', ${SHOWS[1].year}, ${libraryPath.library_group_id})
            RETURNING id, year
        `;
        const catalog = createCatalogService(sql);
        expect(
            await catalog.upsertExternalIdDetailed(
                target.id,
                { provider: 'tmdb', id: SHOWS[0].tmdb, mediaType: 'tv', source: 'scanner' },
                true,
            ),
        ).toEqual({ written: true, changed: true });
        expect(
            await catalog.upsertExternalIdDetailed(
                foreign.id,
                { provider: 'imdb', id: SHOWS[1].imdb, mediaType: 'tv', source: 'scanner' },
                true,
            ),
        ).toEqual({ written: true, changed: true });

        const candidate: MetadataCandidate = {
            title: TITLE,
            year: SHOWS[0].year,
            provider: 'tmdb',
            externalId: '910099',
            mediaType: 'tv',
            confidence: 1,
            externalIds: { imdb: SHOWS[1].imdb, tvdb: SHOWS[0].tvdb },
        };
        const files = await Promise.all(
            [1, 2].map((episode) => episodeFile(SHOWS[0], 1, episode, candidate)),
        );
        const results = await Promise.all(
            files.map((file) =>
                findOrCreateSeriesHierarchy(
                    sql,
                    file.filePath,
                    parseMediaFilename(file.filePath),
                    context,
                    {
                        resolvedSeriesId: target.id,
                        candidate,
                        libraryGroupId: libraryPath.library_group_id,
                        libraryRoot: root,
                    },
                    seriesCache,
                    seasonCache,
                    announcements,
                ),
            ),
        );
        expect(results.map((result) => result.seriesId)).toEqual([target.id, target.id]);
        expect(results.map((result) => result.outcome)).toEqual(['added', 'added']);
        expect((await hierarchies(files)).every((row) => row.series_id === target.id)).toBe(true);
        expect(await externalIds(target.id)).toEqual({
            tmdb: SHOWS[0].tmdb,
            tvdb: SHOWS[0].tvdb,
        });
        expect(await externalIds(foreign.id)).toEqual({ imdb: SHOWS[1].imdb });
        const [{ count }] = await sql<{ count: number }[]>`
            SELECT count(*)::int AS count FROM external_ids
            WHERE provider = 'tmdb' AND external_id = ${candidate.externalId} AND media_type = 'tv'
        `;
        expect(count).toBe(0);
        expect(context.logger.warn).toHaveBeenCalledWith(
            '[FileScanner] Conflicting series provider mapping',
            expect.objectContaining({ seriesId: target.id, keeping: SHOWS[0].tmdb }),
        );
        expect(context.logger.warn).toHaveBeenCalledWith(
            '[FileScanner] Series identity enrichment failed',
            expect.objectContaining({ seriesId: target.id, provider: 'imdb', id: SHOWS[1].imdb }),
        );
        expect(provider.afterMatched).toHaveBeenCalledTimes(1);
        expect(provider.afterMatched).toHaveBeenCalledWith(
            target.id,
            'tv',
            { enqueueMetadataSync: true },
            sql,
        );
    });
});
