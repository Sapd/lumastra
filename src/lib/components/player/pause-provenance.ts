// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Why did the element pause?
 *
 * A raw `pause` entry in an incident timeline is ambiguous, and that ambiguity
 * cost a full investigation (prod 2026-09-11). Two users reported "playback
 * stops randomly"; their timelines all read
 *
 *     play → pause (<1s later) → [playhead frozen] → stall → nudge ×2 →
 *     rebuild ×4 → terminal
 *
 * on BOTH engines (Safari native HLS and Firefox/hls.js), with segments
 * delivered in 0.05–0.6s and 6–36x bandwidth headroom. But `onPause()` pushes
 * its buffer entry BEFORE the `shouldSuppressErrors()` guard, deliberately — so
 * the detaching of the element during a rebuild also lands a `pause`, and a
 * teardown artifact is indistinguishable from a real one after the fact.
 *
 * Recording the provenance makes the next occurrence self-explaining:
 *
 * - `restart-teardown` — inside tryStartRestart()..finishRestart(). Expected
 *   noise; ignore it.
 * - `ended` — end of media.
 * - `user` — the viewer pressed pause.
 * - `involuntary` — none of the above: something paused the element that nobody
 *   asked for. This is the one that matters, because
 *   `updatePlaybackIntent()` derives the ReconnectController's `intendedPlaying`
 *   from `playerStore.pausedByUser` and never reconciles it against the
 *   element's real `paused` state. An involuntary pause therefore leaves intent
 *   "playing", `armStallTimer()` keeps running against an element that is merely
 *   paused, and no rebuild can ever fix it — the ladder spends its whole
 *   6-attempt budget and declares terminal ("reload the page"), which is
 *   precisely what a real page reload then fixes.
 * - `source-reload` — PlaybackManager's seek reset paused the element itself
 *   and resumes it on loadedmetadata.
 *
 * `onPause()` now adopts an `involuntary` pause as the user's intent (see
 * `adoptsPauseAsUserIntent`). On iPad Safari (2026-10-15) these were the native
 * fullscreen controls: the stall dead-man fired 6 s after the pause and the
 * recovery nudge called play(), so the video resumed by itself.
 */

export type PauseProvenance =
    'restart-teardown' | 'source-reload' | 'ended' | 'user' | 'involuntary';

export interface PauseCauseInputs {
    /** shouldSuppressErrors() — the restart/teardown window. */
    restarting: boolean;
    /** playerStore.pausedByUser — the same input updatePlaybackIntent() uses. */
    pausedByUser: boolean;
    /** Controller's end-of-media latch. */
    ended: boolean;
    /** PlaybackManager.isSeekResetInFlight() — our own source reload. */
    sourceReload?: boolean;
}

/**
 * Teardown is checked first on purpose: during a restart the other flags are
 * not trustworthy (the store is mid-reset), so a pause in that window must be
 * reported as the artifact it is rather than mislabeled `involuntary` and
 * sending a future reader after a phantom.
 */
export function classifyPause(inputs: PauseCauseInputs): PauseProvenance {
    if (inputs.restarting) return 'restart-teardown';
    if (inputs.sourceReload) return 'source-reload';
    if (inputs.ended) return 'ended';
    if (inputs.pausedByUser) return 'user';
    return 'involuntary';
}

export interface PauseIntentInputs extends PauseCauseInputs {
    /** In a watch party the sync controller owns play/pause. */
    inWatchParty: boolean;
}

/**
 * Should this `pause` be recorded as the user pausing (pausedByUser)?
 *
 * Yes for a pause that came from outside the player UI: the native fullscreen
 * controls, Picture in Picture, the OS (audio interruption, headphones
 * removed). The player UI records its own pauses before calling pause().
 * Restart teardown and our own source reload resume by themselves, and a dead
 * stream behind a seek reset still needs the seek watchdog, which only runs
 * while intent is "playing". The next `play` event clears the flag again
 * (applyPlaybackResumedReset).
 */
export function adoptsPauseAsUserIntent(inputs: PauseIntentInputs): boolean {
    return !inputs.inWatchParty && classifyPause(inputs) === 'involuntary';
}

export interface TransportDetailInputs extends PauseCauseInputs {
    /** videoElement.paused, when an element is still attached. */
    paused: boolean | undefined;
    /** videoElement.readyState, when an element is still attached. */
    readyState: number | undefined;
}

/**
 * The provenance plus the element state that corroborates it. Absent element
 * fields are omitted rather than sent as `undefined`: the timeline is serialized
 * to JSON, where an explicit undefined becomes a null that reads as "measured,
 * and it was empty" instead of "not observable".
 */
export function buildTransportDetail(inputs: TransportDetailInputs): Record<string, unknown> {
    return {
        provenance: classifyPause(inputs),
        ...(inputs.paused !== undefined ? { paused: inputs.paused } : {}),
        ...(inputs.readyState !== undefined ? { readyState: inputs.readyState } : {}),
    };
}
