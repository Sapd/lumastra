// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WatchTogetherController — owns watch-together mount setup, rejoin logic,
 * version change handler, and stall tracking.
 *
 * Extracted from PlayerController to isolate watch-party concerns.
 */

import { goto } from '$app/navigation';
import { resolve } from '$lib/paths';
import { watchTogether } from '$lib/stores/watchTogether.svelte';
import { playerStore } from './playerStore.svelte';
import {
    createWatchTogetherHandlers,
    createVideoControllerFromElement,
    type WatchTogetherHandlers,
} from './watch-together-handlers';
import { TIMING } from './timing-constants';

/** Playhead progress during the stall window that proves `waiting` was spurious. */
const STALL_PROGRESS_S = 0.25;
/** Playhead progress past a reported stall that proves playback resumed. */
const STALL_RECOVERED_PROGRESS_S = 0.5;

type WatchTogetherToastHandle = {
    showToast: (type: string, userId: string, displayName?: string) => void;
};

function isWatchTogetherToastHandle(value: unknown): value is WatchTogetherToastHandle {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as Record<string, unknown>).showToast === 'function'
    );
}

type SeekSource =
    | 'restore_position'
    | 'resume_initial'
    | 'seek_relative'
    | 'seek_absolute'
    | 'seekTo'
    | 'double_tap'
    | 'chapter_skip'
    | 'intro_skip'
    | 'watch_party_sync'
    | 'watch_party_seek'
    | 'hls_seek'
    | 'direct_stream_seek'
    | 'seek_to_live'
    | 'frame_step';

export interface WatchTogetherControllerDeps {
    getVideoElement: () => HTMLVideoElement | undefined;
    getWatchTogetherToast: () => unknown;
    getItemId: () => string;
    onPlaybackRateChange?: (rate: number) => void;
    getPlaybackInfo: () => {
        itemId: string;
        title: string;
        isLive?: boolean;
        mediaType: string;
        mediaSources?: { id: string; name?: string }[];
    };
    getPlaybackProbe: () => { versions?: { fileId: string }[] } | null;
    /**
     * PlayerController.seekTo. The middle argument is broadcastToWatchParty,
     * NOT an OSD flag — every seek from this controller is applying a position
     * the party already agreed on, so it must stay false. Broadcasting here
     * would echo the host's own target back at the session.
     */
    seekTo: (time: number, broadcastToWatchParty: boolean, source: SeekSource) => void;
    setVideoTime: (time: number, source: string) => void;
    switchLumastraFile: (fileId: string) => void;
    onVersionChange?: (fileId: string) => void;
    handlePlayError: (e: Error) => void;
    /**
     * Called when a party-driven play() (buffer-check resume, stall
     * recovery, sync) was blocked by the browser's autoplay policy and
     * recovered by retrying muted. Show the same "tap to unmute" prompt used
     * for the initial-load autoplay fallback.
     */
    onMutedFallback: () => void;
    log: (...args: unknown[]) => void;
}

export class WatchTogetherController {
    handlers: WatchTogetherHandlers | null = null;
    hasReportedStall: boolean = false;
    private stallRecoveryInFlight = false;
    private stallReportInFlight: Promise<boolean> | null = null;
    private stallGeneration = 0;
    private currentStallId: string | null = null;
    private disposed = false;
    stallTimer: ReturnType<typeof setTimeout> | null = null;
    /** Playhead when the stall was reported; progress past it clears the stall. */
    private stalledAt: number | null = null;

    private sourceReplacement: {
        binding: string;
        code: string;
        membershipRevision: number;
        itemId: string;
        fileId: string | undefined;
        video: HTMLVideoElement;
        stallId: string;
        report: Promise<boolean>;
        readyRequested: boolean;
        completing: boolean;
    } | null = null;

    private playbackBinding(): string | null {
        const party = watchTogether.session;
        if (!party || party.itemId !== this.deps.getItemId()) return null;
        return JSON.stringify([party.code, party.itemId, party.timelineId, party.fileId]);
    }

    get isSourceReplacing(): boolean {
        return (
            this.sourceReplacement !== null &&
            this.sourceReplacement.membershipRevision === watchTogether.getMembershipRevision() &&
            this.sourceReplacement.code === watchTogether.session?.code &&
            this.sourceReplacement.video === this.deps.getVideoElement() &&
            this.sourceReplacement.itemId === this.deps.getItemId()
        );
    }

    /** A local quality/audio rebuild participates in the party's stall protocol. */
    beginSourceReplacement(): void {
        const binding = this.playbackBinding();
        const video = this.deps.getVideoElement();
        if (this.disposed || !binding || !video) return;
        const stallId = crypto.randomUUID();
        this.sourceReplacement = {
            binding,
            code: watchTogether.session!.code,
            membershipRevision: watchTogether.getMembershipRevision(),
            itemId: this.deps.getItemId(),
            fileId: watchTogether.session?.fileId,
            video,
            stallId,
            readyRequested: false,
            completing: false,
            report: this.withRequestTimeout(
                watchTogether.reportStall(stallId, watchTogether.session?.timelineId),
            ),
        };
        this.handlers?.prepareSourceReplacement();
    }

    private retargetSourceReplacement(): void {
        const previous = this.sourceReplacement;
        const binding = this.playbackBinding();
        if (!previous || !binding || previous.binding === binding || !this.isSourceReplacing)
            return;
        const file = watchTogether.session?.fileId;
        if (previous.fileId !== file) {
            const party = watchTogether.session!;
            const url = file ? `/watch/${party.itemId}?fileId=${file}` : `/watch/${party.itemId}`;
            window.location.assign(resolve(url));
            return;
        }
        // Same physical item, new canonical timeline: callbacks from the old
        // readiness generation may no longer release this retained player.
        this.beginSourceReplacement();
        if (this.sourceReplacement) this.sourceReplacement.readyRequested = previous.readyRequested;
        void this.completeSourceReplacement();
    }

    /** Position restoration has finished; readiness still requires actual media data. */
    finishSourceReplacement(): void {
        if (this.sourceReplacement) this.sourceReplacement.readyRequested = true;
        void this.completeSourceReplacement();
    }

    private async completeSourceReplacement(): Promise<void> {
        const replacement = this.sourceReplacement;
        const owns = () =>
            !this.disposed &&
            this.sourceReplacement === replacement &&
            this.isSourceReplacing &&
            replacement?.binding === this.playbackBinding() &&
            this.deps.getVideoElement() === replacement?.video;
        if (!replacement || !replacement.readyRequested || replacement.completing || !owns())
            return;
        const ready = () => replacement.video.readyState >= 3 && !replacement.video.seeking;
        if (!ready()) return;
        replacement.completing = true;
        try {
            // Even an ambiguous/failed report may have committed. Clear exactly
            // its stall generation, after the new source can really play.
            await replacement.report;
            let attempt = 0;
            while (owns() && ready()) {
                if (await this.withRequestTimeout(watchTogether.reportReady(replacement.stallId))) {
                    if (!owns()) return;
                    if (!ready()) {
                        // The SDK can lose readiness while the server ACK travels.
                        // Re-enter with a fresh stall generation; never release a
                        // new/loading source on the previous readiness decision.
                        this.beginSourceReplacement();
                        if (this.sourceReplacement) this.sourceReplacement.readyRequested = true;
                        return;
                    }
                    this.sourceReplacement = null;
                    this.handlers?.reapplyCurrentPartyState(watchTogether);
                    return;
                }
                await new Promise((resolve) =>
                    setTimeout(resolve, Math.min(500 * 2 ** attempt++, 5000)),
                );
            }
        } finally {
            if (owns()) replacement.completing = false;
        }
    }

    private readonly deps: WatchTogetherControllerDeps;

    constructor(deps: WatchTogetherControllerDeps) {
        this.deps = deps;
    }

    private withRequestTimeout(request: Promise<boolean>): Promise<boolean> {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(false), 5000);
            void request.then(
                (result) => {
                    clearTimeout(timeout);
                    resolve(result);
                },
                () => {
                    clearTimeout(timeout);
                    resolve(false);
                },
            );
        });
    }

    isPlaybackHeld(): boolean {
        return this.handlers?.isPlaybackHeld() ?? false;
    }

    /**
     * Called during mount() — sets up handlers, registers event callbacks,
     * handles version change events, sets up intervals, and attempts rejoin.
     * Returns a cleanup function for the intervals.
     */
    async setupInMount(userId: string, isLive?: boolean): Promise<(() => void) | undefined> {
        this.handlers = createWatchTogetherHandlers({
            getItemId: () => this.deps.getItemId(),
            isSourceReplacing: () => this.isSourceReplacing,
            onPlaybackBindingChanged: () => this.retargetSourceReplacement(),
            isHost: () => watchTogether.isHost,
            showToast: (type, userId, uname) => {
                const toast = this.deps.getWatchTogetherToast();
                if (isWatchTogetherToastHandle(toast)) {
                    toast.showToast(type, userId, uname ?? 'Unknown');
                }
            },
            onPlaybackRateChange: (rate) => {
                this.deps.onPlaybackRateChange?.(rate);
                playerStore.setPlaybackRate(rate);
            },
            onPlayError: (e: Error) => this.deps.handlePlayError(e),
            isPausedByUser: () => playerStore.pausedByUser,
            isLive: () => playerStore.isLive,
            log: this.deps.log,
        });

        const videoController = createVideoControllerFromElement(
            () => this.deps.getVideoElement() ?? null,
            (time, source) => {
                this.deps.seekTo(time, false, source as SeekSource);
            },
            (e: Error) => this.deps.handlePlayError(e),
            () => this.deps.onMutedFallback(),
        );
        this.handlers.setController(videoController);

        this.handlers.registerHandlers(watchTogether);

        watchTogether.onVersionChange((fileId, userId, uname) => {
            if (
                this.isSourceReplacing &&
                this.sourceReplacement?.binding !== this.playbackBinding()
            ) {
                // A quality/audio reload owns the restart lock. Recreate the
                // canonical file instead of dropping this version switch at
                // that lock and leaving the old source's readiness hold alive.
                window.location.assign(resolve(`/watch/${this.deps.getItemId()}?fileId=${fileId}`));
                return;
            }
            const state = playerStore.getState();
            const currentMediaSourceId = state.currentMediaSource?.id;

            this.deps.log(' Version change event received:', {
                newFileId: fileId,
                currentMediaSourceId,
                fromUser: uname,
            });

            if (currentMediaSourceId === fileId) {
                this.deps.log(' Already on this media source, ignoring');
                return;
            }

            const toast = this.deps.getWatchTogetherToast();
            if (isWatchTogetherToastHandle(toast)) {
                toast.showToast('version', userId, uname);
            }

            const playbackProbe = this.deps.getPlaybackProbe();
            if (
                playbackProbe?.versions &&
                playbackProbe.versions.some((v) => v.fileId === fileId)
            ) {
                this.deps.log(' Switching lumastra version from watch party:', fileId);
                this.deps.switchLumastraFile(fileId);
                return;
            }

            this.deps.log(' Redirecting to switch media source:', fileId);
            watchTogether.setNavigatingWithinSession();
            // eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() from $lib/paths wraps $app/paths resolve
            goto(resolve(`/watch/${this.deps.getItemId()}?fileId=${fileId}`));
        });

        const handlers = this.handlers;
        const rejoined = !isLive && (await watchTogether.tryRejoinFromStorage(userId));
        if (this.disposed || this.handlers !== handlers) return;
        if (rejoined) {
            await this.handleRejoin();
        }
        if (this.disposed || this.handlers !== handlers) return;
        if ((this.deps.getVideoElement()?.readyState ?? 0) >= 3) this.onCanPlay();

        // Restoration must align a host's saved player position before any
        // heartbeat can overwrite the party's canonical startup position.
        const cleanupIntervals = this.handlers.setupIntervals(
            watchTogether,
            () => watchTogether.isInWatchParty,
            () => watchTogether.isWatchPartySyncing,
            () => watchTogether.isHost,
        );

        return cleanupIntervals;
    }

    async reconcileRestoredItem(): Promise<boolean> {
        const session = watchTogether.session;
        const playbackInfo = this.deps.getPlaybackInfo();

        if (session && session.itemId !== playbackInfo.itemId) {
            this.deps.log(' Video mismatch detected after rejoin', {
                sessionItemId: session.itemId,
                currentItemId: playbackInfo.itemId,
                isHost: watchTogether.isHost,
            });

            if (watchTogether.isHost) {
                this.deps.log(' Host broadcasting navigation to new video');
                const title = playbackInfo.title || 'Unknown';
                const currentState = playerStore.getState();
                if (
                    !(await watchTogether.broadcastNavigate(
                        playbackInfo.itemId,
                        title,
                        playbackInfo.mediaType.toLowerCase() as 'movie' | 'episode' | 'tv',
                        currentState.currentMediaSource?.id,
                    ))
                )
                    return false;
                if (this.disposed) return false;
            } else {
                this.deps.log(' Guest redirecting to session video');
                watchTogether.setNavigatingWithinSession();
                const url = session.fileId
                    ? `/watch/${session.itemId}?fileId=${session.fileId}`
                    : `/watch/${session.itemId}`;
                // eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() from $lib/paths wraps $app/paths resolve
                goto(resolve(url));
                return false;
            }
        }
        return !this.disposed;
    }

    private async handleRejoin(): Promise<void> {
        if (!(await this.reconcileRestoredItem())) return;
        const sessionState = watchTogether.getSessionState();
        const session = watchTogether.session;
        const playbackInfo = this.deps.getPlaybackInfo();
        if (
            session?.itemId === playbackInfo.itemId &&
            sessionState &&
            this.deps.getVideoElement()
        ) {
            if (Math.abs(this.deps.getVideoElement()!.currentTime - sessionState.currentTime) > 1) {
                this.deps.log(
                    ' Rejoined same video - seeking to session position:',
                    sessionState.currentTime,
                );
                this.deps.setVideoTime(sessionState.currentTime, 'watch_party_sync');
            }
            if (!sessionState.isPlaying || watchTogether.isWatchPartySyncing) {
                this.deps.getVideoElement()!.pause();
            }
        }

        if (session && session.fileId) {
            const currentState = playerStore.getState();
            const currentMediaSourceId = currentState.currentMediaSource?.id;

            if (currentMediaSourceId !== session.fileId) {
                this.deps.log(' Media source mismatch detected after rejoin', {
                    sessionFileId: session.fileId,
                    currentMediaSourceId,
                    isHost: watchTogether.isHost,
                });

                if (watchTogether.isHost) {
                    this.deps.log(' Host broadcasting version change');
                    if (currentMediaSourceId) {
                        await watchTogether.broadcastVersionChange(currentMediaSourceId);
                    }
                } else {
                    const playbackProbe = this.deps.getPlaybackProbe();
                    if (
                        playbackProbe?.versions &&
                        playbackProbe.versions.some((v) => v.fileId === session.fileId)
                    ) {
                        this.deps.log(' Guest switching lumastra version:', session.fileId);
                        this.deps.switchLumastraFile(session.fileId);
                    } else {
                        const matchingSource = this.deps
                            .getPlaybackInfo()
                            .mediaSources?.find((s) => s.id === session.fileId);
                        if (matchingSource) {
                            this.deps.log(
                                ' Guest switching to session media source:',
                                matchingSource.name || session.fileId,
                            );
                            playerStore.setMediaSource(matchingSource.id);
                            this.deps.onVersionChange?.(session.fileId);
                        } else {
                            console.warn(
                                '[WatchTogether] Could not find session media source:',
                                session.fileId,
                            );
                        }
                    }
                }
            }
        }
    }

    onWaiting(): void {
        // A `waiting` event while the video is PAUSED is not a buffering stall —
        // it is the side effect of a sync-driven seek that lands just before the
        // guest pauses (host pause with >150ms drift seeks then pauses). Arming
        // the stall timer here would fire reportStall() on a paused guest, which
        // pauses the whole party and shows a buffering spinner that never clears
        // (recovery only runs on `playing`, which can't fire while paused).
        if (this.deps.getVideoElement()?.paused) return;

        // A new waiting event after playback briefly recovered starts a new
        // generation. The server-side stallId prevents an older ready request
        // already on the wire from clearing this newer cycle.
        if (this.stallRecoveryInFlight) {
            this.stallGeneration++;
            this.hasReportedStall = false;
            this.stallRecoveryInFlight = false;
        }
        if (watchTogether.isInWatchParty && !this.stallTimer && !this.hasReportedStall) {
            const waitingAt = this.deps.getVideoElement()?.currentTime ?? null;
            const timelineId = watchTogether.session?.timelineId;
            this.stallTimer = setTimeout(() => {
                // Some engines (WebKit/GStreamer) fire `waiting` and carry on
                // playing without a matching `playing` event. A playhead that
                // moved on is not a stall — reporting it would pause the party.
                if (waitingAt !== null && this.isAdvancingPast(waitingAt, STALL_PROGRESS_S)) {
                    this.stallTimer = null;
                    return;
                }
                const generation = ++this.stallGeneration;
                const stallId = crypto.randomUUID();
                this.currentStallId = stallId;
                this.deps.log(' Buffering for 2+ seconds, reporting stall to watch party');
                this.hasReportedStall = true;
                this.stalledAt = this.deps.getVideoElement()?.currentTime ?? null;
                const report = this.withRequestTimeout(
                    watchTogether.reportStall(stallId, timelineId),
                );
                this.stallReportInFlight = report;
                void report.then(() => {
                    if (this.stallReportInFlight !== report || generation !== this.stallGeneration)
                        return;
                    this.stallReportInFlight = null;
                });
                this.stallTimer = null;
            }, TIMING.WATCH_PARTY_STALL_TIMEOUT_MS);
        }
    }

    /**
     * `timeupdate`: the stall recovery path for engines that never fire
     * `playing` after `waiting` — once the playhead is seen moving again the
     * stall is over, whatever events the engine sent.
     */
    onTimeUpdate(): void {
        if (!this.hasReportedStall || this.stalledAt === null || !watchTogether.isInWatchParty)
            return;
        if (!this.isAdvancingPast(this.stalledAt, STALL_RECOVERED_PROGRESS_S)) return;
        this.deps.log(' Playhead moving again after a stall, reporting ready to watch party');
        this.stalledAt = null;
        void this.recoverReportedStall();
    }

    private isAdvancingPast(position: number, by: number): boolean {
        const video = this.deps.getVideoElement();
        if (!video || video.paused || video.seeking) return false;
        return video.currentTime > position + by;
    }

    onSeeked(): void {
        void this.completeSourceReplacement();
    }

    onCanPlay(): void {
        void this.completeSourceReplacement();
        if (!this.disposed)
            watchTogether.attachLoadedNavigationPlayer(this.deps.getPlaybackInfo().itemId);
    }

    onPlaying(): void {
        this.clearStallTimer();
        if (this.hasReportedStall && watchTogether.isInWatchParty) {
            this.deps.log(' Buffering recovered, reporting ready to watch party');
            void this.recoverReportedStall();
        }
    }

    /**
     * Pausing cancels any in-flight stall detection: a paused guest is not
     * buffering, so a pending stall timer must not fire, and if a stall was
     * already reported (e.g. armed just before the pause) we report ready so the
     * party isn't left waiting on a guest that has intentionally stopped.
     */
    onPause(): void {
        this.clearStallTimer();
        if (this.hasReportedStall && watchTogether.isInWatchParty) {
            void this.recoverReportedStall();
        }
    }

    private async recoverReportedStall(): Promise<void> {
        if (this.stallRecoveryInFlight) return;
        this.stallRecoveryInFlight = true;
        const generation = this.stallGeneration;
        const stallId = this.currentStallId;
        if (!stallId) {
            this.stallRecoveryInFlight = false;
            return;
        }
        try {
            // A failed/timed-out response is ambiguous: the server may have
            // recorded the stall before the response was lost. Sending ready
            // with the same generation is idempotent and safely resolves it.
            if (this.stallReportInFlight) await this.stallReportInFlight;
            let attempt = 0;
            while (!this.disposed && generation === this.stallGeneration) {
                const delay = attempt === 0 ? 0 : Math.min(500 * 2 ** (attempt - 1), 5000);
                if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
                if (
                    this.disposed ||
                    generation !== this.stallGeneration ||
                    !this.hasReportedStall ||
                    !watchTogether.isInWatchParty
                )
                    return;
                if (await this.withRequestTimeout(watchTogether.reportReady(stallId))) {
                    if (generation !== this.stallGeneration) return;
                    this.hasReportedStall = false;
                    this.currentStallId = null;
                    return;
                }
                attempt = Math.min(attempt + 1, 5);
            }
        } finally {
            if (generation === this.stallGeneration) this.stallRecoveryInFlight = false;
        }
    }

    clearStallTimer(): void {
        if (this.stallTimer) {
            clearTimeout(this.stallTimer);
            this.stallTimer = null;
        }
    }

    /** See WatchTogetherHandlers.catchUpIfSuspended. */
    catchUpIfSuspended(): boolean {
        return this.handlers?.catchUpIfSuspended() ?? false;
    }

    /** See WatchTogetherHandlers.takeSuspendedPosition. */
    takeSuspendedPosition(): number | null {
        return this.handlers?.takeSuspendedPosition() ?? null;
    }

    setMediaDuration(duration: number): void {
        this.handlers?.setMediaDuration(duration);
    }

    dispose(): void {
        this.disposed = true;
        this.sourceReplacement = null;
        this.stallGeneration++;
        this.clearStallTimer();
        this.handlers?.dispose();
        this.handlers = null;
    }
}
