// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Display math for the player's transcode-progress badge and the FPS badge,
 * kept out of PlayerOverlay.svelte so it can be unit tested.
 */

import type { PlayerState } from './playerStore.svelte';

type TranscodeProgress = NonNullable<PlayerState['transcodeProgress']>;

/**
 * Whether the encoder has nothing left to do: it reached the end of the file
 * and is not merely paused by the throttle. Not the same as 100 %: after a
 * seek ahead the encoder finishes with the skipped part never transcoded, so
 * coverage stays below 100 for good. Servers without `encoderPercent` fall
 * back to the percentage.
 */
export function isTranscodeFinished(progress: {
    progressPercent: number;
    encoderPercent?: number;
    throttled?: boolean;
}): boolean {
    if (progress.throttled) return false;
    return (progress.encoderPercent ?? progress.progressPercent) >= 100;
}

/**
 * - `paused`: the server's throttle stopped FFmpeg because it is far enough
 *   ahead of the player — nothing to worry about.
 * - `slow`: FFmpeg runs below realtime, so playback may have to wait for it.
 * - `complete`: the encoder reached the end of the file (see
 *   {@link isTranscodeFinished}); `percent` says how much of it was covered.
 */
export type TranscodeProgressState = 'running' | 'slow' | 'paused' | 'complete';

export interface TranscodeProgressView {
    state: TranscodeProgressState;
    percent: number;
    segmentsReady: number;
    totalSegments: number;
    /** Transcoded parts of the file, in % — what the progress bar draws. */
    ranges: { start: number; end: number }[];
    /** Where the encoder is, in % — the bar's marker. Undefined once complete. */
    encoderPercent?: number;
    elapsedSeconds: number;
    /** Undefined while paused, once complete, or without a speed reading. */
    etaSeconds?: number;
    aheadSeconds?: number;
}

/** Below this FFmpeg speed the transcode falls behind playback. */
const SLOW_SPEED = 0.9;

/**
 * `now` is the caller's clock tick: elapsed and ETA advance between polls
 * from the reading's `receivedAt` instead of freezing until the next one.
 */
export function buildTranscodeProgressView(
    progress: TranscodeProgress,
    now: number,
): TranscodeProgressView {
    const sinceReading =
        progress.receivedAt !== undefined
            ? Math.max(0, Math.floor((now - progress.receivedAt) / 1000))
            : 0;
    const state: TranscodeProgressState = progress.throttled
        ? 'paused'
        : isTranscodeFinished(progress)
          ? 'complete'
          : progress.speed !== undefined && progress.speed < SLOW_SPEED
            ? 'slow'
            : 'running';
    const etaSeconds =
        (state === 'running' || state === 'slow') && progress.etaSeconds !== undefined
            ? Math.max(0, progress.etaSeconds - sinceReading)
            : undefined;
    return {
        state,
        percent: Math.min(progress.progressPercent, 100),
        segmentsReady: progress.segmentsReady,
        totalSegments: progress.totalSegments,
        ranges: drawableRanges(progress),
        encoderPercent: state === 'complete' ? undefined : progress.encoderPercent,
        // A finished transcode no longer runs and is no longer polled; its
        // elapsed time is final.
        elapsedSeconds: progress.elapsedSeconds + (state === 'complete' ? 0 : sinceReading),
        etaSeconds,
        aheadSeconds: progress.bufferAheadSeconds,
    };
}

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

/**
 * Ranges the bar can draw: clamped to 0–100, empty ones dropped. An older
 * server sends no ranges — its percentage is a position, drawn from 0.
 */
function drawableRanges(progress: TranscodeProgress): { start: number; end: number }[] {
    const ranges = progress.coveredRanges ?? [{ start: 0, end: progress.progressPercent }];
    return ranges
        .map((range) => ({ start: clampPercent(range.start), end: clampPercent(range.end) }))
        .filter((range) => range.end > range.start);
}

/**
 * The plain-language notice the player shows about the server's encoder:
 * - `gpu_busy` / `cpu_slow`: the encode has run below real time for a while
 *   (the server's judgement, with hysteresis — see slow-transcode.ts);
 * - `software_fallback`: the GPU encoder had no free session, so the server
 *   switched this video to software; shown for a short while only;
 * - `software_fallback_slow`: both — the software encode cannot keep up.
 */
export type TranscodeNotice =
    'gpu_busy' | 'cpu_slow' | 'software_fallback' | 'software_fallback_slow';

/** How long the "switched to software" notice stays when the encode keeps up. */
export const SOFTWARE_FALLBACK_NOTICE_MS = 10_000;
/**
 * With this much already encoded ahead of the player, a slow encode will not
 * be felt for minutes — no reason to worry anyone yet.
 */
export const SLOW_NOTICE_MAX_AHEAD_SECONDS = 120;

/**
 * `fallbackSeenAt` is the client clock when a reading first carried
 * `softwareFallbackFrom`; undefined until then.
 */
export function transcodeNotice(
    progress: Pick<
        TranscodeProgress,
        'slowReason' | 'softwareFallbackFrom' | 'bufferAheadSeconds' | 'throttled'
    > | null,
    fallbackSeenAt: number | undefined,
    now: number,
): TranscodeNotice | null {
    if (!progress) return null;
    // A throttle-paused encode is ahead of the player; minutes ahead will not
    // be felt soon either.
    const ahead =
        progress.throttled || (progress.bufferAheadSeconds ?? 0) >= SLOW_NOTICE_MAX_AHEAD_SECONDS;
    if (progress.slowReason && !ahead) {
        return progress.softwareFallbackFrom ? 'software_fallback_slow' : progress.slowReason;
    }
    if (
        progress.softwareFallbackFrom &&
        fallbackSeenAt !== undefined &&
        now - fallbackSeenAt < SOFTWARE_FALLBACK_NOTICE_MS
    ) {
        return 'software_fallback';
    }
    return null;
}

/** Twice the heartbeat interval: an older progress reading no longer counts. */
export const SLOW_READING_MAX_AGE_MS = 60_000;

/**
 * Whether the server has said its encoder cannot keep up with playback, so a
 * frozen playhead is the next segment taking longer than real time rather
 * than a broken connection. The reconnect controller then waits instead of
 * showing "Reconnecting" — and instead of a rebuild, which would restart the
 * transcode it is waiting for. `startup` is the probe poll's answer before
 * the first heartbeat delivered a progress reading.
 */
export function encoderExplainsWaiting(
    progress: Pick<TranscodeProgress, 'slowReason' | 'throttled' | 'receivedAt'> | null,
    startup: { slowReason?: 'gpu_busy' | 'cpu_slow'; softwareFallbackFrom?: string } | null = null,
    now: number = Date.now(),
): boolean {
    if (progress) {
        // A reading the heartbeat/poll stopped refreshing (failed requests)
        // says nothing about now; trusting it would stretch the dead-stream
        // ceiling for a stream that may really be dead.
        if (
            progress.receivedAt !== undefined &&
            now - progress.receivedAt > SLOW_READING_MAX_AGE_MS
        ) {
            return false;
        }
        return !!progress.slowReason && !progress.throttled;
    }
    return !!startup?.slowReason;
}

/** `m:ss`, or `h:mm:ss` from an hour up. */
export function formatClock(totalSeconds: number): string {
    const s = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const seconds = String(s % 60).padStart(2, '0');
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
        : `${minutes}:${seconds}`;
}

/** Measured fps within this fraction of the source rate shows the source rate. */
const FPS_SNAP_TOLERANCE = 0.03;

/**
 * Frame rate for the FPS badge. The live rate is sampled once a second from
 * decoded-frame counts and wobbles (25 → 24.99 → 25.02); shown raw, the badge
 * changed width every tick and shoved its neighbours around. Within 3 % of the
 * source rate it shows the source rate; further off (frames really are being
 * dropped) it shows the measured rate as a whole number.
 */
export function stableDisplayFps(
    liveFps: number | null | undefined,
    sourceFps: number | null | undefined,
): number | undefined {
    const source = sourceFps ?? undefined;
    if (liveFps === null || liveFps === undefined) return source;
    if (source !== undefined && source > 0) {
        if (Math.abs(liveFps - source) / source <= FPS_SNAP_TOLERANCE) return source;
    }
    return Math.round(liveFps);
}
