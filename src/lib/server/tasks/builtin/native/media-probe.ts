// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { recheckChangedFileHealth } from '../../file-health-auto-recheck.js';
import {
    FILE_HEALTH_RECHECK_BATCH,
    FILE_HEALTH_RULE_VERSION,
} from '../../../database/queries/file-health-recheck.queries.js';
import { durationReviewTechnicalBlock } from '../../../services/file-health-review.service.js';
import { AudioTailAssessmentSchema } from '$lib/schemas/audio-tail-assessment.js';
import {
    boundedAdminHealthIssuesSql,
    actionableFileHealthSql,
} from '$lib/server/database/queries/file-health-classification.queries.js';

/**
 * Media File Probe — native defineTask implementation.
 *
 * Background task that enriches media_files rows with FFprobe data:
 * - Phase A (quick): Probes stream metadata (video, audio, subtitle) + container info
 * - Phase B (slow): Probes keyframe positions for keyframe-accurate seeking
 *
 * Configuration:
 * - SYNC_MEDIA_PROBE_INTERVAL: Duration-string override for the 1h cadence
 *   (e.g. '30m', '2h').
 * - DISABLE_MEDIA_PROBE: Set to 'true' to disable (both scheduled and manual triggers).
 */

import type postgres from 'postgres';
import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { config } from '$lib/server/config.js';
import type {
    TaskContext,
    BacklogStage,
    FailedItem as SdkFailedItem,
} from '@sapd/lumastra-plugin-sdk';
import {
    drainBacklog,
    drainWipe,
    resolveDrainMode,
    formatStopReason,
    computeRemainingHint,
    isAbortedStop,
    lazyBacklog,
    pickWorstStopReason,
    startHeartbeat,
    type DrainBacklogLogger,
    type DrainBacklogMode,
    type DrainStopReason,
} from '../../../plugins/runtime/drain-backlog.js';
import {
    probeMediaFile,
    probeKeyframes,
    probeStreamTails,
    type MediaProbeResult as FfprobeMediaProbeResult,
    type StreamTails,
} from '../../../utils/ffprobe.js';
import {
    isMaterialStreamLoss,
    TRUNCATION_MIN_GAP_S,
    TRUNCATION_MIN_GAP_SHARE_EXACT,
} from '../../../utils/stream-tail-loss.js';
import { takeScanProbe } from '../../../utils/scan-probe-cache.js';
import { mapFFprobeToDbRows } from '../../../utils/media-stream-mapper.js';
import { replaceStreamsForFile } from '../../../database/queries/media-streams.queries.js';
import { refreshLanguagesForFile } from '../../../database/queries/media-item-languages.queries.js';
import { refreshQualityForFile } from '../../../database/queries/media-item-quality.queries.js';
import { refreshSegmentsForFile } from '../../../database/queries/file-segments.queries.js';
import {
    backfillMovieRuntimesChunk,
    getUnprobedFiles,
    getFilesWithoutKeyframes,
    countUnprobedFiles,
    countFilesWithoutKeyframes,
    markFileMissing,
    updateProbeData,
    updateKeyframes,
    updateHealthIssues,
    removeReviewedHealthIssues,
    addRecheckedHealthIssues,
    lockFileHealthIssues,
    getFileHealthSnapshot,
    promoteHighestQualityVersion,
    loadMultiFileItemIds,
    type UnprobedFileRow,
} from '../../../database/queries/media-files.queries.js';
import { AsyncSemaphore } from '../../../utils/async-semaphore.js';
import { withTx } from '../../../database/with-tx.js';
import type { FileHealthIssue } from '../../../database/queries/media-files.queries.js';
import type {
    ListFailedItemsOptions,
    ListFailedItemsResult,
    RetryItemResult,
} from '../../sync-context-types.js';
import { assessFilePresence } from '../../../utils/file-presence.js';
import {
    recordFailure,
    markFailureEventsResolved,
    getFailureAggregates,
    type FailureAggregateRow,
} from '../../../database/queries/plugin-failure-events.queries.js';
import {
    upsertCompletedRow,
    completeFreshFileProbeStage,
    recordStageAttemptFailure,
} from '../../../database/queries/stage-state.queries.js';
import { emitPipelineEvent } from '../../../database/queries/event-outbox.queries.js';
import { registry } from '../../registry.js';
import { MediaLifecycleService } from '../../../services/media-lifecycle.service.js';
import { classifyInfraError } from '../../infra-retry.js';
import type { FileHealthRecheckResult } from '$lib/schemas/file-health-recheck.js';
import { withAdvisoryLock } from '../../../database/with-advisory-lock.js';
import { buildAdminContextStub } from '../../plugin-context.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import { healthPhysicalIdentity } from '../../../utils/health-file-identity.js';
import {
    readTailInventory,
    measureAudioTail,
    type TailInventory,
} from '../../../utils/audio-tail-assessment.js';
import {
    getHealthSourceSnapshot,
    assertHealthSourceCurrent,
    type HealthSourceSnapshot,
} from '../../../database/queries/file-health-assessment.queries.js';
import type { AudioTailAssessment } from '$lib/schemas/audio-tail-assessment.js';

// ============================================================================
// Constants
// ============================================================================

const PLUGIN_ID = 'media-probe';

// Centralized so upsertCompletedRow calls below cannot drift from the
// declared task.processingVersion (line 930). If you bump the task
// processingVersion, bump this constant in the same change.
const PROCESSING_VERSION = 1;

/** Stage skip reason (both probe stages) while `DISABLE_MEDIA_PROBE` is set; reclaimed when cleared. */
export const MEDIA_PROBE_DISABLED_REASON = 'media-probe-disabled';

// Phase A does lightweight metadata probes; 200 keeps each slice ~tens of
// seconds on typical libraries and matches the pre-refactor cadence.
const PHASE_A_SLICE_SIZE = 200;

// How many files to probe CONCURRENTLY within one Phase A slice. ffprobe is a
// child process dominated by NFS-I/O + subprocess spawn, so overlapping a few
// near-linearly multiplies throughput — without this the whole stage is a
// single global run with a serial per-file loop (effective concurrency 1,
// ~8 files/min on cold NFS). Default 4 is conservative; raise on fast storage
// with DB-pool headroom (each worker briefly holds one write transaction).
// Override with LUMASTRA_MEDIA_PROBE_CONCURRENCY.
const MEDIA_PROBE_CONCURRENCY = Math.max(
    1,
    Number.parseInt(process.env.LUMASTRA_MEDIA_PROBE_CONCURRENCY ?? '4', 10) || 4,
);

// Phase B probes keyframes which re-reads the whole file. 50 is slow-but-safe:
// a 2-hour movie can take 30–90 s to scan depending on disk, so the slice
// bounds per-iteration wall time below the 2-minute heartbeat window.
const PHASE_B_SLICE_SIZE = 50;

// Heuristic minimum before entering Phase B. A single keyframe probe takes
// 30–90 s on typical files, up to ~5 min on large 4K titles, and in extreme
// cases 10+ min. This threshold reduces overrun frequency but cannot
// eliminate it — the BullMQ grace window (~10 min) absorbs the tail risk.
const PHASE_B_MIN_BUDGET_MS = 5 * 60 * 1000;

// Shared soft wall-clock budget across both phases. BullMQ's maxDurationMs is
// 1 h (see syncConfig) — leaving ~10 min grace keeps us from racing the hard
// kill and lets the summary message propagate to the admin UI.
const TOTAL_SOFT_BUDGET_MS = 50 * 60 * 1000;

// Chunk size for the destructive wipe. Matches music-analysis.plugin — keeps
// UPDATE/DELETE lock windows short so the scanner and playback writers aren't
// blocked when wiping a 100k-row library.
const WIPE_BATCH_SIZE = 500;

// Chunk size for the Phase 0 runtime backfill. Each chunk runs one UPDATE
// over at most PHASE_0_CHUNK_SIZE movies; the loop yields between chunks so
// a 100k-file library doesn't lock media_items for 30-60s on the very
// first catchup run (which was enough to trip BullMQ's stall detector
// before the heartbeat had seen a single slice).
const PHASE_0_CHUNK_SIZE = 500;

// Chunk size for the pre-drain stage_state reconciliation UPDATEs. Same class
// of stall the Phase 0 backfill was already patched for: the two "mark
// already-done rows completed" UPDATEs ran unbounded over the WHOLE table
// BEFORE startHeartbeat/reportProgress, so on a large library a single
// statement could hold media_item_stage_state locks long enough to look like a
// stall before the first slice. Bound each UPDATE to RECONCILE_CHUNK_SIZE rows
// and yield between chunks (mirrors PHASE_0_CHUNK_SIZE below/above).
export const RECONCILE_CHUNK_SIZE = 500;

// Hard cap on reconciliation chunk count so a pathological planner can't spin
// forever. The bounded UPDATE flips matching rows to 'completed', so they stop
// matching the predicate — a non-terminating loop would imply a planner bug and
// should surface rather than silently continue.
const MAX_RECONCILE_CHUNKS = 10_000;

// Backoff applied to a per-item stage row when its probe fails (bug M1).
// media-probe is multi-stage so it bypasses wrapExecute's attempt accounting;
// without a backoff a perpetually-failing file (corrupt container, unsupported
// codec) is re-enqueued by the stage-sweep every tick. 30 min throttles that
// sweep churn while still recovering quickly once a re-scan resets the file
// (upsertMediaFile nulls probed_at → the row re-enters and a successful probe
// upserts it back to `completed`).
const PROBE_FAILURE_BACKOFF_MS = 30 * 60 * 1000;

// Hard attempt cap: after this many consecutive stage-sweep failures, a probe
// row is promoted failed_transient → failed_permanent (give up) instead of
// looping at the backoff cadence forever. Before this existed a 50 GB remux
// whose keyframe scan always exceeded the ffprobe timeout reached attempt 637.
// ≈ this × the 30-min backoff (~5 h) of retrying before it parks for an operator.
const PROBE_FAILURE_MAX_ATTEMPTS = 10;

// Keyframe-probe timeout scales with file size. probeKeyframes does a full packet
// scan; the 120 s base is fine for typical files but a 50 GB 4K remux can't be
// read in time, so it would time out on every attempt. Base + per-GB, capped so
// one pathological file can't hold a worker slot indefinitely.
const KEYFRAME_TIMEOUT_BASE_MS = 120_000;
const KEYFRAME_TIMEOUT_PER_GB_MS = 20_000;
const KEYFRAME_TIMEOUT_MAX_MS = 900_000; // 15 min

/** Per-file keyframe-probe timeout, scaled by size (bytes). Falls back to the
 *  base when size is unknown/zero. e.g. 50 GB → capped 15 min; 8 GB → ~280 s.
 *  Exported for unit testing. */
export function keyframeTimeoutForSize(fileSizeBytes: number | null | undefined): number {
    if (!fileSizeBytes || !Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0) {
        return KEYFRAME_TIMEOUT_BASE_MS;
    }
    const gb = fileSizeBytes / 1_000_000_000;
    return Math.min(
        KEYFRAME_TIMEOUT_MAX_MS,
        Math.round(KEYFRAME_TIMEOUT_BASE_MS + gb * KEYFRAME_TIMEOUT_PER_GB_MS),
    );
}

// ============================================================================
// Row types
// ============================================================================

interface KeyframeFileRow {
    id: string;
    file_version?: string;
    file_path: string;
    duration_seconds: number | null;
    file_size_bytes: number | null;
    media_item_ids: string[];
}

// ============================================================================
// Input / Result schemas
// ============================================================================

const inputSchema = z.object({ fileId: z.string().uuid().toLowerCase().optional() }).passthrough();

type MediaProbeInput = z.infer<typeof inputSchema>;

interface MediaProbeResult {
    recheck?: FileHealthRecheckResult;
    probed: number;
    keyframed: number;
    errors: number;
    missing: number;
}

// ============================================================================
// Helpers
// ============================================================================

/** …or this share when only keyframes are known (the end is a GOP-sized guess). */
const TRUNCATION_MIN_GAP_SHARE_KEYFRAMES = 0.1;

/**
 * Decide whether the video stream ends materially before the container says.
 *
 * 🔴 The last KEYFRAME is not where the video ends: x264's default keyint is
 * ≈10 s, so a perfectly fine 15 s clip with keyframes at 0 s and 10.4 s (last
 * frame 14.96 s) was flagged "ends at 10s but container reports 15s" — every
 * trailer, extra and short in a library (Windows e2e 2026-09-27, S3).
 *
 * - With `lastPacketPts` (the highest video packet PTS from the scan) the end
 *   is exact; flag when the gap exceeds max(10 s, 5 % of the duration).
 * - Without it (rows probed before the packet PTS was kept) only a keyframe
 *   bound is known: the real end can be up to one GOP past the last keyframe,
 *   so tolerate the largest keyframe interval plus 10 s, and never less than
 *   10 % of the duration. With fewer than two keyframes the GOP is unknown and
 *   nothing is flagged.
 *
 * Exported for unit tests and the false-issue cleanup.
 */
export function assessTruncation(
    keyframes: number[],
    durationSeconds: number | null,
    lastPacketPts?: number | null,
): { truncated: boolean; videoEndSeconds: number } {
    const lastKeyframe = keyframes.length > 0 ? keyframes[keyframes.length - 1] : 0;
    if (durationSeconds == null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        return { truncated: false, videoEndSeconds: lastKeyframe };
    }
    if (lastPacketPts != null && Number.isFinite(lastPacketPts) && lastPacketPts > 0) {
        const videoEnd = Math.max(lastPacketPts, lastKeyframe);
        const gap = durationSeconds - videoEnd;
        const tolerance = Math.max(
            TRUNCATION_MIN_GAP_S,
            durationSeconds * TRUNCATION_MIN_GAP_SHARE_EXACT,
        );
        return { truncated: gap > tolerance, videoEndSeconds: videoEnd };
    }
    if (keyframes.length < 2) return { truncated: false, videoEndSeconds: lastKeyframe };
    let maxGop = keyframes[0] > 0 ? keyframes[0] : 0;
    for (let i = 1; i < keyframes.length; i++) {
        const interval = keyframes[i] - keyframes[i - 1];
        if (interval > maxGop) maxGop = interval;
    }
    const gap = durationSeconds - lastKeyframe;
    const tolerance = Math.max(
        durationSeconds * TRUNCATION_MIN_GAP_SHARE_KEYFRAMES,
        maxGop + TRUNCATION_MIN_GAP_S,
    );
    return { truncated: gap > tolerance, videoEndSeconds: lastKeyframe };
}

/** Re-exported so callers judge a container/stream gap with the same rule. */
export { isMaterialStreamLoss };

/**
 * Stream tails for a file whose scan already says truncated. Only then is the
 * extra seek-to-end ffprobe worth running; `null` otherwise.
 */
async function tailsIfTruncated(
    filePath: string,
    keyframes: number[],
    durationSeconds: number | null,
    lastPacketPts: number | null | undefined,
    signal?: AbortSignal,
): Promise<StreamTails | null> {
    if (!assessTruncation(keyframes, durationSeconds, lastPacketPts).truncated) return null;
    return probeStreamTails(filePath, signal ? { signal } : {});
}

/**
 * Detect file health issues by comparing the keyframe scan against the
 * container duration.
 *
 * `tails` (optional, from `probeStreamTails`) lets a truncation verdict be
 * checked against the streams themselves: a container that over-reports a
 * complete file is not flagged. Without it the keyframe/packet-PTS rule
 * alone decides, as before. Stays pure: the caller performs the probe.
 *
 * Cases detected:
 * - truncated_video: the video stream ends materially before the container
 *   duration (e.g. subtitle streams report 3h but video is only 16m) — see
 *   {@link assessTruncation} and {@link isMaterialStreamLoss}.
 * - no_keyframes: probe succeeded but returned zero keyframes
 *   (file may be corrupt or contain no video I-frames)
 *
 * Exported for unit testing.
 */
export function detectHealthIssues(
    keyframes: number[],
    durationSeconds: number | null,
    lastPacketPts?: number | null,
    tails?: StreamTails | null,
): FileHealthIssue[] {
    const issues: FileHealthIssue[] = [];
    const now = new Date().toISOString();

    if (keyframes.length === 0) {
        issues.push({ type: 'no_keyframes', detected_at: now });
        return issues;
    }

    const { truncated, videoEndSeconds } = assessTruncation(
        keyframes,
        durationSeconds,
        lastPacketPts,
    );
    if (
        truncated &&
        durationSeconds != null &&
        (!tails ||
            tails.success === false ||
            isMaterialStreamLoss({
                containerDuration: durationSeconds,
                videoEnd: tails.videoEnd ?? videoEndSeconds,
                audioEnd: tails.audioEnd,
                hasAudio: tails.hasAudio,
                endedPrematurely: tails.endedPrematurely,
            }))
    ) {
        issues.push({
            type: 'truncated_video',
            basis: tails?.endedPrematurely ? 'premature_eof' : 'duration_comparison',
            detected_at: now,
            expected_duration: Math.round(durationSeconds),
            actual_duration: Math.round(videoEndSeconds),
        });
    }

    return issues;
}

const FALSE_TRUNCATION_CHUNK = 500;

interface HealthReviewFile {
    id: string;
    keyframes: number[] | null;
    duration_seconds: number | null;
    health_issues: FileHealthIssue[] | null;
    file_path: string;
}

interface SelectedHealthEvidence {
    source: HealthSourceSnapshot;
    physical: string;
    inventory: TailInventory;
    reviewed: FileHealthIssue[];
    spentMs: number;
}
async function withHealthEvidenceBudget<T>(
    evidence: SelectedHealthEvidence,
    signal: AbortSignal | undefined,
    work: (bounded: AbortSignal) => Promise<T>,
): Promise<T> {
    const started = performance.now();
    const remaining = Math.max(1, Math.floor(90000 - evidence.spentMs));
    const deadline = AbortSignal.timeout(remaining);
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
        const result = await work(bounded);
        bounded.throwIfAborted();
        return result;
    } catch (error) {
        if (deadline.aborted && !signal?.aborted)
            throw new Error('inconclusive: audio evidence budget exceeded', { cause: error });
        throw error;
    } finally {
        evidence.spentMs += performance.now() - started;
    }
}

/** Revalidate only tail evidence; packet probes say nothing about decode gaps. */
async function revalidateFileTailIssues(
    sql: postgres.Sql,
    row: HealthReviewFile,
    signal?: AbortSignal,
    applyFreshProbe?: (tx: postgres.Sql) => Promise<void>,
    refreshObservations = false,
    selected?: SelectedHealthEvidence,
): Promise<{ cleared: boolean; inconclusive: boolean }> {
    signal?.throwIfAborted();
    const reviewed = (row.health_issues ?? []).filter(
        (issue) => issue.type === 'truncated_video' || issue.type === 'video_ends_early',
    );
    if (reviewed.length === 0 && !applyFreshProbe && !selected)
        return { cleared: false, inconclusive: false };
    const duration = row.duration_seconds;
    const hasUsableDuration = duration != null && Number.isFinite(duration) && duration > 0;
    const drop = new Set<FileHealthIssue['type']>();
    let inconclusive = false;
    const confirmed: FileHealthIssue[] = [];
    const tails =
        (reviewed.length > 0 && hasUsableDuration) || selected
            ? await probeStreamTails(row.file_path, { signal, timeoutMs: 30_000 })
            : undefined;
    let assessment: AudioTailAssessment | undefined;
    if (selected) {
        assessment = await withHealthEvidenceBudget(selected, signal, (bounded) =>
            measureAudioTail(
                row.file_path,
                tails?.videoEnd ?? null,
                tails?.audioEnd ?? null,
                { ...selected.source, physical: selected.physical },
                bounded,
                Math.max(1, Math.floor(55000 - selected.spentMs)),
            ),
        );
        assessment.ruleVersion = FILE_HEALTH_RULE_VERSION;
        assessment.reviewedIssues = selected.reviewed;
        assessment.packetTail = {
            success: tails?.success === true,
            endedPrematurely: tails?.endedPrematurely !== false,
            hasAudio: tails?.hasAudio === true,
            ...(tails?.videoEnd != null && Number.isFinite(tails.videoEnd) && tails.videoEnd >= 0
                ? { videoEnd: tails.videoEnd }
                : {}),
            ...(tails?.audioEnd != null && Number.isFinite(tails.audioEnd) && tails.audioEnd >= 0
                ? { audioEnd: tails.audioEnd }
                : {}),
        };
        if (
            assessment.inventorySignature &&
            assessment.inventorySignature !== selected.inventory.signature
        )
            throw new Error('inconclusive: physical inventory changed');
        if (tails?.success !== true || tails.endedPrematurely) {
            assessment.scope = 'inconclusive';
            assessment.observation = 'unknown';
            assessment.reasons.push('packet_tail_inconclusive');
        }
        await withHealthEvidenceBudget(selected, signal, async (bounded) => {
            const afterInventory = await readTailInventory(row.file_path, bounded);
            if (
                afterInventory.signature !== selected.inventory.signature ||
                (await healthPhysicalIdentity(row.file_path, bounded)) !== selected.physical
            )
                throw new Error('inconclusive: physical source changed');
        });
    }
    if (reviewed.length > 0) {
        if (!hasUsableDuration) {
            inconclusive = true;
        } else {
            signal?.throwIfAborted();
            const uncertainScope =
                selected && durationReviewTechnicalBlock(assessment) !== undefined;
            if (
                uncertainScope ||
                !tails ||
                tails.success !== true ||
                tails.videoEnd == null ||
                !Number.isFinite(tails.videoEnd) ||
                (tails.hasAudio && (tails.audioEnd == null || !Number.isFinite(tails.audioEnd)))
            ) {
                inconclusive = true;
            } else if (
                !isMaterialStreamLoss({
                    containerDuration: duration,
                    videoEnd: tails.videoEnd,
                    audioEnd: tails.audioEnd,
                    hasAudio: tails.hasAudio,
                    endedPrematurely: tails.endedPrematurely,
                })
            ) {
                drop.add('truncated_video');
                drop.add('video_ends_early');
            } else {
                if (refreshObservations)
                    for (const issue of reviewed)
                        confirmed.push({
                            ...issue,
                            type: issue.type,
                            basis: tails.endedPrematurely ? 'premature_eof' : 'duration_comparison',
                            detected_at: new Date().toISOString(),
                            expected_duration: Math.round(duration),
                            actual_duration: Math.round(tails.videoEnd),
                        });
            }
        }
    }
    const disproved = reviewed.filter((issue) => drop.has(issue.type));
    if (disproved.length === 0 && confirmed.length === 0 && !applyFreshProbe && !selected)
        return { cleared: false, inconclusive };
    const cleared = await withTx(sql, async (tx) => {
        signal?.throwIfAborted();
        if (applyFreshProbe || selected) {
            await lockFileHealthIssues(tx, row.id, signal);
            if (selected) {
                await assertHealthSourceCurrent(tx, row.id, selected.source, selected.reviewed);
                await withHealthEvidenceBudget(selected, signal, async (bounded) => {
                    if (
                        (await healthPhysicalIdentity(row.file_path, bounded)) !==
                            selected.physical ||
                        (await readTailInventory(row.file_path, bounded)).signature !==
                            selected.inventory.signature
                    )
                        throw new Error('inconclusive: physical source changed before commit');
                });
            }
            if (applyFreshProbe) await applyFreshProbe(tx);
            signal?.throwIfAborted();
        }
        if (assessment) {
            const currentSource = await getHealthSourceSnapshot(tx, row.id);
            if (!currentSource) throw new Error('inconclusive: source removed');
            assessment.source = { ...currentSource, physical: selected!.physical };
            await tx`UPDATE media_files SET health_tail_assessment = ${tx.json(assessment as unknown as postgres.JSONValue)} WHERE id = ${row.id}::uuid`;
        }
        await addRecheckedHealthIssues(tx, row.id, confirmed, signal, reviewed);
        const result = await removeReviewedHealthIssues(tx, row.id, disproved, signal);
        signal?.throwIfAborted();
        if (result && result.removed > 0 && result.remaining.length === 0) {
            await markFailureEventsResolved(tx, PLUGIN_ID, row.id);
        }
        signal?.throwIfAborted();
        if (selected) {
            await withHealthEvidenceBudget(selected, signal, async (bounded) => {
                if ((await healthPhysicalIdentity(row.file_path, bounded)) !== selected.physical)
                    throw new Error('inconclusive: physical source changed during commit');
            });
        }
        return (result?.removed ?? 0) > 0;
    });
    return { cleared, inconclusive };
}

/** Legacy tail-rule helper; scheduled work uses generation-bound selected-file checks below. */
export async function clearFalseTruncationIssues(
    sql: postgres.Sql<Record<string, never>>,
    signal?: AbortSignal,
): Promise<number> {
    let cleared = 0;
    let afterId = '00000000-0000-0000-0000-000000000000';
    for (;;) {
        if (signal?.aborted) break;
        const rows = await sql<
            {
                id: string;
                keyframes: number[] | null;
                duration_seconds: number | null;
                health_issues: FileHealthIssue[];
                file_path: string;
            }[]
        >`
            SELECT id, keyframes, duration_seconds, health_issues, file_path
            FROM media_files
            WHERE (health_issues @> '[{"type":"truncated_video"}]'::jsonb
                   OR health_issues @> '[{"type":"video_ends_early"}]'::jsonb)
              AND id > ${afterId}::uuid
            ORDER BY id
            LIMIT ${FALSE_TRUNCATION_CHUNK}
        `;
        if (rows.length === 0) break;
        afterId = rows[rows.length - 1].id;
        for (const row of rows) {
            if (signal?.aborted) break;
            const result = await revalidateFileTailIssues(sql, row, signal);
            if (result.cleared) cleared++;
        }
        if (rows.length < FALSE_TRUNCATION_CHUNK) break;
    }
    return cleared;
}

/**
 * Wipe all probe-derived state from media_files in WIPE_BATCH_SIZE-row
 * transactions. Clears probe columns and deletes associated media_streams in
 * the same transaction so the next drain re-ingests from scratch.
 *
 * Preserves `file_size_bytes` and `file_hash_head` — those belong to the
 * scanner (updateFileStat) and are not probe output.
 *
 * Uses `drainWipe` for the batching loop. Each `wipeBatch` call runs a single
 * transaction that DELETEs from media_streams and NULLs the probe columns on
 * media_files — atomic by construction, so an abort mid-batch cannot leave
 * half-wiped rows.
 */
async function wipeProbeData(
    sql: postgres.Sql<Record<string, never>>,
    logger: DrainBacklogLogger,
    abortSignal: AbortSignal,
): Promise<void> {
    await drainWipe({
        abortSignal,
        batchSize: WIPE_BATCH_SIZE,
        fetchBatch: async (limit) => {
            // Pick up to `limit` files that still carry probe state. No row
            // locking here — the atomic transaction in `wipeBatch` either
            // commits all changes or none, so a racing writer on the same
            // row simply causes one of the two to retry without tearing
            // state apart.
            const rows = await sql<{ id: string }[]>`
                SELECT mf.id
                FROM media_files mf
                WHERE mf.probed_at IS NOT NULL
                   OR mf.keyframes IS NOT NULL
                   OR mf.container_format IS NOT NULL
                   OR mf.duration_seconds IS NOT NULL
                   OR mf.total_bitrate IS NOT NULL
                   OR mf.health_issues IS NOT NULL
                   OR EXISTS (
                       SELECT 1 FROM media_streams ms WHERE ms.file_id = mf.id
                   )
                LIMIT ${limit}
            `;
            return rows.map((r) => r.id);
        },
        wipeBatch: async (ids) => {
            return await withTx(sql, async (txRaw) => {
                const tx = txRaw as unknown as postgres.Sql<Record<string, never>>;
                await tx`
                    DELETE FROM media_streams WHERE file_id = ANY(${ids})
                `;
                await tx`
                    UPDATE media_files
                    SET probed_at        = NULL,
                        keyframes        = NULL,
                        container_format = NULL,
                        duration_seconds = NULL,
                        total_bitrate    = NULL,
                        health_issues    = NULL,
                        updated_at       = NOW()
                    WHERE id = ANY(${ids})
                `;
                // M6: reset the linked probe coverage rows to `pending` in the SAME
                // tx as the probed_at wipe. Without this, a wiped file's stage row
                // stays `completed` while `probed_at IS NULL` — divergent state, and
                // if a concurrent catchup probe just wrote `completed`+`probed_at`
                // for an id this batch also returned, the wipe nulls probed_at and
                // leaves the false `completed` behind (the wiper-vs-prober race the
                // unlocked fetch can't prevent). Resetting the coverage atomically
                // makes the two views consistent regardless of the race, and is the
                // correct post-wipe state anyway (the file must be re-probed). Skip
                // `running` rows so an in-flight probe isn't disturbed.
                await tx`
                    UPDATE media_item_stage_state s
                       SET status = 'pending',
                           attempt = 0,
                           declines = 0,
                           declines_since = NULL,
                           last_error = NULL,
                           skipped_reason = NULL,
                           started_at = NULL,
                           completed_at = NULL,
                           next_eligible_at = NULL,
                           updated_at = now()
                      FROM media_file_items mfi
                     WHERE mfi.file_id = ANY(${ids})
                       AND s.media_item_id = mfi.media_item_id
                       AND s.stage_id IN ('media-probe-a', 'media-probe-b')
                       AND s.status <> 'running'
                `;
                return ids.length;
            });
        },
        logger,
        label: 'Probe data',
    });
}

/**
 * Run one bounded reconciliation pass for a probe stage, flipping already-done
 * `media_item_stage_state` rows to `completed` in RECONCILE_CHUNK_SIZE-row
 * chunks until the backlog drains (or the abort signal fires / the chunk cap is
 * hit). Yields a real tick between chunks so BullMQ lock-renewal and the stall
 * watchdog timers fire, and the lock window per statement stays bounded.
 *
 * Preserves the exact final DB state of the original single-shot UPDATE: every
 * row matching the predicate ends up `completed` — the CTE just processes at
 * most RECONCILE_CHUNK_SIZE `ctid`s per statement, and updated rows stop
 * matching so the next chunk fetches the next batch.
 *
 * `runChunk` returns the number of rows updated by that chunk; the loop stops
 * once a chunk returns fewer than a full chunk (backlog drained).
 *
 * Returns `{ total, capped }`. `capped` is true when the loop exhausted
 * MAX_RECONCILE_CHUNKS while the final chunk was still full — i.e. backlog
 * likely remains un-reconciled and the caller should surface it, so a hit cap is
 * not silently indistinguishable from a clean drain.
 */
async function drainReconcileChunks(
    signal: AbortSignal,
    runChunk: () => Promise<number>,
): Promise<{ total: number; capped: boolean }> {
    let total = 0;
    let capped = false;
    for (let i = 0; i < MAX_RECONCILE_CHUNKS; i++) {
        if (signal.aborted) break;
        const n = await runChunk();
        total += n;
        // Short-circuit the instant a chunk comes back empty — the backlog
        // is drained, so recognize that immediately rather than falling
        // through toward the tick delay below first. Equivalent to the
        // generic partial-chunk check right after (0 < RECONCILE_CHUNK_SIZE
        // always holds) but stated explicitly for the empty-chunk case.
        if (n === 0) break;
        if (n < RECONCILE_CHUNK_SIZE) break;
        if (i === MAX_RECONCILE_CHUNKS - 1) {
            // Final permitted iteration still returned a full chunk → more rows
            // almost certainly match the predicate but we've hit the per-run
            // chunk cap. Flag it so the caller can warn instead of the loop
            // ending silently (looking identical to a fully-drained backlog).
            capped = true;
            break;
        }
        // Real tick (not a microtask) so setInterval-based lock renewal /
        // heartbeat timers get a chance to fire between statements — same
        // rationale as the Phase 0 chunked backfill.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return { total, capped };
}

/**
 * Reconciliation pass — drains stage_state rows whose underlying probe work is
 * already done (the historical drift where the handler updated media_files but
 * not the per-item coverage table). Idempotent and the cheapest defense against
 * future content-invalidation paths re-introducing drift.
 *
 * Chunked (see {@link RECONCILE_CHUNK_SIZE}) so the pre-heartbeat UPDATEs can't
 * hold locks long enough to look like a stall on a large library. Returns the
 * per-stage reconciled counts for logging.
 */
export async function reconcileProbeStageState(
    sql: postgres.Sql<Record<string, never>>,
    signal: AbortSignal,
): Promise<{ reconciledA: number; reconciledB: number; capped: boolean }> {
    const { total: reconciledA, capped: cappedA } = await drainReconcileChunks(signal, async () => {
        const rows = await sql<{ count: number }[]>`
            WITH candidates AS (
                SELECT s.ctid
                  FROM media_item_stage_state s
                 WHERE s.stage_id = 'media-probe-a'
                   -- Include skipped_permanent mirror-lies (A7): a row
                   -- wrongly disposed before probe whose file IS now probed
                   -- (proven by the EXISTS guards below) should reconcile to
                   -- completed, not keep lying as skipped. Reason-guarded so
                   -- a genuinely-permanent skip is never clobbered.
                   AND (
                       s.status IN ('pending', 'failed_transient')
                       OR (
                           s.status = 'skipped_permanent'
                           AND s.skipped_reason IN (
                               'ineligible',
                               'predicate-false',
                               'predicate-false-on-invalidation',
                               'no-file-linked'
                           )
                       )
                   )
                   -- At least one linked file must exist AND be non-missing.
                   -- Without the inner "NOT mf.is_missing" guard, an item
                   -- whose only file was sentineled is_missing=true would
                   -- clear the NOT EXISTS below (which already filters
                   -- is_missing) and get marked completed despite never
                   -- being probed.
                   AND EXISTS (
                       SELECT 1 FROM media_file_items mfi
                        JOIN media_files mf ON mf.id = mfi.file_id
                        WHERE mfi.media_item_id = s.media_item_id
                          AND NOT mf.is_missing
                   )
                   AND NOT EXISTS (
                       SELECT 1 FROM media_file_items mfi
                        JOIN media_files mf ON mf.id = mfi.file_id
                        WHERE mfi.media_item_id = s.media_item_id
                          AND mf.probed_at IS NULL
                          AND NOT mf.is_missing
                   )
                 LIMIT ${RECONCILE_CHUNK_SIZE}
            ),
            done AS (
                UPDATE media_item_stage_state s
                   SET status = 'completed',
                       completed_at = now(),
                       last_error = NULL,
                       next_eligible_at = NULL,
                       declines = 0,
                       declines_since = NULL,
                       updated_at = now()
                 WHERE s.ctid IN (SELECT ctid FROM candidates)
                 RETURNING 1
            )
            SELECT COUNT(*)::int AS count FROM done
        `;
        return rows[0]?.count ?? 0;
    });

    const { total: reconciledB, capped: cappedB } = await drainReconcileChunks(signal, async () => {
        const rows = await sql<{ count: number }[]>`
            WITH candidates AS (
                SELECT s.ctid
                  FROM media_item_stage_state s
                 WHERE s.stage_id = 'media-probe-b'
                   -- Include skipped_permanent mirror-lies (A7), reason-guarded
                   -- (same rationale as media-probe-a above).
                   AND (
                       s.status IN ('pending', 'failed_transient')
                       OR (
                           s.status = 'skipped_permanent'
                           AND s.skipped_reason IN (
                               'ineligible',
                               'predicate-false',
                               'predicate-false-on-invalidation',
                               'no-file-linked'
                           )
                       )
                   )
                   -- At least one NON-MISSING video file must exist —
                   -- same rationale as the Phase A reconciliation guard.
                   AND EXISTS (
                       SELECT 1 FROM media_file_items mfi
                        JOIN media_files mf ON mf.id = mfi.file_id
                        WHERE mfi.media_item_id = s.media_item_id
                          AND NOT mf.is_missing
                          AND EXISTS (
                              SELECT 1 FROM media_streams ms
                               WHERE ms.file_id = mf.id AND ms.stream_type = 'video'
                          )
                   )
                   AND NOT EXISTS (
                       SELECT 1 FROM media_file_items mfi
                        JOIN media_files mf ON mf.id = mfi.file_id
                        WHERE mfi.media_item_id = s.media_item_id
                          AND mf.keyframes IS NULL
                          AND NOT mf.is_missing
                          AND EXISTS (
                              SELECT 1 FROM media_streams ms
                               WHERE ms.file_id = mf.id AND ms.stream_type = 'video'
                          )
                   )
                 LIMIT ${RECONCILE_CHUNK_SIZE}
            ),
            done AS (
                UPDATE media_item_stage_state s
                   SET status = 'completed',
                       completed_at = now(),
                       last_error = NULL,
                       next_eligible_at = NULL,
                       declines = 0,
                       declines_since = NULL,
                       updated_at = now()
                 WHERE s.ctid IN (SELECT ctid FROM candidates)
                 RETURNING 1
            )
            SELECT COUNT(*)::int AS count FROM done
        `;
        return rows[0]?.count ?? 0;
    });

    return { reconciledA, reconciledB, capped: cappedA || cappedB };
}

/**
 * Build the tail suffix for the media-probe summary message. When both
 * phases' stop reasons agree, defer to `formatStopReason(primary)`. When
 * they differ, append per-phase hints so the admin sees why each phase
 * ended (e.g. "Phase A: no-progress; Phase B: drained") instead of the
 * winner-take-all suffix losing the other phase's context.
 *
 * A phase that didn't run (skipped catchup, budget exhausted before Phase B,
 * etc.) is omitted entirely.
 */
function buildMediaProbeStopSuffix(
    primary: DrainStopReason,
    phaseA: DrainStopReason | undefined,
    phaseB: DrainStopReason | undefined,
): string {
    const a = phaseA ?? 'drained';
    const b = phaseB ?? 'drained';
    // If only one phase ran, or both agree, the default formatter's single
    // suffix captures the full story.
    if (phaseA === undefined || phaseB === undefined || a === b) {
        return formatStopReason(primary);
    }
    // Phases disagree — surface both. Use the primary's suffix as the
    // headline and append a parenthetical breakdown so admins don't have
    // to cross-reference logs to see what each phase did.
    const base = formatStopReason(primary);
    const breakdown = ` [Phase A: ${a}; Phase B: ${b}]`;
    return base + breakdown;
}

// ============================================================================
// Phase processors
// ============================================================================

interface PhaseAOutcome {
    probed: number;
    errors: number;
    missing: number;
}

/**
 * Record a probe failure against every media_item linked to a file (bug M1).
 * media-probe is a multi-stage task, so the runner falls through to bare
 * `runExecute` and never invokes `wrapExecute` — the per-item stage rows get no
 * attempt accounting, no `last_error`, and no backoff. Without this, a file whose
 * probe perpetually fails (corrupt container, unsupported codec) leaves its rows
 * `pending` with `attempt=0` and is re-enqueued by the stage-sweep every tick,
 * invisibly. This writes the bookkeeping `wrapExecute` would have, status-guarded
 * (`recordStageAttemptFailure` only touches non-terminal rows). Best-effort: a
 * write failure must never break the drain — the row simply stays as-is and
 * retries next cycle (mirrors music-popularity's `recordTransient`).
 */
async function recordProbeFailure(
    sql: postgres.Sql,
    file: { id: string; media_item_ids: string[] },
    stageId: 'media-probe-a' | 'media-probe-b',
    reason: string,
    logger: DrainBacklogLogger,
): Promise<void> {
    // `?? []` so a malformed/partial file row can't throw a SECONDARY error out
    // of a catch block and mask the original probe failure.
    for (const mediaItemId of file.media_item_ids ?? []) {
        try {
            await recordStageAttemptFailure(sql, {
                mediaItemId,
                stageId,
                error: { message: reason.slice(0, 500), code: 'probe_failed', retryable: true },
                backoffMs: PROBE_FAILURE_BACKOFF_MS,
                // Give up after N attempts so an unfixable file (e.g. a keyframe
                // scan that always times out) parks at failed_permanent instead
                // of looping forever (was observed at attempt 637).
                maxAttempts: PROBE_FAILURE_MAX_ATTEMPTS,
            });
        } catch (err) {
            logger.debug('media-probe: could not record attempt failure', {
                mediaItemId,
                stageId,
                err: err instanceof Error ? err.message : String(err),
            });
        }
    }
}

/**
 * Write one successful probe result for `fileId`, and mark the file probed for
 * every media item in `mediaItemIds`: file metadata, runtime propagation, the
 * streams with their language and quality, then the media-probe-a coverage row
 * and `file.probed` per item. The caller runs it inside its transaction, so the
 * business write and the coverage markers commit together (TASK-H22). Phase A
 * and the admin retry both write through here, so they cannot drift apart.
 */
export async function writeProbeResult(
    tx: postgres.Sql,
    fileId: string,
    probe: FfprobeMediaProbeResult,
    mediaItemIds: readonly string[],
    refreshLinkedItems = true,
): Promise<void> {
    await updateProbeData(tx, {
        fileId,
        containerFormat: probe.container,
        durationSeconds: probe.duration,
        totalBitrate: probe.formatBitrate ?? probe.video?.bitrate ?? null,
        fileSizeBytes: probe.fileSize,
    });

    // A combined file (one file, several episode rows) needs its episode windows
    // once its duration is known. The scanner links the rows before any probe has
    // run, and chapter sync only recomputes when chapters exist, so a file without
    // chapters would otherwise never get windows.
    if (refreshLinkedItems && mediaItemIds.length > 1) {
        await refreshSegmentsForFile(tx, fileId);
    }

    // Self-heal: propagate duration to parent media_items for movies that lack
    // runtime_seconds. Episodes are excluded — their runtime comes from
    // authoritative metadata providers and a single file rarely maps 1:1.
    if (refreshLinkedItems && probe.duration && probe.duration > 0) {
        await tx`
            UPDATE media_items mi
            SET runtime_seconds = ROUND(${probe.duration})::int
            FROM media_file_items mfi
            WHERE mfi.file_id = ${fileId}::uuid
              AND mfi.media_item_id = mi.id
              AND mi.media_type = 'movie'
              AND COALESCE(mi.runtime_seconds, 0) = 0
        `;
    }

    const streamRows = mapFFprobeToDbRows(fileId, probe);
    if (streamRows.length > 0) {
        await replaceStreamsForFile(tx, fileId, streamRows);
        if (refreshLinkedItems) {
            await refreshLanguagesForFile(tx, fileId);
            await refreshQualityForFile(tx, fileId);
        }
    }

    // Emit file.probed in the same tx so probe-gated stages (trickplay/intro/
    // music/media-probe-b) re-evaluate their eligibility per item the instant
    // streams exist. has_video/has_audio derive from the JUST-written streams.
    const probedHasVideo = streamRows.some((r) => r.stream_type === 'video');
    const probedHasAudio = streamRows.some((r) => r.stream_type === 'audio');
    for (const mediaItemId of refreshLinkedItems ? mediaItemIds : []) {
        await upsertCompletedRow(tx, {
            mediaItemId,
            stageId: 'media-probe-a',
            processingVersion: PROCESSING_VERSION,
        });
        await emitPipelineEvent(tx, 'file.probed', mediaItemId, {
            event: 'file.probed',
            mediaId: mediaItemId,
            fileId,
            hasVideo: probedHasVideo,
            hasAudio: probedHasAudio,
        });
    }
}

async function processPhaseASlice(
    sql: postgres.Sql,
    logger: DrainBacklogLogger,
    abortSignal: AbortSignal,
    files: UnprobedFileRow[],
): Promise<PhaseAOutcome> {
    let probed = 0;
    let errors = 0;
    let missing = 0;

    // Q2: pre-compute which linked media_items have >1 file, so single-file
    // items (nearly all of a fresh import) skip promoteHighestQualityVersion's
    // advisory-lock + ranking SELECT entirely (it is a no-op for them, just an
    // expensive one).
    const sliceItemIds = [...new Set(files.flatMap((f) => f.media_item_ids))];
    const multiFileItemIds = await loadMultiFileItemIds(sql, sliceItemIds);

    // S1: probe files concurrently within the slice. Each file's work is
    // independent (its own write transaction); counters increment after an
    // `await` and JS is single-threaded, so the accumulation is race-free.
    const sem = new AsyncSemaphore(MEDIA_PROBE_CONCURRENCY);

    const processOne = async (file: UnprobedFileRow): Promise<void> => {
        if (abortSignal.aborted) return;

        try {
            // Q4: probe FIRST. ffprobe opens the file itself, so a presence
            // `stat` is only needed to CLASSIFY a failure (missing vs transient
            // vs genuine error). Probing first saves one NFS round-trip on every
            // successful file — the common case on a healthy import. Pass the
            // per-slice signal so a soft-budget abort kills the ffprobe child
            // mid-scan instead of waiting for the 15s built-in timeout.
            //
            // The library scanner probed a new file seconds ago to decide
            // whether to link it; reuse that result while the row still
            // describes the probed bytes (scan-probe-cache.ts) instead of
            // running a second full ffprobe. A miss probes as before.
            const probe =
                takeScanProbe(file.file_path, {
                    mtime: file.file_mtime,
                    size: file.file_size_bytes,
                }) ??
                (await probeMediaFile(file.file_path, undefined, {
                    signal: abortSignal,
                }));
            if (!probe.success) {
                // If the signal fired mid-probe, the failure is expected — skip.
                if (abortSignal.aborted) return;
                // Classify the failure with a stat (lazy — failure path only).
                const presence = await assessFilePresence(file.file_path, abortSignal);
                if (presence === 'transient') {
                    // Transient-unmount guard: parent directory is also absent,
                    // so the whole mount point is likely offline. Leave the row
                    // eligible for the next drain — otherwise a 30s NFS hiccup
                    // poisons every file in the affected tree until the scanner
                    // reaps them.
                    logger.debug(
                        'File and parent dir absent (probe) — likely transient mount outage',
                        {
                            fileId: file.id,
                            path: file.file_path.split('/').slice(-2).join('/'),
                        },
                    );
                    return;
                }
                if (presence === 'missing') {
                    // Sentinel: mark the file so it is excluded from future
                    // fetches (getUnprobedFiles/getFilesWithoutKeyframes both
                    // filter is_missing). Recovery is automatic: a re-scan resets
                    // is_missing=false and nulls probed_at so it re-enters.
                    const marked = await markFileMissing(
                        sql,
                        file.id,
                        async () =>
                            (await assessFilePresence(file.file_path, abortSignal)) === 'missing',
                        file.file_version,
                    );
                    if (marked === false) return;
                    logger.info('File not found on disk — sentineled as missing', {
                        fileId: file.id,
                        path: file.file_path.split('/').slice(-2).join('/'),
                    });
                    missing++;
                    return;
                }
                // Present on disk but ffprobe failed → a genuine probe error.
                logger.warn('FFprobe failed', {
                    fileId: file.id,
                    error: probe.error,
                });
                errors++;
                await recordProbeFailure(
                    sql,
                    file,
                    'media-probe-a',
                    `ffprobe failed: ${probe.error ?? 'unknown'}`,
                    logger,
                );
                return;
            }

            // One transaction per file: updateProbeData + parent-movie
            // runtime propagation + stream replace + stage_state markers.
            // Without it, a crash between updates leaves media_files.probed_at
            // set but media_streams empty — which collides with the "no
            // streams" branch of getUnprobedFiles and creates a silent
            // re-probe loop. The `media-probe-a` stage markers are written in
            // the SAME transaction (TASK-H22): committing the probe data but
            // crashing before the marker would either leave the stage row
            // `pending` forever (phantom backlog) or, conversely, mark the
            // stage complete without the underlying probe data — both are
            // partial-commit hazards. Atomicity makes the business write and
            // the coverage marker indivisible.
            await withTx(sql, async (txRaw) => {
                const tx = txRaw as unknown as postgres.Sql;
                await writeProbeResult(tx, file.id, probe, file.media_item_ids);
            });

            // After stream metadata is written, re-evaluate which version of
            // each linked media_item is highest quality and promote it to
            // is_default=true. This fixes "first-arrival-wins" scenarios where
            // a 720p file arrived first and a 1080p sibling was added later —
            // the 1080p file is now promoted so audio-language badges and the
            // episode-detail panel resolve to the better file. No-op when the
            // item has only one file.
            //
            // CRITICAL ordering: this loop must remain AFTER the `await
            // withTx(...)` above, inside the same outer try block. If the
            // probe withTx throws (commit conflict, constraint violation,
            // connection drop), control jumps directly to the outer
            // catch (line ~1151) and we never reach this loop — promotion
            // would otherwise compute ranking from stale stream data
            // because replaceStreamsForFile rolled back. Do NOT lift this
            // out of the try block or wrap withTx in its own try/catch.
            for (const mediaItemId of file.media_item_ids) {
                // Q2: only items with more than one file can have a different
                // highest-quality version to promote — skip the rest (the call
                // is a no-op for them, but only after taking an advisory lock).
                if (!multiFileItemIds.has(mediaItemId)) continue;
                try {
                    const result = await promoteHighestQualityVersion(sql, mediaItemId);
                    if (result.promoted) {
                        logger.info('Promoted higher-quality version to default', {
                            fileId: file.id,
                            mediaItemId,
                            chosenFileId: result.chosenFileId,
                            oldFileId: result.oldFileId,
                        });
                        if (result.oldFileId) {
                            // Fire-and-forget: clean up the demoted file's
                            // per-file artifacts (streams, chapters, trickplay
                            // params, disk sprites) and invalidate content-bound
                            // stages so they re-run against the new default.
                            MediaLifecycleService.afterDefaultFileChanged(
                                sql,
                                mediaItemId,
                                result.oldFileId,
                                result.chosenFileId!,
                            ).catch((err) => {
                                logger.warn('afterDefaultFileChanged cleanup failed (non-fatal)', {
                                    mediaItemId,
                                    oldFileId: result.oldFileId,
                                    error: err instanceof Error ? err.message : String(err),
                                });
                            });
                        }
                    }
                } catch (promoteErr) {
                    logger.warn('Quality-promotion failed (non-fatal)', {
                        fileId: file.id,
                        mediaItemId,
                        error:
                            promoteErr instanceof Error ? promoteErr.message : String(promoteErr),
                    });
                }
            }

            probed++;

            // NOTE: the `media-probe-a` stage markers are now written inside
            // the probe transaction above (TASK-H22) so the business write and
            // the coverage marker commit atomically.
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn('Error probing file', {
                fileId: file.id,
                error: message,
            });
            errors++;
            await recordProbeFailure(sql, file, 'media-probe-a', message, logger);
        }
    };

    // S1: run the slice through a bounded pool — Promise.all over withPermit
    // starts every file but only MEDIA_PROBE_CONCURRENCY run at once. An abort
    // makes not-yet-started files return immediately at the top of processOne.
    await Promise.all(files.map((file) => sem.withPermit(() => processOne(file))));

    return { probed, errors, missing };
}

interface PhaseBOutcome {
    keyframed: number;
    errors: number;
    missing: number;
}

export async function processPhaseBSlice(
    sql: postgres.Sql,
    logger: DrainBacklogLogger,
    abortSignal: AbortSignal,
    files: KeyframeFileRow[],
    jobId: string,
): Promise<PhaseBOutcome> {
    let keyframed = 0;
    let errors = 0;
    let missing = 0;

    for (const file of files) {
        if (abortSignal.aborted) break;

        const presence = await assessFilePresence(file.file_path, abortSignal);
        if (presence === 'transient') {
            logger.debug('File and parent dir absent (keyframe) — likely transient mount outage', {
                fileId: file.id,
                path: file.file_path.split('/').slice(-2).join('/'),
            });
            continue;
        }
        if (presence === 'missing') {
            // Revalidate absence under the file/availability locks: a scan may
            // have restored this file since the observation above.
            const marked = await markFileMissing(
                sql,
                file.id,
                async () => (await assessFilePresence(file.file_path, abortSignal)) === 'missing',
                file.file_version,
            );
            if (marked === false) continue;
            logger.info('File not found on disk (keyframe) — sentineled as missing', {
                fileId: file.id,
                path: file.file_path.split('/').slice(-2).join('/'),
            });
            missing++;
            continue;
        }

        try {
            const healthBefore = await getFileHealthSnapshot(sql, file.id);
            // Thread the abort signal into the keyframe probe — a single
            // 2-hour movie can otherwise hold the worker slot for 90s
            // after a stop click while ffprobe finishes its packet scan.
            const result = await probeKeyframes(file.file_path, {
                signal: abortSignal,
                timeoutMs: keyframeTimeoutForSize(file.file_size_bytes),
            });
            if (!result.success) {
                // If the signal fired mid-probe, the failure is expected — don't
                // count it as an error; just let the outer loop break on next iteration.
                if (abortSignal.aborted) break;
                logger.warn('Keyframe probe failed', {
                    fileId: file.id,
                    error: result.error,
                });
                errors++;
                await recordProbeFailure(
                    sql,
                    file,
                    'media-probe-b',
                    `keyframe probe failed: ${result.error ?? 'unknown'}`,
                    logger,
                );
                continue;
            }

            const issues = detectHealthIssues(
                result.keyframes,
                file.duration_seconds,
                result.lastPacketPts,
                await tailsIfTruncated(
                    file.file_path,
                    result.keyframes,
                    file.duration_seconds,
                    result.lastPacketPts,
                    abortSignal,
                ),
            );

            // Atomic keyframes + health_issues + failure-event + stage marker
            // write. All updates run in the same transaction so a process
            // crash between commits cannot leave an orphan marker without an
            // event row, cannot leave keyframes written but health_issues
            // stale, and cannot leave the `media-probe-b` stage row `pending`
            // forever while the keyframes are already committed (TASK-H22
            // partial-commit hazard). Without the marker, stage-sweep keeps
            // enqueueing the global run and each run finds 0 candidates
            // because getFilesWithoutKeyframes already filters
            // `keyframes IS NULL`.
            await revalidateFileTailIssues(
                sql,
                {
                    id: file.id,
                    file_path: file.file_path,
                    duration_seconds: file.duration_seconds,
                    keyframes: result.keyframes,
                    health_issues: healthBefore?.health_issues ?? [],
                },
                abortSignal,
                async (tx) => {
                    await updateKeyframes(tx, file.id, result.keyframes);
                    await addRecheckedHealthIssues(
                        tx,
                        file.id,
                        issues,
                        abortSignal,
                        healthBefore?.health_issues ?? [],
                        jobId,
                    );
                    if (result.keyframes.length > 0)
                        await removeReviewedHealthIssues(
                            tx,
                            file.id,
                            (healthBefore?.health_issues ?? []).filter(
                                (issue) => issue.type === 'no_keyframes',
                            ),
                            abortSignal,
                        );
                    const current = await getFileHealthSnapshot(tx, file.id);
                    if (issues.length > 0) {
                        await recordFailure(tx, PLUGIN_ID, file.id, issues[0].type, jobId ?? null);
                    } else if (current && !current.health_issues?.length) {
                        await markFailureEventsResolved(tx, PLUGIN_ID, file.id);
                    }
                    for (const mediaItemId of file.media_item_ids) {
                        await upsertCompletedRow(tx, {
                            mediaItemId,
                            stageId: 'media-probe-b',
                            processingVersion: PROCESSING_VERSION,
                        });
                    }
                },
                true,
            );

            if (issues.length > 0) {
                logger.warn('File health issues detected', {
                    fileId: file.id,
                    path: file.file_path.split('/').slice(-2).join('/'),
                    issues: issues.map((i) => i.type),
                });
            }

            keyframed++;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn('Error probing keyframes', {
                fileId: file.id,
                error: message,
            });
            errors++;
            await recordProbeFailure(sql, file, 'media-probe-b', message, logger);
        }
    }

    return { keyframed, errors, missing };
}

// ============================================================================
// retryItem
// ============================================================================

/**
 * Admin-initiated retry for a single media_files row. Two-phase dispatch:
 *   - No probed_at → run Phase A (stream probe) first, then Phase B if the
 *     file has a video stream.
 *   - probed_at set + has_video + no keyframes → run Phase B only.
 *   - Already healthy → return success with no work (idempotent).
 *
 * Outcome derived from post-run health_issues column: empty/null → success;
 * non-empty → surface first issue's `type` as the reason.
 */
async function retryOneFile(
    ctx: TaskContext,
    itemId: string,
    preserveEvidence = false,
): Promise<RetryItemResult> {
    if (!UUID_RE.test(itemId)) {
        return { success: false, reason: 'Invalid file id (expected UUID)' };
    }

    const sql = ctx.sql as unknown as postgres.Sql;
    const logger = ctx.logger;
    // Capture content and stored inventory before the initial file read, so
    // a replacement between that read and physical probing cannot bind old
    // bytes to a newer database source generation.
    const initialSource = preserveEvidence ? await getHealthSourceSnapshot(sql, itemId) : undefined;

    // Include prior `audit_run_job_id` so a retry that still flags health
    // issues preserves the Phase D "Run #X →" link to the original failing
    // run rather than overwriting it with a synthetic retry jobId.
    const [file] = await sql<
        Array<{
            id: string;
            file_path: string;
            probed_at: Date | null;
            duration_seconds: number | null;
            file_size_bytes: number | null;
            has_keyframes: boolean;
            has_video: boolean;
            prior_audit_job_id: string | null;
        }>
    >`
        SELECT
            mf.id,
            mf.file_path,
            mf.probed_at,
            mf.duration_seconds,
            mf.file_size_bytes,
            (mf.keyframes IS NOT NULL) AS has_keyframes,
            mf.audit_run_job_id AS prior_audit_job_id,
            EXISTS (
                SELECT 1 FROM media_streams ms
                WHERE ms.file_id = mf.id AND ms.stream_type = 'video'
            ) AS has_video
        FROM media_files mf
        WHERE mf.id = ${itemId}::uuid
        LIMIT 1
    `;
    if (!file) {
        return { success: false, reason: 'File not found' };
    }
    const auditJobId = file.prior_audit_job_id ?? undefined;
    const before = preserveEvidence ? await getFileHealthSnapshot(sql, itemId) : undefined;
    const [observation] = preserveEvidence
        ? await sql<{ at: Date }[]>`SELECT clock_timestamp() AS at`
        : [];

    let selectedEvidence: SelectedHealthEvidence | undefined;
    let freshProbe: FfprobeMediaProbeResult | undefined;
    let freshKeyframes: { keyframes: number[]; issues: FileHealthIssue[] } | undefined;

    try {
        ctx.signal.throwIfAborted();
        // assessFilePresence performs filesystem I/O and can throw — keep
        // it inside the try so an fs error surfaces as a clean retry
        // failure instead of an uncaught rejection at the endpoint.
        const presence = await assessFilePresence(file.file_path, ctx.signal);
        if (presence === 'transient') {
            return {
                success: false,
                reason: 'File or parent directory transiently missing',
            };
        }
        if (presence === 'missing') {
            return { success: false, reason: 'File not found on disk' };
        }

        if (preserveEvidence) {
            const source = await getHealthSourceSnapshot(sql, file.id);
            if (
                !source ||
                !initialSource ||
                source.generation !== initialSource.generation ||
                source.streams !== initialSource.streams
            )
                throw new Error('inconclusive: source changed before probing');
            selectedEvidence = {
                source,
                physical: '',
                inventory: { streams: [], signature: '' },
                reviewed: before?.health_issues ?? [],
                spentMs: 0,
            };
            const evidence = selectedEvidence;
            await withHealthEvidenceBudget(evidence, ctx.signal, async (bounded) => {
                evidence.physical = await healthPhysicalIdentity(file.file_path, bounded);
                evidence.inventory = await readTailInventory(file.file_path, bounded);
            });
        }

        // ── Phase A (stream probe) — only when never probed ──
        if (!file.probed_at) {
            const probe = await probeMediaFile(file.file_path, undefined, {
                signal: ctx.signal,
            });
            if (!probe.success) {
                return {
                    success: false,
                    reason: (probe.error ?? 'probe failed').slice(0, 200),
                };
            }
            if (preserveEvidence) {
                // Keep file rows unlocked while the slow keyframe/tail probes
                // run. All selected-file writes commit together afterwards.
                freshProbe = probe;
                file.duration_seconds = probe.duration ?? null;
                file.has_video = probe.video != null;
                file.has_keyframes = false;
            } else {
                await withTx(sql, async (txRaw) => {
                    const tx = txRaw as unknown as postgres.Sql;
                    const linkedA = await tx<{ media_item_id: string }[]>`
                    SELECT media_item_id FROM media_file_items WHERE file_id = ${file.id}::uuid
                `;
                    ctx.signal.throwIfAborted();
                    await writeProbeResult(
                        tx,
                        file.id,
                        probe,
                        linkedA.map((row) => row.media_item_id),
                        !preserveEvidence,
                    );
                    ctx.signal.throwIfAborted();
                });
                // Re-read so Phase B sees the fresh probe metadata.
                const [refreshed] = await sql<
                    Array<{
                        duration_seconds: number | null;
                        has_video: boolean;
                    }>
                >`
                SELECT mf.duration_seconds,
                       EXISTS (
                           SELECT 1 FROM media_streams ms
                           WHERE ms.file_id = mf.id AND ms.stream_type = 'video'
                       ) AS has_video
                FROM media_files mf
                WHERE mf.id = ${itemId}::uuid
                LIMIT 1
            `;
                file.duration_seconds = refreshed?.duration_seconds ?? null;
                file.has_video = refreshed?.has_video ?? false;
                file.has_keyframes = false;
            }
        }

        // ── Phase B (keyframe + health) — only when file has video
        //    and doesn't already have keyframes. ──
        const needsPhaseB =
            file.has_video &&
            (!file.has_keyframes ||
                (preserveEvidence &&
                    before?.health_issues?.some((i) => i.type === 'no_keyframes')));
        if (needsPhaseB) {
            const result = await probeKeyframes(file.file_path, {
                signal: ctx.signal,
                timeoutMs: keyframeTimeoutForSize(file.file_size_bytes),
            });
            if (!result.success) {
                return {
                    success: false,
                    reason: (result.error ?? 'keyframe probe failed').slice(0, 200),
                };
            }
            ctx.signal.throwIfAborted();
            const tails = await tailsIfTruncated(
                file.file_path,
                result.keyframes,
                file.duration_seconds,
                result.lastPacketPts,
                ctx.signal,
            );
            const issues = detectHealthIssues(
                result.keyframes,
                file.duration_seconds,
                result.lastPacketPts,
                tails,
            );
            if (preserveEvidence) {
                freshKeyframes = { keyframes: result.keyframes, issues };
            } else {
                await withTx(sql, async (txRaw) => {
                    const tx = txRaw as unknown as postgres.Sql;
                    await updateKeyframes(tx, file.id, result.keyframes);
                    await updateHealthIssues(
                        tx,
                        file.id,
                        issues.length > 0 ? issues : null,
                        issues.length > 0 ? (auditJobId ?? null) : null,
                    );
                    if (issues.length > 0) {
                        await recordFailure(
                            tx,
                            PLUGIN_ID,
                            file.id,
                            issues[0].type,
                            auditJobId ?? null,
                        );
                    } else {
                        await markFailureEventsResolved(tx, PLUGIN_ID, file.id);
                        // L3: keyframe probe succeeded cleanly — mark media-probe-b
                        // completed for every linked media_item in the same tx, so the
                        // coverage row isn't left pending until the next sweep tick.
                        const linkedB = await tx<{ media_item_id: string }[]>`
                        SELECT media_item_id FROM media_file_items WHERE file_id = ${file.id}::uuid
                    `;
                        for (const { media_item_id } of linkedB) {
                            await upsertCompletedRow(tx, {
                                mediaItemId: media_item_id,
                                stageId: 'media-probe-b',
                                processingVersion: PROCESSING_VERSION,
                            });
                        }
                    }
                });
                if (issues.length > 0) {
                    return {
                        success: false,
                        reason: issues[0].type,
                    };
                }
                return { success: true };
            }
        }

        // Existing metadata/keyframes need a scoped tail review, not a global wipe.
        const [review] = await sql<HealthReviewFile[]>`
            SELECT id, keyframes, duration_seconds, health_issues, file_path
            FROM media_files WHERE id = ${itemId}::uuid LIMIT 1
        `;
        if (review && freshProbe) review.duration_seconds = file.duration_seconds;
        const applyFreshProbe =
            preserveEvidence && (freshProbe || freshKeyframes)
                ? async (tx: postgres.Sql): Promise<void> => {
                      ctx.signal.throwIfAborted();
                      if (freshProbe) await writeProbeResult(tx, file.id, freshProbe, [], false);
                      if (freshKeyframes) {
                          await updateKeyframes(tx, file.id, freshKeyframes.keyframes);
                          // Add new evidence first so removing the last disproved
                          // warning cannot discard audit provenance for fresh damage.
                          await addRecheckedHealthIssues(
                              tx,
                              file.id,
                              freshKeyframes.issues,
                              ctx.signal,
                              before?.health_issues ?? [],
                          );
                          if (freshKeyframes.keyframes.length > 0) {
                              await removeReviewedHealthIssues(
                                  tx,
                                  file.id,
                                  (before?.health_issues ?? []).filter(
                                      (i) => i.type === 'no_keyframes',
                                  ),
                                  ctx.signal,
                              );
                          }
                      }
                      if (observation) {
                          if (freshProbe) {
                              const completed = await completeFreshFileProbeStage(tx, {
                                  fileId: file.id,
                                  stageId: 'media-probe-a',
                                  processingVersion: PROCESSING_VERSION,
                                  observedAt: observation.at,
                              });
                              for (const mediaItemId of completed)
                                  await emitPipelineEvent(tx, 'file.probed', mediaItemId, {
                                      event: 'file.probed',
                                      mediaId: mediaItemId,
                                      fileId: file.id,
                                      hasVideo: freshProbe.video != null,
                                      hasAudio: freshProbe.audioStreams.length > 0,
                                  });
                          }
                          if (freshKeyframes)
                              await completeFreshFileProbeStage(tx, {
                                  fileId: file.id,
                                  stageId: 'media-probe-b',
                                  processingVersion: PROCESSING_VERSION,
                                  observedAt: observation.at,
                              });
                      }
                      ctx.signal.throwIfAborted();
                  }
                : undefined;
        const result =
            review && (review.health_issues?.length || applyFreshProbe || selectedEvidence)
                ? await revalidateFileTailIssues(
                      sql,
                      review,
                      ctx.signal,
                      applyFreshProbe,
                      preserveEvidence,
                      selectedEvidence,
                  )
                : { inconclusive: false };
        // Always re-read: a decode writer may have added evidence while probing.
        const [after] = await sql<Array<{ health_issues: FileHealthIssue[] | null }>>`
            SELECT health_issues FROM media_files WHERE id = ${itemId}::uuid LIMIT 1
        `;
        if (!after) return { success: false, reason: 'File not found' };
        if (after.health_issues && after.health_issues.length > 0) {
            return {
                success: false,
                reason: `${after.health_issues[0].type}${
                    result.inconclusive ||
                    (preserveEvidence &&
                        after.health_issues.some(
                            (i) =>
                                !['truncated_video', 'video_ends_early', 'no_keyframes'].includes(
                                    i.type,
                                ),
                        ))
                        ? ' (revalidation inconclusive; issue preserved)'
                        : ''
                }`,
            };
        }
        return { success: true };
    } catch (err) {
        if (ctx.signal.aborted) throw ctx.signal.reason;
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn('Media probe retry failed', {
            fileId: file.id,
            error: reason,
        });
        return { success: false, reason: reason.slice(0, 200) };
    }
}

// ============================================================================
// listFailedItems
// ============================================================================

export async function listFailedItems(
    ctx: TaskContext,
    { limit, offset }: ListFailedItemsOptions,
): Promise<ListFailedItemsResult> {
    const clampedLimit = Math.min(100, Math.max(1, limit));
    const safeOffset = Math.max(0, offset);
    const sql = ctx.sql as unknown as postgres.Sql<Record<string, never>>;

    // Predicate mirrors getBacklogStatus `failed` bucket exactly:
    //   is_linked AND is_probed AND (has_keyframes OR NOT has_video) AND has_issues
    // Without this, unlinked or unprobed files with health_issues set would
    // appear in the drilldown but not in the count.
    const [{ count }] = await sql<[{ count: number }]>`
        SELECT COUNT(*)::int AS count
        FROM media_files mf
        WHERE ${actionableFileHealthSql(sql, sql`mf.id`)}
          AND mf.probed_at IS NOT NULL
          AND EXISTS (
              SELECT 1 FROM media_file_items mfi WHERE mfi.file_id = mf.id
          )
          AND (
              mf.keyframes IS NOT NULL
              OR NOT EXISTS (
                  SELECT 1 FROM media_streams ms
                  WHERE ms.file_id = mf.id AND ms.stream_type = 'video'
              )
          )
    `;

    const rows = await sql<
        Array<{
            id: string;
            file_path: string;
            health_issues: Array<FileHealthIssue & { reviewed?: boolean }>;
            audit_run_job_id: string | null;
            task_history_id: string | null;
        }>
    >`
        SELECT
            mf.id,
            mf.file_path,
            ${boundedAdminHealthIssuesSql(sql, sql`mf.health_issues`, sql`mf.updated_at`, sql`mf.id`)} AS health_issues,
            mf.audit_run_job_id,
            th.id AS task_history_id
        FROM media_files mf
        LEFT JOIN (
            SELECT id, task_id FROM task_history
            UNION ALL
            SELECT id, task_id FROM task_history_archive
        ) th ON th.task_id = mf.audit_run_job_id
        WHERE ${actionableFileHealthSql(sql, sql`mf.id`)}
          AND mf.probed_at IS NOT NULL
          AND EXISTS (
              SELECT 1 FROM media_file_items mfi WHERE mfi.file_id = mf.id
          )
          AND (
              mf.keyframes IS NOT NULL
              OR NOT EXISTS (
                  SELECT 1 FROM media_streams ms
                  WHERE ms.file_id = mf.id AND ms.stream_type = 'video'
              )
          )
        ORDER BY mf.probed_at DESC NULLS LAST, mf.id
        LIMIT ${clampedLimit} OFFSET ${safeOffset}
    `;

    const fileIds = rows.map((r) => r.id);
    let aggregates = new Map<string, FailureAggregateRow>();
    try {
        aggregates = await getFailureAggregates(sql, PLUGIN_ID, fileIds);
    } catch (err) {
        ctx.logger.warn(
            'listFailedItems aggregate fetch failed — serving list without timeline counts',
            { error: err instanceof Error ? err.message : String(err) },
        );
    }

    return {
        total: count,
        items: rows.map((row) => {
            const firstIssue = row.health_issues.find((issue) => !issue.reviewed);
            const agg = aggregates.get(row.id);
            return {
                id: row.id,
                label: row.file_path.split('/').slice(-2).join('/'),
                subtitle: row.file_path,
                reason: firstIssue?.type ?? 'unknown',
                detectedAt: firstIssue?.detected_at ?? null,
                taskRunId: row.task_history_id ?? undefined,
                ...(agg && {
                    firstSeen: agg.first_seen.toISOString(),
                    failureCount: agg.failure_count,
                    lastSeen: agg.last_seen.toISOString(),
                }),
            };
        }),
    };
}

// ============================================================================
// Task definition
// ============================================================================

export const mediaProbeTask = defineTask<MediaProbeInput, MediaProbeResult>({
    id: 'media-probe',
    purpose: 'library',
    name: 'Media File Probe',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true },

    schedule: {
        every: '1h',
        // NOTE: this task deliberately does NOT declare `supportsFullRun`.
        // Its identityFor is `global-${mode}`, so a manual drain takes a
        // DIFFERENT exclusiveWith key from the scheduled catchup and the two
        // run concurrently. With a 1h schedule against a drain that can last
        // ~50m, that overlap is near-certain, and the fetchers claim no rows
        // (no FOR UPDATE SKIP LOCKED), so both passes probe the same
        // head-of-backlog slice. music-popularity hit exactly this and fixed
        // it by collapsing identityFor to a constant; until this task does the
        // same, the admin action stays unavailable.
        runOnStartup: false,
        envOverride: 'SYNC_MEDIA_PROBE_INTERVAL',
    },

    identityFor: (input) =>
        input.fileId
            ? `file-health-${input.fileId.toLowerCase()}`
            : `global-${typeof (input as Record<string, unknown>).mode === 'string' ? ((input as Record<string, unknown>).mode as string) : 'catchup'}`,
    // identityFor alone names jobs; opt in to the atomic in-flight claim.
    exclusiveWith: { scope: 'global', ttl: '65m' },
    scope: 'global',
    // Fast-path file ingest pool. media-probe IS cpu-bound (ffprobe), but it
    // belongs to the "new file just arrived" critical path that must drain
    // quickly. The cpu pool is reserved for genuinely-heavy work like
    // trickplay-generation and lumastra-intro-analyzer that can hold a
    // worker slot for tens of minutes; sharing it starves probe.
    resourceClass: 'ingest',

    // NOT isolated. media-probe was the Phase 1 isolation candidate, but the
    // preprod soak measured a ~0.7s per-run spawn floor (thread + ~4.4MB bundle +
    // loadBuiltins + pool connect) against a ~1.3s median run — a ~50% tax on the
    // cheapest, highest-frequency task in the "new file arrived" critical path,
    // for a task whose blast radius if it wedged is small (short, ffprobe-driven,
    // sql-light). Worker isolation now stays on the long CPU jobs where a
    // synchronous wedge is both likely and catastrophic (minutes-to-hours blast
    // radius): lumastra-intro-analyzer and trickplay-generation.
    // Decision: GH #57 soak conclusion (2026-06-09).

    inputSchema,

    coversStages: [
        {
            id: 'media-probe-a',
            appliesTo: ['movie', 'episode', 'track'] as const,
            // Eligibility: a linked, non-missing file (probe is a no-op without one).
            // File-less items are seeded `pending`, then the sweep dispose pass
            // demotes them to `skipped_permanent/'ineligible'` (re-checkable); the
            // event-independent heal flips them back the instant a file lands — the
            // widest-payoff recovery backstop in the system (A5: a lost file.attached
            // event can no longer leave an item's whole downstream pipeline dark).
            eligibility: {
                // `DISABLE_MEDIA_PROBE` leads the fragment (live getter, read per
                // call): execute() early-returns while it is set and the task is
                // global-identity, so without it every seeded row stayed `pending`
                // forever — counted as backlog, found by stage-sweep every tick,
                // never enqueued. Clearing the flag lets the heal reclaim the rows
                // the disabled predicate below parked (up to PER_STAGE_HEAL_QUIET_MS,
                // 15 min, later: the heal goes quiet after ticks that reclaim nothing).
                sql: (sql) => sql`
                    ${config.DISABLE_MEDIA_PROBE ? sql`false` : sql`true`}
                    AND EXISTS (
                        SELECT 1 FROM media_file_items mfi
                          JOIN media_files mf ON mf.id = mfi.file_id
                         WHERE mfi.media_item_id = mi.id AND NOT mf.is_missing
                    )
                `,
                // Rows skipped under the legacy 'no-file-linked' disposition
                // (migration 16.21.0) are reclaimed by the same heal.
                recoverWhenAdditionalReasons: ['no-file-linked', MEDIA_PROBE_DISABLED_REASON],
            },
            invalidatedBy: [
                'file.attached',
                'file.detached',
                'file.contentChanged',
                'file.defaultChanged',
            ] as const,
            // Turning the switch back on re-enrols the whole library through the
            // heal; the default 50 rows per tick would take hours on a large one.
            healLimit: 500,
            retryPolicy: { maxAttempts: 5 },
            enqueueable: true,
            // Self-terminal: execute() writes a terminal status for every candidate
            // it probes (file-less items are disposed by the eligibility pass before
            // enqueue; probed items reach completed/failed_*). Declarative Stage Contract.
            terminalDisposition: [
                {
                    // Switched off by the operator. A predicate, not a global-guard:
                    // a guard drains to `skipped_transient`, which progress counts as
                    // REMAINING. Declared before the self-terminal entry and run
                    // before the eligibility dispose, so rows carry this reason
                    // (listed in recoverWhenAdditionalReasons) instead of 'ineligible'.
                    kind: 'predicate' as const,
                    ruleId: 'media-probe-a-enabled',
                    disposeAs: 'skipped_permanent' as const,
                    reason: MEDIA_PROBE_DISABLED_REASON,
                    excludes: (sql) => (config.DISABLE_MEDIA_PROBE ? sql`true` : sql`false`),
                },
                {
                    kind: 'self-terminal' as const,
                    ruleId: 'media-probe-a-self-terminal',
                },
            ],
        },
        {
            id: 'media-probe-b',
            appliesTo: ['movie', 'episode'] as const,
            // M2 fix: probe-b previously had a `has_file && has_video` predicate but
            // NO recovery rail, so a dead-lettered file.probed event stranded its rows
            // `skipped_permanent` forever (blocking trickplay downstream). Under the
            // unified contract it gains the SQL eligibility it lacked — file present
            // AND a probed video stream — which the event-independent heal re-checks
            // every tick, so a lost file.probed can no longer strand it.
            eligibility: {
                // `DISABLE_MEDIA_PROBE` leads the fragment (live getter, read per
                // call): execute() early-returns while it is set and the task is
                // global-identity, so without it every seeded row stayed `pending`
                // forever — counted as backlog, found by stage-sweep every tick,
                // never enqueued. Clearing the flag lets the heal reclaim the rows
                // the disabled predicate below parked (up to PER_STAGE_HEAL_QUIET_MS,
                // 15 min, later: the heal goes quiet after ticks that reclaim nothing).
                sql: (sql) => sql`
                    ${config.DISABLE_MEDIA_PROBE ? sql`false` : sql`true`}
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
                           AND ms.stream_type = 'video'
                    )
                `,
                recoverWhenAdditionalReasons: [MEDIA_PROBE_DISABLED_REASON],
            },
            // Includes file.probed: media-probe-b is gated on has_video, which
            // media-probe-a produces — so the file.probed event probe-a emits is
            // exactly the signal that ungates probe-b per item.
            invalidatedBy: [
                'file.attached',
                'file.detached',
                'file.contentChanged',
                'file.defaultChanged',
                'file.probed',
            ] as const,
            // Turning the switch back on re-enrols the whole library through the
            // heal; the default 50 rows per tick would take hours on a large one.
            healLimit: 500,
            retryPolicy: { maxAttempts: 5 },
            enqueueable: true,
            terminalDisposition: [
                {
                    // Switched off by the operator. A predicate, not a global-guard:
                    // a guard drains to `skipped_transient`, which progress counts as
                    // REMAINING. Declared before the self-terminal entry and run
                    // before the eligibility dispose, so rows carry this reason
                    // (listed in recoverWhenAdditionalReasons) instead of 'ineligible'.
                    kind: 'predicate' as const,
                    ruleId: 'media-probe-b-enabled',
                    disposeAs: 'skipped_permanent' as const,
                    reason: MEDIA_PROBE_DISABLED_REASON,
                    excludes: (sql) => (config.DISABLE_MEDIA_PROBE ? sql`true` : sql`false`),
                },
                {
                    kind: 'self-terminal' as const,
                    ruleId: 'media-probe-b-self-terminal',
                },
            ],
        },
    ],

    timeout: { hard: '60m', soft: '55m' },

    retry: {
        attempts: 3,
        backoff: 'exponential',
        retryOn: classifyInfraError,
    },

    async execute(ctx) {
        const { logger, signal } = ctx;

        // A selected-file request must NEVER reach reconciliation or the
        // library drain below. Queue identity + the historical retry lock fence
        // duplicate callers across both admin screens and replicas.
        if (ctx.input.fileId !== undefined) {
            const fileId = ctx.input.fileId;
            if (config.DISABLE_MEDIA_PROBE) {
                return {
                    success: true,
                    itemsProcessed: 0,
                    result: {
                        probed: 0,
                        keyframed: 0,
                        errors: 0,
                        missing: 0,
                        recheck: {
                            fileId,
                            outcome: 'inconclusive',
                            issues: [],
                            reason: 'disabled',
                        },
                    },
                };
            }
            const sql = ctx.sql as unknown as postgres.Sql;
            const deadline = AbortSignal.timeout(18 * 60_000);
            const selectedSignal = AbortSignal.any([signal, deadline]);
            const locked = await withAdvisoryLock(
                sql,
                `retry:media-probe:${fileId}`,
                async (tx) => {
                    const selectedCtx = buildAdminContextStub('media-probe', {
                        sql: tx,
                        signal: selectedSignal,
                    });
                    // The pool defaults to 30s, shorter than a keyframe scan.
                    // Local scope restores that default on commit/rollback.
                    await tx`SET LOCAL idle_in_transaction_session_timeout = '19min'`;
                    await tx`SET LOCAL statement_timeout = '20s'`;
                    await tx`SET LOCAL lock_timeout = '5s'`;
                    const result = await retryOneFile(selectedCtx, fileId, true);
                    selectedSignal.throwIfAborted();
                    const after = await getFileHealthSnapshot(tx, fileId);
                    if (result.success && after && !after.health_issues?.length) {
                        await markFailureEventsResolved(tx, PLUGIN_ID, fileId);
                    }
                    selectedSignal.throwIfAborted();
                    const recheck: FileHealthRecheckResult = {
                        fileId,
                        outcome:
                            result.success && after && !after.health_issues?.length
                                ? 'healthy'
                                : result.reason?.includes('inconclusive')
                                  ? 'inconclusive'
                                  : after?.health_issues?.some((i) => result.reason === i.type)
                                    ? 'warning'
                                    : 'error',
                        issues: (after?.health_issues ?? []).map(({ type }) => ({ type })),
                        ...(result.reason
                            ? {
                                  reason: result.reason.includes('inconclusive')
                                      ? ('inconclusive' as const)
                                      : after?.health_issues?.some((i) => result.reason === i.type)
                                        ? ('warnings_remain' as const)
                                        : ('probe_failed' as const),
                              }
                            : {}),
                    };
                    return recheck;
                },
            );
            return {
                success: true,
                itemsProcessed: locked.acquired ? 1 : 0,
                result: {
                    probed: 0,
                    keyframed: 0,
                    errors: 0,
                    missing: 0,
                    recheck: locked.acquired
                        ? locked.value
                        : { fileId, outcome: 'busy', issues: [] },
                },
            };
        }

        if (config.DISABLE_MEDIA_PROBE) {
            return {
                success: true,
                itemsProcessed: 0,
                result: { probed: 0, keyframed: 0, errors: 0, missing: 0 },
            };
        }

        const sql = ctx.sql as unknown as postgres.Sql<Record<string, never>>;
        const rawInput = (ctx.input as Record<string, unknown>) ?? {};
        const mode = typeof rawInput.mode === 'string' ? rawInput.mode : 'catchup';
        const startTime = Date.now();

        const drainMode = resolveDrainMode(mode, logger);

        // Reconciliation pass — drains stage_state rows whose underlying work
        // is already done. Catches the historical drift where the handler
        // was wired to update media_files (probed_at, keyframes) but not the
        // per-item media_item_stage_state coverage table. On preprod this
        // single statement bridged a 96k-row gap in one run; left in place
        // because future content-invalidation paths could re-introduce drift
        // and an idempotent reconciliation is the cheapest defense.
        try {
            // Chunked + abort-aware so these pre-heartbeat UPDATEs can't hold
            // locks long enough to look like a stall on a large library (the
            // exact class Phase 0 was already patched for). See
            // reconcileProbeStageState / RECONCILE_CHUNK_SIZE.
            const {
                reconciledA: reconciledACount,
                reconciledB: reconciledBCount,
                capped: reconcileCapped,
            } = await reconcileProbeStageState(sql, signal);

            if (reconcileCapped) {
                // The reconciliation loop hit MAX_RECONCILE_CHUNKS with a full
                // final chunk — backlog remains un-reconciled this run. Surface
                // it so a persistent gap isn't silently mistaken for a clean
                // drain; the next scheduled/manual run picks up the remainder.
                logger.warn(
                    'stage_state reconciliation hit its per-run chunk cap — backlog left for next run',
                    {
                        'media-probe-a': reconciledACount,
                        'media-probe-b': reconciledBCount,
                    },
                );
            }

            // The file-less-items reconciliation that used to live here was
            // superseded by migration 16.21.0 (Phase D backfill) + the
            // has_file eligibility predicate added in Phase C. New file-less
            // items get seeded as skipped_permanent at item creation;
            // historical pending rows were drained by the migration. The
            // event-driven path (FEATURE_PIPELINE_EVENT_OUTBOX=true) flips
            // them back to pending when a file is later attached.

            if (reconciledACount > 0 || reconciledBCount > 0) {
                logger.info('Reconciled already-done stage_state rows', {
                    'media-probe-a': reconciledACount,
                    'media-probe-b': reconciledBCount,
                });
            }
        } catch (reconcileErr) {
            logger.warn('stage_state reconciliation failed (non-fatal)', {
                error: reconcileErr instanceof Error ? reconcileErr.message : String(reconcileErr),
            });
        }

        // Reuse the exact selected-file path, with persisted input/rule receipts and bounded retries.
        let automaticallyChecked = 0;
        const automaticHeartbeat = startHeartbeat({
            onProgress: (processed, total, meta) =>
                ctx.reportProgress(processed, total, meta?.currentItem),
            logger,
            getTotal: () => FILE_HEALTH_RECHECK_BATCH,
            getProcessed: () => automaticallyChecked,
            getStatus: () => 'Checking changed file health',
            phase: 'File health',
            intervalMs: 30_000,
        });
        try {
            const automaticSignal = AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]);
            await recheckChangedFileHealth(sql, automaticSignal, async (fileId) => {
                signal.throwIfAborted();
                logger.info('Checking changed file health', { fileId });
                const result = await mediaProbeTask.execute({
                    ...ctx,
                    signal: automaticSignal,
                    input: { fileId },
                });
                automaticallyChecked++;
                const outcome = result.result?.recheck?.outcome;
                if (outcome === 'healthy') return true;
                if (outcome !== 'warning') return false;
                const [row] = await sql<{ health_tail_assessment: unknown }[]>`
                    SELECT health_tail_assessment FROM media_files WHERE id = ${fileId}::uuid`;
                const parsed = AudioTailAssessmentSchema.safeParse(row?.health_tail_assessment);
                return parsed.success && durationReviewTechnicalBlock(parsed.data) === undefined;
            });
        } catch (error) {
            signal.throwIfAborted();
            logger.warn('Automatic file health recheck failed; bounded retry retained', {
                error: error instanceof Error ? error.message : String(error),
            });
        } finally {
            automaticHeartbeat.clear();
        }

        let probed = 0;
        let keyframed = 0;
        let errors = 0;
        let missing = 0;

        // Separate lazy snapshots per phase — taken on each phase's first
        // fetchSlice, after Phase 0 / force-mode wipe. Keeping distinct
        // denominators prevents the heartbeat progress from exceeding 100%:
        // a file probed in Phase A increments `probed`, then keyframed in
        // Phase B increments `keyframed`, but each phase's denominator only
        // counts files eligible for THAT phase at the time it started.
        const initialPhaseABacklog = lazyBacklog(() => countUnprobedFiles(sql));
        const initialPhaseBBacklog = lazyBacklog(() => countFilesWithoutKeyframes(sql));

        // Heartbeat: drain-backlog only reports progress between slices; a
        // single slow keyframe slice can silently hold the worker past the
        // 2-min stall threshold. Use running totals so the admin UI advances
        // mid-slice. The shared helper swallows onProgress failures so a
        // Valkey blip can't bubble out of this interval and kill the worker.
        //
        // Include errors+missing in the numerator so the heartbeat matches
        // drainBacklog's `unitsProcessed` accounting (produced + skipped +
        // errored all count as "row done"). Emitting just `probed +
        // keyframed` made the progress bar tick backwards whenever a slice
        // contained a missing/errored file that dragged the per-slice
        // drainBacklog numerator ahead of the heartbeat.
        const onProgress = (
            processed: number,
            total: number,
            meta?: { currentItem?: string; phase?: string },
        ) => {
            ctx.reportProgress(processed, total, meta?.currentItem);
        };

        const heartbeat = startHeartbeat({
            onProgress,
            logger,
            getTotal: () => (initialPhaseABacklog.peek() ?? 0) + (initialPhaseBBacklog.peek() ?? 0),
            getProcessed: () => probed + keyframed + errors + missing,
            getStatus: () => `Probing... (${probed} done, ${errors} errors, ${missing} skipped)`,
            phase: 'Probing media files',
        });

        // Shared wall-clock budget across Phase 0 + A + B. Using a closure so
        // Phase B only gets what's left after Phase A ran.
        const runStart = startTime;
        const budgetRemaining = (): number =>
            Math.max(0, TOTAL_SOFT_BUDGET_MS - (Date.now() - runStart));

        try {
            // ================================================================
            // Phase 0: Bulk runtime_seconds backfill for movies.
            //
            // Self-heals the catalog gap where probed files never wrote
            // runtime back to the parent media_item. Skipped in force mode
            // because wipeProbeData just nulled every duration — running this
            // before re-probing would stomp current values with zeroes.
            //
            // For multi-variant movies (theatrical + extended) we pick the
            // longest probed duration (DISTINCT ON / ORDER BY duration DESC);
            // consistent with play-sessions.service.ts and conservative for
            // "watched" thresholds.
            //
            // Chunked: on a 100k-file library the original single-shot
            // UPDATE held media_items locks for 30-60s. That's long
            // enough to trip BullMQ's stall detector before the first
            // fetchSlice fires, so the heartbeat can't cover the gap.
            // Looping PHASE_0_CHUNK_SIZE at a time yields between
            // statements, lets the abort signal propagate, and gives
            // onProgress a visible pulse. Lock windows stay bounded, so
            // concurrent writers (scanner) don't stall either.
            // ================================================================
            if (drainMode === 'force') {
                await wipeProbeData(sql, logger, signal);
            } else {
                let totalBackfilled = 0;
                // Hard cap on chunk count so a pathological planner doesn't
                // spin forever — the UPDATE is idempotent by construction
                // (updates only rows where runtime_seconds is NULL/0), so
                // a non-zero return every iteration would suggest a
                // planner-inlined retry loop that ought to error out
                // visibly rather than silently continue.
                const MAX_CHUNKS = 10_000;
                let chunkIdx = 0;
                for (; chunkIdx < MAX_CHUNKS; chunkIdx++) {
                    if (signal.aborted) break;
                    const n = await backfillMovieRuntimesChunk(sql, PHASE_0_CHUNK_SIZE);
                    if (n === 0) break;
                    totalBackfilled += n;
                    // Give the scheduler, heartbeat, and onProgress a
                    // chance to run between chunks. Yielding via
                    // `setImmediate`-analogue (resolve/microtask) is not
                    // enough on Node — we want a real tick so
                    // setInterval timers can fire.
                    await new Promise<void>((resolve) => setTimeout(resolve, 0));
                }
                if (chunkIdx === MAX_CHUNKS) {
                    // Hit the cap — either a pathological planner loop or
                    // a legitimately huge library. Either way operators
                    // should see this surface before assuming all done.
                    logger.warn(
                        'Phase 0: Hit MAX_CHUNKS cap during runtime backfill — some rows may remain unfilled until the next run',
                        {
                            maxChunks: MAX_CHUNKS,
                            chunkSize: PHASE_0_CHUNK_SIZE,
                            totalBackfilled,
                        },
                    );
                }
                if (totalBackfilled > 0) {
                    logger.info(
                        `Phase 0: Backfilled runtime_seconds for ${totalBackfilled} movies`,
                    );
                }
            }

            // After wipe, both phases run as manual (drain-until-empty). In
            // catchup we want one slice per phase max so the scheduler's
            // "periodic nibble" semantics are preserved.
            const effectiveMode: DrainBacklogMode = drainMode === 'force' ? 'manual' : drainMode;

            const drainCtx = {
                logger,
                abortSignal: signal,
            };

            // ================================================================
            // Phase A: stream metadata + container probe
            // ================================================================
            const phaseABudget = budgetRemaining();
            let phaseAResult: Awaited<ReturnType<typeof drainBacklog>> | null = null;
            if (phaseABudget > 0) {
                phaseAResult = await drainBacklog<UnprobedFileRow>(drainCtx, {
                    mode: effectiveMode,
                    sliceSize: PHASE_A_SLICE_SIZE,
                    softBudgetMs: phaseABudget,
                    idOf: (row) => row.id,
                    fetchSlice: async (limit) => {
                        const rows = await getUnprobedFiles(sql, limit);
                        // Snapshot Phase A's denominator on the first fetch.
                        // Using a Phase-A-only count prevents cross-phase
                        // double-counting: files that advance through both
                        // phases would otherwise inflate the numerator past
                        // the combined denominator.
                        const total = await initialPhaseABacklog();
                        return {
                            items: rows,
                            remainingHint: computeRemainingHint(
                                total,
                                probed + errors + missing,
                                rows.length,
                            ),
                        };
                    },
                    processSlice: async (files, sliceSignal) => {
                        const outcome = await processPhaseASlice(sql, logger, sliceSignal, files);
                        probed += outcome.probed;
                        errors += outcome.errors;
                        missing += outcome.missing;
                        // Advanced = probed (successful upsert via
                        // replaceStreamsForFile + updateProbeData) + missing
                        // (file has vanished from disk — we don't mark the
                        // row, but the scanner will reap the media_files
                        // record on its next pass; treat it as advanced so
                        // the drain's no-progress detector doesn't fire on a
                        // library full of dead symlinks). Transient errors
                        // stay unadvanced so a DB/FFprobe blip doesn't get
                        // mistaken for a fetcher bug.
                        return {
                            produced: outcome.probed,
                            advanced: outcome.probed + outcome.missing,
                        };
                    },
                    onProgress,
                    phase: 'Probing stream metadata',
                });

                logger.info(
                    `Phase A complete: ${probed} probed, ${errors} errors, ${missing} missing (stop=${phaseAResult.stopReason})`,
                );
            }

            // ================================================================
            // Phase B: keyframe probe
            // ================================================================
            // Both phases run every tick — drainBacklog already limits each to
            // one slice in catchup mode, so the combined cost per run is
            // Phase A (200 files, fast) + Phase B (50 files, slow but budgeted).
            // The old skipPhaseB guard caused Phase B starvation: whenever
            // Phase A had any work (which is always true in a growing library),
            // Phase B was skipped entirely and keyframes were never pre-computed.
            const phaseBBudget = budgetRemaining();
            let phaseBResult: Awaited<ReturnType<typeof drainBacklog>> | null = null;
            if (phaseBBudget >= PHASE_B_MIN_BUDGET_MS && !signal.aborted) {
                phaseBResult = await drainBacklog<KeyframeFileRow>(drainCtx, {
                    mode: effectiveMode,
                    sliceSize: PHASE_B_SLICE_SIZE,
                    softBudgetMs: phaseBBudget,
                    idOf: (row) => row.id,
                    fetchSlice: async (limit) => {
                        const rows = await getFilesWithoutKeyframes(sql, limit);
                        // Snapshot Phase B's denominator on the first fetch.
                        // Separate from Phase A's snapshot so each phase's
                        // progress bar stays within 0–100%.
                        const total = await initialPhaseBBacklog();
                        return {
                            items: rows,
                            remainingHint: computeRemainingHint(
                                total,
                                keyframed + errors + missing,
                                rows.length,
                            ),
                        };
                    },
                    processSlice: async (files, sliceSignal) => {
                        const outcome = await processPhaseBSlice(
                            sql,
                            logger,
                            sliceSignal,
                            files,
                            ctx.runId,
                        );
                        keyframed += outcome.keyframed;
                        errors += outcome.errors;
                        missing += outcome.missing;
                        // Advanced = keyframed (updateKeyframes +
                        // updateHealthIssues — both terminal states: success
                        // OR the file is permanently sentineled as
                        // no_keyframes / truncated_video, which drops it out
                        // of getFilesWithoutKeyframes) + missing. Keyframe
                        // probe failures (outcome.errors) are left
                        // unadvanced: they may be transient I/O (spinning
                        // disk, NFS timeout) and the next drain retries them
                        // via getFilesWithoutKeyframes.
                        return {
                            produced: outcome.keyframed,
                            advanced: outcome.keyframed + outcome.missing,
                        };
                    },
                    onProgress,
                    phase: 'Probing keyframes',
                });

                logger.info(
                    `Phase B complete: ${keyframed} keyframed, ${errors} errors, ${missing} missing (stop=${phaseBResult.stopReason})`,
                );
            }

            // Pick the most informative stop reason from both phases via
            // severity ordering (see pickWorstStopReason): a clean Phase-B
            // `drained` must not mask a Phase-A `no-progress`. Fold in the
            // top-level abortSignal so a wipe-absorbed abort still surfaces
            // as aborted when both phases returned `drained`.
            const primaryStop: DrainStopReason = signal.aborted
                ? 'aborted'
                : pickWorstStopReason([phaseAResult?.stopReason, phaseBResult?.stopReason]);
            const aborted = isAbortedStop(primaryStop);

            // Build the tail suffix for the message. When the two phases
            // stopped for different reasons, append both so the admin can
            // see why each phase ended — a lone suffix would hide nuance
            // like "Phase A: no-progress; Phase B: drained".
            const stopSuffix = buildMediaProbeStopSuffix(
                primaryStop,
                phaseAResult?.stopReason,
                phaseBResult?.stopReason,
            );

            const totalProcessed = probed + keyframed;

            logger.info(
                `Media probe run complete: ${probed} probed, ${keyframed} keyframed, ${errors} errors, ${missing} missing${stopSuffix}`,
            );

            // An aborted run may have partial work committed, but the admin
            // asked for it to stop — surface that as a non-success so the
            // task log doesn't show a green checkmark for a cancelled job.
            return {
                success: !aborted,
                itemsProcessed: totalProcessed,
                result: { probed, keyframed, errors, missing },
            };
        } catch (error) {
            logger.error('Media probe sync failed', error as Error);
            throw error;
        } finally {
            heartbeat.clear();
        }
    },

    backlog: {
        unitLabel: 'files',
        sliceSize: 1,
        softBudget: '1m',
        idOf: (row) => {
            const r = row as { id?: string } | null | undefined;
            return r?.id ?? String(r);
        },
        async stages(ctx: TaskContext): Promise<BacklogStage[]> {
            const sql = ctx.sql as unknown as postgres.Sql<Record<string, never>>;

            // Bucket breakdown — predicates mirror getUnprobedFiles +
            // getFilesWithoutKeyframes exactly so "N remaining" matches what
            // the drain would actually pick up:
            //   analyzed   → file is linked AND probed AND (has keyframes
            //                OR no video stream — audio-only / subtitle-only
            //                files have no keyframes to collect) AND no
            //                persistent health issues
            //   remaining  → file is linked AND (not probed, or probed with
            //                a video stream but no keyframes yet)
            //   ineligible → file exists in media_files but has no
            //                media_file_items junction (orphaned, will never
            //                be visited by the fetchers)
            //   failed     → file is linked, fully probed, but
            //                `health_issues` is populated (no_keyframes or
            //                truncated_video). These files won't be retried
            //                — drain considers them done — so they must be
            //                disjoint from `analyzed` to give admins a
            //                signal to investigate. Matches music-analysis'
            //                disjoint failed-vs-analyzed convention.
            const [row] = await sql<
                Array<{
                    analyzed: number;
                    remaining: number;
                    ineligible: number;
                    failed: number;
                }>
            >`
                WITH file_state AS (
                    SELECT
                        mf.id,
                        (mf.probed_at IS NOT NULL) AS is_probed,
                        (mf.keyframes IS NOT NULL) AS has_keyframes,
                        (${actionableFileHealthSql(sql, sql`mf.id`)}) AS has_issues,
                        EXISTS (
                            SELECT 1 FROM media_streams ms
                            WHERE ms.file_id = mf.id AND ms.stream_type = 'video'
                        ) AS has_video,
                        EXISTS (
                            SELECT 1 FROM media_file_items mfi
                            WHERE mfi.file_id = mf.id
                        ) AS is_linked
                    FROM media_files mf
                )
                SELECT
                    COUNT(*) FILTER (
                        WHERE is_linked
                          AND is_probed
                          AND (has_keyframes OR NOT has_video)
                          AND NOT has_issues
                    )::int AS analyzed,
                    COUNT(*) FILTER (
                        WHERE is_linked
                          AND (
                              NOT is_probed
                              OR (has_video AND NOT has_keyframes)
                          )
                    )::int AS remaining,
                    COUNT(*) FILTER (
                        WHERE NOT is_linked
                    )::int AS ineligible,
                    COUNT(*) FILTER (
                        WHERE is_linked
                          AND is_probed
                          AND (has_keyframes OR NOT has_video)
                          AND has_issues
                    )::int AS failed
                FROM file_state
            `;

            const analyzed = row?.analyzed ?? 0;
            const remaining = row?.remaining ?? 0;
            const ineligible = row?.ineligible ?? 0;
            const failed = row?.failed ?? 0;

            const stages: BacklogStage[] = [];
            if (remaining > 0) {
                stages.push({
                    id: 'remaining',
                    label: 'Remaining',
                    count: remaining,
                });
            }
            if (failed > 0) {
                stages.push({ id: 'failed', label: 'Failed', count: failed });
            }
            if (ineligible > 0) {
                stages.push({
                    id: 'ineligible',
                    label: 'Ineligible',
                    count: ineligible,
                });
            }
            void analyzed;
            return stages;
        },
        async wipe(ctx: TaskContext): Promise<void> {
            const sql = ctx.sql as unknown as postgres.Sql<Record<string, never>>;
            await wipeProbeData(sql, ctx.logger, ctx.signal);
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
            const res = await listFailedItems(ctx, opts);
            return {
                items: res.items.map((item) => ({
                    id: item.id,
                    label: item.label,
                    reason: item.reason,
                    detectedAt: item.detectedAt,
                    subtitle: item.subtitle,
                    firstSeen: item.firstSeen,
                    failureCount: item.failureCount,
                    lastSeen: item.lastSeen,
                })),
                total: res.total,
            };
        },
        async retry(ctx: TaskContext, itemId: string): Promise<void> {
            const result = await retryOneFile(ctx, itemId);
            if (!result.success) {
                throw new Error(result.reason ?? `Retry for item '${itemId}' did not succeed`);
            }
        },
    },
});

registry.registerTask(mediaProbeTask);
