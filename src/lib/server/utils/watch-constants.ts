// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared constants for watch state and playback completion logic.
 */

import { isEpisode } from '$lib/server/utils/media-types.js';

/**
 * Fraction of runtime that must be reached for a media item to be
 * considered fully watched and auto-marked as complete.
 */
export const WATCH_COMPLETION_THRESHOLD = 0.9;

/**
 * How much book may remain before an audiobook counts as finished.
 *
 * ABSOLUTE, deliberately — this is the one media type where a percentage is the
 * wrong shape. AudiobookShelf models the same idea as
 * `markAsFinishedTimeRemaining` (seconds, default 10). Two minutes is the
 * product decision for Lumastra: comfortably past the last sentence, nowhere
 * near the ~45 minutes a percentage rule was silently swallowing.
 */
export const AUDIOBOOK_FINISH_REMAINING_MS = 120_000;

/** Audiobooks arrive lowercase from the DB but UPPERCASE from legacy clients. */
function isAudiobook(mediaType: string | null | undefined): boolean {
    return typeof mediaType === 'string' && mediaType.toLowerCase() === 'audiobook';
}

/** Maximum engagement requirement; also the fallback when runtime is unknown. */
export const MIN_ENGAGEMENT_MS = 60_000;

/**
 * Active playing time required before persisting durable resume progress.
 * Short items need 25% of their runtime, capped at 60 seconds. Callers must
 * supply the episode window's duration for combined multi-episode files.
 */
export function engagementThresholdMs(durationMs: number | null | undefined): number {
    return durationMs !== null && durationMs !== undefined && durationMs > 0
        ? Math.min(MIN_ENGAGEMENT_MS, durationMs * 0.25)
        : MIN_ENGAGEMENT_MS;
}

// Minimum fraction of runtime that must be watched before user_media_state
// is written at all. Prevents accidental-tap sessions from polluting
// Continue Watching / resume records.
export const WATCH_WRITE_THRESHOLD_PERCENT = 0.05;

// Legacy media-type fallback thresholds — used only when runtime is unknown.
// Prefer the runtime-aware `completionThresholdFor(mediaType, runtimeMs)`.
export const COMPLETION_THRESHOLD_BY_MEDIA_TYPE: Record<string, number> = {
    MOVIE: 0.95,
    EPISODE: 0.9,
    SERIES: 0.9,
    SEASON: 0.9,
};

/**
 * Threshold beyond which a play position is considered "complete enough" to
 * mark the item as watched. Runtime-aware: credits are closer to a fixed
 * duration than a fixed percentage, so shorter content uses a lower % and
 * longer content uses a higher %. Falls back to media-type-based thresholds
 * when runtime is unknown (e.g. un-probed files, legacy rows).
 *
 * Tiers chosen so the "done zone" is roughly 60s–8min wide regardless of
 * runtime:
 *   < 90 min  → 0.90  (sitcom/drama episode/short film: 90% of 49min ≈
 *                       4:54 remaining — was 0.93 for the 30-90min band,
 *                       but two real episodes stopped at 92.5-92.8% right
 *                       at the credits and stayed unmarked, prod 2026-09-21)
 *   < 150 min → 0.95  (standard feature)
 *   ≥ 150 min → 0.96  (epic: 96% of 180min = 7:12 remaining — ~credits)
 */
/** An episode's slice of a combined file, in file-absolute milliseconds. */
export interface EpisodeWindow {
    startMs: number;
    endMs: number;
}

/**
 * Has playback crossed the completion threshold for THIS item?
 *
 * Extracted from `watch-manager.reportProgress` so its test stops re-deriving
 * the rule. A test that re-implements the logic it checks cannot fail when the
 * real logic changes — and this rule decides whether an episode is marked
 * watched, which is about as user-visible as it gets.
 *
 * The window is the whole point. In a combined file, positions are
 * file-absolute: entering episode 25 at 692s is 0% of that episode, not 105%
 * of a 660s provider runtime. Judging against the window rather than the raw
 * runtime is what stops an episode being marked watched the instant it opens.
 *
 * Staleness (`accepted`) is deliberately NOT a parameter — a rejected progress
 * event must not complete anything, and that is the caller's gate, not this
 * function's.
 */
export function crossedCompletionThreshold(input: {
    positionMs: number;
    window: EpisodeWindow | null;
    runtimeMs: number | null | undefined;
    mediaType?: string | undefined;
    /** Caller-supplied override; falls back to `completionThresholdFor`. */
    explicitThreshold?: number | undefined;
}): boolean {
    const { positionMs, window, runtimeMs, mediaType, explicitThreshold } = input;
    const position = window ? positionMs - window.startMs : positionMs;
    const runtime = window ? window.endMs - window.startMs : runtimeMs;
    if (!runtime || runtime <= 0) return false;
    const threshold = explicitThreshold ?? completionThresholdFor(mediaType, runtime);
    return position >= runtime * threshold;
}

/**
 * Where a NEW playback of this item should start, given its effective resume.
 *
 * A resume past the completion threshold means the item was finished, not paused:
 * the watch-state rebuilder keeps the last post-completion position on
 * `is_watched=true` rows (that is what makes a re-watch resumable), so a movie
 * watched to the credits can carry resume_position_ms ~= runtime. Starting there
 * plays a second of credits at best — and a start at/after the last segment
 * wedged the HLS session (reverse-proxy e2e, 2026-10-06). Such a resume starts
 * from the beginning; a mid-item resume (including a re-watch in progress) is kept.
 *
 * `runtimeMs` must be the whole FILE's runtime (fileRuntimeMsForResume): positions
 * are file-absolute, and in a combined multi-episode file only a position near the
 * file end is past every episode in it.
 */
export function resumePositionForStart(input: {
    positionMs: number;
    runtimeMs: number | null | undefined;
    mediaType: string | null | undefined;
}): number {
    const { positionMs, runtimeMs, mediaType } = input;
    if (!Number.isFinite(positionMs) || positionMs <= 0) return 0;
    if (
        crossedCompletionThreshold({
            positionMs,
            window: null,
            runtimeMs,
            mediaType: mediaType ?? undefined,
        })
    ) {
        return 0;
    }
    return positionMs;
}

/**
 * The runtime a file-absolute resume is judged against by resumePositionForStart:
 * the length of the FILE — never the catalog runtime, which describes the title
 * rather than this file (an extended cut runs longer; a wrong provider runtime can
 * be off either way) and would wipe a valid resume or miss one at the very end.
 *
 * The probed file duration when known. Without it, a combined multi-episode file
 * falls back to the end of its last episode window, but only when EVERY sibling
 * has one (a partly derived split understates the file); anything else is unknown
 * (null), and the resume is kept — the player clamps a start at the end itself.
 */
export function fileRuntimeMsForResume(input: {
    fileDurationMs: number | null | undefined;
    siblings: ReadonlyArray<{ end_offset_ms: string | number | null }>;
}): number | null {
    const { fileDurationMs, siblings } = input;
    if (fileDurationMs && Number.isFinite(fileDurationMs) && fileDurationMs > 0) {
        return fileDurationMs;
    }
    if (siblings.length > 1) {
        const ends = siblings
            .map((s) => Number(s.end_offset_ms ?? Number.NaN))
            .filter((ms) => Number.isFinite(ms) && ms > 0);
        return ends.length === siblings.length ? Math.max(...ends) : null;
    }
    return null;
}

export function completionThresholdFor(
    mediaType: string | null | undefined,
    runtimeMs?: number | null,
): number {
    if (runtimeMs && runtimeMs > 0) {
        // Audiobooks are an ABSOLUTE window, never a percentage. The tier ladder
        // below tops out at 150 minutes and was calibrated so the "done zone" is
        // 60s-8min — true for film runtimes, badly false an order of magnitude
        // up. A 20h57m book hit the 0.96 tier with 44m38s still to listen, was
        // auto-marked finished, and vanished from Continue Listening while its
        // AudiobookShelf row still read isFinished=0 (prod, 2026-08-27). Even 99%
        // would have finished it ~12 minutes early.
        //
        // Guarded on runtime exceeding the window so a garbage-short runtime
        // cannot produce a <=0 threshold, which would mark a book finished at
        // position 0; those fall through to the tier ladder instead.
        if (isAudiobook(mediaType) && runtimeMs > AUDIOBOOK_FINISH_REMAINING_MS) {
            return (runtimeMs - AUDIOBOOK_FINISH_REMAINING_MS) / runtimeMs;
        }
        const minutes = runtimeMs / 60_000;
        if (minutes < 90) return 0.9;
        if (minutes < 150) return 0.95;
        return 0.96;
    }
    if (!mediaType) return 0.9;
    return COMPLETION_THRESHOLD_BY_MEDIA_TYPE[mediaType.toUpperCase()] ?? 0.9;
}

/**
 * Jellyfin's own default "played" bar (MaxResumePct = 90). Used for /j-compat
 * episode playback so the compat surface advances Next Up the way a real
 * Jellyfin server would, rather than at the stricter runtime-tiered bar.
 */
export const JELLYFIN_PLAYED_THRESHOLD = 0.9;

/**
 * True when a play session originated from the /j Jellyfin-compat surface.
 * New sessions persist their surface explicitly; real client DeviceIds must
 * round-trip unchanged and do not carry the old synthetic prefix. Keep that
 * prefix as a fallback for sessions created before the surface was recorded.
 */
export function isJellyfinCompatSession(session: {
    surface?: string | null;
    device_id?: string | null;
}): boolean {
    return (
        session.surface === 'jellyfin_compat' ||
        (session.device_id?.startsWith('jellyfin-compat-') ?? false)
    );
}

/**
 * Completion threshold to use for THIS session. /j-compat EPISODES use the
 * flat Jellyfin 0.90 "played" bar; everything else (native player, compat
 * movies/seasons/tracks) uses the runtime-tiered completionThresholdFor().
 */
export function playedThresholdFor(
    session: { surface?: string | null; device_id?: string | null },
    mediaType: string | null | undefined,
    runtimeMs: number | null | undefined,
): number {
    if (isJellyfinCompatSession(session) && isEpisode(mediaType)) {
        return JELLYFIN_PLAYED_THRESHOLD;
    }
    return completionThresholdFor(mediaType, runtimeMs ?? undefined);
}

/**
 * Determines the effective "watched" state for display purposes.
 *
 * `is_watched=true AND resume_position_ms > 0` is a valid DB state for a
 * re-watch in progress. When `last_event_at` is strictly newer than
 * `last_watched_at`, the user has had playback activity after the most
 * recent positive completion — i.e. they are actively re-watching.
 * In that case we report the item as NOT watched so the UI shows a
 * progress bar rather than a watched badge.
 *
 * This is a display-time heuristic; the underlying `is_watched` flag
 * in the DB is intentionally unchanged.
 */
export function isEffectivelyWatched(state: {
    is_watched: boolean;
    resume_position_ms: number | string | null;
    last_event_at: string | Date | null;
    last_watched_at: string | Date | null;
}): boolean {
    if (!state.is_watched) return false;
    // Number() on null/undefined/'' → 0 (falsy); on 'abc' → NaN (falsy).
    // Both correctly mean "no resume position" → still watched.
    if (!Number(state.resume_position_ms)) return true;
    if (!state.last_event_at || !state.last_watched_at) return true;
    const evAt = new Date(state.last_event_at);
    const wAt = new Date(state.last_watched_at);
    // Guard against corrupt timestamp strings — treat as watched rather than
    // falsely surfacing the item as mid-rewatch.
    if (isNaN(evAt.getTime()) || isNaN(wAt.getTime())) return true;
    return evAt <= wAt;
}

export interface WatchStateSyncItem {
    isWatched: boolean;
    resumePositionMs: number;
    runtimeMs: number;
}

export interface AutoCompleteResult<T> {
    item: T;
    triggered: boolean;
    ratio: number | null;
    threshold: number | null;
}

/**
 * Local auto-complete: if a provider reports resume progress past the
 * completion threshold but still claims `isWatched=false`, treat it as
 * watched locally. Closes the Infuse→Jellyfin-style sync gap where an
 * external client finishes playback but the provider never updates its
 * played flag. Returns a new item; the input is not mutated. Items with
 * runtime ≤ 0 are passed through unchanged because ratio is undefined.
 * Negative resume positions are clamped to 0 at this boundary — external
 * providers can send garbage and downstream upsert paths don't all guard.
 */
export function applyAutoCompleteFromProgress<T extends WatchStateSyncItem>(
    item: T,
    mediaType?: string | null,
): AutoCompleteResult<T> {
    const safeResume = Math.max(0, item.resumePositionMs);
    const normalized =
        safeResume === item.resumePositionMs ? item : { ...item, resumePositionMs: safeResume };

    if (normalized.isWatched || !normalized.runtimeMs || normalized.runtimeMs <= 0) {
        return {
            item: normalized,
            triggered: false,
            ratio: null,
            threshold: null,
        };
    }
    const threshold = completionThresholdFor(mediaType, normalized.runtimeMs);
    const ratio = normalized.resumePositionMs / normalized.runtimeMs;
    if (ratio >= threshold) {
        return {
            item: { ...normalized, isWatched: true, resumePositionMs: 0 },
            triggered: true,
            ratio,
            threshold,
        };
    }
    return { item: normalized, triggered: false, ratio, threshold };
}
