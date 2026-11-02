// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Finding #20 regression: the drain loop must back off and STOP after a few
 * rounds that projected nothing, instead of hot-looping the same
 * persistently-unparseable row until the 2h hard timeout.
 *
 * `fetchPendingProjectionRows`'s selection predicate is purely "not yet
 * stamped with the current version" -- a row whose embedding text
 * `parsePgVectorText` can never parse (e.g. a non-finite element) is
 * re-selected on every single iteration forever, so `rows.length` is never
 * 0 and the old `rows.length === 0` exit never fires. We drive an
 * INEXHAUSTIBLE eligibility slice (always returns the same row) so that
 * without the no-progress circuit the loop would never terminate -- a
 * safety-valve inside the mock throws past 20 calls so a regression fails
 * fast instead of hanging the test. This mirrors the fix already shipped
 * in sonic-embedding-backfill.ts (NO_PROGRESS_BACKOFF_MS / MAX_NO_PROGRESS_ROUNDS).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type postgres from 'postgres';
import type { ProjectionBasis } from '$lib/server/services/music-embedding-projection/types.js';

const {
    mockGetActiveProjectionBasis,
    mockFetchPendingProjectionRows,
    mockUpdateEmbeddingProjection,
} = vi.hoisted(() => ({
    mockGetActiveProjectionBasis: vi.fn(),
    mockFetchPendingProjectionRows: vi.fn(),
    mockUpdateEmbeddingProjection: vi.fn(),
}));

vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { registerTask: vi.fn() },
}));

vi.mock('$lib/server/database/queries/music-embedding-projection.queries.js', () => ({
    EMBEDDING_PROJECTION_VERSION: 1,
    getActiveProjectionBasis: mockGetActiveProjectionBasis,
    fetchPendingProjectionRows: mockFetchPendingProjectionRows,
    countPendingProjectionRows: vi.fn().mockResolvedValue(0),
    updateEmbeddingProjection: mockUpdateEmbeddingProjection,
}));

const { mockProjectAndQuantize, mockInt8VectorToBuffer } = vi.hoisted(() => ({
    mockProjectAndQuantize: vi.fn(),
    mockInt8VectorToBuffer: vi.fn(),
}));
vi.mock('$lib/server/services/music-embedding-projection/quantize.js', () => ({
    projectAndQuantize: mockProjectAndQuantize,
    int8VectorToBuffer: mockInt8VectorToBuffer,
}));

const mockParsePgVectorText = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/database/queries/music-alchemy.queries.js', () => ({
    parsePgVectorText: mockParsePgVectorText,
}));

import { musicEmbeddingProjectionBackfillTask } from '../music-embedding-projection-backfill.js';

const BASIS: ProjectionBasis = {
    version: 1,
    modelId: 'msclap-2023',
    inputDim: 1024,
    outputDim: 64,
    matrix: new Float32Array(1024 * 64),
};

function makeCtx() {
    const ac = new AbortController();
    return {
        sql: {} as unknown as postgres.Sql,
        logger: {
            info: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
            child: vi.fn(),
        } as unknown as Parameters<
            typeof musicEmbeddingProjectionBackfillTask.execute
        >[0]['logger'],
        signal: ac.signal,
        abortSignal: ac.signal,
        runId: 'test-run',
        input: {},
        reportProgress: vi.fn(),
    } as unknown as Parameters<typeof musicEmbeddingProjectionBackfillTask.execute>[0];
}

describe('music-embedding-projection-backfill: no-progress circuit', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetActiveProjectionBasis.mockResolvedValue(BASIS);
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('stops after a bounded number of rounds when the same row never parses', async () => {
        // The same row is re-selected every round (persistently unparseable
        // embedding), so without the fix this call count is unbounded. The
        // safety valve turns "would hang forever" into a fast, clear
        // failure instead of a real timeout.
        let calls = 0;
        mockFetchPendingProjectionRows.mockImplementation(async () => {
            calls++;
            if (calls > 20) {
                throw new Error(
                    'UNBOUNDED LOOP: fetchPendingProjectionRows called >20 times -- the ' +
                        'no-progress bailout regressed (finding #20)',
                );
            }
            return [{ media_id: 'stuck-track', embedding: 'irrelevant' }];
        });
        // Non-finite element -> parsePgVectorText's real contract returns
        // null; we stub the same outcome directly.
        mockParsePgVectorText.mockReturnValue(null);

        const ctx = makeCtx();
        const promise = musicEmbeddingProjectionBackfillTask.execute(ctx);
        // 3 backoff sleeps of 5s between the 4 rounds that trip the circuit.
        await vi.advanceTimersByTimeAsync(30_000);
        const result = await promise;

        expect(calls).toBe(4);
        expect(mockUpdateEmbeddingProjection).not.toHaveBeenCalled();
        expect(result.success).toBe(true);
        expect(result.result).toEqual({ projected: 0, parseErrors: 4 });

        const warnedNoProgress = (ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls.some(
            (c: unknown[]) => String(c[0]).toLowerCase().includes('no progress'),
        );
        expect(warnedNoProgress).toBe(true);
    });

    it('does NOT trip the circuit while real progress is being made', async () => {
        // Three distinct rows, each written successfully, then the slice
        // empties -- the ordinary "drain complete" exit, not the circuit.
        const rows = [
            { media_id: 'track-1', embedding: 'v1' },
            { media_id: 'track-2', embedding: 'v2' },
            { media_id: 'track-3', embedding: 'v3' },
        ];
        let served = 0;
        mockFetchPendingProjectionRows.mockImplementation(async () => {
            if (served >= rows.length) return [];
            const row = rows[served];
            served++;
            return [row];
        });
        mockParsePgVectorText.mockReturnValue(new Array(1024).fill(0.1));
        mockProjectAndQuantize.mockReturnValue(new Int8Array(64));
        mockInt8VectorToBuffer.mockReturnValue(Buffer.alloc(64));
        mockUpdateEmbeddingProjection.mockResolvedValue(undefined);

        const ctx = makeCtx();
        const promise = musicEmbeddingProjectionBackfillTask.execute(ctx);
        await vi.advanceTimersByTimeAsync(5_000);
        const result = await promise;

        expect(result.result).toEqual({ projected: 3, parseErrors: 0 });
        const warnedNoProgress = (ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls.some(
            (c: unknown[]) => String(c[0]).toLowerCase().includes('no progress'),
        );
        expect(warnedNoProgress).toBe(false);
    });
});
