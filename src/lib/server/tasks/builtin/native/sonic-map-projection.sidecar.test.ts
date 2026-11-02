// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the HTTP sidecar path in sonic-map-projection.ts.
 *
 * Covers:
 *   - HTTP branch: calls POST /project-map, parses NDJSON, upserts coords
 *   - HTTP branch: sidecar error → task returns failure
 *   - HTTP branch: empty response → no-op (no DB writes)
 *   - Subprocess fallback: SONIC_EMBEDDER_URL empty → execFile called, fetch NOT called
 *   - Feature gate: musicMap off → no-op regardless of URL
 *   - DATABASE_URL missing → early failure
 *   - Parse-error tolerance (malformed JSONL lines counted)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const mockExecFileAsync = vi.fn();
const mockFetch = vi.fn();

const mockFeatures = vi.hoisted(() => ({ musicMap: true }));
const mockConfig = vi.hoisted(() => ({
    SONIC_EMBEDDER_URL: 'http://sonic-embedder:8000',
    SONIC_EMBEDDER_PYTHON: 'python3',
    SONIC_MAP_PROJECTION_SCRIPT: 'workers/sonic-embedder/project_map.py',
    DATABASE_URL: 'postgres://test',
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:util', () => ({ promisify: () => mockExecFileAsync }));

vi.mock('$lib/server/config.js', () => ({
    features: mockFeatures,
    config: mockConfig,
}));

vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { registerTask: vi.fn() },
}));

const mockUpsertMapCoords = vi.fn().mockResolvedValue(undefined);
const mockClearMapCoords = vi.fn().mockResolvedValue(undefined);

const mockCountMapCoords = vi.fn().mockResolvedValue(0);

vi.mock('$lib/server/database/queries/music-map.queries.js', () => ({
    upsertMapCoords: mockUpsertMapCoords,
    clearMapCoords: mockClearMapCoords,
    countMapCoords: mockCountMapCoords,
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        }),
    },
}));

vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const ac = new AbortController();
    const fakeSql = vi.fn() as unknown as { begin: ReturnType<typeof vi.fn> } & (() => void);
    // sql.begin(cb) — Bug 4 wraps clear+upsert in a transaction. The fake
    // just invokes the callback with the same fake sql standing in for the
    // transaction handle (query modules are mocked, so it never touches a
    // real connection).
    fakeSql.begin = vi.fn((cb: (tx: unknown) => Promise<unknown>) => cb(fakeSql));
    return {
        sql: fakeSql,
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
        // ctx.settings() is called in execute() to read cpuThreads; default to {} (no cap)
        settings: vi.fn().mockResolvedValue({}),
        ...overrides,
    };
}

function buildNdjson(rows: Array<{ media_id: string; x: number; y: number }>): string {
    return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

function mockResponse(body: string, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(body),
    } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
    vi.clearAllMocks();
    mockFeatures.musicMap = true;
    mockConfig.SONIC_EMBEDDER_URL = 'http://sonic-embedder:8000';
    mockConfig.DATABASE_URL = 'postgres://test';
    mockUpsertMapCoords.mockResolvedValue(undefined);
    mockClearMapCoords.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sonicMapProjectionTask — HTTP sidecar path', () => {
    test('calls POST /project-map and upserts coords on success', async () => {
        const rows = [
            { media_id: 'aaaa-1111', x: 0.1, y: 0.2 },
            { media_id: 'bbbb-2222', x: 0.5, y: 0.8 },
        ];
        mockFetch.mockResolvedValueOnce(mockResponse(buildNdjson(rows)));

        vi.resetModules();
        const { sonicMapProjectionTask } = await import('./sonic-map-projection.js');
        const result = await sonicMapProjectionTask.execute(
            makeCtx() as unknown as Parameters<typeof sonicMapProjectionTask.execute>[0],
        );

        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(2);

        // fetch was used, not execFile
        expect(mockFetch).toHaveBeenCalledOnce();
        expect(mockExecFileAsync).not.toHaveBeenCalled();

        const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('http://sonic-embedder:8000/project-map');
        expect(init.method).toBe('POST');

        // DB writes happened
        expect(mockClearMapCoords).toHaveBeenCalledOnce();
        expect(mockUpsertMapCoords).toHaveBeenCalled();
    });

    test('returns no-op when sidecar returns empty NDJSON', async () => {
        mockFetch.mockResolvedValueOnce(mockResponse(''));

        vi.resetModules();
        const { sonicMapProjectionTask } = await import('./sonic-map-projection.js');
        const result = await sonicMapProjectionTask.execute(
            makeCtx() as unknown as Parameters<typeof sonicMapProjectionTask.execute>[0],
        );

        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
        expect(mockClearMapCoords).not.toHaveBeenCalled();
        expect(mockUpsertMapCoords).not.toHaveBeenCalled();
    });

    test('throws a transient TaskError when sidecar returns HTTP 503', async () => {
        mockFetch.mockResolvedValue(mockResponse('{"detail":"loading"}', 503));

        vi.resetModules();
        const { sonicMapProjectionTask } = await import('./sonic-map-projection.js');
        const ctx = makeCtx() as unknown as Parameters<typeof sonicMapProjectionTask.execute>[0];

        // A normal `return {success:false}` here used to be silently recorded
        // 'completed' by the runner — must throw so a sick sidecar is visible.
        await expect(sonicMapProjectionTask.execute(ctx)).rejects.toMatchObject({
            kind: 'transient',
        });
        expect(mockClearMapCoords).not.toHaveBeenCalled();
    });

    test('throws a transient TaskError when fetch throws (network error)', async () => {
        mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

        vi.resetModules();
        const { sonicMapProjectionTask } = await import('./sonic-map-projection.js');
        const ctx = makeCtx() as unknown as Parameters<typeof sonicMapProjectionTask.execute>[0];

        await expect(sonicMapProjectionTask.execute(ctx)).rejects.toMatchObject({
            kind: 'transient',
        });
    });

    test('tolerates and counts malformed JSONL lines', async () => {
        const validRow = { media_id: 'valid-uuid', x: 0.3, y: 0.7 };
        const ndjson =
            'NOT_JSON\n' +
            JSON.stringify({ media_id: 'missing-x' }) +
            '\n' +
            JSON.stringify(validRow) +
            '\n';
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));

        vi.resetModules();
        const { sonicMapProjectionTask } = await import('./sonic-map-projection.js');
        const result = await sonicMapProjectionTask.execute(
            makeCtx() as unknown as Parameters<typeof sonicMapProjectionTask.execute>[0],
        );

        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(1);
        const r = result.result as { projected: number; parseErrors: number };
        expect(r.parseErrors).toBe(2);
    });

    test('clamps coordinates to [0, 1]', async () => {
        const rows = [{ media_id: 'clip-uuid', x: 1.5, y: -0.1 }];
        mockFetch.mockResolvedValueOnce(mockResponse(buildNdjson(rows)));

        vi.resetModules();
        const { sonicMapProjectionTask } = await import('./sonic-map-projection.js');
        await sonicMapProjectionTask.execute(
            makeCtx() as unknown as Parameters<typeof sonicMapProjectionTask.execute>[0],
        );

        expect(mockUpsertMapCoords).toHaveBeenCalled();
        const firstBatch = mockUpsertMapCoords.mock.calls[0][1] as Array<{
            mediaId: string;
            x: number;
            y: number;
        }>;
        const coord = firstBatch.find((c) => c.mediaId === 'clip-uuid');
        expect(coord?.x).toBe(1); // clamped from 1.5
        expect(coord?.y).toBe(0); // clamped from -0.1
    });

    test('Bug 3: passes an abort signal derived from ctx.signal to fetch', async () => {
        mockFetch.mockResolvedValueOnce(mockResponse(''));
        const ac = new AbortController();

        vi.resetModules();
        const { sonicMapProjectionTask } = await import('./sonic-map-projection.js');
        await sonicMapProjectionTask.execute(
            makeCtx({ signal: ac.signal }) as unknown as Parameters<
                typeof sonicMapProjectionTask.execute
            >[0],
        );

        expect(mockFetch).toHaveBeenCalledOnce();
        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(init.signal).toBeInstanceOf(AbortSignal);

        // Aborting ctx.signal must abort the combined fetch signal — proves
        // ctx.signal actually participates (AbortSignal.any), not just the
        // sidecar's own fixed timeout.
        ac.abort();
        expect((init.signal as AbortSignal).aborted).toBe(true);
    });

    test('Bug 4: wraps clear + upsert in a single sql.begin() transaction', async () => {
        const rows = [{ media_id: 'id-1', x: 0.2, y: 0.3 }];
        mockFetch.mockResolvedValueOnce(mockResponse(buildNdjson(rows)));

        vi.resetModules();
        const { sonicMapProjectionTask } = await import('./sonic-map-projection.js');
        const ctx = makeCtx();
        const result = await sonicMapProjectionTask.execute(
            ctx as unknown as Parameters<typeof sonicMapProjectionTask.execute>[0],
        );

        expect(result.success).toBe(true);
        const fakeSql = ctx.sql as unknown as { begin: ReturnType<typeof vi.fn> };
        expect(fakeSql.begin).toHaveBeenCalledOnce();
        expect(mockClearMapCoords).toHaveBeenCalledOnce();
        expect(mockUpsertMapCoords).toHaveBeenCalled();
    });
});

describe('sonicMapProjectionTask — abort before start (Bug 3)', () => {
    test('returns an aborted result immediately when signal is already aborted', async () => {
        const ac = new AbortController();
        ac.abort();

        vi.resetModules();
        const { sonicMapProjectionTask } = await import('./sonic-map-projection.js');
        const result = await sonicMapProjectionTask.execute(
            makeCtx({ signal: ac.signal }) as unknown as Parameters<
                typeof sonicMapProjectionTask.execute
            >[0],
        );

        expect(result.success).toBe(true);
        expect(result.stopReason).toBe('aborted');
        expect(mockFetch).not.toHaveBeenCalled();
        expect(mockExecFileAsync).not.toHaveBeenCalled();
    });
});

describe('sonicMapProjectionTask — subprocess fallback (SONIC_EMBEDDER_URL empty)', () => {
    test('calls execFile and NOT fetch when URL is empty', async () => {
        mockConfig.SONIC_EMBEDDER_URL = '';
        const rows = [{ media_id: 'id-1', x: 0.2, y: 0.3 }];
        mockExecFileAsync.mockResolvedValueOnce({ stdout: buildNdjson(rows), stderr: '' });

        vi.resetModules();
        const { sonicMapProjectionTask } = await import('./sonic-map-projection.js');
        const result = await sonicMapProjectionTask.execute(
            makeCtx() as unknown as Parameters<typeof sonicMapProjectionTask.execute>[0],
        );

        expect(mockFetch).not.toHaveBeenCalled();
        expect(mockExecFileAsync).toHaveBeenCalledOnce();
        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(1);
    });

    test('passes DATABASE_URL and MODEL_ID to subprocess env', async () => {
        mockConfig.SONIC_EMBEDDER_URL = '';
        mockExecFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });

        vi.resetModules();
        const { sonicMapProjectionTask } = await import('./sonic-map-projection.js');
        await sonicMapProjectionTask.execute(
            makeCtx() as unknown as Parameters<typeof sonicMapProjectionTask.execute>[0],
        );

        const [_bin, _args, opts] = mockExecFileAsync.mock.calls[0] as [
            string,
            string[],
            { env: Record<string, string> },
        ];
        expect(opts.env.DATABASE_URL).toBe('postgres://test');
        expect(opts.env.MODEL_ID).toBe('msclap-2023');
    });
});

describe('sonicMapProjectionTask — feature gate and validation', () => {
    test('is a no-op when musicMap feature is off', async () => {
        mockFeatures.musicMap = false;

        vi.resetModules();
        const { sonicMapProjectionTask } = await import('./sonic-map-projection.js');
        const result = await sonicMapProjectionTask.execute(
            makeCtx() as unknown as Parameters<typeof sonicMapProjectionTask.execute>[0],
        );

        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
        expect(mockFetch).not.toHaveBeenCalled();
        expect(mockExecFileAsync).not.toHaveBeenCalled();
    });

    test('throws a permanent TaskError when DATABASE_URL is empty', async () => {
        mockConfig.DATABASE_URL = '';

        vi.resetModules();
        const { sonicMapProjectionTask } = await import('./sonic-map-projection.js');
        const ctx = makeCtx() as unknown as Parameters<typeof sonicMapProjectionTask.execute>[0];

        await expect(sonicMapProjectionTask.execute(ctx)).rejects.toMatchObject({
            kind: 'permanent',
        });
        expect(mockFetch).not.toHaveBeenCalled();
        expect(mockExecFileAsync).not.toHaveBeenCalled();
    });
});
