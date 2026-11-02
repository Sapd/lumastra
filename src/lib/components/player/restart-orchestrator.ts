// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Restart Orchestrator
 *
 * Consolidates the common "stop → reinitialize → restore position" pattern
 * used when restarting playback for bitrate changes, seeking, or version changes.
 *
 * Note: Quality switch (restartStreamWithNewQuality) has a complex two-phase
 * cleanup pattern and is NOT handled by this orchestrator.
 */

import { createPositionRestoreHandler } from './playback-restart';

/**
 * Restart scenario types (excluding quality_switch which is too complex)
 */
export type RestartScenario =
    | 'bitrate_change' // Adaptive bitrate adjustment
    | 'seek_position' // Seek beyond buffered (DirectStream → HLS)
    | 'version_change'; // Media source/version change

/**
 * Timing constants for restart operations
 */
export const RESTART_TIMING = {
    /** Wait for Jellyfin to clean up old session */
    SESSION_CLEANUP_MS: 500,
    /** Position restore timeout */
    RESTORE_TIMEOUT_MS: 10000,
    /** Position tolerance for considering restore complete */
    POSITION_TOLERANCE_S: 1,
} as const;

/**
 * Common context needed for all restart scenarios
 * Note: setVideoTime uses 'unknown' for source to be compatible with SeekSource in VideoPlayer
 */
export interface RestartContext {
    videoElement: HTMLVideoElement | null;
    currentPosition: number;
    log: (...args: unknown[]) => void;
    setVideoTime: (time: number, source: string) => void;
    finishRestart: (reinitSubtitles?: boolean) => void;
}

/**
 * Callbacks for stopping current playback
 */
export interface StopPlaybackCallbacks {
    destroyPlaybackManager: () => void;
    clearVideoSource: () => void;
}

/**
 * Callbacks for session management
 */
export interface SessionCallbacks {
    endCurrentSession: () => Promise<void>;
    generateNewSessionId: () => string;
    setPlaySessionId: (id: string) => void;
    hasActiveSession: () => boolean;
}

/**
 * Callbacks for UI state
 */
export interface UICallbacks {
    setLoading: (loading: boolean) => void;
    setSeeking?: (seeking: boolean) => void;
    setCurrentTime?: (time: number) => void;
    /**
     * Drives a top-of-screen "switching version" progress bar for the lifetime
     * of a version-change restart. Set true at teardown, false once playback
     * has resumed at the restored position (or on error). Optional; only
     * restartForVersionChange currently wires it.
     */
    setVersionSwitching?: (active: boolean) => void;
}

/**
 * Result from a restart operation
 */
export interface RestartResult {
    success: boolean;
    error?: string;
    /** Cleanup function to cancel pending position restore (call on unmount or new restart) */
    cleanup?: () => void;
}

/**
 * Execute a bitrate change restart
 *
 * Flow:
 * 1. End current session (flush telemetry)
 * 2. Destroy playback
 * 3. Generate new session ID
 * 4. Wait for Jellyfin cleanup
 * 5. Build URL and initialize HLS
 * 6. Restore position
 */
export async function restartForBitrateChange(
    ctx: RestartContext,
    stop: StopPlaybackCallbacks,
    session: SessionCallbacks,
    ui: UICallbacks,
    buildStreamUrl: (forceTranscode: boolean, position: number) => string | Promise<string>,
    initializeHls: (url: string, position: number) => Promise<void>,
    clearAdaptiveSamples: () => void,
    opts: {
        autoResume?: boolean | (() => boolean);
        isCancelled?: () => boolean;
        getRestorePosition?: () => number;
    } = {},
): Promise<RestartResult> {
    const { videoElement, currentPosition, log, setVideoTime, finishRestart } = ctx;

    const cancelIfNeeded = (): RestartResult | undefined => {
        if (!opts.isCancelled?.()) return undefined;
        // Initialization may have completed after the recovery budget expired.
        // Abort that late source too, without installing a position/auto-play
        // handler or changing the stored resume position.
        try {
            stop.destroyPlaybackManager();
            stop.clearVideoSource();
        } finally {
            finishRestart();
        }
        return { success: false, error: 'Playback recovery canceled' };
    };

    try {
        // End current session
        await session.endCurrentSession();
        const canceledAfterSession = cancelIfNeeded();
        if (canceledAfterSession) return canceledAfterSession;

        // Destroy playback
        stop.destroyPlaybackManager();
        stop.clearVideoSource();

        // Update position in store
        ui.setCurrentTime?.(currentPosition);

        // Generate new session
        const newSessionId = session.generateNewSessionId();
        session.setPlaySessionId(newSessionId);
        log(' New PlaySessionId:', newSessionId);

        // Wait for Jellyfin cleanup
        await sleep(RESTART_TIMING.SESSION_CLEANUP_MS);
        const canceledBeforeLoad = cancelIfNeeded();
        if (canceledBeforeLoad) return canceledBeforeLoad;

        // Clear adaptive samples
        clearAdaptiveSamples();

        // Build new URL
        const newUrl = await buildStreamUrl(false, currentPosition);
        if (!newUrl) {
            finishRestart();
            return { success: false, error: 'Failed to build stream URL' };
        }

        log(' New stream URL:', newUrl.replace(/grant=[^&]+/g, 'grant=***'));

        // Start HLS
        await initializeHls(newUrl, currentPosition);
        const canceledAfterLoad = cancelIfNeeded();
        if (canceledAfterLoad) return canceledAfterLoad;

        // Restore position
        let cleanup: (() => void) | undefined;
        if (videoElement) {
            const handler = createPositionRestoreHandler(
                videoElement,
                {
                    targetPosition: opts.getRestorePosition ?? currentPosition,
                    autoResume: opts.autoResume ?? false,
                    toleranceSeconds: RESTART_TIMING.POSITION_TOLERANCE_S,
                    timeoutMs: RESTART_TIMING.RESTORE_TIMEOUT_MS,
                    onRestored: () => finishRestart(true),
                },
                log,
                setVideoTime,
            );
            cleanup = handler.cleanup;
        } else {
            // No video element => no canplay handler => finishRestart would never
            // fire, leaving isRestartingPlayback locked forever — which now (with
            // the hls.js onError suppress gate) would swallow ALL future errors.
            // Flush the restart gate here so the player isn't left wedged.
            finishRestart(true);
        }

        return { success: true, cleanup };
    } catch (error) {
        console.error('[RestartOrchestrator] Bitrate change error:', error);
        finishRestart(true);
        return { success: false, error: String(error) };
    }
}

/**
 * Execute a seek position restart (DirectStream → HLS)
 *
 * Flow:
 * 1. Show loading/seeking indicators
 * 2. End session if exists, generate new ID
 * 3. Destroy playback
 * 4. Initialize with HLS (forceHls=true)
 * 5. Restore position with timeout
 */
export async function restartForSeekPosition(
    ctx: RestartContext,
    stop: StopPlaybackCallbacks,
    session: SessionCallbacks,
    ui: UICallbacks & { setSeeking: (seeking: boolean) => void },
    initializePlayback: (
        forceTranscode: boolean,
        position: number,
        forceHls: boolean,
    ) => Promise<void>,
): Promise<RestartResult> {
    const { videoElement, currentPosition, log, setVideoTime, finishRestart } = ctx;

    ui.setLoading(true);
    ui.setSeeking(true);

    const clearState = () => {
        finishRestart(true);
        ui.setLoading(false);
        ui.setSeeking(false);
    };

    try {
        // End session if exists
        if (session.hasActiveSession()) {
            await session.endCurrentSession();
            const newSessionId = session.generateNewSessionId();
            session.setPlaySessionId(newSessionId);
        }

        // Destroy playback
        stop.destroyPlaybackManager();
        stop.clearVideoSource();

        // Switch to HLS
        log(' Switching to HLS for seeking');
        await initializePlayback(false, currentPosition, true);

        // Restore position with timeout
        let cleanup: (() => void) | undefined;
        if (videoElement) {
            const handler = createPositionRestoreHandler(
                videoElement,
                {
                    targetPosition: currentPosition,
                    autoResume: false,
                    toleranceSeconds: RESTART_TIMING.POSITION_TOLERANCE_S,
                    timeoutMs: RESTART_TIMING.RESTORE_TIMEOUT_MS,
                    onRestored: clearState,
                },
                log,
                (time, _source) => setVideoTime(time, 'hls_seek'),
            );
            cleanup = handler.cleanup;
        } else {
            // No video element => no canplay handler => clearState (this path's
            // restart-gate release) would never fire, wedging isRestartingPlayback.
            clearState();
        }

        return { success: true, cleanup };
    } catch (error) {
        console.error('[RestartOrchestrator] Seek position error:', error);
        clearState();
        return { success: false, error: String(error) };
    }
}

/**
 * Execute a version change restart
 *
 * Flow:
 * 1. Destroy playback (no session end needed)
 * 2. Build new URL
 * 3. Initialize with Direct Play or HLS
 * 4. Restore position
 */
export async function restartForVersionChange(
    ctx: RestartContext,
    stop: StopPlaybackCallbacks,
    ui: UICallbacks,
    buildStreamUrl: (forceTranscode: boolean, position: number) => string | Promise<string>,
    initializeDirectPlay: (url: string) => void,
    initializeHls: (url: string, position: number) => Promise<void>,
    canDirectPlay: () => boolean,
    resolveStartedPosition?: (requestedPosition: number) => number,
): Promise<RestartResult> {
    const { videoElement, currentPosition, log, setVideoTime, finishRestart } = ctx;

    let cleanup: (() => void) | undefined;

    // Show the top progress bar for the whole teardown → restore window.
    ui.setVersionSwitching?.(true);

    try {
        // Pin store playhead to target so the seek bar can't briefly read 0
        // while the video element is detached/re-attaching.
        ui.setCurrentTime?.(currentPosition);

        // Destroy playback
        stop.destroyPlaybackManager();
        stop.clearVideoSource();

        // Build new URL
        const newUrl = await buildStreamUrl(false, currentPosition);
        if (!newUrl) {
            ui.setVersionSwitching?.(false);
            finishRestart(true);
            return { success: false, error: 'Failed to build stream URL' };
        }

        // A granted stream may start at an issued window offset different
        // from the logical position used to request it. Let the caller map
        // that logical request onto the started delivery before restoring.
        const startedPosition = resolveStartedPosition
            ? resolveStartedPosition(currentPosition)
            : currentPosition;
        if (resolveStartedPosition) ui.setCurrentTime?.(startedPosition);

        log(' Version change restart', {
            position: startedPosition.toFixed(2) + 's',
        });

        // Set up position restore. Must be registered BEFORE initialize* so the
        // loadedmetadata/canplay events can't race ahead of the listeners.
        if (videoElement) {
            const handler = createPositionRestoreHandler(
                videoElement,
                {
                    targetPosition: startedPosition,
                    autoResume: false,
                    timeoutMs: RESTART_TIMING.RESTORE_TIMEOUT_MS,
                    onRestored: () => {
                        ui.setVersionSwitching?.(false);
                        finishRestart(true);
                    },
                },
                log,
                setVideoTime,
            );
            cleanup = handler.cleanup;
        }

        ui.setLoading(true);

        // Initialize with appropriate method
        if (canDirectPlay()) {
            log(' Restarting with Direct Play');
            initializeDirectPlay(newUrl);
        } else {
            log(' Restarting with HLS');
            await initializeHls(newUrl, startedPosition);
        }

        // No video element => no canplay handler => finishRestart would never
        // fire. Flush the restart gate here so the player isn't left locked.
        if (!videoElement) {
            ui.setVersionSwitching?.(false);
            finishRestart(true);
        }

        return { success: true, cleanup };
    } catch (error) {
        console.error('[RestartOrchestrator] Version change error:', error);
        // Tear down the canplay listener so a later restart's canplay can't
        // trigger this one's onRestored with a stale target position.
        cleanup?.();
        ui.setVersionSwitching?.(false);
        finishRestart(true);
        return { success: false, error: String(error) };
    }
}

// Utility
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
