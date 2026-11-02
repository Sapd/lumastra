// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { ResumeEntry } from './playback-progress-cache';

export interface ResolveResumeArgs {
    serverPositionMs: number;
    serverAnchor: number | null;
    isWatched: boolean;
    cached: ResumeEntry | null;
}

export function resolveResumePosition(args: ResolveResumeArgs): number {
    // `isWatched` is intentionally NOT a hard gate to 0. The server-side
    // rebuilder (see watch-state-rebuilder.service.ts comment) keeps
    // resume_position_ms > 0 on is_watched=true rows for re-watch support,
    // and PlayerController clears the localStorage cache when isWatched is
    // true (see player-controller.svelte.ts) so `cached` is null in that
    // case. Trusting `serverPositionMs` here lets a re-watch resume at
    // progress > 0 while a fresh "just finished" row (server returns 0)
    // still starts from the beginning.
    const { serverPositionMs, serverAnchor, cached } = args;
    if (!cached) return serverPositionMs;
    if (serverAnchor === null) return cached.positionMs;
    if (cached.anchor >= serverAnchor) return cached.positionMs;
    return serverPositionMs;
}

/**
 * Seconds before the end inside which a start is pointless: playback would end
 * (and the player close) before a frame shows. Capped at 10 % of short media.
 */
const END_START_GUARD_SECONDS = 5;

/**
 * Last line of defence before the player hands a start position to HLS or a
 * direct <video>. The server already starts finished items at 0
 * (resumePositionForStart); this catches anything else that lands at the end — a
 * stale cache entry, a resume measured against a slightly longer runtime. A start
 * past the last segment made hls.js load segment 0, which the server took for a
 * backward seek and re-transcoded from 0 while the player sat at the tail
 * (reverse-proxy e2e, 2026-10-06). Unknown duration keeps the position; a
 * non-finite or negative start is 0.
 */
export function clampStartToPlayable(startSeconds: number, durationSeconds: number): number {
    if (!Number.isFinite(startSeconds) || startSeconds < 0) return 0;
    if (!(durationSeconds > 0)) return startSeconds;
    // Short clips get a proportional guard, or every resume in them would reset.
    const guard = Math.min(END_START_GUARD_SECONDS, durationSeconds * 0.1);
    if (startSeconds >= durationSeconds - guard) return 0;
    return startSeconds;
}
