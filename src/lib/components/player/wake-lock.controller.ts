// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WakeLockController — wraps wake lock reacquisition and background playback management.
 *
 * Extracted from PlayerController to isolate power management concerns.
 */

import { requestWakeLock, setupWakeLockReacquisition, destroyWakeLock } from '$lib/utils/wake-lock';
import { setupBackgroundPlayback } from '$lib/utils/background-playback';
import { playerStore } from './playerStore.svelte';

export interface WakeLockControllerDeps {
    getVideoElement: () => HTMLVideoElement | undefined;
    isInitialized: () => boolean;
    reportProgress: (type: 'progress') => void;
    initializeHls: (url: string, startTime: number) => Promise<void>;
    log: (...args: unknown[]) => void;
    isAudioOnly: () => boolean;
}

export class WakeLockController {
    private cleanupWakeLock: (() => void) | null = null;
    private cleanupBackgroundPlayback: (() => void) | null = null;

    private readonly deps: WakeLockControllerDeps;

    constructor(deps: WakeLockControllerDeps) {
        this.deps = deps;
    }

    setup(): void {
        // Audio-only exists so the screen can go off — don't let visibility-driven or
        // background-resume reacquisition undo the suppression MediaSessionController applies.
        this.cleanupWakeLock = setupWakeLockReacquisition(
            () => playerStore.isPlaying && !this.deps.isAudioOnly(),
        );

        this.cleanupBackgroundPlayback = setupBackgroundPlayback({
            isPlaying: () => playerStore.isPlaying,
            getVideoElement: () => this.deps.getVideoElement() ?? null,
            onResume: (_timeInBackground: number) => {
                if (!this.deps.isAudioOnly()) {
                    requestWakeLock();
                }
            },
            onForeground: (timeInBackground: number) => {
                const LIVE_SESSION_TTL_MS = 30_000;
                if (playerStore.isLive && timeInBackground > LIVE_SESSION_TTL_MS) {
                    const liveUrl = playerStore.currentMediaSource?.transcodingUrl;
                    if (liveUrl) {
                        console.debug(
                            '[BackgroundPlayback] Live session may have expired — reloading stream',
                        );
                        void this.deps.initializeHls(liveUrl, 0);
                    }
                }
            },
            onBackground: () => {
                if (this.deps.isInitialized()) this.deps.reportProgress('progress');
            },
        });
    }

    destroy(): void {
        destroyWakeLock();
        if (this.cleanupWakeLock) {
            this.cleanupWakeLock();
            this.cleanupWakeLock = null;
        }
        if (this.cleanupBackgroundPlayback) {
            this.cleanupBackgroundPlayback();
            this.cleanupBackgroundPlayback = null;
        }
    }
}
