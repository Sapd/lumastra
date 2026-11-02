// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music-analysis coverage-table flag tests.
 *
 * Verifies that the gate at `useCoverageTable = getAuthoritativeStageIds().has(PLUGIN_ID)`
 * routes fetchSlice to the correct query function:
 *
 *   A) Gate OFF — stage NOT in authoritative set → `getUnanalyzedTracks` called,
 *      `findCoverageTableBacklog` NOT called.
 *   B) Gate ON  — stage IN authoritative set → `findCoverageTableBacklog` called,
 *      `getUnanalyzedTracks` NOT called.
 *
 * Both tests exercise the REAL execute() path past the `isEssentiaAvailable`
 * early-return by setting that mock to return true. The drain-backlog mock invokes
 * `opts.fetchSlice(n)` once so the branch is observed without running processSlice.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as StageStateQueries from '$lib/server/database/queries/stage-state.queries.js';
import { makeRecordingSql } from '$lib/server/tasks/__testkit__/index.js';

// ---------------------------------------------------------------------------
// Stage-state spy — hoisted ABOVE imports per verified hoist-safe convention.
// ---------------------------------------------------------------------------

const stageState = vi.hoisted(() => ({
    upsertCompletedRow: vi
        .fn<typeof StageStateQueries.upsertCompletedRow>()
        .mockResolvedValue(undefined),
}));
vi.mock('$lib/server/database/queries/stage-state.queries.js', () => stageState);

// ---------------------------------------------------------------------------
// Config mock — controls getAuthoritativeStageIds + DISABLE flag.
// Avoid importActual (pulls the 3800-line config module into every worker).
// ---------------------------------------------------------------------------

const configMock = vi.hoisted(() => ({
    getAuthoritativeStageIds: vi.fn<() => Set<string>>(() => new Set()),
    config: {
        get DISABLE_MUSIC_ANALYSIS() {
            return false;
        },
    },
}));
vi.mock('$lib/server/config.js', () => ({
    config: configMock.config,
    getAuthoritativeStageIds: configMock.getAuthoritativeStageIds,
}));

// ---------------------------------------------------------------------------
// Registry mock — suppresses registerTask side-effect at module load time.
// ---------------------------------------------------------------------------

vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { registerTask: vi.fn() },
    TaskRegistry: vi.fn(),
    getRegistry: vi.fn(),
    setTestRegistry: vi.fn(),
}));

// ---------------------------------------------------------------------------
// music-analysis.queries mock — spy on both fetchSlice routing functions.
// Use $lib alias and vi.hoisted so variables are available in the factory.
// ---------------------------------------------------------------------------

const queriesMock = vi.hoisted(() => ({
    getUnanalyzedTracks: vi.fn().mockResolvedValue([]),
    findCoverageTableBacklog: vi.fn().mockResolvedValue([]),
    countUnanalyzedTracks: vi.fn().mockResolvedValue(0),
}));

vi.mock('$lib/server/database/queries/music-analysis.queries.js', () => ({
    getUnanalyzedTracks: queriesMock.getUnanalyzedTracks,
    findCoverageTableBacklog: queriesMock.findCoverageTableBacklog,
    countUnanalyzedTracks: queriesMock.countUnanalyzedTracks,
    getMusicAnalysisBacklog: vi.fn().mockResolvedValue({
        analyzed: 0,
        remaining: 0,
        ineligible: 0,
        failed: 0,
    }),
    getMusicAnalysisWipeBatch: vi.fn().mockResolvedValue([]),
    atomicallyWipeMusicAnalysis: vi.fn().mockResolvedValue(undefined),
    markTrackAnalyzed: vi.fn().mockResolvedValue(true),
    markTrackExcluded: vi.fn().mockResolvedValue(true),
    isTrackOverDurationLimit: vi.fn().mockResolvedValue(false),
    overDurationLimitSql: vi.fn(),
    reconcileDurationLimit: vi.fn().mockResolvedValue({ skippedIds: [], restoredIds: [] }),
    TRACK_TOO_LONG_REASON: 'track-too-long',
}));

// ---------------------------------------------------------------------------
// drain-backlog mock — invokes fetchSlice once, skips processSlice.
// This is sufficient to observe which query branch was taken.
// Use $lib alias for consistent interception.
// ---------------------------------------------------------------------------

vi.mock('$lib/server/plugins/runtime/drain-backlog.js', () => ({
    drainBacklog: vi.fn(
        async (
            _ctx: unknown,
            opts: {
                fetchSlice: (limit: number) => Promise<unknown>;
                processSlice?: unknown;
            },
        ) => {
            await opts.fetchSlice(10);
            return { stopReason: 'drained' };
        },
    ),
    drainWipe: vi.fn().mockResolvedValue(undefined),
    resolveDrainMode: vi.fn().mockReturnValue('catchup'),
    formatStopReason: vi.fn().mockReturnValue(''),
    computeRemainingHint: vi.fn().mockReturnValue(0),
    isAbortedStop: vi.fn().mockReturnValue(false),
    lazyBacklog: vi.fn((fn: () => unknown) => {
        const memo = { value: undefined as unknown, called: false };
        const getter = async (): Promise<unknown> => {
            if (!memo.called) {
                memo.value = await fn();
                memo.called = true;
            }
            return memo.value;
        };
        (getter as unknown as { peek: () => unknown }).peek = () => memo.value;
        return getter;
    }),
}));

// ---------------------------------------------------------------------------
// essentia-analysis.service mock — isEssentiaAvailable returns TRUE so
// execute() reaches the fetchSlice branch in both routing tests.
// Use $lib alias for consistent interception.
// ---------------------------------------------------------------------------

vi.mock('$lib/server/services/essentia-analysis.service.js', () => ({
    isEssentiaAvailable: vi.fn().mockReturnValue(true),
    isAnalysisEngineUsable: vi.fn().mockReturnValue(true),
    verifyAnalysisEngineReady: vi.fn().mockResolvedValue(true),
    analyzeTrack: vi.fn(),
    storeAnalysis: vi.fn(),
    withEssentiaConcurrency: vi.fn(async (fn: () => unknown) => fn()),
    getEssentiaConcurrencyLimit: vi.fn().mockReturnValue(1),
}));

// ---------------------------------------------------------------------------
// Import task under test AFTER all vi.mock() calls.
// ---------------------------------------------------------------------------

import { musicAnalysisTask } from '../music-analysis.js';

// ---------------------------------------------------------------------------
// Shared context factory.
// makeRecordingSql provides a callable sql double; the task dereferences
// ctx.sql only inside drainBacklog opts, which the mock stubs out, so a
// recording sql is sufficient here (no real queries reach the DB).
// ---------------------------------------------------------------------------

function makeCtx(): Parameters<typeof musicAnalysisTask.execute>[0] {
    const { sql } = makeRecordingSql();
    const ac = new AbortController();
    return {
        sql: sql as unknown as Parameters<typeof musicAnalysisTask.execute>[0]['sql'],
        logger: {
            info: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
            child: vi.fn(),
        } as unknown as Parameters<typeof musicAnalysisTask.execute>[0]['logger'],
        signal: ac.signal,
        abortSignal: ac.signal,
        runId: 'test-run',
        input: {},
        reportProgress: vi.fn(),
    } as unknown as Parameters<typeof musicAnalysisTask.execute>[0];
}

describe('music-analysis: worker isolation (Fix D)', () => {
    it("declares isolation: 'worker' so a CPU stall can be terminated cross-thread", () => {
        // A CPU stall on the main worker thread (heavy Essentia churn under host
        // contention) starves the heartbeat + BullMQ lock renewal and produces an
        // unreclaimable lock-loss zombie. Running execute() in a worker_threads
        // Worker lets the main-thread stall watchdog terminate() the wedged thread.
        // The sibling analysis-class task (lumastra-intro-analyzer) already declares
        // this; music-analysis lacking it was the anomaly that wedged prod.
        expect(musicAnalysisTask.isolation).toBe('worker');
    });
});

describe('music-analysis: coverage-table gate routing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Restore resolved values after clearAllMocks clears them.
        queriesMock.getUnanalyzedTracks.mockResolvedValue([]);
        queriesMock.findCoverageTableBacklog.mockResolvedValue([]);
        queriesMock.countUnanalyzedTracks.mockResolvedValue(0);
    });

    it('gate OFF: getUnanalyzedTracks called, findCoverageTableBacklog NOT called when stage is NOT authoritative', async () => {
        // Gate OFF: authoritative set does not include 'music-analysis'.
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set<string>());

        await musicAnalysisTask.execute(makeCtx());

        expect(queriesMock.getUnanalyzedTracks).toHaveBeenCalledOnce();
        expect(queriesMock.findCoverageTableBacklog).not.toHaveBeenCalled();
    });

    it('gate ON: findCoverageTableBacklog called, getUnanalyzedTracks NOT called when stage IS authoritative', async () => {
        // Gate ON: authoritative set includes 'music-analysis'.
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set<string>(['music-analysis']));

        await musicAnalysisTask.execute(makeCtx());

        expect(queriesMock.findCoverageTableBacklog).toHaveBeenCalledOnce();
        expect(queriesMock.getUnanalyzedTracks).not.toHaveBeenCalled();
    });
});
