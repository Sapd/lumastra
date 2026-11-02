// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Failures that are not facts about the episode must not strike it.
 *
 * Prod, 2026-10-21, task `lumastra-intro-analyzer`:
 *  - Shutdown/cancel: four in-flight items got a failure row in the same
 *    millisecond at a deploy (ffmpeg killed by the run's abort signal). Four
 *    episodes were tombstoned `skipped_permanent` on aborts alone.
 *  - Timeout: the black-frame pass has a fixed 5-minute ffmpeg timeout. On 4K
 *    HEVC under load it fires, and 62 episodes were quarantined permanently that
 *    way while 192 other 4K episodes completed fine.
 *
 * An interrupted run says nothing about the file, and a timeout says the box was
 * busy, not that the episode is poison. Timeouts stay visible in the failure
 * timeline, but neither kind counts toward `POISON_FAILURE_THRESHOLD`.
 *
 * Like the poison-quarantine suite, these tests mock the query modules and run
 * without a database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { FFmpegError, FFmpegTimeoutError } from '../../../../utils/ffmpeg-spawn.js';

// ---------------------------------------------------------------------------
// In-memory failure log that honours the SQL semantics the classifier relies on:
// `getFailureAggregates(..., stageId)` counts rows WHERE stage_id = stageId, so a
// NULL-stage row is recorded and visible but never counted against a stage.
// ---------------------------------------------------------------------------

const failureStore = vi.hoisted(() => ({
    rows: [] as Array<{ item_id: string; stage_id: string | null; reason: string | null }>,
}));

vi.mock('$lib/server/database/queries/plugin-failure-events.queries.js', () => ({
    recordFailure: vi.fn(
        async (
            _sql: unknown,
            _pluginId: string,
            itemKey: string,
            reason: string | null,
            _jobId: string | null,
            stageId: string | null = null,
        ) => {
            failureStore.rows.push({ item_id: itemKey, stage_id: stageId, reason });
        },
    ),
    getFailureAggregates: vi.fn(
        async (
            _sql: unknown,
            pluginId: string,
            itemKeys: string[],
            stageId: string | null = null,
        ) => {
            const map = new Map<
                string,
                {
                    plugin_id: string;
                    item_id: string;
                    failure_count: number;
                    first_seen: Date;
                    last_seen: Date;
                }
            >();
            for (const key of itemKeys) {
                const count = failureStore.rows.filter(
                    (r) => r.item_id === key && (stageId === null || r.stage_id === stageId),
                ).length;
                if (count > 0) {
                    map.set(key, {
                        plugin_id: pluginId,
                        item_id: key,
                        failure_count: count,
                        first_seen: new Date(),
                        last_seen: new Date(),
                    });
                }
            }
            return map;
        },
    ),
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
// Module under test (imported after the mocks).
// ---------------------------------------------------------------------------

import {
    recordFailureByCause,
    POISON_FAILURE_THRESHOLD,
    lumastraIntroAnalyzerTask,
    readTaskSettings,
} from '../lumastra-intro-analyzer.js';

const sql = vi.fn(async () => []) as unknown as postgres.Sql;
const VISUAL_STAGE = 'lumastra-intro-analyzer:visual';

function makeLogger() {
    return {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
    } as unknown as Parameters<typeof recordFailureByCause>[1];
}

function abortedSignal(): AbortSignal {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
}

function shutdownAbort(): FFmpegError {
    // What ffmpeg-spawn throws when the run's abort signal fires mid-decode.
    return new FFmpegError('FFmpeg aborted', null, '', false, false);
}

function timeout(): FFmpegTimeoutError {
    // What ffmpeg-spawn throws when the fixed per-call timeout fires.
    return new FFmpegTimeoutError(5 * 60_000, '');
}

function realFailure(): Error {
    return new Error('ffmpeg exit 1: moov atom not found');
}

/** One failure through the classifier, the way a catch block calls it. */
function fail(
    episodeId: string,
    err: unknown,
    signal?: AbortSignal,
): ReturnType<typeof recordFailureByCause> {
    return recordFailureByCause(sql, makeLogger(), episodeId, err, {
        reason: err instanceof Error ? err.message : String(err),
        signal,
        stageId: VISUAL_STAGE,
    });
}

describe('lumastra-intro-analyzer: a shutdown abort is not a strike', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        failureStore.rows.length = 0;
    });

    it('an abort mid-analysis records no failure event and never quarantines', async () => {
        const outcome = await fail('ep-abort', shutdownAbort(), abortedSignal());

        expect(outcome).toBe('aborted');
        expect(failureStore.rows).toHaveLength(0);
        expect(stageStateMock.upsertSkippedPermanentRow).not.toHaveBeenCalled();
    });

    it('an aborted run never quarantines, however many items it interrupts', async () => {
        const signal = abortedSignal();
        for (let i = 0; i < POISON_FAILURE_THRESHOLD + 3; i++) {
            await fail('ep-cancelled', shutdownAbort(), signal);
        }

        expect(failureStore.rows).toHaveLength(0);
        expect(stageStateMock.upsertSkippedPermanentRow).not.toHaveBeenCalled();
    });

    it('an AbortError is an abort even when the run signal has not fired', async () => {
        const abortError = new Error('The operation was aborted');
        abortError.name = 'AbortError';

        const outcome = await fail('ep-abort-error', abortError);

        expect(outcome).toBe('aborted');
        expect(failureStore.rows).toHaveLength(0);
    });

    it('interrupted attempts do not count toward the threshold for later real failures', async () => {
        for (let i = 0; i < POISON_FAILURE_THRESHOLD - 1; i++) {
            await fail('ep-mixed', realFailure());
        }
        const signal = abortedSignal();
        for (let i = 0; i < 3; i++) {
            await fail('ep-mixed', shutdownAbort(), signal);
        }
        expect(failureStore.rows).toHaveLength(POISON_FAILURE_THRESHOLD - 1);
        expect(stageStateMock.upsertSkippedPermanentRow).not.toHaveBeenCalled();

        await fail('ep-mixed', realFailure());
        expect(stageStateMock.upsertSkippedPermanentRow).toHaveBeenCalledTimes(1);
    });
});

describe('lumastra-intro-analyzer: a timeout is visible but not a strike', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        failureStore.rows.length = 0;
    });

    it('five timeouts record five events but never tombstone the episode', async () => {
        for (let i = 0; i < POISON_FAILURE_THRESHOLD; i++) {
            expect(await fail('ep-slow-4k', timeout())).toBe('uncounted');
        }

        // Still visible in the failure timeline...
        expect(failureStore.rows).toHaveLength(POISON_FAILURE_THRESHOLD);
        expect(failureStore.rows.every((r) => r.stage_id === null)).toBe(true);
        // ...but never counted as a strike against the stage.
        expect(stageStateMock.upsertSkippedPermanentRow).not.toHaveBeenCalled();
    });

    it('timeouts do not arm the threshold for later real failures', async () => {
        for (let i = 0; i < POISON_FAILURE_THRESHOLD - 1; i++) {
            await fail('ep-slow-then-broken', timeout());
        }
        for (let i = 0; i < POISON_FAILURE_THRESHOLD - 1; i++) {
            await fail('ep-slow-then-broken', realFailure());
        }
        // Four timeouts and four real failures: still below five real strikes.
        expect(stageStateMock.upsertSkippedPermanentRow).not.toHaveBeenCalled();

        await fail('ep-slow-then-broken', realFailure());
        expect(stageStateMock.upsertSkippedPermanentRow).toHaveBeenCalledTimes(1);
    });
});

describe('lumastra-intro-analyzer: real failures keep the existing quarantine', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        failureStore.rows.length = 0;
    });

    it('five ordinary failures still tombstone the episode skipped_permanent', async () => {
        for (let i = 0; i < POISON_FAILURE_THRESHOLD - 1; i++) {
            expect(await fail('ep-poison', realFailure())).toBe('recorded');
        }
        expect(stageStateMock.upsertSkippedPermanentRow).not.toHaveBeenCalled();

        expect(await fail('ep-poison', realFailure())).toBe('recorded');
        expect(stageStateMock.upsertSkippedPermanentRow).toHaveBeenCalledTimes(1);
        const arg = stageStateMock.upsertSkippedPermanentRow.mock.calls[0]![1];
        expect(arg.mediaItemId).toBe('ep-poison');
        expect(arg.stageId).toBe(VISUAL_STAGE);
        expect(arg.skippedReason).toContain('poison-episode');
    });
});

describe('lumastra-intro-analyzer: every failure path goes through the classifier', () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const source = readFileSync(resolve(here, '..', 'lumastra-intro-analyzer.ts'), 'utf8');

    it('only the classifier calls the raw quarantine helper', () => {
        // One definition plus the single call inside recordFailureByCause.
        const rawCalls = source.match(/recordFailureAndMaybeQuarantine\(/g) ?? [];
        expect(rawCalls).toHaveLength(2);
    });

    it('all scheduled and targeted catch blocks use the classifier', () => {
        // One definition plus per-item, single-item fallback, season-chromaprint
        // drain, targeted chromaprint, targeted media, and targeted season visual work,
        // the registered cooperative processItems hook, plus the two provenance-unwrapping paths that re-enter the classifier.
        const routed = source.match(/recordFailureByCause\(/g) ?? [];
        expect(routed).toHaveLength(10);
    });
});

it('caps concurrent isolated intro-analyzer runs so each cannot admit another visual decoder', () => {
    expect(lumastraIntroAnalyzerTask.quotas?.maxConcurrent).toBe(1);
});

it('uses the analysis thread override when no task-specific thread count was saved', async () => {
    const { config } = await import('$lib/server/config.js');
    const spy = vi.spyOn(config, 'ANALYSIS_FFMPEG_THREADS', 'get').mockReturnValue(0);
    try {
        const emptySettings = vi.fn(async () => []) as unknown as postgres.Sql;
        expect((await readTaskSettings(emptySettings)).ffmpegThreads).toBe(0);
    } finally {
        spy.mockRestore();
    }
});
