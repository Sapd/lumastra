// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    waitForSourceWriteLock: vi.fn(),
    releaseLock: vi.fn(),
    deleteSource: vi.fn(),
    markSourceDeleting: vi.fn(),
    clearSourceDeleting: vi.fn(),
    invalidateLiveTvCaches: vi.fn(),
}));

vi.mock('../../../registry.js', () => ({ registry: { registerTask: vi.fn() } }));
vi.mock('$lib/server/database/queries/livetv-sources.queries.js', () => ({
    clearStaleSourceDeletingFlags: vi.fn(),
    getSourcesWithRefreshCron: vi.fn(),
    deleteSource: mocks.deleteSource,
    markSourceDeleting: mocks.markSourceDeleting,
    clearSourceDeleting: mocks.clearSourceDeleting,
}));
vi.mock('$lib/server/cache/valkey.js', () => ({ releaseLock: mocks.releaseLock }));
vi.mock('../../../../services/livetv/source-write-lock.js', () => ({
    waitForSourceWriteLock: mocks.waitForSourceWriteLock,
}));
vi.mock('../../../../services/livetv-cache.service.js', () => ({
    invalidateLiveTvCaches: mocks.invalidateLiveTvCaches,
}));

import { deleteLiveTvSourceTask } from '../livetv-tasks.js';

const SOURCE_ID = '39fd41c1-d8c7-43c8-82cf-8393274dcd31';
const LOCK_KEY = `lock:livetv-source-write:${SOURCE_ID}`;
const LOCK_TOKEN = 'source-write-token';
type DeleteContext = Parameters<typeof deleteLiveTvSourceTask.execute>[0];

function context(): DeleteContext {
    return {
        input: { sourceId: SOURCE_ID },
        sql: {},
        signal: new AbortController().signal,
        logger: { warn: vi.fn() },
        reportProgress: vi.fn(),
    } as unknown as DeleteContext;
}

describe('delete-livetv-source', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mocks.waitForSourceWriteLock.mockResolvedValue(LOCK_TOKEN);
        mocks.releaseLock.mockResolvedValue(true);
        mocks.markSourceDeleting.mockResolvedValue({ found: true, alreadyDeleting: false });
        mocks.clearSourceDeleting.mockResolvedValue(undefined);
    });

    it('allows the source write lock wait and time to finish deletion', () => {
        expect(deleteLiveTvSourceTask.timeout).toEqual({ hard: '45m', soft: '44m' });
    });

    it('flags the source before locking and deleting it', async () => {
        const ctx = context();
        mocks.deleteSource.mockResolvedValue({ deleted: true, channelsDeleted: 12000 });

        await expect(deleteLiveTvSourceTask.execute(ctx)).resolves.toEqual({
            success: true,
            itemsProcessed: 12000,
        });

        expect(mocks.markSourceDeleting).toHaveBeenCalledWith(ctx.sql, SOURCE_ID);
        expect(mocks.markSourceDeleting.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.waitForSourceWriteLock.mock.invocationCallOrder[0],
        );
        expect(mocks.waitForSourceWriteLock).toHaveBeenCalledWith(SOURCE_ID, expect.any(Function));
        expect(mocks.deleteSource).toHaveBeenCalledWith(ctx.sql, SOURCE_ID);
        expect(mocks.invalidateLiveTvCaches).toHaveBeenCalledOnce();
        expect(mocks.releaseLock).toHaveBeenCalledWith(LOCK_KEY, LOCK_TOKEN);
        expect(mocks.waitForSourceWriteLock.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.deleteSource.mock.invocationCallOrder[0],
        );
        expect(mocks.deleteSource.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.releaseLock.mock.invocationCallOrder[0],
        );
        expect(ctx.reportProgress).toHaveBeenLastCalledWith(1, 1);
        expect(mocks.clearSourceDeleting).not.toHaveBeenCalled();
    });

    it('succeeds when cache invalidation fails after the delete commits', async () => {
        const ctx = context();
        mocks.deleteSource.mockResolvedValue({ deleted: true, channelsDeleted: 2 });
        mocks.invalidateLiveTvCaches.mockRejectedValue(new Error('cache unavailable'));

        await expect(deleteLiveTvSourceTask.execute(ctx)).resolves.toEqual({
            success: true,
            itemsProcessed: 2,
        });

        expect(ctx.logger.warn).toHaveBeenCalledWith(
            'Could not invalidate Live TV caches after source deletion',
            { sourceId: SOURCE_ID, error: 'cache unavailable' },
        );
        expect(mocks.releaseLock).toHaveBeenCalledWith(LOCK_KEY, LOCK_TOKEN);
        expect(mocks.clearSourceDeleting).not.toHaveBeenCalled();
    });

    it('succeeds with zero items when the source is gone', async () => {
        mocks.markSourceDeleting.mockResolvedValue({ found: false, alreadyDeleting: false });
        mocks.deleteSource.mockResolvedValue({ deleted: false, channelsDeleted: 0 });

        await expect(deleteLiveTvSourceTask.execute(context())).resolves.toEqual({
            success: true,
            itemsProcessed: 0,
        });
        expect(mocks.releaseLock).toHaveBeenCalledWith(LOCK_KEY, LOCK_TOKEN);
        expect(mocks.invalidateLiveTvCaches).not.toHaveBeenCalled();
    });

    it('releases the lock and clears the flag when deletion throws', async () => {
        const ctx = context();
        const error = new Error('delete failed');
        mocks.deleteSource.mockRejectedValue(error);

        await expect(deleteLiveTvSourceTask.execute(ctx)).rejects.toBe(error);
        expect(mocks.releaseLock).toHaveBeenCalledWith(LOCK_KEY, LOCK_TOKEN);
        expect(mocks.clearSourceDeleting).toHaveBeenCalledWith(ctx.sql, SOURCE_ID);
    });

    it('clears the flag when waiting for the lock throws', async () => {
        const ctx = context();
        const error = new Error('lock unavailable');
        mocks.waitForSourceWriteLock.mockRejectedValue(error);

        await expect(deleteLiveTvSourceTask.execute(ctx)).rejects.toBe(error);
        expect(mocks.clearSourceDeleting).toHaveBeenCalledWith(ctx.sql, SOURCE_ID);
        expect(mocks.deleteSource).not.toHaveBeenCalled();
        expect(mocks.releaseLock).not.toHaveBeenCalled();
    });
});
