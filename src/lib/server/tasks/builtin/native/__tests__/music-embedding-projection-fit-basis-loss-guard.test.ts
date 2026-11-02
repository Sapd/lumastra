// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Finding #8 regression: a refit after the basis row is lost must refuse
 * loudly instead of silently reusing the hardcoded `EMBEDDING_PROJECTION_VERSION`.
 *
 * `projectionBasisExists` returning `false` is ambiguous on its own — it's
 * true both for "fresh install, nothing fit yet" (safe to fit) and "the
 * basis row was lost but rows encoded under it survive" (NOT safe to fit:
 * a new matrix would land under the exact same version number the
 * surviving rows already carry, permanently and silently mixing two
 * incompatible bases with no way to tell them apart afterwards — see the
 * fit task's module docstring and migration 16.224.0). This guards that a
 * nonzero `countEmbeddingsStampedForVersion` trips a permanent TaskError
 * before any fitting happens, and that a genuinely fresh install (count
 * zero) is unaffected.
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

const mockFitUncenteredPcaBasis = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/services/music-embedding-projection/fit.js', () => ({
    fitUncenteredPcaBasis: mockFitUncenteredPcaBasis,
    matrixToBuffer: vi.fn(() => Buffer.alloc(4)),
}));

const mockParsePgVectorText = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/database/queries/music-alchemy.queries.js', () => ({
    parsePgVectorText: mockParsePgVectorText,
}));

import { musicEmbeddingProjectionFitTask } from '../music-embedding-projection-fit.js';

/** sql double whose `.cursor()` yields no rows -- only exercised on the "guard did not fire" path. */
function makeEmptyCursorSql(): postgres.Sql {
    const tag = () => ({
        cursor() {
            return {
                [Symbol.asyncIterator]() {
                    return { next: async () => ({ value: undefined, done: true }) };
                },
            };
        },
    });
    return tag as unknown as postgres.Sql;
}

function makeCtx() {
    const ac = new AbortController();
    return {
        sql: makeEmptyCursorSql() as unknown as Parameters<
            typeof musicEmbeddingProjectionFitTask.execute
        >[0]['sql'],
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

describe('music-embedding-projection-fit: basis-loss guard', () => {
    it('refuses with a permanent TaskError when rows are already stamped but no basis row exists', async () => {
        mockProjectionBasisExists.mockResolvedValue(false);
        mockCountEmbeddingsStampedForVersion.mockResolvedValue(29_959);

        await expect(musicEmbeddingProjectionFitTask.execute(makeCtx())).rejects.toMatchObject({
            kind: 'permanent',
            message: expect.stringContaining('EMBEDDING_PROJECTION_VERSION'),
        });

        // The guard must fire BEFORE any fitting or writing happens -- a
        // silent refit is exactly the outcome this guard exists to prevent.
        expect(mockFitUncenteredPcaBasis).not.toHaveBeenCalled();
        expect(mockInsertProjectionBasisIfAbsent).not.toHaveBeenCalled();
    });

    it('does not trip when no basis exists and nothing is stamped (genuine fresh install)', async () => {
        mockProjectionBasisExists.mockResolvedValue(false);
        mockCountEmbeddingsStampedForVersion.mockResolvedValue(0);

        // The corpus is empty (makeEmptyCursorSql), so this still fails --
        // but on the pre-existing "corpus too small" gate, not our new
        // guard. That distinction is the proof the guard let this through.
        await expect(musicEmbeddingProjectionFitTask.execute(makeCtx())).rejects.toMatchObject({
            kind: 'permanent',
            message: expect.stringContaining('corpus too small'),
        });
    });
});
