// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { browser } from '$app/environment';

/**
 * Background Playback Utility
 * Handles auto-resume when PWA returns from background on mobile
 */

interface BackgroundPlaybackConfig {
    onResume: (timeInBackground: number) => void;
    onBackground: () => void;
    isPlaying: () => boolean;
    getVideoElement: () => HTMLVideoElement | null;
    /**
     * Called unconditionally whenever the tab returns to the foreground,
     * regardless of whether the video was playing or how long it was backgrounded.
     * Use this for session-level recovery that must happen on every foreground event.
     */
    onForeground?: (timeInBackground: number) => void;
}

let config: BackgroundPlaybackConfig | null = null;
let wasPlayingBeforeBackground = false;
let backgroundedAt: number | null = null;

// Maximum time in background before we don't auto-resume (5 minutes)
const MAX_BACKGROUND_TIME_MS = 5 * 60 * 1000;

/**
 * Setup background playback handling
 * - Tracks if user was playing before going to background
 * - Auto-resumes when returning to foreground (if within time limit)
 */
export function setupBackgroundPlayback(cfg: BackgroundPlaybackConfig): () => void {
    if (!browser) {
        return () => {};
    }

    config = cfg;

    const handleVisibilityChange = () => {
        if (document.visibilityState === 'hidden') {
            // Going to background
            wasPlayingBeforeBackground = config?.isPlaying() ?? false;
            backgroundedAt = Date.now();

            if (wasPlayingBeforeBackground) {
                console.debug('[BackgroundPlayback] Went to background while playing');
                config?.onBackground();
            }
        } else if (document.visibilityState === 'visible') {
            // Returning from background
            const timeInBackground = backgroundedAt ? Date.now() - backgroundedAt : 0;

            // Always fire onForeground — callers use this for unconditional
            // session recovery (e.g. live TV heartbeat session)
            config?.onForeground?.(timeInBackground);

            if (wasPlayingBeforeBackground && timeInBackground < MAX_BACKGROUND_TIME_MS) {
                console.debug('[BackgroundPlayback] Returning from background, auto-resuming...');

                // Small delay to let the browser settle
                setTimeout(() => {
                    const video = config?.getVideoElement();
                    if (video && video.paused) {
                        video
                            .play()
                            .then(() => {
                                console.debug('[BackgroundPlayback] Auto-resumed successfully');
                                config?.onResume(timeInBackground);
                            })
                            .catch((error) => {
                                // Play was prevented (user interaction required)
                                const errorName =
                                    error instanceof Error ? error.name : 'UnknownError';
                                console.debug(
                                    '[BackgroundPlayback] Auto-resume blocked:',
                                    errorName,
                                );
                            });
                    }
                }, 100);
            }

            wasPlayingBeforeBackground = false;
            backgroundedAt = null;
        }
    };

    // Also handle page freeze/resume for aggressive iOS power management
    const handleFreeze = () => {
        wasPlayingBeforeBackground = config?.isPlaying() ?? false;
        backgroundedAt = Date.now();
        console.debug('[BackgroundPlayback] Page frozen');
    };

    const handleResume = () => {
        const timeInBackground = backgroundedAt ? Date.now() - backgroundedAt : 0;

        if (wasPlayingBeforeBackground && timeInBackground < MAX_BACKGROUND_TIME_MS) {
            console.debug('[BackgroundPlayback] Page resumed, attempting playback...');
            setTimeout(() => {
                const video = config?.getVideoElement();
                if (video && video.paused) {
                    video.play().catch(() => {
                        /* Autoplay may be blocked by browser - this is expected */
                    });
                }
            }, 100);
        }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('freeze', handleFreeze);
    document.addEventListener('resume', handleResume);

    return () => {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        document.removeEventListener('freeze', handleFreeze);
        document.removeEventListener('resume', handleResume);
        config = null;
    };
}

/**
 * Check if we're currently in background
 */
export function isInBackground(): boolean {
    return browser ? document.visibilityState === 'hidden' : false;
}

export interface SilentKeepaliveOptions {
    audioContext?: AudioContext;
}

/**
 * For iOS: Create a silent audio context to keep the audio session alive
 * This can help prevent the OS from killing the app as quickly
 * Note: This has battery implications
 */
export function createSilentAudioKeepalive(options: SilentKeepaliveOptions = {}): {
    start: () => void;
    stop: () => void;
} {
    if (!browser) {
        return { start: () => {}, stop: () => {} };
    }

    let audioContext: AudioContext | null = options.audioContext ?? null;
    const externalContext = audioContext !== null;
    let oscillator: OscillatorNode | null = null;
    let gainNode: GainNode | null = null;

    return {
        start: () => {
            if (oscillator) return;

            try {
                if (!audioContext) {
                    audioContext = new AudioContext();
                }
                oscillator = audioContext.createOscillator();
                gainNode = audioContext.createGain();

                // Set gain to 0 (silent)
                gainNode.gain.value = 0;

                oscillator.connect(gainNode);
                gainNode.connect(audioContext.destination);
                oscillator.start();

                console.debug('[BackgroundPlayback] Silent audio keepalive started');
            } catch (error) {
                console.debug('[BackgroundPlayback] Failed to create silent audio:', error);
            }
        },
        stop: () => {
            if (oscillator) {
                oscillator.stop();
                oscillator.disconnect();
                oscillator = null;
            }
            if (gainNode) {
                gainNode.disconnect();
                gainNode = null;
            }
            if (audioContext && !externalContext) {
                void audioContext.close();
                audioContext = null;
            }
            console.debug('[BackgroundPlayback] Silent audio keepalive stopped');
        },
    };
}
