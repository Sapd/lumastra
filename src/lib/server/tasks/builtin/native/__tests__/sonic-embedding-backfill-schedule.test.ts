// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for sonic-embedding-backfill: schedule + processItems (incremental).
 *
 * Cases covered:
 *
 *   A) Schedule field is declared (every: '2h', no manualOnly).
 *
 *   B) processItems — feature gate OFF:
 *      execute() and processItems() no-op immediately when features.sonicEmbeddings = false.
 *
 *   C) processItems — feature gate ON, new track:
 *      A track item with filePath triggers embedPaths; on success upsertEmbedding +
 *      upsertState('done') are called.
 *
 *   D) processItems — feature gate ON, non-track item filtered out:
 *      Items with mediaType != 'track' do not trigger embedPaths.
 *
 *   E) processItems — feature gate ON, track without filePath filtered out:
 *      A track item with no filePath does not trigger embedPaths.
 *
 *   F) processItems — feature gate ON, embedder failure:
 *      When embedPaths returns an EmbedFailure, upsertState('failed') is called
 *      and upsertEmbedding is NOT called.
 *
 *   G) processItems — feature gate ON, abort signal set before loop:
 *      No embedPaths calls are made when the AbortSignal is already aborted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskError } from '@sapd/lumastra-plugin-sdk';
import { condenseFailureReason, MAX_REASON_LEN } from '$lib/server/utils/failure-reason.js';

// ---------------------------------------------------------------------------
// Shared mock state — all vi.doMock / vi.resetModules patterns used to
// isolate each describe block's feature-flag and embedPaths behaviour.
// ---------------------------------------------------------------------------

/** 1024-float fake embedding. */
function fakeEmbedding(): number[] {
    return Array.from({ length: 1024 }, (_, i) => i * 0.001);
}

/** Build a fake SQL function whose return values can be programmed per-call. */
function makeSql(...returnValues: (unknown[] | undefined)[]): ReturnType<typeof vi.fn> {
    const mockSql = vi.fn();
    for (const val of returnValues) {
        mockSql.mockResolvedValueOnce(val);
    }
    mockSql.mockResolvedValue([]); // catch-all
    return mockSql;
}

/** Build a minimal TaskContext for processItems. */
function makeCtx(opts: {
    sql: ReturnType<typeof vi.fn>;
    aborted?: boolean;
    settingsValue?: Record<string, unknown>;
    reportFailure?: ReturnType<typeof vi.fn>;
}): Record<string, unknown> {
    const ac = new AbortController();
    if (opts.aborted) ac.abort();
    return {
        sql: opts.sql,
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
        reportFailure: opts.reportFailure ?? vi.fn(),
        reportProgress: vi.fn(),
        settings: vi.fn().mockResolvedValue(opts.settingsValue ?? {}),
    };
}

// ---------------------------------------------------------------------------
// A) Schedule declaration
// ---------------------------------------------------------------------------

describe('sonic-embedding-backfill: schedule field', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Minimal mocks needed to import the module.
        vi.doMock('$lib/server/config.js', () => ({
            features: { sonicEmbeddings: true },
            config: {
                SONIC_EMBEDDER_URL: 'http://sonic:8000',
                SONIC_EMBEDDER_PYTHON: 'python3',
                SONIC_EMBEDDER_SCRIPT: 'embed.py',
                SONIC_EMBEDDER_TEXT_SCRIPT: 'embed_text.py',
                SONIC_EMBEDDER_BATCH_SIZE: 16,
            },
        }));
        vi.doMock('$lib/server/tasks/registry.js', () => ({
            registry: { registerTask: vi.fn() },
        }));
        vi.doMock('$lib/server/utils/logger.js', () => ({
            Logger: {
                for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
            },
        }));
        vi.doMock('$lib/server/cache/valkey.js', () => ({
            cacheGet: vi.fn().mockResolvedValue(null),
            cacheSet: vi.fn().mockResolvedValue(true),
        }));
    });

    it('declares schedule.every = "2h" and does NOT set manualOnly', async () => {
        vi.resetModules();
        const { sonicEmbeddingBackfillTask } = await import('../sonic-embedding-backfill.js');

        // Schedule must be present (enables the 2h drain cycle).
        expect(sonicEmbeddingBackfillTask.schedule).toBeDefined();
        expect(sonicEmbeddingBackfillTask.schedule?.every).toBe('2h');

        // manualOnly must NOT be set (or falsy) so the scheduler fires it.
        expect(sonicEmbeddingBackfillTask.manualOnly).toBeFalsy();
    });
});

// ---------------------------------------------------------------------------
// B) processItems — feature gate OFF
// ---------------------------------------------------------------------------

describe('sonic-embedding-backfill: processItems — feature gate OFF', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.doMock('$lib/server/config.js', () => ({
            // sonicEmbeddings = false → processItems must no-op
            features: { sonicEmbeddings: false },
            config: {
                SONIC_EMBEDDER_URL: 'http://sonic:8000',
                SONIC_EMBEDDER_PYTHON: 'python3',
                SONIC_EMBEDDER_SCRIPT: 'embed.py',
                SONIC_EMBEDDER_TEXT_SCRIPT: 'embed_text.py',
                SONIC_EMBEDDER_BATCH_SIZE: 16,
            },
        }));
        vi.doMock('$lib/server/tasks/registry.js', () => ({
            registry: { registerTask: vi.fn() },
        }));
        vi.doMock('$lib/server/utils/logger.js', () => ({
            Logger: {
                for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
            },
        }));
        vi.doMock('$lib/server/cache/valkey.js', () => ({
            cacheGet: vi.fn().mockResolvedValue(null),
            cacheSet: vi.fn().mockResolvedValue(true),
        }));
    });

    it('processItems returns without calling embedPaths when sonicEmbeddings is off', async () => {
        const mockEmbedPaths = vi.fn();
        vi.doMock('$lib/server/services/sonic-embedding.service.js', () => ({
            isSonicEngineConfigured: () => true,
            SonicEngineError: class SonicEngineError extends Error {},
            SonicBusyError: class SonicBusyError extends Error {},
            embedPaths: mockEmbedPaths,
            isEmbedSuccess: vi.fn(),
            SONIC_MODEL_ID: 'msclap-2023',
        }));
        vi.resetModules();

        const { sonicEmbeddingBackfillTask } = await import('../sonic-embedding-backfill.js');
        const sql = makeSql();
        const ctx = makeCtx({ sql });

        await sonicEmbeddingBackfillTask.processItems?.(ctx as never, [
            { id: 'track-1', mediaType: 'track', filePath: '/music/a.flac' },
        ]);

        expect(mockEmbedPaths).not.toHaveBeenCalled();
        expect(sql).not.toHaveBeenCalled();
    });

    it('execute() no-ops when sonicEmbeddings is off', async () => {
        const mockEmbedPaths = vi.fn();
        vi.doMock('$lib/server/services/sonic-embedding.service.js', () => ({
            isSonicEngineConfigured: () => true,
            SonicEngineError: class SonicEngineError extends Error {},
            SonicBusyError: class SonicBusyError extends Error {},
            embedPaths: mockEmbedPaths,
            isEmbedSuccess: vi.fn(),
            SONIC_MODEL_ID: 'msclap-2023',
        }));
        vi.resetModules();

        const { sonicEmbeddingBackfillTask } = await import('../sonic-embedding-backfill.js');
        const sql = makeSql();
        const ctx = makeCtx({ sql });

        const result = await sonicEmbeddingBackfillTask.execute(ctx as never);

        expect(mockEmbedPaths).not.toHaveBeenCalled();
        expect(result.itemsProcessed).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// B2) Feature ON but no embedder configured (no sidecar URL, no subprocess
//     fallback — every Docker install without the sidecar). Running would fail
//     every track and, after MAX_EMBED_ATTEMPTS runs, write the library off.
// ---------------------------------------------------------------------------

describe('sonic-embedding-backfill: feature ON, no embedder configured', () => {
    let mockEmbedPaths: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockEmbedPaths = vi.fn();
        vi.doMock('$lib/server/config.js', () => ({
            features: { sonicEmbeddings: true },
            config: {
                SONIC_EMBEDDER_URL: '',
                SONIC_EMBEDDER_PYTHON: 'python3',
                SONIC_EMBEDDER_SCRIPT: 'embed.py',
                SONIC_EMBEDDER_TEXT_SCRIPT: 'embed_text.py',
                SONIC_EMBEDDER_BATCH_SIZE: 16,
            },
        }));
        vi.doMock('$lib/server/tasks/registry.js', () => ({
            registry: { registerTask: vi.fn() },
        }));
        vi.doMock('$lib/server/utils/logger.js', () => ({
            Logger: {
                for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
            },
        }));
        vi.doMock('$lib/server/cache/valkey.js', () => ({
            cacheGet: vi.fn().mockResolvedValue(null),
            cacheSet: vi.fn().mockResolvedValue(true),
        }));
        vi.doMock('$lib/server/services/sonic-embedding.service.js', () => ({
            isSonicEngineConfigured: () => false,
            SonicEngineError: class SonicEngineError extends Error {},
            SonicBusyError: class SonicBusyError extends Error {},
            embedPaths: mockEmbedPaths,
            isEmbedSuccess: vi.fn(),
            SONIC_MODEL_ID: 'msclap-2023',
        }));
        vi.resetModules();
    });

    it('execute() no-ops: nothing embedded, nothing written', async () => {
        const { sonicEmbeddingBackfillTask } = await import('../sonic-embedding-backfill.js');
        const sql = makeSql();
        const result = await sonicEmbeddingBackfillTask.execute(makeCtx({ sql }) as never);

        expect(result).toMatchObject({ success: true, itemsProcessed: 0 });
        expect(mockEmbedPaths).not.toHaveBeenCalled();
        // No embedding-state writes: a write here is what counts attempts
        // toward the write-off.
        expect(sql).not.toHaveBeenCalled();
    });

    it('processItems() no-ops for a new track', async () => {
        const { sonicEmbeddingBackfillTask } = await import('../sonic-embedding-backfill.js');
        const sql = makeSql();
        await sonicEmbeddingBackfillTask.processItems?.(makeCtx({ sql }) as never, [
            { id: 'track-1', mediaType: 'track', filePath: '/music/a.flac' },
        ]);

        expect(mockEmbedPaths).not.toHaveBeenCalled();
        expect(sql).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// C) processItems — feature ON, new track → embedPaths called, DB writes land
// ---------------------------------------------------------------------------

describe('sonic-embedding-backfill: processItems — feature ON, success path', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.doMock('$lib/server/config.js', () => ({
            features: { sonicEmbeddings: true },
            config: {
                SONIC_EMBEDDER_URL: 'http://sonic:8000',
                SONIC_EMBEDDER_PYTHON: 'python3',
                SONIC_EMBEDDER_SCRIPT: 'embed.py',
                SONIC_EMBEDDER_TEXT_SCRIPT: 'embed_text.py',
                SONIC_EMBEDDER_BATCH_SIZE: 16,
            },
        }));
        vi.doMock('$lib/server/tasks/registry.js', () => ({
            registry: { registerTask: vi.fn() },
        }));
        vi.doMock('$lib/server/utils/logger.js', () => ({
            Logger: {
                for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
            },
        }));
        vi.doMock('$lib/server/cache/valkey.js', () => ({
            cacheGet: vi.fn().mockResolvedValue(null),
            cacheSet: vi.fn().mockResolvedValue(true),
        }));
    });

    it('calls embedPaths and writes upsertEmbedding + upsertState("done") for a new track', async () => {
        const embedding = fakeEmbedding();
        const mockEmbedPaths = vi.fn().mockResolvedValue([{ path: '/music/a.flac', embedding }]);
        const mockIsEmbedSuccess = vi.fn().mockReturnValue(true);

        vi.doMock('$lib/server/services/sonic-embedding.service.js', () => ({
            isSonicEngineConfigured: () => true,
            SonicEngineError: class SonicEngineError extends Error {},
            SonicBusyError: class SonicBusyError extends Error {},
            embedPaths: mockEmbedPaths,
            isEmbedSuccess: mockIsEmbedSuccess,
            SONIC_MODEL_ID: 'msclap-2023',
        }));
        vi.resetModules();

        const { sonicEmbeddingBackfillTask } = await import('../sonic-embedding-backfill.js');

        // sql: first call upsertEmbedding, second upsertState
        const sql = makeSql([], undefined, undefined);
        const ctx = makeCtx({ sql });

        await sonicEmbeddingBackfillTask.processItems?.(ctx as never, [
            { id: 'track-uuid-1', mediaType: 'track', filePath: '/music/a.flac' },
        ]);

        // embedPaths called once with the track's file path.
        expect(mockEmbedPaths).toHaveBeenCalledOnce();
        expect(mockEmbedPaths).toHaveBeenCalledWith(['/music/a.flac'], undefined);

        // Three DB reads/writes: getActiveProjectionBasis + upsertEmbedding + upsertState.
        expect(sql).toHaveBeenCalledTimes(3);

        // Verify the upsertState call writes 'done'.
        // The status value is passed as a template interpolation (a dynamic arg),
        // not in the static SQL fragments — so check the argument list, not the
        // string parts. The second call's args are [strings, mediaId, modelId, status, ...].
        const secondCallArgs = sql.mock.calls[2] as unknown[];
        // args[1..] are the interpolated values: mediaId, SONIC_MODEL_ID, status (='done'), 1
        // Find 'done' anywhere in the argument list (position 3 after the static parts array).
        expect(secondCallArgs).toContain('done');
    });

    it('passes cpuThreads from settings to embedPaths', async () => {
        const embedding = fakeEmbedding();
        const mockEmbedPaths = vi.fn().mockResolvedValue([{ path: '/music/b.flac', embedding }]);
        const mockIsEmbedSuccess = vi.fn().mockReturnValue(true);

        vi.doMock('$lib/server/services/sonic-embedding.service.js', () => ({
            isSonicEngineConfigured: () => true,
            SonicEngineError: class SonicEngineError extends Error {},
            SonicBusyError: class SonicBusyError extends Error {},
            embedPaths: mockEmbedPaths,
            isEmbedSuccess: mockIsEmbedSuccess,
            SONIC_MODEL_ID: 'msclap-2023',
        }));
        vi.resetModules();

        const { sonicEmbeddingBackfillTask } = await import('../sonic-embedding-backfill.js');
        const sql = makeSql([], undefined, undefined);
        const ctx = makeCtx({ sql, settingsValue: { cpuThreads: 4 } });

        await sonicEmbeddingBackfillTask.processItems?.(ctx as never, [
            { id: 'track-uuid-2', mediaType: 'track', filePath: '/music/b.flac' },
        ]);

        expect(mockEmbedPaths).toHaveBeenCalledWith(['/music/b.flac'], 4);
    });
});

// ---------------------------------------------------------------------------
// D) processItems — non-track items filtered out
// ---------------------------------------------------------------------------

describe('sonic-embedding-backfill: processItems — non-track items ignored', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.doMock('$lib/server/config.js', () => ({
            features: { sonicEmbeddings: true },
            config: {
                SONIC_EMBEDDER_URL: 'http://sonic:8000',
                SONIC_EMBEDDER_PYTHON: 'python3',
                SONIC_EMBEDDER_SCRIPT: 'embed.py',
                SONIC_EMBEDDER_TEXT_SCRIPT: 'embed_text.py',
                SONIC_EMBEDDER_BATCH_SIZE: 16,
            },
        }));
        vi.doMock('$lib/server/tasks/registry.js', () => ({
            registry: { registerTask: vi.fn() },
        }));
        vi.doMock('$lib/server/utils/logger.js', () => ({
            Logger: {
                for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
            },
        }));
        vi.doMock('$lib/server/cache/valkey.js', () => ({
            cacheGet: vi.fn().mockResolvedValue(null),
            cacheSet: vi.fn().mockResolvedValue(true),
        }));
    });

    it('does not call embedPaths when only non-track items are present', async () => {
        const mockEmbedPaths = vi.fn();
        vi.doMock('$lib/server/services/sonic-embedding.service.js', () => ({
            isSonicEngineConfigured: () => true,
            SonicEngineError: class SonicEngineError extends Error {},
            SonicBusyError: class SonicBusyError extends Error {},
            embedPaths: mockEmbedPaths,
            isEmbedSuccess: vi.fn(),
            SONIC_MODEL_ID: 'msclap-2023',
        }));
        vi.resetModules();

        const { sonicEmbeddingBackfillTask } = await import('../sonic-embedding-backfill.js');
        const sql = makeSql();
        const ctx = makeCtx({ sql });

        await sonicEmbeddingBackfillTask.processItems?.(ctx as never, [
            { id: 'movie-1', mediaType: 'movie', filePath: '/movies/a.mkv' },
            { id: 'album-1', mediaType: 'album' },
            { id: 'artist-1', mediaType: 'artist' },
        ]);

        expect(mockEmbedPaths).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// E) processItems — tracks without filePath filtered out
// ---------------------------------------------------------------------------

describe('sonic-embedding-backfill: processItems — tracks without filePath filtered', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.doMock('$lib/server/config.js', () => ({
            features: { sonicEmbeddings: true },
            config: {
                SONIC_EMBEDDER_URL: 'http://sonic:8000',
                SONIC_EMBEDDER_PYTHON: 'python3',
                SONIC_EMBEDDER_SCRIPT: 'embed.py',
                SONIC_EMBEDDER_TEXT_SCRIPT: 'embed_text.py',
                SONIC_EMBEDDER_BATCH_SIZE: 16,
            },
        }));
        vi.doMock('$lib/server/tasks/registry.js', () => ({
            registry: { registerTask: vi.fn() },
        }));
        vi.doMock('$lib/server/utils/logger.js', () => ({
            Logger: {
                for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
            },
        }));
        vi.doMock('$lib/server/cache/valkey.js', () => ({
            cacheGet: vi.fn().mockResolvedValue(null),
            cacheSet: vi.fn().mockResolvedValue(true),
        }));
    });

    it('does not call embedPaths for tracks missing filePath', async () => {
        const mockEmbedPaths = vi.fn();
        vi.doMock('$lib/server/services/sonic-embedding.service.js', () => ({
            isSonicEngineConfigured: () => true,
            SonicEngineError: class SonicEngineError extends Error {},
            SonicBusyError: class SonicBusyError extends Error {},
            embedPaths: mockEmbedPaths,
            isEmbedSuccess: vi.fn(),
            SONIC_MODEL_ID: 'msclap-2023',
        }));
        vi.resetModules();

        const { sonicEmbeddingBackfillTask } = await import('../sonic-embedding-backfill.js');
        const sql = makeSql();
        const ctx = makeCtx({ sql });

        await sonicEmbeddingBackfillTask.processItems?.(ctx as never, [
            { id: 'track-no-path', mediaType: 'track' }, // no filePath
            { id: 'track-empty-path', mediaType: 'track', filePath: '' }, // empty string
        ]);

        expect(mockEmbedPaths).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// F) processItems — embedder failure → upsertState('failed') called
// ---------------------------------------------------------------------------

describe('sonic-embedding-backfill: processItems — embedder failure path', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.doMock('$lib/server/config.js', () => ({
            features: { sonicEmbeddings: true },
            config: {
                SONIC_EMBEDDER_URL: 'http://sonic:8000',
                SONIC_EMBEDDER_PYTHON: 'python3',
                SONIC_EMBEDDER_SCRIPT: 'embed.py',
                SONIC_EMBEDDER_TEXT_SCRIPT: 'embed_text.py',
                SONIC_EMBEDDER_BATCH_SIZE: 16,
            },
        }));
        vi.doMock('$lib/server/tasks/registry.js', () => ({
            registry: { registerTask: vi.fn() },
        }));
        vi.doMock('$lib/server/utils/logger.js', () => ({
            Logger: {
                for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
            },
        }));
        vi.doMock('$lib/server/cache/valkey.js', () => ({
            cacheGet: vi.fn().mockResolvedValue(null),
            cacheSet: vi.fn().mockResolvedValue(true),
        }));
    });

    it('calls upsertState("failed") and NOT upsertEmbedding when embedder returns error', async () => {
        // EmbedFailure shape — no 'embedding' key.
        const mockEmbedPaths = vi
            .fn()
            .mockResolvedValue([{ path: '/music/bad.flac', error: 'model load failed' }]);
        // isEmbedSuccess returns false for EmbedFailure.
        const mockIsEmbedSuccess = vi.fn().mockReturnValue(false);

        vi.doMock('$lib/server/services/sonic-embedding.service.js', () => ({
            isSonicEngineConfigured: () => true,
            SonicEngineError: class SonicEngineError extends Error {},
            SonicBusyError: class SonicBusyError extends Error {},
            embedPaths: mockEmbedPaths,
            isEmbedSuccess: mockIsEmbedSuccess,
            SONIC_MODEL_ID: 'msclap-2023',
        }));
        vi.resetModules();

        const { sonicEmbeddingBackfillTask } = await import('../sonic-embedding-backfill.js');

        // getActiveProjectionBasis, then one DB write: upsertState('failed')
        const sql = makeSql([], undefined);
        const reportFailure = vi.fn().mockResolvedValue(undefined);
        const ctx = makeCtx({ sql, reportFailure });

        await sonicEmbeddingBackfillTask.processItems?.(ctx as never, [
            { id: 'track-bad', mediaType: 'track', filePath: '/music/bad.flac' },
        ]);

        expect(mockEmbedPaths).toHaveBeenCalledOnce();

        // getActiveProjectionBasis + upsertState = two DB calls.
        expect(sql).toHaveBeenCalledTimes(2);

        // The status value is a template interpolation (dynamic arg), not a static fragment.
        // Check that 'failed' appears in the argument list for the upsertState call.
        const firstCallArgs = sql.mock.calls[1] as unknown[];
        expect(firstCallArgs).toContain('failed');

        // The real Python error string must reach plugin_failure_events via
        // ctx.reportFailure — previously discarded entirely.
        expect(reportFailure).toHaveBeenCalledTimes(1);
        expect(reportFailure).toHaveBeenCalledWith(
            'track-bad',
            'model load failed',
            expect.objectContaining({ modelId: 'msclap-2023' }),
        );
    });
});

// ---------------------------------------------------------------------------
// F2) execute() drain loop — per-track embedder failure → reportFailure
//     receives the real Python error string (previously discarded entirely).
// ---------------------------------------------------------------------------

describe('sonic-embedding-backfill: execute() — per-track embedder failure reported', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.doMock('$lib/server/config.js', () => ({
            features: { sonicEmbeddings: true },
            config: {
                SONIC_EMBEDDER_URL: 'http://sonic:8000',
                SONIC_EMBEDDER_PYTHON: 'python3',
                SONIC_EMBEDDER_SCRIPT: 'embed.py',
                SONIC_EMBEDDER_TEXT_SCRIPT: 'embed_text.py',
                SONIC_EMBEDDER_BATCH_SIZE: 16,
            },
        }));
        vi.doMock('$lib/server/tasks/registry.js', () => ({
            registry: { registerTask: vi.fn() },
        }));
        vi.doMock('$lib/server/utils/logger.js', () => ({
            Logger: {
                for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
            },
        }));
        vi.doMock('$lib/server/cache/valkey.js', () => ({
            cacheGet: vi.fn().mockResolvedValue(null),
            cacheSet: vi.fn().mockResolvedValue(true),
        }));
    });

    it('calls ctx.reportFailure with the real embedder error string for a failed track', async () => {
        const mockEmbedPaths = vi
            .fn()
            .mockResolvedValueOnce([
                { path: '/music/bad.flac', error: 'RuntimeError: CUDA out of memory' },
            ])
            .mockResolvedValue([]);
        const mockIsEmbedSuccess = vi.fn().mockReturnValue(false);

        vi.doMock('$lib/server/services/sonic-embedding.service.js', () => ({
            isSonicEngineConfigured: () => true,
            SonicEngineError: class SonicEngineError extends Error {},
            SonicBusyError: class SonicBusyError extends Error {},
            embedPaths: mockEmbedPaths,
            isEmbedSuccess: mockIsEmbedSuccess,
            SONIC_MODEL_ID: 'msclap-2023',
        }));
        vi.resetModules();

        const { sonicEmbeddingBackfillTask } = await import('../sonic-embedding-backfill.js');

        // getActiveProjectionBasis first, then:
        // Round 1: fetchPendingTracks → one track; upsertState('failed') write.
        // Round 2: fetchPendingTracks → empty, drain complete.
        const sql = makeSql(
            [],
            [{ media_item_id: 'track-bad', file_path: '/music/bad.flac' }],
            undefined,
            [],
        );
        const reportFailure = vi.fn().mockResolvedValue(undefined);
        const ctx = makeCtx({ sql, reportFailure });

        vi.useFakeTimers();
        try {
            const runPromise = sonicEmbeddingBackfillTask.execute(ctx as never);
            await vi.runAllTimersAsync();
            await runPromise;
        } finally {
            vi.useRealTimers();
        }

        expect(reportFailure).toHaveBeenCalledTimes(1);
        expect(reportFailure).toHaveBeenCalledWith(
            'track-bad',
            'RuntimeError: CUDA out of memory',
            expect.objectContaining({ modelId: 'msclap-2023' }),
        );
    });

    it('redacts embedded credentials before reporting the failure, and the stored form is capped', async () => {
        const secretUrl = 'http://admin:hunter2@10.0.0.5:8989';
        const longTail = 'x'.repeat(600);
        const rawError = `Command failed: fetch ${secretUrl} timed out: ${longTail}`;

        const mockEmbedPaths = vi
            .fn()
            .mockResolvedValueOnce([{ path: '/music/bad.flac', error: rawError }])
            .mockResolvedValue([]);
        const mockIsEmbedSuccess = vi.fn().mockReturnValue(false);

        vi.doMock('$lib/server/services/sonic-embedding.service.js', () => ({
            isSonicEngineConfigured: () => true,
            SonicEngineError: class SonicEngineError extends Error {},
            SonicBusyError: class SonicBusyError extends Error {},
            embedPaths: mockEmbedPaths,
            isEmbedSuccess: mockIsEmbedSuccess,
            SONIC_MODEL_ID: 'msclap-2023',
        }));
        vi.resetModules();

        const { sonicEmbeddingBackfillTask } = await import('../sonic-embedding-backfill.js');

        const sql = makeSql(
            [],
            [{ media_item_id: 'track-bad', file_path: '/music/bad.flac' }],
            undefined,
            [],
        );
        const reportFailure = vi.fn().mockResolvedValue(undefined);
        const ctx = makeCtx({ sql, reportFailure });

        vi.useFakeTimers();
        try {
            const runPromise = sonicEmbeddingBackfillTask.execute(ctx as never);
            await vi.runAllTimersAsync();
            await runPromise;
        } finally {
            vi.useRealTimers();
        }

        expect(reportFailure).toHaveBeenCalledTimes(1);
        const [, reportedReason] = reportFailure.mock.calls[0] as [string, string, unknown];

        // Credential is gone from the reason the task hands to the runner.
        // Redaction has to happen HERE, before the string leaves the task —
        // it is the last point that knows the secret is a secret.
        expect(reportedReason).not.toContain('hunter2');
        expect(reportedReason).toContain('<redacted>');

        // The CAP is no longer applied here. `recordPluginFailure` condenses on
        // the way into plugin_failure_events, and it must see the whole string:
        // a head-slice at this boundary used to decide what the condenser could
        // ever keep, which is how 705 prod rows ended up holding nothing but an
        // ffmpeg banner. This asserts the property that actually matters — what
        // the runner will store is within the cap — at the function that stores
        // it, rather than asserting a truncation this layer no longer does.
        expect(condenseFailureReason(reportedReason).length).toBeLessThanOrEqual(MAX_REASON_LEN);
    });

    it('reports a failing track at most once even when it is re-selected across multiple drain rounds', async () => {
        // fetchPendingTracks only excludes status='done' (see module comment), so a
        // 'failed' row stays eligible and is re-fetched on the next round until the
        // rest of the backlog drains past it. Simulate that: the same failing track
        // comes back on round 2 before the drain finally empties out on round 3.
        const mockEmbedPaths = vi
            .fn()
            .mockResolvedValueOnce([{ path: '/music/bad.flac', error: 'boom' }])
            .mockResolvedValueOnce([{ path: '/music/bad.flac', error: 'boom' }])
            .mockResolvedValue([]);
        const mockIsEmbedSuccess = vi.fn().mockReturnValue(false);

        vi.doMock('$lib/server/services/sonic-embedding.service.js', () => ({
            isSonicEngineConfigured: () => true,
            SonicEngineError: class SonicEngineError extends Error {},
            SonicBusyError: class SonicBusyError extends Error {},
            embedPaths: mockEmbedPaths,
            isEmbedSuccess: mockIsEmbedSuccess,
            SONIC_MODEL_ID: 'msclap-2023',
        }));
        vi.resetModules();

        const { sonicEmbeddingBackfillTask } = await import('../sonic-embedding-backfill.js');

        // Round 1: fetch → track-bad, upsertState('failed').
        // Round 2: fetch → track-bad again (still eligible); no second state write.
        // Round 3: fetch → [] (drain complete).
        const sql = makeSql(
            [],
            [{ media_item_id: 'track-bad', file_path: '/music/bad.flac' }],
            undefined,
            [{ media_item_id: 'track-bad', file_path: '/music/bad.flac' }],
            [],
        );
        const reportFailure = vi.fn().mockResolvedValue(undefined);
        const ctx = makeCtx({ sql, reportFailure });

        vi.useFakeTimers();
        try {
            const runPromise = sonicEmbeddingBackfillTask.execute(ctx as never);
            await vi.runAllTimersAsync();
            await runPromise;
        } finally {
            vi.useRealTimers();
        }

        // The real embedder error reached plugin_failure_events exactly once for
        // this track, not once per re-selected round.
        expect(reportFailure).toHaveBeenCalledTimes(1);
        // ...and the consecutive-failure counter advanced once for the RUN. Counting
        // every round let a single run with the sidecar down (every path "fetch
        // failed") push every track past MAX_EMBED_ATTEMPTS and write the library off.
        const stateWrites = sql.mock.calls.filter((call) =>
            (call[0] as readonly string[])
                .join('?')
                .includes('INSERT INTO media_audio_embedding_state'),
        );
        expect(stateWrites).toHaveLength(1);
        expect(reportFailure).toHaveBeenCalledWith(
            'track-bad',
            'boom',
            expect.objectContaining({ modelId: 'msclap-2023' }),
        );
    });
});

// ---------------------------------------------------------------------------
// G) processItems — abort before loop → no embedPaths calls
// ---------------------------------------------------------------------------

describe('sonic-embedding-backfill: processItems — abort signal respected', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.doMock('$lib/server/config.js', () => ({
            features: { sonicEmbeddings: true },
            config: {
                SONIC_EMBEDDER_URL: 'http://sonic:8000',
                SONIC_EMBEDDER_PYTHON: 'python3',
                SONIC_EMBEDDER_SCRIPT: 'embed.py',
                SONIC_EMBEDDER_TEXT_SCRIPT: 'embed_text.py',
                SONIC_EMBEDDER_BATCH_SIZE: 16,
            },
        }));
        vi.doMock('$lib/server/tasks/registry.js', () => ({
            registry: { registerTask: vi.fn() },
        }));
        vi.doMock('$lib/server/utils/logger.js', () => ({
            Logger: {
                for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
            },
        }));
        vi.doMock('$lib/server/cache/valkey.js', () => ({
            cacheGet: vi.fn().mockResolvedValue(null),
            cacheSet: vi.fn().mockResolvedValue(true),
        }));
    });

    it('skips all tracks when the abort signal is already set', async () => {
        const mockEmbedPaths = vi.fn();
        vi.doMock('$lib/server/services/sonic-embedding.service.js', () => ({
            isSonicEngineConfigured: () => true,
            SonicEngineError: class SonicEngineError extends Error {},
            SonicBusyError: class SonicBusyError extends Error {},
            embedPaths: mockEmbedPaths,
            isEmbedSuccess: vi.fn(),
            SONIC_MODEL_ID: 'msclap-2023',
        }));
        vi.resetModules();

        const { sonicEmbeddingBackfillTask } = await import('../sonic-embedding-backfill.js');
        const sql = makeSql();
        // aborted: true — signal is already aborted before processItems runs.
        const ctx = makeCtx({ sql, aborted: true });

        await sonicEmbeddingBackfillTask.processItems?.(ctx as never, [
            { id: 'track-1', mediaType: 'track', filePath: '/music/a.flac' },
            { id: 'track-2', mediaType: 'track', filePath: '/music/b.flac' },
        ]);

        expect(mockEmbedPaths).not.toHaveBeenCalled();
        expect(sql).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// H) execute() drain loop — Bug 1 regression: embedPaths() throwing must
//    surface as a thrown TaskError, not a silently-green {success:true}
//    "0 embedded" completion.
// ---------------------------------------------------------------------------

describe('sonic-embedding-backfill: execute() — embedPaths throws (Bug 1)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.doMock('$lib/server/config.js', () => ({
            features: { sonicEmbeddings: true },
            config: {
                SONIC_EMBEDDER_URL: 'http://sonic:8000',
                SONIC_EMBEDDER_PYTHON: 'python3',
                SONIC_EMBEDDER_SCRIPT: 'embed.py',
                SONIC_EMBEDDER_TEXT_SCRIPT: 'embed_text.py',
                SONIC_EMBEDDER_BATCH_SIZE: 16,
            },
        }));
        vi.doMock('$lib/server/tasks/registry.js', () => ({
            registry: { registerTask: vi.fn() },
        }));
        vi.doMock('$lib/server/utils/logger.js', () => ({
            Logger: {
                for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
            },
        }));
        vi.doMock('$lib/server/cache/valkey.js', () => ({
            cacheGet: vi.fn().mockResolvedValue(null),
            cacheSet: vi.fn().mockResolvedValue(true),
        }));
    });

    it('throws a transient TaskError when embedPaths throws with zero progress (dead sidecar)', async () => {
        const mockEmbedPaths = vi
            .fn()
            .mockRejectedValue(new Error('ECONNREFUSED sonic-embedder:8000'));
        vi.doMock('$lib/server/services/sonic-embedding.service.js', () => ({
            isSonicEngineConfigured: () => true,
            SonicEngineError: class SonicEngineError extends Error {},
            SonicBusyError: class SonicBusyError extends Error {},
            embedPaths: mockEmbedPaths,
            isEmbedSuccess: vi.fn(),
            SONIC_MODEL_ID: 'msclap-2023',
        }));
        vi.resetModules();

        const { sonicEmbeddingBackfillTask } = await import('../sonic-embedding-backfill.js');

        // First sql call = getActiveProjectionBasis, second = fetchPendingTracks → one pending track.
        const sql = makeSql([], [{ media_item_id: 'track-1', file_path: '/music/a.flac' }]);
        const ctx = makeCtx({ sql });

        let thrown: unknown;
        try {
            await sonicEmbeddingBackfillTask.execute(ctx as never);
        } catch (err) {
            thrown = err;
        }

        // Note: not asserting `toBeInstanceOf(TaskError)` — vi.resetModules()
        // makes the dynamically re-imported task use a distinct copy of the
        // SDK module than this file's static `TaskError` import, so identity
        // checks would false-negative even though the thrown value really is
        // a TaskError from the module's own SDK copy. Structural checks below
        // are what matter (kind/message are own properties either way).
        expect((thrown as Error).name).toBe('TaskError');
        expect((thrown as TaskError).kind).toBe('transient');
        expect(mockEmbedPaths).toHaveBeenCalledOnce();
        // Only getActiveProjectionBasis + fetchPendingTracks: no 'failed' state
        // write, so an outage never counts toward the track's write-off.
        expect(sql).toHaveBeenCalledTimes(2);
    });

    it('processItems stops at the first engine error instead of failing every track', async () => {
        const EngineError = class SonicEngineError extends Error {};
        const BusyError = class SonicBusyError extends EngineError {};
        const mockEmbedPaths = vi.fn().mockRejectedValue(new EngineError('sidecar unavailable'));
        vi.doMock('$lib/server/services/sonic-embedding.service.js', () => ({
            isSonicEngineConfigured: () => true,
            SonicEngineError: EngineError,
            SonicBusyError: BusyError,
            embedPaths: mockEmbedPaths,
            isEmbedSuccess: vi.fn(),
            SONIC_MODEL_ID: 'msclap-2023',
        }));
        vi.resetModules();

        const { sonicEmbeddingBackfillTask } = await import('../sonic-embedding-backfill.js');
        const sql = makeSql([]);
        await sonicEmbeddingBackfillTask.processItems?.(makeCtx({ sql }) as never, [
            { id: 'track-1', mediaType: 'track', filePath: '/music/a.flac' },
            { id: 'track-2', mediaType: 'track', filePath: '/music/b.flac' },
            { id: 'track-3', mediaType: 'track', filePath: '/music/c.flac' },
        ]);

        expect(mockEmbedPaths).toHaveBeenCalledOnce();
        // getActiveProjectionBasis only — no per-track 'failed' writes.
        expect(sql).toHaveBeenCalledTimes(1);
    });

    it('includes partial progress in the thrown message when some tracks embedded before the sidecar died', async () => {
        const embedding = fakeEmbedding();
        const mockEmbedPaths = vi
            .fn()
            .mockResolvedValueOnce([{ path: '/music/a.flac', embedding }])
            .mockRejectedValueOnce(new Error('sidecar crashed mid-run'));
        const mockIsEmbedSuccess = vi.fn().mockReturnValue(true);
        vi.doMock('$lib/server/services/sonic-embedding.service.js', () => ({
            isSonicEngineConfigured: () => true,
            SonicEngineError: class SonicEngineError extends Error {},
            SonicBusyError: class SonicBusyError extends Error {},
            embedPaths: mockEmbedPaths,
            isEmbedSuccess: mockIsEmbedSuccess,
            SONIC_MODEL_ID: 'msclap-2023',
        }));
        vi.resetModules();

        const { sonicEmbeddingBackfillTask } = await import('../sonic-embedding-backfill.js');

        // getActiveProjectionBasis first, then:
        // Round 1: fetchPendingTracks → track-1, then upsertEmbedding +
        // upsertState('done') land. Round 2: fetchPendingTracks → track-2,
        // then embedPaths throws.
        const sql = makeSql(
            [],
            [{ media_item_id: 'track-1', file_path: '/music/a.flac' }],
            undefined,
            undefined,
            [{ media_item_id: 'track-2', file_path: '/music/b.flac' }],
        );
        const ctx = makeCtx({ sql });

        let thrown: unknown;
        try {
            await sonicEmbeddingBackfillTask.execute(ctx as never);
        } catch (err) {
            thrown = err;
        }

        // Note: not asserting `toBeInstanceOf(TaskError)` — vi.resetModules()
        // makes the dynamically re-imported task use a distinct copy of the
        // SDK module than this file's static `TaskError` import, so identity
        // checks would false-negative even though the thrown value really is
        // a TaskError from the module's own SDK copy. Structural checks below
        // are what matter (kind/message are own properties either way).
        expect((thrown as Error).name).toBe('TaskError');
        expect((thrown as TaskError).kind).toBe('transient');
        expect((thrown as Error).message).toContain('partial progress');
        expect((thrown as Error).message).toContain('1 embedded');
    });

    it('does NOT throw when embedPaths throws because the run was aborted (clean stop, unchanged)', async () => {
        const ac = new AbortController();
        const mockEmbedPaths = vi.fn().mockImplementation(async () => {
            // Simulate the sidecar client honoring ctx.signal mid-fetch: the
            // abort fires and the fetch rejects with an AbortError.
            ac.abort();
            throw new Error('AbortError: The operation was aborted');
        });
        vi.doMock('$lib/server/services/sonic-embedding.service.js', () => ({
            isSonicEngineConfigured: () => true,
            SonicEngineError: class SonicEngineError extends Error {},
            SonicBusyError: class SonicBusyError extends Error {},
            embedPaths: mockEmbedPaths,
            isEmbedSuccess: vi.fn(),
            SONIC_MODEL_ID: 'msclap-2023',
        }));
        vi.resetModules();

        const { sonicEmbeddingBackfillTask } = await import('../sonic-embedding-backfill.js');
        const sql = makeSql([], [{ media_item_id: 'track-1', file_path: '/music/a.flac' }]);
        const ctx = {
            sql,
            logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
            signal: ac.signal,
            abortSignal: ac.signal,
            runId: 'test-run',
            input: {},
            reportProgress: vi.fn(),
            settings: vi.fn().mockResolvedValue({}),
        };

        const result = await sonicEmbeddingBackfillTask.execute(ctx as never);

        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// I) Crash suspects — a file that takes the sidecar process down.
//    An outage charges nobody; the tracks a failed batch had not finished are
//    remembered and re-tried ALONE behind a readiness check, so the one that
//    really crashes the embedder is charged a normal attempt.
// ---------------------------------------------------------------------------

describe('sonic-embedding-backfill: execute() — crash suspects', () => {
    const EngineError = class SonicEngineError extends Error {
        partial: Array<{ path: string; embedding?: number[]; error?: string }>;
        inFlight: string[];
        constructor(
            message: string,
            opts?: { partial?: Array<{ path: string }>; inFlight?: string[] },
        ) {
            super(message);
            this.partial = opts?.partial ?? [];
            this.inFlight = opts?.inFlight ?? [];
        }
    };
    /** The sidecar's memory gate stayed full (429) longer than embedPaths waits. */
    const BusyError = class SonicBusyError extends EngineError {
        constructor(message: string, opts?: { partial?: Array<{ path: string }> }) {
            super(message, { partial: opts?.partial, inFlight: [] });
        }
    };
    const suspects = {
        mark: vi.fn(),
        clear: vi.fn(),
        current: new Set<string>(),
        /** Ids that already took the sidecar down once (strikeCrashSuspect). */
        struck: new Set<string>(),
    };

    function wire(opts: { embedPaths: ReturnType<typeof vi.fn>; ready?: boolean }): void {
        vi.doMock('$lib/server/services/sonic-embedding.service.js', () => ({
            isSonicEngineConfigured: () => true,
            isSonicEmbedderReady: vi.fn().mockResolvedValue(opts.ready ?? true),
            SonicEngineError: EngineError,
            SonicBusyError: BusyError,
            embedPaths: opts.embedPaths,
            isEmbedSuccess: (r: { embedding?: unknown }) => Array.isArray(r.embedding),
            SONIC_MODEL_ID: 'msclap-2023',
        }));
        vi.doMock('$lib/server/services/sonic-crash-suspects.js', () => ({
            loadCrashSuspects: vi.fn(async () => new Set(suspects.current)),
            markCrashSuspects: suspects.mark,
            clearCrashSuspects: suspects.clear,
            strikeCrashSuspect: vi.fn(async (id: string) => {
                const before = suspects.struck.has(id);
                suspects.struck.add(id);
                return before;
            }),
        }));
        vi.resetModules();
    }

    /** Every sql call whose bound values include 'failed' (upsertState(..., 'failed')). */
    function failedWritesFor(sql: ReturnType<typeof vi.fn>, mediaId: string): number {
        return sql.mock.calls.filter(
            (c) => c.slice(1).includes('failed') && c.slice(1).includes(mediaId),
        ).length;
    }

    async function runExecute(
        sql: ReturnType<typeof vi.fn>,
        reportFailure = vi.fn().mockResolvedValue(undefined),
    ): Promise<unknown> {
        const { sonicEmbeddingBackfillTask } = await import('../sonic-embedding-backfill.js');
        const ctx = { ...makeCtx({ sql, reportFailure }), reportSuccess: vi.fn() };
        try {
            await sonicEmbeddingBackfillTask.execute(ctx as never);
            return undefined;
        } catch (err) {
            return err;
        }
    }

    beforeEach(() => {
        vi.clearAllMocks();
        suspects.current = new Set();
        suspects.struck = new Set();
        vi.doMock('$lib/server/config.js', () => ({
            features: { sonicEmbeddings: true },
            config: {
                SONIC_EMBEDDER_URL: 'http://sonic:8000',
                SONIC_EMBEDDER_PYTHON: 'python3',
                SONIC_EMBEDDER_SCRIPT: 'embed.py',
                SONIC_EMBEDDER_TEXT_SCRIPT: 'embed_text.py',
                SONIC_EMBEDDER_BATCH_SIZE: 16,
            },
        }));
        vi.doMock('$lib/server/tasks/registry.js', () => ({
            registry: { registerTask: vi.fn() },
        }));
        vi.doMock('$lib/server/utils/logger.js', () => ({
            Logger: {
                for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
            },
        }));
        vi.doMock('$lib/server/cache/valkey.js', () => ({
            cacheGet: vi.fn().mockResolvedValue(null),
            cacheSet: vi.fn().mockResolvedValue(true),
        }));
    });

    it('a batch outage charges nobody and marks only the request that was in flight', async () => {
        const embedding = fakeEmbedding();
        wire({
            embedPaths: vi.fn().mockRejectedValue(
                new EngineError('sidecar unavailable', {
                    partial: [{ path: '/music/a.flac', embedding } as never],
                    // b and c were sent together; nothing after them was.
                    inFlight: ['/music/b.flac', '/music/c.flac'],
                }),
            ),
        });
        const sql = makeSql(
            [],
            [
                { media_item_id: 'track-a', file_path: '/music/a.flac' },
                { media_item_id: 'track-b', file_path: '/music/b.flac' },
                { media_item_id: 'track-c', file_path: '/music/c.flac' },
                { media_item_id: 'track-d', file_path: '/music/d.flac' },
            ],
        );

        const thrown = await runExecute(sql);

        expect((thrown as Error).name).toBe('TaskError');
        // track-a finished before the outage; track-d was never sent.
        expect(suspects.mark).toHaveBeenCalledWith(['track-b', 'track-c']);
        for (const id of ['track-a', 'track-b', 'track-c', 'track-d']) {
            expect(failedWritesFor(sql, id)).toBe(0);
        }
    });

    it('a suspect is embedded alone, first; the rest still go as one batch', async () => {
        suspects.current = new Set(['track-s']);
        const embedding = fakeEmbedding();
        const embedPaths = vi.fn(async (paths: string[]) =>
            paths.map((path) => ({ path, embedding })),
        );
        wire({ embedPaths });
        const sql = makeSql(
            [],
            [
                { media_item_id: 'track-r1', file_path: '/music/r1.flac' },
                { media_item_id: 'track-s', file_path: '/music/s.flac' },
                { media_item_id: 'track-r2', file_path: '/music/r2.flac' },
            ],
        );

        await runExecute(sql);

        expect(embedPaths.mock.calls[0][0]).toEqual(['/music/s.flac']);
        expect(embedPaths.mock.calls[1][0]).toEqual(['/music/r1.flac', '/music/r2.flac']);
        // It produced a real answer: no longer a suspect.
        expect(suspects.clear).toHaveBeenCalledWith(['track-s']);
    });

    it('first crash alone is only a strike: one coincidental outage charges nobody', async () => {
        suspects.current = new Set(['track-s']);
        const embedPaths = vi.fn().mockRejectedValue(new EngineError('connection reset'));
        wire({ embedPaths, ready: true });
        const sql = makeSql([], [{ media_item_id: 'track-s', file_path: '/music/s.flac' }]);
        const reportFailure = vi.fn().mockResolvedValue(undefined);

        const thrown = await runExecute(sql, reportFailure);

        expect(suspects.struck.has('track-s')).toBe(true);
        expect(failedWritesFor(sql, 'track-s')).toBe(0);
        expect(reportFailure).not.toHaveBeenCalled();
        expect((thrown as Error).name).toBe('TaskError');
    });

    it('struck before, ready before, down again alone: the suspect is charged and kept', async () => {
        suspects.current = new Set(['track-s']);
        suspects.struck = new Set(['track-s']);
        const embedPaths = vi.fn().mockRejectedValue(new EngineError('connection reset'));
        wire({ embedPaths, ready: true });
        const sql = makeSql(
            [],
            [
                { media_item_id: 'track-s', file_path: '/music/s.flac' },
                { media_item_id: 'track-r', file_path: '/music/r.flac' },
            ],
        );
        const reportFailure = vi.fn().mockResolvedValue(undefined);

        const thrown = await runExecute(sql, reportFailure);

        expect(failedWritesFor(sql, 'track-s')).toBe(1);
        expect(reportFailure).toHaveBeenCalledWith(
            'track-s',
            expect.stringMatching(/went down while processing this file on its own/),
            expect.anything(),
        );
        // The embedder is down: nothing else was tried or charged this run.
        expect(embedPaths).toHaveBeenCalledOnce();
        expect(failedWritesFor(sql, 'track-r')).toBe(0);
        expect(suspects.clear).not.toHaveBeenCalledWith(expect.arrayContaining(['track-s']));
        expect((thrown as Error).name).toBe('TaskError');
    });

    it('sidecar not confirmed ready: the suspect waits (not tried, not charged) and the rest goes on', async () => {
        suspects.current = new Set(['track-s']);
        const embedding = fakeEmbedding();
        const embedPaths = vi.fn(async (paths: string[]) =>
            paths.map((path) => ({ path, embedding })),
        );
        wire({ embedPaths, ready: false });
        const sql = makeSql(
            [],
            [
                { media_item_id: 'track-s', file_path: '/music/s.flac' },
                { media_item_id: 'track-r', file_path: '/music/r.flac' },
            ],
        );

        const thrown = await runExecute(sql);

        expect(thrown).toBeUndefined();
        expect(embedPaths).toHaveBeenCalledOnce();
        expect(embedPaths.mock.calls[0][0]).toEqual(['/music/r.flac']);
        expect(failedWritesFor(sql, 'track-s')).toBe(0);
        // Still a suspect for the next run.
        expect(suspects.clear).not.toHaveBeenCalledWith(expect.arrayContaining(['track-s']));
        // Later fetches in this run skip it instead of re-fetching the same chunk.
        const laterFetch = sql.mock.calls
            .slice(2)
            .find((c) =>
                c.slice(1).some((v: unknown) => Array.isArray(v) && v.includes('track-s')),
            );
        expect(laterFetch).toBeDefined();
    });

    it('subprocess mode: no suspect handling (a crashing file is already a per-file failure there)', async () => {
        vi.doMock('$lib/server/config.js', () => ({
            features: { sonicEmbeddings: true },
            config: {
                SONIC_EMBEDDER_URL: '',
                SONIC_EMBEDDER_PYTHON: 'python3',
                SONIC_EMBEDDER_SCRIPT: 'embed.py',
                SONIC_EMBEDDER_TEXT_SCRIPT: 'embed_text.py',
                SONIC_EMBEDDER_BATCH_SIZE: 16,
            },
        }));
        suspects.current = new Set(['track-s']);
        wire({
            embedPaths: vi
                .fn()
                .mockRejectedValue(
                    new EngineError('could not be spawned', { inFlight: ['/music/s.flac'] }),
                ),
        });
        const sql = makeSql([], [{ media_item_id: 'track-s', file_path: '/music/s.flac' }]);

        await runExecute(sql);

        expect(suspects.mark).not.toHaveBeenCalled();
        expect(failedWritesFor(sql, 'track-s')).toBe(0);
    });

    it('a busy sidecar (429) ends the run cleanly: partial stored, nobody charged or suspected', async () => {
        const embedding = fakeEmbedding();
        const embedPaths = vi.fn().mockRejectedValue(
            new BusyError('Sonic sidecar stayed busy', {
                partial: [{ path: '/music/a.flac', embedding } as never],
            }),
        );
        wire({ embedPaths });
        const sql = makeSql(
            [],
            [
                { media_item_id: 'track-a', file_path: '/music/a.flac' },
                { media_item_id: 'track-b', file_path: '/music/b.flac' },
            ],
        );

        const thrown = await runExecute(sql);

        // Not a failed run: a busy sidecar is not an outage for the circuit breaker.
        expect(thrown).toBeUndefined();
        expect(embedPaths).toHaveBeenCalledOnce(); // stopped, did not re-fetch
        expect(suspects.mark).not.toHaveBeenCalled();
        for (const id of ['track-a', 'track-b']) {
            expect(failedWritesFor(sql, id)).toBe(0);
        }
        // The track that embedded before the 429 is stored ('done' state write).
        const doneWrites = sql.mock.calls.filter(
            (c) => c.slice(1).includes('done') && c.slice(1).includes('track-a'),
        );
        expect(doneWrites.length).toBe(1);
    });

    it('a busy sidecar while a suspect runs alone is no strike', async () => {
        suspects.current = new Set(['track-s']);
        const embedPaths = vi.fn().mockRejectedValue(new BusyError('Sonic sidecar stayed busy'));
        wire({ embedPaths, ready: true });
        const sql = makeSql(
            [],
            [
                { media_item_id: 'track-s', file_path: '/music/s.flac' },
                { media_item_id: 'track-r', file_path: '/music/r.flac' },
            ],
        );

        const thrown = await runExecute(sql);

        expect(thrown).toBeUndefined();
        expect(suspects.struck.has('track-s')).toBe(false);
        expect(failedWritesFor(sql, 'track-s')).toBe(0);
        // The batch was not sent after the 429 either.
        expect(embedPaths).toHaveBeenCalledOnce();
    });
});
