// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The state reset that must run whenever playback (re)starts for an item.
 *
 * Extracted from `PlayerController.onPlay()` because a second call site needs
 * the SAME block: the in-place episode advance.
 *
 * onPlay() early-returns for the entire tryStartRestart()…finishRestart()
 * window (shouldSuppressErrors()), and PlaybackManager can fire the native
 * `play` event inside that window. On the in-place advance the element never
 * pauses afterwards, so no later `play` event arrives and the whole block is
 * swallowed — permanently. The advance used to replay only `bootstrapFirstPlay()`
 * out of it.
 *
 * The consequential omission was `hasEnded`. `onEnded()` sets it true moments
 * before the advance, and nothing else clears it. It gates:
 *   - the reconnect auto-resume (`.play()` is skipped while it is true),
 *   - the stall watchdog, via `updatePlaybackIntent()`,
 *   - `rebuildPlaybackSession()`'s `autoResume`.
 * So from the SECOND episode onward, a tunnel would stop audio permanently —
 * precisely the scenario the audio-only rung exists to survive.
 */

/** The subset of playerStore this reset writes. */
export interface PlaybackResumedStore {
    setPlaying(isPlaying: boolean): void;
    clearError(): void;
    setPausedByUser(pausedByUser: boolean): void;
    setReconnectNeedsTap(reconnectNeedsTap: boolean): void;
    setEnded(hasEnded: boolean): void;
}

export interface PlaybackResumedDeps {
    /** Clears the controller's own `hasEnded` flag (not store-backed). */
    setHasEnded(hasEnded: boolean): void;
    /** Re-arms the stall watchdog from the freshly-cleared intent. */
    updatePlaybackIntent(): void;
    /** Pushes 'playing' to the OS lock screen / media keys. */
    setMediaSessionPlaybackState(state: 'playing' | 'paused'): void;
}

/**
 * Apply the "playback is running for this item" reset.
 *
 * Order matters for the last two: `setHasEnded(false)` must precede
 * `updatePlaybackIntent()`, or the watchdog is re-armed from the stale ended
 * flag and stays disabled.
 */
export function applyPlaybackResumedReset(
    store: PlaybackResumedStore,
    deps: PlaybackResumedDeps,
): void {
    store.setPlaying(true);
    store.clearError();
    store.setPausedByUser(false);
    store.setReconnectNeedsTap(false);
    deps.setHasEnded(false);
    store.setEnded(false);
    deps.updatePlaybackIntent();
    deps.setMediaSessionPlaybackState('playing');
}
