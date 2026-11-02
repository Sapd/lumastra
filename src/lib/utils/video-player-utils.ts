// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared video player utilities for YouTube trailers and video previews.
 * Used by HeroVideoPlayer and MediaHoverCard to avoid code duplication.
 */

import { browser } from '$app/environment';

// =========================================================================
// Types
// =========================================================================

export interface YouTubePlayerOptions {
    /** Container element ID to render the player into */
    containerId: string;
    /** YouTube video ID */
    videoId: string;
    /** Start time in seconds (default: 2) */
    startTime?: number;
    /** Initial mute state (default: true) */
    muted?: boolean;
    /** Callback when player is ready */
    onReady?: () => void;
    /** Callback when mute state changes (e.g., browser blocks unmute) */
    onMuteChange?: (muted: boolean) => void;
    /** Callback on error */
    onError?: (errorCode: number | string) => void;
    /** Callback the first time the video actually starts playing (state PLAYING) */
    onPlaying?: () => void;
}

export interface MuteState {
    isMuted: boolean;
    setMuted: (muted: boolean) => void;
}

/**
 * Typed handle for a YouTube IFrame API player instance.
 * Mirrors the methods actually used across HeroVideoPlayer and MediaHoverCard.
 */
export interface YouTubePlayer {
    playVideo: () => void;
    mute: () => void;
    unMute: () => void;
    setVolume: (volume: number) => void;
    getCurrentTime: () => number;
    destroy: () => void;
}

// =========================================================================
// Constants
// =========================================================================

export const MUTE_STORAGE_KEY = 'media-hover-muted';
export const VIDEO_DISABLED_STORAGE_KEY = 'featured-pick-video-disabled';

// =========================================================================
// YouTube IFrame API
// =========================================================================

let ytApiLoading = false;
const ytApiCallbacks: Array<() => void> = [];

/**
 * Ensures YouTube IFrame API is loaded. Calls callback when ready.
 */
export function ensureYouTubeApi(callback: () => void): void {
    if (!browser) return;

    // Already loaded
    if (window.YT && window.YT.Player) {
        callback();
        return;
    }

    // Queue callback
    ytApiCallbacks.push(callback);

    // Already loading, just wait
    if (ytApiLoading) return;

    // Start loading
    ytApiLoading = true;

    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';

    // Handle script load error
    tag.onerror = () => {
        ytApiLoading = false;
        ytApiCallbacks.length = 0; // Clear pending callbacks
    };

    const firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode?.insertBefore(tag, firstScriptTag);

    // Setup global callback
    const originalCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
        ytApiLoading = false;
        originalCallback?.();
        ytApiCallbacks.forEach((cb) => cb());
        ytApiCallbacks.length = 0;
    };

    // Timeout fallback - if API doesn't load in 10 seconds, clear callbacks
    setTimeout(() => {
        if (ytApiLoading) {
            ytApiLoading = false;
            ytApiCallbacks.length = 0;
        }
    }, 10000);
}

/**
 * Waits for YouTube API to be ready (polling fallback).
 */
export function waitForYouTubeApi(callback: () => void, timeoutMs = 5000): () => void {
    if (!browser) return () => {};

    if (window.YT && window.YT.Player) {
        callback();
        return () => {};
    }

    const startTime = Date.now();
    const checkInterval = setInterval(() => {
        if (window.YT && window.YT.Player) {
            clearInterval(checkInterval);
            callback();
        } else if (Date.now() - startTime > timeoutMs) {
            clearInterval(checkInterval);
        }
    }, 100);

    return () => clearInterval(checkInterval);
}

/**
 * Creates a YouTube player with standard settings for trailers/previews.
 * Returns the player instance.
 */
export function createYouTubePlayer(options: YouTubePlayerOptions): YouTubePlayer | null {
    if (!browser || !window.YT || !window.YT.Player) {
        return null;
    }

    const {
        containerId,
        videoId,
        startTime = 2,
        muted = true,
        onReady,
        onMuteChange,
        onError,
        onPlaying,
    } = options;
    let signalledPlaying = false;

    // Track unmute attempts for browser autoplay policy detection
    let attemptedUnmute = false;
    let unmuteTime = 0;

    const player = new window.YT.Player(containerId, {
        // Route the embed through the privacy-enhanced no-cookie domain so YouTube
        // does not set tracking cookies until the user actually starts playback.
        // (The iframe_api script itself must still load from www.youtube.com.)
        host: 'https://www.youtube-nocookie.com',
        videoId,
        playerVars: {
            autoplay: 1,
            mute: 1, // Must start muted for autoplay to work
            controls: 0,
            showinfo: 0,
            rel: 0,
            modestbranding: 1,
            playsinline: 1,
            start: startTime,
            loop: 1,
            playlist: videoId,
            // Strip remaining chrome that can flash before/around autoplay:
            // annotations, fullscreen button, keyboard, captions.
            iv_load_policy: 3,
            fs: 0,
            disablekb: 1,
            cc_load_policy: 0,
        },
        events: {
            onReady: () => {
                // Apply saved mute preference
                if (!muted && player) {
                    attemptedUnmute = true;
                    unmuteTime = Date.now();

                    player.unMute();

                    player.setVolume(50);
                }
                onReady?.();
            },
            onStateChange: (event: { data: number }) => {
                // State 1 = playing. Signal the first real playback so the caller
                // can cross-fade away its backdrop cover (which also hides the
                // brief YouTube chrome/title flash during load).
                if (event.data === 1 && !signalledPlaying) {
                    signalledPlaying = true;
                    onPlaying?.();
                }
                // State 2 = paused. If paused shortly after unmute attempt, browser blocked it
                if (event.data === 2 && attemptedUnmute && Date.now() - unmuteTime < 1000) {
                    // Browser blocked unmuted autoplay - mute and restart
                    attemptedUnmute = false;
                    if (player) {
                        player.mute();

                        player.playVideo();
                    }
                    // Notify parent that mute was forced
                    onMuteChange?.(true);
                }
            },
            onError: (event: unknown) => {
                const errorData =
                    event &&
                    typeof event === 'object' &&
                    'data' in event &&
                    typeof event.data === 'number'
                        ? event.data
                        : 'unknown';
                onError?.(errorData);
            },
        },
    });

    return player;
}

/**
 * Safely destroys a YouTube player and returns current time.
 */
export function destroyYouTubePlayer(player: YouTubePlayer | null): number | null {
    if (!player) return null;

    try {
        const currentTime = player.getCurrentTime();

        player.destroy();
        return typeof currentTime === 'number' ? currentTime : null;
    } catch {
        /* expected: player may already be destroyed or in an invalid state */
        return null;
    }
}

// =========================================================================
// Mute State Management
// =========================================================================

/**
 * Gets the saved mute preference from localStorage.
 * Defaults to muted (true) if not set.
 */
export function getSavedMuteState(): boolean {
    if (!browser) return true;
    return localStorage.getItem(MUTE_STORAGE_KEY) !== 'false';
}

/**
 * Saves mute preference to localStorage.
 */
export function saveMuteState(muted: boolean): void {
    if (!browser) return;
    localStorage.setItem(MUTE_STORAGE_KEY, String(muted));
}

/**
 * Gets the saved video disabled preference from localStorage.
 * Defaults to enabled (false) if not set.
 */
export function getSavedVideoDisabledState(): boolean {
    if (!browser) return false;
    return localStorage.getItem(VIDEO_DISABLED_STORAGE_KEY) === 'true';
}

/**
 * Saves video disabled preference to localStorage.
 */
export function saveVideoDisabledState(disabled: boolean): void {
    if (!browser) return;
    localStorage.setItem(VIDEO_DISABLED_STORAGE_KEY, String(disabled));
}

/**
 * Toggles mute on a YouTube player.
 * Returns the new mute state.
 */
export function toggleYouTubeMute(player: YouTubePlayer | null, currentlyMuted: boolean): boolean {
    if (!player) return currentlyMuted;

    try {
        if (currentlyMuted) {
            player.unMute();

            player.setVolume(50);
            return false;
        } else {
            player.mute();
            return true;
        }
    } catch {
        /* expected: YouTube player API may not be ready */
        return currentlyMuted;
    }
}

/**
 * Toggles mute on an HTML video element.
 * Returns the new mute state.
 */
export function toggleVideoElementMute(
    video: HTMLVideoElement | null,
    currentlyMuted: boolean,
): boolean {
    if (!video) return currentlyMuted;

    try {
        if (currentlyMuted) {
            video.muted = false;
            video.volume = 0.5;
            return false;
        } else {
            video.muted = true;
            return true;
        }
    } catch {
        /* expected: video element may be in a state where mute cannot be toggled */
        return currentlyMuted;
    }
}

// =========================================================================
// Resume Position Calculation
// =========================================================================

/**
 * Preview/resume position math now lives in `$lib/shared/preview-position` so
 * the SERVER can apply the identical heuristic for clients that don't compute
 * it themselves (tvOS via POST /api/v1/previews). Re-exported here so existing
 * client imports keep working — do not fork a second copy.
 */
export {
    calculateResumePosition,
    calculateSmartPreviewPosition,
    PREVIEW_FALLBACK_START_SECONDS,
} from '$lib/shared/preview-position';

// =========================================================================
// YouTube URL Parsing (re-export from utility)
// =========================================================================

/**
 * Extracts YouTube video ID from various URL formats.
 */
export function parseYouTubeId(url: string): string | false {
    const regExp = /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
    const match = url.match(regExp);
    return match && match[7].length === 11 ? match[7] : false;
}
