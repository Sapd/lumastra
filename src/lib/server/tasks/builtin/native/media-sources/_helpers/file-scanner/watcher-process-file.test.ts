// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import type { LibraryPathRow } from '$lib/server/database/queries/library-paths.queries.js';

const { refreshForItems } = vi.hoisted(() => ({
    refreshForItems: vi.fn<(sql: unknown, ids: string[]) => Promise<void>>(),
}));

vi.mock('$lib/server/database/queries/browse.queries.js', () => ({
    refreshRecentlyAddedRecencyForItems: refreshForItems,
}));

import { flushRecencyRefreshes } from './watcher-recency.js';
import { createProcessFileForWatcher } from './watcher-process-file.js';

const sql = {} as postgres.Sql;
const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
const context = { logger } as never;

const lib = (path: string, media_type: string): LibraryPathRow =>
    ({ id: `lib-${path}`, path, media_type }) as unknown as LibraryPathRow;

describe('createProcessFileForWatcher', () => {
    const getEnabledLibraryPaths = vi.fn();
    const ingestSingleFile = vi.fn();
    const processFile = createProcessFileForWatcher({ getEnabledLibraryPaths, ingestSingleFile });

    beforeEach(() => {
        vi.clearAllMocks();
        refreshForItems.mockResolvedValue(undefined);
        getEnabledLibraryPaths.mockResolvedValue([
            lib('/data/series', 'tv'),
            lib('/data/music', 'music'),
        ]);
        ingestSingleFile.mockResolvedValue({ status: 'ingested', mediaItemId: 'item-1' });
    });

    it('ingests a file under a library path and refreshes the ingested item', async () => {
        await processFile(sql, '/data/series/Show/S01E01.mkv', context);
        await flushRecencyRefreshes();

        expect(ingestSingleFile).toHaveBeenCalledExactlyOnceWith(
            sql,
            '/data/series/Show/S01E01.mkv',
            expect.objectContaining({ path: '/data/series' }),
            context,
        );
        expect(refreshForItems).toHaveBeenCalledExactlyOnceWith(sql, ['item-1']);
    });

    it('uses the media type of the library the file belongs to (music is skipped)', async () => {
        await processFile(sql, '/data/music/Artist/Album/01.flac', context);
        await flushRecencyRefreshes();

        expect(ingestSingleFile).toHaveBeenCalledTimes(1);
        expect(refreshForItems).not.toHaveBeenCalled();
    });

    it('does not refresh when the ingest did not produce a new item', async () => {
        ingestSingleFile.mockResolvedValue({ status: 'skipped', mediaItemId: 'item-1' });

        await processFile(sql, '/data/series/Show/S01E01.mkv', context);
        await flushRecencyRefreshes();

        expect(refreshForItems).not.toHaveBeenCalled();
    });

    it('ignores a file outside every library path, with a warning', async () => {
        await processFile(sql, '/elsewhere/file.mkv', context);
        await flushRecencyRefreshes();

        expect(ingestSingleFile).not.toHaveBeenCalled();
        expect(refreshForItems).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('not under any enabled library path'),
            { filePath: '/elsewhere/file.mkv' },
        );
    });

    it('attributes a file in a nested library to the inner library, whatever the list order', async () => {
        getEnabledLibraryPaths.mockResolvedValue([lib('/data', 'tv'), lib('/data/music', 'music')]);

        await processFile(sql, '/data/music/Artist/01.flac', context);
        await flushRecencyRefreshes();

        expect(ingestSingleFile).toHaveBeenCalledWith(
            sql,
            '/data/music/Artist/01.flac',
            expect.objectContaining({ path: '/data/music', media_type: 'music' }),
            context,
        );
        expect(refreshForItems).not.toHaveBeenCalled(); // music: no recency refresh
    });

    it('does not match a sibling directory that merely shares a prefix', async () => {
        await processFile(sql, '/data/series-extra/x.mkv', context);
        await flushRecencyRefreshes();

        expect(ingestSingleFile).not.toHaveBeenCalled();
    });
});
