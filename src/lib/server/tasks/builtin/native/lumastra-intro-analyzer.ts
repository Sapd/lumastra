// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Lumastra Intro Analyzer — native defineTask implementation.
 *
 * Detects intro/credits/recap/preview segments using:
 *   1. Chapter name matching  (instant, zero FFmpeg)
 *   2. Black frame detection  (per-episode FFmpeg)
 *   3. Chromaprint fingerprinting (per-season batch FFmpeg)
 *
 * This is the TRUE inline migration of the external SyncPlugin to the new
 * task system. The execute body is ported directly from
 * plugins/lumastra-intro-analyzer/src/index.ts; only the context wrapper
 * changes (ctx.signal instead of ctx.abortSignal, ctx.reportProgress
 * instead of onProgress, settings via ctx.settings() instead of a
 * module-level pluginContext).
 *
 * Configuration env vars:
 *   PLUGIN_LUMASTRA_INTRO_ANALYZER_ENABLED        — 'false' to disable entirely
 *   PLUGIN_LUMASTRA_INTRO_ANALYZER_INTERVAL_HOURS — override 24h schedule
 */

import {
    readTaskSettings,
    type EffectiveConfig,
    ANALYZER_VISUAL_VERSION,
    ANALYZER_ACOUSTIC_VERSION,
} from './intro-analyzer/settings.js';
export { readTaskSettings, type EffectiveConfig } from './intro-analyzer/settings.js';

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import type { TaskContext, BacklogStage } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { cacheManager } from '$lib/server/cache/index.js';
import { cacheSet } from '$lib/server/cache/valkey.js';
import { probeChapters } from '$lib/server/utils/ffprobe.js';
import { FFmpegError } from '$lib/server/utils/ffmpeg-spawn.js';
import {
    probeVideoTiming,
    NonadvancingVideoTimingError,
} from '$lib/server/utils/ffprobe-video-timing.js';
import { loadKnownFileChapters } from '$lib/server/database/queries/episode-chapters.queries.js';
import { config as serverConfig } from '$lib/server/config.js';
import { classifyInfraError } from '../../infra-retry.js';
import { isEpisode, isMovie } from '$lib/server/utils/media-types.js';
import {
    upsertSegments,
    deleteSegmentsForSourceByTypes,
} from '$lib/server/database/queries/media-segments.queries.js';
import {
    recordFailure,
    getFailureAggregates,
    markFailureEventsResolved,
} from '$lib/server/database/queries/plugin-failure-events.queries.js';
import {
    upsertCompletedRow,
    upsertSkippedPermanentRow,
} from '$lib/server/database/queries/stage-state.queries.js';
import { withTx } from '$lib/server/database/with-tx.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { safeMkdir, safeStatBigInt } from '$lib/server/utils/safe-fs.js';
import type postgres from 'postgres';
import type { Logger as SdkLogger } from '@sapd/lumastra-plugin-sdk';
import type {
    DetectedSegment,
    DetectedSegmentType,
    DetectionMethod,
    DetectorOutcome,
    EpisodeWithFile,
    ChapterInput,
} from './intro-analyzer/types.js';
import {
    analyzeChapters,
    DEFAULT_CHAPTER_CONFIG,
    type ChapterAnalyzerConfig,
} from './intro-analyzer/chapter.js';
import {
    analyzeBlackFrames,
    DEFAULT_BLACKFRAME_CONFIG,
    type BlackFrameConfig,
} from './intro-analyzer/blackframe.js';
import {
    analyzeSeasonFingerprints,
    analyzeSeasonCreditsFingerprints,
    type ChromaprintConfig,
} from './intro-analyzer/chromaprint.js';
import { synthesiseAnimePreviews } from './intro-analyzer/anime-synth.js';
import {
    filterPlausible,
    type PlausibilityConfig,
    type PlausibilityRejection,
} from './intro-analyzer/plausibility.js';
import { snapToChapterMark } from './intro-analyzer/snap.js';
import { resolveSegments, type ResolveContext } from './intro-analyzer/resolve.js';
import {
    acquireExclusiveMediaSegmentWriteGate,
    acquireMediaSegmentResolutionLock,
    acquireMediaSegmentResolutionLocks,
    bumpGlobalMediaSegmentAnalysisGeneration,
    bumpMediaSegmentAnalysisGeneration,
} from './intro-analyzer/resolution-lock.js';
import { reconcileSeasonOutros, type CohortEpisode } from './intro-analyzer/cohort.js';
import {
    getCandidatesForMedia,
    getCandidatesForSeason,
    deleteCandidatesForMedia,
    replaceCandidatesForMethods,
    toCandidates,
    type MediaSegmentCandidateInput,
} from '$lib/server/database/queries/media-segment-candidates.queries.js';
import {
    getAnalyzerInputSnapshot,
    getAnalyzerInputSnapshots,
    analyzableVideoFileSql,
    analyzerFileGenerationSql,
    analyzerMediaGenerationSql,
    analyzerStageEvidenceSql,
    currentAnalyzerInputIdentitySql,
    analyzerUninspectedInputSql,
    analyzerLiveAncestrySql,
    type AnalyzerInputSnapshot,
} from '$lib/server/database/queries/media-segment-input.queries.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import {
    loadFingerprint,
    saveFingerprint,
    pruneCompletedSeasonFingerprints,
    type FingerprintIdentity,
} from '$lib/server/database/queries/media-segment-fingerprints.queries.js';
import {
    AnalysisBudgetReachedError,
    CATCHUP_BUDGET_MS,
    MANUAL_BUDGET_MS,
} from './intro-analyzer/budget.js';

// UUID validation — guards against Postgres 22P02 errors from malformed input
function isUuid(s: unknown): s is string {
    return typeof s === 'string' && UUID_RE.test(s);
}

// ============================================================================
// Constants
// ============================================================================

const PLUGIN_ID = 'lumastra-intro-analyzer';

export const ANALYSIS_TIMEOUT_BACKOFF_MS = 30 * 60_000;
const ANALYSIS_TIMEOUT_REASON = 'analysis-ffmpeg-timeout';

/**
 * Every segment type this analyzer can materialize. A full per-item pass
 * re-decides all of them, so any type the resolver no longer produces is
 * withdrawn rather than left behind as a fossil.
 */
const MATERIALIZED_SEGMENT_TYPES: readonly DetectedSegmentType[] = [
    'Intro',
    'Outro',
    'Preview',
    'Recap',
    'Commercial',
];

/**
 * What a single analysis pass is allowed to touch.
 *
 * These are two INDEPENDENT axes, and the `outroOnly` flag this replaces
 * conflated them. `types` is a resolver concern: which segment types this pass
 * may decide and, just as importantly, retract. `visualOnly` is a detector
 * concern: whether to run just the cheap per-item detectors (chapter +
 * blackframe) and touch only their own evidence.
 *
 * Keeping them separate is what makes an Intro-scoped run correct. Chromaprint
 * is the PRIMARY Intro detector — a theme song is exactly what acoustic
 * fingerprinting finds — so scoping a run to Intro must NOT be allowed to
 * disable it, which a straight rename of `outroOnly` would have done.
 */
interface SegmentScope {
    /** Types this pass may materialize and retract. */
    readonly types: readonly DetectedSegmentType[];
    /**
     * Run only the per-item visual detectors and retract only their own
     * evidence. Set for operator-targeted refreshes, where re-running the
     * season-level acoustic passes would be disproportionate.
     */
    readonly visualOnly: boolean;
    readonly runId?: string;
    readonly shouldYield?: () => boolean;
    readonly onFingerprint?: (mediaId: string) => void;
    readonly onCompleted?: (mediaId: string) => void;
    readonly onAttempt?: (mediaId: string) => void;
    readonly onInputSelected?: (mediaId: string, inputIdentity: string) => void;
}

const FULL_SCOPE: SegmentScope = { types: MATERIALIZED_SEGMENT_TYPES, visualOnly: false };

/** The types an operator may ask for by name. The rest are only ever produced incidentally. */
const OPERATOR_SELECTABLE_TYPES: readonly DetectedSegmentType[] = ['Intro', 'Outro'];

/**
 * Reads the operator's requested scope, or `undefined` for an unscoped run.
 *
 * `outroOnly: true` is the retired spelling of `segmentTypes: ['Outro']`. It is
 * still accepted because the per-item admin surfaces send it — SyncTab's
 * "Regenerate outros" and `POST /api/admin/media/{id}/segments` — and both are
 * always targeted, so the alias never reaches the library-wide branch.
 */
function readRequestedScope(
    rawInput: Record<string, unknown>,
): readonly DetectedSegmentType[] | undefined {
    const raw = rawInput.segmentTypes;
    if (Array.isArray(raw)) {
        const types = raw.filter((t): t is DetectedSegmentType =>
            OPERATOR_SELECTABLE_TYPES.includes(t as DetectedSegmentType),
        );
        // An array naming nothing recognisable is a caller bug, not a request to
        // re-decide everything: silently widening it to the full scope would let
        // a typo retract segments the operator never asked about.
        if (types.length === 0) {
            throw new Error(
                `lumastra-intro-analyzer: segmentTypes named no known type (expected ${OPERATOR_SELECTABLE_TYPES.join(' or ')})`,
            );
        }
        return [...new Set(types)];
    }
    if (raw !== undefined) {
        throw new Error('lumastra-intro-analyzer: segmentTypes must be an array');
    }
    if (rawInput.outroOnly === true) return ['Outro'];
    return undefined;
}
// Bumped from 1 → 2 when adding Commercial detection, chromaprint-based credits
// detection, and anime preview-from-credits-end synthesis. Existing analyzed
// episodes are re-queued so they pick up the new segment types.
//
// Bumped 2 → 3 for the evidence model: detectors now emit candidates into
// `media_segment_candidates` and one ranked resolver materializes the winner,
// blackframe abstains instead of reporting its own window edge as a detection,
// untitled chapter marks became a first-class Outro signal, and every answer is
// re-judged by the plausibility gate. Those changes can alter EVERY stored
// segment — including retracting rows that were previously written with
// confidence — so an episode analysed under version 2 carries an answer this
// pipeline would not produce. Re-analysing the whole library is the point of
// the bump, not a side effect of it.
//
// Bumped 3 → 4 for frame-accurate high-black transitions, generic final
// chapter marks, and the short branded-tail fallback. These alter both the
// boundary and whether an Outro exists, so prior v3 evidence is stale.
// Detector provenance only: stamped onto candidate rows as `detectorVersion`
// and declared as the SDK manifest's processingVersion. Eligibility is gated by
// the per-stage versions below, NOT by this value.
export const PROCESSING_VERSION = 4;

/**
 * Stage identities for `media_item_stage_state`. The analyzer's detectors fall
 * into two groups with very different cost and scope, and versioning them
 * together means a cheap per-item detector change forces the expensive
 * season-level acoustic pass to re-run across the whole library.
 *
 *   visual   — chapter-title, chapter-mark, blackframe. Per item. ffprobe plus
 *              at most one luma decode.
 *   acoustic — chromaprint, cohort. Per season, and deliberately NOT split by
 *              segment type: one fingerprint pass yields both Intro and credits
 *              evidence, so a per-type split would double the cost.
 *
 * `resolveAndMaterialize` re-resolves from the whole candidate pool on every
 * write, so the two stages may complete in any order and at different times —
 * each write converges the materialized segment onto the best evidence
 * available. No barrier between them is needed.
 */
export const ANALYZER_VISUAL_STAGE_ID = `${PLUGIN_ID}:visual`;
export const ANALYZER_ACOUSTIC_STAGE_ID = `${PLUGIN_ID}:acoustic`;

/**
 * Bump when chapter or blackframe detection changes.
 *
 * 4 → 5: frame-accurate high-black transitions, generic final chapter marks and
 * the short branded-tail fallback (2026-08-17). These alter both the Outro
 * boundary and whether one exists at all, so prior visual evidence is stale.
 * The acoustic stage is untouched by that work and deliberately does NOT move —
 * re-fingerprinting the library would cost hours and change nothing.
 */
export const VISUAL_PROCESSING_VERSION = ANALYZER_VISUAL_VERSION;
/** Bump when chromaprint or cohort reconciliation changes. */
export const ACOUSTIC_PROCESSING_VERSION = ANALYZER_ACOUSTIC_VERSION;

/**
 * Methods a `manual` operator override lives under. Preserved by every delete
 * this task performs: an operator who wipes detector output asked to discard
 * what the DETECTORS decided, not to forget what a human told the system. Plan
 * §2 G8 / §4 Phase 6.
 */
const PRESERVED_METHODS: readonly DetectionMethod[] = ['manual'];

/**
 * Methods the per-item pass (`analyzeItem`) is the sole producer of. Ownership
 * is what drives the empty-set replacement rule: a detector that ran and found
 * nothing must still clear its previous candidates, or the resolver keeps
 * re-materializing the answer it just retracted. Ownership is therefore derived
 * from which detectors were ENABLED, never from what they happened to produce.
 */
export const CHAPTER_METHODS: readonly DetectionMethod[] = ['chapter-title', 'chapter-mark'];
const BLACKFRAME_METHODS: readonly DetectionMethod[] = ['blackframe'];
const CHROMAPRINT_METHODS: readonly DetectionMethod[] = ['chromaprint'];
const COHORT_METHODS: readonly DetectionMethod[] = ['cohort'];

/**
 * Season-cohort band and support threshold. Mirrors the constants chromaprint's
 * internal consensus uses (`CONSENSUS_*` in chromaprint.ts) so the two layers
 * agree on what "the season agrees" means; the cohort layer generalises the
 * idea across methods rather than replacing it.
 */
const COHORT_BAND_LO = 0.5;
const COHORT_BAND_HI = 2.0;
const COHORT_MIN_SUPPORT = 3;

// Poison-episode quarantine. A deterministically-failing episode (corrupt remux,
// an ffmpeg build that always segfaults on this file, an unreadable path) is
// CORRECTLY left un-`completed` on throw so it stays eligible and retries next
// drain — but with no upper bound it burns ffmpeg/CPU on EVERY 6h scheduled run
// forever, because `getUnanalyzedSeasons` only excludes `completed` episodes.
// After this many recorded failures (tracked in `plugin_failure_events`) we
// tombstone the episode `skipped_permanent` at the CURRENT PROCESSING_VERSION so
// the drain stops re-attempting it. A `PROCESSING_VERSION` bump, a manual rerun /
// wipe, or an `invalidateByEvent` content/identity change all re-eligibilize it
// (the eligibility queries scope the exclusion to `processing_version >=` current,
// so an old-version tombstone no longer blocks a bumped analyzer).
export const POISON_FAILURE_THRESHOLD = 5;

/**
 * Record a per-item analysis failure and, once an episode has failed
 * `POISON_FAILURE_THRESHOLD` times without ever completing, tombstone it
 * `skipped_permanent` so the scheduled drain stops re-attempting a poison episode
 * on every cycle. A successful analysis writes a `completed` row that removes the
 * episode from the candidate set, so the failure log only accrues for episodes
 * that never succeed — the cumulative count is a sound "consecutive failures"
 * proxy. The quarantine step is best-effort: a failure here just means the
 * episode keeps retrying (the pre-existing, unbounded behavior), never a crash.
 */
export async function recordFailureAndMaybeQuarantine(
    sql: postgres.Sql,
    logger: SdkLogger,
    episodeId: string,
    reason: string,
    // Quarantine is per detector group. A file whose container breaks the
    // visual detectors is not thereby unfingerprintable, and a season whose
    // chromaprint pass crashes must not tombstone chapter/blackframe evidence
    // that was produced successfully.
    stageId: string = ANALYZER_VISUAL_STAGE_ID,
    processingVersion: number = VISUAL_PROCESSING_VERSION,
    input?: AnalyzerInputSnapshot,
): Promise<void> {
    // Record and count against THIS stage. Sharing one counter meant acoustic
    // failures armed the visual threshold, so an episode could be tombstoned on
    // its first visual error.
    await recordFailure(
        sql,
        PLUGIN_ID,
        episodeId,
        reason,
        input?.runId ?? null,
        stageId,
        input ? { ...input, analysisStageId: stageId, processingVersion } : undefined,
    );
    try {
        const aggregates = await getFailureAggregates(sql, PLUGIN_ID, [episodeId], stageId, true);
        const failureCount = aggregates.get(episodeId)?.failure_count ?? 0;
        if (failureCount >= POISON_FAILURE_THRESHOLD) {
            await upsertSkippedPermanentRow(sql, {
                mediaItemId: episodeId,
                stageId,
                processingVersion,
                runId: input?.runId,
                skippedReason: `poison-episode: ${failureCount} failures without completion — last: ${reason.slice(0, 200)}`,
                // The item is only being re-attempted because its `completed` row no
                // longer covers the current input (replaced file, version bump).
                // Prod, 2026-11-02: that stale row made the tombstone a silent no-op
                // while the log said "Quarantined": one episode failed 24 times and
                // failed every drain run that touched its season.
                replaceCompleted: true,
            });
            logger.warn(
                `Quarantined poison episode ${episodeId} as skipped_permanent after ${failureCount} failures — ` +
                    `it will not be re-attempted until a processingVersion bump, manual rerun, or content invalidation`,
                { episodeId, failureCount },
            );
        }
    } catch (err) {
        logger.warn('Poison-episode quarantine check failed (non-fatal — episode stays eligible)', {
            episodeId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/** Failure provenance survives the throw and is checked under the same per-item
 * resolution lock used by content invalidation before any failure is persisted. */
class AnalysisDetectorFailure extends Error {
    constructor(
        readonly original: unknown,
        readonly input: Parameters<typeof analyzerInputStillCurrent>[2],
    ) {
        super(original instanceof Error ? original.message : String(original));
        this.name = 'AnalysisDetectorFailure';
    }
}
class AnalysisSeasonFailure extends Error {
    constructor(
        readonly original: unknown,
        readonly inputs: ReadonlyMap<string, EpisodeWithFile>,
    ) {
        super(original instanceof Error ? original.message : String(original));
        this.name = 'AnalysisSeasonFailure';
    }
}

function isStaleAnalysisFailure(err: unknown): boolean {
    return (
        err instanceof AnalysisInputChangedError ||
        err instanceof AnalysisInputUnverifiedError ||
        ((err instanceof AnalysisDetectorFailure || err instanceof AnalysisSeasonFailure) &&
            isStaleAnalysisFailure(err.original))
    );
}

class AnalysisInputUnavailableError extends Error {
    constructor() {
        super('No eligible local video file with a usable duration is available for analysis');
        this.name = 'AnalysisInputUnavailableError';
    }
}

class AnalysisInputChangedError extends Error {
    constructor() {
        super('Analysis input changed during analysis; retry with the current file');
        this.name = 'AnalysisInputChangedError';
    }
}

class AnalysisInputUnverifiedError extends Error {
    constructor() {
        super('Analysis input identity could not be verified; retry when the file is available');
        this.name = 'AnalysisInputUnverifiedError';
    }
}

class AnalysisCoolingDownError extends Error {
    constructor() {
        super('Analysis is cooling down after an FFmpeg timeout');
        this.name = 'AnalysisCoolingDownError';
    }
}

/**
 * True when a failure means "try again later" and says nothing about the file or
 * the detector: a timeout (backs off by design), a cooldown, an input that
 * changed or could not be verified, no eligible input yet, or a shutdown abort.
 * Looks through the detector/season wrappers.
 */
function isRetryLaterFailure(err: unknown): boolean {
    let cause = err;
    while (cause instanceof AnalysisDetectorFailure || cause instanceof AnalysisSeasonFailure)
        cause = cause.original;
    return (
        isStaleAnalysisFailure(cause) ||
        cause instanceof AnalysisCoolingDownError ||
        cause instanceof AnalysisInputUnavailableError ||
        isAbortError(cause) ||
        (cause instanceof FFmpegError && cause.timedOut)
    );
}

/** Queued jobs may predate a timeout. Restore their cooldown after the runner's
 * claim, so its success:false cleanup cannot reset the row to pending. */
export async function assertAnalysisRetryReady(sql: postgres.Sql, mediaId: string): Promise<void> {
    const cooling = await sql<{ media_item_id: string }[]>`
        UPDATE media_item_stage_state AS miss
           SET status = 'skipped_transient',
               declines = 0,
               declines_since = NULL,
               updated_at = now()
         WHERE media_item_id = ${mediaId}::uuid
           AND stage_id = ${ANALYZER_VISUAL_STAGE_ID}
           AND processing_version >= ${VISUAL_PROCESSING_VERSION}
           AND skipped_reason = ${ANALYSIS_TIMEOUT_REASON}
           AND next_eligible_at > now()
        AND ${analyzerStageEvidenceSql(sql)}
        RETURNING media_item_id
    `;
    if (cooling.length > 0) throw new AnalysisCoolingDownError();
}

/**
 * How `recordFailureByCause` routed a failure.
 *  - `recorded`: a real failure. Counted, and it can tombstone the episode.
 *  - `uncounted`: a timeout (visible in the timeline), or a queued item still cooling down.
 *  - `aborted`: the run was shut down or cancelled. Nothing is written.
 */
export type FailureCauseOutcome = 'recorded' | 'uncounted' | 'aborted';

/** True for an abort: the run's signal fired, or ffmpeg-spawn killed the process on abort. */
function isAbortError(err: unknown): boolean {
    if (err instanceof Error && err.name === 'AbortError') return true;
    return err instanceof FFmpegError && err.message.startsWith('FFmpeg aborted');
}

/**
 * Route a per-item failure by its cause. Only a real failure is a strike against
 * the episode.
 *
 * Prod, 2026-10-21: four in-flight items got a failure row in the same millisecond
 * at a deploy, when the run's abort signal killed their ffmpeg. Four episodes were
 * tombstoned `skipped_permanent` on those aborts alone. The black-frame pass has a
 * fixed 5-minute ffmpeg timeout that fires on 4K HEVC under load: 62 episodes were
 * quarantined that way while 192 other 4K episodes completed fine. Neither says
 * anything about the file.
 *
 * An abort writes nothing. A timeout is still written to `plugin_failure_events`
 * so it stays visible, but with NO stage. The quarantine count only looks at a
 * stage's own rows, so a timeout never counts toward the threshold, including
 * when real failures follow it. A later success still clears it:
 * `markFailureEventsResolved` also resolves legacy NULL-stage rows.
 */
export async function recordFailureByCause(
    sql: postgres.Sql,
    logger: SdkLogger,
    episodeId: string,
    err: unknown,
    opts: {
        reason: string;
        signal?: AbortSignal;
        stageId?: string;
        processingVersion?: number;
        input?: AnalyzerInputSnapshot;
    },
): Promise<FailureCauseOutcome> {
    if (
        err instanceof AnalysisCoolingDownError ||
        err instanceof AnalysisInputChangedError ||
        err instanceof AnalysisInputUnverifiedError
    )
        return 'uncounted';
    if (opts.signal?.aborted || isAbortError(err)) {
        logger.debug('Analysis interrupted by run shutdown — not recorded as an episode failure', {
            episodeId,
        });
        return 'aborted';
    }
    if (err instanceof AnalysisSeasonFailure) {
        const input = err.inputs.get(episodeId);
        if (!input) return 'uncounted';
        return recordFailureByCause(
            sql,
            logger,
            episodeId,
            new AnalysisDetectorFailure(err.original, input),
            opts,
        );
    }
    if (err instanceof AnalysisDetectorFailure) {
        const failure = err;
        return withTx(sql, async (tx) => {
            await acquireMediaSegmentResolutionLock(tx, episodeId);
            if (opts.signal?.aborted) return 'aborted';
            if (!(await analyzerInputStillCurrent(tx, episodeId, failure.input, logger)))
                return 'uncounted';
            return recordFailureByCause(tx, logger, episodeId, failure.original, {
                ...opts,
                input: failure.input as AnalyzerInputSnapshot,
            });
        });
    }
    if (err instanceof AnalysisInputUnavailableError) {
        // Eligibility absence is not evidence of damaged media. Keep an honest
        // history entry without permanently quarantining an unprobed input.
        await recordFailure(
            sql,
            PLUGIN_ID,
            episodeId,
            opts.reason,
            opts.input?.runId ?? null,
            null,
            opts.input
                ? {
                      ...opts.input,
                      analysisStageId: opts.stageId ?? ANALYZER_VISUAL_STAGE_ID,
                      processingVersion: opts.processingVersion ?? VISUAL_PROCESSING_VERSION,
                  }
                : undefined,
        );
        return 'uncounted';
    }
    if (err instanceof FFmpegError && err.timedOut) {
        await recordFailure(
            sql,
            PLUGIN_ID,
            episodeId,
            opts.reason,
            opts.input?.runId ?? null,
            null,
            opts.input
                ? {
                      ...opts.input,
                      analysisStageId: opts.stageId ?? ANALYZER_VISUAL_STAGE_ID,
                      processingVersion: opts.processingVersion ?? VISUAL_PROCESSING_VERSION,
                  }
                : undefined,
        );
        // A timeout is not evidence of a corrupt file. Persist a cooldown rather
        // than a strike, including when the acoustic stage has never had a row.
        const stageId = opts.stageId ?? ANALYZER_VISUAL_STAGE_ID;
        const processingVersion = opts.processingVersion ?? VISUAL_PROCESSING_VERSION;
        await sql`
            INSERT INTO media_item_stage_state (
                media_item_id, stage_id, processing_version, status, skipped_reason,
                next_eligible_at, updated_at, last_run_id
            ) VALUES (
                ${episodeId}::uuid, ${stageId}, ${processingVersion}, 'skipped_transient',
                ${ANALYSIS_TIMEOUT_REASON},
                now() + make_interval(secs => ${ANALYSIS_TIMEOUT_BACKOFF_MS / 1000}), now(), ${opts.input?.runId ?? null}
            )
            ON CONFLICT (media_item_id, stage_id) DO UPDATE
               SET status = 'skipped_transient',
                   last_run_id = COALESCE(EXCLUDED.last_run_id, media_item_stage_state.last_run_id),
                   processing_version = EXCLUDED.processing_version,
                   skipped_reason = EXCLUDED.skipped_reason,
                   next_eligible_at = EXCLUDED.next_eligible_at,
                   declines = 0,
                   declines_since = NULL,
                   updated_at = now()
        `;
        logger.warn(
            `Analysis timed out for ${episodeId} — recorded, not counted toward the poison-episode quarantine`,
            { episodeId, error: opts.reason },
        );
        return 'uncounted';
    }
    await recordFailureAndMaybeQuarantine(
        sql,
        logger,
        episodeId,
        opts.reason,
        opts.stageId,
        opts.processingVersion,
        opts.input,
    );
    return 'recorded';
}

// ============================================================================
// Settings
// ============================================================================

// Build the per-run config blocks from EffectiveConfig. These replace the
// stale module-level DEFAULT_*_CONFIG constants at call sites.

export function buildChapterConfig(cfg: EffectiveConfig): ChapterAnalyzerConfig {
    return {
        introPattern: DEFAULT_CHAPTER_CONFIG.introPattern,
        creditsPattern: DEFAULT_CHAPTER_CONFIG.creditsPattern,
        recapPattern: DEFAULT_CHAPTER_CONFIG.recapPattern,
        previewPattern: DEFAULT_CHAPTER_CONFIG.previewPattern,
        commercialPattern: DEFAULT_CHAPTER_CONFIG.commercialPattern,
        minDuration: cfg.minSegmentDuration,
        maxIntroDuration: cfg.maxIntroDuration,
        // The PLAUSIBLE bound, not the search window. The chapter analyzer is
        // deciding whether an answer is acceptable, and it has no search cost to
        // amortize — feeding it `maxCreditsDuration` (300s by default) made the
        // mark detector's own bound three times looser than the gate that judges
        // its output, so it emitted candidates only to have them dropped.
        maxCreditsDuration: cfg.maxPlausibleCreditsDuration,
        outroMinStartFraction: cfg.outroMinStartFraction,
    };
}

/** The invariants every candidate is judged against before it is stored or resolved. */
export function buildPlausibilityConfig(cfg: EffectiveConfig): PlausibilityConfig {
    return {
        minSegmentDuration: cfg.minSegmentDuration,
        maxIntroDuration: cfg.maxIntroDuration,
        introWindowMaxSec: cfg.introWindowMaxSec,
        maxPlausibleCreditsDuration: cfg.maxPlausibleCreditsDuration,
        maxPlausibleMovieCreditsDuration: cfg.maxPlausibleMovieCreditsDuration,
        outroMinStartFraction: cfg.outroMinStartFraction,
    };
}

/**
 * FNV-1a (32-bit). Chosen over a crypto digest because this is a provenance
 * LABEL, not a security boundary: it only has to answer "were these rows
 * produced under the same detector configuration?", and it must be cheap enough
 * to compute per run and short enough to eyeball in an admin table. No
 * dependency, no `node:crypto` import on a hot path.
 */
function fnv1a32(input: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        // The multiply is written out as shifts+adds because `hash * 16777619`
        // exceeds 2^53 and would silently lose the low bits in a float64.
        hash =
            (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return hash >>> 0;
}

/**
 * Stable hash over the fields that change what a detector ANSWERS (plan §2.5).
 *
 * Threaded onto every candidate write so "which rows were produced under
 * maxSearchDistance = 300" becomes a query instead of an archaeology exercise —
 * the 26 % Outro anomaly was unattributable precisely because nothing recorded
 * the configuration it was produced under.
 *
 * The key list is explicit rather than `JSON.stringify(cfg)` so that an
 * operational knob (batchSize, episodeConcurrency, ffmpegThreads) does not
 * invalidate the provenance of rows whose CONTENT it cannot affect.
 */
export function buildConfigHash(cfg: EffectiveConfig): string {
    const relevant = [
        cfg.chapterDetection,
        cfg.blackframeDetection,
        cfg.maxIntroDuration,
        cfg.maxCreditsDuration,
        cfg.maxMovieCreditsDuration,
        cfg.maxPlausibleCreditsDuration,
        cfg.maxPlausibleMovieCreditsDuration,
        cfg.outroMinStartFraction,
        cfg.snapToleranceSec,
        cfg.minSegmentDuration,
        cfg.maxPointDifferences,
        cfg.maxTimeSkip,
        cfg.introWindowFraction,
        cfg.introWindowMaxSec,
        cfg.invertedIndexShift,
    ];
    return fnv1a32(relevant.join('|')).toString(36);
}

function buildBlackframeConfig(cfg: EffectiveConfig): BlackFrameConfig {
    return {
        minCreditsDuration: cfg.minSegmentDuration,
        maxSearchDistance: cfg.maxCreditsDuration,
        maxMovieSearchDistance: cfg.maxMovieCreditsDuration,
        minimumBlackPct: DEFAULT_BLACKFRAME_CONFIG.minimumBlackPct,
        threshold: DEFAULT_BLACKFRAME_CONFIG.threshold,
        precision: DEFAULT_BLACKFRAME_CONFIG.precision,
        maxGapBuckets: DEFAULT_BLACKFRAME_CONFIG.maxGapBuckets,
    };
}

function buildChromaprintConfig(cfg: EffectiveConfig): ChromaprintConfig {
    return {
        maxPointDifferences: cfg.maxPointDifferences,
        maxTimeSkip: cfg.maxTimeSkip,
        minIntroDuration: cfg.minSegmentDuration,
        maxIntroDuration: cfg.maxIntroDuration,
        introWindowFraction: cfg.introWindowFraction,
        introWindowMaxSec: cfg.introWindowMaxSec,
        invertedIndexShift: cfg.invertedIndexShift,
    };
}

function buildChromaprintCreditsConfig(cfg: EffectiveConfig): ChromaprintConfig {
    // Credits-side chromaprint reuses the intro algorithm but with a credits-
    // sized maxDuration so legitimately-long credit rolls aren't truncated.
    return {
        maxPointDifferences: cfg.maxPointDifferences,
        maxTimeSkip: cfg.maxTimeSkip,
        minIntroDuration: cfg.minSegmentDuration,
        maxIntroDuration: cfg.maxCreditsDuration,
        introWindowFraction: cfg.introWindowFraction,
        introWindowMaxSec: cfg.maxCreditsDuration,
        invertedIndexShift: cfg.invertedIndexShift,
    };
}

// ============================================================================
// SQL helpers
// ============================================================================

const MOVIE_VISUAL_DISABLED_REASON = 'movie-visual-detection-disabled';

/** Match readTaskSettings: only the JSON boolean false disables a detector.
 * Read persisted settings inside the SQL fragment so every sweep observes a
 * settings change without a restart or a broad re-enrolment of completed work.
 */
function movieVisualDetectionEnabledSql(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`(
        NOT EXISTS (
            SELECT 1 FROM plugin_settings
            WHERE plugin_id = ${PLUGIN_ID} AND key = 'chapterDetection' AND value = 'false'::jsonb
        )
        OR NOT EXISTS (
            SELECT 1 FROM plugin_settings
            WHERE plugin_id = ${PLUGIN_ID} AND key = 'blackframeDetection' AND value = 'false'::jsonb
        )
    )`;
}

async function analyzerInputStillCurrent(
    tx: postgres.Sql,
    mediaId: string,
    input: {
        durationSeconds: number | null;
        fileId?: string;
        filePath: string | null;
        fileGeneration?: string;
        mediaGeneration?: string;
        globalGeneration?: string | null;
        inputIdentity?: string;
        physicalIdentity?: string;
        runId?: string;
    },
    // Optional so the callers that report the outcome themselves stay quiet.
    // Everywhere else this is the ONLY record that a write was dropped.
    logger?: SdkLogger,
): Promise<boolean> {
    // Tests and third-party callers may construct EpisodeWithFile manually.
    // Production snapshots always carry every per-item fence field.
    if (!input.fileId || !input.fileGeneration || !input.mediaGeneration) return true;
    const current = await getAnalyzerInputSnapshot(tx, mediaId);
    if (input.physicalIdentity && input.filePath) {
        try {
            if (
                physicalIdentity(await safeStatBigInt(input.filePath, 5000)) !==
                input.physicalIdentity
            )
                return false;
        } catch {
            return false;
        }
    }

    // Two different things used to look identical here, and both returned a
    // bare `false` that the season passes swallowed without a word.
    //
    // A null snapshot is NOT a race: the item does not meet the analyzer's own
    // input requirements (present non-missing file, probed video stream,
    // runtime over 60s, not deleted). The season cohort query deliberately
    // applies a WEAKER filter — an episode still contributes its fingerprint to
    // the cohort consensus even when its own segments cannot be judged — so
    // this outcome is expected and must be legible rather than invisible.
    if (current === null) {
        logger?.info(
            `[intro-analyzer] no write for ${mediaId}: item does not meet the analyzer input requirements`,
            { mediaId, reason: 'ineligible-input' },
        );
        return false;
    }

    const unchanged =
        current.fileId === input.fileId &&
        current.filePath === input.filePath &&
        current.durationSeconds === input.durationSeconds &&
        current.fileGeneration === input.fileGeneration &&
        current.mediaGeneration === input.mediaGeneration &&
        current.globalGeneration === (input.globalGeneration ?? null) &&
        (!input.inputIdentity || current.inputIdentity === input.inputIdentity);

    if (!unchanged) {
        logger?.info(
            `[intro-analyzer] no write for ${mediaId}: input changed while the detectors ran`,
            { mediaId, reason: 'input-changed' },
        );
    }
    return unchanged;
}

/**
 * True when this item is ONE episode inside a file that holds several
 * (`media_file_items.start_offset_ms` / `end_offset_ms`, migration 16.152.0 —
 * S02E24E25 stays one video).
 *
 * The analyzer works in file-absolute time against FILE duration, so for such an
 * item every tail-anchored claim is about the wrong episode: the last chapter
 * mark bounds the LAST episode's credits, the black run before EOF is the LAST
 * episode's fade, and `start / duration >= 0.80` rejects the correct mid-file
 * answer while accepting the wrong end-of-file one. Blackframe already had this
 * defect; the chapter-mark detector must not systematically add a second,
 * higher-confidence wrong answer on top of it. Intro-side detection is
 * unaffected — the head of a combined file really is the first episode's head.
 */
async function isMultiEpisodeFileItem(
    sql: postgres.Sql,
    mediaId: string,
    fileId: string,
): Promise<boolean> {
    const rows = await sql<Array<{ combined: boolean }>>`
        SELECT EXISTS (
            SELECT 1
              FROM media_file_items mfi
             WHERE mfi.media_item_id = ${mediaId} AND mfi.file_id = ${fileId}
               AND (mfi.start_offset_ms IS NOT NULL OR mfi.end_offset_ms IS NOT NULL)
        ) AS combined
    `;
    return rows[0]?.combined === true;
}

/**
 * Set-based counterpart of `isMultiEpisodeFileItem` for the season passes.
 *
 * The per-item guard is not enough on its own: the chromaprint cohort derives
 * its credits window purely from `media_files.duration_seconds`, so two episodes
 * sharing one physical file get the SAME window and fingerprint the identical
 * audio. They then match each other perfectly and both receive the same absolute
 * Outro — correct for the last episode in the file, confidently wrong for the
 * others, and at rank 20 it outranks everything the per-item guard excluded.
 */
async function getCombinedFileEpisodeIds(
    _sql: postgres.Sql,
    episodes: readonly EpisodeWithFile[],
): Promise<Set<string>> {
    // Production episodes carry the selected input's logical window. Other
    // editions cannot suppress detection on the version this pass is reading.
    return new Set(
        episodes
            .filter((episode) => episode.startOffsetMs != null || episode.endOffsetMs != null)
            .map((episode) => episode.episodeId),
    );
}

async function getEpisodesWithFilesForSeason(
    sql: postgres.Sql,
    seasonId: string,
): Promise<EpisodeWithFile[]> {
    return sql<EpisodeWithFile[]>`
        SELECT DISTINCT ON (ep.id)
            ep.id AS "episodeId",
            ep.title,
            ep.season_number AS "seasonNumber",
            ep.episode_number AS "episodeNumber",
            mf.file_path AS "filePath",
            mf.duration_seconds AS "durationSeconds",
            mf.id AS "fileId",
            ${analyzerFileGenerationSql(sql)} AS "fileGeneration",
            ${analyzerMediaGenerationSql(sql, 'ep')} AS "mediaGeneration",
            (
                SELECT value #>> '{}'
                FROM plugin_settings
                WHERE plugin_id = ${PLUGIN_ID}
                  AND key = '__media_segment_generation'
            ) AS "globalGeneration"
        FROM media_items ep
        JOIN media_file_items mfi ON mfi.media_item_id = ep.id
        JOIN media_files mf ON mf.id = mfi.file_id
        WHERE ep.parent_id = ${seasonId}
          AND ep.media_type = 'episode' AND ep.status <> 'deleted'
          AND ${analyzableVideoFileSql(sql)}
          -- Aligned with the write fence (getAnalyzerInputSnapshot) for the
          -- two predicates that describe an UNREADABLE row: a deleted item and
          -- a file flagged missing. Fingerprinting either is pure waste — the
          -- ffmpeg read fails or the item is on its way out — and a stale
          -- fingerprint from one would skew the cohort consensus for its
          -- siblings.
          AND ep.status <> 'deleted'
          AND ${analyzableVideoFileSql(sql)}
        -- is_default FIRST: an episode can link several files (alternate
        -- versions, or a combined multi-episode file the scanner range-linked),
        -- and only the is_default row is "this episode's file". part_number is
        -- NULL for every plain file, so on its own the DISTINCT ON tie-break
        -- picked an arbitrary link — handing the cohort another episode's video
        -- and, with it, the wrong duration. Every window here is duration-
        -- relative (introWindowFraction, the credits tail), so a wrong duration
        -- silently mis-frames both detectors: Hafentage S6 got intro/outro offsets
        -- bounded by a 344s file for episodes whose own files run 401-633s.
        ORDER BY ep.id, mfi.is_default DESC, mf.part_number NULLS FIRST, mf.id, ep.sort_order NULLS LAST, ep.episode_number NULLS LAST
    `;
}

/**
 * Stability window for the season-scan gate. Chromaprint accuracy improves
 * with more episodes in the cohort; running a season-level pass for every
 * single episode as it arrives during an initial library scan is wasted
 * ffmpeg cost. Wait until the season's newest file is at least this many
 * milliseconds old before analysing.
 *
 * 30 minutes is a sensible default: typical library scans complete a
 * season in under 10 min, so a 30-min wait covers the burst and leaves
 * comfortable margin. Late-arriving episodes (months after stability)
 * still trigger a re-analysis, the gate just delays it by 30 min so the
 * episode count is stable.
 */
const SEASON_SCAN_STABILITY_MS = 30 * 60 * 1000;

/**
 * Returns the freshest media_files.created_at / file_mtime / updated_at
 * across all files linked to episodes in this season. Used by the
 * stability gate — if any signal is fresh, defer the analysis.
 *
 * We OR together three timestamps to catch:
 *   - created_at: new file just attached (initial scan or backfill)
 *   - file_mtime: on-disk content changed (scanner re-probe target)
 *   - updated_at: any DB-level mutation (re-probe, re-link, hash update)
 *
 * False positives (over-eager defers) cost only one extra 30-min wait —
 * the analysis is idempotent and re-runs against the same season produce
 * identical results, so over-deferring is strictly better than
 * under-deferring.
 */
async function getSeasonScanFreshness(sql: postgres.Sql, seasonId: string): Promise<Date | null> {
    const rows = await sql<{ freshest: Date | null }[]>`
        SELECT MAX(GREATEST(
            mf.created_at,
            COALESCE(mf.file_mtime, mf.created_at),
            mf.updated_at
        )) AS freshest
          FROM media_items ep
          JOIN media_file_items mfi ON mfi.media_item_id = ep.id
          JOIN media_files mf ON mf.id = mfi.file_id
         WHERE ep.parent_id = ${seasonId}
           AND ep.media_type = 'episode' AND ep.status <> 'deleted'
    `;
    return rows[0]?.freshest ?? null;
}

/** Skip reason written on every deferred stage row. getUnanalyzedSeasons keys on it. */
const SEASON_DEFER_REASON = 'season-scan-not-yet-stable';

/**
 * Mark every pending lumastra-intro-analyzer stage_state row for episodes
 * in this season as `skipped_transient` with a retry-after = the
 * stability deadline. Stage-sweep won't re-enqueue these episodes until
 * the deadline passes; the next attempt then sees a stable season and
 * runs the full analysis.
 *
 * Marking the batch (rather than just the triggering episode) prevents
 * stage-sweep from firing N concurrent runs that each individually
 * defer — efficient cancellation of the entire season's pending queue
 * in one UPDATE.
 */
/**
 * Defer every file-bearing episode of the season on BOTH detector stages until
 * `until`, and return the number of rows written.
 *
 * This INSERTs rows that do not exist yet, rather than only updating pending
 * ones. The acoustic stage is never seeded (its eligibility is row absence), so a
 * fresh season has no acoustic row to update; without an inserted row the season
 * would stay eligible and be handed straight back by the next slice. Rows already
 * resolved at the current version are left untouched.
 */
async function deferSeasonAnalysisUntil(
    sql: postgres.Sql,
    seasonId: string,
    until: Date,
    logger: SdkLogger,
): Promise<void> {
    const rows = await sql<Array<{ media_item_id: string }>>`
        INSERT INTO media_item_stage_state (
            media_item_id, stage_id, processing_version, status, skipped_reason,
            next_eligible_at, declines, declines_since, updated_at
        )
        SELECT ep.id, st.stage_id, st.processing_version, 'skipped_transient', ${SEASON_DEFER_REASON},
               ${until}, 0, NULL, now()
          FROM media_items ep
          CROSS JOIN unnest(
              ${[ANALYZER_VISUAL_STAGE_ID, ANALYZER_ACOUSTIC_STAGE_ID]}::text[],
              ${[VISUAL_PROCESSING_VERSION, ACOUSTIC_PROCESSING_VERSION]}::int[]
          ) AS st(stage_id, processing_version)
         WHERE ep.parent_id = ${seasonId}::uuid
           AND ep.media_type = 'episode' AND ep.status <> 'deleted'
           AND EXISTS (
               SELECT 1 FROM media_file_items mfi
                 JOIN media_files mf ON mf.id = mfi.file_id
                WHERE mfi.media_item_id = ep.id AND ${analyzableVideoFileSql(sql)}
           )
        ON CONFLICT (media_item_id, stage_id) DO UPDATE
           SET status = 'skipped_transient',
               skipped_reason = EXCLUDED.skipped_reason,
               next_eligible_at = EXCLUDED.next_eligible_at,
               declines = 0,
               declines_since = NULL,
               updated_at = now()
         WHERE media_item_stage_state.status IN ('pending', 'failed_transient', 'skipped_transient')
            OR media_item_stage_state.processing_version < EXCLUDED.processing_version
        RETURNING media_item_id
    `;
    if (rows.length > 0) {
        logger.info('Deferred season chromaprint analysis until scan settles', {
            seasonId,
            until: until.toISOString(),
            rowsDeferred: rows.length,
        });
    }
}

/**
 * The stability gate for a season's fingerprint pass. Returns true when the season
 * is quiet enough to analyse. Otherwise it defers the season and returns false, and
 * the caller must mark neither stage for it.
 *
 * Visual-only staleness does not come through here: per-episode detectors do not
 * need the whole cohort, so they are not held back.
 */
async function seasonStableOrDefer(
    sql: postgres.Sql,
    seasonId: string,
    logger: SdkLogger,
): Promise<boolean> {
    const freshest = await getSeasonScanFreshness(sql, seasonId);
    if (!freshest) return true;
    const ageMs = Date.now() - freshest.getTime();
    if (ageMs >= SEASON_SCAN_STABILITY_MS) return true;

    const until = new Date(freshest.getTime() + SEASON_SCAN_STABILITY_MS);
    await deferSeasonAnalysisUntil(sql, seasonId, until, logger).catch((err) => {
        logger.warn('Failed to defer season analysis — handler will retry on next sweep', {
            seasonId,
            err: err instanceof Error ? err.message : String(err),
        });
    });
    return false;
}

/**
 * Seasons with work outstanding on EITHER detector stage.
 *
 * The two stages are reported separately so the drain can run only what is
 * actually stale. Without that, bumping the cheap visual version would still
 * re-run the expensive season-level fingerprint pass for every season — the
 * exact coupling the stage split exists to remove.
 */
// Exported for the season-deferral suite, which drives the drain's slice selection
// directly against a real database.
export async function getUnanalyzedSeasons(
    sql: postgres.Sql,
    visualStageId: string,
    visualVersion: number,
    acousticStageId: string,
    acousticVersion: number,
    // When chromaprint is disabled the acoustic pass cannot run, so an acoustic
    // row is never written. Counting that stage as outstanding would keep those
    // seasons permanently eligible: they would pin the head of the ORDER BY +
    // LIMIT slice, and because the scheduled drain runs in `catchup` mode (one
    // slice, then break) every season past the first batch would never be
    // reached again. Dropping the term instead of marking the stage keeps the
    // work pending for a future run with chromaprint switched back on.
    acousticEnabled: boolean,
    limit: number,
    visualEnabled = true,
    inspectedInputs: ReadonlyMap<string, string> = new Map(),
): Promise<
    Array<{
        seasonId: string;
        seriesId: string;
        episodeCount: number;
        visualStale: boolean;
        acousticStale: boolean;
    }>
> {
    return sql<
        Array<{
            seasonId: string;
            seriesId: string;
            episodeCount: number;
            visualStale: boolean;
            acousticStale: boolean;
        }>
    >`
        -- MATERIALIZED so visualStale/acousticStale (each a NOT EXISTS
        -- correlated per episode row) are computed ONCE per season here, not
        -- twice — once for the SELECT list, once again for the equivalent
        -- HAVING condition. Without the barrier the planner freely inlines
        -- this CTE and reconstructs the exact same duplicated-subplan shape
        -- the old single-query form had (verified on prod: an inlined
        -- rewrite with the filter moved to an outer WHERE still produced 4
        -- subplans, not 2). Each NOT EXISTS is 51,607 index-only probes
        -- against media_item_stage_state's PK on prod, so the duplication
        -- was ~half the query's cost (prod slow-query log, 2026-09-26: 7
        -- calls/4.3h, p50 741ms; 730ms in a prod EXPLAIN with 4 subplans vs
        -- 555ms with 2 — ~1.3x, output byte-for-byte identical in a prod
        -- comparison run with a permissive processing_version).
        WITH sub AS MATERIALIZED (
            SELECT
                season.id AS "seasonId",
                season.parent_id AS "seriesId",
                COUNT(ep.id)::int AS "episodeCount",
                -- 'completed' OR 'skipped_permanent' both count as resolved:
                -- skipped_permanent is the poison-episode tombstone, so a
                -- deterministically-failing episode stops keeping its season in the
                -- drain forever. Version-scoped so a bump re-eligibilizes an
                -- old-version tombstone.
                COUNT(ep.id) FILTER (
                    WHERE ${analyzerUninspectedInputSql(sql, sql`ep.id`, inspectedInputs)} AND NOT EXISTS (
                        SELECT 1 FROM media_item_stage_state miss
                        WHERE miss.stage_id = ${visualStageId}
                          AND miss.media_item_id = ep.id
                          AND miss.status IN ('completed', 'skipped_permanent')
                          AND ${analyzerStageEvidenceSql(sql, 'miss', sql`ident.identity`)}
                          AND miss.processing_version >= ${visualVersion}
                    )
                ) > 0 AND ${visualEnabled} AS "visualStale",
                COUNT(ep.id) FILTER (
                    WHERE ${analyzerUninspectedInputSql(sql, sql`ep.id`, inspectedInputs)} AND NOT EXISTS (
                        SELECT 1 FROM media_item_stage_state miss
                        WHERE miss.stage_id = ${acousticStageId}
                          AND miss.media_item_id = ep.id
                          AND miss.status IN ('completed', 'skipped_permanent')
                          AND ${analyzerStageEvidenceSql(sql, 'miss', sql`ident.identity`)}
                          AND miss.processing_version >= ${acousticVersion}
                    )
                ) > 0 AND ${acousticEnabled} AS "acousticStale"
            FROM media_items season
            JOIN media_items ep ON ep.parent_id = season.id AND ep.media_type = 'episode' AND ep.status <> 'deleted'
            -- The current input identity of the episode, computed ONCE here. Both stage
            -- predicates compare against it; inlined, each stage re-ran the six-table
            -- identity subplan per episode (2 x 53k on prod, ~1 s of a 3.2 s call).
            -- OFFSET 0 stops the planner pulling the subquery back into the predicates.
            CROSS JOIN LATERAL (
                SELECT ${currentAnalyzerInputIdentitySql(sql, sql`ep.id`)} AS identity OFFSET 0
            ) ident
            WHERE season.media_type = 'season' AND ${analyzerLiveAncestrySql(sql, 'season')}
              AND (season.season_number IS NULL OR season.season_number != 0)
              AND EXISTS (
                  SELECT 1 FROM media_file_items mfi
                  JOIN media_files mf ON mf.id = mfi.file_id
                  WHERE mfi.media_item_id = ep.id AND ${analyzableVideoFileSql(sql)}
              )
              -- A season deferred for stability is withheld until its deadline.
              -- Left eligible, it would sit at the head of the ORDER BY slice: the
              -- catchup drain runs one slice per run, so every later season would
              -- wait behind a season it cannot yet analyse. After the deadline the
              -- rows are no longer excluded, and the season is analysed.
              AND NOT EXISTS (
                  SELECT 1
                    FROM media_items dep
                    JOIN media_item_stage_state dss ON dss.media_item_id = dep.id
                   WHERE dep.parent_id = season.id
                     AND dep.media_type = 'episode'
                     AND dss.stage_id = ANY(${[visualStageId, acousticStageId]}::text[])
                     AND dss.status = 'skipped_transient'
                     AND dss.skipped_reason IN (${SEASON_DEFER_REASON}, ${ANALYSIS_TIMEOUT_REASON})
                     AND dss.next_eligible_at > now()
                     AND ${analyzerStageEvidenceSql(sql, 'dss')}
              )
            GROUP BY season.id, season.parent_id
        )
        SELECT "seasonId", "seriesId", "episodeCount", "visualStale", "acousticStale"
        FROM sub
        WHERE "episodeCount" >= 2
          AND ("visualStale" OR "acousticStale")
        ORDER BY "seriesId", "seasonId"
        LIMIT ${limit}
    `;
}

/**
 * Single-episode seasons can't run chromaprint (no cohort) but still benefit
 * from chapter + blackframe analysis. Returns the lone episode id per season
 * that has not been analysed yet. Excludes specials (season 0).
 */
async function getUnanalyzedSingleEpisodeSeasonEpisodes(
    sql: postgres.Sql,
    source: string,
    processingVersion: number,
    limit: number,
    inspectedInputs: ReadonlyMap<string, string> = new Map(),
): Promise<Array<{ episodeId: string; seasonId: string }>> {
    // `season_stats` used to LEFT JOIN every episode of every season and test
    // "has a file" via a correlated EXISTS per episode row (~80,700 probes on
    // prod, each a nested-loop index lookup) just to find the handful of
    // seasons with exactly one file-bearing episode. Rewritten to INNER JOIN
    // media_file_items/media_files directly — COUNT(DISTINCT ep.id), not
    // COUNT(ep.id), because an episode can back more than one
    // media_file_items row (a combined multi-episode release) and the INNER
    // JOIN now fans those out, where the old EXISTS never could (prod
    // slow-query log, 2026-09-26: 7 calls/4.3h, p50 400ms; 523ms in a prod
    // EXPLAIN vs 249ms rewritten — ~2.1x, output byte-for-byte identical in a
    // prod comparison run with a permissive processingVersion).
    return sql<Array<{ episodeId: string; seasonId: string }>>`
        WITH season_stats AS (
            SELECT
                season.id AS season_id,
                COUNT(DISTINCT ep.id)::int AS episode_count
            FROM media_items season
            JOIN media_items ep ON ep.parent_id = season.id AND ep.media_type = 'episode' AND ep.status <> 'deleted'
            JOIN media_file_items mfi ON mfi.media_item_id = ep.id
            JOIN media_files mf ON mf.id = mfi.file_id AND ${analyzableVideoFileSql(sql)}
            WHERE season.media_type = 'season' AND ${analyzerLiveAncestrySql(sql, 'season')}
              AND (season.season_number IS NULL OR season.season_number != 0)
            GROUP BY season.id
        )
        SELECT DISTINCT ep.id AS "episodeId", season.id AS "seasonId", season.parent_id
        FROM media_items season
        JOIN season_stats ss ON ss.season_id = season.id AND ss.episode_count = 1
        JOIN media_items ep ON ep.parent_id = season.id AND ep.media_type = 'episode' AND ep.status <> 'deleted'
        JOIN media_file_items mfi ON mfi.media_item_id = ep.id
        JOIN media_files mf ON mf.id = mfi.file_id
        WHERE ${analyzableVideoFileSql(sql)}
          AND ${analyzerUninspectedInputSql(sql, sql`ep.id`, inspectedInputs)}
          AND NOT EXISTS (
              -- resolved = completed OR poison-quarantined (skipped_permanent),
              -- version-scoped (see getUnanalyzedSeasons).
              SELECT 1 FROM media_item_stage_state miss
              WHERE miss.stage_id = ${source}
                AND miss.media_item_id = ep.id
                AND (miss.status IN ('completed', 'skipped_permanent')
                     OR miss.next_eligible_at > now())
                AND ${analyzerStageEvidenceSql(sql)}
                          AND miss.processing_version >= ${processingVersion}
          )
        ORDER BY season.parent_id, season.id
        LIMIT ${limit}
    `;
}

/**
 * Films that still need the visual pass. Films have no season cohort, so they never
 * get the acoustic stage: their eligibility is row absence on the visual stage, as
 * it is for the single-episode fallback.
 *
 * The file predicates mirror the input fence in getAnalyzerInputSnapshot exactly
 * (present, not missing, duration over 60s, a probed video stream). A film that
 * passes here but fails the fence would be selected on every run and never
 * completed.
 */
// Exported for the movie visual-backlog suite.
export async function getUnanalyzedMovies(
    sql: postgres.Sql,
    visualStageId: string,
    visualVersion: number,
    limit: number,
    inspectedInputs: ReadonlyMap<string, string> = new Map(),
): Promise<Array<{ mediaId: string }>> {
    return sql<Array<{ mediaId: string }>>`
        SELECT mi.id AS "mediaId"
          FROM media_items mi
         WHERE mi.media_type = 'movie' AND ${analyzerUninspectedInputSql(sql, sql`mi.id`, inspectedInputs)}
           AND mi.status <> 'deleted'
           AND EXISTS (
               SELECT 1
                 FROM media_file_items mfi
                 JOIN media_files mf ON mf.id = mfi.file_id
                WHERE mfi.media_item_id = mi.id
                  AND ${analyzableVideoFileSql(sql)}
           )
           AND NOT EXISTS (
               -- resolved = completed OR poison-quarantined, version-scoped (see
               -- getUnanalyzedSeasons).
               SELECT 1 FROM media_item_stage_state miss
                WHERE miss.stage_id = ${visualStageId}
                  AND miss.media_item_id = mi.id
                  AND (miss.status IN ('completed', 'skipped_permanent')
                     OR miss.next_eligible_at > now())
                  AND ${analyzerStageEvidenceSql(sql)}
                          AND miss.processing_version >= ${visualVersion}
           )
         ORDER BY mi.id
         LIMIT ${limit}
    `;
}

async function countBacklog(
    sql: postgres.Sql,
    source: string,
    processingVersion: number,
): Promise<{
    analyzed: number;
    remaining: number;
    ineligible: number;
    etaMs: number | undefined;
}> {
    const [row] = await sql<
        Array<{
            eligible: number;
            remaining: number;
            ineligible: number;
            remaining_episodes: number;
        }>
    >`
        WITH season_stats AS (
            SELECT
                season.id AS season_id,
                COUNT(ep.id) FILTER (
                    WHERE EXISTS (
                        SELECT 1 FROM media_file_items mfi
                        JOIN media_files mf ON mf.id = mfi.file_id
                        WHERE mfi.media_item_id = ep.id AND ${analyzableVideoFileSql(sql)}
                    )
                )::int AS episode_count,
                COUNT(ep.id) FILTER (
                    WHERE NOT EXISTS (
                        -- resolved = completed OR poison-quarantined
                        -- (skipped_permanent), version-scoped, keeping remaining
                        -- consistent with getUnanalyzedSeasons so a fully-quarantined
                        -- season is not reported as perpetually remaining.
                        SELECT 1 FROM media_item_stage_state miss
                        WHERE miss.stage_id = ${source}
                          AND miss.media_item_id = ep.id
                          AND miss.status IN ('completed', 'skipped_permanent')
                          AND ${analyzerStageEvidenceSql(sql)}
                          AND miss.processing_version >= ${processingVersion}
                    )
                    AND EXISTS (
                        SELECT 1 FROM media_file_items mfi
                        JOIN media_files mf ON mf.id = mfi.file_id
                        WHERE mfi.media_item_id = ep.id AND ${analyzableVideoFileSql(sql)}
                    )
                )::int AS unanalyzed_count
            FROM media_items season
            LEFT JOIN media_items ep ON ep.parent_id = season.id AND ep.media_type = 'episode' AND ep.status <> 'deleted'
            WHERE season.media_type = 'season' AND ${analyzerLiveAncestrySql(sql, 'season')}
              AND (season.season_number IS NULL OR season.season_number != 0)
            GROUP BY season.id
        )
        SELECT
            COUNT(*) FILTER (WHERE episode_count >= 2)::int AS eligible,
            COUNT(*) FILTER (WHERE episode_count >= 2 AND unanalyzed_count > 0)::int AS remaining,
            COUNT(*) FILTER (WHERE episode_count > 0 AND episode_count < 2)::int AS ineligible,
            COALESCE(SUM(unanalyzed_count) FILTER (WHERE episode_count >= 2), 0)::int AS remaining_episodes
        FROM season_stats
    `;
    const eligible = row?.eligible ?? 0;
    const remaining = row?.remaining ?? 0;
    const remainingEpisodes = row?.remaining_episodes ?? 0;

    // Rate is sourced from the coverage table so it stays consistent with the
    // eligibility queries above (and with how markAnalyzed writes completion).
    const [rateRow] = await sql<Array<{ recent_episodes: number }>>`
        SELECT COUNT(*)::int AS recent_episodes
        FROM media_item_stage_state
        WHERE stage_id = ${source}
          AND status = 'completed'
          AND processing_version >= ${processingVersion}
          AND completed_at > NOW() - INTERVAL '30 minutes'
    `;
    const recentEpisodes = rateRow?.recent_episodes ?? 0;
    const etaMs =
        remainingEpisodes > 0 && recentEpisodes > 0
            ? Math.round((remainingEpisodes / recentEpisodes) * 30 * 60 * 1000)
            : undefined;

    return {
        analyzed: Math.max(0, eligible - remaining),
        remaining,
        ineligible: row?.ineligible ?? 0,
        etaMs,
    };
}

export async function markAnalyzed(
    sql: postgres.Sql,
    mediaIds: string[],
    stageId: string,
    processingVersion: number,
    proofs: ReadonlyMap<string, AnalyzerInputSnapshot> = new Map(),
    scope: SegmentScope = FULL_SCOPE,
): Promise<string[]> {
    const completed: string[] = [];
    for (const mediaId of mediaIds) {
        const input = proofs.get(mediaId);
        if (!input?.inputIdentity) continue;
        await withTx(sql, async (tx) => {
            await acquireMediaSegmentResolutionLock(tx, mediaId);
            if (!(await analyzerInputStillCurrent(tx, mediaId, input))) return;
            const fullCoverage =
                !scope.visualOnly &&
                MATERIALIZED_SEGMENT_TYPES.every((type) => scope.types.includes(type));
            if (fullCoverage) {
                await upsertCompletedRow(tx, {
                    mediaItemId: mediaId,
                    stageId,
                    processingVersion,
                    runId: input.runId ?? scope.runId,
                });
            }
            await tx`
                INSERT INTO media_segment_analysis_passes
                    (media_id, file_id, input_identity, stage_id, run_id, segment_types, processing_version, coverage_complete, segments_count)
                SELECT ${mediaId}::uuid, ${input.fileId}::uuid, ${input.inputIdentity},
                       ${stageId}, ${input.runId ?? scope.runId ?? null}, ${[...scope.types]}::text[], ${processingVersion}, ${fullCoverage}, COUNT(*)::int
                  FROM media_segments
                 WHERE media_id = ${mediaId}::uuid AND source = ${PLUGIN_ID}
                   AND type = ANY(${[...scope.types]}::text[])
            `;
            await markFailureEventsResolved(tx, PLUGIN_ID, mediaId, stageId, input.inputIdentity);
            completed.push(mediaId);
        });
        if (completed.includes(mediaId)) scope.onCompleted?.(mediaId);
    }
    if (stageId === ANALYZER_ACOUSTIC_STAGE_ID && completed.length > 0) {
        const seasons = [
            ...new Set(
                completed
                    .map((id) => proofs.get(id)?.parentId)
                    .filter((id): id is string => typeof id === 'string'),
            ),
        ];
        if (seasons.length) await pruneCompletedSeasonFingerprints(sql, seasons);
    }
    return completed;
}

/**
 * Operator-requested library-wide re-run of the visual detectors.
 *
 * Deleting the visual stage rows makes every episode eligible again for the
 * ordinary drain, which runs the COMPLETE visual detector set and re-resolves
 * against the acoustic evidence that stage never touches. The acoustic rows are
 * deliberately left alone, so the expensive season-level fingerprint pass is
 * skipped for every season that is still current.
 */
export async function rewindVisualStage(sql: postgres.Sql): Promise<number> {
    const deleted = await sql`
        DELETE FROM media_item_stage_state
        WHERE stage_id = ${ANALYZER_VISUAL_STAGE_ID}
        RETURNING media_item_id
    `;
    return deleted.length;
}

async function wipeAll(sql: postgres.Sql, logger: SdkLogger): Promise<void> {
    await withTx(sql, async (tx) => {
        // The exclusive gate must precede the snapshot. Every per-item writer
        // takes its shared counterpart before item locks, so no first evidence
        // row can appear between this snapshot and the deletes below.
        await acquireExclusiveMediaSegmentWriteGate(tx);
        await bumpGlobalMediaSegmentAnalysisGeneration(tx);
        const affectedRows = await tx<Array<{ mediaId: string }>>`
            SELECT media_id AS "mediaId"
            FROM media_segments
            WHERE source = ${PLUGIN_ID}
            UNION
            SELECT media_id AS "mediaId"
            FROM media_segment_candidates
            WHERE method <> ALL(${[...PRESERVED_METHODS]}::text[])
            ORDER BY "mediaId"
        `;
        const affectedIds = affectedRows.map((row) => row.mediaId);

        // Evidence goes with the answers it produced — otherwise the very next
        // resolution silently restores exactly what the wipe just cleared. The
        // `manual` override survives: it is a human answer, and re-resolution
        // restoring it is the intended behaviour, not a leak.
        await tx`
            DELETE FROM media_segment_candidates
            WHERE media_id = ANY(${affectedIds}::uuid[])
              AND method <> ALL(${[...PRESERVED_METHODS]}::text[])
        `;
        await tx`
            DELETE FROM media_segments
            WHERE media_id = ANY(${affectedIds}::uuid[])
              AND source = ${PLUGIN_ID}
        `;
        await tx`DELETE FROM media_item_stage_state WHERE stage_id = ANY(${[ANALYZER_VISUAL_STAGE_ID, ANALYZER_ACOUSTIC_STAGE_ID]}::text[])`;
        await tx`DELETE FROM media_segment_fingerprints`;
    });
    logger.info('All lumastra-intro-analyzer segments, candidates and stage-state rows wiped');
}

// ============================================================================
// Per-item analysis
// ============================================================================

/**
 * Turn a detector's output into candidate write payloads, keyed by the method
 * that produced them.
 *
 * `MediaSegmentCandidateInput` carries no `method` on purpose — it is supplied
 * once per `replaceCandidatesForMethod` call, because a replace is scoped to
 * exactly one method and letting individual rows disagree would make the delete
 * half of the replace unsound. Grouping here is what enforces that.
 */
export function groupCandidatesByMethod(
    segments: readonly DetectedSegment[],
    configHash: string,
): Map<DetectionMethod, MediaSegmentCandidateInput[]> {
    const byMethod = new Map<DetectionMethod, MediaSegmentCandidateInput[]>();
    for (const segment of segments) {
        const bucket = byMethod.get(segment.method) ?? [];
        bucket.push({
            type: segment.type,
            startTime: segment.startTime,
            endTime: segment.endTime,
            confidence: segment.confidence,
            detectorVersion: PROCESSING_VERSION,
            configHash,
            snappedToChapter: segment.snappedToChapter,
        });
        byMethod.set(segment.method, bucket);
    }
    return byMethod;
}

/**
 * The `onReject` every gate call passes. A dropped detection that logs nothing
 * is indistinguishable from a detector that never fired — which is exactly how
 * 26 % of stored Outros stayed wrong for months.
 */
function rejectLogger(
    logger: SdkLogger,
    mediaId: string,
): (segment: DetectedSegment, verdict: PlausibilityRejection) => void {
    return (segment, verdict) => {
        logger.warn(
            `[intro-analyzer] rejected ${segment.method} ${segment.type} for ${mediaId}: ${verdict.rule} — ${verdict.detail}`,
            {
                mediaId,
                method: segment.method,
                type: segment.type,
                rule: verdict.rule,
                startTime: segment.startTime,
                endTime: segment.endTime,
            },
        );
    };
}

/**
 * Rank the whole evidence pool for one item and materialize the winners.
 *
 * MUST be called with a transaction handle. A targeted `media-<id>` run can
 * execute concurrently with the global drain on the same episode —
 * `exclusiveWith` collapses only same-identity runs — so reading candidates,
 * ranking them and writing the answer has to be one atomic step or two passes
 * interleave and materialize a winner neither of them resolved.
 *
 * A transaction alone is NOT enough for that. Under READ COMMITTED two
 * concurrent transactions each read their own pre-commit snapshot of the pool
 * and then both upsert; last writer wins regardless of which snapshot was
 * current. That is how an operator's freshly-committed `manual` candidate gets
 * overwritten by a drain that never saw it. The advisory lock below serializes
 * resolution per media_id, so every resolution ranks a pool that already
 * contains everything committed before it.
 *
 * Only ever UPSERTS. An abstention (or a gate rejection) removes a candidate
 * from the pool but never deletes another method's materialized row: retraction
 * of pre-existing bad rows is the repair pass's job, and a pass that deleted on
 * "I found nothing" would blank correct answers every time ffmpeg hiccuped.
 * `suppressTypes` is the one deliberate exception — the cohort layer's `blanked`
 * verdict, which is an explicit "this row is wrong", not an absence of evidence.
 */
export async function resolveAndMaterialize(
    tx: postgres.Sql,
    mediaId: string,
    ctx: ResolveContext,
    plausibilityConfig: PlausibilityConfig,
    suppressTypes: readonly DetectedSegmentType[] = [],
    // Defaults to EVERY materializable type, because every call to this function
    // is a re-decide and the stored rows must mirror the resolver's verdict.
    // Opting out per-caller was the bug: the drain could overwrite a wrong
    // marker but never withdraw a false one, so anything an older detector
    // version wrote outlived every later pass. Narrow it only when the caller
    // genuinely re-ran a subset (the targeted Outro refresh passes ['Outro']).
    retractTypesWhenAbsent: readonly DetectedSegmentType[] = MATERIALIZED_SEGMENT_TYPES,
    // Optional so the repair path and tests can omit it. When absent the drops
    // are invisible, which is the state this argument exists to end.
    logger?: SdkLogger,
    // Which types this call may WRITE. Appended last so no existing positional
    // call site shifts. `upsertSegments` only touches the types handed to it, so
    // narrowing this leaves every other type's row byte-for-byte untouched --
    // that is what lets a scoped run promise it will not disturb the others.
    // Distinct from `suppressTypes`, which DELETES the types it names.
    materializeTypes: readonly DetectedSegmentType[] = MATERIALIZED_SEGMENT_TYPES,
    fileId: string | null = null,
): Promise<number> {
    // Serialize resolution per item. Transaction-scoped, so it releases on
    // COMMIT/ROLLBACK with no unlock path to leak. The namespace keeps this
    // from colliding with any other advisory lock in the app.
    await acquireMediaSegmentResolutionLock(tx, mediaId);

    const pool: DetectedSegment[] = toCandidates(await getCandidatesForMedia(tx, mediaId)).map(
        (candidate) => ({
            type: candidate.type,
            startTime: candidate.startTime,
            endTime: candidate.endTime,
            method: candidate.method,
            confidence: candidate.confidence,
            snappedToChapter: candidate.snappedToChapter,
        }),
    );

    const resolved = resolveSegments(
        pool,
        ctx,
        plausibilityConfig,
        // A candidate that wins on rank and is then dropped by the gate is
        // indistinguishable, downstream, from a detector that never fired.
        // `veto` means the whole type was abandoned (structural: the item's own
        // geometry is unusable); `fallback` means this one candidate lost and a
        // lower-ranked one got its turn.
        (segment, verdict, outcome) => {
            logger?.info(
                `[intro-analyzer] ${outcome === 'veto' ? 'vetoed' : 'passed over'} ` +
                    `${segment.method} ${segment.type} for ${mediaId}: ${verdict.rule}`,
                {
                    mediaId,
                    method: segment.method,
                    segmentType: segment.type,
                    rule: verdict.rule,
                    detail: verdict.detail,
                    outcome,
                    startTime: segment.startTime,
                    endTime: segment.endTime,
                },
            );
        },
    ).filter((segment) => !suppressTypes.includes(segment.type));

    if (suppressTypes.length > 0) {
        await deleteSegmentsForSourceByTypes(tx, mediaId, PLUGIN_ID, [...suppressTypes], fileId);
    }
    // An operator's answer is not a detector's to withdraw. `manual` normally
    // resolves and so is already safe, but `stale-manual` deliberately does NOT
    // resolve (the file changed under it) — without this it would look exactly
    // like "no evidence" and get swept.
    const operatorAnsweredTypes = new Set(
        pool.filter((c) => c.method === 'manual' || c.method === 'stale-manual').map((c) => c.type),
    );
    const typesToRetract = retractTypesWhenAbsent.filter(
        (type) =>
            !resolved.some((segment) => segment.type === type) && !operatorAnsweredTypes.has(type),
    );
    if (typesToRetract.length > 0) {
        await deleteSegmentsForSourceByTypes(tx, mediaId, PLUGIN_ID, [...typesToRetract], fileId);
    }

    // Retraction above is computed from the FULL `resolved` set on purpose: a
    // type that resolved but sits outside this call's write scope must not look
    // like an abstention.
    const materialized = resolved.filter((segment) => materializeTypes.includes(segment.type));

    await upsertSegments(
        tx,
        mediaId,
        materialized.map((segment) => ({
            type: segment.type,
            startTime: segment.startTime,
            endTime: segment.endTime,
        })),
        PLUGIN_ID,
        fileId,
    );

    return materialized.length;
}

/** A chapter list the file already has: its stored chapters and runtime. */
export interface KnownChapterList {
    chapters: ChapterInput[];
    durationMs: number;
}

/**
 * Probe the file's chapters once and run the chapter detectors over them.
 *
 * The chapter list is returned alongside the detections because it is also the
 * snap target for every other detector (§1.2) — re-probing per detector would be
 * a second ffprobe shell for data already in hand. When the file's chapters are
 * already known (`known`, see {@link knownChapterListFor}) that list is used and
 * the file is not probed at all.
 */
export async function detectFromChapters(
    filePath: string,
    chapterConfig: ChapterAnalyzerConfig,
    signal?: AbortSignal,
    known?: KnownChapterList,
): Promise<{ segments: DetectedSegment[]; chapters: ChapterInput[] }> {
    // A probe failure is not evidence that the file has no chapters. Let it
    // propagate so the task retries rather than clearing a valid Outro.
    const { chapters, durationMs } =
        known ?? (await probeChapters(filePath, undefined, { signal }));
    if (chapters.length === 0) return { segments: [], chapters: [] };

    // `method` and `confidence` are carried through untouched. Discarding them
    // here — as this function used to — is the structural defect the whole
    // evidence model exists to fix: a chapter title match and a window-edge
    // truncation became the same anonymous row.
    return { segments: analyzeChapters(chapters, durationMs, chapterConfig), chapters };
}

/**
 * The file's stored chapters as a chapter list, when they are trusted for the
 * file's current stat (see `loadKnownFileChapters`). The runtime is the
 * snapshot's duration, the same one every other detector already uses.
 */
async function knownChapterListFor(
    sql: postgres.Sql,
    fileId: string,
    durationSeconds: number,
): Promise<KnownChapterList | undefined> {
    const known = await loadKnownFileChapters(sql, fileId);
    if (!known) return undefined;
    return { chapters: known.chapters, durationMs: Math.round(durationSeconds * 1000) };
}

async function detectFromBlackFrames(
    filePath: string,
    durationSeconds: number,
    isMovieItem: boolean,
    blackframeConfig: BlackFrameConfig,
    ffmpegThreads = serverConfig.ANALYSIS_FFMPEG_THREADS,
    signal?: AbortSignal,
): Promise<DetectorOutcome> {
    // Movies have longer credit rolls than episodes — widen the SEARCH window
    // when this item is a movie so end-credits aren't truncated mid-roll. The
    // accepted-answer bound moves separately (maxPlausibleMovieCreditsDuration).
    const effective: BlackFrameConfig = isMovieItem
        ? { ...blackframeConfig, maxSearchDistance: blackframeConfig.maxMovieSearchDistance }
        : blackframeConfig;

    return analyzeBlackFrames(filePath, durationSeconds, effective, ffmpegThreads, signal);
}

/**
 * The per-item seam: run the file-local detectors, gate them, persist them as
 * evidence, then resolve and materialize.
 */
interface ItemAnalysisOutcome {
    segments: number;
    input: AnalyzerInputSnapshot;
}

function physicalIdentity(stat: Awaited<ReturnType<typeof safeStatBigInt>>): string {
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

async function analyzeItem(
    sql: postgres.Sql,
    mediaId: string,
    config: EffectiveConfig,
    logger: SdkLogger,
    signal?: AbortSignal,
    scope: SegmentScope = FULL_SCOPE,
): Promise<ItemAnalysisOutcome> {
    await assertAnalysisRetryReady(sql, mediaId);
    const info = await getAnalyzerInputSnapshot(sql, mediaId, config);
    const durationSeconds = info?.durationSeconds ?? 0;
    // Every plausibility bound is relative to runtime, so without one the gate
    // can only reject everything. Running the detectors anyway would burn ffmpeg
    // to produce candidates that are guaranteed to be dropped.
    if (!info || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new AnalysisInputUnavailableError();
    }

    scope.onInputSelected?.(mediaId, info.inputIdentity);
    // Carry the selected generation through detector FAILURE as well as success.
    // A replacement must never inherit the previous file's permanent strikes.
    let localBefore: Awaited<ReturnType<typeof safeStatBigInt>> | undefined;
    try {
        localBefore = await safeStatBigInt(info.filePath, 5000, signal);
    } catch (err) {
        signal?.throwIfAborted();
        if (
            typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            (err.code === 'ENOENT' || err.code === 'ENOTDIR')
        )
            throw new AnalysisInputUnavailableError();
        throw new AnalysisInputUnverifiedError();
    }
    info.physicalIdentity = physicalIdentity(localBefore);
    info.runId = scope.runId;
    try {
        const segments = await analyzeCurrentInput(
            sql,
            mediaId,
            config,
            logger,
            info,
            signal,
            scope,
        );
        return { segments, input: info };
    } catch (err) {
        if (signal?.aborted || isAbortError(err)) throw err;
        if (!(await analyzerInputStillCurrent(sql, mediaId, info, logger)))
            throw new AnalysisInputChangedError();
        if (localBefore) {
            let after: Awaited<ReturnType<typeof safeStatBigInt>>;
            try {
                after = await safeStatBigInt(info.filePath, 5000, signal);
            } catch (statError) {
                signal?.throwIfAborted();
                if (
                    typeof statError === 'object' &&
                    statError !== null &&
                    'code' in statError &&
                    (statError.code === 'ENOENT' || statError.code === 'ENOTDIR')
                )
                    throw new AnalysisInputChangedError();
                throw new AnalysisInputUnverifiedError();
            }
            if (
                localBefore.dev !== after.dev ||
                localBefore.ino !== after.ino ||
                localBefore.size !== after.size ||
                localBefore.mtimeNs !== after.mtimeNs ||
                localBefore.ctimeNs !== after.ctimeNs
            )
                throw new AnalysisInputChangedError();
        }
        if (err instanceof AnalysisInputChangedError || err instanceof AnalysisInputUnverifiedError)
            throw err;
        throw new AnalysisDetectorFailure(err, info);
    }
}

async function analyzeCurrentInput(
    sql: postgres.Sql,
    mediaId: string,
    config: EffectiveConfig,
    logger: SdkLogger,
    info: AnalyzerInputSnapshot,
    signal: AbortSignal | undefined,
    scope: SegmentScope,
): Promise<number> {
    const durationSeconds = info.durationSeconds ?? 0;
    const filePath = info.filePath;
    scope.onAttempt?.(mediaId);

    const isMovieItem = isMovie(info.mediaType);
    const resolveCtx: ResolveContext = { durationSeconds, isMovie: isMovieItem };
    const plausibilityConfig = buildPlausibilityConfig(config);
    const configHash = buildConfigHash(config);
    const combinedFile = await isMultiEpisodeFileItem(sql, mediaId, info.fileId);

    const detected: DetectedSegment[] = [];
    let chapters: ChapterInput[] = [];
    const ownedMethods: DetectionMethod[] = [];

    if (config.chapterDetection !== false) {
        ownedMethods.push(...CHAPTER_METHODS);
        const chapterResult = await detectFromChapters(
            filePath,
            buildChapterConfig(config),
            signal,
            await knownChapterListFor(sql, info.fileId, durationSeconds),
        );
        chapters = chapterResult.chapters;
        for (const segment of chapterResult.segments) {
            if (combinedFile && segment.type === 'Outro') {
                logger.debug(
                    `[intro-analyzer] dropped tail-anchored ${segment.method} Outro for ${mediaId}: multi-episode file`,
                    { mediaId, method: segment.method },
                );
                continue;
            }
            // A chapter boundary IS an authored mark, so it is already "snapped"
            // in the sense the flag records: the boundary came from the file's
            // own frame-exact metadata rather than from a derived signal.
            detected.push({ ...segment, snappedToChapter: true });
        }
    }

    if (config.blackframeDetection !== false) {
        ownedMethods.push(...BLACKFRAME_METHODS);
        if (combinedFile) {
            logger.debug(
                `[intro-analyzer] skipping blackframe for ${mediaId}: multi-episode file`,
                { mediaId },
            );
        } else {
            // A chapter Outro that already sits past the credits threshold is a
            // reliable end-of-content signal, so spending an ffmpeg decode to
            // have blackframe lose the rank comparison anyway is pure cost. The
            // threshold is `outroMinStartFraction` rather than a second hardcoded
            // 0.85 so this and the plausibility rule cannot drift apart.
            const chapterOutro = detected.find((segment) => segment.type === 'Outro');
            const suppressBlackframe =
                chapterOutro !== undefined &&
                chapterOutro.startTime / durationSeconds > config.outroMinStartFraction;

            if (!suppressBlackframe) {
                const timing = await probeVideoTiming(
                    filePath,
                    durationSeconds,
                    signal,
                    config.ffmpegThreads,
                );
                signal?.throwIfAborted();
                if (
                    timing === 'input-changed' ||
                    !(await analyzerInputStillCurrent(sql, mediaId, info, logger))
                ) {
                    // Do not charge failure strikes to the replacement input.
                    throw new AnalysisInputChangedError();
                }
                if (timing === 'nonadvancing') throw new NonadvancingVideoTimingError();
                const outcome = await detectFromBlackFrames(
                    filePath,
                    durationSeconds,
                    isMovieItem,
                    buildBlackframeConfig(config),
                    config.ffmpegThreads ?? serverConfig.ANALYSIS_FFMPEG_THREADS,
                    signal,
                );
                if (outcome.kind === 'abstain') {
                    logger.debug(
                        `[intro-analyzer] blackframe abstained for ${mediaId}: ${outcome.reason}`,
                        { mediaId, reason: outcome.reason },
                    );
                } else {
                    // A luma boundary is quantized to a 4s bucket; an authored
                    // mark within tolerance describes the same cut, frame-exact.
                    const snap = snapToChapterMark(
                        outcome.segment.startTime,
                        chapters,
                        config.snapToleranceSec,
                    );
                    detected.push({
                        ...outcome.segment,
                        startTime: snap.time,
                        snappedToChapter: snap.snapped,
                    });
                }
            }
        }
    }

    const plausible = filterPlausible(
        // A no-op under the full scope: `types` then covers every DetectedSegmentType.
        detected.filter((segment) => scope.types.includes(segment.type)),
        resolveCtx,
        plausibilityConfig,
        rejectLogger(logger, mediaId),
    );

    // `ownedMethods` is built from which detectors RAN, never from what they
    // produced: a detector that ran and abstained must still clear its previous
    // candidates, or the resolver re-materializes the answer it just retracted.
    signal?.throwIfAborted();
    return withTx(sql, async (tx) => {
        await acquireMediaSegmentResolutionLock(tx, mediaId);
        signal?.throwIfAborted();
        if (!(await analyzerInputStillCurrent(tx, mediaId, info))) {
            logger.info(`[intro-analyzer] discarded stale detector result for ${mediaId}`, {
                mediaId,
            });
            throw new AnalysisInputChangedError();
        }
        const candidatesByMethod = groupCandidatesByMethod(plausible, configHash);
        // Keyed on the SCOPE, not on `visualOnly`. `replaceCandidatesForMethods`
        // clears every row for a method it re-ran, so without this a scoped pass
        // would delete that method's out-of-scope candidates while the retract
        // list (also scoped) refused to withdraw the materialized rows they
        // backed -- leaving orphaned markers with no candidate behind them.
        if (scope.types.length < MATERIALIZED_SEGMENT_TYPES.length) {
            // This pass runs ONLY the visual detectors (chapter + blackframe),
            // so it may retract only its own evidence for the scoped types.
            // Chromaprint and cohort OUTRANK both of them (see METHOD_RANK) and
            // are produced by season-level passes this path never invokes —
            // deleting them here discards the better answer with nothing to
            // regenerate it, and the normal drain will not revisit a season
            // already marked at the current PROCESSING_VERSION. Manual
            // overrides are excluded twice over: `manual` is never an owned
            // method.
            const scopedTypes = [...scope.types];
            await tx`
                DELETE FROM media_segment_candidates
                WHERE media_id = ${mediaId}
                  AND type = ANY(${scopedTypes}::text[])
                  AND method <> 'manual'
                  AND method = ANY(${ownedMethods}::text[])
            `;
            // Replacing a method normally retracts every type it owns. For an
            // operator-requested scoped rerun, retain that method's evidence for
            // the types OUTSIDE the scope and replace only the scoped ones.
            for (const candidate of toCandidates(await getCandidatesForMedia(tx, mediaId))) {
                if (
                    scope.types.includes(candidate.type) ||
                    !ownedMethods.includes(candidate.method)
                )
                    continue;
                const bucket = candidatesByMethod.get(candidate.method) ?? [];
                bucket.push({
                    type: candidate.type,
                    startTime: candidate.startTime,
                    endTime: candidate.endTime,
                    confidence: candidate.confidence,
                    detectorVersion: candidate.detectorVersion,
                    configHash: candidate.configHash ?? null,
                    snappedToChapter: candidate.snappedToChapter,
                    notes: candidate.notes ?? null,
                });
                candidatesByMethod.set(candidate.method, bucket);
            }
        }
        await replaceCandidatesForMethods(tx, mediaId, ownedMethods, candidatesByMethod);
        // An explicit Outro refresh is an affirmative reconciliation request:
        // if all current detectors abstain, remove the stale materialized Outro
        // rather than leaving yesterday's answer visible indefinitely.
        // A processing-version bump means "re-decide this item". Overwriting a
        // stale answer was never the hard part — the gap was that the drain
        // could not express "there is no Outro here", so a false marker written
        // by an older detector (or orphaned when its candidate was cleared)
        // survived every subsequent pass forever.
        //
        // Retraction keys on the RESOLVER's verdict over the whole candidate
        // pool, not on what this pass's detectors happened to find, so surviving
        // chromaprint/cohort evidence still wins and nothing is dropped merely
        // because the visual group abstained.
        return resolveAndMaterialize(
            tx,
            mediaId,
            resolveCtx,
            plausibilityConfig,
            [],
            scope.types,
            logger,
            scope.types,
            info.fileId,
        );
    });
}

/**
 * What one season fingerprint pass did. `deferred` is the only way to tell "the
 * season is still settling" from "the season was analysed and matched nothing":
 * both report `segments: 0`, but only the second may be marked done.
 */
export interface SeasonFingerprintOutcome {
    readonly segments: number;
    readonly deferred: boolean;
    readonly unavailable?: boolean;
    readonly inputs?: ReadonlyMap<string, AnalyzerInputSnapshot>;
}

export async function analyzeSingleSeasonChromaprint(
    sql: postgres.Sql,
    logger: SdkLogger,
    signal: AbortSignal,
    seasonId: string,
    tmpDir: string,
    config: EffectiveConfig,
    concurrency = 1,
    ffmpegThreads = serverConfig.ANALYSIS_FFMPEG_THREADS,
    scope: SegmentScope = FULL_SCOPE,
): Promise<SeasonFingerprintOutcome> {
    if (!(await seasonStableOrDefer(sql, seasonId, logger))) return { segments: 0, deferred: true };
    const episodeRows = await getEpisodesWithFilesForSeason(sql, seasonId);
    const selected = await getAnalyzerInputSnapshots(
        sql,
        episodeRows.map((episode) => episode.episodeId),
        config,
    );
    const snapshots = episodeRows.map((episode) => {
        const input = selected.get(episode.episodeId);
        if (input) scope.onInputSelected?.(episode.episodeId, input.inputIdentity);
        return input?.parentId === seasonId ? { ...episode, ...input, runId: scope.runId } : null;
    });
    if (snapshots.some((input) => input === null))
        return { segments: 0, deferred: false, unavailable: true };
    const episodes = snapshots.filter(
        (episode): episode is NonNullable<typeof episode> => episode !== null,
    );
    if (signal.aborted) return { segments: 0, deferred: false };
    if (episodes.length < 2) return { segments: 0, deferred: false, unavailable: true };
    const physicalInputs = await Promise.all(
        episodes.map(async (episode) => {
            try {
                return await safeStatBigInt(episode.filePath!, 5000, signal);
            } catch {
                signal.throwIfAborted();
                return undefined;
            }
        }),
    );
    episodes.forEach((episode, index) => {
        if (physicalInputs[index])
            episode.physicalIdentity = physicalIdentity(physicalInputs[index]);
    });
    if (physicalInputs.some((stat) => !stat)) throw new AnalysisInputUnverifiedError();
    try {
        const outcome = await analyzeSeasonInput(
            sql,
            logger,
            signal,
            seasonId,
            tmpDir,
            config,
            concurrency,
            ffmpegThreads,
            scope,
            episodes,
        );
        return {
            ...outcome,
            inputs: new Map(episodes.map((episode) => [episode.episodeId, episode])),
        };
    } catch (err) {
        if (signal.aborted || isAbortError(err) || err instanceof AnalysisBudgetReachedError)
            throw err;
        let failure: unknown = err;
        const generationsCurrent = await Promise.all(
            episodes.map((episode) =>
                analyzerInputStillCurrent(sql, episode.episodeId, episode, logger),
            ),
        );
        if (generationsCurrent.some((current) => !current))
            failure = new AnalysisInputChangedError();
        const physicalCurrent = await Promise.all(
            episodes.map(async (episode, index) => {
                const before = physicalInputs[index];
                if (!before) return 'unverified';
                try {
                    const after = await safeStatBigInt(episode.filePath!, 5000, signal);
                    return before.dev === after.dev &&
                        before.ino === after.ino &&
                        before.size === after.size &&
                        before.mtimeNs === after.mtimeNs &&
                        before.ctimeNs === after.ctimeNs
                        ? 'current'
                        : 'changed';
                } catch (statError) {
                    signal.throwIfAborted();
                    return typeof statError === 'object' &&
                        statError !== null &&
                        'code' in statError &&
                        (statError.code === 'ENOENT' || statError.code === 'ENOTDIR')
                        ? 'changed'
                        : 'unverified';
                }
            }),
        );
        if (physicalCurrent.includes('changed')) failure = new AnalysisInputChangedError();
        else if (!isStaleAnalysisFailure(failure) && physicalCurrent.includes('unverified'))
            failure = new AnalysisInputUnverifiedError();
        throw new AnalysisSeasonFailure(
            failure,
            new Map(episodes.map((episode) => [episode.episodeId, episode])),
        );
    }
}

async function analyzeSeasonInput(
    sql: postgres.Sql,
    logger: SdkLogger,
    signal: AbortSignal,
    seasonId: string,
    tmpDir: string,
    config: EffectiveConfig,
    concurrency: number,
    ffmpegThreads: number,
    scope: SegmentScope,
    episodes: EpisodeWithFile[],
): Promise<SeasonFingerprintOutcome> {
    if (signal.aborted) return { segments: 0, deferred: false };
    if (episodes.length < 2) return { segments: 0, deferred: false, unavailable: true };

    // Stability gate — defer if the season is still actively scanning.
    // Chromaprint accuracy scales with episode count; analysing 5 of 20
    // episodes mid-scan produces noisier intro timestamps than waiting
    // for the full set. Also avoids spending ffmpeg cycles on N-1
    // intermediate analyses that get overwritten by the Nth.
    //
    // The gate also handles late-arriving episodes (file.attached after
    // months) and episode replacements (file.contentChanged) — both
    // bump the season's freshest timestamp, the gate delays, the next
    // attempt re-analyses the (now larger or content-changed) season
    // and upserts segments for every episode in it.
    //
    // The drain runs the same gate before its per-item visual work, so this
    // check only matters to callers that reach the pass directly. It stays here
    // so a direct caller cannot fingerprint a season that is still settling.
    if (!(await seasonStableOrDefer(sql, seasonId, logger))) {
        return { segments: 0, deferred: true };
    }

    const plausibilityConfig = buildPlausibilityConfig(config);
    const configHash = buildConfigHash(config);

    for (const episode of episodes) scope.onAttempt?.(episode.episodeId);

    const checkpointKey = (
        episode: EpisodeWithFile,
        pass: 'intro' | 'credits',
        startSec: number,
        endSec: number,
    ): FingerprintIdentity | null =>
        episode.inputIdentity && episode.physicalIdentity
            ? {
                  mediaId: episode.episodeId,
                  pass,
                  startSec,
                  endSec,
                  inputIdentity: episode.inputIdentity,
                  physicalIdentity: episode.physicalIdentity,
                  processingVersion: ACOUSTIC_PROCESSING_VERSION,
              }
            : null;
    const checkpoint = {
        shouldYield: scope.shouldYield,
        load: async (
            episode: EpisodeWithFile,
            pass: 'intro' | 'credits',
            startSec: number,
            endSec: number,
        ): Promise<Uint32Array | null> => {
            const key = checkpointKey(episode, pass, startSec, endSec);
            return key ? loadFingerprint(sql, key) : null;
        },
        save: async (
            episode: EpisodeWithFile,
            pass: 'intro' | 'credits',
            startSec: number,
            endSec: number,
            points: Uint32Array,
        ): Promise<void> => {
            const key = checkpointKey(episode, pass, startSec, endSec);
            const fileId = episode.fileId;
            if (!key || !fileId) return;
            signal.throwIfAborted();
            await withTx(sql, async (tx) => {
                // File invalidation uses file-row -> media-resolution lock order.
                // Hold a share lock so a replacement cannot delete the checkpoint
                // and then have this old extraction reinsert it after the delete.
                await tx`SELECT 1 FROM media_files WHERE id=${fileId} FOR SHARE`;
                await acquireMediaSegmentResolutionLock(tx, episode.episodeId);
                if (!(await analyzerInputStillCurrent(tx, episode.episodeId, episode, logger)))
                    throw new AnalysisInputChangedError();
                await saveFingerprint(tx, key, points);
            });
        },
        onProgress: scope.onFingerprint,
    };

    // Intro pass — head-window fingerprint comparison.
    const introResults = await analyzeSeasonFingerprints(
        episodes,
        tmpDir,
        buildChromaprintConfig(config),
        concurrency,
        ffmpegThreads,
        signal,
        checkpoint,
    );

    // No candidate verdict is persisted between the two passes. Both produce candidates under
    // the SAME method, and a replace is scoped to a method — writing the intro
    // half alone would clear the previous run's credits candidate as if the
    // credits detector had abstained, when in fact it has not run yet. Bailing
    // out here leaves the prior evidence intact, which is the honest outcome for
    // a cancelled run.
    if (signal.aborted) return { segments: introResults.size, deferred: false };

    // Credits pass — tail-window fingerprint comparison. Precedence against the
    // other detectors is no longer a matter of write order: both write
    // candidates and `METHOD_RANK` decides, so a chromaprint match beats a
    // chapter mark beats a blackframe guess regardless of which pass ran last.
    let creditsResults = new Map<string, DetectedSegment>();
    if (config.chromaprintDetection !== false) {
        creditsResults = await analyzeSeasonCreditsFingerprints(
            episodes,
            tmpDir,
            buildChromaprintCreditsConfig(config),
            concurrency,
            ffmpegThreads,
            signal,
            checkpoint,
        );
    }
    const creditsCount = creditsResults.size;

    if (signal.aborted) return { segments: introResults.size + creditsCount, deferred: false };

    // ── Candidate write: chromaprint ────────────────────────────────────────
    // Every episode in the cohort, including the ones that matched nothing —
    // that empty write IS the abstention.
    const combinedFileEpisodes = await getCombinedFileEpisodeIds(sql, episodes);

    for (const episode of episodes) {
        const duration = episode.durationSeconds;
        const raw: DetectedSegment[] = [];
        const intro = introResults.get(episode.episodeId);
        if (intro) raw.push(intro);
        const credits = creditsResults.get(episode.episodeId);
        // The head of a combined file really is the first episode's head, so the
        // intro stands. The tail belongs to whichever episode ends the file, so
        // the credits match is discarded rather than attributed to all of them.
        if (credits && !combinedFileEpisodes.has(episode.episodeId)) raw.push(credits);

        // No file-accurate runtime means the resolver cannot judge this item.
        // Preserve its prior evidence until probing supplies one.
        if (!duration || duration <= 0) continue;
        const resolveCtx: ResolveContext = { durationSeconds: duration, isMovie: false };
        const gated = filterPlausible(
            raw,
            resolveCtx,
            plausibilityConfig,
            rejectLogger(logger, episode.episodeId),
        );

        await withTx(sql, async (tx) => {
            await acquireMediaSegmentResolutionLock(tx, episode.episodeId);
            if (!(await analyzerInputStillCurrent(tx, episode.episodeId, episode, logger))) {
                throw new AnalysisInputChangedError();
            }
            await replaceCandidatesForMethods(
                tx,
                episode.episodeId,
                CHROMAPRINT_METHODS,
                groupCandidatesByMethod(gated, configHash),
            );
            await resolveAndMaterialize(
                tx,
                episode.episodeId,
                resolveCtx,
                plausibilityConfig,
                [],
                scope.types,
                logger,
                scope.types,
                episode.fileId ?? null,
            );
        });
    }

    if (signal.aborted) return { segments: introResults.size + creditsCount, deferred: false };

    // ── Season cohort reconciliation + materialization ──────────────────────
    // Reaching this point means every detector for this season ran without
    // throwing, so the candidate pool is complete. That precondition is not
    // cosmetic: a consensus computed over a biased subset would "correct" the
    // episodes that WERE analysed properly. A season whose chromaprint pass
    // threw never gets here — the exception propagates to the caller, chromaOK
    // stays false, and the season is reconciled on the next clean pass.
    await reconcileAndMaterializeSeason(
        sql,
        logger,
        seasonId,
        episodes,
        config,
        plausibilityConfig,
        configHash,
        scope,
    );

    if (signal.aborted) return { segments: introResults.size + creditsCount, deferred: false };

    // Anime preview synthesis — operator-gated, per-episode. It reads each
    // episode's MATERIALIZED Outro end, which is why it runs after the resolver
    // above rather than alongside the detectors: a Preview synthesised from a
    // credits boundary that the resolver was about to overrule would be wrong by
    // construction. It writes `anime-synth` candidates and resolves them in the
    // same locked transaction (letting a real chapter-authored "Next
    // episode" Preview outrank the synthesis, which is how the old "skip when a
    // Preview already exists" guard is preserved — as ranking, not as a race).
    if (config.animePreviewFromCreditsEnd && !signal.aborted) {
        await synthesiseAnimePreviews(
            sql,
            logger,
            episodes,
            PLUGIN_ID,
            async (tx, episode) => {
                const duration = episode.durationSeconds;
                if (!duration || duration <= 0) {
                    throw new Error(
                        `anime-preview materialization requires a probed duration for ${episode.episodeId}`,
                    );
                }
                await resolveAndMaterialize(
                    tx,
                    episode.episodeId,
                    { durationSeconds: duration, isMovie: false },
                    plausibilityConfig,
                    [],
                    scope.types,
                    logger,
                    scope.types,
                    episode.fileId ?? null,
                );
            },
            signal,
            {
                configHash,
                detectorVersion: PROCESSING_VERSION,
                validateInput: async (tx, episode) => {
                    if (!(await analyzerInputStillCurrent(tx, episode.episodeId, episode, logger)))
                        throw new AnalysisInputChangedError();
                    return true;
                },
            },
        );
    }

    logger.info(
        `Season ${seasonId}: chromaprint detected ${introResults.size} intros, ${creditsCount} credits across ${episodes.length} episodes`,
    );
    return { segments: introResults.size + creditsCount, deferred: false };
}

/**
 * Borrow the season's agreement for the episodes whose own evidence is an
 * outlier, then resolve and materialize every episode in one place.
 *
 * End credits are cut once and reused, so twelve episodes agreeing on ~46s are a
 * far better witness for the thirteenth than that episode's worst detector. This
 * is the layer that catches Drifting Clouds S03E12 independently of every other
 * fix: twelve siblings agreed on 44-48s, the broken one claimed 200s, and
 * nothing in the per-episode pipeline could tell that it was wrong.
 *
 * `cohort.ts` deliberately makes no policy decisions — it neither gates its own
 * output nor decides whether it should run. Both are this function's job.
 */
export async function reconcileAndMaterializeSeason(
    sql: postgres.Sql,
    logger: SdkLogger,
    seasonId: string,
    episodes: EpisodeWithFile[],
    config: EffectiveConfig,
    plausibilityConfig: PlausibilityConfig,
    configHash: string,
    scope: SegmentScope = FULL_SCOPE,
): Promise<void> {
    // The payoff of the candidates table: the per-item pass's chapter and
    // blackframe results were produced in an earlier phase of the drain and used
    // to be dropped on the floor. They are simply re-read here — no restructuring
    // of the drain loop, no second pass over the files.
    const seasonRows = await getCandidatesForSeason(sql, seasonId);
    const byEpisode = new Map<string, DetectedSegment[]>();
    for (const row of seasonRows) {
        const bucket = byEpisode.get(row.media_id) ?? [];
        bucket.push({
            type: row.type,
            startTime: row.start_time,
            endTime: row.end_time,
            method: row.method,
            confidence: row.confidence,
            snappedToChapter: row.snapped_to_chapter,
        });
        byEpisode.set(row.media_id, bucket);
    }

    // Combined-file episodes are out of scope for the cohort for the same reason
    // they are out of scope for every tail-anchored detector: "file end minus the
    // season's consensus credits length" lands inside a DIFFERENT episode's
    // content. Excluding them keeps the layer from synthesizing precisely the
    // kind of confident wrong answer it exists to remove.
    const combinedFileEpisodes = await getCombinedFileEpisodeIds(sql, episodes);

    const cohortEpisodes: CohortEpisode[] = episodes
        .filter((episode) => !combinedFileEpisodes.has(episode.episodeId))
        .map((episode) => ({
            episodeId: episode.episodeId,
            durationSeconds: episode.durationSeconds,
            candidates: byEpisode.get(episode.episodeId) ?? [],
        }));

    const outcomes = reconcileSeasonOutros(cohortEpisodes, {
        bandLo: COHORT_BAND_LO,
        bandHi: COHORT_BAND_HI,
        minSupport: COHORT_MIN_SUPPORT,
        minSegmentDuration: config.minSegmentDuration,
    });

    const durationByEpisode = new Map(
        episodes.map((episode) => [episode.episodeId, episode.durationSeconds]),
    );
    const episodeById = new Map(episodes.map((episode) => [episode.episodeId, episode]));

    for (const outcome of outcomes) {
        const duration = durationByEpisode.get(outcome.episodeId) ?? null;
        // No runtime means the gate cannot judge anything and the resolver would
        // reject every candidate. Leaving the episode entirely alone is better
        // than blanking it on the strength of a missing probe.
        if (!duration || duration <= 0) continue;

        const ctx: ResolveContext = { durationSeconds: duration, isMovie: false };
        const cohortSegments: DetectedSegment[] = [];

        // `replaced` and `synthesized` both mean "the season says the answer is
        // this instead". Both are recorded as `cohort` evidence rather than
        // applied directly, so the decision survives into the next resolution
        // and still loses to a manual override. `kept` writes nothing — including
        // `kept` with a null segment, which means "nothing was there, leave it
        // alone" and is NOT the same instruction as `blanked`.
        if (
            (outcome.action === 'replaced' || outcome.action === 'synthesized') &&
            outcome.segment
        ) {
            cohortSegments.push(
                ...filterPlausible(
                    [{ ...outcome.segment, method: 'cohort' }],
                    ctx,
                    plausibilityConfig,
                    rejectLogger(logger, outcome.episodeId),
                ),
            );
        }

        // `blanked`: the winner was rejected and nothing could stand in for it.
        // That is a positive statement that the stored row is wrong, so it is the
        // one case where materialization deletes.
        const suppressTypes: DetectedSegmentType[] = outcome.action === 'blanked' ? ['Outro'] : [];
        if (outcome.action === 'blanked') {
            logger.info(
                `[intro-analyzer] cohort blanked the Outro for ${outcome.episodeId} — no candidate agreed with the season`,
                { episodeId: outcome.episodeId, seasonId },
            );
        }

        await withTx(sql, async (tx) => {
            await acquireMediaSegmentResolutionLock(tx, outcome.episodeId);
            const episode = episodeById.get(outcome.episodeId);
            if (
                !episode ||
                !(await analyzerInputStillCurrent(tx, outcome.episodeId, episode, logger))
            ) {
                throw new AnalysisInputChangedError();
            }
            await replaceCandidatesForMethods(
                tx,
                outcome.episodeId,
                COHORT_METHODS,
                groupCandidatesByMethod(cohortSegments, configHash),
            );
            await resolveAndMaterialize(
                tx,
                outcome.episodeId,
                ctx,
                plausibilityConfig,
                suppressTypes,
                scope.types,
                logger,
                scope.types,
                episode.fileId ?? null,
            );
        });
    }
}

// ============================================================================
// Drain helpers
// ============================================================================

// Exported for the season-deferral suites, which exercise the drain's gate against
// a fake and against a real database.
export async function analyzeSliceOfSeasons(
    sql: postgres.Sql,
    logger: SdkLogger,
    signal: AbortSignal,
    seasons: ReadonlyArray<{ seasonId: string; visualStale: boolean; acousticStale: boolean }>,
    config: EffectiveConfig,
    tmpDir: string,
    onProgress?: (processed: number, total: number, currentItem?: string) => void,
    scope: SegmentScope = FULL_SCOPE,
): Promise<{
    seasonsProcessed: number;
    segmentsProduced: number;
    episodesProcessed: number;
    completedIds: string[];
    attemptedIds: string[];
    /** Real errors only: a detector crash, a checkpoint DB failure. */
    incomplete: boolean;
    /** A season held back by the stability gate. Not a failure. */
    deferred: boolean;
    /** Items that simply retry next round (timeout back-off, input changed, no input yet). */
    deferredIds: string[];
}> {
    let segmentsProduced = 0;
    let incomplete = false;
    let deferred = false;
    const deferredIds = new Set<string>();
    const attemptedIds = new Set<string>();
    const completedIds = new Set<string>();
    const originalScope = scope;
    scope = {
        ...scope,
        onAttempt: (id) => {
            attemptedIds.add(id);
            originalScope.onAttempt?.(id);
        },
    };

    const doPerItem = config.chapterDetection !== false || config.blackframeDetection !== false;
    // Chromaprint stays governed by configuration and acoustic staleness, never
    // by the type scope: it is the primary INTRO detector, so an Intro-scoped
    // run is the one that needs it most.
    const doChroma = config.chromaprintDetection !== false;
    const concurrency = Math.max(1, config.episodeConcurrency ?? 1);

    let seasonIdx = 0;
    for (const { seasonId, visualStale, acousticStale } of seasons) {
        if (signal.aborted || scope.shouldYield?.()) break;

        // Tombstones are per stage, so the two detector groups need different
        // episode sets. Using the visually-filtered set for BOTH meant a
        // visually-tombstoned episode could never receive an acoustic row: its
        // season stayed acousticStale forever, pinning the head of the ordered
        // slice, and re-ran the fingerprint pass on every drain without ever
        // resolving.
        const episodeRows = await sql<
            Array<{ id: string; visual_blocked: boolean; acoustic_blocked: boolean }>
        >`
            SELECT DISTINCT ep.id
                 , EXISTS (
                       SELECT 1 FROM media_item_stage_state miss
                       WHERE miss.stage_id = ${ANALYZER_VISUAL_STAGE_ID}
                         AND miss.media_item_id = ep.id
                         AND (miss.status IN ('completed', 'skipped_permanent') OR miss.next_eligible_at > now())
                         AND ${analyzerStageEvidenceSql(sql)}
                          AND miss.processing_version >= ${VISUAL_PROCESSING_VERSION}
                   ) AS visual_blocked
                 , EXISTS (
                       SELECT 1 FROM media_item_stage_state miss
                       WHERE miss.stage_id = ${ANALYZER_ACOUSTIC_STAGE_ID}
                         AND miss.media_item_id = ep.id
                         AND (miss.status = 'skipped_permanent' OR miss.next_eligible_at > now())
                         AND ${analyzerStageEvidenceSql(sql)}
                          AND miss.processing_version >= ${ACOUSTIC_PROCESSING_VERSION}
                   ) AS acoustic_blocked
            FROM media_items ep
            JOIN media_file_items mfi ON mfi.media_item_id = ep.id
            JOIN media_files mf ON mf.id = mfi.file_id
            WHERE ep.parent_id = ${seasonId}
              AND ep.media_type = 'episode' AND ep.status <> 'deleted'
              AND ${analyzableVideoFileSql(sql)}
        `;
        if (episodeRows.length === 0) continue;

        // Poison episodes tombstoned at the current version are skipped for that
        // group's work: the season is here for its OTHER unanalyzed episodes, and
        // re-running a quarantined one would just fail and re-quarantine.
        const episodeIds = episodeRows.filter((r) => !r.visual_blocked).map((r) => r.id);
        const acousticEpisodeIds = episodeRows.filter((r) => !r.acoustic_blocked).map((r) => r.id);
        if (episodeIds.length === 0 && acousticEpisodeIds.length === 0) continue;

        // The fingerprint pass is gated on the season being quiet, and that check
        // has to come BEFORE the per-item visual work. Otherwise the visual stage is
        // completed first, and a deferred season ends up with its visual rows marked
        // while its fingerprint pass never runs. Visual-only staleness is not gated:
        // the per-episode detectors do not need the whole cohort.
        if (doChroma && acousticStale && !(await seasonStableOrDefer(sql, seasonId, logger))) {
            deferred = true;
            seasonIdx++;
            onProgress?.(seasonIdx, seasons.length, seasonId);
            continue;
        }

        let acousticProofs: ReadonlyMap<string, AnalyzerInputSnapshot> = new Map();
        if (doPerItem && visualStale) {
            let processed = 0;
            const idQueue = [...episodeIds];
            async function perItemWorker() {
                while (true) {
                    if (signal.aborted || scope.shouldYield?.()) return;
                    const episodeId = idQueue.shift();
                    if (!episodeId) return;
                    try {
                        const produced = await analyzeItem(
                            sql,
                            episodeId,
                            config,
                            logger,
                            signal,
                            scope,
                        );
                        segmentsProduced += produced.segments;
                        // Checkpoint each finished item before admitting another one or
                        // starting the season's expensive acoustic pass.
                        try {
                            const marked = await markAnalyzed(
                                sql,
                                [episodeId],
                                ANALYZER_VISUAL_STAGE_ID,
                                VISUAL_PROCESSING_VERSION,
                                new Map([[episodeId, produced.input]]),
                                scope,
                            );
                            for (const id of marked) completedIds.add(id);
                            // Nothing was written because the file changed since the
                            // detectors read it. The item stays eligible: retry later.
                            if (marked.length !== 1) deferredIds.add(episodeId);
                        } catch (err) {
                            incomplete = true;
                            logger.warn('Visual checkpoint failed; item remains eligible', {
                                error: String(err),
                            });
                        }
                    } catch (err) {
                        const reason = err instanceof Error ? err.message : String(err);
                        logger.warn(`Drain: per-item failed for ${episodeId}`, {
                            error: reason,
                        });
                        // A failed detector must stay eligible. recordFailure logs
                        // the forensic timeline; the quarantine
                        // wrapper bounds the retries so a poison episode stops burning
                        // ffmpeg every cycle once it has failed enough times. An abort
                        // (deploy/cancel) or a timeout is not a strike: see
                        // recordFailureByCause.
                        const cause = await recordFailureByCause(sql, logger, episodeId, err, {
                            reason,
                            signal,
                        });
                        // Only a recorded failure is a real error. A timeout (backed off
                        // by design), a cooldown, a changed input or a shutdown abort
                        // leaves the item eligible and says nothing about the run.
                        if (cause === 'recorded') incomplete = true;
                        else deferredIds.add(episodeId);
                    }
                    processed++;
                    onProgress?.(processed, episodeIds.length, episodeId);
                }
            }
            await Promise.all(
                Array.from({ length: Math.min(concurrency, episodeIds.length) }, perItemWorker),
            );
        }

        if (signal.aborted || scope.shouldYield?.()) break;

        // Set only when the fingerprint pass actually executed AND succeeded.
        let chromaRan = false;
        // Set when the pass reported a deferral. The pre-check above normally
        // catches that first, but the season can start settling between the two
        // checks, and then its rows already hold the deferral.
        let seasonDeferred = false;
        if (doChroma && acousticStale) {
            try {
                const outcome = await analyzeSingleSeasonChromaprint(
                    sql,
                    logger,
                    signal,
                    seasonId,
                    tmpDir,
                    config,
                    concurrency,
                    config.ffmpegThreads ?? serverConfig.ANALYSIS_FFMPEG_THREADS,
                    scope,
                );
                segmentsProduced += outcome.segments;
                acousticProofs = outcome.inputs ?? new Map();
                seasonDeferred = outcome.deferred;
                if (outcome.deferred) deferred = true;
                // Fewer than two usable files: nothing to pair against yet. The season
                // is retried once its cohort is complete; not an error.
                if (outcome.unavailable) for (const id of acousticEpisodeIds) deferredIds.add(id);
                chromaRan = !outcome.deferred && !outcome.unavailable;
            } catch (err) {
                if (err instanceof AnalysisBudgetReachedError) break;
                const reason = err instanceof Error ? err.message : String(err);
                if (isStaleAnalysisFailure(err)) seasonDeferred = true;
                logger.warn(`Drain: chromaprint failed for season ${seasonId}`, {
                    error: reason,
                });
                // A deterministically-failing season (corrupt cohort file,
                // chromaprint binary crash on this codec, …) would otherwise be
                // fully re-analyzed — chapter + blackframe + chromaprint — every
                // scheduled drain forever, because the acoustic stage staying
                // unmarked keeps every episode in this season eligible again
                // next cycle. Route the failure through the same
                // per-episode poison quarantine used for per-item failures: once
                // an episode has failed `POISON_FAILURE_THRESHOLD` times without
                // ever completing, it's tombstoned `skipped_permanent`, and once
                // ALL episodes in the season are resolved (completed or
                // tombstoned) `getUnanalyzedSeasons` naturally excludes the season.
                const causes = await Promise.all(
                    acousticEpisodeIds.map((episodeId) =>
                        recordFailureByCause(sql, logger, episodeId, err, {
                            reason: `season-chromaprint: ${reason}`,
                            signal,
                            stageId: ANALYZER_ACOUSTIC_STAGE_ID,
                            processingVersion: ACOUSTIC_PROCESSING_VERSION,
                        }),
                    ),
                );
                // A timeout, cooldown, changed input or abort retries later. Anything
                // else (chromaprint crash, corrupt cohort file) is a real error.
                if (!causes.includes('recorded') && isRetryLaterFailure(err)) {
                    for (const id of acousticEpisodeIds) deferredIds.add(id);
                } else {
                    incomplete = true;
                }
            }
        }

        // A deferred season keeps the deferral on both stages: marking either one
        // here would overwrite it with 'completed' and drop the season from the
        // deferred set before its fingerprint pass has run.
        if (!signal.aborted && !seasonDeferred) {
            // Only when the pass genuinely executed. The old combined flag was
            // also set when chromaprint was DISABLED, so the marker recorded
            // fingerprint work that never happened — leaving those episodes
            // permanently un-fingerprinted if it was later enabled.
            if (chromaRan) {
                try {
                    const marked = await markAnalyzed(
                        sql,
                        acousticEpisodeIds,
                        ANALYZER_ACOUSTIC_STAGE_ID,
                        ACOUSTIC_PROCESSING_VERSION,
                        acousticProofs,
                        scope,
                    );
                    for (const id of marked) completedIds.add(id);
                    // Episodes that were skipped (input changed since fingerprinting)
                    // stay eligible and retry later.
                    for (const id of acousticEpisodeIds)
                        if (!marked.includes(id)) deferredIds.add(id);
                } catch (err) {
                    incomplete = true;
                    logger.warn(
                        `markAnalyzed(acoustic) failed for season ${seasonId} — drain will retry next run`,
                        {
                            error: err instanceof Error ? err.message : String(err),
                        },
                    );
                }
            }
        }

        seasonIdx++;
        onProgress?.(seasonIdx, seasons.length, seasonId);
    }

    return {
        seasonsProcessed: seasonIdx,
        segmentsProduced,
        episodesProcessed: completedIds.size,
        completedIds: [...completedIds],
        attemptedIds: [...attemptedIds],
        incomplete,
        deferred,
        deferredIds: [...deferredIds],
    };
}

/**
 * Drain pass for items with no season cohort: single-episode seasons, and films.
 * A cohort needs a second episode to pair against, so these run ONLY chapter +
 * blackframe detection on each item and mark it analysed regardless of cohort
 * availability. Films never reach the acoustic stage for the same reason.
 */
async function analyzeSingleEpisodeFallback(
    sql: postgres.Sql,
    logger: SdkLogger,
    signal: AbortSignal,
    mediaIds: readonly string[],
    config: EffectiveConfig,
    onProgress?: (processed: number, total: number, currentItem?: string) => void,
    scope: SegmentScope = FULL_SCOPE,
): Promise<{
    segmentsProduced: number;
    episodesProcessed: number;
    completedIds: string[];
    attemptedIds: string[];
    /** Real errors only: a detector crash, a checkpoint DB failure. */
    incomplete: boolean;
    /** A season held back by the stability gate. Not a failure. */
    deferred: boolean;
    /** Items that simply retry next round (timeout back-off, input changed, no input yet). */
    deferredIds: string[];
}> {
    let segmentsProduced = 0;
    let incomplete = false;
    let deferred = false;
    const deferredIds = new Set<string>();
    const attemptedIds = new Set<string>();
    const completedIds = new Set<string>();
    const originalScope = scope;
    scope = {
        ...scope,
        onAttempt: (id) => {
            attemptedIds.add(id);
            originalScope.onAttempt?.(id);
        },
    };
    const concurrency = Math.max(1, config.episodeConcurrency ?? 1);
    const queue = [...mediaIds];
    let processed = 0;

    async function worker() {
        while (true) {
            if (signal.aborted || scope.shouldYield?.()) return;
            const mediaId = queue.shift();
            if (!mediaId) return;
            try {
                const outcome = await analyzeItem(sql, mediaId, config, logger, signal, scope);
                segmentsProduced += outcome.segments;
                const marked = await markAnalyzed(
                    sql,
                    [mediaId],
                    ANALYZER_VISUAL_STAGE_ID,
                    VISUAL_PROCESSING_VERSION,
                    new Map([[mediaId, outcome.input]]),
                    scope,
                );
                for (const id of marked) completedIds.add(id);
                if (marked.length !== 1) deferredIds.add(mediaId);
            } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                logger.warn(`Single-item drain: per-item failed for ${mediaId}`, {
                    error: reason,
                });
                // Without a cohort there is no other bound: a poison item would be
                // re-selected on every run, so count it against the quarantine.
                // Aborts and timeouts are routed by cause (see recordFailureByCause).
                const cause = await recordFailureByCause(sql, logger, mediaId, err, {
                    reason,
                    signal,
                });
                if (cause === 'recorded') incomplete = true;
                else deferredIds.add(mediaId);
            }
            processed++;
            onProgress?.(processed, mediaIds.length, mediaId);
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, mediaIds.length || 1) }, worker));

    return {
        segmentsProduced,
        episodesProcessed: completedIds.size,
        completedIds: [...completedIds],
        attemptedIds: [...attemptedIds],
        incomplete,
        deferred,
        deferredIds: [...deferredIds],
    };
}

// ============================================================================
// Input schema + task definition
// ============================================================================

const inputSchema = z
    .object({
        /**
         * Which segment types this run may decide and retract. Absent means all
         * of them (an ordinary full pass).
         */
        segmentTypes: z
            .array(z.enum(['Intro', 'Outro']))
            .nonempty()
            .optional(),
        /** @deprecated The retired spelling of `segmentTypes: ['Outro']`. */
        outroOnly: z.literal(true).optional(),
    })
    .passthrough();

type IntroAnalyzerInput = z.infer<typeof inputSchema>;

interface IntroAnalyzerResult {
    pendingBacklog?: { seasons: number; singleEpisodes: number; movies: number };
    seasonsProcessed: number;
    segmentsProduced: number;
    fingerprintsProcessed?: number;
    analysisOutcome?: 'completed' | 'no-detection' | 'partial' | 'deferred' | 'skipped';
    itemsAttempted?: number;
    itemsCompleted?: number;
    /** Items left eligible on purpose (timeout back-off, changed input). Not failures. */
    deferredItems?: number;
    itemsAbstained?: number;
    skipReason?: 'disabled' | 'no-methods' | 'no-eligible-targets';
}

async function getTmpDir(): Promise<string> {
    const dataBaseDir = serverConfig.BASE_PATH || '.cache';
    const dir = path.join(dataBaseDir, 'plugins', PLUGIN_ID);
    // safeMkdir routes through the fs-guard semaphore (bounded concurrency +
    // timeout) instead of blocking the event loop with a sync syscall; `{
    // recursive: true }` makes it a no-op (no EEXIST throw) when the dir
    // already exists, so no separate existence check is needed.
    await safeMkdir(dir, { recursive: true });
    return dir;
}

function getNamespacedCache() {
    return cacheManager.getCache(`plugin:${PLUGIN_ID}`, {
        l1TTL: 5 * 60 * 1000,
        l2TTL: 12 * 60 * 60 * 1000,
    });
}

export const lumastraIntroAnalyzerTask = defineTask<IntroAnalyzerInput, IntroAnalyzerResult>({
    id: PLUGIN_ID,
    purpose: 'library',
    confirmBeforeRun: true,
    name: 'Lumastra Intro Analyzer',
    description:
        'Detects intro / outro / recap / preview / commercial segments in episodes via FFmpeg fingerprint + chromaprint matching. Results power skip buttons in the player. Tune throughput with the batchSize and episodeConcurrency settings.',
    version: '2.0.0',
    processingVersion: PROCESSING_VERSION,
    minAppVersion: '0.0.0',

    capabilities: { database: true, ffmpeg: true, cache: true },

    // The schedule is a fallback; stage-sweep also triggers pending visual work.
    // Each catchup yields after 30 minutes of admissions, independent of season size.
    // Operators can set PLUGIN_LUMASTRA_INTRO_ANALYZER_INTERVAL_HOURS.
    schedule: {
        every: '6h',
        runOnStartup: false,
        envOverride: 'PLUGIN_LUMASTRA_INTRO_ANALYZER_INTERVAL_HOURS',
    },

    identityFor: (input) => {
        const i = input as Record<string, unknown>;
        if (typeof i.mediaId === 'string' && i.mediaId) return `media-${i.mediaId}`;
        if (typeof i.seasonId === 'string' && i.seasonId) return `season-${i.seasonId}`;
        if (typeof i.seriesId === 'string' && i.seriesId) return `series-${i.seriesId}`;
        if (Array.isArray(i.seasonIds)) {
            const ids = i.seasonIds.filter((id): id is string => typeof id === 'string').sort();
            const semantics = JSON.stringify({
                // Two scoped requests over the same seasons decide different
                // things, so they must not collapse onto one another.
                segmentTypes: Array.isArray(i.segmentTypes)
                    ? [...i.segmentTypes].sort()
                    : i.outroOnly === true
                      ? ['Outro']
                      : null,
                reset: i.reset === true,
                mode: typeof i.mode === 'string' ? i.mode : 'catchup',
            });
            return `seasons-${createHash('sha256')
                .update(`${ids.join(',')}|${semantics}`)
                .digest('hex')
                .slice(0, 16)}`;
        }
        return 'global';
    },

    scope: 'global',
    // Dedicated `analysis` pool — isolated from `cpu` so trickplay-generation
    // and intro-analyzer can't starve each other. Previously shared `cpu` +
    // taskPriority=3 trickplay-jump-cut, but BullMQ's strict-priority popper
    // meant intro starved trickplay (or vice versa) depending on backlog
    // direction. Separate class delivers true fairness with no per-task
    // priority tuning. See the `'analysis'` entry in SDK RESOURCE_CLASSES
    // for the full rationale.
    resourceClass: 'analysis',
    // A local FFmpeg semaphore is per isolate. Bound runs too, otherwise every
    // isolated job would admit its own visual decoder on the same worker.
    quotas: { maxConcurrent: 1 },
    // Manual mode drains until empty or its six-hour admission budget; remaining
    // work (including an unfinished acoustic cohort) resumes from durable evidence.
    supportsFullRun: true,

    // Run execute() in a worker thread when FEATURE_PLUGIN_WORKER_ISOLATION is
    // on (default off → unchanged in-process path). Phase 2 isolation candidate:
    // long-running (per-season chromaprint, ~tens of minutes/hours) so the
    // biggest busy-loop blast-radius today and the biggest payoff from a
    // hard-killable thread.
    isolation: 'worker',

    inputSchema,

    coversStages: [
        {
            // The framework-owned per-item drain corresponds to the VISUAL
            // detector group. The legacy combined id is no longer written by any
            // code path, so leaving it here left the sweep with a backlog that
            // could never shrink — shouldSkipGlobalEnqueue would then re-enqueue
            // global runs on its backoff ladder forever and the admin coverage
            // grid would report the whole episode library as outstanding.
            //
            // The acoustic stage is deliberately NOT swept: it is season-scoped
            // work owned by this task's own drain loop, and its eligibility is
            // computed from row ABSENCE in getUnanalyzedSeasons rather than from
            // seeded pending rows.
            id: ANALYZER_VISUAL_STAGE_ID,
            // 🔴 The version the rows actually carry. The task's
            // `processingVersion` is detector PROVENANCE and moves for reasons
            // that have nothing to do with visual eligibility; `markAnalyzed`
            // stamps VISUAL_PROCESSING_VERSION. Before this was declared the
            // ledger held 4 while all 14,651 completed rows held 5, so a real
            // bump marked nothing obsolete and a provenance bump would have
            // re-analysed the entire library.
            processingVersion: VISUAL_PROCESSING_VERSION,
            appliesTo: ['movie', 'episode'] as const,
            // Movies use the same file fence as their drain and input snapshot;
            // they have no season or acoustic stage. Keep episode/specials policy.
            // Eligibility: an episode with a present file, a probed video stream, a
            // runtime over 60s (too-short clips have no intro to detect), and a
            // non-specials parent season (season_number != 0). Episodes seeded
            // before media-probe are disposed `skipped_permanent/'ineligible'` and
            // healed when the stream lands — the event-independent rail that closed
            // the 34k-episode cold-start loss. `file_path IS NOT NULL` so a healed
            // episode also counts toward the season-analyzable disposition below (no
            // re-skip oscillation). The specials exclusion is a static parent-join
            // (season_number = 0 never changes), so it belongs here in the domain
            // declaration rather than as a separate terminalDisposition predicate.
            eligibility: {
                sql: (sql) => sql`
                    (
                        mi.media_type = 'movie'
                        AND ${movieVisualDetectionEnabledSql(sql)}
                        AND mi.status <> 'deleted'
                        AND EXISTS (
                            SELECT 1 FROM media_file_items mfi
                            JOIN media_files mf ON mf.id = mfi.file_id
                            WHERE mfi.media_item_id = mi.id
                              AND ${analyzableVideoFileSql(sql)}
                        )
                    )
                    OR (
                        mi.media_type = 'episode' AND mi.status <> 'deleted'
                        AND EXISTS (
                            SELECT 1 FROM media_file_items mfi
                              JOIN media_files mf ON mf.id = mfi.file_id
                             WHERE mfi.media_item_id = mi.id AND ${analyzableVideoFileSql(sql)}
                        )

                        AND NOT EXISTS (
                            SELECT 1 FROM media_items s
                             WHERE s.id = mi.parent_id
                               AND s.media_type = 'season'
                               AND s.season_number = 0
                        )
                    )
                `,
                // Migration window (A8): installs that ran the pre-quiet-gate code
                // hold rows skipped under 'season-has-no-analyzable-episodes' whose
                // seasons now have analyzable files; eligibility implies >=1 analyzable
                // episode, so recovering them is safe. The observed season disposition
                // itself stays in terminalDisposition below (a season genuinely with no
                // analyzable episodes must stay skipped_permanent — NOT healed).
                recoverWhenAdditionalReasons: [
                    'season-has-no-analyzable-episodes',
                    'specials-season-not-analyzed',
                    MOVIE_VISUAL_DISABLED_REASON,
                ],
            },
            invalidatedBy: [
                'file.attached',
                'file.detached',
                'file.contentChanged',
                'file.defaultChanged',
                // The analysed span is the episode's window inside a shared
                // file: a moved window is a different span.
                'file.windowChanged',
                'file.probed',
            ] as const,
            // Adding an alternate-version file must not re-run intro/outro
            // detection for an episode that's already analysed.
            preserveCompletedOn: ['file.attached'] as const,
            enqueueable: true,
            // Framework-owned bulk drain (Declarative Stage Contract Phase 2 /
            // eligibility-first Phase 3). Specials (season 0) are excluded via
            // eligibility.sql above — a static domain restriction, not a
            // runtime-gated conclusion. Alongside the movie settings gate,
            // the episode predicate handles seasons with ZERO analyzable
            // (file-bearing) episodes — an
            // upstream-gated conclusion that requires the scan to have quietened
            // before firing (requiresQuietUpstream), so it stays in
            // terminalDisposition rather than eligibility.
            terminalDisposition: [
                {
                    // Movies have no acoustic path. With both visual detectors
                    // disabled, the global drain cannot complete their rows.
                    // The matching eligibility gate and recovery reason keep this
                    // terminal while disabled, then reopen only when it is enabled.
                    kind: 'predicate',
                    ruleId: MOVIE_VISUAL_DISABLED_REASON,
                    disposeAs: 'skipped_permanent',
                    reason: MOVIE_VISUAL_DISABLED_REASON,
                    excludes: (sql) => sql`
                        mi.media_type = 'movie' AND NOT ${movieVisualDetectionEnabledSql(sql)}
                    `,
                },
                {
                    // A file-bearing episode is ALWAYS analyzable: chromaprint when
                    // its season has >=2 file-bearing episodes, else the
                    // chapter/blackframe single-episode fallback (execute()). So we
                    // only tombstone seasons with ZERO analyzable (file-bearing)
                    // episodes — never a single-file-episode season the fallback
                    // handles. Counting raw episode rows (the previous `< 2`)
                    // wrongly tombstoned single-file-episode seasons → over-disposal.
                    // (The fallback-disabled config tombstones single-episode rows
                    // in execute() instead — see the `!doPerItemFallback` branch.)
                    kind: 'predicate',
                    ruleId: 'season-has-no-analyzable-episodes',
                    disposeAs: 'skipped_permanent',
                    reason: 'season-has-no-analyzable-episodes',
                    excludes: (sql) => sql`
                    EXISTS (
                        SELECT 1
                          FROM media_items season
                         WHERE season.id = mi.parent_id
                           AND season.media_type = 'season'
                           AND mi.media_type = 'episode'
                           -- exclude specials so the more-specific reason above isn't clobbered
                           AND (season.season_number IS NULL OR season.season_number != 0)
                           -- NOT EXISTS, not COUNT(*) < 1: same rows, but it stops at the
                           -- first analyzable sibling instead of counting the season.
                           AND NOT EXISTS (
                               SELECT 1
                                 FROM media_items sib
                                 JOIN media_file_items mfi ON mfi.media_item_id = sib.id
                                 JOIN media_files mf ON mf.id = mfi.file_id
                                WHERE sib.parent_id = season.id
                                  AND sib.media_type = 'episode'
                                  AND ${analyzableVideoFileSql(sql)}
                           )
                    )
                `,
                    // Cold-start safety: this rule reads file linkage, which a
                    // fresh large install populates incrementally over the
                    // initial scan/probe. Without this gate the sweep evaluates
                    // it against a half-linked season and PERMANENTLY tombstones
                    // episodes that become analyzable minutes later (the
                    // 70%-of-library mass-skip incident). The gate holds the
                    // skip until the season's files have been quiet for the same
                    // stability window execute() already trusts — or fires
                    // immediately when the season has no files at all.
                    requiresQuietUpstream: {
                        windowMs: SEASON_SCAN_STABILITY_MS,
                        scope: 'parent',
                    },
                },
            ],
        },
    ],

    timeout: { hard: '7h', soft: '6h' },

    // Singleton guard for the SCHEDULED global drain. identityFor returns a
    // constant 'global' for the empty scheduled input, and hard (7h) exceeds
    // the 6h schedule interval, so on a large library a per-season chromaprint
    // pass still running at the next 6h tick would (without this) spawn a second
    // concurrent 'global' run — redundant work piling up every cycle. exclusiveWith
    // SETNX-collapses same-identity fires, so only one 'global' drain runs at a
    // time. Per-item runs (media-/season-/series- identities) are unaffected —
    // their distinct identity keys are independent. ttl >= timeout.hard (SDK).
    // ttl must be >= timeout.hard (7h); 8h gives margin. The 30h widening for
    // the multi-attempt global-mode handoff is gone with that subsystem: there
    // is only one global mode again, so nothing is retried across attempts to
    // hold the slot for.
    exclusiveWith: { scope: 'global', ttl: '8h' },

    // Field descriptions are OPERATOR copy (rendered in the admin task
    // settings). Maintainer rationale lives in the comments beside them — it
    // used to sit in the descriptions ("2026-05-24: bumped 2→4…").
    settings: {
        fields: [
            {
                key: 'chapterDetection',
                type: 'boolean',
                label: 'Chapter name detection',
                description: 'Detect segments from embedded chapter metadata (no FFmpeg needed)',
                default: true,
            },
            {
                key: 'blackframeDetection',
                type: 'boolean',
                label: 'Black frame credits detection',
                description: 'Detect credits via black frame analysis (requires FFmpeg)',
                default: true,
            },
            {
                key: 'chromaprintDetection',
                type: 'boolean',
                label: 'Audio fingerprint intro detection',
                description:
                    'Detect intros by comparing audio across episodes in a season (requires FFmpeg with chromaprint)',
                default: true,
            },
            {
                key: 'batchSize',
                type: 'number',
                label: 'Seasons per scheduled run',
                description:
                    'Maximum seasons one scheduled run analyses. The run also pauses after its time budget; remaining work continues on the next run.',
                default: 150,
            },
            {
                key: 'episodeConcurrency',
                type: 'number',
                label: 'Episode concurrency',
                description:
                    'Episodes prepared at the same time. Visual FFmpeg decodes run one at a time to bound memory, including 4K files.',
                default: 2,
            },
            {
                key: 'ffmpegThreads',
                type: 'number',
                label: 'FFmpeg threads per operation',
                description:
                    'Decoder and filter threads per FFmpeg process. Uses Analysis Thread Count when unset; explicit 0 lets FFmpeg decide.',
                default: 2,
            },
            // Lowered 300 → 120 for stricter cohort matches.
            {
                key: 'maxIntroDuration',
                type: 'number',
                label: 'Max intro duration (seconds)',
                description: 'Longest intro that will be accepted.',
                advanced: true,
                default: 120,
            },
            {
                key: 'maxCreditsDuration',
                type: 'number',
                label: 'Credits search window (seconds)',
                description:
                    'How far before the end of an episode to look for closing credits. This only widens the search — the longest credits that are accepted is set separately below.',
                advanced: true,
                default: 300,
            },
            {
                key: 'maxMovieCreditsDuration',
                type: 'number',
                label: 'Movie credits search window (seconds)',
                description: 'The same search window for movies, whose credits run longer.',
                advanced: true,
                default: 900,
            },
            // Deliberately separate from the search window (maxCreditsDuration):
            // the blackframe detector must find a sustained near-total-black
            // transition before accepting a dark-scene tail. Usually not the
            // binding constraint — outroMinStartFraction caps credits at
            // (1 − fraction) of runtime, i.e. 264 s on a 22-minute episode.
            // Movies are exempt from that rule, so their bound binds alone.
            {
                key: 'maxPlausibleCreditsDuration',
                type: 'number',
                label: 'Max plausible credits length, episodes (seconds)',
                description:
                    'Longest closing credits an episode may have; a longer detection is discarded.',
                advanced: true,
                default: 150,
            },
            {
                key: 'maxPlausibleMovieCreditsDuration',
                type: 'number',
                label: 'Max plausible credits length, movies (seconds)',
                description:
                    'Longest closing credits a movie may have; a longer detection is discarded.',
                advanced: true,
                default: 900,
            },
            // Also gates the untitled-chapter-mark detector and suppresses the
            // blackframe pass when a chapter Outro already sits past it.
            // Blackframe boundaries quantise to 4 s buckets (see snapToleranceSec).
            {
                key: 'outroMinStartFraction',
                type: 'number',
                label: 'Minimum credits start position (0–1)',
                description:
                    'How far into an episode the credits must start. 0.80 means anything that starts before 80 % of the runtime is not treated as credits. Not applied to movies.',
                advanced: true,
                default: 0.8,
            },
            {
                key: 'snapToleranceSec',
                type: 'number',
                label: 'Chapter snap tolerance (seconds)',
                description:
                    'How far a detected start or end may move to line up with a chapter mark in the file. 0 turns this off.',
                advanced: true,
                default: 10,
            },
            {
                key: 'maxPointDifferences',
                type: 'number',
                label: 'Audio match tolerance',
                description:
                    'How different two audio fingerprints may be and still count as the same intro. Lower is stricter; raise it only if intros are being missed.',
                advanced: true,
                default: 6,
            },
            {
                key: 'maxTimeSkip',
                type: 'number',
                label: 'Audio match gap (seconds)',
                description:
                    'Largest gap between matching audio moments before a match counts as broken.',
                advanced: true,
                default: 3.5,
            },
            {
                key: 'introWindowFraction',
                type: 'number',
                label: 'Intro search window (share of episode, 0–1)',
                description:
                    'How much of each episode, from the start, is searched for the intro. 0.25 = the first quarter.',
                advanced: true,
                default: 0.25,
            },
            {
                key: 'introWindowMaxSec',
                type: 'number',
                label: 'Intro search window limit (seconds)',
                description: 'Upper limit on that search window.',
                advanced: true,
                default: 600,
            },
            {
                key: 'invertedIndexShift',
                type: 'number',
                label: 'Audio index tolerance',
                description:
                    'How loosely the audio search index matches. Higher finds more candidates but is slower.',
                advanced: true,
                default: 2,
            },
            {
                key: 'minSegmentDuration',
                type: 'number',
                label: 'Shortest segment (seconds)',
                description: 'Ignore detected intros or credits shorter than this.',
                advanced: true,
                default: 15,
            },
            {
                key: 'animePreviewFromCreditsEnd',
                type: 'boolean',
                label: 'Anime: mark a preview after the credits',
                description:
                    'After the credits, mark what remains of the episode (at least 5 seconds) as a Preview, as anime episodes often end with one. It is not detected automatically — turn it on only if your library is mostly anime.',
                default: false,
            },
        ],
    },

    backlog: {
        unitLabel: 'seasons',
        sliceSize: 1,
        softBudget: '6h',
        idOf: (row) => {
            const r = row as { seasonId?: unknown } | null | undefined;
            if (!r || typeof r.seasonId !== 'string') {
                throw new Error('lumastra-intro-analyzer: backlog row missing seasonId');
            }
            return r.seasonId;
        },
        async stages(ctx: TaskContext): Promise<BacklogStage[]> {
            // The visual stage is what the drain gates on; the legacy combined
            // stage id no longer receives writes, so counting against it would
            // report the whole library as permanently outstanding.
            const status = await countBacklog(
                ctx.sql,
                ANALYZER_VISUAL_STAGE_ID,
                VISUAL_PROCESSING_VERSION,
            );
            const stages: BacklogStage[] = [];
            if (status.remaining > 0) {
                stages.push({
                    id: 'remaining',
                    label: 'Remaining',
                    count: status.remaining,
                });
            }
            if (status.ineligible > 0) {
                stages.push({
                    id: 'ineligible',
                    label: 'Ineligible (< 2 episodes)',
                    count: status.ineligible,
                });
            }
            return stages;
        },
        async wipe(ctx: TaskContext): Promise<void> {
            await wipeAll(ctx.sql, ctx.logger);
        },
        async compute(): Promise<{ items: unknown[]; remainingHint?: number }> {
            return { items: [], remainingHint: 0 };
        },
    },

    retry: {
        attempts: 3,
        backoff: 'exponential',
        retryOn: classifyInfraError,
    },

    async execute(ctx) {
        const { sql, logger, signal, reportProgress } = ctx;
        const drainStartedAt = Date.now();

        if (!serverConfig.PLUGIN_LUMASTRA_INTRO_ANALYZER_ENABLED) {
            return {
                success: false,
                itemsProcessed: 0,
                result: {
                    seasonsProcessed: 0,
                    segmentsProduced: 0,
                    analysisOutcome: 'skipped',
                    skipReason: 'disabled',
                },
            };
        }

        const rawInput = (ctx.input as Record<string, unknown>) ?? {};
        const config = await readTaskSettings(sql, logger);
        const reset = rawInput.reset === true;
        const requestedTypes = readRequestedScope(rawInput);
        const scopeNarrowed = requestedTypes !== undefined;
        const tmpDir = await getTmpDir();

        // Reconciliation of ineligible episodes (specials season; season with
        // fewer than 2 episodes) is now framework-owned: stage-sweep runs the
        // declared `terminalDisposition` predicates on this stage immediately
        // before scanning candidates, draining those rows to
        // `skipped_permanent`. See `coversStages.terminalDisposition` above and
        // `stage-disposition-runner.ts`. The previous inline two-pass UPDATE
        // block was removed in the Declarative Stage Contract Phase 2 migration.

        // Early exit when all detection methods are disabled
        const doPerItemGlobal =
            config.chapterDetection !== false || config.blackframeDetection !== false;
        const doChromaGlobal = config.chromaprintDetection !== false;
        const hasExplicitTarget =
            (typeof rawInput.mediaId === 'string' && rawInput.mediaId.length > 0) ||
            (typeof rawInput.seasonId === 'string' && rawInput.seasonId.length > 0) ||
            (typeof rawInput.seriesId === 'string' && rawInput.seriesId.length > 0) ||
            Array.isArray(rawInput.seasonIds);
        if (!doPerItemGlobal && !doChromaGlobal && !(scopeNarrowed && !hasExplicitTarget)) {
            logger.warn('No detection method enabled; nothing to do');
            return {
                success: false,
                itemsProcessed: 0,
                result: {
                    seasonsProcessed: 0,
                    segmentsProduced: 0,
                    analysisOutcome: 'skipped',
                    skipReason: 'no-methods',
                },
            };
        }

        // A library-wide scoped refresh is a request to re-run VISUAL detection
        // across the library. Rewinding that stage hands the work to the
        // ordinary drain below, which runs the complete visual detector set and
        // re-resolves against the acoustic evidence it never touches.
        //
        // The former standalone campaign ran a strict SUBSET of the Outro
        // detectors while retracting evidence from all of them, so it could
        // permanently downgrade an episode whose best answer came from
        // chromaprint or cohort with nothing left to regenerate it.
        const scopeLabel = (requestedTypes ?? MATERIALIZED_SEGMENT_TYPES).join('+');
        if (scopeNarrowed && !hasExplicitTarget) {
            if (!doPerItemGlobal) {
                const message = `Library-wide ${scopeLabel} refresh requires chapter or blackframe detection; chromaprint-only is unsupported`;
                logger.warn(message);
                throw new Error(message);
            }
            const rewound = await rewindVisualStage(sql);
            logger.info(
                `Library-wide ${scopeLabel} refresh: cleared ${rewound} visual stage rows; the drain re-runs visual detection`,
            );
            // The acoustic stage is untouched, so the drain below skips the
            // expensive fingerprint pass for every season that is still current.
            // From here on this is an ordinary full visual pass whose resolver
            // may only decide and retract the requested types.
        }

        // `visualOnly` follows the TARGET, not the scope: a library-wide pass
        // goes through the ordinary drain (chromaprint included, governed by
        // acoustic staleness), while an operator refresh aimed at one item or
        // season stays on the cheap per-item detectors.
        const attemptedItemIds = new Set<string>();
        const inspectedInputs = new Map<string, string>();
        // Actual new input selection is progress even if the canonical UUIDs
        // repeat after a replacement. An unchanged selection never advances it.
        let inspectedInputRevision = 0;
        const scope: SegmentScope = scopeNarrowed
            ? {
                  types: requestedTypes,
                  onInputSelected: (id, identity) => {
                      if (!hasExplicitTarget && inspectedInputs.get(id) !== identity) {
                          inspectedInputs.set(id, identity);
                          inspectedInputRevision++;
                      }
                  },
                  visualOnly: hasExplicitTarget,
                  runId: ctx.runId,
                  onAttempt: (id) => attemptedItemIds.add(id),
              }
            : { ...FULL_SCOPE, runId: ctx.runId, onAttempt: (id) => attemptedItemIds.add(id) };

        // Admin-targeted: single item
        const rawMediaId = rawInput.mediaId;
        const targetMediaId =
            typeof rawMediaId === 'string' && rawMediaId.length > 0 ? rawMediaId : undefined;

        if (targetMediaId) {
            if (!doPerItemGlobal)
                return {
                    success: false,
                    itemsProcessed: 0,
                    result: {
                        seasonsProcessed: 0,
                        segmentsProduced: 0,
                        analysisOutcome: 'skipped',
                        skipReason: 'no-methods',
                    },
                };
            if (!isUuid(targetMediaId)) {
                throw new Error(`lumastra-intro-analyzer: invalid mediaId "${targetMediaId}"`);
            }
            if (reset) {
                // One transaction, matching the season/series reset below. Split
                // apart, a failure between the two deletes leaves the candidates
                // this pass does NOT own (chromaprint, cohort, anime-synth) in
                // place, and the analyzeItem call directly below re-materializes
                // them — silently defeating the reset for exactly the methods
                // the per-item pass cannot regenerate.
                await withTx(sql, async (tx) => {
                    await acquireMediaSegmentResolutionLock(tx, targetMediaId);
                    await bumpMediaSegmentAnalysisGeneration(tx, [targetMediaId]);
                    // Without the candidates counterpart the very next resolution
                    // restores exactly what the reset just cleared. `manual` is
                    // spared — a reset re-runs the DETECTORS, it does not discard
                    // a human answer.
                    await deleteCandidatesForMedia(tx, targetMediaId, {
                        exceptMethods: PRESERVED_METHODS,
                    });
                    await tx`DELETE FROM media_segments WHERE media_id = ${targetMediaId} AND source = ${PLUGIN_ID}`;
                    await tx`DELETE FROM media_item_stage_state WHERE stage_id = ANY(${[ANALYZER_VISUAL_STAGE_ID, ANALYZER_ACOUSTIC_STAGE_ID]}::text[]) AND media_item_id = ${targetMediaId}`;
                });
            }
            let produced = 0;
            const proofs = new Map<string, AnalyzerInputSnapshot>();
            let ok = false;
            let unavailable = false;
            try {
                const outcome = await analyzeItem(
                    sql,
                    targetMediaId,
                    config,
                    logger,
                    ctx.signal,
                    scope,
                );
                produced = outcome.segments;
                proofs.set(targetMediaId, outcome.input);
                ok = true;
            } catch (err) {
                unavailable = err instanceof AnalysisInputUnavailableError;
                await recordFailureByCause(sql, logger, targetMediaId, err, {
                    reason: err instanceof Error ? err.message : String(err),
                    signal,
                });
                logger.warn(`Targeted: analysis failed for ${targetMediaId}`, {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
            if (ok && !ctx.signal.aborted) {
                const marked = await markAnalyzed(
                    sql,
                    [targetMediaId],
                    ANALYZER_VISUAL_STAGE_ID,
                    VISUAL_PROCESSING_VERSION,
                    proofs,
                    scope,
                );
                ok = marked.includes(targetMediaId);
            }
            // An aborted run may have partial work committed, but the admin
            // asked for it to stop — surface that as a non-success so the
            // task log doesn't show a green checkmark for a cancelled job.
            return {
                success: ok && !ctx.signal.aborted,
                itemsProcessed: ok ? 1 : 0,
                result: {
                    seasonsProcessed: 0,
                    segmentsProduced: produced,
                    analysisOutcome: unavailable
                        ? 'skipped'
                        : ok
                          ? produced === 0
                              ? 'no-detection'
                              : 'completed'
                          : 'partial',
                    itemsAttempted: attemptedItemIds.size,
                    itemsCompleted: ok ? 1 : 0,
                    itemsAbstained: ok && produced === 0 ? 1 : 0,
                    ...(unavailable ? { skipReason: 'no-eligible-targets' as const } : {}),
                },
            };
        }

        // Admin-targeted: season / series / seasonIds
        let targetSeasonIds: string[] | null = null;
        let targetingRequested = false;

        if (Array.isArray(rawInput.seasonIds)) {
            targetingRequested = true;
            const filtered = (rawInput.seasonIds as unknown[]).filter(
                (x): x is string => typeof x === 'string' && x.length > 0,
            );
            const validIds = filtered.filter((x) => isUuid(x));
            if (validIds.length < filtered.length) {
                const invalid = filtered.filter((x) => !isUuid(x));
                throw new Error(
                    `lumastra-intro-analyzer: invalid seasonIds: ${invalid.join(', ')}`,
                );
            }
            targetSeasonIds = [...new Set(validIds)];
        } else if (typeof rawInput.seasonId === 'string' && rawInput.seasonId.length > 0) {
            targetingRequested = true;
            if (!isUuid(rawInput.seasonId)) {
                throw new Error(`lumastra-intro-analyzer: invalid seasonId "${rawInput.seasonId}"`);
            }
            targetSeasonIds = [rawInput.seasonId];
        } else if (typeof rawInput.seriesId === 'string' && rawInput.seriesId.length > 0) {
            targetingRequested = true;
            if (!isUuid(rawInput.seriesId)) {
                throw new Error(`lumastra-intro-analyzer: invalid seriesId "${rawInput.seriesId}"`);
            }
            const rows = await sql<Array<{ id: string }>>`
                SELECT id FROM media_items
                WHERE parent_id = ${rawInput.seriesId}
                  AND media_type = 'season' AND status <> 'deleted'
            `;
            targetSeasonIds = rows.map((r) => r.id);
        }

        if (targetingRequested) {
            if (!targetSeasonIds || targetSeasonIds.length === 0) {
                return {
                    success: false,
                    itemsProcessed: 0,
                    result: {
                        seasonsProcessed: 0,
                        segmentsProduced: 0,
                        analysisOutcome: 'skipped',
                        skipReason: 'no-eligible-targets',
                    },
                };
            }

            if (reset) {
                await withTx(sql, async (tx) => {
                    const targetRows = await tx<Array<{ id: string }>>`
                        SELECT id
                        FROM media_items
                        WHERE parent_id = ANY(${targetSeasonIds}::uuid[])
                          AND media_type = 'episode'
                        ORDER BY id
                    `;
                    await acquireMediaSegmentResolutionLocks(
                        tx,
                        targetRows.map((row) => row.id),
                    );
                    const targetMediaIds = targetRows.map((row) => row.id);
                    await bumpMediaSegmentAnalysisGeneration(tx, targetMediaIds);
                    // Candidates counterpart of the delete above — see the
                    // targeted-reset path for why `manual` survives it.
                    await tx`
                        DELETE FROM media_segment_candidates
                        WHERE method <> ALL(${[...PRESERVED_METHODS]}::text[])
                          AND media_id = ANY(${targetMediaIds}::uuid[])
                    `;
                    await tx`
                        DELETE FROM media_segments
                        WHERE source = ${PLUGIN_ID}
                          AND media_id = ANY(${targetMediaIds}::uuid[])
                    `;
                    await tx`
                        DELETE FROM media_item_stage_state
                        WHERE stage_id = ANY(${[ANALYZER_VISUAL_STAGE_ID, ANALYZER_ACOUSTIC_STAGE_ID]}::text[])
                          AND media_item_id IN (
                              SELECT id FROM media_items
                              WHERE parent_id = ANY(${targetSeasonIds}::uuid[])
                                AND media_type = 'episode'
                          )
                    `;
                });
            }

            const episodeRows = await sql<Array<{ id: string; parent_id: string }>>`
                SELECT DISTINCT ep.id, ep.parent_id
                FROM media_items ep
                JOIN media_file_items mfi ON mfi.media_item_id = ep.id
                JOIN media_files mf ON mf.id = mfi.file_id
                WHERE ep.parent_id = ANY(${targetSeasonIds}::uuid[])
                  AND ep.media_type = 'episode' AND ep.status <> 'deleted'
                  AND ${analyzableVideoFileSql(sql)}
            `;
            const episodeIds = episodeRows.map((r) => r.id);
            if (episodeIds.length === 0)
                return {
                    success: false,
                    itemsProcessed: 0,
                    result: {
                        seasonsProcessed: 0,
                        segmentsProduced: 0,
                        analysisOutcome: 'skipped',
                        skipReason: 'no-eligible-targets',
                    },
                };
            if (!doPerItemGlobal && (scope.visualOnly || !doChromaGlobal))
                return {
                    success: false,
                    itemsProcessed: 0,
                    result: {
                        seasonsProcessed: 0,
                        segmentsProduced: 0,
                        analysisOutcome: 'skipped',
                        skipReason: 'no-methods',
                    },
                };

            const seasonToEpisodes = new Map<string, string[]>();
            for (const row of episodeRows) {
                const list = seasonToEpisodes.get(row.parent_id) ?? [];
                list.push(row.id);
                seasonToEpisodes.set(row.parent_id, list);
            }

            let perItemFound = 0;
            let completionFailed = false;
            const completedItemIds = new Set<string>();
            const doPerItem =
                config.chapterDetection !== false || config.blackframeDetection !== false;
            const perItemOK = new Set<string>();
            const visualProofs = new Map<string, AnalyzerInputSnapshot>();
            const acousticProofs = new Map<string, AnalyzerInputSnapshot>();
            const targetedConcurrency = Math.max(1, config.episodeConcurrency ?? 1);

            if (doPerItem) {
                let processed = 0;
                const idQueue = [...episodeIds];
                async function targetedPerItemWorker() {
                    while (true) {
                        if (signal.aborted) return;
                        const episodeId = idQueue.shift();
                        if (!episodeId) return;
                        let ok = false;
                        try {
                            const outcome = await analyzeItem(
                                sql,
                                episodeId,
                                config,
                                logger,
                                signal,
                                scope,
                            );
                            perItemFound += outcome.segments;
                            visualProofs.set(episodeId, outcome.input);
                            ok = true;
                        } catch (err) {
                            await recordFailureByCause(sql, logger, episodeId, err, {
                                reason: err instanceof Error ? err.message : String(err),
                                signal,
                            });
                            logger.warn(`Targeted: per-item failed for ${episodeId}`, {
                                error: err instanceof Error ? err.message : String(err),
                            });
                        }
                        if (ok) perItemOK.add(episodeId);
                        processed++;
                        reportProgress(processed, episodeIds.length, episodeId);
                    }
                }
                await Promise.all(
                    Array.from(
                        {
                            length: Math.min(targetedConcurrency, episodeIds.length || 1),
                        },
                        targetedPerItemWorker,
                    ),
                );
            } else {
                for (const id of episodeIds) perItemOK.add(id);
            }

            let chromaFound = 0;
            const chromaOK = new Set<string>();
            // Seasons whose fingerprint pass was deferred. Neither stage is marked
            // for them, or the marks would overwrite the deferral.
            const chromaDeferred = new Set<string>();
            const chromaUnavailable = new Set<string>();
            const chromaStale = new Set<string>();
            // Chromaprint owns shared Intro evidence as well as credits. It is
            // intentionally absent from an Outro-only maintenance pass.
            const doChroma = !scope.visualOnly && config.chromaprintDetection !== false;

            if (doChroma && !signal.aborted) {
                let processed = 0;
                for (const seasonId of targetSeasonIds) {
                    if (signal.aborted) break;
                    try {
                        const outcome = await analyzeSingleSeasonChromaprint(
                            sql,
                            logger,
                            signal,
                            seasonId,
                            tmpDir,
                            config,
                            targetedConcurrency,
                            config.ffmpegThreads ?? serverConfig.ANALYSIS_FFMPEG_THREADS,
                            scope,
                        );
                        chromaFound += outcome.segments;
                        for (const [id, input] of outcome.inputs ?? [])
                            acousticProofs.set(id, input);
                        if (outcome.unavailable) chromaUnavailable.add(seasonId);
                        else if (outcome.deferred) chromaDeferred.add(seasonId);
                        else chromaOK.add(seasonId);
                    } catch (err) {
                        const reason = err instanceof Error ? err.message : String(err);
                        if (isStaleAnalysisFailure(err)) chromaStale.add(seasonId);
                        logger.warn(`Targeted: chromaprint failed for season ${seasonId}`, {
                            error: reason,
                        });
                        // Same poison-quarantine routing as the scheduled drain
                        // (see analyzeSliceOfSeasons) — otherwise a manual
                        // targeted rerun of a deterministically-failing season
                        // never converges either.
                        const seasonEpisodeIds = seasonToEpisodes.get(seasonId) ?? [];
                        await Promise.all(
                            seasonEpisodeIds.map((episodeId) =>
                                recordFailureByCause(sql, logger, episodeId, err, {
                                    reason: `season-chromaprint: ${reason}`,
                                    signal,
                                    stageId: ANALYZER_ACOUSTIC_STAGE_ID,
                                    processingVersion: ACOUSTIC_PROCESSING_VERSION,
                                }),
                            ),
                        );
                    }
                    processed++;
                    reportProgress(processed, targetSeasonIds.length, seasonId);
                }
            } else {
                for (const seasonId of targetSeasonIds) chromaOK.add(seasonId);
            }

            // Visual completion is independent of the fingerprint pass, exactly
            // as in the scheduled drain: gating it on chromaOK discarded the
            // season's successful chapter/blackframe work whenever chromaprint
            // failed, and re-ran it on the next drain.
            const toMark: string[] = [];
            if (doPerItem) {
                for (const [seasonId, epIds] of seasonToEpisodes) {
                    // A deferred season keeps its skipped_transient rows; marking its
                    // visual stage now would overwrite the deferral.
                    if (chromaDeferred.has(seasonId) || chromaStale.has(seasonId)) continue;
                    for (const epId of epIds) {
                        if (perItemOK.has(epId)) toMark.push(epId);
                    }
                }
            }
            if (toMark.length > 0 && !signal.aborted) {
                try {
                    const marked = await markAnalyzed(
                        sql,
                        toMark,
                        ANALYZER_VISUAL_STAGE_ID,
                        VISUAL_PROCESSING_VERSION,
                        visualProofs,
                        scope,
                    );
                    for (const id of marked) completedItemIds.add(id);
                    if (marked.length !== toMark.length) completionFailed = true;
                } catch (err) {
                    completionFailed = true;
                    logger.warn('Targeted markAnalyzed(visual) failed', {
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }
            // Without this the expensive pass just performed is invisible to the
            // scheduled drain, which re-runs it for the same season on its next
            // cycle. Only seasons whose pass actually succeeded are marked —
            // `doChroma` false means it never ran.
            if (doChroma && !signal.aborted && !scope.visualOnly) {
                const acousticToMark: string[] = [];
                for (const [seasonId, epIds] of seasonToEpisodes) {
                    if (!chromaOK.has(seasonId)) continue;
                    acousticToMark.push(...epIds);
                }
                if (acousticToMark.length > 0) {
                    try {
                        const marked = await markAnalyzed(
                            sql,
                            acousticToMark,
                            ANALYZER_ACOUSTIC_STAGE_ID,
                            ACOUSTIC_PROCESSING_VERSION,
                            acousticProofs,
                            scope,
                        );
                        for (const id of marked) completedItemIds.add(id);
                        if (marked.length !== acousticToMark.length) completionFailed = true;
                    } catch (err) {
                        completionFailed = true;
                        logger.warn('Targeted markAnalyzed(acoustic) failed', {
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }
                }
            }

            // An aborted run may have partial work committed, but the admin
            // asked for it to stop — surface that as a non-success so the
            // task log doesn't show a green checkmark for a cancelled job.
            if (!doPerItem && doChroma && chromaUnavailable.size === targetSeasonIds.length)
                return {
                    success: false,
                    itemsProcessed: 0,
                    result: {
                        seasonsProcessed: 0,
                        segmentsProduced: 0,
                        analysisOutcome: 'skipped',
                        skipReason: 'no-eligible-targets',
                    },
                };
            const complete =
                !completionFailed &&
                (!doPerItem || perItemOK.size === episodeIds.length) &&
                (!doChroma || chromaOK.size === targetSeasonIds.length);
            return {
                success: complete && !signal.aborted,
                itemsProcessed: completedItemIds.size,
                result: {
                    seasonsProcessed: targetSeasonIds.length,
                    segmentsProduced: perItemFound + chromaFound,
                    itemsAttempted: attemptedItemIds.size,
                    itemsCompleted: completedItemIds.size,
                    ...(perItemFound + chromaFound === 0
                        ? { itemsAbstained: completedItemIds.size }
                        : {}),
                    analysisOutcome:
                        chromaDeferred.size > 0
                            ? 'deferred'
                            : complete
                              ? perItemFound + chromaFound === 0
                                  ? 'no-detection'
                                  : 'completed'
                              : 'partial',
                },
            };
        }

        // Scheduled / manual drain
        const anyDetection =
            config.chapterDetection !== false ||
            config.blackframeDetection !== false ||
            config.chromaprintDetection !== false;
        if (!anyDetection) {
            return {
                success: !signal.aborted,
                itemsProcessed: 0,
                result: {
                    seasonsProcessed: 0,
                    segmentsProduced: 0,
                    analysisOutcome: 'skipped',
                    skipReason: 'no-eligible-targets',
                },
            };
        }

        const batchSize = config.batchSize;
        const rawMode = typeof rawInput.mode === 'string' ? rawInput.mode : 'catchup';
        const mode: 'catchup' | 'manual' | 'force' =
            rawMode === 'manual' || rawMode === 'force' ? rawMode : 'catchup';
        if (mode !== rawMode) {
            logger.warn(`Unknown mode "${rawMode}" — defaulting to catchup`);
        }

        // Force mode: wipe before draining (once per logical force run via sentinel)
        const FORCE_WIPE_SENTINEL = 'force-wipe-in-progress';
        const FORCE_WIPE_TTL_MS = 12 * 60 * 60 * 1000;
        // L2 key mirrors the unified-cache buildL2Key format: `${namespace}:${key}`
        const FORCE_WIPE_L2_KEY = `plugin:${PLUGIN_ID}:${FORCE_WIPE_SENTINEL}`;
        if (mode === 'force' && !signal.aborted) {
            const cache = getNamespacedCache();
            const alreadyWiped = await cache.get(FORCE_WIPE_SENTINEL);
            if (!alreadyWiped) {
                // Write sentinel to Valkey BEFORE wiping so a second replica that
                // reads the sentinel concurrently sees it already set and skips the wipe.
                // Worst-case on Valkey failure: sentinel is missing and two replicas both
                // wipe, which is safe (idempotent) — far better than "wipe happened, no marker".
                await cacheSet(FORCE_WIPE_L2_KEY, 'true', Math.floor(FORCE_WIPE_TTL_MS / 1000));
                await wipeAll(sql, logger);
                // Also populate L1 so same-replica checks see the sentinel immediately.
                try {
                    await cache.set(FORCE_WIPE_SENTINEL, true, FORCE_WIPE_TTL_MS);
                } catch {
                    // L1 write failure is non-fatal; L2 is the authoritative guard.
                }
            } else {
                logger.info('Force mode: wipe sentinel present — resuming drain without re-wipe');
            }
        }

        const softBudgetMs = mode === 'catchup' ? CATCHUP_BUDGET_MS : MANUAL_BUDGET_MS;
        const budgetReached = (): boolean =>
            ctx.softSignal?.aborted === true || Date.now() - drainStartedAt >= softBudgetMs;
        await pruneCompletedSeasonFingerprints(sql);
        const completedItemIds = new Set<string>();
        let fingerprintsProcessed = 0;
        // Progress always counts distinct media items with committed coverage.
        // Extraction/matching heartbeat calls must never reset that scale.
        let lastCompletedProgress = 0;
        const progress = (_processed: number, _total?: number, currentItem?: string): void => {
            if (completedItemIds.size <= lastCompletedProgress) return;
            lastCompletedProgress = completedItemIds.size;
            reportProgress(completedItemIds.size, undefined, currentItem);
        };
        const drainScope: SegmentScope = {
            ...scope,
            shouldYield: budgetReached,
            onCompleted: (mediaId) => {
                completedItemIds.add(mediaId);
                progress(0, undefined, mediaId);
            },
            onFingerprint: (mediaId) => {
                fingerprintsProcessed++;
                reportProgress(completedItemIds.size, undefined, mediaId);
            },
        };
        let totalSeasons = 0;
        let totalFound = 0;
        // `incomplete` is for REAL errors only (detector crash, checkpoint DB
        // failure, no-progress stall). Budget yields, deferred seasons and items
        // that retry next round (timeout back-off, changed input) are not errors.
        let incomplete = false;
        let deferred = false;
        const deferredItemIds = new Set<string>();
        let _totalEpisodes = 0;
        type StopReason = 'drained' | 'aborted' | 'budget' | 'single-slice' | 'no-progress';
        let stopReason: StopReason = 'drained';
        const doPerItemFallback =
            config.chapterDetection !== false || config.blackframeDetection !== false;

        // Persist rotation across worker restarts. Even if one item consumes a
        // whole chunk, each work class gets first access once every three runs.
        const [rotation] = await sql<{ lane: number }[]>`
            INSERT INTO plugin_settings(plugin_id,key,value)
            VALUES (${PLUGIN_ID},'__drain_next_lane','1'::jsonb)
            ON CONFLICT(plugin_id,key) DO UPDATE
            SET value=to_jsonb(((plugin_settings.value #>> '{}')::int+1)%3)
            RETURNING (((value #>> '{}')::int+2)%3) AS lane
        `;
        const lanes = ['seasons', 'singleEpisodes', 'movies'] as const;
        const firstLane = rotation?.lane ?? 0;
        for (let offset = 0; offset < lanes.length; offset++) {
            const lane = lanes[(firstLane + offset) % lanes.length]!;
            if (lane !== 'seasons' && !doPerItemFallback) continue;
            let lastSliceSig: string | null = null;
            while (true) {
                if (signal.aborted || budgetReached()) {
                    stopReason = signal.aborted ? 'aborted' : 'budget';
                    break;
                }
                const seasons =
                    lane === 'seasons'
                        ? await getUnanalyzedSeasons(
                              sql,
                              ANALYZER_VISUAL_STAGE_ID,
                              VISUAL_PROCESSING_VERSION,
                              ANALYZER_ACOUSTIC_STAGE_ID,
                              ACOUSTIC_PROCESSING_VERSION,
                              config.chromaprintDetection !== false,
                              batchSize,
                              doPerItemFallback,
                              inspectedInputs,
                          )
                        : [];
                const perItems =
                    lane === 'singleEpisodes'
                        ? (
                              await getUnanalyzedSingleEpisodeSeasonEpisodes(
                                  sql,
                                  ANALYZER_VISUAL_STAGE_ID,
                                  VISUAL_PROCESSING_VERSION,
                                  batchSize,
                                  inspectedInputs,
                              )
                          ).map((item) => item.episodeId)
                        : lane === 'movies'
                          ? (
                                await getUnanalyzedMovies(
                                    sql,
                                    ANALYZER_VISUAL_STAGE_ID,
                                    VISUAL_PROCESSING_VERSION,
                                    batchSize,
                                    inspectedInputs,
                                )
                            ).map((item) => item.mediaId)
                          : [];
                const ids = lane === 'seasons' ? seasons.map((item) => item.seasonId) : perItems;
                if (ids.length === 0) break;
                const signature = JSON.stringify([ids, inspectedInputRevision]);
                if (signature === lastSliceSig) {
                    logger.warn(`Intro drain stalled in ${lane} — same slice returned twice`);
                    incomplete = true;
                    stopReason = 'no-progress';
                    break;
                }
                lastSliceSig = signature;
                logger.info(`Processing ${ids.length} ${lane} (mode=${mode})`);
                const slice =
                    lane === 'seasons'
                        ? await analyzeSliceOfSeasons(
                              sql,
                              logger,
                              signal,
                              seasons,
                              config,
                              tmpDir,
                              progress,
                              drainScope,
                          )
                        : await analyzeSingleEpisodeFallback(
                              sql,
                              logger,
                              signal,
                              perItems,
                              config,
                              progress,
                              drainScope,
                          );
                if ('seasonsProcessed' in slice && typeof slice.seasonsProcessed === 'number')
                    totalSeasons += slice.seasonsProcessed;
                totalFound += slice.segmentsProduced;
                _totalEpisodes += slice.episodesProcessed;
                for (const id of slice.completedIds) completedItemIds.add(id);
                incomplete ||= slice.incomplete;
                deferred ||= slice.deferred;
                for (const id of slice.deferredIds) deferredItemIds.add(id);
                if (signal.aborted || budgetReached()) {
                    stopReason = signal.aborted ? 'aborted' : 'budget';
                    break;
                }
                if (mode === 'catchup') {
                    if (stopReason === 'drained') stopReason = 'single-slice';
                    break;
                }
            }
            if (stopReason === 'budget' || stopReason === 'aborted') break;
        }

        if (!doPerItemFallback && !signal.aborted) {
            // Both chapter AND blackframe detection are disabled, so the
            // single-episode fallback cannot run. Single-(file-bearing)-episode
            // seasons have no analyzable path (chromaprint needs >=2 cohort), so
            // their pending coverage rows would never reach a terminal status.
            // Tombstone them as skipped_permanent so they don't wedge. (The
            // `season-has-no-analyzable-episodes` disposition deliberately leaves
            // 1-file-bearing seasons for the fallback — which is off here.)
            try {
                const drained = await sql<Array<{ count: number }>>`
                    WITH targets AS (
                        SELECT ep.id
                          FROM media_items season
                          JOIN media_items ep
                            ON ep.parent_id = season.id AND ep.media_type = 'episode' AND ep.status <> 'deleted'
                         WHERE season.media_type = 'season' AND ${analyzerLiveAncestrySql(sql, 'season')}
                           AND (season.season_number IS NULL OR season.season_number != 0)
                           AND EXISTS (
                               SELECT 1 FROM media_file_items mfi
                                 JOIN media_files mf ON mf.id = mfi.file_id
                                WHERE mfi.media_item_id = ep.id AND ${analyzableVideoFileSql(sql)}
                           )
                           AND (
                               SELECT COUNT(*)
                                 FROM media_items sib
                                 JOIN media_file_items mfi ON mfi.media_item_id = sib.id
                                 JOIN media_files mf ON mf.id = mfi.file_id
                                WHERE sib.parent_id = season.id
                                  AND sib.media_type = 'episode'
                                  AND ${analyzableVideoFileSql(sql)}
                           ) = 1
                           -- Cold-start safety (mirrors the declarative
                           -- requiresQuietUpstream gate on the predicate path):
                           -- don't tombstone a season whose files are still
                           -- arriving — a 2nd episode minutes away would make it
                           -- chromaprint-eligible. Only fire once the season's
                           -- newest file has been quiet for the stability window.
                           AND COALESCE((
                               SELECT MAX(GREATEST(mf2.created_at,
                                                   COALESCE(mf2.file_mtime, mf2.created_at),
                                                   mf2.updated_at))
                                 FROM media_items sib2
                                 JOIN media_file_items mfi2 ON mfi2.media_item_id = sib2.id
                                 JOIN media_files mf2 ON mf2.id = mfi2.file_id
                                WHERE sib2.parent_id = season.id
                                  AND sib2.media_type = 'episode'
                           ), 'epoch'::timestamptz) < now() - make_interval(secs => ${
                               SEASON_SCAN_STABILITY_MS / 1000
                           })
                    ), drained AS (
                        UPDATE media_item_stage_state s
                           SET status = 'skipped_permanent',
                               skipped_reason = 'single-episode-detection-disabled',
                               next_eligible_at = NULL,
                               declines = 0,
                               declines_since = NULL,
                               updated_at = now()
                          FROM targets t
                         WHERE s.media_item_id = t.id
                           AND s.stage_id = ANY(${[ANALYZER_VISUAL_STAGE_ID, ANALYZER_ACOUSTIC_STAGE_ID]}::text[])
                           AND s.status IN ('pending', 'failed_transient', 'skipped_transient')
                        RETURNING 1
                    )
                    SELECT COUNT(*)::int AS count FROM drained
                `;
                const n = drained[0]?.count ?? 0;
                if (n > 0) {
                    logger.info(
                        `Single-ep detection disabled — tombstoned ${n} single-episode-season episode(s) as skipped_permanent`,
                    );
                }
            } catch (err) {
                logger.warn('Single-ep disabled-tombstone failed (non-fatal)', {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        // A cancel/shutdown can arrive inside the final slice, its backlog
        // query, or a catchup exit. It always outranks a normal drain reason.
        const backlogLimit = 2147483647;
        // Same eligibility predicates as each drain, without this run's inspected
        // set: remaining visual/acoustic stages, live ancestry, stability and
        // retry cooldowns. Seasons count cohorts; fallbacks count media items.
        const [pendingSeasons, pendingSingles, pendingMovies] = await Promise.all([
            getUnanalyzedSeasons(
                sql,
                ANALYZER_VISUAL_STAGE_ID,
                VISUAL_PROCESSING_VERSION,
                ANALYZER_ACOUSTIC_STAGE_ID,
                ACOUSTIC_PROCESSING_VERSION,
                config.chromaprintDetection !== false,
                backlogLimit,
                doPerItemFallback,
            ),
            doPerItemFallback
                ? getUnanalyzedSingleEpisodeSeasonEpisodes(
                      sql,
                      ANALYZER_VISUAL_STAGE_ID,
                      VISUAL_PROCESSING_VERSION,
                      backlogLimit,
                  )
                : [],
            doPerItemFallback
                ? getUnanalyzedMovies(
                      sql,
                      ANALYZER_VISUAL_STAGE_ID,
                      VISUAL_PROCESSING_VERSION,
                      backlogLimit,
                  )
                : [],
        ]);
        const pendingBacklog = {
            seasons: pendingSeasons.length,
            singleEpisodes: pendingSingles.length,
            movies: pendingMovies.length,
        };
        if (signal.aborted) stopReason = 'aborted';
        else if (!pendingSeasons.length && !pendingSingles.length && !pendingMovies.length)
            stopReason = 'drained';

        logger.info('Intro analysis chunk finished', {
            stopReason,
            seasonsProcessed: totalSeasons,
            itemsCompleted: completedItemIds.size,
            fingerprintsProcessed,
            pendingBacklog,
            elapsedMs: Date.now() - drainStartedAt,
        });

        if (totalSeasons === 0 && _totalEpisodes === 0) {
            if (stopReason !== 'budget' && stopReason !== 'aborted') {
                const cache = getNamespacedCache();
                await cache.delete(FORCE_WIPE_SENTINEL).catch(() => {});
            }
            const deferredItems = [...deferredItemIds].filter(
                (id) => !completedItemIds.has(id),
            ).length;
            const anyDeferred = deferred || deferredItems > 0;
            const partial =
                incomplete ||
                stopReason === 'budget' ||
                stopReason === 'no-progress' ||
                attemptedItemIds.size > 0;
            return {
                // Nothing was processed, so only a real error (or an abort) is a
                // failure. A run with no eligible targets stays non-success.
                success:
                    !signal.aborted &&
                    stopReason !== 'aborted' &&
                    !incomplete &&
                    (partial || anyDeferred),
                itemsProcessed: 0,
                stopReason: stopReason === 'budget' ? 'budget' : undefined,
                result: {
                    seasonsProcessed: 0,
                    segmentsProduced: 0,
                    fingerprintsProcessed,
                    pendingBacklog,
                    itemsAttempted: attemptedItemIds.size,
                    itemsCompleted: 0,
                    ...(deferredItems > 0 ? { deferredItems } : {}),
                    analysisOutcome: incomplete
                        ? 'partial'
                        : anyDeferred
                          ? 'deferred'
                          : partial
                            ? 'partial'
                            : 'skipped',
                    ...(!partial && !anyDeferred
                        ? { skipReason: 'no-eligible-targets' as const }
                        : {}),
                },
            };
        }

        if (stopReason === 'drained' || stopReason === 'no-progress') {
            const cache = getNamespacedCache();
            await cache.delete(FORCE_WIPE_SENTINEL).catch(() => {});
        }

        const deferredItemCount = [...deferredItemIds].filter(
            (id) => !completedItemIds.has(id),
        ).length;

        // An aborted run may have partial work committed, but the admin asked
        // for it to stop — surface that as a non-success so the task log
        // doesn't show a green checkmark for a cancelled job (mirrors
        // media-probe.ts's `success: !aborted` convention).
        return {
            success: !signal.aborted && stopReason !== 'aborted' && !incomplete,
            itemsProcessed: completedItemIds.size,
            stopReason: stopReason === 'budget' ? 'budget' : undefined,
            result: {
                seasonsProcessed: totalSeasons,
                segmentsProduced: totalFound,
                fingerprintsProcessed,
                pendingBacklog,
                itemsAttempted: attemptedItemIds.size,
                itemsCompleted: completedItemIds.size,
                ...(totalFound === 0 ? { itemsAbstained: completedItemIds.size } : {}),
                ...(deferredItemCount > 0 ? { deferredItems: deferredItemCount } : {}),
                analysisOutcome: incomplete
                    ? 'partial'
                    : deferred || deferredItemCount > 0
                      ? 'deferred'
                      : completedItemIds.size === 0
                        ? 'partial'
                        : totalFound === 0
                          ? 'no-detection'
                          : 'completed',
            },
        };
    },

    async processItems(ctx: TaskContext, items: unknown[]): Promise<void> {
        if (!Array.isArray(items) || items.length === 0) return;

        const rawItems = items as Array<Record<string, unknown>>;
        const targets = rawItems.filter(
            (i) =>
                typeof i?.id === 'string' &&
                i.id.length > 0 &&
                isUuid(i.id) &&
                typeof i?.mediaType === 'string' &&
                (isEpisode(i.mediaType as string) || isMovie(i.mediaType as string)),
        );
        if (targets.length === 0) return;

        const config = await readTaskSettings(ctx.sql, ctx.logger);

        ctx.logger.info(`Incremental analysis: ${targets.length} items`);

        let processed = 0;
        let produced = 0;

        for (const item of targets) {
            if (ctx.signal.aborted) break;
            let ok = false;
            const proofs = new Map<string, AnalyzerInputSnapshot>();
            try {
                const outcome = await analyzeItem(
                    ctx.sql,
                    item.id as string,
                    config,
                    ctx.logger,
                    ctx.signal,
                    { ...FULL_SCOPE, runId: ctx.runId },
                );
                produced += outcome.segments;
                proofs.set(item.id as string, outcome.input);
                ok = true;
            } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                ctx.logger.warn(`Incremental analysis failed for ${item.id}`, { error: reason });
                await recordFailureByCause(ctx.sql, ctx.logger, item.id as string, err, {
                    reason,
                    signal: ctx.signal,
                });
            }
            if (ok) {
                await markAnalyzed(
                    ctx.sql,
                    [item.id as string],
                    ANALYZER_VISUAL_STAGE_ID,
                    VISUAL_PROCESSING_VERSION,
                    proofs,
                    { ...FULL_SCOPE, runId: ctx.runId },
                );
            }
            processed++;
            ctx.reportProgress(processed, targets.length, item.id as string);
        }

        ctx.logger.info(
            `Incremental analysis complete: ${produced} segments from ${processed} items`,
        );
    },
});

registry.registerTask(lumastraIntroAnalyzerTask);
