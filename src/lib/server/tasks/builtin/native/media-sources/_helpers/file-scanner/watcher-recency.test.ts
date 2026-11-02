// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type postgres from 'postgres';

const { refreshForItems } = vi.hoisted(() => ({
    refreshForItems: vi.fn<(sql: unknown, ids: string[]) => Promise<void>>(),
}));

vi.mock('$lib/server/database/queries/browse.queries.js', () => ({
    refreshRecentlyAddedRecencyForItems: refreshForItems,
}));

import {
    flushRecencyRefreshes,
    queueRecencyRefresh,
    refreshRecencyAfterWatcherIngest,
} from './watcher-recency.js';

const sql = {} as postgres.Sql;
const ITEM = '11111111-1111-4111-8111-111111111111';
const ITEM_B = '22222222-2222-4222-8222-222222222222';

describe('watcher recency refresh', () => {
    const logger = { warn: vi.fn() };

    beforeEach(() => {
        vi.useFakeTimers();
        refreshForItems.mockReset();
        refreshForItems.mockResolvedValue(undefined);
        logger.warn.mockReset();
    });

    afterEach(async () => {
        await flushRecencyRefreshes(); // never leak queued ids into the next test
        vi.useRealTimers();
    });

    describe('refreshRecencyAfterWatcherIngest', () => {
        it('queues the ingested item for a video library', async () => {
            refreshRecencyAfterWatcherIngest(
                sql,
                'anime',
                { status: 'ingested', mediaItemId: ITEM },
                '/data/anime/x.mkv',
                logger,
            );
            await flushRecencyRefreshes();
            expect(refreshForItems).toHaveBeenCalledExactlyOnceWith(sql, [ITEM]);
        });

        it('queues when the library media type is unknown', async () => {
            refreshRecencyAfterWatcherIngest(
                sql,
                undefined,
                { status: 'ingested', mediaItemId: ITEM },
                '/data/x.mkv',
                logger,
            );
            await flushRecencyRefreshes();
            expect(refreshForItems).toHaveBeenCalledTimes(1);
        });

        it('skips music libraries', async () => {
            refreshRecencyAfterWatcherIngest(
                sql,
                'music',
                { status: 'ingested', mediaItemId: ITEM },
                '/data/music/x.flac',
                logger,
            );
            await flushRecencyRefreshes();
            expect(refreshForItems).not.toHaveBeenCalled();
        });

        it.each(['filtered', 'skipped', 'error'] as const)('skips a %s result', async (status) => {
            refreshRecencyAfterWatcherIngest(
                sql,
                'tv',
                { status, mediaItemId: ITEM },
                '/data/series/x.mkv',
                logger,
            );
            await flushRecencyRefreshes();
            expect(refreshForItems).not.toHaveBeenCalled();
        });

        it('skips an ingest that resolved no media item', async () => {
            refreshRecencyAfterWatcherIngest(
                sql,
                'tv',
                { status: 'ingested', mediaItemId: null },
                '/data/series/x.mkv',
                logger,
            );
            await flushRecencyRefreshes();
            expect(refreshForItems).not.toHaveBeenCalled();
        });
    });

    describe('queueRecencyRefresh', () => {
        it('coalesces everything queued inside the window into ONE refresh', async () => {
            queueRecencyRefresh(sql, [ITEM], logger);
            queueRecencyRefresh(sql, [ITEM, ITEM_B], logger);
            queueRecencyRefresh(sql, [ITEM], logger);
            expect(refreshForItems).not.toHaveBeenCalled(); // nothing before the window ends

            await vi.advanceTimersByTimeAsync(2000);

            expect(refreshForItems).toHaveBeenCalledExactlyOnceWith(sql, [ITEM, ITEM_B]);
        });

        it('starts a new window after a flush', async () => {
            queueRecencyRefresh(sql, [ITEM], logger);
            await vi.advanceTimersByTimeAsync(2000);
            queueRecencyRefresh(sql, [ITEM_B], logger);
            await vi.advanceTimersByTimeAsync(2000);

            expect(refreshForItems.mock.calls.map((c) => c[1])).toEqual([[ITEM], [ITEM_B]]);
        });

        it('queues nothing for an empty id list', async () => {
            queueRecencyRefresh(sql, [], logger);
            await vi.advanceTimersByTimeAsync(5000);
            expect(refreshForItems).not.toHaveBeenCalled();
        });

        it('logs and swallows a refresh failure', async () => {
            refreshForItems.mockRejectedValue(new Error('db down'));
            queueRecencyRefresh(sql, [ITEM], logger);

            await expect(flushRecencyRefreshes()).resolves.toBeUndefined();

            expect(logger.warn).toHaveBeenCalledWith(
                expect.stringContaining('refreshRecentlyAddedRecency failed'),
                expect.objectContaining({ itemCount: 1, error: 'db down' }),
            );
        });
    });
});
