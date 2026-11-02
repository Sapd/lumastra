// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MediaSessionController — wraps the Media Session API setup and state updates.
 *
 * Extracted from PlayerController to isolate media session concerns.
 */

import { isEpisode as isEpisodeType } from '$lib/shared/media-types';
import { getCatalogBackdropUrl } from '$lib/utils/image-utils';
import {
    initMediaSession,
    updateMediaSessionPlaybackState,
    updateMediaSessionPositionState,
    clearMediaSession,
} from '$lib/utils/media-session';
import { requestWakeLock, releaseWakeLock } from '$lib/utils/wake-lock';
import { getBackdropArtworkId } from './backdrop-artwork';
import type { PlaybackInfo } from '$lib/types/playback';

export interface MediaSessionControllerDeps {
    getVideoElement: () => HTMLVideoElement | undefined;
    seekTo: (time: number) => void;
    onPlay: () => void;
    onPause: () => void;
    onStop: () => void;
    onNextTrack: (() => void) | undefined;
    hasWatchPartyGuestRestrictions: () => boolean;
    handlePlayError: (e: Error) => void;
    isAudioOnly: () => boolean;
}

export class MediaSessionController {
    readonly deps: MediaSessionControllerDeps;

    constructor(deps: MediaSessionControllerDeps) {
        this.deps = deps;
    }

    setup(playbackInfo: PlaybackInfo): void {
        const isEpisode = isEpisodeType(playbackInfo.mediaType);
        const artworkId = getBackdropArtworkId(playbackInfo);
        const metadata = {
            title: playbackInfo.title,
            artist: isEpisode ? playbackInfo.seriesName : undefined,
            album:
                isEpisode && playbackInfo.seasonNumber
                    ? `Season ${playbackInfo.seasonNumber}`
                    : undefined,
            artwork: getCatalogBackdropUrl(artworkId, { size: 'card' }),
        };

        initMediaSession(metadata, {
            onPlay: () => {
                if (this.deps.hasWatchPartyGuestRestrictions()) return;
                // Delegate like onPause: in a watch party the player must send the
                // party sync, or the host would play (or stay paused) alone.
                this.deps.onPlay();
            },
            onPause: () => {
                if (this.deps.hasWatchPartyGuestRestrictions()) return;
                // Media keys, headset controls, lock-screen controls, and OS
                // "Now Playing" surfaces are explicit user pauses. Delegate to
                // the player controller so it records that intent and disarms
                // reconnect before pausing the element.
                this.deps.onPause();
            },
            onSeekBackward: (offset = 10) => {
                const video = this.deps.getVideoElement();
                if (video) {
                    this.deps.seekTo(Math.max(0, video.currentTime - offset));
                }
            },
            onSeekForward: (offset = 10) => {
                const video = this.deps.getVideoElement();
                if (video) {
                    this.deps.seekTo(Math.min(video.duration, video.currentTime + offset));
                }
            },
            onSeekTo: (time) => {
                this.deps.seekTo(time);
            },
            onStop: () => {
                this.deps.onStop();
            },
            onNextTrack: this.deps.onNextTrack,
            onPreviousTrack: undefined,
        });
    }

    updatePlaybackState(state: 'playing' | 'paused'): void {
        updateMediaSessionPlaybackState(state);
        this.syncWakeLock(state === 'playing');
    }

    /**
     * Re-evaluate the screen wake lock without touching the OS playback state.
     *
     * Needed because the audio-only decision is made HERE, but the thing that
     * changes it (the quality mode) changes elsewhere. `updatePlaybackState` is
     * normally driven by onPlay()/onPause(), and onPlay() is suppressed for the
     * whole restart window of a quality switch — so crossing back from
     * audio-only to video never re-acquired the lock and the screen slept during
     * ordinary video playback. The player calls this on the mode crossing.
     */
    syncWakeLock(isPlaying: boolean): void {
        // Audio-only exists so the screen can go off. A screen wake lock would defeat
        // the purpose and drain the battery.
        if (isPlaying && !this.deps.isAudioOnly()) {
            requestWakeLock();
        } else {
            releaseWakeLock();
        }
    }

    updatePositionState(duration: number, currentTime: number, playbackRate: number): void {
        updateMediaSessionPositionState(duration, currentTime, playbackRate);
    }

    clear(): void {
        clearMediaSession();
    }
}
