// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/* eslint-disable svelte/no-navigation-without-resolve -- This file uses resolve() from $lib/paths which wraps $app/paths.resolve() */
/**
 * Watch Together Event Handlers
 *
 * Manages Watch Together (synchronized playback) event handling:
 * - Sync events (play/pause/position sync)
 * - Seek events
 * - Navigation events
 * - Buffer coordination
 * - Participant notifications
 * - Hybrid sync strategy (deadzone/catch-up/hard-seek)
 * - Web Worker timers for background tab resilience
 * - Visibility change handling for instant recovery
 *
 * Decoupled from VideoPlayer component via VideoController interface.
 */

import { browser } from '$app/environment';
import { goto } from '$app/navigation';
import { resolve } from '$lib/paths';
import type { WatchTogetherStore } from '$lib/stores/watchTogether.svelte';
import { WorkerTimer } from '$lib/utils/worker-timer';
import { CATCHUP_CHECK_INTERVAL_MS } from '$lib/types/watch-together';
import { AdaptiveDriftCompensator } from './adaptive-drift-compensator';

// ============================================================================
// Adaptive Sync Constants
// ============================================================================

/** Hard seek threshold: Force seek for drift above this (seconds) */
const SYNC_HARD_SEEK_THRESHOLD = 3.0;
/** Resolve a delayed Play from its first moving host sample instead of a long rate chase. */
const STARTUP_HARD_SEEK_THRESHOLD = 1.0;
/**
 * After a host tab is unfrozen, how long heartbeats stay held while it catches up
 * (freezeCatchUpTarget, then a local seek + play): long enough for the seek to land
 * and playback to restart, so no heartbeat reports the frozen position or the pause.
 */
const FREEZE_CATCH_UP_MS = 8_000;

/** Seek latency compensation: Overshoot target by this amount to land closer after seek completes */
const SEEK_LATENCY_OFFSET = 0.25;

/** Position tolerance when verifying a barrier target. */
const POSITION_TOLERANCE_SECONDS = 0.75;

/** Poll cadence while a slow HLS reset is restoring the barrier target. */
const RESUME_TARGET_POLL_INTERVAL_MS = 100;

/**
 * How long the resume poll waits for the local media to reach the barrier
 * target before resuming anyway. Mirrors the barrier poll's own wait cap: a
 * playhead that never lands (HLS source rebuild, a target this media cannot
 * reach) must not strand the guest paused forever, because by this point the
 * barrier is over — the store cleared isSyncing, no watchdog is armed, and
 * catch-up sync refuses to run outside the 'synced' phase. Resuming slightly
 * off-target is recoverable; a silently paused guest is not.
 */
const RESUME_TARGET_MAX_WAIT_MS = 8000;

/**
 * WebKit can leave the play() promise pending while the element is already
 * playing, so starts are also recognised from the element itself (polled, and
 * again before a deadline pauses): unpaused and the playhead moved forward
 * since play() was called.
 */
const START_POLL_INTERVAL_MS = 250;
function playbackAdvancedSince(controller: VideoController, startedAt: number): boolean {
    return !controller.isPaused() && controller.getCurrentTime() > startedAt + 0.25;
}

// ============================================================================
// Types
// ============================================================================

/**
 * Interface for controlling video playback.
 * Allows Watch Together handlers to be decoupled from VideoPlayer component.
 */
export interface VideoController {
    /** Get current playback time in seconds */
    getCurrentTime(): number;
    /** Seek to a specific time */
    seekTo(time: number, source: string): void;
    /** Play the video */
    play(): Promise<void>;
    /** Pause the video */
    pause(): void;
    /** Check if video is paused */
    isPaused(): boolean;
    /** Get current playback rate */
    getPlaybackRate(): number;
    /** Set playback rate */
    setPlaybackRate(rate: number): void;
    /** Get buffered time ranges */
    getBuffered(): TimeRanges | null;
    /** Get ready state */
    getReadyState(): number;
    /** Check if video element exists */
    isReady(): boolean;
    /**
     * True only when the element actually has a media source attached. Distinct
     * from isReady(): a source-cleared element (mid episode/version switch) still
     * exists but has an empty currentSrc. Position-REPORTING paths gate on this;
     * position-APPLYING handlers keep using isReady().
     */
    hasLiveSource(): boolean;
}

export interface WatchTogetherHandlersConfig {
    /** Current item ID being played */
    getItemId: () => string;
    /** Check if current user is host */
    isHost: () => boolean;
    /** Show toast notification */
    showToast?: (
        type: 'join' | 'version' | 'leave' | 'seek' | 'pause' | 'play' | 'stall' | 'disband',
        userId: string,
        displayName?: string,
    ) => void;
    /** Called when playback rate changes from sync */
    onPlaybackRateChange?: (rate: number) => void;
    /** Handle play errors */
    onPlayError?: (error: Error) => void;
    /**
     * Whether the current pause is the USER's (lock screen, headset, OS media
     * controls). Such a pause sends no party sync, so without this a background
     * user pause would look like a browser suspension and be "caught up" (resumed).
     */
    isPausedByUser?: () => boolean;
    /** Live TV: there is no position to catch up to. */
    isLive?: () => boolean;
    /** A source replacement owns readiness and must not publish its temporary clock. */
    isSourceReplacing?: () => boolean;
    /** Retarget a retained player after a canonical same-item timeline changes. */
    onPlaybackBindingChanged?: () => void;
    /** Debug logging */
    log?: (...args: unknown[]) => void;
}

export interface WatchTogetherHandlersState {
    /** Whether initial sync has been applied (for guests) */
    hasAppliedInitialSync: boolean;
    /** Item ID being navigated to (prevents race conditions) */
    navigatingToItemId: string | null;
}

// ============================================================================
// Protocol Phase State Machine
// ============================================================================

/**
 * Exclusive resync phase of the watch-together protocol.
 *
 * synced ──buffer_check──▶ buffer_check ──all_ready(playing)──▶ resuming ──timer──▶ synced
 *   ▲                            │
 *   └──── all_ready(paused) ─────┘
 *
 * Any phase can be superseded by a NEW buffer_check (rapid host seeks). The
 * phase owns its resources: `resuming` owns the scheduled play() timer (exit
 * cancels it), `buffer_check` carries the generation its poll loop checks.
 *
 * NOTE: the group-stall condition is deliberately NOT a phase. A stall event
 * can legitimately arrive in the middle of a buffer check (they are separate
 * server mechanisms), so it is modeled as an orthogonal overlay — forcing
 * exclusivity here is exactly what made the tvOS client drop all_ready events.
 */
type ResyncPhase =
    | { kind: 'synced' }
    | {
          kind: 'buffer_check';
          checkId: string;
          generation: number;
          targetTime: number;
          requireTargetMatch: boolean;
      }
    | {
          kind: 'resuming';
          checkId: string;
          generation: number;
          targetTime: number;
          requireTargetMatch: boolean;
          timer: ReturnType<typeof setTimeout>;
      };

// ============================================================================
// Watch Together Handlers Class
// ============================================================================

/**
 * Manages Watch Together event handlers with decoupled video control.
 */
export class WatchTogetherHandlers {
    private controller: VideoController | null = null;
    private config: Required<WatchTogetherHandlersConfig>;
    private state: WatchTogetherHandlersState = {
        hasAppliedInitialSync: false,
        navigatingToItemId: null,
    };
    private cleanupFunctions: (() => void)[] = [];

    // Worker timer for background-resilient intervals
    private workerTimer: WorkerTimer | null = null;

    // Sync state for adaptive drift compensation
    private currentCatchUpMode: 'normal' | 'catching-up' | 'slowing-down' = 'normal';
    private originalPlaybackRate = 1;
    private driftCompensator: AdaptiveDriftCompensator;
    private startupAlignment: { binding: string; ready: boolean } | null = null;

    private startupPlaybackBinding(store: WatchTogetherStore): string {
        return JSON.stringify([
            this.config.getItemId(),
            store.session?.code,
            store.session?.timelineId,
            store.session?.fileId,
            store.session?.hostClientId,
        ]);
    }

    // --- Protocol phase state machine ---
    // The exclusive resync phase; ALL phase changes go through transition()
    private phase: ResyncPhase = { kind: 'synced' };
    // Monotonic counter; a buffer-check poll loop aborts once a NEWER check
    // (or reset/dispose) bumps it. all_ready does NOT bump it — a still-running
    // loop's late signalReady is a harmless no-op server-side.
    private generationCounter = 0;
    private navigationRevision = 0;
    // Orthogonal group-stall overlay (displayName of the stalled participant).
    // See the ResyncPhase doc comment for why this is not a phase.
    private stalledBy: string | null = null;
    private stallPlayTimeout: ReturnType<typeof setTimeout> | null = null;

    // Store reference for visibility handler
    private watchTogetherStore: WatchTogetherStore | null = null;
    /**
     * Host only: its play state when its tab went hidden (refined at the Page
     * Lifecycle `freeze`), consumed on `resume` or on becoming visible. While the
     * browser keeps it paused, and for FREEZE_CATCH_UP_MS after the catch-up starts,
     * the host sends no heartbeat: the media was stopped by the browser, not the
     * user, and "paused" would split the party (see freezeCatchUpTarget).
     */
    private suspended: { wasPlaying: boolean; position: number; at: number } | null = null;
    private heartbeatHeldUntil = 0;
    /** Set by setupVisibilityHandler; see catchUpIfSuspended(). */
    private catchUpFn: (() => boolean) | null = null;
    private isHostFn: (() => boolean) | null = null;

    constructor(config: WatchTogetherHandlersConfig) {
        this.config = {
            getItemId: config.getItemId,
            isHost: config.isHost,
            showToast: config.showToast ?? (() => {}),
            onPlaybackRateChange: config.onPlaybackRateChange ?? (() => {}),
            onPlayError: config.onPlayError ?? ((e) => console.error('Play error:', e)),
            isPausedByUser: config.isPausedByUser ?? (() => false),
            isLive: config.isLive ?? (() => false),
            isSourceReplacing: config.isSourceReplacing ?? (() => false),
            onPlaybackBindingChanged: config.onPlaybackBindingChanged ?? (() => {}),
            log: config.log ?? (() => {}),
        };

        // Initialize adaptive drift compensator with config optimized for Watch Together
        this.driftCompensator = new AdaptiveDriftCompensator({
            measureDuration: 3000, // 3s initial measurement
            minSamplesForCalibration: 3,
            hardSeekThreshold: SYNC_HARD_SEEK_THRESHOLD,
            maxRateAdjustment: 0.05, // Max 5% rate change
            seekLatencyOffset: SEEK_LATENCY_OFFSET,
            // Close audible/visible gaps promptly, then keep checking so the
            // correction tapers off instead of running past the host.
            targetSyncTime: 15,
            initialRecalibrationInterval: 2000,
            maxRecalibrationInterval: 4000,
            minFinishTimeDiff: 0.5,
            minRateChangeThreshold: 0.003, // Only apply if change > 0.3%
        });
    }

    /**
     * Set the video controller (call when video element is available)
     */
    setController(controller: VideoController | null): void {
        this.controller = controller;
    }

    /**
     * Reset state (call when joining new session)
     */
    resetState(): void {
        this.state.hasAppliedInitialSync = false;
        this.state.navigatingToItemId = null;
        this.stalledBy = null;
        this.generationCounter++; // abort any running buffer-poll loop
        this.transition({ kind: 'synced' }, 'reset');
        this.driftCompensator.reset();
    }

    /**
     * The single funnel for resync-phase changes. Exit actions run here so a
     * phase can never leak its resources: leaving `resuming` cancels the
     * scheduled play() (a stale all_ready timer must not fire into a newer
     * pause/stall/buffer-check).
     */
    private transition(next: ResyncPhase, reason: string): void {
        if (next.kind !== 'synced') this.startupAlignment = null;
        if (this.stallPlayTimeout) clearTimeout(this.stallPlayTimeout);
        this.stallPlayTimeout = null;
        if (this.phase.kind === 'resuming') {
            clearTimeout(this.phase.timer);
        }
        if (this.phase.kind !== next.kind) {
            this.config.log(`[phase] ${this.phase.kind} → ${next.kind} (${reason})`);
        }
        this.phase = next;
    }

    /** Current protocol phase, with the stall overlay, for diagnostics. */
    getPhase(): string {
        return this.stalledBy !== null ? `${this.phase.kind}+stalled` : this.phase.kind;
    }

    isPlaybackHeld(): boolean {
        return (
            this.config.isSourceReplacing() ||
            this.phase.kind !== 'synced' ||
            this.stalledBy !== null
        );
    }

    prepareSourceReplacement(): void {
        this.startupAlignment = null;
        if (this.phase.kind === 'resuming')
            this.transition({ kind: 'synced' }, 'local source replacement');
    }

    /** Reapply the latest authority after a local source is ready, never its old autoplay intent. */
    reapplyCurrentPartyState(store: WatchTogetherStore): void {
        const state = store.getSessionState();
        if (
            !state ||
            this.isPlaybackHeld() ||
            store.isWatchPartySyncing ||
            store.isStalled ||
            store.isPlayerAttachmentPending ||
            !this.controller?.isReady()
        )
            return;
        if (!this.config.isHost()) {
            const expected = state.isPlaying ? store.getExpectedHostPosition() : state.currentTime;
            const tolerance = state.isPlaying ? 1 : 0.15;
            if (
                expected !== null &&
                Number.isFinite(expected) &&
                Math.abs(this.controller.getCurrentTime() - expected) > tolerance
            )
                this.controller.seekTo(expected, 'watch_party_sync');
        }
        if (state.isPlaying) void this.controller.play().catch(this.config.onPlayError);
        else this.controller.pause();
    }

    /**
     * Set the media duration for finish-time sync calculation.
     * Call this when video metadata is loaded.
     */
    setMediaDuration(duration: number): void {
        this.driftCompensator.setMediaDuration(duration);
    }

    /**
     * Set the user's preferred playback rate (e.g., 1.0, 1.25, 1.5).
     * Compensation will be applied relative to this rate.
     */
    setOriginalPlaybackRate(rate: number): void {
        this.originalPlaybackRate = rate;
        this.driftCompensator.setOriginalRate(rate);
    }

    /**
     * Get whether initial sync has been applied
     */
    hasAppliedInitialSync(): boolean {
        return this.state.hasAppliedInitialSync;
    }

    /**
     * Mark initial sync as applied
     */
    markInitialSyncApplied(): void {
        this.state.hasAppliedInitialSync = true;
    }

    /**
     * A non-seek host remains position authority, but guests and hosts during
     * explicit seek barriers must reach the requested target before playback
     * can continue. All paths also require live, usable media.
     */
    private isResumeTargetReady(targetTime: number, requireTargetMatch: boolean): boolean {
        if (!this.controller?.isReady() || !this.controller.hasLiveSource()) return false;

        const currentTime = this.controller.getCurrentTime();
        if (requireTargetMatch && Math.abs(currentTime - targetTime) > POSITION_TOLERANCE_SECONDS) {
            return false;
        }

        const buffered = this.controller.getBuffered();
        if (buffered) {
            const position = requireTargetMatch ? targetTime : currentTime;
            for (let i = 0; i < buffered.length; i++) {
                if (buffered.start(i) <= position && buffered.end(i) >= position + 1) return true;
            }
        }

        return this.controller.getReadyState() >= 3;
    }

    /** Resume only after the shared deadline and the local media target are ready. */
    private scheduleSynchronizedResume(
        checkId: string,
        generation: number,
        targetTime: number,
        delay: number,
        requireTargetMatch: boolean,
    ): void {
        const resumeAt = Date.now() + delay;
        const giveUpAt = resumeAt + RESUME_TARGET_MAX_WAIT_MS;
        const scheduleAttempt = (waitMs: number, reason: string): void => {
            const timer = setTimeout(() => {
                if (
                    this.phase.kind !== 'resuming' ||
                    this.phase.checkId !== checkId ||
                    this.phase.generation !== generation ||
                    this.phase.timer !== timer
                )
                    return;

                if (this.config.isSourceReplacing()) {
                    scheduleAttempt(
                        RESUME_TARGET_POLL_INTERVAL_MS,
                        'waiting for source replacement',
                    );
                    return;
                }

                const remainingDelay = resumeAt - Date.now();
                if (remainingDelay > 0) {
                    scheduleAttempt(remainingDelay, 'waiting for synchronized resume time');
                    return;
                }

                if (
                    this.controller?.isReady() &&
                    !this.isResumeTargetReady(targetTime, requireTargetMatch)
                ) {
                    if (Date.now() < giveUpAt) {
                        scheduleAttempt(
                            RESUME_TARGET_POLL_INTERVAL_MS,
                            'waiting for local resume target',
                        );
                        return;
                    }
                    this.config.log(
                        'Resume target never reached - resuming anyway rather than staying paused',
                        { targetTime, requireTargetMatch },
                    );
                }

                if (this.watchTogetherStore?.getSessionState()?.isPlaying === false) {
                    this.transition({ kind: 'synced' }, 'explicit pause before resume');
                    this.watchTogetherStore?.settleSeekIntent?.();
                    return;
                }
                if (this.stalledBy !== null) {
                    this.transition({ kind: 'synced' }, 'resume held by stall');
                    return;
                }
                if (!this.controller) {
                    this.transition({ kind: 'synced' }, 'resume without controller');
                    return;
                }
                const controller = this.controller;
                const playStartedAt = controller.getCurrentTime();
                const playTimeout = setTimeout(() => {
                    if (
                        generation !== this.generationCounter ||
                        this.phase.kind !== 'resuming' ||
                        this.phase.timer !== playTimeout
                    )
                        return;
                    if (playbackAdvancedSince(controller, playStartedAt)) {
                        this.transition({ kind: 'synced' }, 'playback running, play() pending');
                        if (this.stalledBy === null) this.watchTogetherStore?.settleSeekIntent?.();
                        return;
                    }
                    controller.pause();
                    this.transition({ kind: 'synced' }, 'playback start timed out');
                    this.watchTogetherStore?.settleSeekIntent?.();
                    this.config.onPlayError(
                        new Error('Playback did not start. Press Play to retry.'),
                    );
                }, RESUME_TARGET_MAX_WAIT_MS);
                this.transition(
                    {
                        kind: 'resuming',
                        checkId,
                        generation,
                        targetTime,
                        requireTargetMatch,
                        timer: playTimeout,
                    },
                    'waiting for playback to start',
                );
                // While play() is pending the heartbeats still report the target, which
                // anchors every guest there; settle as soon as the element really plays.
                const startPoll = setInterval(() => {
                    if (
                        generation !== this.generationCounter ||
                        this.phase.kind !== 'resuming' ||
                        this.phase.timer !== playTimeout
                    ) {
                        clearInterval(startPoll);
                        return;
                    }
                    if (!playbackAdvancedSince(controller, playStartedAt)) return;
                    clearInterval(startPoll);
                    this.transition({ kind: 'synced' }, 'playback running, play() pending');
                    if (this.stalledBy === null) this.watchTogetherStore?.settleSeekIntent?.();
                }, START_POLL_INTERVAL_MS);
                void controller
                    .play()
                    .then(() => {
                        if (
                            generation !== this.generationCounter ||
                            this.phase.kind !== 'resuming' ||
                            this.phase.timer !== playTimeout
                        )
                            return;
                        this.transition({ kind: 'synced' }, 'synchronized playback started');
                        if (!controller.isPaused() && this.stalledBy === null)
                            this.watchTogetherStore?.settleSeekIntent?.();
                    })
                    .catch((error: unknown) => {
                        if (
                            generation !== this.generationCounter ||
                            this.phase.kind !== 'resuming' ||
                            this.phase.timer !== playTimeout
                        )
                            return;
                        this.transition({ kind: 'synced' }, 'synchronized play failed');
                        this.watchTogetherStore?.settleSeekIntent?.();
                        this.config.onPlayError(
                            error instanceof Error ? error : new Error(String(error)),
                        );
                    });
            }, waitMs);
            this.transition(
                { kind: 'resuming', checkId, generation, targetTime, requireTargetMatch, timer },
                reason,
            );
        };

        scheduleAttempt(delay, 'all_ready (playing)');
    }

    /**
     * Adopt the party's playback rate as the compensator's base rate.
     *
     * Compare with originalPlaybackRate, not the controller's rate, to avoid
     * ping-pong between this handler and the compensator. The host applies the
     * rate directly (it needs no compensation); for a guest the compensator
     * applies an adjusted rate around this base. Leaving the base at 1.0 while
     * the party runs at, say, 1.25 is unrecoverable — compensation is clamped to
     * +/-5%, so the guest falls behind until every drift check hard-seeks it
     * forward.
     */
    private applySyncedPlaybackRate(playbackRate: number | undefined): void {
        if (!playbackRate || playbackRate === this.originalPlaybackRate) return;
        this.originalPlaybackRate = playbackRate;
        this.driftCompensator.setOriginalRate(playbackRate);
        if (this.config.isHost()) {
            this.controller?.setPlaybackRate(playbackRate);
        }
        this.config.onPlaybackRateChange(playbackRate);
    }

    /**
     * Register all Watch Together event handlers
     */
    registerHandlers(watchTogether: WatchTogetherStore): void {
        // Sync handler - synchronize play/pause/position
        watchTogether.onSync((syncState) => {
            if (!syncState.isPlaying) this.startupAlignment = null;
            this.reanchorSuspension(syncState.currentTime, syncState.isPlaying);
            if (this.config.isSourceReplacing() || !this.controller?.isReady()) return;

            if (this.phase.kind === 'buffer_check' && watchTogether.isWatchPartySyncing === false) {
                this.transition(
                    { kind: 'synced' },
                    'pending barrier canceled by canonical control',
                );
            }

            const isFirstSync = !this.state.hasAppliedInitialSync;
            const isHost = this.config.isHost();

            // On first sync for guests, seek to session position
            if (isFirstSync && !isHost && syncState.currentTime > 0) {
                this.state.hasAppliedInitialSync = true;
                this.config.log(
                    'First sync - guest seeking to session position:',
                    syncState.currentTime,
                );
                this.controller.seekTo(syncState.currentTime, 'watch_party_sync');
                this.controller.pause();
                // The snapshot carries the party's rate. This path returns before
                // the shared rate handling below, so adopt it here or a guest
                // joining a sped-up party starts compensating from a 1.0 base.
                this.applySyncedPlaybackRate(syncState.playbackRate);
                // A connected snapshot can arrive after the join barrier has
                // already completed. In that case no all_ready follows to wake
                // this initial pause, and party autoplay is intentionally
                // disabled. Resume the playing snapshot ourselves; a following
                // buffer_check still pauses us again and owns its later resume.
                //
                // Only when nothing else already owns the resume, though. This
                // branch is the FIRST sync this handler instance sees, which is
                // not necessarily the first event: a remount mid-party (host
                // navigate / version switch) keeps the store's stream alive, so a
                // barrier or stall can already be open when the snapshot lands.
                // Playing here would start ahead of all_ready's coordinated
                // deadline, or through a group stall that onResume owns.
                if (
                    syncState.isPlaying &&
                    this.phase.kind === 'synced' &&
                    this.stalledBy === null
                ) {
                    this.driftCompensator.forceRecalibrate();
                    this.startupAlignment = {
                        binding: this.startupPlaybackBinding(watchTogether),
                        ready: false,
                    };
                    void this.controller.play().catch(this.config.onPlayError);
                }
                return;
            }
            this.state.hasAppliedInitialSync = true;

            // Apply play/pause state
            if (syncState.isPlaying) {
                if (this.phase.kind !== 'synced' || this.stalledBy !== null) {
                    // A play sync during buffer_check/resuming must not start
                    // playback early — all_ready owns the coordinated resume
                    this.config.log(`Ignoring play sync during ${this.phase.kind}`);
                } else {
                    if (this.controller.isPaused()) {
                        if (!isHost)
                            this.startupAlignment = {
                                binding: this.startupPlaybackBinding(watchTogether),
                                ready: false,
                            };
                        // Resuming from a pause via a plain sync (older servers /
                        // stall-resume, not the coordinated barrier): drop stale
                        // paused-time samples so the first post-resume tick can't
                        // hard-seek off a frozen anchor.
                        this.driftCompensator.forceRecalibrate();
                        void this.controller.play().catch(this.config.onPlayError);
                    }
                    // Sync position only while playing - seeking during pause can cause Safari freezes.
                    // The HOST never seeks here: it is the position authority, and sync events echo
                    // session.currentTime (the host's own last heartbeat, up to ~5s stale). Seeking
                    // would rewind the host and drag the whole party into a drift resync.
                    if (!isHost) {
                        const currentTime = this.controller.getCurrentTime();
                        if (watchTogether.needsResync(currentTime, syncState.currentTime)) {
                            this.controller.seekTo(syncState.currentTime, 'watch_party_sync');
                        }
                    }
                }
            } else {
                // A remote pause supersedes any scheduled synchronized resume
                if (this.phase.kind === 'resuming') {
                    this.transition({ kind: 'synced' }, 'remote pause');
                }
                // On pause, sync guest position to host position if drift > 150ms
                // This ensures guests are at exact same position when paused
                if (!isHost) {
                    const currentTime = this.controller.getCurrentTime();
                    const drift = Math.abs(currentTime - syncState.currentTime);
                    if (drift > 0.15) {
                        // 150ms threshold
                        this.config.log('Pause sync - seeking to host position:', {
                            from: currentTime.toFixed(3),
                            to: syncState.currentTime.toFixed(3),
                            drift: (drift * 1000).toFixed(0) + 'ms',
                        });
                        this.controller.seekTo(syncState.currentTime, 'watch_party_pause_sync');
                    }
                }
                this.controller.pause();
            }

            this.applySyncedPlaybackRate(syncState.playbackRate);
        });

        // Only a moving host report can reconcile a delayed Play. The sync
        // command itself may have spent seconds in transit before being stamped.
        watchTogether.onHostPosition((_position, _timestamp, isPlaying) => {
            if (!this.startupAlignment) return;
            if (
                this.config.isHost() ||
                this.startupAlignment.binding !== this.startupPlaybackBinding(watchTogether)
            ) {
                this.startupAlignment = null;
                return;
            }
            if (isPlaying) this.startupAlignment.ready = true;
        });

        // Seek handler
        watchTogether.onSeek((currentTime, _userId, isPlaying, resetTimeline) => {
            if (resetTimeline) this.resetState();
            this.reanchorSuspension(currentTime, isPlaying);
            if (!this.controller?.isReady()) return;
            this.controller.seekTo(currentTime, 'watch_party_seek');
            this.config.onPlaybackBindingChanged();
            // Force recalibration after seek since positions changed significantly
            this.driftCompensator.forceRecalibrate();
            // If isPlaying is false (seeking while paused), ensure we stay paused
            // The buffer_check flow will also handle this, but we pause immediately for responsiveness
            if (!isPlaying) {
                this.controller.pause();
            }
        });

        // Navigate handler
        watchTogether.onNavigate((itemId, title, userId, fileId, reload) => {
            this.startupAlignment = null;
            const currentItemId = this.config.getItemId();

            this.config.log('Navigate event:', {
                itemId,
                title,
                userId,
                fileId,
                currentItemId,
            });

            if (reload) {
                // A failed request may follow cleanup of an earlier accepted title.
                // Recreate the player from the canonical route, including same-item
                // timelines whose old controller may already have been disposed.
                const url = fileId ? `/watch/${itemId}?fileId=${fileId}` : `/watch/${itemId}`;
                window.location.assign(resolve(url));
                return;
            }

            // Already on this video
            if (itemId === currentItemId && this.state.navigatingToItemId === null) {
                this.config.log('Already on this video, ignoring');
                return;
            }

            // A newer canonical destination supersedes an in-flight route.
            if (this.state.navigatingToItemId === itemId) {
                this.config.log('Already navigating to', this.state.navigatingToItemId);
                return;
            }

            this.config.log('Redirecting to new video:', itemId);
            const revision = ++this.navigationRevision;
            this.generationCounter++;
            this.transition({ kind: 'synced' }, 'navigate');
            this.stalledBy = null;
            this.controller?.pause();
            this.state.navigatingToItemId = itemId;
            // Include fileId in URL if present (for version sync)
            const url = fileId ? `/watch/${itemId}?fileId=${fileId}` : `/watch/${itemId}`;
            // Clear the in-flight flag if the navigation is rejected (e.g. a
            // concurrent navigation supersedes this goto without changing itemId,
            // so no {#key} remount recreates the handler). A stuck flag would
            // otherwise disable catch-up sync and ignore future navigate events
            // for the remaining life of this still-mounted handler.
            void goto(resolve(url)).catch((e) => {
                this.config.log('navigate goto rejected, clearing in-flight flag', e);
                if (revision === this.navigationRevision) this.state.navigatingToItemId = null;
            });
        });

        // Session ended handler
        watchTogether.onSessionEnded((hostUserId, hostDisplayName) => {
            this.state.hasAppliedInitialSync = false;
            // Show toast notification that the host ended the party
            this.config.showToast('disband', hostUserId, hostDisplayName);
        });

        // Participant notifications
        watchTogether.onParticipantJoined((participant) => {
            this.config.showToast('join', participant.userId, participant.displayName ?? '');
        });

        watchTogether.onParticipantLeft((userId, displayName) => {
            this.config.showToast('leave', userId, displayName);
        });

        watchTogether.onAction((action, userId, displayName) => {
            this.config.showToast(action, userId, displayName);
        });

        // Buffer check - coordinate synchronized resume
        watchTogether.onBufferCheck((checkId, targetTime, _initiator, _isPlaying, isSeek) => {
            // A new buffer check supersedes any phase: the transition cancels
            // a scheduled resume, and the generation bump aborts any older
            // buffer-poll loop (overlapping join/seek/drift checks previously
            // left orphaned 100ms loops signalling ready at wrong positions).
            // The transition runs even without a ready controller so the
            // machine can't desync from the protocol; media commands below
            // are what need the controller (server timeout covers our
            // missing ready-signal).
            const generation = ++this.generationCounter;
            const isHost = this.config.isHost();
            const requireTargetMatch = !isHost || isSeek;
            this.transition(
                { kind: 'buffer_check', checkId, generation, targetTime, requireTargetMatch },
                'buffer_check event',
            );

            if (!this.controller?.isReady()) return;

            this.controller.pause();

            // Non-hosts seek to the sync target NOW and verify the buffer
            // there. Verifying at the old position was pointless: all_ready
            // seeks to the target anyway, landing on an unbuffered range —
            // instant 'waiting' → stall → group pause loop after every resync.
            // The host stays put (it is the position authority).
            let bufferCheckPosition = this.controller.getCurrentTime();
            if (!isHost && Math.abs(bufferCheckPosition - targetTime) > 0.5) {
                this.controller.seekTo(
                    targetTime,
                    isSeek ? 'watch_party_seek' : 'watch_party_sync',
                );
                bufferCheckPosition = targetTime;
            }

            const startedAt = Date.now();
            const MAX_BUFFER_WAIT_MS = 8000; // server resumes after 5s anyway
            const checkBuffer = () => {
                if (!this.controller?.isReady()) return;
                if (generation !== this.generationCounter) return; // superseded
                if (this.phase.kind !== 'buffer_check' || this.phase.checkId !== checkId) return;

                const currentTime = this.controller.getCurrentTime();
                // `readyState` describes the element's previous media state, not
                // necessarily the target of this barrier. During rapid HLS seeks
                // it can still be HAVE_FUTURE_DATA while the source reset has
                // temporarily put currentTime back at 0. A guest must therefore
                // reach the target before acknowledging it, or the barrier can
                // resume with controls pinned at 00:00.
                //
                // The host is different: on a non-seek barrier (e.g. a new
                // participant joining), the target may be the last heartbeat's
                // stale position. The server relies on the host's ready payload
                // to retarget that barrier to the live playhead, so do not make
                // the host wait for the old target. Still reject a transient 0
                // during an HLS reset unless the requested target really is 0.
                const canAcknowledgeBarrier = requireTargetMatch
                    ? Math.abs(currentTime - targetTime) <= POSITION_TOLERANCE_SECONDS
                    : targetTime === 0 || currentTime > POSITION_TOLERANCE_SECONDS;
                const buffered = this.controller.getBuffered();
                let isBuffered = false;

                if (buffered) {
                    for (let i = 0; i < buffered.length; i++) {
                        if (
                            buffered.start(i) <= bufferCheckPosition &&
                            buffered.end(i) >= bufferCheckPosition + 1
                        ) {
                            isBuffered = true;
                            break;
                        }
                    }
                }

                if (
                    (canAcknowledgeBarrier &&
                        (isBuffered || this.controller.getReadyState() >= 3)) ||
                    Date.now() - startedAt > MAX_BUFFER_WAIT_MS
                ) {
                    // Buffer ready (or we've waited long enough) - signal to server.
                    // Gate only the position PAYLOAD on a live source: the poll keeps
                    // retrying/signalling either way, but a host whose element is
                    // mid-rebuild (in-place version switch — same itemId, no {#key}
                    // remount, so this poll survives) reads getCurrentTime() = 0, and
                    // for a non-seek barrier the server retargets everyone to the
                    // reported position. Reporting 0 would seek the whole party to the
                    // start; omitting it keeps the server's original target.
                    const position =
                        isHost && this.controller.hasLiveSource() ? currentTime : undefined;
                    void watchTogether.signalReady(checkId, position);
                } else {
                    setTimeout(checkBuffer, 100);
                }
            };

            setTimeout(checkBuffer, 200);
        });

        // All ready - synchronized resume (or stay paused if isPlaying is false)
        watchTogether.onAllReady((checkId, targetTime, resumeDelay, isPlaying) => {
            this.reanchorSuspension(targetTime, isPlaying);
            if (
                (this.phase.kind !== 'buffer_check' && this.phase.kind !== 'resuming') ||
                this.phase.checkId !== checkId
            )
                return;
            const isHost = this.config.isHost();
            const generation = this.phase.generation;
            const requireTargetMatch = this.phase.requireTargetMatch;

            // The barrier moved everyone to a new synchronized position, so the
            // compensator's accumulated drift samples are now meaningless. Reset
            // them (as onSeek does) BEFORE the next syncCheck tick can run —
            // otherwise the first post-barrier tick reads a stale hostPosition
            // anchor, sees a huge phantom drift, and hard-seeks the guest away
            // from the freshly-synced target (the intro-skip "jump back" bug).
            this.driftCompensator.forceRecalibrate();

            // Non-hosts seek to host's position. They normally already seeked
            // there during buffer_check — only correct if they've drifted off
            // the target, so we don't tear the buffer down again for nothing.
            // (Runs before the resume timer can fire — the delay is at least
            // one macrotask away.)
            if (!isHost && this.controller?.isReady()) {
                const current = this.controller.getCurrentTime();
                if (Math.abs(current - targetTime) > 0.75) {
                    this.config.log('Seeking to host position:', targetTime);
                    this.controller.seekTo(targetTime, 'watch_party_sync');
                }
            }

            if (!isPlaying) {
                this.transition({ kind: 'synced' }, 'all_ready (paused)');
                return;
            }
            this.scheduleSynchronizedResume(
                checkId,
                generation,
                targetTime,
                Math.max(0, resumeDelay),
                requireTargetMatch,
            );
        });

        // Stall handler - someone is buffering, pause the group
        watchTogether.onStall((userId, displayName) => {
            this.startupAlignment = null;
            this.config.log('Stall detected - pausing for user:', displayName);

            // Replayed/duplicate stall for the same user: re-apply the pause
            // (idempotent) but don't re-notify
            const isDuplicateStall = this.stalledBy === displayName;

            // Enter the stall overlay (disables drift check and catch-up).
            // Deliberately does NOT abort a running buffer check — they are
            // independent server mechanisms and the ready-signal must still go out.
            this.stalledBy = displayName;

            // Keep polling a rebuilding HLS target during a stall. Otherwise a
            // later stall-resume can play at 00:00 without revisiting readiness.
            if (this.phase.kind === 'resuming') {
                const hasController = this.controller?.isReady() ?? false;
                if (
                    !hasController ||
                    this.isResumeTargetReady(this.phase.targetTime, this.phase.requireTargetMatch)
                ) {
                    this.transition({ kind: 'synced' }, 'stall');
                }
            }

            // Pause video
            if (this.controller?.isReady()) {
                this.controller.pause();
            }

            // Reset playback rate to normal during stall
            if (this.currentCatchUpMode !== 'normal' && this.controller?.isReady()) {
                this.controller.setPlaybackRate(this.originalPlaybackRate);
                this.currentCatchUpMode = 'normal';
                watchTogether.setCatchUpMode('normal');
                this.config.onPlaybackRateChange(this.originalPlaybackRate);
            }

            // Reset compensator - will recalibrate when playback resumes
            this.driftCompensator.reset();

            // Show toast notification (once per stall, not per redelivery)
            if (!isDuplicateStall) {
                this.config.showToast('stall', userId, displayName);
            }
        });

        // Resume handler - stalled user recovered, resume playback
        watchTogether.onResume(() => {
            this.config.log('Stall recovered - resuming playback');

            // Exit the stall overlay
            this.stalledBy = null;

            // While a buffer check / synchronized resume is in flight, the
            // all_ready flow owns playback — playing here would start before
            // the buffer is verified
            if (this.phase.kind !== 'synced') {
                this.config.log(`Resume during ${this.phase.kind} — all_ready drives playback`);
                return;
            }

            if (this.config.isSourceReplacing()) return;

            // Resume playback — but only if the group still intends to play.
            // If someone deliberately paused during the stall (session
            // isPlaying=false), blindly resuming would override their pause.
            const sessionState = watchTogether.getSessionState();
            if (sessionState && !sessionState.isPlaying) {
                this.config.log('Group paused during stall - staying paused');
                return;
            }
            if (this.controller?.isReady() && !this.stallPlayTimeout) {
                const generation = this.generationCounter;
                const controller = this.controller;
                const playStartedAt = controller.getCurrentTime();
                const timeout = setTimeout(() => {
                    if (generation !== this.generationCounter || this.stallPlayTimeout !== timeout)
                        return;
                    this.stallPlayTimeout = null;
                    if (playbackAdvancedSince(controller, playStartedAt)) {
                        if (this.stalledBy === null) watchTogether.settleSeekIntent();
                        return;
                    }
                    controller.pause();
                    watchTogether.settleSeekIntent();
                    this.config.onPlayError(
                        new Error('Playback did not restart. Press Play to retry.'),
                    );
                }, RESUME_TARGET_MAX_WAIT_MS);
                this.stallPlayTimeout = timeout;
                const startPoll = setInterval(() => {
                    if (
                        generation !== this.generationCounter ||
                        this.stallPlayTimeout !== timeout
                    ) {
                        clearInterval(startPoll);
                        return;
                    }
                    if (!playbackAdvancedSince(controller, playStartedAt)) return;
                    clearInterval(startPoll);
                    clearTimeout(timeout);
                    this.stallPlayTimeout = null;
                    if (this.stalledBy === null) watchTogether.settleSeekIntent();
                }, START_POLL_INTERVAL_MS);
                void controller
                    .play()
                    .then(() => {
                        if (
                            generation !== this.generationCounter ||
                            this.stallPlayTimeout !== timeout
                        )
                            return;
                        clearTimeout(timeout);
                        this.stallPlayTimeout = null;
                        if (!controller.isPaused() && this.stalledBy === null)
                            watchTogether.settleSeekIntent();
                    })
                    .catch((error: unknown) => {
                        if (
                            generation !== this.generationCounter ||
                            this.stallPlayTimeout !== timeout
                        )
                            return;
                        clearTimeout(timeout);
                        this.stallPlayTimeout = null;
                        watchTogether.settleSeekIntent();
                        this.config.onPlayError(
                            error instanceof Error ? error : new Error(String(error)),
                        );
                    });
            }
        });
    }

    /**
     * Set up periodic heartbeat and drift check intervals using Web Worker timers
     * for resilience against browser throttling in background tabs.
     */
    setupIntervals(
        watchTogether: WatchTogetherStore,
        isInWatchParty: () => boolean,
        isSyncing: () => boolean,
        isHost: () => boolean,
    ): () => void {
        // Store references for visibility handler
        this.watchTogetherStore = watchTogether;
        this.isHostFn = isHost;

        // Create worker timer for background-resilient intervals
        this.workerTimer = new WorkerTimer();

        // Heartbeat - keep session position fresh (host broadcasts to others)
        this.workerTimer.start(
            'heartbeat',
            () => {
                if (isInWatchParty() && this.controller?.hasLiveSource() && !this.heartbeatHeld()) {
                    // Carry the host's true play state so session.isPlaying self-heals
                    // (server persists it host-only). Guests send it too — harmless,
                    // the server ignores non-host isPlaying.
                    void watchTogether.sendHeartbeat(
                        this.phase.kind === 'buffer_check' || this.phase.kind === 'resuming'
                            ? this.phase.targetTime
                            : this.controller.getCurrentTime(),
                        this.phase.kind === 'buffer_check' ||
                            this.phase.kind === 'resuming' ||
                            this.stalledBy !== null
                            ? undefined
                            : !this.controller.isPaused(),
                        this.config.getItemId(),
                    );
                }
            },
            5000,
        );

        // Drift check - report position to server
        this.workerTimer.start(
            'driftCheck',
            () => {
                if (
                    isInWatchParty() &&
                    this.controller?.hasLiveSource() &&
                    !isSyncing() &&
                    !this.config.isSourceReplacing()
                ) {
                    void watchTogether.reportPosition(this.controller.getCurrentTime());
                }
            },
            10000,
        );

        // Hybrid sync check - uses deadzone/catch-up/hard-seek strategy
        this.workerTimer.start(
            'syncCheck',
            () => {
                this.performHybridSyncCheck(watchTogether, isInWatchParty, isSyncing, isHost);
            },
            CATCHUP_CHECK_INTERVAL_MS,
        );

        // Set up visibility change handler for instant recovery
        const visibilityCleanup = this.setupVisibilityHandler(isInWatchParty, isSyncing, isHost);

        const cleanup = () => {
            // Clean up worker timer
            if (this.workerTimer) {
                this.workerTimer.dispose();
                this.workerTimer = null;
            }

            // Clean up visibility handler
            visibilityCleanup();

            // Reset playback rate on cleanup
            if (this.currentCatchUpMode !== 'normal' && this.controller?.isReady()) {
                this.controller.setPlaybackRate(this.originalPlaybackRate);
            }

            // Reset state
            this.currentCatchUpMode = 'normal';
            this.stalledBy = null;
            this.watchTogetherStore = null;
            this.isHostFn = null;
        };

        this.cleanupFunctions.push(cleanup);
        return cleanup;
    }

    /**
     * Adaptive sync using finish-time alignment strategy.
     *
     * Instead of fixed catch-up speeds (1.05x/0.95x), calculates the precise
     * rate needed for guest to finish at the same time as host. This results
     * in much smaller, stable rate adjustments that minimize stuttering.
     *
     * Example: 10s behind at 1hr mark of 2hr movie = only 0.28% speed increase
     */
    private performHybridSyncCheck(
        watchTogether: WatchTogetherStore,
        isInWatchParty: () => boolean,
        isSyncing: () => boolean,
        isHost: () => boolean,
    ): void {
        // Only guests need catch-up sync.
        // Skip while a resync phase is active (buffer_check/resuming) or the
        // group is stalled — catch-up must not fight the coordinated flows.
        if (
            !isInWatchParty() ||
            this.config.isSourceReplacing() ||
            isHost() ||
            !this.controller?.hasLiveSource() ||
            isSyncing() ||
            watchTogether.isCatchUpPaused() ||
            this.phase.kind !== 'synced' ||
            this.stalledBy !== null ||
            // A navigate is already in flight for this player — never hard-seek
            // the outgoing (soon-to-unmount) video toward a host position that
            // belongs to a different episode.
            this.state.navigatingToItemId !== null ||
            // Never compensate a paused element: catch-up only ever seeks/rates,
            // it never resumes playback, so acting on a paused guest is always
            // wrong — it's what yanked a just-paused guest forward. The isPaused()
            // check is immune to any local session-state staleness; the party
            // isPlaying check additionally stops fighting sync in the inverse
            // (element playing, party paused) skew.
            this.controller.isPaused() ||
            watchTogether.getSessionState()?.isPlaying === false ||
            // Host isn't moving — don't hard-seek toward its frozen position. This
            // covers end-of-video, where the host's `ended` sends no `sync` so the
            // session gate above stays stale-true; without this a trailing guest
            // gets yanked to the end and its last seconds are skipped.
            !watchTogether.isHostPlaying()
        ) {
            // Reset to normal if we're the host or not in party
            if (this.currentCatchUpMode !== 'normal') {
                this.controller?.setPlaybackRate(this.originalPlaybackRate);
                this.currentCatchUpMode = 'normal';
                watchTogether.setCatchUpMode('normal');
                watchTogether.setCurrentDrift(0);
                watchTogether.setEffectivePlaybackRate(this.originalPlaybackRate);
            }
            return;
        }

        // Get expected host position (accounts for time elapsed since last update)
        const expectedHostPosition = watchTogether.getExpectedHostPosition();
        if (expectedHostPosition === null) return;

        const myPosition = this.controller.getCurrentTime();
        const drift = expectedHostPosition - myPosition; // positive = behind, negative = ahead

        // Debug logging to diagnose sync issues
        console.debug('[WatchTogether Sync]', {
            expectedHostPosition: expectedHostPosition.toFixed(2),
            myPosition: myPosition.toFixed(2),
            drift: drift.toFixed(2),
            driftSign: drift > 0 ? 'behind' : drift < 0 ? 'ahead' : 'synced',
        });

        // Update drift in store for UI display
        watchTogether.setCurrentDrift(drift);

        if (this.startupAlignment?.binding !== this.startupPlaybackBinding(watchTogether))
            this.startupAlignment = null;
        if (
            this.startupAlignment?.ready &&
            this.controller.isReady() &&
            this.controller.getReadyState() >= 3 &&
            !(typeof document !== 'undefined' && document.hidden)
        ) {
            this.startupAlignment = null;
            if (Math.abs(drift) > STARTUP_HARD_SEEK_THRESHOLD) {
                this.driftCompensator.forceRecalibrate();
                this.controller.setPlaybackRate(this.originalPlaybackRate);
                this.currentCatchUpMode = 'normal';
                watchTogether.setCatchUpMode('normal');
                watchTogether.setEffectivePlaybackRate(this.originalPlaybackRate);
                this.config.onPlaybackRateChange(this.originalPlaybackRate);
                this.controller.seekTo(
                    expectedHostPosition + SEEK_LATENCY_OFFSET,
                    'watch_party_hard_sync',
                );
                return;
            }
        }

        // Use adaptive drift compensator for sync decisions
        const action = this.driftCompensator.update(drift, myPosition, expectedHostPosition);

        switch (action.action) {
            case 'seek':
                // Never hard-seek a hidden tab: the seek tears down the HLS
                // pipeline (source reload on Safari native HLS) while the tab
                // is throttled, which can wedge it. The visibilitychange
                // handler runs an immediate sync check on refocus instead.
                if (typeof document !== 'undefined' && document.hidden) {
                    break;
                }
                // Hard seek required - reset to normal rate first
                if (this.currentCatchUpMode !== 'normal') {
                    this.controller.setPlaybackRate(this.originalPlaybackRate);
                    this.currentCatchUpMode = 'normal';
                    watchTogether.setCatchUpMode('normal');
                    watchTogether.setEffectivePlaybackRate(this.originalPlaybackRate);
                    this.config.onPlaybackRateChange(this.originalPlaybackRate);
                }
                this.controller.seekTo(action.seekTarget!, 'watch_party_hard_sync');
                break;

            case 'rate': {
                // Apply calculated rate adjustment
                const newRate = action.rate!;
                this.controller.setPlaybackRate(newRate);

                // Update UI mode based on whether we're speeding up or slowing down
                const newMode =
                    newRate > this.originalPlaybackRate
                        ? 'catching-up'
                        : newRate < this.originalPlaybackRate
                          ? 'slowing-down'
                          : 'normal';

                if (this.currentCatchUpMode !== newMode) {
                    this.currentCatchUpMode = newMode;
                    watchTogether.setCatchUpMode(newMode);
                }
                watchTogether.setEffectivePlaybackRate(newRate);
                this.config.onPlaybackRateChange(newRate);
                break;
            }

            case 'none':
                // Compensator is in locked state with stable rate - nothing to do
                // The rate was already set during calibration
                break;
        }
    }

    /**
     * Set up visibility change handler for instant recovery when tab becomes visible.
     * - Host: Send immediate heartbeat to refresh session state for guests
     * - Guest: Check drift and hard-seek if needed
     */
    private setupVisibilityHandler(
        isInWatchParty: () => boolean,
        isSyncing: () => boolean,
        isHost: () => boolean,
    ): () => void {
        if (!browser) return () => {};

        // A host whose tab goes to the background can be SUSPENDED by the browser:
        // its media stops while the guests play on. Chromium announces it (Page
        // Lifecycle `freeze`/`resume`); Safari/iOS and Firefox never shipped those
        // events and just pause the video. Either way the player hears no user
        // pause, so no party sync is sent — only the heartbeat would report the
        // pause, splitting the party (or, on return, dragging the guests back).
        // So: remember the host's play state when it goes hidden (refined at
        // `freeze`), hold heartbeats while the browser has it paused, and catch up
        // on `resume` or on becoming visible, whichever comes first.
        const rememberSuspension = () => {
            if (!isInWatchParty() || !isHost() || !this.controller?.hasLiveSource()) return;
            this.suspended = {
                wasPlaying: !this.controller.isPaused(),
                position: this.controller.getCurrentTime(),
                at: Date.now(),
            };
        };
        /** Returns true when it took over (a catch-up is in flight). */
        const catchUpAfterSuspension = (): boolean => {
            const suspended = this.suspended;
            this.suspended = null;
            if (!suspended?.wasPlaying || !this.watchTogetherStore) return false;
            if (!isInWatchParty() || !isHost() || !this.controller?.hasLiveSource()) return false;
            // Still playing (desktop background tab): nothing was suspended. Paused by
            // the user (lock screen, headset): respect it, it is not a suspension.
            if (!this.controller.isPaused() || this.config.isPausedByUser()) return false;
            if (this.config.isLive()) return false;
            this.heartbeatHeldUntil = Date.now() + FREEZE_CATCH_UP_MS;
            const store = this.watchTogetherStore;
            void (async () => {
                // null when the party was paused meanwhile (a real pause — lock screen,
                // a guest — sent a sync): then the host stays paused too.
                const target = await store.freezeCatchUpTarget(suspended);
                if (target === null || !this.controller?.hasLiveSource()) return;
                // Rejoin the party where it is now, locally: the guests never stopped,
                // so there is nothing to move them for. A party-wide seek (barrier)
                // raced the player's own resume-on-visible and left the host ~1 s
                // ahead, inside the compensator's tolerance for good. Heartbeats
                // resume after the hold with the caught-up position.
                this.controller.seekTo(target, 'watch_party_sync');
                await this.controller.play().catch(this.config.onPlayError);
            })();
            return true;
        };

        const handleVisibilityChange = () => {
            if (document.visibilityState === 'hidden') {
                rememberSuspension();
                return;
            }
            if (!isInWatchParty() || !this.controller?.hasLiveSource()) return;
            if (!this.watchTogetherStore) return;

            // Host: catch up if the browser suspended us, else send an immediate
            // heartbeat so guests get fresh position data after the background.
            // A record left from a time we were host (transferred meanwhile) must
            // not linger: visible always consumes it.
            if (!isHost()) this.suspended = null;
            if (isHost()) {
                if (catchUpAfterSuspension() || this.heartbeatHeld()) return;
                void this.watchTogetherStore.sendHeartbeat(
                    this.phase.kind === 'buffer_check' || this.phase.kind === 'resuming'
                        ? this.phase.targetTime
                        : this.controller.getCurrentTime(),
                    this.phase.kind === 'buffer_check' ||
                        this.phase.kind === 'resuming' ||
                        this.stalledBy !== null
                        ? undefined
                        : !this.controller.isPaused(),
                );
                return;
            }

            // Guest: Force recalibration and immediate sync check after visibility change
            // The tab may have been backgrounded for a while, causing drift accumulation
            this.driftCompensator.forceRecalibrate();
            this.performHybridSyncCheck(this.watchTogetherStore, isInWatchParty, isSyncing, isHost);
        };

        this.catchUpFn = catchUpAfterSuspension;
        const handleFreeze = rememberSuspension;
        const handleResume = () => {
            catchUpAfterSuspension();
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);
        document.addEventListener('freeze', handleFreeze);
        document.addEventListener('resume', handleResume);

        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            document.removeEventListener('freeze', handleFreeze);
            document.removeEventListener('resume', handleResume);
            this.catchUpFn = null;
        };
    }

    /**
     * Lock-screen / headset Play while the browser has the host suspended: catch up
     * with the party (where it is NOW) instead of syncing the stale position, which
     * rewound every guest. Returns true when it took over.
     */
    catchUpIfSuspended(): boolean {
        return this.catchUpFn?.() ?? false;
    }

    /**
     * Lock-screen / headset Pause while the browser has the host suspended: where the
     * party has got to (record + elapsed), consuming the record — the caller pauses
     * the PARTY there. null when not suspended (the element's own position is right).
     */
    takeSuspendedPosition(): number | null {
        const s = this.suspended;
        if (!s?.wasPlaying || !this.controller?.isPaused() || this.config.isLive()) return null;
        this.suspended = null;
        return s.position + Math.max(0, (Date.now() - s.at) / 1000);
    }

    /**
     * The party's play state or position changed while this host was hidden (a guest
     * paused or resumed, a seek, a barrier): re-base the suspension record on it, or
     * the catch-up would add time the party never played.
     */
    private reanchorSuspension(position: number, isPlaying: boolean): void {
        if (!this.suspended) return;
        this.suspended = { wasPlaying: isPlaying, position, at: Date.now() };
    }

    private heartbeatHeld(): boolean {
        if (this.config.isSourceReplacing() || Date.now() < this.heartbeatHeldUntil) return true;
        // Hidden after playing and now paused without a user pause: the browser
        // suspended us. Reporting "paused" would split the party.
        return (
            this.suspended?.wasPlaying === true &&
            (this.controller?.isPaused() ?? false) &&
            !this.config.isPausedByUser()
        );
    }

    /**
     * Clean up all handlers and intervals
     */
    dispose(): void {
        this.startupAlignment = null;
        this.cleanupFunctions.forEach((fn) => fn());
        this.cleanupFunctions = [];
        this.generationCounter++; // abort any running buffer-poll loop
        this.transition({ kind: 'synced' }, 'dispose');
        this.controller = null;
    }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new WatchTogetherHandlers instance
 */
export function createWatchTogetherHandlers(
    config: WatchTogetherHandlersConfig,
): WatchTogetherHandlers {
    return new WatchTogetherHandlers(config);
}

// ============================================================================
// Video Controller Adapter
// ============================================================================

/**
 * Create a VideoController adapter from an HTMLVideoElement
 */
export function createVideoControllerFromElement(
    getElement: () => HTMLVideoElement | null,
    seekFn: (time: number, source: string) => void,
    onPlayError?: (error: Error) => void,
    onMutedFallback?: () => void,
): VideoController {
    return {
        getCurrentTime: () => getElement()?.currentTime ?? 0,
        seekTo: seekFn,
        play: async () => {
            const el = getElement();
            if (el) {
                try {
                    await el.play();
                } catch (e) {
                    const error = e as Error;
                    // A party-driven resume (buffer-check all_ready, stall
                    // recovery, sync) is never a direct user gesture, so
                    // browsers with a strict autoplay policy (e.g. Brave,
                    // which blocks by default unlike Chrome's more lenient
                    // engagement heuristic) can reject it — otherwise leaving
                    // the guest silently paused at their pre-join position
                    // forever while segments keep buffering in the
                    // background. Retry muted so playback actually starts,
                    // and let the caller prompt the user to unmute.
                    if (error.name === 'NotAllowedError' && !el.muted) {
                        el.muted = true;
                        try {
                            await el.play();
                            onMutedFallback?.();
                            return;
                        } catch (mutedError) {
                            onPlayError?.(mutedError as Error);
                            throw mutedError;
                        }
                    }
                    onPlayError?.(error);
                    throw error;
                }
            }
        },
        pause: () => getElement()?.pause(),
        isPaused: () => getElement()?.paused ?? true,
        getPlaybackRate: () => getElement()?.playbackRate ?? 1,
        setPlaybackRate: (rate) => {
            const el = getElement();
            if (el) el.playbackRate = rate;
        },
        getBuffered: () => getElement()?.buffered ?? null,
        getReadyState: () => getElement()?.readyState ?? 0,
        isReady: () => getElement() !== null,
        // A source-cleared element (clearVideoSource during an episode/version
        // switch does removeAttribute('src') + load()) reports currentTime 0 and
        // an empty currentSrc while the component is still mounted mid-navigation.
        // Position-REPORTING paths (heartbeat/drift/catch-up) gate on this so they
        // never read and broadcast a phantom position 0 from a video being torn
        // down — which otherwise hard-seeks a following guest back to the start of
        // the old episode. Position-APPLYING handlers (onSync/onSeek/onBufferCheck/
        // onAllReady) keep using isReady() so a server target still applies during
        // source setup and the buffer poll loop retries rather than aborting.
        // During real playback currentSrc is always set (blob: for MSE/hls.js,
        // the stream URL for native HLS / direct play).
        hasLiveSource: () => {
            const el = getElement();
            return el !== null && el.currentSrc !== '';
        },
    };
}
