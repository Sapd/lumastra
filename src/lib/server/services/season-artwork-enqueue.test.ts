// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetTask, mockStartRun, mockLogger, mockFilterEligible, mockFilterServed } = vi.hoisted(
    () => ({
        mockGetTask: vi.fn(),
        mockStartRun: vi.fn(),
        mockLogger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
        mockFilterEligible: vi.fn(),
        mockFilterServed: vi.fn(),
    }),
);

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: vi.fn(() => mockLogger) },
}));

vi.mock('$lib/server/tasks/registry.js', () => ({
    getRegistry: () => ({ getTask: mockGetTask }),
}));

vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: { startRun: mockStartRun },
}));

vi.mock('$lib/server/database/queries/provider-artwork.queries.js', () => ({
    filterSeasonsWithBackfillTarget: mockFilterEligible,
    filterSeasonsWithCurrentLocalPoster: mockFilterServed,
}));

import type postgres from 'postgres';
import {
    enqueueSeasonArtworkMaterialization,
    SEASON_ARTWORK_TASK_ID,
} from './season-artwork-enqueue.js';

const A = 'aaaaaaaa-0000-0000-0000-00000000000a';
const B = 'bbbbbbbb-0000-0000-0000-00000000000b';

/** The season plus the poster URL the series sync read for it. */
const req = (id: string) => ({
    mediaItemId: id,
    posterUrl: `https://image.tmdb.org/t/p/w342/${id}.jpg`,
});

// The SQL filters are exercised for real in season-artwork-enqueue.integration.test.ts;
// here they only need to be seams.
const sql = {} as unknown as postgres.Sql;

describe('enqueueSeasonArtworkMaterialization', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetTask.mockReturnValue({ id: SEASON_ARTWORK_TASK_ID });
        mockStartRun.mockResolvedValue({ runId: 'run-1' });
        // Default: every requested season is eligible and none is already served.
        mockFilterEligible.mockImplementation(async (_sql, ids: string[]) => [...ids]);
        mockFilterServed.mockResolvedValue([]);
    });

    it('enqueues one per-item run carrying mediaItemId', async () => {
        const count = await enqueueSeasonArtworkMaterialization(
            sql,
            [req(A), req(B)],
            'metadata-sync-single',
        );

        expect(count).toBe(2);
        expect(mockStartRun).toHaveBeenCalledTimes(2);
        expect(mockStartRun).toHaveBeenNthCalledWith(
            1,
            SEASON_ARTWORK_TASK_ID,
            { mediaItemId: A },
            { trigger: { kind: 'in-process', sourceRoute: 'metadata-sync-single' } },
        );
    });

    it('does nothing when the list is empty', async () => {
        expect(await enqueueSeasonArtworkMaterialization(sql, [], 'metadata-sync-single')).toBe(0);
        expect(mockGetTask).not.toHaveBeenCalled();
        expect(mockStartRun).not.toHaveBeenCalled();
    });

    it('skips silently when the backfill task is not registered', async () => {
        mockGetTask.mockReturnValue(undefined);

        const count = await enqueueSeasonArtworkMaterialization(
            sql,
            [req(A)],
            'metadata-sync-single',
        );

        expect(count).toBe(0);
        expect(mockStartRun).not.toHaveBeenCalled();
    });

    it('keeps going when one enqueue fails', async () => {
        mockStartRun.mockRejectedValueOnce(new Error('valkey unreachable'));

        const count = await enqueueSeasonArtworkMaterialization(
            sql,
            [req(A), req(B)],
            'metadata-sync-single',
        );

        expect(count).toBe(1);
        expect(mockStartRun).toHaveBeenCalledTimes(2);
    });

    it('de-duplicates ids', async () => {
        const count = await enqueueSeasonArtworkMaterialization(
            sql,
            [req(A), req(A), req(B)],
            'metadata-sync-single',
        );

        expect(count).toBe(2);
    });

    // The prod incident: `syncSeriesWithChildren` selects seasons on "TMDB has a
    // poster", which includes catalog-only seasons the library does not hold. Those
    // runs are rejected by the executor's gate and the failure feeds the task's
    // circuit breaker until it opens. Nothing ineligible may be enqueued.
    it('never enqueues a season that fails the backfill gate', async () => {
        mockFilterEligible.mockResolvedValue([B]);

        const count = await enqueueSeasonArtworkMaterialization(
            sql,
            [req(A), req(B)],
            'metadata-sync-single',
        );

        expect(count).toBe(1);
        expect(mockFilterEligible).toHaveBeenCalledWith(sql, [A, B]);
        expect(mockStartRun).toHaveBeenCalledTimes(1);
        expect(mockStartRun).toHaveBeenCalledWith(
            SEASON_ARTWORK_TASK_ID,
            { mediaItemId: B },
            { trigger: { kind: 'in-process', sourceRoute: 'metadata-sync-single' } },
        );
    });

    it('enqueues nothing when no requested season is eligible', async () => {
        mockFilterEligible.mockResolvedValue([]);

        const count = await enqueueSeasonArtworkMaterialization(
            sql,
            [req(A), req(B)],
            'metadata-sync-single',
        );

        expect(count).toBe(0);
        expect(mockStartRun).not.toHaveBeenCalled();
    });

    // Re-listing an already-local season on every series sync was the waste: one
    // run and one TMDB call per season, every sync. Served seasons are dropped
    // before any run is enqueued, and only eligible seasons are checked for it.
    it('drops seasons whose poster is already local and current', async () => {
        mockFilterServed.mockResolvedValue([A]);

        const count = await enqueueSeasonArtworkMaterialization(
            sql,
            [req(A), req(B)],
            'metadata-sync-single',
        );

        expect(count).toBe(1);
        expect(mockFilterServed).toHaveBeenCalledWith(sql, [req(A), req(B)]);
        expect(mockStartRun).toHaveBeenCalledTimes(1);
        expect(mockStartRun).toHaveBeenCalledWith(
            SEASON_ARTWORK_TASK_ID,
            { mediaItemId: B },
            { trigger: { kind: 'in-process', sourceRoute: 'metadata-sync-single' } },
        );
    });
});
