// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Finding #21 regression: the fit task must STREAM the embedding corpus via
 * a cursor rather than materializing the whole `SELECT embedding::text ...`
 * result set with a plain awaited query. A plain `await sql\`...\`` buffers
 * every row's raw pgvector TEXT into one array before the parse loop even
 * starts, so the raw-text array and the parsed `vectors` array are both
 * fully resident at once for the entire corpus.
 *
 * The sql double's tagged-template call returns an object whose `.cursor()`
 * yields the corpus in chunks, and whose `then` (i.e. what a plain `await`
 * would invoke) throws a message identifying the regression directly --
 * so reverting to a plain awaited query fails this test loudly instead of
 * silently "still working" against the double.
 */

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';

const {
    mockProjectionBasisExists,
    mockInsertProjectionBasisIfAbsent,
    mockCountEmbeddingsStampedForVersion,
} = vi.hoisted(() => ({
    mockProjectionBasisExists: vi.fn(),
    mockInsertProjectionBasisIfAbsent: vi.fn(),
    mockCountEmbeddingsStampedForVersion: vi.fn(),
}));

vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { registerTask: vi.fn() },
}));

vi.mock('$lib/server/database/queries/music-embedding-projection.queries.js', () => ({
    EMBEDDING_PROJECTION_VERSION: 1,
    projectionBasisExists: mockProjectionBasisExists,
    insertProjectionBasisIfAbsent: mockInsertProjectionBasisIfAbsent,
    countEmbeddingsStampedForVersion: mockCountEmbeddingsStampedForVersion,
}));

const { mockFitUncenteredPcaBasis, mockMatrixToBuffer } = vi.hoisted(() => ({
    mockFitUncenteredPcaBasis: vi.fn(),
    mockMatrixToBuffer: vi.fn(),
}));
vi.mock('$lib/server/services/music-embedding-projection/fit.js', () => ({
    fitUncenteredPcaBasis: mockFitUncenteredPcaBasis,
    matrixToBuffer: mockMatrixToBuffer,
}));

const mockParsePgVectorText = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/database/queries/music-alchemy.queries.js', () => ({
    parsePgVectorText: mockParsePgVectorText,
}));

import { musicEmbeddingProjectionFitTask } from '../music-embedding-projection-fit.js';

interface FakeRow {
    embedding: string;
}

function makeChunk(count: number, prefix: string): FakeRow[] {
    return Array.from({ length: count }, (_, i) => ({ embedding: `${prefix}-${i}` }));
}

/**
 * sql double that only supports the streaming contract: `.cursor(size)`
 * yields the corpus in the given chunks via async iteration. `then` stands
 * in for "someone awaited the tagged-template result directly" -- exactly
 * what the old, non-streaming code did -- and throws a message naming the
 * regression so a revert fails this test clearly rather than hanging or
 * failing on an unrelated assertion.
 */
function makeStreamingSql(chunks: FakeRow[][]): { sql: postgres.Sql; cursorCalls: number[] } {
    const cursorCalls: number[] = [];
    const tag = () => ({
        cursor(size: number) {
            cursorCalls.push(size);
            return {
                [Symbol.asyncIterator]() {
                    let i = 0;
                    return {
                        async next() {
                            if (i < chunks.length) {
                                const value = chunks[i];
                                i++;
                                return { value, done: false };
                            }
                            return { value: undefined, done: true };
                        },
                    };
                },
            };
        },
        then(): never {
            throw new Error(
                'REGRESSION (finding #21): the fit task awaited the corpus query directly ' +
                    'instead of streaming it via .cursor() -- this re-buffers the entire raw ' +
                    'pgvector TEXT result set into memory alongside the parsed vectors array.',
            );
        },
    });
    return { sql: tag as unknown as postgres.Sql, cursorCalls };
}

function makeCtx(sql: postgres.Sql) {
    const ac = new AbortController();
    return {
        sql: sql as unknown as Parameters<typeof musicEmbeddingProjectionFitTask.execute>[0]['sql'],
        logger: {
            info: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
            child: vi.fn(),
        } as unknown as Parameters<typeof musicEmbeddingProjectionFitTask.execute>[0]['logger'],
        signal: ac.signal,
        abortSignal: ac.signal,
        runId: 'test-run',
        input: {},
    } as unknown as Parameters<typeof musicEmbeddingProjectionFitTask.execute>[0];
}

describe('music-embedding-projection-fit: streams the corpus instead of double-buffering it', () => {
    it('loads the corpus via .cursor() chunks and fits from all of them', async () => {
        mockProjectionBasisExists.mockResolvedValue(false);
        mockCountEmbeddingsStampedForVersion.mockResolvedValue(0);
        mockParsePgVectorText.mockReturnValue(new Array(1024).fill(0.1));
        mockFitUncenteredPcaBasis.mockReturnValue({
            matrix: new Float32Array(1024 * 64),
            inputDim: 1024,
            outputDim: 64,
        });
        mockMatrixToBuffer.mockReturnValue(Buffer.alloc(4));
        mockInsertProjectionBasisIfAbsent.mockResolvedValue(true);

        // Three chunks, 200 rows each -- 600 total, above MIN_FIT_CORPUS_SIZE
        // (500). Split across chunks specifically to prove multi-chunk
        // iteration is exercised, not just a single round-trip.
        const chunks = [makeChunk(200, 'a'), makeChunk(200, 'b'), makeChunk(200, 'c')];
        const { sql, cursorCalls } = makeStreamingSql(chunks);

        const result = await musicEmbeddingProjectionFitTask.execute(makeCtx(sql));

        expect(result.success).toBe(true);
        expect(result.result).toMatchObject({ fitted: true, corpusSize: 600 });
        expect(mockParsePgVectorText).toHaveBeenCalledTimes(600);
        expect(mockInsertProjectionBasisIfAbsent).toHaveBeenCalledWith(
            sql,
            expect.objectContaining({ corpusSize: 600 }),
        );

        // The corpus query streamed via .cursor(), never a plain awaited
        // fetch of the whole result set.
        expect(cursorCalls.length).toBe(1);
        expect(cursorCalls[0]).toBeGreaterThan(0);
    });
});
