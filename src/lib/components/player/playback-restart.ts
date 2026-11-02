// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Playback Restart Helpers
 *
 * Consolidates common patterns used when restarting video playback:
 * - Quality changes
 * - Bitrate adaptation
 * - Seeking beyond buffer (DirectStream fallback)
 * - Media source changes
 */

import { safeRandomUUID } from '$lib/utils/safe-uuid';

/**
 * Options for position restore handler
 */
export interface PositionRestoreOptions<TSource extends string = string> {
    targetPosition: number | (() => number);
    autoResume: boolean | (() => boolean);
    seekSource?: TSource;
    onRestored?: () => void;
    toleranceSeconds?: number | (() => number);
    timeoutMs?: number;
}

/**
 * Clears the video element source and resets it.
 * This is a common pattern when switching streams.
 */
export function clearVideoSource(videoElement: HTMLVideoElement | null): void {
    if (!videoElement) return;
    videoElement.pause();
    videoElement.removeAttribute('src');
    videoElement.load();
}

/**
 * Values to reset after destroying telemetry.
 * These track native HLS rebuffer state.
 */
export interface TelemetryResetValues {
    nativeRebufferStartTime: null;
    seekStartPosition: null;
    hasNativePlaybackStarted: false;
    lastNativeSeekTime: 0;
}

/**
 * Creates the reset values for telemetry tracking variables.
 */
export function createTelemetryResetValues(): TelemetryResetValues {
    return {
        nativeRebufferStartTime: null,
        seekStartPosition: null,
        hasNativePlaybackStarted: false,
        lastNativeSeekTime: 0,
    };
}

/**
 * Generates a new play session ID (32-character hex string).
 * Jellyfin uses this to track transcoding sessions.
 */
export function generatePlaySessionId(): string {
    return safeRandomUUID();
}

/**
 * Creates a position restore handler that seeks the video to a target
 * position after a stream restart and resolves once playback is ready.
 *
 * Two-stage design:
 *   1. loadedmetadata (or canplay — whichever comes first) — seek
 *      `video.currentTime` to `targetPosition` if needed.  This MUST run
 *      before canplay can fire when HLS.js started loading at a non-zero
 *      `startPosition`: the video element's currentTime is 0 after MSE
 *      attach, buffer is at the target position, and `canplay` requires
 *      buffered data at currentTime — so it would never fire without the
 *      seek.
 *   2. canplay — call `onRestored` so the controller can clear the
 *      restart gate.  A loadedmetadata-only resolution would claim
 *      success before playback is actually ready.
 *
 * Returns a cleanup function to remove the listeners.
 */
export function createPositionRestoreHandler<TSource extends string = string>(
    videoElement: HTMLVideoElement,
    options: PositionRestoreOptions<TSource>,
    log: (...args: unknown[]) => void,
    setVideoTime: (time: number, source: TSource) => void,
): { cleanup: () => void; timeoutId?: ReturnType<typeof setTimeout> } {
    const {
        targetPosition,
        autoResume,
        seekSource = 'restore_position' as TSource,
        onRestored,
        toleranceSeconds = 2,
        timeoutMs,
    } = options;

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let seekedTarget: number | null = null;
    let hasResolved = false;

    const seekIfNeeded = () => {
        const target = typeof targetPosition === 'function' ? targetPosition() : targetPosition;
        const tolerance =
            typeof toleranceSeconds === 'function' ? toleranceSeconds() : toleranceSeconds;
        // Once per target: a seek that landed off-target (clamp, segment snap) must not
        // be re-issued on canplay, or the server spawns another seek generation.
        if (seekedTarget === target) return;
        seekedTarget = target;
        if (Math.abs(videoElement.currentTime - target) > tolerance) {
            log(' Restoring position to:', target);
            setVideoTime(target, seekSource);
        }
    };

    const resolve = () => {
        if (hasResolved) return;
        hasResolved = true;
        if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = undefined;
        }
        if (typeof autoResume === 'function' ? autoResume() : autoResume) {
            videoElement.play().catch(console.error);
        }
        onRestored?.();
        detachAll();
    };

    const onLoadedMetadata = () => {
        // loadedmetadata fires as soon as MSE has duration — BEFORE any
        // frames are available at currentTime=0. Seek now so the video
        // element is positioned where HLS.js has (or is about to append)
        // buffer, unsticking the pipeline.
        if (videoElement.readyState >= 1) {
            seekIfNeeded();
        }
    };

    const onCanPlay = () => {
        // canplay fires once the element has enough data at currentTime to
        // play. If we hadn't seeked yet (e.g. buffer was already at 0 for
        // direct play), fall through to seek + resolve in one shot.
        if (videoElement.readyState >= 2) {
            seekIfNeeded();
            resolve();
        }
    };

    const detachAll = () => {
        videoElement.removeEventListener('loadedmetadata', onLoadedMetadata);
        videoElement.removeEventListener('canplay', onCanPlay);
    };

    videoElement.addEventListener('loadedmetadata', onLoadedMetadata);
    videoElement.addEventListener('canplay', onCanPlay);

    if (timeoutMs) {
        timeoutId = setTimeout(() => {
            if (hasResolved) return;
            log(' Timeout fallback: forcing restart resolution');
            // Ensure the seek still runs if loadedmetadata never fired.
            seekIfNeeded();
            resolve();
        }, timeoutMs);
    }

    return {
        cleanup: () => {
            detachAll();
            if (timeoutId) clearTimeout(timeoutId);
        },
        timeoutId,
    };
}
