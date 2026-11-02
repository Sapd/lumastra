// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sane media runtime from a container duration that may be bogus.
 *
 * ffprobe's `format.duration` is the end of the LONGEST stream, so a single
 * broken stream inflates it: a dvd_subtitle whose last packet has an
 * "infinite" display time (2^32 ms = 4 295 262 s ≈ 50 days), a TS timestamp
 * wrap, a broken mux. Every consumer of that number — the VOD playlist's
 * segment count, the transcode progress, the item runtime — then works
 * against a timeline the file can't fill. GPU transcode tests 2026-10-02: a
 * 300 s MKV stored as 4 295 262 s built a ~700k-segment playlist and the
 * muxed /hls endpoint 500'd (stack overflow in a `Math.max(...)` spread).
 *
 * Pure (no imports) so the probe, the DB read and the tests share one rule.
 */

/** Longer than any real single file; above it a disagreeing container loses. */
export const MAX_PLAUSIBLE_RUNTIME_SECONDS = 24 * 60 * 60;

/** A container more than this many times the media's own end is bogus. */
const IMPLAUSIBLE_RATIO = 2;

/**
 * Padding past the last keyframe when that is the only evidence of where the
 * video ends: the real end sits up to one GOP later (x264 default ≈ 10 s).
 */
export const KEYFRAME_END_PADDING_SECONDS = 10;

const isPositive = (n: number | null | undefined): n is number =>
    typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * Parse a per-stream duration the way ffprobe reports it: `stream.duration`
 * (seconds, mp4/ts) or mkvmerge's `DURATION` tag (`HH:MM:SS.nnnnnnnnn`,
 * sometimes language-suffixed, e.g. `DURATION-eng`). Undefined when absent.
 */
export function parseStreamDurationSeconds(stream: {
    duration?: string;
    tags?: Record<string, string | undefined>;
}): number | undefined {
    if (stream.duration !== undefined) {
        const seconds = Number.parseFloat(stream.duration);
        if (isPositive(seconds)) return seconds;
    }
    const tags = stream.tags;
    if (!tags) return undefined;
    const key = Object.keys(tags).find((k) => /^DURATION(-|$)/i.test(k));
    const raw = key === undefined ? undefined : tags[key]?.trim();
    const match = raw ? /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(raw) : null;
    if (!match) return undefined;
    const seconds =
        Number.parseInt(match[1], 10) * 3600 +
        Number.parseInt(match[2], 10) * 60 +
        Number.parseFloat(match[3]);
    return isPositive(seconds) ? seconds : undefined;
}

/**
 * The runtime to use given the container's duration and independent evidence
 * of where the media (video / audio) actually ends.
 *
 * The container wins unless it is implausible against that evidence: more
 * than 2× the media end, or beyond 24 h while the media ends materially
 * earlier. A container slightly longer than the media (trailing subtitles,
 * a short truncation) is left alone — the truncation health check owns that.
 * With no container duration the media end is used; with no evidence the
 * container is returned as-is (nothing better to go on).
 */
export function reconcileRuntimeSeconds(
    containerSeconds: number | null | undefined,
    mediaEndSeconds: number | null | undefined,
): number | null {
    const container = isPositive(containerSeconds) ? containerSeconds : null;
    if (!isPositive(mediaEndSeconds)) return container;
    if (container === null) return mediaEndSeconds;
    const implausible =
        container > mediaEndSeconds * IMPLAUSIBLE_RATIO ||
        (container > MAX_PLAUSIBLE_RUNTIME_SECONDS && container > mediaEndSeconds * 1.1);
    return implausible ? mediaEndSeconds : container;
}

/**
 * Where the media ends according to its video and audio streams: the longest
 * of them. Subtitle / data / attachment streams are exactly the ones that
 * carry bogus end times, so they are never evidence. When the file has video
 * but no video stream states its duration, audio alone is not trusted (a
 * short commentary track would cap a whole film) and the result is undefined.
 */
export function mediaEndFromStreams(
    streams: ReadonlyArray<{
        codec_type?: string;
        duration?: string;
        tags?: Record<string, string | undefined>;
        disposition?: { attached_pic?: number };
    }>,
): number | undefined {
    let end: number | undefined;
    let hasVideo = false;
    let videoEnd: number | undefined;
    for (const s of streams) {
        if (s.codec_type !== 'video' && s.codec_type !== 'audio') continue;
        // Cover art is a one-frame "video" stream with no meaningful duration.
        if (s.disposition?.attached_pic === 1) continue;
        const d = parseStreamDurationSeconds(s);
        if (s.codec_type === 'video') {
            hasVideo = true;
            if (d !== undefined && (videoEnd === undefined || d > videoEnd)) videoEnd = d;
        }
        if (d !== undefined && (end === undefined || d > end)) end = d;
    }
    return hasVideo && videoEnd === undefined ? undefined : end;
}
