// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * media-item-tasks (series-sync, chapter-sync, image-sync) coverage-table tests.
 *
 * Verifies behaviourally that:
 * A) series-sync calls the REAL `upsertCompletedRow` with stageId='series-sync'
 *    when `syncSeriesWithChildren` succeeds (episodesSynced > 0).
 * B) chapter-sync calls the REAL `upsertCompletedRow` with stageId='chapter-sync'
 *    when `syncSeriesChapters` succeeds.
 * C) trickplay-generation writes coverage ONLY when the item is fully covered —
 *    a partially-done item (`sourcesRemaining > 0`) is a SUCCESS that must stay
 *    pending so the sweep finishes it.
 * C) image-sync (single-item) calls `upsertCompletedRow` with stageId='image-sync'
 *    when `mediaItemId` is present, errors === 0, and the stage is authoritative;
 *    does NOT write when the gate is off or no `mediaItemId` is present.
 * D) image-sync (sweep) invokes `upsertCompletedRow` per-item via the
 *    `onItemSuccess` callback passed to `scanImages`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as StageStateQueries from '$lib/server/database/queries/stage-state.queries.js';

// ---------------------------------------------------------------------------
// Hoisted mocks — declared before any real imports.
// ---------------------------------------------------------------------------

const stageState = vi.hoisted(() => ({
    upsertCompletedRow: vi
        .fn<typeof StageStateQueries.upsertCompletedRow>()
        .mockResolvedValue(undefined),
}));
vi.mock('$lib/server/database/queries/stage-state.queries.js', () => stageState);

// Config mock — only override the surface the tasks read.
// Avoid importOriginal (pulls the 3800-line config module into every worker).
const configMock = vi.hoisted(() => ({
    getAuthoritativeStageIds: vi.fn<() => Set<string>>(() => new Set()),
}));
vi.mock('$lib/server/config.js', () => ({
    getAuthoritativeStageIds: configMock.getAuthoritativeStageIds,
    config: { TRICKPLAY_ENABLED: false },
}));

// The series-sync freshness guard resolves the primary external-id provider rather
// than hardcoding 'tmdb'. Mocked (not stubbed via config) so a test can point it at a
// non-tmdb deployment and prove the literal is really gone — with the hardcode, the
// guard's provider_metadata CTE was empty on every non-tmdb install, so it never
// skipped and silently ran the fan-out it exists to prevent.
const providerConfigMock = vi.hoisted(() => ({
    primary: 'tmdb' as string,
}));
vi.mock('$lib/server/utils/provider-config.js', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getPrimaryExternalIdProvider: () => providerConfigMock.primary,
    getPrimaryProvider: () => providerConfigMock.primary,
}));

// series-sync wraps syncSeriesWithChildren (dynamic import from the task).
const syncSeriesMock = vi.hoisted(() => ({
    syncSeriesWithChildren: vi.fn<
        (
            _sql: unknown,
            _id: string,
            _opts: object,
            _onProgress: (e: {
                totalSeasons?: number;
                seasonsSynced: number;
                episodesSynced: number;
                phase: string;
            }) => void,
            _signal: AbortSignal,
        ) => Promise<{
            seasonsSynced: number;
            episodesSynced: number;
            episodesAttachFailed: number;
            prerequisiteMissing?: 'provider-identity';
        }>
    >(),
    SeriesSyncAbortedError: class SeriesSyncAbortedError extends Error {},
    SeriesSyncProviderUnavailableError: class SeriesSyncProviderUnavailableError extends Error {},
}));
vi.mock('$lib/server/services/metadata-sync-single.service.js', () => syncSeriesMock);

// chapter-sync wraps syncSeriesChapters (dynamic import from the task).
const syncChaptersMock = vi.hoisted(() => ({
    syncSeriesChapters: vi.fn<
        (
            _sql: unknown,
            _mediaId: string,
            _jellyfinUserId: string | undefined,
            _onProgress:
                | ((progress: {
                      phase: string;
                      message: string;
                      episodesProcessed: number;
                      totalEpisodes: number;
                      chaptersFound: number;
                  }) => void)
                | undefined,
            _signal: AbortSignal | undefined,
        ) => Promise<{
            episodesProcessed: number;
            episodesWithChapters: number;
            totalChapters: number;
            inaccessibleFiles: number;
        }>
    >(),
}));
vi.mock('$lib/server/services/chapter-sync.service.js', () => syncChaptersMock);

// image-sync wraps scanImages (dynamic import from the task).
// The mock captures the onItemSuccess callback so sweep tests can verify it fires.
let capturedOnItemSuccess: ((itemId: string) => Promise<void>) | undefined;
const scanImagesMock = vi.hoisted(() => ({
    scanImages: vi.fn<
        (
            _sql: unknown,
            opts: {
                onItemSuccess?: (itemId: string) => Promise<void>;
                onProgress?: (processed: number, total: number) => void;
                signal?: AbortSignal;
                scope?: string;
                mode?: string;
                mediaItemId?: string;
            },
        ) => Promise<{ stored: number; errors: number }>
    >(),
}));
vi.mock('$lib/server/services/image-scanner.service.js', () => scanImagesMock);

// auto-identify-personal-media wraps processAutoIdentifyPersonalMedia (dynamic import).
const autoIdentifyMock = vi.hoisted(() => ({
    processAutoIdentifyPersonalMedia: vi.fn<
        (opts: {
            sql: unknown;
            signal?: AbortSignal;
            onProgress?: (phase: string, matched: number, skipped: number, total: number) => void;
        }) => Promise<{
            matched: number;
            skipped: number;
            failed: number;
            total: number;
            message: string;
        }>
    >(),
}));
vi.mock('$lib/server/services/auto-identify.service.js', () => autoIdentifyMock);

// trickplay-generation wraps generateTrickplayForMediaItem (dynamic import).
const trickplayMock = vi.hoisted(() => ({
    generateTrickplayForMediaItem: vi.fn(),
    cacheBackedHwaccelDenyList: vi.fn(() => ({
        isDenied: async () => false,
        deny: async () => {},
    })),
}));
vi.mock('$lib/server/services/trickplay-generator.service.js', () => trickplayMock);

// Suppress registry side-effect at module load.
vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { registerTask: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Import REAL tasks after all mocks are in place.
// ---------------------------------------------------------------------------

import {
    seriesSyncTask,
    chapterSyncTask,
    imageSyncTask,
    autoIdentifyPersonalMediaTask,
    trickplayGenerationTask,
} from '../media-item-tasks.js';
import { makeRecordingSql } from '$lib/server/tasks/__testkit__/index.js';

// ---------------------------------------------------------------------------
// Context factories
// ---------------------------------------------------------------------------

type SeriesCtx = Parameters<typeof seriesSyncTask.execute>[0];
type ChapterCtx = Parameters<typeof chapterSyncTask.execute>[0];
type ImageCtx = Parameters<typeof imageSyncTask.execute>[0];

/**
 * Series ctx whose SECOND query — the series-sync freshness probe — answers.
 * `stale` false means "synced recently and nothing new below it", i.e. skip.
 * The default makeSeriesCtx leaves the probe unanswered (empty rows), which
 * reads as "not fresh" and runs, so the pre-existing tests are unaffected.
 */
function makeSeriesCtxWithFreshness(
    mediaItemId: string,
    probe: { stale: boolean } | null,
    input: Record<string, unknown> = {},
): SeriesCtx {
    const ac = new AbortController();
    const rec = makeRecordingSql({ rows: [{ media_type: 'SERIES' }] });
    rec.queueRows(probe ? [probe] : []);
    return {
        sql: rec.sql,
        logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() },
        signal: ac.signal,
        abortSignal: ac.signal,
        runId: 'test-run-series-freshness',
        input: { mediaItemId, ...input },
        reportProgress: vi.fn(),
    } as unknown as SeriesCtx;
}

function makeSeriesCtx(mediaItemId: string): SeriesCtx {
    const ac = new AbortController();
    const rec = makeRecordingSql({ rows: [{ media_type: 'SERIES' }] });
    return {
        sql: rec.sql,
        logger: {
            info: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
            child: vi.fn(),
        },
        signal: ac.signal,
        abortSignal: ac.signal,
        runId: 'test-run-series',
        input: { mediaItemId },
        reportProgress: vi.fn(),
    } as unknown as SeriesCtx;
}

function makeChapterCtx(mediaItemId: string): ChapterCtx {
    const ac = new AbortController();
    const { sql } = makeRecordingSql();
    return {
        sql,
        logger: {
            info: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
            child: vi.fn(),
        },
        signal: ac.signal,
        abortSignal: ac.signal,
        runId: 'test-run-chapter',
        input: { mediaItemId },
        reportProgress: vi.fn(),
    } as unknown as ChapterCtx;
}

function makeImageCtx(input: Record<string, unknown> = {}): ImageCtx {
    const ac = new AbortController();
    const { sql } = makeRecordingSql();
    return {
        sql,
        logger: {
            info: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
            child: vi.fn(),
        },
        signal: ac.signal,
        abortSignal: ac.signal,
        runId: 'test-run-image',
        input,
        reportProgress: vi.fn(),
    } as unknown as ImageCtx;
}

type AutoIdentifyCtx = Parameters<typeof autoIdentifyPersonalMediaTask.execute>[0];

function makeAutoIdentifyCtx(): AutoIdentifyCtx {
    const ac = new AbortController();
    const { sql } = makeRecordingSql();
    return {
        sql,
        logger: {
            info: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
            child: vi.fn(),
        },
        signal: ac.signal,
        abortSignal: ac.signal,
        runId: 'test-run-auto-identify',
        input: {},
        reportProgress: vi.fn(),
    } as unknown as AutoIdentifyCtx;
}

// ---------------------------------------------------------------------------
// series-sync behavioural tests
// ---------------------------------------------------------------------------

describe('series-sync: upsertCompletedRow fires on success', () => {
    const SERIES_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

    beforeEach(() => {
        vi.clearAllMocks();
        capturedOnItemSuccess = undefined;
        syncSeriesMock.syncSeriesWithChildren.mockResolvedValue({
            seasonsSynced: 2,
            episodesSynced: 10,
            episodesAttachFailed: 0,
        });
    });

    it('calls upsertCompletedRow with mediaItemId, stageId=series-sync, processingVersion=1', async () => {
        await seriesSyncTask.execute(makeSeriesCtx(SERIES_ID));

        expect(stageState.upsertCompletedRow).toHaveBeenCalledOnce();
        expect(stageState.upsertCompletedRow).toHaveBeenCalledWith(expect.anything(), {
            mediaItemId: SERIES_ID,
            stageId: 'series-sync',
            processingVersion: 1,
        });
    });

    it('does NOT call upsertCompletedRow when episodesSynced === 0', async () => {
        syncSeriesMock.syncSeriesWithChildren.mockResolvedValue({
            seasonsSynced: 1,
            episodesSynced: 0,
            episodesAttachFailed: 0,
        });

        await seriesSyncTask.execute(makeSeriesCtx(SERIES_ID));

        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
    });

    // The run wrapper resets a plain `success:false` row straight to `pending`
    // with no backoff and no attempt increment — correct for a task declining a
    // cycle, fatal for an item that can never succeed. Prod ran three of these
    // once a MINUTE indefinitely (2026-08-20) before the permanent flag.
    it('disposes missing provider identity as a prerequisite skip, without completed coverage', async () => {
        syncSeriesMock.syncSeriesWithChildren.mockResolvedValue({
            seasonsSynced: 0,
            episodesSynced: 0,
            episodesAttachFailed: 0,
            prerequisiteMissing: 'provider-identity',
        });

        const ret = await seriesSyncTask.execute(makeSeriesCtx(SERIES_ID));

        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
        expect(ret).toMatchObject({
            success: false,
            itemsProcessed: 0,
            stopReason: 'skipped',
            result: { reason: 'no-provider-identity' },
        });
        expect((ret as { permanent?: boolean }).permanent).toBeUndefined();
        expect((ret as { result: { message: string } }).result.message).toMatch(/Identify/);
    });

    it('marks NO-CHILDREN permanent — re-running asks TMDB the same question', async () => {
        syncSeriesMock.syncSeriesWithChildren.mockResolvedValue({
            seasonsSynced: 0,
            episodesSynced: 0,
            episodesAttachFailed: 0,
        });

        const ret = await seriesSyncTask.execute(makeSeriesCtx(SERIES_ID));

        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
        expect(ret).toMatchObject({ success: false, permanent: true });
        // permanentFailureMessage() reads the TOP-LEVEL `error`; without it
        // last_error records only that the item was written off, not why.
        expect((ret as { error?: string }).error).toMatch(/no seasons or episodes/i);
    });

    it('leaves a PARTIAL run retryable — seasons arrived, the episode list did not', async () => {
        syncSeriesMock.syncSeriesWithChildren.mockResolvedValue({
            seasonsSynced: 3,
            episodesSynced: 0,
            episodesAttachFailed: 0,
        });

        const ret = await seriesSyncTask.execute(makeSeriesCtx(SERIES_ID));

        expect(ret).toMatchObject({ success: false });
        // Permanent here would strand a series whose episodes timed out.
        expect((ret as { permanent?: boolean }).permanent).toBeUndefined();
    });

    it('does NOT call upsertCompletedRow and returns success:false when episodesAttachFailed > 0', async () => {
        syncSeriesMock.syncSeriesWithChildren.mockResolvedValue({
            seasonsSynced: 2,
            episodesSynced: 8,
            episodesAttachFailed: 3,
        });

        const ret = await seriesSyncTask.execute(makeSeriesCtx(SERIES_ID));

        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
        expect(ret).toMatchObject({ success: false });
    });

    it('does NOT call upsertCompletedRow when the item is not found (row missing)', async () => {
        const ac = new AbortController();
        const rec = makeRecordingSql({ rows: [] });
        const ctx = {
            sql: rec.sql,
            logger: {
                info: vi.fn(),
                warn: vi.fn(),
                debug: vi.fn(),
                error: vi.fn(),
                child: vi.fn(),
            },
            signal: ac.signal,
            abortSignal: ac.signal,
            runId: 'test-run-series-missing',
            input: { mediaItemId: SERIES_ID },
            reportProgress: vi.fn(),
        } as unknown as Parameters<typeof seriesSyncTask.execute>[0];

        const ret = await seriesSyncTask.execute(ctx);

        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
        expect(ret).toMatchObject({ success: false, itemsProcessed: 0 });
    });
});

// ---------------------------------------------------------------------------
// chapter-sync behavioural tests
// ---------------------------------------------------------------------------

describe('chapter-sync: upsertCompletedRow fires on success', () => {
    const CHAPTER_ID = 'bbbbbbbb-0000-0000-0000-000000000001';

    beforeEach(() => {
        vi.clearAllMocks();
        capturedOnItemSuccess = undefined;
        syncChaptersMock.syncSeriesChapters.mockResolvedValue({
            episodesProcessed: 5,
            episodesWithChapters: 3,
            totalChapters: 12,
            inaccessibleFiles: 0,
        });
    });

    it('calls upsertCompletedRow with mediaItemId, stageId=chapter-sync, processingVersion=1', async () => {
        const ctx = makeChapterCtx(CHAPTER_ID);
        await chapterSyncTask.execute(ctx);

        expect(stageState.upsertCompletedRow).toHaveBeenCalledOnce();
        expect(stageState.upsertCompletedRow).toHaveBeenCalledWith(expect.anything(), {
            mediaItemId: CHAPTER_ID,
            stageId: 'chapter-sync',
            processingVersion: 1,
        });

        expect(syncChaptersMock.syncSeriesChapters).toHaveBeenCalledOnce();
        expect(syncChaptersMock.syncSeriesChapters).toHaveBeenCalledWith(
            ctx.sql,
            CHAPTER_ID,
            undefined,
            expect.any(Function),
            ctx.signal,
            { force: false },
        );
    });

    // Regression: a run where files were present-but-unreadable must NOT settle
    // the stage as `completed` (that permanently stranded "Hafentage" with zero
    // chapters). It throws so the run-wrapper records failed_transient + retries.
    it('throws (and does NOT complete the stage) when inaccessibleFiles > 0', async () => {
        syncChaptersMock.syncSeriesChapters.mockResolvedValue({
            episodesProcessed: 5,
            episodesWithChapters: 0,
            totalChapters: 0,
            inaccessibleFiles: 5,
        });
        const ctx = makeChapterCtx(CHAPTER_ID);

        await expect(chapterSyncTask.execute(ctx)).rejects.toThrow(/inaccessible/i);
        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// image-sync single-item behavioural tests
// ---------------------------------------------------------------------------

describe('image-sync single-item: upsertCompletedRow gating', () => {
    const ITEM_ID = 'cccccccc-0000-0000-0000-000000000001';

    beforeEach(() => {
        vi.clearAllMocks();
        capturedOnItemSuccess = undefined;
        scanImagesMock.scanImages.mockImplementation(async (_sql, opts) => {
            capturedOnItemSuccess = opts.onItemSuccess;
            return { stored: 1, errors: 0 };
        });
    });

    it('writes stageId=image-sync when mediaItemId is set and stage is authoritative', async () => {
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set(['image-sync']));

        await imageSyncTask.execute(makeImageCtx({ mediaItemId: ITEM_ID }));

        expect(stageState.upsertCompletedRow).toHaveBeenCalledOnce();
        expect(stageState.upsertCompletedRow).toHaveBeenCalledWith(expect.anything(), {
            mediaItemId: ITEM_ID,
            stageId: 'image-sync',
            processingVersion: 1,
        });
    });

    it('does NOT write when stage is NOT authoritative (gate off)', async () => {
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set<string>());

        await imageSyncTask.execute(makeImageCtx({ mediaItemId: ITEM_ID }));

        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
    });

    it('skips without scanning when no target item is given (library sweep removed)', async () => {
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set(['image-sync']));

        const result = await imageSyncTask.execute(makeImageCtx({}));

        expect(result).toMatchObject({ success: true, itemsProcessed: 0, stopReason: 'skipped' });
        expect(scanImagesMock.scanImages).not.toHaveBeenCalled();
        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
    });

    it('has no default schedule (the daily library sweep is gone)', () => {
        expect(imageSyncTask.schedule).toBeUndefined();
    });

    it('does NOT write when errors > 0 even if gate is on', async () => {
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set(['image-sync']));
        scanImagesMock.scanImages.mockResolvedValue({ stored: 0, errors: 2 });

        await imageSyncTask.execute(makeImageCtx({ mediaItemId: ITEM_ID }));

        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// chapter-sync: abort re-check before upsertCompletedRow
// ---------------------------------------------------------------------------

describe('chapter-sync: abort re-check suppresses upsertCompletedRow', () => {
    const CHAPTER_ID = 'bbbbbbbb-0000-0000-0000-000000000002';

    beforeEach(() => {
        vi.clearAllMocks();
        capturedOnItemSuccess = undefined;
    });

    it('does NOT call upsertCompletedRow when signal is aborted by the time syncSeriesChapters resolves', async () => {
        const ac = new AbortController();
        const { sql } = makeRecordingSql();
        const ctx = {
            sql,
            logger: {
                info: vi.fn(),
                warn: vi.fn(),
                debug: vi.fn(),
                error: vi.fn(),
                child: vi.fn(),
            },
            signal: ac.signal,
            abortSignal: ac.signal,
            runId: 'test-run-chapter-abort',
            input: { mediaItemId: CHAPTER_ID },
            reportProgress: vi.fn(),
        } as unknown as ChapterCtx;

        // Abort the controller INSIDE the mock so that by the time
        // syncSeriesChapters resolves, ctx.signal.aborted === true —
        // exactly what the re-check at line ~270 guards against.
        syncChaptersMock.syncSeriesChapters.mockImplementation(
            async (_sql, _mediaId, _jellyfinUserId, _onProgress, _signal) => {
                ac.abort();
                return {
                    episodesProcessed: 5,
                    episodesWithChapters: 3,
                    totalChapters: 12,
                    inaccessibleFiles: 0,
                };
            },
        );

        const ret = await chapterSyncTask.execute(ctx);

        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
        expect(ret).toMatchObject({ success: false, stopReason: 'aborted' });
    });
});

// ---------------------------------------------------------------------------
// series-sync: abort re-check before upsertCompletedRow
// ---------------------------------------------------------------------------

describe('series-sync: abort re-check suppresses upsertCompletedRow', () => {
    const SERIES_ID = 'aaaaaaaa-0000-0000-0000-000000000002';

    beforeEach(() => {
        vi.clearAllMocks();
        capturedOnItemSuccess = undefined;
    });

    it('does NOT call upsertCompletedRow when signal is aborted by the time syncSeriesWithChildren resolves', async () => {
        const ac = new AbortController();
        const rec = makeRecordingSql({ rows: [{ media_type: 'SERIES' }] });
        const ctx = {
            sql: rec.sql,
            logger: {
                info: vi.fn(),
                warn: vi.fn(),
                debug: vi.fn(),
                error: vi.fn(),
                child: vi.fn(),
            },
            signal: ac.signal,
            abortSignal: ac.signal,
            runId: 'test-run-series-abort',
            input: { mediaItemId: SERIES_ID },
            reportProgress: vi.fn(),
        } as unknown as SeriesCtx;

        // Abort the controller INSIDE the mock so that by the time
        // syncSeriesWithChildren resolves, ctx.signal.aborted === true —
        // exactly what the re-checks at lines ~107 and ~145 guard against.
        syncSeriesMock.syncSeriesWithChildren.mockImplementation(async () => {
            ac.abort();
            return {
                seasonsSynced: 2,
                episodesSynced: 10,
                episodesAttachFailed: 0,
            };
        });

        const ret = await seriesSyncTask.execute(ctx);

        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
        expect(ret).toMatchObject({ success: false, stopReason: 'aborted' });
    });
});

// ---------------------------------------------------------------------------
// image-sync sweep behavioural tests
// ---------------------------------------------------------------------------

// A series-scope scan exercises the same multi-item paths the removed library
// sweep did (soft deadline, per-item coverage callback).
const SERIES_TARGET_ID = 'eeeeeeee-0000-0000-0000-000000000001';

describe('image-sync series scan: soft deadline', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set<string>());
    });

    it('hands scanImages a signal that fires on the soft deadline and completes gracefully', async () => {
        let seen: AbortSignal | undefined;
        scanImagesMock.scanImages.mockImplementation(async (_sql, opts) => {
            seen = opts.signal;
            return { stored: 3, errors: 0 };
        });
        const soft = new AbortController();
        soft.abort();
        const ctx = {
            ...makeImageCtx({ seriesMediaId: SERIES_TARGET_ID }),
            softSignal: soft.signal,
        } as ImageCtx;

        const result = await imageSyncTask.execute(ctx);

        expect(seen?.aborted).toBe(true);
        expect(result).toMatchObject({ success: true, stopReason: 'aborted', itemsProcessed: 3 });
    });

    it('does not hide per-item errors behind a soft stop', async () => {
        scanImagesMock.scanImages.mockResolvedValue({ stored: 2, errors: 1 });
        const soft = new AbortController();
        soft.abort();

        const result = await imageSyncTask.execute({
            ...makeImageCtx({ seriesMediaId: SERIES_TARGET_ID }),
            softSignal: soft.signal,
        } as ImageCtx);

        expect(result).toMatchObject({ success: false, stopReason: 'aborted' });
    });
});

describe('image-sync series scan: onItemSuccess callback writes upsertCompletedRow', () => {
    const SWEPT_ITEM_ID = 'dddddddd-0000-0000-0000-000000000001';

    beforeEach(() => {
        vi.clearAllMocks();
        capturedOnItemSuccess = undefined;
        // Capture the onItemSuccess callback and invoke it with the swept item ID.
        scanImagesMock.scanImages.mockImplementation(async (_sql, opts) => {
            capturedOnItemSuccess = opts.onItemSuccess;
            if (capturedOnItemSuccess) {
                await capturedOnItemSuccess(SWEPT_ITEM_ID);
            }
            return { stored: 1, errors: 0 };
        });
    });

    it('writes stageId=image-sync for the swept item via onItemSuccess', async () => {
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set(['image-sync']));

        // Series scope: no mediaItemId, so the onItemSuccess callback path is active.
        await imageSyncTask.execute(makeImageCtx({ seriesMediaId: SERIES_TARGET_ID }));

        expect(stageState.upsertCompletedRow).toHaveBeenCalledWith(expect.anything(), {
            mediaItemId: SWEPT_ITEM_ID,
            stageId: 'image-sync',
            processingVersion: 1,
        });
    });

    it('does NOT pass onItemSuccess when stage is NOT authoritative (sweep callback absent)', async () => {
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set<string>());

        await imageSyncTask.execute(makeImageCtx({ seriesMediaId: SERIES_TARGET_ID }));

        // capturedOnItemSuccess should be undefined — callback not wired when gate is off.
        expect(capturedOnItemSuccess).toBeUndefined();
        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// auto-identify-personal-media: total-failure escalation
//
// This task has NO coversStages and identityFor: () => 'global' with no
// mediaItemId in its input — it never goes through the wrapExecute per-item
// coverage-gating path, so a bare success:false return here is purely
// informational (invisible to the circuit breaker / task_history state).
// The old `failed === 0 || matched > 0` condition called 999 failures + 1
// lucky match a "success"; total failure must now THROW instead.
// ---------------------------------------------------------------------------

describe('auto-identify-personal-media: total-failure escalation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('throws a transient TaskError when everything failed and nothing matched', async () => {
        autoIdentifyMock.processAutoIdentifyPersonalMedia.mockResolvedValue({
            matched: 0,
            skipped: 5,
            failed: 999,
            total: 1004,
            message: 'done',
        });

        await expect(autoIdentifyPersonalMediaTask.execute(makeAutoIdentifyCtx())).rejects.toThrow(
            /total failure/i,
        );
    });

    it('does NOT throw and reports success:false on partial failure (some matched, some failed)', async () => {
        autoIdentifyMock.processAutoIdentifyPersonalMedia.mockResolvedValue({
            matched: 1,
            skipped: 5,
            failed: 999,
            total: 1005,
            message: 'done',
        });

        const ret = await autoIdentifyPersonalMediaTask.execute(makeAutoIdentifyCtx());

        expect(ret).toMatchObject({ success: false, itemsProcessed: 6 });
    });

    it('returns success:true when there were no failures at all', async () => {
        autoIdentifyMock.processAutoIdentifyPersonalMedia.mockResolvedValue({
            matched: 10,
            skipped: 2,
            failed: 0,
            total: 12,
            message: 'done',
        });

        const ret = await autoIdentifyPersonalMediaTask.execute(makeAutoIdentifyCtx());

        expect(ret).toMatchObject({ success: true, itemsProcessed: 12 });
    });
});

// ---------------------------------------------------------------------------
// trickplay-generation coverage gating
// ---------------------------------------------------------------------------

type TrickplayCtx = Parameters<typeof trickplayGenerationTask.execute>[0];

function makeTrickplayCtx(mediaItemId: string): TrickplayCtx {
    const ac = new AbortController();
    const { sql } = makeRecordingSql();
    return {
        sql,
        logger: {
            info: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
            child: vi.fn(),
        },
        signal: ac.signal,
        abortSignal: ac.signal,
        runId: 'test-run-trickplay',
        input: { mediaItemId },
        reportProgress: vi.fn(),
    } as unknown as TrickplayCtx;
}

describe('trickplay-generation: coverage waits until every source is done', () => {
    const TRICKPLAY_ID = 'cccccccc-0000-0000-0000-000000000001';

    beforeEach(() => {
        vi.clearAllMocks();
        configMock.getAuthoritativeStageIds.mockReturnValue(new Set(['trickplay-generation']));
    });

    it('writes coverage when nothing is left to do', async () => {
        trickplayMock.generateTrickplayForMediaItem.mockResolvedValue({
            success: true,
            sourcesRemaining: 0,
            fileId: TRICKPLAY_ID,
            generated: 120,
            skipped: 0,
            errors: 0,
            duration: 1000,
        });

        await trickplayGenerationTask.execute(makeTrickplayCtx(TRICKPLAY_ID));

        expect(stageState.upsertCompletedRow).toHaveBeenCalledOnce();
        expect(stageState.upsertCompletedRow).toHaveBeenCalledWith(expect.anything(), {
            mediaItemId: TRICKPLAY_ID,
            stageId: 'trickplay-generation',
            processingVersion: 1,
        });
    });

    it('reports a partial run as success:false so the stage row is NOT auto-completed', async () => {
        // 🔴 The regression guard, and it is subtler than it looks. Withholding
        // our own `upsertCompletedRow` is not enough: `wrapExecute` runs its
        // OWN `markCompleted` for any single-coversStages task that does not
        // return `success: false`. Returning `success: true` here would close
        // the coverage row anyway and strand the 4K edition — the exact bug
        // this change exists to fix, minus the alarm that made it visible.
        trickplayMock.generateTrickplayForMediaItem.mockResolvedValue({
            success: true,
            sourcesRemaining: 1,
            fileId: TRICKPLAY_ID,
            generated: 120,
            skipped: 0,
            errors: 0,
            duration: 1000,
        });

        const ret = await trickplayGenerationTask.execute(makeTrickplayCtx(TRICKPLAY_ID));

        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
        expect(ret).toMatchObject({
            success: false,
            stopReason: 'budget',
            itemsProcessed: 120,
            result: { generated: 120, sourcesRemaining: 1, countUnit: 'frames' },
        });
    });

    it('backs off environmental failures through the durable stage policy without stacking queue retries', async () => {
        expect(trickplayGenerationTask.retry?.attempts).toBe(1);
        expect(trickplayGenerationTask.retry?.retryOn?.(new Error('Connection is closed.'))).toBe(
            true,
        );
        trickplayMock.generateTrickplayForMediaItem.mockResolvedValue({
            success: false,
            generated: 0,
            skipped: 0,
            errors: 1,
            sourcesRemaining: 0,
            error: 'FFmpeg could not write frames',
            duration: 1,
        });
        await expect(
            trickplayGenerationTask.execute(makeTrickplayCtx(TRICKPLAY_ID)),
        ).rejects.toMatchObject({ kind: 'transient' });
    });

    it.each([
        { generated: 120, skipped: 0, sourcesRemaining: 1 },
        { generated: 0, skipped: 1, sourcesRemaining: 1 },
        { generated: 120, skipped: 0, sourcesRemaining: 0 },
    ])('preserves partial progress despite errors: %j', async (progress) => {
        const ctx = makeTrickplayCtx(TRICKPLAY_ID);
        trickplayMock.generateTrickplayForMediaItem.mockResolvedValue({
            success: false,
            ...progress,
            errors: 1,
            fileId: TRICKPLAY_ID,
            error: 'A later source could not write its frames',
            duration: 1000,
        });
        const ret = await trickplayGenerationTask.execute(ctx);
        expect(ret).toMatchObject({
            success: false,
            itemsProcessed: progress.generated,
            result: { ...progress, errors: 1 },
        });
        expect(stageState.upsertCompletedRow).not.toHaveBeenCalled();
        expect(ctx.logger.warn).toHaveBeenCalledWith(
            'Trickplay generation made progress with errors',
            expect.objectContaining({ ...progress, errors: 1 }),
        );
    });

    it('backs off a zero-progress error even when sources remain', async () => {
        trickplayMock.generateTrickplayForMediaItem.mockResolvedValue({
            success: false,
            generated: 0,
            skipped: 0,
            sourcesRemaining: 2,
            errors: 1,
            duration: 1,
        });
        await expect(
            trickplayGenerationTask.execute(makeTrickplayCtx(TRICKPLAY_ID)),
        ).rejects.toMatchObject({ kind: 'transient' });
    });

    it('does not write the item off permanently while sources remain untried', async () => {
        // `permanent` is an item-level verdict and the run-wrapper acts on it
        // BEFORE it looks at `success`. Reporting it here would condemn the
        // whole item — including a second edition nothing has even opened yet —
        // to `failed_permanent`, from which only `file.contentChanged` returns.
        trickplayMock.generateTrickplayForMediaItem.mockResolvedValue({
            success: false,
            permanent: true,
            sourcesRemaining: 1,
            fileId: TRICKPLAY_ID,
            generated: 0,
            skipped: 0,
            errors: 1,
            duration: 1000,
        });

        const ret = await trickplayGenerationTask.execute(makeTrickplayCtx(TRICKPLAY_ID));

        expect(ret).toMatchObject({ success: false });
        expect(ret).not.toHaveProperty('permanent');
    });

    it('still passes a permanent verdict through once the item is fully accounted for', async () => {
        trickplayMock.generateTrickplayForMediaItem.mockResolvedValue({
            success: false,
            permanent: true,
            sourcesRemaining: 0,
            fileId: TRICKPLAY_ID,
            generated: 0,
            skipped: 0,
            errors: 1,
            duration: 1000,
        });

        const ret = await trickplayGenerationTask.execute(makeTrickplayCtx(TRICKPLAY_ID));

        expect(ret).toMatchObject({ success: false, permanent: true });
    });

    it('lifts the permanent reason to the top-level `error` the run wrapper stores', async () => {
        // permanentFailureMessage() reads `error` off the TOP level only. Nested
        // in `result` it was lost and last_error said just "Task reported a
        // permanent failure" (prod 2026-09-30, an encrypted `encv` stream).
        const reason = 'Could not find codec parameters for stream 0: unknown codec';
        trickplayMock.generateTrickplayForMediaItem.mockResolvedValue({
            success: false,
            permanent: true,
            sourcesRemaining: 0,
            fileId: TRICKPLAY_ID,
            generated: 0,
            skipped: 0,
            errors: 1,
            duration: 1000,
            error: reason,
        });

        const ret = await trickplayGenerationTask.execute(makeTrickplayCtx(TRICKPLAY_ID));

        expect(ret).toMatchObject({ success: false, permanent: true, error: reason });
    });

    it('passes a deadline that leaves room before the declared hard cap', async () => {
        // Being killed by the watchdog discards every extracted frame; the
        // service must reach its own stopping point first.
        trickplayMock.generateTrickplayForMediaItem.mockResolvedValue({
            success: true,
            sourcesRemaining: 0,
            fileId: TRICKPLAY_ID,
            generated: 1,
            skipped: 0,
            errors: 0,
            duration: 10,
        });

        const before = Date.now();
        await trickplayGenerationTask.execute(makeTrickplayCtx(TRICKPLAY_ID));

        const opts = trickplayMock.generateTrickplayForMediaItem.mock.calls[0][2] as {
            deadlineAt?: number;
        };
        expect(opts.deadlineAt).toBeDefined();
        const budgetMs = (opts.deadlineAt as number) - before;
        expect(budgetMs).toBeGreaterThan(0);
        // Strictly inside the task's own hard timeout.
        expect(budgetMs).toBeLessThan(60 * 60 * 1000);
    });
});

describe('series-sync: freshness guard', () => {
    // A series is matched once PER EPISODE, so one scan batch fans out into a
    // full-series sync per episode — each re-fetching every season. Harborfolk
    // (773 episodes, 19 seasons) took 2,130 runs and 44,580 TMDB calls in a week.
    // The enqueue idempotency key only collapses runs queued at the same moment;
    // these arrive minutes apart. 425 of 728 runs in 24h were a repeat within ten
    // minutes of the previous one.
    const SERIES_ID = 'series-uuid-freshness-0001';

    beforeEach(() => {
        vi.clearAllMocks();
        // A plain object field, so vi.clearAllMocks() does NOT restore it — the
        // non-tmdb test below would otherwise leak into every later test.
        providerConfigMock.primary = 'tmdb';
        syncSeriesMock.syncSeriesWithChildren.mockResolvedValue({
            seasonsSynced: 0,
            episodesSynced: 0,
            episodesAttachFailed: 0,
        });
    });

    it('skips without touching TMDB when synced recently and nothing new below it', async () => {
        const ret = await seriesSyncTask.execute(
            makeSeriesCtxWithFreshness(SERIES_ID, { stale: false }),
        );

        expect(syncSeriesMock.syncSeriesWithChildren).not.toHaveBeenCalled();
        expect(ret).toMatchObject({ success: true, itemsProcessed: 0 });
    });

    it('runs anyway when a descendant or file appeared since that sync', async () => {
        // The escape hatch: freshness alone would delay genuinely new episodes.
        await seriesSyncTask.execute(makeSeriesCtxWithFreshness(SERIES_ID, { stale: true }));

        expect(syncSeriesMock.syncSeriesWithChildren).toHaveBeenCalledTimes(1);
    });

    it('runs when the series was not synced inside the window', async () => {
        // No row from the probe — the freshness filter lives in the CTE, so
        // "not fresh" is an empty result rather than stale=true.
        await seriesSyncTask.execute(makeSeriesCtxWithFreshness(SERIES_ID, null));

        expect(syncSeriesMock.syncSeriesWithChildren).toHaveBeenCalledTimes(1);
    });

    it('does NOT skip when the previous run failed — no false coverage', async () => {
        // syncSeriesWithChildrenInner writes provider_metadata (step 1, series-level)
        // BEFORE the fallible children phase, so a run that dies attaching episodes
        // has already armed the freshness signal. If the guard trusted that alone it
        // would skip 60s later, return success with 0 processed, and wrapExecute would
        // mark the stage COMPLETED for a series whose episodes never synced.
        //
        // The probe answers no row when the stage is not 'completed' (the WHERE EXISTS
        // (SELECT 1 FROM cov) clause), which is the post-failure state.
        await seriesSyncTask.execute(makeSeriesCtxWithFreshness(SERIES_ID, null));

        expect(syncSeriesMock.syncSeriesWithChildren).toHaveBeenCalledTimes(1);
    });

    it('force bypasses the guard entirely', async () => {
        await seriesSyncTask.execute(
            makeSeriesCtxWithFreshness(SERIES_ID, { stale: false }, { force: true }),
        );

        expect(syncSeriesMock.syncSeriesWithChildren).toHaveBeenCalledTimes(1);
    });

    it('probes the CONFIGURED primary provider, not a hardcoded tmdb', async () => {
        // The guard used to filter `provider = 'tmdb'` literally. On a deployment whose
        // primary is anything else the CTE matched nothing, the guard never fired, and
        // the per-episode fan-out ran on every sweep — the exact cost this guard was
        // written to remove, silently absent for those users. Nothing failed: the task
        // still succeeded, just expensively.
        providerConfigMock.primary = 'faketvdb';

        const ac = new AbortController();
        const rec = makeRecordingSql({ rows: [{ media_type: 'SERIES' }] });
        rec.queueRows([{ stale: false }]);
        await seriesSyncTask.execute({
            sql: rec.sql,
            logger: {
                info: vi.fn(),
                warn: vi.fn(),
                debug: vi.fn(),
                error: vi.fn(),
                child: vi.fn(),
            },
            signal: ac.signal,
            abortSignal: ac.signal,
            runId: 'test-run-series-provider',
            input: { mediaItemId: SERIES_ID },
            reportProgress: vi.fn(),
        } as unknown as SeriesCtx);

        const probe = rec.calls.find((c) => c.query.includes('provider_metadata'));
        expect(probe).toBeDefined();
        // Bound as a parameter, and the literal is gone from the query text.
        expect(probe?.values).toContain('faketvdb');
        expect(probe?.query).not.toContain("provider = 'tmdb'");

        // And it still actually skips — proving the resolved value is the one that
        // reaches Postgres, not merely that a string was interpolated somewhere.
        expect(syncSeriesMock.syncSeriesWithChildren).not.toHaveBeenCalled();
    });
});
