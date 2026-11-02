// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Polling schedule for PlayerOverlay's /probe-status loop.
 *
 * The loop runs while the player is loading or buffering. It used to poll
 * every 600ms until it had SEEN a probe start and finish — so a stall that
 * involves no probe at all (a direct stream buffering mid-playback, a stuck
 * player) polled for as long as the stall lasted: 4,949 requests in 83
 * minutes from one tab on prod (2026-09-25), every answer `{"probing":false}`.
 *
 * A probe, when there is one, starts within a few seconds of the manifest
 * request, so the first idle answers stay fast; after that the loop backs off
 * and finally gives up. A new loading/buffering window restarts the schedule
 * (PlayerOverlay's $effect re-arms with a fresh idle count).
 */
export const PROBE_POLL_FAST_MS = 600;

/** Idle answers polled at the fast rate (~5s) before backing off. */
export const FAST_IDLE_LIMIT = 8;
/** Idle answers polled at the medium rate before slowing further. */
const MEDIUM_IDLE_LIMIT = 20;
/** Idle answers after which the loop stops (~2 minutes in total). */
const GIVE_UP_IDLE_LIMIT = 40;

export function nextProbePollDelayMs(state: {
    probing: boolean;
    probeSeen: boolean;
    /** Consecutive `probing: false` answers since the window opened. */
    idleResponses: number;
}): number | null {
    if (state.probing) return PROBE_POLL_FAST_MS;
    // The server cleared its entry after a run we watched — nothing left to show.
    if (state.probeSeen) return null;
    if (state.idleResponses < FAST_IDLE_LIMIT) return PROBE_POLL_FAST_MS;
    if (state.idleResponses < MEDIUM_IDLE_LIMIT) return 2_000;
    if (state.idleResponses < GIVE_UP_IDLE_LIMIT) return 5_000;
    return null;
}
