// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Poison-episode quarantine for the intro-analyzer bulk drain.
 *
 * A deterministically-failing ("poison") episode is correctly NOT marked
 * completed on throw (so it stays eligible and retries) — but with no upper
 * bound `getUnanalyzedSeasons` re-selects it on EVERY 6h scheduled run forever,
 * burning ffmpeg/CPU. `recordFailureAndMaybeQuarantine` bounds this: after
 * POISON_FAILURE_THRESHOLD recorded failures it tombstones the episode
 * `skipped_permanent` at the current PROCESSING_VERSION, and the eligibility
 * queries now treat completed OR skipped_permanent (version-scoped) as resolved.
 *
 * These tests exercise the helper directly against mocked query modules — no DB.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getFailureAggregates } from '$lib/server/database/queries/plugin-failure-events.queries.js';
import type { FailureAggregateRow } from '$lib/server/database/queries/plugin-failure-events.queries.js';

// ---------------------------------------------------------------------------
// Query-module mocks (hoist-safe).
// ---------------------------------------------------------------------------

const failureEventsMock = vi.hoisted(() => ({
    recordFailure: vi.fn(async () => {}),
    aggregateCount: 0,
    throwOnAggregate: false,
}));

vi.mock('$lib/server/database/queries/plugin-failure-events.queries.js', () => ({
    recordFailure: failureEventsMock.recordFailure,
    getFailureAggregates: vi.fn(async (_sql: unknown, _pluginId: string, itemKeys: string[]) => {
        if (failureEventsMock.throwOnAggregate) throw new Error('aggregate query blew up');
        const map = new Map<string, FailureAggregateRow>();
        for (const key of itemKeys) {
            map.set(key, {
                plugin_id: 'lumastra-intro-analyzer',
                item_id: key,
                failure_count: failureEventsMock.aggregateCount,
                first_seen: new Date(),
                last_seen: new Date(),
            });
        }
        return map;
    }),
}));

const stageStateMock = vi.hoisted(() => ({
    upsertSkippedPermanentRow: vi.fn(
        async (
            _sql: unknown,
            _input: {
                mediaItemId: string;
                stageId: string;
                processingVersion: number;
                skippedReason: string;
            },
        ) => {},
    ),
    upsertCompletedRow: vi.fn(async () => {}),
}));

vi.mock('$lib/server/database/queries/stage-state.queries.js', () => ({
    upsertSkippedPermanentRow: stageStateMock.upsertSkippedPermanentRow,
    upsertCompletedRow: stageStateMock.upsertCompletedRow,
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER the mocks.
// ---------------------------------------------------------------------------

import {
    recordFailureAndMaybeQuarantine,
    POISON_FAILURE_THRESHOLD,
} from '../lumastra-intro-analyzer.js';
import type postgres from 'postgres';

const sql = {} as unknown as postgres.Sql;
function makeLogger() {
    return {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
    } as unknown as Parameters<typeof recordFailureAndMaybeQuarantine>[1];
}

describe('lumastra-intro-analyzer: poison-episode quarantine', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        failureEventsMock.aggregateCount = 0;
        failureEventsMock.throwOnAggregate = false;
    });

    it('records the failure but does NOT quarantine below the threshold', async () => {
        failureEventsMock.aggregateCount = POISON_FAILURE_THRESHOLD - 1;
        await recordFailureAndMaybeQuarantine(sql, makeLogger(), 'ep-1', 'ffmpeg exit 1');

        expect(failureEventsMock.recordFailure).toHaveBeenCalledWith(
            sql,
            'lumastra-intro-analyzer',
            'ep-1',
            'ffmpeg exit 1',
            null,
            // The failure is recorded AGAINST A STAGE so each detector group
            // accumulates its own quarantine threshold. Sharing one counter let
            // acoustic failures arm the visual threshold, tombstoning an episode
            // on its first visual error.
            'lumastra-intro-analyzer:visual',
            undefined,
        );
        expect(getFailureAggregates).toHaveBeenCalledWith(
            sql,
            'lumastra-intro-analyzer',
            ['ep-1'],
            'lumastra-intro-analyzer:visual',
            true,
        );
        expect(stageStateMock.upsertSkippedPermanentRow).not.toHaveBeenCalled();
    });

    it('tombstones the episode skipped_permanent at the current version once the threshold is reached', async () => {
        failureEventsMock.aggregateCount = POISON_FAILURE_THRESHOLD;
        const logger = makeLogger();
        await recordFailureAndMaybeQuarantine(sql, logger, 'ep-poison', 'ffmpeg segfault');

        expect(stageStateMock.upsertSkippedPermanentRow).toHaveBeenCalledTimes(1);
        const arg = stageStateMock.upsertSkippedPermanentRow.mock.calls[0]![1] as {
            mediaItemId: string;
            stageId: string;
            processingVersion: number;
            skippedReason: string;
            replaceCompleted?: boolean;
        };
        expect(arg.mediaItemId).toBe('ep-poison');
        // Quarantine is per detector group, and defaults to the visual stage
        // (the per-item failure path). A file whose container breaks the visual
        // detectors is not thereby unfingerprintable, so the season-chromaprint
        // failure path tombstones the acoustic stage instead.
        expect(arg.stageId).toBe('lumastra-intro-analyzer:visual');
        // Written at the CURRENT stage version so a version bump re-eligibilizes.
        expect(arg.processingVersion).toBeGreaterThanOrEqual(1);
        expect(arg.skippedReason).toContain('poison-episode');
        // A stale `completed` row must not turn the tombstone into a silent no-op.
        expect(arg.replaceCompleted).toBe(true);
        // The quarantine is loud so an operator can see it in the run log.
        expect(logger.warn).toHaveBeenCalled();
    });

    it('quarantines when the failure count exceeds the threshold too', async () => {
        failureEventsMock.aggregateCount = POISON_FAILURE_THRESHOLD + 10;
        await recordFailureAndMaybeQuarantine(sql, makeLogger(), 'ep-2', 'boom');
        expect(stageStateMock.upsertSkippedPermanentRow).toHaveBeenCalledTimes(1);
    });

    it('is non-fatal when the aggregate lookup throws — the failure is still recorded and no error propagates', async () => {
        failureEventsMock.throwOnAggregate = true;
        const logger = makeLogger();

        await expect(
            recordFailureAndMaybeQuarantine(sql, logger, 'ep-3', 'transient'),
        ).resolves.toBeUndefined();

        expect(failureEventsMock.recordFailure).toHaveBeenCalledOnce();
        expect(stageStateMock.upsertSkippedPermanentRow).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalled();
    });
});
