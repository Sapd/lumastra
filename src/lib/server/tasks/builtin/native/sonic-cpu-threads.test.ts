// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests verifying that the cpuThreads setting flows correctly through the
 * three CPU-heavy sonic tasks and through the embedBatch subprocess fallback.
 *
 * Covers:
 *   sonic-embedding-backfill:
 *     - cpuThreads set and valid → /embed body has threads
 *     - cpuThreads unset         → /embed body has no threads key
 *     - cpuThreads = 0           → omitted (sidecar uses default)
 *     - subprocess: SONIC_EMBEDDER_THREADS + OMP_NUM_THREADS set when cpuThreads = 6
 *     - subprocess: not set when cpuThreads is absent
 *
 *   sonic-map-projection:
 *     - cpuThreads set   → /project-map body includes threads
 *     - cpuThreads unset → /project-map body has no threads key
 *     - subprocess: SONIC_EMBEDDER_THREADS + OMP_NUM_THREADS set when cpuThreads = 3
 *     - subprocess: not set when cpuThreads is absent
 *
 *   sonic-clustering:
 *     - cpuThreads set   → /cluster body includes threads alongside k
 *     - cpuThreads unset → /cluster body has only k
 *     - subprocess: SONIC_EMBEDDER_THREADS + OMP_NUM_THREADS set when cpuThreads = 5
 *     - subprocess: not set when cpuThreads is absent
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Hoisted mock state (shared across describe blocks via vi.hoisted)
// ---------------------------------------------------------------------------

const mockExecFileAsync = vi.fn();
const mockFetch = vi.fn();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockResponse(body: string, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(body),
    } as unknown as Response;
}

/** Build a ctx whose settings() resolves to the given record. */
function makeCtxWithSettings(
    settings: Record<string, unknown>,
    sqlOverrides?: (fn: ReturnType<typeof vi.fn>) => void,
): Record<string, unknown> {
    const ac = new AbortController();
    const mockSql = vi.fn().mockResolvedValue(undefined) as unknown as ReturnType<typeof vi.fn> & {
        begin: ReturnType<typeof vi.fn>;
    };
    // sql.begin(cb) — sonic-clustering/sonic-map-projection wrap clear+upsert
    // in a transaction (Bug 4). The fake just invokes the callback with the
    // same fake sql standing in for the transaction handle.
    mockSql.begin = vi.fn((cb: (tx: unknown) => Promise<unknown>) => cb(mockSql));
    if (sqlOverrides) sqlOverrides(mockSql);
    return {
        sql: mockSql,
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
        settings: vi.fn().mockResolvedValue(settings),
    };
}

/** 1024-float fake embedding. */
function fakeEmbedding(): number[] {
    return Array.from({ length: 1024 }, (_, i) => i * 0.001);
}

/**
 * `sql` fake for sonic-embedding-backfill, routed by QUERY TEXT rather than by
 * call order.
 *
 * These tests originally queued results positionally (`mockResolvedValueOnce`
 * chained in the order the task happened to query). That went stale the moment
 * `getActiveProjectionBasis` was added ahead of the drain loop: the basis SELECT
 * silently ate the slot reserved for `fetchPendingTracks`, so a track row was
 * handed to `bufferToBasis` as if it were a basis row. Routing on the table name
 * keeps the fake correct the next time a query is inserted.
 */
function routeBackfillSql(
    tracks: Array<{ media_item_id: string; file_path: string }>,
): (sql: ReturnType<typeof vi.fn>) => void {
    return (sql) => {
        let pendingServed = false;
        sql.mockImplementation((strings: unknown) => {
            const text = Array.isArray(strings) ? strings.join(' ') : String(strings);
            // No fit has run → no basis row. The task degrades to a null
            // projected_vector, which is the default state on a fresh install.
            if (text.includes('music_embedding_projection_basis')) return Promise.resolve([]);
            if (text.includes('FROM media_file_items')) {
                // Round 1 yields the tracks; round 2 drains empty so the loop exits.
                const rows = pendingServed ? [] : tracks;
                pendingServed = true;
                return Promise.resolve(rows);
            }
            return Promise.resolve(undefined); // upsertEmbedding / upsertState
        });
    };
}

// ---------------------------------------------------------------------------
// Common mocks factory (reset per describe/test)
// ---------------------------------------------------------------------------

function registerBackfillMocks(url: string): void {
    vi.doMock('node:child_process', () => ({ execFile: vi.fn(), execFileSync: vi.fn() }));
    vi.doMock('node:util', () => ({ promisify: () => mockExecFileAsync }));
    vi.doMock('$lib/server/config.js', () => ({
        features: { sonicEmbeddings: true },
        config: {
            SONIC_EMBEDDER_URL: url,
            // Real files, so the subprocess fallback counts as installed
            // (isSonicEngineConfigured probes them); execFile itself is mocked.
            SONIC_EMBEDDER_PYTHON: process.execPath,
            SONIC_EMBEDDER_SCRIPT: fileURLToPath(import.meta.url),
            SONIC_EMBEDDER_TEXT_SCRIPT: 'embed_text.py',
            SONIC_EMBEDDER_BATCH_SIZE: 1, // 1 track per batch → simpler mock
        },
    }));
    vi.doMock('$lib/server/tasks/registry.js', () => ({
        registry: { registerTask: vi.fn() },
    }));
    vi.doMock('$lib/server/utils/logger.js', () => ({
        Logger: { for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
    }));
    vi.doMock('$lib/server/cache/valkey.js', () => ({
        cacheGet: vi.fn().mockResolvedValue(null),
        cacheSet: vi.fn().mockResolvedValue(true),
    }));
}

function registerMapMocks(url: string): void {
    vi.doMock('node:child_process', () => ({ execFile: vi.fn(), execFileSync: vi.fn() }));
    vi.doMock('node:util', () => ({ promisify: () => mockExecFileAsync }));
    vi.doMock('$lib/server/config.js', () => ({
        features: { musicMap: true },
        config: {
            SONIC_EMBEDDER_URL: url,
            SONIC_EMBEDDER_PYTHON: 'python3',
            SONIC_MAP_PROJECTION_SCRIPT: 'project_map.py',
            DATABASE_URL: 'postgres://test',
        },
    }));
    vi.doMock('$lib/server/tasks/registry.js', () => ({
        registry: { registerTask: vi.fn() },
    }));
    vi.doMock('$lib/server/database/queries/music-map.queries.js', () => ({
        upsertMapCoords: vi.fn().mockResolvedValue(undefined),
        clearMapCoords: vi.fn().mockResolvedValue(undefined),
        countMapCoords: vi.fn().mockResolvedValue(0),
    }));
    vi.doMock('$lib/server/utils/logger.js', () => ({
        Logger: { for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
    }));
}

function registerClusterMocks(url: string): void {
    vi.doMock('node:child_process', () => ({ execFile: vi.fn(), execFileSync: vi.fn() }));
    vi.doMock('node:util', () => ({ promisify: () => mockExecFileAsync }));
    vi.doMock('$lib/server/config.js', () => ({
        features: { musicClusters: true },
        config: {
            SONIC_EMBEDDER_URL: url,
            SONIC_EMBEDDER_PYTHON: 'python3',
            SONIC_CLUSTER_SCRIPT: 'cluster.py',
            SONIC_CLUSTER_K: 12,
            DATABASE_URL: 'postgres://test',
        },
    }));
    vi.doMock('$lib/server/tasks/registry.js', () => ({
        registry: { registerTask: vi.fn() },
    }));
    vi.doMock('$lib/server/database/queries/audio-clusters.queries.js', () => ({
        CLUSTER_MODEL_ID: 'msclap-2023',
        upsertClusterAssignments: vi.fn().mockResolvedValue(undefined),
        clearClusterAssignments: vi.fn().mockResolvedValue(undefined),
        countClusterAssignments: vi.fn().mockResolvedValue(0),
        getClusterAssignmentMap: vi.fn().mockResolvedValue(new Map()),
        getHighestIssuedClusterId: vi.fn().mockResolvedValue(-1),
        recordIssuedClusterIds: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('$lib/server/utils/logger.js', () => ({
        Logger: { for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
    }));
}

// ===========================================================================
// sonic-embedding-backfill — cpuThreads → sidecar
// ===========================================================================

describe('sonic-embedding-backfill — cpuThreads via sidecar', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('sends threads in /embed body when cpuThreads = 4', async () => {
        const track = { media_item_id: 'uuid-a', file_path: '/a.flac' };
        const ndjson = JSON.stringify({ path: '/a.flac', embedding: fakeEmbedding() }) + '\n';
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));
        vi.stubGlobal('fetch', mockFetch);

        registerBackfillMocks('http://sonic:8000');
        vi.resetModules();

        const { sonicEmbeddingBackfillTask } = await import('./sonic-embedding-backfill.js');
        const ctx = makeCtxWithSettings({ cpuThreads: 4 }, routeBackfillSql([track]));

        await sonicEmbeddingBackfillTask.execute(
            ctx as unknown as Parameters<typeof sonicEmbeddingBackfillTask.execute>[0],
        );

        expect(mockFetch).toHaveBeenCalledOnce();
        const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('http://sonic:8000/embed');
        const body = JSON.parse(init.body as string) as { paths: string[]; threads?: number };
        expect(body.threads).toBe(4);
    });

    test('omits threads from /embed body when cpuThreads is absent', async () => {
        const track = { media_item_id: 'uuid-a', file_path: '/a.flac' };
        const ndjson = JSON.stringify({ path: '/a.flac', embedding: fakeEmbedding() }) + '\n';
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));
        vi.stubGlobal('fetch', mockFetch);

        registerBackfillMocks('http://sonic:8000');
        vi.resetModules();

        const { sonicEmbeddingBackfillTask } = await import('./sonic-embedding-backfill.js');
        const ctx = makeCtxWithSettings({}, routeBackfillSql([track]));

        await sonicEmbeddingBackfillTask.execute(
            ctx as unknown as Parameters<typeof sonicEmbeddingBackfillTask.execute>[0],
        );

        expect(mockFetch).toHaveBeenCalledOnce();
        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(init.body as string) as { threads?: number };
        expect(body.threads).toBeUndefined();
    });

    test('omits threads from /embed body when cpuThreads = 0', async () => {
        const track = { media_item_id: 'uuid-a', file_path: '/a.flac' };
        const ndjson = JSON.stringify({ path: '/a.flac', embedding: fakeEmbedding() }) + '\n';
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));
        vi.stubGlobal('fetch', mockFetch);

        registerBackfillMocks('http://sonic:8000');
        vi.resetModules();

        const { sonicEmbeddingBackfillTask } = await import('./sonic-embedding-backfill.js');
        const ctx = makeCtxWithSettings({ cpuThreads: 0 }, routeBackfillSql([track]));

        await sonicEmbeddingBackfillTask.execute(
            ctx as unknown as Parameters<typeof sonicEmbeddingBackfillTask.execute>[0],
        );

        expect(mockFetch).toHaveBeenCalledOnce();
        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(init.body as string) as { threads?: number };
        expect(body.threads).toBeUndefined();
    });
});

// ===========================================================================
// sonic-embedding-backfill — cpuThreads → subprocess fallback
// ===========================================================================

describe('sonic-embedding-backfill — cpuThreads via subprocess fallback', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('sets SONIC_EMBEDDER_THREADS and OMP_NUM_THREADS when cpuThreads = 6', async () => {
        const track = { media_item_id: 'uuid-a', file_path: '/a.flac' };
        const ndjson = JSON.stringify({ path: '/a.flac', embedding: fakeEmbedding() }) + '\n';
        mockExecFileAsync.mockResolvedValueOnce({ stdout: ndjson, stderr: '' });
        vi.stubGlobal('fetch', mockFetch);

        registerBackfillMocks(''); // no sidecar URL → subprocess path
        vi.resetModules();

        const { sonicEmbeddingBackfillTask } = await import('./sonic-embedding-backfill.js');
        const ctx = makeCtxWithSettings({ cpuThreads: 6 }, routeBackfillSql([track]));

        await sonicEmbeddingBackfillTask.execute(
            ctx as unknown as Parameters<typeof sonicEmbeddingBackfillTask.execute>[0],
        );

        expect(mockFetch).not.toHaveBeenCalled();
        expect(mockExecFileAsync).toHaveBeenCalledOnce();
        const [, , opts] = mockExecFileAsync.mock.calls[0] as [
            string,
            string[],
            { env: Record<string, string> },
        ];
        expect(opts.env.SONIC_EMBEDDER_THREADS).toBe('6');
        expect(opts.env.OMP_NUM_THREADS).toBe('6');
    });

    test('does not override SONIC_EMBEDDER_THREADS in subprocess env when cpuThreads is absent', async () => {
        const track = { media_item_id: 'uuid-a', file_path: '/a.flac' };
        const ndjson = JSON.stringify({ path: '/a.flac', embedding: fakeEmbedding() }) + '\n';
        mockExecFileAsync.mockResolvedValueOnce({ stdout: ndjson, stderr: '' });
        vi.stubGlobal('fetch', mockFetch);

        registerBackfillMocks('');
        vi.resetModules();

        const { sonicEmbeddingBackfillTask } = await import('./sonic-embedding-backfill.js');
        const ctx = makeCtxWithSettings({}, routeBackfillSql([track]));

        await sonicEmbeddingBackfillTask.execute(
            ctx as unknown as Parameters<typeof sonicEmbeddingBackfillTask.execute>[0],
        );

        expect(mockExecFileAsync).toHaveBeenCalledOnce();
        const [, , opts] = mockExecFileAsync.mock.calls[0] as [
            string,
            string[],
            { env: Record<string, string> },
        ];
        // Task must not have injected a NEW numeric override for SONIC_EMBEDDER_THREADS.
        // The env is a copy of process.env; if the key was absent in process.env, it stays absent.
        const envVal = opts.env.SONIC_EMBEDDER_THREADS;
        const processVal = process.env.SONIC_EMBEDDER_THREADS;
        if (processVal === undefined) {
            expect(envVal).toBeUndefined();
        } else {
            expect(envVal).toBe(processVal); // not changed by the task
        }
    });
});

// ===========================================================================
// sonic-map-projection — cpuThreads → sidecar
// ===========================================================================

describe('sonic-map-projection — cpuThreads via sidecar', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('sends threads in /project-map body when cpuThreads = 8', async () => {
        const ndjson = JSON.stringify({ media_id: 'uuid-1', x: 0.1, y: 0.2 }) + '\n';
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));
        vi.stubGlobal('fetch', mockFetch);

        registerMapMocks('http://sonic:8000');
        vi.resetModules();

        const { sonicMapProjectionTask } = await import('./sonic-map-projection.js');
        const ctx = makeCtxWithSettings({ cpuThreads: 8 });

        await sonicMapProjectionTask.execute(
            ctx as unknown as Parameters<typeof sonicMapProjectionTask.execute>[0],
        );

        expect(mockFetch).toHaveBeenCalledOnce();
        const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('http://sonic:8000/project-map');
        const body = JSON.parse(init.body as string) as { threads?: number };
        expect(body.threads).toBe(8);
    });

    test('omits threads from /project-map body when cpuThreads is absent', async () => {
        const ndjson = JSON.stringify({ media_id: 'uuid-1', x: 0.1, y: 0.2 }) + '\n';
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));
        vi.stubGlobal('fetch', mockFetch);

        registerMapMocks('http://sonic:8000');
        vi.resetModules();

        const { sonicMapProjectionTask } = await import('./sonic-map-projection.js');
        const ctx = makeCtxWithSettings({});

        await sonicMapProjectionTask.execute(
            ctx as unknown as Parameters<typeof sonicMapProjectionTask.execute>[0],
        );

        expect(mockFetch).toHaveBeenCalledOnce();
        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(init.body as string) as { threads?: number };
        expect(body.threads).toBeUndefined();
    });
});

// ===========================================================================
// sonic-map-projection — cpuThreads → subprocess fallback
// ===========================================================================

describe('sonic-map-projection — cpuThreads via subprocess fallback', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('sets SONIC_EMBEDDER_THREADS and OMP_NUM_THREADS when cpuThreads = 3', async () => {
        const ndjson = JSON.stringify({ media_id: 'uuid-1', x: 0.5, y: 0.5 }) + '\n';
        mockExecFileAsync.mockResolvedValueOnce({ stdout: ndjson, stderr: '' });
        vi.stubGlobal('fetch', mockFetch);

        registerMapMocks('');
        vi.resetModules();

        const { sonicMapProjectionTask } = await import('./sonic-map-projection.js');
        const ctx = makeCtxWithSettings({ cpuThreads: 3 });

        await sonicMapProjectionTask.execute(
            ctx as unknown as Parameters<typeof sonicMapProjectionTask.execute>[0],
        );

        expect(mockFetch).not.toHaveBeenCalled();
        expect(mockExecFileAsync).toHaveBeenCalledOnce();
        const [, , opts] = mockExecFileAsync.mock.calls[0] as [
            string,
            string[],
            { env: Record<string, string> },
        ];
        expect(opts.env.SONIC_EMBEDDER_THREADS).toBe('3');
        expect(opts.env.OMP_NUM_THREADS).toBe('3');
    });

    test('does not override SONIC_EMBEDDER_THREADS in subprocess env when cpuThreads is absent', async () => {
        mockExecFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });
        vi.stubGlobal('fetch', mockFetch);

        registerMapMocks('');
        vi.resetModules();

        const { sonicMapProjectionTask } = await import('./sonic-map-projection.js');
        const ctx = makeCtxWithSettings({});

        await sonicMapProjectionTask.execute(
            ctx as unknown as Parameters<typeof sonicMapProjectionTask.execute>[0],
        );

        expect(mockExecFileAsync).toHaveBeenCalledOnce();
        const [, , opts] = mockExecFileAsync.mock.calls[0] as [
            string,
            string[],
            { env: Record<string, string> },
        ];
        const envVal = opts.env.SONIC_EMBEDDER_THREADS;
        const processVal = process.env.SONIC_EMBEDDER_THREADS;
        if (processVal === undefined) {
            expect(envVal).toBeUndefined();
        } else {
            expect(envVal).toBe(processVal);
        }
    });
});

// ===========================================================================
// sonic-clustering — cpuThreads → sidecar
// ===========================================================================

describe('sonic-clustering — cpuThreads via sidecar', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('sends threads alongside k in /cluster body when cpuThreads = 2', async () => {
        const ndjson = JSON.stringify({ media_id: 'uuid-1', cluster_id: 0 }) + '\n';
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));
        vi.stubGlobal('fetch', mockFetch);

        registerClusterMocks('http://sonic:8000');
        vi.resetModules();

        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        const ctx = makeCtxWithSettings({ cpuThreads: 2 });

        await sonicClusteringTask.execute(
            ctx as unknown as Parameters<typeof sonicClusteringTask.execute>[0],
        );

        expect(mockFetch).toHaveBeenCalledOnce();
        const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('http://sonic:8000/cluster');
        const body = JSON.parse(init.body as string) as { k: number; threads?: number };
        expect(body.k).toBe(12);
        expect(body.threads).toBe(2);
    });

    test('omits threads from /cluster body when cpuThreads is absent', async () => {
        const ndjson = JSON.stringify({ media_id: 'uuid-1', cluster_id: 0 }) + '\n';
        mockFetch.mockResolvedValueOnce(mockResponse(ndjson));
        vi.stubGlobal('fetch', mockFetch);

        registerClusterMocks('http://sonic:8000');
        vi.resetModules();

        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        const ctx = makeCtxWithSettings({});

        await sonicClusteringTask.execute(
            ctx as unknown as Parameters<typeof sonicClusteringTask.execute>[0],
        );

        expect(mockFetch).toHaveBeenCalledOnce();
        const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(init.body as string) as { k: number; threads?: number };
        expect(body.k).toBe(12);
        expect(body.threads).toBeUndefined();
    });
});

// ===========================================================================
// sonic-clustering — cpuThreads → subprocess fallback
// ===========================================================================

describe('sonic-clustering — cpuThreads via subprocess fallback', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('sets SONIC_EMBEDDER_THREADS and OMP_NUM_THREADS when cpuThreads = 5', async () => {
        mockExecFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });
        vi.stubGlobal('fetch', mockFetch);

        registerClusterMocks('');
        vi.resetModules();

        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        const ctx = makeCtxWithSettings({ cpuThreads: 5 });

        await sonicClusteringTask.execute(
            ctx as unknown as Parameters<typeof sonicClusteringTask.execute>[0],
        );

        expect(mockFetch).not.toHaveBeenCalled();
        expect(mockExecFileAsync).toHaveBeenCalledOnce();
        const [, , opts] = mockExecFileAsync.mock.calls[0] as [
            string,
            string[],
            { env: Record<string, string> },
        ];
        expect(opts.env.SONIC_EMBEDDER_THREADS).toBe('5');
        expect(opts.env.OMP_NUM_THREADS).toBe('5');
        // Existing env vars preserved
        expect(opts.env.SONIC_CLUSTER_K).toBe('12');
    });

    test('does not override SONIC_EMBEDDER_THREADS in subprocess env when cpuThreads is absent', async () => {
        mockExecFileAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });
        vi.stubGlobal('fetch', mockFetch);

        registerClusterMocks('');
        vi.resetModules();

        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        const ctx = makeCtxWithSettings({});

        await sonicClusteringTask.execute(
            ctx as unknown as Parameters<typeof sonicClusteringTask.execute>[0],
        );

        expect(mockExecFileAsync).toHaveBeenCalledOnce();
        const [, , opts] = mockExecFileAsync.mock.calls[0] as [
            string,
            string[],
            { env: Record<string, string> },
        ];
        const envVal = opts.env.SONIC_EMBEDDER_THREADS;
        const processVal = process.env.SONIC_EMBEDDER_THREADS;
        if (processVal === undefined) {
            expect(envVal).toBeUndefined();
        } else {
            expect(envVal).toBe(processVal);
        }
    });
});
