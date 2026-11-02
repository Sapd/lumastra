// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/admin/plugins/[pluginId]/index.ts (GET /api/admin/plugins/file-scanner).
 *
 * Covers a cross-process staleness bug: `fileScannerMediaSource.getStatus()`
 * derives `isScanning` from the `_activeScans` module-level Set, which is
 * per-process. In a split app/worker deployment the scan runs in the worker
 * process while the admin UI's poll is served by the app process, so
 * `isScanning` is always false there even mid-scan — the admin "File Scanner"
 * card then never sees `isRunning: true` and freezes on its initial
 * "Discovering files..." placeholder forever. The fix ORs in the Valkey-backed
 * progress key (cross-process) so `isRunning` reflects cluster-wide state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockGetStatus = vi.fn();
const mockGetFileScannerProgress = vi.fn();
const mockBuildPluginContext = vi.fn();
const mockGetScanProgressByKey = vi.fn();
const mockRequestAbort = vi.fn();
const mockRequestAbortForKey = vi.fn();

vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { getTask: vi.fn() },
}));

vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: {
        startRun: vi.fn(),
        cancelRun: vi.fn(),
        listRuns: vi.fn(),
        getRun: vi.fn(),
    },
}));

vi.mock('$lib/server/tasks/backpressure.js', () => ({
    BackpressureError: class BackpressureError extends Error {},
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

vi.mock('$lib/server/tasks/builtin/native/media-sources/file-scanner.js', () => ({
    fileScannerMediaSource: {
        getStatus: (...args: unknown[]) => mockGetStatus(...args),
    },
    getFileScannerProgress: (...args: unknown[]) => mockGetFileScannerProgress(...args),
    requestFileScannerAbort: (...args: unknown[]) => mockRequestAbort(...args),
    requestFileScannerAbortForKey: (...args: unknown[]) => mockRequestAbortForKey(...args),
}));

vi.mock(
    '$lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/progress-store.js',
    () => ({
        getScanProgressByKey: (...args: unknown[]) => mockGetScanProgressByKey(...args),
    }),
);

vi.mock('$lib/server/tasks/plugin-context.js', () => ({
    buildPluginContext: (...args: unknown[]) => mockBuildPluginContext(...args),
}));

const { def } = await import('./index.js');
const { orchestrator } = await import('$lib/server/tasks/orchestrator.js');
const { registry } = await import('$lib/server/tasks/registry.js');

const CTX = { surface: 'internal' as const };

function makeEvent(body?: unknown, pluginId = 'file-scanner'): RequestEvent {
    const url = new URL(`http://localhost/api/admin/plugins/${pluginId}`);
    return {
        url,
        params: { pluginId },
        route: { id: '/api/admin/plugins/[pluginId]' as const },
        request:
            body === undefined
                ? new Request(url.toString())
                : new Request(url.toString(), { method: 'POST', body: JSON.stringify(body) }),
        locals: {
            principal: { username: 'admin' },
        },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockBuildPluginContext.mockReturnValue({});
    mockGetScanProgressByKey.mockResolvedValue(new Map());
    vi.mocked(orchestrator.listRuns).mockResolvedValue({ runs: [] });
});

const LIB_SERIES = '11111111-1111-4111-8111-111111111111';
const LIB_ANIME = '22222222-2222-4222-8222-222222222222';

function run(over: Record<string, unknown>) {
    return {
        id: 'r',
        taskId: 'file-library-scan',
        label: 'scan',
        state: 'active',
        input: {},
        trigger: { kind: 'manual' },
        startedAt: new Date().toISOString(),
        stages: [],
        ...over,
    } as never;
}

describe('GET /api/admin/plugins/file-scanner — cross-process isRunning', () => {
    it('reports not running when neither local state nor Valkey progress show a scan', async () => {
        mockGetStatus.mockResolvedValue({ isScanning: false, itemCount: 0 });
        mockGetFileScannerProgress.mockResolvedValue(null);

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);
        const body = await res.clone().json();

        expect(body.isRunning).toBe(false);
        expect(body.progress).toBeNull();
    });

    it('reports running from local _activeScans state (same-process case)', async () => {
        mockGetStatus.mockResolvedValue({ isScanning: true, itemCount: 0 });
        mockGetFileScannerProgress.mockResolvedValue(null);

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);
        const body = await res.clone().json();

        expect(body.isRunning).toBe(true);
    });

    it('reports running from cross-process Valkey progress even when local state is false', async () => {
        // This is the split app/worker scenario: the scan runs in the worker
        // process (so Valkey holds live progress) but this GET lands on the
        // app process, whose own `_activeScans` set is empty.
        mockGetStatus.mockResolvedValue({ isScanning: false, itemCount: 0 });
        mockGetFileScannerProgress.mockResolvedValue({
            totalFiles: 100,
            processedFiles: 42,
            currentFile: 'movie.mkv',
            currentLibraryPath: '/data/movies',
            added: 1,
            updated: 2,
            skipped: 3,
            unmatched: 0,
            errors: 0,
            phase: 'scanning',
        });

        const handler = def.handlers.GET!;
        const res = await handler(makeEvent(), CTX);
        const body = await res.clone().json();

        expect(body.isRunning).toBe(true);
        expect(body.progress).toEqual(
            expect.objectContaining({
                totalItems: 100,
                processedItems: 42,
                phase: 'scanning',
            }),
        );
    });
});

describe('GET /api/admin/plugins/file-scanner — per-library status', () => {
    // The aggregate `progress` sums every concurrent scan and names whichever
    // reported last: with the hourly scan of every library in flight, an admin
    // who started "Series" was shown "Anime". Each library now reports itself.
    it('lists each queued/running library with its own progress and who started it', async () => {
        mockGetStatus.mockResolvedValue({ isScanning: false, itemCount: 0 });
        mockGetFileScannerProgress.mockResolvedValue(null);
        vi.mocked(orchestrator.listRuns).mockResolvedValue({
            runs: [
                // Fan-out parent (no path) — not a library row.
                run({ id: 'P', trigger: { kind: 'scheduled' } }),
                // Its child: in-process, but it IS the periodic scan.
                run({
                    id: 'A',
                    parentRunId: 'P',
                    input: { libraryPathId: LIB_ANIME },
                    trigger: { kind: 'in-process' },
                }),
                run({
                    id: 'S',
                    state: 'pending',
                    input: { libraryPathId: LIB_SERIES },
                    trigger: { kind: 'manual' },
                }),
            ],
        });
        vi.mocked(orchestrator.getRun).mockResolvedValue(
            run({ id: 'P', trigger: { kind: 'scheduled' } }),
        );
        mockGetScanProgressByKey.mockResolvedValue(
            new Map([[LIB_ANIME, { processedFiles: 10, totalFiles: 100, phase: 'scanning' }]]),
        );

        const body = await (await def.handlers.GET!(makeEvent(), CTX)).json();

        expect(body.isRunning).toBe(true);
        expect(body.libraries).toEqual([
            {
                libraryPathId: LIB_ANIME,
                state: 'running',
                trigger: 'scheduled',
                processedItems: 10,
                totalItems: 100,
                phase: 'scanning',
            },
            { libraryPathId: LIB_SERIES, state: 'queued', trigger: 'manual' },
        ]);
    });

    it('a new queued request is not hidden behind a run that is being stopped', async () => {
        mockGetStatus.mockResolvedValue({ isScanning: false, itemCount: 0 });
        mockGetFileScannerProgress.mockResolvedValue(null);
        vi.mocked(orchestrator.listRuns).mockResolvedValue({
            runs: [
                run({ id: 'old', state: 'cancelling', input: { libraryPathId: LIB_SERIES } }),
                run({ id: 'new', state: 'pending', input: { libraryPathId: LIB_SERIES } }),
            ],
        });

        const body = await (await def.handlers.GET!(makeEvent(), CTX)).json();
        expect(body.libraries).toEqual([
            { libraryPathId: LIB_SERIES, state: 'queued', trigger: 'manual' },
        ]);
    });

    it("a stopping run's progress does not turn the new queued request into 'Scanning'", async () => {
        mockGetStatus.mockResolvedValue({ isScanning: false, itemCount: 0 });
        mockGetFileScannerProgress.mockResolvedValue(null);
        vi.mocked(orchestrator.listRuns).mockResolvedValue({
            runs: [
                run({ id: 'old', state: 'cancelling', input: { libraryPathId: LIB_SERIES } }),
                run({ id: 'new', state: 'pending', input: { libraryPathId: LIB_SERIES } }),
            ],
        });
        // The dying run is still walking and writing its key.
        mockGetScanProgressByKey.mockResolvedValue(
            new Map([[LIB_SERIES, { processedFiles: 500, totalFiles: 1000, phase: 'scanning' }]]),
        );

        const body = await (await def.handlers.GET!(makeEvent(), CTX)).json();
        expect(body.libraries).toEqual([
            { libraryPathId: LIB_SERIES, state: 'queued', trigger: 'manual' },
        ]);
    });

    it('keeps the page polling while a scan is only queued (no progress key yet)', async () => {
        mockGetStatus.mockResolvedValue({ isScanning: false, itemCount: 0 });
        mockGetFileScannerProgress.mockResolvedValue(null);
        vi.mocked(orchestrator.listRuns).mockResolvedValue({
            runs: [run({ state: 'pending', input: { libraryPathId: LIB_SERIES } })],
        });

        const body = await (await def.handlers.GET!(makeEvent(), CTX)).json();
        expect(body.isRunning).toBe(true);
    });
});

describe('POST /api/admin/plugins/file-scanner — scoped abort + honest dedupe', () => {
    it("stopping one library cancels only that library's runs", async () => {
        vi.mocked(orchestrator.listRuns).mockResolvedValue({
            runs: [
                run({ id: 'P', trigger: { kind: 'scheduled' } }),
                run({ id: 'A', input: { libraryPathId: LIB_ANIME } }),
                run({ id: 'S', input: { libraryPathId: LIB_SERIES } }),
            ],
        });
        vi.mocked(orchestrator.cancelRun).mockResolvedValue({ accepted: true } as never);

        const res = await def.handlers.POST!(
            makeEvent({ action: 'abort', paths: [LIB_SERIES] }),
            CTX,
        );

        expect(res.status).toBe(200);
        expect(vi.mocked(orchestrator.cancelRun).mock.calls.map((c) => c[0])).toEqual(['S']);
        expect(mockRequestAbortForKey).toHaveBeenCalledWith(LIB_SERIES);
        expect(mockRequestAbort).not.toHaveBeenCalled();
    });

    it('a bare abort still stops everything', async () => {
        vi.mocked(orchestrator.listRuns).mockResolvedValue({
            runs: [run({ id: 'A', input: { libraryPathId: LIB_ANIME } }), run({ id: 'P' })],
        });
        vi.mocked(orchestrator.cancelRun).mockResolvedValue({ accepted: true } as never);

        await def.handlers.POST!(makeEvent({ action: 'abort' }), CTX);

        expect(vi.mocked(orchestrator.cancelRun)).toHaveBeenCalledTimes(2);
        expect(mockRequestAbort).toHaveBeenCalled();
    });

    it("rejects abort+paths for plugins that aren't the file scanner", async () => {
        const res = await def.handlers.POST!(
            makeEvent({ action: 'abort', paths: [LIB_SERIES] }, 'media-probe'),
            CTX,
        );
        expect(res.status).toBe(422); // ApiProblem.validationFailed
        expect(orchestrator.cancelRun).not.toHaveBeenCalled();
    });

    it('flags a request that deduped onto an already-running scan', async () => {
        vi.mocked(orchestrator.startRun).mockResolvedValue({ runId: 'S', deduped: true } as never);
        const body = await (
            await def.handlers.POST!(makeEvent({ paths: [LIB_SERIES] }), CTX)
        ).json();
        expect(body).toMatchObject({ alreadyRunning: true, message: 'Scan already running' });
    });
});

describe('POST /api/admin/plugins/[pluginId] — demo task guard (C6)', () => {
    // Security review 6, C6: a `demo: true` task claimed to be "hidden in
    // production" but was directly triggerable through this def —
    // registry.getTask() was consulted with no `demo` check before dispatch.
    // NODE_ENV is read directly by the guard at call time; save/restore
    // around each case so a thrown assertion never leaks a mode into another
    // test.
    const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

    afterEach(() => {
        process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    });

    it('refuses a demo task in production with 404', async () => {
        process.env.NODE_ENV = 'production';
        vi.mocked(registry.getTask).mockReturnValue({ id: 'tmdb-metadata', demo: true } as never);

        const res = await def.handlers.POST!(makeEvent({}, 'tmdb-metadata'), CTX);

        expect(res.status).toBe(404);
        expect(orchestrator.startRun).not.toHaveBeenCalled();
    });

    it('control: a non-demo task in production is still accepted', async () => {
        process.env.NODE_ENV = 'production';
        vi.mocked(registry.getTask).mockReturnValue({ id: 'media-probe' } as never);
        vi.mocked(orchestrator.startRun).mockResolvedValue({
            runId: 'r1',
            deduped: false,
        } as never);

        const res = await def.handlers.POST!(makeEvent({}, 'media-probe'), CTX);

        expect(res.status).toBe(200);
        expect(orchestrator.startRun).toHaveBeenCalled();
    });

    it('control: a demo task in development is still accepted', async () => {
        process.env.NODE_ENV = 'development';
        vi.mocked(registry.getTask).mockReturnValue({ id: 'tmdb-metadata', demo: true } as never);
        vi.mocked(orchestrator.startRun).mockResolvedValue({
            runId: 'r2',
            deduped: false,
        } as never);

        const res = await def.handlers.POST!(makeEvent({}, 'tmdb-metadata'), CTX);

        expect(res.status).toBe(200);
        expect(orchestrator.startRun).toHaveBeenCalled();
    });
});
