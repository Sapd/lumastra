// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLogger = vi.hoisted(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: vi.fn(() => mockLogger) },
}));

const mockAfterDeleted = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockAfterDeletedBatch = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockAfterDismissed = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockAfterMatched = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('$lib/server/services/media-lifecycle.service.js', () => ({
    MediaLifecycleService: {
        afterDeleted: mockAfterDeleted,
        afterDeletedBatch: mockAfterDeletedBatch,
        afterDismissed: mockAfterDismissed,
        afterMatched: mockAfterMatched,
    },
}));

const mockMergeDuplicateSeries = vi.hoisted(() =>
    vi.fn().mockResolvedValue({ seasonsReparented: 2, itemsDeleted: 1 }),
);

vi.mock('$lib/server/database/queries/media-items.queries.js', () => ({
    mergeDuplicateSeries: mockMergeDuplicateSeries,
}));

const mockRecomputeHasFiles = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRecomputeHasFilesBatch = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('$lib/server/database/queries/media-files.queries.js', () => ({
    recomputeHasFiles: mockRecomputeHasFiles,
    recomputeHasFilesBatch: mockRecomputeHasFilesBatch,
}));

import { MediaDeletionService } from './media-deletion.service.js';

// Helper to build a mock sql tagged template that tracks calls
function createMockSql(defaultRows: unknown[] = []): ReturnType<typeof vi.fn> & {
    calls: string[];
    begin: ReturnType<typeof vi.fn>;
} {
    const calls: string[] = [];

    const sql = vi.fn((...args: unknown[]) => {
        // Tagged template: first arg is TemplateStringsArray
        if (Array.isArray(args[0]) && 'raw' in (args[0] as object)) {
            const strings = args[0] as string[];
            const query = strings.join('?').trim();
            calls.push(query);
        }
        return Promise.resolve(defaultRows);
    }) as ReturnType<typeof vi.fn> & {
        calls: string[];
        begin: ReturnType<typeof vi.fn>;
    };

    sql.calls = calls;

    // sql.begin executes the callback with a transaction proxy
    sql.begin = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
        return cb(sql);
    });

    return sql;
}

describe('MediaDeletionService', () => {
    let mockSql: ReturnType<typeof createMockSql>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockSql = createMockSql();
    });

    describe('hardDelete', () => {
        beforeEach(() => {
            // The in-tx id-set SELECT must return the row being deleted —
            // an empty result means "item not found" and short-circuits.
            mockSql = createMockSql([{ id: 'item-1', parent_id: null }]);
        });

        it('calls afterDeletedBatch for the deleted ids', async () => {
            const result = await MediaDeletionService.hardDelete(mockSql as never, 'item-1');

            expect(result.deleted).toBe(true);
            expect(result.deletedCount).toBe(1);

            expect(mockAfterDeletedBatch).toHaveBeenCalledTimes(1);
            // sql handle threaded so the lifecycle hook stays on the caller's pool
            expect(mockAfterDeletedBatch).toHaveBeenCalledWith(['item-1'], 'item-1', mockSql);
        });

        it('runs deletion inside a transaction', async () => {
            await MediaDeletionService.hardDelete(mockSql as never, 'item-1');
            expect(mockSql.begin).toHaveBeenCalledTimes(1);
        });

        it('deletes from all required tables', async () => {
            await MediaDeletionService.hardDelete(mockSql as never, 'item-1');

            const queries = mockSql.calls.join('\n');
            expect(queries).toContain('UPDATE media_items SET canonical_id = NULL');
            expect(queries).toContain('DELETE FROM episode_orderings');
            expect(queries).toContain('DELETE FROM episode_chapters');
            expect(queries).toContain('DELETE FROM media_files');
            expect(queries).toContain('DELETE FROM media_file_items');
            expect(queries).toContain('DELETE FROM external_ids');
            expect(queries).toContain('DELETE FROM provider_metadata');
            expect(queries).toContain('DELETE FROM watchlist_activities');
            expect(queries).toContain('DELETE FROM user_ratings');
            expect(queries).toContain('DELETE FROM play_sessions');
            // No FK cascade from play_sessions since mig 16.282.0 (a /j transcode
            // row has no play_sessions row at all).
            expect(queries).toContain('DELETE FROM active_transcode_jobs');
            expect(queries).toContain('UPDATE hls_playback_tokens');
            expect(queries).toContain('DELETE FROM media_items');
        });

        it('returns deleted=false when the item does not exist', async () => {
            const emptySql = createMockSql([]);
            const result = await MediaDeletionService.hardDelete(emptySql as never, 'gone-id');
            expect(result.deleted).toBe(false);
            expect(result.deletedCount).toBe(0);
            expect(mockAfterDeletedBatch).not.toHaveBeenCalled();
        });

        it('recomputes has_files on the surviving parents in ONE batch', async () => {
            // The row set makes the SELECT DISTINCT parent_id step yield one parent.
            const sqlWithParent = createMockSql([{ id: 'item-1', parent_id: 'parent-1' }]);

            await MediaDeletionService.hardDelete(sqlWithParent as never, 'item-1');

            expect(mockRecomputeHasFilesBatch).toHaveBeenCalledExactlyOnceWith(sqlWithParent, [
                'parent-1',
            ]);
        });

        it('does not recompute when there is no surviving parent', async () => {
            await MediaDeletionService.hardDelete(mockSql as never, 'item-1');
            expect(mockRecomputeHasFilesBatch).not.toHaveBeenCalled();
        });

        it('a failing has_files batch retries the parents one by one, and never fails the delete', async () => {
            mockRecomputeHasFilesBatch.mockRejectedValueOnce(new Error('lock timeout'));
            // Two surviving parents; the first single recompute fails too.
            mockRecomputeHasFiles.mockRejectedValueOnce(new Error('deadlock'));
            const sqlWithParents = createMockSql([
                { id: 'item-1', parent_id: 'parent-1' },
                { id: 'item-2', parent_id: 'parent-2' },
            ]);

            const result = await MediaDeletionService.hardDelete(sqlWithParents as never, 'item-1');

            expect(result.deleted).toBe(true);
            expect(mockRecomputeHasFilesBatch).toHaveBeenCalledExactlyOnceWith(sqlWithParents, [
                'parent-1',
                'parent-2',
            ]);
            // The failure of parent-1 must not stop parent-2.
            expect(mockRecomputeHasFiles.mock.calls.map((c) => c[1])).toEqual([
                'parent-1',
                'parent-2',
            ]);
            expect(mockLogger.warn).toHaveBeenCalled();
            expect(mockAfterDeletedBatch).toHaveBeenCalledTimes(1);
        });

        it('handles afterDeletedBatch failure gracefully', async () => {
            mockAfterDeletedBatch.mockRejectedValueOnce(new Error('cache down'));

            // Should not throw
            const result = await MediaDeletionService.hardDelete(mockSql as never, 'item-1');
            expect(result.deleted).toBe(true);
            expect(mockLogger.warn).toHaveBeenCalled();
        });

        it('calls afterDeletedBatch once for the deleted item', async () => {
            const result = await MediaDeletionService.hardDelete(mockSql as never, 'item-1');
            expect(result.deleted).toBe(true);
            expect(mockAfterDeletedBatch).toHaveBeenCalledTimes(1);
            expect(mockAfterDeletedBatch).toHaveBeenCalledWith(['item-1'], 'item-1', mockSql);
        });
    });

    describe('softDismiss', () => {
        it('sets is_dismissed = true', async () => {
            await MediaDeletionService.softDismiss(mockSql as never, 'item-1');

            const queries = mockSql.calls.join('\n');
            expect(queries).toContain('UPDATE media_items');
            expect(queries).toContain('is_dismissed = true');
            expect(queries).toContain('THEN NULL ELSE NOW() END');
        });

        it('does NOT call afterDeleted', async () => {
            await MediaDeletionService.softDismiss(mockSql as never, 'item-1');

            expect(mockAfterDeleted).not.toHaveBeenCalled();
        });
    });

    describe('mergeInto', () => {
        it('delegates to mergeDuplicateSeries', async () => {
            await MediaDeletionService.mergeInto(mockSql as never, 'keep-id', 'merge-id');

            expect(mockMergeDuplicateSeries).toHaveBeenCalledWith(
                mockSql,
                'keep-id',
                'merge-id',
                {},
            );
        });

        it('calls afterDeleted for mergeId only', async () => {
            await MediaDeletionService.mergeInto(mockSql as never, 'keep-id', 'merge-id');

            expect(mockAfterDeleted).toHaveBeenCalledTimes(1);
            expect(mockAfterDeleted).toHaveBeenCalledWith('merge-id', mockSql);
            expect(mockAfterDeleted).not.toHaveBeenCalledWith('keep-id');
        });

        it('returns merge statistics', async () => {
            const result = await MediaDeletionService.mergeInto(
                mockSql as never,
                'keep-id',
                'merge-id',
            );

            expect(result).toEqual({
                seasonsReparented: 2,
                itemsDeleted: 1,
            });
        });

        it('handles afterDeleted failure gracefully', async () => {
            mockAfterDeleted.mockRejectedValueOnce(new Error('cache down'));

            // Should not throw
            const result = await MediaDeletionService.mergeInto(
                mockSql as never,
                'keep-id',
                'merge-id',
            );
            expect(result.itemsDeleted).toBe(1);
            expect(mockLogger.warn).toHaveBeenCalled();
        });

        // GAP A: mergeDuplicateSeries re-parents media_file_items via raw SQL but
        // never recomputes the denormalized media_items.has_files flag. If the
        // surviving (keepId) row was a file-less discovery row, it would stay
        // has_files=false after inheriting the file — making the title vanish
        // from library views. mergeInto must recompute it.
        it('recomputes has_files on keepId after merge (GAP A)', async () => {
            await MediaDeletionService.mergeInto(mockSql as never, 'keep-id', 'merge-id');

            expect(mockRecomputeHasFiles).toHaveBeenCalledWith(mockSql, 'keep-id');
        });

        it('does not throw when recomputeHasFiles fails', async () => {
            mockRecomputeHasFiles.mockRejectedValueOnce(new Error('boom'));

            const result = await MediaDeletionService.mergeInto(
                mockSql as never,
                'keep-id',
                'merge-id',
            );
            expect(result.itemsDeleted).toBe(1);
            expect(mockLogger.warn).toHaveBeenCalled();
        });

        // GAP B: external_ids are moved onto keepId via UPDATE (not INSERT), so the
        // identity.assigned trigger that drives TMDB metadata enrichment never
        // fires. mergeInto must fire afterMatched(keepId) to re-enqueue the sync and
        // invalidate identity-bound stage state on the survivor.
        it('fires afterMatched on keepId to re-enrich metadata + invalidate stages (GAP B)', async () => {
            const sqlWithType = createMockSql([{ media_type: 'movie' }]);

            await MediaDeletionService.mergeInto(sqlWithType as never, 'keep-id', 'merge-id');

            expect(mockAfterMatched).toHaveBeenCalledWith(
                'keep-id',
                'movie',
                expect.objectContaining({ enqueueMetadataSync: true }),
                sqlWithType,
            );
        });

        it('does not throw when afterMatched fails', async () => {
            const sqlWithType = createMockSql([{ media_type: 'movie' }]);
            mockAfterMatched.mockRejectedValueOnce(new Error('orchestrator down'));

            const result = await MediaDeletionService.mergeInto(
                sqlWithType as never,
                'keep-id',
                'merge-id',
            );
            expect(result.itemsDeleted).toBe(1);
            expect(mockLogger.warn).toHaveBeenCalled();
        });
    });
});
