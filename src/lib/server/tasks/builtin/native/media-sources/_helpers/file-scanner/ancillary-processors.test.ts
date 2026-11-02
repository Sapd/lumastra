// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

const {
    mockFindParentMediaItemByFolder,
    mockFindParentMediaItemsByFolders,
    mockFindArtistByChildFolder,
    mockFindTvSeriesByFolderWithSeasonDirectory,
    mockFindSeasonParentIfEpisode,
    mockUpsertLocalArtworkWithOutcome,
    mockFindManagedArtworkClaimForPath,
    mockFindMediaFileByPath,
    mockSafeReaddir,
    mockUpsertExternalSubtitle,
    mockRefreshLanguagesForFile,
    mockFindLocalArtworkOwnedByOtherLibrary,
    mockSafeExists,
} = vi.hoisted(() => ({
    mockFindLocalArtworkOwnedByOtherLibrary: vi.fn(),
    mockSafeExists: vi.fn(),
    mockFindParentMediaItemByFolder: vi.fn(),
    // Default: the batched prefetch is unavailable, so the resolution under
    // test is the per-folder path. The folder-lookup suite below opts in.
    mockFindParentMediaItemsByFolders: vi.fn<
        (sql: unknown, folders: readonly string[]) => Promise<Map<string, string | null>>
    >(() => Promise.reject(new Error('no batch'))),
    mockFindArtistByChildFolder: vi.fn(),
    mockFindTvSeriesByFolderWithSeasonDirectory: vi.fn(),
    mockFindSeasonParentIfEpisode: vi.fn(),
    mockUpsertLocalArtworkWithOutcome: vi.fn(),
    mockFindManagedArtworkClaimForPath: vi.fn(),
    mockFindMediaFileByPath: vi.fn(),
    mockSafeReaddir: vi.fn(),
    mockUpsertExternalSubtitle: vi.fn(),
    mockRefreshLanguagesForFile: vi.fn(),
}));

// Every name imported from this module ANYWHERE in the graph must appear here —
// vitest's mock namespace throws "No <name> export is defined on the mock" the
// first time an absent one is read. `ancillary-processors.ts:14-25` imports ten
// of them; `./shared.ts:14` additionally imports `updateFileStat`.
vi.mock('../../../../../../database/queries/media-files.queries.js', () => ({
    upsertMediaFile: vi.fn(),
    attachFileToItem: vi.fn(),
    touchLibraryAddedAt: vi.fn(),
    isFileLinkedToMediaItem: vi.fn(),
    findParentMediaItemByFolder: mockFindParentMediaItemByFolder,
    findParentMediaItemsByFolders: mockFindParentMediaItemsByFolders,
    findMediaItemByFilePath: vi.fn(),
    findSeasonParentIfEpisode: mockFindSeasonParentIfEpisode,
    findMediaFileByPath: mockFindMediaFileByPath,
    findArtistByChildFolder: mockFindArtistByChildFolder,
    findRootMediaItemByFolderRecursive: vi.fn(),
    findTvSeriesByFolderWithSeasonDirectory: mockFindTvSeriesByFolderWithSeasonDirectory,
    loadMediaFileIdsByPrefix: vi.fn(),
    updateFileStat: vi.fn(),
}));

vi.mock('../../../../../../database/queries/media-artwork.queries.js', () => ({
    upsertLocalArtworkWithOutcome: mockUpsertLocalArtworkWithOutcome,
    findManagedArtworkClaimForPath: mockFindManagedArtworkClaimForPath,
}));

vi.mock('../../../../../../database/queries/external-subtitles.queries.js', () => ({
    upsertExternalSubtitle: mockUpsertExternalSubtitle,
    loadExternalSubtitlesByPrefix: vi.fn(),
}));

vi.mock('../../../../../../database/queries/media-item-languages.queries.js', () => ({
    refreshLanguagesForFile: mockRefreshLanguagesForFile,
}));

// The real helper opens a transaction; the processor only needs the callback to
// run and its value to come back out.
vi.mock('../../../../../../database/with-tx.js', () => ({
    withTx: (s: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(s),
}));

vi.mock('$lib/server/utils/safe-fs.js', () => ({
    safeReaddir: mockSafeReaddir,
    safeStat: vi.fn(),
    safeExists: mockSafeExists,
}));

vi.mock('../../../../../../database/queries/local-artwork-owner.queries.js', () => ({
    findLocalArtworkOwnedByOtherLibrary: mockFindLocalArtworkOwnedByOtherLibrary,
}));

import {
    processArtwork,
    createArtworkGroupProcessor,
    orderArtworkLastWriterFirst,
    processExternalSubtitle,
    resolveArtworkTargets,
    artworkTargetKey,
    artworkWriteKey,
    type SubtitleScanBatch,
} from './ancillary-processors.js';

const sql = {} as unknown as postgres.Sql;
const context = {
    sql,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
} as never;

const SERIES = 'aaaaaaaa-0000-0000-0000-00000000000a';
const SEASON = 'bbbbbbbb-0000-0000-0000-00000000000b';
const EPISODE = 'cccccccc-0000-0000-0000-00000000000c';

describe('processArtwork — managed-claim guard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockUpsertLocalArtworkWithOutcome.mockResolvedValue('inserted');
        mockFindManagedArtworkClaimForPath.mockResolvedValue(null);
        mockFindTvSeriesByFolderWithSeasonDirectory.mockResolvedValue(null);
    });

    it('registers artwork normally when nothing else claims the file', async () => {
        mockFindParentMediaItemByFolder.mockResolvedValue(EPISODE);
        mockFindSeasonParentIfEpisode.mockResolvedValue(SEASON);

        const result = await processArtwork(
            sql,
            { filePath: '/series/Show/Season 01/poster.jpg', artworkType: 'poster' },
            context,
        );

        expect(result).toBe('added');
        expect(mockUpsertLocalArtworkWithOutcome).toHaveBeenCalledWith(sql, {
            mediaItemId: SEASON,
            artworkType: 'poster',
            filePath: '/series/Show/Season 01/poster.jpg',
        });
    });

    it('resolves each folder ONCE up front, then claims + upserts every file', async () => {
        mockFindParentMediaItemByFolder.mockResolvedValue(null);
        mockFindTvSeriesByFolderWithSeasonDirectory.mockResolvedValue(SERIES);
        mockFindSeasonParentIfEpisode.mockResolvedValue(null);
        const files = [
            { filePath: '/series/Show/poster.jpg', artworkType: 'poster' as const },
            { filePath: '/series/Show/backdrop.jpg', artworkType: 'backdrop' as const },
            { filePath: '/series/Show/logo.png', artworkType: 'logo' as const },
        ];

        const targets = await resolveArtworkTargets(sql, files, 3, () => false);
        for (const f of files) await processArtwork(sql, f, context, targets);

        expect(mockFindTvSeriesByFolderWithSeasonDirectory).toHaveBeenCalledTimes(1);
        expect(mockFindParentMediaItemByFolder).toHaveBeenCalledTimes(1);
        // The claim guard and the upsert are per FILE — never cached.
        expect(mockFindManagedArtworkClaimForPath).toHaveBeenCalledTimes(3);
        expect(mockUpsertLocalArtworkWithOutcome).toHaveBeenCalledTimes(3);
        expect(mockUpsertLocalArtworkWithOutcome).toHaveBeenLastCalledWith(sql, {
            mediaItemId: SERIES,
            artworkType: 'logo',
            filePath: '/series/Show/logo.png',
        });
    });

    it("keys a flat season file apart from its folder's own artwork", () => {
        expect(
            artworkTargetKey({ filePath: '/series/Show/poster.jpg', artworkType: 'poster' }),
        ).not.toBe(
            artworkTargetKey({
                filePath: '/series/Show/season02-poster.jpg',
                artworkType: 'poster',
                seasonNumber: 2,
            }),
        );
    });

    it('a failed lookup is not cached: each file retries it and reports its own error', async () => {
        mockFindParentMediaItemByFolder.mockRejectedValueOnce(new Error('pool timeout'));
        mockFindParentMediaItemByFolder.mockResolvedValue(EPISODE);
        mockFindSeasonParentIfEpisode.mockResolvedValue(SEASON);
        const file = {
            filePath: '/series/Show/Season 01/poster.jpg',
            artworkType: 'poster' as const,
        };

        const targets = await resolveArtworkTargets(sql, [file], 1, () => false);
        expect(targets.size).toBe(0);
        await expect(processArtwork(sql, file, context, targets)).resolves.toBe('added');
    });

    it('two top-level folders resolving to ONE series share a write key (ordered writes)', async () => {
        // Anime: `Show/` and `Show Final Season/` both matched to one series.
        mockFindParentMediaItemByFolder.mockResolvedValue(null);
        mockFindTvSeriesByFolderWithSeasonDirectory.mockResolvedValue(SERIES);
        mockFindSeasonParentIfEpisode.mockResolvedValue(null);
        const a = { filePath: '/anime/Show/poster.jpg', artworkType: 'poster' as const };
        const b = {
            filePath: '/anime/Show Final Season/poster.jpg',
            artworkType: 'poster' as const,
        };
        const c = { filePath: '/anime/Show/backdrop.jpg', artworkType: 'backdrop' as const };

        const targets = await resolveArtworkTargets(sql, [a, b, c], 3, () => false);

        expect(artworkWriteKey(a, targets)).toBe(artworkWriteKey(b, targets));
        expect(artworkWriteKey(a, targets)).not.toBe(artworkWriteKey(c, targets));
    });

    it('uses the constrained TV-series fallback for root artwork without a direct file', async () => {
        mockFindParentMediaItemByFolder.mockResolvedValue(null);
        mockFindTvSeriesByFolderWithSeasonDirectory.mockResolvedValue(SERIES);
        mockFindSeasonParentIfEpisode.mockResolvedValue(null);

        const result = await processArtwork(
            sql,
            { filePath: '/series/Show/backdrop.jpg', artworkType: 'backdrop' },
            context,
        );

        expect(result).toBe('added');
        expect(mockFindTvSeriesByFolderWithSeasonDirectory).toHaveBeenCalledWith(
            sql,
            '/series/Show',
        );
        expect(mockUpsertLocalArtworkWithOutcome).toHaveBeenCalledWith(sql, {
            mediaItemId: SERIES,
            artworkType: 'backdrop',
            filePath: '/series/Show/backdrop.jpg',
        });
    });

    it('refuses to re-attribute a file a managed row on ANOTHER item claims', async () => {
        // Folderless layout: /series/Show/poster.jpg is the SERIES poster this
        // feature materialized, but the folder holds episode files, so the scanner
        // resolves it to season 1.
        mockFindParentMediaItemByFolder.mockResolvedValue(EPISODE);
        mockFindSeasonParentIfEpisode.mockResolvedValue(SEASON);
        mockFindManagedArtworkClaimForPath.mockResolvedValue({
            media_item_id: SERIES,
            artwork_type: 'poster',
        });

        const result = await processArtwork(
            sql,
            { filePath: '/series/Show/poster.jpg', artworkType: 'poster' },
            context,
        );

        expect(result).toBe('skipped');
        expect(mockUpsertLocalArtworkWithOutcome).not.toHaveBeenCalled();
    });

    it('passes the RESOLVED target as the exclusion, not the raw folder match', async () => {
        mockFindParentMediaItemByFolder.mockResolvedValue(EPISODE);
        mockFindSeasonParentIfEpisode.mockResolvedValue(SEASON);

        await processArtwork(
            sql,
            { filePath: '/series/Show/Season 01/poster.jpg', artworkType: 'poster' },
            context,
        );

        expect(mockFindManagedArtworkClaimForPath).toHaveBeenCalledWith(
            sql,
            '/series/Show/Season 01/poster.jpg',
            SEASON,
        );
    });

    it('still returns skipped when no media item resolves at all', async () => {
        mockFindParentMediaItemByFolder.mockResolvedValue(null);
        mockFindArtistByChildFolder.mockResolvedValue(null);

        const result = await processArtwork(
            sql,
            { filePath: '/orphan/poster.jpg', artworkType: 'poster' },
            context,
        );

        expect(result).toBe('skipped');
        expect(mockFindManagedArtworkClaimForPath).not.toHaveBeenCalled();
    });

    it('still returns skipped when the write is tombstoned', async () => {
        mockFindParentMediaItemByFolder.mockResolvedValue(EPISODE);
        mockFindSeasonParentIfEpisode.mockResolvedValue(SEASON);
        mockUpsertLocalArtworkWithOutcome.mockResolvedValue('suppressed');

        const result = await processArtwork(
            sql,
            { filePath: '/series/Show/Season 01/poster.jpg', artworkType: 'poster' },
            context,
        );

        expect(result).toBe('skipped');
    });
});

/**
 * The scan summary's honesty, pinned at the two seams that lied.
 *
 * Both of these passes re-walk EVERY sidecar on EVERY scan cycle and used to
 * return 'added' for all of them. On production that made the admin Library
 * page report `+6599 added` for /data/anime — a library of 823 media items that
 * had gained 3 in 24 hours — every hour, forever. The rule these tests hold is
 * one sentence: a file whose row is already exactly right is NOT an addition.
 */
describe('scan-outcome honesty — an unchanged file is never "added"', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockFindManagedArtworkClaimForPath.mockResolvedValue(null);
        mockFindTvSeriesByFolderWithSeasonDirectory.mockResolvedValue(null);
        mockFindParentMediaItemByFolder.mockResolvedValue(EPISODE);
        mockFindSeasonParentIfEpisode.mockResolvedValue(SEASON);
    });

    const artwork = () =>
        processArtwork(
            sql,
            { filePath: '/series/Show/Season 01/poster.jpg', artworkType: 'poster' },
            context,
        );

    it('reports a re-registered artwork sidecar as skipped, not added', async () => {
        mockUpsertLocalArtworkWithOutcome.mockResolvedValue('unchanged');
        await expect(artwork()).resolves.toBe('skipped');
    });

    it('reports a re-pointed artwork row as updated, not added', async () => {
        mockUpsertLocalArtworkWithOutcome.mockResolvedValue('updated');
        await expect(artwork()).resolves.toBe('updated');
    });

    it('still reports a genuinely new artwork row as added', async () => {
        mockUpsertLocalArtworkWithOutcome.mockResolvedValue('inserted');
        await expect(artwork()).resolves.toBe('added');
    });
});

describe('processExternalSubtitle — outcome follows the row, not the walk', () => {
    const SUBTITLE = '/series/Show/Season 01/S01E01.en.srt';

    beforeEach(() => {
        vi.clearAllMocks();
        // One paired video file sitting next to the sidecar.
        mockSafeReaddir.mockResolvedValue([{ name: 'S01E01.mkv', isFile: () => true }]);
        mockFindMediaFileByPath.mockResolvedValue({ id: 'file-1' });
        mockRefreshLanguagesForFile.mockResolvedValue(undefined);
    });

    it('reports a sidecar whose row is already correct as skipped', async () => {
        mockUpsertExternalSubtitle.mockResolvedValue('unchanged');
        await expect(processExternalSubtitle(sql, SUBTITLE, context)).resolves.toBe('skipped');
    });

    it('reports a changed sidecar row as updated', async () => {
        mockUpsertExternalSubtitle.mockResolvedValue('updated');
        await expect(processExternalSubtitle(sql, SUBTITLE, context)).resolves.toBe('updated');
    });

    it('reports a first-time sidecar as added', async () => {
        mockUpsertExternalSubtitle.mockResolvedValue('inserted');
        await expect(processExternalSubtitle(sql, SUBTITLE, context)).resolves.toBe('added');
    });

    // The language projection is the one thing that back-fills a sidecar
    // registered before its video was linked to an item. That file's subtitle
    // row never changes again, so gating the refresh on "the row changed" would
    // strand the item out of the /browse subtitle filter permanently.
    it('still refreshes the language projection on an unchanged row', async () => {
        mockUpsertExternalSubtitle.mockResolvedValue('unchanged');
        await processExternalSubtitle(sql, SUBTITLE, context);
        expect(mockRefreshLanguagesForFile).toHaveBeenCalledWith(sql, 'file-1');
    });
});

describe('processExternalSubtitle — batch mode (library scan)', () => {
    const DIR = '/series/Show/Season 01';
    const EN = `${DIR}/S01E01.en.srt`;
    const DE = `${DIR}/S01E01.de.srt`;

    function batch(existing: SubtitleScanBatch['existing'] = new Map()): SubtitleScanBatch {
        return {
            existing,
            fileIdByPath: new Map([[`${DIR}/S01E01.mkv`, 'file-1']]),
            dirEntries: new Map(),
            orphanedFileIds: new Set(),
        };
    }
    const row = (fileId: string, language: string) => ({
        file_id: fileId,
        language,
        format: 'srt',
        is_forced: false,
        is_sdh: false,
    });

    beforeEach(() => {
        vi.clearAllMocks();
        mockSafeReaddir.mockResolvedValue([{ name: 'S01E01.mkv', isFile: () => true }]);
    });

    it('an unchanged sidecar touches neither the DB nor the projection', async () => {
        const b = batch(new Map([[EN, row('file-1', 'en')]]));
        await expect(processExternalSubtitle(sql, EN, context, b)).resolves.toBe('skipped');
        expect(mockUpsertExternalSubtitle).not.toHaveBeenCalled();
        expect(mockFindMediaFileByPath).not.toHaveBeenCalled();
        // The projection is converged once per pass by the scanner, never per sidecar.
        expect(mockRefreshLanguagesForFile).not.toHaveBeenCalled();
    });

    it('reads a shared directory once for all its sidecars', async () => {
        const b = batch(
            new Map([
                [EN, row('file-1', 'en')],
                [DE, row('file-1', 'de')],
            ]),
        );
        await processExternalSubtitle(sql, EN, context, b);
        await processExternalSubtitle(sql, DE, context, b);
        expect(mockSafeReaddir).toHaveBeenCalledTimes(1);
    });

    it('upserts a new sidecar and reports it added', async () => {
        mockUpsertExternalSubtitle.mockResolvedValue('inserted');
        await expect(processExternalSubtitle(sql, EN, context, batch())).resolves.toBe('added');
        expect(mockUpsertExternalSubtitle).toHaveBeenCalledWith(
            sql,
            expect.objectContaining({ fileId: 'file-1', subtitlePath: EN, language: 'en' }),
        );
        expect(mockRefreshLanguagesForFile).not.toHaveBeenCalled();
    });

    it('records the file a re-paired sidecar left, so its projection is converged too', async () => {
        mockUpsertExternalSubtitle.mockResolvedValue('updated');
        const b = batch(new Map([[EN, row('file-OLD', 'en')]]));
        await expect(processExternalSubtitle(sql, EN, context, b)).resolves.toBe('updated');
        expect([...b.orphanedFileIds]).toEqual(['file-OLD']);
    });

    it('a changed language on the same file is upserted but orphans nothing', async () => {
        mockUpsertExternalSubtitle.mockResolvedValue('updated');
        const b = batch(new Map([[EN, row('file-1', 'fr')]]));
        await expect(processExternalSubtitle(sql, EN, context, b)).resolves.toBe('updated');
        expect(b.orphanedFileIds.size).toBe(0);
    });
});

// Prod reported the same "+0 new · N updated" on every hourly scan with nothing
// on disk changing (movies 216, 4kmovies 216, anime 58, series 14, music 118).
// The artwork pass was the writer: several files aimed at one media_artwork row
// each rewrote it in turn, and one item with sidecars in two library folders had
// its row re-pointed by each folder's scan.
describe('artwork pass — a row several files aim at is written once, not flipped', () => {
    const FOLDER = '/data/movies/Film (2020)';
    const poster = { filePath: `${FOLDER}/poster.jpg`, artworkType: 'poster' as const };
    const folderJpg = { filePath: `${FOLDER}/folder.jpg`, artworkType: 'poster' as const };
    const MOVIE = 'dddddddd-0000-0000-0000-00000000000d';

    // Row state as the real upsert keeps it: one local row per (item, type).
    let rowFilePath: string | null;

    beforeEach(() => {
        vi.clearAllMocks();
        rowFilePath = null;
        mockFindParentMediaItemByFolder.mockResolvedValue(MOVIE);
        mockFindSeasonParentIfEpisode.mockResolvedValue(null);
        mockFindTvSeriesByFolderWithSeasonDirectory.mockResolvedValue(null);
        mockFindManagedArtworkClaimForPath.mockResolvedValue(null);
        mockFindLocalArtworkOwnedByOtherLibrary.mockResolvedValue(null);
        mockSafeExists.mockResolvedValue(true);
        mockUpsertLocalArtworkWithOutcome.mockImplementation(
            async (_sql: unknown, p: { filePath: string }) => {
                if (rowFilePath === p.filePath) return 'unchanged';
                const outcome = rowFilePath === null ? 'inserted' : 'updated';
                rowFilePath = p.filePath;
                return outcome;
            },
        );
    });

    async function scan(files: { filePath: string; artworkType: 'poster' }[]) {
        const targets = await resolveArtworkTargets(sql, files, 3, () => false);
        const processor = createArtworkGroupProcessor(sql, context, targets, '/data/movies');
        const outcomes = [];
        for (const f of orderArtworkLastWriterFirst(files, targets)) {
            outcomes.push(await processor(f));
        }
        return outcomes;
    }

    it('reports NOTHING updated on a rescan where no file changed', async () => {
        await scan([poster, folderJpg]);
        const second = await scan([poster, folderJpg]);

        expect(second).not.toContain('updated');
        expect(second).not.toContain('added');
    });

    it('lands on the same file "last write wins" picked, writing it once', async () => {
        const first = await scan([poster, folderJpg]);

        expect(rowFilePath).toBe(folderJpg.filePath);
        expect(mockUpsertLocalArtworkWithOutcome).toHaveBeenCalledTimes(1);
        expect(first.filter((o) => o === 'added')).toHaveLength(1);
    });

    it('falls back to the earlier file when the winner is admin-suppressed', async () => {
        mockUpsertLocalArtworkWithOutcome.mockImplementation(
            async (_sql: unknown, p: { filePath: string }) => {
                if (p.filePath === folderJpg.filePath) return 'suppressed';
                rowFilePath = p.filePath;
                return 'inserted';
            },
        );

        await scan([poster, folderJpg]);

        expect(rowFilePath).toBe(poster.filePath);
    });

    it("leaves a row owned by another enabled library's live file alone", async () => {
        mockFindLocalArtworkOwnedByOtherLibrary.mockResolvedValue(
            '/data/4kmovies/Film (2020)/poster.jpg',
        );

        const outcomes = await scan([poster]);

        expect(outcomes).toEqual(['skipped']);
        expect(mockUpsertLocalArtworkWithOutcome).not.toHaveBeenCalled();
        expect(mockFindLocalArtworkOwnedByOtherLibrary).toHaveBeenCalledWith(
            sql,
            MOVIE,
            'poster',
            '/data/movies',
        );
    });

    it("takes the row over when the other library's file is gone from disk", async () => {
        mockFindLocalArtworkOwnedByOtherLibrary.mockResolvedValue(
            '/data/4kmovies/Film (2020)/poster.jpg',
        );
        mockSafeExists.mockResolvedValue(false);

        await scan([poster]);

        expect(rowFilePath).toBe(poster.filePath);
    });
});

describe('artwork target resolution — batched and memoised folder lookups change no target', () => {
    // A fake folder -> item table both lookups read, so the batch and the
    // per-folder query answer from the same data, as the real ones do.
    const LINKED: Record<string, string> = {
        '/movies/Film A (2020)': 'movie-a',
        '/movies/Film B (2021)': 'movie-b',
        '/series/Show/Season 01': EPISODE,
        '/music/Artist One/Album': 'track-1',
        '/music/Artist Two/Album': 'track-2',
    };
    const ARTISTS: Record<string, string> = {
        '/music/Artist One': 'artist-1',
        '/music/Artist Two': 'artist-2',
        '/music/Artist Three': 'artist-3',
    };
    const files = [
        { filePath: '/movies/Film A (2020)/poster.jpg', artworkType: 'poster' as const },
        { filePath: '/movies/Film A (2020)/backdrop.jpg', artworkType: 'backdrop' as const },
        { filePath: '/movies/Film B (2021)/poster.jpg', artworkType: 'poster' as const },
        { filePath: '/series/Show/Season 01/poster.jpg', artworkType: 'poster' as const },
        { filePath: '/music/Artist One/Album/cover.jpg', artworkType: 'poster' as const },
        { filePath: '/music/Artist One/folder.jpg', artworkType: 'poster' as const },
        { filePath: '/music/Artist Two/folder.jpg', artworkType: 'poster' as const },
        { filePath: '/music/Artist Three/logo.png', artworkType: 'logo' as const },
        { filePath: '/music/Unknown/folder.jpg', artworkType: 'poster' as const },
    ];

    beforeEach(() => {
        vi.clearAllMocks();
        mockFindParentMediaItemByFolder.mockImplementation(
            async (_sql: unknown, folder: string) => LINKED[folder] ?? null,
        );
        mockFindTvSeriesByFolderWithSeasonDirectory.mockResolvedValue(null);
        mockFindArtistByChildFolder.mockImplementation(
            async (_sql: unknown, folder: string) => ARTISTS[folder] ?? null,
        );
        mockFindSeasonParentIfEpisode.mockImplementation(async (_sql: unknown, id: string) =>
            id === EPISODE ? SEASON : null,
        );
    });

    const batchFromTable = (): void => {
        mockFindParentMediaItemsByFolders.mockImplementationOnce(
            async (_sql: unknown, folders: readonly string[]) =>
                new Map(folders.map((f) => [f, LINKED[f] ?? null])),
        );
    };

    const asObject = (m: Map<string, unknown>): Record<string, unknown> =>
        Object.fromEntries([...m].sort(([a], [b]) => a.localeCompare(b)));

    it('resolves every folder to the same target as the per-folder path', async () => {
        const perFolder = await resolveArtworkTargets(sql, files, 3, () => false);
        batchFromTable();
        const batched = await resolveArtworkTargets(sql, files, 3, () => false);

        expect(asObject(batched)).toEqual(asObject(perFolder));
        // Pinned, so a mistake shared by both paths cannot hide.
        expect(asObject(batched)).toEqual({
            '/movies/Film A (2020)': { kind: 'target', id: 'movie-a' },
            '/movies/Film B (2021)': { kind: 'target', id: 'movie-b' },
            '/music/Artist One': { kind: 'target', id: 'artist-1' },
            '/music/Artist One/Album': { kind: 'target', id: 'track-1' },
            '/music/Artist Three': { kind: 'target', id: 'artist-3' },
            '/music/Artist Two': { kind: 'target', id: 'artist-2' },
            '/music/Unknown': { kind: 'skip', message: 'no media_item for artwork' },
            '/series/Show/Season 01': { kind: 'target', id: SEASON },
        });
    });

    it('prefetches each own folder once and queries a shared parent folder once', async () => {
        batchFromTable();
        // Width 1: answers are memoised, in-flight queries are not, so parallel
        // workers may each query a parent folder until the first answer lands.
        await resolveArtworkTargets(sql, files, 1, () => false);

        expect(mockFindParentMediaItemsByFolders).toHaveBeenCalledTimes(1);
        expect([...mockFindParentMediaItemsByFolders.mock.calls[0]![1]].sort()).toEqual([
            '/movies/Film A (2020)',
            '/movies/Film B (2021)',
            '/music/Artist One',
            '/music/Artist One/Album',
            '/music/Artist Three',
            '/music/Artist Two',
            '/music/Unknown',
            '/series/Show/Season 01',
        ]);
        // Only the parent-folder fallback is left per-folder: four artist-level
        // folders miss, all with the parent /music — one query, not four.
        expect(mockFindParentMediaItemByFolder.mock.calls.map((c) => c[1])).toEqual(['/music']);
    });

    it('without the batch, a shared parent folder is still queried once', async () => {
        await resolveArtworkTargets(sql, files, 1, () => false);

        const parentCalls = mockFindParentMediaItemByFolder.mock.calls.filter(
            (c) => c[1] === '/music',
        );
        expect(parentCalls).toHaveLength(1);
    });

    it('a failed per-folder lookup is not memoised: the next folder queries again', async () => {
        mockFindParentMediaItemByFolder.mockImplementation(
            async (_sql: unknown, folder: string) => {
                if (folder === '/music') throw new Error('pool timeout');
                return LINKED[folder] ?? null;
            },
        );
        const artistFiles = files.filter((f) =>
            /^\/music\/Artist (One|Two)\/folder/.test(f.filePath),
        );
        mockFindParentMediaItemsByFolders.mockImplementationOnce(
            async (_sql: unknown, folders: readonly string[]) =>
                new Map(folders.map((f) => [f, null])),
        );

        const targets = await resolveArtworkTargets(sql, artistFiles, 1, () => false);

        // Both artist folders hit the failing parent lookup; neither is cached.
        expect(targets.size).toBe(0);
        expect(
            mockFindParentMediaItemByFolder.mock.calls.filter((c) => c[1] === '/music'),
        ).toHaveLength(2);
    });
});
