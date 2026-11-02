// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch Together Client Store
 *
 * Manages synchronized watch sessions from the client side.
 * Handles SSE connection for real-time updates.
 */

import { browser } from '$app/environment';
import { SvelteSet } from 'svelte/reactivity';
import type {
    WatchTogetherParty,
    SSEEventType,
    WatchTogetherState,
} from '$lib/types/watch-together';
import { MAX_DRIFT_SECONDS } from '$lib/types/watch-together';
import type {
    CreateSessionRequest,
    JoinSessionRequest,
    LeaveRequest,
    SyncRequest,
    SeekRequest,
    NavigateRequest,
    VersionChangeRequest,
    HeartbeatRequest,
    PositionRequest,
    ActivityRequest,
    ReactionRequest,
    EffectRequest,
    ReadyRequest,
    StallRequest,
    StallReadyRequest,
    TransferHostRequest,
    SetVisibilityRequest,
} from '$lib/types/api-watch-together';
import {
    // Session persistence
    getOrCreateClientId,
    claimClientId,
    saveToStorage,
    loadFromStorage,
    clearStorage,
    isNavigatingWithinSession,
    setNavigatingWithinSessionFlag,
    // SSE connection
    createSSEConnection,
    buildStreamUrl,
    parseSSEEvent,
    type SSEConnection,
    // Pure sync logic
    calculateTimeToSync,
    isHostDevice,
    isOwnEvent,
    // SSE instability warning debounce (pure logic)
    evaluateReconnect,
    initialInstabilityState,
    type InstabilityState,
} from './watchTogether/index';
import * as watchTogetherApi from '$lib/api/watch-together';
import { toasts } from '$lib/stores/toast.store';
import { watchTogetherMaxReconnectMs } from '$lib/stores/client-tuning';
import { apiUrl } from '$lib/shared/api-urls.js';
import { playerStore } from '$lib/components/player/playerStore.svelte';
import { revertAudioOnlyForParty } from '$lib/components/player/audio-only-selection';
import * as m from '$lib/paraglide/messages';

// Debug logging - enable to diagnose issues
const DEBUG = false;
const log = (...args: unknown[]) => DEBUG && console.log('[WatchTogether]', ...args);

/**
 * How long this tab's own playing seek keeps the party "playing" against a paused
 * element (see seekResumeIntent): the server's 5 s buffer-check timeout plus the
 * all_ready resume lead, with margin.
 */
const OWN_SEEK_INTENT_MS = 8_000;

/** Upper bound on how far the server-clock estimate is assumed to be off (host_position). */
const MAX_CLOCK_UNCERTAINTY_MS = 1_000;

/** Host activity type for guests to see what the host is doing */
export type HostActivity = 'watching' | 'searching' | 'browsing';

interface RestoreOptions {
    /** Read membership before stream setup, without delivering events to missing handlers. */
    connect?: boolean;
    /** The player mount that requested this snapshot must still own playback. */
    isCurrent?: () => boolean;
}

class WatchTogetherStoreImpl {
    private pendingStartupSync = false;
    private membershipRevision = 0;
    private startupPlayRevision = 0;
    private lastConnectedBinding: string | null = null;

    private static readonly HOST_POSITION_MAX_AGE_MS = 15_000;
    /** One 5 s host heartbeat plus transit: how stale a playing snapshot can be. */
    private static readonly SNAPSHOT_MAX_STALENESS_S = 7;

    // --- State fields ---
    session = $state<WatchTogetherParty | null>(null);
    isHost: boolean = $state(false);
    /** Host's clientId - used to determine if THIS device is the host (important for same-user multi-device) */
    hostClientId = $state<string | null>(null);
    isConnected: boolean = $state(false);
    isConnecting: boolean = $state(false);
    isSyncing: boolean = $state(false); // True when a resync is in progress (buffer_check/all_ready flow)
    error = $state<string | null>(null);
    lastSyncTime: number = $state(0);
    hasSyncedInitially: boolean = $state(false); // Track if we've synced to session state at least once
    // Smooth catch-up sync state
    catchUpMode: 'normal' | 'catching-up' | 'slowing-down' = $state('normal');
    hostPosition = $state<{
        position: number;
        timestamp: number;
        /** Local monotonic receipt time; immune to wall-clock/NTP changes. */
        receivedAt: number;
        isPlaying: boolean;
        playbackRate: number;
    } | null>(null);
    // Pause catch-up during manual seeks/sync flows
    catchUpPaused: boolean = $state(false);
    // Current drift from host (positive = behind, negative = ahead) in seconds
    currentDrift: number = $state(0);
    // Host activity status (for guests to see what host is doing)
    hostActivity: HostActivity = $state('watching');
    hostActivityMessage = $state<string | null>(null);
    // Stall protection: someone is buffering and group is paused waiting
    isStalled: boolean = $state(false);
    stalledByUser = $state<string | null>(null); // Display name of user who is buffering
    // Clock offset (serverTime - clientTime) for synchronized resume timing
    // Drift trend tracking (for sync indicator)
    driftTrend: 'improving' | 'worsening' | 'stable' = $state('stable');
    previousDrift: number = $state(0); // Last drift value for trend calculation
    // Current effective playback rate (for display)
    effectivePlaybackRate: number = $state(1.0);

    // --- Derived values (replaces 15 derived() stores) ---
    readonly isInWatchParty = $derived(this.session !== null);
    readonly isWatchPartyHost = $derived(this.isHost);
    readonly isWatchPartySyncing = $derived(this.isSyncing);
    readonly watchPartyParticipants = $derived(this.session?.participants ?? []);
    readonly watchPartyCode = $derived(this.session?.code ?? null);
    readonly watchPartyCatchUpMode = $derived(this.catchUpMode);
    readonly isWatchPartyCatchUpPaused = $derived(this.catchUpPaused);
    readonly watchPartyDrift = $derived(this.currentDrift);
    readonly watchPartyHostActivity = $derived(this.hostActivity);
    readonly watchPartyHostActivityMessage = $derived(this.hostActivityMessage);
    readonly isWatchPartyStalled = $derived(this.isStalled);
    readonly watchPartyStalledByUser = $derived(this.stalledByUser);
    readonly watchPartyDriftTrend = $derived(this.driftTrend);
    readonly watchPartyPlaybackRate = $derived(this.effectivePlaybackRate);
    readonly watchPartyTimeToSync = $derived.by(() =>
        calculateTimeToSync(this.currentDrift, this.effectivePlaybackRate),
    );

    // --- Private internal state ---
    private sseConnection: SSEConnection | null = null;
    private currentUserId: string | null = null;
    private sseConnectStartedWallTime = 0;
    private sseConnectStartedMonotonic = 0;
    private serverClockAtReceipt = 0;
    private serverClockReceiptMonotonic = 0;
    /**
     * How far the server-clock estimate can be off: half the `connected` round trip
     * (the NTP midpoint is exact only for symmetric delays). See host_position.
     */
    private serverClockUncertaintyMs = 0;
    private serverDownlinkEstimate = 0;
    private activeBufferCheckId: string | null = null;
    private activeBufferCheckTimelineId: string | undefined;
    private deferredNavigationBarrier: Extract<SSEEventType, { type: 'buffer_check' }> | null =
        null;
    /**
     * Play intent of this tab's own last seek, see {@link seekResumeIntent}.
     * Cleared by any explicit play/pause (ours or a remote `sync`) and by reset.
     */
    private ownSeekIntent: { isPlaying: boolean; at: number } | null = null;
    private seekGeneration = 0;
    private recoverySyncEchoes: {
        code: string;
        syncId: string;
        expiresAt: number;
    }[] = [];
    private playbackControlQueue: Promise<unknown> | null = null;
    private playbackControlEpoch = 0;
    private seekSenderEpoch = 0;
    private playbackControlBinding: string | null = null;
    private seekSettling = false;
    private playRevision = 0;
    private explicitPlayIntent: { revision: number; isPlaying: boolean } | null = null;
    private explicitPauseServerTime = 0;
    private pendingPauseRevision: number | null = null;
    private latestLocalSeek: { generation: number; target: number; revision: number } | null = null;
    private activeBarrierRevision = 0;
    private activeBarrierTarget = 0;
    private sendingSeek = false;
    private navigationRevision = 0;
    private navigationRecoveryNeeded = false;
    private pendingNavigationPredecessors = new SvelteSet<string | undefined>();
    private pendingNavigationTimelineId: string | null = null;
    private navigationPlayerTimelineId: string | null = null;
    private deferredNavigationCompletion: Extract<SSEEventType, { type: 'all_ready' }> | null =
        null;
    private deferredNavigationStall: Extract<SSEEventType, { type: 'stall' }> | null = null;
    private deferredNavigationVersion: Extract<SSEEventType, { type: 'version_change' }> | null =
        null;
    private navigationRequest: Promise<Awaited<
        ReturnType<typeof watchTogetherApi.broadcastNavigate>
    > | null> | null = null;
    private queuedSeek: {
        code: string;
        itemId: string;
        expectedTimelineId?: string;
        generation: number;
        target: number;
        isPlaying: boolean;
        revision: number;
    } | null = null;
    private bufferCheckWatchdog: ReturnType<typeof setTimeout> | null = null;
    // Debounce state for the "connection unstable" warning, so edge-timeout SSE
    // blips don't spam a toast per drop. See ./watchTogether/instability.ts.
    private instability: InstabilityState = initialInstabilityState();

    // Event callbacks
    private onSyncCallback: ((state: WatchTogetherState) => void) | null = null;
    private onSeekCallback:
        | ((
              currentTime: number,
              userId: string,
              isPlaying: boolean,
              resetTimeline?: boolean,
          ) => void)
        | null = null;
    private onNavigateCallback:
        | ((
              itemId: string,
              title: string,
              userId: string,
              fileId?: string,
              reload?: boolean,
          ) => void)
        | null = null;
    private onSessionEndedCallback: ((hostUserId: string, hostDisplayName: string) => void) | null =
        null;
    private onParticipantJoinedCallback:
        ((participant: { userId: string; displayName: string | null }) => void) | null = null;
    private onParticipantLeftCallback: ((userId: string, displayName: string) => void) | null =
        null;
    private onActionCallback:
        ((action: 'play' | 'pause' | 'seek', userId: string, displayName: string) => void) | null =
        null;
    private onBufferCheckCallback:
        | ((
              checkId: string,
              currentTime: number,
              initiator: string,
              isPlaying: boolean,
              seekInitiated: boolean,
          ) => void)
        | null = null;
    private onAllReadyCallback:
        | ((checkId: string, currentTime: number, resumeDelay: number, isPlaying: boolean) => void)
        | null = null;
    private onReactionCallback:
        ((emoji: string, userId: string, displayName: string) => void) | null = null;
    private onScreenEffectCallback:
        ((effect: string, userId: string, displayName: string) => void) | null = null;
    private onVersionChangeCallback:
        ((fileId: string, userId: string, displayName: string) => void) | null = null;
    private onHostActivityCallback: ((activity: HostActivity, message?: string) => void) | null =
        null;

    private armBufferCheckWatchdog(checkId: string, currentTime: number, isPlaying: boolean): void {
        this.activeBarrierTarget = currentTime;
        const revision = this.activeBarrierRevision;
        if (this.bufferCheckWatchdog) clearTimeout(this.bufferCheckWatchdog);
        this.bufferCheckWatchdog = setTimeout(() => {
            if (this.activeBufferCheckId !== checkId) return;
            this.completeSeekRecovery(
                checkId,
                currentTime,
                this.barrierPlayIntent(isPlaying, revision),
            );
        }, 15_000);
    }
    private completeSeekRecovery(checkId: string, currentTime: number, isPlaying: boolean): void {
        if (this.activeBufferCheckId !== checkId || !this.session) return;
        const localRecovery = checkId.startsWith('local-seek-');
        if (localRecovery) {
            // Recovery is terminal for this request generation. A queued seek
            // whose local watchdog already resumed must not be sent later when
            // an older HTTP request finally completes.
            this.queuedSeek = null;
            this.seekGeneration++;
        }
        this.activeBufferCheckId = null;
        if (this.bufferCheckWatchdog) clearTimeout(this.bufferCheckWatchdog);
        this.bufferCheckWatchdog = null;
        this.isSyncing = false;
        this.catchUpPaused = false;
        this.session = { ...this.session, currentTime, isPlaying };
        this.reanchorHostPosition(currentTime, isPlaying);
        if (localRecovery)
            void this.syncRecoveredSeek(
                this.seekGeneration,
                this.session.code,
                currentTime,
                isPlaying,
            );
        // Use the same local target-readiness gate as normal all_ready.
        if (this.onAllReadyCallback) this.onAllReadyCallback(checkId, currentTime, 0, isPlaying);
        else this.settleSeekIntent();
    }

    private async syncRecoveredSeek(
        generation: number,
        code: string,
        currentTime: number,
        isPlaying: boolean,
    ): Promise<void> {
        if (generation !== this.seekGeneration || this.session?.code !== code) return;
        const lifecycleRevision = this.navigationRevision;
        const itemId = this.session.itemId;
        const expectedTimelineId = this.session.timelineId;
        try {
            // Peers never saw this pending local barrier. Give them its recovered
            // position immediately rather than asking drift correction to erase
            // a fifteen-second pause using rate adjustments alone.
            while (
                lifecycleRevision === this.navigationRevision &&
                this.session?.code === code &&
                this.session.itemId === itemId &&
                this.session.timelineId === expectedTimelineId
            ) {
                const syncId = this.rememberRecoverySync(code);
                const playbackRate = this.session.playbackRate;
                await this.queuePlaybackControl(() =>
                    watchTogetherApi.syncPlayback(code, {
                        syncId,
                        itemId,
                        expectedTimelineId,
                        currentTime,
                        isPlaying,
                        clientId: this.getClientId(),
                        playbackRate,
                    }),
                );
                if (this.session?.code !== code || generation === this.seekGeneration) break;
                // A correction can itself finish after a newer control. Reassert
                // only when superseded, stopping as soon as its generation holds.
                generation = this.seekGeneration;
                currentTime = this.session.currentTime;
                isPlaying = this.session.isPlaying;
            }
        } catch (error) {
            console.debug('[WatchTogether] Recovery sync unavailable:', error);
        }
    }

    private invalidatePlaybackControls(binding: string | null = null): void {
        this.playbackControlEpoch++;
        this.playbackControlQueue = null;
        this.playbackControlBinding = binding;
        this.seekSenderEpoch++;
        this.sendingSeek = false;
        this.queuedSeek = null;
    }

    private preparePlaybackControlBinding(): void {
        const binding = JSON.stringify([
            this.session?.code,
            this.session?.itemId,
            this.session?.timelineId,
        ]);
        if (this.playbackControlBinding !== binding) this.invalidatePlaybackControls(binding);
    }

    private queuePlaybackControl<T>(send: () => Promise<T>): Promise<T> {
        this.preparePlaybackControlBinding();
        const epoch = this.playbackControlEpoch;
        const run = (): Promise<T> => {
            if (epoch !== this.playbackControlEpoch)
                return Promise.reject(
                    new DOMException('Playback control superseded by attachment', 'AbortError'),
                );
            return send();
        };
        const request = this.playbackControlQueue
            ? this.playbackControlQueue.then(run, run)
            : run();
        const tail = request.then(
            () => undefined,
            () => undefined,
        );
        this.playbackControlQueue = tail;
        void tail.then(() => {
            if (this.playbackControlQueue === tail) this.playbackControlQueue = null;
        });
        return request;
    }

    private rememberRecoverySync(code: string): string {
        const syncId = crypto.randomUUID();
        this.recoverySyncEchoes = this.recoverySyncEchoes
            .filter((echo) => echo.expiresAt > Date.now())
            .slice(-15);
        this.recoverySyncEchoes.push({ code, syncId, expiresAt: Date.now() + 60_000 });
        return syncId;
    }

    private barrierPlayIntent(proposed: boolean, revision = this.activeBarrierRevision): boolean {
        if (
            this.explicitPlayIntent &&
            (this.explicitPlayIntent.revision > revision ||
                (!this.isHost && !this.explicitPlayIntent.isPlaying))
        ) {
            return this.explicitPlayIntent.isPlaying;
        }
        // Repeated seeks can revisit the same target, which cannot be uniquely
        // correlated without wire changes. This host's newest own command is
        // the playback-intent authority while it is still settling.
        if (
            this.isHost &&
            this.seekSettling &&
            this.ownSeekIntent &&
            this.latestLocalSeek?.revision === revision
        )
            return this.ownSeekIntent.isPlaying;
        return proposed;
    }

    private ownSeekNotSent(): boolean {
        return !!this.queuedSeek && this.queuedSeek.generation === this.latestLocalSeek?.generation;
    }

    private supersedeSeek(isPlaying?: boolean, preserveLocalBarrier = false): void {
        if (!preserveLocalBarrier) this.seekGeneration++;
        if (isPlaying !== undefined) {
            this.explicitPlayIntent = { revision: ++this.playRevision, isPlaying };
            this.pendingPauseRevision = null;
            this.explicitPauseServerTime = isPlaying ? 0 : this.estimatedServerTime();
        }
        if (preserveLocalBarrier && this.activeBufferCheckId?.startsWith('local-seek-')) {
            // Play revises the pending target's intent. Keep its queued request
            // and watchdog: its real prepare/completion may never arrive.
            if (this.queuedSeek && isPlaying !== undefined) {
                this.queuedSeek = { ...this.queuedSeek, isPlaying, revision: this.playRevision };
            }
            this.ownSeekIntent = { isPlaying: isPlaying ?? true, at: Date.now() };
            this.activeBarrierRevision = this.playRevision;
            this.armBufferCheckWatchdog(
                this.activeBufferCheckId,
                this.activeBarrierTarget,
                isPlaying ?? true,
            );
            return;
        }
        this.ownSeekIntent = null;
        this.seekSettling = false;
        this.queuedSeek = null;
        if (this.bufferCheckWatchdog) clearTimeout(this.bufferCheckWatchdog);
        this.bufferCheckWatchdog = null;
        if (this.activeBufferCheckId?.startsWith('local-seek-')) {
            this.activeBufferCheckId = null;
            this.isSyncing = false;
            this.catchUpPaused = false;
        } else if (this.activeBufferCheckId && isPlaying !== undefined) {
            // Explicit controls revise the real barrier's recovery instead of
            // removing its only failsafe when all_ready disappears.
            this.armBufferCheckWatchdog(
                this.activeBufferCheckId,
                this.activeBarrierTarget,
                isPlaying,
            );
        }
    }

    private estimatedServerTime(): number {
        return this.serverClockAtReceipt > 0
            ? this.serverClockAtReceipt + performance.now() - this.serverClockReceiptMonotonic
            : Date.now();
    }

    /** Called when local readiness has completed the synchronized resume. */
    settleSeekIntent(): void {
        this.seekSettling = false;
        this.ownSeekIntent = null;
    }

    private onHostPositionCallback:
        | ((position: number, timestamp: number, isPlaying: boolean, playbackRate: number) => void)
        | null = null;
    private onHostChangedCallback:
        ((newHostUserId: string, newHostDisplayName: string) => void) | null = null;
    private onStallCallback: ((userId: string, displayName: string) => void) | null = null;
    private onResumeCallback: (() => void) | null = null;

    /**
     * Handle stale session - reload page to re-authenticate
     */
    private handleStaleSession(reason: string): void {
        if (!browser) return;
        console.warn(`[WatchTogether] Stale session detected (${reason}), reloading page...`);
        // Clear storage first to prevent infinite reload loops
        clearStorage();
        // Reload the page to trigger re-authentication
        window.location.reload();
    }

    /**
     * Check API response for auth errors and handle them
     */
    private checkAuthError(status: number): boolean {
        if (status === 401) {
            this.handleStaleSession('401 Unauthorized');
            return true;
        }
        return false;
    }

    /**
     * Audio-only and watch parties are mutually exclusive — revert to video
     * when session state has just been established while audio-only is
     * active. See revertAudioOnlyForParty. Call this from EVERY code path
     * that can set `this.session` to an active party: explicit join
     * (`joinSession`) and the `getCurrentSession` rejoin-on-reload fallback
     * in `tryRejoinFromStorage` (localStorage cleared / new tab, but still a
     * server-side participant).
     */
    private applyAudioOnlyPartyExclusion(): void {
        const revertProfile = revertAudioOnlyForParty(
            playerStore.qualityMode,
            playerStore.previousQualityProfile,
        );
        if (revertProfile) {
            playerStore.setQualityProfile(revertProfile);
            toasts.info(m.player_audio_only_party_reverted());
        }
    }

    // Unique client ID for this browser instance (used to filter own events)
    // Lazy initialization to handle SSR -> client hydration
    private _clientId: string | null = null;
    private monotonicNow(): number {
        return typeof performance !== 'undefined' ? performance.now() : Date.now();
    }

    /**
     * A playing snapshot's currentTime is the host's last heartbeat, up to one
     * 5 s heartbeat old, and it carries no time of its own (session.lastSync is
     * also bumped by guest heartbeats). Taken as "now", a guest that stayed in
     * sync through an outage seeked back seconds on reconnect. When this guest
     * already tracks the host on the same item and its estimate is ahead of the
     * snapshot by no more than that staleness, the estimate is the better
     * position. Anything else (a pause, a pending barrier, a host seek during
     * the outage, no estimate) keeps the snapshot.
     */
    private connectedSnapshotPosition(
        session: { currentTime: number; isPlaying: boolean; itemId: string },
        previousItemId: string | undefined,
        hasBufferCheck: boolean,
        reconnectingSamePlayer = false,
    ): number {
        if (
            !reconnectingSamePlayer ||
            !session.isPlaying ||
            hasBufferCheck ||
            previousItemId !== session.itemId ||
            !this.hostPosition?.isPlaying
        )
            return session.currentTime;
        // An outage can expire the bounded host estimate while the buffered
        // video keeps advancing. For the same already-connected player, its
        // delivered clock is better than a heartbeat-old playing snapshot.
        // Fresh players and changed timelines/versions/hosts still use the server.
        const deliveredPosition =
            reconnectingSamePlayer && this.hostPosition?.isPlaying && playerStore.isPlaying
                ? playerStore.playheadTime
                : null;
        const expected = this.getExpectedHostPosition();
        // After a long outage the snapshot can predate the outage itself, not
        // just one heartbeat. Do not move a still-playing video backward using
        // an untimed sample; a fresh host report or control remains authoritative.
        if (
            expected === null &&
            deliveredPosition !== null &&
            Number.isFinite(deliveredPosition) &&
            deliveredPosition >= session.currentTime
        )
            return deliveredPosition;
        if (expected === null || !Number.isFinite(expected)) return session.currentTime;
        const lead = expected - session.currentTime;
        return lead >= 0 && lead <= WatchTogetherStoreImpl.SNAPSHOT_MAX_STALENESS_S
            ? expected
            : session.currentTime;
    }

    /**
     * Re-anchor the guest's catch-up reference to a just-synchronized position so
     * the drift compensator stops extrapolating from a stale pre-seek anchor.
     * A resync barrier (buffer_check/all_ready) is the only path a host seek
     * reaches guests and it carries no host_position. `resumeDelayMs` pushes
     * `receivedAt` into the future so the pre-resume countdown isn't counted as
     * elapsed playing time. No-op for the host (it never catches up to itself).
     */
    private reanchorHostPosition(position: number, isPlaying: boolean, resumeDelayMs = 0): void {
        if (this.isHost) return;
        this.hostPosition = {
            position,
            timestamp: 0,
            receivedAt: this.monotonicNow() + Math.max(0, resumeDelayMs),
            isPlaying,
            playbackRate: this.session?.playbackRate ?? 1,
        };
    }

    private getClientId(): string {
        if (this._clientId === null && browser) {
            this._clientId = getOrCreateClientId();
        }
        return this._clientId || '';
    }

    /**
     * Resolve a clientId that is guaranteed unique among open tabs (Web Locks).
     * Must be awaited before any session operation — duplicated tabs inherit
     * the same sessionStorage clientId, which silently breaks echo suppression
     * and host detection for the entire session.
     */
    private _clientIdClaimed = false;
    private async ensureClientId(): Promise<string> {
        if (!browser) return '';
        if (!this._clientIdClaimed) {
            this._clientId = await claimClientId();
            this._clientIdClaimed = true;
        }
        return this._clientId || '';
    }

    /**
     * Create a new watch together session
     */
    async createSession(
        itemId: string,
        // The wire schema is ['movie','episode','series'] with 'tv' coerced in,
        // so both spellings are valid; callers hold either.
        mediaType: 'movie' | 'episode' | 'tv' | 'series',
        title: string,
        userId: string,
        posterUrl?: string,
        currentTime?: number,
        fileId?: string,
        visibility: 'unlisted' | 'listed' = 'unlisted',
    ): Promise<WatchTogetherParty | null> {
        if (!browser) return null;

        this.isConnecting = true;
        this.error = null;
        this.currentUserId = userId;

        try {
            const requestBody: CreateSessionRequest = {
                visibility,
                itemId,
                mediaType,
                title,
                posterUrl,
                currentTime,
                fileId,
                clientId: await this.ensureClientId(),
            };

            const { data, error } = await watchTogetherApi.createSession(requestBody);

            if (error || !data) {
                throw new Error(error || 'Failed to create session');
            }

            const session = data.party as WatchTogetherParty;

            log(' Session created successfully:', {
                code: session.code,
                hostClientId: session.hostClientId,
            });

            // Host is determined by clientId - the host is the device that created the session
            this.session = session;
            this.isHost = true; // Creator is always host
            this.hostClientId = session.hostClientId || this.getClientId(); // Track host's clientId
            this.isConnecting = false;
            this.hasSyncedInitially = true; // Host is the authority, always synced

            this.applyAudioOnlyPartyExclusion();

            // Save to localStorage for persistence across reloads
            saveToStorage(session.code, userId);

            // Connect to SSE stream
            log(' About to connect to SSE stream...');
            try {
                await this.connectToStream(session.code);
            } catch (e) {
                console.error('[WatchTogether] SSE connect error after create:', e);
                this.error = 'Failed to connect to session stream';
                this.session = null;
                this.isHost = false;
                this.hostClientId = null;
                clearStorage();
                return null;
            }
            log(' SSE connection initiated');

            return session;
        } catch (error) {
            console.error('[WatchTogether] Create session error:', error);
            this.isConnecting = false;
            this.error = error instanceof Error ? error.message : 'Failed to create session';
            return null;
        }
    }

    private deferPlaybackConnection(): void {
        this.pendingStartupSync = true;
        this.startupPlayRevision = this.playRevision;
        this.sseConnection?.disconnect();
        this.sseConnection = null;
        this.isConnected = false;
    }

    /**
     * Join an existing session by code
     */
    async joinSession(
        code: string,
        userId: string,
        options: RestoreOptions = {},
    ): Promise<WatchTogetherParty | null> {
        const revision = this.navigationRevision;
        const isCurrent = () =>
            revision === this.navigationRevision && options.isCurrent?.() !== false;
        if (!browser || !isCurrent()) return null;

        this.isConnecting = true;
        this.error = null;
        this.currentUserId = userId;

        try {
            // Send clientId so server can track this specific client
            const joinRequest: JoinSessionRequest = {
                clientId: await this.ensureClientId(),
            };
            if (!isCurrent()) return null;
            const { data, error, status } = await watchTogetherApi.joinSession(code, joinRequest);
            if (!isCurrent()) return null;

            if (error || !data) {
                // Check for auth error first
                if (this.checkAuthError(status)) return null;
                throw new Error(error || 'Session not found');
            }

            const session = data.party as WatchTogetherParty;

            // isHost is determined by clientId, not userId - supports same user on multiple devices
            const myClientId = this.getClientId();
            this.session = session;
            this.isHost = isHostDevice(session.hostClientId, myClientId);
            this.hostClientId = session.hostClientId || null;
            this.isConnecting = false;
            this.hasSyncedInitially = true; // We have valid session state from join response

            this.applyAudioOnlyPartyExclusion();

            // Save to localStorage for persistence across reloads
            saveToStorage(session.code, userId);

            // Connect to SSE stream
            try {
                if (options.connect === false) this.deferPlaybackConnection();
                else await this.connectToStream(session.code);
            } catch (e) {
                console.error('[WatchTogether] SSE connect error after join:', e);
                this.error = 'Failed to connect to session stream';
                this.session = null;
                this.isHost = false;
                this.hostClientId = null;
                clearStorage();
                return null;
            }

            return session;
        } catch (error) {
            if (!isCurrent()) return null;
            console.error('[WatchTogether] Join session error:', error);
            this.isConnecting = false;
            this.error = error instanceof Error ? error.message : 'Failed to join session';
            // Clear storage if join failed (session may have ended)
            clearStorage();
            return null;
        }
    }

    /**
     * Try to rejoin a session from localStorage or server (called on page load)
     * First checks localStorage, then falls back to asking the server what session the user is in
     */
    async tryRejoinFromStorage(userId: string, options: RestoreOptions = {}): Promise<boolean> {
        const revision = this.navigationRevision;
        const isCurrent = () =>
            revision === this.navigationRevision && options.isCurrent?.() !== false;
        if (!browser || !isCurrent()) return false;

        // Claim a tab-unique clientId before any identity-dependent work
        await this.ensureClientId();
        if (!isCurrent()) return false;

        // If already in a session, don't try to rejoin
        // But DO reconnect SSE if the connection was lost (e.g., after page navigation)
        const sseIsOpen = this.sseConnection?.isConnected() ?? false;
        log(' tryRejoinFromStorage called', {
            hasSession: !!this.session,
            sessionCode: this.session?.code,
            isConnected: this.isConnected,
            sseIsOpen,
            userId,
        });

        if (this.session) {
            log(' Already in a session, checking connection status');
            setNavigatingWithinSessionFlag(false); // Clear flag

            if (options.connect === false) {
                this.deferPlaybackConnection();
                return true;
            }

            // Reconnect SSE if not connected (connection is lost during page navigation)
            if (!sseIsOpen) {
                log(' SSE not open, reconnecting...');
                await this.connectToStream(this.session.code);
            } else {
                log(' SSE already open, skipping reconnect');
            }

            return true;
        }

        this.currentUserId = userId;

        // First, try localStorage
        const stored = loadFromStorage();
        if (stored) {
            log(' Found stored session, attempting to rejoin:', {
                storedCode: stored.code,
                storedUserId: stored.userId,
                currentUserId: userId,
            });

            try {
                const session = await this.joinSession(stored.code, userId, options);
                if (!isCurrent()) return false;
                if (session) {
                    log(' Successfully rejoined session from localStorage', {
                        sessionCode: session.code,
                        hostUserId: session.host.userId,
                        isHost: session.host.userId === userId,
                        itemId: session.itemId,
                    });
                    setNavigatingWithinSessionFlag(false); // Clear navigation flag after successful rejoin
                    return true;
                }
            } catch (error) {
                log(' Failed to rejoin stored session:', error);
            }

            if (!isCurrent()) return false;
            // Session no longer exists, clear storage
            log(' Stored session no longer exists, clearing localStorage');
            clearStorage();
        }

        // If localStorage didn't work, ask the server if we're in a session
        // This handles cases where localStorage was cleared but we're still a participant on the server
        log(' Checking server for active session...');
        try {
            const { data, error, status } = await watchTogetherApi.getCurrentSession();
            if (!isCurrent()) return false;
            // Check for auth error
            if (error && this.checkAuthError(status)) {
                return false;
            }
            if (!error && data) {
                if (data.party) {
                    const session = data.party as WatchTogetherParty;
                    // isHost is determined by clientId, not userId - supports same user on multiple devices
                    const myClientId = this.getClientId();
                    const rejoinedHost = isHostDevice(session.hostClientId, myClientId);

                    log(' Server says we are in a session:', {
                        sessionCode: session.code,
                        hostUserId: session.host.userId,
                        hostClientId: session.hostClientId,
                        myClientId,
                        isHost: rejoinedHost,
                        itemId: session.itemId,
                    });

                    // We're already a participant on the server, just connect
                    this.session = session;
                    this.isHost = rejoinedHost;
                    this.hostClientId = session.hostClientId || null;
                    this.isConnecting = false;
                    this.hasSyncedInitially = true;

                    this.applyAudioOnlyPartyExclusion();

                    // Save to localStorage for future page loads
                    saveToStorage(session.code, userId);

                    // Connect to SSE stream
                    if (options.connect === false) this.deferPlaybackConnection();
                    else await this.connectToStream(session.code);

                    setNavigatingWithinSessionFlag(false); // Clear navigation flag after successful rejoin
                    return true;
                }
            }
        } catch (error) {
            log(' Failed to check server for active session:', error);
        }

        if (!isCurrent()) return false;
        log(' Not in any session');
        setNavigatingWithinSessionFlag(false); // Clear flag even if not in session
        return false;
    }

    /**
     * Leave current session
     * Sends clientId to remove only this specific client (allows same user on multiple devices)
     */
    async leaveSession(): Promise<void> {
        // Already disconnected, nothing to do
        if (!this.session) {
            log(' Already disconnected, nothing to leave');
            clearStorage(); // Still clear storage to be safe
            return;
        }

        const sessionCode = this.session.code;

        // Clear storage first to prevent auto-rejoin
        clearStorage();

        try {
            // Send clientId so server only removes this specific client
            // This allows the same user to stay in the session from other devices
            const leaveRequest: LeaveRequest = { clientId: this.getClientId() };
            await watchTogetherApi.leaveSession(sessionCode, leaveRequest);
        } catch (error) {
            console.error('[WatchTogether] Leave API error:', error);
        }

        // Disconnect and reset state (may have already been done by session_ended event)
        this.disconnect();
    }

    /**
     * Debounced "connection unstable" warning.
     *
     * The SSE stream is reset by edge/proxy idle timeouts every ~30-60s; each
     * drop self-heals in under a second via reconnect + Last-Event-ID replay, so
     * warning per blip would spam the viewer. We warn once when instability is
     * *sustained* — either repeated distinct outages inside a rolling window, or
     * a single outage that stays down for a few seconds — then stay quiet for a
     * cooldown. The message frames it as a network/server issue, not playback.
     *
     * `attempt === 1` marks the start of a NEW outage (the SSE layer resets its
     * counter to 0 on a successful open); higher attempts are the same outage
     * still failing.
     */
    private noteReconnectAttempt(attempt: number): void {
        if (!browser) return;
        const { state, warn } = evaluateReconnect(this.instability, attempt, Date.now());
        this.instability = state;
        if (warn) {
            toasts.warning(
                'Connection unstable — your watch party keeps reconnecting. This is a network or server issue, not your playback; everything resyncs automatically.',
                { timeout: 8000, ariaLive: 'polite' },
            );
        }
    }

    /**
     * Connect to SSE stream for real-time updates
     * Uses createSSEConnection for automatic reconnection with exponential backoff
     */
    private async connectToStream(code: string): Promise<void> {
        if (!browser) return;

        log(' connectToStream called', { code });

        // Disconnect existing connection
        if (this.sseConnection) {
            log(' Disconnecting existing SSE connection');
            this.sseConnection.disconnect();
        }

        // Fresh stream = fresh instability tracking.
        this.instability = initialInstabilityState();

        // Create SSE connection with automatic reconnection
        this.sseConnection = createSSEConnection({
            maxReconnectAttempts: 10,
            // Ceiling on the exponential backoff, not a give-up deadline —
            // maxReconnectAttempts is what ends the retry loop. Operator-tunable
            // via WATCH_TOGETHER_MAX_RECONNECT_MS (default 30s) so a flaky link
            // can be told to keep retrying more often.
            maxReconnectDelay: watchTogetherMaxReconnectMs(),
            initialReconnectDelay: 1000,
            onOpen: () => {
                log(' SSE connected');
                this.isConnected = true;
            },
            onConnecting: (timing) => {
                this.sseConnectStartedWallTime = timing.wallTime;
                this.sseConnectStartedMonotonic = timing.monotonicTime;
            },
            onMessage: (data) => {
                log(' SSE message received:', data.substring(0, 100));
                const event = parseSSEEvent<SSEEventType>(data);
                if (event) {
                    this.handleSSEEvent(event);
                }
            },
            onError: (err) => {
                console.error('[WatchTogether] SSE error:', err);
                this.isConnected = false;
            },
            onReconnecting: (attempt: number, maxAttempts: number) => {
                log(` Reconnecting (attempt ${attempt}/${maxAttempts})...`);
                this.noteReconnectAttempt(attempt);
            },
            onMaxReconnectsExceeded: () => {
                this.handleStaleSession('SSE reconnect failed max attempts');
            },
            onClose: () => {
                this.isConnected = false;
            },
        });

        // Build URL and connect. The /events endpoint stamps an id: on every
        // frame and replays missed events on reconnect via the lastEventId
        // cursor — without it, a buffer_check/all_ready dropped during a
        // connection blip was simply lost (the removed legacy /stream had no replay).
        const clientId = this.getClientId();
        const streamUrl = buildStreamUrl(apiUrl('internal', `/watch-together/${code}/events`), {
            clientId,
        });
        log(' Creating SSE connection:', streamUrl);
        this.sseConnection.connect(streamUrl);
    }

    /** Re-read the authoritative snapshot after the replay cursor falls outside the ring. */
    private async resyncSession(): Promise<void> {
        const code = this.session?.code;
        const connection = this.sseConnection;
        const revision = this.navigationRevision;
        const timelineId = this.session?.timelineId;
        if (!code) return;
        try {
            const { data, error, status } = await watchTogetherApi.getSession(code);
            // A response from a party we left must never restore its state.
            if (
                this.session?.code !== code ||
                this.sseConnection !== connection ||
                this.navigationRevision !== revision ||
                this.session.timelineId !== timelineId
            )
                return;
            if (error || !data?.party) {
                if (this.checkAuthError(status)) return;
                this.error = error || 'Session not found';
                return;
            }
            if (!this.acceptNavigationSnapshot(data.party.timelineId)) return;
            const previousItemId = this.session.itemId;
            const previousFileId = this.session.fileId;
            const retargeted = this.retargetPendingNavigation(data.party.timelineId);
            this.supersedeSeek();
            this.activeBufferCheckId = null;
            this.explicitPlayIntent = null;
            this.pendingPauseRevision = null;
            this.explicitPauseServerTime = 0;
            this.latestLocalSeek = null;
            this.hostPosition = null;
            this.catchUpMode = 'normal';
            this.isSyncing = false;
            this.catchUpPaused = false;
            this.isStalled = false;
            this.stalledByUser = null;
            this.session = data.party;
            this.preparePlaybackControlBinding();
            this.hostClientId = data.party.hostClientId ?? null;
            this.isHost = isHostDevice(data.party.hostClientId, this.getClientId());
            this.hasSyncedInitially = true;
            this.reanchorHostPosition(data.party.currentTime, data.party.isPlaying);
            this.applyAudioOnlyPartyExclusion();
            if (previousItemId !== data.party.itemId) {
                this.navigationPlayerTimelineId = data.party.timelineId ?? null;
                setNavigatingWithinSessionFlag(true);
                this.onNavigateCallback?.(
                    data.party.itemId,
                    data.party.title,
                    data.party.host.userId,
                    data.party.fileId,
                );
            } else {
                if (this.navigationPlayerTimelineId !== null) {
                    if (retargeted || previousFileId !== data.party.fileId) {
                        setNavigatingWithinSessionFlag(true);
                        this.onNavigateCallback?.(
                            data.party.itemId,
                            data.party.title,
                            data.party.host.userId,
                            data.party.fileId,
                            true,
                        );
                    }
                    return;
                }
                if (data.party.fileId && previousFileId !== data.party.fileId) {
                    this.onVersionChangeCallback?.(
                        data.party.fileId,
                        data.party.host.userId,
                        data.party.host.displayName ?? '',
                    );
                }
                this.onSyncCallback?.({
                    currentTime: data.party.currentTime,
                    isPlaying: data.party.isPlaying,
                    playbackRate: data.party.playbackRate,
                    timestamp: Date.now(),
                    fileId: data.party.fileId,
                });
            }
        } catch (error) {
            if (this.session?.code === code && this.sseConnection === connection) {
                this.error = error instanceof Error ? error.message : 'Failed to resync session';
            }
        }
    }

    /**
     * Handle incoming SSE events
     */
    private handleSSEEvent(event: SSEEventType): void {
        if (!this.session) return;
        if (
            [
                'sync',
                'buffer_check',
                'all_ready',
                'host_position',
                'stall',
                'resume',
                'version_change',
            ].includes(event.type) &&
            'timelineId' in event &&
            event.timelineId
        ) {
            const incoming = event.timelineId;
            if (
                this.session.timelineId &&
                incoming !== this.session.timelineId &&
                incoming !== this.pendingNavigationTimelineId
            )
                return;
            if (incoming === this.pendingNavigationTimelineId)
                this.session = { ...this.session, timelineId: incoming };
        }

        switch (event.type) {
            case 'resync':
                void this.resyncSession();
                break;
            case 'connected': {
                if (!this.acceptNavigationSnapshot(event.party.timelineId)) break;
                if (this.navigationRecoveryNeeded && this.onNavigateCallback) {
                    this.recoverNavigationDestination(event.party);
                    break;
                }
                const sameStartupBinding =
                    this.session?.code === event.party.code &&
                    this.session.itemId === event.party.itemId &&
                    this.session.timelineId === event.party.timelineId &&
                    this.session.hostClientId === event.party.hostClientId;
                if (this.pendingStartupSync && !sameStartupBinding) {
                    // A new canonical item, timeline or host retires every local control
                    // and fallback owned by the player that is being replaced.
                    this.supersedeSeek();
                    this.latestLocalSeek = null;
                    this.explicitPlayIntent = null;
                    this.pendingPauseRevision = null;
                    this.explicitPauseServerTime = 0;
                    this.activeBufferCheckId = null;
                    if (this.bufferCheckWatchdog) clearTimeout(this.bufferCheckWatchdog);
                    this.bufferCheckWatchdog = null;
                    this.isSyncing = false;
                    this.catchUpPaused = false;
                }
                const localSeekOwnsStartup =
                    this.pendingStartupSync &&
                    sameStartupBinding &&
                    this.activeBufferCheckId?.startsWith('local-seek-') &&
                    (!event.bufferCheck?.seekInitiated ||
                        this.ownSeekNotSent() ||
                        Math.abs(
                            event.bufferCheck.currentTime - (this.latestLocalSeek?.target ?? 0),
                        ) > 0.01);
                if (
                    !localSeekOwnsStartup &&
                    this.isHost &&
                    event.bufferCheck?.seekInitiated &&
                    this.ownSeekNotSent()
                )
                    break;
                if (
                    !localSeekOwnsStartup &&
                    this.isHost &&
                    this.latestLocalSeek &&
                    event.bufferCheck?.seekInitiated &&
                    Math.abs(event.bufferCheck.currentTime - this.latestLocalSeek.target) > 0.01
                )
                    break;
                // Check if session moved to different video (can happen on SSE reconnect)
                const startupSync = this.pendingStartupSync;
                const connectedBinding = JSON.stringify([
                    event.party.code,
                    event.party.itemId,
                    event.party.timelineId,
                    event.party.fileId,
                    event.party.hostClientId,
                ]);
                const reconnectingSamePlayer =
                    !startupSync && this.lastConnectedBinding === connectedBinding;
                this.lastConnectedBinding = connectedBinding;
                if (!reconnectingSamePlayer) this.hostPosition = null;
                this.pendingStartupSync = false;
                const previousItemId = this.session?.itemId;
                const previousTimelineId = this.session?.timelineId;
                const retargeted = this.retargetPendingNavigation(event.party.timelineId);

                // Calculate clock offset for synchronized resume timing
                // Positive offset means server clock is ahead of client
                const receivedMonotonic = performance.now();
                const roundTrip = Math.max(0, receivedMonotonic - this.sseConnectStartedMonotonic);
                // Reconstruct the receive wall time from a monotonic elapsed
                // interval so an NTP/manual clock jump during the handshake
                // cannot corrupt the estimate. When the server supplies both
                // receive/send timestamps, use the standard NTP midpoint.
                const syntheticReceivedWall = this.sseConnectStartedWallTime + roundTrip;
                const estimatedServerAtReceipt =
                    syntheticReceivedWall +
                    (event.requestReceivedAt -
                        this.sseConnectStartedWallTime +
                        (event.serverTime - syntheticReceivedWall)) /
                        2;
                const clockOffset = estimatedServerAtReceipt - syntheticReceivedWall;
                log(' Clock offset calculated', {
                    serverTime: event.serverTime,
                    clientTime: syntheticReceivedWall,
                    offset: clockOffset,
                    roundTrip,
                });

                // Update isHost based on clientId (important for reconnects and multi-device support)
                const myClientIdOnConnect = this.getClientId();

                this.session = {
                    ...event.party,
                    isPlaying: this.barrierPlayIntent(
                        event.party.isPlaying,
                        startupSync
                            ? this.startupPlayRevision
                            : (this.latestLocalSeek?.revision ?? this.playRevision),
                    ),
                };
                if (
                    this.deferredNavigationBarrier &&
                    this.deferredNavigationBarrier.timelineId !== event.party.timelineId
                )
                    this.deferredNavigationBarrier = null;
                if (
                    this.deferredNavigationBarrier &&
                    event.bufferCheck?.checkId === this.deferredNavigationBarrier.checkId
                ) {
                    this.deferredNavigationBarrier = {
                        ...this.deferredNavigationBarrier,
                        currentTime: event.bufferCheck.currentTime,
                        isPlaying: event.bufferCheck.isPlaying,
                        seekInitiated: event.bufferCheck.seekInitiated ?? false,
                    };
                }
                this.isHost = isHostDevice(event.party.hostClientId, myClientIdOnConnect);
                this.hostClientId = event.party.hostClientId || null;
                this.isConnected = true;
                this.hasSyncedInitially = true;
                this.preparePlaybackControlBinding();
                this.serverClockAtReceipt = estimatedServerAtReceipt;
                this.serverClockReceiptMonotonic = performance.now();
                this.serverClockUncertaintyMs = roundTrip / 2;
                this.serverDownlinkEstimate = Math.max(
                    0,
                    estimatedServerAtReceipt - event.serverTime,
                );

                const sameItemNewTimeline =
                    previousItemId === event.party.itemId &&
                    Boolean(previousTimelineId && previousTimelineId !== event.party.timelineId);
                if (sameItemNewTimeline) {
                    this.supersedeSeek();
                    this.activeBufferCheckId = null;
                    this.isSyncing = false;
                    this.catchUpPaused = false;
                    if (this.navigationPlayerTimelineId === null)
                        this.onSeekCallback?.(
                            event.party.currentTime,
                            'system',
                            event.party.isPlaying,
                            true,
                        );
                }

                if (
                    retargeted &&
                    previousItemId === event.party.itemId &&
                    this.onNavigateCallback
                ) {
                    setNavigatingWithinSessionFlag(true);
                    this.onNavigateCallback(
                        event.party.itemId,
                        event.party.title,
                        event.party.host.userId,
                        event.party.fileId,
                        true,
                    );
                    break;
                }

                if (previousItemId && previousItemId !== event.party.itemId)
                    this.navigationPlayerTimelineId = event.party.timelineId ?? null;

                // If the session's video changed while we were disconnected, trigger navigate
                // This handles the case where we missed a navigate event during SSE disconnect
                if (
                    previousItemId &&
                    previousItemId !== event.party.itemId &&
                    this.onNavigateCallback
                ) {
                    log(' Session video changed during disconnect', {
                        from: previousItemId,
                        to: event.party.itemId,
                    });
                    // Set flag to preserve storage during the redirect
                    this.navigationPlayerTimelineId = event.party.timelineId ?? null;
                    setNavigatingWithinSessionFlag(true);
                    this.onNavigateCallback(
                        event.party.itemId,
                        event.party.title,
                        'system',
                        event.party.fileId,
                    );
                }

                // Only sync position/state for NON-hosts (joiners)
                // Host is the authority and shouldn't seek back to their own position
                // The connected snapshot is authoritative. The delayed join
                // buffer check may already have completed before this stream
                // opened, in which case forcing a pause would freeze the guest.
                if (
                    !localSeekOwnsStartup &&
                    this.navigationPlayerTimelineId !== event.party.timelineId &&
                    (!this.isHost || sameItemNewTimeline || startupSync) &&
                    (!previousItemId || previousItemId === event.party.itemId)
                ) {
                    const position = this.connectedSnapshotPosition(
                        event.party,
                        previousItemId,
                        Boolean(event.bufferCheck),
                        reconnectingSamePlayer,
                    );
                    const playing = event.bufferCheck
                        ? false
                        : startupSync
                          ? this.session.isPlaying
                          : event.party.isPlaying;
                    // A restored host is a new player, not an already-running
                    // clock authority. Apply the handshake before heartbeats.
                    if (startupSync) this.onSeekCallback?.(position, 'system', false, true);
                    if (this.onSyncCallback) {
                        this.onSyncCallback({
                            currentTime: position,
                            isPlaying: playing,
                            playbackRate: event.party.playbackRate,
                            timestamp: Date.now(),
                        });
                    }
                }
                if (
                    localSeekOwnsStartup ||
                    (!event.bufferCheck && this.activeBufferCheckId?.startsWith('local-seek-'))
                )
                    break;
                if (!event.bufferCheck && this.bufferCheckWatchdog) {
                    clearTimeout(this.bufferCheckWatchdog);
                    this.bufferCheckWatchdog = null;
                }
                const repeatedBufferCheck = event.bufferCheck?.checkId === this.activeBufferCheckId;
                this.activeBufferCheckId = event.bufferCheck?.checkId ?? null;
                this.activeBufferCheckTimelineId = event.party.timelineId;
                if (event.bufferCheck) {
                    this.activeBarrierRevision = startupSync
                        ? this.startupPlayRevision
                        : (this.latestLocalSeek?.revision ?? this.playRevision);
                    const intent = this.barrierPlayIntent(event.bufferCheck.isPlaying);
                    this.armBufferCheckWatchdog(
                        event.bufferCheck.checkId,
                        event.bufferCheck.currentTime,
                        intent,
                    );
                    this.isSyncing = true;
                    this.catchUpPaused = true;
                    this.session = {
                        ...this.session,
                        currentTime: event.bufferCheck.currentTime,
                        isPlaying: intent,
                    };
                    if (
                        this.navigationPlayerTimelineId &&
                        this.navigationPlayerTimelineId === event.party.timelineId
                    ) {
                        this.deferredNavigationBarrier = {
                            type: 'buffer_check',
                            timelineId: event.party.timelineId,
                            checkId: event.bufferCheck.checkId,
                            currentTime: event.bufferCheck.currentTime,
                            isPlaying: intent,
                            seekInitiated: event.bufferCheck.seekInitiated ?? false,
                            initiator: 'system',
                        };
                        if (this.bufferCheckWatchdog) clearTimeout(this.bufferCheckWatchdog);
                        this.bufferCheckWatchdog = null;
                    } else if (!repeatedBufferCheck) {
                        this.onBufferCheckCallback?.(
                            event.bufferCheck.checkId,
                            event.bufferCheck.currentTime,
                            'system',
                            intent,
                            event.bufferCheck.seekInitiated ?? false,
                        );
                    }
                }
                break;
            }

            case 'sync': {
                this.recoverySyncEchoes = this.recoverySyncEchoes.filter(
                    (echo) => echo.expiresAt > Date.now(),
                );
                // Recovery already reanchored this tab. Its own asynchronous
                // echo must not supersede a pending play or a newer control.
                if (
                    isOwnEvent(
                        event.clientId,
                        event.author.userId,
                        this.getClientId(),
                        this.currentUserId,
                    ) &&
                    this.recoverySyncEchoes.some(
                        (echo) => echo.code === this.session?.code && echo.syncId === event.syncId,
                    )
                )
                    break;
                if (this.deferredNavigationCompletion) {
                    this.deferredNavigationCompletion = null;
                    this.deferredNavigationBarrier = null;
                    this.activeBufferCheckId = null;
                    this.isSyncing = false;
                    if (this.bufferCheckWatchdog) clearTimeout(this.bufferCheckWatchdog);
                    this.bufferCheckWatchdog = null;
                }
                // A local control revised intent when issued; its later
                // confirmation must not erase a newer queued seek.
                if (
                    !isOwnEvent(
                        event.clientId,
                        event.author.userId,
                        this.getClientId(),
                        this.currentUserId,
                    )
                )
                    this.supersedeSeek(
                        event.state.isPlaying,
                        event.state.isPlaying &&
                            this.activeBufferCheckId?.startsWith('local-seek-') === true,
                    );
                if (!event.state.isPlaying) this.explicitPauseServerTime = event.state.timestamp;
                // Update local session state from sync event
                // This keeps session.currentTime fresh so guests don't broadcast stale positions
                // Also update hostPosition so catch-up sync knows current state immediately
                this.lastSyncTime = event.state.timestamp;
                if (this.session) {
                    this.session = {
                        ...this.session,
                        timelineId:
                            event.timelineId === this.pendingNavigationTimelineId
                                ? event.timelineId
                                : this.session.timelineId,
                        currentTime: event.state.currentTime,
                        isPlaying: event.state.isPlaying,
                        playbackRate: event.state.playbackRate,
                    };
                }
                // Initialize or update hostPosition for catch-up sync
                // This ensures guests have host position data immediately after first sync
                if (!this.isHost) {
                    this.hostPosition = {
                        position: event.state.currentTime,
                        timestamp: event.state.timestamp,
                        receivedAt: this.monotonicNow(),
                        isPlaying: event.state.isPlaying,
                        playbackRate: event.state.playbackRate,
                    };
                }

                if (event.timelineId && event.timelineId === this.navigationPlayerTimelineId) break;

                // Own confirmations also carry canonical order: a peer control
                // may have been applied while this request was still in flight.
                this.onSyncCallback?.(event.state);
                const myClientId = this.getClientId();
                if (
                    !isOwnEvent(event.clientId, event.author.userId, myClientId, this.currentUserId)
                ) {
                    // Notify about play/pause action (unless it's a system event)
                    if (event.author.userId !== 'system' && this.onActionCallback) {
                        const action = event.state.isPlaying ? 'play' : 'pause';
                        this.onActionCallback(
                            action,
                            event.author.userId,
                            event.author.displayName ?? '',
                        );
                    }
                }
                break;
            }

            case 'navigate': {
                if (!this.acceptNavigationSnapshot(event.timelineId)) break;
                const entryPosition = event.currentTime ?? 0;
                const wasWaiting = this.navigationPlayerTimelineId !== null;
                const sameItem = this.session?.itemId === event.itemId;
                const retargeted = this.retargetPendingNavigation(event.timelineId);
                const reusesLoadedItem =
                    !wasWaiting && sameItem && this.session?.fileId === event.fileId;
                this.navigationRevision++;
                this.invalidatePlaybackControls();
                this.navigationRequest = null;
                this.supersedeSeek();
                this.latestLocalSeek = null;
                this.hostPosition = null;
                this.deferredNavigationCompletion = null;
                this.deferredNavigationVersion = null;
                this.deferredNavigationStall = null;
                this.deferredNavigationBarrier = null;
                this.activeBufferCheckId = null;
                if (this.bufferCheckWatchdog) clearTimeout(this.bufferCheckWatchdog);
                this.bufferCheckWatchdog = null;
                this.isSyncing = false;
                this.catchUpPaused = false;
                this.isStalled = false;
                this.stalledByUser = null;
                // Update session with new itemId and fileId (important for mismatch detection)
                if (this.session) {
                    this.session = {
                        ...this.session,
                        itemId: event.itemId,
                        timelineId: event.timelineId,
                        currentTime: entryPosition,
                        isPlaying: false,
                        title: event.title,
                        fileId: event.fileId,
                    };
                }

                if (reusesLoadedItem) {
                    this.onSeekCallback?.(entryPosition, 'system', false, true);
                    this.onSyncCallback?.({
                        currentTime: entryPosition,
                        isPlaying: false,
                        playbackRate: this.session?.playbackRate ?? 1,
                        timestamp: Date.now(),
                    });
                    break;
                }
                this.navigationPlayerTimelineId = event.timelineId ?? null;

                // Don't apply our own navigate events (filter by clientId, fallback to userId)
                const ownNavEvent = isOwnEvent(
                    event.clientId,
                    event.author.userId,
                    this.getClientId(),
                    this.currentUserId,
                );

                log(' Navigate event received', {
                    itemId: event.itemId,
                    fileId: event.fileId,
                    fromUserId: event.author.userId,
                    fromClientId: event.clientId,
                    myClientId: this.getClientId(),
                    myUserId: this.currentUserId,
                    isOwnEvent: ownNavEvent,
                });

                if (!ownNavEvent && this.onNavigateCallback) {
                    // Set flag to preserve storage during the redirect
                    setNavigatingWithinSessionFlag(true);
                    this.onNavigateCallback(
                        event.itemId,
                        event.title,
                        event.author.userId,
                        event.fileId,
                        wasWaiting && sameItem && retargeted,
                    );
                }
                break;
            }

            case 'participant_joined': {
                if (this.session) {
                    // Check if this exact client already exists (same clientId)
                    // Allow same userId with different clientIds (multi-device support)
                    const exists = this.session.participants.some(
                        (p) => p.clientId === event.participant.clientId,
                    );
                    if (!exists) {
                        this.session = {
                            ...this.session,
                            participants: [...this.session.participants, event.participant],
                        };
                    }
                }
                // Notify about the new participant (don't notify about our own clientId joining)
                const isOwnJoin = event.participant.clientId === this.getClientId();
                if (!isOwnJoin && this.onParticipantJoinedCallback) {
                    this.onParticipantJoinedCallback(event.participant);
                }
                break;
            }

            case 'participant_left':
                if (this.session) {
                    // If clientId is provided, only remove that specific client
                    // Otherwise remove all participants with this userId (legacy behavior)
                    const newParticipants = event.clientId
                        ? this.session.participants.filter((p) => p.clientId !== event.clientId)
                        : this.session.participants.filter((p) => p.userId !== event.author.userId);
                    this.session = {
                        ...this.session,
                        participants: newParticipants,
                    };
                }
                // Notify about the participant leaving
                if (this.onParticipantLeftCallback) {
                    this.onParticipantLeftCallback(
                        event.author.userId,
                        event.author.displayName ?? '',
                    );
                }
                break;

            case 'session_ended':
                if (this.onSessionEndedCallback) {
                    this.onSessionEndedCallback(event.host.userId, event.host.displayName ?? '');
                }
                clearStorage();
                this.disconnect();
                break;

            case 'buffer_check': {
                if (this.isHost && event.seekInitiated && this.ownSeekNotSent()) break;
                if (
                    this.isHost &&
                    event.seekInitiated &&
                    this.latestLocalSeek &&
                    Math.abs(event.currentTime - this.latestLocalSeek.target) > 0.01
                )
                    break;
                this.activeBarrierRevision =
                    event.seekInitiated && this.latestLocalSeek
                        ? this.latestLocalSeek.revision
                        : this.playRevision;
                const intent = this.barrierPlayIntent(event.isPlaying);
                if (this.activeBufferCheckId === event.checkId) {
                    this.armBufferCheckWatchdog(event.checkId, event.currentTime, intent);
                    break;
                }
                // Server is requesting all clients to buffer at position and signal ready
                // Pause catch-up sync during the sync flow
                // Update session.currentTime to the target position so guests use correct position
                this.isSyncing = true;
                this.catchUpPaused = true;
                this.activeBufferCheckId = event.checkId;
                this.activeBufferCheckTimelineId = event.timelineId ?? this.session?.timelineId;
                this.armBufferCheckWatchdog(event.checkId, event.currentTime, intent);
                if (this.session) {
                    this.session = {
                        ...this.session,
                        timelineId:
                            event.timelineId === this.pendingNavigationTimelineId
                                ? event.timelineId
                                : this.session.timelineId,
                        currentTime: event.currentTime,
                        isPlaying: intent,
                    };
                }
                if (event.timelineId && event.timelineId === this.navigationPlayerTimelineId) {
                    this.deferredNavigationBarrier = event;
                    if (this.bufferCheckWatchdog) clearTimeout(this.bufferCheckWatchdog);
                    this.bufferCheckWatchdog = null;
                    break;
                }
                if (this.onBufferCheckCallback) {
                    this.onBufferCheckCallback(
                        event.checkId,
                        event.currentTime,
                        event.initiator,
                        intent,
                        event.seekInitiated ?? false,
                    );
                }
                break;
            }

            case 'all_ready': {
                if (this.isHost && this.ownSeekNotSent()) break;
                // A delayed completion from a superseded barrier must never
                // resume or seek the current generation.
                const missedInitial =
                    this.activeBufferCheckId?.startsWith('local-seek-') &&
                    this.latestLocalSeek &&
                    Math.abs(event.currentTime - this.latestLocalSeek.target) <= 0.01;
                if (this.activeBufferCheckId !== event.checkId && !missedInitial) break;
                const callbackId = missedInitial ? this.activeBufferCheckId! : event.checkId;
                if (event.timelineId && event.timelineId === this.navigationPlayerTimelineId) {
                    this.deferredNavigationCompletion = event;
                    if (this.session)
                        this.session = {
                            ...this.session,
                            currentTime: event.currentTime,
                            isPlaying: this.barrierPlayIntent(event.isPlaying),
                        };
                    break;
                }
                if (
                    !this.isHost &&
                    this.explicitPlayIntent?.isPlaying === false &&
                    this.pendingPauseRevision === null &&
                    event.isPlaying &&
                    event.serverTime > this.explicitPauseServerTime + this.serverClockUncertaintyMs
                ) {
                    // A later authoritative completion can heal a missed Play.
                    // Older completions and a pause still awaiting the server
                    // retain the deliberate local pause.
                    this.explicitPlayIntent = null;
                    this.explicitPauseServerTime = 0;
                }
                const isPlaying = this.barrierPlayIntent(event.isPlaying);
                this.activeBufferCheckId = null;
                if (this.bufferCheckWatchdog) clearTimeout(this.bufferCheckWatchdog);
                this.bufferCheckWatchdog = null;
                // A barrier that ends paused settles the play state: our earlier
                // "playing" seek intent is void. One that ends playing keeps it until
                // the scheduled resume has actually started the element.
                if (!isPlaying) this.settleSeekIntent();
                // All clients are ready - schedule synchronized resume
                // Resume catch-up sync after the sync flow completes
                // Update session.currentTime to the final synchronized position
                this.isSyncing = false;
                this.catchUpPaused = false;
                if (this.session) {
                    this.session = {
                        ...this.session,
                        currentTime: event.currentTime,
                        isPlaying, // Will match intended play state
                    };
                }
                if (this.deferredNavigationBarrier?.checkId === event.checkId) break;
                if (this.onAllReadyCallback) {
                    // all_ready carries a fresh server send timestamp, so
                    // re-anchor on every barrier instead of accumulating
                    // oscillator drift from the original SSE handshake.
                    const estimatedServerNow = event.serverTime + this.serverDownlinkEstimate;
                    this.serverClockAtReceipt = estimatedServerNow;
                    this.serverClockReceiptMonotonic = performance.now();
                    const lateness = Math.max(0, estimatedServerNow - event.resumeAt);
                    const resumeDelay = Math.max(0, event.resumeAt - estimatedServerNow);
                    const projectedTime = isPlaying
                        ? event.currentTime + (lateness / 1000) * (this.session?.playbackRate ?? 1)
                        : event.currentTime;
                    log(' all_ready resume delay', {
                        serverResumeAt: event.resumeAt,
                        estimatedServerNow,
                        delay: resumeDelay,
                    });
                    // Re-anchor the catch-up reference to the freshly synchronized
                    // position. The barrier (buffer_check/all_ready) is the only
                    // place a host seek reaches guests — it never emits a
                    // host_position, so without this the drift compensator keeps
                    // extrapolating from the pre-seek anchor (up to ~5s until the
                    // next heartbeat) and hard-seeks the guest back off target.
                    this.reanchorHostPosition(projectedTime, isPlaying, resumeDelay);
                    this.onAllReadyCallback(callbackId, projectedTime, resumeDelay, isPlaying);
                }
                break;
            }

            case 'reaction':
                // Emoji reaction from a participant
                if (this.onReactionCallback) {
                    this.onReactionCallback(
                        event.emoji,
                        event.author.userId,
                        event.author.displayName ?? '',
                    );
                }
                break;

            case 'screen_effect':
                // Screen effect from a participant (shake, confetti, etc.)
                if (this.onScreenEffectCallback) {
                    this.onScreenEffectCallback(
                        event.effect,
                        event.author.userId,
                        event.author.displayName ?? '',
                    );
                }
                break;

            case 'version_change': {
                // File/version change from a participant
                log(' Received version_change event', {
                    fileId: event.fileId,
                    fromUser: event.author.userId,
                });

                // Skip if this is our own event
                if (
                    isOwnEvent(
                        event.clientId,
                        event.author.userId,
                        this.getClientId(),
                        this.currentUserId,
                    )
                ) {
                    log(' Ignoring own version_change event');
                    break;
                }

                // Update session state
                if (this.session) {
                    this.session = {
                        ...this.session,
                        fileId: event.fileId,
                    };
                }

                if (this.navigationPlayerTimelineId === this.session?.timelineId) {
                    this.deferredNavigationVersion = event;
                    break;
                }
                if (this.onVersionChangeCallback) {
                    this.onVersionChangeCallback(
                        event.fileId,
                        event.author.userId,
                        event.author.displayName ?? '',
                    );
                }
                break;
            }

            case 'host_position':
                // Host broadcasting their position for smooth catch-up sync
                // Only process if we're NOT the host (hosts don't need to catch up to themselves)
                if (!this.isHost) {
                    // Anchor the position at when the server SENT it, not when it
                    // arrived: a host_position replayed after a reconnect (or held up
                    // by a stalled connection) is seconds old, and taken as "now" it
                    // made a playing host look seconds behind — the guest hard-seeked
                    // back (web e2e, network blip: 8.3 s -> 4.6 s). Needs the server
                    // clock estimate from `connected` / `all_ready`; without one it
                    // falls back to receipt time as before.
                    const rawAgeMs =
                        this.serverClockAtReceipt > 0
                            ? this.serverClockAtReceipt +
                              (performance.now() - this.serverClockReceiptMonotonic) -
                              event.timestamp
                            : 0;
                    // Trust only the age beyond the estimate's uncertainty: on a slow
                    // `connected` (cold server) the estimate ran ~1.5 s ahead, every
                    // live position looked 1.5 s old and a web guest sat 1.5 s ahead
                    // of an Apple TV host. Replayed positions are seconds old, so
                    // they are still aged (by all but the uncertainty).
                    // Capped: a slow handshake (TLS, auth, cold server) would otherwise
                    // let an ~11 s old replay pass as live (same cap on tvOS).
                    const uncertaintyMs = Math.min(
                        this.serverClockUncertaintyMs,
                        MAX_CLOCK_UNCERTAINTY_MS,
                    );
                    const ageMs = Math.max(0, rawAgeMs - uncertaintyMs);
                    this.hostPosition = {
                        position: event.position,
                        timestamp: event.timestamp,
                        receivedAt: this.monotonicNow() - ageMs,
                        isPlaying: event.isPlaying,
                        playbackRate: event.playbackRate,
                    };

                    if (this.onHostPositionCallback) {
                        this.onHostPositionCallback(
                            event.position,
                            event.timestamp,
                            event.isPlaying,
                            event.playbackRate,
                        );
                    }
                }
                break;

            case 'host_changed': {
                // Previous host left, new host was elected
                // Determine if THIS device is the new host by comparing clientIds
                const myClientIdForHostChange = this.getClientId();
                const amINewHost = event.newHostClientId === myClientIdForHostChange;

                log(' Host changed', {
                    newHost: event.newHost.userId,
                    newHostDisplayName: event.newHost.displayName ?? '',
                    newHostClientId: event.newHostClientId,
                    myClientId: myClientIdForHostChange,
                    amINewHost,
                });

                this.isHost = amINewHost;
                this.hostClientId = event.newHostClientId || null;
                if (this.session) {
                    this.session = {
                        ...this.session,
                        host: event.newHost,
                        hostClientId: event.newHostClientId,
                    };
                }
                // Reset catch-up mode if we became the host
                if (amINewHost) {
                    this.catchUpMode = 'normal';
                    this.hostPosition = null;
                }
                // Reset host activity when host changes
                this.hostActivity = 'watching';
                this.hostActivityMessage = null;

                if (this.onHostChangedCallback) {
                    this.onHostChangedCallback(
                        event.newHost.userId,
                        event.newHost.displayName ?? '',
                    );
                }
                break;
            }

            case 'host_activity':
                // Host is broadcasting their activity status (searching, browsing, etc.)
                log(' Host activity', {
                    activity: event.activity,
                    message: event.message,
                });

                this.hostActivity = event.activity;
                this.hostActivityMessage = event.message || null;

                if (this.onHostActivityCallback) {
                    this.onHostActivityCallback(event.activity, event.message);
                }
                break;

            case 'visibility_changed':
                // Session visibility changed
                log(' Visibility changed', { visibility: event.visibility });

                if (this.session) {
                    this.session = {
                        ...this.session,
                        visibility: event.visibility,
                    };
                }
                break;

            case 'stall': {
                // Someone is buffering - pause the group
                log(' Stall event', {
                    userId: event.author.userId,
                    displayName: event.author.displayName ?? '',
                });

                this.isStalled = true;
                this.stalledByUser = event.author.displayName ?? '';
                this.catchUpPaused = true; // Disable catch-up during stall
                if (this.navigationPlayerTimelineId === this.session?.timelineId) {
                    this.deferredNavigationStall = event;
                    break;
                }

                // Don't notify about our own stall
                if (
                    !isOwnEvent(
                        event.clientId,
                        event.author.userId,
                        this.getClientId(),
                        this.currentUserId,
                    ) &&
                    this.onStallCallback
                ) {
                    this.onStallCallback(event.author.userId, event.author.displayName ?? '');
                }
                break;
            }

            case 'resume':
                // Stalled user is ready - resume the group
                log(' Resume event');

                this.isStalled = false;
                this.stalledByUser = null;
                this.deferredNavigationStall = null;
                this.catchUpPaused = false; // Re-enable catch-up

                if (this.navigationPlayerTimelineId === this.session?.timelineId) break;
                if (this.onResumeCallback) {
                    this.onResumeCallback();
                }
                break;
        }
    }

    /**
     * Send playback state sync (play/pause)
     *
     * For guests: Only sends play/pause state, NOT position.
     * Position is only updated by explicit seek actions (broadcastSeek).
     * This prevents guests from accidentally broadcasting stale positions.
     */
    async syncPlaybackState(
        currentTime: number,
        isPlaying: boolean,
        playbackRate = 1,
    ): Promise<void> {
        if (this.navigationPlayerTimelineId !== null) return;
        log(' syncPlaybackState called', {
            hasSession: !!this.session,
            sessionCode: this.session?.code,
            isHost: this.isHost,
            currentTime,
            isPlaying,
            playbackRate,
        });

        const session = this.session;
        if (!session) {
            log(' syncPlaybackState: No session, aborting');
            return;
        }
        // An explicit play/pause supersedes the intent of an earlier seek.
        this.supersedeSeek(
            isPlaying,
            isPlaying && this.activeBufferCheckId?.startsWith('local-seek-') === true,
        );
        const controlRevision = this.playRevision;
        const lifecycleRevision = this.navigationRevision;
        if (!isPlaying) this.pendingPauseRevision = controlRevision;

        // Optimistically apply our own play/pause to local state. The server
        // excludes the sender from the echoed `sync`, so without this a pausing
        // guest's local session.isPlaying stays stale-true — which lets stall-resume
        // auto-resume it and keeps getExpectedHostPosition() extrapolating the host
        // forward, so the drift compensator yanks the paused guest ahead ("pauses
        // but doesn't really pause"). Freezing the host anchor on pause stops the
        // extrapolation immediately. Authoritative events (all_ready / host_position
        // / connected) heal this within seconds; on a failed POST the guest just
        // stays paused, matching intent.
        this.session = { ...session, isPlaying, lastSync: Date.now() };
        if (!this.isHost && !isPlaying && this.hostPosition) {
            this.hostPosition = { ...this.hostPosition, isPlaying: false };
        }

        // For guests, use the session's current position instead of their local position
        // This prevents accidentally broadcasting wrong positions (e.g., video started at 0)
        // Guests can only update position via explicit seek (broadcastSeek).
        // Exception: a guest PAUSING a playing party sends where it really is. The
        // session position is the host's last heartbeat (up to ~5 s old), so pausing
        // with it rewound every player, the host included. The server only accepts a
        // guest's pause position when it sits at/just ahead of that heartbeat, so a
        // guest still at 0 cannot rewind the party.
        const guestPausingPlayback = !this.isHost && !isPlaying && session.isPlaying;
        const positionToSync =
            this.isHost || guestPausingPlayback ? currentTime : session.currentTime;
        const code = session.code;

        try {
            const syncRequest: SyncRequest = {
                itemId: session.itemId,
                expectedTimelineId: session.timelineId,
                currentTime: positionToSync,
                isPlaying,
                playbackRate,
                clientId: this.getClientId(),
            };
            log(' Sending sync request', {
                url: `/api/watch-together/${code}/sync`,
                syncRequest,
            });
            const { error: syncError, status } = await this.queuePlaybackControl(() =>
                watchTogetherApi.syncPlayback(code, syncRequest),
            );
            log(' Sync response', {
                ok: !syncError,
                status,
            });
            // Check for auth error
            if (syncError) {
                this.checkAuthError(status);
            }
        } catch (error) {
            console.error('[WatchTogether] Sync error:', error);
        } finally {
            if (
                lifecycleRevision === this.navigationRevision &&
                this.session?.code === code &&
                this.pendingPauseRevision === controlRevision
            ) {
                this.pendingPauseRevision = null;
                this.explicitPauseServerTime = Math.max(
                    this.explicitPauseServerTime,
                    this.estimatedServerTime(),
                );
            }
        }
    }

    /**
     * Should a seek this tab is about to broadcast leave the party playing?
     *
     * A coordinated party seek pauses this tab's own <video> until all_ready (the
     * barrier owns the resume). A second seek pressed inside that window used to
     * read `video.paused` and broadcast `isPlaying: false` — four quick ArrowRight
     * presses by a playing host ended the whole party PAUSED. So while our own playing seek is still settling, its intent
     * wins over the element. An explicit play/pause clears it; after local readiness settles the seek, the element is the truth again.
     */
    seekResumeIntent(elementPlaying: boolean): boolean {
        if (elementPlaying) return true;
        const intent = this.ownSeekIntent;
        return (
            !!intent &&
            intent.isPlaying &&
            (this.seekSettling || Date.now() - intent.at < OWN_SEEK_INTENT_MS)
        );
    }

    /**
     * Broadcast a seek event.
     * Pauses catch-up sync during the seek flow (will resume on all_ready).
     *
     * @param currentTime - The position to seek to
     * @param isPlaying - Whether playback should resume after seek (default: true)
     */
    async broadcastSeek(currentTime: number, isPlaying: boolean = true): Promise<void> {
        if (this.navigationPlayerTimelineId !== null) return;
        if (!this.session) return;
        this.preparePlaybackControlBinding();
        const code = this.session.code;
        const itemId = this.session.itemId;
        const expectedTimelineId = this.session.timelineId;
        const generation = ++this.seekGeneration;
        const pendingId = `local-seek-${generation}`;
        this.latestLocalSeek = { generation, target: currentTime, revision: this.playRevision };
        this.activeBarrierRevision = this.playRevision;
        this.ownSeekIntent = { isPlaying, at: Date.now() };
        this.seekSettling = true;
        this.catchUpPaused = true;
        this.isSyncing = true;
        this.session = { ...this.session, currentTime, isPlaying };
        this.activeBufferCheckId = pendingId;
        // Start recovery before the request: either its response or its initial
        // SSE event can disappear. The server's real barrier replaces this one.
        this.armBufferCheckWatchdog(pendingId, currentTime, isPlaying);
        this.onBufferCheckCallback?.(
            pendingId,
            currentTime,
            this.currentUserId ?? '',
            isPlaying,
            true,
        );

        const command = {
            code,
            itemId,
            expectedTimelineId,
            generation,
            target: currentTime,
            isPlaying,
            revision: this.playRevision,
        };
        if (this.sendingSeek) {
            this.queuedSeek = command;
            return;
        }
        await this.sendSeekCommand(command);
    }

    private async sendSeekCommand(command: {
        code: string;
        itemId: string;
        expectedTimelineId?: string;
        generation: number;
        target: number;
        isPlaying: boolean;
        revision: number;
    }): Promise<void> {
        const senderEpoch = this.seekSenderEpoch;
        this.sendingSeek = true;
        const { code, itemId, expectedTimelineId, generation, target, isPlaying, revision } =
            command;
        const pendingId = `local-seek-${generation}`;
        try {
            const seekRequest: SeekRequest = {
                itemId,
                expectedTimelineId,
                currentTime: target,
                clientId: this.getClientId(),
                isPlaying,
            };
            const { error, status } = await this.queuePlaybackControl(() =>
                watchTogetherApi.broadcastSeek(code, seekRequest),
            );
            if (error) {
                if (generation === this.seekGeneration && this.session?.code === code) {
                    this.checkAuthError(status);
                    this.completeSeekRecovery(
                        pendingId,
                        target,
                        this.barrierPlayIntent(isPlaying, revision),
                    );
                }
            } else if (
                this.session?.code === code &&
                generation === this.seekGeneration &&
                this.session.itemId === itemId &&
                this.session.timelineId === expectedTimelineId &&
                this.explicitPlayIntent &&
                this.explicitPlayIntent.revision > revision &&
                !this.queuedSeek
            ) {
                // An in-flight seek can reach the server after an explicit pause.
                // Reassert the newer control after this older command settles.
                const correction = {
                    currentTime: this.session.currentTime,
                    isPlaying: this.explicitPlayIntent.isPlaying,
                    playbackRate: this.session.playbackRate,
                };
                await this.queuePlaybackControl(() =>
                    watchTogetherApi.syncPlayback(code, {
                        itemId,
                        expectedTimelineId,
                        currentTime: correction.currentTime,
                        clientId: this.getClientId(),
                        isPlaying: correction.isPlaying,
                        playbackRate: correction.playbackRate,
                    }),
                );
            }
        } catch (error) {
            console.error('[WatchTogether] Seek broadcast error:', error);
            if (generation === this.seekGeneration)
                this.completeSeekRecovery(
                    pendingId,
                    target,
                    this.barrierPlayIntent(isPlaying, revision),
                );
        } finally {
            if (senderEpoch === this.seekSenderEpoch) {
                this.sendingSeek = false;
                const queued = this.queuedSeek;
                this.queuedSeek = null;
                if (
                    queued &&
                    queued.generation === this.seekGeneration &&
                    this.session?.code === queued.code &&
                    this.session.itemId === queued.itemId &&
                    this.session.timelineId === queued.expectedTimelineId
                )
                    void this.sendSeekCommand(queued);
            }
        }
    }

    /**
     * Broadcast navigation to a new item.
     * Sets a flag to prevent disconnect() from clearing storage during navigation.
     */
    captureNavigationOwnership(): () => boolean {
        const code = this.session?.code;
        const revision = this.navigationRevision;
        const timelineId = this.pendingNavigationTimelineId ?? this.session?.timelineId;
        return () =>
            this.navigationRevision === revision &&
            this.session?.code === code &&
            this.session?.timelineId === timelineId;
    }

    private acceptNavigationSnapshot(timelineId: string | undefined): boolean {
        if (!this.pendingNavigationTimelineId || timelineId === this.pendingNavigationTimelineId)
            return true;
        // A reconnect can still see the predecessor while our request waits for
        // the server. That snapshot cannot abandon the pending destination.
        if (this.pendingNavigationPredecessors.has(timelineId)) return false;
        // A different canonical identity supersedes this request. Its delayed
        // acknowledgement must never restore the previous destination.
        this.navigationRevision++;
        this.invalidatePlaybackControls();
        this.navigationRequest = null;
        this.pendingNavigationTimelineId = null;
        this.pendingNavigationPredecessors.clear();
        return true;
    }

    private retargetPendingNavigation(timelineId: string | undefined): boolean {
        if (
            this.navigationPlayerTimelineId === null ||
            this.navigationPlayerTimelineId === timelineId
        )
            return false;
        this.navigationPlayerTimelineId = timelineId ?? null;
        this.deferredNavigationBarrier = null;
        this.deferredNavigationCompletion = null;
        this.deferredNavigationVersion = null;
        this.deferredNavigationStall = null;
        this.activeBufferCheckId = null;
        if (this.bufferCheckWatchdog) clearTimeout(this.bufferCheckWatchdog);
        this.bufferCheckWatchdog = null;
        this.isStalled = false;
        this.stalledByUser = null;
        this.isSyncing = false;
        this.catchUpPaused = false;
        return true;
    }

    private recoverNavigationDestination(party: WatchTogetherParty): void {
        this.session = party;
        this.navigationPlayerTimelineId = party.timelineId ?? null;
        if (!this.onNavigateCallback) return;
        this.navigationRecoveryNeeded = false;
        setNavigatingWithinSessionFlag(true);
        this.onNavigateCallback(party.itemId, party.title, party.host.userId, party.fileId, true);
    }

    async broadcastNavigate(
        itemId: string,
        title: string,
        mediaType: 'movie' | 'episode' | 'tv',
        fileId?: string,
    ): Promise<boolean> {
        if (!this.session) return false;
        const code = this.session.code;
        const revision = ++this.navigationRevision;
        this.navigationRecoveryNeeded = false;
        this.invalidatePlaybackControls();
        const timelineId = crypto.randomUUID();
        const predecessors = this.pendingNavigationTimelineId
            ? new SvelteSet(this.pendingNavigationPredecessors)
            : new SvelteSet<string | undefined>();
        predecessors.add(this.session.timelineId);
        if (this.pendingNavigationTimelineId) predecessors.add(this.pendingNavigationTimelineId);
        this.pendingNavigationPredecessors = predecessors;
        this.pendingNavigationTimelineId = timelineId;
        this.navigationPlayerTimelineId = timelineId;
        this.deferredNavigationCompletion = null;
        this.deferredNavigationVersion = null;
        this.deferredNavigationStall = null;
        this.seekGeneration++;
        this.queuedSeek = null;
        this.latestLocalSeek = null;
        setNavigatingWithinSessionFlag(true);
        const previous = this.navigationRequest;
        const request = (async () => {
            await previous?.catch(() => null);
            if (revision !== this.navigationRevision || this.session?.code !== code) return null;
            let expectedTimelineId = this.session?.timelineId;
            if (previous) {
                const fresh = await watchTogetherApi.getSession(code);
                if (
                    revision !== this.navigationRevision ||
                    this.session?.code !== code ||
                    !fresh.data?.party
                )
                    return null;
                expectedTimelineId = fresh.data.party.timelineId;
                this.pendingNavigationPredecessors.add(expectedTimelineId);
            }
            const body: NavigateRequest = {
                expectedTimelineId,
                itemId,
                title,
                mediaType,
                fileId,
                timelineId,
                clientId: this.getClientId(),
            };
            for (let attempt = 0; attempt < 3; attempt++) {
                if (revision !== this.navigationRevision || this.session?.code !== code)
                    return null;
                const result = await watchTogetherApi.broadcastNavigate(code, body);
                if (!result.error || (result.status >= 400 && result.status < 500) || attempt === 2)
                    return result;
                await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
            }
            return null;
        })();
        this.navigationRequest = request;
        try {
            const result = await request;
            let recovered: WatchTogetherParty | undefined;
            if (revision !== this.navigationRevision || this.session?.code !== code) return false;
            if (!result || result.error) {
                // The server may have committed a request whose acknowledgement was lost.
                const snapshot = await watchTogetherApi.getSession(code);
                if (revision !== this.navigationRevision || this.session?.code !== code)
                    return false;
                if (
                    snapshot.data?.party?.timelineId !== timelineId ||
                    snapshot.data.party.itemId !== itemId
                ) {
                    this.navigationRecoveryNeeded = true;
                    if (snapshot.data?.party)
                        this.recoverNavigationDestination(snapshot.data.party);
                    void this.connectToStream(code);
                    return false;
                }
                recovered = snapshot.data.party;
            }
            const keepsCurrentBarrier =
                this.activeBufferCheckId && this.activeBufferCheckTimelineId === timelineId;
            if (!keepsCurrentBarrier) {
                this.supersedeSeek();
                this.activeBufferCheckId = null;
                this.isSyncing = false;
                this.catchUpPaused = false;
            }
            const latestState = this.session.timelineId === timelineId ? this.session : recovered;
            // Both ends know the identity committed by this acknowledged request.
            // No follow-up read can delay controls or overwrite a newer navigation.
            this.session = {
                ...this.session,
                itemId,
                title,
                fileId,
                timelineId,
                currentTime: latestState?.currentTime ?? result?.data?.currentTime ?? 0,
                isPlaying: latestState?.isPlaying ?? false,
                playbackRate: latestState?.playbackRate ?? this.session.playbackRate,
            };
            this.hostPosition = null;
            return true;
        } catch (error) {
            console.error('[WatchTogether] Navigate broadcast error:', error);
            if (revision === this.navigationRevision && this.session?.code === code) {
                this.navigationRecoveryNeeded = true;
                void this.connectToStream(code);
            }
            return false;
        } finally {
            if (this.navigationRequest === request) this.navigationRequest = null;
            if (this.pendingNavigationTimelineId === timelineId) {
                this.pendingNavigationTimelineId = null;
                this.pendingNavigationPredecessors.clear();
            }
        }
    }

    /**
     * Broadcast a version/media source change to all participants.
     */
    async broadcastVersionChange(fileId: string): Promise<void> {
        if (!this.session) return;

        log(' Broadcasting version change', {
            fileId,
            sessionCode: this.session.code,
        });

        try {
            const versionRequest: VersionChangeRequest = {
                fileId,
                clientId: this.getClientId(),
            };
            await watchTogetherApi.broadcastVersionChange(this.session.code, versionRequest);
            log(' Version change broadcast sent successfully');
        } catch (error) {
            console.error('[WatchTogether] Version change broadcast error:', error);
        }
    }

    /**
     * Host only: called when the browser unfreezes this tab (Page Lifecycle `resume`).
     *
     * A frozen tab's media is stopped by the BROWSER, not by the user, while the guests
     * play on. Reporting that stop (the next heartbeat says paused) used to flip the
     * session to paused while the guests kept playing — a split party that never
     * healed. Instead the host catches up: if it was
     * playing when frozen and the server still has the party playing, this returns
     * where the party has got to by now (its position at the freeze + time since,
     * both from this tab), else null. The caller seeks its own player there and plays;
     * the guests never stopped, so the party itself does not move.
     */
    async freezeCatchUpTarget(
        frozen: { wasPlaying: boolean; position: number; at: number },
        now = Date.now(),
    ): Promise<number | null> {
        const local = this.session;
        if (!local || !this.isHost || !frozen.wasPlaying) return null;
        try {
            const { data, error } = await watchTogetherApi.getCurrentSession();
            const server = (error ? null : data?.party) as WatchTogetherParty | null;
            if (!server || server.code !== local.code || !server.isPlaying) return null;
            // From the host's own freeze record, on one clock. NOT from
            // server.currentTime + (now - lastSync): guest heartbeats keep bumping
            // lastSync while only the host moves currentTime, so that pulled the
            // whole party back by the length of the freeze.
            const elapsed = Math.max(0, (now - frozen.at) / 1000);
            return frozen.position + elapsed * (server.playbackRate || 1);
        } catch (error) {
            console.debug('[WatchTogether] freeze catch-up check failed:', error);
            return null;
        }
    }

    /**
     * Send heartbeat to update session position without broadcasting.
     * This keeps the session state fresh for new joiners.
     *
     * @param isPlaying - The caller's true play state. Persisted host-only on the
     *   server so `session.isPlaying` self-heals to the host's reality every ~5s,
     *   preventing a stale-true flag from telling a joining guest to resume against
     *   a paused host.
     */
    async sendHeartbeat(currentTime: number, isPlaying?: boolean, itemId?: string): Promise<void> {
        if (this.navigationPlayerTimelineId !== null || this.pendingStartupSync) return;
        if (!this.session) return;

        try {
            const heartbeatRequest: HeartbeatRequest = {
                itemId: itemId ?? this.session.itemId,
                expectedTimelineId: this.session.timelineId,
                currentTime,
                clientId: this.getClientId(),
                isPlaying: isPlaying ?? this.session.isPlaying,
            };
            await watchTogetherApi.sendHeartbeat(this.session.code, heartbeatRequest);
        } catch (error) {
            // Silently ignore heartbeat errors - they're not critical
            console.debug('[WatchTogether] Heartbeat error:', error);
        }
    }

    /**
     * Report position to server for drift detection.
     * Called periodically (every 10s) to check if clients are in sync.
     */
    async reportPosition(currentTime: number): Promise<void> {
        if (this.navigationPlayerTimelineId !== null) return;
        if (!this.session || this.isSyncing) return;

        try {
            const positionRequest: PositionRequest = {
                clientId: this.getClientId(),
                position: currentTime,
            };
            const { data } = await watchTogetherApi.reportPosition(
                this.session.code,
                positionRequest,
            );

            if (data?.resyncing) {
                // Server detected drift and is triggering a resync
                // The buffer_check SSE event will handle the actual sync
                console.debug('[WatchTogether] Server detected drift, resync triggered');
            }
        } catch (error) {
            // Silently ignore position report errors
            console.debug('[WatchTogether] Position report error:', error);
        }
    }

    /**
     * Disconnect from session and SSE stream.
     * If navigating within session, storage is preserved for rejoin on new page.
     * Note: This does NOT remove the user from the session on the server - they remain a participant.
     * The server uses getUserActiveSession() to track which session a user is in.
     */
    disconnect(): void {
        this.membershipRevision++;
        this.pendingStartupSync = false;
        this.pendingNavigationPredecessors.clear();
        this.navigationRecoveryNeeded = false;
        this.invalidatePlaybackControls();
        this.navigationRevision++;
        this.navigationRequest = null;
        const navigating = isNavigatingWithinSession();
        log(' disconnect() called', { isNavigatingWithinSession: navigating });

        if (this.sseConnection) {
            this.sseConnection.disconnect();
            this.sseConnection = null;
        }

        // Only clear storage if NOT navigating within the session
        // This allows rejoin on the new page after navigation
        // Even if storage is cleared, the server still knows we're in the session
        if (!navigating) {
            log(' Clearing localStorage (not navigating within session)');
            clearStorage();
        } else {
            log(' Preserving localStorage during navigation');
        }

        // Reset state to initial
        this.navigationPlayerTimelineId = null;
        this.pendingNavigationTimelineId = null;
        this.deferredNavigationBarrier = null;
        this.deferredNavigationCompletion = null;
        this.deferredNavigationVersion = null;
        this.deferredNavigationStall = null;
        this.session = null;
        this.isHost = false;
        this.hostClientId = null;
        this.isConnected = false;
        this.isConnecting = false;
        this.isSyncing = false;
        this.activeBufferCheckId = null;
        this.supersedeSeek();
        this.latestLocalSeek = null;
        this.recoverySyncEchoes = [];
        this.explicitPlayIntent = null;
        this.explicitPauseServerTime = 0;
        this.pendingPauseRevision = null;
        this.playRevision = 0;
        // The server clock estimate belongs to the old connection. Kept, it would
        // stamp the next session's pause with a stale server time, and a delayed
        // completion would then look newer than the pause and heal it.
        this.lastConnectedBinding = null;
        this.serverClockAtReceipt = 0;
        this.serverClockReceiptMonotonic = 0;
        this.serverClockUncertaintyMs = 0;
        this.serverDownlinkEstimate = 0;
        if (this.bufferCheckWatchdog) clearTimeout(this.bufferCheckWatchdog);
        this.bufferCheckWatchdog = null;
        this.error = null;
        this.lastSyncTime = 0;
        this.hasSyncedInitially = false;
        this.instability = initialInstabilityState();
        this.catchUpMode = 'normal';
        this.hostPosition = null;
        this.catchUpPaused = false;
        this.currentDrift = 0;
        this.hostActivity = 'watching';
        this.hostActivityMessage = null;
        this.isStalled = false;
        this.stalledByUser = null;
        this.driftTrend = 'stable';
        this.previousDrift = 0;
        this.effectivePlaybackRate = 1.0;
        this.currentUserId = null;

        // Clear event callbacks to prevent stale references from destroyed components
        this.onSyncCallback = null;
        this.onSeekCallback = null;
        this.onNavigateCallback = null;
        this.onSessionEndedCallback = null;
        this.onParticipantJoinedCallback = null;
        this.onParticipantLeftCallback = null;
        this.onActionCallback = null;
        this.onBufferCheckCallback = null;
        this.onAllReadyCallback = null;
        this.onReactionCallback = null;
        this.onScreenEffectCallback = null;
        this.onVersionChangeCallback = null;
        this.onHostActivityCallback = null;
        this.onHostPositionCallback = null;
        this.onHostChangedCallback = null;
        this.onStallCallback = null;
        this.onResumeCallback = null;

        // Note: We don't clear the navigation flag here - it will be cleared after successful rejoin
    }

    /**
     * Register event callbacks
     */
    onSync(callback: (state: WatchTogetherState) => void): void {
        this.onSyncCallback = callback;
    }

    onSeek(
        callback: (
            currentTime: number,
            userId: string,
            isPlaying: boolean,
            resetTimeline?: boolean,
        ) => void,
    ): void {
        this.onSeekCallback = callback;
    }

    onNavigate(
        callback: (
            itemId: string,
            title: string,
            userId: string,
            fileId?: string,
            reload?: boolean,
        ) => void,
    ): void {
        this.onNavigateCallback = callback;
    }

    onSessionEnded(callback: (hostUserId: string, hostDisplayName: string) => void): void {
        this.onSessionEndedCallback = callback;
    }

    onParticipantJoined(
        callback: (participant: { userId: string; displayName: string | null }) => void,
    ): void {
        this.onParticipantJoinedCallback = callback;
    }

    onParticipantLeft(callback: (userId: string, displayName: string) => void): void {
        this.onParticipantLeftCallback = callback;
    }

    onAction(
        callback: (action: 'play' | 'pause' | 'seek', userId: string, displayName: string) => void,
    ): void {
        this.onActionCallback = callback;
    }

    /** Re-enter deferred readiness only after the destination's loaded player is attached. */
    attachLoadedNavigationPlayer(itemId: string): void {
        if (
            this.pendingNavigationTimelineId ||
            this.session?.itemId !== itemId ||
            this.session.timelineId !== this.navigationPlayerTimelineId
        )
            return;
        this.navigationPlayerTimelineId = null;
        const stall = this.deferredNavigationStall;
        this.deferredNavigationStall = null;
        if (this.isStalled && stall?.timelineId === this.session.timelineId) {
            this.onStallCallback?.(stall.author.userId, stall.author.displayName ?? '');
        }
        const version = this.deferredNavigationVersion;
        this.deferredNavigationVersion = null;
        this.deferredNavigationStall = null;
        if (version && version.timelineId === this.session.timelineId) {
            this.onVersionChangeCallback?.(
                version.fileId,
                version.author.userId,
                version.author.displayName ?? '',
            );
        }
        const completion = this.deferredNavigationCompletion;
        this.deferredNavigationCompletion = null;
        if (
            completion?.timelineId === this.session.timelineId &&
            completion.checkId === this.activeBufferCheckId
        ) {
            this.deferredNavigationBarrier = null;
            this.handleSSEEvent(completion);
            return;
        }
        const barrier = this.deferredNavigationBarrier;
        if (barrier && this.session.timelineId !== barrier.timelineId) return;
        this.deferredNavigationBarrier = null;
        if (barrier && this.activeBufferCheckId === barrier.checkId) {
            const intent = this.barrierPlayIntent(this.session.isPlaying);
            this.armBufferCheckWatchdog(barrier.checkId, this.session.currentTime, intent);
            this.onBufferCheckCallback?.(
                barrier.checkId,
                this.session.currentTime,
                barrier.initiator,
                intent,
                barrier.seekInitiated,
            );
        } else {
            this.onSeekCallback?.(this.session.currentTime, 'system', this.session.isPlaying, true);
            this.onSyncCallback?.({
                currentTime: this.session.currentTime,
                isPlaying: this.session.isPlaying,
                playbackRate: this.session.playbackRate,
                timestamp: Date.now(),
            });
        }
    }

    onBufferCheck(
        callback: (
            checkId: string,
            currentTime: number,
            initiator: string,
            isPlaying: boolean,
            seekInitiated: boolean,
        ) => void,
    ): void {
        this.onBufferCheckCallback = callback;
    }

    onAllReady(
        callback: (
            checkId: string,
            currentTime: number,
            resumeDelay: number,
            isPlaying: boolean,
        ) => void,
    ): void {
        this.onAllReadyCallback = callback;
    }

    onReaction(callback: (emoji: string, userId: string, displayName: string) => void): void {
        this.onReactionCallback = callback;
    }

    onScreenEffect(callback: (effect: string, userId: string, displayName: string) => void): void {
        this.onScreenEffectCallback = callback;
    }

    /**
     * Register callback for version/media source changes
     */
    onVersionChange(callback: (fileId: string, userId: string, displayName: string) => void): void {
        this.onVersionChangeCallback = callback;
    }

    /**
     * Register callback for host position updates (for smooth catch-up sync)
     */
    onHostPosition(
        callback: (
            position: number,
            timestamp: number,
            isPlaying: boolean,
            playbackRate: number,
        ) => void,
    ): void {
        this.onHostPositionCallback = callback;
    }

    /**
     * Register callback for host change events (host succession)
     */
    onHostChanged(callback: (newHostUserId: string, newHostDisplayName: string) => void): void {
        this.onHostChangedCallback = callback;
    }

    /**
     * Register callback for host activity updates
     */
    onHostActivity(callback: (activity: HostActivity, message?: string) => void): void {
        this.onHostActivityCallback = callback;
    }

    /**
     * Register callback for when someone in the group stalls (buffering)
     */
    onStall(callback: (userId: string, displayName: string) => void): void {
        this.onStallCallback = callback;
    }

    /**
     * Register callback for when the group resumes after a stall
     */
    onResume(callback: () => void): void {
        this.onResumeCallback = callback;
    }

    /**
     * Broadcast host activity status to all participants (host only)
     * Call this when the host opens search, navigates to browse page, etc.
     */
    async broadcastActivity(activity: HostActivity, message?: string): Promise<void> {
        if (!this.session || !this.isHost) return;

        try {
            const activityRequest: ActivityRequest = { activity, message };
            await watchTogetherApi.broadcastActivity(this.session.code, activityRequest);
        } catch (error) {
            console.error('[WatchTogether] Broadcast activity error:', error);
        }
    }

    /**
     * Send an emoji reaction to all participants
     */
    async sendReaction(emoji: string): Promise<void> {
        if (!this.session) return;

        try {
            const reactionRequest: ReactionRequest = { emoji };
            await watchTogetherApi.sendReaction(this.session.code, reactionRequest);
        } catch (error) {
            console.error('[WatchTogether] Send reaction error:', error);
        }
    }

    /**
     * Send a screen effect to all participants (shake, confetti, etc.)
     */
    async sendScreenEffect(effect: string): Promise<void> {
        if (!this.session) return;

        try {
            const effectRequest: EffectRequest = { effect };
            await watchTogetherApi.sendScreenEffect(this.session.code, effectRequest);
        } catch (error) {
            console.error('[WatchTogether] Send screen effect error:', error);
        }
    }

    /**
     * Signal to server that this client's buffer is ready
     * @param currentTime - The current playback position (host uses this for accurate sync)
     */
    async signalReady(checkId: string, currentTime?: number): Promise<void> {
        if (this.deferredNavigationBarrier?.checkId === checkId) return;
        if (!this.session || checkId.startsWith('local-seek-')) return;

        try {
            const readyRequest: ReadyRequest = {
                clientId: this.getClientId(),
                checkId,
                currentTime: currentTime ?? 0,
            };
            await watchTogetherApi.signalReady(this.session.code, readyRequest);
        } catch (error) {
            console.error('[WatchTogether] Signal ready error:', error);
        }
    }

    /**
     * Report that this client is stalled (buffering for too long).
     * This will pause the entire group until the client reports ready.
     */
    async reportStall(
        stallId: string,
        expectedTimelineId = this.session?.timelineId,
    ): Promise<boolean> {
        if (
            !this.session ||
            this.navigationPlayerTimelineId !== null ||
            expectedTimelineId !== this.session.timelineId
        )
            return false;

        log(' Reporting stall to server');

        try {
            const stallRequest: StallRequest = {
                clientId: this.getClientId(),
                stallId,
                expectedTimelineId,
            };
            const { error } = await watchTogetherApi.reportStall(this.session.code, stallRequest);
            if (error) throw error;
            return true;
        } catch (error) {
            console.error('[WatchTogether] Report stall error:', error);
            return false;
        }
    }

    /**
     * Report that this client is ready after a stall (buffering recovered).
     * This will resume the group if everyone is ready.
     */
    async reportReady(stallId: string): Promise<boolean> {
        if (!this.session) return false;

        log(' Reporting ready after stall');

        try {
            const stallReadyRequest: StallReadyRequest = {
                clientId: this.getClientId(),
                stallId,
            };
            const { error } = await watchTogetherApi.reportStallReady(
                this.session.code,
                stallReadyRequest,
            );
            if (error) throw error;
            return true;
        } catch (error) {
            console.error('[WatchTogether] Report ready error:', error);
            return false;
        }
    }

    /**
     * Check if the group is currently stalled waiting for someone
     */
    getIsStalled(): boolean {
        return this.isStalled;
    }

    /**
     * Get the displayName of the user who is causing the stall
     */
    getStalledByUser(): string | null {
        return this.stalledByUser;
    }

    /**
     * Transfer host status to another participant (host only)
     */
    async transferHost(newHostUserId: string): Promise<boolean> {
        if (!this.session || !this.isHost) {
            console.warn('[WatchTogether] Cannot transfer host - not in session or not host');
            return false;
        }

        try {
            const transferRequest: TransferHostRequest = { newHostUserId };
            const { error: transferError, status } = await watchTogetherApi.transferHost(
                this.session.code,
                transferRequest,
            );

            if (transferError) {
                console.error('[WatchTogether] Transfer host failed:', status);
                return false;
            }

            return true;
        } catch (error) {
            console.error('[WatchTogether] Transfer host error:', error);
            return false;
        }
    }

    /**
     * Disband (end) the session - host only, works from any device
     */
    async disbandSession(): Promise<boolean> {
        if (!this.session || !this.isHost) {
            console.warn('[WatchTogether] Cannot disband - not in session or not host');
            return false;
        }

        try {
            const { error: disbandError, status } = await watchTogetherApi.disbandSession(
                this.session.code,
            );

            if (disbandError) {
                console.error('[WatchTogether] Disband session failed:', status);
                return false;
            }

            // Clear local storage
            clearStorage();

            return true;
        } catch (error) {
            console.error('[WatchTogether] Disband session error:', error);
            return false;
        }
    }

    /**
     * Set session visibility (host only)
     * Only listed sessions appear on the homepage
     */
    async setVisibility(visibility: 'unlisted' | 'listed'): Promise<boolean> {
        if (!this.session || !this.isHost) {
            console.warn('[WatchTogether] Cannot change visibility - not in session or not host');
            return false;
        }

        try {
            const visibilityRequest: SetVisibilityRequest = { visibility };
            const { error: visibilityError, status } = await watchTogetherApi.setVisibility(
                this.session.code,
                visibilityRequest,
            );

            if (visibilityError) {
                console.error('[WatchTogether] Set visibility failed:', status);
                return false;
            }

            // Update local state
            this.session = { ...this.session, visibility };

            return true;
        } catch (error) {
            console.error('[WatchTogether] Set visibility error:', error);
            return false;
        }
    }

    /**
     * Get the shareable join link for the current session
     */
    getJoinLink(): string | null {
        if (!this.session) return null;

        if (browser) {
            return `${window.location.origin}/party/${this.session.code}`;
        }
        return null;
    }

    /**
     * Check if current playback time needs resync
     */
    needsResync(localTime: number, remoteTime: number): boolean {
        return Math.abs(localTime - remoteTime) > MAX_DRIFT_SECONDS;
    }

    /**
     * Calculate the expected host position based on last known position and elapsed time.
     * Uses time elapsed since local receipt, so browser/server clock skew,
     * oscillator drift, NTP corrections, and manual wall-clock changes cannot
     * manufacture playback drift.
     * Returns null if no host position available or if host is paused.
     */
    getExpectedHostPosition(): number | null {
        if (!this.hostPosition || this.isHost) return null;

        const { position, receivedAt, isPlaying, playbackRate } = this.hostPosition;

        // If host is paused, position doesn't change
        if (!isPlaying) return position;

        // Monotonic time cannot jump if the system clock is corrected while a
        // movie is playing. Network transit remains a small fixed bias handled
        // by the synchronizer's dead zone / hard-seek threshold.
        const localNow = this.monotonicNow();
        const elapsedMs = Math.max(0, localNow - receivedAt);
        if (elapsedMs > WatchTogetherStoreImpl.HOST_POSITION_MAX_AGE_MS) {
            // Do not extrapolate indefinitely through a suspended tab or dead
            // SSE connection. The next heartbeat supplies a fresh anchor.
            return null;
        }
        const elapsedSec = elapsedMs / 1000;

        // Debug logging
        console.debug('[WatchTogether] getExpectedHostPosition', {
            hostReportedPosition: position.toFixed(2),
            receivedAt,
            localNow,
            elapsedMs,
            elapsedSec: elapsedSec.toFixed(2),
            playbackRate,
            expectedPosition: (position + elapsedSec * playbackRate).toFixed(2),
        });

        // Expected position = reported position + (elapsed time * playback rate)
        return position + elapsedSec * playbackRate;
    }

    /**
     * Whether the host's last reported state was "playing".
     *
     * Catch-up sync only makes sense against a moving host. When the host is
     * paused — including the end-of-video case where `ended` never sends a `sync`
     * (so the client `session.isPlaying` gate stays stale-true) — the guest must
     * not hard-seek toward the host's frozen position, which would skip a trailing
     * guest's remaining tail. Reflects the latest `host_position`/`sync` isPlaying.
     */
    isHostPlaying(): boolean {
        return this.hostPosition?.isPlaying === true;
    }

    /**
     * Update catch-up mode based on current drift
     */
    setCatchUpMode(mode: 'normal' | 'catching-up' | 'slowing-down'): void {
        this.catchUpMode = mode;
    }

    /**
     * Update current drift value (for UI display) and calculate trend
     */
    setCurrentDrift(drift: number): void {
        // Calculate drift trend based on change from previous value
        // Positive drift = behind host, negative = ahead
        // Improving = absolute drift decreasing (toward 0)
        // Worsening = absolute drift increasing (away from 0)
        const absDrift = Math.abs(drift);
        const absPrevDrift = Math.abs(this.previousDrift);
        const threshold = 0.1; // 100ms threshold to avoid jitter

        let driftTrend: 'improving' | 'worsening' | 'stable' = 'stable';
        if (absDrift < absPrevDrift - threshold) {
            driftTrend = 'improving';
        } else if (absDrift > absPrevDrift + threshold) {
            driftTrend = 'worsening';
        }

        this.currentDrift = drift;
        this.previousDrift = drift;
        this.driftTrend = driftTrend;
    }

    /**
     * Update effective playback rate (for sync indicator display)
     */
    setEffectivePlaybackRate(rate: number): void {
        this.effectivePlaybackRate = rate;
    }

    /**
     * Check if catch-up sync is currently paused (during seek/buffer_check flows)
     */
    isCatchUpPaused(): boolean {
        return this.catchUpPaused;
    }

    /**
     * Pause catch-up sync (called before explicit seek)
     */
    pauseCatchUp(): void {
        this.catchUpPaused = true;
    }

    /**
     * Check if we've received initial sync from the session.
     * Fresh joiners should not broadcast until they've synced.
     */
    /** Explicit teardown retires local media work even when the same party is rejoined. */
    getMembershipRevision(): number {
        return this.membershipRevision;
    }

    getHasSyncedInitially(): boolean {
        return this.hasSyncedInitially;
    }

    /**
     * Mark that we're navigating within the session.
     * This prevents storage from being cleared during disconnect.
     */
    setNavigatingWithinSession(): void {
        setNavigatingWithinSessionFlag(true);
    }

    /**
     * Check if currently navigating within the session.
     */
    isNavigatingWithinSession(): boolean {
        return isNavigatingWithinSession();
    }

    /**
     * Get current session state (for reading session position without broadcasting)
     */
    get isPlayerAttachmentPending(): boolean {
        return this.navigationPlayerTimelineId !== null;
    }

    getSessionState(): {
        currentTime: number;
        isPlaying: boolean;
    } | null {
        if (!this.session) return null;
        return {
            currentTime: this.session.currentTime,
            isPlaying: this.session.isPlaying,
        };
    }
}

export const watchTogether = new WatchTogetherStoreImpl();

/** Type for the watch together store (for use in other modules) */
export type WatchTogetherStore = typeof watchTogether;
