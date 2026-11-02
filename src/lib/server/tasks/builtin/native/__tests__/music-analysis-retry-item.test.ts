// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * music-analysis failures.retry — unit tests.
 *
 * Covers the retryOneTrack path:
 *   - UUID validation (no DB hit)
 *   - Track not found
 *   - Track with no file_path
 *   - File presence 'transient' → no marker write, throws
 *   - File presence 'missing' → markTrackExcluded called with 'skipped', resolves
 *   - analyzeTrack returns null → markTrackExcluded called with 'failed'+'essentia-empty-result'
 *   - Happy path → storeAnalysis+markTrackAnalyzed succeed → resolves
 *   - analyzeTrack throws → markTrackExcluded called → throws
 *   - withEssentiaConcurrency is invoked exactly once
 *
 * NOTE: The native failures.retry contract differs from the legacy retryItem:
 * it resolves (Promise<void>) on success and throws on failure, rather than
 * returning a RetryItemResult object.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── plugin-failure-events mock ───────────────────────────────────────────────
vi.mock('../../../../database/queries/plugin-failure-events.queries.js', () => ({
    recordFailure: vi.fn().mockResolvedValue(undefined),
    markFailureEventsResolved: vi.fn().mockResolvedValue(0),
    getFailureAggregates: vi.fn().mockResolvedValue(new Map()),
}));

// ─── duration cap: real queries, only the length lookup is stubbed so the ─────
// positional sql mock below keeps its call order.
const { mockIsTrackOverDurationLimit } = vi.hoisted(() => ({
    mockIsTrackOverDurationLimit: vi.fn(),
}));
import type * as MusicAnalysisQueries from '../../../../database/queries/music-analysis.queries.js';
vi.mock('../../../../database/queries/music-analysis.queries.js', async (importOriginal) => {
    const actual = await importOriginal<typeof MusicAnalysisQueries>();
    return { ...actual, isTrackOverDurationLimit: mockIsTrackOverDurationLimit };
});

// ─── essentia-analysis.service mock ──────────────────────────────────────────
const { mockWithEssentiaConcurrency, mockAnalyzeTrack, mockStoreAnalysis, mockAssessFilePresence } =
    vi.hoisted(() => ({
        mockWithEssentiaConcurrency: vi.fn(async (fn: () => Promise<void>) => {
            await fn();
        }),
        mockAnalyzeTrack: vi.fn(),
        mockStoreAnalysis: vi.fn(),
        mockAssessFilePresence: vi.fn(),
    }));

vi.mock('../../../../services/essentia-analysis.service.js', () => ({
    withEssentiaConcurrency: mockWithEssentiaConcurrency,
    analyzeTrack: mockAnalyzeTrack,
    storeAnalysis: mockStoreAnalysis,
    isEssentiaAvailable: vi.fn().mockReturnValue(true),
    isAnalysisEngineUsable: vi.fn().mockReturnValue(true),
    getEssentiaConcurrencyLimit: vi.fn().mockReturnValue(2),
}));

vi.mock('../../../../utils/file-presence.js', () => ({
    assessFilePresence: mockAssessFilePresence,
}));

// ─── Drain-backlog mock (task imports it at module load for execute()) ────────
import type * as DrainBacklogModule from '../../../../plugins/runtime/drain-backlog.js';
vi.mock('../../../../plugins/runtime/drain-backlog.js', async (importOriginal) => {
    const actual = await importOriginal<typeof DrainBacklogModule>();
    return { ...actual, drainBacklog: vi.fn() };
});

import { musicAnalysisTask } from '../music-analysis.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

type RetryFn = NonNullable<NonNullable<typeof musicAnalysisTask.failures>['retry']>;

async function callRetry(ctx: ReturnType<typeof makeCtx>, itemId: string): Promise<void> {
    return musicAnalysisTask.failures!.retry!(ctx as unknown as Parameters<RetryFn>[0], itemId);
}

type SqlMock = ReturnType<typeof vi.fn> & {
    begin: ReturnType<typeof vi.fn>;
    json: (v: unknown) => unknown;
};

/**
 * Build a tagged-template sql mock that resolves calls in order from `rows`.
 * `.begin(fn)` calls fn with the same mock (simulates a transaction).
 * `.json(v)` is a passthrough so sql.json() inside tagged templates doesn't throw.
 */
function makeSqlFn(rows: Array<Array<Record<string, unknown>>>): SqlMock {
    let i = 0;
    const fn = vi.fn((..._args: unknown[]) => Promise.resolve(rows[i++] ?? []));
    const beginFn = vi.fn((txFn: (sql: unknown) => Promise<unknown>) => txFn(fn));
    return Object.assign(fn, { begin: beginFn, json: (v: unknown) => v });
}

function makeCtx(rows: Array<Array<Record<string, unknown>>>) {
    return {
        sql: makeSqlFn(rows) as never,
        logger: {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            child: vi.fn(),
        },
        signal: new AbortController().signal,
        abortSignal: new AbortController().signal,
        runId: 'test-job-retry',
        input: {},
        reportProgress: vi.fn(),
    };
}

const VALID_UUID = '00000000-0000-0000-0000-000000000001';

const FOUND_TRACK = {
    id: VALID_UUID,
    file_path: '/music/artist/track.flac',
    prior_audit_job_id: null,
};

const FAKE_ANALYSIS = {
    bpm: 120,
    key: 'A',
    scale: 'major',
    energy: 0.8,
    danceability: 0.7,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('music-analysis failures.retry', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Default withEssentiaConcurrency: invoke callback immediately
        mockWithEssentiaConcurrency.mockImplementation(async (fn: () => Promise<void>) => {
            await fn();
        });
        mockIsTrackOverDurationLimit.mockResolvedValue(false);
    });

    it('skips an over-length track instead of analysing it, and resolves', async () => {
        mockAssessFilePresence.mockResolvedValueOnce('exists');
        mockIsTrackOverDurationLimit.mockResolvedValueOnce(true);

        // sql calls: [lookup], [markTrackExcluded UPDATE], [coverage upsert], [post-check SELECT]
        const ctx = makeCtx([
            [FOUND_TRACK],
            [],
            [],
            [{ status: 'skipped', reason: 'track-too-long' }],
        ]);

        await expect(callRetry(ctx, VALID_UUID)).resolves.toBeUndefined();
        expect(mockAnalyzeTrack).not.toHaveBeenCalled();
        const markerWrite = (ctx.sql as SqlMock).mock.calls[1] as unknown[];
        expect(JSON.stringify(markerWrite)).toContain('track-too-long');
    });

    // 0. failures.retry is defined on the task
    it('is defined on the task', () => {
        expect(typeof musicAnalysisTask.failures?.retry).toBe('function');
    });

    // 1. Invalid UUID → no DB hit, throws
    it('rejects invalid UUID without hitting the DB', async () => {
        const ctx = makeCtx([]);
        await expect(callRetry(ctx, 'not-a-uuid')).rejects.toThrow(/invalid track id/i);
        expect(ctx.sql as SqlMock).not.toHaveBeenCalled();
    });

    // 2. Track not found → sql returns []
    it('throws not-found when the track row is missing', async () => {
        const ctx = makeCtx([[]]);
        await expect(callRetry(ctx, VALID_UUID)).rejects.toThrow(/not found/i);
    });

    // 3. Track with no file_path
    it('throws no-file_path when the track has no file', async () => {
        const ctx = makeCtx([[{ id: VALID_UUID, file_path: null, prior_audit_job_id: null }]]);
        await expect(callRetry(ctx, VALID_UUID)).rejects.toThrow(/no file_path/i);
    });

    // 4. File presence 'transient' → no marker write, throws
    it('throws with transient reason when parent dir is missing, no marker written', async () => {
        mockAssessFilePresence.mockResolvedValueOnce('transient');

        // sql calls: [lookup] — no marker write
        const ctx = makeCtx([[FOUND_TRACK]]);
        await expect(callRetry(ctx, VALID_UUID)).rejects.toThrow(/transiently missing/i);
        // Only 1 sql call (track lookup) — no markTrackExcluded
        expect(ctx.sql as SqlMock).toHaveBeenCalledTimes(1);
        expect(mockWithEssentiaConcurrency).toHaveBeenCalledTimes(1);
    });

    // 5. File presence 'missing' → markTrackExcluded called with 'skipped', resolves
    it('resolves when file is missing (marks skipped, then post-check shows not-failed)', async () => {
        mockAssessFilePresence.mockResolvedValueOnce('missing');

        // sql calls: [lookup], [markTrackExcluded UPDATE], [post-check SELECT]
        const ctx = makeCtx([
            [FOUND_TRACK],
            [], // markTrackExcluded UPDATE
            [{ status: 'skipped', reason: 'file-not-found' }], // post-check: not failed → resolves
        ]);

        await expect(callRetry(ctx, VALID_UUID)).resolves.toBeUndefined();
        expect(ctx.sql as SqlMock).toHaveBeenCalledTimes(3);
    });

    // 6. analyzeTrack returns null → markTrackExcluded with 'failed'+'essentia-empty-result', post-check fails → throws
    it('throws when analyzeTrack returns null (post-check confirms failed)', async () => {
        mockAssessFilePresence.mockResolvedValueOnce('exists');
        mockAnalyzeTrack.mockResolvedValueOnce(null);

        // sql calls: [lookup], [markTrackExcluded UPDATE], [post-check SELECT]
        const ctx = makeCtx([
            [FOUND_TRACK],
            [], // markTrackExcluded UPDATE
            [{ status: 'failed', reason: 'essentia-empty-result' }], // post-check: status='failed'
        ]);

        await expect(callRetry(ctx, VALID_UUID)).rejects.toThrow(/essentia/i);
        expect(ctx.sql as SqlMock).toHaveBeenCalledTimes(3);
    });

    // 7. Happy path → storeAnalysis+markTrackAnalyzed succeed → resolves
    it('resolves on happy path', async () => {
        mockAssessFilePresence.mockResolvedValueOnce('exists');
        mockAnalyzeTrack.mockResolvedValueOnce(FAKE_ANALYSIS);
        mockStoreAnalysis.mockResolvedValueOnce(undefined);

        // sql calls: [lookup], [storeAnalysis inside tx], [markTrackAnalyzed inside tx], [post-check SELECT]
        const ctx = makeCtx([
            [FOUND_TRACK],
            [], // storeAnalysis UPDATE (inside tx)
            [], // markTrackAnalyzed UPDATE (inside tx) → no throw = success
            [{ status: 'success', reason: null }], // post-check: not failed
        ]);

        await expect(callRetry(ctx, VALID_UUID)).resolves.toBeUndefined();
        expect(mockAnalyzeTrack).toHaveBeenCalledWith(
            FOUND_TRACK.file_path,
            expect.any(AbortSignal),
        );
        expect(mockStoreAnalysis).toHaveBeenCalledWith(
            expect.anything(),
            VALID_UUID,
            FAKE_ANALYSIS,
        );
    });

    // 8. analyzeTrack throws → markTrackExcluded called, post-check shows failed → throws
    it('throws with error message when analyzeTrack throws', async () => {
        mockAssessFilePresence.mockResolvedValueOnce('exists');
        const thrownErr = new Error('Essentia binary crashed');
        mockAnalyzeTrack.mockRejectedValueOnce(thrownErr);

        // sql calls: [lookup], [markTrackExcluded UPDATE], [post-check SELECT]
        const ctx = makeCtx([
            [FOUND_TRACK],
            [], // markTrackExcluded UPDATE
            [{ status: 'failed', reason: 'Essentia binary crashed' }], // post-check: status='failed'
        ]);

        await expect(callRetry(ctx, VALID_UUID)).rejects.toThrow(/Essentia binary crashed/);
    });

    // 9. withEssentiaConcurrency is invoked exactly once per retry call
    it('invokes withEssentiaConcurrency exactly once', async () => {
        mockAssessFilePresence.mockResolvedValueOnce('exists');
        mockAnalyzeTrack.mockResolvedValueOnce(FAKE_ANALYSIS);
        mockStoreAnalysis.mockResolvedValueOnce(undefined);

        const ctx = makeCtx([[FOUND_TRACK], [], [], [{ status: 'success', reason: null }]]);

        await callRetry(ctx, VALID_UUID);
        expect(mockWithEssentiaConcurrency).toHaveBeenCalledTimes(1);
    });
});
