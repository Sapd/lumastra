// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * OSD (On-Screen Display) Indicators Manager
 *
 * Manages the state and timeouts for various on-screen indicators:
 * - Volume indicator (shown on volume change)
 * - Speed indicator (shown on playback speed change)
 * - Frame step indicator (shown when stepping through frames)
 * - Seek percent indicator (shown when seeking to a percentage)
 */

export interface VolumeIndicatorState {
    volume: number;
    isMuted: boolean;
}

export interface SpeedIndicatorState {
    speed: number;
}

export interface FrameStepIndicatorState {
    direction: 'forward' | 'backward';
}

export interface SeekPercentIndicatorState {
    percent: number;
}

export class OsdIndicatorStore {
    volumeIndicator = $state<VolumeIndicatorState | null>(null);
    volumeIndicatorKey = $state(0);
    speedIndicator = $state<SpeedIndicatorState | null>(null);
    speedIndicatorKey = $state(0);
    frameStepIndicator = $state<FrameStepIndicatorState | null>(null);
    frameStepIndicatorKey = $state(0);
    seekPercentIndicator = $state<SeekPercentIndicatorState | null>(null);
    seekPercentIndicatorKey = $state(0);

    // Private timer fields (not reactive)
    #volumeIndicatorTimeout: ReturnType<typeof setTimeout> | null = null;
    #speedIndicatorTimeout: ReturnType<typeof setTimeout> | null = null;
    #frameStepIndicatorTimeout: ReturnType<typeof setTimeout> | null = null;
    #seekPercentIndicatorTimeout: ReturnType<typeof setTimeout> | null = null;

    // Track animation timing for volume indicator
    #volumeIndicatorAnimationStart = 0;

    showVolumeIndicator(volume: number, isMuted: boolean): void {
        if (this.#volumeIndicatorTimeout) {
            clearTimeout(this.#volumeIndicatorTimeout);
        }

        const now = Date.now();
        const wasHidden = this.volumeIndicator === null;
        const animationNeedsRestart = wasHidden || now - this.#volumeIndicatorAnimationStart > 1000;

        if (animationNeedsRestart) {
            this.#volumeIndicatorAnimationStart = now;
            this.volumeIndicatorKey += 1;
        }

        this.volumeIndicator = { volume, isMuted };

        // Hide after animation completes (1.5s)
        this.#volumeIndicatorTimeout = setTimeout(() => {
            this.volumeIndicator = null;
        }, 1500);
    }

    showSpeedIndicator(speed: number): void {
        if (this.#speedIndicatorTimeout) {
            clearTimeout(this.#speedIndicatorTimeout);
        }

        this.speedIndicator = { speed };
        this.speedIndicatorKey += 1;

        this.#speedIndicatorTimeout = setTimeout(() => {
            this.speedIndicator = null;
        }, 1200);
    }

    showFrameStepIndicator(direction: 'forward' | 'backward'): void {
        if (this.#frameStepIndicatorTimeout) {
            clearTimeout(this.#frameStepIndicatorTimeout);
        }

        this.frameStepIndicator = { direction };
        this.frameStepIndicatorKey += 1;

        this.#frameStepIndicatorTimeout = setTimeout(() => {
            this.frameStepIndicator = null;
        }, 1200);
    }

    showSeekPercentIndicator(percent: number): void {
        if (this.#seekPercentIndicatorTimeout) {
            clearTimeout(this.#seekPercentIndicatorTimeout);
        }

        this.seekPercentIndicator = { percent };
        this.seekPercentIndicatorKey += 1;

        this.#seekPercentIndicatorTimeout = setTimeout(() => {
            this.seekPercentIndicator = null;
        }, 1200);
    }

    destroy(): void {
        if (this.#volumeIndicatorTimeout) {
            clearTimeout(this.#volumeIndicatorTimeout);
            this.#volumeIndicatorTimeout = null;
        }
        if (this.#speedIndicatorTimeout) {
            clearTimeout(this.#speedIndicatorTimeout);
            this.#speedIndicatorTimeout = null;
        }
        if (this.#frameStepIndicatorTimeout) {
            clearTimeout(this.#frameStepIndicatorTimeout);
            this.#frameStepIndicatorTimeout = null;
        }
        if (this.#seekPercentIndicatorTimeout) {
            clearTimeout(this.#seekPercentIndicatorTimeout);
            this.#seekPercentIndicatorTimeout = null;
        }
    }
}

/**
 * Creates an OSD indicator store for use in Svelte components
 */
export function createOsdIndicatorStore(): OsdIndicatorStore {
    return new OsdIndicatorStore();
}
