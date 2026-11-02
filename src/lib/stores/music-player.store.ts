// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { MediaPlaybackError } from '$lib/audio/audio-element-helpers';
import type { PlaybackStartResponse } from '$lib/schemas/playback-start.js';
import { maintainPlaybackGrant } from '$lib/utils/playback-grant.js';

/**
 * Music Player Store
 *
 * Manages the entire music playback experience. Audio operations are delegated
 * to a platform-specific AudioBackend (WebAudioBackend for desktop/Android,
 * PlainAudioBackend for iOS) selected at init time.
 *
 * Lifecycle:
 * - Mounted once in the root layout (persists across page navigation)
 * - `init()` called from `+layout.svelte`'s root `onMount`, gated to fire once
 *   the first time the app-shell branch (not /login, /setup, /showcase) is
 *   active (see `RunOnceWhenTrue` in `$lib/components/players`) — creates the
 *   backend. Not called from MiniPlayer.svelte itself: that component is now
 *   lazy-loaded, gated on the visibility this very init/hydrate call sets, so
 *   it cannot be the one to trigger it (Task 8 fix round 1, Critical 1).
 * - Backend handles all audio element, Web Audio, crossfade, MediaSession, wake lock
 */

import { page } from '$app/stores';
import { musicGenreIcon } from '$lib/utils/music-genre-icon';
import { writable, derived, get } from 'svelte/store';
import type { MusicTrack, QueueItem } from '$lib/schemas/music';
import { RadioNowPlayingResponseSchema } from '$lib/schemas/api-music-responses';
import type { RadioNowPlaying } from '$lib/schemas/radio';
import { apiGet } from '$lib/api/client';
import {
    startMusicPlaySession,
    cancelMusicPlayback,
    reportMusicPlayback,
    reportMusicPlaybackBeacon,
    replayMusicPlays,
    type MusicPlaybackReport,
    type MusicReplayItem,
} from '$lib/api/music';
import {
    boundedMusicReplays,
    musicReplayStorageKey,
    LEGACY_REPLAY_STORAGE_KEY,
} from './music-replay-persistence';
import { findChapterAtMs, getNextChapter } from '$lib/utils/music-chapters';
import type { AutoplaySeed, PlaybackContext } from '$lib/schemas/autoplay-seed';
import {
    calculateCrossfadeDuration,
    getDjCrossfadeBeats,
    findNextDownbeat,
    bpmGap,
    determineCrossfadeStyle,
    getEffectiveIntroEndMs,
    clampBassSwapBeats,
    computeBarPhase,
    scaleCrossfadeBeatsForTrackLength,
} from '$lib/utils/beat-math';
import {
    computeCrossfadePlan,
    guardLastVocalEndMs,
    CROSSFADE_END_HEADROOM_MS,
} from '$lib/utils/crossfade-plan';
import { applyLufsGain } from '$lib/utils/lufs-gain';
import {
    savePlaybackState,
    loadPlaybackState,
    clearPlaybackState,
    onPlaybackSessionEndedElsewhere,
} from './music-playback-persistence';
import { createAudioBackend } from '$lib/audio';
import { claimAudio, registerAudioParticipant, releaseAudio } from './audio-exclusivity';
import { createMusicTabSync, type MusicTabCommand, type MusicTabSync } from './music-tab-sync';
import type { AudioBackend, CrossfadeDebugInfo, TimeUpdateInfo, TrackMetadata } from '$lib/audio';
import { createAirPlayDetector, type AirPlayDetector } from '$lib/audio/airplay-detector';
import { streamTokenOf, StreamTokenRecoveryGate } from '$lib/utils/stream-token-recovery';
import { getDeviceId } from '$lib/components/player/device-id';
// Paraglide messages — imported as `messages` (not the conventional `m`) to
// avoid colliding with the local `m` alias used for the dynamic `$lib/api/music`
// import throughout this store.
import * as messages from '$lib/paraglide/messages';
import { toasts } from '$lib/stores/toast.store';

// Preserve the server-resolved artwork, including absent cover art.
function withTrackImages(track: MusicTrack): MusicTrack {
    return {
        ...track,
        images: track.images ?? {},
    };
}

function trackArtworkUrl(track: MusicTrack): string {
    return track.images?.primary?.variants?.thumb ?? track.images?.primary?.href ?? '';
}

// ============================================================================
// Types
// ============================================================================

export type { MusicTrack };
export type { CrossfadeDebugInfo };
export type { QueueItem };

export interface MusicPlayerState {
    currentTrack: MusicTrack | null;
    /**
     * How `currentTrack` started: 'user' = the user explicitly picked it
     * (direct play, or a track they queued themselves being promoted),
     * 'smart' = the system picked it (autoplay/smart-queue promotion, radio
     * seed). Sent to the smart queue as `intent` — a manual pick makes the
     * current track dominate the retrieval centroid instead of splitting the
     * vote with session history. Meaningless while `currentTrack` is null.
     */
    currentTrackSource: 'user' | 'smart';
    queue: QueueItem[];
    history: MusicTrack[];
    isPlaying: boolean;
    progress: number;
    currentTimeMs: number;
    durationMs: number;
    volume: number;
    isExpanded: boolean;
    isMuted: boolean;
    autoplayEnabled: boolean;
    activePanel: 'queue' | 'lyrics' | 'settings' | 'add';
    isCrossfading: boolean;
    /** 0-1 progress through the active crossfade */
    crossfadeProgress: number;
    /**
     * The OUTGOING track during a fade: the store promotes the incoming track
     * at fade start, but the old song stays audible for the whole fade. Its
     * id and its own deck clock, for views that follow what is heard (lyrics).
     */
    crossfadeOutgoing: { trackId: string; timeMs: number } | null;
    /** Current beat number (1-based) during crossfade */
    crossfadeCurrentBeat: number;
    /** Total beats in the active crossfade */
    crossfadeTotalBeats: number;
    /** Optional seed that biases smart queue results; null in normal playback mode */
    autoplaySeed: AutoplaySeed | null;
    /** Display-only context for the queue panel; auto-clears when queued tracks run out */
    playbackContext: PlaybackContext | null;
    /** Whether crossfade is enabled */
    crossfadeEnabled: boolean;
    /** Whether per-track LUFS normalization is applied during music playback. */
    loudnessNormalizationEnabled: boolean;
    /** Whether music detail modals show integrated loudness in dB. */
    showLoudnessDb: boolean;
    /** Whether music detail modals and queue rows show BPM. */
    showBpm: boolean;
    /** Pulse the current-position circle throughout playback. */
    alwaysShowBeatPulse: boolean;
    /** True when an active <audio> element is routing to AirPlay. Not persisted. */
    isAirPlayActive: boolean;
    /**
     * True while another browser tab is playing music (music-tab-sync.ts).
     * Lets this tab explain why it is paused. Not persisted.
     */
    playingElsewhere: boolean;
    /** True when at least one AirPlay receiver is reachable on the network. */
    isAirPlayAvailable: boolean;
    /** User-configured crossfade beat count (null = auto/smart) */
    crossfadeBeatsOverride: number | null;
    /** Track IDs skipped during this session (for skip penalty in queue) */
    skippedTrackIds: string[];
    /**
     * Downbeat-snapped time (ms) at which the next crossfade should trigger.
     * Set when entering the crossfade lead window; cleared after crossfade fires.
     */
    pendingCrossfadeAtMs: number | null;
    /** ID of the queue head track that pendingCrossfadeAtMs was computed for.
     *  If queue[0] changes, checkCrossfadeTrigger auto-resets pendingCrossfadeAtMs. */
    pendingCrossfadeForTrackId: string | null;
    /**
     * True when the armed pendingCrossfadeAtMs came from a manual hold-to-mix
     * gesture (mixNow) rather than the automatic lead-window logic. A manual
     * pending fires even when crossfadeEnabled is false — it is an explicit
     * user action. Invariant: meaningful only while pendingCrossfadeAtMs is
     * non-null; every site that clears or auto-arms the pending resets it.
     */
    pendingCrossfadeIsManual: boolean;
    /** Feedback given on the current track (null = none yet) */
    currentTrackFeedback: 'liked' | 'disliked' | null;
    /** Whether the user has seeked during the current track */
    hasSeeked: boolean;
    /** ISO 8601 timestamp of when current track started playing */
    playStartedAt: string | null;
    /** Playback session id; offline plays use a stable generated replay id. */
    playEventId: string | null;
    /** Play context for analytics — derived from autoplaySeed/playbackContext */
    playContext: string | null;
    /**
     * Lyrics availability for the current track.
     * `idle` = not yet fetched (default after each track switch). Lyrics are
     * loaded lazily only when the user opens the Lyrics tab — `LyricsPanel`
     * tracks the in-flight loading state locally and reports the result back
     * here once known. The store never sets this to a "loading" state.
     */
    lyricsStatus: 'idle' | 'available' | 'unavailable';
    /** True when the smart queue used fallback (no embeddings) */
    smartQueueFallback: boolean;
    /** True while the smart queue is fetching the next track */
    smartQueueLoading: boolean;
    /** Live effective BPM considering playbackRate adjustments (null if no BPM data) */
    effectiveBpm: number | null;
    /** Target BPM the effective BPM is normalizing toward (null if not normalizing) */
    normalizingTargetBpm: number | null;
    /** Debug mode: show crossfade alignment details in the player */
    crossfadeDebug: boolean;
    /** Debug info about the last/current crossfade alignment */
    crossfadeDebugInfo: CrossfadeDebugInfo | null;
    isFullScreen: boolean;
    /** 0-1 progress of swipe-up gesture revealing the full-screen player */
    fullScreenSwipeProgress: number;
    /** True while the swipe-to-open gesture is animating from the release position to fully open. Used to enable a CSS transition on the transform during that settling phase. */
    fullScreenSwipeCompleting: boolean;
    /** Briefly true after a swipe-committed open to suppress the .fullscreen-player slide-up keyframe (which would otherwise snap the sheet back down to translateY(100%) and bounce up). */
    fullScreenSuppressEntry: boolean;
    /** Whether the backend supports programmatic volume control */
    supportsVolumeControl: boolean;
    /**
     * Whether the active audio backend can crossfade. False on iOS
     * (PlainAudioBackend, no Web Audio) — folded into `crossfadeEffective` so
     * predictive UI (zone markers, "Up Next" preview, countdowns) never
     * advertises a blend the backend cannot perform, even after
     * loadMusicSettings() restores the saved crossfade preference.
     */
    supportsCrossfade: boolean;
    /** True while play() is awaiting the backend to load + start a new track.
     *  Drives the top loading bar so users get feedback for the brief gap
     *  between tap and audio start. */
    isLoadingTrack: boolean;
    /** Selected audio output device (sinkId), null = system default.
     *  Only meaningful when the backend supports output selection. */
    audioOutputDeviceId: string | null;
}

const OUTPUT_DEVICE_STORAGE_KEY = 'lumastra:audio-output-device';

/** Cap on retained session history. Also bounds the smart queue's exclude list. */
const HISTORY_LIMIT = 50;

function readOutputDevice(): string | null {
    try {
        if (typeof localStorage === 'undefined') return null;
        return localStorage.getItem(OUTPUT_DEVICE_STORAGE_KEY);
    } catch {
        /* expected: localStorage may be unavailable (private browsing) */
        return null;
    }
}

function readCrossfadeDebug(): boolean {
    try {
        return (
            typeof localStorage !== 'undefined' &&
            localStorage.getItem('lumastra:crossfade-debug') === 'true'
        );
    } catch {
        /* expected: localStorage may be unavailable (private browsing) */
        return false;
    }
}

/**
 * State stop() carries over its reset to INITIAL_STATE. Everything here is set
 * once per page (init, loadMusicSettings, the AirPlay detector) or lives on the
 * still-existing backend, so nothing would restore it after stop(). Logout
 * ends in a full page load, which drops all of it with the page. So does every
 * sign-in (login form, OIDC/forward-auth redirects, the player's session-drop
 * re-auth): no path changes the user while this module lives (checked
 * 2026-10-15; the import.meta.env.DEV-only DevModeSwitcher is the exception).
 */
const STATE_KEPT_ACROSS_STOP = [
    // The deck keeps its volume and mute (element.muted on iOS) across stop().
    'volume',
    'isMuted',
    'playingElsewhere',
    // The AirPlay flags mirror the detector, which only reports CHANGES:
    // resetting them would leave a still-routed element reading as local, and
    // the next track would go out on the cookie-authed URL.
    'isAirPlayActive',
    'isAirPlayAvailable',
    // Saved preferences, loaded only at init.
    'crossfadeEnabled',
    'crossfadeBeatsOverride',
    'autoplayEnabled',
    'showLoudnessDb',
    'showBpm',
    'alwaysShowBeatPulse',
    'loudnessNormalizationEnabled',
    'crossfadeDebug',
] as const satisfies readonly (keyof MusicPlayerState)[];

const INITIAL_STATE: MusicPlayerState = {
    audioOutputDeviceId: readOutputDevice(),
    currentTrack: null,
    currentTrackSource: 'smart',
    queue: [],
    history: [],
    isPlaying: false,
    progress: 0,
    currentTimeMs: 0,
    durationMs: 0,
    volume: 0.8,
    isExpanded: false,
    isMuted: false,
    autoplayEnabled: true,
    activePanel: 'queue',
    isCrossfading: false,
    crossfadeProgress: 0,
    crossfadeOutgoing: null,
    crossfadeCurrentBeat: 0,
    crossfadeTotalBeats: 0,
    autoplaySeed: null,
    playbackContext: null,
    crossfadeEnabled: true,
    loudnessNormalizationEnabled: true,
    showLoudnessDb: false,
    showBpm: true,
    alwaysShowBeatPulse: false,
    isAirPlayActive: false,
    playingElsewhere: false,
    isAirPlayAvailable: false,
    crossfadeBeatsOverride: null,
    skippedTrackIds: [],
    currentTrackFeedback: null,
    hasSeeked: false,
    playStartedAt: null,
    playEventId: null,
    playContext: null,
    lyricsStatus: 'idle',
    pendingCrossfadeAtMs: null,
    pendingCrossfadeForTrackId: null,
    pendingCrossfadeIsManual: false,
    smartQueueFallback: false,
    smartQueueLoading: false,
    effectiveBpm: null,
    normalizingTargetBpm: null,
    crossfadeDebug: readCrossfadeDebug(),
    crossfadeDebugInfo: null,
    isFullScreen: false,
    fullScreenSwipeProgress: 0,
    fullScreenSwipeCompleting: false,
    fullScreenSuppressEntry: false,
    supportsVolumeControl: true,
    supportsCrossfade: true,
    isLoadingTrack: false,
};

// ============================================================================
// Autoplay seed helpers
// ============================================================================

export function getSeedCrossfadeBeats(
    seed: AutoplaySeed | null,
    outgoingBpm?: number,
    incomingBpm?: number,
): number {
    const mood = seed?.type === 'mood' ? seed.mood : undefined;
    return getDjCrossfadeBeats(outgoingBpm, incomingBpm, mood);
}

// ============================================================================
// Store factory
// ============================================================================

/**
 * What the playing tab shows the others (music-tab-sync.ts): enough to mirror
 * the mini-player — track, queue, a position that keeps moving — and, when the
 * listener presses play in the other tab, to continue from exactly there.
 */
interface MusicTabLiveState {
    track: MusicTrack | null;
    /** Omitted when unchanged since the previous state (position ticks). */
    queue?: QueueItem[];
    history?: MusicTrack[];
    playbackContext: PlaybackContext | null;
    autoplaySeed: AutoplaySeed | null;
    positionMs: number;
    durationMs: number;
    isPlaying: boolean;
    volume: number;
    isMuted: boolean;
    /** Date.now() when sent; the receiver advances the position from here. */
    sentAt: number;
}

/** While the owner plays, it re-sends its position this often. */
const LIVE_STATE_INTERVAL_MS = 3_000;
/** How often a mirroring tab advances its displayed position between states. */
const MIRROR_TICK_MS = 500;

function feedbackForTrack(track: MusicTrack): 'liked' | 'disliked' | null {
    const feedback = 'feedback' in track ? track.feedback : undefined;
    return feedback === 'liked' || feedback === 'disliked' ? feedback : null;
}

function createMusicPlayerStore() {
    const store = writable<MusicPlayerState>(INITIAL_STATE);

    /** Keep the user's volume untouched when loudness normalization is disabled. */
    function getPlaybackVolume(volume: number, loudnessLufs: number | undefined): number {
        return get(store).loudnessNormalizationEnabled
            ? applyLufsGain(volume, loudnessLufs)
            : volume;
    }

    // The platform-specific audio backend (WebAudioBackend or PlainAudioBackend)
    let backend: AudioBackend | null = null;
    let initInFlight = false;
    let initPromise: Promise<void> | null = null;
    let airPlayDetector: AirPlayDetector | null = null;
    let progressReportInterval: ReturnType<typeof setInterval> | null = null;
    let isSkipping = false;
    /** A dislike advances the queue without also inferring a skip. */
    let suppressNextSkipReport = false;
    // Monotonic token for in-flight play() calls. Only the most recent call
    // is allowed to clear `isLoadingTrack` — earlier calls finishing late
    // would otherwise hide the loading bar while the latest tap is still
    // loading.
    let playLoadToken = 0;
    /**
     * Fields that must be reset whenever currentTrack changes.
     * Used by all track-switch paths (play, crossfade, cancel-crossfade)
     * to avoid scattered invalidation bugs.
     */
    const TRACK_SWITCH_RESETS = {
        currentTrackFeedback: null,
        lyricsStatus: 'idle' as const,
        hasSeeked: false,
        crossfadeDebugInfo: null,
        crossfadeOutgoing: null,
        pendingCrossfadeForTrackId: null,
        playStartedAt: null,
        playEventId: null,
        playContext: null,
    } satisfies Partial<MusicPlayerState>;

    /**
     * Session history with the outgoing track prepended, newest first.
     *
     * Every updater that promotes a new track into `currentTrack` must set
     * `history: historyWithOutgoing(s)`. The smart queue sends these ids as its
     * `exclude`/`history` params, so a swap path that skips this leaves the
     * server with no session context and it re-picks tracks already played.
     */
    function historyWithOutgoing(s: MusicPlayerState): MusicTrack[] {
        if (!s.currentTrack) return s.history;
        return [s.currentTrack, ...s.history].slice(0, HISTORY_LIMIT);
    }

    /**
     * Queue-context ids for the smart queue's sonic centroid (`recentQueue`
     * param): the current track, then upcoming USER-queued tracks (deliberate
     * intent), backfilled with recently played history. Unplayed smart picks
     * are deliberately excluded — feeding them back into the centroid let one
     * off-lane suggestion reinforce itself before it was ever heard, which
     * compounded into full genre drift within a few autoplay hops.
     */
    function recentQueueContextIds(s: MusicPlayerState, currentTrackId: string): string[] {
        // Dedup across all three sources — the centroid weights each id by
        // position, so a track that is both user-queued and in recent history
        // (or is the current track re-queued) would otherwise be
        // double-counted at two decay ranks.
        const MAX_CONTEXT = 5;
        const seen = new Set([currentTrackId]);
        const ids = [currentTrackId];
        for (const q of s.queue) {
            if (ids.length >= MAX_CONTEXT) break;
            if (q.source !== 'user' || seen.has(q.track.id)) continue;
            seen.add(q.track.id);
            ids.push(q.track.id);
        }
        for (const t of s.history) {
            if (ids.length >= MAX_CONTEXT) break;
            if (seen.has(t.id)) continue;
            seen.add(t.id);
            ids.push(t.id);
        }
        return ids;
    }

    /** Monotonic version counter for fetchNextTrack — stale responses are ignored */
    let fetchNextTrackVersion = 0;

    /** Synchronous lock to prevent double-fire of triggerCrossfade from rapid 50ms ticks */
    let crossfadePending = false;

    /**
     * Track ID of the next-queue track for which we have already issued a
     * prefetchNext() call on the backend. Keyed to the next track ID so that:
     * - We prefetch at most once per upcoming track (guard against ~50ms re-fires).
     * - If the queue head changes (reorder/insert), the new ID differs from the
     *   stored value and we re-prefetch the new next track immediately.
     * No explicit reset is required: the id comparison in checkPrefetchNext is
     * self-correcting across track switches and queue mutations.
     */
    let prefetchedNextTrackId: string | null = null;

    /**
     * Monotonic token claimed by each triggerCrossfade() before it awaits the
     * backend. Any path that cancels a crossfade (skip, play, pause, seek,
     * AirPlay activation) bumps this token; the finalize block that runs after
     * the await re-checks it and bails if it changed — so the outgoing track's
     * play-end / completed-listen is reported exactly once, by whoever handled
     * the cancellation, never twice.
     */
    let crossfadeToken = 0;

    /** Active music session ID for admin sessions panel visibility */
    let musicSessionId: string | null = null;
    /**
     * Monotonic token for in-flight startMusicSession() calls. Multiple callers
     * (play, crossfade, pause-crossfade, seek-crossfade) can `void
     * startMusicSession()` near-simultaneously; without ordering their async
     * INSERT responses interleave and the loser's session_id can overwrite the
     * winner's, orphaning the live session and mis-targeting heartbeats. Only
     * the most recent call is allowed to publish its session_id.
     */
    let musicSessionToken = 0;

    interface ListeningSession {
        id: string | null;
        ready: Promise<void>;
        start?: Promise<PlaybackStartResponse>;
        trackId: string;
        startedAt: string;
        eventId: string;
        seq: number;
        elapsedMs: number;
        positionMs: number;
        clock: number;
        startReported: boolean;
        durationMs?: number;
        playContext?: string;
    }
    let listeningSession: ListeningSession | null = null;
    let pendingMusicCompletion: Promise<void> = Promise.resolve();
    const legacyReplayStorageKey = LEGACY_REPLAY_STORAGE_KEY;
    let replayStorageKey: string | null = null;
    function currentReplayStorageKey(): string | null {
        const userId = get(page).data.user?.userId;
        return musicReplayStorageKey(userId);
    }
    function trimReplays(): void {
        pendingReplays = boundedMusicReplays(pendingReplays);
    }
    let pendingReplays: MusicReplayItem[] = [];
    let replayLoaded = false;
    let replayFlushing = false;

    function persistReplays(): void {
        try {
            trimReplays();
            if (replayStorageKey) {
                localStorage.setItem(replayStorageKey, JSON.stringify(pendingReplays));
            }
        } catch {
            /* storage unavailable */
        }
    }

    function loadReplays(): void {
        const key = currentReplayStorageKey();
        if (replayLoaded && replayStorageKey === key) return;
        replayLoaded = true;
        replayStorageKey = key;
        pendingReplays = [];
        try {
            // The old queue has no owner identity: clearing avoids attributing another user's listens.
            localStorage.removeItem(legacyReplayStorageKey);
            if (!replayStorageKey) return;
            const saved: unknown = JSON.parse(localStorage.getItem(replayStorageKey) ?? '[]');
            if (Array.isArray(saved)) {
                pendingReplays = boundedMusicReplays(saved);
                persistReplays();
            }
        } catch {
            /* storage unavailable */
        }
    }

    async function flushMusicReplays(): Promise<void> {
        loadReplays();
        if (replayFlushing || !pendingReplays.length) return;
        replayFlushing = true;
        // Process the snapshot once, in server-sized batches. Retryable results
        // wait for a later trigger instead of spinning on the same rejected item.
        const snapshot = pendingReplays.slice();
        const ownerKey = replayStorageKey;
        try {
            for (let offset = 0; offset < snapshot.length; offset += 100) {
                const batch = snapshot.slice(offset, offset + 100);
                const result = await replayMusicPlays(batch);
                if (currentReplayStorageKey() !== ownerKey) return;
                if (!result.data || result.error) break;
                const done = new Set(
                    result.data.results.flatMap((entry) => {
                        const item = batch[entry.index];
                        return item && entry.eventId === item.eventId && !entry.retryable
                            ? [item.eventId]
                            : [];
                    }),
                );
                pendingReplays = pendingReplays.filter((item) => !done.has(item.eventId));
                persistReplays();
            }
        } catch {
            /* retry on the next heartbeat or reconnect */
        } finally {
            replayFlushing = false;
            // A terminal report may have queued another play while a batch was
            // in flight. Flush those additions without retrying this snapshot.
            const submitted = new Set(snapshot.map((item) => item.eventId));
            if (pendingReplays.some((item) => !submitted.has(item.eventId))) {
                void flushMusicReplays();
            }
        }
    }

    function queueMusicReplay(item: MusicReplayItem, flush = true): void {
        loadReplays();
        if (!replayStorageKey) return;
        if (!pendingReplays.some((queued) => queued.eventId === item.eventId)) {
            pendingReplays.push(item);
            persistReplays();
        }
        if (flush) void flushMusicReplays();
    }

    function musicReport(
        session: ListeningSession,
        status: MusicPlaybackReport['status'],
        positionMs: number,
    ): MusicPlaybackReport {
        return {
            positionMs: Math.max(0, Math.round(positionMs)),
            status,
            eventSeq: ++session.seq,
            sessionElapsedMs: Math.round(session.elapsedMs),
            listenedTotalMs: Math.round(session.elapsedMs),
        };
    }

    // Count heard audio, capped by wall time. Seeks and stalled playheads add no
    // listening time. A new session starts at zero even when resuming a position.
    function accumulateListening(info: TimeUpdateInfo): void {
        const session = listeningSession;
        if (!session) return;
        const now = Date.now();
        if (get(store).isPlaying) {
            session.elapsedMs += Math.max(
                0,
                Math.min(
                    now - session.clock,
                    (info.currentTimeMs - session.positionMs) / (info.playbackRate || 1),
                ),
            );
        }
        session.clock = now;
        session.positionMs = info.currentTimeMs;
    }

    async function startMusicSession(track: MusicTrack): Promise<void> {
        void completeMusicSession();
        const previousCompletion = pendingMusicCompletion;
        const myToken = ++musicSessionToken;
        const session: ListeningSession = {
            id: null,
            ready: Promise.resolve(),
            trackId: track.id,
            startedAt: new Date().toISOString(),
            eventId: crypto.randomUUID(),
            seq: 0,
            elapsedMs: 0,
            positionMs: get(store).currentTrack?.id === track.id ? get(store).currentTimeMs : 0,
            clock: Date.now(),
            startReported: false,
            durationMs:
                track.durationMs && track.durationMs > 0 ? Math.round(track.durationMs) : undefined,
            playContext: derivePlayContext(get(store)),
        };
        listeningSession = session;
        store.update((s) => ({
            ...s,
            playStartedAt: session.startedAt,
            playEventId: session.eventId,
        }));
        session.ready = (async () => {
            await previousCompletion;
            try {
                session.start = musicStart(track);
                const result = await session.start;
                if (result) {
                    session.id = result.playbackSessionId;
                    session.eventId = result.playbackSessionId;
                    if (myToken === musicSessionToken && listeningSession === session) {
                        musicSessionId = session.id;
                        store.update((s) => ({
                            ...s,
                            playEventId: session.id,
                            playStartedAt: session.startedAt,
                        }));
                    }
                }
            } catch {
                /* offline playback is replayed at the end */
            }
        })();
        await session.ready;
        if (listeningSession === session && get(store).currentTrack?.id === track.id) {
            heartbeatMusicSession(get(store).currentTimeMs, !get(store).isPlaying);
        }
        void flushMusicReplays();
    }

    /**
     * The fade this player is reporting for Active Streams ("A → B"). The
     * incoming track is promoted at fade start, so the report rides on the NEW
     * session as role 'incoming' with the outgoing track as the other side.
     * `endsAt` is local wall time; only the remaining milliseconds go to the
     * server, which re-anchors them on its own clock.
     */
    let crossfadeReport: { otherTrackId: string; durationMs: number; endsAt: number } | null = null;
    /** A cancelled fade still shown server-side: the next heartbeat sends null. */
    let crossfadeReportCleared = false;

    function crossfadeHeartbeatField(): {
        crossfade?: {
            otherTrackId: string;
            role: 'incoming';
            remainingMs: number;
            durationMs: number;
        } | null;
    } {
        if (crossfadeReport) {
            const remainingMs = Math.round(crossfadeReport.endsAt - Date.now());
            if (remainingMs > 0) {
                return {
                    crossfade: {
                        otherTrackId: crossfadeReport.otherTrackId,
                        role: 'incoming',
                        remainingMs: Math.min(remainingMs, 60_000),
                        durationMs: Math.min(crossfadeReport.durationMs, 60_000),
                    },
                };
            }
            // Ran its course: the server entry expires on its own.
            crossfadeReport = null;
        }
        if (crossfadeReportCleared) {
            crossfadeReportCleared = false;
            return { crossfade: null };
        }
        return {};
    }

    // A fade cut short (pause, seek, skip, AirPlay, a failed engine) ends
    // through many paths; all of them clear isCrossfading. Watching that one
    // flag clears the Active Streams fade at once instead of leaving "A → B"
    // up until it would have finished. A fade that simply ran out needs no
    // call: the server entry expires at its end time.
    let wasCrossfading = false;
    store.subscribe((s) => {
        if (wasCrossfading && !s.isCrossfading && crossfadeReport) {
            const leftMs = crossfadeReport.endsAt - Date.now();
            crossfadeReport = null;
            if (leftMs > 1_000) {
                crossfadeReportCleared = true;
                // Deferred: the path that cancelled may send its own
                // heartbeat (pause does), which then carries the clear.
                queueMicrotask(() => {
                    if (!crossfadeReportCleared) return;
                    const now = get(store);
                    heartbeatMusicSession(now.currentTimeMs, !now.isPlaying);
                });
            }
        }
        wasCrossfading = s.isCrossfading;
    });

    function heartbeatMusicSession(positionMs: number, isPaused: boolean): void {
        if (!musicSessionId) return;
        const id = musicSessionId;
        const nextTrackId = get(store).queue[0]?.track.id;
        const fadeField = crossfadeHeartbeatField();
        // A clear that never reached the server is retried by the next
        // heartbeat; otherwise a cancelled fade stays up until its end time.
        const retryClear = (): void => {
            if (fadeField.crossfade === null && musicSessionId === id && !crossfadeReport) {
                crossfadeReportCleared = true;
            }
        };
        const session = listeningSession;
        if (!session || session.id !== id) return;
        void flushMusicReplays();
        void reportMusicPlayback(id, {
            ...musicReport(session, isPaused ? 'PAUSED' : 'ACTIVE', positionMs),
            ...(nextTrackId ? { nextMediaId: nextTrackId } : {}),
            ...fadeField,
        })
            .then((result) => {
                if (!result.error && !result.data?.action && session.elapsedMs > 0)
                    session.startReported = true;
                if (result.error && result.status !== 404) retryClear();
                // 404 on an ACTIVE/PAUSED heartbeat means the session row is no
                // longer ACTIVE/PAUSED. We never heartbeat a session we
                // completed ourselves (completeMusicSession nulls the id
                // first), so the only way here is an out-of-band termination:
                // an admin kill from /admin/sessions, a self-kill from the home
                // "free a slot" panel, or the stream-limit reconciler. Stop
                // playback so the kill actually takes effect — previously the
                // row flipped to KILLED server-side but the <audio> kept
                // playing because nothing on the client honored the kill.
                // Guard on the id still being current so a late 404 for a track
                // we already switched away from can't stop the new one.
                if (
                    (result.status === 404 ||
                        result.data?.action === 'kill' ||
                        result.data?.action === 'superseded') &&
                    musicSessionId === id
                ) {
                    handleSessionKilled();
                }
            })
            .catch(() => {
                // Network/parse failure — non-critical, keep playing.
                retryClear();
            });
    }

    /**
     * A live music session was terminated server-side (admin/self kill or the
     * stream-limit reconciler). Tear playback down cleanly. The row is already
     * gone, so null the session id first: that makes stop()'s
     * completeMusicSession() a no-op instead of PUTting a dead session, and
     * bumping the token invalidates any in-flight startMusicSession().
     */
    function handleSessionKilled(): void {
        listeningSession = null;
        if (sessionSupersededByOtherTab) {
            // Not a kill: another tab of this browser started playing, and its
            // session start closed ours (one music session per device). This
            // tab is already paused for it; stopping here would throw away its
            // place. Resume opens a fresh session.
            musicSessionId = null;
            return;
        }
        musicSessionId = null;
        musicSessionToken++;
        stop();
        toasts.info('Playback stopped — this session was ended.');
    }

    function completeMusicSession(
        endReason: 'skip' | 'completion' | 'user' | 'unload' = 'user',
        beacon = false,
    ): Promise<void> {
        const hadSession = listeningSession !== null;
        const completion = finishMusicSession(endReason, beacon);
        if (hadSession) pendingMusicCompletion = completion;
        return completion;
    }

    function releaseMusicSessionStart(session: ListeningSession): void {
        if (session.start && musicStarts.get(session.trackId) === session.start) {
            musicStarts.delete(session.trackId);
            grantDisposers.get(session.trackId)?.();
            grantDisposers.delete(session.trackId);
            castStarts.delete(session.trackId);
        }
    }

    async function finishMusicSession(
        endReason: 'skip' | 'completion' | 'user' | 'unload',
        beacon: boolean,
    ): Promise<void> {
        const session = listeningSession;
        listeningSession = null;
        musicSessionId = null;
        musicSessionToken++;
        if (!session) return;
        releaseMusicSessionStart(session);
        const state = get(store);
        const positionMs =
            state.currentTrack?.id === session.trackId ? state.currentTimeMs : session.positionMs;
        const report = { ...musicReport(session, 'COMPLETED', positionMs), endReason };
        const replay: MusicReplayItem = {
            eventId: session.eventId,
            kind: 'music',
            mediaId: session.trackId,
            startedAt: session.startedAt,
            endedAt: new Date().toISOString(),
            positionMs: report.positionMs,
            listenedMs: report.listenedTotalMs ?? 0,
            endReason,
            startReported: session.startReported,
            durationMs: session.durationMs,
            playContext: session.playContext,
        };
        // Persist before unloading: beacon enqueueing does not acknowledge delivery.
        if (beacon) {
            void session.ready.then(() => releaseMusicSessionStart(session));
            queueMusicReplay(replay, false);
            if (session.id) {
                try {
                    reportMusicPlaybackBeacon(session.id, report);
                } catch {
                    /* persisted for replay */
                }
            }
            return;
        }
        await session.ready;
        releaseMusicSessionStart(session);
        replay.eventId = session.eventId;
        replay.startReported = session.startReported;
        if (session.id) {
            try {
                const result = await reportMusicPlayback(session.id, report);
                if (!result.error) return;
            } catch {
                /* replay the same id if the response was lost */
            }
        }
        queueMusicReplay(replay);
    }

    function resetListeningPosition(positionMs: number): void {
        if (!listeningSession) return;
        listeningSession.positionMs = positionMs;
        listeningSession.clock = Date.now();
    }

    let listeningWasPlaying = false;
    store.subscribe((state) => {
        if (listeningSession && (!state.isPlaying || !listeningWasPlaying)) {
            listeningSession.clock = Date.now();
            listeningSession.positionMs = state.currentTimeMs;
        }
        listeningWasPlaying = state.isPlaying;
    });

    // -------------------------------------------------------------------------
    // Crossfade trigger check (extracted from old progress loop)
    // -------------------------------------------------------------------------

    /**
     * Largest beat count `determineCrossfadeStyle` ever returns (echo/blend/
     * bass-swap). Used only to derive a conservative upper bound on the fade
     * duration when deciding whether the per-tick style math can be skipped.
     */
    const MAX_STYLE_CROSSFADE_BEATS = 48;
    /** Max `bufferAfterFade` added to a fade (blend/other = 5s; bass-swap = 1s). */
    const MAX_CROSSFADE_BUFFER_AFTER_FADE_MS = 5_000;
    /**
     * Slack matching the `targetTriggerMs - 2000` pending-arm window below. Kept
     * in sync with the pending-arm condition so the early-return can't skip a
     * tick on which the pending point would have been armed.
     */
    const CROSSFADE_PENDING_ARM_SLACK_MS = 2_000;

    function checkCrossfadeTrigger(currentMs: number, durationMs: number): void {
        const state = get(store);
        const rawOutroStart = state.currentTrack?.audioFeatures?.outroStartMs;
        // Never start a gradual fade while the outgoing track is still singing:
        // when the analysis knows where the last vocal phrase ends, delay the
        // outro trigger to that point. (lastVocalEndMs is sidecar-engine
        // only; undefined leaves the outro boundary untouched.) A last-vocal-end
        // sitting within the final 2s of the track is an analysis outlier — no
        // fade can host it — so it's guarded out here too, as is the vocal end
        // of a dj-outro boundary (already placed after the vocals server-side).
        const lastVocalEnd = guardLastVocalEndMs(state.currentTrack?.audioFeatures, durationMs);
        const outroStart =
            rawOutroStart !== undefined && lastVocalEnd !== undefined
                ? Math.max(rawOutroStart, lastVocalEnd)
                : rawOutroStart;
        const hasNext = state.queue.length > 0;

        // crossfadeEnabled governs AUTOMATIC fades only — a manual hold-to-mix
        // pending (pendingCrossfadeIsManual) must still fire with it off.
        if (
            state.isCrossfading ||
            crossfadePending ||
            !hasNext ||
            (!state.crossfadeEnabled && !state.pendingCrossfadeIsManual) ||
            !state.supportsCrossfade ||
            state.isAirPlayActive
        ) {
            return;
        }

        // Self-correcting: if queue[0] changed since we computed the pending
        // trigger point, discard it so we recompute for the new track. We then
        // fall through and recompute against the current head this same tick
        // — returning let the very next tick hit the outro path with a
        // freshly-reset pending state and fire a crossfade for a head that
        // had only just been swapped in — except when auto-crossfade is
        // disabled: the cleared manual pending was the only reason this tick
        // got past the crossfadeEnabled guard, so we return early instead.
        const currentHeadId = state.queue[0]?.id;
        let pendingCrossfadeAtMs = state.pendingCrossfadeAtMs;
        if (pendingCrossfadeAtMs !== null && state.pendingCrossfadeForTrackId !== currentHeadId) {
            store.update((s) => ({
                ...s,
                pendingCrossfadeAtMs: null,
                pendingCrossfadeForTrackId: null,
                pendingCrossfadeIsManual: false,
            }));
            pendingCrossfadeAtMs = null;
            // A manual mix armed for the old head does not transfer to the new
            // one — and it was the only reason this tick got past the
            // crossfadeEnabled guard. Without the auto setting there is
            // nothing left to compute.
            if (!state.crossfadeEnabled) return;
        }

        // PERF: the style/duration math below (determineCrossfadeStyle,
        // clampBassSwapBeats, calculateCrossfadeDuration, findNextDownbeat) runs
        // on EVERY onTimeUpdate tick (~20×/sec). Far from the track boundary none
        // of it can change state — no trigger can fire and no pending point can be
        // armed — so skip it. Exact boundary behavior is preserved by deriving a
        // conservative upper bound on how early any action could occur:
        //   • outro trigger requires currentMs >= outroStart
        //   • pending-arm requires currentMs >= (durationMs - leadMs - 2000)
        // where leadMs = fadeDurationMs + bufferAfterFade (≤5000) and fadeDurationMs
        // is monotonic in beats. We bound beats by (override ?? max style beats = 48)
        // and reuse the exact bpm the real path uses, so maxLeadMs ≥ any actual
        // leadMs — the skipped window can never contain a real action. We only skip
        // while nothing is armed yet; an armed pending must still be checked for
        // firing (currentMs >= pendingCrossfadeAtMs), and that branch touches none
        // of the skipped math.
        if (durationMs > 0 && pendingCrossfadeAtMs === null) {
            const outBpmBound = state.currentTrack?.audioFeatures?.bpm;
            const inBpmBound = state.queue[0]?.track.audioFeatures?.bpm;
            const bpmBound = outBpmBound ?? inBpmBound ?? 0;
            const maxBeatsBound = state.crossfadeBeatsOverride ?? MAX_STYLE_CROSSFADE_BEATS;
            const maxLeadMs =
                calculateCrossfadeDuration(bpmBound, maxBeatsBound) +
                MAX_CROSSFADE_BUFFER_AFTER_FADE_MS;
            const earliestPendingArmMs = durationMs - maxLeadMs - CROSSFADE_PENDING_ARM_SLACK_MS;
            const outroReachable = outroStart !== undefined && currentMs >= outroStart;
            if (!outroReachable && currentMs < earliestPendingArmMs) {
                return;
            }
        }

        if (durationMs > 0) {
            // Dynamic lead time based on smart crossfade detection. Shared with
            // MiniPlayer's fade-zone marker via computeCrossfadePlan so the two
            // can never diverge — see crossfade-plan.ts.
            const chMood =
                state.autoplaySeed?.type === 'mood'
                    ? state.autoplaySeed.mood?.toLowerCase()
                    : undefined;
            const plan = computeCrossfadePlan({
                outgoingAudioFeatures: state.currentTrack?.audioFeatures,
                incomingAudioFeatures: state.queue[0]?.track.audioFeatures,
                durationMs,
                incomingDurationSec: (state.queue[0]?.track.durationMs ?? 0) / 1000,
                crossfadeBeatsOverride: state.crossfadeBeatsOverride,
                mood: chMood,
                currentMs,
            });

            // Outro boundary trigger — for gradual transitions (plan.usesOutro).
            // Cut and end-aligned (short BPM-gap echo) transitions skip it:
            // outroStartMs marks where the outro begins (8-16s from end), but
            // those are short and should fire closer to the actual end via the
            // dynamic lead time.
            //
            // Guard against firing for a stale/just-swapped queue head: the
            // outro position belongs to the *outgoing* track, but a recent head
            // swap means the pending state was reset to null this tick — so we
            // additionally require a sane remaining window (enough time for the
            // fade to complete) before firing the outro trigger.
            const remainingMs = durationMs - currentMs;
            const minRemainingForOutroMs = plan.fadeDurationMs + 1_000;
            if (
                plan.usesOutro &&
                outroStart !== undefined &&
                currentMs >= outroStart &&
                remainingMs >= minRemainingForOutroMs
            ) {
                if (pendingCrossfadeAtMs === null) {
                    void triggerCrossfade();
                    return;
                }
            }

            // plan.dynamicTargetMs > 0 iff durationMs > (fadeDurationMs + bufferAfterFade).
            if (plan.dynamicTargetMs > 0) {
                if (pendingCrossfadeAtMs !== null) {
                    if (currentMs >= pendingCrossfadeAtMs) {
                        void triggerCrossfade();
                    }
                } else if (currentMs >= plan.dynamicTargetMs - CROSSFADE_PENDING_ARM_SLACK_MS) {
                    const downbeats = state.currentTrack?.audioFeatures?.downbeats;
                    const bpm =
                        state.currentTrack?.audioFeatures?.bpm ??
                        state.queue[0]?.track.audioFeatures?.bpm ??
                        0;
                    let snapAtMs = plan.dynamicTargetMs;
                    if (downbeats && downbeats.length > 0 && bpm > 0) {
                        const maxLookaheadSec = (2 * 4 * 60) / bpm;
                        const nextBeat = findNextDownbeat(
                            downbeats,
                            plan.dynamicTargetMs / 1000,
                            maxLookaheadSec,
                        );
                        snapAtMs = nextBeat * 1000;
                    }
                    // Never schedule the fade to start while the outgoing
                    // track is still singing (best effort — the end-of-track
                    // clamp below still wins when even the shrunk fade can't
                    // fit after the vocals).
                    if (plan.lastVocalEndMs !== undefined) {
                        snapAtMs = Math.max(snapAtMs, plan.lastVocalEndMs);
                    }
                    // Clamp: never snap past the point where the crossfade
                    // wouldn't have time to complete before track end, with a
                    // headroom margin so the fade can't be scheduled to finish
                    // exactly at (or after) the last sample.
                    snapAtMs = Math.min(
                        snapAtMs,
                        durationMs - plan.fadeDurationMs - CROSSFADE_END_HEADROOM_MS,
                    );
                    store.update((s) => ({
                        ...s,
                        pendingCrossfadeAtMs: snapAtMs,
                        pendingCrossfadeForTrackId: currentHeadId ?? null,
                        pendingCrossfadeIsManual: false,
                    }));
                }
            }
        }
    }

    /**
     * Warm the browser buffer for the next queued track when the current track
     * has passed the 20% mark. Called on every onTimeUpdate tick (≈50ms) but
     * guarded by `prefetchedNextTrackId` so the backend call fires at most once
     * per upcoming track.  Re-fires if the queue head changes (reorder/insert).
     * No-op when crossfading (the inactive deck is already loaded by the crossfade
     * path), when there is no next track, or when duration is unknown.
     */
    function checkPrefetchNext(currentMs: number, durationMs: number): void {
        if (durationMs <= 0) return;
        if (currentMs / durationMs < 0.2) return;

        const state = get(store);
        // During an active crossfade the backend is already buffering the next
        // track on the inactive deck — no prefetch needed.
        if (state.isCrossfading) return;

        const nextTrack = state.queue[0]?.track;
        if (!nextTrack) return;

        if (prefetchedNextTrackId === nextTrack.id) return;

        // Mark before calling so rapid re-fires (50ms interval) don't double-call.
        prefetchedNextTrackId = nextTrack.id;
        prefetchStarts.add(nextTrack.id);
        void trackStreamUrl(nextTrack, { waitForOutgoing: true })
            .then((url) => {
                if (get(store).queue[0]?.track.id === nextTrack.id) backend?.prefetchNext(url);
                else if (get(store).currentTrack?.id !== nextTrack.id) {
                    const pending = musicStarts.get(nextTrack.id);
                    if (pending) discardMusicStart(nextTrack.id, pending);
                }
            })
            .catch(() => {
                // Speculative warming is best-effort. Retrying every time tick
                // under a cap of one would exhaust admission's rate limit.
                // A normal track transition requests a fresh start after stop.
                prefetchStarts.delete(nextTrack.id);
            });
    }

    /**
     * Cancel an in-flight crossfade and promote the incoming queue head to the
     * current track, keeping playback going. Used when AirPlay engages mid-fade
     * (B8) — the wireless route can't run the dual-deck crossfade, so we finalize
     * the swap synchronously instead of leaving two decks mid-fade.
     *
     * Mirrors triggerCrossfade's finalize block: reports play-end + completed
     * listen for the outgoing track exactly once, then swaps state. Bumps the
     * crossfade token first so any in-flight triggerCrossfade continuation bails
     * and can't double-report.
     */
    function finalizeCrossfadeForAirPlay(): void {
        const state = get(store);
        if (!state.isCrossfading) return;

        crossfadeToken++;
        backend?.cancelCrossfade();
        crossfadePending = false;

        // The incoming track was already promoted to currentTrack at fade
        // start (triggerCrossfade), which also handled play-end reporting,
        // session transition and queue consumption. cancelCrossfade() just
        // promoted the matching deck; keep it playing and reconcile.
        backend?.resume();
        // cancelCrossfade promoted the incoming deck at the backend's remembered
        // volume, which is still LUFS-adjusted for the OUTGOING track. Re-apply
        // the current (incoming) track's normalization (same re-sync as the
        // crossfade finalize block; skipped while muted for the same reason).
        if (backend?.supportsVolumeControl && !state.isMuted) {
            backend.setVolume(
                getPlaybackVolume(state.volume, state.currentTrack?.audioFeatures?.loudnessLufs),
            );
        }
        // Read back the deck's actual position (wherever the fade left it,
        // mid-intro) so the store mirrors real audio.
        const actualMs = backend?.getCurrentTimeMs() ?? state.currentTimeMs;
        const reconciledMs =
            Number.isFinite(actualMs) && actualMs >= 0 ? actualMs : state.currentTimeMs;

        store.update((s) => ({
            ...s,
            isCrossfading: false,
            crossfadeProgress: 0,
            crossfadeOutgoing: null,
            crossfadeCurrentBeat: 0,
            crossfadeTotalBeats: 0,
            isPlaying: true,
            currentTimeMs: reconciledMs,
            progress: s.durationMs > 0 ? reconciledMs / s.durationMs : 0,
            normalizingTargetBpm: null,
        }));
    }

    // -------------------------------------------------------------------------
    // Initialization
    // -------------------------------------------------------------------------

    let unregisterAudioParticipant: (() => void) | null = null;
    /** Cross-tab "one tab plays" coordinator — see music-tab-sync.ts. */
    let tabSync: MusicTabSync<MusicTabLiveState> | null = null;
    /**
     * Mirroring: this tab is not playing and shows the owner's live state.
     * `mirroredLoadedTrackId` is the track this tab's backend actually has
     * loaded — once the owner moves on, resuming here must load the new track,
     * not unpause the old one.
     */
    let mirroring = false;
    let mirroredLoadedTrackId: string | null = null;
    /** Player closed (X) in this tab while mirroring; cleared by a new claim. */
    let mirrorDismissed = false;
    let dismissedOwnerTabId: string | null = null;
    /** When the owner's last state arrived (its last sign of life). */
    let lastOwnerStateAt = 0;
    /** A take-over (resume from another tab) is in flight. */
    let takingOver = 0;
    /** When this tab last sent the owner an optimistic command. */
    let lastLocalActionAt = 0;
    /** Trailing throttle for volume commands during a slider drag. */
    let volumeCommandTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingVolume: number | null = null;
    let mirrorAnchor: { positionMs: number; sentAt: number; isPlaying: boolean } | null = null;
    let mirrorTicker: ReturnType<typeof setInterval> | null = null;
    let liveStateInterval: ReturnType<typeof setInterval> | null = null;
    let unsubscribeLiveState: (() => void) | null = null;
    let unsubscribeSessionEnded: (() => void) | null = null;
    /** Bumped when another tab claims playback; a start in flight yields. */
    let otherTabClaimEpoch = 0;
    /** Bumped by every play/pause/stop, so a slow resume can tell it was superseded. */
    let playbackIntentGen = 0;
    /**
     * Another tab played since this one last started. Every tab of a browser
     * shares one device id and the server keeps one music session per device,
     * so that tab's session start closed ours ('track_change'). Resuming must
     * open a new session: heartbeating the closed one 404s, which reads as an
     * admin kill and stops playback.
     */
    let sessionSupersededByOtherTab = false;
    /**
     * A track ended with an empty queue while a smart-queue fetch was in
     * flight; that fetch should start the next track when it lands. ONLY then:
     * without this flag the fetch started the next track whenever the player
     * happened to be idle — a paused player, or a tab restored paused (every
     * restore fetches suggestions) began playing a second later by itself.
     */
    let awaitingQueueRefill = false;

    async function init(): Promise<void> {
        if (backend) return;
        // Concurrent callers share the one in-flight init, so a play() that
        // lands while it is still running can wait for it (see play()).
        if (initPromise) return initPromise;
        initPromise = initBackend().finally(() => {
            initPromise = null;
        });
        return initPromise;
    }

    // The in-flight preference load started by initBackend. A restore waits for
    // it before topping up the queue: autoplayEnabled defaults to true until the
    // saved value arrives, so an earlier top-up would add smart tracks for a
    // user who has autoplay off.
    let musicSettingsLoaded: Promise<void> = Promise.resolve();

    async function initBackend(): Promise<void> {
        if (initInFlight) return;
        initInFlight = true;
        try {
            backend = await createAudioBackend();
            // Load music preferences with the player, not only when the Queue
            // settings tab is opened. This ensures a persisted normalization
            // choice takes effect for every playback entry point after reload.
            musicSettingsLoaded = loadMusicSettings();

            // Starting an audiobook stops music. Registered here rather than at
            // module scope so a store that never initialised cannot be asked to
            // stop a backend it does not have.
            unregisterAudioParticipant?.();
            unregisterAudioParticipant = registerAudioParticipant('music', () => stop(), {
                // An audiobook started in another tab: pause, keep the place.
                pauseForOtherTab: () => {
                    sessionSupersededByOtherTab = true;
                    // A resume still waiting on the owner query must yield too.
                    otherTabClaimEpoch++;
                    if (get(store).isPlaying) pause();
                },
            });

            // Another tab starting playback pauses this one. A plain pause():
            // by the time it runs this tab no longer owns the shared snapshot,
            // so its persist is a no-op and the playing tab's state survives.
            tabSync?.destroy();
            tabSync = createMusicTabSync<MusicTabLiveState>({
                getState: () => {
                    const s = get(store);
                    return {
                        isPlaying: s.isPlaying,
                        trackId: s.currentTrack?.id ?? null,
                        positionMs: Math.round(s.currentTimeMs),
                        track: s.currentTrack,
                    };
                },
                onOtherTabPlaying: (claim) => {
                    // Also covers a start still loading here (play(), a resume
                    // waiting on the owner query): they check the epoch.
                    otherTabClaimEpoch++;
                    sessionSupersededByOtherTab = true;
                    // Closed with X: stay closed while the same tab keeps
                    // playing (every track change is a new claim); reopen
                    // when a different tab starts.
                    if (claim.tabId !== dismissedOwnerTabId) mirrorDismissed = false;
                    clearVolumeCommand();
                    if (get(store).isPlaying) pause();
                    store.update((s) => ({ ...s, playingElsewhere: true }));
                },
                onOtherTabIdle: (reason) => {
                    stopMirrorTicker();
                    if (reason === 'expired' && mirrorAnchor?.isPlaying) {
                        // The owner died (crash, discarded tab): nothing played
                        // after its last state, so rewind the position the
                        // ticker ran on to that point — Play continues from
                        // where the music actually stopped.
                        const alive =
                            mirrorAnchor.positionMs +
                            Math.max(0, lastOwnerStateAt - mirrorAnchor.sentAt);
                        store.update((s) => {
                            const ms = s.durationMs > 0 ? Math.min(alive, s.durationMs) : alive;
                            return {
                                ...s,
                                currentTimeMs: ms,
                                progress: s.durationMs > 0 ? ms / s.durationMs : 0,
                            };
                        });
                    }
                    if (mirrorAnchor) mirrorAnchor = { ...mirrorAnchor, isPlaying: false };
                    store.update((s) => ({ ...s, playingElsewhere: false }));
                },
                onOwnerState: (live) => applyOwnerState(live),
                onCommand: (command) => {
                    const s = get(store);
                    switch (command.type) {
                        case 'seek':
                            // Only for the track the mirroring tab saw.
                            if (
                                s.currentTrack?.id === command.trackId &&
                                Number.isFinite(command.positionMs) &&
                                command.positionMs >= 0
                            ) {
                                seekTo(command.positionMs);
                            }
                            break;
                        case 'pause':
                            if (s.isPlaying) pause();
                            break;
                        case 'queue-op':
                            applyQueueOp(command);
                            break;
                        case 'skip':
                            if (s.currentTrack) void skip();
                            break;
                        case 'previous':
                            if (s.currentTrack) void previous();
                            break;
                        case 'volume':
                            if (Number.isFinite(command.volume)) setVolume(command.volume);
                            break;
                        case 'mute':
                            if (s.isMuted !== command.muted) toggleMute();
                            break;
                    }
                },
                // A tab just opened: give it the full lists at once.
                onQueried: () => broadcastLiveState(true),
            });
            startLiveStateBroadcast();

            // Logging out in another tab ends this user's session here too:
            // stop, and never write their queue back (security fix C13).
            unsubscribeSessionEnded?.();
            unsubscribeSessionEnded = onPlaybackSessionEndedElsewhere(() => stop());

            backend.init(
                {
                    onTrackEnded: () => handleTrackEnded(),
                    onPlaybackError: (error) => handlePlaybackError(error),
                    onTimeUpdate: (info: TimeUpdateInfo) => {
                        accumulateListening(info);
                        if (get(store).isCrossfading) {
                            // During a fade the backend's active deck is still the
                            // OUTGOING track, but the store already promoted the
                            // incoming track at fade start. Mirror the incoming
                            // deck's clock instead — and never overwrite
                            // durationMs with the outgoing track's.
                            // The active deck's own clock is the outgoing
                            // track's, which views of what is still heard
                            // follow (crossfadeOutgoing). It only moves forward:
                            // after the completion swap the active deck is the
                            // incoming one.
                            const incomingMs = backend?.getCrossfadeIncomingTimeMs?.() ?? null;
                            store.update((s) => {
                                const out = s.crossfadeOutgoing;
                                const crossfadeOutgoing =
                                    out && info.currentTimeMs > out.timeMs
                                        ? { ...out, timeMs: info.currentTimeMs }
                                        : out;
                                if (incomingMs === null) {
                                    // Nothing moved: keep the state object so
                                    // subscribers are not woken every tick.
                                    return crossfadeOutgoing === out
                                        ? s
                                        : { ...s, crossfadeOutgoing };
                                }
                                return {
                                    ...s,
                                    crossfadeOutgoing,
                                    currentTimeMs: incomingMs,
                                    progress:
                                        s.durationMs > 0 ? incomingMs / s.durationMs : s.progress,
                                };
                            });
                            return;
                        }
                        const trackBpm = get(store).currentTrack?.audioFeatures?.bpm ?? null;
                        const effectiveBpm =
                            trackBpm !== null ? Math.round(trackBpm * info.playbackRate) : null;

                        const prevNormTarget = get(store).normalizingTargetBpm;
                        const normalizingTargetBpm =
                            prevNormTarget !== null && Math.abs(info.playbackRate - 1) < 0.005
                                ? null
                                : prevNormTarget;

                        store.update((s) => ({
                            ...s,
                            currentTimeMs: info.currentTimeMs,
                            durationMs: info.durationMs || s.durationMs,
                            progress:
                                info.durationMs > 0 ? info.currentTimeMs / info.durationMs : 0,
                            effectiveBpm,
                            normalizingTargetBpm,
                        }));

                        checkCrossfadeTrigger(info.currentTimeMs, info.durationMs);
                        checkPrefetchNext(info.currentTimeMs, info.durationMs);
                    },
                    onCrossfadeProgress: (progress) => {
                        store.update((s) => ({
                            ...s,
                            crossfadeProgress: progress.ratio,
                            crossfadeCurrentBeat: progress.currentBeat,
                            crossfadeTotalBeats: progress.totalBeats,
                        }));
                    },
                },
                {
                    onPlay: () => resume(),
                    onPause: () => pause(),
                    onNextTrack: () => void skip(),
                    onPreviousTrack: () => void previous(),
                    onSeekTo: (time) => seekTo(time * 1000),
                    onSeekForward: (offset) => {
                        const currentMs = backend?.getCurrentTimeMs() ?? 0;
                        seekTo(currentMs + (offset ?? 10) * 1000);
                    },
                    onSeekBackward: (offset) => {
                        const currentMs = backend?.getCurrentTimeMs() ?? 0;
                        seekTo(Math.max(0, currentMs - (offset ?? 10) * 1000));
                    },
                    onStop: () => stop(),
                },
            );

            // Update capabilities from the backend
            store.update((s) => ({
                ...s,
                supportsVolumeControl: backend?.supportsVolumeControl ?? true,
                supportsCrossfade: backend?.supportsCrossfade ?? false,
                crossfadeEnabled: backend?.supportsCrossfade ? s.crossfadeEnabled : false,
                crossfadeDebug: readCrossfadeDebug(),
            }));

            // AirPlay detection: gate crossfade on wireless routing.
            // Detector seeds initial state synchronously, so isAirPlayActive is
            // correct even when AirPlay was already engaged at page load.
            airPlayDetector?.stop();
            // Scoped to this init() call so each detector instance gets a fresh
            // flag — no leakage if init() is ever called more than once.
            let initialSeed = true;
            airPlayDetector = createAirPlayDetector(
                (active) => {
                    // AirPlay engaging mid-crossfade: the wireless route can't run
                    // the dual-deck crossfade, so cancel it and finalize the swap
                    // to the incoming track immediately (don't just clear the
                    // pending trigger — that would strand us mid-fade with two
                    // decks). Do this before the store update so the swap lands in
                    // a single coherent state.
                    if (active && get(store).isCrossfading) {
                        finalizeCrossfadeForAirPlay();
                    }
                    store.update((s) => ({
                        ...s,
                        isAirPlayActive: active,
                        // Clear any pending trigger on every transition. On enter:
                        // prevents a pre-AirPlay trigger from firing late after
                        // disconnect. On exit: forces fresh recompute against the
                        // current playback position so we don't fire an overdue
                        // trigger that was scheduled before AirPlay engaged.
                        pendingCrossfadeAtMs: null,
                        pendingCrossfadeForTrackId: null,
                        pendingCrossfadeIsManual: false,
                    }));
                    // Skip the synchronous seed call so we don't log on every page load.
                    if (!initialSeed) {
                        console.info(`[music] AirPlay ${active ? 'connected' : 'disconnected'}`);
                    }
                    initialSeed = false;
                },
                (available) => {
                    store.update((s) => ({
                        ...s,
                        isAirPlayAvailable: available,
                    }));
                },
            );
            airPlayDetector.start(backend?.getAllAudioElements() ?? []);

            // Reapply the persisted output device (best-effort — the device
            // may have been unplugged since; on failure fall back to default
            // and forget the selection so we don't retry every session).
            const persistedSink = readOutputDevice();
            if (persistedSink && backend.setOutputDevice) {
                void backend.setOutputDevice(persistedSink).then((ok) => {
                    if (ok) return;
                    try {
                        localStorage.removeItem(OUTPUT_DEVICE_STORAGE_KEY);
                    } catch {
                        /* expected: localStorage may be unavailable */
                    }
                    store.update((s) => ({ ...s, audioOutputDeviceId: null }));
                });
            }
        } finally {
            initInFlight = false;
        }
    }

    /**
     * The current track's stream failed after it started playing: a mid-stream
     * network drop or decode error. A failure while `backend.play()` is still
     * pending rejects that call instead, and play()'s own catch handles it.
     *
     * Stops with an error rather than skipping or retrying, as the iOS client
     * does. The track did play, so stop() reporting its play-end at the
     * position reached is correct.
     */
    function handlePlaybackError(error: unknown): void {
        const state = get(store);
        if (!state.currentTrack || state.isLoadingTrack) return;
        const trackId = state.currentTrack.id;
        // A dead AirPlay stream session fails the load like any other error;
        // re-mint and reload in place before giving up on the track.
        void (
            error instanceof MediaPlaybackError && error.code === 3
                ? Promise.resolve(false)
                : recoverCurrentStreamAfterError()
        ).then((recovered) => {
            if (recovered) return;
            const now = get(store);
            if (now.currentTrack?.id !== trackId || now.isLoadingTrack) return;
            console.error('[MusicPlayer] playback failed mid-stream', error);
            stop();
            toasts.error(messages.music_playback_failed(), {
                diagnosticKey: 'music_playback_failed',
                diagnosticError: error,
            });
        });
    }

    function destroy(): void {
        void completeMusicSession();
        unregisterAudioParticipant?.();
        unregisterAudioParticipant = null;
        releaseAudio('music');
        endMirroring();
        if (broadcastTimer !== null) clearTimeout(broadcastTimer);
        broadcastTimer = null;
        clearVolumeCommand();
        unsubscribeLiveState?.();
        unsubscribeLiveState = null;
        if (liveStateInterval !== null) clearInterval(liveStateInterval);
        liveStateInterval = null;
        tabSync?.destroy();
        tabSync = null;
        unsubscribeSessionEnded?.();
        unsubscribeSessionEnded = null;
        airPlayDetector?.stop();
        airPlayDetector = null;
        backend?.destroy();
        backend = null;
    }

    // -------------------------------------------------------------------------
    // Playback controls
    // -------------------------------------------------------------------------

    function contextForPlayback(
        context: PlaybackContext | null,
        source: 'user' | 'smart',
        queue: QueueItem[],
    ): PlaybackContext | null {
        if (context && source === 'smart' && !queue.some((q) => q.source === 'user')) {
            toasts.info('Queue finished — Autoplay picking similar tracks');
            return null;
        }
        return context;
    }

    /** Derive analytics play context from current store state */
    function derivePlayContext(state: MusicPlayerState): string | undefined {
        if (state.autoplaySeed) return 'radio';
        if (state.playbackContext) return state.playbackContext.type; // 'artist' | 'album' | 'genre'
        return 'queue';
    }

    /**
     * @param source Provenance of the track being promoted: 'user' for an
     * explicit pick (default — external play() calls come from UI clicks),
     * 'smart' when an advance path promotes a smart-queue item. Radio-seed
     * plays (`fromSeed`) always count as 'smart' — the system chose the
     * specific track, the user only chose the mood.
     */
    async function play(
        rawTrack: MusicTrack,
        fromSeed = false,
        source: 'user' | 'smart' = 'user',
    ): Promise<void> {
        // A play() right after page load can beat the backend's async init
        // (the layout starts it on mount; a quick "Play all" click or a
        // restored tab lands first). Wait for it instead of dropping the
        // user's click with only a console error.
        if (!backend && initPromise) await initPromise;
        if (!backend) {
            console.error('Music backend not initialized');
            return;
        }

        // Take audio BEFORE loading: an audiobook holding it is stopped first,
        // so the two are never both decoding and never both reporting a
        // position to a last-write-wins upstream.
        claimAudio('music');
        claimPlayback();
        endMirroring();
        const claimEpoch = otherTabClaimEpoch;
        playbackIntentGen++;
        awaitingQueueRefill = false;
        // play() opens its own session below.
        sessionSupersededByOtherTab = false;
        store.update((s) => (s.playingElsewhere ? { ...s, playingElsewhere: false } : s));

        const track = withTrackImages(rawTrack);

        const state = get(store);

        if (state.isCrossfading) {
            // Invalidate any in-flight triggerCrossfade finalize and clear the
            // pending lock BEFORE cancelCrossfade() resolves its awaited Promise
            // (mirror pause()/seekTo() ordering), so the resolved continuation
            // can't re-report play-end for the track play() is replacing.
            crossfadeToken++;
            backend?.cancelCrossfade();
            crossfadePending = false;
        }

        if (state.autoplaySeed && !fromSeed) {
            store.update((s) => ({ ...s, autoplaySeed: null }));
        }

        const myToken = ++playLoadToken;
        store.update((s) => ({ ...s, isLoadingTrack: true }));
        try {
            await playTrackWithTokenRecovery(
                track,
                {
                    title: track.title,
                    artist: track.artists.map((artist) => artist.title).join(', '),
                    album: track.album?.title,
                    artworkUrl: trackArtworkUrl(track),
                    isRadio: track.isRadio === true,
                },
                () => myToken === playLoadToken,
            );
        } catch (err) {
            // backend.play() rejected (network error, unsupported/undecodable
            // stream, etc.). Without recovery the store would keep isPlaying:true
            // with no audio, and skip()/auto-resume have already advanced past
            // this track — stranding the user. Roll back to a stopped state and
            // tell them why. Only the latest play() call is authoritative.
            if (myToken !== playLoadToken) return;
            console.error('[MusicPlayer] backend.play() failed', err);
            // Tear down to a clean stopped state. Null out currentTrack first so
            // stop() does NOT re-report play-end for the previous track — the
            // caller (skip/auto-resume) already reported its end before invoking
            // play(). stop() still stops the backend, completes the session, and
            // resets state (preserving volume).
            store.update((s) => ({
                ...s,
                isLoadingTrack: false,
                isPlaying: false,
                currentTrack: null,
            }));
            stop();
            toasts.error(messages.music_playback_failed(), {
                diagnosticKey: 'music_playback_failed',
                diagnosticError: err,
            });
            return;
        } finally {
            if (myToken === playLoadToken) {
                store.update((s) => ({ ...s, isLoadingTrack: false }));
            }
        }

        // Apply LUFS gain for the new track
        const effectiveVolume = getPlaybackVolume(
            get(store).volume,
            track.audioFeatures?.loudnessLufs,
        );
        if (backend?.supportsVolumeControl) {
            backend.setVolume(effectiveVolume);
        }

        const durationMs = track.durationMs ?? 0;

        store.update((s) => {
            const history = historyWithOutgoing(s);
            // Remove the track from queue if it was in there (user clicked a queued item)
            const queue = s.queue.filter((q) => q.track.id !== track.id);
            return {
                ...s,
                ...TRACK_SWITCH_RESETS,
                currentTrack: track,
                currentTrackFeedback: feedbackForTrack(track),
                currentTrackSource: fromSeed ? 'smart' : source,
                playbackContext: contextForPlayback(
                    s.playbackContext,
                    fromSeed ? 'smart' : source,
                    queue,
                ),
                history,
                queue,
                isPlaying: true,
                progress: 0,
                currentTimeMs: 0,
                durationMs,
                isCrossfading: false,
                crossfadeOutgoing: null,
                pendingCrossfadeAtMs: null,
                pendingCrossfadeIsManual: false,
            };
        });

        // Capture analytics context; the shared session report counts this play.
        const updatedState = get(store);
        const playContext = derivePlayContext(updatedState);
        store.update((s) => ({
            ...s,
            playContext: playContext ?? null,
        }));

        // Start the playback session used for presence and listening history.
        void startMusicSession(track);

        void fetchNextTrack(track.id);
        void syncCurrentTrackContext(track);
        startProgressReporting();
        persistState();

        // Another tab claimed playback while this track was loading. It was
        // not playing yet, so that tab's claim could not pause it — do it now,
        // or both tabs end up playing.
        if (otherTabClaimEpoch !== claimEpoch && myToken === playLoadToken) pause();
    }

    function hasCompleteTrackMetadata(track: MusicTrack): boolean {
        const af = track.audioFeatures;
        return Boolean(
            track.album &&
            track.artists.some((artist) => artist.id) &&
            track.durationMs &&
            af &&
            af.downbeats &&
            af.downbeats.length > 0,
        );
    }

    /**
     * Fetch track detail from the server and apply it to matching items in
     * the store. For the current track we also apply user context (feedback)
     * — see `syncCurrentTrackContext`. For queue items we skip the fetch
     * when metadata is already complete (see `enrichQueueTrackMetadata`).
     */
    async function fetchAndApplyTrackPatch(
        track: MusicTrack,
        opts: { applyUserContext: boolean },
    ): Promise<void> {
        try {
            const { getTrack } = await import('$lib/api/music');
            const result = await getTrack(track.id);
            const patch = result.data?.track;
            const userContext = result.data?.userContext;
            if (!patch) return;
            const current = get(store).currentTrack;
            const loudnessBefore =
                current?.id === track.id ? current.audioFeatures?.loudnessLufs : undefined;
            store.update((s) => ({
                ...s,
                currentTrack:
                    s.currentTrack?.id === track.id
                        ? { ...s.currentTrack, ...patch }
                        : s.currentTrack,
                currentTrackFeedback:
                    opts.applyUserContext && s.currentTrack?.id === track.id && userContext
                        ? userContext.feedback
                        : s.currentTrackFeedback,
                queue: s.queue.map((q) =>
                    q.track.id === track.id ? { ...q, track: { ...q.track, ...patch } } : q,
                ),
            }));
            reapplyLoudnessIfChanged(track.id, loudnessBefore);
        } catch (e) {
            console.warn('[MusicPlayer] Failed to fetch track detail', e);
        }
    }

    /**
     * Re-apply loudness normalization when the current track's `loudnessLufs`
     * arrived (or changed) after playback started. Entry points that build a
     * track without it would otherwise play un-normalized until the fade-out,
     * where the crossfade computes the normalized level and steps to it.
     * Mid-fade the post-fade re-sync applies it instead; muted stays muted.
     */
    function reapplyLoudnessIfChanged(trackId: string, loudnessBefore: number | undefined): void {
        const s = get(store);
        if (s.currentTrack?.id !== trackId || !s.loudnessNormalizationEnabled) return;
        const loudness = s.currentTrack.audioFeatures?.loudnessLufs;
        if (loudness === undefined || loudness === loudnessBefore) return;
        if (!backend?.supportsVolumeControl || s.isMuted || s.isCrossfading) return;
        backend.setVolume(getPlaybackVolume(s.volume, loudness));
    }

    /**
     * Sync the current track from the server: metadata + user feedback.
     * Always hits the server (feedback must refresh on every track change,
     * even when metadata is already complete client-side).
     */
    async function syncCurrentTrackContext(track: MusicTrack): Promise<void> {
        await fetchAndApplyTrackPatch(track, { applyUserContext: true });
    }

    /**
     * Enrich a queue item's metadata from the server. Early-returns when the
     * client already has full metadata — used for persisted queue items where
     * we otherwise fire N fetches on every hydrate.
     */
    async function enrichQueueTrackMetadata(track: MusicTrack): Promise<void> {
        if (hasCompleteTrackMetadata(track)) return;
        await fetchAndApplyTrackPatch(track, { applyUserContext: false });
    }

    function pause(): void {
        playbackIntentGen++;
        awaitingQueueRefill = false;
        const state = get(store);

        if (state.isCrossfading) {
            // Immediately finalize the crossfade and pause on the incoming track.
            // The incoming track is already currentTrack (promoted at fade start,
            // where play-end reporting and the session transition happened).
            // cancelCrossfade swaps the active deck and resolves the pending Promise.
            // We must clear isCrossfading BEFORE the resolved Promise triggers the
            // triggerCrossfade continuation — it checks isCrossfading to detect cancel.
            // Bump the crossfade token too so the continuation bails even if a later
            // path resets isCrossfading before it runs.
            crossfadeToken++;
            backend?.cancelCrossfade();
            crossfadePending = false;

            // Pause the backend after cancelling crossfade
            backend?.pause();

            // cancelCrossfade left the incoming deck at the backend's remembered
            // volume (still LUFS-adjusted for the outgoing track) — re-apply the
            // current track's normalization so resume plays at the right level.
            if (backend?.supportsVolumeControl && !state.isMuted) {
                backend.setVolume(
                    getPlaybackVolume(
                        state.volume,
                        state.currentTrack?.audioFeatures?.loudnessLufs,
                    ),
                );
            }

            // Reconcile the store clock with wherever the fade left the deck.
            const actualMs = backend?.getCurrentTimeMs() ?? state.currentTimeMs;
            const reconciledMs =
                Number.isFinite(actualMs) && actualMs >= 0 ? actualMs : state.currentTimeMs;

            store.update((s) => ({
                ...s,
                isCrossfading: false,
                crossfadeProgress: 0,
                crossfadeOutgoing: null,
                crossfadeCurrentBeat: 0,
                crossfadeTotalBeats: 0,
                isPlaying: false,
                currentTimeMs: reconciledMs,
                progress: s.durationMs > 0 ? reconciledMs / s.durationMs : 0,
                normalizingTargetBpm: null,
            }));
        } else {
            backend?.pause();
            store.update((s) => ({ ...s, isPlaying: false }));
            heartbeatMusicSession(get(store).currentTimeMs, true);
        }

        stopProgressReporting();
        persistState();
        tabSync?.announceIdle();
    }

    // -------------------------------------------------------------------------
    // Live state across tabs (music-tab-sync.ts)
    // -------------------------------------------------------------------------

    function liveState(): MusicTabLiveState {
        const s = get(store);
        const last = lastBroadcast;
        return {
            track: s.currentTrack,
            // The heavy lists ride along only when they changed: a position
            // tick every 3s must not clone the whole queue each time.
            queue: needFullBroadcast || !last || s.queue !== lastQueue ? s.queue : undefined,
            history:
                needFullBroadcast || !last || s.history !== lastHistory ? s.history : undefined,
            playbackContext: s.playbackContext,
            autoplaySeed: s.autoplaySeed,
            positionMs: Math.round(s.currentTimeMs),
            durationMs: s.durationMs,
            isPlaying: s.isPlaying,
            volume: s.volume,
            isMuted: s.isMuted,
            sentAt: Date.now(),
        };
    }

    let lastBroadcast: MusicTabLiveState | null = null;
    /** The next state carries the full lists (see claimPlayback). */
    let needFullBroadcast = false;
    /** Position ticks since the last full state; every Nth one is full. */
    let ticksSinceFull = 0;
    const FULL_STATE_EVERY_TICKS = 5;
    let lastQueue: QueueItem[] | null = null;
    let lastHistory: MusicTrack[] | null = null;
    let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
    let lastBroadcastAt = 0;
    /** At most one state per this interval; a burst (volume drag) collapses. */
    const BROADCAST_MIN_GAP_MS = 150;

    /**
     * Claim playback across tabs. The first state after a claim carries the
     * full queue and history: a tab that dropped earlier states (closed with
     * X, taking over, a newer local action) would otherwise keep stale lists
     * until the next queue change.
     */
    function claimPlayback(): void {
        tabSync?.announcePlaying();
        needFullBroadcast = true;
        // Playing here ends a dismissal: once another tab takes over from
        // this one, this tab shows it again.
        mirrorDismissed = false;
        dismissedOwnerTabId = null;
    }

    /** Send the live state; a no-op unless this tab holds the newest claim. */
    function broadcastLiveState(full = false): void {
        if (!tabSync || mirroring) return;
        const s = get(store);
        if (full) needFullBroadcast = true;
        lastBroadcast = liveState();
        needFullBroadcast = false;
        lastQueue = s.queue;
        lastHistory = s.history;
        lastBroadcastAt = Date.now();
        tabSync.broadcastState(lastBroadcast, lastBroadcast.isPlaying);
    }

    /** Throttled broadcast for change-driven sends (trailing edge). */
    function scheduleBroadcast(): void {
        if (broadcastTimer !== null) return;
        const wait = Math.max(0, BROADCAST_MIN_GAP_MS - (Date.now() - lastBroadcastAt));
        broadcastTimer = setTimeout(() => {
            broadcastTimer = null;
            broadcastLiveState();
        }, wait);
    }

    /**
     * Broadcast on every change another tab would show — track, queue, play
     * state, a seek — and every few seconds while playing. The store emits on
     * each timeupdate, so the checks here are cheap reference/number compares.
     */
    function startLiveStateBroadcast(): void {
        unsubscribeLiveState?.();
        unsubscribeLiveState = store.subscribe((s) => {
            const last = lastBroadcast;
            if (!last) return;
            const expectedMs = last.isPlaying
                ? last.positionMs + (Date.now() - last.sentAt)
                : last.positionMs;
            if (
                s.currentTrack?.id !== last.track?.id ||
                s.queue !== lastQueue ||
                s.isPlaying !== last.isPlaying ||
                s.history !== lastHistory ||
                s.volume !== last.volume ||
                s.isMuted !== last.isMuted ||
                Math.abs(s.currentTimeMs - expectedMs) > 2_500
            ) {
                // Coalesce bursts (one action's several updates, a volume
                // drag) into one message.
                scheduleBroadcast();
            }
        });
        if (liveStateInterval !== null) clearInterval(liveStateInterval);
        liveStateInterval = setInterval(() => {
            if (!get(store).isPlaying) return;
            // Every Nth tick is full, so a mirror that missed the lists
            // (dropped a state) catches up within ~15s regardless.
            ticksSinceFull = (ticksSinceFull + 1) % FULL_STATE_EVERY_TICKS;
            broadcastLiveState(ticksSinceFull === 0);
        }, LIVE_STATE_INTERVAL_MS);
        broadcastLiveState();
    }

    /** Show the owner's live state here (this tab is not playing). */
    function applyOwnerState(live: MusicTabLiveState): void {
        if (get(store).isPlaying) return;
        // Closed here with X: stay closed until another tab starts playing.
        if (mirrorDismissed) return;
        // Taking over: the other tab's state must not re-show "playing
        // elsewhere" (and a Pause) mid-hand-off, nor swap the track.
        if (takingOver > 0) return;
        // Sent before this tab's own optimistic action (seek, pause, volume)
        // reached the owner: applying it would snap that action back.
        if (live.sentAt < lastLocalActionAt && Date.now() - lastLocalActionAt < 2_000) return;
        lastOwnerStateAt = Date.now();
        if (!mirroring) {
            mirroring = true;
            mirroredLoadedTrackId = get(store).currentTrack?.id ?? null;
        }
        const positionMs = live.isPlaying
            ? live.positionMs + Math.max(0, Date.now() - live.sentAt)
            : live.positionMs;
        mirrorAnchor = {
            positionMs: live.positionMs,
            sentAt: live.sentAt,
            isPlaying: live.isPlaying,
        };
        store.update((s) => ({
            ...s,
            currentTrack: live.track,
            queue: live.queue ?? s.queue,
            history: live.history ?? s.history,
            playbackContext: live.playbackContext,
            autoplaySeed: live.autoplaySeed,
            durationMs: live.durationMs,
            // Shown, and carried over when playback moves here; this tab's
            // own (silent) deck is aligned when it takes over (endMirroring).
            volume: live.volume,
            isMuted: live.isMuted,
            currentTimeMs: Math.min(positionMs, live.durationMs || positionMs),
            progress: live.durationMs > 0 ? Math.min(1, positionMs / live.durationMs) : 0,
            playingElsewhere: live.isPlaying ? true : s.playingElsewhere,
        }));
        if (live.isPlaying) startMirrorTicker();
        else stopMirrorTicker();
    }

    /** Keep the mirrored position moving between states. */
    function startMirrorTicker(): void {
        if (mirrorTicker !== null) return;
        mirrorTicker = setInterval(() => {
            const anchor = mirrorAnchor;
            if (!mirroring || !anchor?.isPlaying) {
                stopMirrorTicker();
                return;
            }
            const pos = anchor.positionMs + (Date.now() - anchor.sentAt);
            store.update((s) => {
                const ms = s.durationMs > 0 ? Math.min(pos, s.durationMs) : pos;
                return {
                    ...s,
                    currentTimeMs: ms,
                    progress: s.durationMs > 0 ? ms / s.durationMs : 0,
                };
            });
        }, MIRROR_TICK_MS);
    }

    function stopMirrorTicker(): void {
        if (mirrorTicker !== null) clearInterval(mirrorTicker);
        mirrorTicker = null;
    }

    /**
     * The seek bar's seek. In a tab that only mirrors another tab's playback,
     * seeking HERE would move a paused deck nobody hears, and the next mirror
     * tick would snap the bar back — so it steers the playing tab instead,
     * and the bar stays where the listener dropped it.
     */
    function userSeekTo(ms: number): void {
        const track = get(store).currentTrack;
        if (
            mirroring &&
            track &&
            tabSync?.sendCommand({ type: 'seek', trackId: track.id, positionMs: ms })
        ) {
            lastLocalActionAt = Date.now();
            mirrorAnchor = {
                positionMs: ms,
                sentAt: Date.now(),
                isPlaying: mirrorAnchor?.isPlaying ?? false,
            };
            store.update((s) => ({
                ...s,
                currentTimeMs: ms,
                progress: s.durationMs > 0 ? ms / s.durationMs : 0,
            }));
            return;
        }
        seekTo(ms);
    }

    /** The pause button: in a mirroring tab, pause the music where it plays. */
    function userPause(): void {
        const s = get(store);
        if (!s.isPlaying && s.playingElsewhere && tabSync?.sendCommand({ type: 'pause' })) {
            lastLocalActionAt = Date.now();
            // Optimistic; the owner's 'idle' and next state confirm it.
            if (mirrorAnchor) mirrorAnchor = { ...mirrorAnchor, isPlaying: false };
            stopMirrorTicker();
            store.update((st) => ({ ...st, playingElsewhere: false }));
            return;
        }
        pause();
    }

    /** The volume slider: in a mirroring tab, set the playing tab's volume. */
    function userSetVolume(vol: number): void {
        const v = Math.max(0, Math.min(1, vol));
        if (mirroring && tabSync && !tabSync.ownsSnapshot()) {
            // A slider drag fires on every input: send the latest value at
            // most every 100ms (trailing), not one command per pixel.
            lastLocalActionAt = Date.now();
            store.update((s) => ({ ...s, volume: v, isMuted: v === 0 }));
            pendingVolume = v;
            if (volumeCommandTimer === null) {
                volumeCommandTimer = setTimeout(() => {
                    volumeCommandTimer = null;
                    const next = pendingVolume;
                    pendingVolume = null;
                    if (next !== null) tabSync?.sendCommand({ type: 'volume', volume: next });
                }, 100);
            }
            return;
        }
        setVolume(vol);
    }

    /** The mute button: in a mirroring tab, mute the playing tab. */
    function userToggleMute(): void {
        const muted = !get(store).isMuted;
        if (mirroring && tabSync?.sendCommand({ type: 'mute', muted })) {
            lastLocalActionAt = Date.now();
            store.update((s) => ({ ...s, isMuted: muted }));
            return;
        }
        toggleMute();
    }

    /**
     * A queue edit in a tab that mirrors another is an edit of THE queue —
     * the one playing. Apply it here (instant feedback), then hand the whole
     * edited queue to the owner; without this the owner's next state replaced
     * the local edit and it silently vanished.
     */
    function withQueueSync(
        edit: () => void,
        op: Omit<Extract<MusicTabCommand, { type: 'queue-op' }>, 'type'>,
    ): void {
        edit();
        if (mirroring && tabSync && !tabSync.ownsSnapshot()) {
            lastLocalActionAt = Date.now();
            tabSync.sendCommand({ type: 'queue-op', ...op });
        }
    }

    /** Drop a pending (throttled) volume command — its target has changed. */
    function clearVolumeCommand(): void {
        if (volumeCommandTimer !== null) clearTimeout(volumeCommandTimer);
        volumeCommandTimer = null;
        pendingVolume = null;
    }

    /** The skip button: in a mirroring tab, skip where the music plays. */
    async function userSkip(): Promise<void> {
        if (mirroring && tabSync?.sendCommand({ type: 'skip' })) {
            lastLocalActionAt = Date.now();
            return;
        }
        await skip();
    }

    /** The previous button: in a mirroring tab, go back where the music plays. */
    async function userPrevious(): Promise<void> {
        if (mirroring && tabSync?.sendCommand({ type: 'previous' })) {
            lastLocalActionAt = Date.now();
            return;
        }
        await previous();
    }

    /** Apply a mirroring tab's queue edit to THIS (the owner's) queue. */
    function applyQueueOp(command: Extract<MusicTabCommand, { type: 'queue-op' }>): void {
        const track = command.track as MusicTrack | undefined;
        const validTrack = !!track && typeof track.id === 'string';
        switch (command.op) {
            case 'add':
                if (validTrack) addToQueue(track, command.sessionId);
                break;
            case 'add-front':
                if (validTrack) addToQueueFront(track);
                break;
            case 'remove':
                if (typeof command.id === 'string') removeFromQueue(command.id);
                break;
            case 'order': {
                if (!Array.isArray(command.ids)) return;
                // Re-order what the owner HAS: items the mirror did not know
                // (smart-queue refills since) keep their relative order after.
                const queue = get(store).queue;
                const byId = new Map(queue.map((q) => [q.id, q]));
                const ordered = command.ids
                    .map((id) => byId.get(id))
                    .filter((q): q is QueueItem => q !== undefined);
                const seen = new Set(ordered.map((q) => q.id));
                reorderQueue([...ordered, ...queue.filter((q) => !seen.has(q.id))]);
                break;
            }
        }
    }

    /** This tab takes over (plays, resumes, stops): stop showing the owner's. */
    function endMirroring(): void {
        clearVolumeCommand();
        const wasMirroring = mirroring;
        mirroring = false;
        mirrorAnchor = null;
        stopMirrorTicker();
        if (wasMirroring && backend) {
            // The mirrored volume/mute becomes this tab's; align its deck,
            // which was never touched while it only mirrored.
            const s = get(store);
            if (s.isMuted) backend.mute();
            else if (backend.supportsVolumeControl) {
                backend.unmute(s.volume > 0 ? s.volume : 0.8);
                backend.setVolume(
                    getPlaybackVolume(s.volume, s.currentTrack?.audioFeatures?.loudnessLufs),
                );
            }
        }
    }

    /**
     * Resume in a tab that is not the one that played last: continue from the
     * live position of the tab that did (or, if it is gone, from the shared
     * snapshot) instead of this tab's stale one — moving playback between
     * tabs should pick the song up where it was, not replay a chunk of it.
     */
    async function resumeFromOtherTab(sync: MusicTabSync<MusicTabLiveState>): Promise<void> {
        const trackId = get(store).currentTrack?.id;
        // Taking over starts now: from here the transport buttons act on THIS
        // tab (a pause during the owner query cancels the take-over rather
        // than pausing the other tab).
        store.update((s) => (s.playingElsewhere ? { ...s, playingElsewhere: false } : s));
        // A volume drag still waiting to be sent belongs to THIS tab now (it
        // is in the store; endMirroring puts it on this deck) — not to the tab
        // being taken over from.
        clearVolumeCommand();
        const intent = ++playbackIntentGen;
        const claimEpoch = otherTabClaimEpoch;
        takingOver++;
        let owner: Awaited<ReturnType<typeof sync.queryOwner>>;
        try {
            owner = await sync.queryOwner();
        } finally {
            takingOver--;
        }
        // A pause, stop, new track or another tab's claim during the query
        // supersedes this resume.
        if (intent !== playbackIntentGen || claimEpoch !== otherTabClaimEpoch) return;
        // The owner moved to another track inside the query window (the state
        // announcing it was ignored while taking over): continue ITS track.
        const ownerTrack = owner?.track as MusicTrack | undefined;
        if (owner && owner.trackId !== trackId && ownerTrack && typeof ownerTrack.id === 'string') {
            const durationMs = ownerTrack.durationMs ?? 0;
            store.update((s) => ({ ...s, currentTrack: ownerTrack, durationMs }));
            await resumeMirroredTrack(ownerTrack, owner.positionMs);
            return;
        }
        let liveMs: number | null = null;
        if (owner) {
            if (owner.trackId === trackId) liveMs = owner.positionMs;
        } else if (mirroring) {
            // No owner left. The position shown here is the newest this tab
            // knows (it includes a seek made here after the owner closed).
            liveMs = get(store).currentTimeMs;
        } else {
            // A tab that never mirrored falls back to the shared snapshot.
            const snapshot = loadPlaybackState();
            if (snapshot && snapshot.currentTrack?.id === trackId) liveMs = snapshot.position;
        }
        if (get(store).currentTrack?.id !== trackId) return;
        // The owner moved on to another track while this tab mirrored it: the
        // backend here still holds the old one, so load the shown track.
        const shown = get(store).currentTrack;
        if (mirroring && shown && shown.id !== mirroredLoadedTrackId) {
            await resumeMirroredTrack(shown, liveMs ?? get(store).currentTimeMs);
            return;
        }
        // Compare with where THIS tab's deck actually is — not the store's
        // time, which mirroring kept in step with the other tab while the
        // deck sat at its own old pause point. Comparing with the store made
        // the seek look unnecessary, and the hand-off resumed from the old
        // point (found on preprod: 0:14 → resumed at 0:08).
        const deckMs = backend?.getCurrentTimeMs() ?? get(store).currentTimeMs;
        if (liveMs !== null && Math.abs(liveMs - deckMs) > 1000) {
            seekTo(liveMs);
        }
        resumeHere();
    }

    function resume(): void {
        // Also while mirroring an owner that has since closed: the track shown
        // may not be the one this tab's player holds.
        if (tabSync && (!tabSync.ownsSnapshot() || mirroring) && get(store).currentTrack) {
            void resumeFromOtherTab(tabSync);
            return;
        }
        resumeHere();
    }

    /**
     * Continue, in this tab, a track the owner switched to while this tab was
     * only mirroring it. Loaded at the live position like a restore
     * (hydrateFromPersistence) — not play(), which would start it from 0 and
     * count a fresh play start for a track already being listened to.
     */
    async function resumeMirroredTrack(track: MusicTrack, positionMs: number): Promise<void> {
        claimAudio('music');
        claimPlayback();
        endMirroring();
        const intent = ++playbackIntentGen;
        const claimEpoch = otherTabClaimEpoch;
        store.update((s) => ({ ...s, isPlaying: true, playingElsewhere: false }));
        const result = await backend?.preload(
            await trackStreamUrl(track),
            {
                title: track.title,
                artist: track.artists.map((artist) => artist.title).join(', '),
                album: track.album?.title,
                artworkUrl: trackArtworkUrl(track),
            },
            positionMs,
            getPlaybackVolume(get(store).volume, track.audioFeatures?.loudnessLufs),
            true,
        );
        if (!result?.resumed) {
            store.update((s) => ({ ...s, isPlaying: false }));
            tabSync?.announceIdle();
            return;
        }
        if (intent !== playbackIntentGen || claimEpoch !== otherTabClaimEpoch) {
            // Paused, stopped or claimed elsewhere while loading.
            backend?.pause();
            return;
        }
        sessionSupersededByOtherTab = false;
        musicSessionId = null;
        void startMusicSession(track);
        startProgressReporting();
        void fetchNextTrack(track.id);
        void syncCurrentTrackContext(track);
        persistState();
    }

    function resumeHere(): void {
        endMirroring();
        // Unpausing is a claim too. Without it, tapping play on the paused music
        // mini-player while an audiobook is running leaves the arbiter believing
        // the audiobook still owns audio — and both decode, and both report a
        // position upstream.
        claimAudio('music');
        claimPlayback();
        backend?.resume();
        store.update((s) => ({ ...s, isPlaying: true, playingElsewhere: false }));
        const resumedTrack = get(store).currentTrack;
        if (resumedTrack && (sessionSupersededByOtherTab || !listeningSession)) {
            // Superseded by another tab (see sessionSupersededByOtherTab), or
            // never had one (a restored tab): open a fresh session.
            const needsFreshStart = sessionSupersededByOtherTab;
            sessionSupersededByOtherTab = false;
            musicSessionId = null;
            if (needsFreshStart) {
                grantDisposers.get(resumedTrack.id)?.();
                grantDisposers.delete(resumedTrack.id);
                musicStarts.delete(resumedTrack.id);
            }
            const intent = playbackIntentGen;
            void trackStreamUrl(resumedTrack)
                .then(async (href) => {
                    if (
                        intent !== playbackIntentGen ||
                        get(store).currentTrack?.id !== resumedTrack.id
                    )
                        return;
                    await startMusicSession(resumedTrack);
                    if (needsFreshStart)
                        await backend?.reloadCurrentSrc(href, {
                            positionMs: get(store).currentTimeMs,
                            resume: true,
                        });
                })
                .catch((err: unknown) => {
                    stop();
                    toasts.error(messages.music_playback_failed(), {
                        diagnosticKey: 'music_playback_failed',
                        diagnosticError: err,
                    });
                });
        } else {
            heartbeatMusicSession(get(store).currentTimeMs, false);
        }
        if (get(store).currentTrack) startProgressReporting();
    }

    async function skip(): Promise<void> {
        if (isSkipping) {
            // A skip is already running; drop any pending dislike-suppression
            // flag so it can't leak onto an unrelated future skip.
            suppressNextSkipReport = false;
            return;
        }
        isSkipping = true;
        // Consume the dislike-path suppression flag exactly once. When set, the
        // caller (dislikeCurrentTrack) has already recorded the negative signal;
        // we must NOT also fire the implicit skip-rating writes below.
        const suppressSkipReport = suppressNextSkipReport;
        suppressNextSkipReport = false;
        try {
            // If a crossfade is in flight, cancel it and clear the pending lock
            // SYNCHRONOUSLY before any await below (mirror pause()/seekTo()
            // ordering). cancelCrossfade() resolves triggerCrossfade's awaited
            // Promise; clearing crossfadePending + isCrossfading here, plus the
            // monotonic crossfade token, ensures triggerCrossfade's finalize
            // block sees a cancelled state and does NOT re-report play-end /
            // record-completed-listen for the track skip() is handling.
            if (get(store).isCrossfading) {
                crossfadeToken++;
                backend?.cancelCrossfade();
                crossfadePending = false;
                store.update((s) => ({
                    ...s,
                    isCrossfading: false,
                    crossfadeProgress: 0,
                    crossfadeOutgoing: null,
                    crossfadeCurrentBeat: 0,
                    crossfadeTotalBeats: 0,
                }));
            }

            const state = get(store);

            if (state.currentTrack) {
                if (!suppressSkipReport) {
                    store.update((s) => ({
                        ...s,
                        skippedTrackIds: [...s.skippedTrackIds, state.currentTrack!.id],
                    }));
                }
                void completeMusicSession(suppressSkipReport ? 'user' : 'skip');
            }

            const nextItem = state.queue[0];
            const nextTrack = nextItem?.track;
            if (!nextTrack) {
                if (state.autoplayEnabled && state.smartQueueLoading) {
                    // Queue fetch in-flight — stop the backend but don't tear
                    // down the player. fetchNextTrack's auto-resume will play
                    // the next track once the fetch completes.
                    backend?.stop();
                    store.update((s) => ({ ...s, isPlaying: false }));
                    return;
                }
                stop();
                return;
            }

            store.update((s) => ({ ...s, queue: s.queue.slice(1) }));

            await play(nextTrack, Boolean(state.autoplaySeed), nextItem.source);
        } finally {
            isSkipping = false;
        }
    }

    async function previous(): Promise<void> {
        const state = get(store);

        if (state.currentTimeMs > 3000) {
            seekTo(0);
            return;
        }
        const prev = state.history[0];
        if (!prev) {
            seekTo(0);
            return;
        }
        store.update((s) => ({
            ...s,
            queue: s.currentTrack
                ? [
                      {
                          track: s.currentTrack,
                          source: 'user' as const,
                          id: s.currentTrack.id,
                      },
                      ...s.queue,
                  ]
                : s.queue,
            history: s.history.slice(1),
            currentTrack: null,
        }));
        await play(prev);
    }

    function seekTo(ms: number): void {
        const state = get(store);

        if (state.isCrossfading) {
            // The incoming track was already promoted to currentTrack at fade
            // start, and the seek bar shows ITS timeline — so a seek during the
            // fade means "jump within the incoming track". Cancel the fade
            // (cancelCrossfade promotes the incoming deck) and seek that deck.
            //
            // Bump the token + clear the pending lock before cancelCrossfade()
            // resolves triggerCrossfade's awaited Promise, so its completion
            // block bails and doesn't re-finalize the fade.
            crossfadeToken++;
            backend?.cancelCrossfade();
            crossfadePending = false;

            // Clamp into the current (incoming) track's playable range so a
            // stale/oversized position can never land at/past its end
            // (instant track-end). Unknown duration (0): don't force 0 — that
            // would silently discard every mid-fade seek; pass the position
            // through like the generic (non-crossfade) seek path does.
            const SEEK_END_EPSILON_MS = 1_000;
            const durationMs = state.durationMs;
            const targetMs =
                durationMs > 0
                    ? Math.max(0, Math.min(ms, Math.max(0, durationMs - SEEK_END_EPSILON_MS)))
                    : Math.max(0, ms);

            // cancelCrossfade left the incoming deck at the backend's remembered
            // volume (still LUFS-adjusted for the outgoing track) — re-apply the
            // current track's normalization. Skipped while muted (setVolume
            // would clear the mute).
            if (backend?.supportsVolumeControl && !state.isMuted) {
                backend.setVolume(
                    getPlaybackVolume(
                        state.volume,
                        state.currentTrack?.audioFeatures?.loudnessLufs,
                    ),
                );
            }

            store.update((s) => ({
                ...s,
                isCrossfading: false,
                crossfadeProgress: 0,
                crossfadeOutgoing: null,
                crossfadeCurrentBeat: 0,
                crossfadeTotalBeats: 0,
                currentTimeMs: targetMs,
                progress: durationMs > 0 ? targetMs / durationMs : 0,
                hasSeeked: true,
                normalizingTargetBpm: null,
                // A manual mix (hold-to-mix) was armed against the pre-seek
                // position; the user's seek supersedes it, so drop it rather
                // than leave a stale "Mixing on the beat…" hint pulsing or
                // fire an un-quantized fade the moment playback crosses the
                // now-meaningless snap point. Auto pendings keep their
                // existing (untouched) seek semantics.
                pendingCrossfadeAtMs: s.pendingCrossfadeIsManual ? null : s.pendingCrossfadeAtMs,
                pendingCrossfadeForTrackId: s.pendingCrossfadeIsManual
                    ? null
                    : s.pendingCrossfadeForTrackId,
                pendingCrossfadeIsManual: false,
            }));

            backend?.seekTo(targetMs);
            resetListeningPosition(targetMs);
            heartbeatMusicSession(targetMs, !get(store).isPlaying);
            return;
        }

        backend?.seekTo(ms);
        const durationMs = get(store).durationMs;
        store.update((s) => ({
            ...s,
            currentTimeMs: ms,
            progress: durationMs > 0 ? ms / durationMs : s.progress,
            hasSeeked: true,
            // See the crossfading branch above: a manual mix was armed
            // against the pre-seek position; the user's seek supersedes it.
            // Auto pendings keep their existing (untouched) seek semantics.
            pendingCrossfadeAtMs: s.pendingCrossfadeIsManual ? null : s.pendingCrossfadeAtMs,
            pendingCrossfadeForTrackId: s.pendingCrossfadeIsManual
                ? null
                : s.pendingCrossfadeForTrackId,
            pendingCrossfadeIsManual: false,
        }));
        resetListeningPosition(ms);
        heartbeatMusicSession(ms, !get(store).isPlaying);
    }

    function setVolume(vol: number): void {
        const v = Math.max(0, Math.min(1, vol));
        // Re-apply the current track's LUFS gain on top of the user volume —
        // play() does this for the new-track case, but a mid-track volume change
        // must keep the same per-track normalization or loudness jumps.
        const effectiveVolume = getPlaybackVolume(
            v,
            get(store).currentTrack?.audioFeatures?.loudnessLufs,
        );
        backend?.setVolume(effectiveVolume);
        store.update((s) => ({ ...s, volume: v, isMuted: v === 0 }));
        persistState();
    }

    function toggleMute(): void {
        const state = get(store);
        if (state.isMuted) {
            const restoreVol = state.volume > 0 ? state.volume : 0.8;
            // unmute() restores raw volume; immediately re-apply LUFS gain so the
            // track returns to its normalized level rather than its raw volume.
            backend?.unmute(restoreVol);
            const effectiveVolume = getPlaybackVolume(
                restoreVol,
                state.currentTrack?.audioFeatures?.loudnessLufs,
            );
            if (backend?.supportsVolumeControl) {
                backend.setVolume(effectiveVolume);
            }
            store.update((s) => ({ ...s, isMuted: false, volume: restoreVol }));
        } else {
            backend?.mute();
            store.update((s) => ({ ...s, isMuted: true }));
        }
        persistState();
    }

    /**
     * Stop playback and reset the in-memory player state.
     *
     * @param clearPersistence - When true, also wipes the persisted snapshot
     *   in localStorage so the mini-player will not be restored on refresh.
     *   Pass true only for user-explicit close actions (X button). Leave false
     *   for auto-stop paths (watch-page takeover, hardware media-session stop,
     *   end-of-queue) so the session can be recovered by a later refresh or
     *   when the user returns to a page that mounts the mini-player.
     */
    function stop(clearPersistence = false): void {
        const wasMirroring = mirroring;
        // Closing the player here while another tab plays: stay closed until
        // the next claim, instead of reappearing with that tab's next state.
        if (wasMirroring && clearPersistence) {
            mirrorDismissed = true;
            dismissedOwnerTabId = tabSync?.ownerTabId() ?? null;
        }
        endMirroring();
        playbackIntentGen++;
        awaitingQueueRefill = false;
        // Report play end for current track if playing. Not for a track this
        // tab only mirrored: the tab that plays it reports its own end, and
        // a second report here would count the listen twice.
        if (!wasMirroring) void completeMusicSession('user');

        releaseAudio('music');
        tabSync?.announceIdle();
        backend?.stop();
        stopProgressReporting();
        const current = get(store);
        const kept = Object.fromEntries(
            STATE_KEPT_ACROSS_STOP.map((key) => [key, current[key]]),
        ) as Pick<MusicPlayerState, (typeof STATE_KEPT_ACROSS_STOP)[number]>;
        store.set({
            ...INITIAL_STATE,
            ...kept,
            // The backend outlives stop() and init() returns early for it, so
            // nothing re-applies its capabilities. INITIAL_STATE says
            // supportsCrossfade: true — on iOS that armed fades after the
            // player was closed once, and PlainAudioBackend's triggerCrossfade
            // is an instant switch, so songs were cut where the fade would have
            // started. Before init has a backend, initBackend sets them.
            supportsVolumeControl: backend?.supportsVolumeControl ?? current.supportsVolumeControl,
            supportsCrossfade: backend?.supportsCrossfade ?? current.supportsCrossfade,
        });
        // A tab that does not own the snapshot must not wipe it: closing the
        // player in a paused background tab would otherwise erase the session
        // another tab is playing.
        if (clearPersistence && (tabSync?.ownsSnapshot() ?? true)) {
            clearPlaybackState();
        }
        // Logout and closing the player: the library-wide token must not
        // outlive the session that minted it (a later user of this tab).
        clearMusicStreamToken();
    }

    // -------------------------------------------------------------------------
    // Crossfade
    // -------------------------------------------------------------------------

    async function triggerCrossfade(): Promise<void> {
        if (crossfadePending) return;
        crossfadePending = true;

        // Claim a token for this crossfade. If any cancel path (skip/play/pause/
        // seek/AirPlay) bumps crossfadeToken while we await the backend, the
        // finalize block below detects the change and bails — preventing a
        // double play-end report for the outgoing track.
        const myCrossfadeToken = ++crossfadeToken;

        const state = get(store);
        const nextItem = state.queue[0];
        const nextTrack = nextItem?.track;
        if (!nextTrack || !backend) {
            crossfadePending = false;
            return;
        }

        // A fade cancelled by a path that left crossfadeProgress behind must
        // not start this one half done (the lyrics panel reads it).
        store.update((s) => ({ ...s, isCrossfading: true, crossfadeProgress: 0 }));

        const outBpm = state.currentTrack?.audioFeatures?.bpm;
        const inBpm = nextTrack.audioFeatures?.bpm;

        // Smart crossfade style detection
        const channelMood =
            state.autoplaySeed?.type === 'mood'
                ? state.autoplaySeed.mood?.toLowerCase()
                : undefined;
        const crossfadeStyle = determineCrossfadeStyle(
            state.currentTrack?.audioFeatures,
            nextTrack.audioFeatures,
            channelMood,
        );

        // Smart fades scale with track length (mirrors checkCrossfadeTrigger);
        // a manual beat override is used verbatim.
        const styleBeats = scaleCrossfadeBeatsForTrackLength(
            crossfadeStyle.beats,
            crossfadeStyle.fadeMode,
            backend.getDurationMs() / 1000,
            nextTrack.durationMs == null ? undefined : nextTrack.durationMs / 1000,
        );
        let beats = state.crossfadeBeatsOverride ?? styleBeats;
        // Mutable: the effective fade mode can downgrade from bass-swap to the
        // default blend below if there isn't enough remaining audio for a
        // minimum-length bass-swap (clampBassSwapBeats returns 0).
        let fadeMode: 'blend' | 'cut' | 'filter' | 'echo' | 'bassswap' =
            state.crossfadeBeatsOverride ? 'blend' : crossfadeStyle.fadeMode;
        // Organic material: plain equal-power blend at natural tempo — no BPM
        // rate-matching, no beat alignment, no incoming intro seek. Applied by
        // omitting the corresponding option fields below (the engine only
        // rate-matches when BOTH bpms are present, and only seeks/aligns when
        // beat data is supplied).
        const plainTransition = crossfadeStyle.plainTransition === true;

        // For bass-swap: adapt beat count to remaining track time.
        // Same logic as checkCrossfadeTrigger — ensures the crossfade
        // fits within the remaining audio even if triggered early.
        const bpmForCalc = outBpm ?? inBpm ?? 0;
        if (fadeMode === 'bassswap' && !state.crossfadeBeatsOverride && bpmForCalc > 0 && backend) {
            const remainingMs = backend.getDurationMs() - backend.getCurrentTimeMs();
            const clampedBeats = clampBassSwapBeats(beats, remainingMs, bpmForCalc);
            if (clampedBeats === 0) {
                // Sentinel: not enough remaining audio for even a minimum
                // (16-beat) bass-swap. Fall back to the default crossfade style
                // (blend) instead of forcing a too-short bass-swap.
                fadeMode = 'blend';
                beats = styleBeats;
            } else {
                beats = clampedBeats;
            }
        }

        // Never run a fade longer than the audio actually remaining. The
        // trigger paths aim to prevent this (vocal-fit shrink, end-of-track
        // clamps), but a vocal-delayed or otherwise late trigger can still
        // leave less room than the style default. Floor 8 beats while 8 fit;
        // a trigger in the last few seconds (a seek or hold-to-mix there) goes
        // below it and fits what is left, rather than fading in the new track
        // long after the old one has ended. Manual overrides and cut mode are
        // left untouched.
        if (!state.crossfadeBeatsOverride && fadeMode !== 'cut' && bpmForCalc > 0) {
            const remainingMs = backend.getDurationMs() - backend.getCurrentTimeMs();
            const beatMs = 60_000 / bpmForCalc;
            if (calculateCrossfadeDuration(bpmForCalc, beats) > remainingMs - 1_000) {
                const fitBeats = Math.floor(Math.max(remainingMs - 1_000, 0) / beatMs);
                const floorBeats =
                    fitBeats >= 8
                        ? 8
                        : Math.max(1, Math.floor(Math.max(remainingMs - 250, 0) / beatMs));
                // Shrink-only (min() guards a style already below the floor).
                beats = Math.min(beats, Math.max(floorBeats, fitBeats));
            }
        }

        store.update((s) => ({
            ...s,
            pendingCrossfadeAtMs: null,
            pendingCrossfadeForTrackId: null,
            pendingCrossfadeIsManual: false,
        }));

        // Compute debug info
        const outDownbeats = state.currentTrack?.audioFeatures?.downbeats;
        const inDownbeats = nextTrack.audioFeatures?.downbeats;
        const inBeatGrid = nextTrack.audioFeatures?.beatGrid;
        const effectiveIntroEndMs = getEffectiveIntroEndMs(nextTrack.audioFeatures);
        const desiredStartSec = effectiveIntroEndMs / 1000;
        const outCurrentSec = (backend.getCurrentTimeMs() ?? 0) / 1000;

        const hasOutPhaseData = outDownbeats && outDownbeats.length >= 2;
        const hasInDownbeats = inDownbeats && inDownbeats.length > 0;
        const hasInBeatGrid = inBeatGrid && inBeatGrid.length > 0;

        let alignmentMethod: CrossfadeDebugInfo['alignmentMethod'] = 'none';
        if (!plainTransition) {
            if (hasOutPhaseData && hasInDownbeats) alignmentMethod = 'phase-aligned';
            else if (hasInDownbeats && desiredStartSec > 0) alignmentMethod = 'downbeat-snap';
            else if (hasInBeatGrid && desiredStartSec > 0) alignmentMethod = 'beat-grid-snap';
            else if (desiredStartSec > 0) alignmentMethod = 'intro-end';
        }

        let outBarPhase: number | null = null;
        if (hasOutPhaseData) {
            const phase = computeBarPhase(outCurrentSec, outDownbeats!);
            if (phase !== null) {
                outBarPhase = Math.round(phase * 1000) / 1000;
            }
        }

        let syncTechnique: CrossfadeDebugInfo['syncTechnique'] = 'no-sync';
        let bpmGapPercent: number | null = null;
        const gap = outBpm && inBpm ? bpmGap(outBpm, inBpm) : null;
        if (gap !== null) {
            bpmGapPercent = Math.round(gap * 1000) / 10;
            if (plainTransition) {
                // Organic pair or echo-out: rate-matching is deliberately skipped.
            } else if (gap <= 0.15) syncTechnique = 'rate-match';
            else if (gap <= 0.25) syncTechnique = 'time-stretch';
        }

        const debugInfo: CrossfadeDebugInfo = {
            inTrackId: nextTrack.id,
            alignmentMethod,
            outHasDownbeats: !!(outDownbeats && outDownbeats.length > 0),
            inHasDownbeats: !!hasInDownbeats,
            inHasBeatGrid: !!hasInBeatGrid,
            outBarPhase,
            inStartSec: Math.round(effectiveIntroEndMs / 10) / 100,
            outBpm: outBpm ? Math.round(outBpm * 10) / 10 : null,
            inBpm: inBpm ? Math.round(inBpm * 10) / 10 : null,
            bpmGapPercent,
            syncTechnique,
            outKey: state.currentTrack?.audioFeatures?.key ?? null,
            inKey: nextTrack.audioFeatures?.key ?? null,
            fadeMode,
            fadeReason: crossfadeStyle.reason,
            outroSource:
                state.currentTrack?.audioFeatures?.outroSource ??
                (state.currentTrack?.audioFeatures?.outroStartMs !== undefined
                    ? 'percentage'
                    : 'dynamic-lead'),
        };

        store.update((s) => ({ ...s, crossfadeDebugInfo: debugInfo }));

        // Compute LUFS-adjusted volumes for each deck
        const outLufs = state.currentTrack?.audioFeatures?.loudnessLufs;
        const inLufs = nextTrack.audioFeatures?.loudnessLufs;
        const outgoingVolume = getPlaybackVolume(state.volume, outLufs);
        const incomingVolume = getPlaybackVolume(state.volume, inLufs);

        // ── Promote the incoming track at fade START ─────────────────────────
        // The incoming track becomes audible from this moment, so the whole app
        // treats it as the current track now: now-playing marker, queue
        // consumption, history, sessions and reporting all switch here rather
        // than at fade completion. This is consistent with every cancel path
        // (pause/seek/skip/AirPlay) — cancelCrossfade always promotes the
        // incoming deck, so the incoming track wins once the fade has started.
        // Everything from the `crossfadePending = true` guard up to and
        // including this update is synchronous, so no queue mutation can race
        // between choosing nextTrack and consuming it.
        if (state.currentTrack) {
            void completeMusicSession('completion');
        }

        // Transition play session: complete outgoing, start incoming. Active
        // Streams shows the fade from the new session's first heartbeat, sent
        // right away: the periodic one would land when the fade is half over.
        if (state.currentTrack) {
            // Same duration the engine computes (beats at the pacing BPM,
            // unknown BPM assumed 120, 100 ms floor).
            const fadeMs = Math.max(calculateCrossfadeDuration(bpmForCalc, beats), 100);
            crossfadeReport = {
                otherTrackId: state.currentTrack.id,
                durationMs: Math.round(fadeMs),
                endsAt: Date.now() + fadeMs,
            };
            crossfadeReportCleared = false;
        }
        void startMusicSession(nextTrack);

        // Where the incoming deck starts playing (intro-end for aligned fades,
        // 0 for plain transitions). onTimeUpdate mirrors the incoming deck's
        // real clock during the fade, so this is just the initial value.
        const incomingStartMs = plainTransition ? 0 : effectiveIntroEndMs || 0;
        const nextDurationMs = nextTrack.durationMs;

        store.update((s) => ({
            ...s,
            ...TRACK_SWITCH_RESETS,
            // Keep the fade debug info we just computed visible through (and
            // after) the fade — TRACK_SWITCH_RESETS would null it.
            crossfadeDebugInfo: s.crossfadeDebugInfo,
            currentTrack: nextTrack,
            currentTrackFeedback: feedbackForTrack(nextTrack),
            currentTrackSource: nextItem.source,
            playbackContext: contextForPlayback(
                s.playbackContext,
                nextItem.source,
                s.queue.slice(1),
            ),
            history: historyWithOutgoing(s),
            queue: s.queue.slice(1),
            crossfadeOutgoing: s.currentTrack
                ? { trackId: s.currentTrack.id, timeMs: outCurrentSec * 1000 }
                : null,
            currentTimeMs: incomingStartMs,
            progress:
                nextDurationMs !== null && nextDurationMs > 0
                    ? incomingStartMs / nextDurationMs
                    : 0,
            // Unknown incoming duration → 0 ("unknown"), NOT the outgoing
            // track's stale length: onTimeUpdate deliberately never refreshes
            // durationMs during the fade, so a wrong value would drive the
            // progress bar and the mid-fade seek clamp for the whole fade.
            // The first post-fade timeupdate fills in the real duration.
            durationMs: nextDurationMs ?? 0,
            normalizingTargetBpm: null,
        }));

        // The track/queue/history swap is committed state now — persist it so
        // a reload mid-fade restores the incoming track instead of replaying
        // one whose play-end was already reported.
        persistState();

        void fetchNextTrack(nextTrack.id);
        void syncCurrentTrackContext(nextTrack);
        startProgressReporting();

        try {
            await backend.triggerCrossfade(
                await trackStreamUrl(nextTrack, { waitForOutgoing: true }),
                {
                    title: nextTrack.title,
                    artist: nextTrack.artists.map((artist) => artist.title).join(', '),
                    album: nextTrack.album?.title,
                    artworkUrl: trackArtworkUrl(nextTrack),
                },
                {
                    beats,
                    // Same pacing BPM as the plan/trigger (outgoing, else
                    // incoming) — incomingBpm below is omitted for unsynced
                    // transitions, which used to change the fade's length.
                    paceBpm: bpmForCalc > 0 ? bpmForCalc : undefined,
                    volume: state.volume,
                    fadeMode,
                    // outgoingBpm stays — it paces the fade duration. Omitting
                    // incomingBpm on plain transitions disables rate-matching.
                    outgoingBpm: outBpm,
                    incomingBpm: plainTransition ? undefined : inBpm,
                    outgoingDownbeats: plainTransition
                        ? undefined
                        : state.currentTrack?.audioFeatures?.downbeats,
                    outgoingCurrentTimeSec: outCurrentSec,
                    incomingBeatGrid: plainTransition
                        ? undefined
                        : nextTrack.audioFeatures?.beatGrid,
                    incomingDownbeats: plainTransition
                        ? undefined
                        : nextTrack.audioFeatures?.downbeats,
                    // Plain transitions start the incoming track at 0 — never
                    // skip a rock song's intro.
                    incomingIntroEndMs: plainTransition
                        ? undefined
                        : effectiveIntroEndMs || undefined,
                    outgoingVolume,
                    incomingVolume,
                },
            );
        } catch (err) {
            console.error('[Crossfade] triggerCrossfade error', err);
            crossfadePending = false;
            // If a cancel path (pause/skip/play/seek/AirPlay) already took
            // over while the backend was failing, it owns the decks — bail
            // rather than clobber whatever it started.
            if (myCrossfadeToken !== crossfadeToken || !get(store).isCrossfading) {
                return;
            }
            // The store already promoted the incoming track at fade start, but
            // the fade engine failed to deliver it (both backends throw on
            // their cannot-run paths: missing engine/deck, incoming play()
            // rejection). Clear the fade state and hard-cut the audio to the
            // promoted track so state and sound can't diverge.
            backend?.cancelCrossfade();
            store.update((s) => ({
                ...s,
                isCrossfading: false,
                crossfadeProgress: 0,
                crossfadeOutgoing: null,
                crossfadeCurrentBeat: 0,
                crossfadeTotalBeats: 0,
            }));
            // Apply the incoming track's LUFS volume BEFORE starting it — the
            // backend's remembered volume is still adjusted for the outgoing
            // track. Skipped while muted (setVolume clears mute).
            if (backend?.supportsVolumeControl && !get(store).isMuted) {
                backend.setVolume(
                    getPlaybackVolume(get(store).volume, nextTrack.audioFeatures?.loudnessLufs),
                );
            }
            // Participate in play-call ordering so a user play()/skip() that
            // fires during this await supersedes the recovery (matching the
            // token discipline of play() itself).
            const myRecoveryToken = ++playLoadToken;
            try {
                await playTrackWithTokenRecovery(
                    nextTrack,
                    {
                        title: nextTrack.title,
                        artist: nextTrack.artists.map((artist) => artist.title).join(', '),
                        album: nextTrack.album?.title,
                        artworkUrl: trackArtworkUrl(nextTrack),
                        isRadio: nextTrack.isRadio === true,
                    },
                    () => myRecoveryToken === playLoadToken,
                );
                if (myRecoveryToken !== playLoadToken) return;
                const postRecovery = get(store);
                if (postRecovery.currentTrack?.id !== nextTrack.id) return;
                // User paused while the recovery play was in flight — the
                // backend's play() unconditionally started audio; re-pause.
                if (!postRecovery.isPlaying) {
                    backend?.pause();
                }
            } catch (playErr) {
                // Recovery play failed too (network/undecodable). Tear down to
                // a clean stopped state — mirrors play()'s own failure path.
                // Null currentTrack first so stop() doesn't re-report play-end
                // for a track that never actually played.
                console.error('[Crossfade] hard-cut recovery play() failed', playErr);
                if (myRecoveryToken !== playLoadToken) return;
                toasts.error(messages.music_playback_failed(), {
                    diagnosticKey: 'music_playback_failed',
                    diagnosticError: playErr,
                });
                // A dead track (404, unreadable file) must not end the session:
                // move on to the next queued track, as its own end would have.
                // currentTrack is nulled first so play() does not report a
                // play-end for a track that never sounded.
                const after = get(store).queue[0];
                store.update((s) => ({
                    ...s,
                    isPlaying: false,
                    currentTrack: null,
                    queue: after ? s.queue.slice(1) : s.queue,
                }));
                if (after) {
                    await play(after.track, Boolean(get(store).autoplaySeed), after.source);
                    return;
                }
                stop();
            }
            return;
        }

        // If the crossfade was cancelled (by pause, skip, play, seek, or
        // AirPlay activation) the cancel handler already finalized the swap.
        // Two independent signals detect this: (1) the monotonic token was
        // bumped by the cancel path, and (2) isCrossfading was cleared. Either
        // one means we must NOT re-finalize — bail without touching state.
        // (Track promotion, play-end reporting and the session transition all
        // happened at fade start, so there is nothing to re-report here.)
        const postState = get(store);
        if (myCrossfadeToken !== crossfadeToken || !postState.isCrossfading) {
            crossfadePending = false;
            return;
        }

        // Re-sync the backend's remembered volume to the INCOMING track's LUFS
        // normalization. The engine already left the deck at the LUFS-adjusted
        // incoming volume, but the backend's currentVolume still holds the
        // OUTGOING track's adjusted value — any later re-apply (mid-fade volume
        // change settle, crossfade-cancel promote, shadow audio) would replay
        // the new track at the old track's loudness correction. Skipped while
        // muted: setVolume would clear the mute; toggleMute recomputes LUFS on
        // unmute anyway.
        // Read loudness from the store's current track, not the nextTrack captured
        // at fade start: syncCurrentTrackContext usually lands mid-fade and is
        // the first time a queue item built without loudnessLufs gets it.
        if (backend.supportsVolumeControl && !postState.isMuted) {
            const inLoudness =
                postState.currentTrack?.id === nextTrack.id
                    ? (postState.currentTrack.audioFeatures?.loudnessLufs ??
                      nextTrack.audioFeatures?.loudnessLufs)
                    : nextTrack.audioFeatures?.loudnessLufs;
            backend.setVolume(getPlaybackVolume(postState.volume, inLoudness));
        }

        // Normalize playback rate on new active deck
        backend.normalizePlaybackRate();

        // Track target BPM for live drift UI. Skip for backends that normalize
        // the playback rate instantly (no gradual ramp) — the rate snaps to its
        // target before the first timeupdate, so showing a "normalizing toward X"
        // indicator would only flicker for a frame.
        const incomingNaturalBpm = nextTrack.audioFeatures?.bpm ?? null;
        const isNormalizing =
            backend.normalizationStyle === 'gradual' && backend.getPlaybackRate() !== 1;

        store.update((s) => ({
            ...s,
            isCrossfading: false,
            crossfadeProgress: 0,
            crossfadeOutgoing: null,
            crossfadeCurrentBeat: 0,
            crossfadeTotalBeats: 0,
            normalizingTargetBpm:
                isNormalizing && incomingNaturalBpm !== null
                    ? Math.round(incomingNaturalBpm)
                    : null,
        }));

        crossfadePending = false;
    }

    /**
     * Manual "hold-to-mix": crossfade to the next queued track now-ish, DJ
     * style. The fade start is quantized to the outgoing track's next downbeat
     * (≤2 bars ahead) via the same pending mechanism the automatic path uses;
     * without beat data — or when the snap point can't fit a full fade before
     * track end — the fade starts immediately. Falls back to a plain skip()
     * when the backend can't crossfade (unsupported backend, AirPlay), the
     * queue is empty, or playback is paused, so the gesture never dead-ends.
     * Deliberately ignores the crossfadeEnabled user setting: that governs
     * automatic fades only.
     */
    function mixNow(): void {
        const state = get(store);
        if (state.isCrossfading || crossfadePending) return;

        const nextTrack = state.queue[0]?.track;
        if (
            !nextTrack ||
            !backend ||
            !state.supportsCrossfade ||
            state.isAirPlayActive ||
            state.currentTrack?.isRadio ||
            // Paused → behave like a tap; skip() already handles
            // advance-and-play semantics.
            !state.isPlaying
        ) {
            void skip();
            return;
        }

        const currentMs = backend.getCurrentTimeMs();
        const durationMs = backend.getDurationMs();

        // Fade geometry for the end-of-track clamp — same plan the automatic
        // trigger uses, so manual and auto fades can never disagree on length.
        const chMood =
            state.autoplaySeed?.type === 'mood'
                ? state.autoplaySeed.mood?.toLowerCase()
                : undefined;
        const plan = computeCrossfadePlan({
            outgoingAudioFeatures: state.currentTrack?.audioFeatures,
            incomingAudioFeatures: nextTrack.audioFeatures,
            durationMs,
            incomingDurationSec: (nextTrack.durationMs ?? 0) / 1000,
            crossfadeBeatsOverride: state.crossfadeBeatsOverride,
            mood: chMood,
            currentMs,
        });

        const downbeats = state.currentTrack?.audioFeatures?.downbeats;
        const bpm = state.currentTrack?.audioFeatures?.bpm ?? nextTrack.audioFeatures?.bpm ?? 0;
        let snapAtMs = currentMs;
        if (downbeats && downbeats.length > 0 && bpm > 0) {
            const maxLookaheadSec = (2 * 4 * 60) / bpm; // 2 bars, as in the auto path
            snapAtMs = findNextDownbeat(downbeats, currentMs / 1000, maxLookaheadSec) * 1000;
        }
        // Never schedule a fade that can't complete before the track ends.
        if (durationMs > 0) {
            snapAtMs = Math.min(
                snapAtMs,
                durationMs - plan.fadeDurationMs - CROSSFADE_END_HEADROOM_MS,
            );
        }

        // A track too short for the tick's fire window (plan.dynamicTargetMs
        // <= 0, i.e. durationMs <= fadeDurationMs + bufferAfterFade) must
        // fade immediately — an armed pending would never fire, since the
        // tick's own fire branch is gated on dynamicTargetMs > 0.
        if (plan.dynamicTargetMs <= 0 || snapAtMs <= currentMs) {
            void triggerCrossfade();
            return;
        }
        store.update((s) => ({
            ...s,
            pendingCrossfadeAtMs: snapAtMs,
            pendingCrossfadeForTrackId: s.queue[0]?.id ?? null,
            pendingCrossfadeIsManual: true,
        }));
    }

    // -------------------------------------------------------------------------
    // Smart queue
    // -------------------------------------------------------------------------

    async function fetchNextTrack(currentTrackId: string, force = false): Promise<void> {
        store.update((s) => ({ ...s, smartQueueLoading: true }));

        // Re-read AFTER setting smartQueueLoading so a redundant concurrent
        // fetch sees the latest smart count and bails (same freshness pattern
        // the excludeIds read below already uses).
        const state = get(store);

        const smartCount = state.queue.filter((q) => q.source === 'smart').length;
        if (smartCount >= 3 && !force) {
            store.update((s) => ({ ...s, smartQueueLoading: false }));
            return;
        }

        if (!state.autoplayEnabled) {
            store.update((s) => ({ ...s, smartQueueLoading: false }));
            return;
        }

        // Version tracking: if another fetchNextTrack fires while we're
        // awaiting the network, ignore the stale response.
        const version = ++fetchNextTrackVersion;

        try {
            const { getRecommendations } = await import('$lib/api/music');

            // Re-read state after dynamic import for fresher exclude lists
            const freshState = get(store);
            const excludeIds = [
                currentTrackId,
                ...freshState.queue.map((q) => q.track.id),
                ...freshState.history.map((t) => t.id),
                ...freshState.skippedTrackIds,
            ];
            const sessionHistory = freshState.history.map((t) => t.id);
            const skippedIds = freshState.skippedTrackIds;
            const upcomingIds = recentQueueContextIds(freshState, currentTrackId).slice(1);
            const result = await getRecommendations({
                currentTrackId,
                exclude: excludeIds,
                history: sessionHistory,
                skipped: skippedIds,
                seed: freshState.autoplaySeed ?? undefined,
                upcoming: upcomingIds,
                // AirPlay hard-cuts and iOS can't crossfade, so send the effective
                // capability, not the raw toggle
                crossfade:
                    freshState.crossfadeEnabled &&
                    freshState.supportsCrossfade &&
                    !freshState.isAirPlayActive,
                startedBy: freshState.currentTrackSource === 'user' ? 'user' : 'autoplay',
            });

            // Stale response — a newer fetch superseded us
            if (version !== fetchNextTrackVersion) return;

            // Autoplay was switched off (or the saved preference arrived) while
            // the request was in flight: drop the suggestions.
            if (!get(store).autoplayEnabled) {
                store.update((s) => ({ ...s, smartQueueLoading: false }));
                return;
            }

            if (result.data) {
                const { next: autoNext, alternatives: suggestions, source } = result.data;
                const fallback = source === 'fallback';

                store.update((s) => {
                    // Collect IDs already in queue to prevent duplicates
                    const existingIds = new Set(s.queue.map((q) => q.id));

                    // Add autoNext + suggestions as smart items (deduplicated)
                    const newSmartItems: QueueItem[] = [];
                    const allReturned = [autoNext, ...(suggestions ?? [])].filter(
                        Boolean,
                    ) as MusicTrack[];

                    for (const track of allReturned) {
                        if (!existingIds.has(track.id)) {
                            newSmartItems.push({
                                track,
                                source: 'smart' as const,
                                id: track.id,
                            });
                            existingIds.add(track.id);
                        }
                    }

                    return {
                        ...s,
                        queue: [...s.queue, ...newSmartItems],
                        smartQueueFallback: fallback ?? false,
                        smartQueueLoading: false,
                    };
                });

                // Auto-resume: handleTrackEnded returned early waiting for us
                // (the flag is cleared by any play/pause/stop since). No
                // isPlaying check: the ended track leaves it true, which is
                // exactly why the old "idle" test never let this fire.
                const postState = get(store);
                if (
                    awaitingQueueRefill &&
                    !postState.isCrossfading &&
                    postState.queue.length > 0 &&
                    postState.currentTrack
                ) {
                    awaitingQueueRefill = false;
                    const nextItem = postState.queue[0];
                    store.update((s) => ({
                        ...s,
                        queue: s.queue.slice(1),
                    }));
                    void play(nextItem.track, Boolean(postState.autoplaySeed), nextItem.source);
                }
            } else {
                store.update((s) => ({ ...s, smartQueueLoading: false }));
                stopIfIdle();
            }
        } catch (err) {
            if (version !== fetchNextTrackVersion) return;
            console.error('[SmartQueue] fetchNextTrack error', err);
            store.update((s) => ({ ...s, smartQueueLoading: false }));
            stopIfIdle();
        }
    }

    /**
     * If the player is idle (not playing, queue empty), stop cleanly.
     * Handles the case where handleTrackEnded returned early waiting
     * for a smart queue fetch that failed or returned empty.
     */
    function stopIfIdle(): void {
        const s = get(store);
        if (!s.isPlaying && !s.isCrossfading && s.queue.length === 0) {
            store.update((st) => ({ ...st, isPlaying: false }));
        }
    }

    // -------------------------------------------------------------------------
    // Progress reporting
    // -------------------------------------------------------------------------

    function startProgressReporting(): void {
        stopProgressReporting();
        progressReportInterval = setInterval(() => {
            const state = get(store);
            if (!state.isPlaying) return;
            const isRadio = state.currentTrack?.isRadio === true;
            // Non-radio tracks: skip ticks before playback has actually
            // started (currentTimeMs would still be 0 between play() and the
            // first timeupdate). Radio streams report no positional time, so
            // currentTimeMs stays at 0 forever — gate the skip on isRadio so
            // the admin-sessions heartbeat actually fires for radio.
            if (!isRadio && state.currentTimeMs <= 0) return;
            heartbeatMusicSession(state.currentTimeMs, false);
            // Keep the snapshot's position fresh while playing. It was only
            // written on discrete actions, so a tab opened mid-track (or a
            // crash recovery) restored the position of the last click, often 0.
            persistState();
        }, 10_000);
    }

    function stopProgressReporting(): void {
        if (progressReportInterval !== null) {
            clearInterval(progressReportInterval);
            progressReportInterval = null;
        }
    }

    // -------------------------------------------------------------------------
    // Queue management
    // -------------------------------------------------------------------------

    function toggleExpanded(): void {
        store.update((s) => ({ ...s, isExpanded: !s.isExpanded }));
    }

    function setActivePanel(panel: 'queue' | 'lyrics' | 'settings' | 'add'): void {
        store.update((s) => ({ ...s, activePanel: panel }));
    }

    function addToQueue(rawTrack: MusicTrack, sessionId?: string): void {
        const track = withTrackImages(rawTrack);
        store.update((s) => {
            if (s.queue.some((q) => q.id === track.id)) return s;
            return {
                ...s,
                queue: [...s.queue, { track, source: 'user' as const, id: track.id, sessionId }],
            };
        });
        persistState();
    }

    function addToQueueFront(rawTrack: MusicTrack): void {
        const track = withTrackImages(rawTrack);
        store.update((s) => {
            const filtered = s.queue.filter((q) => q.id !== track.id);
            // No crossfade special case: queue[0] is never a live fade target
            // (triggerCrossfade consumes it synchronously at fade start), so
            // the front of the queue is always safe to insert at.
            return {
                ...s,
                queue: [{ track, source: 'user' as const, id: track.id }, ...filtered],
            };
        });
        persistState();
    }

    function reorderQueue(items: QueueItem[]): void {
        // No crossfade lock needed: triggerCrossfade consumes queue[0]
        // synchronously at fade start (before its first await), so the queue
        // never holds an in-flight fade target — it is freely reorderable at
        // any time, including mid-fade.
        store.update((s) => ({ ...s, queue: items }));
        persistState();
    }

    function removeFromQueue(itemId: string): void {
        // Same as reorderQueue: queue[0] is never a live fade target (it is
        // consumed synchronously at fade start), so any item may be removed.
        store.update((s) => ({
            ...s,
            queue: s.queue.filter((i) => i.id !== itemId),
        }));
        persistState();
    }

    /** Append a brew without interrupting playback, or replace the session and play it. */
    async function enqueueFromBrew(
        tracks: MusicTrack[],
        playImmediately = true,
        context: PlaybackContext | null = null,
    ): Promise<void> {
        const seenIds = new Set<string>();
        const deduped = tracks.filter((track) => {
            if (seenIds.has(track.id)) return false;
            seenIds.add(track.id);
            return true;
        });
        if (!deduped.length) return;

        if (!playImmediately) {
            store.update((s) => {
                const queued = new Set(s.queue.map((item) => item.id));
                return {
                    ...s,
                    queue: [
                        ...s.queue,
                        ...deduped
                            .filter((track) => !queued.has(track.id))
                            .map((track) => ({
                                track: withTrackImages(track),
                                source: 'user' as const,
                                id: track.id,
                            })),
                    ],
                };
            });
            persistState();
            return;
        }

        // Invalidate suggestions requested for the previous session. Replacement
        // deduplicates only the incoming list: old queue membership is irrelevant.
        fetchNextTrackVersion++;
        const [first, ...rest] = deduped;
        store.update((s) => ({
            ...s,
            queue: rest.map((track) => ({
                track: withTrackImages(track),
                source: 'user' as const,
                id: track.id,
                sessionId: context?.type === 'album' ? context.sessionId : undefined,
            })),
            playbackContext: context,
            autoplaySeed: null,
            smartQueueLoading: false,
            smartQueueFallback: false,
        }));
        await play(first);
        persistState();
    }

    function refreshSmartQueue(): void {
        const state = get(store);
        if (!state.currentTrack) return;
        // Collect IDs of smart items being dismissed so they're excluded
        const dismissedIds = state.queue.filter((q) => q.source === 'smart').map((q) => q.track.id);
        store.update((s) => ({
            ...s,
            queue: s.queue.filter((q) => q.source !== 'smart'),
            skippedTrackIds: [...s.skippedTrackIds, ...dismissedIds],
        }));
        void fetchNextTrack(state.currentTrack.id, true);
    }

    /**
     * Fetch a smart-queue pick and append it to the queue.
     * Unlike fetchNextTrack, this allows multiple smart items and
     * excludes everything already in the queue to avoid duplicates.
     */
    async function addSmartItem(): Promise<void> {
        const state = get(store);
        if (!state.currentTrack) return;

        store.update((s) => ({ ...s, smartQueueLoading: true }));

        try {
            const { getRecommendations } = await import('$lib/api/music');
            const excludeIds = [
                state.currentTrack.id,
                ...state.queue.map((q) => q.track.id),
                ...state.history.map((t) => t.id),
                ...state.skippedTrackIds,
            ];
            const upcomingIds = recentQueueContextIds(state, state.currentTrack.id).slice(1);
            const result = await getRecommendations({
                currentTrackId: state.currentTrack.id,
                exclude: excludeIds,
                history: state.history.map((t) => t.id),
                skipped: state.skippedTrackIds,
                seed: state.autoplaySeed ?? undefined,
                upcoming: upcomingIds,
                crossfade:
                    state.crossfadeEnabled && state.supportsCrossfade && !state.isAirPlayActive,
                startedBy: state.currentTrackSource === 'user' ? 'user' : 'autoplay',
            });
            if (result.data?.next) {
                const track = result.data.next;
                const usedFallback = result.data.source === 'fallback';
                store.update((s) => {
                    if (s.queue.some((q) => q.id === track.id)) {
                        return { ...s, smartQueueLoading: false };
                    }
                    return {
                        ...s,
                        queue: [
                            ...s.queue,
                            {
                                track,
                                source: 'smart' as const,
                                id: track.id,
                            },
                        ],
                        smartQueueFallback: usedFallback || s.smartQueueFallback,
                        smartQueueLoading: false,
                    };
                });
            } else {
                store.update((s) => ({ ...s, smartQueueLoading: false }));
            }
        } catch (err) {
            console.error('[SmartQueue] addSmartItem error', err);
            store.update((s) => ({ ...s, smartQueueLoading: false }));
        }
    }

    /**
     * Fetch AI-suggested candidate tracks for the "Add" tab's Suggestions
     * section. Read-only — mirrors the same exclude/history/skipped/seed
     * assembly as addSmartItem/refreshSmartQueue, but never mutates the queue
     * or any other store state. Returns [] when there is no current track or
     * on error.
     */
    async function getSuggestionCandidates(): Promise<MusicTrack[]> {
        const state = get(store);
        if (!state.currentTrack) return [];

        try {
            const { getRecommendations } = await import('$lib/api/music');
            const excludeIds = [
                state.currentTrack.id,
                ...state.queue.map((q) => q.track.id),
                ...state.history.map((t) => t.id),
                ...state.skippedTrackIds,
            ];
            const upcomingIds = recentQueueContextIds(state, state.currentTrack.id).slice(1);
            const result = await getRecommendations({
                currentTrackId: state.currentTrack.id,
                exclude: excludeIds,
                history: state.history.map((t) => t.id),
                skipped: state.skippedTrackIds,
                seed: state.autoplaySeed ?? undefined,
                upcoming: upcomingIds,
                crossfade:
                    state.crossfadeEnabled && state.supportsCrossfade && !state.isAirPlayActive,
                startedBy: state.currentTrackSource === 'user' ? 'user' : 'autoplay',
            });
            const suggestions = result.data?.alternatives ?? [];
            // Re-read the live store: the queue/current track may have changed
            // while we awaited the network (e.g. a crossfade promotion), and
            // filtering against the pre-await snapshot could return tracks
            // that are meanwhile playing or queued.
            const liveState = get(store);
            const queueIds = new Set(liveState.queue.map((q) => q.track.id));
            return suggestions.filter(
                (track) => track.id !== liveState.currentTrack?.id && !queueIds.has(track.id),
            );
        } catch (err) {
            console.error('[SmartQueue] getSuggestionCandidates error', err);
            return [];
        }
    }

    function setLyricsStatus(status: 'available' | 'unavailable'): void {
        store.update((s) => ({ ...s, lyricsStatus: status }));
    }

    async function startPlayback(track: MusicTrack): Promise<void> {
        // `playbackContext` is display-only provenance for the current queue.
        // Clearing it here means any fresh playback (Quick Pick click, album
        // play, etc.) starts with no stale "Playing from …" label. Callers
        // that want to SET context (e.g. stations) do so AFTER startPlayback
        // returns — see stations.startStation().

        // Cancel any in-flight fetchNextTrack so its response cannot land on
        // the freshly-cleared queue and block the smart-queue regeneration for
        // the new track.  play() fires fetchNextTrack (force=false) which
        // bails when smartCount >= 3; without this bump an in-flight fetch from
        // the previous song can complete during the await backend.play() gap,
        // add stale smart items, and cause the new fetchNextTrack to bail.
        fetchNextTrackVersion++;

        store.update((s) => ({
            ...s,
            queue: [],
            playbackContext: null,
            smartQueueLoading: false,
            smartQueueFallback: false,
        }));
        await play(track);
    }

    function clearQueue(): void {
        store.update((s) => ({
            ...s,
            queue: [],
            playbackContext: null,
            smartQueueLoading: false,
            smartQueueFallback: false,
        }));
    }

    function clearPlaybackContext(): void {
        store.update((s) => ({ ...s, playbackContext: null }));
    }

    function switchToSmartQueue(): void {
        const state = get(store);
        if (!state.currentTrack || state.currentTrack.isRadio || state.autoplaySeed) return;
        // Invalidate the previous queue before replacement, including a reply
        // that arrives while the new recommendation request is being imported.
        fetchNextTrackVersion++;
        awaitingQueueRefill = false;
        prefetchedNextTrackId = null;
        if (state.isCrossfading) {
            crossfadeToken++;
            crossfadePending = false;
            backend?.cancelCrossfade();
            if (backend?.supportsVolumeControl && !state.isMuted) {
                backend.setVolume(
                    getPlaybackVolume(state.volume, state.currentTrack.audioFeatures?.loudnessLufs),
                );
            }
        }
        store.update((s) => ({
            ...s,
            queue: [],
            autoplayEnabled: true,
            playbackContext: null,
            smartQueueLoading: false,
            smartQueueFallback: false,
            isCrossfading: false,
            crossfadeOutgoing: null,
            pendingCrossfadeAtMs: null,
            pendingCrossfadeForTrackId: null,
            pendingCrossfadeIsManual: false,
        }));
        if (!state.autoplayEnabled) {
            void import('$lib/api/user')
                .then((m) => m.updatePlaybackPreferences({ musicAutoplayEnabled: true }))
                .catch(() => {
                    /* silent */
                });
        }
        persistState();
        void fetchNextTrack(state.currentTrack.id).then(() => persistState());
    }

    // -------------------------------------------------------------------------
    // Track ended handler
    // -------------------------------------------------------------------------

    function handleTrackEnded(): void {
        const state = get(store);
        if (state.isCrossfading) return;

        if (state.currentTrack) {
            void completeMusicSession('completion');
        }

        const nextItem = state.queue[0];
        if (nextItem) {
            store.update((s) => ({ ...s, queue: s.queue.slice(1) }));
            void play(nextItem.track, Boolean(state.autoplaySeed), nextItem.source);
        } else if (state.autoplayEnabled && state.smartQueueLoading) {
            // Smart queue fetch in-flight — do not stop; wait for fetch to complete
            awaitingQueueRefill = true;
            return;
        } else {
            store.update((s) => ({
                ...s,
                isPlaying: false,
                playbackContext: s.playbackContext?.type === 'album' ? null : s.playbackContext,
            }));
        }
    }

    // -------------------------------------------------------------------------
    // Explicit track feedback
    // -------------------------------------------------------------------------

    // Optimistic feedback updates: apply locally for instant UI feedback,
    // PUT to the server, and revert the local change if the request fails
    // (only if the track is still current — track switches win the race).
    async function likeCurrentTrack(): Promise<void> {
        const state = get(store);
        if (!state.currentTrack) return;
        const trackId = state.currentTrack.id;
        const previous = state.currentTrackFeedback;
        store.update((s) => ({ ...s, currentTrackFeedback: 'liked' }));
        try {
            const { setTrackFeedback } = await import('$lib/api/music');
            const result = await setTrackFeedback(trackId, 'liked');
            if (result.error) throw new Error(result.error);
        } catch (e) {
            console.warn('[MusicPlayer] Failed to like track', e);
            store.update((s) =>
                s.currentTrack?.id === trackId ? { ...s, currentTrackFeedback: previous } : s,
            );
        }
    }

    async function dislikeCurrentTrack(): Promise<void> {
        const state = get(store);
        if (!state.currentTrack) return;
        const trackId = state.currentTrack.id;
        const previous = state.currentTrackFeedback;
        store.update((s) => ({
            ...s,
            currentTrackFeedback: 'disliked',
            skippedTrackIds: [...s.skippedTrackIds, trackId],
        }));
        try {
            const { setTrackFeedback } = await import('$lib/api/music');
            const result = await setTrackFeedback(trackId, 'disliked');
            if (result.error) throw new Error(result.error);
            // Preserve the explicit dislike without inferring a second skip.
            suppressNextSkipReport = true;
            void skip();
        } catch (e) {
            console.warn('[MusicPlayer] Failed to dislike track', e);
            store.update((s) => ({
                ...s,
                currentTrackFeedback:
                    s.currentTrack?.id === trackId ? previous : s.currentTrackFeedback,
                skippedTrackIds: s.skippedTrackIds.filter((id) => id !== trackId),
            }));
        }
    }

    // -------------------------------------------------------------------------
    // Autoplay toggle
    // -------------------------------------------------------------------------

    function toggleAutoplay(): void {
        const newValue = !get(store).autoplayEnabled;
        store.update((s) => ({
            ...s,
            autoplayEnabled: newValue,
        }));
        void import('$lib/api/user')
            .then((m) => m.updatePlaybackPreferences({ musicAutoplayEnabled: newValue }))
            .catch(() => {
                /* silent */
            });
        if (newValue) {
            const state = get(store);
            if (state.currentTrack && state.queue.length === 0) {
                void fetchNextTrack(state.currentTrack.id);
            }
        }
    }

    // -------------------------------------------------------------------------
    // Autoplay seed management
    // -------------------------------------------------------------------------

    async function seedAutoplay(seed: AutoplaySeed, initialTrack?: MusicTrack): Promise<void> {
        // A radio is continuous by definition: with autoplay off it played its
        // first track and stopped. Turn it on, as switchToSmartQueue does.
        const autoplayWasOff = !get(store).autoplayEnabled;
        store.update((s) => ({
            ...s,
            autoplaySeed: seed,
            autoplayEnabled: true,
            playbackContext: null,
            queue: [],
        }));
        if (autoplayWasOff) {
            void import('$lib/api/user')
                .then((m) => m.updatePlaybackPreferences({ musicAutoplayEnabled: true }))
                .catch(() => {
                    /* silent */
                });
        }

        const { toasts } = await import('$lib/stores/toast.store');
        const label =
            seed.type === 'mood'
                ? `${seed.emoji} ${seed.label}`
                : seed.type === 'genre'
                  ? `${musicGenreIcon(seed.genre)} ${seed.label} Radio`
                  : seed.type === 'artist'
                    ? `📻 ${seed.artistName} Radio`
                    : `📻 ${seed.albumName} Radio`;
        toasts.info(`${label} — Playing similar music`);

        if (initialTrack) {
            await play(initialTrack, true);
        } else {
            const state = get(store);
            if (state.currentTrack) {
                await fetchNextTrack(state.currentTrack.id, true);
                const updated = get(store);
                const smartItem = updated.queue.find((q) => q.source === 'smart');
                if (smartItem) {
                    const track = smartItem.track;
                    store.update((s) => ({
                        ...s,
                        queue: s.queue.filter((q) => q.source !== 'smart'),
                    }));
                    await play(track, true);
                }
            } else {
                try {
                    if (seed.type === 'mood' || seed.type === 'genre') {
                        // Mood/genre radio: cold start with taste + mood matching. The
                        // server only cold-starts a mood seed, so a genre radio sends
                        // its genre as the mood key (an unknown key falls back to
                        // taste alone).
                        const { getRecommendations } = await import('$lib/api/music');
                        const result = await getRecommendations({
                            seed: {
                                type: 'mood',
                                mood: seed.type === 'mood' ? seed.mood : seed.genre,
                            },
                        });
                        if (result.data?.next) {
                            await play(result.data.next, true);
                        }
                    } else if (seed.type === 'artist') {
                        // Artist radio: fetch a random track by this artist to bootstrap
                        const { getArtist } = await import('$lib/api/music');
                        const artistResult = await getArtist(seed.artistId);
                        if (!artistResult.error && artistResult.data?.tracks?.length) {
                            const tracks = artistResult.data.tracks;
                            const randomTrack = tracks[Math.floor(Math.random() * tracks.length)];
                            const bootstrapTrack: MusicTrack = randomTrack;
                            await play(bootstrapTrack, true);
                        }
                    } else {
                        // Album radio: fetch album tracks and bootstrap queue from one
                        const { getAlbum, getRecommendations } = await import('$lib/api/music');
                        const albumResult = await getAlbum(
                            seed.type === 'album' ? seed.albumId : '',
                        );
                        if (!albumResult.error && albumResult.data) {
                            const albumTracks = albumResult.data.tracks;
                            if (albumTracks && albumTracks.length > 0) {
                                const randomTrack =
                                    albumTracks[Math.floor(Math.random() * albumTracks.length)];
                                const result = await getRecommendations({
                                    currentTrackId: randomTrack.id,
                                    seed,
                                    crossfade:
                                        state.crossfadeEnabled &&
                                        state.supportsCrossfade &&
                                        !state.isAirPlayActive,
                                });
                                if (result.error || !result.data?.next) {
                                    console.warn(
                                        '[MusicPlayer] Album radio recommendation failed, starting the album track',
                                        result.error,
                                    );
                                    await play(randomTrack, true);
                                } else {
                                    await play(result.data.next, true);
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.warn('[MusicPlayer] Autoplay queue fetch failed', e);
                }
            }
        }
    }

    async function clearAutoplaySeed(): Promise<void> {
        store.update((s) => ({ ...s, autoplaySeed: null }));
        const { toasts } = await import('$lib/stores/toast.store');
        toasts.info('Radio stopped — Autoplay continues');
    }

    function setPlaybackContext(context: PlaybackContext | null): void {
        store.update((s) => ({
            ...s,
            playbackContext: context,
            autoplaySeed: null,
        }));
    }

    async function dismissSmartItem(trackId?: string): Promise<void> {
        const state = get(store);
        if (!state.currentTrack) return;

        // Find the specific smart item to dismiss, or fall back to the first smart item
        const smartItem = trackId
            ? state.queue.find((q) => q.source === 'smart' && q.track.id === trackId)
            : state.queue.find((q) => q.source === 'smart');
        if (!smartItem) return;

        store.update((s) => ({
            ...s,
            queue: s.queue.filter((q) => q.id !== smartItem.id),
            skippedTrackIds: [...s.skippedTrackIds, smartItem.track.id],
        }));

        // Re-fetch if running low on smart items
        const updatedState = get(store);
        const remainingSmartCount = updatedState.queue.filter((q) => q.source === 'smart').length;
        if (remainingSmartCount < 3) {
            await fetchNextTrack(state.currentTrack.id, true);
        }
    }

    // -------------------------------------------------------------------------
    // Persistence
    // -------------------------------------------------------------------------

    function persistState(): void {
        // Security fix C13 (fix round 1): the suppression check itself now
        // lives inside savePlaybackState() (music-playback-persistence.ts),
        // not here — this is persistState()'s only caller-side write path,
        // but savePlaybackState() is the actual storage boundary, and the
        // module-level `beforeunload` listener elsewhere in this file must
        // not be able to bypass it via a future second write path.
        //
        // Only the tab that last played writes the shared snapshot; a paused
        // or idle tab's copy is stale by definition (music-tab-sync.ts).
        if (tabSync && !tabSync.ownsSnapshot()) return;
        const state = get(store);
        savePlaybackState({
            autoplaySeed: state.autoplaySeed,
            playbackContext: state.playbackContext,
            currentTrack: state.currentTrack,
            position: state.currentTimeMs,
            queue: state.queue,
            history: state.history,
            volume: state.volume,
            wasPlaying: state.isPlaying,
            savedAt: Date.now(),
        });
    }

    async function hydrateFromPersistence(): Promise<void> {
        const persisted = loadPlaybackState();
        if (!persisted || !persisted.currentTrack) return;

        const track = persisted.currentTrack;
        const durationMs = track.durationMs ?? 0;
        // Defensive clamp: the persistence layer already clamps to
        // [0, duration-ε] and resets near-end to 0, but guard here too so a
        // near-end position can never immediately re-fire handleTrackEnded.
        const NEAR_END_EPSILON_MS = 2_000;
        const rawSavedPositionMs = persisted.position ?? 0;
        let savedPositionMs = Math.max(0, rawSavedPositionMs);
        if (durationMs > 0 && savedPositionMs >= durationMs - NEAR_END_EPSILON_MS) {
            savedPositionMs = 0;
        }

        // Set isPlaying immediately to match what we'll ask the backend to do,
        // preventing the UI from showing "paused" while audio is already playing.
        //
        // The snapshot is shared by every tab: "was playing" may describe a tab
        // that is STILL playing. Resuming here too would play the same track
        // twice, seconds apart — so ask first, and restore paused if it is.
        //
        // An owner that answers also knows the live position — the snapshot's
        // can be seconds old — so a paused restore lines up with the music.
        const owner = persisted.wasPlaying ? await tabSync?.queryOwner() : null;
        if (owner?.trackId === track.id) {
            savedPositionMs = Math.max(0, owner.positionMs);
            if (durationMs > 0 && savedPositionMs >= durationMs - NEAR_END_EPSILON_MS) {
                savedPositionMs = 0;
            }
        }
        const shouldResume = (persisted.wasPlaying ?? false) && !owner;
        if (shouldResume) {
            claimAudio('music');
            claimPlayback();
        }

        store.update((s) => ({
            ...s,
            currentTrack: track,
            currentTrackFeedback: feedbackForTrack(track),
            // Provenance is not persisted — restore as 'smart' so a reload
            // never fabricates manual intent the user didn't just express.
            currentTrackSource: 'smart',
            queue: persisted.queue,
            history: persisted.history,
            volume: persisted.volume,
            autoplaySeed: persisted.autoplaySeed,
            playbackContext: persisted.playbackContext,
            currentTimeMs: savedPositionMs,
            durationMs,
            progress: durationMs > 0 ? savedPositionMs / durationMs : 0,
            isPlaying: shouldResume,
            playingElsewhere: owner?.isPlaying === true,
        }));

        // Only a restore that plays starts a play session. A paused restore
        // (including a tab that mirrors another tab's playback) loads the
        // cookie URL: a start here would close the playing tab's session,
        // because one device has one music session.
        const restoreSrc = shouldResume
            ? await trackStreamUrl(track)
            : track.isRadio
              ? `/api/music/radio/${track.id}/stream`
              : `/api/music/tracks/${track.id}/stream`;
        const result = await backend?.preload(
            restoreSrc,
            {
                title: track.title,
                artist: track.artists.map((artist) => artist.title).join(', '),
                album: track.album?.title,
                artworkUrl: trackArtworkUrl(track),
            },
            savedPositionMs,
            // LUFS-normalize like every other playback path — the persisted
            // volume is the RAW user volume; passing it verbatim would resume
            // this track without loudness correction until the next track
            // switch/volume change re-syncs it.
            getPlaybackVolume(persisted.volume, track.audioFeatures?.loudnessLufs),
            shouldResume,
        );

        if (shouldResume && !result?.resumed) {
            // Browser blocked autoplay — correct the UI state, and retract the
            // claim so other tabs don't show "playing in another tab".
            store.update((s) => ({ ...s, isPlaying: false }));
            tabSync?.announceIdle();
        } else if (result?.resumed && !get(store).isPlaying) {
            // Paused while the preload was in flight — by the user, or by
            // another tab starting playback. The backend resumed anyway once
            // the source loaded, so the UI said "paused" over live audio.
            backend?.pause();
        } else if (result?.resumed) {
            if (track.id) startProgressReporting();
            // A restored playback is a playback: register it like play() does,
            // or it never shows in Active Streams or counts toward the limit.
            void startMusicSession(track);
        }

        await musicSettingsLoaded;
        void fetchNextTrack(track.id);

        // Current track: always fetch so feedback (liked/disliked) is synced
        // from the server even when client-side metadata is already complete.
        void syncCurrentTrackContext(track);
        // Queue items: metadata-only enrichment, early-returns when complete
        // to avoid N fetches on every hydrate.
        const enriched = new Set<string>([track.id]);
        for (const item of persisted.queue) {
            if (!enriched.has(item.track.id)) {
                enriched.add(item.track.id);
                void enrichQueueTrackMetadata(item.track);
            }
        }
    }

    // -------------------------------------------------------------------------
    // Crossfade settings
    // -------------------------------------------------------------------------

    // Keep this preference's writes ordered and prevent a late GET from
    // undoing an optimistic toggle. Other music preferences retain their flow.
    let beatPulseRevision = 0;
    let beatPulseWritesPending = 0;
    let beatPulseSaved = INITIAL_STATE.alwaysShowBeatPulse;
    let beatPulseWriteQueue: Promise<void> = Promise.resolve();

    async function loadMusicSettings(): Promise<void> {
        const beatRevisionAtLoad = beatPulseRevision;
        const beatWritePendingAtLoad = beatPulseWritesPending > 0;
        try {
            const { getPlaybackPreferences } = await import('$lib/api/user');
            const result = await getPlaybackPreferences();
            if (result.data) {
                const loudnessNormalizationEnabled =
                    result.data.musicLoudnessNormalizationEnabled ?? true;
                const canLoadBeatPulse =
                    beatRevisionAtLoad === beatPulseRevision &&
                    !beatWritePendingAtLoad &&
                    beatPulseWritesPending === 0;
                if (canLoadBeatPulse) {
                    beatPulseSaved = result.data.musicAlwaysShowBeatPulse ?? false;
                }
                store.update((s) => ({
                    ...s,
                    crossfadeEnabled: result.data!.musicCrossfadeEnabled ?? true,
                    crossfadeBeatsOverride: result.data!.musicCrossfadeBeats ?? null,
                    autoplayEnabled: result.data!.musicAutoplayEnabled ?? true,
                    showLoudnessDb: result.data!.musicShowLoudnessDb ?? false,
                    showBpm: result.data!.musicShowBpm ?? true,
                    alwaysShowBeatPulse: canLoadBeatPulse ? beatPulseSaved : s.alwaysShowBeatPulse,
                    loudnessNormalizationEnabled,
                }));
                const state = get(store);
                if (backend?.supportsVolumeControl && !state.isMuted) {
                    backend.setVolume(
                        loudnessNormalizationEnabled
                            ? applyLufsGain(
                                  state.volume,
                                  state.currentTrack?.audioFeatures?.loudnessLufs,
                              )
                            : state.volume,
                    );
                }
            }
        } catch (e) {
            console.warn('[MusicPlayer] Failed to load user settings', e);
        }
    }

    async function setCrossfadeEnabled(enabled: boolean): Promise<void> {
        store.update((s) => ({
            ...s,
            crossfadeEnabled: enabled,
            pendingCrossfadeAtMs: enabled ? s.pendingCrossfadeAtMs : null,
            pendingCrossfadeIsManual: enabled ? s.pendingCrossfadeIsManual : false,
        }));
        try {
            const { updatePlaybackPreferences } = await import('$lib/api/user');
            await updatePlaybackPreferences({
                musicCrossfadeEnabled: enabled,
            });
        } catch (e) {
            console.warn('[MusicPlayer] Failed to persist crossfade enabled setting', e);
        }
    }

    async function setShowLoudnessDb(enabled: boolean): Promise<void> {
        store.update((s) => ({ ...s, showLoudnessDb: enabled }));
        try {
            const { updatePlaybackPreferences } = await import('$lib/api/user');
            await updatePlaybackPreferences({ musicShowLoudnessDb: enabled });
        } catch (e) {
            console.warn('[MusicPlayer] Failed to persist loudness display setting', e);
        }
    }

    async function setShowBpm(enabled: boolean): Promise<void> {
        store.update((s) => ({ ...s, showBpm: enabled }));
        try {
            const { updatePlaybackPreferences } = await import('$lib/api/user');
            await updatePlaybackPreferences({ musicShowBpm: enabled });
        } catch (e) {
            console.warn('[MusicPlayer] Failed to persist BPM display setting', e);
        }
    }

    async function setAlwaysShowBeatPulse(enabled: boolean): Promise<void> {
        const revision = ++beatPulseRevision;
        beatPulseWritesPending++;
        store.update((s) => ({ ...s, alwaysShowBeatPulse: enabled }));
        const write = beatPulseWriteQueue.then(async () => {
            try {
                const { updatePlaybackPreferences } = await import('$lib/api/user');
                const result = await updatePlaybackPreferences({
                    musicAlwaysShowBeatPulse: enabled,
                });
                if (result.error) throw new Error(result.error);
                beatPulseSaved = enabled;
            } catch (e) {
                console.warn('[MusicPlayer] Failed to persist beat pulse setting', e);
                toasts.error('Could not save beat pulse setting. Please try again.');
                // A failed older write must not undo a newer choice queued
                // behind it. Only roll back the latest failed toggle.
                if (revision === beatPulseRevision) {
                    store.update((s) => ({ ...s, alwaysShowBeatPulse: beatPulseSaved }));
                }
            } finally {
                beatPulseWritesPending--;
            }
        });
        beatPulseWriteQueue = write;
        await write;
    }

    async function setLoudnessNormalizationEnabled(enabled: boolean): Promise<void> {
        const state = get(store);
        store.update((s) => ({ ...s, loudnessNormalizationEnabled: enabled }));
        if (backend?.supportsVolumeControl && !state.isMuted) {
            backend.setVolume(
                enabled
                    ? applyLufsGain(state.volume, state.currentTrack?.audioFeatures?.loudnessLufs)
                    : state.volume,
            );
        }
        try {
            const { updatePlaybackPreferences } = await import('$lib/api/user');
            await updatePlaybackPreferences({ musicLoudnessNormalizationEnabled: enabled });
        } catch (e) {
            console.warn('[MusicPlayer] Failed to persist loudness normalization setting', e);
        }
    }

    async function setCrossfadeBeats(beats: number | null): Promise<void> {
        // Clear the pending trigger so it's recomputed with the new beat count.
        // Without this, the crossfade would fire at the old trigger time.
        store.update((s) => ({
            ...s,
            crossfadeBeatsOverride: beats,
            pendingCrossfadeAtMs: null,
            pendingCrossfadeForTrackId: null,
            pendingCrossfadeIsManual: false,
        }));
        try {
            const { updatePlaybackPreferences } = await import('$lib/api/user');
            await updatePlaybackPreferences({
                musicCrossfadeBeats: beats,
            });
        } catch (e) {
            console.warn('[MusicPlayer] Failed to persist crossfade beats setting', e);
        }
    }

    function toggleCrossfadeDebug(): void {
        store.update((s) => {
            const next = !s.crossfadeDebug;
            try {
                localStorage.setItem('lumastra:crossfade-debug', String(next));
            } catch {
                /* expected: localStorage may be unavailable (private browsing) */
            }
            return { ...s, crossfadeDebug: next };
        });
    }

    /** Whether the active backend can route output to a selectable device. */
    function canSelectOutputDevice(): boolean {
        return backend?.supportsOutputSelection?.() === true;
    }

    /**
     * Switch audio output to the given device (sinkId; '' / 'default' =
     * system default). Persists the choice and reapplies it on next init.
     */
    async function setOutputDevice(deviceId: string): Promise<boolean> {
        if (!backend?.setOutputDevice) return false;
        const ok = await backend.setOutputDevice(deviceId);
        if (ok) {
            const isDefault = deviceId === '' || deviceId === 'default';
            store.update((s) => ({ ...s, audioOutputDeviceId: isDefault ? null : deviceId }));
            try {
                if (isDefault) localStorage.removeItem(OUTPUT_DEVICE_STORAGE_KEY);
                else localStorage.setItem(OUTPUT_DEVICE_STORAGE_KEY, deviceId);
            } catch {
                /* expected: localStorage may be unavailable (private browsing) */
            }
        }
        return ok;
    }

    /** Listening runway before the projected fade start during a fade test. */
    const FADE_TEST_LEAD_MS = 12_000;

    /**
     * Fade test (debug tool): play `outgoing` seeked to shortly before its
     * projected crossfade start with `incoming` queued next, so the REAL
     * trigger path (outro/vocal boundaries, downbeat snap, style selection)
     * runs audibly without sitting through the whole track. The seek target
     * mirrors checkCrossfadeTrigger's boundary math approximately — the
     * live trigger still decides exactly when and how to fade.
     */
    async function startFadeTest(outgoing: MusicTrack, incoming: MusicTrack): Promise<void> {
        await play(outgoing);
        // play() failed or the user raced another track in — abandon the test.
        if (get(store).currentTrack?.id !== outgoing.id) return;

        addToQueueFront(incoming);

        // Guarantee analysis features before computing the seek target
        // (play()'s own context sync is fire-and-forget), and enrich the
        // queued incoming track so the style decision sees its features too.
        await Promise.all([
            fetchAndApplyTrackPatch(outgoing, { applyUserContext: true }),
            fetchAndApplyTrackPatch(incoming, { applyUserContext: false }),
        ]);

        const state = get(store);
        if (state.currentTrack?.id !== outgoing.id) return;
        const durationMs =
            state.durationMs > 0
                ? state.durationMs
                : (state.currentTrack.durationMs ?? outgoing.durationMs ?? 0);
        if (durationMs <= 0) return;

        const af = state.currentTrack.audioFeatures;
        const inTrack = state.queue[0]?.id === incoming.id ? state.queue[0].track : incoming;
        const inAf = inTrack.audioFeatures;

        // Projected fade start — the same plan the trigger and the UI marker use.
        const projectedFadeStartMs = computeCrossfadePlan({
            outgoingAudioFeatures: af,
            incomingAudioFeatures: inAf,
            durationMs,
            incomingDurationSec: (inTrack.durationMs ?? 0) / 1000,
            crossfadeBeatsOverride: state.crossfadeBeatsOverride,
            mood:
                state.autoplaySeed?.type === 'mood'
                    ? state.autoplaySeed.mood?.toLowerCase()
                    : undefined,
        }).startMs;

        const target = Math.min(
            Math.max(0, projectedFadeStartMs - FADE_TEST_LEAD_MS),
            Math.max(0, durationMs - FADE_TEST_LEAD_MS),
        );
        if (target > 0) seekTo(target);
    }

    // Pending commit timer — cancelled on any explicit setFullScreen or
    // re-entry into commitSwipeFullScreen so stale callbacks can't stomp state.
    let swipeCompleteTimer: ReturnType<typeof setTimeout> | null = null;

    function setFullScreen(value: boolean): void {
        if (swipeCompleteTimer !== null) {
            clearTimeout(swipeCompleteTimer);
            swipeCompleteTimer = null;
        }
        store.update((s) => ({
            ...s,
            isFullScreen: value,
            fullScreenSwipeProgress: 0,
            fullScreenSwipeCompleting: false,
            fullScreenSuppressEntry: false,
        }));
    }

    function setFullScreenSwipeProgress(progress: number): void {
        store.update((s) => ({ ...s, fullScreenSwipeProgress: progress }));
    }

    // Commit a partial swipe-up into the full-screen state. Animates the
    // remaining distance smoothly via a CSS transition, then flips
    // `isFullScreen` to true while `fullScreenSuppressEntry` blocks the
    // .fullscreen-player slide-up keyframe (which would otherwise snap the
    // sheet down to translateY(100%) and visibly bounce back up). The
    // suppression persists until the next explicit `setFullScreen` call
    // (close or tap-to-open), so re-adding the class later never retriggers
    // the keyframe in this session.
    //
    // The sequencing is important: the CSS transition rule and the transform
    // target must not land in the same browser style-recalc frame, or
    // Chromium snaps to the new value instead of interpolating. We arm the
    // transition first, then set the target transform on the next animation
    // frame so the browser has already committed the `transition: 0.28s` rule.
    const SWIPE_COMPLETE_MS = 280;
    function commitSwipeFullScreen(): void {
        if (swipeCompleteTimer !== null) {
            clearTimeout(swipeCompleteTimer);
            swipeCompleteTimer = null;
        }
        // Phase 1: arm the transition. `fullScreenSwipeProgress` stays at its
        // current in-gesture value so the transform doesn't jump.
        store.update((s) => ({ ...s, fullScreenSwipeCompleting: true }));
        // Phase 2 (next frame): set the target — transform animates via the
        // now-active transition rule.
        const raf: (cb: () => void) => void =
            typeof requestAnimationFrame === 'function'
                ? (cb) => {
                      requestAnimationFrame(cb);
                  }
                : (cb) => {
                      setTimeout(cb, 16);
                  };
        raf(() => {
            store.update((s) => ({ ...s, fullScreenSwipeProgress: 1 }));
            swipeCompleteTimer = setTimeout(() => {
                swipeCompleteTimer = null;
                store.update((s) => ({
                    ...s,
                    isFullScreen: true,
                    fullScreenSwipeProgress: 0,
                    fullScreenSwipeCompleting: false,
                    fullScreenSuppressEntry: true,
                }));
            }, SWIPE_COMPLETE_MS);
        });
    }

    // Per-track starts are shared with prefetch and reporting.
    const AIRPLAY_RELOAD_TIMEOUT_MS = 3000;
    let startsEpoch = 0;
    let preparingAirPlay = false;
    let airPlayPrepare: { trackId: string; promise: Promise<void> } | null = null;
    const castStarts = new Set<string>();
    const musicStarts = new Map<string, Promise<PlaybackStartResponse>>();
    const grantDisposers = new Map<string, () => void>();
    const prefetchStarts = new Set<string>();
    const streamTokenRecovery = new StreamTokenRecoveryGate();

    function endUnusedMusicStart(id: string): Promise<unknown> {
        if (listeningSession?.id === id) return completeMusicSession();
        return cancelMusicPlayback(id);
    }

    function discardMusicStart(trackId: string, pending: Promise<PlaybackStartResponse>): void {
        musicStarts.delete(trackId);
        prefetchStarts.delete(trackId);
        if (prefetchedNextTrackId === trackId) prefetchedNextTrackId = null;
        grantDisposers.get(trackId)?.();
        grantDisposers.delete(trackId);
        castStarts.delete(trackId);
        void pending.then((start) => endUnusedMusicStart(start.playbackSessionId)).catch(() => {});
    }

    // Only speculative prefetches follow the queue. A direct play also prepares
    // a start while the old track is still displayed, and must retain that start.
    store.subscribe((state) => {
        if (prefetchedNextTrackId !== state.queue[0]?.track.id) prefetchedNextTrackId = null;
        for (const [trackId, pending] of musicStarts) {
            if (!prefetchStarts.has(trackId)) continue;
            if (trackId === state.currentTrack?.id || trackId === listeningSession?.trackId) {
                prefetchStarts.delete(trackId);
                continue;
            }
            if (trackId !== state.queue[0]?.track.id) discardMusicStart(trackId, pending);
        }
    });

    function clearMusicStreamToken(): void {
        startsEpoch++;
        musicStarts.forEach((pending) => {
            void pending
                .then((start) => endUnusedMusicStart(start.playbackSessionId))
                .catch(() => {});
        });
        grantDisposers.forEach((dispose) => dispose());
        grantDisposers.clear();
        musicStarts.clear();
        castStarts.clear();
        prefetchStarts.clear();
        prefetchedNextTrackId = null;
    }

    function musicStart(track: MusicTrack): Promise<PlaybackStartResponse> {
        const element = backend?.getAudioElement() as
            | {
                  webkitCurrentPlaybackTargetIsWireless?: boolean;
                  remote?: { state?: string };
              }
            | null
            | undefined;
        const castTarget =
            preparingAirPlay ||
            get(store).isAirPlayActive ||
            element?.webkitCurrentPlaybackTargetIsWireless === true ||
            element?.remote?.state === 'connected' ||
            element?.remote?.state === 'connecting';
        const existing = musicStarts.get(track.id);
        if (existing && (!castTarget || castStarts.has(track.id))) return existing;
        if (existing) {
            grantDisposers.get(track.id)?.();
            grantDisposers.delete(track.id);
            musicStarts.delete(track.id);
            void existing
                .then((start) => endUnusedMusicStart(start.playbackSessionId))
                .catch(() => {});
        }
        if (castTarget) castStarts.add(track.id);
        else castStarts.delete(track.id);
        const epoch = startsEpoch;
        const pending = Promise.resolve().then(async (): Promise<PlaybackStartResponse> => {
            const result = await startMusicPlaySession({
                trackId: track.id,
                deviceId: getDeviceId(),
                castTarget,
            });
            if (!result.data || result.data.delivery.kind !== 'file')
                throw new Error(result.error ?? 'Music start failed');
            const start = result.data;
            if (epoch !== startsEpoch) {
                void endUnusedMusicStart(start.playbackSessionId);
                throw new Error('Playback start cancelled');
            }
            if (musicStarts.get(track.id) === pending) {
                grantDisposers.set(
                    track.id,
                    maintainPlaybackGrant(start, async () => {
                        const state = get(store);
                        if (state.currentTrack?.id === track.id && start.delivery.kind === 'file') {
                            await backend?.reloadCurrentSrc(start.delivery.url, {
                                positionMs: state.currentTimeMs,
                                resume: state.isPlaying,
                            });
                        }
                    }),
                );
            }
            return start;
        });
        musicStarts.set(track.id, pending);
        void pending.catch(() => {
            if (musicStarts.get(track.id) === pending) musicStarts.delete(track.id);
        });
        return pending;
    }

    async function trackStreamUrl(
        track: MusicTrack,
        _opts: { forceToken?: boolean; waitForOutgoing?: boolean } = {},
    ): Promise<string> {
        // Radio is a cookie-authenticated proxy, outside library track starts.
        if (track.isRadio) return `/api/music/radio/${track.id}/stream`;
        // A cap-one preload/prefetch can be refused while the outgoing track owns
        // its slot, so only that speculative path waits for the terminal
        // acknowledgement. A user-initiated play must never block on it.
        if (_opts.waitForOutgoing) await pendingMusicCompletion;
        const start = await musicStart(track);
        if (start.delivery.kind !== 'file') throw new Error('Expected music file delivery');
        return start.delivery.url;
    }

    /** Recover a failed granted source once; an older secret reuses the current start. */
    async function recoverStreamToken(
        failedSrc: string,
        track = get(store).currentTrack,
    ): Promise<boolean> {
        if (!track || !streamTokenOf(failedSrc)) return false;
        const cached = musicStarts.get(track.id);
        if (cached) {
            const current = await cached.catch(() => null);
            if (current && current.grant.token !== streamTokenOf(failedSrc)) return true;
        }
        if (!streamTokenRecovery.tryAcquire()) return false;
        grantDisposers.get(track.id)?.();
        grantDisposers.delete(track.id);
        musicStarts.delete(track.id);
        try {
            await musicStart(track);
            await startMusicSession(track);
            return true;
        } catch {
            streamTokenRecovery.reset();
            return false;
        }
    }

    /**
     * backend.play() with one token-recovery retry. `isCurrent` reports whether
     * this load is still the one that matters after the re-mint await; if not,
     * the original error is rethrown for the caller's superseded-play handling.
     */
    async function playTrackWithTokenRecovery(
        track: MusicTrack,
        metadata: TrackMetadata,
        isCurrent: () => boolean,
    ): Promise<void> {
        const src = await trackStreamUrl(track);
        if (!isCurrent()) return;
        try {
            await backend?.play(src, metadata);
        } catch (err) {
            if (
                !get(store).isAirPlayActive ||
                (err instanceof MediaPlaybackError && err.code === 3) ||
                !(await recoverStreamToken(src, track)) ||
                !isCurrent()
            )
                throw err;
            console.warn('[MusicPlayer] stream failed on a tokenized URL — re-minted, retrying');
            await backend?.play(await trackStreamUrl(track), metadata);
        }
    }

    /**
     * Mid-stream failure of the current deck (onPlaybackError). Returns true
     * when a token recovery took over; false leaves it to the caller.
     */
    async function recoverCurrentStreamAfterError(): Promise<boolean> {
        const state = get(store);
        const track = state.currentTrack;
        // Read before any await: the error event fired for this deck.
        const failedSrc = backend?.getAudioElement()?.src ?? '';
        if (!track || !backend) return false;
        if (!(await recoverStreamToken(failedSrc))) return false;
        const now = get(store);
        // The user moved on during the mint: nothing left to repair.
        if (now.currentTrack?.id !== track.id) return true;
        console.warn('[MusicPlayer] stream failed on a tokenized URL — re-minted, reloading');
        // Position/play state from the store: after the error the element's
        // own currentTime/paused no longer describe where playback was. A
        // failed reload errors the element again and lands back in
        // handlePlaybackError, where the cooldown lets it fail normally.
        void backend.reloadCurrentSrc(await trackStreamUrl(track), {
            positionMs: now.currentTimeMs,
            resume: now.isPlaying,
        });
        return true;
    }

    /** Ensure the current track has its own granted URL before opening the AirPlay picker. */
    async function activateAirPlay(): Promise<boolean> {
        if (!getPickerElement()) return false;

        preparingAirPlay = true;
        try {
            const activeTrack = get(store).currentTrack;
            if (activeTrack) {
                try {
                    // Concurrent activations share one start: a second one would
                    // otherwise end the first one's listening session (releasing
                    // its start) and mint again.
                    const trackId = activeTrack.id;
                    if (airPlayPrepare?.trackId !== trackId) {
                        const promise = (async (): Promise<void> => {
                            await trackStreamUrl(activeTrack);
                            const start = await musicStart(activeTrack);
                            if (listeningSession?.id !== start.playbackSessionId) {
                                await startMusicSession(activeTrack);
                            }
                        })();
                        const entry = { trackId, promise };
                        airPlayPrepare = entry;
                        void promise
                            .catch(() => {})
                            .finally(() => {
                                if (airPlayPrepare === entry) airPlayPrepare = null;
                            });
                    }
                    await airPlayPrepare?.promise;
                } catch {
                    return false;
                }
            }

            // Reload current track with the granted URL so the AirPlay device can
            // fetch it without a session cookie.
            //
            // Route the reload through backend.reloadCurrentSrc() instead of mutating
            // the raw <audio> element's src/currentTime. The backend owns the audio
            // element (deck selection, currentMetadata, MediaSession handlers, wake
            // lock, keepalive) and, on a WebAudio backend, the MediaElementSource
            // graph — poking .src directly desyncs that internal state and can detach
            // the WebAudio node. reloadCurrentSrc swaps the URL on the active deck in
            // place while preserving position, play/pause state, and metadata.
            //
            // Skip the reload when the element already plays this track's token URL
            // (second click, e.g. to switch receivers or disconnect): re-assigning
            // the src while routed wireless makes the receiver drop and re-buffer the
            // stream, and the awaited play() can stall — the button then spins and
            // playback wedges. Only the CURRENT token counts: after a re-mint the old
            // one is dead, so the receiver needs the new URL anyway. Decided by
            // URL, not isAirPlayActive: a route engaged from Safari's own control
            // still sits on the cookie-authed URL and does need the reload.
            const currentTrack = get(store).currentTrack;
            const deck = getPickerElement();
            if (
                currentTrack &&
                deck &&
                backend &&
                !(await isTokenizedStreamFor(deck.src, currentTrack))
            ) {
                // Bounded: reloadCurrentSrc awaits play(), which may never settle
                // while a receiver negotiates — the button would spin forever and the
                // picker never open.
                let timer: ReturnType<typeof setTimeout> | undefined;
                await Promise.race([
                    backend
                        .reloadCurrentSrc(await trackStreamUrl(currentTrack, { forceToken: true }))
                        .catch(() => false),
                    new Promise<void>((resolve) => {
                        timer = setTimeout(resolve, AIRPLAY_RELOAD_TIMEOUT_MS);
                    }),
                ]);
                clearTimeout(timer);
            }

            // Re-read: the active deck can change across the awaits above
            // (gapless swap / crossfade promotion).
            const picker = getPickerElement();
            if (!picker) return false;
            picker.webkitShowPlaybackTargetPicker();
            return true;
        } finally {
            preparingAirPlay = false;
        }
    }

    function getPickerElement():
        (HTMLAudioElement & { webkitShowPlaybackTargetPicker: () => void }) | null {
        const el = backend?.getAudioElement() as
            (HTMLAudioElement & { webkitShowPlaybackTargetPicker?: () => void }) | null | undefined;
        return el?.webkitShowPlaybackTargetPicker
            ? (el as HTMLAudioElement & { webkitShowPlaybackTargetPicker: () => void })
            : null;
    }

    /** True when `src` is the /api/v1 stream of `track` carrying the current token. */
    async function isTokenizedStreamFor(src: string, track: MusicTrack): Promise<boolean> {
        if (!src) return false;
        const wanted = await trackStreamUrl(track);
        const current = new URL(src, 'http://local');
        const target = new URL(wanted, current.origin);
        return current.pathname === target.pathname && current.search === target.search;
    }

    // Register beforeunload to persist current position and complete session
    if (typeof window !== 'undefined') {
        // iOS Safari and discarded tabs skip beforeunload; pagehide still fires.
        window.addEventListener('online', () => void flushMusicReplays());
        window.addEventListener('pagehide', () => {
            tabSync?.announceClosed();
            void completeMusicSession('unload', true);
        });
        // Back from the back/forward cache: the claim was released on the way
        // out — learn who owns playback now instead of assuming it is us.
        window.addEventListener('pageshow', (event) => {
            if (event.persisted) void tabSync?.queryOwner();
        });
        window.addEventListener('beforeunload', () => {
            persistState();
            // Release the claim in the other tabs: their controls then act
            // locally instead of commanding a tab that is gone.
            tabSync?.announceClosed();
            void completeMusicSession('unload', true);
        });
    }

    return {
        subscribe: store.subscribe,
        // Test-only: lets vitest specs drive state without going through the
        // curated action API. Stripped from production builds via DEV check.
        ...(import.meta.env.DEV
            ? {
                  _updateForTest: store.update,
                  _startMusicSessionForTest: startMusicSession,
                  _resetAirPlayTokenForTest: () => {
                      clearMusicStreamToken();
                      streamTokenRecovery.reset();
                  },
              }
            : {}),
        init,
        destroy,
        play,
        pause: userPause,
        resume,
        skip: userSkip,
        mixNow,
        previous: userPrevious,
        seekTo: userSeekTo,
        setVolume: userSetVolume,
        toggleMute: userToggleMute,
        toggleExpanded,
        setActivePanel,
        addToQueue: (track: MusicTrack, sessionId?: string) =>
            withQueueSync(() => addToQueue(track, sessionId), { op: 'add', track, sessionId }),
        addToQueueFront: (track: MusicTrack) =>
            withQueueSync(() => addToQueueFront(track), { op: 'add-front', track }),
        reorderQueue: (items: QueueItem[]) =>
            withQueueSync(() => reorderQueue(items), { op: 'order', ids: items.map((i) => i.id) }),
        removeFromQueue: (itemId: string) =>
            withQueueSync(() => removeFromQueue(itemId), { op: 'remove', id: itemId }),
        refreshSmartQueue,
        enqueueFromBrew,
        addSmartItem,
        getSuggestionCandidates,
        setLyricsStatus,
        startPlayback,
        clearQueue,
        switchToSmartQueue,
        stop,
        likeCurrentTrack,
        dislikeCurrentTrack,
        toggleAutoplay,
        seedAutoplay,
        clearAutoplaySeed,
        setPlaybackContext,
        clearPlaybackContext,
        dismissSmartItem,
        hydrateFromPersistence,
        loadMusicSettings,
        setCrossfadeEnabled,
        setShowLoudnessDb,
        setShowBpm,
        setAlwaysShowBeatPulse,
        setLoudnessNormalizationEnabled,
        setCrossfadeBeats,
        toggleCrossfadeDebug,
        startFadeTest,
        canSelectOutputDevice,
        setOutputDevice,
        setFullScreen,
        setFullScreenSwipeProgress,
        commitSwipeFullScreen,
        activateAirPlay,
    };
}

// ============================================================================
// Singleton export
// ============================================================================

export const musicPlayerStore = createMusicPlayerStore();

// Expose store on window in dev/test mode for Playwright E2E access. A production
// build gets it only when built with VITE_E2E_HOOKS=true (playwright.music.config.ts);
// otherwise Vite folds the condition to false and drops the block.
if (
    typeof window !== 'undefined' &&
    (import.meta.env.DEV || import.meta.env.VITE_E2E_HOOKS === 'true')
) {
    (
        window as Window & {
            __musicPlayerStore?: typeof musicPlayerStore;
            __getSeedCrossfadeBeats?: typeof getSeedCrossfadeBeats;
        }
    ).__musicPlayerStore = musicPlayerStore;
    (
        window as Window & {
            __getSeedCrossfadeBeats?: typeof getSeedCrossfadeBeats;
        }
    ).__getSeedCrossfadeBeats = getSeedCrossfadeBeats;
}

// ============================================================================
// Derived stores
// ============================================================================

/**
 * True when crossfade will actually fire on the next eligible track boundary.
 *
 * Equivalent to `crossfadeEnabled && supportsCrossfade && !isAirPlayActive`.
 * UI predictive surfaces (countdowns, zone markers, "Up Next" preview,
 * technique badges) should consume this rather than `crossfadeEnabled` alone —
 * otherwise they advertise a blend that will not happen while AirPlay is active
 * or on a backend that cannot crossfade (iOS PlainAudioBackend).
 *
 * Reactive UI that reflects an in-progress fade (`isCrossfading`) is
 * independent of this — let those keep using `isCrossfading` directly.
 */
export const crossfadeEffective = derived(
    musicPlayerStore,
    ($s) => $s.crossfadeEnabled && $s.supportsCrossfade && !$s.isAirPlayActive,
);

/** True when the mini-player bar should be rendered. */
export const isMinPlayerVisible = derived(musicPlayerStore, ($s) => $s.currentTrack !== null);

/** Formatted current time as mm:ss. */
export const formattedCurrentTime = derived(musicPlayerStore, ($s) => {
    const totalSeconds = Math.floor($s.currentTimeMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
});

/** Formatted total duration as mm:ss. */
export const formattedDuration = derived(musicPlayerStore, ($s) => {
    const totalSeconds = Math.floor($s.durationMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
});

/**
 * Current chapter under the playhead, plus its index and the total chapter
 * count. `null` when the track has no chapters or the playhead sits before
 * the first chapter. Recomputes on every time-update — keep read sites inside
 * components that already re-render with the store.
 */
export const currentChapter = derived(musicPlayerStore, ($s) => {
    const chapters = $s.currentTrack?.chapters;
    if (!chapters || chapters.length === 0) return null;
    const match = findChapterAtMs(chapters, $s.currentTimeMs);
    if (!match) return null;
    return {
        chapter: match.chapter,
        index: match.index,
        total: chapters.length,
    };
});

/**
 * The chapter immediately after the one currently playing. `null` on the last
 * chapter, or when the track has no chapters.
 */
export const nextChapter = derived(musicPlayerStore, ($s) => {
    const chapters = $s.currentTrack?.chapters;
    if (!chapters || chapters.length === 0) return null;
    return getNextChapter(chapters, $s.currentTimeMs);
});

// ============================================================================
// Radio now-playing poller
// ============================================================================

/** Current DJ / show info for a live radio station. Null when not on radio. */
export const currentRadioNowPlaying = writable<RadioNowPlaying | null>(null);

let radioPollTimer: ReturnType<typeof setInterval> | null = null;
let radioPollStationId: string | null = null;

function stopRadioPoll(): void {
    if (radioPollTimer !== null) {
        clearInterval(radioPollTimer);
        radioPollTimer = null;
    }
    radioPollStationId = null;
    currentRadioNowPlaying.set(null);
}

async function pollRadio(stationId: string): Promise<void> {
    if (typeof document !== 'undefined' && document.hidden) return;
    const { data } = await apiGet(
        `/api/music/radio/${stationId}/now-playing`,
        RadioNowPlayingResponseSchema,
    );
    if (data) currentRadioNowPlaying.set(data);
}

function startRadioPoll(stationId: string): void {
    if (radioPollStationId === stationId) return;
    stopRadioPoll();
    radioPollStationId = stationId;
    void pollRadio(stationId);
    radioPollTimer = setInterval(() => void pollRadio(stationId), 20_000);
}

// React to currentTrack changes — start/stop polling automatically.
musicPlayerStore.subscribe((state) => {
    const track = state.currentTrack;
    if (track?.isRadio && track.id) {
        startRadioPoll(track.id);
    } else {
        stopRadioPoll();
    }
});
