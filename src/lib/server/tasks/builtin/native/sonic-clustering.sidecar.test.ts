// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the HTTP sidecar path in sonic-clustering.ts.
 *
 * Covers:
 *   - HTTP branch: calls POST /cluster with {k}, parses NDJSON, upserts assignments
 *   - HTTP branch: sidecar error → task returns failure
 *   - HTTP branch: empty response → no-op (no DB writes)
 *   - Subprocess fallback: SONIC_EMBEDDER_URL empty → execFile called, fetch NOT called
 *   - Feature gate: musicClusters off → no-op regardless of URL
 *   - DATABASE_URL missing → early failure
 *   - Parse-error tolerance
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const mockExecFileAsync = vi.fn();
const mockFetch = vi.fn();

const mockFeatures = vi.hoisted(() => ({ musicClusters: true }));
const mockConfig = vi.hoisted(() => ({
    SONIC_EMBEDDER_URL: 'http://sonic-embedder:8000',
    SONIC_EMBEDDER_PYTHON: 'python3',
    SONIC_CLUSTER_SCRIPT: 'workers/sonic-embedder/cluster.py',
    SONIC_CLUSTER_K: 12,
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

const mockUpsertClusterAssignments = vi.fn().mockResolvedValue(undefined);
const mockClearClusterAssignments = vi.fn().mockResolvedValue(undefined);
const mockCountClusterAssignments = vi.fn().mockResolvedValue(0);

vi.mock('$lib/server/database/queries/audio-clusters.queries.js', () => ({
    CLUSTER_MODEL_ID: 'msclap-2023',
    upsertClusterAssignments: mockUpsertClusterAssignments,
    clearClusterAssignments: mockClearClusterAssignments,
    countClusterAssignments: mockCountClusterAssignments,
    getClusterAssignmentMap: vi.fn().mockResolvedValue(new Map()),
    getHighestIssuedClusterId: vi.fn().mockResolvedValue(-1),
    recordIssuedClusterIds: vi.fn().mockResolvedValue(undefined),
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

function buildNdjson(rows: Array<{ media_id: string; cluster_id: number }>): string {
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
    mockFeatures.musicClusters = true;
    mockConfig.SONIC_EMBEDDER_URL = 'http://sonic-embedder:8000';
    mockConfig.DATABASE_URL = 'postgres://test';
    mockConfig.SONIC_CLUSTER_K = 12;
    mockUpsertClusterAssignments.mockResolvedValue(undefined);
    mockClearClusterAssignments.mockResolvedValue(undefined);
    mockCountClusterAssignments.mockResolvedValue(0);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sonicClusteringTask — HTTP sidecar path', () => {
    test('calls POST /cluster with {k} and upserts assignments on success', async () => {
        const rows = [
            { media_id: 'aaaa-1111', cluster_id: 0 },
            { media_id: 'bbbb-2222', cluster_id: 1 },
            { media_id: 'cccc-3333', cluster_id: 0 },
        ];
        mockFetch.mockResolvedValueOnce(mockResponse(buildNdjson(rows)));
        mockCountClusterAssignments.mockResolvedValue(rows.length);

        vi.resetModules();
        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        const result = await sonicClusteringTask.execute(
            makeCtx() as unknown as Parameters<typeof sonicClusteringTask.execute>[0],
        );

        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(3);

        // fetch was used, not execFile
        expect(mockFetch).toHaveBeenCalledOnce();
        expect(mockExecFileAsync).not.toHaveBeenCalled();

        const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('http://sonic-embedder:8000/cluster');
        expect(init.method).toBe('POST');
        const body = JSON.parse(init.body as string) as { k: number };
        expect(body.k).toBe(12); // from SONIC_CLUSTER_K

        // DB writes happened
        expect(mockClearClusterAssignments).toHaveBeenCalledOnce();
        expect(mockUpsertClusterAssignments).toHaveBeenCalled();
    });

    test('returns no-op when sidecar returns empty NDJSON', async () => {
        mockFetch.mockResolvedValueOnce(mockResponse(''));

        vi.resetModules();
        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        const result = await sonicClusteringTask.execute(
            makeCtx() as unknown as Parameters<typeof sonicClusteringTask.execute>[0],
        );

        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
        expect(mockClearClusterAssignments).not.toHaveBeenCalled();
        expect(mockUpsertClusterAssignments).not.toHaveBeenCalled();
    });

    test('throws a transient TaskError when sidecar returns HTTP 503', async () => {
        mockFetch.mockResolvedValue(mockResponse('{"detail":"loading"}', 503));

        vi.resetModules();
        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        const ctx = makeCtx() as unknown as Parameters<typeof sonicClusteringTask.execute>[0];

        // A normal `return {success:false}` here used to be silently recorded
        // 'completed' by the runner — must throw so a sick sidecar is visible.
        await expect(sonicClusteringTask.execute(ctx)).rejects.toMatchObject({
            kind: 'transient',
        });
        expect(mockClearClusterAssignments).not.toHaveBeenCalled();
    });

    test('throws a transient TaskError when fetch throws (network error)', async () => {
        mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

        vi.resetModules();
        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        const ctx = makeCtx() as unknown as Parameters<typeof sonicClusteringTask.execute>[0];

        await expect(sonicClusteringTask.execute(ctx)).rejects.toMatchObject({
            kind: 'transient',
        });
    });

    test('tolerates and counts malformed JSONL lines', async () => {
        const validRow = { media_id: 'valid-uuid', cluster_id: 5 };
        const ndjson =
            'NOT_JSON\n' +
            JSON.stringify({ media_id: 'missing-cluster-id' }) +
            '\n' +
            JSON.stringify(validRow) +
            '\n';
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));

        vi.resetModules();
        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        const result = await sonicClusteringTask.execute(
            makeCtx() as unknown as Parameters<typeof sonicClusteringTask.execute>[0],
        );

        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(1);
        const r = result.result as { assigned: number; parseErrors: number; clusters: number };
        expect(r.parseErrors).toBe(2);
        expect(r.assigned).toBe(1);
    });

    test('Bug 3: passes an abort signal derived from ctx.signal to fetch', async () => {
        mockFetch.mockResolvedValueOnce(mockResponse(''));
        const ac = new AbortController();

        vi.resetModules();
        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        await sonicClusteringTask.execute(
            makeCtx({ signal: ac.signal }) as unknown as Parameters<
                typeof sonicClusteringTask.execute
            >[0],
        );

        expect(mockFetch).toHaveBeenCalledOnce();
        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(init.signal).toBeInstanceOf(AbortSignal);

        // Aborting ctx.signal must abort the combined signal fetch received —
        // proves ctx.signal actually participates (AbortSignal.any), not just
        // the sidecar's own fixed timeout.
        ac.abort();
        expect((init.signal as AbortSignal).aborted).toBe(true);
    });

    test('counts distinct clusters in result', async () => {
        const rows = [
            { media_id: 'a', cluster_id: 0 },
            { media_id: 'b', cluster_id: 1 },
            { media_id: 'c', cluster_id: 2 },
            { media_id: 'd', cluster_id: 0 },
        ];
        mockFetch.mockResolvedValueOnce(mockResponse(buildNdjson(rows)));

        vi.resetModules();
        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        const result = await sonicClusteringTask.execute(
            makeCtx() as unknown as Parameters<typeof sonicClusteringTask.execute>[0],
        );

        expect(result.success).toBe(true);
        const r = result.result as { assigned: number; clusters: number; parseErrors: number };
        expect(r.clusters).toBe(3); // distinct cluster IDs: 0, 1, 2
        expect(r.assigned).toBe(4);
    });
});

describe('sonicClusteringTask — subprocess fallback (SONIC_EMBEDDER_URL empty)', () => {
    test('calls execFile and NOT fetch when URL is empty', async () => {
        mockConfig.SONIC_EMBEDDER_URL = '';
        const rows = [
            { media_id: 'id-1', cluster_id: 0 },
            { media_id: 'id-2', cluster_id: 1 },
        ];
        mockExecFileAsync.mockResolvedValueOnce({ stdout: buildNdjson(rows), stderr: '' });
        mockCountClusterAssignments.mockResolvedValue(2);

        vi.resetModules();
        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        const result = await sonicClusteringTask.execute(
            makeCtx() as unknown as Parameters<typeof sonicClusteringTask.execute>[0],
        );

        expect(mockFetch).not.toHaveBeenCalled();
        expect(mockExecFileAsync).toHaveBeenCalledOnce();
        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(2);
    });

    test('passes DATABASE_URL, MODEL_ID, and SONIC_CLUSTER_K to subprocess env', async () => {
        mockConfig.SONIC_EMBEDDER_URL = '';
        mockExecFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });

        vi.resetModules();
        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        await sonicClusteringTask.execute(
            makeCtx() as unknown as Parameters<typeof sonicClusteringTask.execute>[0],
        );

        const [_bin, _args, opts] = mockExecFileAsync.mock.calls[0] as [
            string,
            string[],
            { env: Record<string, string> },
        ];
        expect(opts.env.DATABASE_URL).toBe('postgres://test');
        expect(opts.env.MODEL_ID).toBe('msclap-2023');
        expect(opts.env.SONIC_CLUSTER_K).toBe('12');
    });
});

describe('sonicClusteringTask — feature gate and validation', () => {
    test('is a no-op when musicClusters feature is off', async () => {
        mockFeatures.musicClusters = false;

        vi.resetModules();
        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        const result = await sonicClusteringTask.execute(
            makeCtx() as unknown as Parameters<typeof sonicClusteringTask.execute>[0],
        );

        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
        expect(mockFetch).not.toHaveBeenCalled();
        expect(mockExecFileAsync).not.toHaveBeenCalled();
    });

    test('throws a permanent TaskError when DATABASE_URL is empty', async () => {
        mockConfig.DATABASE_URL = '';

        vi.resetModules();
        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        const ctx = makeCtx() as unknown as Parameters<typeof sonicClusteringTask.execute>[0];

        await expect(sonicClusteringTask.execute(ctx)).rejects.toMatchObject({
            kind: 'permanent',
        });
        expect(mockFetch).not.toHaveBeenCalled();
        expect(mockExecFileAsync).not.toHaveBeenCalled();
    });
});
