// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * file-library-scan native task — manifest and disable-gate tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fileLibraryScanTask } from './file-library-scan.js';
import { features } from '$lib/server/config.js';

const startRun = vi.fn((..._args: unknown[]): Promise<{ runId: string; deduped: boolean }> =>
    Promise.resolve({ runId: 'child', deduped: false }),
);
const getEnabledLibraryPaths = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('$lib/server/services/jellyfin-setup-sync.service.js', () => ({
    requestJellyfinSetupInventory: (_sql: unknown, source: string) =>
        startRun(
            'jellyfin-file-inventory',
            { kickPull: true },
            {
                trigger: { kind: 'in-process', sourceRoute: source },
                idempotencyKey: `jellyfin-setup-inventory-${Math.floor(Date.now() / 600_000)}`,
            },
        ),
}));

vi.mock('../../orchestrator.js', () => ({
    orchestrator: {
        startRun: (...args: unknown[]) => startRun(...args),
    },
}));
const scanForSync = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('./media-sources/file-scanner.js', () => ({
    scanForSync: (...args: unknown[]) => scanForSync(...args),
    requestFileScannerAbortForKey: vi.fn(),
}));
vi.mock('$lib/server/database/queries/library-paths.queries.js', () => ({
    getEnabledLibraryPaths: (...args: unknown[]) => getEnabledLibraryPaths(...args),
}));

describe('file-library-scan task manifest', () => {
    it('has the correct id', () => {
        expect(fileLibraryScanTask.id).toBe('file-library-scan');
    });

    it('declares a 1h schedule with env override', () => {
        expect(fileLibraryScanTask.schedule).toMatchObject({
            every: '1h',
            envOverride: 'SYNC_FILE_LIBRARY_SCAN_INTERVAL',
        });
    });

    it('uses io resource class', () => {
        expect(fileLibraryScanTask.resourceClass).toBe('io');
    });

    it('has runOnStartup: true with 2m startupDelay', () => {
        expect(fileLibraryScanTask.schedule?.runOnStartup).toBe(true);
        expect(fileLibraryScanTask.schedule?.startupDelay).toBe('2m');
    });

    it('has global scope', () => {
        expect(fileLibraryScanTask.scope).toBe('global');
    });

    it('declares exclusiveWith so per-path runs are deduped cluster-wide', () => {
        expect(fileLibraryScanTask.exclusiveWith).toMatchObject({ scope: 'global', ttl: '130m' });
    });

    it('caps maxConcurrent at 5 so fan-out cannot claim the whole bulk pool', () => {
        // Raised 2 → 5 (see the task def comment): with a cap of 2, two wedged
        // video-library scans blocked every other library — incl. a newly-added
        // music library — from scanning at all.
        expect(fileLibraryScanTask.quotas?.maxConcurrent).toBe(5);
    });

    it('identityFor returns "global-catchup" without libraryPathId', () => {
        expect(fileLibraryScanTask.identityFor({})).toBe('global-catchup');
    });

    it('identityFor returns "global-force" for force mode without libraryPathId', () => {
        expect(fileLibraryScanTask.identityFor({ mode: 'force' })).toBe('global-force');
    });

    it('identityFor returns path key when libraryPathId provided', () => {
        // Colons are banned in identity formulas — BullMQ 5.71 rejects them in
        // jobIds (see commit 46e931899). The native task now uses `-` as the
        // intra-formula separator.
        expect(fileLibraryScanTask.identityFor({ libraryPathId: 'abc' })).toBe('path-abc');
    });
});

describe('file-library-scan DISABLE_FILE_LIBRARY_SCAN gate', () => {
    const ac = new AbortController();

    function makeCtx() {
        return {
            sql: vi.fn(),
            logger: {
                info: vi.fn(),
                warn: vi.fn(),
                debug: vi.fn(),
                error: vi.fn(),
            },
            signal: ac.signal,
            abortSignal: ac.signal,
            runId: 'test-run',
            input: {},
            reportProgress: vi.fn(),
        };
    }

    beforeEach(() => {
        delete process.env.DISABLE_FILE_LIBRARY_SCAN;
    });

    it('returns success with 0 items when DISABLE_FILE_LIBRARY_SCAN=true', async () => {
        process.env.DISABLE_FILE_LIBRARY_SCAN = 'true';
        const ctx = makeCtx();
        const result = await fileLibraryScanTask.execute(
            ctx as unknown as Parameters<typeof fileLibraryScanTask.execute>[0],
        );
        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
    });
});

describe('file-library-scan per-path fan-out', () => {
    const ac = new AbortController();

    function makeCtx(input: Record<string, unknown>) {
        return {
            sql: vi.fn(),
            logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
            signal: ac.signal,
            abortSignal: ac.signal,
            runId: 'parent-run',
            input,
            reportProgress: vi.fn(),
        };
    }

    beforeEach(() => {
        delete process.env.DISABLE_FILE_LIBRARY_SCAN;
        // Reset + restore the default impl so a per-test mockImplementation
        // (e.g. the total-failure case) can't leak into the next test.
        startRun.mockReset();
        startRun.mockImplementation(() => Promise.resolve({ runId: 'child', deduped: false }));
        getEnabledLibraryPaths.mockReset();
    });

    const dispatchedIds = (): string[] =>
        startRun.mock.calls.map((c) => (c[1] as { libraryPathId: string }).libraryPathId);

    it('dispatches one scoped per-path run per enabled library path (no monolithic scan)', async () => {
        getEnabledLibraryPaths.mockResolvedValue([
            { id: 'movies-id', path: '/data/movies', media_type: 'movie', library_group_id: 'g-m' },
            { id: 'series-id', path: '/data/series', media_type: 'tv', library_group_id: 'g-s' },
        ]);
        const ctx = makeCtx({});
        const result = await fileLibraryScanTask.execute(
            ctx as unknown as Parameters<typeof fileLibraryScanTask.execute>[0],
        );

        expect(result.success).toBe(true);
        // itemsProcessed = number of per-path runs queued (dispatcher view).
        expect(result.itemsProcessed).toBe(2);
        expect(startRun).toHaveBeenCalledTimes(2);
        expect(dispatchedIds()).toEqual(['movies-id', 'series-id']);
        // Each fan-out child carries its own libraryGroupId + parentRunId.
        expect(startRun.mock.calls[0][2]).toMatchObject({
            libraryGroupId: 'g-m',
            parentRunId: 'parent-run',
            idempotencyKey: 'library-ingest:file-library-scan:movies-id',
        });
    });

    it('dispatches movies/video libraries before series, music, etc.', async () => {
        // Intentionally NOT in priority order in the input.
        getEnabledLibraryPaths.mockResolvedValue([
            { id: 'music-id', path: '/data/music', media_type: 'music', library_group_id: 'g1' },
            { id: 'series-id', path: '/data/series', media_type: 'tv', library_group_id: 'g2' },
            { id: 'movies-id', path: '/data/movies', media_type: 'movie', library_group_id: 'g3' },
        ]);
        const ctx = makeCtx({});
        await fileLibraryScanTask.execute(
            ctx as unknown as Parameters<typeof fileLibraryScanTask.execute>[0],
        );
        expect(dispatchedIds()).toEqual(['movies-id', 'series-id', 'music-id']);
    });

    it('tolerates a PARTIAL dispatch failure (logs, self-heals next cycle, no throw)', async () => {
        getEnabledLibraryPaths.mockResolvedValue([
            { id: 'movies-id', path: '/data/movies', media_type: 'movie', library_group_id: 'g1' },
            { id: 'series-id', path: '/data/series', media_type: 'tv', library_group_id: 'g2' },
        ]);
        startRun.mockImplementationOnce(() => Promise.resolve({ runId: 'ok', deduped: false }));
        startRun.mockImplementationOnce(() => Promise.reject(new Error('queue at capacity')));
        const ctx = makeCtx({});
        const result = await fileLibraryScanTask.execute(
            ctx as unknown as Parameters<typeof fileLibraryScanTask.execute>[0],
        );
        // One dispatched, one failed → not a total failure → don't fail the
        // whole dispatcher (would risk circuit-tripping all scanning).
        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(1);
        expect(ctx.logger.error).toHaveBeenCalled();
    });

    it('THROWS when every per-path dispatch fails (so the run is marked failed + retried, not a silent completed)', async () => {
        getEnabledLibraryPaths.mockResolvedValue([
            { id: 'movies-id', path: '/data/movies', media_type: 'movie', library_group_id: 'g1' },
            { id: 'series-id', path: '/data/series', media_type: 'tv', library_group_id: 'g2' },
        ]);
        startRun.mockImplementation(() => Promise.reject(new Error('orchestrator unavailable')));
        const ctx = makeCtx({});
        await expect(
            fileLibraryScanTask.execute(
                ctx as unknown as Parameters<typeof fileLibraryScanTask.execute>[0],
            ),
        ).rejects.toThrow(/orchestrator unavailable/);
    });

    it('returns success with no dispatch when there are no enabled library paths', async () => {
        getEnabledLibraryPaths.mockResolvedValue([]);
        const ctx = makeCtx({});
        const result = await fileLibraryScanTask.execute(
            ctx as unknown as Parameters<typeof fileLibraryScanTask.execute>[0],
        );
        expect(result.success).toBe(true);
        expect(startRun).not.toHaveBeenCalled();
    });
});

describe('file-library-scan per-path result', () => {
    const ac = new AbortController();

    function makeCtx() {
        return {
            sql: vi.fn(),
            logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
            signal: ac.signal,
            abortSignal: ac.signal,
            runId: 'path-run',
            input: { libraryPathId: 'lp-1' },
            reportProgress: vi.fn(),
        };
    }

    beforeEach(() => {
        delete process.env.DISABLE_FILE_LIBRARY_SCAN;
        scanForSync.mockReset();
    });

    it('names the failed files in the run result, not just a count', async () => {
        const errors = Array.from(
            { length: 8 },
            (_, i) => `/data/anime/S01E0${i}.mkv: processing failed`,
        );
        scanForSync.mockResolvedValue({ added: 0, updated: 0, skipped: 100, unmatched: 0, errors });

        const out = await fileLibraryScanTask.execute(
            makeCtx() as unknown as Parameters<typeof fileLibraryScanTask.execute>[0],
        );

        expect(out.result?.scanErrors).toBe(8);
        expect(out.result?.scanErrorSample).toEqual(errors.slice(0, 5));
        expect(out.result?.message).toContain('8 error(s)');
        expect(out.result?.message).toContain('/data/anime/S01E00.mkv');
        expect(out.result?.message).toContain('...and 3 more');
    });

    it.each([
        'write CONNECTION_CLOSED postgres:5432',
        'connect ECONNREFUSED postgres:5432',
        'ENOSPC: no space left on device',
    ])('throws a retryable error for collected infrastructure failure: %s', async (message) => {
        scanForSync.mockResolvedValue({
            added: 0,
            updated: 0,
            skipped: 0,
            unmatched: 0,
            errors: [message],
            errorDetails: [{ path: '/fixture.mkv', err: new Error(message) }],
        });
        await expect(
            fileLibraryScanTask.execute(
                makeCtx() as unknown as Parameters<typeof fileLibraryScanTask.execute>[0],
            ),
        ).rejects.toMatchObject({ kind: 'transient', message: expect.stringContaining(message) });
    });

    it.each([
        { path: '/Connection Lost (2019).mkv', err: new Error('invalid media') },
        { path: '/fixture.mkv', err: new Error('Connection is closed.') },
    ])('preserves counts and samples for a tolerated per-file error: $path', async (detail) => {
        const errors = [`${detail.path}: ${detail.err.message}`];
        scanForSync.mockResolvedValue({
            added: 100,
            updated: 5,
            skipped: 0,
            unmatched: 0,
            errors,
            errorDetails: [detail],
        });
        const out = await fileLibraryScanTask.execute(
            makeCtx() as unknown as Parameters<typeof fileLibraryScanTask.execute>[0],
        );
        expect(out).toMatchObject({
            success: true,
            itemsProcessed: 105,
            result: { added: 100, updated: 5, scanErrors: 1, scanErrorSample: errors },
        });
    });

    it('does not retry a path that looks like a connection error even above the threshold', async () => {
        const detail = { path: '/Connection Lost (2019).mkv', err: new Error('invalid media') };
        scanForSync.mockResolvedValue({
            added: 1,
            updated: 0,
            skipped: 0,
            unmatched: 0,
            errors: [`${detail.path}: invalid media`],
            errorDetails: [detail],
        });
        const out = await fileLibraryScanTask.execute(
            makeCtx() as unknown as Parameters<typeof fileLibraryScanTask.execute>[0],
        );
        expect(out.success).toBe(false);
    });

    it('omits the sample on a clean scan', async () => {
        scanForSync.mockResolvedValue({
            added: 1,
            updated: 0,
            skipped: 5,
            unmatched: 0,
            errors: [],
        });

        const out = await fileLibraryScanTask.execute(
            makeCtx() as unknown as Parameters<typeof fileLibraryScanTask.execute>[0],
        );

        expect(out.result?.scanErrors).toBe(0);
        expect(out.result?.scanErrorSample).toBeUndefined();
    });

    it('does not enqueue inventory for an unchanged scan', async () => {
        const enabled = vi.spyOn(features, 'jellyfinSync', 'get').mockReturnValue(true);
        startRun.mockClear();
        scanForSync.mockResolvedValue({
            added: 0,
            updated: 0,
            skipped: 5,
            unmatched: 0,
            errors: [],
        });
        try {
            await fileLibraryScanTask.execute(makeCtx() as never);
            expect(startRun).not.toHaveBeenCalled();
        } finally {
            enabled.mockRestore();
        }
    });

    it('starts one setup inventory with a time-bucketed idempotency key after a changed scan', async () => {
        const enabled = vi.spyOn(features, 'jellyfinSync', 'get').mockReturnValue(true);
        startRun.mockClear();
        scanForSync.mockResolvedValue({
            added: 1,
            updated: 0,
            skipped: 5,
            unmatched: 0,
            errors: [],
        });
        try {
            await fileLibraryScanTask.execute(makeCtx() as never);
            expect(startRun).toHaveBeenCalledWith(
                'jellyfin-file-inventory',
                { kickPull: true },
                {
                    trigger: { kind: 'in-process', sourceRoute: 'file-library-scan' },
                    idempotencyKey: expect.stringMatching(/^jellyfin-setup-inventory-\d+$/),
                },
            );
        } finally {
            enabled.mockRestore();
        }
    });

    it('does not fail or retry a successful scan because its inventory trigger failed', async () => {
        const enabled = vi.spyOn(features, 'jellyfinSync', 'get').mockReturnValue(true);
        startRun.mockRejectedValueOnce(new Error('queue unavailable'));
        scanForSync.mockResolvedValue({
            added: 1,
            updated: 0,
            skipped: 0,
            unmatched: 0,
            errors: [],
        });
        const context = makeCtx();
        try {
            await expect(fileLibraryScanTask.execute(context as never)).resolves.toMatchObject({
                success: true,
            });
            expect(context.logger.warn).toHaveBeenCalled();
        } finally {
            enabled.mockRestore();
        }
    });

    it('does not start Jellyfin tasks when watch sync is disabled', async () => {
        const enabled = vi.spyOn(features, 'jellyfinSync', 'get').mockReturnValue(false);
        startRun.mockClear();
        scanForSync.mockResolvedValue({
            added: 1,
            updated: 0,
            skipped: 0,
            unmatched: 0,
            errors: [],
        });
        try {
            await fileLibraryScanTask.execute(makeCtx() as never);
            expect(startRun).not.toHaveBeenCalled();
        } finally {
            enabled.mockRestore();
        }
    });
});
