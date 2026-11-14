// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FFmpeg Multi-Audio HLS Transcode Service
 *
 * Manages FFmpeg transcode jobs that demux Jellyfin's static stream into
 * separate video and audio HLS renditions using `-var_stream_map`.
 *
 * This enables native tvOS AVPlayer audio track picker with instant switching.
 *
 * Key features:
 * - Uses Jellyfin static=true stream as input (all audio tracks preserved)
 * - Selective transcoding: copies compatible codecs, transcodes incompatible ones
 * - Job lifecycle management with automatic cleanup
 * - Per-user job limits
 * - **Sliding window segment cleanup** - keeps disk usage constant by deleting
 *   old segments while maintaining a rewind buffer
 */

import {
    countPlaybackTranscodes,
    publishPlaybackPressure,
    setPlaybackCountsProvider,
    type PlaybackCounts,
} from '../tasks/playback-pressure.js';

import * as fs from 'fs/promises';
import { defaultAudioAbsoluteIndex } from '$lib/shared/stream-index.js';
import { readFileSync } from 'node:fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { ShutdownInterruptedError } from '$lib/server/lifecycle/shutdown-interrupted.js';
import { isShuttingDown as isWebShuttingDown } from '$lib/server/lifecycle/web-shutdown.js';
import { Logger } from '../utils/logger.js';
import { isDistinctStreamDuration } from '../utils/hls-stream-duration.js';
import { isNativeHlsClient } from '../utils/hls-master-playlist.js';
import {
    transcodeDecision,
    type TranscodeDecision,
    type FullStrategyConfig,
    FullTranscodeStrategy,
    getHwAccelFromEncoder,
    resolveTonemapMode,
} from './transcoding/index.js';
import {
    planStandaloneTranscode,
    type EffectiveTranscodePlan,
} from './transcoding/effective-transcode-plan.js';
import { effectiveAudioTrackCount } from './transcoding/full-transcode-strategy.js';
import {
    getTranscodeJobPersistenceService,
    getCurrentPodName,
    type TranscodeJobPersistenceService,
    type PersistedJobMetadata,
} from './transcode-job-persistence.service.js';
import { checkRealTranscodeLoadShed } from './preview-admission.service.js';
import type {
    TranscodeJob,
    TranscodeJobConfig,
    IFrameEntry,
    TranscodeJobStatus,
    VodManifestInfo,
    FFmpegJobInfo,
    PlaybackSession,
    GenerationRoleValue,
    PlayerTranscodeProgressInfo,
} from './transcoding/types.js';
import { PlaySessionOwnedByAnotherUserError } from './transcoding/play-session-owner-error.js';
import { UserJobCapReachedError } from './transcoding/user-job-cap-error.js';
import { TranscodeCapacityError } from './transcoding/transcode-capacity-error.js';
import { getProcessResourceUsage, getIntelGpuVideoUsage } from './transcoding/resource-monitor.js';
import { publishJobStats, readJobStats, deleteJobStats } from './transcoding/ffmpeg-stats-cache.js';
import { publishMessage, subscribeToChannel } from '$lib/server/cache/valkey.js';
import { normalizeItemId, truncateForLog } from './hls/job-item-binding.js';
import { outputMarkerNamesItem, readOutputMarker, writeOutputMarker } from './hls/output-marker.js';
import { isPathInsideDirectory } from '$lib/server/utils/hls-segment-utils.js';
import {
    resolveHlsGenerationRoute,
    type HlsGenerationRouterAdapter,
    type SegmentGenerationRoute,
} from './hls/generation-router.js';
import { clearSeekTimestamp, setLastSeekTimestamp } from './hls/seek-cooldown-tracker.js';
import { clearSessionRequestTrackers } from './hls/segment-request-tracker.js';
import { clearSessionSeekTrace } from './hls/seek-trace-collector.js';
import {
    allocateNextGenerationIndex,
    applyRetainedGenerationSelection,
    buildGenerationOutputDir,
    createPlaybackSession,
    getMaxRetainedGenerations,
    selectRetainedGenerationsToKeep,
    touchPlaybackSession,
} from './hls/generation-coordinator.js';
import { TranscodeFileManager } from './transcoding/file-manager.js';
import {
    JELLYFIN_COMPAT_DEVICE_ID,
    isPersistablePlaySessionId,
    sessionKey,
} from './transcoding/session-key.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import { spawnFFmpegSafely } from '../utils/ffmpeg-spawn.js';
import {
    FFmpegProcessRunnerEvents,
    type ProcessLifecycleCallbacks,
} from './transcoding/process-runner.js';
import { SeekController } from './transcoding/seek-controller.js';
import { IFrameAnalyzer } from './transcoding/iframe-analyzer.js';
import { hardwareDetection } from './transcoding/hardware-detection.js';
import {
    classifyTranscodeFailure,
    formatTranscodeFailureMessage,
    isGpuEncoderSessionFailure,
    isLearnableGpuDecodeFailure,
    type TranscodeFailure,
} from './transcoding/transcode-failure-classifier.js';
import { summarizeFfmpegStderr } from './transcoding/ffmpeg-error-summary.js';
import { getPreviewCacheStore, dirSizeBytes } from './preview-cache.store.js';
import {
    recordTranscodeFailureEvent,
    type TranscodeFailureOutcome,
} from '../database/queries/transcode-failure-events.queries.js';
import { buildTranscodeEnvSnapshot } from './transcoding/env-snapshot.js';
import { assertTranscodeInputIsMedia } from './transcoding/input-guard.js';
import { prepareMediaFormatWhitelist } from '../utils/media-format-whitelist.js';
import {
    bufferAheadSeconds,
    decideThrottle,
    producedMediaSeconds,
} from './transcoding/transcode-throttle.js';
import {
    coveragePercent,
    coveredSeconds,
    currentGenerationRange,
    mergeRanges,
    rangesAsPercent,
    sessionCoveredRanges,
    type MediaRange,
} from './transcoding/transcode-coverage.js';
import { restartRateWindow } from './transcoding/live-rates.js';
import {
    restartSlowTracking,
    slowTranscodeReason,
    startSlowTracking,
    softwareFallbackPreset,
    toSoftwareDecision,
} from './transcoding/slow-transcode.js';
import {
    qualityCapForcesTranscode,
    computeCappedVideoBitrateMbps,
    computeCappedDimensions,
    computeQualityCapReservation,
    resolveDeliveredAudioTracks,
} from './transcoding/quality-cap.js';
import { uniformSegmentCount } from '$lib/server/utils/hls-segment-grid.js';
import { buildRemuxTailRunArgs, cacheTailRun } from './hls/tail-run.js';
import { storeEndSegment } from './hls/end-segment-cache.js';
import {
    buildGopGrid,
    isGopModeJob,
    gopIneligibleReason,
    resolveGopGenerationStart,
    type GopGrid,
} from './hls/gop-grid.js';
import { GopSegmentAssembler } from './hls/gop-segment-assembler.js';
import {
    GOP_AUDIO_PART_PREFIX,
    GOP_VIDEO_PART_PREFIX,
    gopAudioPartsDirName,
    gopVideoPartsDirName,
} from './transcoding/gop-output-args.js';

/**
 * `active_transcode_jobs` is shared, and the row says which subsystem owns it.
 *
 * The video pipeline is the only writer with a `transcode_decision`; music and
 * audiobooks stamp `config.type` instead (there is no video/audio action pair to
 * describe, and inventing one would put an impossible row in front of an admin).
 * Without this, `classifyTranscodeType` returns `'unknown'` for those rows and the
 * caller's `unknown → 'full'` fallback labels them **full video transcode** — a
 * correctly-typed, entirely wrong badge.
 *
 * Music is deliberately left alone here: its rows have read `'full'` since it
 * shipped, and relabelling them is a separate change with its own surface. The
 * discriminator is returned for it so the next person can see the shape.
 */
function jobConfigKind(jobConfig: unknown): 'music' | 'audiobook' | null {
    if (typeof jobConfig !== 'object' || jobConfig === null) return null;
    const type = (jobConfig as { type?: unknown }).type;
    return type === 'music' || type === 'audiobook' ? type : null;
}

/**
 * Derive display transcode type from video/audio actions.
 *
 * `videoDisabled` is checked before the `!videoAction` guard: an audio-drop
 * job has no video action to describe (there is no video stream at all), so
 * checking it after would fall through to 'unknown' — and callers map
 * 'unknown' to 'full', mislabelling an audio-only job as a full video
 * transcode.
 */
export function classifyTranscodeType(
    videoAction?: string,
    audioAction?: string,
    needsTonemapping?: boolean,
    videoDisabled?: boolean,
): 'remux' | 'audio-only' | 'full' | 'tonemapping' | 'audio-drop' | 'unknown' {
    if (videoDisabled) return 'audio-drop';
    if (!videoAction) return 'unknown';
    if (needsTonemapping) return 'tonemapping';
    if (videoAction === 'copy' && audioAction === 'copy') return 'remux';
    if (videoAction === 'copy' && audioAction === 'transcode') return 'audio-only';
    if (videoAction === 'transcode') return 'full';
    return 'unknown';
}

/**
 * Reuses {@link classifyTranscodeType}'s return type rather than a bare
 * `string`, so a typo'd mode (e.g. `'audio_drop'`) is a compile error instead
 * of silently falling through to the normal timeouts. `'other'` is added for
 * call sites (the reaper) that only need to distinguish "is this the
 * audio-drop rung" and don't have a full video/audio-action classification on
 * hand.
 */
export type ReapJobMode = ReturnType<typeof classifyTranscodeType> | 'other';

/**
 * Input to {@link shouldReapJob} — the reaper's decision reduced to the four
 * numbers/flags it actually needs, so the decision can be unit tested without
 * timers, a live job map, or the service singleton.
 */
export interface ReapCandidate {
    /** `'audio-drop'` gets the extended retention window; every other mode
     *  (including the unrelated `'audio-only'`, which still has a video
     *  stream) keeps the normal timeouts. */
    mode: ReapJobMode;
    /** Whether FFmpeg has finished remuxing all segments (no process running). */
    completed: boolean;
    progressAgeSeconds: number;
    segmentAgeSeconds: number;
}

/**
 * Resolve the progress/inactivity timeout pair (in seconds) for a reap-check
 * mode. `audio-drop` gets one extended value for both signals — see
 * {@link shouldReapJob}; every other mode gets the normal per-signal timeouts.
 *
 * Shared by `shouldReapJob` and the segment-access fallback arm in
 * `cleanupInactiveJobs` so the "which timeout applies to audio-drop" decision
 * lives in exactly one place. Callers still own how these two numbers get
 * combined — e.g. the fallback arm's `Math.min(...)` grace period vs.
 * `shouldReapJob`'s raw comparisons — those formulas are NOT part of this
 * helper and must not be collapsed into it (see the comment at the fallback
 * arm's call site).
 */
export function resolveTimeouts(mode: ReapJobMode): {
    progressTimeoutSeconds: number;
    inactivityTimeoutSeconds: number;
} {
    if (mode === 'audio-drop') {
        const t = config.FFMPEG_AUDIO_DROP_INACTIVITY_TIMEOUT_SECONDS;
        return { progressTimeoutSeconds: t, inactivityTimeoutSeconds: t };
    }
    return {
        progressTimeoutSeconds: config.FFMPEG_PROGRESS_TIMEOUT_SECONDS,
        inactivityTimeoutSeconds: config.FFMPEG_INACTIVITY_TIMEOUT_SECONDS,
    };
}

/**
 * Decides whether a job is stale enough to reap — the shared core of the
 * completed-job arm and the progress-heartbeat arm in `cleanupInactiveJobs`.
 *
 * `audio-drop` jobs (the audio-only quality rung, `-vn`) get ONE extended
 * timeout applied to BOTH signals: a tunnel stalls progress heartbeats, and a
 * satisfied deep client buffer stalls segment fetches with no tunnel at all.
 * Either signal alone must not kill the job — only both going stale past
 * `FFMPEG_AUDIO_DROP_INACTIVITY_TIMEOUT_SECONDS` does. Every other mode keeps
 * the existing per-arm semantics unchanged.
 */
/**
 * Wall-clock seconds until FFmpeg reaches the end of the file at its current
 * speed. Undefined without a speed reading or a known duration. Deliberately
 * not derived from elapsed time / percent: after a seek the percentage
 * includes media FFmpeg never encoded, which made that estimate far too short.
 */
function estimateRemainingSeconds(
    totalDurationSeconds: number,
    producedSeconds: number,
    speed: number | undefined,
): number | undefined {
    if (!(totalDurationSeconds > 0) || speed === undefined || !(speed > 0)) return undefined;
    return Math.max(0, Math.round((totalDurationSeconds - producedSeconds) / speed));
}

/** How long a segment request that had to wait keeps the throttle from pausing. */
const THROTTLE_HOLD_AFTER_WAIT_MS = 30_000;

/**
 * The coverage half of the player's progress payload, shared by the owner
 * pod's in-memory read and another pod's row + stats read so the two cannot
 * drift apart.
 */
function buildCoverageProgress(input: {
    totalDurationSeconds: number;
    segmentDurationSeconds: number;
    ranges: MediaRange[];
    encoderSeconds: number;
    speed: number | undefined;
}): Pick<
    PlayerTranscodeProgressInfo,
    | 'progressPercent'
    | 'segmentsReady'
    | 'totalSegments'
    | 'coveredRanges'
    | 'encoderPercent'
    | 'etaSeconds'
> {
    const total = input.totalDurationSeconds;
    const segmentDuration = input.segmentDurationSeconds > 0 ? input.segmentDurationSeconds : 6;
    const totalSegments = uniformSegmentCount(total, segmentDuration);
    const covered = coveredSeconds(input.ranges);
    const percent = coveragePercent(covered, total);
    return {
        progressPercent: percent,
        segmentsReady:
            percent === 100
                ? totalSegments
                : Math.min(Math.floor(covered / segmentDuration), totalSegments),
        totalSegments,
        coveredRanges: rangesAsPercent(input.ranges, total).map(([start, end]) => ({ start, end })),
        // Rounded DOWN, 100 only at the real end: the player treats 100 as
        // "finished" and stops polling, so 99.96 must not read as 100.
        encoderPercent:
            total > 0
                ? input.encoderSeconds >= total
                    ? 100
                    : Math.min(99.9, Math.floor((input.encoderSeconds / total) * 1000) / 10)
                : undefined,
        etaSeconds: estimateRemainingSeconds(total, input.encoderSeconds, input.speed),
    };
}

/** Whole seconds for the progress payload; undefined stays undefined. */
function roundAhead(seconds: number | undefined): number | undefined {
    return seconds === undefined ? undefined : Math.round(seconds);
}

export function shouldReapJob(job: ReapCandidate): boolean {
    const { progressTimeoutSeconds, inactivityTimeoutSeconds } = resolveTimeouts(job.mode);
    if (job.mode === 'audio-drop') {
        return (
            job.progressAgeSeconds > progressTimeoutSeconds &&
            job.segmentAgeSeconds > inactivityTimeoutSeconds
        );
    }
    return job.completed
        ? job.segmentAgeSeconds > inactivityTimeoutSeconds &&
              job.progressAgeSeconds > progressTimeoutSeconds
        : job.progressAgeSeconds > progressTimeoutSeconds;
}

/**
 * Input to {@link selectEvictionVictim} — reduced to the two timestamps the
 * decision actually needs, so it can be unit tested without a live job map.
 */
export interface EvictionCandidate {
    /** Last heartbeat reporting status ACTIVE (not PAUSED) — see
     *  `TranscodeJob.lastActiveProgressAt`'s doc for why PAUSED must not
     *  count here. */
    lastActiveProgressAt: Date;
    lastAccessedAt: Date;
    /** See `TranscodeJob.lastPersistedClientActivityAt`. */
    lastPersistedClientActivityAt?: Date;
}

/**
 * Picks which of several eviction-eligible jobs to sacrifice when a
 * concurrency cap (global or per-user) is reached — by whichever candidate
 * has gone longest since EITHER an active heartbeat OR a segment/playlist
 * fetch (`Math.max` of the two, then the smallest of those maxima loses).
 *
 * A single signal isn't enough on its own:
 * - `lastAccessedAt` (segment-fetch recency) alone used to be the whole
 *   sort, and picks the wrong victim whenever a client buffers minutes
 *   ahead: it goes quiet on segment requests for long stretches while still
 *   very much watching. Prod 2026-08-22 (Stromberg S2E6) lost an
 *   actively-heartbeating session to exactly this.
 * - `lastActiveProgressAt` (heartbeat recency) alone picks the wrong victim
 *   the other direction for a client whose play session never sends our
 *   heartbeat at all (e.g. a Jellyfin-compat client using Jellyfin's own
 *   session reporting) — that candidate's heartbeat timestamp never moves
 *   past job creation, so it would always look stalest and get evicted
 *   first regardless of how much it's actually streaming.
 *
 * Taking the max of the two lets either signal protect a candidate that's
 * genuinely alive, while a session that is neither heartbeating (as ACTIVE)
 * nor fetching segments — paused, backgrounded, or truly abandoned — still
 * ages normally into eviction eligibility on both.
 *
 * Returns `undefined` for an empty candidate list — callers already handle
 * "nothing evictable" as a distinct case (throw / reject the new job).
 */
export function selectEvictionVictim<T extends EvictionCandidate>(
    candidates: readonly T[],
): T | undefined {
    return [...candidates].sort((a, b) => lastLiveActivityAt(a) - lastLiveActivityAt(b))[0];
}

/**
 * The most recent moment a candidate showed ANY sign of life: an active
 * heartbeat or a segment/playlist fetch. See `selectEvictionVictim` for why
 * both signals are needed.
 */
function lastLiveActivityAt(c: EvictionCandidate): number {
    return Math.max(
        c.lastActiveProgressAt.getTime(),
        c.lastAccessedAt.getTime(),
        c.lastPersistedClientActivityAt?.getTime() ?? 0,
    );
}

/**
 * A job that got a client heartbeat on this pod within this window is
 * heartbeating here; older than that, its client's heartbeats (30s apart) are
 * landing on another pod, and the reaper copies the DB row's activity in.
 */
const CROSS_POD_HEARTBEAT_GRACE_MS = 90_000;

/**
 * Narrows global-cap eviction candidates to those idle (no active heartbeat AND
 * no segment fetch) for at least `minIdleSeconds`.
 *
 * `selectEvictionVictim` decides WHICH job dies; this decides whether ANY job
 * may. Without it, reaching the cap killed the idlest job however recently it
 * was active, so a viewer mid-episode lost their stream the moment someone else
 * pressed play. Worse, the victim's client recovers by rebuilding onto a NEW
 * play session, which needs a slot and evicts the next live viewer: a cascade
 * that lasts as long as the server sits at its cap (iOS native HLS feels it
 * first, it can only escalate to a full rebuild).
 *
 * `minIdleSeconds <= 0` disables the floor (legacy always-evict behaviour).
 */
export function filterEvictableByIdle<T extends EvictionCandidate>(
    candidates: readonly T[],
    minIdleSeconds: number,
    now: number = Date.now(),
): T[] {
    if (!(minIdleSeconds > 0)) return [...candidates];
    const cutoff = now - minIdleSeconds * 1000;
    return candidates.filter((c) => lastLiveActivityAt(c) <= cutoff);
}

/**
 * Resolves the base output directory for a job's generation-0 output.
 *
 * When `jobConfig.outputDir` is set (preview-cache-backed jobs), that exact
 * directory is used instead of the derived per-session dir under
 * `FFMPEG_TRANSCODE_DIR` — the PreviewCacheStore owns that directory's
 * lifecycle (see preview-cache.store.ts), so FFmpeg must write directly into
 * it rather than nesting a generation subfolder inside it. Exported as a
 * standalone pure function (rather than a class method) so it can be unit
 * tested without instantiating the service.
 *
 * C1 backstop: `startHlsPlayback` validates `playSessionId` against
 * `SAFE_PLAY_SESSION_ID_RE` before it ever reaches here, but that is a SEPARATE
 * guard at a different call site — a future caller that forgets to validate
 * (or a value that reaches this function some other way) must not be able to
 * escape `FFMPEG_TRANSCODE_DIR` via `..` segments. `path.join` normalizes
 * `..` rather than rejecting it, so the containment check is independent and
 * unconditional for the derived-path branch. This also covers the delete
 * path: `getSessionOutputDir` (used by both `stopJob` and the inactivity
 * reaper before `fs.rm`) calls this same function, so a caller that reaches
 * `fs.rm` through that path is covered too. The `outputDir` override branch
 * is intentionally NOT checked against `FFMPEG_TRANSCODE_DIR` — that
 * directory legitimately lives under `PREVIEW_CACHE_DIR` instead, a separate
 * tree the PreviewCacheStore owns and is responsible for confining.
 *
 * `isPathInsideDirectory` treats EQUAL paths as "inside" (see its own doc
 * comment), which is correct for a file-containment check but wrong here:
 * `playSessionId: '.'` or `''` makes `path.join` yield `FFMPEG_TRANSCODE_DIR`
 * itself, and returning the transcode ROOT as a session's output dir means
 * the delete path (`getSessionOutputDir` -> `deleteOutputDirectory` ->
 * `fs.rm(dir, { recursive: true, force: true })`) would wipe every live
 * session for every user, not just an escape outside it. So this function
 * additionally rejects the dir being equal to the base — a session's output
 * dir must be strictly INSIDE FFMPEG_TRANSCODE_DIR, never the root itself.
 */
export function resolveOutputBaseDir(
    jobConfig: Pick<TranscodeJobConfig, 'playSessionId' | 'outputDir'>,
): string {
    if (jobConfig.outputDir !== undefined) {
        return jobConfig.outputDir;
    }
    const dir = path.join(config.FFMPEG_TRANSCODE_DIR, jobConfig.playSessionId);
    const isEqualToRoot = path.relative(config.FFMPEG_TRANSCODE_DIR, dir) === '';
    if (isEqualToRoot || !isPathInsideDirectory(dir, config.FFMPEG_TRANSCODE_DIR)) {
        throw new Error(
            `resolveOutputBaseDir: playSessionId escapes FFMPEG_TRANSCODE_DIR: ${jobConfig.playSessionId}`,
        );
    }
    return dir;
}

// Re-exported: importers (and tests) have always taken them from here.
export { sessionKey, isPersistablePlaySessionId };

/**
 * How many segments before the seek target the promoted generation starts.
 *
 * Two effects stack, and the preroll has to span both:
 *  1. AVPlayer primes the AAC decoder across a splice by fetching the audio
 *     segment BEFORE the seek point — a forward seek to N draws a request for N-1.
 *  2. In demux, audio and video are fetched independently and audio runs BEHIND.
 *     Measured on prod: video had reached segment 83 while audio was still
 *     pulling 78..81, so a seek triggered at video 83 left audio needing 81.
 *
 * With a one-segment preroll the generation started at 82 and audio 81 existed
 * in no generation at all — the outgoing one never got that far — so playback
 * ran for about two segments and then stalled on a missing_404.
 *
 * Two segments covers priming plus one segment of A/V skew. The cost is ~6s more
 * encoding per seek, which is nothing against a transcode running ~7x realtime.
 */
const SEEK_PREROLL_SEGMENTS = 2;

/**
 * How far before the requested segment a RESTORE restarts FFmpeg.
 *
 * Wider than `SEEK_PREROLL_SEGMENTS` because the two situations differ. A seek
 * restarts BOTH streams at the target, so two segments covers decoder priming
 * plus a segment of slack. A restore interrupts LINEAR playback, where audio
 * trails video — prod measured video at segment 83 while audio was still pulling
 * 78..81 — and the restore is triggered by whichever stream misses first, which
 * is normally video because it fetches ahead.
 *
 * Resuming only two segments back can therefore start AHEAD of segments audio
 * still needs, and audio cannot rescue itself: `canStreamTriggerSeekForJob`
 * refuses to seek for audio streams, so a segment below the generation's offset
 * that no longer exists on disk is never produced and the request 404s for good.
 * Six segments covers the measured skew with margin, and at the ~0.13s/segment
 * this transcode sustains it costs well under a second of extra encoding.
 */
const RESTORE_PREROLL_SEGMENTS = 6;

/**
 * Where should the generation promoted by a forward seek actually start?
 *
 * Seeking to segment N used to start the new generation exactly at N. But the
 * player asks for audio segment N-1 to prime its decoder, and the outgoing
 * generation has usually produced nothing near N (it was still transcoding from
 * the old position), so N-1 existed in NO generation and 404'd forever. Video
 * played, audio never arrived, and the player hung — visible in the logs as
 * `missing_404` on the audio stream with `requestedSegment` one below
 * `segmentOffset`.
 *
 * Starting one segment early makes N-1 real. Audio and video must shift
 * together: their offsets both derive from `startTimeSeconds` (see
 * `getStreamSegmentOffsetForJob`), and AVPlayer matches demuxed streams by
 * segment NUMBER, so moving one stream alone would desync them.
 *
 * Copy-mode video is left exactly as it was: there, segment↔time is a keyframe
 * mapping rather than a multiply (`alignToKeyframeSegmentStart`), so shifting
 * the start time by a grid amount would break that correspondence.
 *
 * KNOWN GAP: that also means demux copy/remux sessions keep the original bug.
 * They usually escape it by accident — keyframe alignment pulls the start time
 * back to the previous keyframe, which often lands the audio offset on N-1
 * anyway — but when the keyframe sits inside the same segment bucket as the
 * target, audio N-1 still 404s. Fixing that needs a preroll of one KEYFRAME
 * segment, not a grid shift.
 */
export function resolveSeekGenerationStart(
    targetSegment: number,
    segmentDurationSeconds: number,
    opts: {
        isCopyModeVideo: boolean;
        alignedSeekTimeSeconds: number;
        /** Segments to start early. Defaults to the seek preroll; a RESTORE
         *  interrupts linear playback and needs a wider one — see
         *  `RESTORE_PREROLL_SEGMENTS`. */
        prerollSegments?: number;
    },
): { startSegment: number; startTimeSeconds: number } {
    // NaN passes every `<=` comparison, so test for a usable number explicitly
    // rather than relying on the range checks below — a NaN reaching
    // job.segmentOffset would become a malformed FFmpeg -start_number.
    const usable =
        Number.isFinite(targetSegment) &&
        Number.isFinite(segmentDurationSeconds) &&
        targetSegment > 0 &&
        segmentDurationSeconds > 0;
    if (opts.isCopyModeVideo || !usable) {
        return {
            // Clamp even on the passthrough: a negative offset would also reach
            // FFmpeg as -start_number.
            startSegment: Number.isFinite(targetSegment) ? Math.max(0, targetSegment) : 0,
            startTimeSeconds: opts.alignedSeekTimeSeconds,
        };
    }

    const startSegment = Math.max(
        0,
        targetSegment - (opts.prerollSegments ?? SEEK_PREROLL_SEGMENTS),
    );
    // Snap to the grid so the offset derived from this time (floor(t / dur))
    // lands back on `startSegment`. Starting marginally earlier than an
    // off-grid request is harmless — a preroll starts early by design.
    const startTimeSeconds = startSegment * segmentDurationSeconds;

    // Self-check rather than trust the arithmetic: per-stream offsets are
    // RE-DERIVED elsewhere as floor(t / dur), and for a fractional duration
    // float rounding can land that a segment below `startSegment` (e.g.
    // 45 * 6.006 / 6.006 floors to 44). Audio and video would then sit on
    // different offsets — the 200+ second desync the code warns about. If the
    // grid does not round-trip, skip the preroll instead of risking it.
    if (Math.floor(startTimeSeconds / segmentDurationSeconds) !== startSegment) {
        return { startSegment: targetSegment, startTimeSeconds: opts.alignedSeekTimeSeconds };
    }

    return { startSegment, startTimeSeconds };
}

/**
 * Where a RESTORED job should tell FFmpeg to start, given the segment whose
 * request triggered the restore.
 *
 * A restore used to rerun FFmpeg from the persisted offset — normally 0 —
 * regardless of where the viewer actually was, then block the request until
 * production caught up. Prod 2026-08-28 measured the cost exactly: the restored
 * remux emitted 133 segments in 17s (~0.13s each), so reaching the requested
 * segment 65 took `waitMs: 8018`. That eight seconds WAS the visible freeze, and
 * all of it went on regenerating content the client had already played.
 *
 * Restricted to explicitly TRANSCODED video on purpose. `FullTranscodeStrategy` passes
 * `startNumber: !isVideoCopy ? config.startNumber : undefined`:
 *  - transcode → `-start_number N`, so FFmpeg writes `segment_000NN.m4s` at the
 *    manifest's own index. Resuming is purely ADDITIVE to the segments already
 *    on disk, and the served playlist is synthesized from segment 0 across the
 *    full timeline anyway (see the manifestStartSegment note in the segment
 *    handler), so nothing about the earlier range changes.
 *  - copy → no `-start_number`, so FFmpeg renumbers from 0 and would overwrite
 *    `segment_00000.m4s` of the very output still being served. Copy mode also
 *    needs keyframe alignment (`alignToKeyframeSegmentStart`), which this
 *    uniform-grid resume does not do. Both reasons say: leave it alone. (A
 *    restored job does carry `keyframeData`: it rides in the persisted config.)
 *
 * Returns `undefined` when the persisted offset should stand — including when the
 * restore is already at or past the request, so this can only ever move FORWARD.
 */
export function resolveRestoreResumeStart(opts: {
    requiredSegmentIndex: number | undefined;
    persistedSegmentOffset: number;
    segmentDurationSeconds: number;
    /** True ONLY when the persisted decision explicitly says the video is
     *  transcoded — see the opt-in note below. */
    isVideoTranscoded: boolean;
}): { startSegment: number; startTimeSeconds: number } | undefined {
    // Legacy rows without a decision can describe copied output. Resume only
    // when the effective contract explicitly uses absolute transcode numbering.
    if (!opts.isVideoTranscoded) return undefined;
    if (!Number.isFinite(opts.requiredSegmentIndex)) return undefined;
    // Not merely nullish: a persisted 0 survives `??` and would make
    // alignedSeekTimeSeconds 0 while the index still passes, resuming FFmpeg at
    // t=0 but numbering its files from the target — the whole timeline shifted.
    if (!Number.isFinite(opts.segmentDurationSeconds) || opts.segmentDurationSeconds <= 0) {
        return undefined;
    }

    const target = opts.requiredSegmentIndex as number;
    if (target <= opts.persistedSegmentOffset) return undefined;

    const resume = resolveSeekGenerationStart(target, opts.segmentDurationSeconds, {
        isCopyModeVideo: false,
        alignedSeekTimeSeconds: target * opts.segmentDurationSeconds,
        prerollSegments: RESTORE_PREROLL_SEGMENTS,
    });

    // resolveSeekGenerationStart can decline the preroll (fractional-duration
    // round-trip) and hand back the bare target; either way, never move backwards.
    if (resume.startSegment <= opts.persistedSegmentOffset) return undefined;
    return resume;
}

/**
 * Has the requested MUXED audio track actually changed?
 *
 * `HlsOutputConfig.hlsAudioTrackIndex` is documented as "default: first/default
 * track", and `FullTranscodeStrategy` resolves an absent value with
 * `?? defaultAudioAbsoluteIndex(audioTracks)`. So a job started without the
 * param is muxing the file's DEFAULT track — it is not in an indeterminate
 * state, and comparing the raw `undefined` against an explicit index reads
 * "unknown" where the system means "the default".
 *
 * That misreading tore down a healthy job to restart it on the track it was
 * already muxing. The restart is not free: on a copy/remux stream it retires the
 * FFmpeg generation, keyframe-aligns BACKWARD (prod: 3.157s requested -> 0.5s
 * aligned) and makes the client refetch from the new generation's first segment.
 *
 * Reachable via the Jellyfin-compat route, which is a by-design producer of the
 * transition: `/j/Videos/[itemId]/master.m3u8` parses `AudioStreamIndex` as
 * OPTIONAL, defaults `hlsAudioMode` to 'muxed' and reuses the client's
 * `PlaySessionId`, so a client that requests without the param and then
 * re-requests with `AudioStreamIndex=<the default>` hits it exactly. tvOS sends
 * no audio-index param at all, so its jobs always hold `undefined` here.
 *
 * Deliberately asymmetric: an omitted index still reports "no change" rather
 * than "switch to the default", so a client re-requesting its playlist without
 * the param can never newly provoke a restart.
 */
export function hasAudioTrackChanged(
    existing: Pick<TranscodeJobConfig, 'hlsOutput' | 'audioTracks'>,
    next: Pick<TranscodeJobConfig, 'hlsOutput' | 'audioTracks'>,
): boolean {
    const requested = next.hlsOutput?.hlsAudioTrackIndex;
    if (requested === undefined) return false;

    // Demux jobs deliver every audio track as its own rendition; the index only
    // picks the master's DEFAULT (the web player sends it in demux too). A
    // different index is not a different stream, so never restart for it.
    if (next.hlsOutput?.hlsAudioMode === 'demux' && existing.hlsOutput?.hlsAudioMode === 'demux') {
        return false;
    }

    const existingIndex = existing.hlsOutput?.hlsAudioTrackIndex;
    if (existingIndex !== undefined) return existingIndex !== requested;

    // No explicit index on the running job: resolve what it is ACTUALLY muxing,
    // using the same expression as the three sites in FullTranscodeStrategy.
    const tracks = existing.audioTracks ?? [];
    // Nothing to resolve against — keep the old conservative answer rather than
    // reuse a job whose audio cannot be reasoned about.
    if (tracks.length === 0) return true;
    return defaultAudioAbsoluteIndex(tracks) !== requested;
}

/**
 * Does an incoming request describe a stream the existing FFmpeg job cannot serve?
 *
 * Called when a play session already has a running job: `true` tears it down and
 * re-spawns FFmpeg, `false` reuses what is already producing segments.
 *
 * The subtitle-burn-in clause is easy to miss. Burn-in is composited into the
 * video frames, so changing WHICH subtitle is burned — or turning it off — needs
 * a re-encode. No other field here moves when only the subtitle index changes:
 * `videoInfo.isTranscoded` is already `true` on both sides, and the codecs are
 * identical. Without the clause the job is reused and the ORIGINAL subtitle stays
 * welded into the stream for the rest of the session, so picking a different
 * track (or switching subtitles off) silently does nothing.
 *
 * The same defect class applies to `videoDisabled`: toggling the audio-only
 * rung on a session with an already-running job would otherwise return
 * `false` here, reuse the existing (video-carrying, or video-dropped) job,
 * and the switch would silently do nothing.
 *
 * `itemId` (fix plan 6, C1): compared normalized (`normalizeItemId` folds a
 * dashed/dashless UUID respelling to the same string) so a client that
 * re-fetches a master under the SAME `PlaySessionId` with a differently
 * spelled — but equal — id (a `/j` client switching between the dashed
 * `TranscodingUrl` and a dashless `/Videos/{id}/master.m3u8`, or a case
 * change) still reuses the job. A genuine item change under one session id
 * (two items that share one underlying file) now recreates the job instead
 * of silently inheriting the old `config.itemId` — which is the job->item
 * binding the segment handler and job-restoration.ts key their access
 * decision on (`services/hls/job-item-binding.ts`); leaving a stale itemId
 * on a reused job would let it keep answering to the wrong item's URL.
 *
 * EXCEPT for a cache-backed preview artifact (`config.cacheKey` set on either
 * side): those are keyed by FILE, not item — `config.itemId` is whichever
 * viewer most recently (re-)warmed the shared artifact, never a per-session
 * identity, and `media_file_items` is M:N (two DIFFERENT items can legitimately
 * share one artifact). Comparing itemId there is not just wrong, it is
 * actively destructive: `ensureArtifactJobResident`
 * (`preview-session.service.ts`) checks residency OUTSIDE the per-session
 * start lock, so two concurrent viewers of different items sharing one file
 * can both observe "no job" and both call `startJob`; the second call would
 * see the first's live job with a different `itemId`, treat it as changed,
 * `stopJob('playback_config_changed')` it, and the killed FFmpeg's non-zero
 * exit triggers `markFailed(cacheKey)` — DELETING the artifact directory out
 * from under BOTH viewers. Muxed artifacts (all previews since 2026-08-26)
 * have no on-disk master.m3u8, so this re-warm path runs on every reaped
 * muxed artifact, not just a rare race. The job->item BINDING for an artifact
 * is the viewer's own `PreviewSession.itemId` (see job-item-binding.ts /
 * `checkJobItemBinding` in the segment handler), never `config.itemId` —
 * fix plan 6, C1 fix round 1, Important #1.
 */
export function hasPlaybackConfigChanged(
    existing: TranscodeJobConfig,
    next: TranscodeJobConfig,
): boolean {
    const isArtifactJob = Boolean(existing.cacheKey || next.cacheKey);
    return (
        (!isArtifactJob && normalizeItemId(existing.itemId) !== normalizeItemId(next.itemId)) ||
        existing.fileId !== next.fileId ||
        existing.inputUrl !== next.inputUrl ||
        existing.planHints?.targetVideoCodec !== next.planHints?.targetVideoCodec ||
        existing.planHints?.targetAudioCodec !== next.planHints?.targetAudioCodec ||
        existing.videoInfo?.outputCodec !== next.videoInfo?.outputCodec ||
        existing.videoInfo?.isTranscoded !== next.videoInfo?.isTranscoded ||
        existing.forceAudioTranscode !== next.forceAudioTranscode ||
        existing.hlsOutput?.hlsAudioMode !== next.hlsOutput?.hlsAudioMode ||
        existing.subtitleBurnIn?.absoluteIndex !== next.subtitleBurnIn?.absoluteIndex ||
        existing.videoDisabled !== next.videoDisabled ||
        existing.qualityCap?.maxBitrate !== next.qualityCap?.maxBitrate ||
        existing.qualityCap?.maxHeight !== next.qualityCap?.maxHeight ||
        existing.maxAudioChannels !== next.maxAudioChannels
    );
}

/** Resolve request requirements and freeze video/HDR before exposing any grid. */
async function computeEffectivePlan(
    jobConfig: TranscodeJobConfig,
    inputDecision: TranscodeDecision | undefined,
): Promise<EffectiveTranscodePlan> {
    const decision: TranscodeDecision = inputDecision
        ? structuredClone(inputDecision)
        : {
              mode: 'full',
              reasons: 0,
              videoAction: 'copy',
              audioAction: 'copy',
              useGpu: false,
              needsTonemapping: false,
              preserveHdr10: false,
          };
    const requested = jobConfig.videoInfo?.outputCodec?.toLowerCase();
    const codecChange = !!requested && requested !== jobConfig.videoInfo?.codec?.toLowerCase();
    const capped = qualityCapForcesTranscode(
        jobConfig.qualityCap,
        jobConfig.videoInfo?.height,
        jobConfig.mediaSourceInfo?.bitrate,
        jobConfig.playbackPlan?.quality_cap,
    ).force;
    // Every copy→transcode flip needs the normal codec-aware encoder selection,
    // including burn-in. Copy decisions carry no encoder or GPU selection.
    const wasCopy = decision.videoAction === 'copy';
    const chooseEncoder =
        wasCopy &&
        !jobConfig.videoDisabled &&
        (!!jobConfig.subtitleBurnIn || codecChange || capped || decision.needsTonemapping);
    if (
        wasCopy &&
        (jobConfig.videoDisabled
            ? !!inputDecision
            : jobConfig.subtitleBurnIn || codecChange || capped || decision.needsTonemapping)
    ) {
        decision.videoAction = 'transcode';
    }
    if (chooseEncoder) {
        const family = codecChange
            ? requested.includes('265') || requested.includes('hevc')
                ? 'hevc'
                : requested.includes('av1')
                  ? 'av1'
                  : 'h264'
            : undefined;
        await transcodeDecision.assignEncoderForFlippedTranscode(
            decision,
            {
                codec: jobConfig.videoInfo?.codec,
                is10Bit: (jobConfig.videoInfo?.bitDepth ?? 8) > 8,
            },
            family,
        );
    }
    if (
        chooseEncoder ||
        (!inputDecision && !jobConfig.videoDisabled && decision.videoAction === 'transcode')
    ) {
        const requiredTonemap = decision.needsTonemapping;
        // Legacy/unprobed callers still carry the source range in videoInfo.
        const videoStream =
            jobConfig.mediaSourceInfo?.streams.find((stream) => stream.type === 'Video') ??
            (jobConfig.videoInfo
                ? {
                      index: 0,
                      type: 'Video' as const,
                      videoRange: jobConfig.videoInfo.videoRange,
                      videoRangeType: jobConfig.videoInfo.videoRangeType,
                  }
                : undefined);
        transcodeDecision.assignHdrForFlippedTranscode(
            decision,
            videoStream,
            jobConfig.playbackPlan?.client_hdr_formats,
        );
        if (requiredTonemap) {
            decision.needsTonemapping = true;
            decision.preserveHdr10 = false;
            decision.outputVideoRange = 'SDR';
        }
    }
    const plan = planStandaloneTranscode({
        decision,
        videoInfo: jobConfig.videoInfo,
        videoDisabled: jobConfig.videoDisabled,
        subtitleBurnIn: jobConfig.subtitleBurnIn,
        burnInHdrStrategy: config.HLS_BURN_IN_HDR_STRATEGY,
        gpuAcceleration: jobConfig.softwareEncodeFallback ? 'none' : config.GPU_ACCELERATION,
        segmentDuration: jobConfig.segmentDurationSeconds ?? serviceConfig.FFMPEG_SEGMENT_DURATION,
        startTimeSeconds: jobConfig.startTimeSeconds,
        maxWidth: 0,
        maxHeight: 0,
        videoBitrateMbps: config.VIDEO_BITRATE_MBPS,
        tonemappingAlgorithm: config.TONEMAPPING_ALGORITHM,
    });
    // A legacy caller without probe/plan data uses the duration-based stream
    // authority heuristic. Preserve that absence when no requirement changed
    // video; the effective contract still explicitly records its copy action.
    if (!inputDecision && (plan.video.action === 'copy' || plan.video.action === 'drop'))
        plan.decision = undefined;
    return plan;
}

/**
 * Freeze admin MAX_WIDTH/MAX_HEIGHT/VIDEO_BITRATE_MBPS for the whole job,
 * including later seek generations and restores. New jobs pick up admin changes.
 * Only a muxed track replacement recalculates audio reservation/video share,
 * using the saved total budget and server bitrate rather than current settings.
 */
function computeEffectiveCaps(
    jobConfig: TranscodeJobConfig,
    decision: TranscodeDecision | undefined,
): EffectiveTranscodePlan['caps'] {
    let { maxWidth, maxHeight } = computeMaxDimensions(decision, jobConfig.videoInfo?.height, {
        downscaleCpuTo1080p:
            config.TRANSCODE_DOWNSCALE_CPU_TO_1080P && !jobConfig.softwareEncodeFallback,
        defaultMaxWidth: config.MAX_WIDTH,
        defaultMaxHeight: config.MAX_HEIGHT,
    });
    const dimensions = computeCappedDimensions(
        jobConfig.videoInfo?.width,
        jobConfig.videoInfo?.height,
        jobConfig.qualityCap,
        config.MAX_HEIGHT > 0 ? config.MAX_HEIGHT : undefined,
    );
    if (dimensions) {
        maxWidth = dimensions.width;
        maxHeight = dimensions.height;
    }
    const active = !!jobConfig.qualityCap && decision?.videoAction === 'transcode';
    const { effectiveBudgetBps, audioReservationBps } = active
        ? computeQualityCapReservation(
              jobConfig.qualityCap,
              jobConfig.videoInfo?.height,
              config.MAX_HEIGHT > 0 ? config.MAX_HEIGHT : undefined,
              !jobConfig.forceAudioTranscode && decision?.audioAction === 'copy',
              resolveDeliveredAudioTracks(
                  jobConfig.audioTracks,
                  jobConfig.hlsOutput?.hlsAudioMode,
                  jobConfig.hlsOutput?.hlsAudioTrackIndex,
              ).map((track) => track.bitrate),
          )
        : { effectiveBudgetBps: undefined, audioReservationBps: undefined };
    return {
        maxWidth,
        maxHeight,
        videoBitrateMbps: config.VIDEO_BITRATE_MBPS,
        qualityCapAudioReservationBps: audioReservationBps,
        qualityCapTotalBudgetBps: effectiveBudgetBps,
        maxVideoBitrateMbps:
            jobConfig.isPreview && config.PREVIEW_MAX_VIDEO_BITRATE_MBPS > 0
                ? config.PREVIEW_MAX_VIDEO_BITRATE_MBPS
                : computeCappedVideoBitrateMbps(
                      effectiveBudgetBps,
                      audioReservationBps,
                      config.VIDEO_BITRATE_MBPS,
                  ),
    };
}

/**
 * Effective output dimension cap for a transcode.
 *
 * Honors the admin setting TRANSCODE_DOWNSCALE_CPU_TO_1080P: when the host has
 * NO GPU and is re-encoding (videoAction='transcode') a source taller than
 * 1080p, cap the output to 1080p. A 4K CPU encode (especially HDR/Dolby Vision)
 * typically runs below real time and can't sustain HLS playback, so downscaling
 * keeps it playable. An explicit, SMALLER admin MAX_WIDTH/MAX_HEIGHT is
 * preserved (we only ever lower the cap, never raise it). GPU paths and
 * copy/remux are unaffected (returns the configured defaults).
 */
export function computeMaxDimensions(
    decision: { useGpu: boolean; videoAction: string } | undefined,
    sourceHeight: number | undefined,
    opts: {
        downscaleCpuTo1080p: boolean;
        defaultMaxWidth: number;
        defaultMaxHeight: number;
    },
): { maxWidth: number; maxHeight: number; downscaled: boolean } {
    const { downscaleCpuTo1080p, defaultMaxWidth, defaultMaxHeight } = opts;
    if (
        downscaleCpuTo1080p &&
        decision &&
        !decision.useGpu &&
        decision.videoAction === 'transcode' &&
        (sourceHeight ?? 0) > 1080
    ) {
        return {
            maxWidth: defaultMaxWidth > 0 ? Math.min(defaultMaxWidth, 1920) : 1920,
            maxHeight: defaultMaxHeight > 0 ? Math.min(defaultMaxHeight, 1080) : 1080,
            downscaled: true,
        };
    }
    return {
        maxWidth: defaultMaxWidth,
        maxHeight: defaultMaxHeight,
        downscaled: false,
    };
}

// Re-export types for backward compatibility with existing imports
export type {
    TranscodeJob,
    TranscodeJobConfig,
    IFrameEntry,
    TranscodeJobStatus,
    VodManifestInfo,
    FFmpegJobInfo,
};
export {
    selectSegmentGenerationCandidate,
    type SegmentGenerationCandidate,
    type SegmentGenerationCandidateSelection,
    type SegmentGenerationFileMiss,
    type SegmentGenerationRoute,
    type SegmentGenerationRouteReason,
} from './hls/generation-router.js';

const logger = Logger.for('FFmpegTranscodeService');

/** Cross-pod "stop this play session" broadcast (payload: {playSessionId, reason}). */
const TRANSCODE_STOP_CHANNEL = 'transcode:stop:v1';

/**
 * How long a parked-unwatched generation waits for the client to come back,
 * from the moment it was parked. Longer than the retained-generation TTL: a
 * 4K burn-in probe of segments 0 and 1 alone takes ~17 s, and a parked job is
 * never accessed, so the plain TTL would retire it right before the jump.
 */
const PARKED_UNWATCHED_TTL_MS = 60_000;
const serviceConfig = config;
/** How long a GOP-mode break keeps a title on the legacy cut. */
const GOP_TRIP_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Longest a completed UUID job may sit idle (no heartbeat, progress or segment
 * fetch seen by THIS pod) before the reaper drops it even though the client-
 * lease lookup is failing. Normally a failed lookup defers the reap, because a
 * paused viewer's only heartbeat can land on another pod; during a long
 * database outage that deferral would keep every finished job's segments on
 * disk until the cache fills. Matches the 1 h in-memory TTL of errored jobs.
 */
const COMPLETED_JOB_LOOKUP_FAILED_MAX_IDLE_MS = 60 * 60 * 1000;

/**
 * Delay before the single transparent retry of a GPU transcode that hit a
 * decode surface mismatch. A short pause lets a concurrent encode session / VRAM
 * held by another transcode release before the retry contends for the GPU again,
 * so a transient busy-GPU stall recovers with hardware decode intact instead of
 * escalating into a (false) learned decode incapability. See handleExit.
 */
const GPU_DECODE_RETRY_BACKOFF_MS = 2000;

// ============================================================================
// Service Implementation
// ============================================================================

class FFmpegTranscodeService {
    /** Active transcode jobs by job ID */
    private jobs: Map<string, TranscodeJob> = new Map();
    /** Playback sessions keyed by playSessionId */
    private sessions: Map<string, PlaybackSession> = new Map();
    /** Map playSessionId -> current jobId for lookups */
    private jobsByPlaySession: Map<string, string> = new Map();
    /** Map playSessionId -> retained previous jobId */
    private previousJobsByPlaySession: Map<string, string> = new Map();
    /** Cleanup interval timer */
    private cleanupInterval: ReturnType<typeof setInterval> | null = null;
    /** Segment cleanup interval timer */
    private segmentCleanupInterval: ReturnType<typeof setInterval> | null = null;
    /** Stats publish interval timer — writes CPU/RAM to Valkey for cross-pod visibility */
    private statsPublishInterval: ReturnType<typeof setInterval> | null = null;
    /** Transcode throttle tick — pauses/resumes FFmpeg by its lead over the player */
    private throttleInterval: ReturnType<typeof setInterval> | null = null;
    /**
     * Reentrancy guards for the periodic timers. Under NFS latency a single cleanup
     * pass (fs.readdir/unlink over the transcode dir) can exceed its interval; without
     * these, overlapping ticks pile up and compound the fs-request storm rather than
     * backing off. Each timer skips its tick if the previous one is still running.
     */
    private cleanupInactiveRunning = false;
    private segmentCleanupRunning = false;
    private statsPublishRunning = false;
    /** Whether service is shutting down */
    private isShuttingDown = false;
    /** True while the cleanup sweep's job-status lookup is failing; gates the once-per-transition log. */
    private jobLookupFailing = false;
    /** Promise that resolves when startup cleanup is complete */
    private startupCleanupPromise: Promise<void>;
    /** Transcode strategies */
    private fullStrategy = new FullTranscodeStrategy();
    /** Database persistence service for job recovery; resolved on first use. */
    private persistenceInstance: TranscodeJobPersistenceService | null = null;

    /**
     * Resolved lazily, NOT in the constructor.
     *
     * `new TranscodeJobPersistenceService()` throws outright when `getDb()` is
     * null ('AI database not configured'). Building it in the constructor made
     * merely CONSTRUCTING this service require a database, which broke 72 unit
     * tests in CI — every one of them failing inside `new FFmpegTranscodeService`
     * before it reached its own subject. CI's unit job has never set
     * DATABASE_URL (only TEST_DATABASE_URL, and only for integration), while a
     * local `.env` supplies one, so the suite passed locally and failed in CI
     * for a day without the divergence being visible from either side.
     *
     * Deferring the resolution also lets the callers' EXISTING error handling do
     * its job: `clearStaleTranscodeDirectories` already catches this and logs
     * 'Skipping startup transcode cleanup', which is the correct degraded
     * behaviour and was simply unreachable — the constructor threw first.
     */
    private get persistence(): TranscodeJobPersistenceService {
        this.persistenceInstance ??= getTranscodeJobPersistenceService();
        return this.persistenceInstance;
    }
    /** File manager for directory and segment operations */
    private fileManager = new TranscodeFileManager();
    /** Process runner for FFmpeg lifecycle management (event-based) */
    private processRunner = new FFmpegProcessRunnerEvents();
    /** Seek controller for seeking logic */
    private seekController = new SeekController(this.fileManager);
    /** I-frame analyzer for Apple TV support */
    private iframeAnalyzer = new IFrameAnalyzer();
    /** Optional one-shot callbacks fired when stopJob() removes a session. Keyed by the folded sessionKey(). */
    private sessionStopCallbacks: Map<string, () => void> = new Map();
    /**
     * Per-playSessionId serialization chain for startJob(). Concurrent start
     * requests for the SAME session (Safari/native-HLS re-requesting to apply saved
     * audio/subtitle prefs, or a client retry on a slow first response) would each
     * pass the "no existing job" check and spawn a separate FFmpeg process — the
     * loser becomes unreachable from jobsByPlaySession and leaks its process/disk
     * for the life of the pod. Serializing per session makes the second caller see
     * the job the first registered and reuse/supersede it instead.
     */
    private sessionStartChains: Map<string, Promise<unknown>> = new Map();
    /**
     * Serializes the global-cap admission decision (count → evict → reserve) so
     * concurrent starts for DIFFERENT sessions can't both read the same count, both
     * evict the same LRU victim (only one is actually removed), and both still add a
     * job — which lets LUMASTRA_MAX_CONCURRENT_TRANSCODES be exceeded under a burst.
     */
    private globalAdmissionChain: Promise<unknown> = Promise.resolve();
    /**
     * Slots reserved by starts that passed the global cap but haven't registered
     * their job in `this.jobs` yet. Counted alongside committed jobs during admission
     * so a concurrent start sees them; released once the job registers or the start fails.
     */
    private reservedSlots = 0;

    /** Listener for cross-pod stops (TRANSCODE_STOP_CHANNEL); see ensureStopSubscription. */
    private stopSubscription: Promise<void> | null = null;
    private stopUnsubscribe: (() => Promise<void>) | null = null;

    constructor() {
        setPlaybackCountsProvider(() => this.playbackCpuCounts());
        // NOTE: persistence is deliberately NOT resolved here — see the getter.
        // Clear stale transcode files from previous run
        // (app may have crashed/restarted without cleanup)
        // Store the promise so startJob can wait for it
        this.startupCleanupPromise = this.clearStaleTranscodeDirectories();

        // Cleanup orphaned jobs from this pod (Kubernetes restart scenario)
        this.cleanupOrphanedJobs().catch((err) => {
            logger.error('Failed to cleanup orphaned jobs', err as Error);
        });

        // Start cleanup intervals. Each tick is skipped if the previous one for the
        // same job is still in flight (see the *Running guards) so slow NFS passes
        // don't overlap and pile up.
        this.cleanupInterval = setInterval(() => {
            // A pod that has jobs but no stop listener (Valkey was down when its
            // first job started) retries the subscription here.
            if (this.jobs.size > 0) this.ensureStopSubscription();
            if (this.cleanupInactiveRunning) return;
            this.cleanupInactiveRunning = true;
            void this.cleanupInactiveJobs().finally(() => {
                this.cleanupInactiveRunning = false;
            });
        }, 30000);

        // Segment cleanup runs more frequently for responsive disk management
        this.segmentCleanupInterval = setInterval(() => {
            if (this.segmentCleanupRunning) return;
            this.segmentCleanupRunning = true;
            void this.cleanupOldSegmentsForAllJobs().finally(() => {
                this.segmentCleanupRunning = false;
            });
        }, 10000);

        // Every 2s: pause FFmpeg that is far ahead of its player, resume it once
        // the player catches up (see transcode-throttle.ts). Segment requests
        // also re-evaluate, so this tick mostly matters for a paused player,
        // which stops requesting segments altogether.
        this.throttleInterval = setInterval(() => {
            for (const job of this.jobs.values()) this.applyThrottle(job);
            void publishPlaybackPressure();
        }, 2000);

        // Every 10s: publish CPU/RAM stats to Valkey for cross-pod admin
        // visibility, AND flush live HLS segment progress to the DB so a
        // transcode-progress read served by a pod that does NOT hold the
        // in-memory job (the getAllActiveJobsInfoMultiPod fallback) reports
        // real progress instead of the frozen creation-time 0 (see
        // persistJobProgress).
        this.statsPublishInterval = setInterval(() => {
            if (this.statsPublishRunning) return;
            this.statsPublishRunning = true;
            void Promise.allSettled([
                this.persistJobProgress(),
                this.publishResourceStats(),
            ]).finally(() => {
                this.statsPublishRunning = false;
            });
        }, 10000);
    }

    // ========================================================================
    // Job Management
    // ========================================================================

    /**
     * Create a TranscodeJob object with default values.
     * Centralizes job object creation to prevent inconsistencies.
     */
    private createJobObject(
        id: string,
        config: TranscodeJobConfig,
        sessionOutputDir: string,
        outputDir: string,
        generationIndex: number,
        generationRole: GenerationRoleValue,
        segmentOffset: number = 0,
        decision?: TranscodeDecision,
        startedAt: Date = new Date(),
    ): TranscodeJob {
        const existingPlan = config.effectivePlan;
        const segmentDuration =
            existingPlan?.segmentDuration ??
            config.segmentDurationSeconds ??
            serviceConfig.FFMPEG_SEGMENT_DURATION;
        const effectivePlan = existingPlan
            ? {
                  ...existingPlan,
                  grid:
                      existingPlan.videoDisabled || existingPlan.video.action !== 'copy'
                          ? ('uniform' as const)
                          : config.gopSegments
                            ? ('gop' as const)
                            : ('keyframe' as const),
                  segmentDuration: config.segmentDurationSeconds ?? segmentDuration,
                  startTimeSeconds: config.startTimeSeconds ?? 0,
                  segmentOffset,
                  startNumber: (
                      existingPlan.video.action === 'drop'
                          ? existingPlan.decision?.videoAction === 'transcode'
                          : existingPlan.video.action !== 'copy'
                  )
                      ? segmentOffset
                      : 0,
              }
            : undefined;
        config = {
            ...config,
            effectivePlan,
            segmentDurationSeconds: effectivePlan?.segmentDuration ?? config.segmentDurationSeconds,
        };
        return {
            id,
            config,
            outputDir,
            sessionOutputDir,
            generationIndex,
            generationRole,
            process: null,
            status: 'starting',
            startedAt,
            // Always "now": this job object is live in THIS process as of this
            // call. For a fresh job that is identical to startedAt; for a
            // restore (which passes the persisted created_at) it correctly
            // restarts the never-watched grace period instead of inheriting an
            // already-expired one.
            unwatchedGraceAnchor: new Date(),
            lastAccessedAt: new Date(),
            lastProgressAt: new Date(),
            lastActiveProgressAt: new Date(),
            lastClientHeartbeatAt: new Date(),
            throttlePaused: false,
            masterPlaylistReady: false,
            segmentsReady: 0,
            transcodeFps: undefined,
            transcodeSpeed: undefined,
            lastServedSegment: new Map(),
            requestedMediaSeconds: new Map(),
            deletedUpTo: new Map(),
            segmentOffset,
            segmentDurationSeconds:
                config.segmentDurationSeconds ?? serviceConfig.FFMPEG_SEGMENT_DURATION,
            isSeeking: false,
            seekCount: 0,
            lastSeekTrigger: '',
            lastFFmpegSpawnTime: Date.now(),
            previousFFmpegSpawnTime: null,
            spawnAttempt: 0,
            streamTargetDurations: new Map(),
            iframeData: [],
            iframeAnalyzedCount: 0,
            iframeAnalysisComplete: config.isJellyfinTranscoded ?? false,
            transcodeDecisionResult: decision,
            requestedStartTimeSeconds: config.startTimeSeconds,
            syncTraceOrigin: (config.startTimeSeconds ?? 0) > 0 ? 'startup' : 'origin',
            syncTraceLoggedStreams: new Set(),
            keyframeData: config.keyframeData,
            endSegmentCache: new Map(),
            tailCacheAbortController: null,
        };
    }

    /**
     * Diagnostic snapshot of a non-zero-start generation's segment numbering.
     *
     * 🔴 `audioOffset` / `videoOffset` describe the DEMUX stream dirs and are
     * meaningless for a MUXED job. A muxed job serves only `streamDir ''`,
     * which takes the keyframe branch of getStreamSegmentOffsetForJob and
     * equals `globalOffset`; the `stream_N` video dir reported here takes the
     * copy+muxed branch (`segmentOffset - 1`, intentional demux preroll), so a
     * muxed job always logs a spurious 1-segment "A/V skew" that does not exist
     * in anything it serves. Cost two investigations (2026-09-11, 2026-09-12)
     * before being recognised as a logging artifact — it cannot place audio and
     * video apart. Read `seg-trace.offset` for what a muxed job actually uses.
     */
    private logSyncPlan(job: TranscodeJob, reason: 'startup' | 'seek'): void {
        if ((job.config.startTimeSeconds ?? 0) <= 0) return;

        const videoStreamDir = `stream_${job.config.audioTracks?.length ?? 0}`;
        const audioStreamDir = 'stream_0';
        const requestedStartTimeSeconds =
            job.requestedStartTimeSeconds ?? job.config.startTimeSeconds ?? 0;
        const ffmpegStartTimeSeconds = job.config.startTimeSeconds ?? 0;

        logger.info('sync-plan', {
            playSessionId: job.config.playSessionId,
            jobId: job.id,
            generationIndex: job.generationIndex,
            reason,
            requestedStartTimeSeconds,
            ffmpegStartTimeSeconds,
            startDeltaSeconds: ffmpegStartTimeSeconds - requestedStartTimeSeconds,
            globalOffset: job.segmentOffset,
            audioOffset: this.getStreamSegmentOffsetForJob(job, audioStreamDir),
            videoOffset: this.getStreamSegmentOffsetForJob(job, videoStreamDir),
            jobSegmentDuration: job.segmentDurationSeconds,
            audioTargetDuration:
                this.getStreamTargetDurationForJob(job, audioStreamDir) ??
                job.segmentDurationSeconds,
            videoTargetDuration:
                this.getStreamTargetDurationForJob(job, videoStreamDir) ??
                job.segmentDurationSeconds,
            seekCount: job.seekCount,
            videoAction: job.transcodeDecisionResult?.videoAction,
            audioAction: job.transcodeDecisionResult?.audioAction,
        });
    }

    private getOrCreateSession(playSessionId: string): PlaybackSession {
        let session = this.sessions.get(sessionKey(playSessionId));
        if (!session) {
            session = createPlaybackSession(playSessionId);
            this.sessions.set(sessionKey(playSessionId), session);
        } else {
            touchPlaybackSession(session);
        }
        return session;
    }

    /**
     * The id this session was FIRST registered under, restoring its ORIGINAL
     * case. The session maps are keyed case-folded (see `sessionKey`), so
     * callers legitimately arrive holding either case: a folded key from the
     * reaper's own map iteration, or a lowercase id read back from Postgres.
     *
     * Anything keyed OUTSIDE these maps — the on-disk directory name, and the
     * per-session trackers the HTTP layer populates from the request URL — uses
     * the original case, so it must be resolved back before use. A folded id
     * reaching those points at a directory that does not exist (the rm silently
     * no-ops and the output leaks) or misses the tracker entry it meant to free.
     */
    private originalSessionId(playSessionId: string): string {
        return this.sessions.get(sessionKey(playSessionId))?.playSessionId ?? playSessionId;
    }

    private getSessionOutputDir(playSessionId: string): string {
        return resolveOutputBaseDir({ playSessionId: this.originalSessionId(playSessionId) });
    }

    private getGenerationOutputDir(playSessionId: string, generationIndex: number): string {
        return buildGenerationOutputDir(this.getSessionOutputDir(playSessionId), generationIndex);
    }

    private getNextGenerationIndex(playSessionId: string): number {
        const session = this.getOrCreateSession(playSessionId);
        return allocateNextGenerationIndex(session);
    }

    private syncSessionMappings(playSessionId: string): void {
        const session = this.sessions.get(sessionKey(playSessionId));
        if (!session) return;

        if (session.currentJobId) {
            this.jobsByPlaySession.set(sessionKey(playSessionId), session.currentJobId);
        } else {
            this.jobsByPlaySession.delete(sessionKey(playSessionId));
        }

        session.previousJobId = session.retainedJobIds[0];

        if (session.previousJobId) {
            this.previousJobsByPlaySession.set(sessionKey(playSessionId), session.previousJobId);
        } else {
            this.previousJobsByPlaySession.delete(sessionKey(playSessionId));
        }

        if (!session.currentJobId && session.retainedJobIds.length === 0) {
            this.sessions.delete(sessionKey(playSessionId));
            this.jobsByPlaySession.delete(sessionKey(playSessionId));
            this.previousJobsByPlaySession.delete(sessionKey(playSessionId));
        }
    }

    private registerCurrentJob(playSessionId: string, job: TranscodeJob): void {
        const session = this.getOrCreateSession(playSessionId);
        job.generationRole = 'current';
        session.currentJobId = job.id;
        session.nextGenerationIndex = Math.max(
            session.nextGenerationIndex,
            job.generationIndex + 1,
        );
        session.lastAccessedAt = new Date();
        this.jobs.set(job.id, job);
        this.syncSessionMappings(playSessionId);
        this.ensureStopSubscription();
    }

    /**
     * Listen for stops of jobs this pod owns, issued on another pod.
     *
     * A stop that lands on a pod without the job used to only mark the DB row,
     * which the owner's cleanup acts on 30-60 s later. /j stop reports are routed
     * by client IP, segments by session, so on prod they regularly land on the
     * wrong pod: an Android TV audio switch left the old 4K HDR burn-in
     * transcode running next to the new one and the 4 GiB web pod was
     * OOM-killed (2026-10-02). The DB mark stays as the fallback when Valkey is
     * down. Subscribed lazily, by the first job this pod starts.
     */
    private ensureStopSubscription(): void {
        if (this.stopSubscription || this.isShuttingDown) return;
        this.stopSubscription = subscribeToChannel(TRANSCODE_STOP_CHANNEL, (raw) =>
            this.onRemoteStop(raw),
        )
            .then((unsub) => {
                this.stopUnsubscribe = unsub;
                // No Valkey (or a transient failure): try again on the next job.
                if (!unsub) this.stopSubscription = null;
            })
            .catch((err) => {
                logger.warn('Transcode stop channel subscription failed', {
                    error: String(err),
                });
                this.stopSubscription = null;
            });
    }

    private onRemoteStop(raw: string): void {
        let playSessionId: string | undefined;
        let reason = 'remote_stop';
        try {
            const parsed = JSON.parse(raw) as { playSessionId?: unknown; reason?: unknown };
            if (typeof parsed.playSessionId === 'string') playSessionId = parsed.playSessionId;
            if (typeof parsed.reason === 'string') reason = parsed.reason;
        } catch {
            return;
        }
        if (!playSessionId) return;
        // Only a job held in THIS pod's memory: stopJob on a non-owner would
        // take the cross-pod branch and publish again.
        if (!this.getCurrentJobId(this.originalSessionId(playSessionId))) return;
        this.stopJob(playSessionId, reason).catch((err) => {
            logger.warn('Remote transcode stop failed', { playSessionId, error: String(err) });
        });
    }

    private setPreviousJob(playSessionId: string, job: TranscodeJob): void {
        const session = this.getOrCreateSession(playSessionId);
        job.generationRole = 'previous';
        session.retainedJobIds = [
            job.id,
            ...session.retainedJobIds.filter((jobId) => jobId !== job.id),
        ];
        this.syncSessionMappings(playSessionId);
    }

    /**
     * Stop a retained generation's FFmpeg (SIGSTOP) so the generation being read
     * gets the encoder to itself. `throttledAt` is set as well: every kill path
     * already continues a throttle-stopped process before SIGTERM, and the reaper
     * reads a stopped process's liveness from its client, not its progress.
     */
    private parkGeneration(job: TranscodeJob, kind: 'unwatched' | 'superseded'): void {
        const proc = job.process;
        const alive = !!proc?.pid && proc.exitCode === null && proc.signalCode === null;
        if (!alive || process.platform === 'win32' || job.killRequested) return;
        if (!job.throttledAt) {
            try {
                proc.kill('SIGSTOP');
            } catch (err) {
                logger.warn('Could not park retained generation', {
                    jobId: job.id,
                    error: String(err),
                });
                return;
            }
            job.throttledAt = new Date();
        }
        job.parked = kind;
        job.parkedAt = new Date();
        logger.info('Parked retained generation', {
            jobId: job.id,
            playSessionId: job.config.playSessionId,
            generationIndex: job.generationIndex,
            segmentOffset: job.segmentOffset,
            kind,
        });
    }

    /**
     * Make a parked-unwatched retained generation current again: the client came
     * back to its position after probing segment 0 (see TranscodeJob.parked).
     * Roles swap, nothing is spawned: the reclaimed process resumes with the head
     * start it already had, and the probe generation is parked in its place.
     */
    private reclaimRetainedGeneration(playSessionId: string, job: TranscodeJob): boolean {
        const session = this.sessions.get(sessionKey(playSessionId));
        if (!session || !session.retainedJobIds.includes(job.id)) return false;
        // Re-checked here: the route was resolved across an await, and a TTL
        // retire or a dead process must never become the session's current job.
        const proc = job.process;
        if (
            job.parked !== 'unwatched' ||
            job.killRequested ||
            (job.status !== 'running' && job.status !== 'ready') ||
            !proc?.pid ||
            proc.exitCode !== null ||
            proc.signalCode !== null
        ) {
            return false;
        }
        const previous = session.currentJobId ? this.jobs.get(session.currentJobId) : undefined;
        if (previous?.isSeeking) return false;

        session.retainedJobIds = session.retainedJobIds.filter((jobId) => jobId !== job.id);
        if (previous) this.setPreviousJob(playSessionId, previous);
        this.registerCurrentJob(playSessionId, job);
        this.resumeThrottledJob(job, 'reclaimed');
        // It has served nothing yet: without fresh anchors the reaper's
        // never-watched arm (measured from the job's creation, parked time
        // included) could stop it before the first segment it is about to serve.
        const now = new Date();
        job.unwatchedGraceAnchor = now;
        job.lastAccessedAt = now;
        job.lastClientHeartbeatAt = now;
        if (previous) this.parkGeneration(previous, 'superseded');
        // A reclaim moves the session like a seek: stale in-flight requests for
        // the probe's segments must hit the seek cooldown, not seek back again.
        setLastSeekTimestamp(playSessionId, now.getTime());

        this.persistence.saveJob(job).catch((err) => {
            logger.warn(
                'Failed to persist reclaimed generation',
                { jobId: job.id, playSessionId },
                err as Error,
            );
        });
        logger.info('Reclaimed parked generation', {
            playSessionId,
            currentJobId: job.id,
            currentGeneration: job.generationIndex,
            segmentOffset: job.segmentOffset,
            previousJobId: previous?.id,
            previousGeneration: previous?.generationIndex,
        });
        return true;
    }

    private getCurrentJobId(playSessionId: string): string | undefined {
        return this.sessions.get(sessionKey(playSessionId))?.currentJobId;
    }

    private getPreviousJobId(playSessionId: string): string | undefined {
        return this.sessions.get(sessionKey(playSessionId))?.retainedJobIds[0];
    }

    private getRetainedJobsByPlaySession(playSessionId: string): TranscodeJob[] {
        const session = this.sessions.get(sessionKey(playSessionId));
        if (!session) return [];
        return session.retainedJobIds
            .map((jobId) => this.jobs.get(jobId))
            .filter((job): job is TranscodeJob => Boolean(job));
    }

    private async enforceGenerationLimit(
        playSessionId: string,
        anchorSegmentOffset: number,
        preserveJobIds: string[] = [],
    ): Promise<void> {
        const session = this.sessions.get(sessionKey(playSessionId));
        if (!session) return;

        const maxRetained = getMaxRetainedGenerations(config.FFMPEG_MAX_GENERATIONS_PER_SESSION);
        if (session.retainedJobIds.length <= maxRetained) {
            this.syncSessionMappings(playSessionId);
            return;
        }

        const retainedJobs = session.retainedJobIds
            .map((jobId) => this.jobs.get(jobId))
            .filter((job): job is TranscodeJob => Boolean(job));

        const { keepIds, retireIds } = selectRetainedGenerationsToKeep(
            retainedJobs,
            session.retainedJobIds,
            {
                maxRetained,
                anchorSegmentOffset,
                preserveJobIds,
            },
        );

        applyRetainedGenerationSelection(session, keepIds);
        this.syncSessionMappings(playSessionId);

        for (const retireId of retireIds) {
            const retireJob = this.jobs.get(retireId);
            if (!retireJob) continue;
            await this.retireJobGeneration(retireJob, 'superseded_retained_generation');
        }
    }

    /**
     * Start a new transcode job or return existing one for this playSession.
     *
     * Called by the main hls-lumastra endpoint (NOT by segment requests).
     * This happens when:
     * 1. Initial playback start - Creates new job
     * 2. Audio track change - Client re-requests stream at current position with different audio
     * 3. Client reconnection - App returns from background, re-requests stream
     *
     * Segment requests (forward/backward seeks via Siri remote) are handled by the
     * segment endpoint using shouldTriggerForwardSeek/shouldTriggerBackwardSeek,
     * which call seekToSegment() directly without going through startJob().
     */
    /**
     * Serialize an operation per playSessionId. Each call runs only after the prior
     * one for the same key settles (success OR failure), so start requests for one
     * session never interleave. Entries self-evict when the chain drains.
     */
    private async withSessionStartLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
        const prev = this.sessionStartChains.get(key) ?? Promise.resolve();
        // Run fn after prev regardless of how prev settled.
        const run = prev.then(fn, fn);
        const guarded = run.catch(() => {});
        this.sessionStartChains.set(key, guarded);
        try {
            return await run;
        } finally {
            // Drop the entry only if no later call has chained onto it.
            if (this.sessionStartChains.get(key) === guarded) {
                this.sessionStartChains.delete(key);
            }
        }
    }

    async startJob(
        jobConfig: TranscodeJobConfig,
        options?: {
            /**
             * Refuse (throw `PlaySessionOwnedByAnotherUserError`) when a job
             * started by a different user is resident under this session id.
             * Checked INSIDE the per-session lock, so the decision and the
             * start are one step: `startHlsPlayback`'s own ownership arms run
             * before the lock, and a second user's start could otherwise land
             * between those arms and this call and stop or ride the first
             * user's job. Exact compare (users.username is unique
             * case-sensitively), same as those arms. Not set by the shared
             * preview-cache artifact, which any viewer may re-warm.
             */
            requireSameOwner?: boolean;
            /**
             * At `FFMPEG_MAX_JOBS_PER_USER`, refuse (throw
             * `UserJobCapReachedError`) instead of evicting one of the
             * principal's other sessions. For a principal several people
             * share — the showcase's per-IP one — each "other session" is
             * another person's stream. The caller's own session never
             * counts here: a config change stops it first and a seek
             * returns before the cap check.
             */
            refuseAtUserCap?: boolean;
        },
    ): Promise<TranscodeJob> {
        // D-HLS-1 (security runtime pass 2026-09-26, fix (a)): the lock used to
        // key on the RAW playSessionId while the job registry (getCurrentJobId,
        // getJob, etc.) keys on the case-folded sessionKey() — so two spellings
        // of one UUID (e.g. lowercase vs UPPERCASE) were never serialized
        // against each other, raced startJobInternal concurrently, and one
        // start 503'd while the other left a self-inconsistent row (measured
        // 20/20 on preprod, 1b-case). Folding here matches the registry's own
        // key, so both spellings now serialize on the SAME lock.
        return this.withSessionStartLock(sessionKey(jobConfig.playSessionId), () => {
            if (options?.requireSameOwner) {
                // Any status, as in startHlsPlayback's live-job arm: an
                // errored/stopped job still names its owner, whose own
                // recovery must pass while nobody else takes the session over.
                const resident = this.getJobByPlaySession(jobConfig.playSessionId);
                if (resident && resident.config.username !== jobConfig.username) {
                    throw new PlaySessionOwnedByAnotherUserError(jobConfig.playSessionId);
                }
            }
            return this.startJobInternal(jobConfig, {
                refuseAtUserCap: options?.refuseAtUserCap === true,
            });
        });
    }

    /**
     * Serialized global-cap admission: atomically (w.r.t. concurrent starts) counts
     * committed jobs + in-flight reservations, evicts the LRU current job until under
     * cap, then reserves a slot. The caller MUST release the reservation
     * (this.reservedSlots--) once its job is registered in this.jobs OR the start
     * fails. Throws `TranscodeCapacityError` if the cap is reached and every
     * candidate is still live (see `filterEvictableByIdle`).
     *
     * countGlobalJobs excludes jobs already marked 'stopping' (stopJob sets that
     * synchronously), so an eviction reflects in the count immediately.
     */
    private async admitGlobalTranscodeSlot(jobConfig: TranscodeJobConfig): Promise<void> {
        // Cross-category emergency load-shed — real playback transcodes only. Previews /
        // cache-backed jobs have their own admission (preview-admission) and are excluded
        // from the global cap, so they must not be double-shed here.
        const isRealTranscode = !jobConfig.isPreview && !jobConfig.outputDir && !jobConfig.cacheKey;
        if (isRealTranscode) {
            const shed = checkRealTranscodeLoadShed();
            if (shed.shed) {
                throw new TranscodeCapacityError(
                    `Transcode load-shed: system load ${shed.loadRatio.toFixed(2)}/core exceeds ` +
                        `LUMASTRA_TRANSCODE_LOAD_SHED_RATIO (${shed.threshold})`,
                    'transcode_load_shed',
                );
            }
        }
        const prev = this.globalAdmissionChain;
        let releaseGate!: () => void;
        const gate = new Promise<void>((resolve) => (releaseGate = resolve));
        this.globalAdmissionChain = prev.then(() => gate);
        await prev.catch(() => {});
        try {
            const globalCap = config.LUMASTRA_MAX_CONCURRENT_TRANSCODES;
            // globalCap <= 0 means "no cap" (fail-open).
            if (globalCap > 0) {
                while (this.countGlobalJobs() + this.reservedSlots >= globalCap) {
                    // Cache-backed jobs (config.outputDir/cacheKey) are shared preview
                    // artifacts other viewers attach to — never evict one (stopping it
                    // deletes the shared dir out from under them). See
                    // `selectEvictionVictim`'s doc comment for why heartbeat recency,
                    // not segment-fetch recency, decides the victim.
                    const candidates = Array.from(this.jobs.values()).filter(
                        (j) =>
                            j.generationRole === 'current' &&
                            j.status !== 'error' &&
                            j.status !== 'stopped' &&
                            j.status !== 'stopping' &&
                            !j.config.outputDir &&
                            !j.config.cacheKey,
                    );
                    const minIdleSeconds = config.LUMASTRA_TRANSCODE_EVICTION_MIN_IDLE_SECONDS;
                    const evictable = this.globalCapEvictionOrder(
                        candidates,
                        jobConfig,
                        minIdleSeconds,
                    );
                    // Refuse BEFORE stopping anything when the evictable jobs cannot
                    // bring the count under the cap (in-flight reservations hold
                    // slots too): evicting the requester's own old session and then
                    // refusing anyway would leave them with no stream at all.
                    const needed = this.countGlobalJobs() + this.reservedSlots - globalCap + 1;
                    if (evictable.length < needed) {
                        // Refuse the NEW stream rather than interrupt a live one.
                        throw new TranscodeCapacityError(
                            `Server-wide transcode cap of ${globalCap} reached (LUMASTRA_MAX_CONCURRENT_TRANSCODES): ` +
                                `${candidates.length} running job(s) and ${this.reservedSlots} start(s) in flight, ` +
                                `none idle for ${minIdleSeconds}s (LUMASTRA_TRANSCODE_EVICTION_MIN_IDLE_SECONDS)`,
                        );
                    }
                    const lruJob = evictable[0];
                    logger.info('Global transcode cap reached — evicting job', {
                        evictedJobId: lruJob.id,
                        evictedPlaySessionId: lruJob.config.playSessionId,
                        evictedUser: lruJob.config.username,
                        evictedLastProgressAt: lruJob.lastProgressAt.toISOString(),
                        evictedLastAccessedAt: lruJob.lastAccessedAt.toISOString(),
                        globalCap,
                    });
                    await this.stopJob(lruJob.config.playSessionId, 'global_cap_eviction');
                }
            }
            this.reservedSlots++;
        } finally {
            releaseGate();
        }
    }

    /**
     * Jobs the global cap may stop to admit `jobConfig`, in the order it stops
     * them. Never a job someone is watching, except:
     * 1. the requester's own real session for the same item: a client
     *    rebuilding onto a fresh play session replaces it, and its recent
     *    heartbeat must not block its own rebuild;
     * 2. preview jobs, when the requester is real playback: a throwaway preview
     *    must not hold a slot against someone pressing play.
     * Everyone else only once idle (see `filterEvictableByIdle`).
     */
    private globalCapEvictionOrder(
        candidates: TranscodeJob[],
        jobConfig: TranscodeJobConfig,
        minIdleSeconds: number,
    ): TranscodeJob[] {
        const byIdleness = (jobs: TranscodeJob[]): TranscodeJob[] => {
            const sorted: TranscodeJob[] = [];
            const rest = [...jobs];
            for (let v = selectEvictionVictim(rest); v; v = selectEvictionVictim(rest)) {
                sorted.push(v);
                rest.splice(rest.indexOf(v), 1);
            }
            return sorted;
        };
        const requesterIsReal = !jobConfig.isPreview;
        const own = requesterIsReal
            ? candidates.filter(
                  (j) =>
                      !j.config.isPreview &&
                      j.config.username === jobConfig.username &&
                      j.config.itemId === jobConfig.itemId,
              )
            : [];
        const previews = requesterIsReal
            ? candidates.filter((j) => j.config.isPreview && !own.includes(j))
            : [];
        const idle = filterEvictableByIdle(
            candidates.filter((j) => !own.includes(j) && !previews.includes(j)),
            minIdleSeconds,
        );
        return [...byIdleness(own), ...byIdleness(previews), ...byIdleness(idle)];
    }

    private async startJobInternal(
        jobConfig: TranscodeJobConfig,
        options: { refuseAtUserCap: boolean } = { refuseAtUserCap: false },
    ): Promise<TranscodeJob> {
        if (this.isShuttingDown) {
            throw new ShutdownInterruptedError();
        }

        // Wait for startup cleanup to complete (prevents race condition where
        // a new job's directory could be deleted by the startup cleanup)
        await this.startupCleanupPromise;

        // Check for existing current generation for this playSessionId
        const existingJobId = this.getCurrentJobId(jobConfig.playSessionId);
        if (existingJobId) {
            const existing = this.jobs.get(existingJobId);
            if (existing && existing.status !== 'error' && existing.status !== 'stopped') {
                existing.lastAccessedAt = new Date();

                const existingPlanId = existing.config.playbackPlan?.plan_id;
                const newPlanId = jobConfig.playbackPlan?.plan_id;
                const playbackConfigChanged = hasPlaybackConfigChanged(existing.config, jobConfig);

                if (playbackConfigChanged) {
                    logger.info('Playback config change detected - recreating job', {
                        jobId: existing.id,
                        playSessionId: jobConfig.playSessionId,
                        existingItemId: truncateForLog(existing.config.itemId),
                        newItemId: truncateForLog(jobConfig.itemId),
                        existingPlanId,
                        newPlanId,
                        existingFileId: existing.config.fileId,
                        newFileId: jobConfig.fileId,
                        existingInputUrl: existing.config.inputUrl,
                        newInputUrl: jobConfig.inputUrl,
                        existingOutputCodec: existing.config.videoInfo?.outputCodec,
                        newOutputCodec: jobConfig.videoInfo?.outputCodec,
                        existingVideoTranscoded: existing.config.videoInfo?.isTranscoded,
                        newVideoTranscoded: jobConfig.videoInfo?.isTranscoded,
                        existingForceAudioTranscode: existing.config.forceAudioTranscode,
                        newForceAudioTranscode: jobConfig.forceAudioTranscode,
                        existingSubtitleBurnIn: existing.config.subtitleBurnIn?.absoluteIndex,
                        newSubtitleBurnIn: jobConfig.subtitleBurnIn?.absoluteIndex,
                        existingQualityCap: existing.config.qualityCap,
                        newQualityCap: jobConfig.qualityCap,
                        existingMaxAudioChannels: existing.config.maxAudioChannels,
                        newMaxAudioChannels: jobConfig.maxAudioChannels,
                    });

                    await this.stopJob(jobConfig.playSessionId, 'playback_config_changed');
                } else {
                    // Check if audio track changed (client switches audio via PlaybackInfo).
                    // Compares EFFECTIVE tracks, so an unspecified index resolves to
                    // the default the job is really muxing — see hasAudioTrackChanged.
                    const oldAudioIndex = existing.config.hlsOutput?.hlsAudioTrackIndex;
                    const newAudioIndex = jobConfig.hlsOutput?.hlsAudioTrackIndex;
                    const audioTrackChanged = hasAudioTrackChanged(existing.config, jobConfig);

                    // Check if start position changed significantly
                    // This handles:
                    // - Audio track changes (client requests stream at current position with different audio)
                    // - Client reconnection after network issues
                    // - Any scenario where client re-requests stream at a different position
                    const oldStartSeconds = existing.config.startTimeSeconds || 0;
                    const hasExplicitStartPosition = jobConfig.startTimeSeconds !== undefined;
                    const newStartSeconds = hasExplicitStartPosition
                        ? jobConfig.startTimeSeconds || 0
                        : oldStartSeconds;
                    const positionDelta = Math.abs(newStartSeconds - oldStartSeconds);

                    // Audio track change or significant position change (> 10 seconds) requires restart
                    if (audioTrackChanged || positionDelta > 10) {
                        logger.info(
                            audioTrackChanged
                                ? 'Audio track change detected - restarting job'
                                : 'Position change detected - restarting job at new position',
                            {
                                jobId: existing.id,
                                playSessionId: jobConfig.playSessionId,
                                oldPosition: oldStartSeconds,
                                newPosition: newStartSeconds,
                                delta: positionDelta,
                                audioTrackChanged,
                                oldAudioIndex,
                                newAudioIndex,
                            },
                        );

                        // Audio track change: always restart at the client's
                        // current playback position. If the client sent a seek=
                        // param we trust it (newStartSeconds > 0); otherwise
                        // fall back to the job's last known position
                        // (oldStartSeconds) rather than restarting at 0, which
                        // would leave the retained generation serving the old
                        // audio while the new one transcodes from the start.
                        const seekPositionSeconds = audioTrackChanged
                            ? newStartSeconds > 0
                                ? newStartSeconds
                                : oldStartSeconds
                            : newStartSeconds;

                        // Calculate target segment for the position. Muxed HLS with
                        // copied video uses keyframe-derived playlist segments; using
                        // floor(time / targetDuration) here creates a generation whose
                        // offset is ahead of the segment hls.js selects from EXTINF.
                        let targetSegmentIndex = Math.floor(
                            seekPositionSeconds / existing.segmentDurationSeconds,
                        );
                        if (
                            existing.config.hlsOutput?.hlsAudioMode === 'muxed' &&
                            existing.transcodeDecisionResult?.videoAction === 'copy' &&
                            existing.keyframeData &&
                            existing.keyframeData.length > 0 &&
                            existing.config.totalDurationSeconds
                        ) {
                            const keyframeTarget = getKeyframeSegmentIndexForTime(
                                seekPositionSeconds,
                                existing.keyframeData,
                                existing.config.totalDurationSeconds,
                                existing.segmentDurationSeconds,
                            );
                            if (keyframeTarget !== targetSegmentIndex) {
                                logger.info('Using keyframe segment target for muxed copy seek', {
                                    playSessionId: jobConfig.playSessionId,
                                    seekPositionSeconds,
                                    uniformTarget: targetSegmentIndex,
                                    keyframeTarget,
                                });
                            }
                            targetSegmentIndex = keyframeTarget;
                        }

                        // Use seekToSegment to restart FFmpeg at the position
                        // This handles: killing FFmpeg, cleaning segments, updating state, restarting
                        const seekSuccess = await this.seekToSegmentUnlocked(
                            jobConfig.playSessionId,
                            targetSegmentIndex,
                            existing.segmentDurationSeconds,
                            seekPositionSeconds,
                            audioTrackChanged,
                            audioTrackChanged ? jobConfig.hlsOutput : undefined,
                        );

                        if (!seekSuccess) {
                            logger.error(
                                'Failed to seek job to new position, cleaning up and creating new job',
                                undefined,
                                {
                                    jobId: existing.id,
                                    targetSegmentIndex,
                                    newPosition: seekPositionSeconds,
                                },
                            );
                            // Clean up the failed job to prevent memory leak
                            await this.stopJob(jobConfig.playSessionId, 'seek_failed');
                            // Fall through to create a new job
                        } else {
                            return this.getJobByPlaySession(jobConfig.playSessionId) ?? existing;
                        }
                    } else {
                        // Log the existing transcode decision for debugging
                        const existingDecision = existing.transcodeDecisionResult;
                        logger.debug('Returning existing job (position unchanged)', {
                            jobId: existing.id,
                            playSessionId: jobConfig.playSessionId,
                            status: existing.status,
                            positionDelta,
                            // Include transcode decision info for debugging
                            transcodeDecision: existingDecision
                                ? {
                                      mode: existingDecision.mode,
                                      videoAction: existingDecision.videoAction,
                                      audioAction: existingDecision.audioAction,
                                      targetAudioCodec: existingDecision.targetCodec?.audio,
                                  }
                                : 'none',
                        });
                        return existing;
                    }
                }
            }
        }

        // Global-cap admission: a serialized count → evict → reserve so concurrent
        // starts can't each read the same count, evict the same victim, and both add a
        // job — exceeding LUMASTRA_MAX_CONCURRENT_TRANSCODES (see admitGlobalTranscodeSlot).
        // Reserves a slot that MUST be released once this job registers in this.jobs
        // (where it counts itself) or the start fails.
        await this.admitGlobalTranscodeSlot(jobConfig);
        let slotHeld = true;
        let releaseTimer: ReturnType<typeof setTimeout> | undefined;
        const releaseSlot = (): void => {
            if (slotHeld) {
                slotHeld = false;
                if (releaseTimer) clearTimeout(releaseTimer);
                this.reservedSlots = Math.max(0, this.reservedSlots - 1);
            }
        };
        // Safety net: the reservation MUST be released once the job registers or the
        // start fails. A leaked reservation permanently shrinks the effective global
        // cap, so — in addition to releasing at every known exit below — auto-release
        // well past normal startup in case some future unguarded reject slips through.
        releaseTimer = setTimeout(releaseSlot, 30_000);
        if (typeof releaseTimer.unref === 'function') releaseTimer.unref();

        // Check user job limit
        const userJobCount = this.countUserJobs(jobConfig.username);
        if (userJobCount >= config.FFMPEG_MAX_JOBS_PER_USER) {
            if (options.refuseAtUserCap) {
                releaseSlot();
                throw new UserJobCapReachedError(config.FFMPEG_MAX_JOBS_PER_USER);
            }
            // Before failing, try to evict a job to make room:
            // 1. Prefer evicting a job for the same item (zombie from previous playback)
            // 2. Fall back to evicting the least-recently-used job for this user
            // Cache-backed jobs are excluded for the same reason as the
            // global-cap eviction above: they are shared artifacts, not
            // this user's exclusive resource, and evicting one would stop
            // playback for every other viewer attached to it.
            const userJobs = Array.from(this.jobs.values()).filter(
                (j) =>
                    j.config.username === jobConfig.username &&
                    j.generationRole === 'current' &&
                    j.status !== 'error' &&
                    j.status !== 'stopped' &&
                    !j.config.outputDir &&
                    !j.config.cacheKey,
            );
            const sameFileJob = userJobs.find(
                (j) => j.config.itemId === jobConfig.itemId && j.config.fileId === jobConfig.fileId,
            );
            const sameItemJob = userJobs.find((j) => j.config.itemId === jobConfig.itemId);
            // Falls back to `selectEvictionVictim` (heartbeat recency, not
            // segment-fetch recency) — same reasoning as the global-cap eviction.
            const jobToEvict = sameFileJob ?? sameItemJob ?? selectEvictionVictim(userJobs);

            if (jobToEvict) {
                logger.info('Evicting job to make room for new session', {
                    evictedJobId: jobToEvict.id,
                    evictedPlaySessionId: jobToEvict.config.playSessionId,
                    evictedItemId: jobToEvict.config.itemId,
                    reason: sameFileJob
                        ? 'same_file_zombie'
                        : sameItemJob
                          ? 'same_item_zombie'
                          : 'lru_eviction',
                    newItemId: jobConfig.itemId,
                });
                await this.stopJob(
                    jobToEvict.config.playSessionId,
                    'evicted_for_new_session',
                ).catch((err: unknown) => {
                    releaseSlot();
                    throw err;
                });
            } else {
                releaseSlot();
                throw new Error(
                    `Maximum ${config.FFMPEG_MAX_JOBS_PER_USER} concurrent transcode jobs per user`,
                );
            }
        }

        const sessionOutputDir = resolveOutputBaseDir(jobConfig);
        const generationIndex = this.getNextGenerationIndex(jobConfig.playSessionId);
        // Cache-backed jobs (jobConfig.outputDir set) write generation 0 directly
        // into the caller-provided dir — no nested gen-XXXX subfolder — since the
        // preview cache store owns that exact directory's layout and lifecycle.
        const outputDir =
            jobConfig.outputDir ??
            this.getGenerationOutputDir(jobConfig.playSessionId, generationIndex);
        await this.fileManager.createOutputDirectory(outputDir).catch((err: unknown) => {
            releaseSlot();
            throw err;
        });

        // Calculate initial segment offset based on start time.
        // Must be computed AFTER the copy-mode override below so units are consistent.
        let initialOffset: number;

        // Make transcode decision (determines video/audio actions, GPU usage)
        let decision: TranscodeDecision | undefined;

        if (jobConfig.playbackPlan && jobConfig.mediaSourceInfo) {
            try {
                decision = await transcodeDecision.consumePlan(
                    jobConfig.playbackPlan,
                    jobConfig.mediaSourceInfo,
                );
                logger.info('Transcode decision from PlaybackPlan', {
                    planId: jobConfig.playbackPlan.plan_id,
                    mode: decision.mode,
                    videoAction: decision.videoAction,
                    audioAction: decision.audioAction,
                    useGpu: decision.useGpu,
                    gpuEncoder: decision.gpuEncoder,
                    needsTonemapping: decision.needsTonemapping,
                });
            } catch (err) {
                // When a plan is present, consumePlan is authoritative — do not
                // silently fall through to the heuristic decide() path, which
                // could produce a divergent decision.
                releaseSlot();
                throw new Error(
                    `consumePlan failed for plan ${jobConfig.playbackPlan.plan_id}: ${err instanceof Error ? err.message : String(err)}`,
                    { cause: err },
                );
            }
        }

        // Heuristic fallback: only used for /j/ Jellyfin compat path (no PlaybackPlan)
        if (!decision && jobConfig.mediaSourceInfo) {
            try {
                decision = await transcodeDecision.decide(
                    jobConfig.mediaSourceInfo,
                    jobConfig.deviceProfileId,
                    jobConfig.userAgent,
                    jobConfig.planHints,
                );
                logger.info('Transcode decision made', {
                    mode: decision.mode,
                    videoAction: decision.videoAction,
                    audioAction: decision.audioAction,
                    useGpu: decision.useGpu,
                    gpuEncoder: decision.gpuEncoder,
                    needsTonemapping: decision.needsTonemapping,
                });
            } catch (err) {
                logger.error('Transcode decision failed', err instanceof Error ? err : undefined);
            }
        }

        // Only force transcodeMode for /j/ compat path (no PlaybackPlan).
        // When a plan is present, the decision is already made by consumePlan().
        if (!jobConfig.playbackPlan) {
            jobConfig.transcodeMode = 'full';
        }

        // This is the only request-to-effective-plan computation for this job.
        // Geometry below is attached before either manifests or FFmpeg can read it.
        const hadDecision = !!decision;
        jobConfig.effectivePlan = await computeEffectivePlan(jobConfig, decision);
        decision = jobConfig.effectivePlan.decision;
        jobConfig.effectivePlan.caps = computeEffectiveCaps(jobConfig, decision);

        // Copy mode: use 10s segments so audio matches video's keyframe-aligned cadence.
        // Must happen BEFORE initialOffset calculation so offset uses the right unit.
        const requestedStartTimeSeconds = jobConfig.startTimeSeconds ?? 0;
        // GOP mode: the grid and start entry, decided once below and reused for
        // the job's offset and grid (one source, so they can never disagree).
        let startGopGrid: GopGrid | null = null;
        let gopStartEntry: number | null = null;

        if (decision?.videoAction === 'copy') {
            const configuredDuration =
                jobConfig.segmentDurationSeconds ?? serviceConfig.FFMPEG_SEGMENT_DURATION;
            if (hadDecision && configuredDuration === serviceConfig.FFMPEG_SEGMENT_DURATION) {
                jobConfig.segmentDurationSeconds = 10;
            }

            // GOP mode (services/hls/gop-grid.ts): exact keyframe-grid entries.
            // Decided once here and stored either way (true or false), so seek
            // generations and a restored config keep the same mode.
            if (jobConfig.gopSegments === undefined) {
                const gopInput = {
                    enabled: serviceConfig.HLS_COPY_GOP_SEGMENTS,
                    hlsAudioMode: jobConfig.hlsOutput?.hlsAudioMode,
                    hlsContainer: jobConfig.hlsOutput?.hlsContainer,
                    videoAction: decision.videoAction,
                    // Count what the strategy will really map (a probe that
                    // contradicts the track list drops them all).
                    audioTrackCount: effectiveAudioTrackCount({
                        audioTracks: jobConfig.audioTracks ?? [],
                        mediaSourceInfo: jobConfig.mediaSourceInfo,
                    }),
                    keyframes: jobConfig.keyframeData,
                    totalSeconds: jobConfig.totalDurationSeconds,
                    isPreview: jobConfig.isPreview,
                };
                const gopReason = this.isGopTripped(jobConfig)
                    ? 'tripped'
                    : gopIneligibleReason(gopInput);
                jobConfig.gopSegments = gopReason === null;
                // A demux copy job that cannot use the grid keeps the legacy
                // fixed-length cut: its declared segment times drift from the
                // file after seeks. iPhone/iPad web must stay on demux (muxed
                // fMP4+AC-3 loops on iOS), so this is accepted, not worked
                // around; the log makes affected titles findable.
                if (
                    gopReason !== null &&
                    gopReason !== 'disabled' &&
                    gopReason !== 'preview' &&
                    gopReason !== 'not_demux_copy' &&
                    jobConfig.hlsOutput?.hlsAudioMode === 'demux' &&
                    decision.videoAction === 'copy'
                ) {
                    logger.warn('Demux copy without GOP grid: legacy fixed-length cut', {
                        playSessionId: jobConfig.playSessionId,
                        reason: gopReason,
                        keyframeCount: jobConfig.keyframeData?.length ?? 0,
                    });
                }
            }
            // Same duration source as the job object (createJobObject).
            const gopGrid = jobConfig.gopSegments
                ? buildGopGrid(
                      jobConfig.keyframeData ?? [],
                      jobConfig.totalDurationSeconds ?? 0,
                      jobConfig.segmentDurationSeconds ?? serviceConfig.FFMPEG_SEGMENT_DURATION,
                  )
                : null;
            if (jobConfig.gopSegments && !gopGrid) {
                // Keyframes that do not form a servable grid: legacy cut.
                jobConfig.gopSegments = false;
            }
            startGopGrid = gopGrid;

            if (gopGrid) {
                // Start on exactly the keyframe of the grid entry holding the
                // requested time, so the first fragment the player anchors on
                // starts where the playlist says it does.
                const requested = jobConfig.startTimeSeconds ?? 0;
                const { entry, startTimeSeconds } = resolveGopGenerationStart(gopGrid, {
                    requestedSeconds: requested,
                });
                jobConfig.startTimeSeconds = startTimeSeconds;
                gopStartEntry = entry;
                logger.info('GOP mode: copy-mode start on grid entry', {
                    playSessionId: jobConfig.playSessionId,
                    requestedStartTimeSeconds: requested,
                    entry,
                    startTimeSeconds: jobConfig.startTimeSeconds ?? 0,
                });
            } else if (
                jobConfig.startTimeSeconds &&
                jobConfig.startTimeSeconds > 0 &&
                jobConfig.keyframeData &&
                jobConfig.keyframeData.length > 0 &&
                jobConfig.totalDurationSeconds
            ) {
                const alignedStartTime = alignToKeyframeSegmentStart(
                    jobConfig.startTimeSeconds,
                    jobConfig.keyframeData,
                    jobConfig.totalDurationSeconds,
                    jobConfig.segmentDurationSeconds ?? serviceConfig.FFMPEG_SEGMENT_DURATION,
                );

                if (Math.abs(alignedStartTime - jobConfig.startTimeSeconds) > 0.001) {
                    logger.info('Aligned initial copy-mode start time to video segment boundary', {
                        playSessionId: jobConfig.playSessionId,
                        requestedStartTimeSeconds: jobConfig.startTimeSeconds,
                        alignedStartTimeSeconds: alignedStartTime,
                    });
                    jobConfig.startTimeSeconds = alignedStartTime;
                }
            }
        }

        // Transcode mode: snap startTimeSeconds to a segment boundary so the
        // fMP4 BMDT (from -copyts, no -start_at_zero) equals the playlist's
        // cumulative time at the first real segment. Without this, the
        // fractional remainder between seekTime and N*segmentDuration produces
        // a BMDT-vs-playlist mismatch that trips fragParsingError when hls.js
        // is recreated mid-stream (e.g., version switch), where it can't
        // bridge the gap with timestampOffset.
        if (
            decision?.videoAction !== 'copy' &&
            jobConfig.startTimeSeconds &&
            jobConfig.startTimeSeconds > 0
        ) {
            const segDur =
                jobConfig.segmentDurationSeconds ?? serviceConfig.FFMPEG_SEGMENT_DURATION;
            const aligned = Math.floor(jobConfig.startTimeSeconds / segDur) * segDur;
            if (Math.abs(aligned - jobConfig.startTimeSeconds) > 0.001) {
                logger.info('Aligned transcode start time to segment boundary', {
                    playSessionId: jobConfig.playSessionId,
                    requestedStartTimeSeconds: jobConfig.startTimeSeconds,
                    alignedStartTimeSeconds: aligned,
                });
                jobConfig.startTimeSeconds = aligned;
            }
        }

        // Now compute initialOffset with the correct (possibly overridden) duration.
        // Previews are a self-contained mini-window — segments must be numbered
        // from 0 (see types.ts JobConfig.isPreview), so we skip the offset math.
        const jobSegmentDuration =
            jobConfig.segmentDurationSeconds ?? serviceConfig.FFMPEG_SEGMENT_DURATION;
        if (jobConfig.isPreview) {
            initialOffset = 0;
        } else {
            initialOffset = jobConfig.startTimeSeconds
                ? Math.floor(jobConfig.startTimeSeconds / jobSegmentDuration)
                : 0;
            if (gopStartEntry !== null) {
                initialOffset = gopStartEntry;
            } else if (
                jobConfig.hlsOutput?.hlsAudioMode === 'muxed' &&
                decision?.videoAction === 'copy' &&
                jobConfig.startTimeSeconds &&
                jobConfig.startTimeSeconds > 0 &&
                jobConfig.keyframeData &&
                jobConfig.keyframeData.length > 0 &&
                jobConfig.totalDurationSeconds
            ) {
                initialOffset = getKeyframeSegmentIndexForTime(
                    jobConfig.startTimeSeconds,
                    jobConfig.keyframeData,
                    jobConfig.totalDurationSeconds,
                    jobSegmentDuration,
                );
            }
        }

        // Create job object
        const job = this.createJobObject(
            randomUUID(),
            jobConfig,
            sessionOutputDir,
            outputDir,
            generationIndex,
            'current',
            initialOffset,
            decision,
        );
        job.requestedStartTimeSeconds = requestedStartTimeSeconds;
        job.gopGrid = startGopGrid ?? undefined;
        job.syncTraceOrigin = requestedStartTimeSeconds > 0 ? 'startup' : 'origin';

        this.registerCurrentJob(jobConfig.playSessionId, job);
        // The job is now in this.jobs and counts itself — drop the admission reservation.
        releaseSlot();
        await this.stampOutputDir(job);

        logger.info('Created transcode job', {
            jobId: job.id,
            playSessionId: jobConfig.playSessionId,
            mode: 'full',
            requestedStartTimeSeconds,
            startTimeSeconds: jobConfig.startTimeSeconds || 0,
            initialOffset: initialOffset,
            totalDuration: jobConfig.totalDurationSeconds,
            useGpu: decision?.useGpu ?? false,
            gpuEncoder: decision?.gpuEncoder,
        });
        this.logSyncPlan(job, 'startup');

        // Start FFmpeg process
        try {
            await this.spawnFFmpeg(job);
        } catch (err) {
            if (err instanceof ShutdownInterruptedError) throw err;
            job.status = 'error';
            job.error = (err as Error).message;
            logger.error('Failed to start FFmpeg', err as Error, {
                jobId: job.id,
            });
        }

        // Persist job to database for server restart recovery
        try {
            await this.persistence.saveJob(job);
        } catch (err) {
            logger.warn('Failed to persist transcode job to database', {
                jobId: job.id,
                playSessionId: jobConfig.playSessionId,
                error: String(err),
            });
            // Non-fatal - job can still work without persistence
        }

        // Start I-frame analysis worker for direct stream mode
        // For Jellyfin transcode mode, keyframes are at segment boundaries (no analysis needed)
        if (!jobConfig.isJellyfinTranscoded) {
            this.iframeAnalyzer.startAnalysis(job);
        }

        // Pre-warm end-segment cache in background for VOD tail probes.
        // hls.js requests the last VOD segment to verify stream integrity; without
        // cached data this 404s and blocks playback. Fire-and-forget — playback
        // starts immediately, cache warms in parallel.
        //
        // Skip concat-demuxer sessions — localFilePath is a list file, not media.
        // Skip muxed sessions — no demuxed tail probes.
        // Skip a job that failed to spawn or was stopped while spawning (the
        // input sniff is an await): its retire already ran, so nothing would
        // abort a tail worker started now.
        if (
            job.status !== 'error' &&
            job.status !== 'stopping' &&
            job.status !== 'stopped' &&
            !jobConfig.useConcatDemuxer &&
            job.config.totalDurationSeconds &&
            job.config.totalDurationSeconds > 60 &&
            job.config.hlsOutput?.hlsAudioMode !== 'muxed'
        ) {
            const isRemux = decision?.videoAction === 'copy' && decision?.audioAction === 'copy';
            const tailCachePromise = isGopModeJob(job)
                ? this.spawnGopTailCacheWorker(job)
                : isRemux
                  ? this.spawnTailCacheWorker(job)
                  : this.spawnTailCacheWorkerTranscode(job);

            tailCachePromise.catch((err) => {
                logger.warn('Tail cache warmup failed (non-fatal)', {
                    jobId: job.id,
                    error: String(err),
                });
            });
        }

        return job;
    }

    /**
     * Spawn a lightweight FFmpeg to produce the last few segments of each stream.
     * Runs in background — the main playback FFmpeg is already producing from the start.
     * This ensures endSegmentCache has real tail media with correct BMDT for VOD probes.
     *
     * Uses -c copy for both audio and video (no transcoding) so it completes in <2s.
     * The BMDT in copy-mode segments matches the source timeline, which is consistent
     * with what the main FFmpeg produces (both use -avoid_negative_ts make_zero).
     *
     * IMPORTANT: Only safe for pure remux sessions (video=copy, audio=copy).
     * For audio_transcode or full transcode, -c copy produces segments with source
     * codecs that are incompatible with the transcoded init segment and playlist.
     * Those sessions rely on warmEndSegmentCache() catching real tail segments
     * once the main FFmpeg naturally reaches the end.
     */
    private async spawnTailCacheWorker(job: TranscodeJob): Promise<void> {
        const totalDuration = job.config.totalDurationSeconds!;
        const segDur = job.segmentDurationSeconds;
        const inputFile = job.config.localFilePath;

        // Need a local media file (not a concat list) to produce tail segments
        if (!inputFile || job.config.useConcatDemuxer) return;

        // Register the abort handle BEFORE the setup awaits below, so a
        // concurrent retireJobGeneration() aborts THIS worker (not a stale/null
        // handle). The pre-spawn guard then skips spawning an orphan ffmpeg.
        const abortController = new AbortController();
        job.tailCacheAbortController = abortController;

        // Reads the input with its own FFmpeg — same playlist-body guard as
        // every main spawn (transcoding/input-guard.ts). A refusal rejects,
        // which the caller logs as a failed (non-fatal) tail warm-up. After
        // the registration above, so a retire during the sniff is seen by the
        // pre-spawn `aborted` check.
        await assertTranscodeInputIsMedia(job.config);

        // Seek to 30s before the end — produces ~3 segments per stream
        const seekTo = Math.max(0, totalDuration - 30);
        const tailDir = path.join(job.outputDir, '.tail-cache');

        // Audio tracks first, then video — the main job's stream layout.
        const videoStreamIndex = (job.config.audioTracks || []).length;

        // Create stream directories for output
        for (let i = 0; i <= videoStreamIndex; i++) {
            await fs.mkdir(path.join(tailDir, `stream_${i}`), {
                recursive: true,
            });
        }

        const args = buildRemuxTailRunArgs({
            seekToSeconds: seekTo,
            inputFile,
            audioTrackCount: videoStreamIndex,
            segmentSeconds: segDur,
            tailDir,
        });

        // A retire during the setup awaits above may have aborted us — bail
        // before spawning so no orphan ffmpeg outlives the retired generation.
        if (abortController.signal.aborted) return;

        try {
            const result = await spawnFFmpegSafely({
                args,
                libraryInput: inputFile,
                timeout: 15_000, // 15s — copy mode should be nearly instant
                abortSignal: abortController.signal,
                context: { jobId: job.id, purpose: 'tail-cache' },
            });

            if (result.exitCode !== 0) {
                logger.warn('Tail cache FFmpeg exited with error', {
                    jobId: job.id,
                    exitCode: result.exitCode,
                    stderr: result.stderr.slice(0, 500),
                });
                return;
            }

            const streamDirs = Array.from(
                { length: videoStreamIndex + 1 },
                (_, i) => `stream_${i}`,
            );
            await this.cacheTailRunEndSegments(job, tailDir, streamDirs, 'remux');
        } finally {
            // Clean up temp directory
            await fs.rm(tailDir, { recursive: true, force: true }).catch(() => {});
            // Clear the abort controller now that the worker has finished.
            if (job.tailCacheAbortController === abortController) {
                job.tailCacheAbortController = null;
            }
        }
    }

    /**
     * GOP-mode tail cache: the job's own GOP-mode arguments, started on the
     * keyframe of grid entry `count - 3`, assembled with that offset. Its last
     * entry IS grid entry `count - 1` on every stream, so it is cached as a
     * `segment` keyed by that grid index (never as a uniform-grid tail run).
     */
    private async spawnGopTailCacheWorker(job: TranscodeJob): Promise<void> {
        const grid = this.getGopGrid(job);
        const inputFile = job.config.localFilePath;
        if (!grid || !inputFile || job.config.useConcatDemuxer) return;

        const abortController = new AbortController();
        job.tailCacheAbortController = abortController;
        await assertTranscodeInputIsMedia(job.config);

        const { entry, startTimeSeconds } = resolveGopGenerationStart(grid, {
            requestedSeconds: grid.starts[Math.max(0, grid.count - 3)],
        });
        const tailDir = path.join(job.outputDir, '.tail-cache');
        const tailJob = {
            ...job,
            outputDir: tailDir,
            segmentOffset: entry,
            gopAssembler: undefined,
            gopBroken: undefined,
            config: {
                ...job.config,
                startTimeSeconds,
                effectivePlan: job.config.effectivePlan
                    ? {
                          ...job.config.effectivePlan,
                          startTimeSeconds,
                          segmentOffset: entry,
                      }
                    : undefined,
            },
        } as TranscodeJob;
        const audioCount = job.config.audioTracks?.length ?? 0;
        const streamDirs = Array.from({ length: audioCount + 1 }, (_, i) => `stream_${i}`);
        for (const d of [
            ...streamDirs,
            ...Array.from({ length: audioCount }, (_, i) => gopAudioPartsDirName(i)),
            gopVideoPartsDirName(audioCount),
        ]) {
            await fs.mkdir(path.join(tailDir, d), { recursive: true });
        }
        const whitelistReady = prepareMediaFormatWhitelist();
        if (whitelistReady) await whitelistReady;
        const args = this.buildFFmpegArgs(tailJob);
        if (tailJob.gopBroken || abortController.signal.aborted) {
            await fs.rm(tailDir, { recursive: true, force: true }).catch(() => {});
            return;
        }

        try {
            const result = await spawnFFmpegSafely({
                args,
                timeout: 120_000,
                abortSignal: abortController.signal,
                context: { jobId: job.id, purpose: 'tail-cache-gop' },
            });
            if (result.exitCode !== 0) {
                logger.warn('Tail cache (GOP) FFmpeg failed', {
                    jobId: job.id,
                    exitCode: result.exitCode,
                    stderr: result.stderr.slice(0, 500),
                });
                return;
            }
            const assembler = new GopSegmentAssembler({
                grid,
                gridOffset: entry,
                log: logger,
                streams: streamDirs.map((dir, i) =>
                    i < audioCount
                        ? {
                              kind: 'audio' as const,
                              streamDir: path.join(tailDir, dir),
                              partsDir: path.join(tailDir, gopAudioPartsDirName(i)),
                              partPrefix: GOP_AUDIO_PART_PREFIX,
                              initName: `init_${i}.mp4`,
                          }
                        : {
                              kind: 'video' as const,
                              streamDir: path.join(tailDir, dir),
                              partsDir: path.join(tailDir, gopVideoPartsDirName(i)),
                              partPrefix: GOP_VIDEO_PART_PREFIX,
                              initName: `init_${i}.mp4`,
                          },
                ),
            });
            await assembler.tick({ final: true });
            if (assembler.broken || !assembler.complete) {
                logger.warn('Tail cache (GOP): assembly incomplete, nothing cached', {
                    jobId: job.id,
                    broken: assembler.broken,
                });
                return;
            }
            const lastEntry = grid.count - 1;
            const fileName = `segment_${String(lastEntry - entry).padStart(5, '0')}.m4s`;
            for (const dir of streamDirs) {
                const buffer = await fs
                    .readFile(path.join(tailDir, dir, fileName))
                    .catch(() => null);
                if (!buffer || buffer.length === 0) continue;
                storeEndSegment(
                    job.endSegmentCache,
                    dir,
                    { kind: 'segment', segmentIndex: lastEntry, buffer },
                    {
                        totalSeconds: job.config.totalDurationSeconds ?? 0,
                        segmentSeconds: job.segmentDurationSeconds,
                    },
                );
                logger.info('Tail cache (GOP): end segment', {
                    jobId: job.id,
                    stream: dir,
                    segmentIndex: lastEntry,
                    size: buffer.length,
                });
            }
        } finally {
            await fs.rm(tailDir, { recursive: true, force: true }).catch(() => {});
            if (job.tailCacheAbortController === abortController) {
                job.tailCacheAbortController = null;
            }
        }
    }

    /**
     * Put the last segment of each stream of a finished tail run into
     * endSegmentCache. The run's file numbers count from its own `-ss`, so a
     * segment cannot be keyed by them: it answers only the LAST playlist entry,
     * and only when its stream reaches into that entry
     * (services/hls/end-segment-cache.ts). A copy audio stream that ends early
     * is skipped instead of answering the entry after its real last one.
     */
    private async cacheTailRunEndSegments(
        job: TranscodeJob,
        tailDir: string,
        streamDirs: string[],
        worker: 'remux' | 'transcode',
    ): Promise<void> {
        const totalSeconds = job.config.totalDurationSeconds;
        if (!totalSeconds) return;
        const results = await cacheTailRun({
            cache: job.endSegmentCache,
            tailDir,
            streamDirs,
            totalSeconds,
            segmentSecondsFor: (streamDir) =>
                job.streamTargetDurations.get(streamDir) || job.segmentDurationSeconds,
        });
        if (!results) {
            logger.warn('Tail cache: run output unreadable, nothing cached', {
                jobId: job.id,
                worker,
                streamDirs,
            });
            return;
        }
        for (const result of results) {
            logger.info('Tail cache: end segment', { jobId: job.id, worker, ...result });
        }
    }

    /**
     * Spawn a tail-cache FFmpeg that reuses the main job's encoding decisions.
     * Produces real tail segments with correct codecs for audio_transcode and
     * full transcode sessions.
     *
     * Uses CPU encoding to avoid GPU session contention with the main FFmpeg
     * (consumer GPUs typically have a 2-3 concurrent NVENC session limit).
     * Disables subtitle burn-in since probe segments aren't viewed.
     */
    private async spawnTailCacheWorkerTranscode(job: TranscodeJob): Promise<void> {
        const totalDuration = job.config.totalDurationSeconds!;
        const inputFile = job.config.localFilePath;
        if (!inputFile || job.config.useConcatDemuxer) return;

        // This worker encodes on the CPU. When the main run encodes video on a GPU
        // the two outputs differ (NVENC HEVC SDR is Main 8-bit, libx265 is Main10),
        // and a cached tail would be served under the main run's init segment:
        // media the player cannot decode for a seek to the end. No tail cache then;
        // the end of the stream is produced by the main run like any other segment.
        const mainDecision = job.transcodeDecisionResult;
        if (
            mainDecision?.videoAction === 'transcode' &&
            (mainDecision.useGpu || mainDecision.gpuEncoder)
        ) {
            logger.debug('Tail cache skipped: the main run encodes video on a GPU', {
                jobId: job.id,
                gpuEncoder: mainDecision.gpuEncoder,
            });
            return;
        }

        // Register the abort handle BEFORE the setup awaits below so a concurrent
        // retireJobGeneration() aborts THIS worker; the pre-spawn guard then
        // skips spawning an orphan ffmpeg.
        const abortController = new AbortController();
        job.tailCacheAbortController = abortController;

        // Same playlist-body guard as spawnTailCacheWorker above, after the
        // registration for the same reason.
        await assertTranscodeInputIsMedia(job.config);

        const seekTo = Math.max(0, totalDuration - 30);
        const tailDir = path.join(job.outputDir, '.tail-cache');
        const decision = job.transcodeDecisionResult;

        // Clone decision with GPU disabled to avoid NVENC session contention.
        // All codec choices (videoAction, audioAction, targetCodec) stay identical
        // so the tail segments are codec-compatible with the main pipeline's init segment.
        // toSoftwareDecision also swaps a GPU encoder name in targetCodec.video,
        // which the strategy falls back to once gpuEncoder is unset.
        const tailDecision: TranscodeDecision | undefined = decision
            ? toSoftwareDecision(decision)
            : undefined;

        // Build strategy config matching the main pipeline (from buildFFmpegArgs),
        // with overrides for seek position, output dir, and GPU.
        // Use the SAME resolution cap as the main transcode so tail-cache
        // segments match (HLS can't switch resolution mid-stream).
        const { maxWidth, maxHeight } = computeMaxDimensions(
            tailDecision,
            job.config.videoInfo?.height,
            {
                downscaleCpuTo1080p: config.TRANSCODE_DOWNSCALE_CPU_TO_1080P,
                defaultMaxWidth: config.MAX_WIDTH,
                defaultMaxHeight: config.MAX_HEIGHT,
            },
        );
        const strategyConfig: FullStrategyConfig = {
            outputDir: tailDir,
            segmentDuration: job.segmentDurationSeconds,
            startTimeSeconds: seekTo,
            startNumber: 0,
            audioTracks: job.config.audioTracks,
            videoInfo: job.config.videoInfo,
            videoDisabled: job.config.videoDisabled,
            hlsOutput: job.config.hlsOutput
                ? { ...job.config.hlsOutput, hlsPlaylistType: 'vod' }
                : undefined,
            localFilePath: inputFile,
            useConcatDemuxer: false,
            decision: tailDecision,
            gpuAcceleration: 'none', // CPU-only
            vaapiDevice: undefined,
            encodingPreset: job.config.encodingPreset ?? config.ENCODING_PRESET,
            nvencPreset: job.config.nvencPreset ?? config.NVENC_PRESET,
            nvencTune: config.NVENC_TUNE || undefined,
            nvencRc: config.NVENC_RC === 'auto' ? undefined : config.NVENC_RC,
            nvencCq: config.NVENC_CQ,
            h264Crf: config.H264_CRF,
            h265Crf: config.H265_CRF,
            videoBitrateMbps: config.VIDEO_BITRATE_MBPS,
            maxWidth,
            maxHeight,
            tonemappingAlgorithm: config.TONEMAPPING_ALGORITHM,
            deinterlaceMethod: config.DEINTERLACE_METHOD,
            audioCodec: config.AUDIO_CODEC,
            audioBitrateStereo: config.AUDIO_BITRATE_STEREO,
            audioBitrateSurround: config.AUDIO_BITRATE_SURROUND,
            audioVbr: config.AUDIO_VBR,
            audioBoost: config.AUDIO_BOOST,
            mediaSourceInfo: job.config.mediaSourceInfo,
            forceAudioTranscode: job.config.forceAudioTranscode,
            subtitleBurnIn: undefined, // No subtitle overlay for probe segments
            // A main run that fell back from NVENC keeps the GPU encoder's profile.
            softwareEncodeFallback: job.config.softwareEncodeFallback,
        };

        // Create stream directories matching the main job's demux layout
        const audioCount = job.config.audioTracks?.length ?? 0;
        const streamCount = audioCount + 1;
        for (let i = 0; i < streamCount; i++) {
            await fs.mkdir(path.join(tailDir, `stream_${i}`), {
                recursive: true,
            });
        }

        // F4: enumerate the demuxer list off the event loop; the builder reads it synchronously.
        const whitelistReady = prepareMediaFormatWhitelist();
        if (whitelistReady) await whitelistReady;
        const result = this.fullStrategy.buildArgs(strategyConfig);

        // CPU transcode of 30s of video can take 30-120s depending on codec/resolution.
        // Use a generous timeout but not unlimited.
        const timeout = 120_000;

        // A retire during the setup awaits above may have aborted us — bail
        // before spawning so no orphan ffmpeg outlives the retired generation.
        if (abortController.signal.aborted) return;

        try {
            const ffmpegResult = await spawnFFmpegSafely({
                args: result.args,
                timeout,
                abortSignal: abortController.signal,
                context: { jobId: job.id, purpose: 'tail-cache-transcode' },
            });

            if (ffmpegResult.exitCode !== 0) {
                logger.warn('Tail cache (transcode) FFmpeg failed', {
                    jobId: job.id,
                    exitCode: ffmpegResult.exitCode,
                    stderr: ffmpegResult.stderr.slice(0, 500),
                });
                return;
            }

            // A video-disabled run writes no video stream; it must not be
            // required (all-or-nothing read below).
            const writtenStreams = job.config.videoDisabled ? audioCount : streamCount;
            const streamDirs = Array.from({ length: writtenStreams }, (_, i) => `stream_${i}`);
            await this.cacheTailRunEndSegments(job, tailDir, streamDirs, 'transcode');
        } finally {
            await fs.rm(tailDir, { recursive: true, force: true }).catch(() => {});
            // Clear the abort controller now that the worker has finished.
            if (job.tailCacheAbortController === abortController) {
                job.tailCacheAbortController = null;
            }
        }
    }

    /**
     * Restore a transcode job from database metadata.
     * Used when a segment is requested but the job is not in memory (server restart scenario).
     *
     * @param metadata - Persisted job metadata from database
     * @returns Restored transcode job
     */
    async restoreJob(
        metadata: PersistedJobMetadata,
        options?: {
            /**
             * Did the segment that triggered this restore actually exist on disk?
             * The caller has just checked, and the answer decides whether FFmpeg
             * has anything left to do — see the adoption branch below.
             */
            segmentPresentOnDisk?: boolean;
            /**
             * Job-unit index of the segment whose request triggered this restore.
             * Lets FFmpeg resume at the viewer's position instead of regenerating
             * everything before it — see `resolveRestoreResumeStart`.
             */
            requiredSegmentIndex?: number;
            /**
             * The session was taken over from a peer pod whose row was still
             * active. That pod may be alive with its FFmpeg still writing into
             * the persisted output_dir, so a respawn goes to a fresh generation
             * directory instead — see `pickRestoreOutput`.
             */
            previousOwnerMayStillWrite?: boolean;
            /**
             * Background restore started when this pod claimed the session, while
             * the client is still being served from the pre-generated output.
             * FFmpeg resumes at the first segment the client will need next — the
             * one after the last segment on disk, or the requested one if later —
             * instead of at the persisted position.
             */
            prewarm?: boolean;
        },
    ): Promise<TranscodeJob> {
        // One restore per session at a time. A demux client sends audio and video
        // requests together; claimJobForRestoration accepts a row this pod already
        // owns, so both would spawn FFmpeg and the second registration would
        // orphan the first process.
        return this.withSessionStartLock(sessionKey(metadata.play_session_id), async () => {
            const resident = this.getJobByPlaySession(metadata.play_session_id);
            if (
                resident &&
                resident.status !== 'error' &&
                resident.status !== 'stopped' &&
                resident.status !== 'stopping'
            ) {
                logger.info('Restore skipped: the session already has a live job here', {
                    playSessionId: metadata.play_session_id,
                    jobId: resident.id,
                });
                return resident;
            }
            return this.restoreJobUnlocked(metadata, options);
        });
    }

    private async restoreJobUnlocked(
        metadata: PersistedJobMetadata,
        options?: {
            segmentPresentOnDisk?: boolean;
            requiredSegmentIndex?: number;
            previousOwnerMayStillWrite?: boolean;
            prewarm?: boolean;
        },
    ): Promise<TranscodeJob> {
        const age = Date.now() - metadata.created_at.getTime();
        logger.info('Restoring transcode job from persistence', {
            playSessionId: metadata.play_session_id,
            jobId: metadata.job_id,
            age,
            status: metadata.status,
            mode: metadata.mode,
            podName: metadata.pod_name,
        });

        // Wait for startup cleanup to complete (prevents race condition)
        await this.startupCleanupPromise;

        // Create job object from metadata
        const outputDirName = path.basename(metadata.output_dir);
        const restoredGenerationIndex = outputDirName.startsWith('gen-')
            ? parseInt(outputDirName.replace('gen-', ''), 10) || 1
            : 1;
        const restoredSessionOutputDir = outputDirName.startsWith('gen-')
            ? path.dirname(metadata.output_dir)
            : metadata.output_dir;
        // New rows restore their effective contract without deciding from requests
        // or host settings again. Legacy rows are upgraded once at this boundary.
        const hadPersistedPlan = !!metadata.config.effectivePlan;
        if (!metadata.config.effectivePlan) {
            metadata.config.effectivePlan = await computeEffectivePlan(
                metadata.config,
                metadata.transcode_decision ?? undefined,
            );
            metadata.config.effectivePlan.caps = computeEffectiveCaps(
                metadata.config,
                metadata.config.effectivePlan.decision,
            );
        }
        const restoredPlan = metadata.config.effectivePlan;
        const restoredDecision = restoredPlan.decision;
        if (hadPersistedPlan) {
            metadata.config = {
                ...metadata.config,
                startTimeSeconds: restoredPlan.startTimeSeconds,
                segmentDurationSeconds: restoredPlan.segmentDuration,
                gopSegments: restoredPlan.grid === 'gop',
            };
        }
        const persistedSegmentOffset = hadPersistedPlan
            ? restoredPlan.segmentOffset
            : metadata.segment_offset || 0;

        // The row's output_dir is per session, not per job: after a cross-pod
        // item switch this pod may still hold the OLD item's output at exactly
        // that path (HLS re-measure 2026-09-27 §6.3). Adopting it, or letting
        // job-restoration's segment wait find it next to a fresh FFmpeg, serves
        // the wrong item's bytes. Output not stamped for the row's item is not
        // this job's: wipe it before anything reads it.
        const outputIsRowItems = await this.purgeOutputNotStampedFor(metadata);
        const segmentPresentOnDisk = options?.segmentPresentOnDisk === true && outputIsRowItems;

        // Decided BEFORE the job is built, because adoption spawns no FFmpeg at
        // all: an adopted job must keep the persisted offset. Stamping a resume
        // onto it would describe a start that never happened over an output that
        // genuinely begins at 0 — and `saveJob` below persists that fiction, so
        // every later restore of this session would inherit the skew.
        const adoptCompleteOutput =
            segmentPresentOnDisk && (await this.fileManager.isOutputComplete(metadata.output_dir));

        // A respawn re-reads the persisted input path with no re-scan in
        // between, so a file that became a playlist/manifest body after the
        // job was created would be followed (final wave M1). Checked here,
        // before the job is registered or its output dir recreated, so a
        // refusal throws straight to the caller (job-restoration.ts), which
        // marks the row 'error' — never restorable again — and fails the
        // request. spawnFFmpeg re-checks as the backstop for every spawn.
        // Adoption spawns nothing, so it is not gated.
        if (!adoptCompleteOutput) {
            await assertTranscodeInputIsMedia(metadata.config);
        }

        const segmentDurationForResume =
            metadata.config.segmentDurationSeconds ?? serviceConfig.FFMPEG_SEGMENT_DURATION;
        const videoAction = restoredDecision?.videoAction;
        const isGopRestore = metadata.config.gopSegments === true;

        // The job as it stood before this restore: persisted dir and offset. Only
        // read from (grid, keyframes, per-stream offsets) — never registered.
        const probeJob = this.createJobObject(
            metadata.job_id,
            metadata.config,
            restoredSessionOutputDir,
            metadata.output_dir,
            restoredGenerationIndex,
            'previous',
            persistedSegmentOffset,
            restoredDecision,
            metadata.created_at,
        );

        // Prewarm: the client is still reading the pre-generated output, so the
        // first segment it will NOT find there is the one after the last on disk.
        // Resuming anywhere earlier (the persisted offset, usually 0) makes the
        // client's next request a forward seek that restarts FFmpeg again.
        let nextOnDisk: number | undefined;
        let requiredIndex = options?.requiredSegmentIndex;
        if (options?.prewarm === true && !adoptCompleteOutput && !isGopRestore) {
            nextOnDisk = await this.nextPublicSegmentOnDisk(probeJob, videoAction === 'transcode');
            if (nextOnDisk !== undefined) {
                requiredIndex = Math.max(requiredIndex ?? 0, nextOnDisk);
            }
        }

        let resume: { startSegment: number; startTimeSeconds: number } | undefined;
        // A resume that is not additive to the persisted output (copy / GOP grid):
        // FFmpeg renumbers from 0, so it needs a directory of its own.
        let resumeNeedsFreshGeneration = false;
        if (!adoptCompleteOutput) {
            if (videoAction === 'transcode') {
                resume = resolveRestoreResumeStart({
                    requiredSegmentIndex: requiredIndex,
                    persistedSegmentOffset,
                    segmentDurationSeconds: segmentDurationForResume,
                    isVideoTranscoded: true,
                });
            } else if (
                videoAction === 'copy' &&
                requiredIndex !== undefined &&
                Number.isFinite(requiredIndex) &&
                // Forward of the persisted start, or BEHIND it when the segment is
                // not on disk and nobody is prewarming: a job restarted at its old
                // offset (a previous prewarm's, prod 2026-11-01 20:54) can never
                // produce a segment below it, and the request would time out.
                (requiredIndex > persistedSegmentOffset ||
                    (requiredIndex < persistedSegmentOffset &&
                        !segmentPresentOnDisk &&
                        options?.prewarm !== true)) &&
                Number.isFinite(segmentDurationForResume) &&
                segmentDurationForResume > 0
            ) {
                // Same start a seek to that segment would pick (keyframe-aligned
                // time, grid entry), so the client's next request finds the file
                // it asks for instead of triggering a forward seek.
                let generationStart = this.resolveSeekStart(
                    probeJob,
                    metadata.play_session_id,
                    requiredIndex,
                    requiredIndex * segmentDurationForResume,
                ).generationStart;
                // The resume was derived from the end of the disk output (not from
                // a client that jumped ahead): a start above it leaves segments no
                // generation serves. Step back to the keyframe at or below it.
                if (nextOnDisk !== undefined && requiredIndex === nextOnDisk) {
                    let target = requiredIndex;
                    while (generationStart.startSegment > nextOnDisk && target > 1) {
                        target -= 1;
                        generationStart = this.resolveSeekStart(
                            probeJob,
                            metadata.play_session_id,
                            target,
                            target * segmentDurationForResume,
                        ).generationStart;
                    }
                }
                if (generationStart.startSegment !== persistedSegmentOffset) {
                    resume = generationStart;
                    resumeNeedsFreshGeneration = true;
                }
            }
        }

        const restoreOutput =
            (options?.previousOwnerMayStillWrite === true || resumeNeedsFreshGeneration) &&
            !adoptCompleteOutput
                ? await this.pickRestoreOutput(restoredSessionOutputDir, restoredGenerationIndex)
                : { outputDir: metadata.output_dir, generationIndex: restoredGenerationIndex };
        if (restoreOutput.outputDir !== metadata.output_dir) {
            logger.info('Restoring into a fresh generation', {
                playSessionId: metadata.play_session_id,
                jobId: metadata.job_id,
                previousOutputDir: metadata.output_dir,
                outputDir: restoreOutput.outputDir,
                previousOwnerMayStillWrite: options?.previousOwnerMayStillWrite === true,
                resumeSegment: resume?.startSegment,
            });
        }

        const job = this.createJobObject(
            metadata.job_id,
            resume
                ? { ...metadata.config, startTimeSeconds: resume.startTimeSeconds }
                : metadata.config,
            restoredSessionOutputDir,
            restoreOutput.outputDir,
            restoreOutput.generationIndex,
            'current',
            resume ? resume.startSegment : persistedSegmentOffset,
            restoredDecision,
            metadata.created_at,
        );

        job.restoredFromPersistence = true;

        // The persisted output path lives under /tmp and may disappear across
        // deploys or container restarts. Recreate it before spawning FFmpeg
        // because child_process.spawn uses this path as cwd.
        await this.fileManager.createOutputDirectory(job.outputDir);
        await this.stampOutputDir(job);

        // Register under the ORIGINAL-case id, not the `uuid` column's lowercased
        // one. Map lookups are case-folded either way (see `sessionKey`), but the
        // session records whichever id it was first created with and that is what
        // `getSessionOutputDir` derives the on-disk path from — so the config's
        // id, written when FFmpeg first named the directory, is the authority.
        const originalPlaySessionId = metadata.config?.playSessionId || metadata.play_session_id;
        // Older rows persisted a `config` without `playSessionId`. Teardown
        // (`retireJobGeneration`) and handleExit's `persistence.updateProgress`
        // both read the id straight off the config, so backfill it rather than
        // letting `undefined` reach the session maps and the database.
        job.config.playSessionId = originalPlaySessionId;
        this.registerCurrentJob(originalPlaySessionId, job);
        let retainedPrewarmJob: TranscodeJob | undefined;

        // The restored generation starts past the output the client is still
        // reading. Keep that output routable as a retained generation (as a seek
        // does with the generation it leaves) so requests below the new offset are
        // served from it instead of reading as backward seeks.
        if (
            !isGopRestore &&
            !adoptCompleteOutput &&
            nextOnDisk !== undefined &&
            nextOnDisk > persistedSegmentOffset &&
            restoreOutput.outputDir !== metadata.output_dir
        ) {
            const retained = probeJob;
            retainedPrewarmJob = retained;
            retained.id = randomUUID();
            retained.status = 'ready';
            retained.masterPlaylistReady = true;
            // Its files were written by a producer that is gone: the stale-segment
            // guard compares file mtimes with the generation's spawn time, and a
            // spawn time of "now" would reject every one of them (prod 2026-11-01:
            // nothing was served from the retained generation, so the new job was
            // reaped as never watched).
            retained.lastFFmpegSpawnTime = 0;
            retained.previousFFmpegSpawnTime = null;
            retained.segmentsReady = nextOnDisk - persistedSegmentOffset; // complete segments only
            retained.restoredFromPersistence = true;
            retained.config.playSessionId = originalPlaySessionId;
            this.jobs.set(retained.id, retained);
            this.setPreviousJob(originalPlaySessionId, retained);
        }

        logger.info('Transcode job restored from persistence', {
            jobId: job.id,
            playSessionId: metadata.play_session_id,
            mode: metadata.config.transcodeMode,
            segmentOffset: job.segmentOffset,
        });

        // A restore does NOT imply there is work left to do. The job is restored
        // whenever it is absent from THIS pod's memory — after a deploy, a reap,
        // or (before the `sessionKey` fix) simply because it was filed under a
        // differently-cased id. If the previous FFmpeg already wrote a complete
        // clip, respawning would rewrite every segment from index 0 underneath a
        // client that is reading them: `segmentsReady` collapses to 0, segment
        // requests block on `waitForRestoredSegment` (~8s measured in prod), and
        // the picture freezes while audio — buffered further ahead — plays on.
        // Adopt the finished output instead.
        //
        // Gated on the segment being PRESENT. `slidingWindowCleanup` prunes
        // segments behind the playhead for jobs in status 'ready', so a complete
        // manifest can legitimately be missing early segments; seeking back into
        // that gap is the one case where respawning really is required, and
        // adopting there would strand the request until `waitForRestoredSegment`
        // times out — turning a recoverable seek into a 503.
        if (adoptCompleteOutput) {
            job.status = 'ready';
            // No FFmpeg runs here, so there is no spawn the adopted files could
            // predate: the stale-segment guard must not refuse them.
            job.lastFFmpegSpawnTime = 0;
            job.previousFFmpegSpawnTime = null;
            // Not reachedEndOfInput: "complete" here only means every manifest
            // carries ENDLIST, which a SIGTERM flush writes too.
            job.masterPlaylistReady = true;
            const adoptedGopGrid = this.getGopGrid(job);
            if (adoptedGopGrid) {
                job.segmentsReady = adoptedGopGrid.count - job.segmentOffset;
            } else if (job.config.totalDurationSeconds && job.config.totalDurationSeconds > 0) {
                job.segmentsReady = uniformSegmentCount(
                    job.config.totalDurationSeconds,
                    job.segmentDurationSeconds,
                );
            }
            logger.info('Restored job adopted complete on-disk output — FFmpeg not restarted', {
                jobId: job.id,
                playSessionId: originalPlaySessionId,
                outputDir: job.outputDir,
                segmentsReady: job.segmentsReady,
            });
        } else {
            // Restart FFmpeg process
            try {
                await this.spawnFFmpeg(job);
                logger.info('FFmpeg process restarted for restored job', {
                    jobId: job.id,
                    playSessionId: metadata.play_session_id,
                    ffmpegPid: job.process?.pid,
                });
            } catch (err) {
                if (err instanceof ShutdownInterruptedError) throw err;
                if (options?.prewarm === true) {
                    // A background restore nobody is waiting on must not poison the
                    // row ('error' is terminal): drop what it registered, leave the
                    // row restorable, and let the caller back off.
                    logger.warn('Prewarm could not start FFmpeg — leaving the session restorable', {
                        jobId: job.id,
                        playSessionId: metadata.play_session_id,
                        error: (err as Error).message,
                    });
                    await this.abandonPrewarmedJob(job, retainedPrewarmJob, metadata.output_dir);
                    throw err;
                }
                job.status = 'error';
                job.error = (err as Error).message;
                logger.error('Failed to restart FFmpeg for restored job', err as Error, {
                    jobId: job.id,
                    playSessionId: metadata.play_session_id,
                });
            }
        }

        // Update database with new status, pod info, and progress in a single call
        try {
            await this.persistence.saveJob(job);
        } catch (err) {
            logger.warn('Failed to update restored job in database', {
                jobId: job.id,
                playSessionId: metadata.play_session_id,
                error: String(err),
            });
            // Non-fatal
        }

        // Start I-frame analysis worker for direct stream mode
        if (!metadata.config.isJellyfinTranscoded) {
            this.iframeAnalyzer.startAnalysis(job);
        }

        return job;
    }

    /** Undo a prewarm's registrations after its FFmpeg could not be started. */
    private async abandonPrewarmedJob(
        job: TranscodeJob,
        retained: TranscodeJob | undefined,
        persistedOutputDir: string,
    ): Promise<void> {
        if (retained) {
            await this.retireJobGeneration(retained, 'prewarm_failed', {
                deleteOutputDir: false,
            }).catch(() => {});
        }
        await this.retireJobGeneration(job, 'prewarm_failed', {
            // Only a directory this restore created; the persisted one is the
            // session's pre-generated output.
            deleteOutputDir: job.outputDir !== persistedOutputDir,
        }).catch(() => {});
    }

    /**
     * The first PUBLIC segment index a restore must produce: everything below it
     * is complete on disk in every stream. The minimum across streams, so a
     * lagging stream (audio ahead of video) cannot be skipped; a stream directory
     * that is empty or missing counts as 0 whenever another stream has files.
     * Undefined when nothing at all is on disk.
     *
     * The highest file of a stream is deliberately NOT counted: the previous
     * producer may have been killed mid-write, and nothing on disk says whether
     * its last segment is whole. It is produced again by the restored job and is
     * not routable from the retained generation.
     */
    private async nextPublicSegmentOnDisk(
        probe: TranscodeJob,
        isVideoTranscoded: boolean,
    ): Promise<number | undefined> {
        const root = probe.outputDir;
        const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
        const existing = entries
            .filter((entry) => entry.isDirectory() && /^stream_\d+$/.test(entry.name))
            .map((entry) => Number.parseInt(entry.name.slice('stream_'.length), 10));
        // Muxed output has one stream at the root. Demuxed output has stream_0 ..
        // stream_<audio count> (the video is last); expect every one of them, even
        // a directory FFmpeg never created.
        const streamDirs: string[] = [];
        if (existing.length === 0) {
            streamDirs.push('');
        } else {
            const last = Math.max(...existing, probe.config.audioTracks?.length ?? 0);
            for (let i = 0; i <= last; i++) streamDirs.push(`stream_${i}`);
        }
        let next: number | undefined;
        let anyFiles = false;
        for (const streamDir of streamDirs) {
            const names = await fs.readdir(path.join(root, streamDir)).catch(() => [] as string[]);
            let highest = -1;
            for (const name of names) {
                const match = /^segment_(\d+)\.(?:m4s|ts|mp4)$/.exec(name);
                if (match) highest = Math.max(highest, Number.parseInt(match[1], 10));
            }
            if (highest >= 0) anyFiles = true;
            // Transcoded video is numbered by its public index (-start_number);
            // everything else by distance from the stream's own offset.
            const offset = isVideoTranscoded
                ? 0
                : this.getStreamSegmentOffsetForJob(probe, streamDir);
            // `highest` complete segments are 0 .. highest-1; none when empty.
            const candidate = Math.max(highest, 0) + offset;
            next = next === undefined ? candidate : Math.min(next, candidate);
        }
        return anyFiles ? next : undefined;
    }

    /**
     * Output directory for a restore that took the session over from a live peer.
     *
     * The peer's FFmpeg is not ours to stop and can keep writing into the
     * persisted generation directory for as long as that pod lives (prod
     * 2026-10-15: web-0 wrote for 2 s after web-1 claimed the session, until its
     * own SIGTERM). Respawning into the same directory mixes two runs' output:
     * in GOP mode `ensureGopAssembler` empties the parts dirs, the peer drops a
     * part ~80 keyframes in, and the assembler — seeing content past entry 0
     * with no part on entry 0's keyframe yet — declares the stream broken and
     * trips GOP mode for the whole title. The legacy cut has the same race on
     * its segment files. A generation directory nobody else knows about cannot
     * receive the peer's writes; the old one is left to the peer and removed
     * with the session directory.
     */
    private async pickRestoreOutput(
        sessionOutputDir: string,
        persistedGenerationIndex: number,
    ): Promise<{ outputDir: string; generationIndex: number }> {
        // Above every generation on disk, not just the persisted one: the peer
        // may have started a later generation (a seek) it had not persisted yet.
        const names = await fs.readdir(sessionOutputDir).catch(() => [] as string[]);
        let highest = persistedGenerationIndex;
        for (const name of names) {
            const match = /^gen-(\d+)$/.exec(name);
            if (match) highest = Math.max(highest, Number.parseInt(match[1], 10));
        }
        const generationIndex = highest + 1;
        return {
            outputDir: buildGenerationOutputDir(sessionOutputDir, generationIndex),
            generationIndex,
        };
    }

    /**
     * Get existing job by playSessionId and update activity timestamp.
     *
     * Use this method when the access represents user activity that should
     * extend the job's lifetime (e.g., status checks, segment recording).
     *
     * For high-frequency lookups where updating the timestamp would be
     * wasteful (e.g., segment existence checks), use getJobByPlaySession instead.
     */
    getJob(playSessionId: string): TranscodeJob | undefined {
        const jobId = this.jobsByPlaySession.get(sessionKey(playSessionId));
        if (!jobId) return undefined;

        const job = this.jobs.get(jobId);
        if (job) {
            job.lastAccessedAt = new Date();
            // Update database timestamp (async, non-blocking). Pod-guarded:
            // own-job write, see updateLastAccessed in transcode-jobs.queries.ts.
            this.persistence.updateLastAccessed(playSessionId, getCurrentPodName()).catch((err) => {
                logger.debug('Failed to update lastAccessedAt in DB', {
                    playSessionId,
                    error: String(err),
                });
            });
        }
        return job;
    }

    /**
     * Get job status
     */
    getJobStatus(playSessionId: string): TranscodeJobStatus | undefined {
        const job = this.getJob(playSessionId);
        if (!job) return undefined;

        return {
            jobId: job.id,
            status: job.status,
            segmentsReady: job.segmentsReady,
            masterPlaylistReady: job.masterPlaylistReady,
            error: job.error,
            elapsedSeconds: Math.floor((Date.now() - job.startedAt.getTime()) / 1000),
        };
    }

    getPlayerTranscodeProgress(playSessionId: string): PlayerTranscodeProgressInfo | undefined {
        // Polling progress is observation, not evidence of media consumption.
        const job = this.getJobByPlaySession(playSessionId);
        if (!job) return undefined;

        const totalDuration = job.config.totalDurationSeconds || 0;
        const decision = job.transcodeDecisionResult;

        return {
            ...buildCoverageProgress({
                totalDurationSeconds: totalDuration,
                segmentDurationSeconds: job.segmentDurationSeconds,
                ranges: sessionCoveredRanges(job, totalDuration),
                encoderSeconds: producedMediaSeconds(job),
                speed: job.transcodeSpeed,
            }),
            elapsedSeconds: Math.floor((Date.now() - job.startedAt.getTime()) / 1000),
            fps: job.transcodeFps,
            speed: job.transcodeSpeed,
            throttled: job.throttledAt !== undefined,
            bufferAheadSeconds: roundAhead(bufferAheadSeconds(job)),
            transcodeType: decision
                ? classifyTranscodeType(
                      decision.videoAction,
                      decision.audioAction,
                      decision.needsTonemapping,
                      job.config.videoDisabled,
                  )
                : 'unknown',
            videoAction: decision?.videoAction,
            audioAction: decision?.audioAction,
            isHardwareAccelerated: decision?.useGpu ?? false,
            gpuEncoder: decision?.gpuEncoder,
            gpuDecoder: decision?.gpuDecoder,
            hdrTonemapMode: decision?.hdrTonemapMode,
            slowReason: slowTranscodeReason(job, Date.now()),
            softwareFallbackFrom: job.config.softwareEncodeFallback,
        };
    }

    /**
     * The encoder notice for a session's transcode (slow, software fallback),
     * for the player's startup poll — before the player's first heartbeat
     * creates the play-session row, so the transcode job's owner is the only
     * ownership there is. Same arms as the HLS master route: the resident job's
     * `config.username`, else the persisted transcode row's owner (exact
     * compare). Undefined for no job, or a job `username` does not own.
     */
    async getEncoderNotice(
        playSessionId: string,
        username: string,
    ): Promise<
        Pick<PlayerTranscodeProgressInfo, 'slowReason' | 'softwareFallbackFrom'> | undefined
    > {
        // getJobByPlaySession, not getJob: a poll must not count as access
        // (getJob bumps lastAccessedAt and the row), least of all a
        // non-owner's, which would keep the job alive.
        const job = this.getJobByPlaySession(playSessionId);
        if (job) {
            if (job.config.username !== username) return undefined;
            return {
                slowReason: slowTranscodeReason(job, Date.now()),
                softwareFallbackFrom: job.config.softwareEncodeFallback,
            };
        }
        const owner = await this.getPersistedJobOwner(sessionKey(playSessionId)).catch(() => null);
        if (owner === null || owner !== username) return undefined;
        const progress = await this.getPlayerTranscodeProgressMultiPod(playSessionId);
        if (!progress) return undefined;
        return {
            slowReason: progress.slowReason,
            softwareFallbackFrom: progress.softwareFallbackFrom,
        };
    }

    async getPlayerTranscodeProgressMultiPod(
        playSessionId: string,
    ): Promise<PlayerTranscodeProgressInfo | undefined> {
        const local = this.getPlayerTranscodeProgress(playSessionId);
        if (local) return local;

        // Another pod owns the job (the router hashes the player's API calls by
        // client IP, its segment requests by session). One row plus the owner's
        // Valkey stats — this runs on every progress poll, so no full scan.
        // The row carries the dashed lowercase id (see sessionKey).
        const row = await this.persistence.getJob(sessionKey(playSessionId)).catch((err) => {
            logger.warn('Cross-pod transcode progress read failed', {
                playSessionId,
                error: String(err),
            });
            return null;
        });
        if (!row || !['starting', 'running', 'ready'].includes(row.status)) return undefined;
        const stats = await readJobStats(row.job_id);

        const segmentDuration = row.config.segmentDurationSeconds ?? config.FFMPEG_SEGMENT_DURATION;
        const totalDuration = row.config.totalDurationSeconds || 0;
        // Earlier generations' ranges are persisted in the row's config.
        const rowJob = {
            segmentOffset: row.segment_offset,
            segmentsReady: row.segments_ready,
            segmentDurationSeconds: segmentDuration,
        };
        const decision = row.transcode_decision;
        const fallbackFrom = row.config.softwareEncodeFallback ?? stats?.softwareFallbackFrom;
        const transcodeType =
            jobConfigKind(row.config) === 'audiobook'
                ? 'audiobook-remux'
                : decision
                  ? classifyTranscodeType(
                        decision.videoAction,
                        decision.audioAction,
                        decision.needsTonemapping,
                        row.config.videoDisabled,
                    )
                  : 'unknown';

        return {
            ...buildCoverageProgress({
                totalDurationSeconds: totalDuration,
                segmentDurationSeconds: segmentDuration,
                ranges: mergeRanges([
                    ...(row.config.coveredRanges ?? []),
                    currentGenerationRange(rowJob, totalDuration),
                ]),
                encoderSeconds: producedMediaSeconds(rowJob),
                speed: stats?.transcodeSpeed,
            }),
            elapsedSeconds: Math.floor((Date.now() - row.created_at.getTime()) / 1000),
            fps: stats?.transcodeFps,
            speed: stats?.transcodeSpeed,
            throttled: stats?.throttled,
            bufferAheadSeconds: roundAhead(stats?.bufferAheadSeconds),
            transcodeType,
            videoAction: decision?.videoAction,
            audioAction: decision?.audioAction,
            // The row's decision stays the GPU one after a software fallback;
            // its config (persisted at the switch) or the owner's stats say so.
            isHardwareAccelerated: fallbackFrom ? false : (decision?.useGpu ?? false),
            gpuEncoder: fallbackFrom ? undefined : decision?.gpuEncoder,
            gpuDecoder: fallbackFrom ? undefined : decision?.gpuDecoder,
            hdrTonemapMode: decision?.hdrTonemapMode,
            slowReason: stats?.slowReason,
            softwareFallbackFrom: fallbackFrom,
        };
    }

    /**
     * Get info needed to generate a complete VOD manifest.
     * This allows the player to know total duration and seek properly.
     *
     * IMPORTANT: We always return the FULL duration of the video, not reduced
     * by start time. This ensures:
     * 1. The player sees the complete timeline
     * 2. Users can seek to any position (including before their start point)
     * 3. Segment numbers in the manifest match timeline positions
     *
     * The segmentOffset handles the translation between manifest segment numbers
     * and actual FFmpeg output files.
     */
    getVodManifestInfo(playSessionId: string): VodManifestInfo | undefined {
        const job = this.getJob(playSessionId);
        if (!job) return undefined;

        const totalDuration = job.config.totalDurationSeconds;
        if (!totalDuration || totalDuration <= 0) return undefined;

        // Use FULL duration - don't subtract start time
        // The manifest shows the complete timeline, segmentOffset handles translation
        const segmentDuration = job.segmentDurationSeconds;
        const totalSegments = uniformSegmentCount(totalDuration, segmentDuration);

        // Compute keyframe-based segment durations for copy-mode video.
        // This replaces synthetic uniform estimates with real GOP-aligned boundaries.
        let keyframeSegmentDurations: number[] | undefined;
        let keyframeStreamOffset: number | undefined;
        if (job.keyframeData && job.keyframeData.length > 0) {
            keyframeSegmentDurations = computeSegmentsFromKeyframes(
                job.keyframeData,
                totalDuration,
                segmentDuration,
            );
            // Compute the keyframe segment index covering the FFmpeg start time.
            // This diverges from uniform floor(time/duration) at high positions
            // (e.g., uniform=1097 vs keyframe=1051 at ~10970s with ~10.4s GOPs).
            const startTime = job.config.startTimeSeconds ?? 0;
            if (startTime > 0) {
                keyframeStreamOffset = getKeyframeSegmentIndexForTime(
                    startTime,
                    job.keyframeData,
                    totalDuration,
                    segmentDuration,
                );
            }
        }

        return {
            totalDurationSeconds: totalDuration,
            segmentDurationSeconds: segmentDuration,
            totalSegments,
            segmentsReady: job.segmentsReady,
            isComplete: job.status === 'stopped',
            segmentOffset: job.segmentOffset,
            startTimeSeconds: job.config.startTimeSeconds,
            keyframeSegmentDurations,
            keyframeStreamOffset,
        };
    }

    getSegmentOffsetForJob(job: TranscodeJob): number {
        return job.segmentOffset;
    }

    getStreamTargetDurationForJob(job: TranscodeJob, streamDir: string): number | undefined {
        // GOP mode counts every stream in grid entries; no per-stream rescaling.
        if (isGopModeJob(job)) return undefined;
        return job.streamTargetDurations.get(streamDir);
    }

    // ------------------------------------------------------------------------
    // GOP mode (services/hls/gop-grid.ts)
    // ------------------------------------------------------------------------

    /**
     * Titles whose GOP-mode generation broke recently. A break fails the
     * generation closed (410 → the client restarts); without this, a title that
     * breaks deterministically would restart into the same break forever. The
     * next job for it takes the legacy cut instead.
     */
    private readonly gopTrips = new Map<string, number>();

    private gopTripKey(cfg: TranscodeJobConfig): string {
        return `${cfg.itemId}|${cfg.localFilePath ?? ''}`;
    }

    private tripGop(cfg: TranscodeJobConfig, reason: string): void {
        this.gopTrips.set(this.gopTripKey(cfg), Date.now());
        logger.warn('GOP mode: tripped for this title; next jobs use the legacy cut', {
            itemId: cfg.itemId,
            reason,
        });
    }

    private isGopTripped(cfg: TranscodeJobConfig): boolean {
        const at = this.gopTrips.get(this.gopTripKey(cfg));
        if (at === undefined) return false;
        if (Date.now() - at > GOP_TRIP_TTL_MS) {
            this.gopTrips.delete(this.gopTripKey(cfg));
            return false;
        }
        return true;
    }

    /** The job's keyframe grid, built once. Null when the job is not in GOP mode. */
    getGopGrid(job: TranscodeJob): GopGrid | null {
        if (!isGopModeJob(job)) return null;
        if (!job.gopGrid) {
            job.gopGrid =
                buildGopGrid(
                    job.keyframeData ?? [],
                    job.config.totalDurationSeconds ?? 0,
                    job.segmentDurationSeconds,
                ) ?? undefined;
        }
        return job.gopGrid ?? null;
    }

    /**
     * Create (once per generation) and start the assembler that turns this
     * generation's per-keyframe parts into grid entries. A ladder respawn of the
     * same job keeps the assembler and its position.
     */
    private async ensureGopAssembler(job: TranscodeJob): Promise<void> {
        const grid = this.getGopGrid(job);
        if (!grid) return;
        const audioCount = job.config.audioTracks?.length ?? 0;
        const videoIndex = audioCount;
        const dirs = [
            ...Array.from({ length: audioCount }, (_, i) => gopAudioPartsDirName(i)),
            gopVideoPartsDirName(videoIndex),
            ...Array.from({ length: audioCount + 1 }, (_, i) => `stream_${i}`),
        ];
        // Every spawn starts a fresh run from the generation start, writing part
        // names from scratch: drop the previous run's assembler and leftovers
        // (a ladder respawn, or a restore over a crashed run's output) so two
        // runs' parts can never mix. Assembled entries stay; they are rebuilt
        // identically and replaced atomically.
        await job.gopAssembler?.stop();
        job.gopAssembler = undefined;
        for (const d of dirs) {
            if (!d.startsWith('stream_')) {
                await fs.rm(path.join(job.outputDir, d), { recursive: true, force: true });
            }
            await fs.mkdir(path.join(job.outputDir, d), { recursive: true });
        }
        const assembler = new GopSegmentAssembler({
            grid,
            gridOffset: job.segmentOffset,
            segmentSeconds: job.segmentDurationSeconds,
            log: logger,
            streams: [
                ...Array.from({ length: audioCount }, (_, i) => ({
                    kind: 'audio' as const,
                    streamDir: path.join(job.outputDir, `stream_${i}`),
                    partsDir: path.join(job.outputDir, gopAudioPartsDirName(i)),
                    partPrefix: GOP_AUDIO_PART_PREFIX,
                    initName: `init_${i}.mp4`,
                })),
                {
                    kind: 'video' as const,
                    streamDir: path.join(job.outputDir, `stream_${videoIndex}`),
                    partsDir: path.join(job.outputDir, gopVideoPartsDirName(videoIndex)),
                    partPrefix: GOP_VIDEO_PART_PREFIX,
                    initName: `init_${videoIndex}.mp4`,
                },
            ],
            onProgress: (ready) => {
                if (ready > job.segmentsReady) {
                    job.segmentsReady = ready;
                    job.lastProgressAt = new Date();
                }
            },
            onBroken: (reason) => {
                job.gopBroken = reason;
                this.tripGop(job.config, reason);
            },
        });
        job.gopAssembler = assembler;
        assembler.start();
    }

    /** FFmpeg exited cleanly at the end of its input: assemble the tail entries. */
    private async finishGopAssembly(job: TranscodeJob): Promise<number | null> {
        const grid = this.getGopGrid(job);
        if (!grid || !job.gopAssembler) return null;
        await job.gopAssembler.tick({ final: true });
        job.segmentsReady = Math.max(job.segmentsReady, job.gopAssembler.readyEntries);
        // Like a completed legacy remux: flush the count now, so a cross-pod or
        // post-GC progress read reports the finished generation.
        if (job.generationRole === 'current' && job.gopAssembler.complete) {
            await this.persistence
                .updateProgress(job.config.playSessionId, job.segmentsReady, true)
                .catch(() => {
                    /* non-fatal: next periodic flush / read reconciles */
                });
        }
        return grid.count - job.segmentOffset;
    }

    /**
     * Cache the per-stream HLS TARGETDURATION discovered from FFmpeg's manifest.
     * Video in remux mode has ~10s segments (keyframe-aligned) while audio has ~6s.
     */
    setStreamTargetDuration(
        playSessionId: string,
        streamDir: string,
        targetDuration: number,
    ): void {
        const job = this.getJob(playSessionId);
        if (!job) return;
        job.streamTargetDurations.set(streamDir, targetDuration);
    }

    /**
     * Get the cached TARGETDURATION for a specific stream.
     * Returns undefined if not yet discovered (falls back to global FFMPEG_SEGMENT_DURATION).
     */
    getStreamTargetDuration(playSessionId: string, streamDir: string): number | undefined {
        const job = this.getJob(playSessionId);
        return job ? this.getStreamTargetDurationForJob(job, streamDir) : undefined;
    }

    /**
     * Compute per-stream segment offset from the global (audio-based) offset.
     * The global offset is in audio segments (6s each). For video streams with
     * larger target duration (~10s), the offset needs to be scaled.
     *
     * @returns The segment offset for this specific stream
     */
    getStreamSegmentOffset(playSessionId: string, streamDir: string): number {
        const job = this.getJob(playSessionId);
        if (!job) return 0;
        return this.getStreamSegmentOffsetForJob(job, streamDir);
    }

    getStreamSegmentOffsetForJob(job: TranscodeJob, streamDir: string): number {
        // Preview jobs use a self-contained mini-playlist starting at the seek
        // point (FFmpeg startNumber=0, segments numbered from 0). The per-stream
        // offset must match — otherwise the segment handler interprets hls.js's
        // "first segment" request as a backward seek and re-transcodes from 0.
        if (job.config.isPreview) {
            return 0;
        }
        // GOP mode: every stream is on the keyframe grid, and the generation's
        // offset IS its first grid entry.
        if (isGopModeJob(job)) {
            return job.segmentOffset;
        }
        const seekTimeSeconds = Math.max(
            0,
            job.config.startTimeSeconds ?? job.segmentOffset * job.segmentDurationSeconds,
        );

        if (
            job.config.hlsOutput?.hlsAudioMode === 'muxed' &&
            streamDir === '' &&
            job.transcodeDecisionResult?.videoAction === 'copy' &&
            job.keyframeData &&
            job.keyframeData.length > 0 &&
            job.config.totalDurationSeconds
        ) {
            return getKeyframeSegmentIndexForTime(
                seekTimeSeconds,
                job.keyframeData,
                job.config.totalDurationSeconds,
                job.segmentDurationSeconds,
            );
        }

        const videoStreamDir = `stream_${job.config.audioTracks?.length ?? 0}`;

        // Copy-mode video: offset must match the keyframe-space offset used
        // by the VOD playlist so segment N in the playlist maps to FFmpeg
        // file segment_(N - offset).
        if (
            job.transcodeDecisionResult?.videoAction === 'copy' &&
            streamDir === videoStreamDir &&
            job.segmentOffset > 0
        ) {
            // Demux mode: video must use uniform offset (same as audio) so
            // both playlists have aligned segment numbers. Safari/AVPlayer
            // matches demuxed streams by segment number — keyframe offset
            // (e.g. 479) vs audio uniform offset (499) causes 200+ second
            // A/V desync. The segment handler translates uniform indices
            // to keyframe FFmpeg files at serving time.
            if (job.config.hlsOutput?.hlsAudioMode === 'demux') {
                return Math.floor(seekTimeSeconds / job.segmentDurationSeconds);
            }
            // Muxed mode / no keyframes: use uniform grid with preroll offset.
            return Math.max(0, job.segmentOffset - 1);
        }

        const streamTargetDuration = job.streamTargetDurations.get(streamDir);
        if (!isDistinctStreamDuration(streamTargetDuration, job.segmentDurationSeconds)) {
            return Math.floor(seekTimeSeconds / job.segmentDurationSeconds);
        }

        // Convert global offset to stream-specific offset (remux mode:
        // video ~10s vs audio ~6s)
        return Math.floor(seekTimeSeconds / streamTargetDuration!);
    }

    /**
     * Check if a stream is authoritative for seeking (i.e., can trigger seek operations).
     * In demuxed HLS (separate audio + video streams), only video is authoritative.
     * Audio streams should follow video's position, not trigger independent seeks
     * which cause seek storms (audio and video fighting over the transcode position).
     *
     * Uses the transcode decision to identify the video stream by its output index.
     * Falls back to duration-based heuristic only when no decision is available.
     */
    canStreamTriggerSeek(playSessionId: string, streamDir: string): boolean {
        const job = this.getJob(playSessionId);
        if (!job) return true;
        return this.canStreamTriggerSeekForJob(job, streamDir);
    }

    canStreamTriggerSeekForJob(job: TranscodeJob, streamDir: string): boolean {
        // `videoDisabled` is honoured alongside the muxed flag because an
        // audio-only job's output is a single flat rendition whatever the
        // config says — there is no video stream for it to defer to, so it is
        // always authoritative. The job config is pinned to muxed at assembly
        // (see hls/playback.service.ts), but restoreJob replays configs written
        // by older builds, which can still carry the plan's 'demux'.
        if (
            (job.config.hlsOutput?.hlsAudioMode === 'muxed' || job.config.videoDisabled) &&
            streamDir === ''
        ) {
            return true;
        }

        const decision = job.transcodeDecisionResult;

        // If we have a transcode decision, use the video stream index directly.
        // Video is always the last output stream in our FFmpeg mapping.
        if (decision) {
            const audioTrackCount = job.config.audioTracks?.length ?? 0;
            const videoStreamDir = `stream_${audioTrackCount}`;

            // Only one video stream exists — if this IS it, allow seeking
            if (streamDir === videoStreamDir) return true;

            // This is an audio stream — block seeking (video is authoritative)
            return false;
        }

        // Fallback: duration-based heuristic (legacy / no decision available)
        const streamTd = job.streamTargetDurations.get(streamDir);
        if (!streamTd) return true;

        if (isDistinctStreamDuration(streamTd, job.segmentDurationSeconds)) {
            return true;
        }

        for (const otherTd of job.streamTargetDurations.values()) {
            if (isDistinctStreamDuration(otherTd, job.segmentDurationSeconds)) {
                return false;
            }
        }

        return true;
    }

    /**
     * Record that a segment was served to track playback position.
     * Called by the segment serving endpoint.
     *
     * @param playSessionId - The play session ID
     * @param streamDir - Stream directory name (e.g., "stream_0")
     * @param segmentIndex - The segment index that was served
     */
    recordSegmentAccess(playSessionId: string, streamDir: string, segmentIndex: number): void {
        const job = this.getJob(playSessionId);
        if (!job) return;
        this.recordSegmentAccessForJob(job, streamDir, segmentIndex);
    }

    recordSegmentAccessForJob(job: TranscodeJob, streamDir: string, segmentIndex: number): void {
        const currentMax = job.lastServedSegment.get(streamDir) ?? -1;
        if (segmentIndex > currentMax) {
            job.lastServedSegment.set(streamDir, segmentIndex);
            logger.debug('Segment access recorded', {
                jobId: job.id,
                streamDir,
                segmentIndex,
                previousMax: currentMax,
            });
        }
    }

    /**
     * Record a segment request for the transcode throttle, BEFORE the handler
     * waits for or serves the file. `requestedSegmentNum` is the absolute
     * playlist index and `segmentDurationSeconds` that stream's target
     * duration, so the product is media time whatever the stream's numbering.
     * For keyframe-aligned remux video the target duration is the longest
     * segment, which overstates the position — the safe direction, as it only
     * shrinks the measured lead.
     *
     * A request for a segment that is not on disk yet means the player is
     * waiting on FFmpeg: a throttled process is continued at once instead of on
     * the next tick, so a mis-measured lead costs one short wait, never a stall.
     */
    recordSegmentRequestForJob(
        job: TranscodeJob,
        streamDir: string,
        requestedSegmentNum: number,
        segmentDurationSeconds: number,
        fileExists: boolean,
    ): void {
        if (requestedSegmentNum < 0 || !(segmentDurationSeconds > 0)) return;
        job.lastSegmentRequestedAt = Date.now();
        // A parked retained generation is only woken by a reclaim.
        if (job.parked) return;
        (job.requestedMediaSeconds ??= new Map()).set(
            streamDir,
            (requestedSegmentNum + 1) * segmentDurationSeconds,
        );
        if (!fileExists) {
            job.throttleHoldUntil = Date.now() + THROTTLE_HOLD_AFTER_WAIT_MS;
            if (job.throttledAt) {
                this.resumeThrottledJob(job, 'segment_not_ready');
                return;
            }
        }
        this.applyThrottle(job);
    }

    /**
     * Pause or resume one job's FFmpeg according to {@link decideThrottle}.
     * Only a live, current-generation playback process is throttled: cache-
     * backed previews, seeks in flight and finished jobs are left alone (a
     * paused one of those is resumed).
     */
    private applyThrottle(job: TranscodeJob): void {
        // A parked generation stays stopped until a reclaim or a kill.
        if (job.parked) return;
        const proc = job.process;
        const alive = !!proc?.pid && proc.exitCode === null && proc.signalCode === null;
        const eligible =
            alive &&
            process.platform !== 'win32' &&
            !this.isShuttingDown &&
            !job.isSeeking &&
            !job.killRequested &&
            job.generationRole === 'current' &&
            (job.status === 'running' || job.status === 'ready') &&
            !job.config.outputDir &&
            !job.config.cacheKey &&
            !job.config.isPreview;
        const decision = decideThrottle({
            enabled: eligible && config.TRANSCODE_THROTTLE,
            throttled: job.throttledAt !== undefined,
            aheadSeconds: bufferAheadSeconds(job),
            pauseAfterSeconds: config.THROTTLE_AFTER_SECONDS,
        });
        if (decision === 'pause') {
            if ((job.throttleHoldUntil ?? 0) > Date.now()) return;
            this.pauseThrottledJob(job);
        } else if (decision === 'resume') {
            this.resumeThrottledJob(job, 'caught_up');
        }
    }

    private pauseThrottledJob(job: TranscodeJob): void {
        try {
            if (!job.process?.kill('SIGSTOP')) return;
            job.throttlePaused = true;
        } catch (err) {
            logger.warn('Transcode throttle could not pause FFmpeg', {
                jobId: job.id,
                error: String(err),
            });
            return;
        }
        job.throttledAt = new Date();
        this.publishThrottleChange();
        logger.debug('Transcode throttled — FFmpeg paused ahead of the player', {
            jobId: job.id,
            playSessionId: job.config.playSessionId,
            aheadSeconds: bufferAheadSeconds(job),
        });
    }

    /**
     * A pod that does not own the job reads the throttle state from the
     * Valkey stats, which otherwise refresh every 10 s — publish on the edge so
     * the player sees a pause/resume within one poll.
     */
    private publishThrottleChange(): void {
        if (this.statsPublishRunning) return;
        this.statsPublishRunning = true;
        void this.publishResourceStats().finally(() => {
            this.statsPublishRunning = false;
        });
    }

    private resumeThrottledJob(
        job: TranscodeJob,
        reason: 'caught_up' | 'segment_not_ready' | 'reclaimed',
    ): void {
        // Only a reclaim (or a kill) ends parking; any other wake-up would let a
        // retained generation encode on unthrottled next to the current one.
        if (job.parked) {
            if (reason !== 'reclaimed') return;
            job.parked = undefined;
            job.parkedAt = undefined;
        }
        const pausedAt = job.throttledAt;
        if (!pausedAt) return;
        job.throttledAt = undefined;
        // A process that died while stopped (SIGKILL, OOM) only needs the flag
        // cleared — this runs from the tick once it is no longer alive.
        const proc = job.process;
        if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
            job.throttlePaused = false;
            return;
        }
        // FFmpeg made no progress while stopped, and the no-heartbeat reaper reads
        // lastProgressAt: without this refresh a job paused for longer than
        // FFMPEG_PROGRESS_TIMEOUT_SECONDS would be reaped the moment it resumes.
        job.lastProgressAt = new Date();
        restartRateWindow(job);
        job.slowTranscode = restartSlowTracking(job.slowTranscode, Date.now());
        try {
            if (job.process?.kill('SIGCONT')) job.throttlePaused = false;
            else job.throttledAt = pausedAt;
        } catch {
            job.throttledAt = pausedAt;
            /* process already gone — handleExit owns the cleanup */
        }
        this.publishThrottleChange();
        logger.debug('Transcode throttle released — FFmpeg resumed', {
            jobId: job.id,
            playSessionId: job.config.playSessionId,
            reason,
            pausedSeconds: Math.round((Date.now() - pausedAt.getTime()) / 1000),
            aheadSeconds: bufferAheadSeconds(job),
        });
    }

    /**
     * Record a progress heartbeat from the client.
     * Called by the progress endpoint when eventType is 'progress'.
     * This keeps the session alive even when video is paused (clients send every 10s).
     *
     * @param playSessionId - The play session ID
     */
    /** Last DB write time per session for debouncing heartbeat persistence */
    private lastProgressDbWrite = new Map<string, number>();

    /**
     * Record a progress heartbeat from the player (via play-sessions endpoint).
     * Updates in-memory timestamp on every call. Persists to DB at most every 60s
     * to avoid write spam (player sends heartbeats every ~10s).
     *
     * `status` is the play session's reported status, when the caller has it.
     * `lastProgressAt` (any status) always advances — that one guards the
     * reaper's "has anyone been here at all recently" decision, and a paused
     * client's heartbeat MUST count there or a pause would get the job fully
     * torn down. `lastActiveProgressAt` only advances on `'ACTIVE'` — that one
     * feeds `selectEvictionVictim`, where a paused session must age normally
     * instead of looking permanently fresh. Missing/undefined status is
     * treated as active (the pre-existing behavior for any caller that hasn't
     * been updated to pass it), not as a reason to freeze eviction priority.
     */
    recordProgressHeartbeat(
        playSessionId: string,
        status?: 'ACTIVE' | 'PAUSED',
        ownerUsername?: string,
    ): void {
        const jobId = this.jobsByPlaySession.get(sessionKey(playSessionId));
        const job = jobId ? this.jobs.get(jobId) : undefined;
        // `ownerUsername`: a caller whose id is not tied to a play_sessions row
        // it owns (/j progress reports name only a PlaySessionId) passes the
        // reporter, so another user cannot keep this job alive.
        if (job && ownerUsername !== undefined && job.config.username !== ownerUsername) return;
        if (!job) {
            // The router hashes /api/v1/play-sessions/<id> by client IP, not by
            // PlaySessionId, so with several web pods a heartbeat often lands on
            // a pod that does not own the job. Hand it to the owner through the
            // row its reaper reads every sweep (the client-gone arm). Not
            // debounced: one indexed UPDATE per ~30s heartbeat, and a per-id
            // debounce map here would grow with every session this pod never owns.
            // No pod guard on purpose (it is the owner's row); takeover and
            // restore key off last_accessed_at, which this leaves alone.
            this.persistence
                .updateLastProgress(playSessionId, undefined, ownerUsername)
                .catch((err) => {
                    logger.warn('Failed to persist cross-pod progress heartbeat', {
                        playSessionId,
                        error: String(err),
                    });
                });
            return;
        }

        const now = Date.now();
        job.lastProgressAt = new Date(now);
        job.lastClientHeartbeatAt = new Date(now);
        if (status !== 'PAUSED') {
            job.lastActiveProgressAt = new Date(now);
        }

        // Debounce DB writes — persist every 60s
        const lastWrite = this.lastProgressDbWrite.get(playSessionId) ?? 0;
        if (now - lastWrite < 60_000) return;

        this.lastProgressDbWrite.set(playSessionId, now);
        this.persistence.updateLastProgress(playSessionId, getCurrentPodName()).catch((err) => {
            logger.warn('Failed to persist progress heartbeat', {
                playSessionId,
                error: String(err),
            });
        });
    }

    /**
     * Check if a segment was deleted (for returning 410 Gone)
     */
    isSegmentDeleted(playSessionId: string, streamDir: string, segmentIndex: number): boolean {
        const jobId = this.jobsByPlaySession.get(sessionKey(playSessionId));
        if (!jobId) return false;

        const job = this.jobs.get(jobId);
        if (!job) return false;
        return this.isSegmentDeletedForJob(job, streamDir, segmentIndex);
    }

    isSegmentDeletedForJob(job: TranscodeJob, streamDir: string, segmentIndex: number): boolean {
        const deletedUpTo = job.deletedUpTo.get(streamDir) ?? -1;
        return segmentIndex <= deletedUpTo;
    }

    getPreviousJobByPlaySession(playSessionId: string): TranscodeJob | undefined {
        const jobId = this.getPreviousJobId(playSessionId);
        if (!jobId) return undefined;
        return this.jobs.get(jobId);
    }

    private getGenerationRouterAdapter(): HlsGenerationRouterAdapter {
        return {
            getSegmentOffsetForJob: (job) => this.getSegmentOffsetForJob(job),
            getStreamSegmentOffsetForJob: (job, streamDir) =>
                this.getStreamSegmentOffsetForJob(job, streamDir),
            getStreamTargetDurationForJob: (job, streamDir) =>
                this.getStreamTargetDurationForJob(job, streamDir),
            isSegmentDeletedForJob: (job, streamDir, segmentIndex) =>
                this.isSegmentDeletedForJob(job, streamDir, segmentIndex),
        };
    }

    async resolveSegmentRoute(
        playSessionId: string,
        streamDir: string,
        requestedSegmentNum: number,
        options?: {
            normalizedPath?: string;
            segmentExtension?: string;
            fallbackSegmentExtension?: string;
            excludeJobIds?: Iterable<string>;
            requireRetainedFile?: boolean;
            fileExists?: (filePath: string) => Promise<boolean>;
            /** False for I-frame/thumbnail byte-range requests: they never move a session. */
            allowReclaim?: boolean;
        },
    ): Promise<SegmentGenerationRoute | undefined> {
        const segmentName = `segment_${requestedSegmentNum
            .toString()
            .padStart(5, '0')}.${options?.fallbackSegmentExtension ?? 'm4s'}`;
        // Fresh state on every resolve: a concurrent request may have reclaimed
        // or parked a generation while this one awaited.
        const resolve = (excludeJobIds?: Iterable<string>) =>
            resolveHlsGenerationRoute({
                current: this.getJobByPlaySession(playSessionId),
                retained: this.getRetainedJobsByPlaySession(playSessionId),
                streamDir,
                requestedSegmentNum,
                normalizedPath:
                    options?.normalizedPath ??
                    (streamDir ? `${streamDir}/${segmentName}` : segmentName),
                segmentExtension: options?.segmentExtension ?? '',
                fallbackSegmentExtension: options?.fallbackSegmentExtension ?? 'm4s',
                adapter: this.getGenerationRouterAdapter(),
                excludeJobIds,
                requireRetainedFile: options?.requireRetainedFile,
                fileExists: options?.fileExists,
            });
        const route = await resolve(options?.excludeJobIds);
        if (route?.reason !== 'retained-reclaim') return route;
        // A sibling request already reclaimed it: serve it as the current job.
        if (this.getJobByPlaySession(playSessionId)?.id === route.job.id) return route;
        // Only a stream that may move the session (video) reclaims. Audio keeps
        // today's routing and follows video once the roles have swapped; it must
        // not wait on a stopped process. A failed swap (seek in flight) routes as
        // if the parked generation were not there.
        if (
            options?.allowReclaim !== false &&
            this.canStreamTriggerSeekForJob(route.job, streamDir) &&
            this.reclaimRetainedGeneration(playSessionId, route.job)
        ) {
            return route;
        }
        return resolve([...(options?.excludeJobIds ?? []), route.job.id]);
    }

    async resolveSegmentJob(
        playSessionId: string,
        streamDir: string,
        requestedSegmentNum: number,
    ): Promise<TranscodeJob | undefined> {
        return (await this.resolveSegmentRoute(playSessionId, streamDir, requestedSegmentNum))?.job;
    }

    /**
     * Does another live job write below this job's output directory? A legacy
     * session keeps its first generation in the session directory itself, and a
     * restore's fresh `gen-NNNN` is created inside it: deleting the old
     * generation's directory would delete the live one with it.
     */
    private holdsLiveGenerationOutput(job: TranscodeJob): boolean {
        const prefix = job.outputDir.endsWith(path.sep) ? job.outputDir : job.outputDir + path.sep;
        for (const other of this.jobs.values()) {
            if (other.id !== job.id && other.outputDir.startsWith(prefix)) return true;
        }
        return false;
    }

    private async retireJobGeneration(
        job: TranscodeJob,
        reason: string,
        options?: {
            deleteOutputDir?: boolean;
            updatePersistence?: boolean;
            persistForRestart?: boolean;
        },
    ): Promise<void> {
        const {
            deleteOutputDir = true,
            updatePersistence = false,
            persistForRestart = false,
        } = options ?? {};
        const playSessionId = job.config.playSessionId;

        job.status = 'stopping';
        // Kill any in-flight tail-cache FFmpeg worker before tearing down the job.
        // Without this abort the background process keeps running after the job is
        // retired (stop, seek, evict, or supersede), wasting CPU/IO and writing
        // into a directory that may be concurrently deleted.
        job.tailCacheAbortController?.abort();
        job.tailCacheAbortController = null;
        job.shutdownKillRequested = reason === 'shutdown';
        await this.processRunner.killFFmpeg(job);
        await job.gopAssembler?.stop();

        if (deleteOutputDir && !this.holdsLiveGenerationOutput(job)) {
            await this.fileManager.deleteOutputDirectory(job.outputDir);
        }

        if (job.config.concatTmpFile) {
            await fs.unlink(job.config.concatTmpFile).catch(() => undefined);
        }

        // Safe to clear: seekToSegment() shallow-copies into nextJob.endSegmentCache
        // before this job is retired, so the new job's map holds its own references.
        job.endSegmentCache.clear();
        this.jobs.delete(job.id);
        void deleteJobStats(job.id);

        const session = this.sessions.get(sessionKey(playSessionId));
        if (session) {
            if (session.currentJobId === job.id) {
                session.currentJobId = undefined;
            }
            session.retainedJobIds = session.retainedJobIds.filter((jobId) => jobId !== job.id);
            this.syncSessionMappings(playSessionId);
        }

        if (updatePersistence) {
            if (persistForRestart) {
                await this.persistence
                    // D-HLS-1 follow-up: own-job write, guarded on pod_name so a
                    // loser process's graceful-shutdown persist cannot stamp
                    // 'stopped' onto a row a newer process's start has since
                    // claimed for a different item (transcode-jobs.queries.ts).
                    .updateStatus(playSessionId, 'stopped', undefined, true, getCurrentPodName())
                    .catch((err) => {
                        logger.warn('Failed to mark job as stopped in database', {
                            jobId: job.id,
                            playSessionId,
                            error: String(err),
                        });
                    });
            } else {
                // Ownership-guarded: if this session has migrated to a peer
                // (rolling recreate, or sticky hashing routing it back), the row
                // now belongs to that pod and deleting it would 410 a live
                // stream — and, with the shared transcode mount, the companion
                // directory delete would pull segments out from under the peer's
                // ffmpeg.
                const selfPod = getCurrentPodName();
                await this.persistence.deleteJob(playSessionId, selfPod).catch((err) => {
                    logger.warn('Failed to delete job from database', {
                        jobId: job.id,
                        playSessionId,
                        error: String(err),
                    });
                });
            }
        }

        logger.info('Transcode generation retired', {
            jobId: job.id,
            playSessionId,
            generationIndex: job.generationIndex,
            generationRole: job.generationRole,
            reason,
        });
    }

    /**
     * Register a one-shot callback to be invoked when the session identified by
     * `playSessionId` is stopped (via `stopJob` or inactivity cleanup).
     * The callback replaces any previously registered callback for that session.
     * It is fired at most once and removed immediately after invocation.
     *
     * Intended use: optional modules (e.g. showcase transcode cap) that need
     * to release a resource when the transcode session ends.  The callback is
     * intentionally typeless here — no showcase knowledge leaks into this module.
     */
    registerSessionStopCallback(playSessionId: string, callback: () => void): void {
        // Keyed on the folded sessionKey(), matching every other session map
        // (jobsByPlaySession, sessions, sessionStartChains): stopJob() below
        // looks the callback up via originalSessionId(), which resolves
        // through the SAME folded key to whichever spelling is currently
        // "current" for this session — a raw, unfolded key here would miss
        // that lookup whenever a case-variant re-request registers a NEW
        // callback under a different spelling of one session id (e.g. the
        // showcase slot-release callback), leaking the resource until its
        // own TTL fallback instead of firing on stop.
        this.sessionStopCallbacks.set(sessionKey(playSessionId), callback);
    }

    /**
     * Remove a previously registered session stop callback.
     * No-op if no callback is registered for the given session.
     */
    unregisterSessionStopCallback(playSessionId: string): void {
        this.sessionStopCallbacks.delete(sessionKey(playSessionId));
    }

    /**
     * Stamp a job's freshly created generation dir with who writes it (see
     * `hls/output-marker.ts`). Cache-backed jobs (`config.outputDir`) write
     * into a PreviewCacheStore artifact that is never persisted or restored,
     * so there is nothing to prove there. Best effort: an unstamped dir only
     * costs a later restore a respawn (fail closed), never wrong bytes.
     */
    private async stampOutputDir(job: TranscodeJob): Promise<void> {
        if (job.config.outputDir !== undefined) return;
        try {
            await writeOutputMarker(job.outputDir, {
                itemId: job.config.itemId,
                podName: getCurrentPodName(),
                jobId: job.id,
            });
        } catch (err) {
            logger.warn('Could not stamp transcode output dir', {
                jobId: job.id,
                outputDir: job.outputDir,
                error: String(err),
            });
        }
    }

    /**
     * Before a restore reads `metadata.output_dir`: keep it only if it is
     * stamped for the row's item; otherwise (another item's leftover, or an
     * unstamped legacy dir) delete it so nothing adopts or serves it.
     * Returns whether the output was kept.
     */
    private async purgeOutputNotStampedFor(metadata: PersistedJobMetadata): Promise<boolean> {
        const marker = await readOutputMarker(metadata.output_dir);
        if (outputMarkerNamesItem(marker, metadata.item_id)) return true;
        logger.info("Discarding output that is not this row's item before restoring", {
            playSessionId: metadata.play_session_id,
            rowItemId: truncateForLog(metadata.item_id),
            markerItemId: truncateForLog(marker?.itemId),
            markerPod: marker?.podName,
            outputDir: metadata.output_dir,
        });
        await this.fileManager.deleteOutputDirectory(metadata.output_dir);
        return false;
    }

    /**
     * The session was lost to a start of ANOTHER item (upsertJob's full
     * replace), not taken over: delete those of `jobs`' generation dirs that
     * still carry this pod's stamp for that job. The row no longer names
     * their item, so nobody will ever restore them — and on a per-container
     * transcode dir nobody else could — yet left behind they sat at the path
     * the new row names (HLS re-measure 2026-09-27 §6.3). A dir a peer has
     * spawned into since (shared mount: same `<sid>/gen-NNNN`) carries the
     * peer's stamp and is left alone, as is everything after a same-item
     * takeover, where the peer may be serving our output.
     */
    private async reclaimOutputLostToAnotherItem(
        playSessionId: string,
        jobs: readonly TranscodeJob[],
    ): Promise<void> {
        let row: PersistedJobMetadata | null;
        try {
            row = await this.persistence.getJob(playSessionId);
        } catch {
            return;
        }
        if (!row) return;
        const self = getCurrentPodName();
        let reclaimed = false;
        for (const job of jobs) {
            if (job.config.outputDir !== undefined) continue;
            if (normalizeItemId(row.item_id) === normalizeItemId(job.config.itemId)) continue;
            const marker = await readOutputMarker(job.outputDir);
            if (marker?.podName !== self || marker.jobId !== job.id) continue;
            await this.fileManager.deleteOutputDirectory(job.outputDir);
            reclaimed = true;
        }
        if (reclaimed) {
            logger.info('Reclaimed output of a session lost to another item', {
                playSessionId,
                rowItemId: truncateForLog(row.item_id),
                ownerPod: row.pod_name,
            });
            await this.fileManager.cleanupSessionDirectory(this.getSessionOutputDir(playSessionId));
        }
    }

    /**
     * May this pod remove `playSessionId`'s output directories?
     *
     * On a shared FFMPEG_TRANSCODE_DIR a peer can take the session over
     * (`takeOverStaleJob` / `claimJobForRestoration` flip the row's pod_name
     * and keep its output_dir) while this pod's own job is still resident. That
     * job's later stop or reap must then leave the directory alone: the peer's
     * restored FFmpeg is writing into it. The row's pod_name decides, as for
     * the pod-guarded row delete/status writes; an unowned row, or no row at
     * all (never persisted, or already deleted — nothing to restore from, so
     * nobody else can own it), means ours.
     *
     * Unlike those writes this is read-then-act, not one atomic UPDATE: a
     * takeover committing between this read and the rm is not seen. Callers
     * therefore read it as late as possible (after the FFmpeg kills and the
     * own-row delete), which leaves that gap at a DB round trip.
     *
     * Fails OPEN on a DB error (the pre-guard behaviour): a takeover is itself
     * a DB write, and leaking every stopped session's output during an outage
     * would fill the transcode volume.
     */
    private async ownsSessionOutput(playSessionId: string): Promise<boolean> {
        try {
            const row = await this.persistence.getJob(playSessionId);
            if (!row || row.pod_name === null) return true;
            const self = getCurrentPodName();
            if (row.pod_name === self) return true;
            logger.info('Leaving session output in place — session now owned by another pod', {
                playSessionId,
                ownerPod: row.pod_name,
                selfPod: self,
            });
            return false;
        } catch (err) {
            logger.warn('Session output ownership check failed — deleting as before', {
                playSessionId,
                error: String(err),
            });
            return true;
        }
    }

    /**
     * Stop a transcode job
     * @returns true if the job was found and stopped, false if not found
     */
    async stopJob(
        requestedPlaySessionId: string,
        reason: string = 'client_request',
        persistForRestart: boolean = false,
    ): Promise<boolean> {
        // The reaper reaches here with its own case-folded map key, while the
        // per-session trackers torn down below were populated by the HTTP layer
        // from the request URL's original-case id. Resolve once, up front, so
        // every teardown in this method frees the state it actually meant to.
        const playSessionId = this.originalSessionId(requestedPlaySessionId);
        const jobId = this.getCurrentJobId(playSessionId);

        // Job not in memory - check if it exists on another pod
        if (!jobId) {
            // Don't do cross-pod stop for restart persistence (only for admin/client stops)
            if (persistForRestart) {
                return false;
            }

            try {
                const dbJob = await this.persistence.getJob(playSessionId);
                if (dbJob) {
                    // Job exists on another pod - mark as stopped in database
                    // Set can_restore = FALSE to prevent job from restarting
                    const currentPodName = getCurrentPodName();
                    await this.persistence.updateStatus(
                        playSessionId,
                        'stopped',
                        `Stopped by ${reason} from pod ${currentPodName}`,
                        false, // can_restore = FALSE (admin/client stop should not restart)
                    );

                    logger.info('Marked cross-pod job as stopped in database', {
                        playSessionId,
                        jobPodName: dbJob.pod_name,
                        currentPodName,
                        reason,
                    });

                    // Tell the owner now; the DB mark above is the fallback
                    // its 30 s cleanup picks up when Valkey is unavailable.
                    void publishMessage(
                        TRANSCODE_STOP_CHANNEL,
                        JSON.stringify({ playSessionId, reason }),
                    ).then((delivered) => {
                        if (!delivered) {
                            logger.warn(
                                'Transcode stop broadcast not delivered — owner stops on its 30 s cleanup',
                                { playSessionId, jobPodName: dbJob.pod_name },
                            );
                        }
                    });

                    // The owning pod will see the 'stopped' status and clean up within 30-60s (cleanup runs every 30s)
                    return true;
                }
            } catch (error) {
                logger.error('Failed to check/stop cross-pod job', error as Error, {
                    playSessionId,
                    reason,
                });
            }

            return false;
        }

        const job = this.jobs.get(jobId);
        if (!job) return false;

        logger.info('Stopping transcode job', {
            jobId: job.id,
            playSessionId,
            reason,
            persistForRestart,
        });

        job.status = 'stopping';

        // Output is deleted only at the end, once ownership is re-read (see
        // below): retiring kills FFmpeg first, which can wait seconds.
        await this.retireJobGeneration(job, reason, {
            deleteOutputDir: false,
            updatePersistence: true,
            persistForRestart,
        });
        this.lastProgressDbWrite.delete(playSessionId);

        // Clean up module-level session state to prevent slow memory leaks
        clearSeekTimestamp(playSessionId);
        clearSessionRequestTrackers(playSessionId);
        clearSessionSeekTrace(playSessionId);

        const retainedJobs = this.getRetainedJobsByPlaySession(playSessionId);
        for (const retainedJob of retainedJobs) {
            await this.retireJobGeneration(retainedJob, `${reason}_retained_generation`, {
                deleteOutputDir: false,
            });
        }

        // Decided only now, after every kill (each can wait up to the force-kill
        // timeout) and after this pod's own pod-guarded row delete: a takeover
        // that landed during the kills is seen here, and once our own row is
        // gone nobody can take the session over any more. What is left is the
        // read -> rm gap itself (see ownsSessionOutput).
        if (await this.ownsSessionOutput(playSessionId)) {
            for (const retainedJob of retainedJobs) {
                await this.fileManager.deleteOutputDirectory(retainedJob.outputDir);
            }
            if (!persistForRestart) {
                await this.fileManager.deleteOutputDirectory(job.outputDir);
                await this.fileManager.deleteOutputDirectory(
                    this.getSessionOutputDir(playSessionId),
                );
            }
        } else {
            // Regardless of persistForRestart: output for an item the row no
            // longer names is never restorable.
            await this.reclaimOutputLostToAnotherItem(playSessionId, [job, ...retainedJobs]);
        }

        logger.info('Transcode job stopped', {
            jobId: job.id,
            playSessionId,
            reason,
        });

        // Fire and remove any registered stop callback (e.g. showcase slot
        // release). Folded key — see registerSessionStopCallback's doc comment.
        const stopCallback = this.sessionStopCallbacks.get(sessionKey(playSessionId));
        if (stopCallback) {
            this.sessionStopCallbacks.delete(sessionKey(playSessionId));
            try {
                stopCallback();
            } catch (cbErr) {
                logger.warn('Session stop callback threw', {
                    playSessionId,
                    error: cbErr instanceof Error ? cbErr.message : String(cbErr),
                });
            }
        }

        return true;
    }

    /**
     * Owner (`config.username`) of the persisted transcode row for this session
     * id, wherever its job runs; `null` when there is no row (or the id cannot
     * have one). A row without a username yields `''`, which matches nobody.
     * Lets the master route refuse a session whose job lives on another pod.
     */
    async getPersistedJobOwner(playSessionId: string): Promise<string | null> {
        const row = await this.persistence.getJob(playSessionId);
        if (!row) return null;
        const owner = (row.config as { username?: unknown } | null)?.username;
        return typeof owner === 'string' ? owner : '';
    }

    /**
     * Stop the job behind a client-supplied play session id, but only if it
     * belongs to `username` — wherever it runs. A job on another pod is stopped
     * through stopJob's cross-pod path (its row is flagged; the owner's reaper
     * kills it within one sweep). Used by DELETE /j/Videos/ActiveEncodings.
     */
    async stopJobForUser(
        playSessionId: string,
        username: string,
        reason: string = 'client_stopped',
    ): Promise<boolean> {
        const local = this.getJobByPlaySession(playSessionId);
        if (local) {
            if (local.config.username !== username) return false;
            return this.stopJob(playSessionId, reason);
        }
        const row = await this.persistence.getJob(playSessionId);
        if (!row || row.config?.username !== username) return false;
        // A finished/errored row is left alone (keeps its error message).
        if (!['starting', 'running', 'ready'].includes(row.status)) return false;
        return this.stopJob(playSessionId, reason);
    }

    /**
     * Stop a transcode job by item ID and username.
     * Used by the progress endpoint when the play session ID is not available.
     * Finds the first matching active job and stops it.
     */
    async stopJobByItemAndUser(
        itemId: string,
        username: string,
        reason: string = 'playback_stopped',
    ): Promise<boolean> {
        for (const job of this.jobs.values()) {
            if (
                job.generationRole === 'current' &&
                job.config.itemId === itemId &&
                job.config.username === username
            ) {
                return this.stopJob(job.config.playSessionId, reason);
            }
        }
        // Not on this pod. The /j stop report carries no PlaySessionId in its
        // URL, so the router hashes it by client IP and it often reaches a pod
        // that does not own the job. stopJob's cross-pod path flags the owner's
        // row, which the owner's reaper picks up within one sweep (30s).
        try {
            // Only an unambiguous match: the report names no device, so with the
            // same item playing on two devices a guess could kill the wrong
            // (live) stream with a non-restorable stop. Ambiguous cases fall to
            // the client-gone reaper instead.
            const rows = (await this.persistence.getAllActiveJobs()).filter(
                (r) =>
                    r.status !== 'stopping' &&
                    r.item_id === itemId &&
                    r.config?.username === username,
            );
            if (rows.length === 1) return this.stopJob(rows[0].play_session_id, reason);
        } catch (err) {
            logger.warn('Failed to look up a cross-pod job to stop', {
                itemId,
                error: String(err),
            });
        }
        return false;
    }

    /**
     * Where a generation that serves `targetSegmentIndex` starts: the keyframe
     * (copy mode), grid entry (GOP mode) or preroll segment (transcode) the seek
     * path and the restore path both begin FFmpeg at. One definition, so a
     * restore that resumes at the viewer's position lands on exactly the grid a
     * seek to that position would use — a restore that disagrees is followed by
     * a forward-seek re-transcode.
     */
    private resolveSeekStart(
        job: TranscodeJob,
        playSessionId: string,
        targetSegmentIndex: number,
        requestedSeekTimeSeconds: number,
    ): {
        alignedSeekTime: number;
        generationStart: { startSegment: number; startTimeSeconds: number };
    } {
        let alignedSeekTime = requestedSeekTimeSeconds;
        const decision = job.transcodeDecisionResult;
        const gopGrid = this.getGopGrid(job);
        if (gopGrid) {
            // GOP mode: the target is a grid entry; alignment happens below.
        } else if (
            decision?.videoAction === 'copy' &&
            requestedSeekTimeSeconds > 0 &&
            job.keyframeData &&
            job.keyframeData.length > 0 &&
            job.config.totalDurationSeconds
        ) {
            const aligned = alignToKeyframeSegmentStart(
                requestedSeekTimeSeconds,
                job.keyframeData,
                job.config.totalDurationSeconds,
                job.segmentDurationSeconds,
            );
            if (Math.abs(aligned - requestedSeekTimeSeconds) > 0.001) {
                logger.info('Aligned seek time to video keyframe boundary', {
                    playSessionId,
                    requestedSeekTimeSeconds,
                    alignedSeekTimeSeconds: aligned,
                });
                alignedSeekTime = aligned;
            }
        }

        // Where the promoted generation STARTS, which is one segment before the
        // seek target so the player's decoder-priming request for target-1 can be
        // served. Deliberately separate from the logical target used for
        // canSeek/waitForSeekCompletion/generation limits.
        // GOP mode starts one grid ENTRY early (the same decoder-priming preroll,
        // in grid units: audio target-1 must exist) and exactly on that entry's
        // keyframe, so every entry this generation serves starts where declared.
        const gopStart = gopGrid
            ? resolveGopGenerationStart(gopGrid, { seekTargetEntry: targetSegmentIndex })
            : null;
        const generationStart = gopStart
            ? { startSegment: gopStart.entry, startTimeSeconds: gopStart.startTimeSeconds ?? 0 }
            : resolveSeekGenerationStart(targetSegmentIndex, job.segmentDurationSeconds, {
                  isCopyModeVideo: decision?.videoAction === 'copy',
                  alignedSeekTimeSeconds: alignedSeekTime,
              });
        return { alignedSeekTime, generationStart };
    }

    /**
     * Seek to a specific segment by restarting FFmpeg from that position.
     * Used when user seeks far ahead of current transcoding progress.
     *
     * @param playSessionId - The play session ID
     * @param targetSegmentIndex - The segment number to seek to
     * @param segmentDurationSeconds - Duration of each segment (default 6)
     * @returns true if seek was initiated, false if job not found
     */
    async seekToSegment(
        playSessionId: string,
        targetSegmentIndex: number,
        segmentDurationSeconds: number = 6,
        exactSeekTimeSeconds?: number,
        forceRestart: boolean = false,
        nextHlsOutput?: TranscodeJobConfig['hlsOutput'],
    ): Promise<boolean> {
        // Serialised with startJob/restoreJob on the session start lock: a seek
        // that lands while a restore is still spawning FFmpeg would retire the
        // restored job under it, and the spawn would then finish for a job nobody
        // owns (two FFmpeg processes for one session). startJob's own seek calls
        // already hold the lock and use seekToSegmentUnlocked.
        return this.withSessionStartLock(sessionKey(playSessionId), () =>
            this.seekToSegmentUnlocked(
                playSessionId,
                targetSegmentIndex,
                segmentDurationSeconds,
                exactSeekTimeSeconds,
                forceRestart,
                nextHlsOutput,
            ),
        );
    }

    private async seekToSegmentUnlocked(
        playSessionId: string,
        targetSegmentIndex: number,
        segmentDurationSeconds: number = 6,
        exactSeekTimeSeconds?: number,
        forceRestart: boolean = false,
        nextHlsOutput?: TranscodeJobConfig['hlsOutput'],
    ): Promise<boolean> {
        if (this.isShuttingDown || isWebShuttingDown()) return false;
        // Cache-backed jobs (preview warming) write into a shared, single-
        // generation artifact directory owned by the PreviewCacheStore. Seeking
        // would spawn a second generation into the same dir — an in-place
        // clobber of a shared artifact — so reject it outright instead.
        if (this.getJob(playSessionId)?.config.outputDir) {
            logger.warn('Rejecting in-place seek on a cache-backed preview job', {
                playSessionId,
            });
            return false;
        }

        const jobId = this.getCurrentJobId(playSessionId);
        if (!jobId) return false;

        const job = this.jobs.get(jobId);
        if (!job) return false;

        // Convert to job-unit offset for all comparisons and state updates.
        // The caller may pass a video segment index (e.g. 811 with 10s duration).
        // All internal state (segmentOffset, canSeek) uses job.segmentDurationSeconds units.
        const requestedSeekTimeSeconds =
            exactSeekTimeSeconds ?? targetSegmentIndex * segmentDurationSeconds;
        const logicalTarget = targetSegmentIndex;

        const audioBasedTarget = logicalTarget;

        const { alignedSeekTime, generationStart } = this.resolveSeekStart(
            job,
            playSessionId,
            audioBasedTarget,
            requestedSeekTimeSeconds,
        );

        // Wait for any in-progress seek
        if (job.isSeeking) {
            const waitResult = await this.seekController.waitForSeekCompletion(
                job,
                audioBasedTarget,
            );
            // Audio-track replacement (forceRestart) must always proceed: a
            // prior seek timing out or being covered is unrelated to the
            // user's current intent to switch audio. Aborting here would
            // leave the server serving old-audio segments while the client
            // already reloaded its manifest with the new track.
            if (waitResult === 'failed' && !forceRestart) return false;
            if (waitResult === 'covered' && !forceRestart) return true;
            // 'proceed' or forceRestart falls through to do the seek
        }

        // Check if seek is needed
        if (!forceRestart && !this.seekController.canSeek(job, audioBasedTarget)) {
            return true; // Already at target position
        }

        // Mark as seeking
        job.isSeeking = true;

        logger.info('Seeking transcode job to new position', {
            jobId: job.id,
            playSessionId,
            targetSegmentIndex,
            segmentDurationSeconds,
            seekTimeSeconds: alignedSeekTime,
            audioBasedTarget,
            generationStartSegment: generationStart.startSegment,
            generationStartTimeSeconds: generationStart.startTimeSeconds,
            previousOffset: job.segmentOffset,
            currentProgress: job.segmentsReady,
            forceRestart,
        });

        let nextJob: TranscodeJob | undefined;
        try {
            const generationIndex = this.getNextGenerationIndex(playSessionId);
            const outputDir = this.getGenerationOutputDir(playSessionId, generationIndex);
            await this.fileManager.createOutputDirectory(outputDir);

            const nextConfig: TranscodeJobConfig = {
                ...job.config,
                startTimeSeconds: generationStart.startTimeSeconds,
                // Coverage spans generations: hand the ranges encoded so far to
                // the new one. An audio-track replacement (forceRestart) starts
                // over — what was encoded carries the old audio.
                coveredRanges: forceRestart
                    ? []
                    : sessionCoveredRanges(job, job.config.totalDurationSeconds || 0),
            };
            if (nextHlsOutput) {
                nextConfig.hlsOutput = { ...job.config.hlsOutput, ...nextHlsOutput };
                const plan = nextConfig.effectivePlan;
                const budget = plan?.caps.qualityCapTotalBudgetBps;
                if (plan && budget !== undefined) {
                    const { audioReservationBps } = computeQualityCapReservation(
                        { maxBitrate: budget },
                        undefined,
                        undefined,
                        !nextConfig.forceAudioTranscode && plan.decision?.audioAction === 'copy',
                        resolveDeliveredAudioTracks(
                            nextConfig.audioTracks,
                            nextConfig.hlsOutput.hlsAudioMode,
                            nextConfig.hlsOutput.hlsAudioTrackIndex,
                        ).map((track) => track.bitrate),
                    );
                    nextConfig.effectivePlan = {
                        ...plan,
                        caps: {
                            ...plan.caps,
                            qualityCapAudioReservationBps: audioReservationBps,
                            maxVideoBitrateMbps: computeCappedVideoBitrateMbps(
                                budget,
                                audioReservationBps,
                                plan.caps.videoBitrateMbps,
                            ),
                        },
                    };
                }
            }
            nextJob = this.createJobObject(
                randomUUID(),
                nextConfig,
                job.sessionOutputDir,
                outputDir,
                generationIndex,
                'current',
                generationStart.startSegment,
                job.transcodeDecisionResult,
                new Date(),
            );
            nextJob.seekCount = job.seekCount + 1;
            nextJob.lastSeekTrigger = job.lastSeekTrigger;
            nextJob.streamTargetDurations = new Map(job.streamTargetDurations);
            nextJob.endSegmentCache = new Map(job.endSegmentCache);
            nextJob.gopGrid = job.gopGrid;
            nextJob.requestedStartTimeSeconds = requestedSeekTimeSeconds;
            nextJob.syncTraceOrigin = 'seek';
            nextJob.isSeeking = true;

            job.isSeeking = false;
            this.setPreviousJob(playSessionId, job);
            this.registerCurrentJob(playSessionId, nextJob);
            await this.stampOutputDir(nextJob);

            await this.spawnFFmpeg(nextJob);

            if (forceRestart) {
                // Audio-track replacement: every retained generation (the
                // just-promoted OLD plus anything still around from earlier
                // seeks) carries the previous audio stream. Retire them all
                // — otherwise the generation router tiebreaks to a retained
                // generation during NEW's ~0.2–1s startup window and serves
                // wrong-audio segments. For regular seeks retention is kept:
                // those segments are valid playback content for the old
                // position.
                //
                // We swallow retire failures (I/O errors on killFFmpeg /
                // deleteOutputDirectory): NEW is already spawned, and letting
                // the exception escape would fall into the catch block below
                // which restores `job` as current — but retireJobGeneration
                // has already removed it from this.jobs, so the restore would
                // silently kill the session.
                const retainedJobs = this.getRetainedJobsByPlaySession(playSessionId);
                for (const retained of retainedJobs) {
                    await this.retireJobGeneration(retained, 'audio_track_replaced').catch(
                        (retireErr) => {
                            logger.warn(
                                'Failed to retire old generation after audio switch',
                                { jobId: retained.id, playSessionId },
                                retireErr as Error,
                            );
                        },
                    );
                }
            } else {
                await this.enforceGenerationLimit(playSessionId, audioBasedTarget, [job.id]);
            }

            nextJob.isSeeking = false;

            const promotedJob = nextJob;
            this.persistence.saveJob(promotedJob).catch((err) => {
                logger.warn(
                    'Failed to persist seek generation to database',
                    { jobId: promotedJob.id, playSessionId },
                    err as Error,
                );
            });

            if (!nextJob.config.isJellyfinTranscoded) {
                this.iframeAnalyzer.startAnalysis(nextJob);
            }

            logger.info('Seek promoted new generation', {
                playSessionId,
                previousJobId: job.id,
                currentJobId: nextJob.id,
                previousGeneration: job.generationIndex,
                currentGeneration: nextJob.generationIndex,
                segmentOffset: nextJob.segmentOffset,
                seekTimeSeconds: alignedSeekTime,
                requestedSeekTimeSeconds,
                seekCount: nextJob.seekCount,
            });
            this.logSyncPlan(nextJob, 'seek');

            // A backward seek away from a generation that never served a
            // segment: a Jellyfin client resuming at T probes segment 0 first,
            // then returns to T. Park it (last, after everything that can throw:
            // the catch below would otherwise restore a stopped process as
            // current) instead of letting two encodes share the GPU; a request
            // back at T reclaims it, a real seek to 0 leaves it to
            // PARKED_UNWATCHED_TTL_MS. Parking frees the encoder, not memory.
            if (
                !forceRestart &&
                nextJob.segmentOffset < job.segmentOffset &&
                job.lastServedSegment.size === 0 &&
                job.generationRole === 'previous' &&
                this.jobs.has(job.id)
            ) {
                this.parkGeneration(job, 'unwatched');
            }

            return true;
        } catch (err) {
            const session = this.sessions.get(sessionKey(playSessionId));
            if (session && nextJob && session.currentJobId === nextJob.id) {
                this.jobs.delete(nextJob.id);
                session.currentJobId = job.id;
                session.retainedJobIds = session.retainedJobIds.filter((jobId) => jobId !== job.id);
                job.generationRole = 'current';
                this.syncSessionMappings(playSessionId);
            }
            if (nextJob) {
                await nextJob.gopAssembler?.stop().catch(() => {});
                await this.fileManager.deleteOutputDirectory(nextJob.outputDir);
            }
            if (err instanceof ShutdownInterruptedError) throw err;
            logger.error('Failed to spawn new generation for seek', err as Error, {
                playSessionId,
                previousJobId: job.id,
            });
            return false;
        } finally {
            // Clear seeking flag
            job.isSeeking = false;
        }
    }

    /**
     * Get the current segment offset for a job
     */
    getSegmentOffset(playSessionId: string): number {
        const jobId = this.jobsByPlaySession.get(sessionKey(playSessionId));
        if (!jobId) return 0;
        const job = this.jobs.get(jobId);
        return job?.segmentOffset ?? 0;
    }

    /**
     * Get job by play session ID without updating activity timestamp.
     *
     * Use this for high-frequency lookups (e.g., segment serving, existence checks)
     * where updating lastAccessedAt on every call would be wasteful.
     *
     * For activity that should extend job lifetime, use getJob() instead.
     */
    getJobByPlaySession(playSessionId: string): TranscodeJob | undefined {
        const jobId = this.jobsByPlaySession.get(sessionKey(playSessionId));
        if (!jobId) return undefined;
        return this.jobs.get(jobId);
    }

    /**
     * Shutdown service - stop all jobs gracefully
     */
    async shutdown(): Promise<void> {
        const podName = getCurrentPodName();
        logger.info('FFmpeg transcode service shutting down...', {
            podName,
            activeJobs: this.jobsByPlaySession.size,
        });
        this.isShuttingDown = true;

        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }

        if (this.segmentCleanupInterval) {
            clearInterval(this.segmentCleanupInterval);
            this.segmentCleanupInterval = null;
        }

        if (this.statsPublishInterval) {
            clearInterval(this.statsPublishInterval);
            this.statsPublishInterval = null;
        }

        if (this.throttleInterval) {
            clearInterval(this.throttleInterval);
            this.throttleInterval = null;
        }

        // A subscribe still in flight would store its unsubscribe after this
        // point and leak the listener — let it settle first.
        await this.stopSubscription?.catch(() => {});
        if (this.stopUnsubscribe) {
            await this.stopUnsubscribe().catch(() => {});
            this.stopUnsubscribe = null;
        }

        // Stop all active jobs with persistence for restart recovery
        const stopPromises = Array.from(this.jobsByPlaySession.keys()).map((playSessionId) =>
            this.stopJob(playSessionId, 'shutdown', true),
        );

        await Promise.allSettled(stopPromises);

        // Mark all this pod's DB rows as stopped (catches any jobs not in memory).
        // Only with a real HOSTNAME: the 'unknown' fallback is shared by every
        // HOSTNAME-less process, so a pod-wide sweep under it would mark PEERS'
        // live rows stopped and their owners would tear those jobs down.
        if (process.env.HOSTNAME) {
            try {
                await this.persistence.markPodJobsAsStopped(podName, 'graceful_shutdown');
            } catch (err) {
                logger.warn('Failed to mark pod jobs as stopped in DB', err as Error);
            }
        } else {
            logger.warn('No HOSTNAME set — cannot mark pod DB rows as stopped on shutdown');
        }

        logger.info('FFmpeg transcode service shutdown complete', {
            jobsStopped: stopPromises.length,
            podName,
        });
    }

    /**
     * Best-effort guard against killing a recycled PID. A stale job DB row can name
     * a PID the OS has since reassigned to an unrelated process; before SIGKILL we
     * verify /proc/<pid>/cmdline still looks like ffmpeg. Returns true on platforms
     * without /proc (macOS/Windows) or if the check can't be read, preserving the
     * prior unconditional-kill behavior there — the /proc read is a local virtual
     * file (not NFS), so the sync read is cheap and non-blocking in practice.
     */
    private isLikelyFFmpegPid(pid: number): boolean {
        try {
            const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
            if (cmdline.length === 0) return true; // unreadable → don't second-guess
            // cmdline args are NUL-separated; ffmpeg may be an absolute path.
            return cmdline.toLowerCase().includes('ffmpeg');
        } catch (err) {
            const code = (err as { code?: string }).code;
            // ENOENT = the PID is already gone (kill would no-op anyway; allow it to
            // fall through to the guarded kill). Any other error (no /proc, EACCES)
            // → fail open to preserve prior behavior.
            if (code === 'ENOENT') return true;
            return true;
        }
    }

    /**
     * Cleanup orphaned jobs using TTL-based detection.
     *
     * Works with any Kubernetes deployment type (Deployment, StatefulSet, etc.)
     * by detecting stale jobs based on timestamps rather than pod name matching.
     *
     * A job is considered orphaned if:
     * 1. It was created more than STALE_JOB_THRESHOLD ago AND
     * 2. It has no progress updates for more than STALE_PROGRESS_THRESHOLD
     *
     * This handles the case where:
     * - A pod crashes and restarts with a new name (Deployment)
     * - FFmpeg process died but job wasn't cleaned up
     * - Network issues prevented cleanup messages
     */
    /**
     * Startup wipe of leftover transcode output, minus anything still live.
     *
     * FFMPEG_TRANSCODE_DIR is shared across web replicas and the worker so a
     * peer can restore a session's job after a rolling recreate. That sharing
     * makes an unconditional startup wipe destructive: every container boot
     * would delete the segments of sessions the OTHER containers are actively
     * serving, so a zero-downtime deploy would kill every stream on the host.
     *
     * The DB is the cross-pod source of truth for which sessions are live, so
     * ask it first and preserve those directories. If that query fails we
     * delete NOTHING: leaking stale directories costs disk (and the inactivity
     * reaper plus cleanupOrphanedJobs still collect them), whereas guessing
     * wrong costs every viewer their stream.
     */
    private async clearStaleTranscodeDirectories(): Promise<void> {
        let liveSessionIds: Set<string>;
        try {
            // EVERY row, not getAllActiveJobs() — that one filters to
            // starting/running/ready/stopping, but a graceful shutdown persists
            // 'stopped' + can_restore=true and deliberately leaves the output
            // directory behind so a peer can restore the session. Those rows
            // are exactly what a rolling deploy depends on, so they must count
            // as live here.
            liveSessionIds = new Set(await this.persistence.getAllJobPlaySessionIds());
        } catch (err) {
            logger.warn(
                'Skipping startup transcode cleanup — could not determine which sessions are live',
                { error: String(err) },
            );
            return;
        }

        await this.fileManager.clearTranscodeDirectory(liveSessionIds);
    }

    private async cleanupOrphanedJobs(): Promise<void> {
        const currentPodName = getCurrentPodName();

        logger.info('Checking for orphaned jobs (TTL-based cleanup)', {
            podName: currentPodName,
        });

        try {
            // Get ALL active jobs from database (across all pods)
            const allJobs = await this.persistence.getAllActiveJobs();

            // TTL thresholds for detecting orphaned jobs
            const STALE_JOB_THRESHOLD = 5 * 60 * 1000; // 5 minutes
            const STALE_PROGRESS_THRESHOLD = 5 * 60 * 1000; // 5 minutes

            let orphanedCount = 0;
            const now = Date.now();

            for (const job of allJobs) {
                // Keep stopped jobs for restart recovery (graceful shutdown scenario)
                if (job.status === 'stopped') {
                    continue;
                }

                const jobAge = now - job.created_at.getTime();
                const progressAge = now - job.last_progress_at.getTime();

                // Job is orphaned if it's old AND has no recent progress
                const isOrphaned =
                    jobAge > STALE_JOB_THRESHOLD && progressAge > STALE_PROGRESS_THRESHOLD;

                if (isOrphaned) {
                    // Recheck timestamps and generation atomically. Restorable
                    // rows become dormant for the same recovery window as the
                    // periodic reaper; a peer serving segments keeps its row.
                    if (
                        !(await this.persistence.retireOrphanedJob(
                            job.play_session_id,
                            job.job_id,
                            new Date(now - STALE_JOB_THRESHOLD),
                        ))
                    )
                        continue;
                    orphanedCount++;
                    logger.warn('Cleaning up orphaned job (stale timestamps)', {
                        playSessionId: job.play_session_id,
                        status: job.status,
                        jobAgeSeconds: Math.floor(jobAge / 1000),
                        progressAgeSeconds: Math.floor(progressAge / 1000),
                        podName: job.pod_name,
                        currentPod: currentPodName,
                        ffmpegPid: job.ffmpeg_pid,
                    });

                    // Try to kill FFmpeg process if PID is known
                    // (will only work if job is on this pod)
                    if (job.ffmpeg_pid && job.pod_name === currentPodName) {
                        // If the orphan is actually an in-memory job on THIS
                        // pod (stale state on the owning pod, not a cross-pod
                        // kill), route through the normal teardown so its
                        // handleExit sees status='stopping' and
                        // killEscalated=true. Otherwise handleExit would
                        // surface this as an external SIGKILL / OOM overlay
                        // on the next session that reuses the itemId key.
                        const localJobId = this.jobsByPlaySession.get(
                            sessionKey(job.play_session_id),
                        );
                        const localJob = localJobId ? this.jobs.get(localJobId) : undefined;
                        if (localJob) {
                            logger.info('Routing orphan cleanup through stopJob (job is local)', {
                                pid: job.ffmpeg_pid,
                                playSessionId: job.play_session_id,
                            });
                            await this.stopJob(
                                job.play_session_id,
                                'orphan_cleanup',
                                job.can_restore,
                            ).catch((stopErr) => {
                                logger.warn(
                                    'Failed to stop local orphan job',
                                    { playSessionId: job.play_session_id },
                                    stopErr as Error,
                                );
                            });
                        } else if (this.isLikelyFFmpegPid(job.ffmpeg_pid)) {
                            // Only kill if the PID still looks like our ffmpeg. A stale
                            // DB row (>5min) can name a PID the OS has since recycled to
                            // an unrelated process on this host; a blind SIGKILL would
                            // then kill a bystander. The /proc check is best-effort —
                            // on platforms without /proc it returns true (prior behavior).
                            try {
                                process.kill(job.ffmpeg_pid, 'SIGKILL');
                                logger.info('Killed orphaned FFmpeg process', {
                                    pid: job.ffmpeg_pid,
                                    playSessionId: job.play_session_id,
                                });
                            } catch (err) {
                                // Process might be on different pod or already dead
                                logger.debug(
                                    'Could not kill FFmpeg process (different pod or dead)',
                                    {
                                        pid: job.ffmpeg_pid,
                                        error: (err as Error).message,
                                    },
                                );
                            }
                        } else {
                            logger.warn(
                                'Skipping orphan kill — PID no longer looks like ffmpeg (likely recycled)',
                                {
                                    pid: job.ffmpeg_pid,
                                    playSessionId: job.play_session_id,
                                },
                            );
                        }
                    }
                }
            }

            if (orphanedCount > 0) {
                logger.info('Orphaned jobs cleanup complete', {
                    orphanedCount,
                    totalJobsChecked: allJobs.length,
                });
            } else {
                logger.debug('No orphaned jobs found', {
                    totalJobsChecked: allJobs.length,
                });
            }
        } catch (error) {
            logger.error('Failed to cleanup orphaned jobs', error as Error, {
                podName: currentPodName,
            });
            // Non-fatal - don't throw
        }
    }

    // ========================================================================
    // FFmpeg Process Management
    // ========================================================================

    private static readonly UUID_RE =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    /**
     * Persist one genuine failure attempt. Fire-and-forget: the caller is FFmpeg's
     * exit path and a DB error must never unwind a transcode (mirrors
     * publishProbeError). Callers pass `args` from the spawnFFmpeg closure — never a
     * job stash, which a concurrent seek could point at the next generation.
     *
     * `attempt` and `transcodeSpeed` are likewise caller-supplied snapshots, never
     * read from `job` in here. Several handleExit branches respawn (`learned`,
     * `bridged`) via `void this.spawnFFmpeg(job)` before recording — spawnFFmpeg is
     * async, but its statements before the first `await` (including
     * `job.spawnAttempt++` and clearing `job.transcodeSpeed`) run synchronously the
     * instant it's called, `void` or not. Reading `job.spawnAttempt`/
     * `job.transcodeSpeed` from inside this function would then record the NEXT
     * attempt's number and a nulled speed against the attempt that actually failed.
     * Requiring the caller to snapshot before any respawn makes that hazard
     * structurally impossible rather than dependent on getting the call order right
     * in every branch.
     *
     * `precomputedFailure` lets a caller that already classified the same
     * stderr/code for its own purposes (the terminal-'failed' branch logs and
     * publishes the classification before recording it) share that result
     * instead of paying for — and risking a second unguarded throw from —
     * `classifyTranscodeFailure` a second time. Omit it and this function
     * classifies internally, inside its own try/catch.
     *
     * `getDb` is loaded via dynamic import rather than a module-scope one:
     * `connection.js` transitively reaches `tasks/registry.ts`, and a
     * module-scope import here widens ffmpeg-transcode.service.ts's import
     * graph to include it — breaking any test that mocks
     * `$lib/server/config.js` only partially, since `new TaskRegistry` reads
     * `FEATURE_PER_TASK_QUEUES` off it at import time (mirrors why
     * publishProbeError imports keyframe-probe-progress.service.js lazily).
     */
    private recordFailureEvent(
        job: TranscodeJob,
        args: string[],
        outcome: TranscodeFailureOutcome,
        code: number | null,
        signal: string | null,
        stderrBuffer: string,
        attempt: number,
        transcodeSpeed: number | null,
        precomputedFailure?: TranscodeFailure,
    ): void {
        // The ENTIRE body — including argument construction, not just the DB call —
        // is inside this async IIFE's try/catch, and the IIFE itself is invoked with
        // `void`. An async function call can never throw synchronously to its caller
        // (even a throw before the first `await` becomes a rejection of the returned
        // promise), so wrapping everything here — including the dynamic import —
        // keeps this method's synchronous, non-throwing, fire-and-forget contract:
        // it would unwind out of handleExit/handleError and skip the shared tail
        // those callers still need to run (markFailed, persistence.updateStatus).
        // One try/catch around everything guarantees a sync throw and an async
        // rejection land in the same non-throwing path.
        void (async (): Promise<void> => {
            try {
                const { getDb } = await import('../database/connection.js');
                const db = getDb();
                if (!db) {
                    logger.warn('Transcode failure event not recorded — database unavailable', {
                        jobId: job.id,
                        outcome,
                    });
                    return;
                }

                const failure = precomputedFailure ?? classifyTranscodeFailure(stderrBuffer, code);

                // Teardown, not a fault: FFmpeg died because its own output
                // directory was reaped out from under it (a stop, a supersede, or a
                // seek retiring the previous generation). Nothing can consume that
                // output any more, so there is no failure left to report — and the
                // stderr reads as a GPU/missing-file error, which is how these came
                // to dominate the prod failure page. Dropped at this single choke
                // point so every caller inherits it.
                if (failure.category === 'output-unavailable') {
                    logger.debug('Transcode failure event skipped — output directory reaped', {
                        jobId: job.id,
                        playSessionId: job.config.playSessionId,
                        outcome,
                        exitCode: code,
                    });
                    return;
                }

                const decision = job.transcodeDecisionResult;

                await recordTranscodeFailureEvent(db, {
                    jobId: job.id,
                    playSessionId: job.config.playSessionId,
                    attempt,
                    outcome,
                    exitCode: code,
                    signal,
                    category: failure.category,
                    summary: failure.summary,
                    argv: args,
                    stderrTail: stderrBuffer,
                    encoder: decision?.gpuEncoder ?? null,
                    hwaccel: decision?.gpuEncoder
                        ? getHwAccelFromEncoder(decision.gpuEncoder)
                        : null,
                    // itemId is documented as "internal UUID **or Jellyfin ID**"
                    // (types.ts:600-601). media_id is a UUID FK, so a Jellyfin-shaped id
                    // would throw — and because this recorder swallows errors by contract,
                    // that would silently record NOTHING. Guard rather than trust.
                    mediaId: FFmpegTranscodeService.UUID_RE.test(job.config.itemId ?? '')
                        ? job.config.itemId
                        : null,
                    fileId: job.config.fileId ?? null,
                    // videoInfo ONLY — job.config carries username and deviceId.
                    source: job.config.videoInfo ? { ...job.config.videoInfo } : null,
                    decision: decision ? { ...decision } : null,
                    env: buildTranscodeEnvSnapshot(),
                    transcodeSpeed,
                });
            } catch (err) {
                // Non-throwing by contract (see recordTranscodeFailureEvent), but a
                // caller must never assume that — an unhandled rejection here would
                // still be an unhandled rejection on FFmpeg's exit path. Also catches
                // a synchronous throw from argument construction (e.g.
                // classifyTranscodeFailure or buildTranscodeEnvSnapshot).
                logger.debug('Transcode failure event recording failed unexpectedly', {
                    jobId: job.id,
                    outcome,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        })();
    }

    /**
     * Fire-and-forget respawn for the GPU ladder branches of handleExit. A
     * rejected spawn (an input refused by the playlist-body guard, or a
     * process-runner spawn failure) marks the job failed instead of becoming
     * an unhandled rejection with the job left looking alive.
     */
    private respawnFFmpeg(job: TranscodeJob): Promise<void> {
        return this.spawnFFmpeg(job).catch((err: unknown) => {
            // A stop/retire that landed during the spawn owns the job's state;
            // do not turn its 'stopping' into a failure (the process runner
            // treats that state the same way).
            if (err instanceof ShutdownInterruptedError) {
                job.status = 'stopped';
                logger.info('FFmpeg retry refused by shutdown', { jobId: job.id });
                return;
            }
            if (job.status === 'stopping' || job.status === 'stopped') return;
            job.status = 'error';
            job.error = err instanceof Error ? err.message : String(err);
            logger.error('FFmpeg respawn failed', err as Error, { jobId: job.id });
            if (this.getCurrentJobId(job.config.playSessionId) === job.id) {
                this.persistence
                    // D-HLS-1 follow-up: own-job write, pod-guarded (see above).
                    .updateStatus(
                        job.config.playSessionId,
                        'error',
                        job.error,
                        undefined,
                        getCurrentPodName(),
                    )
                    .catch((persistErr: unknown) => {
                        logger.warn('Failed to persist respawn failure status', {
                            jobId: job.id,
                            error: String(persistErr),
                        });
                    });
            }
        });
    }

    /**
     * Spawn FFmpeg process for a job using the event-based ProcessRunner
     */
    private async spawnFFmpeg(job: TranscodeJob): Promise<void> {
        // F4: enumerate the demuxer list off the event loop; the builder reads it synchronously.
        const whitelistReady = prepareMediaFormatWhitelist();
        if (whitelistReady) await whitelistReady;
        // A seek or a scheduled GPU retry may already be preparing a spawn
        // when SIGTERM arrives. Leave the job restorable for the next pod.
        if (this.isShuttingDown || isWebShuttingDown()) {
            job.status = 'stopped';
            logger.info('Skipping FFmpeg start during shutdown', { jobId: job.id });
            throw new ShutdownInterruptedError();
        }
        const args = this.buildFFmpegArgs(job);
        job.spawnAttempt = (job.spawnAttempt ?? 0) + 1;
        // Clear the previous attempt's progress readings. transcodeSpeed is only
        // overwritten when FFmpeg emits a `speed=` line, and ladder respawns reuse
        // this same job object — so an attempt that dies before encoding a frame
        // would otherwise record its predecessor's speed, which reads in a bug
        // report as "it was keeping up" when it never started.
        job.transcodeSpeed = undefined;
        job.transcodeFps = undefined;
        job.rateSample = undefined;
        // A new process starts slowly (probe, encoder init, the seek target's
        // keyframe): its slow-transcode judgement starts over with a grace.
        job.slowTranscode = startSlowTracking(Date.now());
        // Same reason, for the teardown stamp: the ladder respawns reuse this job
        // object, so a kill we requested for the PREVIOUS process must not make the
        // next one's genuine failure look intentional. killEscalated is cleared for
        // the same reason — it gates handleExit's external-SIGKILL branch.
        job.killRequested = undefined;
        job.shutdownKillRequested = undefined;
        job.killEscalated = undefined;
        // Only an exit of THIS process can say it read the input to the end.
        job.reachedEndOfInput = undefined;
        // A new process starts running; a stop on the previous one is history.
        job.throttledAt = undefined;
        job.throttlePaused = false;
        job.parked = undefined;
        job.parkedAt = undefined;
        const startTime = Date.now();

        // Record spawn time for stale segment detection.
        // Files with mtime < lastFFmpegSpawnTime are from a previous FFmpeg run
        // and must not be served (different PTS timeline after -copyts -start_at_zero).
        // previousFFmpegSpawnTime captures the spawn this one replaces (null on the
        // job's first spawn, since spawnAttempt was just incremented to 1 above) —
        // see its doc comment on TranscodeJob for why the guard needs it.
        job.previousFFmpegSpawnTime = job.spawnAttempt > 1 ? job.lastFFmpegSpawnTime : null;
        job.lastFFmpegSpawnTime = startTime;

        const handleMasterPlaylistCheck = () => {
            void this.checkMasterPlaylist(job, startTime);
        };

        const handleExit = (
            code: number | null,
            signal: string | null,
            stderrBuffer: string,
            receivedSigterm: boolean,
        ) => {
            // Capture status before any changes for logging
            const wasStatus = job.status;
            // Snapshot the attempt number / last observed speed for THIS exit
            // before any branch below can respawn — see recordFailureEvent's
            // doc comment for why reading these from `job` inside the recorder
            // itself would race a `void this.spawnFFmpeg(job)` respawn.
            const failedAttempt = job.spawnAttempt ?? 1;
            const failedTranscodeSpeed = job.transcodeSpeed ?? null;
            // A job is "superseded" when a NEWER job for the same play session has
            // already replaced it as current (e.g. the client changed playback
            // config right after start — common on Safari/native-HLS, which
            // re-requests the stream when it applies saved audio/subtitle
            // preferences). The old job's FFmpeg then dies non-zero because its
            // working dir was reaped — that's expected teardown, NOT a playback
            // failure, so it must never surface a probe-error to the player.
            // This is race-proof vs. the status='stopping' flag (which can lag
            // the dir reap).
            const currentJobId = this.jobsByPlaySession.get(sessionKey(job.config.playSessionId));
            const isSuperseded = currentJobId !== undefined && currentJobId !== job.id;
            // `killRequested` is the third — and only deterministic — arm: it is
            // stamped inside killFFmpeg before the SIGTERM, so an exit we caused is
            // recognisable even when `status` has been restored to a running value
            // (the ladder's retry branches do exactly that) and even when FFmpeg
            // swallows the signal and reports a bare `code=255, signal=null`.
            // Without it, an ordinary "user pressed stop" filed a transcode failure.
            // HTTP draining leaves producers alive. Only an issued kill can
            // make this process's exit a shutdown interruption.
            const shutdownKill = job.shutdownKillRequested === true && job.killRequested === true;
            const isIntentional =
                wasStatus === 'stopping' || isSuperseded || job.killRequested === true;

            // If the job is mid-seek, this exit belongs to a process the seek
            // flow is tearing down and replacing. Skip every mutation — the
            // seek flow manages job-level state via prepareJobStateForSeek()
            // and its own catch/finally at the call site handles genuine
            // spawn failures. Publishing a probe error here would race against
            // the next spawn and surface a stale overlay for a session that
            // is already advancing to its new position.
            if (job.isSeeking) {
                logger.debug('Ignoring exit from old process during seek', {
                    jobId: job.id,
                    code,
                    signal,
                    receivedSigterm,
                });
                return;
            }

            if (code === 0 && !shutdownKill) {
                // Keep status as 'ready' — all segments are on disk and the player
                // is still consuming them. Setting 'stopped' would cause the cleanup
                // loop to kill the job and the admin page to drop it.
                // The normal inactivity/progress timeout will clean up when the player
                // stops requesting segments.
                job.status = 'ready';
                job.reachedEndOfInput = !isIntentional;
                if (isGopModeJob(job)) {
                    // GOP mode: readiness comes from the assembler. Only a run that
                    // read its input to the end may flush the last entries; a stop
                    // we caused (also exit 0) leaves them unassembled.
                    if (!isIntentional) {
                        void this.finishGopAssembly(job)
                            .then((total) => {
                                logger.info('GOP mode: generation complete', {
                                    jobId: job.id,
                                    entries: total,
                                    assembled: job.gopAssembler?.readyEntries,
                                    broken: job.gopBroken,
                                });
                            })
                            .catch((err: unknown) => {
                                logger.warn('GOP mode: final assembly failed', {
                                    jobId: job.id,
                                    error: err instanceof Error ? err.message : String(err),
                                });
                            });
                    }
                } else if (job.config.totalDurationSeconds && job.config.totalDurationSeconds > 0) {
                    const totalSegments = uniformSegmentCount(
                        job.config.totalDurationSeconds,
                        job.segmentDurationSeconds,
                    );
                    job.segmentsReady = totalSegments;
                    // Flush the completed count to the DB immediately: the
                    // periodic persistJobProgress may not tick before this job is
                    // reaped, and a completed remux is served from disk for the
                    // rest of a long session — a cross-pod / post-GC progress read
                    // must report 100%, not the stale creation-time 0.
                    if (job.generationRole === 'current') {
                        void this.persistence
                            .updateProgress(job.config.playSessionId, totalSegments, true)
                            .catch(() => {
                                /* non-fatal: next periodic flush / read reconciles */
                            });
                    }
                    logger.info('FFmpeg transcode completed (all segments ready)', {
                        jobId: job.id,
                        totalSegments,
                        duration: job.config.totalDurationSeconds,
                    });
                } else {
                    logger.info('FFmpeg transcode completed (all segments ready)', {
                        jobId: job.id,
                    });
                }

                // Preview-cache-backed job: drop a `.ready` marker into the exact
                // caller-provided dir and flip the cache entry ready/sized. Fired
                // (not awaited) — handleExit is a synchronous callback, mirroring
                // the existing void-fire-and-forget pattern used elsewhere in this
                // handler (e.g. publishProbeError below).
                if (job.config.outputDir || job.config.cacheKey) {
                    const cacheOutputDir = job.config.outputDir;
                    const cacheKey = job.config.cacheKey;
                    void (async (): Promise<void> => {
                        if (cacheOutputDir) {
                            await fs
                                .writeFile(path.join(cacheOutputDir, '.ready'), '')
                                .catch(() => {});
                        }
                        if (cacheKey) {
                            const size = await dirSizeBytes(cacheOutputDir ?? '').catch(() => 0);
                            getPreviewCacheStore().markReady(cacheKey, size);
                        }
                    })();
                }
            } else if (isIntentional) {
                // Either stopJob()/retireJobGeneration() set status='stopping'
                // before killing FFmpeg, OR this job was superseded by a newer
                // job for the same play session (its dir was reaped → non-zero
                // exit). The exit code on teardown is non-deterministic
                // (255/1/137 observed), so we accept any and do NOT surface it
                // as a playback failure.
                job.status = 'stopped';
                logger.info('FFmpeg transcode terminated (intentional stop)', {
                    jobId: job.id,
                    code,
                    signal,
                    shutdownKill,
                    superseded: isSuperseded,
                    supersededBy: isSuperseded ? currentJobId : undefined,
                });
                // Tell the runner this exit is handled: its 500 ms startup
                // check must not rethrow a shutdown kill as a failed start.
                if (shutdownKill) return true;
            } else if (signal === 'SIGKILL' && !job.killEscalated) {
                // SIGKILL we didn't send: kernel OOM, external orphan cleanup,
                // operator kill -9. Surface it so the user sees something went
                // wrong instead of a silent freeze. (Our own killFFmpeg sets
                // killEscalated before promoting SIGTERM → SIGKILL.)
                job.status = 'error';
                job.error = 'FFmpeg killed by SIGKILL (possible OOM)';
                logger.error('FFmpeg transcode killed externally', undefined, {
                    jobId: job.id,
                    signal,
                    stderr: stderrBuffer,
                });
                void this.publishProbeError(
                    job,
                    'ffmpeg_exit',
                    'FFmpeg killed (possible out-of-memory)',
                );
                this.recordFailureEvent(
                    job,
                    args,
                    'killed',
                    code,
                    signal,
                    stderrBuffer,
                    failedAttempt,
                    failedTranscodeSpeed,
                );
            } else if (signal !== null) {
                // Our own SIGKILL escalation, or any other signal after we
                // already know the termination was intentional. Silent stop.
                job.status = 'stopped';
                logger.info('FFmpeg transcode killed', {
                    jobId: job.id,
                    signal,
                    killEscalated: job.killEscalated ?? false,
                });
            } else if (receivedSigterm) {
                // External SIGTERM with no prior stopJob call (pod shutdown,
                // manual kill). FFmpeg caught the signal and logged "signal 15"
                // earlier in its stderr stream — detected from the full 5000-
                // char buffer in process-runner, so verbose codec stats cannot
                // mask it.
                job.status = 'stopped';
                logger.info('FFmpeg transcode terminated (external SIGTERM)', {
                    jobId: job.id,
                    code,
                });
            } else if (
                !job.config.softwareEncodeFallback &&
                job.transcodeDecisionResult?.useGpu &&
                // Only before the session served any GPU output: a run that
                // dies mid-stream (driver reset), or a seek generation, must
                // not continue with a different encoder behind segments the
                // player already has — the VOD playlist has one EXT-X-MAP and
                // the hvc1/avc1 parameter sets live in that init segment. A
                // generation-0 fallback carries over to later seeks via config.
                job.segmentsReady === 0 &&
                // A restored/taken-over job starts at segmentsReady 0 as well, but
                // its earlier run may have served segments and the init under the
                // GPU encoder: switching encoders behind them corrupts the picture.
                !job.restoredFromPersistence &&
                // Every seek path counts: in place (seek-controller) and a new
                // generation (seekCount = previous + 1).
                job.seekCount === 0 &&
                isGpuEncoderSessionFailure(job.transcodeDecisionResult.gpuEncoder, stderrBuffer)
            ) {
                // The GPU encoder could not open a session: another app holds it
                // (game streaming, OBS, Discord, instant replay) or the driver's
                // session limit is reached. Waiting rarely helps — a game stream
                // holds the encoder for hours — so this job continues in software
                // at the same output size (buildFFmpegArgs), and the player is
                // told why (softwareFallbackFrom in the progress payload). Only
                // this job: the next one tries the GPU again.
                const fromEncoder = job.transcodeDecisionResult.gpuEncoder!;
                job.config.softwareEncodeFallback = fromEncoder;
                job.transcodeDecisionResult = toSoftwareDecision(job.transcodeDecisionResult);
                // Publish the software contract before respawn awaits I/O;
                // manifests can read it before the replacement argv is built.
                this.updateSoftwareFallbackPlan(job);

                job.status = wasStatus;
                logger.warn(
                    'GPU encoder could not open a session (in use by another app?) — continuing this job with software encoding',
                    {
                        jobId: job.id,
                        gpuEncoder: fromEncoder,
                        summary: summarizeFfmpegStderr(stderrBuffer, code),
                    },
                );
                const replacement = this.respawnFFmpeg(job);
                this.recordFailureEvent(
                    job,
                    args,
                    'bridged',
                    code,
                    signal,
                    stderrBuffer,
                    failedAttempt,
                    failedTranscodeSpeed,
                );
                // The row and the Valkey stats carry the switch to other pods
                // and across a restart (a restored job must not retry NVENC
                // or change size).
                if (this.getCurrentJobId(job.config.playSessionId) === job.id) {
                    this.persistence.saveJob(job).catch((err: unknown) => {
                        logger.warn('Failed to persist software-encode fallback', {
                            jobId: job.id,
                            error: String(err),
                        });
                    });
                }
                this.publishThrottleChange();
                // The runner waits for the replacement before its spawn returns.
                return replacement;
            } else {
                // Learn-on-failure: a VA-API-family (QSV / VA-API) transcode that
                // died trying to feed system-memory frames into a GPU-only
                // filter/encoder. This happens when the source codec can't be
                // hardware-decoded (e.g. MPEG-4 ASP / VC-1 on Arc) but the static
                // whitelist assumed it could, so decode silently fell back to
                // software while scale_qsv/scale_vaapi/encode still demanded a GPU
                // surface (auto_scale -38 → "Impossible to convert between the
                // formats" → "Could not open encoder" → -22).
                //
                // Two DIFFERENT questions are answered from the exit, with different
                // signatures (see transcode-failure-classifier):
                //   • retrySignature (BROAD) — is this worth one silent re-attempt?
                //     The terminal symptom lines ("Could not open encoder", filter
                //     reinit) are enough; a cheap retry costs little.
                //   • learnSignature (STRICT) — is this PROVEN silicon incapability
                //     worth persisting to the deny-map? Requires the definitive
                //     "Impossible to convert between the formats" line AND the
                //     absence of any transient resource/session signature. On a
                //     small-VRAM Arc, concurrent transcodes exhaust encode sessions /
                //     device memory and emit the identical terminal error — learning
                //     from that permanently (and wrongly) routes a decodable codec
                //     through software. isLearnableGpuDecodeFailure() gates that out.
                //
                // Flow: first failure → one delayed retry with the SAME (unbridged)
                // args (a busy GPU often frees a session in ~2s). Second failure →
                // if learnSignature, teach the deny-map + bridge (persisted, affects
                // future jobs); otherwise bridge THIS job only via
                // config.forceSoftwareDecodeBridge — rescuing it without poisoning
                // the deny-map. Either way the user never sees the error.
                const gpuEnc = job.transcodeDecisionResult?.gpuEncoder;
                const backend = gpuEnc ? getHwAccelFromEncoder(gpuEnc) : null;
                const sourceCodec = job.config.videoInfo?.codec;
                const sourceBitDepth = job.config.videoInfo?.bitDepth;
                const retrySignature =
                    /could not open encoder|impossible to convert between the formats|reinitializing filters!/i.test(
                        stderrBuffer,
                    );
                const learnSignature = isLearnableGpuDecodeFailure(stderrBuffer);
                const isDecodeBridgeCandidate =
                    backend &&
                    hardwareDetection.canSoftwareDecodeBridge(backend) &&
                    retrySignature &&
                    !job.gpuBridgeRetried &&
                    hardwareDetection.isSourceHardwareDecodable(
                        backend,
                        sourceCodec,
                        sourceBitDepth,
                    );
                if (isDecodeBridgeCandidate && !job.hwDecodeRetried) {
                    job.hwDecodeRetried = true;
                    // Keep the running status; do NOT surface an error or persist
                    // 'error'. Re-spawn with identical args — no deny-map write, so
                    // a codec that merely lost a race for the GPU this once stays
                    // hardware-decoded for every other job. Delay the respawn briefly
                    // so a concurrent encode session / VRAM held by another transcode
                    // has time to release before the retry contends for it again — an
                    // immediate respawn hits the same saturated GPU and fails
                    // identically, which used to escalate a transient stall into a
                    // (false) learned incapability.
                    job.status = wasStatus;
                    logger.warn(
                        'GPU decode surface mismatch — retrying once with unmodified hardware-decode args before concluding incompatibility',
                        { jobId: job.id, backend, sourceCodec, gpuEncoder: gpuEnc },
                    );
                    setTimeout(() => {
                        // Guard against teardown/seek during the backoff window: a
                        // stopJob() flips status to 'stopping', a seek sets isSeeking
                        // and manages its own respawn.
                        if (job.status === wasStatus && !job.isSeeking && !job.process) {
                            void this.respawnFFmpeg(job);
                        }
                    }, GPU_DECODE_RETRY_BACKOFF_MS);
                    this.recordFailureEvent(
                        job,
                        args,
                        'retried',
                        code,
                        signal,
                        stderrBuffer,
                        failedAttempt,
                        failedTranscodeSpeed,
                    );
                    return true;
                }
                if (isDecodeBridgeCandidate && job.hwDecodeRetried && learnSignature) {
                    const sample = job.config.localFilePath?.split('/').pop();
                    const persisted = hardwareDetection.markSourceNotHardwareDecodable(
                        backend,
                        sourceCodec!,
                        { bitDepth: sourceBitDepth, sample },
                    );
                    // The deny-map refuses depth-less lessons (they can only be
                    // written to the bare-codec key, which over-reaches onto every
                    // 8-bit source of that codec). Nothing flipped in the deny-map,
                    // so this respawn needs the bridge forced explicitly or it
                    // rebuilds the same unbridged args and fails identically.
                    if (!persisted) job.config.forceSoftwareDecodeBridge = true;
                    job.gpuBridgeRetried = true;
                    // Keep the running status; do NOT surface an error or persist
                    // 'error'. The re-spawn rebuilds args (now bridged, because the
                    // deny-map entry flips isSourceHardwareDecodable) and installs its
                    // own handleExit, which will report the real outcome.
                    job.status = wasStatus;
                    logger.warn(
                        'GPU hardware-decode unsupported for source codec — learned and retrying with software-decode bridge',
                        { jobId: job.id, backend, sourceCodec, gpuEncoder: gpuEnc },
                    );
                    const replacement = this.respawnFFmpeg(job);
                    this.recordFailureEvent(
                        job,
                        args,
                        'learned',
                        code,
                        signal,
                        stderrBuffer,
                        failedAttempt,
                        failedTranscodeSpeed,
                    );
                    return replacement;
                }
                if (isDecodeBridgeCandidate && job.hwDecodeRetried && !learnSignature) {
                    // Second surface-mismatch exit, but WITHOUT the strict learn
                    // signature (or with a transient resource/session signature) — the
                    // failure is not proof the GPU can't decode this codec. Rescue
                    // THIS job with the software-decode bridge but write NOTHING to the
                    // deny-map, so a busy-GPU episode never poisons a decodable codec.
                    // forceSoftwareDecodeBridge routes only this respawn; gpuBridgeRetried
                    // caps the loop (a bridged attempt that still fails falls through
                    // to the normal error path below).
                    job.config.forceSoftwareDecodeBridge = true;
                    job.gpuBridgeRetried = true;
                    job.status = wasStatus;
                    logger.warn(
                        'GPU transcode failed twice without a decode-capability signature (likely transient GPU pressure) — bridging this session only, not learning',
                        { jobId: job.id, backend, sourceCodec, gpuEncoder: gpuEnc },
                    );
                    const replacement = this.respawnFFmpeg(job);
                    this.recordFailureEvent(
                        job,
                        args,
                        'bridged',
                        code,
                        signal,
                        stderrBuffer,
                        failedAttempt,
                        failedTranscodeSpeed,
                    );
                    return replacement;
                }

                job.status = 'error';
                job.error = `FFmpeg exited with code ${code}`;
                logger.error('FFmpeg transcode failed', undefined, {
                    jobId: job.id,
                    code,
                    stderr: stderrBuffer,
                    gpuEncoder: job.transcodeDecisionResult?.gpuEncoder,
                });

                // Invalidate the GPU encoder probe cache so the next job re-probes
                // instead of trusting a potentially broken GPU encoder
                if (
                    job.transcodeDecisionResult?.useGpu &&
                    job.transcodeDecisionResult?.gpuEncoder
                ) {
                    hardwareDetection.invalidateEncoderProbe(
                        job.transcodeDecisionResult.gpuEncoder,
                    );
                }

                // Surface a one-line summary to the player overlay (see
                // keyframe-probe-progress.service). The full stderr stays in
                // the server log above. Dynamic import mirrors the pattern
                // used by playback.service and keeps this file free of a
                // hard cycle with the probe-progress module.
                //
                // Guarded (pre-existing gap, not newly introduced): this runs
                // BEFORE publishProbeError and recordFailureEvent below — an
                // unguarded throw here (classifyTranscodeFailure is pure regex
                // today, but nothing enforces that staying true) would skip both,
                // leaving the session's status update never persisted. Falls back
                // to 'unknown' rather than let the whole terminal-failure path die.
                let failure: TranscodeFailure;
                try {
                    failure = classifyTranscodeFailure(stderrBuffer, code);
                } catch (err) {
                    logger.warn('classifyTranscodeFailure threw — using fallback category', {
                        jobId: job.id,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    failure = {
                        category: 'unknown',
                        summary: `FFmpeg exited with code ${code}`,
                    };
                }
                logger.warn('FFmpeg transcode failed', {
                    jobId: job.id,
                    category: failure.category,
                    summary: failure.summary,
                });

                // Actionable hint for the common GPU-less failure mode: a CPU
                // transcode running BELOW real-time can't keep up with playback
                // and gets reaped mid-encode (its working files vanish → FFmpeg
                // dies with a missing-file error). Make that obvious in the log
                // instead of leaving an operator to decode a generic FFmpeg exit.
                const lastSpeed = job.transcodeSpeed;
                if (
                    !job.transcodeDecisionResult?.useGpu &&
                    typeof lastSpeed === 'number' &&
                    lastSpeed < 0.95
                ) {
                    logger.warn(
                        'Transcode was running BELOW real-time on CPU and failed before finishing. ' +
                            'This host has no GPU and likely cannot transcode this title fast enough ' +
                            '(typical for 4K / HDR / Dolby Vision sources). Options: enable GPU ' +
                            'transcoding (GPU_ACCELERATION), or enable TRANSCODE_DOWNSCALE_CPU_TO_1080P ' +
                            'to cap CPU transcodes to 1080p so they can keep up.',
                        {
                            jobId: job.id,
                            lastSpeed,
                            sourceHeight: job.config.videoInfo?.height,
                            videoAction: job.transcodeDecisionResult?.videoAction,
                        },
                    );
                }
                void this.publishProbeError(
                    job,
                    'ffmpeg_exit',
                    formatTranscodeFailureMessage(failure),
                );
                this.recordFailureEvent(
                    job,
                    args,
                    'failed',
                    code,
                    signal,
                    stderrBuffer,
                    failedAttempt,
                    failedTranscodeSpeed,
                    failure,
                );
            }

            // Preview-cache-backed job that did not exit cleanly (intentional
            // stop, external kill, or genuine error): flip the cache entry to
            // failed so a broken warm is never left stuck in 'warming' forever.
            if (code !== 0 && job.config.cacheKey) {
                getPreviewCacheStore().markFailed(job.config.cacheKey);
            }

            // Persist final status to database so the web container can see it.
            // Note: seek cases never reach here — the early return above catches all
            // isSeeking exits regardless of exit code.
            //
            // Single-writer rule for an INTENTIONAL stop (isIntentional): stopJob()'s
            // retireJobGeneration() is the authoritative writer of can_restore for
            // that case (via its persistForRestart branch, which sets can_restore=true
            // so the session can resume). That write happens AFTER this handler runs —
            // retireJobGeneration is still inside its `await killFFmpeg(job)` call when
            // the real process 'exit' event fires and invokes this callback, since the
            // spawn-time exit listener and killFFmpeg's own exit listener are both
            // registered on the same child process and fire off the same event
            // emission. An unconditional write here would race that authoritative
            // write and could leave a gracefully-stopped session stuck with
            // can_restore=false forever. So this generic block must skip intentional
            // exits entirely and defer to retireJobGeneration. Non-intentional exits
            // (real crash/OOM/error) have no other writer, so they still persist here.
            const finalStatus = job.status;
            if (!isIntentional && this.getCurrentJobId(job.config.playSessionId) === job.id) {
                // canRestore=true for 'ready' (completed, segments on disk)
                // canRestore=false for 'stopped' (killed) and 'error'
                const canRestore = finalStatus === 'ready';
                this.persistence
                    // D-HLS-1 follow-up: own-job write, pod-guarded (see above).
                    .updateStatus(
                        job.config.playSessionId,
                        finalStatus,
                        finalStatus === 'error' ? job.error : undefined,
                        canRestore,
                        getCurrentPodName(),
                    )
                    .catch((err) => {
                        logger.warn(
                            'Failed to persist FFmpeg exit status to database',
                            { jobId: job.id, status: finalStatus },
                            err as Error,
                        );
                    });
            }
        };

        const handleError = (error: Error) => {
            if (job.shutdownKillRequested && job.killRequested) {
                job.status = 'stopped';
                logger.info('FFmpeg process terminated during shutdown', { jobId: job.id });
                return;
            }
            // During seek, this error is from the old process being killed.
            // Skip all mutations — the seek flow manages its own state.
            if (job.isSeeking) {
                logger.debug('Ignoring error from killed process during seek', {
                    jobId: job.id,
                    error: error.message,
                });
                return;
            }

            // Intentional teardown: stopJob/retireJobGeneration set status
            // to 'stopping' before killing FFmpeg. A spawn/process error
            // racing against that teardown is expected, not a user-facing
            // failure — mirrors the handleExit guard.
            if (job.status === 'stopping') {
                logger.debug('Ignoring spawn error during intentional stop', {
                    jobId: job.id,
                    error: error.message,
                });
                return;
            }

            this.recordFailureEvent(
                job,
                args,
                'spawn_failed',
                null,
                null,
                error.message,
                job.spawnAttempt ?? 1,
                job.transcodeSpeed ?? null,
            );

            job.status = 'error';
            job.error = error.message;
            logger.error('FFmpeg process error', error, { jobId: job.id });

            if (this.getCurrentJobId(job.config.playSessionId) === job.id) {
                this.persistence
                    // D-HLS-1 follow-up: own-job write, pod-guarded (see above).
                    .updateStatus(
                        job.config.playSessionId,
                        'error',
                        error.message,
                        false,
                        getCurrentPodName(),
                    )
                    .catch((err) => {
                        logger.warn(
                            'Failed to persist FFmpeg error status to database',
                            { jobId: job.id },
                            err as Error,
                        );
                    });
            }

            const failure = classifyTranscodeFailure('', null, error.message);
            void this.publishProbeError(
                job,
                'ffmpeg_spawn',
                formatTranscodeFailureMessage(failure),
            );
        };

        const callbacks: ProcessLifecycleCallbacks = {
            onMasterPlaylistCheck: handleMasterPlaylistCheck,
            onExit: handleExit,
            onError: handleError,
        };
        // Every spawn of this job's input — start, restore, seek generation,
        // GPU ladder respawn — re-checks that the input is still media, not a
        // playlist/manifest body (final wave M1; see transcoding/input-guard.ts).
        // A refusal throws, which each caller already handles as a failed
        // spawn. Placed after the synchronous prefix above (spawnAttempt,
        // args), which handleExit's failure recording relies on running the
        // instant a respawn is requested. A job with no local input has
        // nothing to sniff (buildFFmpegArgs returned no argv for it).
        if (job.config.localFilePath) {
            await assertTranscodeInputIsMedia(job.config);
            // A stop or supersede that landed during the sniff found no
            // process to kill. Spawning now would orphan an FFmpeg and flip
            // 'stopping' back to 'running'.
            if (job.status === 'stopping' || job.status === 'stopped') {
                logger.debug('Job stopped during the input sniff — not spawning FFmpeg', {
                    jobId: job.id,
                    status: job.status,
                });
                return;
            }
        }
        // GOP mode: the part directories must exist before FFmpeg opens them,
        // and the assembler must be watching from the first part on.
        // Only GOP jobs pay the await: every other spawn keeps its exact timing.
        if (isGopModeJob(job)) await this.ensureGopAssembler(job);
        void publishPlaybackPressure();
        await this.processRunner.spawnFFmpeg(job, args, callbacks);
    }

    /**
     * Broadcast a one-line terminal FFmpeg error to the player-overlay side-
     * channel. No-op when the job has no fileId — the overlay keys progress by
     * fileId, and without one there is no entry to replace.
     *
     * Fire-and-forget by design: a Valkey hiccup must not mask the underlying
     * FFmpeg error. The dynamic import avoids a module cycle with the probe-
     * progress service.
     */
    private async publishProbeError(
        job: TranscodeJob,
        code: 'ffmpeg_exit' | 'ffmpeg_spawn',
        message: string,
    ): Promise<void> {
        const { fileId, itemId } = job.config;
        if (!fileId) return;
        try {
            const { setProbeError } = await import('./keyframe-probe-progress.service.js');
            await setProbeError({ fileId, itemId, code, message });
        } catch (err) {
            logger.debug('Failed to publish probe error', {
                jobId: job.id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    /**
     * Check if master playlist is ready
     */
    private async checkMasterPlaylist(job: TranscodeJob, startTime?: number): Promise<void> {
        // In muxed mode, FFmpeg produces index.m3u8 directly (no master playlist)
        const playlistName =
            job.config.hlsOutput?.hlsAudioMode === 'muxed' ? 'index.m3u8' : 'master.m3u8';
        const masterPath = path.join(job.outputDir, playlistName);
        try {
            await fs.access(masterPath);
            job.masterPlaylistReady = true;
            job.status = 'ready';
            const elapsedMs = startTime ? Date.now() - startTime : undefined;
            logger.info('FFmpeg transcode ready (master playlist created)', {
                jobId: job.id,
                playSessionId: job.config.playSessionId,
                itemId: job.config.itemId,
                elapsedMs,
                videoCodec: job.config.videoInfo?.codec,
            });
        } catch (err) {
            // fs.access throws ENOENT when master.m3u8 doesn't exist yet — expected during startup.
            // Log unexpected errors (permissions, disk issues) so they're diagnosable.
            const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined;
            if (code !== 'ENOENT') {
                logger.warn('Unexpected error checking master playlist', {
                    jobId: job.id,
                    error: err instanceof Error ? err.message : String(err),
                    code,
                });
            }
        }
    }

    /**
     * Build FFmpeg arguments for multi-audio HLS output.
     *
     * Uses FullTranscodeStrategy: single local file input processed entirely
     * by FFmpeg with GPU-accelerated video encoding when available.
     */
    private updateSoftwareFallbackPlan(job: TranscodeJob): void {
        const plan = job.config.effectivePlan;
        if (!plan) return;
        const replacement = planStandaloneTranscode({
            ...plan.caps,
            decision: job.transcodeDecisionResult,
            videoInfo: job.config.videoInfo,
            videoDisabled: plan.videoDisabled,
            subtitleBurnIn: plan.subtitleBurnIn,
            gpuAcceleration: 'none',
            segmentDuration: plan.segmentDuration,
            startTimeSeconds: plan.startTimeSeconds,
            startNumber: plan.segmentOffset,
            tonemappingAlgorithm:
                job.transcodeDecisionResult?.tonemappingAlgorithm ?? config.TONEMAPPING_ALGORITHM,
        });
        job.config.effectivePlan = {
            ...plan,
            video: replacement.video,
            decision: replacement.decision,
        };
        job.transcodeDecisionResult = job.config.effectivePlan.decision;
    }

    private buildFFmpegArgs(job: TranscodeJob): string[] {
        // A job that fell back to software keeps doing so wherever it is
        // rebuilt — a restore from the row (whose transcode_decision upsertJob
        // leaves at the GPU one) included. Without this a restored job tried
        // NVENC again and, past the fallback gate, failed while it was busy.
        if (job.config.softwareEncodeFallback && job.transcodeDecisionResult?.useGpu) {
            job.transcodeDecisionResult = toSoftwareDecision(job.transcodeDecisionResult);
            this.updateSoftwareFallbackPlan(job);
        }
        const { config: jobConfig, outputDir, transcodeDecisionResult: decision } = job;

        if (!jobConfig.localFilePath) {
            logger.error('buildFFmpegArgs called without localFilePath', undefined, {
                jobId: job.id,
            });
            return [];
        }

        // job.segmentDurationSeconds was already set during startJob() —
        // copy-mode override to 10s happens before job creation, not here.

        const plan = jobConfig.effectivePlan;
        if (!plan) throw new Error('Job has no effective transcode plan');
        const { maxWidth, maxHeight, maxVideoBitrateMbps, qualityCapAudioReservationBps } =
            plan.caps;
        const strategyConfig: FullStrategyConfig = {
            outputDir,
            effectivePlan: plan,
            segmentDuration: plan.segmentDuration,
            startTimeSeconds: jobConfig.startTimeSeconds,
            startNumber: job.segmentOffset,
            audioTracks: jobConfig.audioTracks,
            videoInfo: jobConfig.videoInfo,
            videoDisabled: jobConfig.videoDisabled,
            hlsOutput: jobConfig.hlsOutput,
            localFilePath: jobConfig.localFilePath,
            useConcatDemuxer: jobConfig.useConcatDemuxer,
            // Bound preview transcodes to a short snippet so a single hover/hero
            // job can never transcode the whole movie (0 = unbounded).
            maxDurationSeconds:
                jobConfig.maxDurationSeconds ??
                (jobConfig.isPreview && config.PREVIEW_TRANSCODE_MAX_SECONDS > 0
                    ? config.PREVIEW_TRANSCODE_MAX_SECONDS
                    : undefined),
            // Cap preview segment size: an unconstrained encoder on a complex 4K
            // source emits 10+ Mbps segments that stall the hover player. Only
            // set for previews, so real playback's rate control is untouched.
            // Previews never carry a qualityCap, so the two are mutually
            // exclusive in practice; preview takes precedence if they ever did.
            maxVideoBitrateMbps,
            decision,
            // After a GPU encoder session failure the decision is software
            // already; 'none' also keeps hardware decode/upload out of the args.
            gpuAcceleration: jobConfig.softwareEncodeFallback ? 'none' : config.GPU_ACCELERATION,
            vaapiDevice: jobConfig.softwareEncodeFallback ? undefined : config.VAAPI_DEVICE,
            encodingPreset: jobConfig.softwareEncodeFallback
                ? softwareFallbackPreset(
                      jobConfig.encodingPreset ?? config.ENCODING_PRESET,
                      jobConfig.videoInfo?.height,
                  )
                : (jobConfig.encodingPreset ?? config.ENCODING_PRESET),
            nvencPreset: jobConfig.nvencPreset ?? config.NVENC_PRESET,
            nvencTune: config.NVENC_TUNE || undefined,
            nvencRc: config.NVENC_RC === 'auto' ? undefined : config.NVENC_RC,
            nvencCq: config.NVENC_CQ,
            h264Crf: config.H264_CRF,
            h265Crf: config.H265_CRF,
            videoBitrateMbps: config.VIDEO_BITRATE_MBPS,
            maxWidth,
            maxHeight,
            tonemappingAlgorithm: config.TONEMAPPING_ALGORITHM,
            deinterlaceMethod: config.DEINTERLACE_METHOD,
            audioCodec: config.AUDIO_CODEC,
            audioBitrateStereo: config.AUDIO_BITRATE_STEREO,
            audioBitrateSurround: config.AUDIO_BITRATE_SURROUND,
            audioVbr: config.AUDIO_VBR,
            audioBoost: config.AUDIO_BOOST,
            qualityCapAudioReservationBps,
            maxAudioChannels: jobConfig.maxAudioChannels,
            mediaSourceInfo: jobConfig.mediaSourceInfo,
            forceAudioTranscode: jobConfig.forceAudioTranscode,
            subtitleBurnIn: jobConfig.subtitleBurnIn,
            burnInHdrStrategy: config.HLS_BURN_IN_HDR_STRATEGY,
            // Load-bearing for the GPU recovery ladder in handleExit: after a second
            // surface-mismatch exit it sets job.config.forceSoftwareDecodeBridge and
            // respawns, expecting bridged (software-decode) args. This object is
            // assembled field-by-field, so omitting the flag rebuilt the IDENTICAL
            // failing command — the "bridge this session only" branch was a silent
            // no-op and the user got the failure banner it exists to prevent.
            forceSoftwareDecodeBridge: jobConfig.forceSoftwareDecodeBridge,
            sourceTimestamps: isNativeHlsClient(jobConfig),
            softwareEncodeFallback: jobConfig.softwareEncodeFallback,
        };
        const gopGrid = this.getGopGrid(job);
        if (gopGrid) {
            strategyConfig.gopSegments = {
                videoStartKeyframe: gopGrid.firstKeyframe[job.segmentOffset] ?? 0,
            };
        }

        const result = this.fullStrategy.buildArgs(strategyConfig);
        const startFlag = result.args.indexOf('-start_number');
        job.ffmpegOutputStartNumber = startFlag < 0 ? 0 : Number(result.args[startFlag + 1]);
        if (decision) {
            decision.hdrTonemapMode = resolveTonemapMode(result.args);
        }
        if (gopGrid && !result.gopSplit) {
            // The playlist already lists the keyframe grid; legacy-cut files would
            // be served under it, shifted. Fail closed instead (segment → 410).
            job.gopBroken = 'FFmpeg arguments fell back to the single-output layout';
            this.tripGop(job.config, job.gopBroken);
            logger.error('GOP mode: strategy did not build the GOP layout; failing closed', {
                jobId: job.id,
                playSessionId: job.config.playSessionId,
            });
        }
        logger.info('FFmpeg args built with FullTranscodeStrategy', {
            jobId: job.id,
            description: result.description,
            sourceTimestamps: strategyConfig.sourceTimestamps,
            argCount: result.args.length,
        });
        return result.args;
    }

    // ========================================================================
    // Cleanup
    // ========================================================================

    /**
     * Cleanup inactive jobs based on three criteria:
     * 1. No progress heartbeat for FFMPEG_PROGRESS_TIMEOUT_SECONDS (default 120s = 2 min)
     *    - Clients send progress every 10s, even when paused
     *    - If no heartbeat, client likely crashed/disconnected
     * 2. No segment access for FFMPEG_INACTIVITY_TIMEOUT_SECONDS (default 300s = 5 min)
     *    - Only applies if progress heartbeat is also stale
     *    - Fallback for clients that don't send progress reports
     * 3. Never served a single segment for FFMPEG_UNWATCHED_JOB_TIMEOUT_SECONDS
     *    (default 60s) despite having produced output
     *    - FFmpeg's own progress heartbeats keep criterion 1 from firing even
     *      though no client is actually reading the segments, so a job spawned
     *      by a manifest fetch that's never followed by a segment request
     *      would otherwise run for the full inactivity timeout
     *
     * Important: If progress heartbeats are being received (user paused but session active),
     * we do NOT kill based on segment inactivity alone. This allows users to pause for
     * extended periods without losing their transcode session.
     */
    private async cleanupInactiveJobs(): Promise<void> {
        if (this.isShuttingDown) return;

        const now = Date.now();
        const previousGenerationTtl = config.FFMPEG_PREVIOUS_GENERATION_TTL_SECONDS * 1000;

        // Collect jobs to stop first (don't modify map during iteration)
        // Store jobId to verify it hasn't changed before stopping (race condition protection)
        const jobsToStop: Array<{
            playSessionId: string;
            jobId: string;
            reason: string;
        }> = [];

        // Batch check if any in-memory jobs were marked as stopped in database (cross-pod stop)
        // Query only for the specific play sessions we have in memory (more efficient)
        // Filter out non-UUID session IDs (e.g. preview sessions use "preview-{uuid}-{ts}" format)
        // because the DB column is typed UUID and would throw a PostgresError on invalid input.
        let stoppedInDbPlaySessions: Set<string> = new Set();
        const endedPlaySessions = new Map<string, string>();
        // Rows cleanupExpiredJobs' dormant branch marked 'stopped' while leaving
        // can_restore=true. That is "this session went idle — keep it
        // restorable", NOT an admin/client stop (those set can_restore=false),
        // so the owner must release FFmpeg WITHOUT deleting the row. Treating it
        // as a stop deleted the row and 410'd the client on wake-up (prod
        // 2026-09-25, 373 x 410 in two minutes).
        const dormantInDbPlaySessions: Set<string> = new Set();
        // Client activity other pods recorded on the row (a heartbeat the router
        // hashed to a non-owner pod), keyed by sessionKey. Stays null when the
        // lookup failed: without it the client-gone arm cannot tell a client
        // heartbeating elsewhere from a gone one, so it does not run.
        let dbClientActivityAt: Map<string, number> | null = null;
        let lookupFailedThisSweep = false;
        // The map keys are sessionKey()s: a UUID session (dashed, or /j's dashless
        // 32-hex) is already in the dashed form Postgres returns, so the row's
        // play_session_id below matches its key without further folding.
        const playSessionIds = Array.from(this.jobsByPlaySession.keys()).filter((id) =>
            UUID_RE.test(id),
        );

        if (playSessionIds.length > 0) {
            try {
                // Query only the jobs we have in memory to check their DB status
                // This catches jobs marked as 'stopped' by cross-pod admin stops
                const dbJobs = await this.persistence.getJobsByPlaySessions(playSessionIds);
                dbClientActivityAt = new Map(
                    dbJobs.map((row) => [
                        sessionKey(row.play_session_id),
                        row.last_progress_at.getTime(),
                    ]),
                );
                // Feed the global cap's idle floor too (filterEvictableByIdle), but
                // only for a job whose heartbeats do not reach this pod. The row
                // cannot tell PAUSED from ACTIVE, so for a job heartbeating here
                // the local `lastActiveProgressAt` stays the better signal and a
                // paused viewer keeps ageing into eviction.
                const sweepNow = Date.now();
                for (const row of dbJobs) {
                    const jobId = this.jobsByPlaySession.get(sessionKey(row.play_session_id));
                    const job = jobId ? this.jobs.get(jobId) : undefined;
                    if (job && job.id === row.job_id) {
                        const heartbeatsHere =
                            sweepNow - job.lastClientHeartbeatAt.getTime() <
                            CROSS_POD_HEARTBEAT_GRACE_MS;
                        job.lastPersistedClientActivityAt = heartbeatsHere
                            ? undefined
                            : row.last_progress_at;
                    }
                }

                for (const dbJob of dbJobs) {
                    const key = sessionKey(dbJob.play_session_id);
                    const localId = this.jobsByPlaySession.get(key);
                    const local = localId ? this.jobs.get(localId) : undefined;
                    // /j jobs have a separate reporting session id and intentionally
                    // own no play_sessions stub. Non-UUID previews never enter this query.
                    if (
                        local?.id === dbJob.job_id &&
                        local.config.deviceId !== JELLYFIN_COMPAT_DEVICE_ID
                    ) {
                        if (dbJob.play_session_status === null) {
                            endedPlaySessions.set(key, 'session_missing');
                        } else if (
                            ['CRASHED', 'COMPLETED', 'KILLED'].includes(dbJob.play_session_status)
                        ) {
                            endedPlaySessions.set(
                                key,
                                dbJob.play_session_stop_reason ?? 'session_ended',
                            );
                        }
                    }
                    // Only stop jobs that are explicitly marked as 'stopped' in DB
                    // Don't stop jobs that are 'stopping' (normal in-progress stop on owning pod)
                    if (dbJob.status === 'stopped') {
                        // CRITICAL: Verify the job_id matches to prevent stopping a new job
                        // that reused the same play session ID
                        const jobId = this.jobsByPlaySession.get(sessionKey(dbJob.play_session_id));
                        const job = jobId ? this.jobs.get(jobId) : undefined;

                        if (job && job.id === dbJob.job_id) {
                            // Don't kill jobs that are currently seeking — the DB
                            // may have a stale 'stopped' from the old FFmpeg exit
                            // before the seek restarted FFmpeg
                            if (job.isSeeking) {
                                logger.debug(
                                    'Ignoring stopped DB record — job is currently seeking',
                                    {
                                        playSessionId: dbJob.play_session_id,
                                        jobId: job.id,
                                    },
                                );
                            } else if (dbJob.can_restore) {
                                dormantInDbPlaySessions.add(sessionKey(dbJob.play_session_id));
                                logger.info('Job marked dormant in database (kept restorable)', {
                                    playSessionId: dbJob.play_session_id,
                                    jobId: job.id,
                                    dbPodName: dbJob.pod_name,
                                });
                            } else {
                                stoppedInDbPlaySessions.add(sessionKey(dbJob.play_session_id));
                                logger.info('Job marked as stopped in database (cross-pod stop)', {
                                    playSessionId: dbJob.play_session_id,
                                    jobId: job.id,
                                    dbErrorMessage: dbJob.error_message,
                                    dbPodName: dbJob.pod_name,
                                });
                            }
                        } else {
                            logger.debug(
                                'Ignoring stopped DB record - job_id mismatch (stale record)',
                                {
                                    playSessionId: dbJob.play_session_id,
                                    dbJobId: dbJob.job_id,
                                    memoryJobId: job?.id,
                                    dbPodName: dbJob.pod_name,
                                },
                            );
                        }
                    }
                }
            } catch (error) {
                lookupFailedThisSweep = true;
                // Log the transition into the failing state once; every later
                // failed sweep would repeat the same line for the whole outage.
                if (!this.jobLookupFailing) {
                    this.jobLookupFailing = true;
                    logger.warn(
                        'Failed to batch check job status in database; completed jobs fall back to the idle-age ceiling',
                        {
                            error: String(error),
                            maxIdleSeconds: COMPLETED_JOB_LOOKUP_FAILED_MAX_IDLE_MS / 1000,
                        },
                    );
                } else {
                    logger.debug('Job status lookup still failing', { error: String(error) });
                }
                // Non-fatal, continue with normal timeout checks
            }
            if (!lookupFailedThisSweep && this.jobLookupFailing) {
                this.jobLookupFailing = false;
                logger.info('Job status lookup recovered; normal completed-job reaping resumed');
            }
        } else if (this.jobLookupFailing) {
            this.jobLookupFailing = false;
        }

        for (const [playSessionId, jobId] of this.jobsByPlaySession) {
            const job = this.jobs.get(jobId);
            if (!job) continue;

            // Terminal session state wins over recency, seeking, and dormant
            // retention. A terminal job must never be restorable.
            const endedReason = endedPlaySessions.get(playSessionId);
            if (endedReason) {
                jobsToStop.push({ playSessionId, jobId, reason: endedReason });
                continue;
            }

            // Clean up errored jobs after 1 hour
            if (job.status === 'error') {
                const errorAge = now - job.lastAccessedAt.getTime();
                const ERROR_IN_MEMORY_TTL = 60 * 60 * 1000; // 1 hour
                if (errorAge > ERROR_IN_MEMORY_TTL) {
                    jobsToStop.push({
                        playSessionId,
                        jobId,
                        reason: 'error_cleanup',
                    });
                }
                continue;
            }

            // Skip jobs that aren't running
            if (job.status !== 'ready' && job.status !== 'running') continue;

            // Check if this job was marked as stopped in database
            if (stoppedInDbPlaySessions.has(playSessionId)) {
                jobsToStop.push({
                    playSessionId,
                    jobId,
                    reason: 'stopped_in_database',
                });
                continue;
            }
            if (dormantInDbPlaySessions.has(playSessionId)) {
                jobsToStop.push({
                    playSessionId,
                    jobId,
                    reason: 'dormant_in_database',
                });
                continue;
            }

            // Cache-backed preview artifacts (config.outputDir/cacheKey — the
            // shared `preview-cache-*` jobs) are owned by the PreviewCacheStore,
            // NOT the timeout heuristics below. A completed preview clip
            // legitimately STOPS making FFmpeg progress (it's a short, finite
            // window that finishes transcoding) and, because its
            // totalDurationSeconds is the whole file (not the clip), never
            // satisfies the `isCompleted` guard — so the no-progress reaper
            // would kill it ~120s after it finishes, out from under a viewer
            // still looping the artifact, 410'ing that viewer's next segment.
            // The store bounds these (disk budget + LRU eviction via
            // onDrop→stopJob) and refcount-pins any artifact with an attached
            // viewer, so it can safely own teardown. Errored jobs are still
            // reaped above (handleExit's markFailed drops the store entry); a
            // DB-authoritative stop above still wins. See countUserJobs for the
            // same `!outputDir && !cacheKey` cache-backed predicate.
            //
            // Gate on status 'ready' (transcode COMPLETE): only a finished clip
            // exhibits the false-positive (no more FFmpeg progress → reaped).
            // A still-encoding artifact is 'running' here — leave it subject to
            // the progress-heartbeat timeout so a genuinely hung/stalled FFmpeg
            // (e.g. an NFS-wedged source read) is still reaped, not leaked for
            // the life of the pod.
            if ((job.config.cacheKey || job.config.outputDir) && job.status === 'ready') {
                continue;
            }

            // A job mid-seek is spawning a fresh generation that may not have
            // produced progress or served a segment yet (encoder warm-up, GPU
            // contention, cold cache). The seek flow owns its lifecycle — the
            // local inactivity/heartbeat heuristics below must not kill it out
            // from under an in-flight seek. The DB-authoritative stop above still
            // wins because a genuine stop is not a seek.
            if (job.isSeeking) continue;

            // A client that spawned the job (fetched the manifest) but never
            // pulled a single segment leaves FFmpeg writing to disk for the
            // full inactivity/progress timeout — FFmpeg's own progress
            // heartbeats keep progressInactive fresh below, so the checks
            // further down never fire for this case. Reap it much sooner,
            // but only once it has actually produced output (never punish a
            // job that's still starting up) and only via the unwatched-specific
            // grace period.
            //
            // That period is measured from `unwatchedGraceAnchor` (when this
            // job object went live in THIS process), NOT from `startedAt`.
            // `lastServedSegment` is per-process, so a job restored after a
            // rolling deploy always looks unwatched on the restoring pod; using
            // `startedAt` there meant a session older than the timeout was
            // reaped on the very first sweep after its restore — deleting the
            // DB row (persistForRestart=false) and 410'ing every later segment,
            // which is exactly the deploy-kills-the-stream bug this guards.
            if (job.segmentsReady > 0 && job.lastServedSegment.size === 0) {
                const unwatchedTimeout = config.FFMPEG_UNWATCHED_JOB_TIMEOUT_SECONDS * 1000;
                const sinceStart = now - job.unwatchedGraceAnchor.getTime();
                if (sinceStart > unwatchedTimeout) {
                    logger.info('Cleaning up transcode job - never watched', {
                        jobId: job.id,
                        playSessionId,
                        sinceStartSeconds: Math.floor(sinceStart / 1000),
                        jobAgeSeconds: Math.floor((now - job.startedAt.getTime()) / 1000),
                        segmentsReady: job.segmentsReady,
                        timeoutSeconds: config.FFMPEG_UNWATCHED_JOB_TIMEOUT_SECONDS,
                    });
                    jobsToStop.push({
                        playSessionId,
                        jobId,
                        reason: 'never_watched',
                    });
                    continue;
                }
            }

            const segmentInactive = now - job.lastAccessedAt.getTime();
            // A throttled FFmpeg is stopped on purpose, so the absence of its own
            // progress says nothing; while paused the job is exactly as alive as
            // its client (heartbeat here, segment fetch, or a heartbeat another
            // pod wrote to the row). The client-gone arm below still reaps it
            // once the client really is gone.
            const progressInactive =
                now -
                (job.throttledAt
                    ? Math.max(
                          job.lastProgressAt.getTime(),
                          job.lastClientHeartbeatAt.getTime(),
                          job.lastAccessedAt.getTime(),
                          dbClientActivityAt?.get(playSessionId) ?? 0,
                      )
                    : job.lastProgressAt.getTime());
            // Only 'audio-drop' (the -vn audio-only rung) gets the extended
            // retention window in shouldReapJob — every other mode string here
            // (including 'audio-only', which still carries a video stream) is
            // just an opaque "not audio-drop" label to that function.
            const reapMode = job.config.videoDisabled ? 'audio-drop' : 'other';

            // Check if FFmpeg finished remuxing all segments (completed job).
            // Completed jobs have no FFmpeg process running, so progress heartbeat
            // is irrelevant. Only clean up based on segment access inactivity.
            const totalSegments = uniformSegmentCount(
                job.config.totalDurationSeconds ?? 0,
                job.segmentDurationSeconds,
            );
            const isCompleted = totalSegments > 0 && job.segmentsReady >= totalSegments;

            if (isCompleted) {
                // A failed lookup is unknown, not an expired remote client lease.
                // UUID jobs can receive their only heartbeat on another web pod;
                // defer this sweep until persistence can answer. Non-UUID jobs
                // are never queried and retain their existing local-only cleanup.
                // Safety net: once the job has been idle on this pod longer than
                // the ceiling it is reaped anyway, so an outage cannot fill the
                // transcode cache. A job with a live local FFmpeg process is
                // never touched (a completed job normally has none).
                if (dbClientActivityAt === null && UUID_RE.test(playSessionId)) {
                    const localIdleMs =
                        now -
                        Math.max(
                            job.lastProgressAt.getTime(),
                            job.lastAccessedAt.getTime(),
                            job.lastClientHeartbeatAt.getTime(),
                        );
                    if (job.process || localIdleMs <= COMPLETED_JOB_LOOKUP_FAILED_MAX_IDLE_MS) {
                        continue;
                    }
                    logger.info('Cleaning up completed transcode job - idle past ceiling', {
                        jobId: job.id,
                        playSessionId,
                        idleSeconds: Math.floor(localIdleMs / 1000),
                    });
                    jobsToStop.push({ playSessionId, jobId, reason: 'inactivity' });
                    continue;
                }
                // Completed job — all segments on disk, no FFmpeg running.
                // A native heartbeat can reach another web pod. Its persisted
                // lease is just as authoritative here as while still encoding:
                // paused viewers have no segment fetches or encoder progress.
                const completedProgressInactive =
                    now -
                    Math.max(
                        job.lastProgressAt.getTime(),
                        dbClientActivityAt?.get(playSessionId) ?? 0,
                    );
                // Clean up only if BOTH segment requests AND client progress
                // have gone stale, including progress received by another pod.
                if (
                    shouldReapJob({
                        mode: reapMode,
                        completed: true,
                        progressAgeSeconds: completedProgressInactive / 1000,
                        segmentAgeSeconds: segmentInactive / 1000,
                    })
                ) {
                    logger.info('Cleaning up completed transcode job - no activity', {
                        jobId: job.id,
                        playSessionId,
                        segmentInactiveSeconds: Math.floor(segmentInactive / 1000),
                        progressInactiveSeconds: Math.floor(completedProgressInactive / 1000),
                    });
                    jobsToStop.push({
                        playSessionId,
                        jobId,
                        reason: 'inactivity',
                    });
                }
                continue;
            }

            // Client gone while FFmpeg is still encoding. The arms below key off
            // `lastProgressAt`, which FFmpeg's own progress keeps fresh, so on
            // their own they let an abandoned job encode the whole file at full
            // speed until it is stopped. Client activity = a heartbeat to this pod, a segment or
            // playlist fetch, or the row's last_progress_at (a heartbeat the
            // router sent to another pod). Only for sessions whose row we read
            // this sweep: the stop is dormant, so a backgrounded client is
            // restored from that row on its next segment request — without one
            // (persistence skipped or failed) it would get a 410 instead.
            const dbClientActivity = dbClientActivityAt?.get(playSessionId);
            if (dbClientActivity !== undefined) {
                const lastClientActivity = Math.max(
                    job.lastClientHeartbeatAt.getTime(),
                    job.lastAccessedAt.getTime(),
                    dbClientActivity,
                );
                const clientGoneSeconds =
                    reapMode === 'audio-drop'
                        ? config.FFMPEG_AUDIO_DROP_INACTIVITY_TIMEOUT_SECONDS
                        : config.FFMPEG_CLIENT_GONE_TIMEOUT_SECONDS;
                if (now - lastClientActivity > clientGoneSeconds * 1000) {
                    logger.info('Cleaning up transcode job - client gone while encoding', {
                        jobId: job.id,
                        playSessionId,
                        clientIdleSeconds: Math.floor((now - lastClientActivity) / 1000),
                        timeoutSeconds: clientGoneSeconds,
                        segmentsReady: job.segmentsReady,
                    });
                    jobsToStop.push({ playSessionId, jobId, reason: 'client_gone' });
                    continue;
                }
            }

            // Check progress heartbeat timeout (primary - more responsive)
            // Clients send progress every 10s, so 2 min without = definitely stale
            if (
                shouldReapJob({
                    mode: reapMode,
                    completed: false,
                    progressAgeSeconds: progressInactive / 1000,
                    segmentAgeSeconds: segmentInactive / 1000,
                })
            ) {
                logger.info('Cleaning up transcode job - no progress heartbeat', {
                    jobId: job.id,
                    playSessionId,
                    progressInactiveSeconds: Math.floor(progressInactive / 1000),
                    timeoutSeconds: config.FFMPEG_PROGRESS_TIMEOUT_SECONDS,
                });
                jobsToStop.push({
                    playSessionId,
                    jobId,
                    reason: 'no_heartbeat',
                });
                continue;
            }

            // If progress heartbeat is recent, session is active (possibly paused)
            // Don't kill based on segment inactivity alone - user may be paused
            // The progress timeout above will catch truly stale sessions

            // Fallback: check segment access timeout ONLY for clients without progress reporting
            // This is for legacy clients or edge cases where progress isn't sent
            // Both conditions must be met: no segments AND no progress (within a grace period)
            //
            // Mode-aware like the two arms above: at defaults FFMPEG_PROGRESS_TIMEOUT_SECONDS
            // (120s) <= FFMPEG_INACTIVITY_TIMEOUT_SECONDS (300s), so progressGracePeriod
            // normally equals the progress timeout and this arm is only reachable when the
            // arm above already ruled out progressInactive exceeding it —
            // i.e. it adds nothing beyond that arm UNLESS the timeouts diverge.
            // For 'audio-drop' the arm above uses the much larger
            // FFMPEG_AUDIO_DROP_INACTIVITY_TIMEOUT_SECONDS threshold, which
            // reintroduces exactly that divergence — an audio-drop job with
            // progressInactive between the normal and audio-drop thresholds
            // would otherwise reach here and be reaped by the OLD 120s/300s
            // pair, defeating the extended retention window. Both effective
            // timeouts must therefore track the same mode-aware value the
            // arms above use.
            const resolvedTimeouts = resolveTimeouts(reapMode);
            const effectiveProgressTimeout = resolvedTimeouts.progressTimeoutSeconds * 1000;
            const effectiveInactivityTimeout = resolvedTimeouts.inactivityTimeoutSeconds * 1000;
            // This arm's grace period is its OWN formula — Math.min of the two
            // resolved timeouts — and must stay that way. shouldReapJob's
            // completed branch uses the raw progressTimeoutSeconds instead; the
            // two are genuinely different and collapsing them would silently
            // tighten this arm for non-audio-drop jobs under non-default configs.
            const progressGracePeriod = Math.min(
                effectiveProgressTimeout,
                effectiveInactivityTimeout,
            );
            if (
                segmentInactive > effectiveInactivityTimeout &&
                progressInactive > progressGracePeriod
            ) {
                logger.info(
                    'Cleaning up inactive transcode job - no segment requests and stale progress',
                    {
                        jobId: job.id,
                        playSessionId,
                        segmentInactiveSeconds: Math.floor(segmentInactive / 1000),
                        progressInactiveSeconds: Math.floor(progressInactive / 1000),
                        timeoutSeconds: Math.floor(effectiveInactivityTimeout / 1000),
                    },
                );
                jobsToStop.push({ playSessionId, jobId, reason: 'inactivity' });
            }
        }

        // Now stop the collected jobs
        for (const { playSessionId, jobId, reason } of jobsToStop) {
            // Verify the job hasn't been replaced (race condition: new job created for same playSessionId)
            const currentJobId = this.jobsByPlaySession.get(sessionKey(playSessionId));
            if (currentJobId !== jobId) {
                logger.debug('Skipping cleanup - job was replaced', {
                    playSessionId,
                    oldJobId: jobId,
                    newJobId: currentJobId,
                });
                continue;
            }
            // A client that is backgrounded can lose both segment requests and
            // progress heartbeats. Neither is an explicit user/admin stop, so
            // retain the job metadata for recovery after releasing its output.
            const dormant =
                !endedPlaySessions.has(playSessionId) &&
                (reason === 'inactivity' ||
                    reason === 'no_heartbeat' ||
                    reason === 'client_gone' ||
                    reason === 'dormant_in_database');
            const stopped = await this.stopJob(playSessionId, reason, dormant);
            if (dormant && stopped && (await this.ownsSessionOutput(playSessionId))) {
                await this.fileManager.deleteOutputDirectory(
                    this.getSessionOutputDir(playSessionId),
                );
            }
        }

        const previousToRetire: Array<{
            playSessionId: string;
            jobId: string;
        }> = [];
        for (const [playSessionId, session] of this.sessions) {
            for (const retainedJobId of session.retainedJobIds) {
                const retainedJob = this.jobs.get(retainedJobId);
                if (!retainedJob) {
                    session.retainedJobIds = session.retainedJobIds.filter(
                        (jobId) => jobId !== retainedJobId,
                    );
                    this.syncSessionMappings(playSessionId);
                    continue;
                }

                const expired =
                    retainedJob.parked === 'unwatched' && retainedJob.parkedAt
                        ? now - retainedJob.parkedAt.getTime() > PARKED_UNWATCHED_TTL_MS
                        : now - retainedJob.lastAccessedAt.getTime() > previousGenerationTtl;
                if (expired) {
                    previousToRetire.push({
                        playSessionId,
                        jobId: retainedJobId,
                    });
                }
            }
        }

        for (const { playSessionId, jobId } of previousToRetire) {
            const previousJob = this.jobs.get(jobId);
            if (!previousJob) continue;
            // Same pod guard as stopJob: after a takeover the generation and
            // session dirs may be the new owner's restored output.
            await this.retireJobGeneration(previousJob, 'previous_generation_ttl', {
                deleteOutputDir: false,
            });
            if (await this.ownsSessionOutput(playSessionId)) {
                await this.fileManager.deleteOutputDirectory(previousJob.outputDir);
                await this.fileManager.cleanupSessionDirectory(
                    this.getSessionOutputDir(playSessionId),
                );
            } else {
                await this.reclaimOutputLostToAnotherItem(playSessionId, [previousJob]);
            }
        }

        // Also cleanup expired jobs from database
        try {
            const deletedJobs = await this.persistence.cleanupExpiredJobs(
                config.FFMPEG_INACTIVITY_TIMEOUT_SECONDS,
                config.FFMPEG_PROGRESS_TIMEOUT_SECONDS,
            );
            if (deletedJobs.length > 0) {
                logger.info('Cleaned up expired jobs from database', {
                    count: deletedJobs.length,
                });

                // Clean up output directories for deleted jobs
                // Safe in multi-replica: each pod cleans up directories from shared storage
                for (const job of deletedJobs) {
                    // active_transcode_jobs is NOT exclusively ours: the music
                    // transcode service persists rows into the same table whose
                    // output_dir is a shared CACHE SHARD (one directory holding
                    // 1/256 of the whole music cache), not a per-session dir.
                    // deleteOutputDirectory is a recursive rm, so deleting one
                    // of those on TTL expiry would wipe cached audio other
                    // listeners are still streaming — and any .partial being
                    // written into that shard. Only ever remove directories that
                    // live under OUR transcode root; everything else belongs to
                    // a subsystem that owns its own eviction policy.
                    if (!isPathInsideDirectory(job.output_dir, config.FFMPEG_TRANSCODE_DIR)) {
                        logger.debug('Skipping output-dir removal — not under the transcode root', {
                            playSessionId: job.play_session_id,
                            outputDir: job.output_dir,
                        });
                        continue;
                    }
                    await this.fileManager.deleteOutputDirectory(job.output_dir);
                    logger.debug('Removed output directory for expired job', {
                        playSessionId: job.play_session_id,
                        outputDir: job.output_dir,
                    });
                }
            }
        } catch (err) {
            logger.warn('Failed to cleanup expired jobs from database', {
                error: String(err),
            });
            // Non-fatal
        }
    }

    // ========================================================================
    // I-Frame Analysis (for Apple TV scrubbing)
    // ========================================================================

    /**
     * Reset I-frame analysis data (called when seeking).
     * Clears existing data and restarts analysis from new position.
     */
    resetIFrameAnalysis(job: TranscodeJob): void {
        job.iframeData = [];
        job.iframeAnalyzedCount = 0;
        job.iframeAnalysisComplete = false;

        // Restart analysis worker if not Jellyfin transcoded
        if (!job.config.isJellyfinTranscoded) {
            this.iframeAnalyzer.startAnalysis(job);
        }
    }

    /**
     * Run segment cleanup for all active jobs
     */
    private async cleanupOldSegmentsForAllJobs(): Promise<void> {
        if (this.isShuttingDown) return;

        for (const job of this.jobs.values()) {
            if (job.generationRole !== 'current') continue;
            // Cache-backed jobs (config.outputDir set) write into a shared
            // preview-cache artifact other viewers may still be reading from
            // (including re-hover/loop-back to early segments) — never prune
            // its segments here. The artifact's own lifecycle (budget
            // eviction / markFailed) is what deletes it, not this sweep.
            if (job.config.outputDir) continue;
            // Include 'stopped' status (FFmpeg finished but segments still being served)
            // Exclude 'error' status (job failed, will be cleaned up by inactivity timeout)
            if (job.status === 'ready' || job.status === 'running' || job.status === 'stopped') {
                await this.fileManager.slidingWindowCleanup(job);
            }
        }
    }

    /**
     * Publish CPU/RAM resource stats for all running jobs to Valkey.
     * Runs on a 10s interval so the web container can display stats for jobs
     * on this worker pod without requiring database writes.
     */
    /**
     * Flush live HLS progress (segments_ready / master_playlist_ready) to the
     * DB for every local job that owns its session's row.
     *
     * The authoritative segment counter lives ONLY in memory (job.segmentsReady,
     * advanced from FFmpeg stderr in the process runner). The DB column
     * active_transcode_jobs.segments_ready is written once at job creation (0)
     * and the upsert's ON CONFLICT clause never advances it. So when a
     * transcode-progress read is served by a pod/instance that does not hold the
     * in-memory job — the getAllActiveJobsInfoMultiPod fallback used by
     * getPlayerTranscodeProgressMultiPod (`memJob?.segmentsReady ??
     * dbJob.segments_ready`) — it would otherwise report a permanent 0% (with a
     * correct totalSegments + climbing elapsed) while playback works fine. This
     * happens on multi-pod/blue-green routing and after the local job is reaped
     * while a long-lived (e.g. Safari native-HLS) session keeps playing from
     * already-produced segments on disk.
     *
     * Mirroring publishResourceStats, we flush the counter every ~10s so the
     * cross-pod DB fallback stays accurate. persistence.updateProgress is a
     * no-op for non-persistable (non-UUID) sessions, so preview-cache jobs are
     * additionally skipped below to avoid needless writes.
     */
    private async persistJobProgress(): Promise<void> {
        if (this.isShuttingDown) return;
        for (const job of this.jobs.values()) {
            // Only the current generation owns the session's active_transcode_jobs
            // row (upsert key = play_session_id). Skip retired generations,
            // terminal jobs, and preview-cache artifacts (synthetic sessions).
            if (
                job.generationRole !== 'current' ||
                job.status === 'error' ||
                job.status === 'stopped' ||
                job.status === 'stopping' ||
                job.config.outputDir ||
                job.config.cacheKey
            ) {
                continue;
            }
            await this.persistence.updateProgress(
                job.config.playSessionId,
                job.segmentsReady,
                job.masterPlaylistReady,
                getCurrentPodName(),
            );
        }
    }

    private async publishResourceStats(): Promise<void> {
        if (this.isShuttingDown) return;

        // Collect jobs that have a live process
        const jobsWithPids: { job: TranscodeJob; pid: number }[] = [];
        for (const job of this.jobs.values()) {
            if (
                job.process?.pid &&
                !job.process.killed &&
                (job.status === 'running' || job.status === 'ready')
            ) {
                jobsWithPids.push({ job, pid: job.process.pid });
            }
        }

        if (jobsWithPids.length === 0) return;

        // Get GPU usage once (shared resource)
        const gpuVideoUsage =
            config.GPU_ACCELERATION === 'qsv' || config.GPU_ACCELERATION === 'vaapi'
                ? await getIntelGpuVideoUsage()
                : undefined;

        await Promise.all(
            jobsWithPids.map(async ({ job, pid }) => {
                const resources = await getProcessResourceUsage(pid);
                await publishJobStats(job.id, {
                    cpuPercent: resources.cpuPercent,
                    memoryMB: resources.memoryMB,
                    gpuVideoPercent: gpuVideoUsage,
                    transcodeFps: job.transcodeFps,
                    transcodeSpeed: job.transcodeSpeed,
                    throttled: job.throttledAt !== undefined,
                    bufferAheadSeconds: bufferAheadSeconds(job),
                    slowReason: slowTranscodeReason(job, Date.now()),
                    softwareFallbackFrom: job.config.softwareEncodeFallback,
                });
            }),
        );
    }

    /**
     * Count active jobs for a user
     *
     * Cache-backed jobs (config.outputDir/cacheKey set — preview-cache-*
     * artifacts) are excluded: they're already bounded by the
     * PreviewCacheStore disk budget + PREVIEW_MAX_GLOBAL admission, are
     * unevictable (shared across viewers), and can linger `status='ready'`
     * until the ~300s inactivity reaper. Counting them here would let a few
     * hover-warms starve real playback of its per-user transcode slots.
     */
    private countUserJobs(username: string): number {
        const playSessions = new Set<string>();
        for (const job of this.jobs.values()) {
            if (
                job.config.username === username &&
                job.generationRole === 'current' &&
                job.status !== 'error' &&
                job.status !== 'stopped' &&
                job.status !== 'stopping' &&
                !job.config.outputDir &&
                !job.config.cacheKey
            ) {
                playSessions.add(job.config.playSessionId);
            }
        }
        return playSessions.size;
    }

    /**
     * Count active transcode jobs across all users (server-wide).
     * Mirrors countUserJobs but without the username filter, used to
     * enforce LUMASTRA_MAX_CONCURRENT_TRANSCODES.
     *
     * Cache-backed jobs are excluded for the same reason as in
     * countUserJobs — see that doc comment.
     */
    private countGlobalJobs(): number {
        const playSessions = new Set<string>();
        for (const job of this.jobs.values()) {
            if (
                job.generationRole === 'current' &&
                job.status !== 'error' &&
                job.status !== 'stopped' &&
                job.status !== 'stopping' &&
                !job.config.outputDir &&
                !job.config.cacheKey
            ) {
                playSessions.add(job.config.playSessionId);
            }
        }
        return playSessions.size;
    }

    /**
     * Count preview-cache artifacts (config.cacheKey) that are CURRENTLY
     * encoding on the GPU — i.e. actively holding a hardware encode session.
     * Only `running`/`starting` count: a completed preview's FFmpeg has already
     * exited and no longer occupies the GPU (even while its job lingers `ready`
     * until the store evicts it). Used to bound concurrent GPU previews so they
     * can't starve real playback of encode sessions (see PREVIEW_MAX_GPU_JOBS).
     */
    countActiveGpuPreviewJobs(): number {
        let count = 0;
        for (const job of this.jobs.values()) {
            if (
                job.config.cacheKey &&
                job.transcodeDecisionResult?.useGpu &&
                (job.status === 'running' || job.status === 'starting')
            ) {
                count++;
            }
        }
        return count;
    }

    /**
     * Get information about ALL active FFmpeg jobs across all pods (multi-pod compatible).
     * Queries database for all jobs, enriches with in-memory stats for jobs on this pod.
     * Use this for admin display in Kubernetes multi-replica deployments.
     */
    async getAllActiveJobsInfoMultiPod(): Promise<FFmpegJobInfo[]> {
        const jobs: FFmpegJobInfo[] = [];
        const now = Date.now();
        const currentPodName = getCurrentPodName();

        try {
            // Get all active jobs from database (all pods)
            const dbJobs = await this.persistence.getAllActiveJobs();

            logger.debug('Retrieved active jobs from database for admin display', {
                count: dbJobs.length,
                currentPod: currentPodName,
            });

            // Track PIDs for resource usage queries (only for jobs on this pod)
            const jobsWithPids: { jobInfo: FFmpegJobInfo; pid?: number }[] = [];

            for (const dbJob of dbJobs) {
                // Try to find job in memory (if it's on this pod)
                const memJob = this.getJob(dbJob.play_session_id);

                // A copy-mode job runs on 10 s segments (keyframe cadence), so the
                // global setting is only the last resort: a job owned by another pod
                // still carries its own length in the persisted config.
                const segmentDuration =
                    memJob?.segmentDurationSeconds ??
                    dbJob.config.segmentDurationSeconds ??
                    config.FFMPEG_SEGMENT_DURATION;
                const totalDuration = dbJob.config.totalDurationSeconds || 0;

                // Calculate progress from DB data (or memory if available)
                const segmentsReady = memJob?.segmentsReady ?? dbJob.segments_ready;
                const segmentOffset = memJob?.segmentOffset ?? dbJob.segment_offset;
                const estimatedProgressSeconds = (segmentOffset + segmentsReady) * segmentDuration;
                const progressPercent =
                    totalDuration > 0
                        ? Math.min(
                              100,
                              Math.round((estimatedProgressSeconds / totalDuration) * 100),
                          )
                        : 0;

                // Timing calculations
                const startedAtMs = dbJob.created_at.getTime();
                const elapsedSeconds = Math.floor((now - startedAtMs) / 1000);
                const lastAccessedAtMs = dbJob.last_accessed_at.getTime();
                const lastProgressAtMs = dbJob.last_progress_at.getTime();

                // An audiobook remux has no transcode_decision by design (there is
                // no video stream to describe an action for), so it must be
                // recognised BEFORE the decision-based classifier — otherwise it
                // falls through 'unknown' into the caller's 'full' fallback and
                // renders as a full video transcode.
                const transcodeType =
                    jobConfigKind(dbJob.config) === 'audiobook'
                        ? 'audiobook-remux'
                        : dbJob.transcode_decision
                          ? classifyTranscodeType(
                                dbJob.transcode_decision.videoAction,
                                dbJob.transcode_decision.audioAction,
                                dbJob.transcode_decision.needsTonemapping,
                                dbJob.config.videoDisabled,
                            )
                          : 'unknown';

                // Calculate bitrates
                const sourceBitrate = dbJob.config.mediaSourceInfo?.bitrate;

                const jobInfo: FFmpegJobInfo = {
                    jobId: dbJob.job_id,
                    playSessionId: dbJob.play_session_id,
                    itemId: dbJob.item_id,
                    username: dbJob.user_id,
                    deviceId: dbJob.device_id,
                    status: dbJob.status as TranscodeJob['status'],
                    mode: transcodeType === 'unknown' ? 'full' : transcodeType,
                    error: dbJob.error_message ?? undefined,

                    // Timing
                    startedAt: dbJob.created_at.toISOString(),
                    elapsedSeconds,
                    lastAccessedAt: dbJob.last_accessed_at.toISOString(),
                    lastAccessedSecondsAgo: Math.floor((now - lastAccessedAtMs) / 1000),
                    lastProgressAt: dbJob.last_progress_at.toISOString(),
                    lastProgressSecondsAgo: Math.floor((now - lastProgressAtMs) / 1000),

                    // Progress
                    segmentsReady,
                    segmentOffset,
                    totalSegments: uniformSegmentCount(totalDuration, segmentDuration),
                    segmentDurationSeconds: segmentDuration,
                    progressPercent,
                    masterPlaylistReady: memJob?.masterPlaylistReady ?? dbJob.master_playlist_ready,
                    isSeeking: memJob?.isSeeking ?? false,
                    seekCount: memJob?.seekCount ?? 0,

                    // Video info
                    videoCodec: dbJob.config.videoInfo?.codec,
                    videoOutputCodec: dbJob.config.videoInfo?.outputCodec,
                    resolution: dbJob.config.videoInfo
                        ? `${dbJob.config.videoInfo.width}x${dbJob.config.videoInfo.height}`
                        : undefined,
                    videoRange:
                        dbJob.config.videoInfo?.videoRangeType ||
                        dbJob.config.videoInfo?.videoRange,

                    // Audio info
                    audioTrackCount: dbJob.config.audioTracks?.length ?? 0,
                    audioTracks: (dbJob.config.audioTracks ?? []).map((t) => ({
                        index: t.index,
                        language: t.language,
                        codec: t.codec,
                        channels: t.channels,
                        displayTitle: t.displayTitle,
                    })),

                    // Subtitle info
                    subtitleTrackCount: dbJob.config.subtitleTracks?.length || 0,
                    subtitles: (dbJob.config.subtitleTracks || []).map((t) => ({
                        index: t.index,
                        language: t.language,
                        codec: t.codec,
                        displayTitle: t.displayTitle,
                    })),

                    // Transcode decision
                    transcodeDecision: dbJob.transcode_decision
                        ? {
                              videoAction: dbJob.transcode_decision.videoAction,
                              audioAction: dbJob.transcode_decision.audioAction,
                              useGpu: dbJob.transcode_decision.useGpu,
                              gpuEncoder: dbJob.transcode_decision.gpuEncoder,
                              gpuDecoder: dbJob.transcode_decision.gpuDecoder,
                              needsTonemapping: dbJob.transcode_decision.needsTonemapping,
                              hdrTonemapMode: dbJob.transcode_decision.hdrTonemapMode,
                              tonemappingAlgorithm: dbJob.transcode_decision.tonemappingAlgorithm,
                          }
                        : undefined,

                    // Process info (only accurate for jobs on this pod)
                    processRunning: memJob
                        ? memJob.process !== null && !memJob.process.killed
                        : dbJob.status === 'running' || dbJob.status === 'ready',
                    processPid: memJob?.process?.pid ?? dbJob.ffmpeg_pid ?? undefined,

                    // Bitrates
                    sourceBitrateMbps: sourceBitrate
                        ? Math.round((sourceBitrate / 1_000_000) * 10) / 10
                        : undefined,
                    targetBitrateMbps: undefined,

                    // Transcode type
                    transcodeType,

                    // Source file path
                    sourceFilePath:
                        dbJob.config.localFilePath || dbJob.config.inputUrl || undefined,

                    // Output directory
                    outputDir: dbJob.output_dir,

                    // Pod name (for multi-pod visibility)
                    podName: dbJob.pod_name ?? undefined,

                    slowReason: memJob ? slowTranscodeReason(memJob, now) : undefined,
                    softwareFallbackFrom:
                        memJob?.config.softwareEncodeFallback ??
                        dbJob.config.softwareEncodeFallback,
                };

                // Track for resource usage query if job is on this pod,
                // otherwise read transient stats from Valkey (written by worker pod)
                if (memJob?.process?.pid) {
                    jobsWithPids.push({ jobInfo, pid: memJob.process.pid });
                } else {
                    jobs.push(jobInfo);
                }
            }

            // Enrich cross-pod jobs with Valkey stats (written by the worker pod)
            await Promise.all(
                jobs.map(async (jobInfo) => {
                    const cached = await readJobStats(jobInfo.jobId);
                    if (cached) {
                        jobInfo.cpuPercent = cached.cpuPercent;
                        jobInfo.memoryMB = cached.memoryMB;
                        if (cached.gpuVideoPercent !== undefined) {
                            jobInfo.gpuVideoPercent = cached.gpuVideoPercent;
                        }
                        // A resident job's own values are fresher than the stats.
                        if (!this.getJob(jobInfo.playSessionId)) {
                            jobInfo.slowReason = cached.slowReason;
                            jobInfo.softwareFallbackFrom = cached.softwareFallbackFrom;
                        }
                    }
                }),
            );

            // Get resource usage for processes on this pod
            const [, gpuVideoUsage] = await Promise.all([
                Promise.all(
                    jobsWithPids.map(async ({ jobInfo, pid }) => {
                        if (pid && jobInfo.processRunning) {
                            const resources = await getProcessResourceUsage(pid);
                            jobInfo.cpuPercent = resources.cpuPercent;
                            jobInfo.memoryMB = resources.memoryMB;
                        }
                        jobs.push(jobInfo);
                    }),
                ),
                // Get Intel GPU video engine usage (only if QSV/VAAPI configured and jobs exist)
                jobsWithPids.length > 0 &&
                (config.GPU_ACCELERATION === 'qsv' || config.GPU_ACCELERATION === 'vaapi')
                    ? getIntelGpuVideoUsage()
                    : Promise.resolve(undefined),
            ]);

            // Apply GPU video usage to jobs on this pod
            if (gpuVideoUsage !== undefined && currentPodName) {
                for (const job of jobs) {
                    if (job.podName === currentPodName) {
                        job.gpuVideoPercent = gpuVideoUsage;
                    }
                }
            }

            // Sort by startedAt (newest first)
            jobs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

            return jobs;
        } catch (error) {
            logger.error('Failed to get all active jobs for multi-pod display', error as Error);
            // Fallback to in-memory jobs only
            return this.getActiveJobsInfo();
        }
    }

    /**
     * Get information about all active FFmpeg jobs for admin display.
     * Returns a serializable object (no process references, Maps converted to objects).
     * Includes CPU/memory resource usage when available.
     *
     * NOTE: In multi-pod setups, this only shows jobs on the current pod.
     * Use getAllActiveJobsInfoMultiPod() for cluster-wide view.
     */
    async getActiveJobsInfo(): Promise<FFmpegJobInfo[]> {
        const jobs: FFmpegJobInfo[] = [];

        // Collect job info and PIDs for resource queries
        const jobsWithPids: { jobInfo: FFmpegJobInfo; pid?: number }[] = [];

        for (const job of this.jobs.values()) {
            const now = Date.now();
            const startedAtMs = job.startedAt.getTime();
            const lastAccessedAtMs = job.lastAccessedAt.getTime();
            const lastProgressAtMs = job.lastProgressAt.getTime();

            // Calculate duration and progress
            const elapsedSeconds = Math.floor((now - startedAtMs) / 1000);
            const totalDuration = job.config.totalDurationSeconds || 0;
            const segmentDuration = job.segmentDurationSeconds;
            const estimatedProgressSeconds =
                (job.segmentOffset + job.segmentsReady) * segmentDuration;
            const progressPercent =
                totalDuration > 0
                    ? Math.min(100, Math.round((estimatedProgressSeconds / totalDuration) * 100))
                    : 0;

            const transcodeType = job.transcodeDecisionResult
                ? classifyTranscodeType(
                      job.transcodeDecisionResult.videoAction,
                      job.transcodeDecisionResult.audioAction,
                      job.transcodeDecisionResult.needsTonemapping,
                      job.config.videoDisabled,
                  )
                : 'unknown';

            const mode = transcodeType === 'unknown' ? 'full' : transcodeType;

            // Calculate bitrates (convert from bps to Mbps)
            const sourceBitrate = job.config.mediaSourceInfo?.bitrate;

            const jobInfo: FFmpegJobInfo = {
                jobId: job.id,
                playSessionId: job.config.playSessionId,
                itemId: job.config.itemId,
                username: job.config.username,
                deviceId: job.config.deviceId,
                status: job.status,
                mode,
                error: job.error,

                // Timing
                startedAt: job.startedAt.toISOString(),
                elapsedSeconds,
                lastAccessedAt: job.lastAccessedAt.toISOString(),
                lastAccessedSecondsAgo: Math.floor((now - lastAccessedAtMs) / 1000),
                lastProgressAt: job.lastProgressAt.toISOString(),
                lastProgressSecondsAgo: Math.floor((now - lastProgressAtMs) / 1000),

                // Progress
                segmentsReady: job.segmentsReady,
                segmentOffset: job.segmentOffset,
                totalSegments: uniformSegmentCount(totalDuration, segmentDuration),
                segmentDurationSeconds: segmentDuration,
                progressPercent,
                masterPlaylistReady: job.masterPlaylistReady,
                isSeeking: job.isSeeking,
                seekCount: job.seekCount,

                // Video info
                videoCodec: job.config.videoInfo?.codec,
                videoOutputCodec: job.config.videoInfo?.outputCodec,
                resolution: job.config.videoInfo
                    ? `${job.config.videoInfo.width}x${job.config.videoInfo.height}`
                    : undefined,
                videoRange:
                    job.config.videoInfo?.videoRangeType || job.config.videoInfo?.videoRange,

                // Audio info
                audioTrackCount: job.config.audioTracks?.length ?? 0,
                audioTracks: (job.config.audioTracks ?? []).map((t) => ({
                    index: t.index,
                    language: t.language,
                    codec: t.codec,
                    channels: t.channels,
                    displayTitle: t.displayTitle,
                })),

                // Subtitle info
                subtitleTrackCount: job.config.subtitleTracks?.length ?? 0,
                subtitles: (job.config.subtitleTracks ?? []).map((t) => ({
                    index: t.index,
                    language: t.language,
                    codec: t.codec,
                    displayTitle: t.displayTitle,
                })),

                // Transcode decision (if full mode)
                transcodeDecision: job.transcodeDecisionResult
                    ? {
                          videoAction: job.transcodeDecisionResult.videoAction,
                          audioAction: job.transcodeDecisionResult.audioAction,
                          useGpu: job.transcodeDecisionResult.useGpu,
                          gpuEncoder: job.transcodeDecisionResult.gpuEncoder,
                          gpuDecoder: job.transcodeDecisionResult.gpuDecoder,
                          needsTonemapping: job.transcodeDecisionResult.needsTonemapping,
                          hdrTonemapMode: job.transcodeDecisionResult.hdrTonemapMode,
                          tonemappingAlgorithm: job.transcodeDecisionResult.tonemappingAlgorithm,
                      }
                    : undefined,

                // Process info
                processRunning: job.process !== null && !job.process.killed,
                processPid: job.process?.pid,

                // Bitrates
                sourceBitrateMbps: sourceBitrate
                    ? Math.round((sourceBitrate / 1_000_000) * 10) / 10
                    : undefined,
                targetBitrateMbps: undefined,

                // Transcode type
                transcodeType,

                // Source file path
                sourceFilePath: job.config.localFilePath || job.config.inputUrl || undefined,

                // Output directory
                outputDir: job.outputDir,

                slowReason: slowTranscodeReason(job, now),
                softwareFallbackFrom: job.config.softwareEncodeFallback,
            };

            jobsWithPids.push({ jobInfo, pid: job.process?.pid });
        }

        // Get resource usage for all running processes in parallel
        // Also get Intel GPU video engine usage once (shared across all jobs)
        const [, gpuVideoUsage] = await Promise.all([
            Promise.all(
                jobsWithPids.map(async ({ jobInfo, pid }) => {
                    if (pid && jobInfo.processRunning) {
                        const resources = await getProcessResourceUsage(pid);
                        jobInfo.cpuPercent = resources.cpuPercent;
                        jobInfo.memoryMB = resources.memoryMB;
                    }
                    jobs.push(jobInfo);
                }),
            ),
            // Get Intel GPU video engine usage (only if QSV/VAAPI configured and jobs exist)
            jobsWithPids.length > 0 &&
            (config.GPU_ACCELERATION === 'qsv' || config.GPU_ACCELERATION === 'vaapi')
                ? getIntelGpuVideoUsage()
                : Promise.resolve(undefined),
        ]);

        // Apply GPU video usage to all jobs (it's a shared resource)
        if (gpuVideoUsage !== undefined) {
            for (const job of jobs) {
                job.gpuVideoPercent = gpuVideoUsage;
            }
        }

        // Sort by startedAt (newest first)
        jobs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

        return jobs;
    }

    /** Live video encodes only; persisted sessions can outlive their encoder. */
    private playbackCpuCounts(): PlaybackCounts {
        return countPlaybackTranscodes(this.jobs.values());
    }

    /** Get count of active jobs. */
    getActiveJobCount(): number {
        return this.jobs.size;
    }
}

// ============================================================================
// Keyframe-Based Segment Computation
// ============================================================================

/**
 * Compute segment durations from keyframe PTS data, matching FFmpeg's copy-mode
 * segment boundaries. Port of Jellyfin's ComputeSegments algorithm.
 *
 * FFmpeg in copy mode can only split at keyframes. Given a target segment duration
 * (e.g., 10s), FFmpeg advances through the stream and cuts at the first keyframe
 * at or past each target boundary. This produces variable-length segments
 * (e.g., 10.177s, 9.843s, 10.344s).
 *
 * This function replicates that logic so the VOD playlist has accurate EXTINF
 * durations matching what FFmpeg actually produces. Without this, synthetic
 * uniform durations drift cumulatively and hls.js computes wrong segment
 * numbers on seek.
 *
 * @param keyframes - Sorted PTS values in seconds from ffprobe
 * @param totalDuration - Total media duration in seconds
 * @param desiredSegmentLength - Target segment duration in seconds (e.g., 10)
 * @returns Array of per-segment durations in seconds
 */
export function computeSegmentsFromKeyframes(
    keyframes: number[],
    totalDuration: number,
    desiredSegmentLength: number,
): number[] {
    if (keyframes.length === 0 || totalDuration <= 0 || desiredSegmentLength <= 0) {
        return [];
    }

    const result: number[] = [];
    let lastCut = 0;
    let desiredCutPoint = desiredSegmentLength;

    for (const keyframe of keyframes) {
        if (keyframe >= desiredCutPoint) {
            const segmentDuration = keyframe - lastCut;
            result.push(segmentDuration);
            lastCut = keyframe;
            // Advance on absolute grid, not relative to last cut.
            // Jellyfin: desiredCutTime += desiredSegmentLengthTicks
            // This prevents a single long GOP from shifting all subsequent boundaries.
            desiredCutPoint += desiredSegmentLength;
        }
    }

    // Final segment: from last cut to end of media
    const remainder = totalDuration - lastCut;
    if (remainder > 0.001) {
        result.push(remainder);
    }

    return result;
}

/**
 * Compute segment durations accounting for a mid-stream seek.
 *
 * After a seek to `seekStartTime`, FFmpeg restarts with a grid anchored at the
 * seek position (due to `-start_at_zero`).  Segments before the seek use the
 * position-0 grid; segments from the seek point onward use the post-seek grid.
 *
 * This produces EXTINF values that match what FFmpeg actually outputs after the
 * seek, preventing cumulative drift between Safari's EXTINF-derived currentTime
 * and the real content PTS — which was the root cause of PGS subtitle desync.
 */
export function computeSegmentsWithSeekGrid(
    keyframes: number[],
    totalDuration: number,
    desiredSegmentLength: number,
    seekStartTime: number,
): number[] {
    if (keyframes.length === 0 || totalDuration <= 0 || desiredSegmentLength <= 0) {
        return [];
    }

    if (seekStartTime <= 0) {
        return computeSegmentsFromKeyframes(keyframes, totalDuration, desiredSegmentLength);
    }

    // 1. Compute the full position-0 grid (for segments before the seek)
    const fullGridDurations = computeSegmentsFromKeyframes(
        keyframes,
        totalDuration,
        desiredSegmentLength,
    );

    // 2. Find which segment the seek falls in
    let cumulative = 0;
    let seekSegmentIndex = fullGridDurations.length;
    for (let i = 0; i < fullGridDurations.length; i++) {
        cumulative += fullGridDurations[i];
        if (seekStartTime < cumulative - 0.001) {
            seekSegmentIndex = i;
            break;
        }
    }

    if (seekSegmentIndex >= fullGridDurations.length) {
        return fullGridDurations;
    }

    // 3. Keep segments 0..seekSegmentIndex-1 from the position-0 grid
    const result = fullGridDurations.slice(0, seekSegmentIndex);

    // 4. Compute the post-seek grid for segments from seekSegmentIndex onward.
    //    FFmpeg sees keyframes shifted by -seekStartTime with an absolute grid
    //    anchored at 0 (due to -start_at_zero).  The exact seek position is
    //    the start of the keyframe segment (the cumulative duration up to
    //    seekSegmentIndex), which is the nearest keyframe boundary.
    const segmentStartTime = result.reduce((s, d) => s + d, 0);
    const shiftedKeyframes: number[] = [];
    for (const kf of keyframes) {
        if (kf >= segmentStartTime - 0.001) {
            shiftedKeyframes.push(kf - segmentStartTime);
        }
    }

    const remainingDuration = totalDuration - segmentStartTime;
    if (remainingDuration <= 0.001 || shiftedKeyframes.length === 0) {
        return fullGridDurations;
    }

    const postSeekDurations = computeSegmentsFromKeyframes(
        shiftedKeyframes,
        remainingDuration,
        desiredSegmentLength,
    );

    result.push(...postSeekDurations);
    return result;
}

/**
 * Align an arbitrary requested time to the start of the keyframe-derived
 * video segment that actually contains it. This keeps audio transcode startup
 * aligned with copied video, which can only begin on the preceding keyframe.
 */
export function alignToKeyframeSegmentStart(
    requestedTimeSeconds: number,
    keyframes: number[],
    totalDuration: number,
    desiredSegmentLength: number,
): number {
    const KEYFRAME_BOUNDARY_TOLERANCE_SECONDS = 0.001;
    // Jellyfin offsets HLS remux seeks by 0.5s because FFmpeg can otherwise
    // choose the previous keyframe when the input seek time is exactly a
    // keyframe. With -noaccurate_seek, this still keeps the desired boundary
    // keyframe while avoiding a one-GOP rewind.
    const KEYFRAME_SEEK_OFFSET_SECONDS = 0.5;

    if (
        requestedTimeSeconds <= 0 ||
        keyframes.length === 0 ||
        totalDuration <= 0 ||
        desiredSegmentLength <= 0
    ) {
        return Math.max(0, requestedTimeSeconds);
    }

    const durations = computeSegmentsFromKeyframes(keyframes, totalDuration, desiredSegmentLength);

    let cumulative = 0;
    for (let i = 0; i < durations.length; i++) {
        const segmentStart = cumulative;
        const segmentEnd = segmentStart + (durations[i] ?? 0);
        // A time at or past the end belongs to the LAST segment. Falling through
        // used to return `totalDuration` itself — a start past every segment, which
        // wedged the copy session (finished movie resumed at 420.08 s of 420.021 s,
        // reverse-proxy e2e 2026-10-06).
        const isLast = i === durations.length - 1;
        if (isLast || requestedTimeSeconds < segmentEnd - KEYFRAME_BOUNDARY_TOLERANCE_SECONDS) {
            return Math.min(
                segmentStart + KEYFRAME_SEEK_OFFSET_SECONDS,
                Math.max(segmentStart, segmentEnd - KEYFRAME_BOUNDARY_TOLERANCE_SECONDS),
            );
        }
        cumulative = segmentEnd;
    }

    return Math.max(0, Math.min(requestedTimeSeconds, totalDuration));
}

export function getKeyframeSegmentStartTime(
    segmentIndex: number,
    keyframes: number[],
    totalDuration: number,
    desiredSegmentLength: number,
): number {
    if (
        segmentIndex <= 0 ||
        keyframes.length === 0 ||
        totalDuration <= 0 ||
        desiredSegmentLength <= 0
    ) {
        return 0;
    }

    const durations = computeSegmentsFromKeyframes(keyframes, totalDuration, desiredSegmentLength);

    const boundedIndex = Math.min(segmentIndex, durations.length);
    let cumulative = 0;
    for (let i = 0; i < boundedIndex; i++) {
        cumulative += durations[i] ?? 0;
    }

    return Math.max(0, Math.min(cumulative, totalDuration));
}

export function getKeyframeSegmentIndexForTime(
    timeSeconds: number,
    keyframes: number[],
    totalDuration: number,
    desiredSegmentLength: number,
): number {
    if (
        timeSeconds <= 0 ||
        keyframes.length === 0 ||
        totalDuration <= 0 ||
        desiredSegmentLength <= 0
    ) {
        return 0;
    }

    const durations = computeSegmentsFromKeyframes(keyframes, totalDuration, desiredSegmentLength);

    let cumulative = 0;
    for (let i = 0; i < durations.length; i++) {
        cumulative += durations[i];
        if (timeSeconds < cumulative) {
            return i;
        }
    }

    return Math.max(0, durations.length - 1);
}

/**
 * Index of the last keyframe FFmpeg file a copy-mode generation starting at
 * `startTimeSeconds` writes, relative to that generation's first file. The
 * demux video playlist has one entry per uniform step, which can be one more
 * than the keyframe files FFmpeg actually cuts; the segment handler clamps to
 * this so the tail entry is still served.
 */
export function getLastKeyframeFileIndex(
    startTimeSeconds: number,
    keyframes: number[],
    totalDuration: number,
    desiredSegmentLength: number,
): number {
    const fileCount = computeSegmentsFromKeyframes(
        keyframes,
        totalDuration,
        desiredSegmentLength,
    ).length;
    const startFile = getKeyframeSegmentIndexForTime(
        startTimeSeconds,
        keyframes,
        totalDuration,
        desiredSegmentLength,
    );
    return Math.max(0, fileCount - 1 - startFile);
}

// ============================================================================
// Singleton Instance
// ============================================================================

let instance: FFmpegTranscodeService | null = null;

/**
 * Get the FFmpeg transcode service singleton
 */
export function getFFmpegTranscodeService(): FFmpegTranscodeService {
    if (!instance) {
        instance = new FFmpegTranscodeService();
    }
    return instance;
}

/**
 * Shutdown the FFmpeg transcode service
 */
export async function shutdownFFmpegTranscodeService(): Promise<void> {
    if (instance) {
        await instance.shutdown();
        instance = null;
    }
}
