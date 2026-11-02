// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { browser } from '$app/environment';

export interface MediaSessionMetadata {
    title: string;
    artist?: string; // Show name for TV, director for movies
    album?: string; // Season info for TV
    artwork?: string; // Thumbnail URL
}

export interface MediaSessionCallbacks {
    onPlay?: () => void;
    onPause?: () => void;
    onSeekBackward?: (seekOffset?: number) => void;
    onSeekForward?: (seekOffset?: number) => void;
    onSeekTo?: (seekTime: number) => void;
    onStop?: () => void;
    onNextTrack?: () => void;
    onPreviousTrack?: () => void;
}

export interface MediaSessionOptions {
    /**
     * Music lock-screen controls should avoid seekforward/seekbackward because
     * iOS renders those as podcast-style skip buttons instead of track buttons.
     */
    trackControlsOnly?: boolean;
    /**
     * Allows absolute scrubber seeking while still suppressing the 10-second
     * seekforward/seekbackward actions.
     */
    seekToWithTrackControls?: boolean;
}

let positionStateEnabled = true;

function clearMediaSessionPositionState(): void {
    if (!browser || !('mediaSession' in navigator)) {
        return;
    }
    try {
        navigator.mediaSession.setPositionState();
    } catch {
        // Some browsers may not support clearing position state.
    }
}

/**
 * Initialize Media Session API for lock screen / notification controls
 * Works on mobile (iOS/Android) and desktop (Chrome, Edge, Firefox)
 *
 * Acts as a complete state-setter: every known action is either registered
 * with its callback or explicitly nulled. Leaving `seekforward`/`seekbackward`
 * registered from a previous session (e.g. the video player) makes iOS render
 * podcast-style skip-15s buttons instead of prev/next track buttons on the
 * lock screen — nulling undefined handlers guarantees a clean slate.
 */
export function initMediaSession(
    metadata: MediaSessionMetadata,
    callbacks: MediaSessionCallbacks,
    options: MediaSessionOptions = {},
): void {
    if (!browser || !('mediaSession' in navigator)) {
        return;
    }

    updateMediaSessionMetadata(metadata);

    const session = navigator.mediaSession;
    const trackControlsOnly = options.trackControlsOnly === true;
    const allowSeekTo = !trackControlsOnly || options.seekToWithTrackControls === true;
    positionStateEnabled = allowSeekTo;
    if (!allowSeekTo) {
        clearMediaSessionPositionState();
    }

    const setHandler = (
        action: MediaSessionAction,
        handler: MediaSessionActionHandler | null,
    ): void => {
        try {
            session.setActionHandler(action, handler);
        } catch {
            // Some browsers may not support every action
        }
    };

    setHandler('play', callbacks.onPlay ?? null);
    setHandler('pause', callbacks.onPause ?? null);
    setHandler('stop', callbacks.onStop ?? null);
    setHandler('nexttrack', callbacks.onNextTrack ?? null);
    setHandler('previoustrack', callbacks.onPreviousTrack ?? null);

    setHandler(
        'seekbackward',
        !trackControlsOnly && callbacks.onSeekBackward
            ? (details) => callbacks.onSeekBackward!(details.seekOffset ?? 10)
            : null,
    );
    setHandler(
        'seekforward',
        !trackControlsOnly && callbacks.onSeekForward
            ? (details) => callbacks.onSeekForward!(details.seekOffset ?? 10)
            : null,
    );
    setHandler(
        'seekto',
        allowSeekTo && callbacks.onSeekTo
            ? (details) => {
                  if (details.seekTime !== undefined) {
                      callbacks.onSeekTo!(details.seekTime);
                  }
              }
            : null,
    );
}

/**
 * Update the media session metadata (e.g., when episode changes)
 */
export function updateMediaSessionMetadata(metadata: MediaSessionMetadata): void {
    if (!browser || !('mediaSession' in navigator)) {
        return;
    }

    const artworkArray: MediaImage[] = [];

    if (metadata.artwork) {
        // Provide multiple sizes for different contexts
        artworkArray.push(
            { src: metadata.artwork, sizes: '96x96', type: 'image/jpeg' },
            { src: metadata.artwork, sizes: '128x128', type: 'image/jpeg' },
            { src: metadata.artwork, sizes: '192x192', type: 'image/jpeg' },
            { src: metadata.artwork, sizes: '256x256', type: 'image/jpeg' },
            { src: metadata.artwork, sizes: '384x384', type: 'image/jpeg' },
            { src: metadata.artwork, sizes: '512x512', type: 'image/jpeg' },
        );
    }

    navigator.mediaSession.metadata = new MediaMetadata({
        title: metadata.title,
        artist: metadata.artist || '',
        album: metadata.album || '',
        artwork: artworkArray,
    });
}

/**
 * Update playback state (playing, paused, none)
 */
export function updateMediaSessionPlaybackState(state: 'playing' | 'paused' | 'none'): void {
    if (!browser || !('mediaSession' in navigator)) {
        return;
    }

    navigator.mediaSession.playbackState = state;
}

/**
 * Update position state for seek bar on lock screen
 */
export function updateMediaSessionPositionState(
    duration: number,
    position: number,
    playbackRate: number = 1,
): void {
    if (!browser || !('mediaSession' in navigator)) {
        return;
    }
    if (!positionStateEnabled) {
        return;
    }

    // Only update if we have valid finite values (LiveTV has Infinity duration)
    if (
        Number.isFinite(duration) &&
        Number.isFinite(position) &&
        duration > 0 &&
        position >= 0 &&
        position <= duration
    ) {
        try {
            navigator.mediaSession.setPositionState({
                duration,
                position,
                playbackRate,
            });
        } catch (e) {
            // Some browsers may not support this
            console.debug('[MediaSession] Position state not supported:', e);
        }
    }
}

/**
 * Clear media session (when player is destroyed)
 */
export function clearMediaSession(): void {
    if (!browser || !('mediaSession' in navigator)) {
        return;
    }

    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = 'none';
    clearMediaSessionPositionState();

    // Remove all action handlers
    const actions: MediaSessionAction[] = [
        'play',
        'pause',
        'seekbackward',
        'seekforward',
        'seekto',
        'stop',
        'nexttrack',
        'previoustrack',
    ];

    for (const action of actions) {
        try {
            navigator.mediaSession.setActionHandler(action, null);
        } catch {
            // Some actions may not be supported
        }
    }
}
