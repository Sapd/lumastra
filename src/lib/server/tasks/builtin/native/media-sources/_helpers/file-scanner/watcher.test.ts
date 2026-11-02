// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Unit tests for watcher ingestion guards and lifecycle serialization. */

import { flushRecencyRefreshes } from './watcher-recency.js';
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import type { Mock, MockedFunction } from 'vitest';
import { WatcherLeader, WATCHER_INGEST_CONCURRENCY, type ProcessFileFn } from './watcher.js';
import type { PluginContext } from '../../../../../../plugins/types/base-plugin.js';

// These unit fixtures exercise the disconnected memory-lock primitive, not a
// deployed coordination instance. Do not inherit the runner's task endpoint.
vi.hoisted(() => vi.stubEnv('TASK_CACHE_URL', ''));
afterAll(() => vi.unstubAllEnvs());

// ---------------------------------------------------------------------------
// handleUnlink — phantom-unlink guard
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
    access: vi.fn(),
}));

vi.mock('../../../../../../database/queries/media-files.queries.js', () => ({
    deleteStaleMediaFile: vi.fn(),
    findMediaFilePathNfc: vi.fn(),
    findRangeFilesSupersededBy: vi.fn(),
    listDirectChildMediaFilePaths: vi.fn(async () => []),
}));

vi.mock('../../../../../../database/queries/browse.queries.js', () => ({
    refreshRecentlyAddedRecencyForItems: vi.fn(),
}));

vi.mock('../../../../../../utils/file-presence.js', () => ({
    assessFilePresence: vi.fn(),
}));

// ---------------------------------------------------------------------------
// WatcherLeader.stop/updatePaths lifecycle-lock serialization
// ---------------------------------------------------------------------------

// `vi.hoisted` because the vi.mock factory below (hoisted above imports) needs
// to close over the same array the test body inspects, to count constructor
// vs close() calls on the (mocked) NativeWatcherProcess.
const { fakeNativeInstances, resetFakeNativeInstances } = vi.hoisted(() => {
    const instances: Array<{ paths: string[]; closed: boolean }> = [];
    return {
        fakeNativeInstances: instances,
        resetFakeNativeInstances: (): void => {
            instances.length = 0;
        },
    };
});

vi.mock('./watcher-native-host.js', () => {
    class FakeNativeWatcherProcess {
        paths: string[];
        closed = false;
        constructor(opts: { paths: string[] }) {
            this.paths = opts.paths;
            fakeNativeInstances.push(this);
        }
        start(): void {}
        close(): Promise<void> {
            this.closed = true;
            return Promise.resolve();
        }
    }
    return {
        NativeWatcherProcess: FakeNativeWatcherProcess,
        verifyNativeWatcherBinary: async () => {},
        waitForNativeWatcherQuarantineRelease: async () => {},
    };
});

vi.mock('../../../../../../utils/native-watcher-policy.js', async () => {
    const { TEST_NATIVE_POLICY } = await import('./watcher-native-test-policy.js');
    return { buildNativeWatcherPolicy: async () => TEST_NATIVE_POLICY };
});

describe('WatcherLeader.handleUnlink', () => {
    let instance: WatcherLeader;
    let deleteStaleMediaFile: ReturnType<typeof vi.fn>;
    let findMediaFilePathNfc: ReturnType<typeof vi.fn>;
    let findRangeFilesSupersededBy: ReturnType<typeof vi.fn>;
    let processFile: Mock<ProcessFileFn>;
    let refreshRecency: ReturnType<typeof vi.fn>;
    let assessFilePresence: ReturnType<typeof vi.fn>;
    let accessMock: MockedFunction<typeof import('node:fs/promises').access>;

    beforeEach(async () => {
        vi.resetAllMocks();

        const fsModule = await import('node:fs/promises');
        accessMock = vi.mocked(fsModule.access);

        const queriesModule =
            await import('../../../../../../database/queries/media-files.queries.js');
        deleteStaleMediaFile = queriesModule.deleteStaleMediaFile as ReturnType<typeof vi.fn>;
        findMediaFilePathNfc = queriesModule.findMediaFilePathNfc as ReturnType<typeof vi.fn>;
        findRangeFilesSupersededBy = queriesModule.findRangeFilesSupersededBy as ReturnType<
            typeof vi.fn
        >;
        findRangeFilesSupersededBy.mockResolvedValue([]);
        const browseModule = await import('../../../../../../database/queries/browse.queries.js');
        refreshRecency = browseModule.refreshRecentlyAddedRecencyForItems as ReturnType<
            typeof vi.fn
        >;
        refreshRecency.mockResolvedValue(undefined);
        // Default: an actual delete happened. Individual tests override.
        deleteStaleMediaFile.mockResolvedValue({ deleted: true, affectedItemIds: [] });

        const presenceModule = await import('../../../../../../utils/file-presence.js');
        assessFilePresence = presenceModule.assessFilePresence as ReturnType<typeof vi.fn>;

        processFile = vi.fn<ProcessFileFn>().mockResolvedValue(undefined);
        instance = new WatcherLeader(processFile);
        // Inject a minimal context so handleUnlink does not bail out early.
        // Bracket notation reaches the private `context` field without a cast;
        // the fake value only needs the `sql` surface these tests touch, so it
        // is narrowed through `Partial<PluginContext>` rather than `unknown`.
        instance['context'] = { sql: {} } as Partial<PluginContext> as PluginContext;
    });

    it('ignores phantom unlink when file still exists on disk', async () => {
        accessMock.mockResolvedValue(undefined); // fs.access resolves → file present

        await instance['handleUnlink']('/media/black-books-s01e01.nfo');

        expect(deleteStaleMediaFile).not.toHaveBeenCalled();
    });

    it('proceeds with delete when file is genuinely gone (ENOENT)', async () => {
        const enoent = Object.assign(new Error('no such file'), {
            code: 'ENOENT',
        });
        accessMock.mockRejectedValue(enoent);
        deleteStaleMediaFile.mockResolvedValue({ deleted: true });
        // Set library root so mount guard passes and delete proceeds
        instance['_currentPaths'] = ['/media'];
        assessFilePresence.mockResolvedValue('missing');

        await instance['handleUnlink']('/media/black-books-s01e01.nfo');

        expect(deleteStaleMediaFile).toHaveBeenCalledOnce();
        expect(deleteStaleMediaFile).toHaveBeenCalledWith({}, '/media/black-books-s01e01.nfo');
    });

    it('refreshes the recency of the titles a deleted file was linked to', async () => {
        accessMock.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));
        deleteStaleMediaFile.mockResolvedValue({
            deleted: true,
            affectedItemIds: ['episode-1', 'episode-2'],
        });
        instance['_currentPaths'] = ['/media'];
        assessFilePresence.mockResolvedValue('missing');

        await instance['handleUnlink']('/media/show-s01e01.mkv');
        await flushRecencyRefreshes();

        expect(refreshRecency).toHaveBeenCalledExactlyOnceWith({}, ['episode-1', 'episode-2']);
    });

    it('refreshes the titles found through the NFC-normalised path fallback', async () => {
        accessMock.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));
        deleteStaleMediaFile
            .mockResolvedValueOnce({ deleted: false, affectedItemIds: [] })
            .mockResolvedValueOnce({ deleted: true, affectedItemIds: ['nfc-episode'] });
        findMediaFilePathNfc.mockResolvedValue('/media/stored-as-nfc.mkv');
        instance['_currentPaths'] = ['/media'];
        assessFilePresence.mockResolvedValue('missing');

        await instance['handleUnlink']('/media/stored-as-nfd.mkv');
        await flushRecencyRefreshes();

        expect(refreshRecency).toHaveBeenCalledExactlyOnceWith({}, ['nfc-episode']);
    });

    it('re-ingests the multi-episode files a deleted file covered', async () => {
        accessMock.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));
        instance['_currentPaths'] = ['/media'];
        assessFilePresence.mockResolvedValue('missing');
        findRangeFilesSupersededBy.mockResolvedValue(['/media/Show/Show S01E01E02.mkv']);

        await instance['handleUnlink']('/media/Show/Show S01E02.mkv');

        expect(findRangeFilesSupersededBy).toHaveBeenCalledWith(
            {},
            '/media/Show/Show S01E02.mkv',
            '/media',
        );
        expect(processFile).toHaveBeenCalledExactlyOnceWith(
            {},
            '/media/Show/Show S01E01E02.mkv',
            instance['context'],
        );
    });

    it('looks covered files up by the stored path when the NFC fallback deleted the row', async () => {
        accessMock.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));
        deleteStaleMediaFile
            .mockResolvedValueOnce({ deleted: false, affectedItemIds: [] })
            .mockResolvedValueOnce({ deleted: true, affectedItemIds: [] });
        findMediaFilePathNfc.mockResolvedValue('/media/stored-as-nfc.mkv');
        instance['_currentPaths'] = ['/media'];
        assessFilePresence.mockResolvedValue('missing');

        await instance['handleUnlink']('/media/stored-as-nfd.mkv');

        expect(findRangeFilesSupersededBy).toHaveBeenCalledExactlyOnceWith(
            {},
            '/media/stored-as-nfc.mkv',
            '/media',
        );
    });

    it('does not look for covered files when no row was deleted', async () => {
        accessMock.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));
        deleteStaleMediaFile.mockResolvedValue({ deleted: false, affectedItemIds: [] });
        findMediaFilePathNfc.mockResolvedValue(null);
        instance['_currentPaths'] = ['/media'];
        assessFilePresence.mockResolvedValue('missing');

        await instance['handleUnlink']('/media/unknown.mkv');

        expect(findRangeFilesSupersededBy).not.toHaveBeenCalled();
        expect(processFile).not.toHaveBeenCalled();
    });

    it('does not refresh recency when no row was deleted', async () => {
        accessMock.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));
        deleteStaleMediaFile.mockResolvedValue({ deleted: false, affectedItemIds: [] });
        findMediaFilePathNfc.mockResolvedValue(null);
        instance['_currentPaths'] = ['/media'];
        assessFilePresence.mockResolvedValue('missing');

        await instance['handleUnlink']('/media/unknown.mkv');
        await flushRecencyRefreshes();

        expect(refreshRecency).not.toHaveBeenCalled();
    });

    it('a failing recency refresh after unlink is swallowed', async () => {
        accessMock.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));
        deleteStaleMediaFile.mockResolvedValue({ deleted: true, affectedItemIds: ['e'] });
        refreshRecency.mockRejectedValue(new Error('db down'));
        instance['_currentPaths'] = ['/media'];
        assessFilePresence.mockResolvedValue('missing');

        await expect(instance['handleUnlink']('/media/show-s01e02.mkv')).resolves.toBeUndefined();
        await expect(flushRecencyRefreshes()).resolves.toBeUndefined();
    });

    it('skips delete on non-ENOENT access errors (EACCES)', async () => {
        const eacces = Object.assign(new Error('permission denied'), {
            code: 'EACCES',
        });
        accessMock.mockRejectedValue(eacces);
        // Set library root so we reach the mount guard (which gets skipped due to EACCES phantom check)
        instance['_currentPaths'] = ['/media'];

        await instance['handleUnlink']('/media/black-books-s01e01.nfo');

        expect(deleteStaleMediaFile).not.toHaveBeenCalled();
    });

    it('cancels a pending create/change debounce timer for the same path (rapid create→delete)', async () => {
        vi.useFakeTimers();
        try {
            const processFile = vi.fn().mockResolvedValue(undefined);
            // Re-create against the fake-timers instance so the debounce
            // timer scheduled below is one vi controls.
            instance = new WatcherLeader(processFile);
            instance['context'] = { sql: {} } as Partial<PluginContext> as PluginContext;

            instance['scheduleProcess']('/media/ghost.mkv');

            const enoent = Object.assign(new Error('no such file'), { code: 'ENOENT' });
            accessMock.mockRejectedValue(enoent);
            deleteStaleMediaFile.mockResolvedValue({ deleted: true });
            // Set library root so mount guard passes and delete proceeds
            instance['_currentPaths'] = ['/media'];
            assessFilePresence.mockResolvedValue('missing');

            // The delete arrives before the create/change debounce (500ms) fires.
            await instance['handleUnlink']('/media/ghost.mkv');

            // Advance past the debounce window. Pre-fix, the stale timer would
            // still be pending here and would fire processFile for a path that
            // is now confirmed deleted.
            await vi.advanceTimersByTimeAsync(600);

            expect(processFile).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    // --- mount-aware deletion guard (depends on assessFilePresence) ---------

    it('vanished mount → transient → does NOT delete, and cooldown skips re-probe', async () => {
        const enoent = Object.assign(new Error('no such file'), { code: 'ENOENT' });
        accessMock.mockRejectedValue(enoent);
        instance['_currentPaths'] = ['/media/movies'];
        assessFilePresence.mockResolvedValue('transient');

        await instance['handleUnlink']('/media/movies/a.mkv');
        expect(deleteStaleMediaFile).not.toHaveBeenCalled();
        expect(assessFilePresence).toHaveBeenCalledTimes(1);

        assessFilePresence.mockClear();
        await instance['handleUnlink']('/media/movies/b.mkv'); // within cooldown
        expect(assessFilePresence).not.toHaveBeenCalled(); // breaker short-circuits
        expect(deleteStaleMediaFile).not.toHaveBeenCalled();
    });

    it('live mount → missing → deletes', async () => {
        const enoent = Object.assign(new Error('no such file'), { code: 'ENOENT' });
        accessMock.mockRejectedValue(enoent);
        instance['_currentPaths'] = ['/media/movies'];
        assessFilePresence.mockResolvedValue('missing');

        await instance['handleUnlink']('/media/movies/a.mkv');
        expect(deleteStaleMediaFile).toHaveBeenCalledOnce();
    });

    it('does not mutate the DB for an unlink while the lease is fenced', async () => {
        accessMock.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));
        instance['_currentPaths'] = ['/media'];
        assessFilePresence.mockResolvedValue('missing');
        instance['leaseLost'] = true;

        await instance['handleUnlink']('/media/fenced.nfo');

        expect(deleteStaleMediaFile).not.toHaveBeenCalled();
    });

    it('treats an expired lease validity as fenced even without a failed renewal', async () => {
        accessMock.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));
        instance['_currentPaths'] = ['/media'];
        assessFilePresence.mockResolvedValue('missing');
        instance['lockValue'] = 'held';
        instance['leaseValidUntil'] = Date.now() - 1;

        await instance['handleUnlink']('/media/expired.nfo');

        expect(deleteStaleMediaFile).not.toHaveBeenCalled();

        instance['leaseValidUntil'] = Date.now() + 20_000;
        await instance['handleUnlink']('/media/valid.nfo');
        expect(deleteStaleMediaFile).toHaveBeenCalledOnce();
    });

    it('skips the delete when the lease is lost while the presence probe is running', async () => {
        accessMock.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));
        instance['_currentPaths'] = ['/media'];
        assessFilePresence.mockImplementation(async () => {
            instance['leaseLost'] = true;
            return 'missing';
        });

        await instance['handleUnlink']('/media/mid-flight.nfo');

        expect(deleteStaleMediaFile).not.toHaveBeenCalled();
        expect(findMediaFilePathNfc).not.toHaveBeenCalled();
    });

    it('NFD miss → NFC fallback deletes', async () => {
        const enoent = Object.assign(new Error('no such file'), { code: 'ENOENT' });
        accessMock.mockRejectedValue(enoent);
        instance['_currentPaths'] = ['/media/movies'];
        assessFilePresence.mockResolvedValue('missing');
        deleteStaleMediaFile.mockResolvedValueOnce({ deleted: false });
        findMediaFilePathNfc.mockResolvedValueOnce('/media/movies/åäö.mkv'); // NFC stored form
        deleteStaleMediaFile.mockResolvedValueOnce({ deleted: true });

        await instance['handleUnlink']('/media/movies/å.mkv');

        expect(findMediaFilePathNfc).toHaveBeenCalled();
        expect(deleteStaleMediaFile).toHaveBeenCalledTimes(2);
        expect(deleteStaleMediaFile).toHaveBeenLastCalledWith({}, '/media/movies/åäö.mkv');
    });

    it('skips delete when no library root resolves (fail-safe during restart)', async () => {
        const enoent = Object.assign(new Error('no such file'), { code: 'ENOENT' });
        accessMock.mockRejectedValue(enoent);
        // Empty _currentPaths simulates the restart state where resolveLibraryRoot returns null
        instance['_currentPaths'] = [];

        await instance['handleUnlink']('/media/movies/a.mkv');

        // Should NOT proceed to delete when root is null
        expect(deleteStaleMediaFile).not.toHaveBeenCalled();
        expect(assessFilePresence).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// scheduleProcess — bounded ingest concurrency (WATCHER_INGEST_CONCURRENCY)
// ---------------------------------------------------------------------------

describe('WatcherLeader.scheduleProcess ingest concurrency cap', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('never runs more than WATCHER_INGEST_CONCURRENCY processFile calls at once', async () => {
        let active = 0;
        let maxActive = 0;
        const releasers: Array<() => void> = [];
        const processFile = vi.fn().mockImplementation(async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise<void>((resolve) => releasers.push(resolve));
            active--;
        });

        const instance = new WatcherLeader(processFile);
        instance['context'] = { sql: {} } as Partial<PluginContext> as PluginContext;

        const total = WATCHER_INGEST_CONCURRENCY * 2 + 2;
        for (let i = 0; i < total; i++) {
            instance['scheduleProcess'](`/media/file-${i}.mkv`);
        }

        // Fire every per-path debounce timer (all scheduled ~simultaneously).
        await vi.advanceTimersByTimeAsync(600);

        // Only the cap's worth should have actually started; the rest are
        // parked in the semaphore queue waiting for a permit.
        expect(processFile).toHaveBeenCalledTimes(WATCHER_INGEST_CONCURRENCY);
        expect(maxActive).toBeLessThanOrEqual(WATCHER_INGEST_CONCURRENCY);

        const flush = async (): Promise<void> => {
            for (let i = 0; i < 8; i++) await Promise.resolve();
        };

        let iterations = 0;
        while (processFile.mock.calls.length < total && iterations < total * 4) {
            const release = releasers.shift();
            release?.();
            await flush();
            iterations++;
        }

        expect(processFile).toHaveBeenCalledTimes(total);
        expect(maxActive).toBeLessThanOrEqual(WATCHER_INGEST_CONCURRENCY);

        // Drain whatever is still in flight so nothing is left hanging.
        while (releasers.length > 0) {
            releasers.shift()?.();
            await flush();
        }
    });
});

// ---------------------------------------------------------------------------
// stop() / updatePaths() lifecycle-lock serialization
// ---------------------------------------------------------------------------

describe('WatcherLeader lifecycle-lock serialization', () => {
    // acquireLock/renewLock/cacheSet/releaseLock (cache/valkey.js) all have an
    // in-memory fallback that activates automatically whenever no real Valkey
    // client is connected (see valkey.ts's `if (!client) { ... }` branches) —
    // this test suite never calls connectValkey(), so start()/stop() exercise
    // that fallback for real without needing to mock cache/valkey.js at all.
    beforeEach(() => {
        resetFakeNativeInstances();
    });

    it('two concurrent updatePaths() calls leave exactly one live NativeWatcherProcess (no orphan)', async () => {
        const instance = new WatcherLeader(vi.fn());
        const fakeContext = { sql: {} } as Partial<PluginContext> as PluginContext;

        const started = await instance.start(fakeContext, ['/media/a']);
        expect(started).toBe(true);
        expect(fakeNativeInstances).toHaveLength(1);

        try {
            // Fire both updatePaths calls back-to-back, without awaiting between
            // them, so they genuinely race. Pre-fix (no withLifecycleLock), both
            // would read the same `this.watcher`, both close it, and both
            // construct a new NativeWatcherProcess — orphaning one. Post-fix, the
            // shared `_lifecycle` promise chain serializes them.
            const p1 = instance.updatePaths(['/media/b']);
            const p2 = instance.updatePaths(['/media/c']);
            await Promise.all([p1, p2]);

            const live = fakeNativeInstances.filter((c) => !c.closed);
            expect(live).toHaveLength(1);
            // Sanity: both updates actually ran (not short-circuited as no-ops) —
            // the original 'a' watcher plus two path-change rebuilds.
            expect(fakeNativeInstances.length).toBeGreaterThanOrEqual(3);
        } finally {
            await instance.stop();
        }
    });
});
