// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the sonic-clustering task.
 *
 * All tests mock the Python spawn (execFile via promisify) and the
 * audio-clusters query module so no real database or Python process is needed.
 *
 * Covers:
 *   - Feature-gate no-op when musicClusters is false
 *   - Missing DATABASE_URL early return
 *   - Empty Python output (no embeddings yet)
 *   - Successful clustering: parse → clear → upsert batches
 *   - Parse-error tolerance
 *   - Python subprocess failure
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockExecFileAsync = vi.fn();

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:util', () => ({ promisify: () => mockExecFileAsync }));

// Config mock — exposes both features and config objects.
const mockFeatures = vi.hoisted(() => ({ musicClusters: true }));
const mockConfig = vi.hoisted(() => ({
    DATABASE_URL: 'postgres://test',
    SONIC_EMBEDDER_PYTHON: 'python3',
    SONIC_CLUSTER_SCRIPT: 'workers/sonic-embedder/cluster.py',
    SONIC_CLUSTER_K: 12,
}));

vi.mock('$lib/server/config.js', () => ({
    features: mockFeatures,
    config: mockConfig,
}));

// Registry mock — suppresses side-effect registerTask call.
vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { registerTask: vi.fn() },
}));

const mockWarm = vi.fn();
const mockGetClusters = vi.fn().mockResolvedValue([{ cover_media_ids: ['cover-a', 'cover-b'] }]);
vi.mock('$lib/server/services/music/collage-warmup.js', () => ({ warmMusicCollages: mockWarm }));

// Audio-clusters query mock.
const mockUpsertClusterAssignments = vi.fn().mockResolvedValue(undefined);
const mockClearClusterAssignments = vi.fn().mockResolvedValue(undefined);
const mockCountClusterAssignments = vi.fn().mockResolvedValue(0);

vi.mock('$lib/server/database/queries/audio-clusters.queries.js', () => ({
    CLUSTER_MODEL_ID: 'msclap-2023',
    getClusters: mockGetClusters,
    upsertClusterAssignments: mockUpsertClusterAssignments,
    clearClusterAssignments: mockClearClusterAssignments,
    countClusterAssignments: mockCountClusterAssignments,
    getClusterAssignmentMap: vi.fn().mockResolvedValue(new Map()),
    getHighestIssuedClusterId: vi.fn().mockResolvedValue(-1),
    recordIssuedClusterIds: vi.fn().mockResolvedValue(undefined),
}));

// Logger mock.
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

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a fake task context similar to what the task runner provides. */
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
        settings: vi.fn().mockResolvedValue({}),
        ...overrides,
    };
}

/** Build a JSONL string from an array of assignment objects. */
function buildJsonl(rows: Array<{ media_id: string; cluster_id: number }>): string {
    return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
    vi.clearAllMocks();
    mockFeatures.musicClusters = true;
    mockConfig.DATABASE_URL = 'postgres://test';
    mockUpsertClusterAssignments.mockResolvedValue(undefined);
    mockClearClusterAssignments.mockResolvedValue(undefined);
    mockCountClusterAssignments.mockResolvedValue(0);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sonic-clustering task', () => {
    test('is a no-op when musicClusters feature is off', async () => {
        mockFeatures.musicClusters = false;

        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        const result = await sonicClusteringTask.execute(
            makeCtx() as unknown as Parameters<typeof sonicClusteringTask.execute>[0],
        );

        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
        expect(mockExecFileAsync).not.toHaveBeenCalled();
        expect(mockClearClusterAssignments).not.toHaveBeenCalled();
    });

    test('throws a permanent TaskError when DATABASE_URL is empty', async () => {
        mockConfig.DATABASE_URL = '';

        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        const ctx = makeCtx() as unknown as Parameters<typeof sonicClusteringTask.execute>[0];

        // A config problem is not worth retrying — must be `kind: 'permanent'`
        // and, critically, MUST throw rather than return {success:false} (a
        // plain return is invisible to the runner and records 'completed').
        await expect(sonicClusteringTask.execute(ctx)).rejects.toMatchObject({
            kind: 'permanent',
        });
        expect(mockExecFileAsync).not.toHaveBeenCalled();
    });

    test('returns success with zero assignments when Python output is empty', async () => {
        mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        const result = await sonicClusteringTask.execute(
            makeCtx() as unknown as Parameters<typeof sonicClusteringTask.execute>[0],
        );

        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
        // No DB writes when output is empty
        expect(mockClearClusterAssignments).not.toHaveBeenCalled();
        expect(mockUpsertClusterAssignments).not.toHaveBeenCalled();
    });

    test('returns success and upserts assignments on clean run', async () => {
        const rows = [
            { media_id: 'aaaa-1111', cluster_id: 0 },
            { media_id: 'bbbb-2222', cluster_id: 1 },
            { media_id: 'cccc-3333', cluster_id: 0 },
        ];
        mockExecFileAsync.mockResolvedValue({ stdout: buildJsonl(rows), stderr: '' });
        mockCountClusterAssignments.mockResolvedValue(rows.length);

        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        const result = await sonicClusteringTask.execute(
            makeCtx() as unknown as Parameters<typeof sonicClusteringTask.execute>[0],
        );

        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(3);
        expect(mockWarm).toHaveBeenCalledOnce();
        const loadCovers = mockWarm.mock.calls[0][1] as () => Promise<string[][]>;
        expect(await loadCovers()).toEqual([['cover-a', 'cover-b']]);
        expect(mockWarm.mock.invocationCallOrder[0]).toBeGreaterThan(
            mockUpsertClusterAssignments.mock.invocationCallOrder[0],
        );

        // Should clear old assignments first
        expect(mockClearClusterAssignments).toHaveBeenCalledOnce();
        expect(mockClearClusterAssignments).toHaveBeenCalledWith(expect.anything(), 'msclap-2023');

        // Should upsert all assignments
        expect(mockUpsertClusterAssignments).toHaveBeenCalled();
        const allCalls = mockUpsertClusterAssignments.mock.calls;
        const allAssigned = allCalls.flatMap(
            (call: unknown[]) => call[2] as Array<{ mediaId: string; clusterId: number }>,
        );
        expect(allAssigned).toHaveLength(3);
        expect(allAssigned.find((a) => a.mediaId === 'aaaa-1111')?.clusterId).toBe(0);
        expect(allAssigned.find((a) => a.mediaId === 'bbbb-2222')?.clusterId).toBe(1);
    });

    test("stores the PREVIOUS run's ids, not the raw KMeans index", async () => {
        // Same partition as last time, but KMeans numbered it the other way
        // round — a device that saved "cluster 7" must still get this sound.
        const { getClusterAssignmentMap, getHighestIssuedClusterId, recordIssuedClusterIds } =
            await import('$lib/server/database/queries/audio-clusters.queries.js');
        vi.mocked(getClusterAssignmentMap).mockResolvedValueOnce(
            new Map([
                ['a', 7],
                ['b', 7],
                ['c', 2],
            ]),
        );
        vi.mocked(getHighestIssuedClusterId).mockResolvedValueOnce(9);
        const rows = [
            { media_id: 'a', cluster_id: 0 },
            { media_id: 'b', cluster_id: 0 },
            { media_id: 'c', cluster_id: 1 },
            { media_id: 'new', cluster_id: 2 },
        ];
        mockExecFileAsync.mockResolvedValue({ stdout: buildJsonl(rows), stderr: '' });

        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        const result = await sonicClusteringTask.execute(
            makeCtx() as unknown as Parameters<typeof sonicClusteringTask.execute>[0],
        );

        const stored = mockUpsertClusterAssignments.mock.calls.flatMap(
            (call: unknown[]) => call[2] as Array<{ mediaId: string; clusterId: number }>,
        );
        expect(Object.fromEntries(stored.map((a) => [a.mediaId, a.clusterId]))).toEqual({
            a: 7,
            b: 7,
            c: 2,
            new: 10,
        });
        expect(recordIssuedClusterIds).toHaveBeenCalledWith(expect.anything(), 'msclap-2023', [10]);
        expect(result.result).toMatchObject({ idsKept: 2, idsIssued: 1, idsRetired: 0 });
    });

    test('result contains the number of distinct clusters', async () => {
        const rows = [
            { media_id: 'a', cluster_id: 0 },
            { media_id: 'b', cluster_id: 1 },
            { media_id: 'c', cluster_id: 2 },
            { media_id: 'd', cluster_id: 0 },
        ];
        mockExecFileAsync.mockResolvedValue({ stdout: buildJsonl(rows), stderr: '' });

        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        const result = await sonicClusteringTask.execute(
            makeCtx() as unknown as Parameters<typeof sonicClusteringTask.execute>[0],
        );

        expect(result.success).toBe(true);
        // 3 distinct cluster IDs: 0, 1, 2
        const clusterResult = result.result as {
            assigned: number;
            clusters: number;
            parseErrors: number;
        };
        expect(clusterResult.clusters).toBe(3);
        expect(clusterResult.assigned).toBe(4);
    });

    test('tolerates and counts malformed JSONL lines', async () => {
        const validRow = { media_id: 'valid-uuid', cluster_id: 5 };
        const stdout =
            'NOT_JSON\n' +
            JSON.stringify({ media_id: 'missing-cluster-id' }) +
            '\n' +
            JSON.stringify(validRow) +
            '\n';

        mockExecFileAsync.mockResolvedValue({ stdout, stderr: '' });

        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        const result = await sonicClusteringTask.execute(
            makeCtx() as unknown as Parameters<typeof sonicClusteringTask.execute>[0],
        );

        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(1);

        const clusterResult = result.result as {
            assigned: number;
            parseErrors: number;
            clusters: number;
        };
        expect(clusterResult.parseErrors).toBe(2); // 2 invalid lines
        expect(clusterResult.assigned).toBe(1);
    });

    test('throws a transient TaskError when Python subprocess throws', async () => {
        mockExecFileAsync.mockRejectedValue(new Error('cluster.py exited with code 1'));

        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        const ctx = makeCtx() as unknown as Parameters<typeof sonicClusteringTask.execute>[0];

        // A subprocess crash is worth retrying — must be `kind: 'transient'`
        // and, critically, MUST throw rather than return {success:false} (a
        // plain return is invisible to the runner and records 'completed').
        await expect(sonicClusteringTask.execute(ctx)).rejects.toMatchObject({
            kind: 'transient',
        });
        expect(mockClearClusterAssignments).not.toHaveBeenCalled();
        expect(mockUpsertClusterAssignments).not.toHaveBeenCalled();
    });

    test('passes DATABASE_URL, MODEL_ID, and SONIC_CLUSTER_K to the Python process', async () => {
        mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });

        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        await sonicClusteringTask.execute(
            makeCtx() as unknown as Parameters<typeof sonicClusteringTask.execute>[0],
        );

        expect(mockExecFileAsync).toHaveBeenCalledOnce();
        const [_bin, _args, opts] = mockExecFileAsync.mock.calls[0] as [
            string,
            string[],
            { env: Record<string, string> },
        ];
        expect(opts.env.DATABASE_URL).toBe('postgres://test');
        expect(opts.env.MODEL_ID).toBe('msclap-2023');
        expect(opts.env.SONIC_CLUSTER_K).toBe('12');
    });

    test('task id is "sonic-clustering"', async () => {
        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        expect(sonicClusteringTask.id).toBe('sonic-clustering');
    });

    test('task resourceClass is "analysis"', async () => {
        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        expect(sonicClusteringTask.resourceClass).toBe('analysis');
    });

    test('task runs on a schedule (not manualOnly)', async () => {
        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        expect(sonicClusteringTask.manualOnly).toBeFalsy();
        expect(sonicClusteringTask.schedule).toBeDefined();
        expect(sonicClusteringTask.schedule?.every).toBe('24h');
    });

    test('task quota maxConcurrent is 1', async () => {
        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        expect(sonicClusteringTask.quotas?.maxConcurrent).toBe(1);
    });

    // -------------------------------------------------------------------
    // Bug 3 — ctx.signal (admin Cancel) propagation
    // -------------------------------------------------------------------

    test('returns an aborted result immediately when signal is already aborted', async () => {
        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        const ac = new AbortController();
        ac.abort();
        const ctx = makeCtx({ signal: ac.signal });

        const result = await sonicClusteringTask.execute(
            ctx as unknown as Parameters<typeof sonicClusteringTask.execute>[0],
        );

        expect(result.success).toBe(true);
        expect(result.stopReason).toBe('aborted');
        expect(mockExecFileAsync).not.toHaveBeenCalled();
        expect(mockClearClusterAssignments).not.toHaveBeenCalled();
    });

    test('threads ctx.signal into the subprocess execFile options', async () => {
        mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
        const ac = new AbortController();

        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        await sonicClusteringTask.execute(
            makeCtx({ signal: ac.signal }) as unknown as Parameters<
                typeof sonicClusteringTask.execute
            >[0],
        );

        expect(mockExecFileAsync).toHaveBeenCalledOnce();
        const [, , opts] = mockExecFileAsync.mock.calls[0] as [
            string,
            string[],
            { signal?: AbortSignal },
        ];
        expect(opts.signal).toBe(ac.signal);
    });

    // -------------------------------------------------------------------
    // Bug 4 — clear + upsert wrapped in a single transaction
    // -------------------------------------------------------------------

    test('wraps clear + upsert in a single sql.begin() transaction', async () => {
        const rows = [
            { media_id: 'aaaa-1111', cluster_id: 0 },
            { media_id: 'bbbb-2222', cluster_id: 1 },
        ];
        mockExecFileAsync.mockResolvedValue({ stdout: buildJsonl(rows), stderr: '' });

        const { sonicClusteringTask } = await import('./sonic-clustering.js');
        const ctx = makeCtx();
        const result = await sonicClusteringTask.execute(
            ctx as unknown as Parameters<typeof sonicClusteringTask.execute>[0],
        );

        expect(result.success).toBe(true);
        const fakeSql = ctx.sql as unknown as { begin: ReturnType<typeof vi.fn> };
        expect(fakeSql.begin).toHaveBeenCalledOnce();
        // Both clear and upsert must run — the fake `begin` invokes the
        // callback synchronously with the same fake handle standing in for
        // the transaction, so the calls are still observable on the mocks.
        expect(mockClearClusterAssignments).toHaveBeenCalledOnce();
        expect(mockUpsertClusterAssignments).toHaveBeenCalled();
    });
});
