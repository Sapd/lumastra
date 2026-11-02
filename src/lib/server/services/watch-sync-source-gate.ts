// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure change-detection for the watch-sync pull loop's `progress` /
 * `mark_unwatched` gates.
 *
 * The bug this fixes: `pullForProvider` (in `watch-sync-engine.service.ts`)
 * used to decide whether to append a new event by comparing the sync
 * source's freshly-reported value against Lumastra's **derived**
 * `user_media_state` (`currentState`). That derived state is arbitrated
 * across every source plus the rebuilder's own transforms (e.g. a watched
 * item always reports `resume_position_ms = 0` regardless of what any
 * individual source last said), so it can permanently diverge from what
 * one particular source keeps reporting. When it diverges, the old gate
 * re-appended the same `progress` (and sometimes `mark_unwatched`) event
 * on every single pull cycle, forever — confirmed in prod with a user who
 * accumulated 1455 and 687 redundant `progress` rows for two stuck
 * episodes.
 *
 * The fix: compare the source's new report against what THAT SAME SOURCE
 * last reported (its own event-log snapshot), not against the derived
 * state. A source's value trivially converges with its own last value —
 * after the first cycle writes the new snapshot, an unchanged report on
 * the next cycle matches and is skipped.
 *
 * These functions hold only the decision — no I/O — so they're
 * unit-testable without a database. The caller (`watch-sync-engine.
 * service.ts`) is responsible for fetching the source's last-reported
 * snapshot (see `getSourceSnapshotsForMedia` in
 * `user-media-events.queries.ts`) and Lumastra's current derived state,
 * then feeding both into these helpers.
 */

import type { DecisiveEventType } from '../database/queries/user-media-events.queries.js';

export type { DecisiveEventType };

/**
 * Decide whether the pull should append a `mark_unwatched` event for one
 * (user, media) this cycle.
 *
 * Two conditions must BOTH hold:
 *   1. `currentlyWatched` — Lumastra's derived state currently considers
 *      the item watched. Without this, the very first pull of an item
 *      that was NEVER watched (no prior "watched" intent from any
 *      source) would spuriously emit an unwatch — there is nothing to
 *      "unwatch" yet.
 *   2. The source's own last decisive report was NOT already
 *      `mark_unwatched` — this is the convergence fix. Once the source
 *      has told us "not watched" once, saying it again every cycle is
 *      pure noise (the classic churn: a higher-priority source keeps
 *      `currentlyWatched` pinned `true` forever, so condition 1 alone
 *      would re-fire on every cycle).
 *
 * A genuine watched → unwatched transition (condition 2 was previously
 * `mark_watched`/`completed`, or this source has never reported before)
 * still fires exactly once.
 */
export function shouldEmitSourceUnwatch(
    currentlyWatched: boolean,
    lastDecisiveEventType: DecisiveEventType | null,
): boolean {
    return currentlyWatched && lastDecisiveEventType !== 'mark_unwatched';
}

/**
 * Decide whether the pull should append a `mark_watched` event for one
 * (user, media) this cycle — the mirror of {@link shouldEmitSourceUnwatch}.
 *
 *   1. Lumastra does not already consider the item watched.
 *   2. This source's own last decisive report was NOT already
 *      `mark_watched` — the convergence half. Without it, an item whose
 *      derived state stays unwatched despite the source's mark (a
 *      higher-priority `lumastra-player` progress at ~92 % outranks a
 *      `jellyfin-sync` mark_watched) got a fresh mark_watched every pull:
 *      ~4,600 redundant rows a day on prod for ~30 items, since 09-21.
 */
export function shouldEmitSourceWatch(
    currentlyWatched: boolean,
    lastDecisiveEventType: DecisiveEventType | null,
): boolean {
    return !currentlyWatched && lastDecisiveEventType !== 'mark_watched';
}

/** Result of {@link decideSourceProgressEvent}. */
export interface SourceProgressDecision {
    /** Whether a `progress` event should be appended this cycle. */
    emit: boolean;
    /** The `position_ms` to write when `emit` is true. Ignored otherwise. */
    positionMs: number;
}

/**
 * Decide whether the pull should append a `progress` event for one
 * (user, media) this cycle, and at what position.
 *
 * @param newPositionMs - The position this source just reported.
 * @param lastSourcePositionMs - The `position_ms` of the most recent live
 *   `progress` event from THIS SAME SOURCE for this media (0 when the
 *   source has never reported a position before).
 * @param treatAsWatched - True when Lumastra's derived state considers
 *   the item watched AND this cycle did not just flip it to unwatched
 *   (i.e. `shouldEmitSourceUnwatch` returned false, or returned true but
 *   only because a genuine transition — not a steady "already unwatched"
 *   state — is not in play; see caller for the exact composition). When
 *   true, no progress event is ever emitted: a watched item's resume
 *   position is not tracked from a sync source, so a stale/irrelevant
 *   position report can never re-open it as in-progress.
 * @param toleranceMs - Minimum absolute delta before a moved (nonzero)
 *   position counts as a real change. Defaults to 1000ms — Jellyfin's
 *   tick precision can drift by a few ms across reconnects/DST
 *   transitions and spurious 1ms diffs must not flap.
 */
export function decideSourceProgressEvent(
    newPositionMs: number,
    lastSourcePositionMs: number,
    treatAsWatched: boolean,
    toleranceMs = 1000,
): SourceProgressDecision {
    if (treatAsWatched) {
        return { emit: false, positionMs: newPositionMs };
    }
    if (newPositionMs > 0 && Math.abs(newPositionMs - lastSourcePositionMs) >= toleranceMs) {
        return { emit: true, positionMs: newPositionMs };
    }
    if (newPositionMs === 0 && lastSourcePositionMs > 0) {
        return { emit: true, positionMs: 0 };
    }
    return { emit: false, positionMs: newPositionMs };
}
