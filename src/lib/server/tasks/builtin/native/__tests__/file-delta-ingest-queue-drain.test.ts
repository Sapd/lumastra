// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * file-delta-ingest — queue-drain unit tests.
 *
 * Covers the fix for the payload-drop bug: `identityFor`/`exclusiveWith`
 * dedup keys on `libraryPathId` ALONE, so the upsert/remove payload now
 * travels out-of-band via a per-path Valkey LIST
 * (`file-delta-ingest-queue.ts`) instead of riding inside the deduped task
 * `input`. These tests exercise `execute()`'s drain loop directly against a
 * fully mocked Valkey client (same in-memory-list mock style as
 * `pending-write-drain.test.ts`) plus mocked DB/FS dependencies — the
 * per-file ingest/remove pipeline itself (ffprobe, NFC matching, symlink
 * escape, etc.) is already covered end-to-end against a real Postgres test
 * DB in `file-delta-ingest.integration.test.ts`; these tests are only
 * concerned with "does every payload pushed for a path get processed by the
 * run, regardless of how many callers raced".
 *
 * Scenarios:
 *   - two payloads queued for the same path (simulating two racing callers)
 *     are BOTH drained into a single run — this is the actual bug fix; the
 *     old design would have silently dropped the second payload.
 *   - the legacy inline upsert/remove on the task input (back-compat) is
 *     processed FIRST, then the queue is drained.
 *   - a crash-orphaned entry left on the processing key by a previous run is
 *     recovered and reprocessed before the drain loop sees an empty list.
 *   - a malformed (non-JSON) queue entry is dropped and acked, not retried
 *     forever.
 *   - eventIds accumulate across the legacy payload and every drained
 *     payload.
 *   - enqueueDeltaPayload is a no-op for an empty payload and pushes exactly
 *     once for a non-empty one.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runTask } from '@sapd/lumastra-plugin-sdk-testing';

// ── Dependency mocks ─────────────────────────────────────────────────────────

const { mockGetLibraryPathById } = vi.hoisted(() => ({ mockGetLibraryPathById: vi.fn() }));
vi.mock('$lib/server/database/queries/library-paths.queries.js', () => ({
    getLibraryPathById: mockGetLibraryPathById,
}));

const { mockDeleteStaleMediaFile, mockFindMediaFilePathNfc } = vi.hoisted(() => ({
    mockDeleteStaleMediaFile: vi.fn(),
    mockFindMediaFilePathNfc: vi.fn(),
}));
vi.mock('$lib/server/database/queries/media-files.queries.js', () => ({
    deleteStaleMediaFile: mockDeleteStaleMediaFile,
    findMediaFilePathNfc: mockFindMediaFilePathNfc,
}));

const { mockRefreshRecentlyAddedRecency, mockRefreshRecentlyAddedRecencyForItems } = vi.hoisted(
    () => ({
        mockRefreshRecentlyAddedRecency: vi.fn(),
        mockRefreshRecentlyAddedRecencyForItems: vi.fn(),
    }),
);
vi.mock('$lib/server/database/queries/browse.queries.js', () => ({
    refreshRecentlyAddedRecency: mockRefreshRecentlyAddedRecency,
    refreshRecentlyAddedRecencyForItems: mockRefreshRecentlyAddedRecencyForItems,
}));

const { mockIngestSingleFile } = vi.hoisted(() => ({ mockIngestSingleFile: vi.fn() }));
vi.mock('../media-sources/file-scanner.js', () => ({
    ingestSingleFile: mockIngestSingleFile,
}));

const { mockSafeRealpath } = vi.hoisted(() => ({
    // Identity mock: real fs symlink resolution isn't under test here.
    // resolveUnderRoot's lexical containment check still runs for real.
    mockSafeRealpath: vi.fn(async (p: string) => p),
}));
vi.mock('$lib/server/utils/safe-fs.js', () => ({
    safeRealpath: mockSafeRealpath,
}));

const { mockRequireClient } = vi.hoisted(() => ({ mockRequireClient: vi.fn() }));
vi.mock('../../../valkey-types.js', () => ({
    requireClient: mockRequireClient,
}));

import { fileDeltaIngestTask } from '../file-delta-ingest.js';
import {
    enqueueDeltaPayload,
    pendingListKey,
    processingListKey,
} from '../file-delta-ingest-queue.js';

// ── Fake Valkey client (mirrors pending-write-drain.test.ts's makeClient) ──

interface FakeClient {
    lists: Map<string, string[]>;
    customCommand: ReturnType<typeof vi.fn>;
}

function makeFakeValkeyClient(): FakeClient {
    const lists = new Map<string, string[]>();
    const getList = (key: string): string[] => {
        let l = lists.get(key);
        if (!l) {
            l = [];
            lists.set(key, l);
        }
        return l;
    };
    const client: FakeClient = {
        lists,
        customCommand: vi.fn(async (cmd: string[]) => {
            const [op] = cmd;
            switch (op) {
                case 'LPUSH': {
                    const [, key, value] = cmd;
                    const l = getList(key);
                    l.unshift(value);
                    return l.length;
                }
                case 'LMOVE': {
                    // LMOVE source destination LEFT|RIGHT LEFT|RIGHT
                    const [, source, destination, fromSide, toSide] = cmd;
                    const src = getList(source);
                    if (src.length === 0) return null;
                    const value = fromSide === 'LEFT' ? src.shift()! : src.pop()!;
                    const dst = getList(destination);
                    if (toSide === 'LEFT') dst.unshift(value);
                    else dst.push(value);
                    return value;
                }
                case 'LREM': {
                    const [, key, countStr, value] = cmd;
                    const l = getList(key);
                    const count = parseInt(countStr, 10) || 1;
                    let removed = 0;
                    for (let i = 0; i < l.length && removed < count; i++) {
                        if (l[i] === value) {
                            l.splice(i, 1);
                            removed++;
                            i--;
                        }
                    }
                    return removed;
                }
                case 'LLEN':
                    return getList(cmd[1]).length;
                default:
                    return null;
            }
        }),
    };
    return client;
}

// ── sql stub ──────────────────────────────────────────────────────────────
// Every DB read/write the plugin issues goes through query-module functions,
// all mocked above, so the stub only needs to exist and resolve to no rows.
function makeSql(): unknown {
    const fn = vi.fn(async () => []);
    (fn as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
    return fn;
}

const LIB_PATH_ID = 'lib-1';
const PENDING_KEY = pendingListKey(LIB_PATH_ID);
const PROCESSING_KEY = processingListKey(LIB_PATH_ID);

describe('file-delta-ingest — Valkey queue drain', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetLibraryPathById.mockResolvedValue({
            id: LIB_PATH_ID,
            path: '/media/lib1',
            enabled: true,
        });
        mockSafeRealpath.mockImplementation(async (p: string) => p);
        mockIngestSingleFile.mockImplementation(async (_sql: unknown, lexAbs: string) => ({
            status: 'ingested',
            mediaItemId: `mid:${lexAbs}`,
        }));
        mockDeleteStaleMediaFile.mockResolvedValue({ deleted: true, affectedItemIds: [] });
        mockFindMediaFilePathNfc.mockResolvedValue(null);
        mockRefreshRecentlyAddedRecency.mockResolvedValue(undefined);
        mockRefreshRecentlyAddedRecencyForItems.mockResolvedValue(undefined);
    });

    it('records files ingest deliberately skipped (no media_files row) for file-reconcile', async () => {
        // Prod 2026-09-28: a superseded multi-episode file was skipped without a
        // row, so reconcile re-proposed it every 5 minutes, forever.
        const client = makeFakeValkeyClient();
        mockRequireClient.mockReturnValue(client);
        mockIngestSingleFile.mockImplementation(async (_sql: unknown, lexAbs: string) =>
            lexAbs.endsWith('dup.mp4')
                ? { status: 'skipped', mediaItemId: null }
                : lexAbs.endsWith('known.mkv')
                  ? { status: 'skipped', mediaItemId: 'already-in-library' }
                  : { status: 'ingested', mediaItemId: `mid:${lexAbs}` },
        );

        await runTask(
            fileDeltaIngestTask,
            { libraryPathId: LIB_PATH_ID, upsert: ['a.mkv', 'dup.mp4', 'known.mkv'], remove: [] },
            { sql: makeSql() as never },
        );

        const zadds = client.customCommand.mock.calls
            .map(([cmd]) => cmd as string[])
            .filter((cmd) => cmd[0] === 'ZADD');
        expect(zadds).toHaveLength(1);
        expect(zadds[0][1]).toBe('file-reconcile:skipped:lib-1');
        // [ZADD, key, score, member]: only the row-less skip is recorded.
        expect(zadds[0].slice(2).filter((_, i) => i % 2 === 1)).toEqual(['dup.mp4']);
    });

    it('refreshes recency scoped to the upserted items, not the whole library', async () => {
        const client = makeFakeValkeyClient();
        mockRequireClient.mockReturnValue(client);
        const sql = makeSql() as never;

        await runTask(
            fileDeltaIngestTask,
            { libraryPathId: LIB_PATH_ID, upsert: ['a.mkv'], remove: [] },
            { sql },
        );

        expect(mockRefreshRecentlyAddedRecencyForItems).toHaveBeenCalledTimes(1);
        expect(mockRefreshRecentlyAddedRecencyForItems).toHaveBeenCalledWith(sql, [
            expect.stringMatching(/^mid:.*a\.mkv$/),
        ]);
        expect(mockRefreshRecentlyAddedRecency).not.toHaveBeenCalled();
    });

    it('refreshes only the titles of removed files, never the whole library', async () => {
        const client = makeFakeValkeyClient();
        mockRequireClient.mockReturnValue(client);
        mockDeleteStaleMediaFile.mockResolvedValue({
            deleted: true,
            affectedItemIds: ['episode-1', 'episode-2'],
        });
        const sql = makeSql() as never;

        await runTask(
            fileDeltaIngestTask,
            { libraryPathId: LIB_PATH_ID, upsert: [], remove: ['gone.mkv'] },
            { sql },
        );

        expect(mockRefreshRecentlyAddedRecencyForItems).toHaveBeenCalledExactlyOnceWith(sql, [
            'episode-1',
            'episode-2',
        ]);
        expect(mockRefreshRecentlyAddedRecency).not.toHaveBeenCalled();
    });

    it('a removal that matched no row does not widen the refresh', async () => {
        const client = makeFakeValkeyClient();
        mockRequireClient.mockReturnValue(client);
        mockDeleteStaleMediaFile.mockResolvedValue({ deleted: false, affectedItemIds: [] });
        mockFindMediaFilePathNfc.mockResolvedValue(null);
        const sql = makeSql() as never;

        await runTask(
            fileDeltaIngestTask,
            { libraryPathId: LIB_PATH_ID, upsert: [], remove: ['never-ingested.tmp.mkv'] },
            { sql },
        );

        expect(mockRefreshRecentlyAddedRecency).not.toHaveBeenCalled();
        expect(mockRefreshRecentlyAddedRecencyForItems).not.toHaveBeenCalled();
    });

    it('a removal found under a different Unicode form (NFC fallback) still refreshes its titles', async () => {
        const client = makeFakeValkeyClient();
        mockRequireClient.mockReturnValue(client);
        mockDeleteStaleMediaFile
            .mockResolvedValueOnce({ deleted: false, affectedItemIds: [] }) // exact path misses
            .mockResolvedValueOnce({ deleted: true, affectedItemIds: ['nfc-episode'] });
        mockFindMediaFilePathNfc.mockResolvedValue('/media/lib1/gone-nfc.mkv');
        const sql = makeSql() as never;

        await runTask(
            fileDeltaIngestTask,
            { libraryPathId: LIB_PATH_ID, upsert: [], remove: ['gone.mkv'] },
            { sql },
        );

        expect(mockRefreshRecentlyAddedRecencyForItems).toHaveBeenCalledExactlyOnceWith(sql, [
            'nfc-episode',
        ]);
    });

    it('refreshes each title once even when an item shows up several times', async () => {
        const client = makeFakeValkeyClient();
        mockRequireClient.mockReturnValue(client);
        mockDeleteStaleMediaFile.mockResolvedValue({
            deleted: true,
            affectedItemIds: ['shared-episode'],
        });
        const sql = makeSql() as never;

        await runTask(
            fileDeltaIngestTask,
            { libraryPathId: LIB_PATH_ID, upsert: [], remove: ['a.mkv', 'b.mkv'] },
            { sql },
        );

        expect(mockRefreshRecentlyAddedRecencyForItems).toHaveBeenCalledExactlyOnceWith(sql, [
            'shared-episode',
        ]);
    });

    it('a mixed batch refreshes upserted and removed titles in one scoped call', async () => {
        const client = makeFakeValkeyClient();
        mockRequireClient.mockReturnValue(client);
        mockDeleteStaleMediaFile.mockResolvedValue({ deleted: true, affectedItemIds: ['old-ep'] });
        const sql = makeSql() as never;

        await runTask(
            fileDeltaIngestTask,
            { libraryPathId: LIB_PATH_ID, upsert: ['a.mkv'], remove: ['gone.mkv'] },
            { sql },
        );

        expect(mockRefreshRecentlyAddedRecencyForItems).toHaveBeenCalledTimes(1);
        const [, ids] = mockRefreshRecentlyAddedRecencyForItems.mock.calls[0] as [
            unknown,
            string[],
        ];
        expect(ids).toHaveLength(2);
        expect(ids).toContain('old-ep');
        expect(ids.some((id) => /^mid:.*a\.mkv$/.test(id))).toBe(true);
        expect(mockRefreshRecentlyAddedRecency).not.toHaveBeenCalled();
    });

    it('uses the documented per-library-path key names', () => {
        expect(PENDING_KEY).toBe('task:delta-ingest:pending:lib-1');
        expect(PROCESSING_KEY).toBe('task:delta-ingest:pending:lib-1:processing');
    });

    it('enqueueDeltaPayload is a no-op for an empty payload', async () => {
        const client = makeFakeValkeyClient();
        mockRequireClient.mockReturnValue(client);
        await enqueueDeltaPayload(LIB_PATH_ID, { upsert: [], remove: [] });
        expect(client.customCommand).not.toHaveBeenCalled();
    });

    it('pushes exactly one LPUSH for a non-empty payload', async () => {
        const client = makeFakeValkeyClient();
        mockRequireClient.mockReturnValue(client);
        await enqueueDeltaPayload(LIB_PATH_ID, { upsert: ['a.mkv'], remove: [] });
        expect(client.lists.get(PENDING_KEY)).toHaveLength(1);
    });

    it('drains every payload queued for the path — coalesces racing callers into one run', async () => {
        const client = makeFakeValkeyClient();
        mockRequireClient.mockReturnValue(client);

        // Two callers race on the same libraryPathId: BOTH push before
        // either run starts. This is exactly the scenario the old
        // whole-input dedup silently dropped the second payload for.
        await enqueueDeltaPayload(LIB_PATH_ID, { upsert: ['a.mkv'], remove: [] });
        await enqueueDeltaPayload(LIB_PATH_ID, { upsert: ['b.mkv'], remove: ['old.mkv'] });

        const result = await runTask(
            fileDeltaIngestTask,
            { libraryPathId: LIB_PATH_ID, upsert: [], remove: [] },
            { sql: makeSql() as never },
        );

        expect(result.success).toBe(true);
        expect(result.result?.batchesProcessed).toBe(2);
        expect(result.result?.requested).toBe(3);
        expect(result.result?.succeeded).toBe(3);
        expect(result.result?.results.map((r) => r.path).sort()).toEqual([
            'a.mkv',
            'b.mkv',
            'old.mkv',
        ]);

        // Both the pending and processing lists are fully drained.
        expect(client.lists.get(PENDING_KEY) ?? []).toEqual([]);
        expect(client.lists.get(PROCESSING_KEY) ?? []).toEqual([]);
    });

    it('processes the legacy inline payload first, then drains the queue (back-compat)', async () => {
        const client = makeFakeValkeyClient();
        mockRequireClient.mockReturnValue(client);

        await enqueueDeltaPayload(LIB_PATH_ID, { upsert: ['queued.mkv'], remove: [] });

        const result = await runTask(
            fileDeltaIngestTask,
            { libraryPathId: LIB_PATH_ID, upsert: ['legacy.mkv'], remove: [] },
            { sql: makeSql() as never },
        );

        expect(result.result?.batchesProcessed).toBe(2);
        expect(result.result?.results.map((r) => r.path)).toEqual(['legacy.mkv', 'queued.mkv']);
    });

    it('recovers a crash-orphaned entry from the processing key and reprocesses it', async () => {
        const client = makeFakeValkeyClient();
        mockRequireClient.mockReturnValue(client);

        // Simulate a crash: a previous run for this path claimed an entry
        // (LMOVE'd it onto the processing key) and died before replaying or
        // acking it.
        const orphan = JSON.stringify({
            upsert: ['orphan.mkv'],
            remove: [],
            enqueuedAt: Date.now(),
        });
        client.lists.set(PROCESSING_KEY, [orphan]);

        const result = await runTask(
            fileDeltaIngestTask,
            { libraryPathId: LIB_PATH_ID, upsert: [], remove: [] },
            { sql: makeSql() as never },
        );

        expect(result.result?.results.map((r) => r.path)).toEqual(['orphan.mkv']);
        expect(result.result?.succeeded).toBe(1);
        expect(client.lists.get(PROCESSING_KEY) ?? []).toEqual([]);
    });

    it('drops a malformed (non-JSON) queue entry and continues draining', async () => {
        const client = makeFakeValkeyClient();
        mockRequireClient.mockReturnValue(client);

        client.lists.set(PENDING_KEY, ['not valid json {{']);
        await enqueueDeltaPayload(LIB_PATH_ID, { upsert: ['good.mkv'], remove: [] });

        const result = await runTask(
            fileDeltaIngestTask,
            { libraryPathId: LIB_PATH_ID, upsert: [], remove: [] },
            { sql: makeSql() as never },
        );

        expect(result.result?.results.map((r) => r.path)).toEqual(['good.mkv']);
        expect(result.result?.batchesProcessed).toBe(1);
        expect(client.lists.get(PENDING_KEY) ?? []).toEqual([]);
        expect(client.lists.get(PROCESSING_KEY) ?? []).toEqual([]);
    });

    it('collects eventIds from the legacy payload and every drained queue entry', async () => {
        const client = makeFakeValkeyClient();
        mockRequireClient.mockReturnValue(client);

        await enqueueDeltaPayload(LIB_PATH_ID, {
            upsert: ['a.mkv'],
            remove: [],
            eventId: 'evt-queued-1',
        });

        const result = await runTask(
            fileDeltaIngestTask,
            {
                libraryPathId: LIB_PATH_ID,
                upsert: ['legacy.mkv'],
                remove: [],
                eventId: 'evt-legacy',
            },
            { sql: makeSql() as never },
        );

        expect(result.result?.eventId).toBe('evt-legacy');
        expect(result.result?.eventIds).toEqual(['evt-legacy', 'evt-queued-1']);
    });

    it('an empty queue with no legacy payload processes zero batches', async () => {
        const client = makeFakeValkeyClient();
        mockRequireClient.mockReturnValue(client);

        const result = await runTask(
            fileDeltaIngestTask,
            { libraryPathId: LIB_PATH_ID, upsert: [], remove: [] },
            { sql: makeSql() as never },
        );

        expect(result.result?.batchesProcessed).toBe(0);
        expect(result.result?.requested).toBe(0);
        expect(result.result?.results).toEqual([]);
    });
});
