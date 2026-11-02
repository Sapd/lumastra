// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music Audio Analysis — native defineTask implementation.
 *
 * Background task that enriches music tracks with Essentia audio features:
 * BPM, beat grid, downbeats, key + scale, energy, danceability, loudness,
 * intro/outro boundaries, and mood tags.
 *
 * Only processes tracks where custom_metadata is missing the 'bpm' field
 * (i.e., not yet analyzed). Uses a concurrency limit of 2 since Essentia
 * is CPU-intensive.
 *
 * Skips gracefully if the Essentia binary is not installed.
 *
 * Configuration:
 * - SYNC_MUSIC_ANALYSIS_INTERVAL: Duration-string override for the 1h cadence
 *   (e.g. '30m', '2h').
 * - DISABLE_MUSIC_ANALYSIS: Set to 'true' to disable (both scheduled and
 *   manual triggers). Checked at execute() entry.
 * - MUSIC_ANALYSIS_MAX_DURATION_MINUTES: tracks longer than this are skipped
 *   ('track-too-long'), not analysed. Default 30, 0 = no cap.
 */

import type postgres from 'postgres';
import { z } from 'zod';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import { config } from '$lib/server/config.js';
import type {
    TaskContext,
    BacklogStage,
    FailedItem as SdkFailedItem,
} from '@sapd/lumastra-plugin-sdk';
import type { PluginContext } from '../../../plugins/types/base-plugin.js';
import {
    drainBacklog,
    drainWipe,
    resolveDrainMode,
    formatStopReason,
    computeRemainingHint,
    isAbortedStop,
    lazyBacklog,
} from '../../../plugins/runtime/drain-backlog.js';
import {
    isEssentiaAvailable,
    isAnalysisEngineUsable,
    verifyAnalysisEngineReady,
    analyzeTrack,
    storeAnalysis,
    withEssentiaConcurrency,
    getEssentiaConcurrencyLimit,
} from '../../../services/essentia-analysis.service.js';
import { SidecarUnreachableError } from '../../../services/music-analysis-sidecar.service.js';
import { hIncrBy, expire } from '../../../cache/valkey.js';
import { withTx } from '../../../database/with-tx.js';
import {
    atomicallyWipeMusicAnalysis,
    countUnanalyzedTracks,
    findCoverageTableBacklog,
    getMusicAnalysisBacklog,
    getMusicAnalysisWipeBatch,
    getUnanalyzedTracks,
    markTrackAnalyzed,
    markTrackExcluded,
    isTrackOverDurationLimit,
    overDurationLimitSql,
    reconcileDurationLimit,
    TRACK_TOO_LONG_REASON,
    type UnanalyzedTrackRow,
} from '../../../database/queries/music-analysis.queries.js';
import {
    upsertCompletedRow,
    upsertSkippedPermanentRow,
    deferTransientRetryBatch,
} from '../../../database/queries/stage-state.queries.js';
import { getAuthoritativeStageIds } from '$lib/server/config.js';
import { assessFilePresence } from '../../../utils/file-presence.js';
import {
    recordFailure,
    markFailureEventsResolved,
    getFailureAggregates,
    type FailureAggregateRow,
} from '../../../database/queries/plugin-failure-events.queries.js';
import { registry } from '../../registry.js';
import { classifyInfraError } from '../../infra-retry.js';

// Inlined from the retired `plugins/types/sync-plugin-ui.ts` — the legacy
// sync-plugin UI module is gone but music-analysis still needs this shape
// to type the item bundle passed to its processItems-style handler.
interface NewMediaItem {
    id: string;
    mediaType: string;
    filePath?: string;
    jellyfinId?: string;
}

// ============================================================================
// Constants
// ============================================================================

// Bumped to 2: fix key detection (tonal.key_key instead of tonal.key_edma.key)
// Bumped to 3: DJ intro detection (dj_intro_end_ms) for extended mixes
// Bumped to 4: voice/instrumental heuristic + lowlevel spectral features
// Bumped to 5: per-frame fade detection (outputFrames) + real energy curve
// Bumped to 6: Python-sidecar analysis engine (MUSIC_ANALYSIS_ENGINE) — real EBU R128
// loudness, librosa-derived raw features. INTENTIONAL: this bump re-admits the whole
// library so prod re-analyzes every track through the newly-selected engine (picking up
// real R128 loudness + heuristic mood). Operators flipping to engine=sidecar should set
// the flag in the SAME deploy window so the forced re-run produces sidecar (not binary)
// output. The library is NFS-backed, so the re-run is paced by the 6h scheduler drain.
// Bumped to 7: vocal-phrase boundaries (first_vocal_start_ms / last_vocal_end_ms) from
// the sidecar's vocal-band harmonic ratio. NOTE: only the sidecar engine emits the raw
// signal — on the binary engine this re-run produces identical output with null vocal
// boundaries, so operators should flip MUSIC_ANALYSIS_ENGINE=sidecar in the same deploy
// window to make the forced re-analysis worthwhile.
const PROCESSING_VERSION = 7;

const PLUGIN_ID = 'music-analysis';

// Backoff applied to a coverage row whose file is TRANSIENTLY absent (mount
// outage) so it is not re-selected on every drain tick. The row stays retriable
// in its current state; a real file event (afterContentChanged) re-eligibilizes
// it sooner. Without this, a transient row — including a version-behind
// `completed` row re-selected by the version-aware backlog — hot-loops the drain.
const TRANSIENT_RETRY_MS = 15 * 60 * 1000;

// Tracks processed per drain slice — balances scheduler throughput
// (catchup does one slice/run) against progress-reporting cadence.
const SLICE_SIZE = 100;

// All Essentia-written fields live under this single custom_metadata subkey,
// so a wipe drops one key instead of sixteen. See migration 12.37.0 and
// storeAnalysis() in essentia-analysis.service.ts.
const ESSENTIA_NAMESPACE_KEY = 'essentia';

// Batch size for the chunked wipe loop — keeps lock windows short on large
// libraries and bounds the UPDATE's WAL/memory footprint per iteration.
const WIPE_BATCH_SIZE = 500;

// ============================================================================
// Poison-track guard (sidecar crash strikes)
// ============================================================================

// A SidecarUnreachableError is normally infrastructure ("the sidecar is down")
// and must NOT blame the track — but a track whose decode SEGFAULTS the sidecar
// produces that same error on every attempt, forever: stage-sweep re-enqueues
// it, the sidecar dies again, and analysis never progresses (observed on prod
// 2026-07-09: one track kept the sidecar in a 127-restart crash loop).
// Disambiguate by failure shape: a connection that dropped MID-REQUEST
// (reset / "other side closed") means the sidecar was alive when it took the
// track and died holding it — that implicates the track. A refused or
// timed-out CONNECT (sidecar down, or still loading its model after a restart)
// says nothing about the track and never counts. After
// SIDECAR_CRASH_STRIKE_LIMIT mid-request deaths the track is marked failed
// like any durable analyze error (visible in the task's Failures tab,
// re-admitted by a PROCESSING_VERSION bump or manual retry).
const SIDECAR_CRASH_STRIKE_LIMIT = 3;

// Strike-counter TTL — long enough to outlive slow retry cadences, short
// enough that a fixed environment (sidecar upgrade, repaired file) forgets
// old strikes on its own.
const SIDECAR_CRASH_STRIKE_TTL_S = 7 * 24 * 60 * 60;

const sidecarCrashStrikeKey = (trackId: string): string =>
    `v1:music-analysis:sidecar-crash-strikes:${trackId}`;

// Failure shapes of a connection that died mid-request (undici SocketError /
// node socket error codes). ECONNREFUSED/ETIMEDOUT are deliberately absent —
// those mean the sidecar was already unreachable before the track was sent.
const MID_REQUEST_DEATH_RE =
    /ECONNRESET|EPIPE|UND_ERR_SOCKET|other side closed|socket hang up|terminated/i;

function isMidRequestSidecarDeath(err: unknown): boolean {
    let cur: unknown = err;
    for (let depth = 0; cur instanceof Error && depth < 6; depth++) {
        const code = (cur as Error & { code?: string }).code ?? '';
        if (MID_REQUEST_DEATH_RE.test(cur.message) || MID_REQUEST_DEATH_RE.test(code)) {
            return true;
        }
        cur = cur.cause;
    }
    return false;
}

/**
 * Count one sidecar-crash strike against a track. Returns the strike count
 * when the track has exhausted its strikes and must be marked failed, or null
 * when it must stay eligible for retry (not a mid-request death, still under
 * the limit, or the counter store is unavailable — never poison on
 * uncertainty).
 */
async function countSidecarCrashStrike(
    trackId: string,
    err: SidecarUnreachableError,
): Promise<number | null> {
    if (!isMidRequestSidecarDeath(err)) return null;
    try {
        const key = sidecarCrashStrikeKey(trackId);
        const strikes = await hIncrBy(key, 'strikes', 1);
        await expire(key, SIDECAR_CRASH_STRIKE_TTL_S);
        return strikes >= SIDECAR_CRASH_STRIKE_LIMIT ? strikes : null;
    } catch {
        return null;
    }
}

// ============================================================================
// Schemas / types
// ============================================================================

const inputSchema = z.object({}).passthrough();

type MusicAnalysisInput = z.infer<typeof inputSchema>;

interface MusicAnalysisResult {
    analyzed: number;
    skipped: number;
    errors: number;
}

interface SliceOutcome {
    analyzed: number;
    skipped: number;
    errors: number;
    /**
     * Count of marker writes that landed this slice. `analyzed` always
     * counts as advanced because the transactional upsert is what moves
     * the track out of the fetch predicate. `skipped` and `errors` credit
     * advance ONLY when their marker write returned true — a DB blip
     * during the marker phase must leave the row eligible so
     * drainBacklog's no-progress detector can fire.
     */
    advancedMarkers: number;
    /**
     * Tracks the slice started processing but abandoned before any mark
     * write (abort fired after the track took its concurrency slot).
     * These stay eligible on the next drain — surfaced for admin
     * visibility so they don't look like a silent drop.
     */
    abortedUnmarked: number;
}

// ============================================================================
// Task definition
// ============================================================================

export const musicAnalysisTask = defineTask<MusicAnalysisInput, MusicAnalysisResult>({
    id: 'music-analysis',
    purpose: 'music-ai',
    confirmBeforeRun: true,
    name: 'Music Audio Analysis',
    version: '1.0.0',
    processingVersion: PROCESSING_VERSION,
    minAppVersion: '0.0.0',

    capabilities: { database: true },

    schedule: {
        every: '6h',
        runOnStartup: false,
        envOverride: 'SYNC_MUSIC_ANALYSIS_INTERVAL',
    },

    // MODE-INDEPENDENT, and paired with exclusiveWith below — see
    // music-popularity.ts for the long form. The orchestrator's SETNX mutex key
    // is `identityKey(taskId, identityFor(input))`, so exclusiveWith inherits
    // whatever this returns: a mode-suffixed identity would hand catchup,
    // manual and force each their own key and collapse only same-mode re-fires.
    // catchup, manual and force are the same work at different depths here, so
    // single-flight across all three is the correct semantics.
    identityFor: () => 'global',
    scope: 'global',
    // Singleton guard. `force` drops the stored music analysis, and without this it could run
    // CONCURRENTLY with an in-flight catchup or manual pass — deleting rows
    // that pass is mid-write. The derived data is recomputable, so the damage
    // is wasted work and a transient hole rather than permanent loss, but the
    // wipe racing its own writer is not a state worth allowing. ttl >= the
    // task's hard timeout, per the SDK rule.
    exclusiveWith: { scope: 'global', ttl: '130m' },
    // Run on the dedicated `analysis` worker pool so we don't compete head-of-
    // line with trickplay-generation's ~2500-item backlog on the cpu queue.
    // Prior attempt: cpu + taskPriority=7 to deprioritize — but BullMQ's
    // priority is strict, not weighted; with trickplay at default priority 5
    // music-analysis never got popped (last completed 14h ago even with a
    // fresh file-library-scan upstream). The fairness fix is class isolation,
    // not priority. Same pattern that fixed lumastra-intro-analyzer earlier.
    //
    // Note: `analysis` class currently has concurrency 1. Music-analysis and
    // intro-analyzer alternate fairly on different cadences (per-6h vs
    // per-season), so collisions are rare. If they become an issue, bump
    // LUMASTRA_CONCURRENCY_ANALYSIS or revisit under the per-task-queue
    // redesign (Wave 8.5).
    resourceClass: 'analysis',
    // Honours `{ mode: 'manual' }` — drains the whole backlog in one
    // run instead of the single batch a scheduled catchup cycle does.
    supportsFullRun: true,
    // Clears the Essentia namespace from every track's custom_metadata and re-analyses.
    supportsForceRun: true,

    // Run execute() in a node:worker_threads Worker so a CPU stall (heavy
    // Essentia subprocess churn under host contention) cannot starve the main
    // worker's heartbeat + BullMQ lock renewal — the failure mode that wedged a
    // cancel in 'cancelling' for 2h in prod (BullMQ lost the job lock during a
    // ~6min event-loop stall; the orphaned processor then beat its heartbeat
    // forever, so no liveness guard could reclaim it). With isolation the main
    // thread's stall watchdog can terminate() the wedged thread. Same hard
    // defense lumastra-intro-analyzer (the sibling `analysis`-class chromaprint
    // task) already declares; music-analysis lacking it was the anomaly.
    // Compatibility: execute() uses only worker-rebuilt/RPC ctx surfaces
    // (sql/logger/signal/reportProgress/input/runId) and drainBacklog (reads
    // only logger + abortSignal); it never calls ctx.dep()/ctx.drain(), and the
    // Essentia child_process spawn works identically inside a worker thread.
    isolation: 'worker',

    inputSchema,

    coversStages: [
        {
            id: 'music-analysis',
            appliesTo: ['track'] as const,
            // Eligibility: a non-missing file WITH a probed audio stream. Tracks
            // seeded before media-probe writes streams are disposed to
            // `skipped_permanent/'ineligible'` by the sweep, then healed the instant
            // the audio stream lands — event-independently. The SQL deliberately
            // does NOT cover the post-probe permanent reasons ('file-not-found',
            // 'essentia-empty-result') — those were evaluated against a real file and
            // are legitimately terminal, so they are NOT in recoverWhenAdditionalReasons.
            //
            // 🔴 The two DURABLE engine gates below belong HERE, not only in
            // `execute()`. This is a GLOBAL-identity task (`identityFor: () => 'global'`),
            // so when the drain early-returns there is no `mediaItemId` for
            // `wrapExecute` to auto-complete, and the early return reports
            // `success: true` with zero processed — so nothing is written at all and
            // every seeded row stays `pending`, which `loadStageProgressByIds` counts
            // as REMAINING. `music-analysis` is in `HEADLINE_PROGRESS_STAGE_IDS`, so
            // that bar could never reach 100%. Identical in shape to the
            // `library-embeddings` provider hole; the difference is what triggers it:
            // Essentia ships a prebuilt extractor for linux-x86_64 ONLY, so every
            // arm64 install with a music library hit this out of the box (Dockerfile
            // skips the download on non-amd64 by design and the app is documented to
            // "degrade gracefully" — it degraded, but the coverage rows did not).
            //
            // Both flags are read INSIDE the builder, which `runStageDisposition`
            // calls every sweep tick, so re-enrolment needs no event and no new
            // mechanism — see `recoverWhenAdditionalReasons`. `DISABLE_MUSIC_ANALYSIS`
            // is a live getter over `process.env`, so toggling it is observed within
            // one tick in BOTH directions. `isEssentiaAvailable()` is live in sidecar
            // mode (reads `SONIC_ANALYZE_URL`) but memoises the binary probe, so
            // installing a binary under an existing process needs a restart to be
            // noticed — acceptable, since that is already true of every other caller.
            //
            // Deliberately NOT gated on `verifyAnalysisEngineReady()`: that probe is
            // TRANSIENT (a configured-but-down sidecar), and the existing drain
            // comment is explicit that tracks must stay eligible across it. Tombstoning
            // on a network blip would be a regression.
            eligibility: {
                sql: (sql) => sql`
                    ${!config.DISABLE_MUSIC_ANALYSIS ? sql`true` : sql`false`}
                    AND ${isAnalysisEngineUsable() ? sql`true` : sql`false`}
                    AND EXISTS (
                        SELECT 1 FROM media_file_items mfi
                          JOIN media_files mf ON mf.id = mfi.file_id
                         WHERE mfi.media_item_id = mi.id AND NOT mf.is_missing
                    )
                    AND EXISTS (
                        SELECT 1 FROM media_file_items mfi
                          JOIN media_files mf ON mf.id = mfi.file_id
                          JOIN media_streams ms ON ms.file_id = mf.id
                         WHERE mfi.media_item_id = mi.id
                           AND NOT mf.is_missing
                           AND ms.stream_type = 'audio'
                    )
                    AND NOT ${overDurationLimitSql(
                        sql as unknown as postgres.Sql<Record<string, never>>,
                        maxAnalysisDurationSeconds(),
                    )}
                `,
                // The two reasons the predicates below stamp are listed here so the
                // sweep's event-independent heal reclaims exactly those rows once the
                // operator turns analysis back on or the engine becomes available.
                // Without them, `skipped_permanent` is never re-swept and no pipeline
                // event fires for a config change — the library would be tombstoned
                // PERMANENTLY, which is strictly worse than the stall being fixed.
                recoverWhenAdditionalReasons: [
                    'no-file-linked',
                    'music-analysis-disabled',
                    'essentia-unavailable',
                    // Live cap: raising or removing it reclaims these rows.
                    TRACK_TOO_LONG_REASON,
                ],
            },
            // One-time bulk re-enrol when an operator enables analysis or moves to an
            // amd64 host / configures a sidecar. Flipping rows to `pending` is cheap;
            // the actual Essentia spend stays bounded by this task's own drain
            // batching and the single-slot `analysis` resource class.
            healLimit: 500,
            invalidatedBy: [
                'file.attached',
                'file.detached',
                'file.contentChanged',
                'file.defaultChanged',
                'file.probed',
            ] as const,
            // A re-attached/alternate file must not re-run Essentia analysis for
            // a track that's already analysed.
            preserveCompletedOn: ['file.attached'] as const,
            enqueueable: true,
            // The task guarantees a terminal coverage-row write for every candidate
            // it is handed: the success path upserts a `completed` row, and every
            // DURABLE exclusion (file permanently missing, Essentia hard-failure)
            // upserts a `skipped_permanent` row (see processTrackSlice). Only
            // TRANSIENT outages (parent directory absent / mount missing) leave the
            // row `pending` on purpose so it retries next sweep — that is correct,
            // not a wedge. wedge-guard Invariant 2 backstops the guarantee at
            // runtime. Declarative Stage Contract Phase 2.
            terminalDisposition: [
                {
                    // Whole-stage facts, but expressed as author predicates rather than
                    // a `global-guard` on purpose — a guard drains to
                    // `skipped_transient`, which `loadStageProgressByIds` counts as
                    // REMAINING, so the churn would stop and the bar would STILL be
                    // structurally unable to reach 100%. "You turned this off" and
                    // "this build has no analysis engine" are genuinely
                    // not-applicable-to-this-install, so `skipped_permanent` is the
                    // honest status — and it is safe here only because
                    // `eligibility.sql` above carries the same two flags and reclaims
                    // these rows the moment either flips.
                    //
                    // Two predicates rather than one so the Ingest Map can tell the
                    // causes apart: one is a setting the operator can flip in the UI,
                    // the other needs a different host arch or a sidecar URL. Both run
                    // BEFORE the eligibility dispose (order is invariant in
                    // `runStageDisposition`), so rows carry these specific reasons
                    // instead of the generic 'ineligible' the negation would stamp —
                    // which here also means "this file has no audio stream".
                    kind: 'predicate' as const,
                    ruleId: 'music-analysis-enabled',
                    disposeAs: 'skipped_permanent' as const,
                    reason: 'music-analysis-disabled',
                    excludes: (sql) => (config.DISABLE_MUSIC_ANALYSIS ? sql`true` : sql`false`),
                },
                {
                    kind: 'predicate' as const,
                    ruleId: 'music-analysis-engine-available',
                    disposeAs: 'skipped_permanent' as const,
                    reason: 'essentia-unavailable',
                    // isAnalysisEngineUsable, not isEssentiaAvailable: a binary that
                    // is present but crashes on this host (Docker Desktop / WSL2) is
                    // just as unavailable — otherwise every track stayed pending and
                    // read as "not progressing" forever (Windows e2e S7).
                    excludes: (sql) => (isAnalysisEngineUsable() ? sql`false` : sql`true`),
                },
                {
                    // Per-row, unlike the two above: DJ mixes / album rips over the
                    // duration cap. Same reason the drain's per-track guard stamps, so
                    // `recoverWhenAdditionalReasons` reclaims both populations alike.
                    kind: 'predicate' as const,
                    ruleId: 'music-analysis-duration-cap',
                    disposeAs: 'skipped_permanent' as const,
                    reason: TRACK_TOO_LONG_REASON,
                    excludes: (sql) =>
                        overDurationLimitSql(
                            sql as unknown as postgres.Sql<Record<string, never>>,
                            maxAnalysisDurationSeconds(),
                        ),
                },
                {
                    kind: 'self-terminal' as const,
                    ruleId: 'music-analysis-self-terminal',
                },
            ],
        },
    ],

    timeout: { hard: '120m', soft: '110m' },

    async execute(ctx) {
        const { sql: rawSql, signal, reportProgress, runId } = ctx;
        const sql = rawSql as unknown as postgres.Sql<Record<string, never>>;
        const logger = ctx.logger as unknown as PluginContext['logger'];

        if (config.DISABLE_MUSIC_ANALYSIS) {
            return {
                success: true,
                itemsProcessed: 0,
                result: { analyzed: 0, skipped: 0, errors: 0 },
            };
        }

        if (!isEssentiaAvailable()) {
            return {
                success: true,
                itemsProcessed: 0,
                result: { analyzed: 0, skipped: 0, errors: 0 },
            };
        }

        // Engine readiness check. In binary mode this is the crash-probe (spawns a
        // synthetic WAV once per process); in sidecar mode it GETs /health with a
        // 5s timeout. A configured-but-down sidecar returns false here so the drain
        // skips cleanly — tracks stay pending/eligible and retry next sweep — rather
        // than marking every track failed for a transient network outage.
        if (!(await verifyAnalysisEngineReady())) {
            logger.info('Analysis engine not ready — skipping drain (tracks stay eligible)');
            return {
                success: true,
                itemsProcessed: 0,
                result: { analyzed: 0, skipped: 0, errors: 0 },
            };
        }

        const rawInput = (ctx.input as Record<string, unknown>) ?? {};
        const mode = typeof rawInput.mode === 'string' ? rawInput.mode : 'catchup';
        const drainMode = resolveDrainMode(mode, logger);

        logger.info(
            `Using process-level Essentia concurrency limit: ${getEssentiaConcurrencyLimit()}`,
        );

        const startTime = Date.now();
        let analyzed = 0;
        let skipped = 0;
        let errors = 0;

        // Snapshot the eligible backlog lazily — captured inside fetchSlice on
        // the first call so it's taken *after* any force-mode wipe. A pre-wipe
        // count would collapse the progress bar to 100% before real work begins.
        const initialBacklog = lazyBacklog(() => countUnanalyzedTracks(sql, PROCESSING_VERSION));

        const onProgress = (processed: number, total: number, meta?: { currentItem?: string }) => {
            reportProgress(processed, total, meta?.currentItem);
        };

        const useCoverageTable = getAuthoritativeStageIds().has(PLUGIN_ID);

        await applyDurationLimitToExistingMarkers(sql, logger);

        try {
            const result = await drainBacklog<UnanalyzedTrackRow>(
                { sql, logger, abortSignal: signal } as unknown as Parameters<
                    typeof drainBacklog
                >[0],
                {
                    mode: drainMode,
                    sliceSize: SLICE_SIZE,
                    onWipe: () => wipeMusicAnalysis(sql, logger, signal),
                    idOf: (row) => row.id,
                    fetchSlice: async (limit) => {
                        const rows = useCoverageTable
                            ? await findCoverageTableBacklog(
                                  sql,
                                  PLUGIN_ID,
                                  PROCESSING_VERSION,
                                  limit,
                              )
                            : await getUnanalyzedTracks(sql, PROCESSING_VERSION, limit);
                        const total = await initialBacklog();
                        return {
                            items: rows,
                            remainingHint: computeRemainingHint(
                                total,
                                analyzed + skipped + errors,
                                rows.length,
                            ),
                        };
                    },
                    processSlice: async (tracks, sliceSignal) => {
                        const outcome = await processTrackSlice(
                            sql,
                            logger,
                            sliceSignal,
                            tracks,
                            runId,
                        );
                        analyzed += outcome.analyzed;
                        skipped += outcome.skipped;
                        errors += outcome.errors;
                        return {
                            produced: outcome.analyzed,
                            advanced: outcome.advancedMarkers,
                        };
                    },
                    onProgress,
                    phase: 'Analyzing tracks',
                    heartbeat: {
                        getTotal: () => initialBacklog.peek(),
                        getProcessed: () => analyzed,
                        getStatus: () =>
                            `Analyzing tracks... (${analyzed} done, ${errors} errors, ${skipped} skipped)`,
                    },
                },
            );

            const duration = Date.now() - startTime;
            logger.info(
                `Music analysis complete: ${analyzed} analyzed, ${skipped} skipped, ${errors} errors (stop=${result.stopReason}, ${duration}ms)`,
            );

            const suffix = formatStopReason(result.stopReason);

            // A normal return (as opposed to a thrown TaskError) is invisible
            // to the runner's success/failure bookkeeping — the run is still
            // recorded 'completed'. That's correct here: an abort is a clean
            // stop, not an error. `success: false` on abort is kept only for
            // convention (matches media-probe) and for whatever reads the
            // `result` JSONB column.
            return {
                success: !isAbortedStop(result.stopReason),
                itemsProcessed: analyzed,
                result: { analyzed, skipped, errors },
                ...(analyzed + skipped + errors === 0
                    ? {}
                    : {
                          message: `Analyzed tracks (${analyzed} done, ${errors} errors, ${skipped} skipped)${suffix}`,
                      }),
            };
        } catch (error) {
            logger.error('Music analysis sync failed', error instanceof Error ? error : undefined);
            // Unlike the abort path above, this IS a genuine internal-error
            // path (drainBacklog/processTrackSlice threw unexpectedly — e.g.
            // DB pool exhaustion). Returning `{success:false}` here used to be
            // silently ignored by the runner (a normal return always records
            // 'completed', regardless of the `success` field), so the run
            // showed green in the admin UI despite having failed outright.
            // Rethrow as a TaskError so the runner actually marks/retries the
            // run as failed. Classify via the shared infra heuristic:
            // network/DB blips are transient (worth a retry), anything else
            // is treated as permanent since retrying the same crash would
            // just fail again the same way.
            throw new TaskError({
                message: error instanceof Error ? error.message : String(error),
                kind: classifyInfraError(error) ? 'transient' : 'permanent',
                cause: error,
            });
        }
    },

    async processItems(ctx: TaskContext, items: unknown[]): Promise<void> {
        const tracks = (items as NewMediaItem[]).filter((i) => i.mediaType === 'track');
        if (!tracks.length) return;

        // Respect the feature switch on the incremental path too, so the self-test
        // below never spawns a probe on an instance with analysis turned off.
        if (config.DISABLE_MUSIC_ANALYSIS) return;

        if (!isEssentiaAvailable()) {
            const logger = ctx.logger as unknown as PluginContext['logger'];
            logger.info('Skipping incremental analysis: engine not available');
            return;
        }

        if (!(await verifyAnalysisEngineReady())) {
            const logger = ctx.logger as unknown as PluginContext['logger'];
            logger.info('Skipping incremental analysis: engine not ready (tracks stay eligible)');
            return;
        }

        const sql = ctx.sql as unknown as postgres.Sql<Record<string, never>>;
        const logger = ctx.logger as unknown as PluginContext['logger'];
        const signal = ctx.signal;
        const reportProgress = ctx.reportProgress;

        logger.info(
            `Using process-level Essentia concurrency limit: ${getEssentiaConcurrencyLimit()}`,
        );
        let analyzed = 0;
        let abortedUnmarked = 0;

        await Promise.all(
            tracks.map((track) =>
                withEssentiaConcurrency(async () => {
                    if (signal.aborted) {
                        abortedUnmarked++;
                        return;
                    }
                    if (!track.filePath) {
                        logger.debug('Track has no filePath, skipping incremental', {
                            id: track.id,
                        });
                        return;
                    }
                    const presence = await assessFilePresence(track.filePath);
                    if (presence === 'transient') {
                        logger.debug('Track parent dir absent (incremental, likely transient)', {
                            id: track.id,
                        });
                        return;
                    }
                    if (presence === 'missing') {
                        logger.debug('Track file not found, skipping incremental', {
                            id: track.id,
                        });
                        const ok = await markTrackExcluded(
                            sql,
                            track.id,
                            PROCESSING_VERSION,
                            'skipped',
                            'file-not-found',
                        );
                        if (!ok) {
                            logger.warn(
                                'Failed to mark skipped track (incremental) — row stays eligible',
                                { id: track.id },
                            );
                        }
                        return;
                    }

                    if ((await skipIfTooLong(sql, logger, track.id)) !== null) return;

                    try {
                        const result = await analyzeTrack(track.filePath, signal);
                        if (!result) {
                            const ok = await markTrackExcluded(
                                sql,
                                track.id,
                                PROCESSING_VERSION,
                                'failed',
                                'essentia-empty-result',
                            );
                            if (ok) {
                                await recordFailure(
                                    sql,
                                    PLUGIN_ID,
                                    track.id,
                                    'essentia-empty-result',
                                    ctx.runId ?? null,
                                );
                            } else {
                                logger.warn(
                                    'Failed to mark empty-result track (incremental) — row stays eligible',
                                    { id: track.id },
                                );
                            }
                            return;
                        }

                        await withTx(sql, async (tx) => {
                            const txSql = tx as unknown as postgres.Sql<Record<string, never>>;
                            await storeAnalysis(txSql, track.id, result);
                            const marked = await markTrackAnalyzed(
                                txSql,
                                track.id,
                                PROCESSING_VERSION,
                            );
                            if (!marked) {
                                throw new Error('Failed to persist music-analysis marker');
                            }
                            // Coverage row: this task uses a global-scope input,
                            // so the runner wrapper does not auto-write completion.
                            // Without this upsert the row stays `pending` and the
                            // next drain tick would re-process the same track.
                            await upsertCompletedRow(txSql, {
                                mediaItemId: track.id,
                                stageId: PLUGIN_ID,
                                processingVersion: PROCESSING_VERSION,
                            });
                        });

                        analyzed++;
                        reportProgress(
                            analyzed,
                            tracks.length,
                            track.filePath ? track.filePath.split('/').pop() : undefined,
                        );
                    } catch (err) {
                        // Transient sidecar transport failure — leave the track pending
                        // for retry; do NOT tombstone it. Exception: a track that keeps
                        // killing the sidecar mid-request is poison — after the strike
                        // limit it falls through to the durable-failure path below.
                        let poisonStrikes: number | null = null;
                        if (err instanceof SidecarUnreachableError) {
                            poisonStrikes = await countSidecarCrashStrike(track.id, err);
                            if (poisonStrikes === null) {
                                logger.debug(
                                    'Sidecar transiently unreachable (incremental) — leaving track eligible',
                                    {
                                        id: track.id,
                                        error: err.message,
                                    },
                                );
                                abortedUnmarked++;
                                return;
                            }
                        }
                        logger.warn('Error analyzing track (incremental)', {
                            id: track.id,
                            error: err instanceof Error ? err.message : String(err),
                            ...(poisonStrikes !== null
                                ? { sidecarCrashStrikes: poisonStrikes }
                                : {}),
                        });
                        const errMsg =
                            poisonStrikes !== null
                                ? `track crashed the analysis sidecar ${poisonStrikes} times — skipped (${err instanceof Error ? err.message : 'fetch failed'})`
                                : err instanceof Error
                                  ? err.message
                                  : 'analyze-threw';
                        const ok = await markTrackExcluded(
                            sql,
                            track.id,
                            PROCESSING_VERSION,
                            'failed',
                            errMsg,
                        );
                        if (ok) {
                            await recordFailure(
                                sql,
                                PLUGIN_ID,
                                track.id,
                                errMsg,
                                ctx.runId ?? null,
                            );
                        } else {
                            logger.warn(
                                'Failed to mark failed track (incremental) — row stays eligible',
                                { id: track.id },
                            );
                        }
                    }
                }).catch((err: unknown) => {
                    logger.warn('Concurrency slot failure (incremental)', {
                        id: track.id,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }),
            ),
        );

        if (abortedUnmarked > 0) {
            logger.info(
                `Music-analysis incremental: ${abortedUnmarked} track(s) aborted without mark; will be re-attempted next sweep`,
            );
        }
    },

    backlog: {
        unitLabel: 'tracks',
        sliceSize: SLICE_SIZE,
        softBudget: '1m',
        idOf: (row) => {
            const r = row as { id?: string } | null | undefined;
            return r?.id ?? String(r);
        },
        async stages(ctx: TaskContext): Promise<BacklogStage[]> {
            const sql = ctx.sql as unknown as postgres.Sql<Record<string, never>>;
            const status = await getMusicAnalysisBacklog(sql, PROCESSING_VERSION);
            const stages: BacklogStage[] = [];
            if (status.remaining > 0) {
                stages.push({
                    id: 'remaining',
                    label: 'Remaining',
                    count: status.remaining,
                });
            }
            if ((status.failed ?? 0) > 0) {
                stages.push({
                    id: 'failed',
                    label: 'Failed',
                    count: status.failed ?? 0,
                });
            }
            if (status.ineligible > 0) {
                stages.push({
                    id: 'ineligible',
                    label: 'Ineligible',
                    count: status.ineligible,
                });
            }
            return stages;
        },
        async wipe(ctx: TaskContext): Promise<void> {
            const sql = ctx.sql as unknown as postgres.Sql<Record<string, never>>;
            const logger = ctx.logger as unknown as PluginContext['logger'];
            await wipeMusicAnalysis(sql, logger, ctx.signal);
        },
        async compute(): Promise<{ items: unknown[]; remainingHint?: number }> {
            return { items: [], remainingHint: 0 };
        },
    },

    failures: {
        async list(
            ctx: TaskContext,
            opts: { limit: number; offset: number },
        ): Promise<{ items: SdkFailedItem[]; total: number }> {
            const clampedLimit = Math.min(100, Math.max(1, opts.limit));
            const safeOffset = Math.max(0, opts.offset);
            const sql = ctx.sql as unknown as postgres.Sql<Record<string, never>>;

            const [{ count }] = await sql<[{ count: number }]>`
                SELECT COUNT(*)::int AS count
                FROM media_items mi
                WHERE mi.media_type = 'track'
                  AND (mi.processing_state -> 'music-analysis' ->> 'version')::int >= ${PROCESSING_VERSION}
                  AND mi.processing_state -> 'music-analysis' ->> 'status' = 'failed'
            `;

            const rows = await sql<
                Array<{
                    id: string;
                    title: string;
                    artist: string | null;
                    processing_state: Record<
                        string,
                        {
                            status: string;
                            reason?: string;
                            audit_run_job_id?: string;
                        }
                    >;
                    task_history_id: number | null;
                }>
            >`
                SELECT mi.id, mi.title, mi.artist, mi.processing_state, th.id AS task_history_id
                FROM media_items mi
                LEFT JOIN (
                    SELECT id, task_id FROM task_history
                    UNION ALL
                    SELECT original_id AS id, task_id FROM task_history_archive
                    WHERE original_id IS NOT NULL
                ) th ON th.task_id = (mi.processing_state -> 'music-analysis' ->> 'audit_run_job_id')
                WHERE mi.media_type = 'track'
                  AND (mi.processing_state -> 'music-analysis' ->> 'version')::int >= ${PROCESSING_VERSION}
                  AND mi.processing_state -> 'music-analysis' ->> 'status' = 'failed'
                ORDER BY mi.updated_at DESC
                LIMIT ${clampedLimit} OFFSET ${safeOffset}
            `;

            const trackIds = rows.map((r) => r.id);
            let aggregates = new Map<string, FailureAggregateRow>();
            try {
                aggregates = await getFailureAggregates(sql, PLUGIN_ID, trackIds);
            } catch (err) {
                const logger = ctx.logger as unknown as PluginContext['logger'];
                logger.warn(
                    'listFailedItems aggregate fetch failed — serving list without timeline counts',
                    { error: err instanceof Error ? err.message : String(err) },
                );
            }

            return {
                total: count,
                items: rows.map((r) => {
                    const agg = aggregates.get(r.id);
                    return {
                        id: r.id,
                        label: r.artist ? `${r.artist} — ${r.title}` : r.title,
                        reason: r.processing_state['music-analysis']?.reason ?? 'Analysis failed',
                        detectedAt: null,
                        ...(agg && {
                            firstSeen: agg.first_seen.toISOString(),
                            failureCount: agg.failure_count,
                            lastSeen: agg.last_seen.toISOString(),
                        }),
                    };
                }),
            };
        },

        async retry(ctx: TaskContext, itemId: string): Promise<void> {
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(itemId)) {
                throw new Error('Invalid track id (expected UUID)');
            }

            const sql = ctx.sql as unknown as postgres.Sql<Record<string, never>>;
            const logger = ctx.logger as unknown as PluginContext['logger'];
            const signal = ctx.signal;
            const runId = ctx.runId;

            const [track] = await sql<
                Array<{
                    id: string;
                    file_path: string | null;
                    prior_audit_job_id: string | null;
                }>
            >`
                SELECT
                    mi.id,
                    (ARRAY_AGG(mf.file_path ORDER BY mf.id))[1] AS file_path,
                    MAX(mi.processing_state -> 'music-analysis' ->> 'audit_run_job_id') AS prior_audit_job_id
                FROM media_items mi
                JOIN media_file_items mfi ON mfi.media_item_id = mi.id
                JOIN media_files mf ON mf.id = mfi.file_id
                WHERE mi.id = ${itemId}::uuid
                  AND mi.media_type = 'track'
                  AND mf.file_path IS NOT NULL
                GROUP BY mi.id
            `;

            if (!track) {
                throw new Error(`Track or file not found (id=${itemId})`);
            }
            if (!track.file_path) {
                throw new Error('Track has no file_path');
            }

            const auditJobId = track.prior_audit_job_id ?? undefined;
            void runId;

            let thrown: unknown = null;
            try {
                await withEssentiaConcurrency(async () => {
                    if (signal.aborted) {
                        thrown = new Error('Retry aborted before start');
                        return;
                    }

                    try {
                        const presence = await assessFilePresence(track.file_path!);
                        if (presence === 'transient') {
                            thrown = new Error('File parent directory transiently missing');
                            return;
                        }
                        if (presence === 'missing') {
                            await markTrackExcluded(
                                sql,
                                track.id,
                                PROCESSING_VERSION,
                                'skipped',
                                'file-not-found',
                                auditJobId,
                            );
                            return;
                        }

                        if ((await skipIfTooLong(sql, logger, track.id)) !== null) return;

                        const result = await analyzeTrack(track.file_path!, signal);
                        if (!result) {
                            await markTrackExcluded(
                                sql,
                                track.id,
                                PROCESSING_VERSION,
                                'failed',
                                'essentia-empty-result',
                                auditJobId,
                            );
                            return;
                        }

                        await withTx(sql, async (tx) => {
                            const txSql = tx as unknown as postgres.Sql<Record<string, never>>;
                            await storeAnalysis(txSql, track.id, result);
                            const marked = await markTrackAnalyzed(
                                txSql,
                                track.id,
                                PROCESSING_VERSION,
                            );
                            if (!marked) {
                                throw new Error('Failed to persist music-analysis marker');
                            }
                            await upsertCompletedRow(txSql, {
                                mediaItemId: track.id,
                                stageId: PLUGIN_ID,
                                processingVersion: PROCESSING_VERSION,
                            });
                        });
                    } catch (err) {
                        // Transient sidecar transport failure — leave the track
                        // pending (do NOT tombstone); signal the caller that the
                        // retry itself was transient so no "still failing" error
                        // is surfaced to the admin UI. Exception: a track that
                        // keeps killing the sidecar mid-request is poison — after
                        // the strike limit it falls through to the failure path.
                        let poisonStrikes: number | null = null;
                        if (err instanceof SidecarUnreachableError) {
                            poisonStrikes = await countSidecarCrashStrike(track.id, err);
                            if (poisonStrikes === null) {
                                logger.debug(
                                    'Sidecar transiently unreachable (retry) — leaving track eligible',
                                    {
                                        id: track.id,
                                        error: err.message,
                                    },
                                );
                                // thrown stays null → retry returns without throwing
                                return;
                            }
                        }
                        logger.warn('Music analysis retry failed', {
                            id: track.id,
                            error: err instanceof Error ? err.message : String(err),
                            ...(poisonStrikes !== null
                                ? { sidecarCrashStrikes: poisonStrikes }
                                : {}),
                        });
                        try {
                            const retryErrMsg =
                                poisonStrikes !== null
                                    ? `track crashed the analysis sidecar ${poisonStrikes} times — skipped (${err instanceof Error ? err.message : 'fetch failed'})`
                                    : err instanceof Error
                                      ? err.message
                                      : 'analyze-threw';
                            const ok = await markTrackExcluded(
                                sql,
                                track.id,
                                PROCESSING_VERSION,
                                'failed',
                                retryErrMsg,
                                auditJobId,
                            );
                            if (ok) {
                                await recordFailure(
                                    sql,
                                    PLUGIN_ID,
                                    track.id,
                                    retryErrMsg,
                                    auditJobId ?? null,
                                );
                            }
                        } catch (markErr) {
                            logger.warn('markTrackExcluded failed during retry', {
                                id: track.id,
                                error: markErr instanceof Error ? markErr.message : String(markErr),
                            });
                        }
                        thrown = err;
                    }
                });
            } catch (slotErr) {
                throw new Error(
                    (slotErr instanceof Error ? slotErr.message : String(slotErr)).slice(0, 200),
                    { cause: slotErr },
                );
            }

            if (thrown) {
                throw thrown instanceof Error ? thrown : new Error(String(thrown));
            }

            // Post-write state inspection. Success = not 'failed'.
            // The SELECT may fail transiently (DB blip after a successful analyze+store);
            // treat that as success rather than misreporting a good write as failed.
            let afterRow: { status: string | null; reason: string | null } | undefined;
            try {
                const [row] = await sql<Array<{ status: string | null; reason: string | null }>>`
                    SELECT
                        processing_state -> 'music-analysis' ->> 'status' AS status,
                        processing_state -> 'music-analysis' ->> 'reason' AS reason
                    FROM media_items
                    WHERE id = ${itemId}::uuid
                    LIMIT 1
                `;
                afterRow = row;
            } catch (readErr) {
                logger.warn('Music analysis retry post-check failed — assuming success', {
                    id: track.id,
                    error: readErr instanceof Error ? readErr.message : String(readErr),
                });
            }
            if (afterRow?.status === 'failed') {
                throw new Error((afterRow.reason ?? 'Still failing').slice(0, 200));
            }
        },
    },
});

registry.registerTask(musicAnalysisTask);

// ============================================================================
// Helpers
// ============================================================================

/**
 * Write a terminal `skipped_permanent` coverage row for a durably-excluded
 * track so its `media_item_stage_state` row leaves `pending` and stops
 * cycling through the drain. The success path writes a `completed` coverage
 * row via `upsertCompletedRow`; this is its skip-side counterpart, keeping the
 * `self-terminal` contract honest (every candidate gets a terminal write).
 *
 * Best-effort and non-throwing: `markTrackExcluded` already recorded the
 * durable verdict in `processing_state`; a coverage-write blip must not abort
 * the slice. If it fails, wedge-guard Invariant 2 still backstops the row.
 * Only call this for DURABLE exclusions (file permanently missing, Essentia
 * hard-failure) — never for transient mount/dir outages, which intentionally
 * stay `pending` to retry.
 */
/** The live duration cap in seconds; 0 = no cap. */
function maxAnalysisDurationSeconds(): number {
    return Math.max(0, config.MUSIC_ANALYSIS_MAX_DURATION_MINUTES) * 60;
}

/**
 * Durably skip a track over the duration cap: `skipped` marker, terminal
 * coverage row, and any earlier failure events resolved (a mix that failed
 * before the cap existed must stop counting as "could not process").
 *
 * Returns `null` when the track is within the cap (caller analyses it), else
 * whether the marker write landed. A failed length lookup returns `null` — the
 * track is analysed as before rather than skipped on a DB blip.
 */
async function skipIfTooLong(
    sql: postgres.Sql<Record<string, never>>,
    logger: PluginContext['logger'],
    trackId: string,
): Promise<boolean | null> {
    let over: boolean;
    try {
        over = await isTrackOverDurationLimit(sql, trackId, maxAnalysisDurationSeconds());
    } catch (err) {
        logger.warn('Duration-cap lookup failed — analysing track anyway', {
            id: trackId,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
    if (!over) return null;
    logger.debug('Track exceeds the analysis duration cap, skipping', { id: trackId });
    const ok = await markTrackExcluded(
        sql,
        trackId,
        PROCESSING_VERSION,
        'skipped',
        TRACK_TOO_LONG_REASON,
    );
    if (!ok) {
        logger.warn('Failed to mark over-length track — row stays eligible', { id: trackId });
        return false;
    }
    await writeSkippedPermanentCoverage(sql, logger, trackId, TRACK_TOO_LONG_REASON);
    await resolveFailuresQuietly(sql, logger, trackId);
    return true;
}

async function resolveFailuresQuietly(
    sql: postgres.Sql<Record<string, never>>,
    logger: PluginContext['logger'],
    trackId: string,
): Promise<void> {
    try {
        await markFailureEventsResolved(sql as unknown as postgres.Sql, PLUGIN_ID, trackId);
    } catch (err) {
        logger.warn('Failed to resolve failure events for over-length track', {
            id: trackId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Re-classify markers written before the current cap (see
 * `reconcileDurationLimit`). Best-effort: a failure here must not block the
 * drain, the next run retries it.
 */
async function applyDurationLimitToExistingMarkers(
    sql: postgres.Sql<Record<string, never>>,
    logger: PluginContext['logger'],
): Promise<void> {
    try {
        const { skippedIds, restoredIds } = await reconcileDurationLimit(
            sql,
            PROCESSING_VERSION,
            maxAnalysisDurationSeconds(),
        );
        for (const id of skippedIds) {
            await writeSkippedPermanentCoverage(sql, logger, id, TRACK_TOO_LONG_REASON);
            await resolveFailuresQuietly(sql, logger, id);
        }
        if (skippedIds.length > 0 || restoredIds.length > 0) {
            logger.info(
                `Duration cap applied: ${skippedIds.length} failed tracks re-marked skipped, ${restoredIds.length} re-queued`,
            );
        }
    } catch (err) {
        logger.warn('Duration-cap reconcile failed — will retry next run', {
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

async function writeSkippedPermanentCoverage(
    sql: postgres.Sql<Record<string, never>>,
    logger: PluginContext['logger'],
    trackId: string,
    skippedReason: string,
): Promise<void> {
    try {
        await upsertSkippedPermanentRow(sql, {
            mediaItemId: trackId,
            stageId: PLUGIN_ID,
            processingVersion: PROCESSING_VERSION,
            skippedReason,
        });
    } catch (err) {
        logger.warn('Failed to write skipped_permanent coverage row — wedge-guard will backstop', {
            id: trackId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Process one slice of unanalyzed tracks. Honors the process-level Essentia
 * concurrency limit and persists each result in a per-track transaction so
 * a mid-slice abort or crash never desyncs processing_state from custom_metadata.
 */
async function processTrackSlice(
    sql: postgres.Sql<Record<string, never>>,
    logger: PluginContext['logger'],
    abortSignal: AbortSignal,
    tracks: UnanalyzedTrackRow[],
    jobId: string,
): Promise<SliceOutcome> {
    let analyzed = 0;
    let skipped = 0;
    let errors = 0;
    let advancedMarkers = 0;
    let abortedUnmarked = 0;
    // Coverage rows whose file was transiently absent this slice — deferred in a
    // single batch after the slice so they leave the eligible window instead of
    // being re-picked every drain tick (see TRANSIENT_RETRY_MS).
    const transientIds: string[] = [];

    await Promise.all(
        tracks.map((track) =>
            withEssentiaConcurrency(async () => {
                if (abortSignal.aborted) {
                    abortedUnmarked++;
                    return;
                }

                const presence = await assessFilePresence(track.file_path);
                if (presence === 'transient') {
                    logger.debug(
                        'Skipping track: parent dir absent (likely transient mount outage)',
                        {
                            id: track.id,
                            path: track.file_path.split('/').slice(-2).join('/'),
                        },
                    );
                    transientIds.push(track.id);
                    return;
                }
                if (presence === 'missing') {
                    logger.debug('Audio file not found on disk, skipping', {
                        id: track.id,
                        path: track.file_path.split('/').slice(-2).join('/'),
                    });
                    skipped++;
                    const ok = await markTrackExcluded(
                        sql,
                        track.id,
                        PROCESSING_VERSION,
                        'skipped',
                        'file-not-found',
                    );
                    if (ok) {
                        advancedMarkers++;
                        // Durable exclusion: the file is genuinely absent (not a
                        // transient mount outage). Write a terminal coverage row
                        // so the stage_state row leaves `pending` — otherwise the
                        // self-terminal contract is a lie and the row cycles
                        // forever in coverage-table mode. A file.attached /
                        // file.contentChanged event reseeds it to pending.
                        await writeSkippedPermanentCoverage(
                            sql,
                            logger,
                            track.id,
                            'file-not-found',
                        );
                    } else {
                        logger.warn('Failed to mark skipped track — row stays eligible', {
                            id: track.id,
                        });
                    }
                    return;
                }

                const tooLong = await skipIfTooLong(sql, logger, track.id);
                if (tooLong !== null) {
                    skipped++;
                    if (tooLong) advancedMarkers++;
                    return;
                }

                try {
                    const result = await analyzeTrack(track.file_path, abortSignal);
                    if (!result) {
                        logger.warn('Essentia returned no result', {
                            id: track.id,
                            path: track.file_path.split('/').slice(-2).join('/'),
                        });
                        errors++;
                        const ok = await markTrackExcluded(
                            sql,
                            track.id,
                            PROCESSING_VERSION,
                            'failed',
                            'essentia-empty-result',
                            jobId,
                        );
                        if (ok) {
                            advancedMarkers++;
                            await recordFailure(
                                sql,
                                PLUGIN_ID,
                                track.id,
                                'essentia-empty-result',
                                jobId ?? null,
                            );
                            // Durable Essentia hard-failure: the analyzer ran and
                            // returned nothing for this file. Tombstone the
                            // coverage row so it leaves `pending`; a
                            // PROCESSING_VERSION bump or content event re-admits it.
                            await writeSkippedPermanentCoverage(
                                sql,
                                logger,
                                track.id,
                                'essentia-empty-result',
                            );
                        } else {
                            logger.warn('Failed to mark empty-result track — row stays eligible', {
                                id: track.id,
                            });
                        }
                        return;
                    }

                    try {
                        await withTx(sql, async (tx) => {
                            const txSql = tx as unknown as postgres.Sql<Record<string, never>>;
                            await storeAnalysis(txSql, track.id, result);
                            const marked = await markTrackAnalyzed(
                                txSql,
                                track.id,
                                PROCESSING_VERSION,
                            );
                            if (!marked) {
                                throw new Error('Failed to persist music-analysis marker');
                            }
                            await upsertCompletedRow(txSql, {
                                mediaItemId: track.id,
                                stageId: PLUGIN_ID,
                                processingVersion: PROCESSING_VERSION,
                            });
                        });
                        analyzed++;
                        advancedMarkers++;
                    } catch (txErr) {
                        logger.warn('Essentia tx failed — row stays eligible', {
                            id: track.id,
                            error: txErr instanceof Error ? txErr.message : String(txErr),
                        });
                        errors++;
                    }
                } catch (err) {
                    // Transient sidecar transport failure: the sidecar was unreachable
                    // (fetch threw, connection reset, timeout, or HTTP 5xx). Leave the
                    // track pending so it retries next drain — do NOT tombstone it.
                    // Exception: a track that keeps killing the sidecar mid-request is
                    // poison — after the strike limit it falls through to the durable
                    // failure path below instead of looping forever.
                    let poisonStrikes: number | null = null;
                    if (err instanceof SidecarUnreachableError) {
                        poisonStrikes = await countSidecarCrashStrike(track.id, err);
                        if (poisonStrikes === null) {
                            logger.debug(
                                'Sidecar transiently unreachable — leaving track eligible for retry',
                                {
                                    id: track.id,
                                    error: err.message,
                                },
                            );
                            abortedUnmarked++;
                            return;
                        }
                    }
                    logger.warn('Error analyzing track', {
                        id: track.id,
                        error: err instanceof Error ? err.message : String(err),
                        ...(poisonStrikes !== null ? { sidecarCrashStrikes: poisonStrikes } : {}),
                    });
                    errors++;
                    const errMsg =
                        poisonStrikes !== null
                            ? `track crashed the analysis sidecar ${poisonStrikes} times — skipped (${err instanceof Error ? err.message : 'fetch failed'})`
                            : err instanceof Error
                              ? err.message
                              : 'analyze-threw';
                    const ok = await markTrackExcluded(
                        sql,
                        track.id,
                        PROCESSING_VERSION,
                        'failed',
                        errMsg,
                        jobId,
                    );
                    if (ok) {
                        advancedMarkers++;
                        await recordFailure(sql, PLUGIN_ID, track.id, errMsg, jobId ?? null);
                        // Durable analyze failure (Essentia threw on this file).
                        // Tombstone the coverage row so it leaves `pending`; a
                        // PROCESSING_VERSION bump or content event re-admits it.
                        await writeSkippedPermanentCoverage(sql, logger, track.id, errMsg);
                    } else {
                        logger.warn('Failed to mark failed track — row stays eligible', {
                            id: track.id,
                        });
                    }
                }
            }).catch((err: unknown) => {
                logger.warn('Concurrency slot failure', {
                    id: track.id,
                    error: err instanceof Error ? err.message : String(err),
                });
                errors++;
            }),
        ),
    );

    // Defer transiently-unavailable rows in one batch so they exit the eligible
    // window instead of being re-picked every drain tick. Best-effort — a
    // coverage-write blip must not fail the slice; and a no-op outside
    // coverage-table mode (no matching media_item_stage_state rows).
    if (transientIds.length > 0) {
        try {
            await deferTransientRetryBatch(sql, {
                stageId: PLUGIN_ID,
                mediaItemIds: transientIds,
                retryAfterMs: TRANSIENT_RETRY_MS,
            });
        } catch (err) {
            logger.warn('Failed to defer transient coverage rows', {
                count: transientIds.length,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    if (abortedUnmarked > 0) {
        logger.info(
            `Music-analysis slice: ${abortedUnmarked} track(s) aborted without mark; will be re-attempted next drain`,
        );
    }

    return { analyzed, skipped, errors, advancedMarkers, abortedUnmarked };
}

/**
 * Remove the Essentia namespace from custom_metadata and clear the
 * music-analysis processing_state marker via `drainWipe`.
 */
async function wipeMusicAnalysis(
    sql: postgres.Sql<Record<string, never>>,
    logger: PluginContext['logger'],
    abortSignal: AbortSignal,
): Promise<void> {
    await drainWipe({
        abortSignal,
        batchSize: WIPE_BATCH_SIZE,
        fetchBatch: (limit) => getMusicAnalysisWipeBatch(sql, ESSENTIA_NAMESPACE_KEY, limit),
        wipeBatch: (ids) => atomicallyWipeMusicAnalysis(sql, ids, ESSENTIA_NAMESPACE_KEY),
        logger,
        label: 'Music analysis',
    });
}
