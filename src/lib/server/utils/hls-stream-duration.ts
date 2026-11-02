// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Helpers for inferring a stream's effective segment duration.
 *
 * FFmpeg's EXT-X-TARGETDURATION is a ceiling, not the real cadence. Audio
 * streams can legitimately publish base+1 seconds even when their actual
 * segments are still at the configured base duration. Video copy/remux
 * streams, however, often have genuinely longer keyframe-aligned segments.
 */

export interface HlsDurationSample {
    duration: number;
}

const DISTINCT_DURATION_RATIO = 1.15;
const DISTINCT_DURATION_EPSILON_SECONDS = 0.5;

/**
 * Returns true when a candidate duration is meaningfully larger than the base
 * duration and should be treated as a distinct stream cadence.
 */
export function isDistinctStreamDuration(
    candidateDuration: number | undefined,
    baseDuration: number,
): boolean {
    if (
        !Number.isFinite(candidateDuration) ||
        candidateDuration === undefined ||
        candidateDuration <= 0 ||
        !Number.isFinite(baseDuration) ||
        baseDuration <= 0
    ) {
        return false;
    }

    const threshold = Math.max(
        baseDuration * DISTINCT_DURATION_RATIO,
        baseDuration + DISTINCT_DURATION_EPSILON_SECONDS,
    );

    return candidateDuration >= threshold;
}

/**
 * Infer the effective segment duration for a stream from FFmpeg manifest data.
 *
 * When actual segment durations stay near the base cadence, we return the base
 * duration even if EXT-X-TARGETDURATION was rounded up. When the observed
 * cadence is genuinely longer, we return the stream target duration so the
 * generated VOD timeline matches the stream's segment numbering.
 */
export function resolveEffectiveStreamDuration(
    baseDuration: number,
    targetDuration?: number,
    segments?: HlsDurationSample[],
): number {
    const safeBaseDuration = Number.isFinite(baseDuration) && baseDuration > 0 ? baseDuration : 6;

    const validSegments =
        segments?.filter((segment) => Number.isFinite(segment.duration) && segment.duration > 0) ??
        [];

    if (validSegments.length > 0) {
        const averageDuration =
            validSegments.reduce((sum, segment) => sum + segment.duration, 0) /
            validSegments.length;

        if (isDistinctStreamDuration(averageDuration, safeBaseDuration)) {
            return Number.isFinite(targetDuration) && (targetDuration ?? 0) > 0
                ? targetDuration!
                : averageDuration;
        }

        return safeBaseDuration;
    }

    // No segment samples available — don't trust targetDuration alone.
    // FFmpeg's TARGETDURATION is a ceiling, so audio with ~6s segments can
    // publish TD=7. Without real segment data we can't distinguish that from
    // genuinely longer video segments. Return base and let the next call
    // (with segment data) correct it — cacheStreamTargetDuration re-reads
    // on every request.
    return safeBaseDuration;
}
