// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PlayerController — extracted logic from VideoPlayer.svelte
 *
 * This class owns all reactive state, derived values, utility methods,
 * playback initialization, subtitle management, event handlers, and
 * control functions that were previously inlined in VideoPlayer.svelte.
 *
 * VideoPlayer.svelte becomes a thin shell that instantiates this class,
 * binds DOM elements, and renders child components.
 */

import { LiveTvStartupDeadline } from './livetv-startup-deadline.js';
import { SvelteMap, SvelteSet, SvelteURL } from 'svelte/reactivity';
import { browser } from '$app/environment';
import { goto, pushState } from '$app/navigation';
import { base as basePath, resolve } from '$lib/paths';
import { invalidateWhenIdle } from '$lib/utils/invalidate-when-idle';
import { audioTrackRole } from '$lib/shared/track-selection';
import {
    isUnknownLanguage,
    languageMatchScore,
    normalizeLanguage,
} from '$lib/shared/language-codes';
import { playerStore } from './playerStore.svelte';
import { encoderExplainsWaiting } from './transcode-progress-view';
import { toasts } from '$lib/stores/toast.store';
import { playerSkipSeconds } from '$lib/stores/client-tuning';
import { watchTogether } from '$lib/stores/watchTogether.svelte';
import { readWatchEntry, type WatchEntry } from '$lib/stores/watch-entry';
import {
    detectCapabilities,
    canPlayDirectly,
    getCapabilities,
    getPathScopedCapabilities,
    ensurePathScopedCapabilities,
    serializePathScopedCaps,
    type BrowserCapabilities,
} from './browserCapabilities.svelte';
import type {
    PlaybackInfo,
    MediaSourceInfo,
    PlaybackVariant,
    SubtitleStreamInfo,
    QualityMode,
    TranscodingProfile,
    NextEpisodeInfo,
} from '$lib/types/playback';
import {
    selectPlayerProbe,
    probeTrackRecommendation,
    type PlayerProbe,
    type ProbeVersion,
    type PlayerMethod,
} from './player-probe';
import { formatBitrateInfo } from '$lib/utils/media-display.js';
import { probePlayability } from '$lib/api/playback.js';
import { shouldForceTranscode } from './playback-decision';
import { needsAudioTranscodeForBrowser } from './codec-support';
import {
    subtitleRequiresBurnIn as checkSubtitleRequiresBurnIn,
    isPgsSubtitle as checkIsPgsSubtitle,
    isAssSubtitle as checkIsAssSubtitle,
    isVobsubSubtitle as checkIsVobsubSubtitle,
    isAssCodec,
    isBurnInCodec,
    positionSubtitleCues,
    calculateSubtitleOverlayFontSize,
} from './subtitle-utils';
import {
    buildStreamUrl as buildStreamUrlFromModule,
    type StreamUrlContext,
} from './stream-url-builder';
import { selectRebuildStreamSource } from './rebuild-stream-source';
import type { PlaybackStartResponse, PlaybackCapabilities } from '$lib/schemas/playback-start.js';
import { getDeviceId } from './device-id';
import {
    initializePreferences,
    getPreferences,
    updatePreferences,
    selectionPreferenceSnapshot,
} from './preferences-sync.svelte';
import { createSubtitleRendererManager, type SubtitleRendererManager } from './subtitle-renderer';
import type { IProgressReporter } from './progress-reporter.types';
import type { ClientSubtitleMethod } from '$lib/schemas/playback-plan.js';
import { PlaySessionReporter } from './play-session-reporter';
import { buildReauthUrl, claimReauthReload, probeBrowserSession } from './session-reauth';
import { SameBrowserChannel } from './same-browser-channel';
import { ReconnectController, type ReconnectCause } from './reconnect-controller';
import { RestartQueue, type RestartResume } from './restart-queue';
import { languagesMatch } from '$lib/shared/language-codes';
import { StreamBitrateMeter, decodedResolution } from './stream-bitrate';
import { buildSubtitleDisplayTitle } from './language-utils';
import { getLocale } from '$lib/paraglide/runtime.js';
import { triage410, triageNetworkStatus, decideRecovery } from './reconnect-policy';
import { describeInfoRefusal } from './playback-refusal';
import {
    isStreamTokenUsable,
    StreamTokenRecoveryGate,
    streamTokenOf,
} from '$lib/utils/stream-token-recovery';
import { selectAudioOnlyMethod } from './audio-only-selection';
import { shouldAdvanceInPlace } from './audio-only-advance';
import {
    classifyHttpPlaybackDiagnostic,
    type PlaybackFailureStage,
    type StreamDiagnosticCode,
} from '$lib/utils/playback-diagnostics';
import * as m from '$lib/paraglide/messages';
import { serverCapabilities } from '$lib/stores/server-capabilities.store';
import {
    createPlaybackManager,
    type PlaybackError,
    type CodecDetectionResult,
    type AutoplayResult,
} from './playback-manager';
import type { PlaybackManager } from './playback-manager';
import { AUDIO_ONLY_HLS_BUFFER_SETTINGS, type HlsVodBufferSettings } from './hls-config';
import { applyPlaybackResumedReset } from './playback-resumed-reset';
import { TelemetryController } from './telemetry.controller';
import { bufferAheadSeconds } from './telemetry';
import { AbrController } from './abr.controller';
import { MediaSessionController } from './media-session.controller';
import { WatchTogetherController } from './watch-together.controller';
import { WakeLockController } from './wake-lock.controller';
import { requestWakeLock } from '$lib/utils/wake-lock';
import { safeRandomUUID } from '$lib/utils/safe-uuid';
import { asInternalUuid } from '$lib/utils/id-patterns';
import { getCatalogLogoUrl } from '$lib/utils/image-utils';
import { createOsdIndicatorStore } from './osd-indicators.svelte';
import {
    playbackPreferences,
    DEFAULT_SUBTITLE_STYLE,
    type SubtitleStyleSettings,
} from './preferences-sync.svelte';
import type { AnnotationData } from '$lib/types/media-annotations';
import {
    detectDoubleTap,
    updateSkipAnimation,
    createDoubleTapState,
    type DoubleTapState,
    type SkipAnimationState,
} from './video-input';
import { VideoShortcuts, type KeyboardState } from './VideoShortcuts';
import {
    initFaviconController,
    setPlaybackState,
    stopPlayingAnimation,
    restoreOriginalTitle,
} from '$lib/utils/favicon-controller';
import {
    clearVideoSource,
    generatePlaySessionId,
    createPositionRestoreHandler,
} from './playback-restart';
import { playbackIncidentEvent } from '$lib/client-diagnostics/playback-incident.js';
import { LiveTvHeartbeat } from './livetv-heartbeat';
import {
    restartForBitrateChange,
    restartForSeekPosition,
    restartForVersionChange,
    RESTART_TIMING,
    type RestartContext,
    type StopPlaybackCallbacks,
    type SessionCallbacks,
    type UICallbacks,
} from './restart-orchestrator';
import { calculateWheelVolumeDelta, clampVolume } from './volume-control';
import { playerWheelAction } from './player-wheel';
import { asSafariVideo } from './safari-types';
import { TIMING, SEEK, SUBTITLE, FRAME, PLAYER_ERRORS } from './timing-constants';
import type { NativeBandwidthEstimator } from './native-bandwidth';
import { tick } from 'svelte';
import {
    setResumeEntry,
    getResumeEntry,
    clearResumeEntry,
} from '$lib/utils/playback-progress-cache';
import { clampStartToPlayable, resolveResumePosition } from '$lib/utils/resume-resolver';
import { getPlaybackContext } from '$lib/api/playlists.js';
import { getNextEpisodeAfterPlayback } from '$lib/api/content.js';
import {
    getStreamInfoWithLimitCheck,
    getPlaybackSessionFailure,
    claimPlaybackSession,
    leaveChannel,
} from '$lib/api/livetv-playback.js';
import { liveTvSimpleContext } from '$lib/components/livetv/simple/simple-context.svelte.js';
import { nextLiveTvRetry, nextStationId, type LiveTvFailureView } from './livetv-failure-retry.js';
import {
    LIVETV_SUSTAINED_PLAYBACK_MS,
    clearLiveTvRetryBudget,
    readLiveTvRetryBudget,
    writeLiveTvRetryBudget,
} from './livetv-retry-budget';
import type { PlaybackSessionStartResponse } from '$lib/schemas/livetv-playback-sessions.js';
import { getPreferredFeed, clearPreferredFeed } from '$lib/components/livetv/feed-preference.js';
import type { LiveHlsDelivery } from '$lib/schemas/livetv-delivery.js';
import { appliedLiveTvProfile, liveTvQualityState } from './livetv-quality.js';
import {
    IncidentRingBuffer,
    PLAYBACK_INCIDENT_BUFFER_MAX_ENTRIES,
    PLAYBACK_INCIDENT_BUFFER_MAX_AGE_MS,
} from './incident-buffer.js';
import { IncidentReporter } from './incident-reporter.js';
import { adoptsPauseAsUserIntent, buildTransportDetail } from './pause-provenance.js';
import {
    getLiveTvChannels,
    reportPlaybackIncident,
    resolvePlaybackIncident,
} from '$lib/api/playback.js';
import type { PlaybackIncidentReportInput } from '$lib/schemas/playback.js';
import { apiUrl } from '$lib/shared/api-urls.js';
import {
    getLiveTvQualityPreference,
    setLiveTvQualityPreference,
    type LiveTvQualityChoice,
} from './livetv-quality-preference.js';
import { LIVE_TV_QUALITY_PROFILES, liveTvRungIdForProfile } from './livetv-quality.js';
import { buildAdaptiveReport } from './adaptive-report.js';
import {
    liveTvBlockCauseForKill,
    liveTvBlockCauseForPolicy,
    liveTvBlockPresentation,
    liveTvFailurePresentation,
    type LiveTvBlockPresentation,
} from './livetv-failure-presentation.js';
import { AUTO_PROFILE } from '$lib/types/playback.js';
import { mapLumastraAudioStreams } from './lumastra-track-mapping';
import { shouldPersistVolumeChange, startupMuted } from './startup-mute.js';

function isSelectedFileDelivery(
    delivery: PlaybackStartResponse['delivery'],
    probe: PlayerProbe,
): delivery is Extract<PlaybackStartResponse['delivery'], { kind: 'file' | 'hls' }> {
    return (
        (delivery.kind === 'file' || delivery.kind === 'hls') &&
        delivery.fileId === probe.activeFileId
    );
}

// ============================================================================
// Lumastra method → PlayMethod mapping
// ============================================================================

type LumastraMethod = PlayerMethod;
type PlayMethod = 'DirectPlay' | 'DirectStream' | 'Transcode' | 'AudioOnly';

function lumastraMethodToPlayMethod(method: LumastraMethod): PlayMethod {
    if (method === 'direct') return 'DirectPlay';
    if (method === 'full_transcode') return 'Transcode';
    // Without this arm the audio-only rung fell into the `DirectStream`
    // catch-all, so the quality menu rendered a "Remux" badge next to the
    // selected "Audio only" row.
    if (method === 'audio_only') return 'AudioOnly';
    return 'DirectStream';
}

// ============================================================================
// Props Interface
// ============================================================================

export interface VideoPlayerProps {
    playbackInfo: PlaybackInfo;
    username: string;
    userId: string;
    avatarUrl?: string;
    autoPlay?: boolean;
    isContinuation?: boolean;
    initialSourceId?: string | undefined;
    initialStartTime?: number | undefined;
    autoQualityEnabled?: boolean;
    defaultQualityMode?: 'original' | 'auto';
    hlsVodBufferSettings?: HlsVodBufferSettings;
    subtitleSizeMultiplier?: number;
    subtitlePgsScale?: number;
    subtitleSrtScale?: number;
    /** Seconds before the credits/outro start to show the next-episode prompt (signed; admin-configured). */
    nextEpisodePromptLeadSeconds?: number;
    volumeCurve?: 'linear' | 'quadratic' | 'quartic';
    playlistContext?: { playlistId: number; position: number } | undefined;
    enableAirPlay?: boolean;
    showAnnotations?: boolean;
    showChat?: boolean;
    annotationsMaxPins?: number;
    annotationsIsAdmin?: boolean;
    annotationsMediaTitle?: string;
    mediaDbId?: string;
    /** Callback when playback ends */
    onended?: () => void;
    /** Callback when error occurs */
    onerror?: (data: { message: string }) => void;
    /** Callback when back is clicked */
    onback?: () => void;
    /** Callback when version/source changes (fileId for Lumastra, mediaSourceId for Jellyfin compat) */
    onversionchange?: (fileId: string) => void;
    /** Callback when next episode is clicked */
    onnextepisode?: (data: { itemId: string }) => void;
    /** Callback when next playlist item is clicked */
    onnextplaylistitem?: (data: { itemId: string; playlistId: number; position: number }) => void;
}

// ============================================================================
// SeekSource type
// ============================================================================

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

// ============================================================================
// WatchTogetherToast handle guard
// ============================================================================

function lumastraHdrToVideoRangeType(hdr: string | null | undefined): string {
    switch (hdr) {
        case 'sdr':
            return 'SDR';
        case 'dovi':
            return 'DOVI';
        case 'dovi_hdr10':
            return 'DOVIWithHDR10';
        case 'hdr10plus':
            return 'HDR10Plus';
        case 'hlg':
            return 'HLG';
        case 'hdr10':
            return 'HDR10';
        default:
            return hdr?.toUpperCase() ?? 'SDR';
    }
}
// Note: lumastraHdrToVideoRangeType maps to Jellyfin videoRangeType enum values
// (DOVIWithHDR10, HDR10Plus, etc.) — intentionally different from the shared
// formatHdrLabel() which maps to display labels (DV P8, HDR10+, etc.)

// ============================================================================
// PlayerController class
// ============================================================================

/** How a Live TV re-join ended; see PlayerController.recoverLiveTvStream. */
type LiveTvRejoinOutcome = 'recovered' | 'superseded' | 'exhausted';

/** The playback this preparation belonged to was replaced; not a playback failure. */
export class PlaybackSupersededError extends Error {
    constructor() {
        super('Playback preparation superseded');
        this.name = 'PlaybackSupersededError';
    }
}

export class PlayerController {
    // ---- Props (declared first so $derived fields can reference it) ----
    props!: VideoPlayerProps;

    // ---- Constants ----
    readonly DEBUG = false;
    readonly DEBUG_SUBTITLES = false;
    readonly SUBTITLE_REFERENCE_HEIGHT = 1080;
    readonly WATCH_PARTY_STORAGE_KEY = 'dashboard_watch_party';
    readonly SPEED_LEVELS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

    // ---- Reactive state ($state) — only fields read in template or $derived ----
    videoElement: HTMLVideoElement | undefined = $state();
    playerContainer: HTMLDivElement | undefined = $state();
    watchTogetherToast: unknown = $state(null);
    playbackProbe = $state<PlayerProbe | null>(null);
    lumastraFileId = $state<string | null>(null);
    caps = $state<BrowserCapabilities | null>(null);
    logoLoaded: boolean = $state(false);
    showChannelSwitcher: boolean = $state(false);
    showMovieSidebar: boolean = $state(false);
    showEpisodeBrowser: boolean = $state(false);
    showPlaylistBrowser: boolean = $state(false);
    showReactionPicker: boolean = $state(false);
    showWatchPartySearch: boolean = $state(false);
    watchPartyPanelOpen: boolean = $state(false);
    showAnnotationsSidebar: boolean = $state(false);
    annotationPins: AnnotationData[] = $state([]);
    liveTvFailure = $state<{
        type: 'source_down' | 'connection_lost' | 'heartbeat_lost' | 'kicked' | 'stream_failed';
        diagnostic?: string;
        /** Typed reason + retry state, set with `stream_failed`. */
        failure?: LiveTvFailureView;
        /**
         * Cause-specific copy for the terminal 'kicked' overlay. Absent means
         * the priority-eviction default — set it for every other cause, or the
         * overlay claims a higher-priority viewer took the slot when none did.
         */
        blocked?: LiveTvBlockPresentation;
    } | null>(null);
    // When a terminal failure has a specific, known cause (e.g. a 404 = file not
    // found), stash the message here so the terminal overlay shows it instead of
    // the generic "session ended" / connection-lost text. Consumed + cleared in
    // the reconnect onStateChange('terminal') handler.
    private pendingTerminalMessage: string | null = null;
    /** Localized reason the last playability probe was refused (404 / plugin veto). */
    private lastProbeRefusal: string | null = null;
    /** A provisional detail captured from the HLS error before recovery enters
     *  its synchronous state callback. Cleared once shown. */
    private pendingReconnectDiagnostic: string | null = null;
    /**
     * Stage of the network failure that started the current reconnect, so
     * `reconnectAttempt` can skip the nudge ladder for a manifest-stage
     * failure (a nudge cannot re-request a manifest). Cleared whenever the
     * reconnect controller leaves `recovering`.
     */
    private lastNetworkFailureStage: PlaybackFailureStage | null = null;
    /** Invalidates an in-flight reachability probe when playback recovers,
     *  changes item, or a newer network error supersedes it. */
    private reconnectDiagnosticEpoch = 0;
    playerControlsRef = $state<{
        closeAllMenus?: () => boolean;
        hasOpenMenu?: () => boolean;
    } | null>(null);
    showSearch: boolean = $state(false);
    showWatchPartyBackConfirm: boolean = $state(false);
    skipAnimation = $state<SkipAnimationState | null>(null);
    cancelTrigger: number = $state(0);
    showAutoplayMutedPrompt: boolean = $state(false);
    /** The player muted itself (autoplay fallback); not saved as the user's mute. */
    mutedByAutoplayFallback = false;
    showAutoplayTutorial: boolean = $state(false);
    isAirplayActive: boolean = $state(false);
    videoHeight: number = $state(this.SUBTITLE_REFERENCE_HEIGHT);
    activeSrtCue: string | null = $state(null);
    /** Tab-conflict modal visibility — bound by VideoPlayer.svelte. */
    tabConflictVisible: boolean = $state(false);
    /** iOS native fullscreen can only render the video element's text tracks. */
    isIOSNativeFullscreen: boolean = $state(false);

    // ---- Plain fields (not read in templates, only used imperatively) ----
    playbackManager: PlaybackManager | null = null;
    subtitleRenderer: SubtitleRendererManager | null = null;
    private nativeSubtitleFailure = $state<{
        index: number;
        sourceId: string;
        revision: number;
    } | null>(null);
    private subtitleRendererGeneration = 0;
    private cancelSubtitleWork: (() => void) | null = null;
    private subtitleInitializationFailure = $state<{
        index: number;
        sourceId: string;
        href: string | undefined;
        revision: number;
    } | null>(null);
    resizeObserver: ResizeObserver | null = $state.raw(null);
    isInitialized: boolean = false;
    startupPositionResolved = $state(false);
    /** Releases this controller's playerStore.bindExternalControl handle. */
    private unbindExternalControl: (() => void) | null = null;
    wasKicked: boolean = false;
    liveTvHeartbeat: LiveTvHeartbeat | null = null;
    private liveTvSessionId: string | null = null;
    private liveTvFeedId: string | undefined;
    liveTvCurrentFeedId = $state<string | undefined>();
    // Sub-controllers
    readonly telemetryCtrl: TelemetryController;
    readonly abrCtrl: AbrController;
    readonly mediaSessionCtrl: MediaSessionController;
    lastMediaSessionPositionUpdate = 0;
    readonly watchTogetherCtrl: WatchTogetherController;
    wakeLockCtrl: WakeLockController | null = null;
    /** Fresh per playback attempt (constructed in mount()'s asyncInit) —
     *  see playerStore.attemptId's doc comment for why this is NOT rebuilt
     *  on reconnect. */
    private incidentBuffer: IncidentRingBuffer | null = null;
    private incidentReporter: IncidentReporter | null = null;
    nativeTrackToSubtitleIndex: SvelteMap<TextTrack, number> = new SvelteMap();
    pendingShowTimeouts: SvelteSet<ReturnType<typeof setTimeout>> = new SvelteSet();
    // Derived from playbackPreferences — no $effect sync needed
    readonly subtitleStyle: SubtitleStyleSettings = $derived(
        playbackPreferences.subtitleStyle || DEFAULT_SUBTITLE_STYLE,
    );

    // ---- Comparison bookkeeping (plain fields, NOT $state — only used for
    //      dedup comparisons in $effect blocks, never in templates or $derived) ----
    previousSubtitleIndex: number | null = null;
    lastAppliedPlaybackRate: number = 1;
    lastMediaSourceId: string | null = null;
    lastAppliedPositionY: number | null = null;
    lastAppliedOverlayMode: boolean | null = null;
    lastInjectedCSS: string = '';
    lastAppliedStyle: string | null = null;

    // ---- Plain (non-reactive) fields ----
    progressReporter: IProgressReporter | null = null;
    /**
     * Same-browser tab coordination. Created alongside the progressReporter
     * so we can probe other tabs before the first `start` report. Null on
     * environments without BroadcastChannel — the probe-and-modal path is
     * graceful (no-op probe → no conflict found → proceed); phases 1+2
     * (server-side supersede + heartbeat backstop) cover the gap.
     */
    sameBrowserChannel: SameBrowserChannel | null = null;
    /**
     * Resolved by the user's choice in the tab-conflict modal. While the
     * modal is up, `pendingTabConflict` holds the resolver so other code
     * paths (eg. a parallel teardown) can dismiss it deterministically.
     */
    pendingTabConflict: ((proceed: boolean) => void) | null = null;
    /**
     * One-shot guard so the probe runs exactly once per controller life.
     * Quality-restart and source-switching reuse the controller and call
     * `reportProgress('start')` again — those are NOT new tabs and must
     * not re-probe (they would always conflict with their own active state).
     */
    private hasProbedSameBrowser: boolean = false;
    /**
     * In-flight probe-and-modal promise. Held so a second `reportProgress`
     * call (e.g., onPlaying racing onSeeked or quality-restart) awaits the
     * SAME decision instead of slipping past the gate. Resolves to:
     *   - true  → user picked Continue (or no conflict / unsupported)
     *   - false → user picked Cancel
     */
    private probeAndModalPromise: Promise<boolean> | null = null;
    /**
     * Set true when the user picks Cancel in the tab-conflict modal. While
     * set, ALL `reportProgress` calls are no-ops — without this, the next
     * progress-interval tick would call `restartSessionAndResend` and
     * silently re-attempt the start the user just declined.
     */
    private userCancelledTabConflict: boolean = false;
    directPlayFailed: boolean = false;
    hasResumedInitialPosition: boolean = false;
    hasFiredInitialPositionHeartbeat: boolean = false;
    /**
     * Gate that suppresses interval 'progress' heartbeats until a real
     * position has been confirmed (via onSeeked or the onTimeUpdate
     * initial-position block). Prevents position=0 heartbeats from leaking
     * during initial buffering before the resume seek lands.
     *
     * Once true, every subsequent progress event flows regardless of
     * direction. Reset alongside hasFiredInitialPositionHeartbeat on
     * session rollover (resetEngagementTracking).
     */
    hasReportedRealPosition: boolean = false;
    // Overridable $derived (Svelte 5.25+): derives from props but can be
    // temporarily reassigned (e.g., when merging playlist context in mount()).
    // Resets to props.playbackInfo when the prop changes.
    // Note: props is declared before this field so the reference is safe.
    currentPlaybackInfo: PlaybackInfo = $derived(this.props.playbackInfo);
    // Same overridable-$derived pattern as currentPlaybackInfo, for the item id
    // used to fetch playability / same-browser-tab identity / AirPlay tokens.
    // Without this, every one of those consumers stays pinned to the ORIGINAL
    // item after an in-place episode advance (advanceEpisodeInPlace), since
    // `props` itself never changes for the life of an un-remounted component.
    currentMediaDbId: string | undefined = $derived(this.props.mediaDbId);
    /** The play method actually in force. Never assign directly — use
     *  setLumastraPlayMethod(), which is the single write path that keeps the
     *  play-session reporter in sync (see its doc comment). */
    lumastraPlayMethod: PlayerMethod | null = null;
    lumastraProgressIntervalRef: ReturnType<typeof setInterval> | null = null;
    isSwitchingVersion: boolean = false;

    /**
     * Engagement tracking (drives server-side Continue Watching signal).
     *
     * `playingMsAccumulator` is the cumulative wall-clock time the player
     * has been actively *playing* (not paused, not buffering, not seeking)
     * inside the current session. Driven by a 1Hz setInterval failsafe
     * AND by onTimeUpdate (high-frequency precision while timeupdate is
     * firing); the timer is anchored to controller life, not to media
     * events, so a Safari background tab or codec stall that silences
     * timeupdate doesn't freeze the accumulator.
     *
     * The accumulated value is forwarded to the server as `sessionElapsedMs`
     * on every heartbeat. The server's `getContinueWatchingFromDb` query
     * uses `highest_session_elapsed_ms` to promote a row into Continue
     * Watching; a scrub-and-leave session sends a near-zero value and is
     * filtered out server-side.
     *
     * `lastSeenPlaySessionId` detects auto-advance / quality-restart that
     * keeps the same PlayerController instance — when playSessionId
     * changes, the prior session's accumulator must not bleed into the
     * new session's elapsed total.
     *
     * `lastPlayingTickAt` is nulled the moment we observe the player is
     * not actively playing, so a pause→resume short gap doesn't get
     * billed as engagement on the first tick after resume.
     */
    playingMsAccumulator: number = 0;
    lastPlayingTickAt: number | null = null;
    lastSeenPlaySessionId: string | null = null;
    engagementTickIntervalRef: ReturnType<typeof setInterval> | null = null;
    static readonly ENGAGEMENT_TICK_MS = 1_000;

    // ---- Live FPS sampling state (piggybacks on the engagement ticker) ----
    // A sliding window rather than a single prior sample: some browsers'
    // native pipelines (observed on Safari) update the decoded-frame counter
    // in uneven bursts rather than smoothly, so a single 1s tick-to-tick
    // delta aliases between ~0 and ~2x actual fps. Averaging over the oldest
    // sample still in the window smooths that out.
    private fpsSamples: Array<{ at: number; frames: number }> = [];
    private static readonly FPS_WINDOW_MS = 3_000;

    // ---- Resume-cache state ----
    private latestServerAnchor: number | null = null;
    private engagementGateOpened = false;
    private lastCacheWriteAt = 0;
    private static readonly CACHE_THROTTLE_MS = 5_000;

    /**
     * After a version switch, the new transcode is still warming up on the
     * server (ffmpeg has just started producing segments). HLS.js may fetch
     * a fragment that's partially written and hit fragParsingError. Its
     * built-in recoverMediaError() doesn't help — it re-appends the broken
     * fragments from its buffer instead of re-fetching. The user's manual
     * seek works because it flushes HLS.js's buffer and forces re-fetch by
     * which point ffmpeg has caught up.
     *
     * When non-null, a fragParsingError is intercepted and we programmatic-
     * seek to this position (mimicking the manual seek). The arm is bounded to
     * the switch WINDOW: it auto-clears once the switched stream actually
     * resumes (first `playing`) or after a safety timeout, and is also cleared
     * by the intercept firing, a new version switch, or unmount. Bounding it is
     * essential — otherwise a clean switch (no fragParsingError) would leave
     * this stuck non-null and a LATER, unrelated fragParsingError would wrongly
     * seek the user back to this now-stale position instead of recovering
     * normally. (A fragParsingError in the failure case fires BEFORE `playing`,
     * so the auto-clear can't race the intended intercept.)
     */
    postSwitchRecoveryTarget: number | null = null;
    /** Tears down armPostSwitchRecovery's `playing`/timeout auto-clear. */
    private postSwitchClearCleanup: (() => void) | null = null;
    storeInitialized: boolean = false;
    playlistBrowserAutoOpened: boolean = false;
    cleanupPositionRestore: (() => void) | null = null;
    doubleTapState: DoubleTapState = createDoubleTapState();
    skipAnimationTimeout: ReturnType<typeof setTimeout> | null = null;
    overlayHasActiveAutoSkip: boolean = false;
    seekRepeatTimer: ReturnType<typeof setInterval> | null = null;
    seekRepeatCount: number = 0;
    autoplayMutedDismissed: boolean = false;
    lastMouseX: number = 0;
    lastMouseY: number = 0;
    // AirPlay stream token, minted lazily on activation. MUST be cleared when the
    // media item changes (today this happens because {#key data.playbackInfo.itemId}
    // in watch/[itemId]/+page.svelte fully remounts the controller). If that remount
    // is ever replaced by in-place prop-swap, clear this here on item change — an
    // item-scoped token reused for a different item hard-401s (wrong_item).
    private playbackStart: PlaybackStartResponse | null = null;
    streamToken: string | null = null;
    streamTokenPromise: Promise<string | null> | null = null;
    /** Absolute expiry of streamToken (epoch ms), null when unknown. */
    streamTokenExpiresAt: number | null = null;
    /** One failure-driven re-mint per cooldown — see StreamTokenRecoveryGate. */
    private readonly streamTokenRecovery = new StreamTokenRecoveryGate();
    /** In-flight `/api/auth/check` probe after a 401 (see session-reauth.ts). */
    private sessionLossProbe: Promise<void> | null = null;
    private lastSessionLossProbeAt = 0;
    seekBufferingTimer: ReturnType<typeof setTimeout> | null = null;
    subtitleCacheBuster: number = 0;
    postSeekSubtitleTimer: ReturnType<typeof setTimeout> | null = null;
    subtitleLoadGeneration: number = 0;
    /** iOS: <track> elements wait for loadedmetadata; see detachSubtitleTracksBeforeLoad. */
    subtitleLoadDeferredUntilMetadata = false;
    isRestartingPlayback: boolean = false;
    suppressErrorsDuringRestart: boolean = false;
    /** Restarts requested while one holds the lock (run afterwards, latest
     *  wins) and the resume snapshot shared by a burst of restarts. */
    private readonly restartQueue = new RestartQueue();
    /** Media bitrate of the stream being played, for the stats pill. */
    private readonly streamBitrateMeter = new StreamBitrateMeter();
    private readonly boundHandleVideoDimensions = (): void => {
        playerStore.setDecodedResolution(decodedResolution(this.videoElement));
    };
    asyncCleanup: (() => void) | undefined;
    private reconnect: ReconnectController | null = null;
    private reconnectVisibilityHandler: (() => void) | null = null;
    private hasEnded = false;
    /** Last audio-only-ness the wake lock was synced for. `null` until the first
     *  restart, so the initial mount doesn't fight onPlay() for the lock. */
    private lastWakeLockAudioOnly: boolean | null = null;
    originalDocumentTitle: string = '';
    lastQualityRestartKey = this.buildQualityRestartKey(
        playerStore.qualityMode,
        playerStore.currentQualityProfile,
    );
    lastAudioTrackIndex: number = playerStore.currentAudioTrackIndex;
    pendingAudioTrackIndex: number | null = null;
    lastAudioSwitchRevision = playerStore.audioSelectionRevision;
    audioSwitchInFlight = false;
    audioSwitchAttempt = 0;
    failedAudioSwitch: { index: number; revision: number; sourceId: string | undefined } | null =
        null;
    private previousToggledSubtitle: { fileId: string; id: string; index: number } | null = null;
    private liveTvStartupDeadline = new LiveTvStartupDeadline();
    private liveTvStartupHasProgress = false;
    private liveTvStartupSignal: AbortSignal | undefined;
    private liveTvStartupCleanup: (() => void) | undefined;
    private armLiveTvStartup(): void {
        this.liveTvStartupCleanup?.();
        const video = this.videoElement;
        let lastTime = video?.currentTime ?? 0;
        let lastFrames = video?.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
        let frameCallback: number | undefined;
        let lastPresentedTime: number | undefined;
        const generation = this.playbackGeneration;
        this.liveTvStartupSignal = this.liveTvStartupDeadline.begin(() => {
            if (generation !== this.playbackGeneration || this.wasKicked || this.liveTvFailure)
                return;
            // The proxy may already know why the channel never produced a picture; ask
            // BEFORE the teardown below ends the session as 'left' and the reason is gone.
            const sessionId = this.liveTvSessionId;
            void (async () => {
                const typed = sessionId
                    ? await getPlaybackSessionFailure(sessionId, AbortSignal.timeout(2000))
                    : null;
                if (
                    generation !== this.playbackGeneration ||
                    this.wasKicked ||
                    this.liveTvFailure ||
                    this.liveTvStartupHasProgress
                )
                    return;
                const heartbeat = this.liveTvHeartbeat;
                this.playbackGeneration++;
                const afterGeneration = this.playbackGeneration;
                this.liveTvQualityAbortController?.abort();
                this.playbackManager?.destroy();
                clearVideoSource(this.videoElement ?? null);
                this.liveTvHeartbeat = null;
                this.liveTvSessionId = null;
                this.liveTvFeedId = undefined;
                this.liveTvCurrentFeedId = undefined;
                void this.endCurrentSession('error');
                void heartbeat?.destroy();
                if (afterGeneration !== this.playbackGeneration || this.wasKicked) return;
                playerStore.setLoading(false);
                if (typed) this.showLiveTvFailure(typed);
                else this.liveTvFailure = { type: 'connection_lost' };
            })();
        });
        const complete = (): void => {
            this.liveTvStartupHasProgress = true;
            this.armLiveTvBudgetReset();
            this.liveTvStartupDeadline.cancel(false);
            this.liveTvStartupSignal = undefined;
        };
        const progress = (): void => {
            if (!video) return;
            const frames = video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
            // Seeks move the clock even when no frame has been decoded.
            if (!video.seeking && !video.paused && frames > lastFrames) complete();
            // Explicit audio-only playback has no video frame counter.
            if (
                this.lumastraPlayMethod === 'audio_only' &&
                !video.seeking &&
                !video.paused &&
                video.currentTime > lastTime &&
                video.currentTime - lastTime < 2
            )
                complete();
            lastFrames = frames;
            lastTime = video.currentTime;
        };
        const presented: VideoFrameRequestCallback = (_now, metadata): void => {
            if (!video) return;
            if (
                !video.seeking &&
                !video.paused &&
                lastPresentedTime !== undefined &&
                metadata.mediaTime > lastPresentedTime
            )
                complete();
            lastPresentedTime = metadata.mediaTime;
            if (!this.liveTvStartupHasProgress)
                frameCallback = video.requestVideoFrameCallback(presented);
        };
        if (video?.requestVideoFrameCallback)
            frameCallback = video.requestVideoFrameCallback(presented);
        const seek = (): void => {
            lastTime = video?.currentTime ?? 0;
            lastPresentedTime = undefined;
            lastFrames = video?.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
        };
        const pause = (): void => {
            if (!playerStore.pausedByUser) return;
            this.liveTvStartupDeadline.cancel(false);
            this.liveTvStartupSignal = undefined;
        };
        const play = (): void => {
            if (!this.liveTvStartupHasProgress) this.armLiveTvStartup();
        };
        video?.addEventListener('timeupdate', progress);
        video?.addEventListener('seeking', seek);
        video?.addEventListener('seeked', seek);
        video?.addEventListener('pause', pause);
        video?.addEventListener('play', play);
        this.liveTvStartupCleanup = () => {
            this.liveTvStartupDeadline.cancel();
            if (frameCallback !== undefined) video?.cancelVideoFrameCallback(frameCallback);
            video?.removeEventListener('timeupdate', progress);
            video?.removeEventListener('seeking', seek);
            video?.removeEventListener('seeked', seek);
            video?.removeEventListener('pause', pause);
            video?.removeEventListener('play', play);
        };
    }
    private liveTvQualityAbortController: AbortController | null = null;
    private liveTvAutoRetryTimer: ReturnType<typeof setTimeout> | undefined;
    /** Automatic retries made since the channel last played; budget in livetv-failure-retry.ts. */
    private liveTvAutoRetryAttempts = 0;
    private liveTvBudgetResetTimer: ReturnType<typeof setTimeout> | undefined;
    private resolvingLiveTvFailure = false;
    /** Invalidates async playback work when this controller starts tearing down. */
    private playbackGeneration = 0;
    private navigationRequestRevision = 0;
    lastBurnInState: boolean = playerStore.forceSubtitleBurnIn;
    isPreparingAirPlay: boolean = false;
    airplayListenerCleanup: (() => void) | null = null;
    autoplayTutorialTimer: ReturnType<typeof setTimeout> | null = null;

    // ---- OSD indicators (rune-based class) ----
    readonly osdIndicators = createOsdIndicatorStore();

    // ---- Browser detection (computed once) ----
    readonly isSafari: boolean =
        browser && /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    readonly isIOS: boolean =
        browser &&
        (/iPad|iPhone|iPod/i.test(navigator.userAgent) ||
            (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

    // ---- VideoShortcuts (created after methods are available, see setup) ----
    videoShortcuts!: VideoShortcuts;

    /**
     * Effective seek/skip step (seconds) for double-tap, keyboard arrows and the
     * accelerating seek-hold. Per-user preference, falling back to the server's
     * PLAYER_SKIP_SECONDS. Positive only — direction is applied by the caller.
     */
    get seekStepSeconds(): number {
        const v = playbackPreferences.seekStepSeconds;
        return typeof v === 'number' && v > 0 ? v : playerSkipSeconds();
    }

    // ---- Bound event handlers for add/removeEventListener ----
    private readonly boundHandleKeydown = (e: KeyboardEvent) => this.handleKeydown(e);
    private readonly boundHandleKeyup = (e: KeyboardEvent) => this.handleKeyup(e);
    private readonly boundHandleWindowBlur = () => this.handleWindowBlur();
    private readonly boundHandleFullscreenChange = () => this.handleFullscreenChange();
    private readonly boundHandleIOSFullscreenStart = () => this.handleIOSFullscreenStart();
    private readonly boundHandleIOSFullscreenEnd = () => this.handleIOSFullscreenEnd();
    private readonly boundHandleBeforeUnload = () => this.handleBeforeUnload();
    /**
     * `pagehide` is the reliable unload signal on Safari/iOS, where
     * `beforeunload` is unreliable (and is skipped entirely for bfcache-eligible
     * navigations). Both are wired because either may be the only one that
     * fires; handleBeforeUnload is idempotent-safe via its isInitialized guard
     * and the beacon flushes no-op on an empty buffer.
     */
    private readonly boundHandlePageHide = () => this.handleBeforeUnload();
    /** Last currentTime handed to reconnect.notifyProgress(), so a `timeupdate`
     *  on a frozen playhead is not mistaken for progress. Null until the first
     *  tick; reset on seek/session rebuild via resetProgressPosition(). */
    private lastProgressPosition: number | null = null;

    // ---- Derived values ----
    readonly isControlMenuOpen = $derived(this.playerControlsRef?.hasOpenMenu?.() ?? false);
    readonly isAnyOverlayOpen = $derived(
        this.showMovieSidebar ||
            this.showEpisodeBrowser ||
            this.showPlaylistBrowser ||
            this.showChannelSwitcher ||
            this.showSearch ||
            this.showWatchPartySearch ||
            this.watchPartyPanelOpen ||
            this.showAnnotationsSidebar,
    );

    get logoId(): string | undefined {
        // Image events can arrive after navigation has discarded the page's
        // playback prop (Safari reports these on the destination route).
        const info = this.props.playbackInfo;
        if (!info) return undefined;
        // The clearLogo is series-level branding. For an episode prefer the
        // series id: the episode has no logo of its own, and TMDB only carries
        // the logo at the series level (fetched live — it's NOT stored as a
        // logo_path the catalog metadata walk could rank up), so resolving by
        // episode id 404s and the player shows no logo even though
        // /admin/library/media (which queries the series) does. Movies have
        // no seriesId → internalId.
        return info.seriesId || info.internalId || info.itemId;
    }

    get logoUrl(): string | null {
        return this.logoId ? (getCatalogLogoUrl(this.logoId, { fallback: 'none' }) ?? null) : null;
    }

    readonly canSyncToWatchParty = $derived(watchTogether.isInWatchParty && !playerStore.isLive);

    readonly hasWatchPartyGuestRestrictions = $derived(
        watchTogether.isInWatchParty && !watchTogether.isWatchPartyHost,
    );

    readonly isWatchPartyGuest = $derived(
        this.canSyncToWatchParty && !watchTogether.isWatchPartyHost,
    );

    readonly isActiveWatchPartyHost = $derived(
        watchTogether.isInWatchParty && watchTogether.isWatchPartyHost,
    );

    readonly isDirectPlayMode = $derived(playerStore.playMethod === 'DirectPlay');

    readonly isDirectStreamMode = $derived(playerStore.playMethod === 'DirectStream');

    readonly isTranscodeMode = $derived(playerStore.playMethod === 'Transcode');

    get currentAdaptiveBitrate(): number | null {
        return this.abrCtrl.currentBitrate;
    }

    readonly subtitlePositionY = $derived(this.subtitleStyle.positionY ?? 85);

    // Effective subtitle line position (0-100 % from top), capped for landscape mobile.
    // Reads videoHeight to re-derive on orientation change (ResizeObserver fires on rotate).
    readonly effectiveSubtitleLineY: number = $derived(
        (() => {
            const base = this.subtitlePositionY;
            if (!browser) return base;
            const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
            if (!isMobile) return base;
            void this.videoHeight; // subscribe to orientation changes via ResizeObserver
            const isLandscape = window.innerWidth > window.innerHeight;
            // In landscape, the control bar occupies ~20% of player height.
            // Cap at 72% from top to keep subtitle above it.
            return isLandscape ? Math.min(base, 72) : base;
        })(),
    );

    // True when the viewport is portrait-shaped (re-derives on resize/rotate via
    // videoHeight, which the ResizeObserver updates).
    readonly isPortrait: boolean = $derived(
        (() => {
            if (!browser) return false;
            void this.videoHeight;
            return window.innerHeight > window.innerWidth;
        })(),
    );

    // Render subtitles through the custom DOM overlay (.portrait-subtitle-overlay)
    // instead of native ::cue when:
    //  - portrait: native ::cue positioning overflows the letterboxed video, OR
    //  - Safari: WebKit ignores ::cue background and mis-positions forced cues,
    //    leaving empty caption boxes during dialogue.
    // In overlay mode the native track is kept 'hidden' (cues still parse + fire
    // cuechange to populate activeSrtCue, but the browser renders nothing).
    readonly useSubtitleOverlay: boolean = $derived(
        !this.isIOSNativeFullscreen && (this.isPortrait || this.isSafari),
    );

    /** Shared CSS-pixel size for native cues and the text subtitle overlay. */
    get textSubtitleFontSize(): number {
        return calculateSubtitleOverlayFontSize(
            this.videoHeight,
            browser ? window.innerWidth : 0,
            this.isPortrait,
            this.subtitleStyle.fontSize,
            this.props.subtitleSizeMultiplier ?? 1.2,
            this.props.subtitleSrtScale ?? 140,
        );
    }

    get subtitleCueCSS(): string {
        const style = this.subtitleStyle;

        const fontFamilyMap: Record<string, string> = {
            system: 'system-ui, -apple-system, sans-serif',
            serif: 'Georgia, "Times New Roman", serif',
            mono: '"SF Mono", "Monaco", "Consolas", monospace',
        };

        let textShadow = '';
        if (style.outlineWidth > 0) {
            const outlineColor = style.outlineColor;
            const w = style.outlineWidth;
            textShadow = [
                `-${w}px -${w}px 0 ${outlineColor}`,
                `${w}px -${w}px 0 ${outlineColor}`,
                `-${w}px ${w}px 0 ${outlineColor}`,
                `${w}px ${w}px 0 ${outlineColor}`,
                `0 -${w}px 0 ${outlineColor}`,
                `0 ${w}px 0 ${outlineColor}`,
                `-${w}px 0 0 ${outlineColor}`,
                `${w}px 0 0 ${outlineColor}`,
            ].join(', ');
        }
        if (style.shadowBlur > 0) {
            const shadowPart = `2px 2px ${style.shadowBlur}px rgba(0, 0, 0, 0.9)`;
            textShadow = textShadow ? `${textShadow}, ${shadowPart}` : shadowPart;
        }

        const hasBackground = style.backgroundColor !== 'transparent';

        const backgroundCSS = hasBackground
            ? `background-color: ${style.backgroundColor};`
            : `background: transparent !important; background-color: transparent !important;`;

        const fontSizePx = this.textSubtitleFontSize;
        return `
            video::cue {
                ${backgroundCSS}
                color: ${style.textColor} !important;
                font-size: ${fontSizePx}px !important;
                font-family: ${fontFamilyMap[style.fontFamily] || fontFamilyMap.system};
                text-shadow: ${textShadow || 'none'};
                padding: ${hasBackground ? '4px 8px' : '0'};
                border-radius: ${hasBackground ? '4px' : '0'};
                outline: none;
                -webkit-box-decoration-break: clone;
                box-decoration-break: clone;
            }
            .player-container .video-element::cue {
                ${backgroundCSS}
                color: ${style.textColor} !important;
                font-size: ${fontSizePx}px !important;
                font-family: ${fontFamilyMap[style.fontFamily] || fontFamilyMap.system};
                text-shadow: ${textShadow || 'none'};
                padding: ${hasBackground ? '4px 8px' : '0'};
                border-radius: ${hasBackground ? '4px' : '0'};
                outline: none;
                -webkit-box-decoration-break: clone;
                box-decoration-break: clone;
            }
            @media (orientation: portrait) {
                video::cue,
                .player-container .video-element::cue {
                    font-size: 0 !important;
                    color: transparent !important;
                    background: transparent !important;
                    text-shadow: none !important;
                }
            }
        `;
    }

    get portraitSubtitleInlineStyle(): string {
        const style = this.subtitleStyle;
        const fontFamilyMap: Record<string, string> = {
            system: 'system-ui, -apple-system, sans-serif',
            serif: 'Georgia, "Times New Roman", serif',
            mono: '"SF Mono", "Monaco", "Consolas", monospace',
        };

        const parts: string[] = [
            `color: ${style.textColor}`,
            `font-family: ${fontFamilyMap[style.fontFamily] ?? fontFamilyMap.system}`,
            `font-size: ${this.textSubtitleFontSize}px`,
        ];

        if (style.backgroundColor !== 'transparent') {
            parts.push(`background-color: ${style.backgroundColor}`);
        }

        const shadows: string[] = [];
        if (style.outlineWidth > 0) {
            const w = style.outlineWidth;
            const oc = style.outlineColor;
            shadows.push(
                `-${w}px -${w}px 0 ${oc}`,
                `${w}px -${w}px 0 ${oc}`,
                `-${w}px ${w}px 0 ${oc}`,
                `${w}px ${w}px 0 ${oc}`,
                `0 -${w}px 0 ${oc}`,
                `0 ${w}px 0 ${oc}`,
                `-${w}px 0 0 ${oc}`,
                `${w}px 0 0 ${oc}`,
            );
        }
        if (style.shadowBlur > 0) {
            shadows.push(`2px 2px ${style.shadowBlur}px rgba(0,0,0,0.9)`);
        }
        if (shadows.length > 0) {
            parts.push(`text-shadow: ${shadows.join(', ')}`);
        }

        return parts.join('; ');
    }

    // ============================================================================
    // Constructor
    // ============================================================================

    constructor(props: VideoPlayerProps) {
        this.props = props;
        // props is a reactive proxy from $props()
        // currentPlaybackInfo is an overridable $derived — auto-synced from props

        // Initialize sub-controllers with dependency injection
        this.telemetryCtrl = new TelemetryController({
            isSafari: this.isSafari,
            getVideoElement: () => this.videoElement,
            log: (...args: unknown[]) => this.log(...args),
        });

        this.abrCtrl = new AbrController({
            getMediaSourceBitrate: () =>
                playerStore.getState().currentMediaSource?.bitrate || 20_000_000,
            getVideoBitrateForEstimator: () =>
                playerStore.getState().currentMediaSource?.bitrate || 10_000_000,
            getQualityMode: () => playerStore.getState().qualityMode,
            isLive: () => playerStore.isLive,
            onQualitySwitch: (targetBitrate) => this.restartPlaybackAtBitrate(targetBitrate),
            onShowToast: (reason, direction, duration) =>
                playerStore.showToast(reason, direction, duration),
            log: (...args: unknown[]) => this.log(...args),
            ensureTelemetry: () => this.telemetryCtrl.ensure(),
        });

        this.mediaSessionCtrl = new MediaSessionController({
            getVideoElement: () => this.videoElement,
            seekTo: (time) => this.seekTo(time),
            onPlay: () => {
                // Lock screen / headset / OS "Now Playing" Play. In a watch party it
                // goes through the party — a bare element.play() played this tab
                // alone. If the browser had suspended this host in the background,
                // catch up with the party instead: a sync from here would carry the
                // stale position and rewind every guest.
                if (this.canSyncToWatchParty && this.videoElement?.paused) {
                    playerStore.setPausedByUser(false);
                    this.updatePlaybackIntent();
                    if (this.watchTogetherCtrl.catchUpIfSuspended()) return;
                    this.togglePlayPause();
                    return;
                }
                this.playbackManager?.startDeferredSource();
                this.videoElement?.play().catch((e: Error) => this.handlePlayError(e));
            },
            onPause: () => {
                // OS media controls / lock screen / headset pause is a
                // deliberate user pause that bypasses togglePlayPause — record
                // intent so reconnect/watchdog never auto-resume against it.
                playerStore.setPausedByUser(true);
                this.updatePlaybackIntent();
                // In a watch party it must pause the PARTY: without the sync only
                // the host heartbeat reported it, the server flipped to paused and
                // the guests played on (a split party).
                if (this.canSyncToWatchParty && this.videoElement) {
                    // Suspended by the browser: the element is already paused, at a
                    // stale position. Pause the party where it has got to.
                    const caughtUp = this.watchTogetherCtrl.takeSuspendedPosition();
                    if (caughtUp !== null) {
                        this.setVideoTime(caughtUp, 'watch_party_sync');
                        watchTogether.syncPlaybackState(caughtUp, false);
                        return;
                    }
                    if (!this.videoElement.paused) {
                        this.togglePlayPause();
                        return;
                    }
                }
                this.videoElement?.pause();
            },
            onStop: () => this.props.onback?.(),
            onNextTrack: undefined, // Set during mount when effectiveNextItem is known
            hasWatchPartyGuestRestrictions: () => this.hasWatchPartyGuestRestrictions,
            handlePlayError: (e) => this.handlePlayError(e),
            isAudioOnly: () => playerStore.qualityMode === 'audio-only',
        });

        this.watchTogetherCtrl = new WatchTogetherController({
            getVideoElement: () => this.videoElement,
            getWatchTogetherToast: () => this.watchTogetherToast,
            getItemId: () => this.currentPlaybackInfo.itemId,
            onPlaybackRateChange: (rate) => {
                this.lastAppliedPlaybackRate = rate;
            },
            getPlaybackInfo: () => this.currentPlaybackInfo,
            getPlaybackProbe: () => this.playbackProbe,
            seekTo: (time, broadcastToWatchParty, source) =>
                this.seekTo(time, broadcastToWatchParty, source),
            setVideoTime: (time, source) => this.setVideoTime(time, source as SeekSource),
            switchLumastraFile: (fileId) => this.switchLumastraFile(fileId),
            onVersionChange: (fileId) => this.props.onversionchange?.(fileId),
            handlePlayError: (e) => this.handlePlayError(e),
            onMutedFallback: () => this.showMutedAutoplayPrompt(),
            log: (...args: unknown[]) => this.log(...args),
        });

        // Initialize VideoShortcuts with callbacks bound to this instance
        this.videoShortcuts = new VideoShortcuts({
            onTogglePlayPause: () => this.togglePlayPause(),
            // Keyboard arrows pass a ±step magnitude; remap to the user's
            // configured seek step, preserving only the direction.
            onSeek: (seconds) => this.seek(Math.sign(seconds) * this.seekStepSeconds),
            onSeekToPercent: (percent) => this.seekToPercent(percent),
            onStartAcceleratingSeek: (direction) => this.startAcceleratingSeek(direction),
            onStopAcceleratingSeek: () => this.stopAcceleratingSeek(),
            onAdjustVolume: (delta) => this.adjustVolume(delta),
            onToggleMute: () => {
                playerStore.toggleMute();
                if (this.videoElement) this.videoElement.muted = playerStore.isMuted;
            },
            onShowVolumeIndicator: () => this.showVolumeIndicator(),
            onToggleSubtitles: () => this.toggleSubtitles(),
            onToggleFullscreen: () => this.toggleFullscreen(),
            onCloseAllOverlays: () => this.closeAllOverlays(),
            onBack: () => this.props.onback?.(),
            onAdjustSpeed: (delta) => this.adjustSpeed(delta),
            onStepFrame: (direction) => this.stepFrame(direction),
            onSkipSegment: () => this.skipSegment(),
            onGoToNextItem: (event) => this.goToNextItem(event),
            onShowSeekPercentIndicator: (percent) =>
                this.osdIndicators.showSeekPercentIndicator(percent),
            onShowWatchPartyBackConfirm: () => {
                this.showWatchPartyBackConfirm = true;
            },
            onCancelAutoSkip: () => {
                this.cancelTrigger++;
            },
        });

        this.reconnect = new ReconnectController({
            attemptRecovery: (cause, attempt) => this.reconnectAttempt(cause, attempt),
            isStallExpected: () =>
                encoderExplainsWaiting(
                    playerStore.transcodeProgress,
                    playerStore.startupEncoderNotice,
                ),
            schedule: (fn, ms) => {
                const id = setTimeout(fn, ms);
                return () => clearTimeout(id);
            },
            onStateChange: (state, terminalReason) => {
                if (state === 'recovering') {
                    const cause = this.reconnect?.getCause() ?? null;
                    // MUST run before any renewal of playSessionId — this
                    // branch is synchronous and fires before
                    // scheduleNextAttempt()/attemptRecovery() ever gets a
                    // chance to rebuild the session, so reading
                    // playerStore.playSessionId here always captures the
                    // PRE-renewal id. See incident-reporter.ts's
                    // reportReconnect() doc comment.
                    this.incidentReporter?.reportReconnect(
                        playerStore.playSessionId ?? '',
                        cause ?? 'network',
                    );
                    playerStore.setReconnecting(true, cause, this.pendingReconnectDiagnostic);
                    this.pendingReconnectDiagnostic = null;
                    // Clear any stale terminal error so the blocking center
                    // overlay can't render on top of the reconnect badge.
                    playerStore.clearError();
                    this.telemetryCtrl.recordReconnect('recovering');
                } else if (state === 'connected') {
                    this.reconnectDiagnosticEpoch++;
                    this.pendingReconnectDiagnostic = null;
                    this.lastNetworkFailureStage = null;
                    playerStore.setReconnecting(false);
                    playerStore.clearError();
                    // onStateChange('connected') only fires from toConnected —
                    // i.e. a CONFIRMED recovery, never normal startup — so this
                    // records a successful reconnect, not routine playback.
                    this.telemetryCtrl.recordReconnect('recovered');
                    this.incidentReporter?.reportRecovered();
                } else {
                    // terminal — a specific known cause (404 file-not-found,
                    // stream limit, admin kill) wins; otherwise distinguish
                    // "the retry budget ran out" (actionable: reload the page)
                    // from the generic session-ended message.
                    // Snapshot the diagnosis BEFORE the reset below clears it —
                    // the terminal incident is the only record of why recovery
                    // gave up, and reading these after the nulling is what left
                    // prod terminals with NULL cause/stage.
                    const terminalCause = this.reconnect?.getCause();
                    const terminalStage = this.lastNetworkFailureStage ?? undefined;
                    this.reconnectDiagnosticEpoch++;
                    this.pendingReconnectDiagnostic = null;
                    this.lastNetworkFailureStage = null;
                    playerStore.setReconnecting(false);
                    playerStore.setError(
                        this.pendingTerminalMessage ??
                            (terminalReason === 'retries-exhausted'
                                ? m.player_reconnect_failed()
                                : m.player_session_ended()),
                    );
                    this.pendingTerminalMessage = null;
                    this.telemetryCtrl.recordReconnect('terminal', { reason: terminalReason });
                    this.incidentReporter?.reportTerminal(playerStore.playSessionId ?? '', {
                        reconnectCause: terminalCause,
                        stage: terminalStage,
                        // The machine reason, not the localized user string: a
                        // translated message is useless for forensics.
                        message: terminalReason ?? 'session-ended',
                    });
                    if (terminalReason === 'retries-exhausted') {
                        // Capture the failed element above BEFORE detaching it.
                        // A terminal overlay alone leaves native Safari fetching
                        // the same rejected segment indefinitely.
                        this.cleanupPositionRestore?.();
                        this.cleanupPositionRestore = null;
                        this.restartQueue.reset();
                        this.pendingAudioTrackIndex = null;
                        this.playbackManager?.destroy(true);
                        clearVideoSource(this.videoElement ?? null);
                        playerStore.setPlaying(false);
                        playerStore.setLoading(false);
                        playerStore.setBuffering(false);
                        playerStore.stopProgressReporting();
                        this.mediaSessionCtrl.updatePlaybackState('paused');
                    }
                }
            },
            isHidden: () => (browser ? document.hidden : false),
            canRecoverStartup: () => this.videoElement?.paused === false,
        });

        if (browser) {
            this.reconnectVisibilityHandler = () => {
                if (!document.hidden) this.reconnect?.onVisible();
            };
            document.addEventListener('visibilitychange', this.reconnectVisibilityHandler);
        }

        // Initialize all reactive effects.
        // IMPORTANT: This class MUST be instantiated during synchronous component
        // initialization (in the <script> block), NOT inside onMount or async code.
        // $effect() calls require an active component context to register properly.
        this.initEffects();
    }

    // ============================================================================
    // Logging helpers
    // ============================================================================

    log = (...args: unknown[]): void => {
        if (this.DEBUG) console.log('[Player]', ...args);
    };

    logSub = (...args: unknown[]): void => {
        if (this.DEBUG_SUBTITLES) console.log('[Player:Subtitles]', ...args);
    };

    warn = (...args: unknown[]): void => {
        console.warn('[Player]', ...args);
    };

    // ============================================================================
    // Utility helpers
    // ============================================================================

    /**
     * Arm the post-version-switch media-error intercept. See
     * `postSwitchRecoveryTarget` docs for why this exists.
     */
    armPostSwitchRecovery(targetPosition: number): void {
        // Tear down any prior arm before re-arming (back-to-back switches).
        this.postSwitchClearCleanup?.();
        this.postSwitchRecoveryTarget = targetPosition;
        // Show the buffering spinner immediately — the post-switch window
        // before the first fragParsingError is where the player is black
        // but the UI thinks everything is fine.
        playerStore.setBuffering(true);
        console.log(`[Player] Post-switch recovery armed @ ${targetPosition.toFixed(2)}s`);

        // Bound the arm to the switch window: clear it once the switched stream
        // actually resumes (first `playing`) or after a safety timeout. Without
        // this, a clean switch (no fragParsingError) leaves the target stuck and
        // a later unrelated fragParsingError would seek to this stale position.
        const video = this.videoElement;
        const onResumed = (): void => this.clearPostSwitchRecovery();
        const timer = setTimeout(onResumed, 15_000);
        video?.addEventListener('playing', onResumed, { once: true });
        this.postSwitchClearCleanup = (): void => {
            clearTimeout(timer);
            video?.removeEventListener('playing', onResumed);
        };
    }

    clearPostSwitchRecovery(): void {
        this.postSwitchRecoveryTarget = null;
        this.postSwitchClearCleanup?.();
        this.postSwitchClearCleanup = null;
    }

    /**
     * Execute the post-switch HLS rebuild. Shared by both the fast-path
     * (first fragParsingError from onMediaRecoveryAttempt) and the fallback
     * (fatal onError if the fast-path misses).
     *
     * Pins playerStore state so the seek bar stays on the target during
     * resetForSeek's transient removeAttribute('src') + load() which
     * otherwise leaks video.currentTime=0 via onTimeUpdate.
     *
     * Subtitle re-init: resetForSeek destroys the HLS instance but doesn't
     * touch the PGS/libbitsub subtitle renderer. We wait for the video
     * element to reach the target position AND start playing before
     * re-initing — libbitsub's internal RAF loop gets wedged if the
     * PgsRenderer is constructed while the video is paused/unseeked
     * mid-rebuild, leading to subtitles stuck on the first cue. The
     * restartForVersionChange path gets this right for free because
     * finishRestart(true) fires from the position-restore `canplay` event.
     */
    private executePostSwitchReset(target: number, reason: string): void {
        console.log(`[Player] post-switch HLS reset (${reason}) at ${target.toFixed(2)}s`);
        this.clearPostSwitchRecovery();
        playerStore.setSeeking(true);
        playerStore.setBuffering(true);
        playerStore.setCurrentTime(target);
        this.playbackManager?.resetForSeek(target);

        const video = this.videoElement;
        if (!video) return;

        const reinitWhenReady = (): void => {
            video.removeEventListener('playing', reinitWhenReady);
            clearTimeout(fallbackTimer);
            console.log(
                `[Player] post-switch reset: video playing at ${video.currentTime.toFixed(2)}s — reinit subtitles`,
            );
            void this.reinitializeSubtitleRendererIfNeeded();
        };
        video.addEventListener('playing', reinitWhenReady, { once: true });
        // Fallback: if playback never resumes (autoplay blocked, etc.)
        // still re-init so subtitles aren't silently dead.
        const fallbackTimer = setTimeout(() => {
            video.removeEventListener('playing', reinitWhenReady);
            console.log(`[Player] post-switch reset: fallback subtitle reinit after timeout`);
            void this.reinitializeSubtitleRendererIfNeeded();
        }, 5000);
    }

    setVideoTime(time: number, source: SeekSource): void {
        if (!this.videoElement) {
            if (this.DEBUG)
                console.warn('[Player] setVideoTime called but no videoElement', { time, source });
            return;
        }
        if (!Number.isFinite(time)) {
            if (this.DEBUG)
                console.warn('[Player] setVideoTime ignored non-finite time', {
                    time,
                    source,
                });
            return;
        }
        if (
            this.isRestartingPlayback &&
            source !== 'restore_position' &&
            source !== 'resume_initial'
        )
            this.restartQueue?.noteSeek(time);
        if (this.DEBUG) {
            const from = this.videoElement.currentTime;
            console.log(
                `[Player] setVideoTime: ${from.toFixed(2)}s -> ${time.toFixed(2)}s (${source})`,
            );
        }
        this.videoElement.currentTime = time;
    }

    clampSeekTime(time: number): number | null {
        if (!Number.isFinite(time)) return null;
        const duration = Number.isFinite(playerStore.duration)
            ? playerStore.duration
            : Number.isFinite(this.videoElement?.duration ?? NaN)
              ? (this.videoElement as HTMLVideoElement).duration
              : null;
        const clamped = duration === null ? time : Math.min(time, duration);
        return Math.max(0, clamped);
    }

    closeAllOverlays(): boolean {
        if (this.watchPartyPanelOpen) {
            this.watchPartyPanelOpen = false;
            return true;
        }
        if (this.showChannelSwitcher) {
            this.showChannelSwitcher = false;
            return true;
        }
        if (this.showMovieSidebar) {
            this.showMovieSidebar = false;
            return true;
        }
        if (this.showEpisodeBrowser) {
            this.showEpisodeBrowser = false;
            return true;
        }
        if (this.showPlaylistBrowser) {
            this.showPlaylistBrowser = false;
            return true;
        }
        if (this.showReactionPicker) {
            this.showReactionPicker = false;
            return true;
        }
        if (this.showAnnotationsSidebar) {
            this.showAnnotationsSidebar = false;
            return true;
        }
        if (this.showWatchPartySearch) {
            this.showWatchPartySearch = false;
            return true;
        }
        if (this.showSearch) {
            this.showSearch = false;
            return true;
        }
        if (this.showWatchPartyBackConfirm) {
            this.showWatchPartyBackConfirm = false;
            return true;
        }
        if (this.playerControlsRef?.closeAllMenus?.()) {
            return true;
        }
        return false;
    }

    showVolumeIndicator(): void {
        this.osdIndicators.showVolumeIndicator(playerStore.volume, playerStore.isMuted);
    }

    clearStallTimer(): void {
        this.watchTogetherCtrl.clearStallTimer();
    }

    clearSeekBufferingTimer(): void {
        if (this.seekBufferingTimer) {
            clearTimeout(this.seekBufferingTimer);
            this.seekBufferingTimer = null;
        }
    }

    clearSkipAnimationTimer(): void {
        if (this.skipAnimationTimeout) {
            clearTimeout(this.skipAnimationTimeout);
            this.skipAnimationTimeout = null;
        }
    }

    mightBeInWatchParty(): boolean {
        if (!browser) return false;
        try {
            return localStorage.getItem(this.WATCH_PARTY_STORAGE_KEY) !== null;
        } catch {
            /* expected: localStorage may be blocked (private browsing) */
            return false;
        }
    }

    audioTrackMatchesTarget(
        track: { language?: string; label?: string },
        targetTrack: { languageCode?: string; language?: string },
    ): boolean {
        const trackLang = track.language || '';
        const trackLabel = track.label || '';
        if (targetTrack.languageCode && trackLang === targetTrack.languageCode) return true;
        if (targetTrack.language && trackLang === targetTrack.language) return true;
        if (
            targetTrack.language &&
            trackLabel.toLowerCase().includes(targetTrack.language.toLowerCase())
        )
            return true;
        return false;
    }

    hasValidPlaybackState(state: ReturnType<typeof playerStore.getState>): state is ReturnType<
        typeof playerStore.getState
    > & {
        itemId: string;
        currentMediaSource: NonNullable<
            ReturnType<typeof playerStore.getState>['currentMediaSource']
        >;
        playSessionId: string;
    } {
        return !!(state.itemId && state.currentMediaSource && state.playSessionId);
    }

    isPlaylistNavigation(item: {
        type: string;
        playlistId?: number;
        position?: number;
        itemId: string;
    }): item is {
        type: 'playlist';
        playlistId: number;
        position: number;
        itemId: string;
    } {
        return (
            item.type === 'playlist' && item.playlistId !== undefined && item.position !== undefined
        );
    }

    getBufferedRanges(): string {
        if (!this.videoElement || !this.videoElement.buffered.length) return 'none';
        const ranges: string[] = [];
        for (let i = 0; i < this.videoElement.buffered.length; i++) {
            ranges.push(
                `${this.videoElement.buffered.start(i).toFixed(1)}-${this.videoElement.buffered.end(i).toFixed(1)}s`,
            );
        }
        return ranges.join(', ');
    }

    getBufferHealth(): number | undefined {
        const video = this.videoElement;
        if (!video) return undefined;
        const currentTime = video.currentTime;
        const buffered = video.buffered;
        for (let i = 0; i < buffered.length; i++) {
            if (buffered.start(i) <= currentTime && currentTime <= buffered.end(i)) {
                return Math.round((buffered.end(i) - currentTime) * 10) / 10;
            }
        }
        return 0;
    }

    getAudioLanguage(
        state: ReturnType<typeof playerStore.getState>,
        audioIndex: number | undefined,
    ): string | undefined {
        if (audioIndex == null || !state.currentMediaSource) return undefined;
        const track = state.currentMediaSource.audioStreams.find((s) => s.index === audioIndex);
        return track?.language || track?.displayTitle || undefined;
    }

    getSubtitleLanguage(
        state: ReturnType<typeof playerStore.getState>,
        subtitleIndex: number | null | undefined,
    ): string | undefined {
        if (subtitleIndex == null || !state.currentMediaSource) return undefined;
        const track = state.currentMediaSource.subtitleStreams.find(
            (s) => s.index === subtitleIndex,
        );
        return track?.language || track?.displayTitle || undefined;
    }

    getValidatedStreamIndices(state: ReturnType<typeof playerStore.getState>): {
        /** 0-based audio-relative index — for client-side lookups (language, display). */
        audioStreamIndex: number;
        /** Absolute ffmpeg stream index — the value to report/persist on the wire. */
        audioStreamIndexAbsolute: number | null;
        subtitleStreamIndex: number | null;
    } {
        if (!state.currentMediaSource) {
            return {
                audioStreamIndex: 0,
                audioStreamIndexAbsolute: null,
                subtitleStreamIndex: null,
            };
        }

        let audioStreamIndex = state.currentAudioTrackIndex;
        const audioIndexValid = state.currentMediaSource.audioStreams.some(
            (s) => s.index === state.currentAudioTrackIndex,
        );
        if (!audioIndexValid && state.currentMediaSource.audioStreams.length > 0) {
            const fallbackIndex = state.currentMediaSource.audioStreams[0]?.index ?? 0;
            this.warn(
                `Audio index ${state.currentAudioTrackIndex} not found in media source, falling back to ${fallbackIndex}`,
            );
            audioStreamIndex = fallbackIndex;
        }

        // Resolve the absolute stream index for the selected (relative) track.
        // Prefer the matched track's absoluteIndex; if the selection no longer
        // matches a stream (e.g. mid version-switch), fall back to the first
        // track's ABSOLUTE index. Only as a last resort use the raw value — never
        // send a relative index where the wire/DB expects absolute.
        const selectedAudio = state.currentMediaSource.audioStreams.find(
            (s) => s.index === audioStreamIndex,
        );
        const audioStreamIndexAbsolute =
            state.currentMediaSource.audioStreams.length === 0
                ? null
                : (selectedAudio?.absoluteIndex ??
                  state.currentMediaSource.audioStreams[0]?.absoluteIndex ??
                  audioStreamIndex);

        let subtitleStreamIndex = state.currentSubtitleTrackIndex;
        if (subtitleStreamIndex !== null) {
            const subtitleIndexValid = state.currentMediaSource.subtitleStreams.some(
                (s) => s.index === state.currentSubtitleTrackIndex,
            );
            if (!subtitleIndexValid) {
                this.warn(
                    `Subtitle index ${state.currentSubtitleTrackIndex} not found in media source, falling back to null (off)`,
                );
                subtitleStreamIndex = null;
            }
        }

        return {
            audioStreamIndex,
            audioStreamIndexAbsolute,
            subtitleStreamIndex,
        };
    }

    getSubtitleTypeFlags(subtitleIndex: number | null): {
        isPgs: boolean;
        isAss: boolean;
        isVobsub: boolean;
    } {
        return {
            isPgs: this.isPgsSubtitle(subtitleIndex),
            isAss: this.isAssSubtitle(subtitleIndex),
            isVobsub: this.isVobsubSubtitle(subtitleIndex),
        };
    }

    buildCapsParam(): string {
        const caps = getCapabilities();
        if (!caps?.detected) return '';

        const video: string[] = [];
        const audio = ['mp3'];
        const hlsAudio: string[] = [];
        const containers: string[] = [];
        const hdr: string[] = [];

        if (caps.h264?.supported) video.push('h264');
        if (caps.h265?.supported) video.push('hevc');
        if (caps.vp9?.supported) video.push('vp9');
        if (caps.av1?.supported) video.push('av1');

        if (caps.aac) audio.push('aac');
        if (caps.opus) audio.push('opus');
        if (caps.flac) audio.push('flac');
        // AC3/EAC3 can direct-play in mp4 on Safari (and some Chromium builds)
        if (caps.ac3) audio.push('ac3');
        if (caps.eac3) audio.push('eac3');

        // HLS audio — exclude codecs not compatible with HLS transport (e.g. FLAC)
        hlsAudio.push(...audio.filter((c) => c !== 'flac'));

        if (caps.mp4) containers.push('mp4');
        if (caps.webm) containers.push('webm');

        if (caps.hdr10?.supported) hdr.push('hdr10');
        if (caps.hdr10Plus?.supported) hdr.push('hdr10plus');
        if (caps.hlg?.supported) hdr.push('hlg');
        if (caps.dolbyVision?.supported) hdr.push('dovi');

        const parts: string[] = [
            `v:${video.join(',')}`,
            `a:${audio.join(',')}`,
            `ha:${hlsAudio.join(',')}`,
        ];
        if (containers.length > 0) parts.push(`c:${containers.join(',')}`);
        if (hdr.length > 0) parts.push(`h:${hdr.join(',')}`);
        parts.push(`as:${caps.audioTracksApi ? '1' : '0'}`);
        // Same preference as the path-scoped caps' hlsDemuxAudio (iPhone/iPad).
        if (this.isIOS) parts.push('da:1');

        // All modern browsers handle multi-channel AAC (5.1/7.1).
        // Safari with AC-3/E-AC-3 supports Atmos (8ch); others max at 6ch AAC.
        const isSafari =
            typeof navigator !== 'undefined' &&
            /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
        const maxChannels = isSafari && (caps.ac3 || caps.eac3) ? 8 : 6;
        parts.push(`mc:${maxChannels}`);

        const constraints: string[] = [];
        if (caps.h264?.supported) constraints.push('h264:52');
        if (caps.h265?.supported) constraints.push('hevc:186');
        if (constraints.length > 0) parts.push(`cc:${constraints.join(',')}`);

        return parts.join(';');
    }

    /**
     * Serialize path-scoped browser capabilities into compact wire format.
     * Format: ps:df={v:h264,hevc;a:aac,opus;c:mp4,webm},nh={v:h264,hevc;a:aac,ac3,eac3},mh={v:h264,vp9,av1;a:aac,opus}
     */
    buildPathScopedCapsParam(): string | null {
        const caps = getPathScopedCapabilities();
        if (!caps) return null;
        return serializePathScopedCaps(caps);
    }

    tryStartRestart(): boolean {
        if (this.reconnect?.getState() === 'terminal') return false;
        if (this.isRestartingPlayback) {
            this.log(' Already restarting, skipping');
            return false;
        }
        if (this.cleanupPositionRestore) {
            this.cleanupPositionRestore();
            this.cleanupPositionRestore = null;
            // cleanup() detaches the canplay listener that was the only path
            // to clear isVersionSwitching for an in-flight lumastra switch.
            // Without this the "switching version" bar would stay lit through
            // any non-version restart (ABR, error recovery) that interrupts
            // a still-settling version change. Any new restart that is itself
            // a version switch will re-set the flag via its UI callback.
            playerStore.setVersionSwitching(false);
        }
        this.isRestartingPlayback = true;
        this.suppressErrorsDuringRestart = true;
        return true;
    }

    finishRestart(reinitSubtitles = false): void {
        this.watchTogetherCtrl?.finishSourceReplacement();
        this.isRestartingPlayback = false;
        this.suppressErrorsDuringRestart = false;
        this.syncWakeLockForQualityMode();
        if (reinitSubtitles) {
            void this.reinitializeSubtitleRendererIfNeeded();
        }
        // Drain any audio-track switches that arrived while we were restarting.
        this.consumePendingAudioSwitch();
        this.drainQueuedRestart();
    }

    /**
     * Run the restart that was queued while the lock was held (see
     * RestartQueue). Deferred to a microtask so the finishing restart's own
     * trailing code runs first. If the drained audio switch above already took
     * the lock, the queued request stays put: the next restart to acquire the
     * lock subsumes it, and its finishRestart() drains whatever is left.
     */
    private drainQueuedRestart(): void {
        if (this.isRestartingPlayback) return;
        const next = this.restartQueue.takePending();
        if (!next) {
            this.restartQueue.settle();
            return;
        }
        const generation = this.restartQueue.generation;
        queueMicrotask(() => {
            if (generation !== this.restartQueue.generation) return;
            this.log(' Running queued restart:', next);
            if (next.kind === 'seek') {
                void this.restartStreamAtPosition(next.position);
            } else {
                void this.restartStreamWithNewQuality({ resumeAt: next.position });
            }
        });
    }

    /**
     * Where and how to resume after a restart, read from the element NOW —
     * before any await or teardown. Playback resumes only if it was actually
     * running and the user owns play/pause (not in a watch party, where the
     * sync controller resumes).
     */
    /**
     * While a quality/audio restart is swapping the stream, the element is
     * reset and reports currentTime 0 until the new stream has data. Those
     * ticks must not reach the store: the seek bar showed 0:00 for the whole
     * 15 s startup of a copy-mode job (Windows e2e 2026-09-27 follow-up), and
     * a follow-up restart would read that 0 back as the position. The store
     * keeps the burst's resume position until the element can render a frame.
     */
    private isHoldingRestartPosition(): boolean {
        if (!this.isRestartingPlayback || !this.restartQueue.currentResume()) return false;
        const el = this.videoElement;
        return !el || el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA;
    }

    private readPlaybackPosition(): number {
        const held = this.restartQueue.currentResume();
        if (held) return held.position;
        const el = this.videoElement;
        // A decoded, settled element is the delivered clock. Display state
        // can lag; using that old nonzero value rewinds a recovered source.
        if (el && el.readyState >= 2 && !el.seeking && Number.isFinite(el.currentTime))
            return el.currentTime;
        return playerStore.playheadTime || el?.currentTime || 0;
    }

    private readRestartResume(): RestartResume {
        const el = this.videoElement;
        return {
            position: this.readPlaybackPosition(),
            play:
                !!el &&
                !el.paused &&
                !playerStore.pausedByUser &&
                !this.hasEnded &&
                !watchTogether.isInWatchParty,
        };
    }

    /**
     * Re-evaluate the screen wake lock after a restart, on the audio-only ↔
     * video crossing.
     *
     * The lock is normally driven by onPlay() → updatePlaybackState('playing'),
     * but onPlay() early-returns for the WHOLE restart window and the element
     * never pauses in between — so no later `play` event arrives. Switching back
     * from audio-only to video therefore never re-acquired the lock, and the
     * screen slept during ordinary video playback.
     *
     * Intent, not `videoElement.paused`, is the input: mid-restart the element
     * is transiently paused while the new source loads, so reading it would
     * release the lock we just came here to take.
     */
    private syncWakeLockForQualityMode(): void {
        const isAudioOnly = playerStore.qualityMode === 'audio-only';
        if (this.lastWakeLockAudioOnly === isAudioOnly) return;
        this.lastWakeLockAudioOnly = isAudioOnly;
        this.mediaSessionCtrl.syncWakeLock(!playerStore.pausedByUser && !this.hasEnded);
    }

    shouldSuppressErrors(): boolean {
        return (
            this.isRestartingPlayback ||
            this.suppressErrorsDuringRestart ||
            this.reconnect?.getState() === 'terminal'
        );
    }

    startAcceleratingSeek(direction: 'forward' | 'backward'): void {
        if (this.seekRepeatTimer) return;
        this.seekRepeatCount = 0;

        this.seekRepeatTimer = setInterval(() => {
            this.seekRepeatCount++;
            const multiplier = Math.min(
                SEEK.MAX_MULTIPLIER,
                1 + Math.floor(this.seekRepeatCount / SEEK.ACCELERATE_THRESHOLD),
            );
            const seekAmount =
                this.seekStepSeconds * multiplier * (direction === 'backward' ? -1 : 1);
            this.seek(seekAmount);
        }, SEEK.ACCELERATE_INTERVAL_MS);
    }

    stopAcceleratingSeek(): void {
        if (this.seekRepeatTimer) {
            clearInterval(this.seekRepeatTimer);
            this.seekRepeatTimer = null;
        }
        this.seekRepeatCount = 0;
    }

    handleAutoSkipActiveChange(
        event: CustomEvent<{ active: boolean }> | { active: boolean } | undefined,
    ): void {
        if (!event) return;
        const active = 'detail' in event ? event.detail?.active : event.active;
        if (typeof active === 'boolean') {
            this.overlayHasActiveAutoSkip = active;
        }
    }

    // ============================================================================
    // Subtitle type helpers
    // ============================================================================

    isPgsSubtitle(subtitleIndex: number | null): boolean {
        const state = playerStore.getState();
        return checkIsPgsSubtitle(state.currentMediaSource?.subtitleStreams, subtitleIndex);
    }

    isAssSubtitle(subtitleIndex: number | null): boolean {
        const state = playerStore.getState();
        return checkIsAssSubtitle(state.currentMediaSource?.subtitleStreams, subtitleIndex);
    }

    isVobsubSubtitle(subtitleIndex: number | null): boolean {
        const state = playerStore.getState();
        return checkIsVobsubSubtitle(state.currentMediaSource?.subtitleStreams, subtitleIndex);
    }

    isClientRenderedSubtitle(subtitleIndex: number | null): boolean {
        return (
            this.isPgsSubtitle(subtitleIndex) ||
            this.isAssSubtitle(subtitleIndex) ||
            this.isVobsubSubtitle(subtitleIndex)
        );
    }

    subtitleRequiresBurnIn(subtitleIndex: number | null): boolean {
        const state = playerStore.getState();
        const needsBurnIn = checkSubtitleRequiresBurnIn(
            state.currentMediaSource?.subtitleStreams,
            subtitleIndex,
        );

        if (needsBurnIn) {
            const subtitleStream = state.currentMediaSource?.subtitleStreams?.find(
                (s) => s.index === subtitleIndex,
            );
            this.log(' Subtitle requires burn-in:', {
                index: subtitleIndex,
                codec: subtitleStream?.codec,
                deliveryMethod: subtitleStream?.deliveryMethod,
                displayTitle: subtitleStream?.displayTitle,
            });
        }

        return needsBurnIn;
    }

    getSubtitleTextHref(subtitleIndex: number): string {
        const state = playerStore.getState();
        if (!state.currentMediaSource || !state.itemId) return '';

        const track = state.currentMediaSource.subtitleStreams.find(
            (sub) => sub.index === subtitleIndex,
        );
        const baseUrl = track?.hrefs?.text ?? '';
        if (!baseUrl || this.subtitleCacheBuster <= 0) return baseUrl;
        // Server hrefs are plain path?query strings (no fragment); drop a stale buster, add the new one.
        const withoutBuster = baseUrl.replace(/([?&])_t=[^&]*&?/, '$1').replace(/[?&]$/, '');
        return `${withoutBuster}${withoutBuster.includes('?') ? '&' : '?'}_t=${this.subtitleCacheBuster}`;
    }

    // ============================================================================
    // Lumastra media source builders
    // ============================================================================

    buildLumastraSource(info: PlayerProbe, _itemId: string): MediaSourceInfo {
        const activeVersion = info.activeVersion;
        const delivery =
            this.playbackStart?.mediaId === info.mediaId &&
            'fileId' in this.playbackStart.delivery &&
            this.playbackStart.delivery.fileId === info.activeFileId
                ? this.playbackStart.delivery
                : undefined;
        const tracks =
            delivery && 'tracks' in delivery && delivery.tracks
                ? delivery.tracks
                : activeVersion.tracks;
        // The probe supplies selection metadata only. Every resource comes from
        // the current start, matched by stable subtitle id (sidecar indices move).
        const descriptors = delivery && 'subtitles' in delivery ? delivery.subtitles : undefined;
        const subtitleStreams: SubtitleStreamInfo[] = (
            descriptors ?? activeVersion.tracks.subtitles
        ).map((sub) => {
            const probeTrack = activeVersion.tracks.subtitles.find((t) => t.id === sub.id);
            const startedTrack = descriptors
                ? tracks.subtitles.find((t) => t.index === sub.index)
                : undefined;
            const method =
                startedTrack?.method ??
                probeTrack?.method ??
                ('hrefs' in sub && sub.hrefs.text ? 'external_vtt' : 'none');
            const external = method === 'external_vtt' || method === 'client_render';
            return {
                index: sub.index,
                id: sub.id,
                codec: sub.codec,
                language: sub.language ?? undefined,
                languageCode: sub.language ?? undefined,
                title: sub.title ?? undefined,
                displayTitle: buildSubtitleDisplayTitle(
                    { language: sub.language, title: sub.title, forced: sub.forced },
                    getLocale(),
                ),
                isDefault: sub.default,
                isForced: sub.forced,
                isExternal: probeTrack?.source === 'sidecar',
                isTextSubtitleStream: sub.format === 'text',
                supportsExternalStream: external,
                deliveryMethod:
                    method === 'burn_in'
                        ? descriptors
                            ? 'Encode'
                            : undefined
                        : external
                          ? 'External'
                          : 'Drop',
                hrefs: 'hrefs' in sub ? sub.hrefs : undefined,
            };
        });

        const videoStream = tracks.video
            ? {
                  index: 0,
                  codec: tracks.video.codec,
                  width: tracks.video.width,
                  height: tracks.video.height,
                  averageFrameRate: tracks.video.fps,
                  videoRange: tracks.video.hdr === 'sdr' ? 'SDR' : 'HDR',
                  videoRangeType: lumastraHdrToVideoRangeType(tracks.video.hdr),
                  isDefault: true,
              }
            : undefined;

        // Extracted so it can be tested — see lumastra-track-mapping.ts. It also
        // carries `title` through now: this mapping used to fold it into
        // displayTitle and drop it, which silently disabled the commentary /
        // audio-description filter in the client's own resolver.
        const audioStreams = mapLumastraAudioStreams(tracks.audio);

        const defaultAudioStreamIndex =
            audioStreams.find((a) => a.isDefault)?.index ?? audioStreams[0]?.index;
        // Fallback only — the real pick is the probe's recommended tracks (or
        // the local resolver), which match forced subtitles to the chosen
        // audio. This used to take the first forced/default track in file
        // order, and failing that the FIRST track of any kind, so every
        // fallback (version switch without an identity match, a stale
        // recommendation) turned on e.g. "GER [Forced]" under English audio
        // (S10). Forced counts only in the default audio's language.
        const defaultAudioLanguage = audioStreams.find(
            (a) => a.index === defaultAudioStreamIndex,
        )?.language;
        const defaultSubtitleStreamIndex =
            subtitleStreams.find((s) => s.isDefault && !s.isForced)?.index ??
            subtitleStreams.find(
                (s) => s.isForced && languagesMatch(s.language, defaultAudioLanguage),
            )?.index;

        return {
            id: info.activeFileId,
            name: activeVersion?.label || 'Lumastra',
            path: '',
            container: tracks.video?.container ?? 'mkv',
            size: activeVersion.sizeBytes ?? 0,
            bitrate: tracks.video?.bitrate ?? 0,
            supportsDirectPlay: activeVersion.availableMethods.includes('direct'),
            supportsDirectStream:
                activeVersion.availableMethods.includes('remux') ||
                activeVersion.availableMethods.includes('audio_transcode'),
            supportsTranscoding:
                activeVersion.availableMethods.includes('audio_transcode') ||
                activeVersion.availableMethods.includes('full_transcode'),
            videoStreams: videoStream ? [videoStream] : [],
            audioStreams,
            subtitleStreams,
            defaultAudioStreamIndex,
            defaultSubtitleStreamIndex,
        };
    }

    /** Preserve a same-file subtitle by its stable ID, even with identical language tags. */
    private updateProbedSource(info: PlayerProbe, itemId: string): void {
        const sameFile = playerStore.currentMediaSource?.id === info.activeFileId;
        const start = this.playbackStart;
        const delivery =
            start?.mediaId === info.mediaId && isSelectedFileDelivery(start.delivery, info)
                ? start.delivery
                : undefined;
        const subtitles = delivery?.subtitles ?? info.activeVersion.tracks.subtitles;
        const selectedId = sameFile
            ? playerStore.currentMediaSource?.subtitleStreams.find(
                  (s) => s.index === playerStore.currentSubtitleTrackIndex,
              )?.id
            : undefined;
        playerStore.updateCurrentMediaSource(this.buildLumastraSource(info, itemId));
        if (selectedId) {
            playerStore.currentSubtitleTrackIndex =
                subtitles.find((s) => s.id === selectedId)?.index ?? null;
        }
    }

    /**
     * Build a PlaybackVariant from a ProbeVersion for the version picker.
     * This is a clean domain model — no Jellyfin MediaSourceInfo adaptation.
     */
    private buildPlaybackVariant(v: ProbeVersion): PlaybackVariant {
        const primaryAudio = v.tracks.audio[0];
        return {
            id: v.fileId,
            label: v.label || 'Default',
            videoWidth: v.tracks.video?.width,
            videoHeight: v.tracks.video?.height,
            videoCodec: v.tracks.video?.codec,
            hdr: v.tracks.video?.hdr,
            audioCodec: primaryAudio?.codec,
            audioChannels: primaryAudio?.channels,
            fileSize: v.sizeBytes ?? 0,
        };
    }

    /**
     * Sync playbackProbe.versions into playerStore.playbackVariants so the
     * version picker (QualitySelector) renders for multi-version items.
     */
    private syncProbeVersionsToStore(info: PlayerProbe): void {
        if (!info.versions || info.versions.length <= 1) {
            playerStore.setPlaybackVariants([], null);
            return;
        }
        const variants = info.versions.map((v) => this.buildPlaybackVariant(v));
        playerStore.setPlaybackVariants(variants, info.activeFileId);
    }

    buildLumastraTranscodingInfo(
        info: PlayerProbe,
        method: PlayerMethod,
    ): ReturnType<typeof playerStore.getState>['transcodingInfo'] {
        const delivery =
            this.playbackStart?.mediaId === info.mediaId &&
            'fileId' in this.playbackStart.delivery &&
            this.playbackStart.delivery.fileId === info.activeFileId
                ? this.playbackStart.delivery
                : undefined;
        method = delivery?.playMethod ?? method;
        if (method === 'direct') return null;

        const video = info.activeVersion.tracks.video;
        return {
            videoCodec:
                method === 'full_transcode'
                    ? `${video?.codec?.toUpperCase() ?? ''} → ${(delivery?.transcodeCodec ?? 'h264').toUpperCase()}`
                    : (video?.codec?.toUpperCase() ?? ''),
            videoBitrate: info.activeVersion.tracks.video?.bitrate
                ? formatBitrateInfo(info.activeVersion.tracks.video.bitrate)
                : '',
            resolution: video ? `${video.width}x${video.height}` : '',
            isTranscoding: method === 'full_transcode',
            isAudioTranscoding: method === 'audio_transcode' || method === 'full_transcode',
            transcodeReasons: delivery?.reasons ?? info.activeVersion.reasons,
            transcodeReasonCodes:
                !delivery || method === info.activeVersion.playMethod
                    ? info.activeVersion.reasonCodes
                    : [],
        };
    }

    private timelineRequestId = 0;
    private timelineItemId: string | null = null;
    private timelineFileId: string | undefined;

    refreshTimeline(info: PlayerProbe): void {
        const start = this.playbackStart;
        const delivery = start?.delivery;
        if (
            !start ||
            start.mediaId !== info.mediaId ||
            !delivery ||
            !('fileId' in delivery) ||
            delivery.fileId !== info.activeFileId
        )
            return;
        if (delivery.timeline)
            void this.fetchTimeline(delivery.timeline.href, info.mediaId, info.activeFileId);
    }

    /** Follow the selected start's href; stale session responses cannot replace its timeline. */
    private async fetchTimeline(href: string, itemId: string, fileId?: string): Promise<void> {
        const requestId = ++this.timelineRequestId;
        if (this.timelineItemId !== itemId || this.timelineFileId !== fileId) {
            playerStore.setChaptersAndSegments([], []);
            playerStore.trickplayVariants = [];
        }
        this.timelineItemId = itemId;
        this.timelineFileId = fileId;
        try {
            const { getTimelineByHref } = await import('$lib/api/playback.js');
            const { data } = await getTimelineByHref(href);
            if (requestId !== this.timelineRequestId) return;
            if (data) {
                if (playerStore.itemId !== itemId && this.currentMediaDbId !== itemId) return;
                if (fileId && data.fileId !== fileId) return;
                playerStore.setChaptersAndSegments(data.chapters, data.segments);
                playerStore.trickplayVariants = data.trickplay.variants;
                if (!playerStore.duration && data.durationMs > 0)
                    playerStore.setDuration(data.durationMs / 1000);
            }
        } catch {
            // Chapters and skip segments are optional.
        }
    }

    setLumastraHdrInfo(info: PlayerProbe): void {
        const sourceHdr = info.activeVersion.tracks.video?.hdr ?? 'sdr';
        if (sourceHdr === 'sdr') {
            playerStore.setHdrInfo(null);
            return;
        }
        const delivery =
            this.playbackStart?.mediaId === info.mediaId &&
            'fileId' in this.playbackStart.delivery &&
            this.playbackStart.delivery.fileId === info.activeFileId
                ? this.playbackStart.delivery
                : undefined;
        const method =
            delivery?.playMethod ?? this.lumastraPlayMethod ?? info.activeVersion.playMethod;
        const outputHdr =
            delivery?.outputHdr ??
            (method === info.activeVersion.playMethod
                ? info.activeVersion.outputHdr
                : method === 'full_transcode'
                  ? 'sdr'
                  : sourceHdr);
        const isToneMapped = outputHdr === 'sdr';
        playerStore.setHdrInfo({
            sourceFormat: sourceHdr,
            outputFormat: isToneMapped ? 'sdr' : (outputHdr ?? null),
            isToneMapped,
            dvProfile: info.activeVersion.tracks.video?.dvProfile,
            dvBlCompatId: info.activeVersion.tracks.video?.dvBlCompatId,
        });
    }

    buildStreamUrl(forceTranscode: boolean = false, startPositionSeconds: number = 0): string {
        const state = playerStore.getState();
        if (!state.currentMediaSource || !state.playSessionId) return '';

        const context: StreamUrlContext = {
            state,
            isSafari: this.isSafari,
            log: this.log,
        };

        const result = buildStreamUrlFromModule(context, {
            forceTranscode,
            startPositionSeconds,
            currentAdaptiveBitrate: this.currentAdaptiveBitrate,
        });

        if (!result) return '';

        if (result.playMethod === 'DirectPlay') {
            playerStore.setLoading(false);
        }

        playerStore.setPlayMethod(result.playMethod);
        playerStore.setTranscodingInfo(result.transcodingInfo);
        playerStore.setHdrInfo(result.hdrInfo);

        return result.url;
    }

    positionSubtitlesAboveControls(track: TextTrack): void {
        const isMobileDevice = browser && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
        positionSubtitleCues(track, isMobileDevice, this.effectiveSubtitleLineY);
    }

    // ============================================================================
    // Stream / Token
    // ============================================================================

    async fetchStreamToken(): Promise<string | null> {
        const grant = this.playbackStart?.grant;
        this.streamTokenExpiresAt = grant ? Date.parse(grant.expiresAt) : null;
        return grant?.token ?? null;
    }

    /** Forget the AirPlay stream token so the next use re-mints. */
    dropStreamToken(): void {
        this.streamToken = null;
        this.streamTokenPromise = null;
        this.streamTokenExpiresAt = null;
    }

    /**
     * The tokenized source failed to load. The element exposes no HTTP status,
     * so this is treated as the dead-session 401 (inactivity timeout, absolute
     * expiry, or a newer mint for this item) and repaired once per cooldown:
     * drop the token and rebuild at the current position. initializePlayback()
     * re-mints only while routed wireless, so a source still tokenized after
     * AirPlay disconnected falls back to the cookie-authed URL.
     *
     * `sourceIsTokenized`: the caller's evidence that the FAILING source
     * carried the token (a 401 from hls.js, or the element's own src). A
     * token left over from an earlier AirPlay session must not divert an
     * unrelated failure (e.g. direct play → HLS fallback) into a rebuild.
     *
     * Returns true when it took over the error.
     */
    recoverTokenizedSource(sourceIsTokenized: boolean): boolean {
        if (!this.streamToken || !this.props.enableAirPlay || !sourceIsTokenized) return false;
        // A restart/rebuild in flight owns recovery (and its old source's
        // errors are expected); never start a second concurrent rebuild.
        if (this.shouldSuppressErrors() || this.isPreparingAirPlay) return false;
        if (!this.streamTokenRecovery.tryAcquire()) return false;
        const position = this.videoElement?.currentTime || 0;
        const wireless = !!asSafariVideo(this.videoElement ?? null)
            ?.webkitCurrentPlaybackTargetIsWireless;
        this.log(' Tokenized source failed — re-minting and rebuilding', { position, wireless });
        this.dropStreamToken();
        void this.initializePlayback(false, position, wireless).catch((error: unknown) => {
            console.error('[Player] Rebuild after playback-grant failure failed:', error);
            playerStore.setLoading(false);
        });
        return true;
    }

    /**
     * A playback or session request answered 401 (or native playback failed
     * without a status). If the browser session itself is gone — a forward-auth
     * proxy dropped it mid-film, or a native session expired — reload the
     * watch page once at the current position so the page load signs back in
     * and the new player resumes there. Anything else (a 401 for one
     * resource, a probe that cannot tell) leaves the caller's error handling
     * alone. A definite probe answer holds off the next probe for 15 s; the
     * reload itself is once per tab per cooldown (claimReauthReload), so a
     * sign-in that does not stick ends on the normal error UI, not a loop.
     */
    private checkForLostBrowserSession(trigger: string): void {
        if (!browser || this.sessionLossProbe) return;
        // A hidden document is a background tab or a page being torn down
        // (pagehide stop reports); never navigate it away.
        if (document.visibilityState === 'hidden') return;
        if (Date.now() - this.lastSessionLossProbeAt < 15_000) return;

        // Capture where we are now: by the time the probe answers, a
        // fallback or reset may already have moved the element to 0.
        const state = playerStore.getState();
        const position = state.isLive
            ? null
            : state.playheadTime || this.videoElement?.currentTime || null;
        const target = buildReauthUrl(
            window.location.href,
            basePath,
            state.isLive ? null : (state.itemId ?? null),
            position,
        );
        if (target === null) return;
        const generation = this.playbackGeneration;

        this.sessionLossProbe = probeBrowserSession()
            .then((result) => {
                if (result !== 'unknown') this.lastSessionLossProbeAt = Date.now();
                if (result !== 'lost' || generation !== this.playbackGeneration) return;
                let storage: Storage | null = null;
                try {
                    storage = window.sessionStorage;
                } catch {
                    /* expected: storage blocked — claimReauthReload refuses */
                }
                if (!claimReauthReload(storage, Date.now())) {
                    this.log(' Browser session lost, re-auth reload already used', { trigger });
                    return;
                }
                this.log(' Browser session lost — reloading to sign back in', {
                    trigger,
                    position,
                });
                this.navigateForReauth(target);
            })
            .finally(() => {
                this.sessionLossProbe = null;
            });
    }

    /**
     * Full page load (not a client-side goto), so it passes the proxy's
     * sign-in. @internal — a method only so tests can stub the navigation.
     */
    navigateForReauth(target: string): void {
        window.location.assign(target);
    }

    // ============================================================================
    // Playback Initialization
    // ============================================================================

    async initializeHls(
        url: string,
        startPositionSeconds: number = 0,
        followPartyStartupClock = false,
    ): Promise<void> {
        if (this.reconnect?.getState() === 'terminal') return;
        const state = playerStore.getState();
        const mediaSource = state.currentMediaSource;
        const pm = this.ensurePlaybackManager();

        // Ensure PlaySessionId is in the URL so the server uses the same
        // session ID as the play-session-reporter (single session per playback).
        let hlsUrl = url;
        const readyDelivery = !playerStore.isLive && this.playbackStart !== null;
        if (!readyDelivery && state.playSessionId && !url.includes('PlaySessionId=')) {
            const sep = url.includes('?') ? '&' : '?';
            hlsUrl = `${url}${sep}PlaySessionId=${state.playSessionId}`;
        }

        // Include the stable per-browser device UUID so the server's manifest-level
        // stream-limit check can exclude this device's own (possibly stale) sessions
        // — otherwise a reload after a lost stop-beacon can falsely 429 a user who is
        // really at their limit only because of their own ghost session.
        if (!readyDelivery && !hlsUrl.includes('deviceId=')) {
            const sep = hlsUrl.includes('?') ? '&' : '?';
            hlsUrl = `${hlsUrl}${sep}deviceId=${encodeURIComponent(getDeviceId())}`;
        }

        // Append subtitle burn-in params if a bitmap subtitle track is active
        // and burn-in is enabled (PGS/DVBSub/VobSub require server-side encoding)
        const subIdx = state.currentSubtitleTrackIndex;
        if (
            !readyDelivery &&
            subIdx !== null &&
            subIdx !== undefined &&
            subIdx >= 0 &&
            state.forceSubtitleBurnIn
        ) {
            hlsUrl += `&SubtitleStreamIndex=${subIdx}&SubtitleMethod=Encode`;
        }

        pm.updateConfig({
            isLive: playerStore.isLive,
            sourceCodec: mediaSource?.videoStreams[0]?.codec,
            sourceBitrate: mediaSource?.bitrate,
        });

        pm.setSuppressErrors(this.suppressErrorsDuringRestart);

        // New stream: the previous one's segment bitrate says nothing about it.
        this.streamBitrateMeter.reset();
        playerStore.setStreamBitrate(null);
        playerStore.setPlaybackDeliveryInfo(this.buildHlsDeliveryInfo(hlsUrl));
        await pm.load(hlsUrl, 'hls', {
            startPosition: startPositionSeconds,
            getStartupPosition: followPartyStartupClock
                ? () =>
                      watchTogether.session?.itemId === this.props.playbackInfo.itemId
                          ? watchTogether.getSessionState()?.currentTime
                          : undefined
                : undefined,
        });
    }

    initializeDirectPlay(url: string, initialPositionSeconds?: number): void {
        if (this.reconnect?.getState() === 'terminal') return;
        const pm = this.ensurePlaybackManager();
        const video = this.videoElement;
        if (video && initialPositionSeconds !== undefined) {
            const generation = this.playbackGeneration;
            video.addEventListener(
                'loadedmetadata',
                () => {
                    if (generation !== this.playbackGeneration || video !== this.videoElement)
                        return;
                    // The party can rejoin while the file is loading. Resolve its
                    // clock at metadata delivery rather than restoring the saved
                    // progress captured before that rejoin.
                    const sessionState =
                        watchTogether.session?.itemId === this.props.playbackInfo.itemId
                            ? watchTogether.getSessionState()
                            : null;
                    video.currentTime = sessionState?.currentTime ?? initialPositionSeconds;
                    if (
                        sessionState &&
                        (!sessionState.isPlaying || watchTogether.isWatchPartySyncing)
                    )
                        video.pause();
                },
                { once: true },
            );
        }
        this.streamBitrateMeter.reset();
        playerStore.setStreamBitrate(null);
        playerStore.setPlaybackDeliveryInfo({ type: 'direct' });
        pm.load(url, 'direct');
    }

    private buildHlsDeliveryInfo(
        hlsUrl: string,
    ): ReturnType<typeof playerStore.getState>['playbackDeliveryInfo'] {
        const parsed = new SvelteURL(hlsUrl, window.location.origin);
        const containerParam = parsed.searchParams.get('hlsContainer');
        const audioModeParam = parsed.searchParams.get('hlsAudioMode');

        return {
            type: 'hls',
            hlsClient: this.isSafari ? 'native' : 'hls.js',
            hlsContainer:
                containerParam === 'mpegts'
                    ? 'mpegts'
                    : containerParam === 'fmp4' || containerParam === null
                      ? 'fmp4'
                      : 'unknown',
            hlsAudioMode:
                audioModeParam === 'demux'
                    ? 'demux'
                    : audioModeParam === 'muxed'
                      ? 'muxed'
                      : audioModeParam === null
                        ? (this.playbackProbe?.hlsAudioMode ?? 'unknown')
                        : 'unknown',
        };
    }

    async initializePlayback(
        forceTranscode: boolean = false,
        startPositionSeconds: number = 0,
        forceHls: boolean = false,
    ): Promise<void> {
        this.resetBandwidthTracking();

        if (!this.videoElement) {
            console.warn('[Player] Video element not ready, waiting...');
            await tick();
            if (!this.videoElement) {
                console.error('[Player] Video element still not ready after tick');
                playerStore.setError('Video element not available');
                return;
            }
        }

        // When playbackProbe is available, the server planner is the sole authority
        // for delivery path decisions — skip client-side direct-play heuristics.
        if (this.playbackProbe && this.lumastraPlayMethod) {
            let method = this.lumastraPlayMethod;
            const lumastraUrl = await this.buildLumastraPlaybackUrl(
                this.playbackProbe,
                method,
                startPositionSeconds,
            );

            method = this.lumastraPlayMethod ?? method;
            this.log(' Lumastra playback (planner-authoritative):', {
                method,
                forceTranscode,
                forceHls,
                url: lumastraUrl.substring(0, 80) + '...',
            });

            playerStore.setPlayMethod(lumastraMethodToPlayMethod(method));
            playerStore.setLoading(true);

            if (this.playbackStart?.delivery.kind === 'file') {
                this.initializeDirectPlay(lumastraUrl);
            } else {
                await this.initializeHls(lumastraUrl, startPositionSeconds);
            }
            return;
        }

        if (this.playbackProbe && !this.lumastraPlayMethod) {
            this.log(
                ' playbackProbe loaded but lumastraPlayMethod not yet resolved — falling to legacy path',
            );
        }

        // Legacy Jellyfin compat path — client-side direct-play decision
        const streamUrl = this.buildStreamUrl(forceTranscode, startPositionSeconds);

        if (streamUrl) {
            const state = playerStore.getState();
            const playMethod = state.playMethod;

            this.log(' Playback decision (legacy):', {
                playMethod,
                forceTranscode,
                forceHls,
                streamUrl: streamUrl.substring(0, 50) + '...',
            });

            playerStore.setLoading(true);

            if (!forceHls && (playMethod === 'DirectPlay' || streamUrl.includes('/file'))) {
                this.log(' Starting Direct Play');
                this.initializeDirectPlay(streamUrl);
            } else {
                this.log(' Starting HLS:', playMethod);
                await this.initializeHls(streamUrl, startPositionSeconds);
            }
            return;
        }

        console.warn('[Player] No stream URL available — cannot initialize playback');
        playerStore.setError('No stream URL available');
    }

    /**
     * Find the first available play method from lumastra info, in fallback priority order.
     * Excludes 'direct' since fallback implies direct play already failed.
     */
    findAvailableLumastraFallback(info: PlayerProbe): PlayerMethod | null {
        const fallbackMethods = ['remux', 'audio_transcode', 'full_transcode'] as const;
        for (const method of fallbackMethods) {
            if (!info.activeVersion.availableMethods.includes(method)) continue;
            const selectedAudio =
                info.activeVersion.tracks.audio.find(
                    (track) => track.index === playerStore.currentAudioTrackIndex,
                ) ??
                info.activeVersion.tracks.audio.find((track) => track.default) ??
                info.activeVersion.tracks.audio[0];
            if (
                method === 'remux' &&
                selectedAudio &&
                needsAudioTranscodeForBrowser(selectedAudio.codec, this.isSafari)
            )
                continue;
            return method;
        }
        return null;
    }

    /**
     * Resolve the recommended play method, falling back if the recommended one is unavailable.
     * Returns the method to use, or null if nothing is available.
     */
    resolveAvailableLumastraMethod(info: PlayerProbe): PlayerMethod | null {
        const audioOnly = selectAudioOnlyMethod(info, playerStore.getState().qualityMode);
        if (audioOnly !== 'not-applicable') {
            if (audioOnly === null) {
                toasts.error(m.player_audio_only_unavailable());
                playerStore.setQualityProfile(playerStore.previousQualityProfile);
            }
            return audioOnly;
        }
        return info.activeVersion.playable ? (info.activeVersion.playMethod ?? null) : null;
    }

    private async playbackCapabilities(): Promise<PlaybackCapabilities> {
        const caps = await ensurePathScopedCapabilities();
        const state = playerStore.getState();
        if (!caps)
            return {
                containers: ['mp4'],
                videoCodecs: ['h264'],
                audioCodecs: ['aac'],
                subtitleFormats: ['vtt'],
                hdr: [],
            };
        const path = this.isSafari ? caps.nativeHls : caps.mseHls;
        return {
            containers: caps.directFile.containers,
            videoCodecs: path.videoCodecs,
            audioCodecs: path.audioCodecs,
            subtitleFormats: state.forceSubtitleBurnIn
                ? []
                : [
                      'vtt',
                      ...(caps.subtitleRendering.ass ? ['ass', 'ssa'] : []),
                      ...(caps.subtitleRendering.pgs ? ['pgs'] : []),
                      ...(caps.subtitleRendering.vobsub ? ['vobsub'] : []),
                  ],
            hdr: caps.hdr.decode,
            maxAudioChannels: caps.maxChannels,
            ...(state.qualityMode === 'fixed'
                ? {
                      maxVideoBitrateBps: state.currentQualityProfile?.maxBitrate,
                      maxHeight: state.currentQualityProfile?.height,
                  }
                : {}),
        };
    }

    /** Renewal mutates the reporter's start in place; keep source/timeline state intact. */
    private handlePlaybackDelivery(start: PlaybackStartResponse): void {
        const previousHrefs = Array.from(this.videoElement?.querySelectorAll('track') ?? []).map(
            (track) => track.getAttribute('src'),
        );
        if (this.playbackStart !== start) this.applyPlaybackStart(start);
        else if ('trickplay' in start.delivery) {
            playerStore.trickplayManifestHref = start.delivery.trickplay?.href ?? null;
            // Preserve selection and source metadata while refreshing subtitle credentials.
            for (const track of playerStore.currentMediaSource?.subtitleStreams ?? []) {
                track.hrefs = start.delivery.subtitles?.find(
                    (sub) => sub.index === track.index,
                )?.hrefs;
            }
        }
        const nextHrefs = playerStore.subtitleTracks
            .filter(
                (track) =>
                    track.isTextSubtitleStream &&
                    track.supportsExternalStream &&
                    !isAssCodec(track.codec),
            )
            .map((track) => this.getSubtitleTextHref(track.index));
        if (
            previousHrefs.length &&
            (previousHrefs.length !== nextHrefs.length ||
                nextHrefs.some((href, index) => previousHrefs[index] !== href))
        )
            this.loadSubtitles();
        playerStore.setPlaySessionId(start.playbackSessionId);
        this.streamToken = start.grant.token;
        this.streamTokenExpiresAt = Date.parse(start.grant.expiresAt);
    }

    private subtitleStartRevision: number | undefined;
    private audioStartRevision: number | undefined;
    private subtitleBurnInReconciliationKey: string | undefined;

    /** Stable identity of the overlay actually encoded in the active video. */
    private activeBurnedSubtitleId(): string | undefined {
        const delivery = this.playbackStart?.delivery;
        if (
            !delivery ||
            (delivery.kind !== 'file' && delivery.kind !== 'hls') ||
            this.playbackStart?.mediaId !== playerStore.itemId ||
            delivery.fileId !== playerStore.currentMediaSource?.id
        )
            return undefined;
        const applied = delivery.applied?.subtitleId;
        if (!applied || applied === 'none') return undefined;
        const descriptor = delivery.subtitles?.find((track) => track.id === applied);
        return descriptor &&
            delivery.tracks?.subtitles.some(
                (track) => track.method === 'burn_in' && track.index === descriptor.index,
            )
            ? descriptor.id
            : undefined;
    }

    private reconcileBurnedSubtitleSelection(): boolean {
        const burned = this.activeBurnedSubtitleId();
        if (!burned) return false;
        const desiredTrack = playerStore.currentMediaSource?.subtitleStreams.find(
            (track) => track.index === playerStore.currentSubtitleTrackIndex,
        );
        const desired = desiredTrack?.id;
        if (desired === burned) {
            this.subtitleBurnInReconciliationKey = undefined;
            return false;
        }
        const key = `${this.playbackStart?.playbackSessionId}:${desired ?? 'none'}`;
        if (this.subtitleBurnInReconciliationKey === key) return true;
        this.subtitleBurnInReconciliationKey = key;
        // Moving to a client-rendered track must remove the old encoded overlay.
        // Consume the flag change here so the separate burn-in effect does not
        // race a duplicate restart or ask the next start to burn the new track.
        if (!isBurnInCodec(desiredTrack?.codec) && playerStore.forceSubtitleBurnIn) {
            this.lastBurnInState = false;
            playerStore.setForceSubtitleBurnIn(false);
        }
        void this.restartStreamWithNewQuality();
        return true;
    }

    /** Adopt the started file, method and grant-bearing resources together. */
    private applyPlaybackStart(start: PlaybackStartResponse): void {
        const probe = this.playbackProbe;
        const delivery = start.delivery;
        if (!probe || start.mediaId !== probe.mediaId || !isSelectedFileDelivery(delivery, probe))
            return;
        const preserveNewerAudio =
            this.audioStartRevision !== undefined &&
            this.audioStartRevision !== playerStore.audioSelectionRevision;
        const desiredAudioFileId = playerStore.currentMediaSource?.id;
        const desiredAudio = playerStore.currentMediaSource?.audioStreams.find(
            (track) => track.index === playerStore.currentAudioTrackIndex,
        );
        this.audioStartRevision = undefined;
        const preserveNewerChoice =
            this.subtitleStartRevision !== undefined &&
            this.subtitleStartRevision !== playerStore.subtitleSelectionRevision;
        const desiredIndex = playerStore.currentSubtitleTrackIndex;
        const desiredTrack = playerStore.currentMediaSource?.subtitleStreams.find(
            (track) => track.index === desiredIndex,
        );
        this.subtitleStartRevision = undefined;
        const previousDelivery =
            this.playbackStart?.mediaId === probe?.mediaId &&
            this.playbackStart &&
            probe &&
            isSelectedFileDelivery(this.playbackStart.delivery, probe)
                ? this.playbackStart.delivery
                : undefined;
        const selectedId =
            previousDelivery && 'subtitles' in previousDelivery
                ? previousDelivery.subtitles?.find(
                      (s) => s.index === playerStore.currentSubtitleTrackIndex,
                  )?.id
                : probe?.activeVersion.tracks.subtitles.find(
                      (s) => s.index === playerStore.currentSubtitleTrackIndex,
                  )?.id;
        this.playbackStart = start;
        if (!probe || start.mediaId !== probe.mediaId || !isSelectedFileDelivery(delivery, probe))
            return;
        if (delivery.playMethod) this.setLumastraPlayMethod(delivery.playMethod);
        this.updateProbedSource(probe, start.mediaId);
        if (delivery.applied) {
            const audio = delivery.tracks?.audio.find(
                (track) => track.absoluteIndex === delivery.applied?.audioStreamIndex,
            );
            if (audio && !preserveNewerAudio) {
                if (audio.index !== playerStore.currentAudioTrackIndex) {
                    playerStore.audioSelectionLanguage = null;
                    playerStore.audioSelectionReason = null;
                }
                playerStore.currentAudioTrackIndex = audio.index;
            }
            if (preserveNewerAudio && desiredAudio) {
                const desired = delivery.tracks?.audio.find((track) =>
                    desiredAudioFileId !== delivery.fileId
                        ? track.index === playerStore.currentAudioTrackIndex
                        : desiredAudio.absoluteIndex !== undefined
                          ? track.absoluteIndex === desiredAudio.absoluteIndex
                          : track.index === desiredAudio.index,
                );
                if (desired) {
                    playerStore.currentAudioTrackIndex = desired.index;
                    this.pendingAudioTrackIndex = desired.index;
                }
            }
            if (!preserveNewerChoice)
                playerStore.currentSubtitleTrackIndex =
                    delivery.subtitles?.find((s) => s.id === delivery.applied?.subtitleId)?.index ??
                    null;
        } else if (!preserveNewerChoice && selectedId && 'subtitles' in delivery) {
            playerStore.currentSubtitleTrackIndex =
                delivery.subtitles?.find((s) => s.id === selectedId)?.index ?? null;
        }
        if (preserveNewerChoice) {
            playerStore.currentSubtitleTrackIndex =
                desiredIndex === null
                    ? null
                    : (delivery.subtitles?.find(
                          (track) => track.id === (desiredTrack?.id ?? selectedId),
                      )?.index ?? playerStore.currentSubtitleTrackIndex);
            this.reconcileBurnedSubtitleSelection();
        }
        if (delivery.durationMs != null) playerStore.setDuration(delivery.durationMs / 1000);
        if (delivery.playMethod) {
            playerStore.setPlayMethod(lumastraMethodToPlayMethod(delivery.playMethod));
            const display = this.buildLumastraTranscodingInfo(probe, delivery.playMethod);
            if (display) display.transcodeReasons = delivery.reasons ?? [];
            playerStore.setTranscodingInfo(display);
        }
        this.setLumastraHdrInfo(probe);
        if (delivery.seek) {
            this.currentPlaybackInfo = {
                ...this.currentPlaybackInfo,
                streamStartPositionTicks: delivery.seek.streamStartPositionMs * 10_000,
                clientShouldSeek: delivery.seek.clientShouldSeek,
                episodeSegment:
                    delivery.seek.streamStartPositionMs > 0 && delivery.durationMs != null
                        ? {
                              startMs: delivery.seek.streamStartPositionMs,
                              endMs: delivery.durationMs,
                          }
                        : undefined,
            };
        }
        // Invalidate responses from the previous session even for the same file.
        ++this.timelineRequestId;
        playerStore.trickplayManifestHref = delivery.trickplay?.href ?? null;
        playerStore.trickplayVariants = [];
        this.refreshTimeline(probe);
    }

    private playbackMethodOverride: PlayerMethod | undefined;

    private async buildLumastraPlaybackUrl(
        info: PlayerProbe,
        method: PlayerMethod,
        seekSeconds?: number,
        isCurrent: () => boolean = () => true,
    ): Promise<string> {
        if (!(this.progressReporter instanceof PlaySessionReporter)) {
            throw new Error('Playback session reporter unavailable');
        }
        const reporter = this.progressReporter;
        const generation = this.playbackGeneration;
        const itemId = this.currentPlaybackInfo.itemId;
        const assertOwned = () => {
            if (
                !isCurrent() ||
                generation !== this.playbackGeneration ||
                itemId !== this.currentPlaybackInfo.itemId ||
                reporter !== this.progressReporter
            )
                throw new PlaybackSupersededError();
        };
        if (reporter.getSessionId()) await this.endCurrentSession('switch');
        assertOwned();
        const capabilities = await this.playbackCapabilities();
        assertOwned();
        reporter.setSessionId(undefined);
        reporter.setSelectedMethod(method);
        reporter.setCapabilities(capabilities);
        const subtitle = info.activeVersion.tracks.subtitles.find(
            (track) => track.index === playerStore.currentSubtitleTrackIndex,
        );
        const burnIn =
            playerStore.currentSubtitleTrackIndex !== null &&
            (playerStore.forceSubtitleBurnIn || isBurnInCodec(subtitle?.codec));
        reporter.setRequestedMethod(
            method === 'audio_only'
                ? method
                : burnIn
                  ? 'full_transcode'
                  : this.playbackMethodOverride,
        );
        reporter.setLumastraContext({ fileId: info.activeFileId });
        reporter.setStartPosition(seekSeconds);
        if (seekSeconds !== undefined) playerStore.setCurrentTime(seekSeconds);
        await this.reportProgress('start');
        assertOwned();
        const start = reporter.getStartResult();
        if (
            !start ||
            !('url' in start.delivery) ||
            start.mediaId !== info.mediaId ||
            !isSelectedFileDelivery(start.delivery, info)
        )
            throw new Error('Playback start failed');
        if (this.playbackStart !== start) this.applyPlaybackStart(start);
        this.streamToken = start.grant.token;
        this.streamTokenExpiresAt = Date.parse(start.grant.expiresAt);
        playerStore.setPlaySessionId(start.playbackSessionId);
        return start.delivery.url;
    }

    async fallbackToHlsTranscoding(reason: string): Promise<void> {
        if (this.directPlayFailed) return;

        console.warn(`[Player] ${reason}, falling back to HLS transcoding`);
        this.directPlayFailed = true;
        const currentPos = this.videoElement?.currentTime || 0;

        if (this.playbackProbe) {
            const nextMethod = this.findAvailableLumastraFallback(this.playbackProbe);
            if (nextMethod) {
                console.log(`[Player] Lumastra: falling back to ${nextMethod}`);
                this.playbackMethodOverride = nextMethod;
                this.setLumastraPlayMethod(nextMethod);
                playerStore.setPlayMethod(lumastraMethodToPlayMethod(nextMethod));
                try {
                    await this.initializeHls(
                        await this.buildLumastraPlaybackUrl(
                            this.playbackProbe,
                            nextMethod,
                            currentPos,
                        ),
                        currentPos,
                    );
                } catch (err) {
                    if (!(err instanceof PlaybackSupersededError)) throw err;
                    this.log(' Fallback preparation superseded');
                }
            } else {
                console.warn('[Player] Lumastra: no HLS fallback methods available');
                playerStore.setError(PLAYER_ERRORS.TRANSCODING_UNAVAILABLE);
            }
            return;
        }

        try {
            await this.initializePlayback(true, currentPos);
        } catch (err) {
            if (err instanceof PlaybackSupersededError) {
                this.log(' Fallback preparation superseded');
                return;
            }
            console.error('[Player] HLS fallback initializePlayback failed:', err);
            playerStore.setError('Failed to start transcoded playback');
        }
    }

    handlePlayError(error: Error): void {
        if (this.shouldSuppressErrors()) {
            this.log(' Ignoring play error during restart:', error.name);
            return;
        }

        if (error instanceof PlaybackSupersededError) {
            this.log(' Ignoring superseded playback preparation');
        } else if (error.name === 'NotAllowedError') {
            this.liveTvStartupDeadline.cancel(false);
            this.liveTvStartupSignal = undefined;
            playerStore.setPlaying(false);
            playerStore.setShowControls(true);
        } else if (error.name === 'AbortError' || error.message?.includes('aborted')) {
            this.log(' Fetch aborted (likely quality switch)');
        } else {
            console.error('Play error:', error);
            playerStore.setError(`Playback error: ${error.message}`);
        }
    }

    /**
     * Show the "tap to unmute" overlay after a blocked autoplay attempt fell
     * back to muted playback. Shared by the initial-load autoplay path and
     * the watch-together sync-resume path — both retry muted on
     * NotAllowedError and need the same recovery UX so the guest isn't left
     * silently muted with no visible way to fix it.
     */
    /** The source waits for the user's tap (iOS); cleared on the first 'playing'. */
    // ABR counters for the heartbeat's `adaptive` block (Active Streams / Admin badge).
    private abrSwitches = 0;
    private abrRebuffers = 0;
    awaitingTapPause = false;

    handleAutoplayResult(result: AutoplayResult): void {
        this.log(' Autoplay result:', result);
        if (result.playingMuted && result.usedMutedFallback) {
            this.showMutedAutoplayPrompt();
            return;
        }
        if (result.success) return;
        if (result.awaitingTap) {
            // iOS source waits for the tap: no startup/stall watchdog until then,
            // it would rebuild the source in a loop. Cleared in onPlaying().
            this.awaitingTapPause = true;
            playerStore.setPausedByUser(true);
            this.updatePlaybackIntent();
        }
        playerStore.setShowControls(true);
    }

    showMutedAutoplayPrompt(): void {
        this.showAutoplayMutedPrompt = true;
        this.mutedByAutoplayFallback = true;
        // Ensure, never toggle: a party guest takes the muted fallback once per
        // resume (join barrier, then the host's Play), and a second toggle flipped
        // the store back to unmuted — the store sync then unmuted the element, and
        // Chrome pauses a gesture-less autoplay the moment it is unmuted. The guest
        // sat paused at 0 while the party played (web e2e, 2026-10-01).
        if (!playerStore.isMuted) playerStore.toggleMute();
        // A party guest can take the muted fallback more than once (each resume):
        // one tutorial timer, not one per fallback.
        if (this.autoplayTutorialTimer) clearTimeout(this.autoplayTutorialTimer);
        // iOS has no per-site Safari autoplay setting. The sound action is enough.
        if (this.autoplayMutedDismissed || this.isIOS) return;
        this.autoplayTutorialTimer = setTimeout(() => {
            if (this.showAutoplayMutedPrompt && !this.autoplayMutedDismissed) {
                this.showAutoplayTutorial = true;
            }
        }, TIMING.AUTOPLAY_TUTORIAL_DELAY_MS);
    }

    handleAutoplayUnmute(): void {
        this.log(' User clicked unmute on autoplay prompt');
        this.showAutoplayMutedPrompt = false;
        this.showAutoplayTutorial = false;

        if (this.videoElement) {
            this.videoElement.muted = false;
            if (playerStore.isMuted) {
                playerStore.toggleMute();
            }
        }
    }

    handleAutoplayDismiss(): void {
        this.log(' User dismissed autoplay tutorial');
        this.autoplayMutedDismissed = true;
        this.showAutoplayTutorial = false;
        if (this.autoplayTutorialTimer) clearTimeout(this.autoplayTutorialTimer);
    }

    async fetchPlaybackProbe(itemId: string, fileId?: string): Promise<PlayerProbe | null> {
        const generation = this.playbackGeneration;
        await ensurePathScopedCapabilities();
        if (generation !== this.playbackGeneration) return null;
        const capabilities = await this.playbackCapabilities();
        // A file-specific probe contains only that file. Load all versions once
        // for deep links; subsequent switches can retain the existing picker.
        const previous = this.playbackProbe?.mediaId === itemId ? this.playbackProbe : null;
        const all =
            fileId && !previous
                ? await probePlayability(
                      itemId,
                      { capabilities },
                      () => generation === this.playbackGeneration,
                  )
                : null;
        if (generation !== this.playbackGeneration) return null;
        const preferenceSnapshot = selectionPreferenceSnapshot();
        const { data, error, status, validationError } = await probePlayability(
            itemId,
            {
                capabilities,
                fileId,
            },
            () => generation === this.playbackGeneration,
        );
        if (generation !== this.playbackGeneration) return null;
        if (validationError) {
            console.warn(
                '[Lumastra] playability probe response validation warning:',
                validationError,
            );
        }
        if (error) {
            console.error(`[Lumastra] playability probe failed: ${error}`);
            this.lastProbeRefusal = describeInfoRefusal(status, error);
            toasts.error(this.lastProbeRefusal);
            return null;
        }
        this.lastProbeRefusal = null;
        if (data) {
            this.lumastraFileId = data.activeFileId;
        }
        const result = data ? selectPlayerProbe(data, previous ?? all?.data) : null;
        return result ? { ...result, preferenceSnapshot } : null;
    }

    async switchLumastraFile(fileId: string): Promise<void> {
        // Captured once, up front: currentMediaDbId is an overridable $derived
        // (repointed to the new item by advanceEpisodeInPlace) rather than a
        // plain readonly field, so re-reading it after an `await` can't be
        // relied on to stay narrowed to `string` by this guard.
        const mediaDbId = this.currentMediaDbId;
        if (!mediaDbId || this.isSwitchingVersion) return;
        const previousFileId = this.lumastraFileId;
        const sourceProbe = this.playbackProbe;
        const sourceStart = this.playbackStart;
        const version = this.playbackProbe?.versions.find(
            (candidate) => candidate.fileId === fileId,
        );
        if (!version) return;
        this.isSwitchingVersion = true;
        this.lumastraFileId = fileId;
        this.playbackMethodOverride = undefined;
        // playheadTime survives an in-flight HLS resetForSeek() window where
        // videoElement.currentTime briefly reads 0; fall back to the element
        // if the store hasn't been populated yet (pre-initialization).
        const rawPosition = playerStore.playheadTime || this.videoElement?.currentTime || 0;
        const sourceDelivery =
            sourceProbe &&
            sourceStart?.mediaId === mediaDbId &&
            isSelectedFileDelivery(sourceStart.delivery, sourceProbe)
                ? sourceStart.delivery
                : undefined;
        const sourceOffsetMs = Math.max(0, sourceDelivery?.seek?.streamStartPositionMs ?? 0);
        const rawPositionMs = Number.isFinite(rawPosition) ? Math.max(0, rawPosition * 1000) : 0;
        const sourceDurationMs =
            sourceDelivery?.durationMs ?? sourceProbe?.activeVersion.durationMs;
        const logicalPositionMs = Math.max(0, rawPositionMs - sourceOffsetMs);
        const currentPosition =
            (typeof sourceDurationMs === 'number' &&
            Number.isFinite(sourceDurationMs) &&
            sourceDurationMs > 0
                ? Math.min(logicalPositionMs, Math.max(0, sourceDurationMs - sourceOffsetMs - 1000))
                : logicalPositionMs) / 1000;
        try {
            const newInfo = await this.fetchPlaybackProbe(mediaDbId, fileId);
            if (!newInfo) {
                toasts.error('Failed to load version info');
                this.lumastraFileId = previousFileId;
                return;
            }
            if (!newInfo.activeVersion.playable) {
                playerStore.setError(PLAYER_ERRORS.TRANSCODING_UNAVAILABLE);
                this.lumastraFileId = previousFileId;
                return;
            }
            const versionMethod = this.resolveAvailableLumastraMethod(newInfo);
            if (!versionMethod) {
                playerStore.setError(PLAYER_ERRORS.TRANSCODING_UNAVAILABLE);
                this.lumastraFileId = previousFileId;
                return;
            }

            // Acquire the shared restart guard AFTER validation so a failed
            // fetch can't leave the player stuck with isRestartingPlayback=true.
            if (!this.tryStartRestart()) {
                this.lumastraFileId = previousFileId;
                return;
            }
            // Programmatic stream replacement — see restartStreamWithNewQuality().
            this.reconnect?.beginProgrammaticRestart();

            // Snapshot previous state so we can roll back symmetrically if
            // the restart fails. Without this the store would reflect the new
            // version's metadata while playback reverted to the old file.
            const snapshot = {
                playbackProbe: this.playbackProbe,
                playbackStart: this.playbackStart,
                lumastraPlayMethod: this.lumastraPlayMethod,
                currentMediaSource: playerStore.currentMediaSource,
                playMethod: playerStore.playMethod,
                transcodingInfo: playerStore.transcodingInfo,
            };

            // Commit new version state before tearing down HLS.
            this.setPlaybackProbe(newInfo);
            this.setLumastraPlayMethod(versionMethod);
            this.syncProbeVersionsToStore(newInfo);
            this.updateProbedSource(newInfo, mediaDbId);
            playerStore.setPlayMethod(lumastraMethodToPlayMethod(versionMethod));
            playerStore.setTranscodingInfo(
                this.buildLumastraTranscodingInfo(newInfo, versionMethod),
            );
            this.refreshTimeline(newInfo);
            this.setLumastraHdrInfo(newInfo);

            // Delegate to the same orchestrator restartPlayback uses:
            // destroyPM → clearVideoSource → canplay-restore → initializeHls.
            // The old inline path skipped clearVideoSource and relied on HLS.js'
            // loadedmetadata fine-tune (drift>2, {once:true}), which frequently
            // missed and left video.currentTime stuck at 0 with the seek bar
            // pinned at 0 while buffer sat at the saved position.
            const ctx: RestartContext = {
                videoElement: this.videoElement ?? null,
                currentPosition,
                log: this.log,
                setVideoTime: this.setVideoTime.bind(this) as (
                    time: number,
                    source: string,
                ) => void,
                finishRestart: this.finishRestart.bind(this),
            };

            const stop: StopPlaybackCallbacks = {
                destroyPlaybackManager: () => this.playbackManager?.destroy(),
                clearVideoSource: () => clearVideoSource(this.videoElement ?? null),
            };

            const ui: UICallbacks = {
                setLoading: (l) => playerStore.setLoading(l),
                setCurrentTime: (t) => playerStore.setCurrentTime(t),
                setVersionSwitching: (v) => playerStore.setVersionSwitching(v),
            };

            const result = await restartForVersionChange(
                ctx,
                stop,
                ui,
                (_forceTranscode, position) =>
                    this.buildLumastraPlaybackUrl(newInfo, versionMethod, position),
                (url) => this.initializeDirectPlay(url),
                (url, startPos) => this.initializeHls(url, startPos),
                () => this.lumastraPlayMethod === 'direct',
                (requestedPosition) => {
                    const start = this.playbackStart;
                    const delivery =
                        start?.mediaId === mediaDbId &&
                        isSelectedFileDelivery(start.delivery, newInfo)
                            ? start.delivery
                            : undefined;
                    const offsetMs = Math.max(0, delivery?.seek?.streamStartPositionMs ?? 0);
                    const requestedMs = Number.isFinite(requestedPosition)
                        ? Math.max(0, requestedPosition * 1000)
                        : 0;
                    const durationMs = delivery?.durationMs ?? newInfo.activeVersion.durationMs;
                    const rawTargetMs = offsetMs + requestedMs;
                    const boundedTargetMs =
                        typeof durationMs === 'number' &&
                        Number.isFinite(durationMs) &&
                        durationMs > 0
                            ? Math.min(rawTargetMs, Math.max(0, durationMs - 1000))
                            : rawTargetMs;
                    const startedPosition = boundedTargetMs / 1000;
                    // Arm before initializeHls can synchronously emit media
                    // errors, using the actual target stream's clock.
                    this.armPostSwitchRecovery(startedPosition);
                    return startedPosition;
                },
            );

            if (result.success && result.cleanup) {
                this.cleanupPositionRestore = result.cleanup;
            } else if (!result.success) {
                this.warn('Lumastra version switch failed:', result.error);
                this.clearPostSwitchRecovery();
                // Full rollback: the orchestrator has already destroyed the
                // previous HLS stream and cleared the video element, so we
                // can't truly restore playback here — but we MUST undo the
                // committed metadata so the UI doesn't display the new
                // version's badges/bitrate over whatever state the player
                // ends up in.
                this.lumastraFileId = previousFileId;
                this.playbackStart = snapshot.playbackStart;
                playerStore.trickplayManifestHref =
                    snapshot.playbackStart && 'trickplay' in snapshot.playbackStart.delivery
                        ? (snapshot.playbackStart.delivery.trickplay?.href ?? null)
                        : null;
                ++this.timelineRequestId;
                this.setPlaybackProbe(snapshot.playbackProbe);
                this.setLumastraPlayMethod(snapshot.lumastraPlayMethod);
                if (snapshot.currentMediaSource) {
                    playerStore.updateCurrentMediaSource(snapshot.currentMediaSource);
                }
                playerStore.setPlayMethod(snapshot.playMethod);
                playerStore.setTranscodingInfo(snapshot.transcodingInfo);
                if (snapshot.playbackProbe) {
                    this.refreshTimeline(snapshot.playbackProbe);
                    this.setLumastraHdrInfo(snapshot.playbackProbe);
                    this.syncProbeVersionsToStore(snapshot.playbackProbe);
                }
            }
        } finally {
            this.isSwitchingVersion = false;
        }
    }

    /**
     * VOD buffer settings for the CURRENT quality mode.
     *
     * The audio-only rung wants a far deeper buffer (1800 s vs the 600 s video
     * default) — that deep buffer is the whole point of the rung: it is what
     * lets playback survive a tunnel or a dead spot. Resolved through one
     * function so construction and the mid-playback refresh below can never
     * disagree.
     */
    private currentHlsVodBufferSettings(): HlsVodBufferSettings | undefined {
        return playerStore.qualityMode === 'audio-only'
            ? AUDIO_ONLY_HLS_BUFFER_SETTINGS
            : this.props.hlsVodBufferSettings;
    }

    ensurePlaybackManager(): PlaybackManager {
        if (this.playbackManager) {
            // The manager is a lazy singleton that outlives quality restarts:
            // restartStreamWithNewQuality() destroys the hls.js instance but
            // never nulls `this.playbackManager`, and audio-only is not
            // persisted so it can ONLY be entered mid-playback — i.e. always on
            // an existing manager. Without re-pushing the settings here, the
            // config frozen at construction (video defaults) is what load()
            // reads, and the deep audio-only buffer never applies in the one
            // situation it exists for.
            this.playbackManager.updateConfig({
                hlsVodBufferSettings: this.currentHlsVodBufferSettings(),
            });
            return this.playbackManager;
        }

        if (!this.videoElement) {
            throw new Error('Cannot create PlaybackManager: videoElement not available');
        }
        const state = playerStore.getState();
        const mediaSource = state.currentMediaSource;

        this.playbackManager = createPlaybackManager({
            videoElement: this.videoElement,
            isSafari: this.isSafari,
            isLive: playerStore.isLive,
            autoPlay: this.props.autoPlay ?? false,
            isContinuation: this.props.isContinuation,
            // iOS native HLS can stall for good when started muted (startup-mute.ts).
            mutedAutoplayFallback: !this.isIOS,
            // iOS: a native-HLS source attached outside a tap loops on its first
            // segment while WebKit blocks playback; attach it inside the tap.
            deferNativeSourceUntilGesture: this.isIOS,
            hlsVodBufferSettings: this.currentHlsVodBufferSettings(),
            mightBeInWatchParty: () => this.mightBeInWatchParty(),
            isInWatchParty: () => watchTogether.isInWatchParty,
            log: this.log,
            sourceCodec: mediaSource?.videoStreams[0]?.codec,
            sourceBitrate: mediaSource?.bitrate,
            events: {
                onManifestParsed: () => {
                    this.suppressErrorsDuringRestart = false;
                },
                onFragmentLoaded: (bandwidth) => {
                    const state = playerStore.getState();
                    const sourceBitrate = state.currentMediaSource?.bitrate || 0;

                    this.log(' Bandwidth measured:', {
                        bandwidth: (bandwidth / 1000000).toFixed(1) + ' Mbps',
                        sourceBitrate: (sourceBitrate / 1000000).toFixed(1) + ' Mbps',
                        qualityMode: state.qualityMode,
                        currentAdaptive: this.currentAdaptiveBitrate
                            ? (this.currentAdaptiveBitrate / 1000000).toFixed(1) + ' Mbps'
                            : 'not set',
                    });

                    playerStore.setBandwidth(bandwidth);
                    playerStore.setDownloadBandwidth(bandwidth);

                    this.telemetryCtrl.recordBandwidthThrottled(bandwidth);

                    if (state.qualityMode === 'auto' && !state.isLive) {
                        this.checkAdaptiveQualitySwitch(bandwidth);
                    }
                },
                onBufferLow: (bufferAhead) => {
                    const state = playerStore.getState();
                    if (state.qualityMode === 'auto' && !state.isLive) {
                        this.log(' Buffer low:', bufferAhead.toFixed(1) + 's ahead');
                    }
                },
                onLevelSwitching: (level) => {
                    console.log(`[Player] Quality switching to level ${level}`);
                },
                onTransientDiagnostic: (error: PlaybackError) => {
                    if (error.httpStatus === 401) this.checkForLostBrowserSession('hls-retry-401');
                    this.incidentReporter?.reportError(playerStore.playSessionId ?? '', {
                        errorType: error.type,
                        stage: error.stage,
                        httpStatus: error.httpStatus,
                        serverDiagnosticCode: error.serverDiagnosticCode,
                        message: error.message,
                    });
                },
                onError: (error: PlaybackError) => {
                    if (this.wasKicked) return;

                    // During an in-flight restart/rebuild the OLD hls instance
                    // can emit fatal errors (410/network/media) as it is torn
                    // down. Ignore them — the rebuild owns recovery; handling
                    // them here would double-trigger reconnect or, on a
                    // terminal-status classification, permanently lock the
                    // reconnect UI. Mirrors the native onError()/onPlay() guards.
                    if (this.shouldSuppressErrors()) return;

                    this.incidentReporter?.reportError(playerStore.playSessionId ?? '', {
                        errorType: error.type,
                        stage: error.stage,
                        httpStatus: error.httpStatus,
                        serverDiagnosticCode: error.serverDiagnosticCode,
                        message: error.message,
                    });

                    // 401 on a tokenized source: the AirPlay stream session
                    // died — re-mint instead of a terminal auth failure.
                    if (error.httpStatus === 401 && this.recoverTokenizedSource(true)) return;
                    // A dead browser session reloads the page; the error
                    // handling below still runs in case it is not.
                    if (error.httpStatus === 401) this.checkForLostBrowserSession('hls-401');

                    // Session expired (410). Admin-stop is flagged terminal
                    // by the server header; a plain expiry is recoverable.
                    if (error.type === 'session_expired') {
                        // Live has no resumable position — a gone session is a
                        // live failure, not a VOD rebuild-at-position (mirrors
                        // the network branch's !isLive carve-out below). Use
                        // 'source_down' (not 'connection_lost') — a 410 is a
                        // server-side session invalidation, not the client's
                        // network, so "check your network" would mislead.
                        if (playerStore.isLive) {
                            // The 410 body itself names the reason when the proxy sent one.
                            if (error.liveTvFailure) {
                                this.showLiveTvFailure(error.liveTvFailure);
                                return;
                            }
                            // A channel that failed answers media requests with 410: the
                            // session state names the reason. Without one, the old copy.
                            const diagnostic = error.sessionTerminal
                                ? m.player_diagnostic_server_session_ended()
                                : m.player_diagnostic_server_session_expired();
                            void this.failLiveTvFromSession(() => {
                                this.liveTvFailure = { type: 'source_down', diagnostic };
                            });
                            return;
                        }
                        const verdict = triage410(error.sessionTerminal === true);
                        this.reconnect?.trigger('session-expired', {
                            terminal: verdict === 'terminal',
                        });
                        return;
                    }

                    // VOD network error → indefinite reconnect with HTTP
                    // triage. Live streams keep their failure handling below.
                    if (error.type === 'network' && !playerStore.isLive) {
                        const verdict = triageNetworkStatus(error.httpStatus);
                        const alreadyRecovering = this.reconnect?.getState() === 'recovering';
                        if (!alreadyRecovering) this.lastNetworkFailureStage = error.stage ?? null;
                        if (!alreadyRecovering || typeof error.httpStatus === 'number') {
                            this.beginNetworkDiagnostics(error, !alreadyRecovering);
                        }
                        // For a terminal network failure (404 file-not-found,
                        // 401/403 auth) carry the specific message into the
                        // terminal overlay instead of the generic "session
                        // ended" text — so the user sees WHY (e.g. the file
                        // isn't available) rather than an endless-looking
                        // reconnect/connection-lost state.
                        if (verdict === 'terminal' && error.message) {
                            this.pendingTerminalMessage = error.message;
                        }
                        this.reconnect?.trigger('network', {
                            terminal: verdict === 'terminal',
                        });
                        return;
                    }

                    // Fallback: fatal fragParsingError slipped past the
                    // onMediaRecoveryAttempt fast-path (e.g. if details
                    // weren't available on earlier attempts). Rebuild HLS
                    // from scratch via resetForSeek.
                    if (
                        !error.recoverable &&
                        error.details === 'fragParsingError' &&
                        this.postSwitchRecoveryTarget !== null &&
                        this.playbackManager
                    ) {
                        this.executePostSwitchReset(
                            this.postSwitchRecoveryTarget,
                            'fatal fallback',
                        );
                        return;
                    }

                    this.telemetryCtrl.recordError(error.type, error.message);

                    if (!error.recoverable) {
                        // Hard failure — no recovery is coming. Disarm the
                        // stall dead-man so it doesn't keep firing futile
                        // restartLoad() nudges on the already-dead instance.
                        this.reconnect?.setIntendedPlaying(false);
                        if (playerStore.isLive) {
                            // A per-viewer output that died answers 404/503 until a
                            // new join recreates it; try that before giving up.
                            this.recoverLiveTvOrFail(`fatal ${error.type} error`, () => {
                                void this.failLiveTvFromSession(() => {
                                    if (error.type === 'network') {
                                        this.beginLiveNetworkDiagnostics(error);
                                    } else {
                                        this.liveTvFailure = { type: 'source_down' };
                                    }
                                });
                            });
                            return;
                        }
                        playerStore.setError(error.message);
                        this.props.onerror?.({ message: error.message });
                    }
                },
                onNetworkRecoveryAttempt: (attempt, max) => {
                    console.log(`[Player] Network error recovery attempt ${attempt}/${max}`);
                },
                onMediaRecoveryAttempt: (attempt, max, details) => {
                    console.log(
                        `[Player] Media error recovery attempt ${attempt}/${max} (${details ?? 'unknown'})`,
                    );
                    // Fast-path: fragParsingError after a version switch
                    // means FFmpeg hadn't finished the fragment when HLS
                    // requested it. recoverMediaError() retries the same
                    // broken buffer and always fails — we waste ~5-10s on
                    // 3 doomed attempts. Rebuild HLS from scratch at the
                    // first attempt instead; return true so playback-manager
                    // skips recoverMediaError() and the fatal escalation.
                    if (
                        details === 'fragParsingError' &&
                        this.postSwitchRecoveryTarget !== null &&
                        this.playbackManager
                    ) {
                        this.executePostSwitchReset(
                            this.postSwitchRecoveryTarget,
                            `fast-path attempt ${attempt}/${max}`,
                        );
                        return true;
                    }
                },
                onBufferStall: () => {
                    // Live TV adapts inside hls.js across the server's ladder.
                    if (playerStore.isLive) return;
                    this.log(' Buffer stalled - checking for quality reduction');
                    this.abrCtrl.handleBufferStall();
                },
                // Byte-verified (hls.js only) network-activity signal — see
                // onProgress()'s isHlsActive() gate below for why the DOM
                // 'progress' event alone is not trusted for hls.js.
                onVerifiedNetworkActivity: () => this.reconnect?.notifyNetworkActivity(),
                // Receiver-timed delivery measurement (hls.js only). The buffer
                // reading is taken HERE, at the moment the fragment landed, so
                // the reported window says what the viewer's buffer looked like
                // while those bytes were arriving.
                onFragmentDelivered: (sample) => {
                    // The stats pill shows what the stream IS (media bitrate),
                    // not how fast the link burst it (downloadBandwidth).
                    playerStore.setStreamBitrate(
                        this.streamBitrateMeter.add({
                            bytes: sample.bytes,
                            mediaSec: sample.mediaSec,
                        }),
                    );
                    this.telemetryCtrl.recordFragmentDelivery(
                        sample,
                        this.videoElement ? bufferAheadSeconds(this.videoElement) : 0,
                    );
                },
                onCodecDetected: (info: CodecDetectionResult) => {
                    const state = playerStore.getState();

                    if (state.playMethod === 'DirectStream' && info.isActuallyTranscoding) {
                        this.log(
                            ' Correcting play method: was DirectStream but actually Transcode',
                        );
                        playerStore.setPlayMethod('Transcode');

                        const currentInfo = state.transcodingInfo;
                        if (currentInfo) {
                            playerStore.setTranscodingInfo({
                                ...currentInfo,
                                videoCodec: info.formattedCodec,
                                videoBitrate: info.formattedBitrate,
                                isTranscoding: true,
                            });
                        }
                    } else if (
                        state.transcodingInfo &&
                        info.formattedBitrate &&
                        !state.transcodingInfo.videoBitrate
                    ) {
                        // Populate bitrate from HLS manifest for Lumastra streams
                        playerStore.setTranscodingInfo({
                            ...state.transcodingInfo,
                            videoBitrate: info.formattedBitrate,
                        });
                    }
                },
                onLoadingChange: (isLoading) => {
                    playerStore.setLoading(isLoading);
                },
                onDirectPlayFailed: () => {
                    this.fallbackToHlsTranscoding('Direct play failed');
                },
                onPlayError: (error) => {
                    if (playerStore.isLive) {
                        // Autoplay blocked: the tap-to-play path, as before.
                        if (error.name === 'NotAllowedError') {
                            this.handlePlayError(error);
                            return;
                        }
                        // play() interrupted by a load or restart: not a failure.
                        if (error.name === 'AbortError') return;
                        // Live has no "HLS transcoding" fallback: re-join instead.
                        this.recoverLiveTvOrFail(`play failed (${error.message})`, () => {
                            void this.failLiveTvFromSession(() => {
                                this.liveTvFailure = { type: 'source_down' };
                            });
                        });
                        return;
                    }
                    if (!this.directPlayFailed && error.name !== 'NotAllowedError') {
                        this.fallbackToHlsTranscoding(`Play failed: ${error.message}`);
                    } else {
                        this.handlePlayError(error);
                    }
                },
                onMutedFallbackStart: () => {
                    this.mutedByAutoplayFallback = true;
                },
                onBeforeSourceChange: () => this.detachSubtitleTracksBeforeLoad(),
                onAutoplayResult: (result: AutoplayResult) => this.handleAutoplayResult(result),
                onQualitySwitch: (newLevel, bitrate, bandwidth) => {
                    this.abrSwitches += 1;
                    const telemetry = this.ensureTelemetry();
                    if (telemetry) {
                        telemetry.recordQualitySwitch(newLevel, {
                            bitrate,
                            bandwidth,
                        });
                        telemetry.recordBandwidth(bandwidth);
                    }
                    // Recorded outside the telemetry guard: the incident window
                    // must hold the lead-up even for a session whose telemetry
                    // reporter never came up.
                    this.incidentBuffer?.push({
                        t: Date.now(),
                        kind: 'quality_switch',
                        detail: { level: newLevel, bitrate, bandwidth },
                    });
                },
                onRebufferStart: (position) => {
                    this.abrRebuffers += 1;
                    const telemetry = this.ensureTelemetry();
                    if (telemetry) {
                        telemetry.recordRebufferStart(position);
                    }
                    this.incidentBuffer?.push({
                        t: Date.now(),
                        kind: 'rebuffer_event',
                        detail: { position },
                    });
                },
                onRebufferEnd: (position, _durationMs) => {
                    const telemetry = this.ensureTelemetry();
                    if (telemetry) {
                        telemetry.recordRebufferEnd(position);
                    }
                },
                onBufferStarvation: (bufferBefore) => {
                    const telemetry = this.ensureTelemetry();
                    if (telemetry) {
                        telemetry.recordBufferStarvation(bufferBefore);
                    }
                    // hls.js engine only — the native-engine equivalent lives in
                    // onWaiting()'s Safari branch, and the two are mutually
                    // exclusive per session, so this is not a duplicate entry.
                    this.incidentBuffer?.push({
                        t: Date.now(),
                        kind: 'playback_stall',
                        detail: { bufferHealth: bufferBefore },
                    });
                },
            },
        });
        return this.playbackManager;
    }

    // ============================================================================
    // Restart Orchestration
    // ============================================================================

    buildQualityRestartKey(qualityMode: QualityMode, profile: TranscodingProfile | null): string {
        if (qualityMode === 'fixed') {
            return `fixed:${profile?.maxBitrate ?? 'unknown'}`;
        }
        return `${qualityMode}:${profile?.mode ?? 'none'}`;
    }

    private applyLiveTvStreamInfo(
        info: LiveHlsDelivery,
        requestedChoice: LiveTvQualityChoice,
    ): void {
        const liveSource =
            playerStore.currentMediaSource ?? this.currentPlaybackInfo.mediaSources[0];
        if (!liveSource) throw new Error('Live TV media source is unavailable');

        const requestedProfile =
            LIVE_TV_QUALITY_PROFILES.find(
                (profile) => liveTvRungIdForProfile(profile) === requestedChoice,
            ) ?? null;
        const appliedProfile = info.adaptive
            ? AUTO_PROFILE
            : appliedLiveTvProfile(requestedProfile, info);
        const qualityMode: QualityMode = info.adaptive
            ? 'auto'
            : appliedProfile
              ? 'fixed'
              : 'original';
        this.lastQualityRestartKey = this.buildQualityRestartKey(qualityMode, appliedProfile);
        playerStore.setLiveTvQualityProfile(appliedProfile, qualityMode);
        playerStore.setLiveTvQuality(liveTvQualityState(info, requestedChoice));
        playerStore.updateCurrentMediaSource({ ...liveSource, transcodingUrl: info.url });
        playerStore.setPlayMethod(
            info.adaptive || info.appliedMaxBitrateBps !== null ? 'Transcode' : 'DirectStream',
        );
    }

    private handleLiveTvNegotiationFailure(
        result: Exclude<Awaited<ReturnType<typeof getStreamInfoWithLimitCheck>>, { ok: true }>,
        preserveCurrentPlayback: boolean = false,
    ): void {
        if ('error' in result && result.status === 410) return;
        if ('kicked' in result) {
            this.wasKicked = true;
            clearTimeout(this.liveTvAutoRetryTimer);
            // 410 from the Live TV stream endpoint is a priority eviction —
            // unless the server named another reason, keep the default copy.
            this.liveTvFailure = {
                type: 'kicked',
                blocked:
                    result.reason === 'evicted'
                        ? undefined
                        : liveTvBlockPresentation({ kind: 'session_ended' }),
            };
            this.playbackManager?.destroy();
            return;
        }
        if ('failure' in result) {
            if (preserveCurrentPlayback) {
                // The picture keeps running; say why the switch did not happen.
                toasts.error(
                    liveTvFailurePresentation(result.failure.code, {
                        simple: liveTvSimpleContext.active,
                        isAdmin: false,
                        retryable: result.failure.retryable,
                    }).message,
                );
                return;
            }
            this.showLiveTvFailure(result.failure);
            return;
        }
        // A 503 from the source means every viewer slot on the provider is taken.
        // Reporting it as "quality unavailable" hid the only actionable fact —
        // and a retry at another quality cannot help.
        if ('streamLimit' in result && !preserveCurrentPlayback) {
            this.liveTvFailure = {
                type: 'kicked',
                blocked: liveTvBlockPresentation({
                    kind: 'source_capacity',
                    limit: result.streamLimit.limit,
                }),
            };
            this.playbackManager?.destroy();
            return;
        }
        if (preserveCurrentPlayback) {
            toasts.error(m.livetv_quality_unavailable());
            return;
        }
        // Any other refusal used to end in a toast over a blank player.
        this.showLiveTvFailure({ code: 'unknown', retryable: false });
    }

    /** Station whose retry budget is persisted (the item id of a Live TV channel). */
    private liveTvBudgetStationId(): string | undefined {
        return this.props?.playbackInfo?.itemId;
    }

    /**
     * Playback started: the budget is only spent back after LIVETV_SUSTAINED_PLAYBACK_MS
     * without a failure, so a feed that plays a moment and fails again keeps its count.
     */
    private armLiveTvBudgetReset(): void {
        if (this.liveTvBudgetResetTimer !== undefined) return;
        if (this.liveTvAutoRetryAttempts === 0) return;
        this.liveTvBudgetResetTimer = setTimeout(() => {
            this.liveTvBudgetResetTimer = undefined;
            this.resetLiveTvRetryBudget();
        }, LIVETV_SUSTAINED_PLAYBACK_MS);
    }

    /** Full budget again: sustained playback, a manual retry or a deliberate channel switch. */
    private resetLiveTvRetryBudget(): void {
        clearTimeout(this.liveTvBudgetResetTimer);
        this.liveTvBudgetResetTimer = undefined;
        clearTimeout(this.liveTvAutoRetryTimer);
        this.liveTvAutoRetryAttempts = 0;
        const stationId = this.liveTvBudgetStationId();
        if (stationId) clearLiveTvRetryBudget(stationId);
    }

    /**
     * Show the Live TV failure card for a typed reason and, when the server says the failure
     * is retryable, schedule the automatic retry (see livetv-failure-retry.ts for the budget).
     */
    private showLiveTvFailure(
        input: Pick<LiveTvFailureView, 'code' | 'retryable' | 'retryAfterMs' | 'feedsTried'>,
    ): void {
        clearTimeout(this.liveTvAutoRetryTimer);
        clearTimeout(this.liveTvBudgetResetTimer);
        this.liveTvBudgetResetTimer = undefined;
        this.liveTvStartupDeadline.cancel(false);
        this.liveTvStartupSignal = undefined;
        this.reconnectDiagnosticEpoch++;
        const retry = nextLiveTvRetry(input, this.liveTvAutoRetryAttempts);
        const failure: LiveTvFailureView = {
            code: input.code,
            retryable: input.retryable,
            ...(input.retryAfterMs !== undefined ? { retryAfterMs: input.retryAfterMs } : {}),
            ...(input.feedsTried ? { feedsTried: input.feedsTried } : {}),
            attempts: this.liveTvAutoRetryAttempts,
            ...(retry ? { retryAt: Date.now() + retry.delayMs } : {}),
        };
        playerStore.setLoading(false);
        this.liveTvFailure = { type: 'stream_failed', failure };
        if (!retry) return;
        this.liveTvAutoRetryAttempts = retry.attempt;
        const stationId = this.liveTvBudgetStationId();
        if (stationId) writeLiveTvRetryBudget(stationId, retry.attempt);
        const generation = this.playbackGeneration;
        this.liveTvAutoRetryTimer = setTimeout(() => {
            if (generation === this.playbackGeneration && !this.wasKicked)
                void this.retryLiveTvInPlace();
        }, retry.delayMs);
    }

    /**
     * A media request or the player said the Live TV session is gone: ask the server whether
     * the channel failed and with which reason. `fallback` runs when it names none.
     */
    private async failLiveTvFromSession(fallback: () => void): Promise<void> {
        if (this.resolvingLiveTvFailure) return;
        this.resolvingLiveTvFailure = true;
        const generation = this.playbackGeneration;
        const sessionId = this.liveTvSessionId;
        try {
            const failure = sessionId
                ? await getPlaybackSessionFailure(sessionId, AbortSignal.timeout(3000))
                : null;
            if (generation !== this.playbackGeneration || this.wasKicked || this.liveTvFailure)
                return;
            if (failure) this.showLiveTvFailure(failure);
            else fallback();
        } finally {
            this.resolvingLiveTvFailure = false;
        }
    }

    /** Cancel the countdown; the card stays with a manual "Try again". */
    handleLiveTvCancelRetry(): void {
        clearTimeout(this.liveTvAutoRetryTimer);
        const current = this.liveTvFailure;
        if (current?.type !== 'stream_failed' || !current.failure) return;
        const failure: LiveTvFailureView = { ...current.failure };
        delete failure.retryAt;
        this.liveTvFailure = { type: 'stream_failed', failure };
    }

    /** Join the channel again without reloading the page. */
    private async retryLiveTvInPlace(busyRetried = false): Promise<void> {
        clearTimeout(this.liveTvAutoRetryTimer);
        if (this.wasKicked || !playerStore.isLive) return;
        // The persisted budget (see livetv-retry-budget.ts) survives this reload.
        if (!this.videoElement || !this.isInitialized) {
            this.reloadLiveTvPage();
            return;
        }
        if (!this.tryStartRestart()) {
            // A restart is running: a reload would only churn the channel. Look again
            // shortly, once; then leave the card for a manual retry.
            if (busyRetried) {
                this.handleLiveTvCancelRetry();
                return;
            }
            const generation = this.playbackGeneration;
            this.liveTvAutoRetryTimer = setTimeout(() => {
                if (generation === this.playbackGeneration && !this.wasKicked)
                    void this.retryLiveTvInPlace(true);
            }, 1000);
            return;
        }
        const generation = this.playbackGeneration;
        const isCurrent = (): boolean =>
            generation === this.playbackGeneration && this.isInitialized && !this.wasKicked;
        try {
            this.reconnectDiagnosticEpoch++;
            this.liveTvFailure = null;
            playerStore.setLoading(true);
            this.liveTvStartupHasProgress = false;
            this.armLiveTvStartup();
            const negotiated = await this.negotiateLiveTvStream(
                playerStore.liveTvQuality?.selection ?? getLiveTvQualityPreference(),
            );
            if (!isCurrent() || !negotiated) return;
            if (!negotiated.result.ok) {
                this.handleLiveTvNegotiationFailure(negotiated.result);
                return;
            }
            this.playbackManager?.prepareForRestart();
            await this.initializeHls(negotiated.result.streamInfo.delivery.url, 0);
            if (!isCurrent()) return;
            this.applyLiveTvStreamInfo(negotiated.result.streamInfo.delivery, negotiated.applied);
        } catch (error) {
            this.log(' Live TV in-place retry failed:', error);
            if (isCurrent() && !this.liveTvFailure) {
                this.showLiveTvFailure({ code: 'unknown', retryable: true });
            }
        } finally {
            this.finishRestart();
        }
    }

    /**
     * Negotiate a Live TV stream, degrading to Original if the quality is refused.
     *
     * A refused ceiling says nothing about whether the CHANNEL is playable — the
     * source is fine, only the requested rung or ladder is not (HDR, an unreadable
     * probe, a channel below the ladder, or an exhausted encoder budget). The server
     * degrades on its own under LIVETV_CAP_FALLBACK=source, but an operator can set
     * `refuse`, and a stale saved preference can request a quality this channel never
     * supports. Retrying at Original here means neither turns into a dead player the
     * viewer cannot escape — the quality menu they would need is inside it.
     *
     * The saved preference is deliberately NOT rewritten: the next channel may well
     * satisfy it, and silently downgrading every future channel is worse than
     * degrading this one.
     */
    private async negotiateLiveTvStream(choice: LiveTvQualityChoice): Promise<{
        result: Awaited<ReturnType<typeof getStreamInfoWithLimitCheck>>;
        applied: LiveTvQualityChoice;
    } | null> {
        const first = await this.requestLiveTvStreamInfo(choice);
        if (!first) return null;
        if (first.ok || !('capUnavailable' in first) || choice === 'original') {
            return { result: first, applied: choice };
        }
        this.log(` Live TV quality ${choice} refused (${first.capUnavailable}); retrying Original`);
        const fallback = await this.requestLiveTvStreamInfo('original');
        if (!fallback) return null;
        if (!fallback.ok) {
            // Prefer the RETRY's verdict when it is more specific than "quality
            // unavailable". Between the two calls the viewer can be kicked by priority
            // eviction, or the source can die — reporting the first call's
            // `capUnavailable` in either case skips the kicked screen and the
            // source-down screen in favour of a toast that explains neither.
            const terminal =
                'kicked' in fallback || 'failure' in fallback || 'streamLimit' in fallback;
            return { result: terminal ? fallback : first, applied: choice };
        }
        toasts.info(m.livetv_quality_fell_back_to_original());
        return { result: fallback, applied: 'original' };
    }

    private ownLiveTvSession(info: PlaybackSessionStartResponse): void {
        const previous = this.liveTvHeartbeat;
        this.liveTvSessionId = info.playbackSessionId;
        this.liveTvFeedId = info.delivery.feedId;
        this.liveTvCurrentFeedId = info.delivery.feedId;
        // The old handle can only leave its own session, even on the same station.
        void previous?.destroy();
        let deliveryUrl = info.delivery.url;
        this.liveTvHeartbeat = new LiveTvHeartbeat(
            info,
            info.reporting.intervalMs,
            () => {
                // Don't clobber a terminal 'kicked' overlay (admin / stream-
                // limit kill) — the heartbeat keeps polling after a kill and
                // would otherwise flip the correct "kicked — Browse channels"
                // UI into a "connection lost — Retry" that makes no sense.
                if (this.liveTvSessionId === info.playbackSessionId && !this.wasKicked) {
                    this.liveTvFailure = { type: 'heartbeat_lost' };
                }
            },
            () => {
                if (
                    this.liveTvSessionId === info.playbackSessionId &&
                    this.liveTvFailure?.type === 'heartbeat_lost'
                )
                    this.liveTvFailure = null;
            },
            () => {
                if (this.liveTvSessionId !== info.playbackSessionId || this.wasKicked) return;
                this.wasKicked = true;
                this.liveTvFailure = { type: 'kicked' };
                clearTimeout(this.liveTvAutoRetryTimer);
                this.playbackManager?.destroy();
            },
            (failure) => {
                // The channel failed (not a takeover): the typed card, never the kicked overlay.
                if (this.liveTvSessionId !== info.playbackSessionId || this.wasKicked) return;
                if (this.liveTvFailure?.type === 'stream_failed') return;
                if (failure) this.showLiveTvFailure(failure);
                else this.liveTvFailure = { type: 'source_down' };
            },
            async () => {
                if (
                    this.liveTvSessionId !== info.playbackSessionId ||
                    !this.videoElement ||
                    deliveryUrl === info.delivery.url
                )
                    return;
                deliveryUrl = info.delivery.url;
                const manager = this.ensurePlaybackManager();
                manager.updateConfig({ autoPlay: !this.videoElement.paused });
                await manager.load(info.delivery.url, 'hls');
            },
        );
    }

    async switchLiveTvFeed(feedId: string): Promise<boolean> {
        const previousFeedId = this.liveTvFeedId;
        this.liveTvFeedId = feedId;
        const switched = await this.switchLiveTvQuality(
            playerStore.liveTvQuality?.selection ?? getLiveTvQualityPreference(),
        );
        if (!switched) this.liveTvFeedId = previousFeedId;
        return switched;
    }

    private async requestLiveTvStreamInfo(
        choice: LiveTvQualityChoice,
    ): Promise<Awaited<ReturnType<typeof getStreamInfoWithLimitCheck>> | null> {
        this.liveTvQualityAbortController?.abort();
        const controller = new AbortController();
        this.liveTvQualityAbortController = controller;
        const generation = this.playbackGeneration;
        try {
            const pending = this.liveTvSessionId
                ? null
                : claimPlaybackSession(this.currentPlaybackInfo.itemId);
            let result = pending
                ? { ok: true as const, streamInfo: pending }
                : await getStreamInfoWithLimitCheck(
                      this.currentPlaybackInfo.itemId,
                      choice,
                      this.liveTvStartupSignal && !this.liveTvStartupSignal.aborted
                          ? AbortSignal.any([controller.signal, this.liveTvStartupSignal])
                          : controller.signal,
                      this.liveTvFeedId ?? getPreferredFeed(this.currentPlaybackInfo.itemId),
                  );
            if (
                !result.ok &&
                'error' in result &&
                result.status === 404 &&
                !this.liveTvSessionId &&
                getPreferredFeed(this.currentPlaybackInfo.itemId)
            ) {
                clearPreferredFeed(this.currentPlaybackInfo.itemId);
                result = await getStreamInfoWithLimitCheck(
                    this.currentPlaybackInfo.itemId,
                    choice,
                    controller.signal,
                );
            }
            if (
                controller.signal.aborted ||
                this.liveTvStartupSignal?.aborted ||
                generation !== this.playbackGeneration
            ) {
                if (result.ok) void leaveChannel(result.streamInfo.playbackSessionId);
                return null;
            }
            if (result.ok) this.ownLiveTvSession(result.streamInfo);
            return result;
        } finally {
            if (this.liveTvQualityAbortController === controller) {
                this.liveTvQualityAbortController = null;
            }
        }
    }

    /**
     * Re-join state of ONE Live TV playback: the budget belongs to the playback generation it
     * was started for (a channel switch starts fresh), and `inFlight` lets the several error
     * events one failure fires (hls.js fatal, the element's error, a rejected play()) share
     * one recovery instead of each burning a budget slot.
     */
    private liveTvRejoin: {
        generation: number;
        attempts: number[];
        inFlight: Promise<LiveTvRejoinOutcome> | null;
    } | null = null;

    /**
     * Re-join a Live TV channel whose stream failed in the browser's player.
     *
     * The server's per-viewer outputs (a quality rung, or the fMP4 / H.264 version an HEVC
     * channel is served as) are recreated by a new stream join, not by reloading the URL
     * that died: an encoder crash, a proxy restart or a variant the server could not carry
     * across an ingest failover all leave that URL answering 404/503. Safari's native HLS
     * reports such a failure as a bare media error with no HTTP status, which used to land in
     * the VOD "fall back to HLS transcoding" path and end in "No stream URL available".
     *
     * Up to three re-joins in two minutes, 1.5 s / 4 s / 8 s apart (a failover needs a moment
     * to produce its first segment). Resolves `recovered` (playing again, or the server's
     * answer put up its own screen), `superseded` (the playback changed, the viewer was
     * kicked, or another restart owns the player: not a failure) or `exhausted` (the caller
     * shows the Live TV failure screen).
     */
    private recoverLiveTvStream(reason: string): Promise<LiveTvRejoinOutcome> {
        if (!playerStore.isLive || this.wasKicked) return Promise.resolve('superseded');
        const generation = this.playbackGeneration;
        if (this.liveTvRejoin?.generation !== generation) {
            this.liveTvRejoin = { generation, attempts: [], inFlight: null };
        }
        const state = this.liveTvRejoin;
        state.inFlight ??= this.runLiveTvRejoin(reason, state).finally(() => {
            state.inFlight = null;
        });
        return state.inFlight;
    }

    private async runLiveTvRejoin(
        reason: string,
        state: { generation: number; attempts: number[] },
    ): Promise<LiveTvRejoinOutcome> {
        const isCurrent = () =>
            state.generation === this.playbackGeneration && this.isInitialized && !this.wasKicked;
        // Every attempt turns the spinner on; with none left the caller puts up the
        // failure screen, which must not sit under a spinner.
        const exhausted = (): LiveTvRejoinOutcome => {
            if (isCurrent()) playerStore.setLoading(false);
            return 'exhausted';
        };
        for (const delayMs of [1500, 4000, 8000]) {
            const now = Date.now();
            state.attempts = state.attempts.filter((t) => now - t < 120_000);
            if (state.attempts.length >= 3) return exhausted();
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            if (!isCurrent() || !this.videoElement || !this.playbackManager) return 'superseded';
            // A quality switch or another restart owns the player: let it finish.
            if (!this.tryStartRestart()) return 'superseded';
            state.attempts.push(Date.now());
            console.warn(
                `[Player] Live TV: ${reason}; re-joining the channel (attempt ${state.attempts.length})`,
            );
            try {
                playerStore.setLoading(true);
                const negotiated = await this.negotiateLiveTvStream(
                    playerStore.liveTvQuality?.selection ?? getLiveTvQualityPreference(),
                );
                if (!isCurrent()) return 'superseded';
                if (!negotiated) continue;
                if (!negotiated.result.ok) {
                    // The server answered (kicked, slot limit, source down): its screen.
                    this.handleLiveTvNegotiationFailure(negotiated.result);
                    if (!this.liveTvFailure && !this.wasKicked) {
                        this.liveTvFailure = { type: 'source_down' };
                    }
                    return 'recovered';
                }
                this.playbackManager.prepareForRestart();
                await this.initializeHls(negotiated.result.streamInfo.delivery.url, 0);
                if (!isCurrent()) return 'superseded';
                this.applyLiveTvStreamInfo(
                    negotiated.result.streamInfo.delivery,
                    negotiated.applied,
                );
                return 'recovered';
            } catch (error) {
                this.log(' Live TV re-join failed:', error);
            } finally {
                // Ours to release: tryStartRestart() refuses every other restart while we
                // hold it.
                this.finishRestart();
            }
        }
        return exhausted();
    }

    /**
     * A Live TV error event: re-join first, and fall back to `onExhausted` (the failure screen)
     * only when the re-joins ran out for the playback the error belonged to.
     */
    private recoverLiveTvOrFail(reason: string, onExhausted: () => void): void {
        const generation = this.playbackGeneration;
        void this.recoverLiveTvStream(reason).then((outcome) => {
            if (outcome !== 'exhausted' || this.liveTvFailure || this.wasKicked) return;
            if (generation !== this.playbackGeneration) return;
            onExhausted();
        });
    }

    async switchLiveTvQuality(choice: LiveTvQualityChoice): Promise<boolean> {
        if (!playerStore.isLive || !this.videoElement || !this.playbackManager) return false;
        if (!this.tryStartRestart()) return false;

        const generation = this.playbackGeneration;
        const playbackManager = this.playbackManager;
        const isCurrentPlayback = () =>
            generation === this.playbackGeneration &&
            this.isInitialized &&
            this.playbackManager === playbackManager;

        try {
            const previousChoice = playerStore.liveTvQuality?.selection ?? 'server';
            const result = await this.requestLiveTvStreamInfo(choice);
            if (!result || !isCurrentPlayback()) return false;
            if (!result.ok) {
                this.handleLiveTvNegotiationFailure(result, true);
                return false;
            }

            // Keep the current stream alive until the server has committed the new
            // viewer/rung ownership. A refused cap therefore never tears down playback.
            this.playbackManager.prepareForRestart();
            playerStore.setLoading(true);
            try {
                await this.initializeHls(result.streamInfo.delivery.url, 0);
                if (!isCurrentPlayback()) return false;
            } catch (switchError) {
                if (!isCurrentPlayback()) return false;
                this.log(' Live TV HLS rebuild failed, restoring prior quality:', switchError);
                const rollback = await this.requestLiveTvStreamInfo(previousChoice);
                if (!isCurrentPlayback()) return false;
                if (rollback?.ok) {
                    this.playbackManager.prepareForRestart();
                    try {
                        await this.initializeHls(rollback.streamInfo.delivery.url, 0);
                    } catch (rollbackError) {
                        if (!isCurrentPlayback()) return false;
                        this.log(' Live TV quality rollback failed:', rollbackError);
                        playerStore.setLoading(false);
                        this.liveTvFailure = { type: 'source_down' };
                        toasts.error(m.livetv_quality_restore_failed());
                        return false;
                    }
                    if (!isCurrentPlayback()) return false;
                    this.applyLiveTvStreamInfo(rollback.streamInfo.delivery, previousChoice);
                } else if (rollback) {
                    this.handleLiveTvNegotiationFailure(rollback);
                }
                toasts.error(m.livetv_quality_switch_failed());
                return false;
            }
            this.applyLiveTvStreamInfo(result.streamInfo.delivery, choice);
            // A 200 does not mean the ceiling was applied. Under
            // LIVETV_CAP_FALLBACK=source the server answers success while serving the
            // uncapped source, so without this the menu just closed and a viewer who
            // picked 720p to bound their data usage silently streamed the full source
            // with no notification at all. `source_within_cap` is excluded — there the
            // ceiling genuinely holds, the source simply already sits under it.
            const ceilingDropped =
                choice !== 'server' &&
                choice !== 'original' &&
                choice !== 'adaptive' &&
                result.streamInfo.delivery.appliedMaxBitrateBps === null &&
                result.streamInfo.delivery.reason !== 'source_within_cap';
            if (ceilingDropped) {
                toasts.info(m.livetv_quality_fell_back_to_original());
            } else {
                // Only persist a pick the server actually honoured; otherwise every
                // later channel would re-request a quality this one just refused.
                setLiveTvQualityPreference(choice);
            }
            return true;
        } catch (error) {
            this.log(' Live TV quality switch failed:', error);
            toasts.error(m.livetv_quality_switch_failed());
            return false;
        } finally {
            this.finishRestart();
        }
    }

    async restartStreamWithNewQuality(opts: { resumeAt?: number | null } = {}): Promise<void> {
        if (!this.videoElement || !this.playbackManager) return;

        if (!this.tryStartRestart()) {
            // Another restart holds the lock. Queue instead of dropping: a
            // dropped request is a quality pick that never reaches the server
            // (Windows e2e 2026-09-27, S1). This restart reads the current
            // quality/audio state when it runs, so the latest request wins.
            this.log(' Restart in flight, queueing quality restart');
            this.restartQueue.queueQuality();
            return;
        }
        this.watchTogetherCtrl?.beginSourceReplacement();
        // Whatever was queued is subsumed by this restart (it reads the current
        // state); a queued seek target survives as the resume position.
        const queued = this.restartQueue.takePending();
        const resume = this.restartQueue.captureResume(
            () => this.readRestartResume(),
            opts.resumeAt ?? queued?.position ?? null,
        );
        // Pin the displayed position for the restart window (see
        // isHoldingRestartPosition) — the element is about to read 0.
        if (resume.position > 0) playerStore.setCurrentTime(resume.position);
        // Deliberate stream replacement, not a failure: keep the stall
        // watchdog from firing on the old stream's clock while the new one
        // starts up. It re-arms once the new stream really plays.
        this.reconnect?.beginProgrammaticRestart();

        try {
            await this.restartStreamWithNewQualityInner(resume);
        } catch (err) {
            // If any awaited call in the restart body rejects (network error on
            // fetchPlaybackProbe, HLS.js load failure, etc.) the explicit
            // finishRestart() calls are skipped and isRestartingPlayback stays
            // true forever — permanently blocking future audio/quality switches
            // via the coalescer's isRestartingPlayback guard.
            this.log(' restartStreamWithNewQuality failed:', err);
            this.finishRestart();
        }
    }

    /**
     * Keep the restart lock until the new source can play, then restore the
     * position and resume if the user was playing — the same canplay-restore
     * the orchestrated restarts (version switch, ABR) use.
     *
     * The quality/audio path used to release the lock as soon as the loader
     * was set up and relied on PlaybackManager's autoplay, which only runs
     * when the page was opened with autoPlay. Opened any other way, every
     * quality or audio-track switch left the player paused (S1, steps 3-4).
     * Holding the lock also means a restart requested while this stream is
     * still starting is queued behind it instead of racing it.
     *
     * `seekToPosition` is for DIRECT play only. An HLS restart already starts
     * at the position — the server transcodes from `seek=` and hls.js gets it
     * as startPosition, with PlaybackManager's own loadedmetadata fine-tune
     * (2 s tolerance) behind that. A second, tighter correcting seek here is a
     * redundant programmatic seek into a stream that has barely started; any
     * segment request it causes outside the new generation's range makes the
     * server spawn a seek generation (a second job) for the same session.
     */
    private holdRestartUntilPlayable(resume: RestartResume, seekToPosition: boolean): void {
        const video = this.videoElement;
        if (!video) {
            this.finishRestart(true);
            return;
        }
        this.cleanupPositionRestore?.();
        const handler = createPositionRestoreHandler(
            video,
            {
                targetPosition: () =>
                    this.restartQueue.currentResume()?.position ?? resume.position,
                // Decided at restore time, below: the user may pause while the
                // new stream is still starting.
                autoResume: false,
                // HLS already positions its captured start. A newer accepted
                // seek must still supersede that old loader's start position.
                toleranceSeconds: () =>
                    seekToPosition ||
                    (this.restartQueue.currentResume()?.position ?? resume.position) !==
                        resume.position
                        ? RESTART_TIMING.POSITION_TOLERANCE_S
                        : Number.POSITIVE_INFINITY,
                timeoutMs: RESTART_TIMING.RESTORE_TIMEOUT_MS,
                onRestored: () => {
                    this.cleanupPositionRestore = null;
                    if (
                        resume.play &&
                        !playerStore.pausedByUser &&
                        !watchTogether.isInWatchParty &&
                        this.videoElement === video
                    ) {
                        video.play().catch((e: Error) => this.handleReconnectPlayError(e));
                    }
                    this.finishRestart(true);
                },
            },
            this.log,
            this.setVideoTime.bind(this) as (time: number, source: string) => void,
        );
        this.cleanupPositionRestore = handler.cleanup;
    }

    private async restartStreamWithNewQualityInner(resume: RestartResume): Promise<void> {
        this.playbackMethodOverride = undefined;
        if (!this.videoElement || !this.playbackManager) return;

        // Captured once, up front — see the same note in switchLumastraFile().
        const mediaDbId = this.currentMediaDbId;

        if (this.playbackProbe && mediaDbId) {
            const newInfo = await this.fetchPlaybackProbe(
                mediaDbId,
                this.lumastraFileId ?? undefined,
            );
            if (newInfo) {
                this.setPlaybackProbe(newInfo);
                if (!newInfo.activeVersion.playable) {
                    playerStore.setError(PLAYER_ERRORS.TRANSCODING_UNAVAILABLE);
                    this.finishRestart();
                    return;
                }
                const qualityMethod = this.resolveAvailableLumastraMethod(newInfo);
                if (!qualityMethod) {
                    playerStore.setError(PLAYER_ERRORS.TRANSCODING_UNAVAILABLE);
                    this.finishRestart();
                    return;
                }
                this.setLumastraPlayMethod(qualityMethod);
                // Captured synchronously before the first await (see
                // restartStreamWithNewQuality) and shared across a burst of
                // restarts. Reading playheadTime/currentTime here, after the
                // fetch, returned 0 once an earlier restart had reset the
                // element — the 0:14 -> 0:00 jump of S1.
                const savedTime = resume.position;
                const lumastraStreamUrl = await this.buildLumastraPlaybackUrl(
                    newInfo,
                    qualityMethod,
                    savedTime,
                );
                this.updateProbedSource(newInfo, mediaDbId);
                playerStore.setPlayMethod(
                    lumastraMethodToPlayMethod(this.lumastraPlayMethod ?? qualityMethod),
                );
                playerStore.setTranscodingInfo(
                    this.buildLumastraTranscodingInfo(newInfo, qualityMethod),
                );
                this.refreshTimeline(newInfo);
                this.setLumastraHdrInfo(newInfo);
                if (this.lumastraPlayMethod === 'direct') {
                    this.initializeDirectPlay(lumastraStreamUrl);
                } else {
                    await this.initializeHls(lumastraStreamUrl, savedTime);
                }
                this.holdRestartUntilPlayable(resume, this.lumastraPlayMethod === 'direct');
                return;
            }
            this.finishRestart();
            return;
        }

        if (!this.playbackProbe && mediaDbId) {
            const refreshedInfo = await this.fetchPlaybackProbe(
                mediaDbId,
                this.lumastraFileId ?? undefined,
            );
            if (refreshedInfo) {
                this.setPlaybackProbe(refreshedInfo);
                if (!refreshedInfo.activeVersion.playable) {
                    playerStore.setError(PLAYER_ERRORS.TRANSCODING_UNAVAILABLE);
                    this.finishRestart();
                    return;
                }
                const refreshMethod = this.resolveAvailableLumastraMethod(refreshedInfo);
                if (!refreshMethod) {
                    playerStore.setError(PLAYER_ERRORS.TRANSCODING_UNAVAILABLE);
                    this.finishRestart();
                    return;
                }
                this.setLumastraPlayMethod(refreshMethod);
                const savedTime = resume.position;
                const lumastraStreamUrl = await this.buildLumastraPlaybackUrl(
                    refreshedInfo,
                    refreshMethod,
                    savedTime,
                );
                this.updateProbedSource(refreshedInfo, mediaDbId);
                playerStore.setPlayMethod(
                    lumastraMethodToPlayMethod(this.lumastraPlayMethod ?? refreshMethod),
                );
                playerStore.setTranscodingInfo(
                    this.buildLumastraTranscodingInfo(refreshedInfo, refreshMethod),
                );
                this.refreshTimeline(refreshedInfo);
                this.setLumastraHdrInfo(refreshedInfo);
                if (this.lumastraPlayMethod === 'direct') {
                    this.initializeDirectPlay(lumastraStreamUrl);
                } else {
                    await this.initializeHls(lumastraStreamUrl, savedTime);
                }
                this.holdRestartUntilPlayable(resume, this.lumastraPlayMethod === 'direct');
                return;
            } else {
                toasts.error('Failed to reload stream. Please try again.');
            }
            this.finishRestart();
            return;
        }

        playerStore.setLoading(true);

        this.playbackManager.prepareForRestart();
        // The burst's snapshot, not prepareForRestart()'s element read: a
        // queued restart runs against an element the previous one reset.
        const savedState = { savedPosition: resume.position, wasPlaying: resume.play };
        this.log(' Restarting stream, saved state:', savedState);

        const sourceBitrate = playerStore.currentMediaSource?.videoStreams[0]?.bitrate;
        const forceTranscode = shouldForceTranscode(
            playerStore.currentQualityProfile,
            playerStore.qualityMode,
            sourceBitrate,
        );

        if (playerStore.qualityMode === 'original') {
            this.log(' Switching to original mode, resetting adaptive bitrate state');
            this.abrCtrl.reset();
        }

        await this.endSessionForRestart();

        // Refresh lumastra info for updated quality/capability settings
        const itemId =
            this.props.mediaDbId ??
            this.props.playbackInfo.internalId ??
            this.props.playbackInfo.itemId;
        if (itemId) {
            const refreshedInfo = await this.fetchPlaybackProbe(
                itemId,
                this.lumastraFileId ?? undefined,
            );
            if (refreshedInfo) {
                this.setPlaybackProbe(refreshedInfo);
                const method = this.resolveAvailableLumastraMethod(refreshedInfo);
                if (method) {
                    this.setLumastraPlayMethod(method);
                    this.updateProbedSource(refreshedInfo, itemId);
                    playerStore.setTranscodingInfo(
                        this.buildLumastraTranscodingInfo(refreshedInfo, method),
                    );
                    this.refreshTimeline(refreshedInfo);
                    this.setLumastraHdrInfo(refreshedInfo);
                    this.log(' Updated media source with new quality settings');
                } else {
                    playerStore.setError(PLAYER_ERRORS.TRANSCODING_UNAVAILABLE);
                    this.finishRestart();
                    return;
                }
            } else {
                playerStore.setError(PLAYER_ERRORS.TRANSCODING_UNAVAILABLE);
                this.finishRestart();
                return;
            }
        }

        await this.initializePlayback(forceTranscode, savedState.savedPosition);

        this.isRestartingPlayback = false;
        this.consumePendingAudioSwitch();
        this.drainQueuedRestart();

        if (this.videoElement && savedState.savedPosition > 0) {
            const restorePosition = () => {
                if (this.videoElement && this.videoElement.readyState >= 2) {
                    if (Math.abs(this.videoElement.currentTime - savedState.savedPosition) > 1) {
                        this.log(' Fine-tuning position to:', savedState.savedPosition);
                        this.setVideoTime(savedState.savedPosition, 'restore_position');
                    }
                    if (savedState.wasPlaying) {
                        this.videoElement.play().catch(console.error);
                    }
                    this.suppressErrorsDuringRestart = false;
                    this.reinitializeSubtitleRendererIfNeeded();
                    this.videoElement.removeEventListener('canplay', restorePosition);
                }
            };
            this.videoElement.addEventListener('canplay', restorePosition);
        } else if (savedState.wasPlaying && this.videoElement) {
            const startPlaying = () => {
                if (this.videoElement && this.videoElement.readyState >= 2) {
                    this.videoElement.play().catch(console.error);
                    this.suppressErrorsDuringRestart = false;
                    this.reinitializeSubtitleRendererIfNeeded();
                    this.videoElement.removeEventListener('canplay', startPlaying);
                }
            };
            this.videoElement.addEventListener('canplay', startPlaying);
        } else {
            this.suppressErrorsDuringRestart = false;
            this.reinitializeSubtitleRendererIfNeeded();
        }
    }

    /** Update playSessionId in both the store and the reporter. */
    private syncPlaySessionId(id: string): void {
        if (!playerStore.isLive && this.progressReporter instanceof PlaySessionReporter) {
            this.progressReporter.setSessionId(undefined);
        } else {
            playerStore.setPlaySessionId(id);
        }
    }

    /** Keep the file selected by the probe in sync with the next start. */
    private setPlaybackProbe(value: PlayerProbe | null): void {
        this.playbackProbe = value;
        playerStore.setAudioOnlyAvailable(
            value?.activeVersion.availableMethods.includes('audio_only') ?? false,
        );
        if (!(this.progressReporter instanceof PlaySessionReporter)) return;
        if (!value) return;
        this.progressReporter.setLumastraContext({
            fileId: value.activeFileId ?? undefined,
        });
    }

    /** Record the method for display and heartbeat diagnostics, never as a start override. */
    private setLumastraPlayMethod(method: PlayerMethod | null): void {
        this.lumastraPlayMethod = method;
        if (this.progressReporter instanceof PlaySessionReporter) {
            this.progressReporter.setSelectedMethod(method ?? undefined);
        }
    }

    async endSessionForRestart(): Promise<void> {
        const state = playerStore.getState();
        if (!state.playSessionId || !state.itemId) return;

        this.log(' Ending current playback session before mode switch...');

        await this.endCurrentSession();
        if (this.progressReporter instanceof PlaySessionReporter) {
            this.progressReporter.setSessionId(undefined);
            return;
        }

        const newSessionId = safeRandomUUID();
        this.log(' Generated new PlaySessionId:', newSessionId);
        this.syncPlaySessionId(newSessionId);
    }

    /**
     * Attach only evidence the browser can actually observe to a network
     * recovery. A failed media request alone cannot prove whether the user,
     * their DNS/VPN/proxy, or the server failed; the short, same-origin
     * liveness request narrows that ambiguity without exposing a stream URL or
     * token as part of the diagnostic request.
     */
    private beginNetworkDiagnostics(error: PlaybackError, probeReachability: boolean): void {
        if (!browser) return;

        if (!navigator.onLine) {
            this.setReconnectDiagnostic(m.player_reconnecting_client_offline());
            return;
        }

        if (typeof error.httpStatus === 'number') {
            this.setReconnectDiagnostic(this.describeStreamFailure(error));
            return;
        }

        this.setReconnectDiagnostic(m.player_reconnecting_network_checking());
        if (!probeReachability) return;

        const epoch = this.reconnectDiagnosticEpoch;
        void this.checkServerReachability(epoch);
    }

    private setReconnectDiagnostic(diagnostic: string): void {
        // Every fresh observation invalidates an older async health probe. A
        // concrete HTTP status must never be overwritten by an earlier probe.
        this.reconnectDiagnosticEpoch++;
        this.pendingReconnectDiagnostic = diagnostic;
        playerStore.setReconnectDiagnostic(diagnostic);
    }

    private describeStreamFailure(error: PlaybackError): string {
        const base = error.serverDiagnosticCode
            ? this.describeServerDiagnostic(error.serverDiagnosticCode)
            : typeof error.httpStatus === 'number'
              ? this.describeHttpStatus(error.httpStatus)
              : m.player_reconnecting_network_unknown();
        return error.stage ? `${base} · ${this.describeFailureStage(error.stage)}` : base;
    }

    private describeHttpStatus(status: number): string {
        switch (classifyHttpPlaybackDiagnostic(status)) {
            case 'authorization-rejected':
                return m.player_diagnostic_authorization_rejected({ status });
            case 'media-not-found':
                return m.player_diagnostic_media_not_found({ status });
            case 'stream-limit':
                return m.player_diagnostic_stream_limit({ status });
            case 'request-timeout':
                return m.player_diagnostic_request_timeout({ status });
            case 'gateway-timeout':
                return m.player_diagnostic_gateway_timeout({ status });
            case 'gateway-unavailable':
                return m.player_diagnostic_gateway_unavailable({ status });
            case 'server-error':
                return m.player_diagnostic_server_error({ status });
            default:
                return m.player_reconnecting_stream_http({ status });
        }
    }

    private describeFailureStage(stage: PlaybackFailureStage): string {
        switch (stage) {
            case 'manifest':
                return m.player_diagnostic_stage_manifest();
            case 'init-segment':
                return m.player_diagnostic_stage_init_segment();
            case 'media-segment':
                return m.player_diagnostic_stage_media_segment();
            default:
                return m.player_diagnostic_stage_unknown();
        }
    }

    private describeServerDiagnostic(code: StreamDiagnosticCode): string {
        switch (code) {
            case 'transcoder-start-failed':
                return m.player_diagnostic_transcoder_start_failed();
            case 'source-unavailable':
                return m.player_diagnostic_source_unavailable();
            case 'storage-read-failed':
                return m.player_diagnostic_storage_read_failed();
            case 'session-expired':
                return m.player_diagnostic_server_session_expired();
            case 'concurrency-limit':
                return m.player_diagnostic_stream_limit({ status: 429 });
            case 'playback-method-not-allowed':
                return m.playback_refusal_transcode_not_allowed();
            case 'upstream-timeout':
                return m.player_diagnostic_gateway_timeout({ status: 504 });
        }
    }

    private async checkServerReachability(epoch: number): Promise<void> {
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), 3000);
        try {
            const response = await fetch(resolve('/api/health'), {
                cache: 'no-store',
                // Liveness is public; avoid adding ambient session cookies to
                // the diagnostic request.
                credentials: 'omit',
                signal: abort.signal,
            });
            if (!this.isCurrentNetworkDiagnostic(epoch)) return;
            playerStore.setReconnectDiagnostic(
                response.ok
                    ? m.player_reconnecting_web_app_reachable()
                    : m.player_reconnecting_server_health_http({ status: response.status }),
            );
        } catch {
            if (!this.isCurrentNetworkDiagnostic(epoch)) return;
            playerStore.setReconnectDiagnostic(m.player_reconnecting_network_unknown());
        } finally {
            clearTimeout(timeout);
        }
    }

    private isCurrentNetworkDiagnostic(epoch: number): boolean {
        return (
            epoch === this.reconnectDiagnosticEpoch &&
            this.reconnect?.getState() === 'recovering' &&
            this.reconnect.getCause() === 'network'
        );
    }

    /** Live TV uses a terminal overlay rather than the VOD reconnect badge,
     *  but it receives the same evidence-based network classification. */
    private beginLiveNetworkDiagnostics(error: PlaybackError): void {
        if (!browser) {
            this.setLiveNetworkDiagnostic();
            return;
        }

        if (!navigator.onLine) {
            this.setLiveNetworkDiagnostic(m.player_reconnecting_client_offline());
            return;
        }

        if (typeof error.httpStatus === 'number') {
            this.setLiveNetworkDiagnostic(this.describeStreamFailure(error));
            return;
        }

        this.setLiveNetworkDiagnostic(m.player_reconnecting_network_checking());
        const epoch = this.reconnectDiagnosticEpoch;
        void this.checkLiveServerReachability(epoch);
    }

    /** Every live classification invalidates an older reachability probe. */
    private setLiveNetworkDiagnostic(diagnostic?: string): void {
        this.reconnectDiagnosticEpoch++;
        this.liveTvFailure = { type: 'connection_lost', diagnostic };
    }

    private async checkLiveServerReachability(epoch: number): Promise<void> {
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), 3000);
        try {
            const response = await fetch(resolve('/api/health'), {
                cache: 'no-store',
                credentials: 'omit',
                signal: abort.signal,
            });
            if (!this.isCurrentLiveNetworkDiagnostic(epoch)) return;
            this.liveTvFailure = {
                type: 'connection_lost',
                diagnostic: response.ok
                    ? m.player_reconnecting_web_app_reachable()
                    : m.player_reconnecting_server_health_http({ status: response.status }),
            };
        } catch {
            if (!this.isCurrentLiveNetworkDiagnostic(epoch)) return;
            this.liveTvFailure = {
                type: 'connection_lost',
                diagnostic: m.player_reconnecting_network_unknown(),
            };
        } finally {
            clearTimeout(timeout);
        }
    }

    private isCurrentLiveNetworkDiagnostic(epoch: number): boolean {
        return (
            epoch === this.reconnectDiagnosticEpoch &&
            this.liveTvFailure?.type === 'connection_lost'
        );
    }

    /**
     * Restart playback after the server returns 410 (session expired).
     * This happens when the transcode job was cleaned up (e.g. after deploy)
     * but the player still has the old PlaySessionId.
     *
     * One recovery attempt, dispatched by the ReconnectController.
     */
    private reconnectAttempt(cause: ReconnectCause, attempt: number): 'rebuild' | 'nudge' {
        // network / stall: a persistent failure escalates to the same
        // fresh-session rebuild the session-expired path uses, on BOTH engines.
        // On native Safari HLS the nudge is a structural no-op (restartLoad()
        // has no Hls instance, and Safari can neither re-fetch a session the
        // server has forgotten nor expose the 410 to JS), so it escalates a
        // step earlier. On hls.js the nudge (hls.startLoad()) clears most
        // transient drops, but it cannot revive a dead pipeline whose errors
        // keep classifying as generic 'network' — observed as an endless
        // "reconnecting…" spinner that only an F5 fixed — so after a few
        // failed nudges it rebuilds too. Thresholds live in reconnect-policy.
        const isNativeEngine = this.playbackManager?.isNativeEngine() ?? false;
        const action: 'nudge' | 'rebuild' =
            cause === 'session-expired' ||
            decideRecovery({
                isNativeEngine,
                attempt,
                stage:
                    cause === 'network' ? (this.lastNetworkFailureStage ?? undefined) : undefined,
            }) === 'rebuild'
                ? 'rebuild'
                : 'nudge';
        // Telemetry: one row per recovery attempt (cause + nudge-vs-rebuild +
        // engine) so a stuck nudge-loop is visible server-side instead of
        // silent. See reconnect_event / player-reconnect-hlsjs incident.
        this.telemetryCtrl.recordReconnect('attempt', {
            cause,
            attempt,
            action,
            engine: isNativeEngine ? 'native_hls' : 'hls_js',
        });
        this.incidentBuffer?.push({
            t: Date.now(),
            kind: 'reconnect_attempt',
            detail: { cause, attempt, action, media: this.getMediaSnapshot() },
        });

        if (action === 'rebuild') {
            void this.rebuildPlaybackSession();
            return 'rebuild';
        }
        // Early attempts: re-kick fragment loading (always safe).
        this.playbackManager?.restartLoad();
        // Resume only when WE own the play/pause state AND the user intends to
        // be playing. In a watch party the sync controller owns play/pause;
        // after a deliberate pause (or end) we must not auto-resume against the
        // user — re-loading segments is enough.
        if (!watchTogether.isInWatchParty && !playerStore.pausedByUser && !this.hasEnded) {
            this.videoElement?.play().catch((e: Error) => this.handleReconnectPlayError(e));
        }
        return 'nudge';
    }

    private handleReconnectPlayError(e: Error): void {
        // Autoplay policy blocked the resume (e.g. tab was backgrounded).
        // Surface tap-to-resume; the video-surface click handler resumes.
        if (e.name === 'NotAllowedError') {
            playerStore.setReconnectNeedsTap(true);
        }
    }

    /** Update the controller's notion of whether we intend to be playing.
     *  Watch-party sessions are excluded — the sync controller owns play/pause,
     *  so the stall watchdog must not fire there. */
    private updatePlaybackIntent(): void {
        // Live streams have their own failure handling (liveTvFailure) and the
        // VOD network path already excludes them — keep the stall watchdog off
        // for live too, for consistency. Watch-party sessions are sync-owned.
        this.reconnect?.setIntendedPlaying(
            !playerStore.pausedByUser &&
                !this.hasEnded &&
                !watchTogether.isInWatchParty &&
                !playerStore.isLive,
        );
    }

    /** Bind a local source rebuild to its party membership and canonical file. */
    private captureSourceReplacementRestart() {
        const generation = this.playbackGeneration;
        const itemId = this.currentPlaybackInfo.itemId;
        const video = this.videoElement;
        const partyBinding = () =>
            JSON.stringify([
                watchTogether.session?.code,
                watchTogether.session?.itemId,
                watchTogether.session?.timelineId,
                watchTogether.session?.fileId,
                watchTogether.session ? watchTogether.getMembershipRevision() : null,
            ]);
        const binding = partyBinding();
        const ownsController = () =>
            generation === this.playbackGeneration &&
            itemId === this.currentPlaybackInfo.itemId &&
            video === this.videoElement;
        const isCurrent = () => ownsController() && binding === partyBinding();
        this.watchTogetherCtrl?.beginSourceReplacement();
        const resume = this.restartQueue.captureResume(() => this.readRestartResume());
        let recovered = false;
        const recoverCurrentSource = () => {
            if (recovered || !ownsController() || isCurrent()) return;
            recovered = true;
            this.cleanupPositionRestore?.();
            this.cleanupPositionRestore = null;
            this.isRestartingPlayback = false;
            this.suppressErrorsDuringRestart = false;
            this.restartQueue.reset();
            const currentParty = watchTogether.session;
            if (currentParty?.itemId === itemId) {
                // Canonical files may be absent from the old cached probe.
                // Recreate from the current route and its fresh party snapshot.
                const url = currentParty.fileId
                    ? `/watch/${itemId}?fileId=${currentParty.fileId}`
                    : `/watch/${itemId}`;
                window.location.assign(resolve(url));
            } else void this.restartStreamWithNewQuality({ resumeAt: resume.position });
        };

        return {
            resume,
            isCurrent,
            recoverCurrentSource,
            finishRestart: (reinit?: boolean) => {
                if (isCurrent()) this.finishRestart(reinit);
                else recoverCurrentSource();
            },
        };
    }

    /** Reattach delivery issued by the progress reporter's implicit session recovery. */
    private async restoreReportedSession(): Promise<void> {
        const delivery = this.playbackStart?.delivery;
        const video = this.videoElement;
        if (!delivery || !('url' in delivery) || !video) return;
        // A restart in flight already attaches the session the reporter created (the reporter
        // dedups `start`); queueing here would drain into a third session after it ends.
        if (!this.tryStartRestart()) return;
        const { resume, isCurrent, recoverCurrentSource, finishRestart } =
            this.captureSourceReplacementRestart();
        this.reconnect?.beginProgrammaticRestart();
        try {
            this.playbackManager?.destroy(true);
            clearVideoSource(video);
            playerStore.setLoading(true);
            if (delivery.kind === 'file') this.initializeDirectPlay(delivery.url);
            else await this.initializeHls(delivery.url, resume.position);
            if (!isCurrent()) {
                recoverCurrentSource();
                return;
            }
            this.cleanupPositionRestore = createPositionRestoreHandler(
                video,
                {
                    targetPosition: () =>
                        this.restartQueue.currentResume()?.position ?? resume.position,
                    autoResume: () =>
                        isCurrent() &&
                        !watchTogether.isInWatchParty &&
                        !playerStore.pausedByUser &&
                        !this.hasEnded &&
                        resume.play,
                    toleranceSeconds: RESTART_TIMING.POSITION_TOLERANCE_S,
                    timeoutMs: RESTART_TIMING.RESTORE_TIMEOUT_MS,
                    onRestored: () => finishRestart(true),
                },
                this.log,
                (time, source) => {
                    if (isCurrent()) this.setVideoTime(time, source as SeekSource);
                },
            ).cleanup;
        } catch (error) {
            this.warn('Reported session source recovery failed:', error);
            finishRestart();
        }
    }

    /**
     * Rebuild the play session at the current position after a recoverable
     * 410. Unlike the old session-expired restart path, there is NO local
     * attempt cap (the ReconnectController owns the retry budget) and NO
     * setError on failure (the controller retries on backoff). Auto-resume is
     * decided by playback intent, not the element's paused state.
     */
    private async rebuildPlaybackSession(): Promise<void> {
        // Both early returns below refund the recovery attempt. The ladder has
        // ALREADY incremented its counter by the time it dispatches us (see
        // ReconnectController.scheduleNextAttempt), so bailing here would spend
        // a slot on a no-op. A session created with transcode_job_id NULL can
        // issue no /hls manifest requests, while the ladder counts it and
        // declares terminal before any useful recovery attempt.
        if (!playerStore.getState().currentMediaSource) {
            this.log(' Reconnect: media source gone, skipping rebuild');
            this.reconnect?.refundAttempt();
            return;
        }
        if (!this.tryStartRestart()) {
            // A restart is already in flight — this attempt cannot do anything,
            // and the one in flight is the recovery we are waiting on.
            this.log(' Reconnect: restart already in flight, refunding attempt');
            this.reconnect?.refundAttempt();
            return;
        }

        const { resume, isCurrent, recoverCurrentSource, finishRestart } =
            this.captureSourceReplacementRestart();
        const currentPosition = resume.position;
        // Auto-resume is governed by playback INTENT, never the element's
        // post-stall paused value. Suppressed in a watch party (sync resumes).
        const autoResume = () =>
            isCurrent() &&
            !playerStore.pausedByUser &&
            !this.hasEnded &&
            !watchTogether.isInWatchParty;

        this.log(' Reconnect rebuild at position:', currentPosition, {
            autoResume: autoResume(),
        });

        const ctx: RestartContext = {
            videoElement: this.videoElement ?? null,
            currentPosition,
            log: this.log,
            setVideoTime: (time, source) => {
                if (isCurrent()) this.setVideoTime(time, source as SeekSource);
            },
            finishRestart,
        };

        const stop: StopPlaybackCallbacks = {
            destroyPlaybackManager: () => {
                if (isCurrent()) this.playbackManager?.destroy(true);
            },
            clearVideoSource: () => {
                if (isCurrent()) clearVideoSource(this.videoElement ?? null);
            },
        };

        const session: SessionCallbacks = {
            endCurrentSession: () => this.endCurrentSession('switch', isCurrent),
            generateNewSessionId: generatePlaySessionId,
            setPlaySessionId: (id) => {
                if (isCurrent()) this.syncPlaySessionId(id);
            },
            hasActiveSession: () =>
                !!(playerStore.getState().playSessionId && playerStore.getState().itemId),
        };

        const ui: UICallbacks = {
            setLoading: (l) => {
                if (isCurrent()) playerStore.setLoading(l);
            },
            setCurrentTime: (t) => {
                if (isCurrent()) playerStore.setCurrentTime(t);
            },
        };

        // Start a new session and follow its delivery URL. The legacy builder
        // has no URL for a planner-driven HLS source.
        const playbackProbe = this.playbackProbe;
        const lumastraMethod = this.lumastraPlayMethod;
        const source = selectRebuildStreamSource({
            lumastra:
                playbackProbe && lumastraMethod
                    ? { info: playbackProbe, method: lumastraMethod }
                    : null,
            buildLumastraUrl: (info, method, startPos) =>
                this.buildLumastraPlaybackUrl(info, method, startPos, isCurrent),
            buildLegacyUrl: (forceTranscode, startPos) =>
                this.buildStreamUrl(forceTranscode, startPos),
            initializeHls: async (url, startPos) => {
                if (isCurrent()) await this.initializeHls(url, startPos);
            },
            initializeDirectPlay: (url) => {
                if (isCurrent()) this.initializeDirectPlay(url);
            },
            isDirectDelivery: () => this.playbackStart?.delivery.kind === 'file',
        });

        const result = await restartForBitrateChange(
            ctx,
            stop,
            session,
            ui,
            source.buildUrl,
            source.initialize,
            () => {
                if (isCurrent()) this.abrCtrl.clearSamples();
            },
            {
                autoResume,
                isCancelled: () => !isCurrent() || this.reconnect?.getState() === 'terminal',
                getRestorePosition: () =>
                    this.restartQueue.currentResume()?.position ?? currentPosition,
            },
        );

        if (!isCurrent()) {
            result.cleanup?.();
            recoverCurrentSource();
            return;
        }
        if (result.success && result.cleanup) {
            this.cleanupPositionRestore = result.cleanup;
        }
        if (!result.success) {
            // Do NOT setError — the ReconnectController retries on backoff.
            this.warn('Reconnect rebuild failed:', result.error);
        }
    }

    async restartPlaybackAtBitrate(targetBitrate: number): Promise<void> {
        if (!this.tryStartRestart()) return;
        const { resume, isCurrent, recoverCurrentSource, finishRestart } =
            this.captureSourceReplacementRestart();
        // Programmatic stream replacement — see restartStreamWithNewQuality().
        this.reconnect?.beginProgrammaticRestart();
        const currentPosition = resume.position;
        this.log(' Restarting at bitrate:', {
            targetBitrate: (targetBitrate / 1000000).toFixed(1) + ' Mbps',
            currentPosition: currentPosition.toFixed(1) + 's',
        });

        const ctx: RestartContext = {
            videoElement: this.videoElement ?? null,
            currentPosition,
            log: this.log,
            setVideoTime: (time, source) => {
                if (isCurrent()) this.setVideoTime(time, source as SeekSource);
            },
            finishRestart,
        };

        const stop: StopPlaybackCallbacks = {
            destroyPlaybackManager: () => {
                if (isCurrent()) this.playbackManager?.destroy();
            },
            clearVideoSource: () => {
                if (isCurrent()) clearVideoSource(this.videoElement ?? null);
            },
        };

        const session: SessionCallbacks = {
            endCurrentSession: () => this.endCurrentSession(),
            generateNewSessionId: generatePlaySessionId,
            setPlaySessionId: (id) => {
                if (isCurrent()) this.syncPlaySessionId(id);
            },
            hasActiveSession: () =>
                !!(playerStore.getState().playSessionId && playerStore.getState().itemId),
        };

        const ui: UICallbacks = {
            setLoading: (l) => {
                if (isCurrent()) playerStore.setLoading(l);
            },
            setCurrentTime: (t) => {
                if (isCurrent()) playerStore.setCurrentTime(t);
            },
        };

        const result = await restartForBitrateChange(
            ctx,
            stop,
            session,
            ui,
            (forceTranscode, startPos) =>
                this.playbackProbe && this.lumastraPlayMethod
                    ? this.buildLumastraPlaybackUrl(
                          this.playbackProbe,
                          this.lumastraPlayMethod,
                          startPos,
                          isCurrent,
                      )
                    : this.buildStreamUrl(forceTranscode, startPos),
            async (url, startPos) => {
                if (isCurrent()) await this.initializeHls(url, startPos);
            },
            () => {
                if (isCurrent()) this.abrCtrl.clearSamples();
            },
            {
                isCancelled: () => !isCurrent(),
                getRestorePosition: () =>
                    this.restartQueue.currentResume()?.position ?? currentPosition,
            },
        );

        if (!isCurrent()) {
            result.cleanup?.();
            recoverCurrentSource();
            return;
        }
        if (result.success && result.cleanup) {
            this.cleanupPositionRestore = result.cleanup;
        } else if (!result.success) {
            this.warn('Bitrate change restart failed:', result.error);
        }
    }

    async restartStreamAtPosition(targetTime: number): Promise<void> {
        this.log(' restartStreamAtPosition called:', {
            targetTime: targetTime.toFixed(2) + 's',
            isRestartingPlayback: this.isRestartingPlayback,
        });

        if (!this.tryStartRestart()) {
            // Don't drop the user's seek: run it once the restart in flight
            // finishes (merged into a queued quality restart if there is one).
            this.restartQueue.queueSeek(targetTime);
            return;
        }
        // This restart lands at targetTime, which supersedes any queued seek.
        const queued = this.restartQueue.takePending();
        if (queued?.kind === 'quality') {
            // A quality change was waiting too: requeue it so it runs after
            // this seek restart and resumes at the new position.
            this.restartQueue.queueQuality();
            this.restartQueue.queueSeek(targetTime);
        }

        const ctx: RestartContext = {
            videoElement: this.videoElement ?? null,
            currentPosition: targetTime,
            log: this.log,
            setVideoTime: this.setVideoTime.bind(this) as (time: number, source: string) => void,
            finishRestart: this.finishRestart.bind(this),
        };

        const stop: StopPlaybackCallbacks = {
            destroyPlaybackManager: () => this.playbackManager?.destroy(),
            clearVideoSource: () => clearVideoSource(this.videoElement ?? null),
        };

        const session: SessionCallbacks = {
            endCurrentSession: () => this.endCurrentSession(),
            generateNewSessionId: generatePlaySessionId,
            setPlaySessionId: (id) => this.syncPlaySessionId(id),
            hasActiveSession: () =>
                !!(playerStore.getState().playSessionId && playerStore.getState().itemId),
        };

        const ui: UICallbacks & { setSeeking: (s: boolean) => void } = {
            setLoading: (l) => playerStore.setLoading(l),
            setSeeking: (s) => playerStore.setSeeking(s),
        };

        const result = await restartForSeekPosition(
            ctx,
            stop,
            session,
            ui,
            (forceTranscode, startPos, forceHls) =>
                this.initializePlayback(forceTranscode, startPos, forceHls),
        );

        if (result.success && result.cleanup) {
            this.cleanupPositionRestore = result.cleanup;
        } else if (!result.success) {
            this.warn('Seek position restart failed:', result.error);
        }
    }

    async restartPlayback(): Promise<void> {
        if (!this.tryStartRestart()) return;

        const currentPosition = playerStore.currentTime;

        this.directPlayFailed = false;

        const mediaSource = playerStore.currentMediaSource;
        const videoStream = mediaSource?.videoStreams[0];

        this.log(' Restarting playback', {
            container: mediaSource?.container,
            codec: videoStream?.codec,
            videoRange: videoStream?.videoRange,
            supportsDirectPlay: mediaSource?.supportsDirectPlay,
            restorePosition: currentPosition,
        });

        const ctx: RestartContext = {
            videoElement: this.videoElement ?? null,
            currentPosition,
            log: this.log,
            setVideoTime: this.setVideoTime.bind(this) as (time: number, source: string) => void,
            finishRestart: this.finishRestart.bind(this),
        };

        const stop: StopPlaybackCallbacks = {
            destroyPlaybackManager: () => this.playbackManager?.destroy(),
            clearVideoSource: () => clearVideoSource(this.videoElement ?? null),
        };

        const ui: UICallbacks = {
            setLoading: (l) => playerStore.setLoading(l),
        };

        const canDirectPlaySource = (): boolean => {
            const playbackProbe = this.playbackProbe;
            if (playbackProbe) {
                return this.lumastraPlayMethod === 'direct';
            }
            const ms = playerStore.currentMediaSource;
            if (!ms?.supportsDirectPlay) return false;
            const vs = ms.videoStreams?.[0];
            return canPlayDirectly(vs?.codec ?? '', vs?.videoRange, ms.container);
        };

        const result = await restartForVersionChange(
            ctx,
            stop,
            ui,
            (forceTranscode, startPos) =>
                this.playbackProbe && this.lumastraPlayMethod
                    ? this.buildLumastraPlaybackUrl(
                          this.playbackProbe,
                          this.lumastraPlayMethod,
                          startPos,
                      )
                    : this.buildStreamUrl(forceTranscode, startPos),
            (url) => this.initializeDirectPlay(url),
            (url, startPos) => this.initializeHls(url, startPos),
            canDirectPlaySource,
        );

        if (result.success && result.cleanup) {
            this.cleanupPositionRestore = result.cleanup;
        } else if (!result.success) {
            this.warn('Version change restart failed:', result.error);
        }
    }

    // ============================================================================
    // Telemetry (delegated to TelemetryController)
    // ============================================================================

    ensureTelemetry(): ReturnType<TelemetryController['ensure']> {
        return this.telemetryCtrl.ensure();
    }

    resetTelemetryTrackingState(): void {
        this.telemetryCtrl.resetTrackingState();
    }

    async destroyTelemetry(): Promise<void> {
        await this.telemetryCtrl.destroy();
    }

    destroyTelemetryViaBeacon(): void {
        this.telemetryCtrl.destroyViaBeacon();
    }

    /**
     * End the active play session.
     *
     * @param reason Defaults to 'switch' because almost every caller is
     * PROGRAMMATIC (reconnect rebuild, quality/mode restart, item switch).
     * Reporting those as 'user' made play_sessions.stop_reason useless for
     * telling a human "stop" from the machinery churning sessions — exactly
     * what you need to read when diagnosing a rebuild loop. The one genuinely
     * user-initiated caller (stopAndCleanup, i.e. leaving the player) passes
     * 'user' explicitly.
     */
    async endCurrentSession(
        reason: 'user' | 'completion' | 'unload' | 'error' | 'switch' = 'switch',
        isCurrent: () => boolean = () => true,
    ): Promise<void> {
        await this.destroyTelemetry();
        if (!isCurrent()) return;

        try {
            await this.reportProgress('stop', reason);
        } catch (e) {
            this.log(' Failed to send stop event:', e);
        }
    }

    // ============================================================================
    // Bandwidth / ABR (delegated to AbrController)
    // ============================================================================

    checkAdaptiveQualitySwitch(measuredBandwidth: number): void {
        this.abrCtrl.checkQualitySwitch(measuredBandwidth);
    }

    ensureBandwidthEstimator(): NativeBandwidthEstimator {
        return this.abrCtrl.ensureBandwidthEstimator();
    }

    resetBandwidthTracking(): void {
        this.abrCtrl.resetBandwidthTracking();
    }

    // ============================================================================
    // Subtitle Management
    // ============================================================================

    /**
     * iOS Safari passes every <track> child present when a source starts loading
     * to AVFoundation as an out-of-band subtitle track. Next to an HLS master
     * playlist that fails the whole load: AVFoundation -11800 / -50 on
     * availableMediaCharacteristicsWithMediaSelectionOptions, MediaError 4
     * (iPhone 2026-10-15, same stream 2/2: <track> before load fails, after
     * loadedmetadata plays and shows). So on iOS tracks are removed before every
     * new source and attached again once its metadata has loaded.
     */
    detachSubtitleTracksBeforeLoad(): void {
        const video = this.videoElement;
        if (!this.isIOS || !video) return;
        video.querySelectorAll('track').forEach((track) => track.remove());
        this.nativeTrackToSubtitleIndex.clear();
        this.subtitleLoadDeferredUntilMetadata = true;
    }

    /** Keep browser auto-selection from bypassing Off or the styled overlay.
     * TextTrackList is not reactive: Safari may enable a track after our first
     * display pass, or add an in-band caption only once media starts arriving.
     */
    observeNativeSubtitleSelection(video: HTMLVideoElement): () => void {
        const tracks = video.textTracks;
        if (!tracks?.addEventListener) return () => {};
        const reconcile = (): void => {
            // iOS native fullscreen owns its caption menu while the custom
            // player UI is unavailable. The exit handler restores our selection.
            if (this.videoElement === video && !this.isIOSNativeFullscreen)
                this.updateSubtitleDisplay();
        };
        tracks.addEventListener('addtrack', reconcile);
        tracks.addEventListener('change', reconcile);
        return () => {
            tracks.removeEventListener('addtrack', reconcile);
            tracks.removeEventListener('change', reconcile);
        };
    }

    loadSubtitles(): void {
        const video = this.videoElement;
        if (!video) return;

        if (this.isIOS && video.readyState < HTMLMediaElement.HAVE_METADATA) {
            // Attached in onLoadedMetadata; see detachSubtitleTracksBeforeLoad.
            this.detachSubtitleTracksBeforeLoad();
            this.logSub('loadSubtitles deferred until loadedmetadata (iOS)');
            return;
        }
        this.subtitleLoadDeferredUntilMetadata = false;

        const currentGeneration = ++this.subtitleLoadGeneration;

        if (this.pendingShowTimeouts.size > 0) {
            this.logSub(
                'loadSubtitles: Cancelling pending timeouts from previous load:',
                this.pendingShowTimeouts.size,
            );
            for (const timeoutId of this.pendingShowTimeouts) {
                clearTimeout(timeoutId);
            }
            this.pendingShowTimeouts.clear();
        }

        const existingTracks = video.querySelectorAll('track');
        existingTracks.forEach((track) => track.remove());
        this.nativeTrackToSubtitleIndex.clear();

        this.logSub('loadSubtitles() called', {
            generation: currentGeneration,
            totalSubtitleTracks: playerStore.subtitleTracks.length,
            currentSubtitleIndex: playerStore.currentSubtitleTrackIndex,
        });

        let nativeTrackIndex = 0;
        playerStore.subtitleTracks.forEach((sub) => {
            if (sub.isTextSubtitleStream && sub.supportsExternalStream) {
                if (isAssCodec(sub.codec)) {
                    this.logSub('Skipping ASS subtitle from VTT track (AkariSub handles it):', {
                        index: sub.index,
                        codec: sub.codec,
                        displayTitle: sub.displayTitle,
                    });
                    return;
                }

                const track = document.createElement('track');
                track.kind = 'subtitles';
                track.label = sub.displayTitle;
                track.srclang = sub.languageCode || 'und';
                const subtitleUrl = this.getSubtitleTextHref(sub.index);
                track.src = subtitleUrl;
                track.default = sub.index === playerStore.currentSubtitleTrackIndex;

                const currentIndex = nativeTrackIndex;
                const sourceId = playerStore.currentMediaSource?.id;
                const isCurrentTrack = (): boolean =>
                    currentGeneration === this.subtitleLoadGeneration &&
                    video === this.videoElement &&
                    sourceId === playerStore.currentMediaSource?.id &&
                    track.parentElement === video &&
                    this.nativeTrackToSubtitleIndex.get(track.track) === sub.index;
                track.addEventListener('error', (e) => {
                    if (
                        !isCurrentTrack() ||
                        playerStore.currentSubtitleTrackIndex !== sub.index ||
                        !sourceId
                    )
                        return;
                    this.nativeSubtitleFailure = {
                        index: sub.index,
                        sourceId,
                        revision: playerStore.subtitleSelectionRevision,
                    };
                    console.error(
                        `[Player:Subtitles] Failed to load track ${currentIndex}: "${sub.displayTitle}"`,
                        e,
                    );
                });
                track.addEventListener('load', () => {
                    if (!isCurrentTrack()) return;
                    const failure = this.nativeSubtitleFailure;
                    if (failure && failure.sourceId === sourceId && failure.index === sub.index)
                        this.nativeSubtitleFailure = null;
                    this.logSub(`Track ${currentIndex} loaded successfully: "${sub.displayTitle}"`);
                });

                video.appendChild(track);

                this.nativeTrackToSubtitleIndex.set(track.track, sub.index);
                this.logSub('Added native text track:', {
                    nativeIndex: nativeTrackIndex,
                    subtitleIndex: sub.index,
                    displayTitle: sub.displayTitle,
                    isDefault: track.default,
                    src: subtitleUrl,
                });
                nativeTrackIndex++;
            }
        });

        this.logSub('loadSubtitles() complete', {
            nativeTracksAdded: nativeTrackIndex,
            nativeTrackMapping: Object.fromEntries(this.nativeTrackToSubtitleIndex),
        });

        requestAnimationFrame(() => {
            if (currentGeneration !== this.subtitleLoadGeneration) {
                this.logSub('loadSubtitles RAF aborted - newer load started', {
                    thisGeneration: currentGeneration,
                    currentGeneration: this.subtitleLoadGeneration,
                });
                return;
            }

            if (!this.videoElement) return;

            // No preloading: a track's VTT is fetched only once it leaves
            // 'disabled', which updateSubtitleDisplay() does for the SELECTED
            // track alone. This used to flip every track to 'hidden' "for cue
            // loading", so a file with 54 embedded SRT tracks made the browser
            // download all 54 (~1,000 cues each) and the server fork one
            // ffmpeg WebVTT extraction per track (Windows e2e 2026-09-27, S11).
            this.updateSubtitleDisplay(currentGeneration);
        });
    }

    /**
     * Register a cuechange handler that mirrors the track's active cues into
     * `activeSrtCue` (plain text) so the custom .portrait-subtitle-overlay can
     * render them. Used in overlay mode (portrait / Safari) where the native
     * track is kept 'hidden'. Tags are stripped and whitespace-only cues are
     * discarded so the overlay never paints an empty box.
     */
    private attachCueChangeHandler(track: TextTrack): void {
        const update = (): void => {
            const active = track.activeCues;
            if (active && active.length > 0) {
                const texts: string[] = [];
                for (let j = 0; j < active.length; j++) {
                    const cue = active[j] as VTTCue;
                    if (cue.text) {
                        const stripped = cue.text.replace(/<[^>]*>/g, '').trim();
                        if (stripped) texts.push(stripped);
                    }
                }
                this.activeSrtCue = texts.join('\n') || null;
            } else {
                this.activeSrtCue = null;
            }
        };
        track.oncuechange = update;
        // oncuechange only fires on transitions; seed the currently-active cue.
        update();
    }

    /**
     * Register a cuechange handler that positions native cues at the user's
     * subtitle line as they become active. Used for the native ::cue path.
     *
     * This guarantees positioning even when the VTT loads *after* the track is
     * shown (the waitForCues "show anyway" fallback) — otherwise late cues stay
     * at the browser default (bottom of frame) until something forces the
     * position effect to re-run (e.g. nudging the Position slider).
     */
    private attachRepositionHandler(track: TextTrack): void {
        const apply = (): void => {
            const cues = track.activeCues;
            if (!cues) return;
            const pos = this.effectiveSubtitleLineY;
            for (let j = 0; j < cues.length; j++) {
                const cue = cues[j] as VTTCue;
                cue.snapToLines = false;
                cue.line = pos;
            }
        };
        track.oncuechange = apply;
        apply();
    }

    updateSubtitleDisplay(loadGeneration?: number): void {
        const video = this.videoElement;
        if (!video?.textTracks) return;

        if (this.pendingShowTimeouts.size > 0) {
            this.logSub('Cancelling pending show timeouts:', this.pendingShowTimeouts.size);
            for (const timeoutId of this.pendingShowTimeouts) {
                clearTimeout(timeoutId);
            }
            this.pendingShowTimeouts.clear();
        }

        const currentSubtitleIndex = playerStore.currentSubtitleTrackIndex;
        const isPgsActive = this.isPgsSubtitle(currentSubtitleIndex);
        const isAssActive = this.isAssSubtitle(currentSubtitleIndex);
        const isVobsubActive = this.isVobsubSubtitle(currentSubtitleIndex);
        const hasSpecialRenderer =
            isPgsActive || isAssActive || isVobsubActive || !!this.activeBurnedSubtitleId();

        const currentSubtitleTrack =
            currentSubtitleIndex !== null
                ? playerStore.subtitleTracks.find((t) => t.index === currentSubtitleIndex)
                : null;

        this.logSub('updateSubtitleDisplay() called', {
            currentSubtitleIndex,
            currentSubtitleTitle: currentSubtitleTrack?.displayTitle ?? 'OFF',
            currentSubtitleCodec: currentSubtitleTrack?.codec ?? 'N/A',
            isPgsActive,
            isAssActive,
            isVobsubActive,
            hasSpecialRenderer,
            nativeTextTracksCount: video.textTracks.length,
            nativeTrackMapping: Object.fromEntries(this.nativeTrackToSubtitleIndex),
            loadGeneration,
        });

        for (let i = 0; i < video.textTracks.length; i++) {
            const track = video.textTracks[i];
            const subtitleIndex = this.nativeTrackToSubtitleIndex.get(video.textTracks[i]);
            const subtitleTrack =
                subtitleIndex !== undefined
                    ? playerStore.subtitleTracks.find((t) => t.index === subtitleIndex)
                    : undefined;

            const oldMode = track.mode;
            let newMode: TextTrackMode;

            // Every track that is not the selected one stays 'disabled': a
            // 'hidden' track is fetched and parsed by the browser, which for a
            // file with dozens of embedded tracks means dozens of VTT
            // extractions on the server (S11). Switching to a track later goes
            // disabled -> hidden -> waitForCues below, which loads it then.
            if (hasSpecialRenderer) {
                newMode = 'disabled';
            } else if (subtitleIndex !== undefined && subtitleIndex === currentSubtitleIndex) {
                if (this.useSubtitleOverlay) {
                    // Safari / portrait: keep the native track 'hidden' so cues
                    // still parse and fire cuechange (feeding activeSrtCue), but
                    // the browser paints nothing — the .portrait-subtitle-overlay
                    // renders the text. Avoids WebKit's empty ::cue boxes. The
                    // cuechange handler is (re)attached after the loop.
                    newMode = 'hidden';
                } else {
                    newMode = 'showing';
                    this.positionSubtitlesAboveControls(track);
                }
            } else {
                newMode = 'disabled';
            }

            if (newMode === 'showing' && oldMode !== 'showing') {
                // Any '* → showing' transition must go through waitForCues so
                // the user's subtitle position (cue.line) is applied after
                // cues are parsed. Disabled tracks additionally need to be
                // bumped to 'hidden' first to trigger VTT fetch + parse.
                if (oldMode === 'disabled') {
                    this.logSub(`  Track ${i} was disabled - setting to hidden first to load cues`);
                    track.mode = 'hidden';
                }

                const trackRef = track;
                const trackIndex = i;
                const trackElement = Array.from(video.querySelectorAll('track')).find(
                    (element) => element.track === track,
                ) as HTMLTrackElement | undefined;

                const showTrackWithVerification = () => {
                    if (
                        loadGeneration !== undefined &&
                        loadGeneration !== this.subtitleLoadGeneration
                    ) {
                        this.logSub(
                            `  Track ${trackIndex} showTrack skipped - newer load started`,
                            {
                                thisGeneration: loadGeneration,
                                currentGeneration: this.subtitleLoadGeneration,
                            },
                        );
                        return;
                    }

                    const currentSelectedIndex = playerStore.currentSubtitleTrackIndex;
                    const mappedIndex = this.nativeTrackToSubtitleIndex.get(trackRef);

                    if (mappedIndex !== currentSelectedIndex) {
                        this.logSub(`  Track ${trackIndex} showTrack skipped - selection changed`, {
                            mappedIndex,
                            currentSelectedIndex,
                        });
                        return;
                    }

                    trackRef.mode = 'showing';
                    this.logSub(`  Track ${trackIndex} set to showing`, {
                        cueCount: trackRef.cues?.length ?? 0,
                        actualMode: trackRef.mode,
                    });
                    this.positionSubtitlesAboveControls(trackRef);
                    // Keep positioning cues as they appear — covers cues that
                    // finish loading after this point (slow VTT extraction).
                    this.attachRepositionHandler(trackRef);

                    const verifyTimeoutId = setTimeout(() => {
                        this.pendingShowTimeouts.delete(verifyTimeoutId);

                        if (
                            loadGeneration !== undefined &&
                            loadGeneration !== this.subtitleLoadGeneration
                        ) {
                            return;
                        }

                        const stillSelected = playerStore.currentSubtitleTrackIndex;
                        const stillMapped = this.nativeTrackToSubtitleIndex.get(trackRef);

                        if (stillMapped === stillSelected && trackRef.mode !== 'showing') {
                            this.logSub(
                                `  Track ${trackIndex} mode was reset! Re-applying 'showing'`,
                                {
                                    currentMode: trackRef.mode,
                                    expectedMode: 'showing',
                                },
                            );
                            trackRef.mode = 'showing';
                            this.positionSubtitlesAboveControls(trackRef);
                        }
                    }, SUBTITLE.VERIFY_DELAY_MS);
                    this.pendingShowTimeouts.add(verifyTimeoutId);
                };

                const waitForCues = (attempt: number = 0) => {
                    if (
                        loadGeneration !== undefined &&
                        loadGeneration !== this.subtitleLoadGeneration
                    ) {
                        this.logSub(
                            `  Track ${trackIndex} waitForCues aborted - newer load started`,
                            {
                                thisGeneration: loadGeneration,
                                currentGeneration: this.subtitleLoadGeneration,
                            },
                        );
                        return;
                    }

                    const currentSelectedIndex = playerStore.currentSubtitleTrackIndex;
                    const mappedIndex = this.nativeTrackToSubtitleIndex.get(trackRef);
                    if (mappedIndex !== currentSelectedIndex) {
                        this.logSub(
                            `  Track ${trackIndex} waitForCues aborted - selection changed`,
                        );
                        return;
                    }

                    const hasCues = trackRef.cues && trackRef.cues.length > 0;
                    // readyState 2 = LOADED, 3 = ERROR. Only treat LOADED as
                    // ready; an errored VTT should not trigger the attempt-limit
                    // fallback "show anyway" (would flip track to showing with
                    // zero cues).
                    const isReady = trackElement?.readyState === 2;

                    this.logSub(`  Track ${trackIndex} waitForCues attempt ${attempt}`, {
                        hasCues,
                        cueCount: trackRef.cues?.length ?? 0,
                        readyState: trackElement?.readyState,
                        trackMode: trackRef.mode,
                    });

                    const hasErrored = trackElement?.readyState === 3;

                    if (hasCues || (isReady && attempt >= 2)) {
                        showTrackWithVerification();
                    } else if (hasErrored) {
                        this.logSub(
                            `  Track ${trackIndex} VTT load errored (readyState=3); not forcing 'showing'`,
                        );
                    } else if (attempt < SUBTITLE.MAX_CUE_WAIT_ATTEMPTS) {
                        const timeoutId = setTimeout(() => {
                            this.pendingShowTimeouts.delete(timeoutId);
                            waitForCues(attempt + 1);
                        }, SUBTITLE.CUE_WAIT_INTERVAL_MS);
                        this.pendingShowTimeouts.add(timeoutId);
                    } else {
                        this.logSub(
                            `  Track ${trackIndex} giving up waiting for cues, showing anyway`,
                        );
                        showTrackWithVerification();
                    }
                };

                waitForCues(0);
            } else {
                if (oldMode !== newMode) track.mode = newMode;

                if (oldMode === 'showing' && newMode !== 'showing') {
                    this.activeSrtCue = null;
                }
                if (newMode === 'disabled') {
                    track.oncuechange = null;
                }
            }

            const trackEl = Array.from(video.querySelectorAll('track')).find(
                (element) => element.track === track,
            ) as HTMLTrackElement | undefined;

            this.logSub(`  Native track ${i}: "${track.label}"`, {
                nativeIndex: i,
                mappedSubtitleIndex: subtitleIndex,
                subtitleTitle: subtitleTrack?.displayTitle,
                oldMode,
                newMode,
                isSelected: subtitleIndex === currentSubtitleIndex,
                cueCount: track.cues?.length ?? 0,
                trackReadyState: trackEl?.readyState,
                trackSrc: trackEl?.src?.substring(0, 80) + '...',
            });
        }

        // Drive the custom subtitle overlay (.portrait-subtitle-overlay). In
        // overlay mode (Safari / portrait) attach the cuechange handler to the
        // selected, now-'hidden' text track so its cues feed activeSrtCue.
        // Otherwise clear it so a stale overlay never lingers.
        if (this.useSubtitleOverlay && !hasSpecialRenderer && currentSubtitleIndex !== null) {
            let attached = false;
            for (let i = 0; i < video.textTracks.length; i++) {
                const overlayTrack = video.textTracks[i];
                if (
                    this.nativeTrackToSubtitleIndex.get(video.textTracks[i]) ===
                    currentSubtitleIndex
                ) {
                    this.attachCueChangeHandler(overlayTrack);
                    attached = true;
                } else if (overlayTrack.oncuechange) {
                    // Clear a stale handler from a previously-selected overlay
                    // track — 'hidden' tracks still fire cuechange, so without
                    // this an old track keeps overwriting activeSrtCue. Safe
                    // here: in overlay mode no track is 'showing', so this never
                    // clobbers the native reposition handler.
                    overlayTrack.oncuechange = null;
                }
            }
            if (!attached) this.activeSrtCue = null;
        } else {
            this.activeSrtCue = null;
            // Native ::cue path: guarantee the selected track has the reposition
            // cuechange handler regardless of how it became visible (the browser
            // auto-shows a `default` track, bypassing the hidden->showing
            // transition where it would otherwise be installed). Without this the
            // cues stay at line:auto (bottom of frame) until the Position slider
            // is nudged.
            if (!hasSpecialRenderer && currentSubtitleIndex !== null) {
                for (let i = 0; i < video.textTracks.length; i++) {
                    const nativeTrack = video.textTracks[i];
                    if (
                        this.nativeTrackToSubtitleIndex.get(video.textTracks[i]) ===
                            currentSubtitleIndex &&
                        nativeTrack.mode !== 'disabled'
                    ) {
                        this.attachRepositionHandler(nativeTrack);
                        break;
                    }
                }
            }
        }

        this.logSub('updateSubtitleDisplay() complete');
    }

    updateSubtitleRendererContext(): void {
        if (!this.subtitleRenderer) return;

        const state = playerStore.getState();
        if (state.currentMediaSource && state.itemId) {
            this.subtitleRenderer.setContext({
                itemId: state.itemId,
                mediaSourceId: state.currentMediaSource.id,
                subtitleStreams: state.currentMediaSource.subtitleStreams || [],
            });
        }
        this.subtitleRenderer.setVideoElement(this.videoElement ?? null);
    }

    async initSpecialSubtitleRenderer(subtitleIndex: number): Promise<void> {
        const renderer = this.subtitleRenderer;
        const video = this.videoElement;
        if (!renderer || !video) return;

        const generation = ++this.subtitleRendererGeneration;
        this.cancelSubtitleWork?.();
        this.subtitleInitializationFailure = null;
        const playbackGeneration = this.playbackGeneration;
        const sourceId = playerStore.currentMediaSource?.id;
        if (!sourceId) return;
        const isCurrent = (): boolean =>
            generation === this.subtitleRendererGeneration &&
            playbackGeneration === this.playbackGeneration &&
            renderer === this.subtitleRenderer &&
            video === this.videoElement &&
            sourceId === playerStore.currentMediaSource?.id &&
            subtitleIndex === playerStore.currentSubtitleTrackIndex;

        const state = playerStore.getState();
        const isDirectPlay = state.playMethod === 'DirectPlay';

        const safariVideoForDebug = asSafariVideo(this.videoElement ?? null);
        const audioTracksBefore = safariVideoForDebug?.audioTracks;
        const hlsAudioBefore = this.playbackManager?.getAudioTracks();
        this.logSub('initSpecialSubtitleRenderer: Audio state BEFORE init:', {
            subtitleIndex,
            videoMuted: this.videoElement?.muted,
            videoVolume: this.videoElement?.volume,
            nativeAudioTracksCount: audioTracksBefore?.length ?? 0,
            hlsAudioTracksCount: hlsAudioBefore?.length ?? 0,
            playMethod: state.playMethod,
        });

        this.logSub('initSpecialSubtitleRenderer: Initializing renderer for index', subtitleIndex);

        let success = false;
        let attemptedHref: string | undefined;
        for (let attempt = 0; attempt <= SUBTITLE.INIT_MAX_RETRIES; attempt++) {
            if (!isCurrent()) return;
            // Re-read delivery on retry: credentials may have renewed after failure.
            attemptedHref = playerStore.subtitleTracks.find(
                (track) => track.index === subtitleIndex,
            )?.hrefs?.raw;
            this.updateSubtitleRendererContext();
            success = await this.initializeSubtitleAttempt(renderer, subtitleIndex);
            if (!isCurrent()) {
                // A file/video change without a replacement initialization may
                // have completed this renderer against a source that is gone.
                if (
                    generation === this.subtitleRendererGeneration &&
                    renderer === this.subtitleRenderer
                )
                    renderer.disposeAll();
                return;
            }
            if (success) break;

            renderer.disposeAll();
            if (attempt < SUBTITLE.INIT_MAX_RETRIES) {
                await new Promise<void>((resolve) => {
                    const finish = (): void => {
                        clearTimeout(timer);
                        if (this.cancelSubtitleWork === finish) this.cancelSubtitleWork = null;
                        resolve();
                    };
                    const timer = setTimeout(finish, SUBTITLE.INIT_RETRY_DELAY_MS * 2 ** attempt);
                    this.cancelSubtitleWork = finish;
                });
            }
        }
        if (!success) {
            this.subtitleInitializationFailure = {
                index: subtitleIndex,
                sourceId,
                href: attemptedHref,
                revision: playerStore.subtitleSelectionRevision,
            };
            this.logSub('Subtitle renderer retries exhausted:', subtitleIndex);
            return;
        }

        const audioTracksAfter = safariVideoForDebug?.audioTracks;
        const hlsAudioAfter = this.playbackManager?.getAudioTracks();
        this.logSub('initSpecialSubtitleRenderer: Renderer initialization result:', {
            subtitleIndex,
            success,
            hasActiveRenderer: renderer.hasActiveRenderer(),
            videoMutedAfter: this.videoElement?.muted,
            videoVolumeAfter: this.videoElement?.volume,
            nativeAudioTracksCountAfter: audioTracksAfter?.length ?? 0,
            hlsAudioTracksCountAfter: hlsAudioAfter?.length ?? 0,
        });

        if (isDirectPlay && this.videoElement && (audioTracksAfter?.length ?? 0) > 1) {
            const currentAudioIndex = state.currentAudioTrackIndex;
            this.logSub(
                'initSpecialSubtitleRenderer: Re-applying audio track for Safari:',
                currentAudioIndex,
            );

            setTimeout(() => {
                if (isCurrent()) {
                    this.applyDirectPlayAudioTrack(playerStore.currentAudioTrackIndex);
                }
            }, SUBTITLE.SAFARI_AUDIO_FIX_DELAY_MS);
        }

        if (success && this.subtitleRenderer) {
            const style = playbackPreferences.subtitleStyle || DEFAULT_SUBTITLE_STYLE;
            this.logSub('initSpecialSubtitleRenderer: Applying subtitle style to new renderer');
            // The new renderer takes the current style here, so the live-update effect's
            // dedupe key from the previous renderer no longer says what is on screen.
            this.lastAppliedStyle = null;
            this.subtitleRenderer.applyStyle({
                fontSize: style.fontSize,
                positionY: style.positionY,
                textColor: style.textColor,
                outlineColor: style.outlineColor,
                outlineWidth: style.outlineWidth,
                shadowBlur: style.shadowBlur,
                backgroundColor: style.backgroundColor,
            });
        }
    }

    private initializeSubtitleAttempt(
        renderer: SubtitleRendererManager,
        subtitleIndex: number,
    ): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            let settled = false;
            const finish = (success: boolean): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (this.cancelSubtitleWork === cancel) this.cancelSubtitleWork = null;
                resolve(success);
            };
            const cancel = (): void => finish(false);
            const timer = setTimeout(() => {
                renderer.disposeAll();
                finish(false);
            }, SUBTITLE.INIT_TIMEOUT_MS);
            this.cancelSubtitleWork = cancel;
            try {
                void renderer.initRenderer(subtitleIndex).then(finish, (error: unknown) => {
                    this.logSub('Subtitle renderer initialization failed:', error);
                    finish(false);
                });
            } catch (error) {
                this.logSub('Subtitle renderer initialization failed:', error);
                finish(false);
            }
        });
    }

    disposeAllSubtitleRenderers(): void {
        this.subtitleRendererGeneration++;
        this.cancelSubtitleWork?.();
        this.subtitleInitializationFailure = null;
        this.logSub('disposeAllSubtitleRenderers: Disposing all renderers');
        this.subtitleRenderer?.disposeAll();
    }

    async reinitializeSubtitleRendererIfNeeded(): Promise<void> {
        const currentSubtitleIndex = playerStore.currentSubtitleTrackIndex;
        const hadActiveSpecialRenderer = this.subtitleRenderer?.hasActiveSpecialRenderer() ?? false;
        const currentIsClientRendered =
            currentSubtitleIndex !== null && this.isClientRenderedSubtitle(currentSubtitleIndex);

        this.logSub('reinitializeSubtitleRendererIfNeeded called', {
            currentSubtitleIndex,
            hasVideoElement: !!this.videoElement,
            hadActiveSpecialRenderer,
            currentIsClientRendered,
        });

        if (this.videoElement) {
            this.loadSubtitles();
        }

        // A Lumastra version switch or a subtitle-track change that leaves us
        // without a client-rendered selection must still tear down the old
        // PGS/ASS/VobSub renderer — otherwise it keeps painting cues from
        // the previous file over the new video.
        if (hadActiveSpecialRenderer && !currentIsClientRendered) {
            this.log(' Disposing stale client-rendered subtitle renderer');
            this.disposeAllSubtitleRenderers();
        }

        if (!currentIsClientRendered) return;

        this.log(' Reinitializing special subtitle renderer');

        this.disposeAllSubtitleRenderers();

        const generation = this.subtitleRendererGeneration;
        const playbackGeneration = this.playbackGeneration;
        const renderer = this.subtitleRenderer;
        const video = this.videoElement;
        const sourceId = playerStore.currentMediaSource?.id;

        await new Promise((resolve) => setTimeout(resolve, TIMING.STABILIZATION_WAIT_MS));

        if (
            generation !== this.subtitleRendererGeneration ||
            playbackGeneration !== this.playbackGeneration ||
            renderer !== this.subtitleRenderer ||
            video !== this.videoElement ||
            sourceId !== playerStore.currentMediaSource?.id ||
            currentSubtitleIndex !== playerStore.currentSubtitleTrackIndex
        )
            return;

        await this.initSpecialSubtitleRenderer(currentSubtitleIndex);
    }

    // ============================================================================
    // Progress Reporting
    // ============================================================================

    /** Derive the subtitle-delivery method the server should record for this
     *  heartbeat. The client-side reporter only describes how the track is
     *  being consumed right now (none, canvas render, or HLS VTT). Burn-in is
     *  authoritative on the server side and is written by the HLS pipeline. */
    private deriveSubtitleMethod(subtitleStreamIndex: number | null): ClientSubtitleMethod {
        if (subtitleStreamIndex === null) return 'none';
        if (this.isClientRenderedSubtitle(subtitleStreamIndex)) return 'client_render';
        return 'external_vtt';
    }

    async reportProgress(
        eventType: 'start' | 'progress' | 'stop',
        endReason?: 'user' | 'completion' | 'unload' | 'error' | 'switch',
    ): Promise<void> {
        if (!this.progressReporter) return;
        // The user already declined to take over from another tab — every
        // subsequent report would otherwise re-attempt the start (the
        // reporter's `restartSessionAndResend` path POSTs a fresh start
        // when sessionId is null), which is exactly what Cancel meant to
        // prevent.
        if (this.userCancelledTabConflict) return;

        // Suppress interval 'progress' heartbeats until a real position has
        // been confirmed by either onSeeked or the onTimeUpdate initial-position
        // block. 'start' and 'stop' are lifecycle events and always flow.
        if (eventType === 'progress' && !this.hasReportedRealPosition) {
            return;
        }

        const state = playerStore.getState();
        if (!this.hasValidPlaybackState(state)) return;

        // Same-browser conflict gate — probe other tabs once per controller
        // life before the first `start` report. Concurrent reportProgress
        // calls share the same promise so we ask the user exactly once and
        // every caller waits on that single decision. Cancel → pause and
        // skip the start; the other tab continues uninterrupted. Phases 1+2
        // (server supersede + heartbeat backstop) cover unsupported browsers.
        //
        // Skip entirely in a Watch Together party: multiple tabs/devices playing
        // the same item is the whole point there, not a conflict — the party
        // sync coordinates playback, so the "already playing in another tab"
        // prompt is a false positive.
        if (
            eventType === 'start' &&
            this.sameBrowserChannel &&
            this.currentMediaDbId &&
            !watchTogether.isInWatchParty
        ) {
            if (!this.probeAndModalPromise && !this.hasProbedSameBrowser) {
                this.hasProbedSameBrowser = true;
                this.probeAndModalPromise = this.runProbeAndModal();
            }
            if (this.probeAndModalPromise) {
                const proceed = await this.probeAndModalPromise;
                if (!proceed) return;
            }
        }

        // `state` is a live store reference and the tab-conflict probe above
        // awaits a user decision — during that await the player can be torn
        // down (currentMediaSource → null), so the validity check at the top is
        // stale. Re-check before dereferencing currentMediaSource.id below.
        if (!state.currentMediaSource) return;

        // Auto-advance / quality-restart: the playSessionId changes but
        // the controller instance is reused. Catch the rollover here so
        // the new session resets its engagement accumulator.
        this.syncEngagementToActiveSession(state.playSessionId);

        const { audioStreamIndex, audioStreamIndexAbsolute, subtitleStreamIndex } =
            this.getValidatedStreamIndices(state);

        const maxStreamingBitrate =
            state.qualityMode === 'fixed' && state.currentQualityProfile?.maxBitrate
                ? state.currentQualityProfile.maxBitrate
                : undefined;

        const delivery = this.playbackStart?.delivery;
        const ok = await this.progressReporter.report(eventType, {
            subtitleSelectionRevision: playerStore.subtitleSelectionRevision,
            audioSelectionRevision: playerStore.audioSelectionRevision,
            itemId: state.itemId,
            mediaSourceId: state.currentMediaSource.id,
            currentTime: this.readPlaybackPosition(),
            isPaused: state.isPaused,
            isMuted: state.isMuted,
            volume: state.volume ?? 1,
            playMethod: state.playMethod,
            playSessionId: state.playSessionId,
            // Persist the ABSOLUTE stream index (matches DB media_streams.stream_index
            // and the Jellyfin /j/ path); language lookup uses the relative index.
            audioStreamIndex: audioStreamIndexAbsolute,
            subtitleStreamIndex,
            subtitleId:
                (delivery &&
                'subtitles' in delivery &&
                delivery.fileId === state.currentMediaSource.id
                    ? delivery.subtitles?.find((track) => track.index === subtitleStreamIndex)?.id
                    : undefined) ??
                this.playbackProbe?.activeVersion.tracks.subtitles.find(
                    (track) => track.index === subtitleStreamIndex,
                )?.id ??
                'none',
            audioLanguage: this.getAudioLanguage(state, audioStreamIndex),
            subtitleLanguage: this.getSubtitleLanguage(state, subtitleStreamIndex),
            subtitleMethod: this.deriveSubtitleMethod(subtitleStreamIndex),
            bufferHealthSec: this.getBufferHealth(),
            maxStreamingBitrate,
            playbackRate: state.playbackRate,
            endReason,
            sessionElapsedMs: this.playingMsAccumulator,
        });

        // Only an actual start callback owns its intent snapshot. A stale failed
        // caller must never clear the snapshot of a newer request.

        // Now that the session is established (start succeeded), advertise
        // this tab as the same-browser active player so future probes from
        // other tabs see us. Read sessionId from the reporter — playerStore
        // may be a step behind. If start failed (ok === false), don't
        // advertise — there is no live session.
        if (eventType === 'start' && ok && this.sameBrowserChannel && this.currentMediaDbId) {
            const sessionId =
                this.progressReporter instanceof PlaySessionReporter
                    ? this.progressReporter.getSessionId()
                    : playerStore.getState().playSessionId;
            if (sessionId) {
                this.sameBrowserChannel.setActive({
                    mediaId: this.currentMediaDbId,
                    sessionId,
                    deviceId: getDeviceId(),
                });
            }
        }
    }

    /**
     * Run the probe and (if a conflict is found) the modal. Returns whether
     * the player should proceed with `startPlaySession`. All concurrent
     * callers share the single returned promise — see `probeAndModalPromise`.
     *
     * Failures from BroadcastChannel.postMessage or any other internal
     * exception fall through to "no conflict found, proceed" — the
     * server-side supersede + heartbeat backstop are the safety net.
     */
    private async runProbeAndModal(): Promise<boolean> {
        const mediaDbId = this.currentMediaDbId;
        if (!this.sameBrowserChannel || !mediaDbId) return true;
        let acks: { sessionId: string; deviceId: string; tabName?: string }[];
        try {
            acks = await this.sameBrowserChannel.probe(mediaDbId);
        } catch (err) {
            this.log('Probe failed; proceeding without conflict gate', err);
            return true;
        }
        if (acks.length === 0) return true;

        // Pause while the user reads the modal — otherwise both tabs are
        // emitting audio for the duration of the prompt, which is exactly
        // the bad UX this feature is preventing.
        this.videoElement?.pause();
        const proceed = await this.askTabConflict();
        if (!proceed) {
            // Spec scenario 3: Cancel closes the player overlay. By the
            // time we get here, onPlaying() has already set isInitialized
            // and started the progress timer — the userCancelledTabConflict
            // gate stops future reports, but the user is still on a loaded,
            // pressable player. Tearing down via onback returns the user
            // to whichever screen the player was opened from and prevents
            // untracked local-only playback.
            this.userCancelledTabConflict = true;
            this.props.onback?.();
            return false;
        }
        // User chose Continue — resume playback and let the caller start.
        void this.videoElement?.play().catch(() => {
            // Autoplay policies may reject; the existing autoplay-muted
            // prompt handles that path. Non-fatal here.
        });
        return true;
    }

    /**
     * Show the tab-conflict modal and return the user's choice. Resolves to
     * `true` when the user picks Continue here, `false` for Cancel / Esc.
     * Only one modal at a time — concurrent callers serialize via
     * `probeAndModalPromise`.
     */
    private askTabConflict(): Promise<boolean> {
        return new Promise((resolve) => {
            this.pendingTabConflict = resolve;
            this.tabConflictVisible = true;
        });
    }

    /** Called by VideoPlayer.svelte → TabConflictModal when the user picks. */
    resolveTabConflict(proceed: boolean): void {
        this.tabConflictVisible = false;
        const resolver = this.pendingTabConflict;
        this.pendingTabConflict = null;
        resolver?.(proceed);
    }

    /**
     * Increment the engagement accumulator. Called from `onTimeUpdate`
     * (~4 Hz while playing) AND from a 1 Hz setInterval failsafe so a
     * suspended timeupdate (background tab, codec stall) does not
     * permanently stall the accumulator. Both drivers feed the same
     * wall-clock delta computation; concurrent calls simply produce small
     * deltas that sum correctly without double-counting.
     *
     * Pause-resume safety: when we observe the player is NOT actively
     * playing, we null `lastPlayingTickAt`. The next tick after resume
     * therefore has no anchor and produces no delta — paused time can't
     * leak into the accumulator just because the pause happened to be
     * shorter than the 5 s background-tab cap.
     *
     * Caps individual deltas at 5 s to defend against background-tab
     * timestamps where the handler fires after a long suspended gap
     * with `isPlaying` still true.
     */
    private tickPlayingAccumulator(): void {
        const state = playerStore.getState();
        const isActivelyPlaying =
            state.isPlaying && !state.isPaused && !state.isSeeking && !state.isBuffering;
        if (!isActivelyPlaying) {
            // Drop the anchor so resume doesn't bill the pause duration.
            this.lastPlayingTickAt = null;
            return;
        }
        const now = Date.now();
        if (this.lastPlayingTickAt !== null) {
            const delta = now - this.lastPlayingTickAt;
            if (delta > 0 && delta < 5_000) {
                this.playingMsAccumulator += delta;
            }
        }
        this.lastPlayingTickAt = now;
    }

    /**
     * Sample the video element's decoded-frame count and derive a measured
     * fps for the "live fps" badge (PlayerOverlay.svelte). Piggybacks on the
     * same 1 Hz engagement ticker as tickPlayingAccumulator rather than
     * running its own interval. Uses `getVideoPlaybackQuality()` where
     * available; browsers without it (or before the first sample) just leave
     * `playerStore.liveFps` null, and the badge falls back to source fps.
     *
     * Mirrors tickPlayingAccumulator's anchor-drop: when playback isn't
     * actively progressing, the sliding window is cleared so a pause/seek gap
     * doesn't get averaged into the next real sample.
     */
    private tickLiveFps(): void {
        const state = playerStore.getState();
        const isActivelyPlaying =
            state.isPlaying && !state.isPaused && !state.isSeeking && !state.isBuffering;
        if (!isActivelyPlaying) {
            this.fpsSamples = [];
            return;
        }
        const video = this.videoElement;
        if (!video || typeof video.getVideoPlaybackQuality !== 'function') return;
        const frames = video.getVideoPlaybackQuality().totalVideoFrames;
        const now = Date.now();
        this.fpsSamples.push({ at: now, frames });
        while (
            this.fpsSamples.length > 1 &&
            now - this.fpsSamples[0].at > PlayerController.FPS_WINDOW_MS
        ) {
            this.fpsSamples.shift();
        }
        const oldest = this.fpsSamples[0];
        const deltaMs = now - oldest.at;
        const deltaFrames = frames - oldest.frames;
        if (deltaMs > 250 && deltaFrames >= 0) {
            playerStore.setLiveFps((deltaFrames * 1000) / deltaMs);
        }
    }

    /**
     * Reset engagement state at session boundaries (new media, source
     * change, controller dispose). Ensures the new session starts with
     * a fresh accumulator and doesn't inherit prior session elapsed time.
     */
    private resetEngagementTracking(): void {
        this.playingMsAccumulator = 0;
        this.lastPlayingTickAt = null;
        this.hasFiredInitialPositionHeartbeat = false;
        this.hasReportedRealPosition = false;
        this.engagementGateOpened = false;
        this.latestServerAnchor = null;
        this.lastCacheWriteAt = 0;
        this.fpsSamples = [];
        playerStore.setLiveFps(null);
        // Re-seed from the new session's playbackInfo so the first cache write
        // uses the correct anchor until the first heartbeat ack arrives.
        this.latestServerAnchor = this.currentPlaybackInfo.resumeAnchor ?? null;
    }

    /**
     * Reset engagement state when playSessionId rolls over to a new id —
     * caught by reportProgress and tickPlayingAccumulator. Auto-advance
     * to next episode and quality-restart both reuse the PlayerController
     * instance with a new playSessionId; without this, the new session
     * inherits the prior episode's accumulator and the gate is already
     * "open" before any real engagement.
     */
    private syncEngagementToActiveSession(playSessionId: string | null): void {
        if (playSessionId !== this.lastSeenPlaySessionId) {
            this.resetEngagementTracking();
            this.lastSeenPlaySessionId = playSessionId;
        }
    }

    /**
     * Start the 1 Hz engagement failsafe timer. Idempotent — the
     * setupReporter / onPlay paths can call this freely. Stops itself
     * via cleanupEngagementTicker on dispose.
     */
    private startEngagementTicker(): void {
        if (this.engagementTickIntervalRef !== null) return;
        this.engagementTickIntervalRef = setInterval(() => {
            this.tickPlayingAccumulator();
            this.tickLiveFps();
            this.writeResumeCache(false);
        }, PlayerController.ENGAGEMENT_TICK_MS);
    }

    private cleanupEngagementTicker(): void {
        if (this.engagementTickIntervalRef !== null) {
            clearInterval(this.engagementTickIntervalRef);
            this.engagementTickIntervalRef = null;
        }
    }

    // ============================================================================
    // Resume-cache helpers
    // ============================================================================

    private getCacheIdentity(): { username: string; uuid: string } | null {
        const username = this.props.username ?? '';
        const uuid = this.currentPlaybackInfo.internalId ?? '';
        if (!username || !uuid) return null;
        return { username, uuid };
    }

    private writeResumeCache(force = false): void {
        if (!this.engagementGateOpened) return;
        if (this.currentPlaybackInfo.isLive) return; // no resume semantic for Live TV
        if (watchTogether.isInWatchParty) return; // leader-driven; do not muddy the cache
        if (this.latestServerAnchor === null) return;
        const id = this.getCacheIdentity();
        if (!id) return;
        const positionMs = (this.videoElement?.currentTime ?? 0) * 1000;
        if (positionMs <= 0) return;

        const now = Date.now();
        if (!force && now - this.lastCacheWriteAt < PlayerController.CACHE_THROTTLE_MS) return;
        this.lastCacheWriteAt = now;

        setResumeEntry(id.username, id.uuid, positionMs, this.latestServerAnchor);
    }

    // ============================================================================
    // Video Event Handlers
    // ============================================================================

    onPlay(): void {
        // Recorded before the restart-window guard: the element really did
        // start playing, and a play that the handler deliberately swallows
        // mid-restart is exactly the kind of detail an incident timeline is
        // read for.
        this.incidentBuffer?.push({
            t: Date.now(),
            kind: 'play',
            // readyState at play time distinguishes "started cleanly" from a
            // play() issued before the element had data to work with.
            ...(this.videoElement ? { detail: { readyState: this.videoElement.readyState } } : {}),
        });

        if (this.shouldSuppressErrors()) {
            this.log(' Ignoring onPlay during restart');
            return;
        }

        this.applyPlaybackResumedReset();
        playerStore.showControlsTemporarily();

        if (this.subtitleRenderer?.hasActiveSpecialRenderer()) {
            this.subtitleRenderer.syncToCurrentTime();
        }

        if (!this.isInitialized) {
            this.bootstrapFirstPlay();
        } else {
            this.reportProgress('progress');
        }
    }

    /**
     * "First play" bootstrap for a fresh item: resets engagement tracking,
     * starts the engagement ticker, fires the `start` progress report, and
     * flips `isInitialized`. Normally reached from onPlay()'s `!isInitialized`
     * branch — but onPlay() itself early-returns via shouldSuppressErrors()
     * for the entire tryStartRestart()...finishRestart() window, and
     * PlaybackManager can call `.play()` (and thus fire the native `play`
     * event) before that window closes. That event is swallowed, no later
     * `play` event fires (the element never pauses in between), and
     * `isInitialized` would stay false forever — no watch progress, no
     * resume position, no session for the item. advanceEpisodeInPlace() calls
     * this explicitly once the swapped source is confirmed ready (canplay),
     * instead of relying on onPlay() to run it. Idempotent — no-ops if
     * already initialized, so a normal onPlay() bootstrap and this explicit
     * call can't double-fire.
     */
    /** See playback-resumed-reset.ts. Called from onPlay() and from every path
     *  that starts playback while onPlay() is suppressed (the in-place episode
     *  advance), so the two can never drift apart again. */
    private applyPlaybackResumedReset(): void {
        applyPlaybackResumedReset(playerStore, {
            setHasEnded: (v) => {
                this.hasEnded = v;
            },
            updatePlaybackIntent: () => this.updatePlaybackIntent(),
            setMediaSessionPlaybackState: (state) =>
                this.mediaSessionCtrl.updatePlaybackState(state),
        });
    }

    private bootstrapFirstPlay(): void {
        if (this.isInitialized) return;

        // Audio preferences are applied before source attachment in mount().
        // Keep the element's current state here: a user may have muted/changed
        // volume while waiting for Play, or autoplay may have fallen back muted.
        // Re-reading storage on first play overwrites those newer choices.
        // Fresh session — reset engagement accumulator before the first
        // `start` so the new session can't inherit the prior session's
        // elapsed time. Boot the 1 Hz failsafe ticker so a quiet
        // timeupdate (Safari background, codec stall) doesn't stall
        // the accumulator.
        this.resetEngagementTracking();
        this.lastSeenPlaySessionId = playerStore.playSessionId;
        this.startEngagementTicker();
        this.reportProgress('start');
        this.lastQualityRestartKey = this.buildQualityRestartKey(
            playerStore.qualityMode,
            playerStore.currentQualityProfile,
        );
        const delivery = this.playbackStart?.delivery;
        const actualAudio =
            delivery && 'applied' in delivery
                ? delivery.tracks?.audio.find(
                      (track) => track.absoluteIndex === delivery.applied?.audioStreamIndex,
                  )
                : undefined;
        this.lastAudioTrackIndex = actualAudio?.index ?? playerStore.currentAudioTrackIndex;
        this.isInitialized = true;
        // A control used before first play could not persist yet. Adopt its
        // current audio state now; onVolumeChange excludes automatic fallback.
        this.onVolumeChange();
        if (!this.isRestartingPlayback) this.consumePendingAudioSwitch();
        this.abrCtrl.onPlaybackStart();
        playerStore.startProgressReporting(() => this.reportProgress('progress'));
    }

    onPause(): void {
        // See onPlay() — buffered regardless of the restart-window guard. That
        // is why the provenance has to travel with it: a detach during a rebuild
        // lands a `pause` here too, and without the label a teardown artifact is
        // indistinguishable from an involuntary pause (see pause-provenance.ts).
        const pauseCause = {
            restarting: this.shouldSuppressErrors(),
            pausedByUser: playerStore.pausedByUser,
            ended: this.hasEnded,
            sourceReload: this.playbackManager?.isSeekResetInFlight() ?? false,
        };
        this.incidentBuffer?.push({
            t: Date.now(),
            kind: 'pause',
            detail: buildTransportDetail({
                ...pauseCause,
                paused: this.videoElement?.paused,
                readyState: this.videoElement?.readyState,
            }),
        });

        if (this.shouldSuppressErrors()) return;

        // A pause from outside the player UI (iPad native fullscreen controls,
        // PiP, the OS) is still the user pausing. Without this the stall
        // dead-man fired against the paused element and the recovery nudge
        // resumed it a few seconds later. See pause-provenance.ts.
        if (
            adoptsPauseAsUserIntent({
                ...pauseCause,
                inWatchParty: watchTogether.isInWatchParty,
            })
        ) {
            playerStore.setPausedByUser(true);
            this.updatePlaybackIntent();
        }

        playerStore.setPlaying(false);
        playerStore.setShowControls(true);
        // A paused video is not buffering — clear any spinner left over from a
        // seek-induced `waiting` (e.g. a watch-party sync seek that precedes the
        // pause) and cancel watch-party stall detection so the guest shows as
        // paused rather than stuck "buffering" until someone resumes.
        playerStore.setBuffering(false);
        this.watchTogetherCtrl.onPause();
        this.reportProgress('progress');
        this.writeResumeCache(true);

        this.mediaSessionCtrl.updatePlaybackState('paused');
    }

    onTimeUpdate(): void {
        if (this.reconnect?.getState() === 'terminal') return;
        // Tick the engagement accumulator on every timeupdate event. Cheap
        // (a Date.now() and a numeric add); fires at ~4 Hz while playing,
        // never while paused/seeking/buffering — see tickPlayingAccumulator.
        this.tickPlayingAccumulator();
        this.watchTogetherCtrl.onTimeUpdate();

        if (this.videoElement) {
            // Batch all per-tick playerStore writes into a single
            // applyTimeupdate call. The setter does the same equality
            // checks as the individual setters used to, but bundling
            // them means $derived/$effect chains downstream of the
            // player only run once per tick instead of once per field.
            const update: Parameters<typeof playerStore.applyTimeupdate>[0] = {};
            if (!playerStore.isSeeking && !this.isHoldingRestartPosition()) {
                // Skip currentTime entirely while the user is scrubbing —
                // matches the original `if (!isSeeking) setCurrentTime(...)`
                // gate. Writing currentTime here would clobber playheadTime's
                // fractional value with the whole-second display tick.
                update.currentTime = this.videoElement.currentTime;
            }

            if (
                isFinite(this.videoElement.duration) &&
                this.videoElement.duration > 0 &&
                Math.abs(this.videoElement.duration - playerStore.duration) > 1
            ) {
                if (playerStore.isLive || this.videoElement.duration > playerStore.duration) {
                    update.duration = this.videoElement.duration;
                }
            }

            if (this.videoElement.buffered.length > 0) {
                update.bufferedEnd = this.videoElement.buffered.end(
                    this.videoElement.buffered.length - 1,
                );
            }

            if (!this.videoElement.paused) {
                if (playerStore.isLoading) update.loading = false;
                if (playerStore.isBuffering) update.buffering = false;
            }

            playerStore.applyTimeupdate(update);

            if (
                !this.hasFiredInitialPositionHeartbeat &&
                !this.videoElement.paused &&
                this.videoElement.currentTime > 0
            ) {
                this.hasFiredInitialPositionHeartbeat = true;
                this.hasReportedRealPosition = true;
                playerStore.setCurrentTime(this.videoElement.currentTime);
                void this.reportProgress('progress');
            }

            const mediaDuration =
                playerStore.duration > 0 ? playerStore.duration : this.videoElement.duration;
            const now = Date.now();
            if (
                mediaDuration > 0 &&
                !isNaN(mediaDuration) &&
                now - this.lastMediaSessionPositionUpdate >=
                    TIMING.MEDIA_SESSION_POSITION_INTERVAL_MS
            ) {
                this.lastMediaSessionPositionUpdate = now;
                this.mediaSessionCtrl.updatePositionState(
                    mediaDuration,
                    this.videoElement.currentTime,
                    this.videoElement.playbackRate,
                );
            }
        }

        // Only REAL forward progress counts. The controller's contract is
        // "currentTime advanced", and it resets both stall dead-men plus the
        // seek suppression on this call — but `timeupdate` can fire on a frozen
        // playhead (observed on Safari), which would re-arm the watchdogs
        // forever and mask exactly the stall they exist to catch. Enforce the
        // contract at the caller, which is the only place that can see the
        // delta.
        const positionNow = this.videoElement?.currentTime;
        if (typeof positionNow === 'number' && Number.isFinite(positionNow)) {
            const advanced =
                this.lastProgressPosition === null || positionNow > this.lastProgressPosition;
            this.lastProgressPosition = positionNow;
            if (advanced) this.reconnect?.notifyProgress();
        } else {
            this.reconnect?.notifyProgress();
        }
    }

    onProgress(): void {
        // The media 'progress' event = data is still arriving. Treat it as
        // activity so the stall watchdog does not fire while a large 4K copy
        // segment is legitimately downloading (>stallTimeoutMs) but not yet
        // advancing currentTime — otherwise high-bitrate direct-play shows a
        // false "connection problem" during normal buffering / slow forward
        // seeks into not-yet-produced regions.
        //
        // BUT: this DOM event can also fire on a dead-but-trickling connection
        // with no genuine new bytes, which would re-arm the stall watchdog
        // forever and mask a frozen playhead. For hls.js we have a
        // byte-verified alternative — PlaybackManager polls the loading
        // fragment's live LoaderStats and calls onVerifiedNetworkActivity()
        // only on real `.loaded` growth — so skip this DOM-event path there
        // entirely. Native Safari HLS has no loader-stats hook, so it keeps
        // using this as its fallback signal (bounded by the Layer-2 hard
        // ceiling in ReconnectController, which only real notifyProgress can
        // reset).
        if (!this.playbackManager?.isHlsActive()) {
            this.reconnect?.notifyNetworkActivity();
        }

        if (this.playbackManager?.isHlsActive() || !this.videoElement) return;

        this.ensureBandwidthEstimator().onProgress(
            this.videoElement.buffered,
            this.videoElement.duration,
            false,
        );
    }

    /**
     * The media element's `stalled` event: the UA tried to fetch media data and
     * got nothing for a while. Safari can emit this WITHOUT a companion
     * `waiting` on network starvation, in which case nothing else here notices —
     * it was previously bound to no handler at all.
     *
     * Deliberately does NOT trigger recovery on its own: `stalled` also fires
     * during ordinary slow buffering, and the reconnect controller's dead-men
     * already own the "is this actually frozen" decision. All this does is make
     * a starved native stream visible in telemetry, so the silent case
     * (stalled-without-waiting) stops being invisible after the fact.
     */
    onStalled(): void {
        if (this.playbackManager?.isHlsActive()) return;
        if (!this.telemetryCtrl.hasNativePlaybackStarted) return;
        if (playerStore.isSeeking || watchTogether.isInWatchParty) return;

        const video = this.videoElement;
        let bufferHealth = 0;
        if (video) {
            const buffered = video.buffered;
            const currentTime = video.currentTime;
            for (let i = 0; i < buffered.length; i++) {
                if (currentTime >= buffered.start(i) && currentTime <= buffered.end(i)) {
                    bufferHealth = buffered.end(i) - currentTime;
                    break;
                }
            }
        }
        this.log(' Native stream stalled (UA reported no media data)', { bufferHealth });
        this.telemetryCtrl.recordMediaStalled(bufferHealth);
        this.incidentBuffer?.push({
            t: Date.now(),
            kind: 'media_stalled',
            detail: { bufferHealth, media: this.getMediaSnapshot() },
        });
    }

    onWaiting(): void {
        if (playerStore.isSeeking) {
            if (!this.seekBufferingTimer) {
                this.seekBufferingTimer = setTimeout(() => {
                    if (playerStore.isSeeking) {
                        playerStore.setBuffering(true);
                    }
                    this.seekBufferingTimer = null;
                }, SEEK.BUFFERING_DELAY_MS);
            }
        } else {
            playerStore.setBuffering(true);
        }

        if (this.isSafari && this.videoElement) {
            const timeSinceSeek = Date.now() - this.telemetryCtrl.lastNativeSeekTime;
            if (!this.telemetryCtrl.hasNativePlaybackStarted) {
                this.log(' Initial buffering (not counting as rebuffer)');
            } else if (watchTogether.isInWatchParty) {
                this.log(' In watch party (not counting as rebuffer)');
            } else if (playerStore.isSeeking) {
                this.log(' Buffering during seek (not counting as rebuffer)');
            } else if (timeSinceSeek < SEEK.GRACE_PERIOD_MS) {
                this.log(` Buffering ${timeSinceSeek}ms after seek (not counting as rebuffer)`);
            } else {
                this.telemetryCtrl.nativeRebufferStartTime = Date.now();

                const buffered = this.videoElement.buffered;
                const currentTime = this.videoElement.currentTime;
                let bufferHealth = 0;
                if (buffered.length > 0) {
                    for (let i = 0; i < buffered.length; i++) {
                        if (currentTime >= buffered.start(i) && currentTime <= buffered.end(i)) {
                            bufferHealth = buffered.end(i) - currentTime;
                            break;
                        }
                    }
                }

                if (bufferHealth < 0.5) {
                    this.telemetryCtrl.recordBufferStarvation(bufferHealth);
                    // Native-engine counterpart of PlaybackManager's
                    // onBufferStarvation callback — one engine or the other
                    // runs, never both, so this cannot double-record.
                    this.incidentBuffer?.push({
                        t: Date.now(),
                        kind: 'playback_stall',
                        detail: { bufferHealth },
                    });
                }
                this.telemetryCtrl.recordRebufferStart(currentTime);
            }
        }

        this.watchTogetherCtrl.onWaiting();

        this.reconnect?.notifyWaiting();
    }

    onCanPlay(): void {
        this.watchTogetherCtrl.onCanPlay();
        this.clearSeekBufferingTimer();

        playerStore.setBuffering(false);
        playerStore.setLoading(false);

        if (
            this.isSafari &&
            this.telemetryCtrl.nativeRebufferStartTime !== null &&
            this.videoElement
        ) {
            const duration = Date.now() - this.telemetryCtrl.nativeRebufferStartTime;
            this.telemetryCtrl.nativeRebufferStartTime = null;

            if (duration > 100) {
                this.telemetryCtrl.recordRebufferEnd(this.videoElement.currentTime);
            }
        }

        this.clearStallTimer();
    }

    onPlaying(): void {
        if (this.reconnect?.getState() === 'terminal') return;
        if (this.awaitingTapPause) {
            // Started by any route (tap, OS controls, party): the user wants playback.
            this.awaitingTapPause = false;
            playerStore.setPausedByUser(false);
            this.updatePlaybackIntent();
        }
        playerStore.setBuffering(false);
        playerStore.setLoading(false);

        playerStore.setPlaying(true);

        // NOTE: we deliberately do NOT clear the post-switch arm here.
        // Playback often starts briefly on the first good fragments before
        // fragParsingError hits a partial fragment further along. Rely on
        // the 15s safety timer instead.

        if (!this.telemetryCtrl.hasNativePlaybackStarted) {
            this.telemetryCtrl.hasNativePlaybackStarted = true;
            this.log(
                ' Native playback started (future waiting events will be counted as rebuffers)',
            );
        }

        this.watchTogetherCtrl.onPlaying();
    }

    onSeeking(): void {
        if (this.telemetryCtrl.seekStartPosition === null) {
            const state = playerStore.getState();
            this.telemetryCtrl.seekStartPosition = state.currentTime;
        }

        playerStore.setSeeking(true);
        // Suppress the stall dead-man for the duration of the seek: a seek (esp.
        // a server-side kill+restart seek of 4K copy on a no-GPU box) pauses
        // currentTime long enough to trip the watchdog, surfacing a false
        // "connection problem". Real seek failures still come via the error path.
        this.reconnect?.setSeeking(true);
        // Drop the progress baseline: the playhead is about to jump (possibly
        // BACKWARD), and the first post-seek tick must read as real progress so
        // it lifts the seek suppression instead of being filtered as "no
        // forward movement".
        this.lastProgressPosition = null;
        if (this.videoElement) {
            this.log(' onSeeking event - browser seeking to:', {
                currentTime: this.videoElement.currentTime.toFixed(2) + 's',
                buffered: this.getBufferedRanges(),
            });
        }
    }

    onSeeked(): void {
        this.watchTogetherCtrl?.onSeeked?.();
        this.clearSeekBufferingTimer();

        playerStore.setSeeking(false);
        // A paused native seek can finish without another canplay/playing
        // event. Its decoded frame is enough to dismiss the seek spinner.
        if (
            this.videoElement?.paused &&
            this.videoElement.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
        ) {
            playerStore.setBuffering(false);
            playerStore.setLoading(false);
        }
        this.telemetryCtrl.lastNativeSeekTime = Date.now();

        if (this.videoElement) {
            this.log(' onSeeked event - browser finished seeking:', {
                currentTime: this.videoElement.currentTime.toFixed(2) + 's',
                buffered: this.getBufferedRanges(),
            });

            if (this.telemetryCtrl.seekStartPosition !== null) {
                const seekDistance =
                    this.videoElement.currentTime - this.telemetryCtrl.seekStartPosition;
                if (Math.abs(seekDistance) > 1) {
                    this.telemetryCtrl.recordSeek(
                        this.telemetryCtrl.seekStartPosition,
                        this.videoElement.currentTime,
                    );
                    this.incidentBuffer?.push({
                        t: Date.now(),
                        kind: 'seek',
                        detail: {
                            fromPosition: this.telemetryCtrl.seekStartPosition,
                            toPosition: this.videoElement.currentTime,
                        },
                    });
                    // Sync playerStore.currentTime to the post-seek position
                    // before reporting — timeupdate hasn't fired yet so the
                    // store still holds the pre-seek value.
                    playerStore.setCurrentTime(this.videoElement.currentTime);
                    // Open the real-position gate so subsequent interval
                    // heartbeats flow from this point onward.
                    this.hasReportedRealPosition = true;
                    // Flush a heartbeat now so play_sessions.position_ms and
                    // Continue Watching both reflect the actual resumed position.
                    // Distance gate dedupes micro-scrubs from HLS source switches.
                    void this.reportProgress('progress');
                }
                this.telemetryCtrl.seekStartPosition = null;
            }

            if (this.postSeekSubtitleTimer) {
                clearTimeout(this.postSeekSubtitleTimer);
            }
            this.postSeekSubtitleTimer = setTimeout(() => {
                this.postSeekSubtitleTimer = null;
                if (this.videoElement && playerStore.currentSubtitleTrackIndex !== null) {
                    this.logSub('Post-seek subtitle reload');
                    this.subtitleCacheBuster = Date.now();
                    this.loadSubtitles();
                }
            }, SUBTITLE.RELOAD_DEBOUNCE_MS);
        }
        this.abrCtrl.clearSamples();
        this.writeResumeCache(true);
    }

    onEnded(): void {
        if (this.shouldSuppressErrors()) return;

        this.hasEnded = true;
        playerStore.setEnded(true);
        this.updatePlaybackIntent();

        // Transfer native fullscreen to the persistent .watch-page wrapper now, before
        // the browser can auto-exit fullscreen on video end-of-stream (Safari does this).
        // Only when there's a next item to advance to — otherwise, navigating back would
        // leave a spurious restoreFullscreen flag in sessionStorage.
        if (playerStore.effectiveNextItem) {
            this.transferFullscreenToWrapper();
        }

        playerStore.setPlaying(false);

        // In a watch party, `ended` is a pause the party never hears — onEnded
        // broadcasts nothing, so the host's isPlaying only heals via the ~5s
        // heartbeat. Send it NOW so guests learn the host stopped immediately,
        // shrinking the stale-isPlaying window that otherwise lets a trailing
        // guest get hard-seeked to the end (tail skipped) or a joiner resume
        // against an ended video. Heartbeat, not a sync — trailing guests aren't
        // force-paused mid-tail; they play out their last seconds naturally.
        if (this.canSyncToWatchParty && watchTogether.isHost && this.videoElement) {
            void watchTogether.sendHeartbeat(this.videoElement.currentTime, false);
        }

        this.telemetryCtrl.flushViaBeacon();

        this.reportProgress('stop', 'completion');
        if (this.lumastraProgressIntervalRef) {
            clearInterval(this.lumastraProgressIntervalRef);
            this.lumastraProgressIntervalRef = null;
        }
        playerStore.stopProgressReporting();

        // Clear resume cache on completion
        const id = this.getCacheIdentity();
        if (id) clearResumeEntry(id.username, id.uuid);

        this.props.onended?.();
    }

    /**
     * Compact <video> state for playback incidents: what the media element
     * itself reports (error, readyState, buffered/seekable ranges, decoded vs
     * dropped frames), which the server never sees. A native-HLS stall where
     * every segment answers 200 can only be told apart client-side (decode
     * error vs. timeline mismatch vs. no frames). Bounded: <= 4 ranges each.
     */
    getMediaSnapshot(): Record<string, unknown> | undefined {
        const video = this.videoElement;
        if (!video) return undefined;
        const ranges = (r: TimeRanges): string[] => {
            const out: string[] = [];
            for (let i = 0; i < r.length && out.length < 4; i++) {
                out.push(`${r.start(i).toFixed(1)}-${r.end(i).toFixed(1)}`);
            }
            return out;
        };
        const snap: Record<string, unknown> = {
            readyState: video.readyState,
            networkState: video.networkState,
            currentTime: Number(video.currentTime.toFixed(2)),
            duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(2)) : null,
            paused: video.paused,
            seeking: video.seeking,
            buffered: ranges(video.buffered),
            seekable: ranges(video.seekable),
        };
        if (video.error) {
            snap.error = { code: video.error.code, message: video.error.message.slice(0, 200) };
        }
        const webkit = video as HTMLVideoElement & {
            webkitDecodedFrameCount?: number;
            webkitDroppedFrameCount?: number;
        };
        if (typeof webkit.webkitDecodedFrameCount === 'number') {
            snap.decodedFrames = webkit.webkitDecodedFrameCount;
            snap.droppedFramesWebkit = webkit.webkitDroppedFrameCount;
        }
        const quality = video.getVideoPlaybackQuality?.();
        if (quality) {
            snap.totalFrames = quality.totalVideoFrames;
            snap.droppedFrames = quality.droppedVideoFrames;
        }
        return snap;
    }

    onError(): void {
        if (this.shouldSuppressErrors()) {
            this.log(' Ignoring video error during restart');
            return;
        }
        // Teardown clears the source (clearVideoSource, PlaybackManager.destroy,
        // prepareForRestart). An error from an element with no source left is
        // that teardown, not a playback failure: no incident, no re-auth probe.
        // hls.js attaches (Managed)MediaSource through a <source> child with no
        // src attribute (appendSource), so a child counts as a source.
        if (
            this.videoElement &&
            !this.videoElement.getAttribute('src') &&
            !this.videoElement.querySelector('source[src]')
        ) {
            this.log(' Ignoring video error from a cleared source');
            return;
        }

        const error = this.videoElement?.error;
        this.incidentReporter?.reportError(playerStore.playSessionId ?? '', {
            errorType: error?.code === 3 ? 'decode' : 'media',
            message: (error?.message || 'Unknown native playback error').slice(0, 200),
        });

        // Native Safari HLS / direct play report no HTTP status; a failure of
        // a tokenized source is most likely its dead stream session.
        const failedSrc = this.videoElement?.currentSrc || this.videoElement?.src || '';
        if (this.recoverTokenizedSource(streamTokenOf(failedSrc) !== null)) return;
        // No status here, so a 401 looks like any other failure: ask the server.
        this.checkForLostBrowserSession('native-error');

        if (playerStore.isLive && error) {
            this.recoverLiveTvOrFail(`video error (${error.message})`, () => {
                void this.failLiveTvFromSession(() => {
                    this.liveTvFailure = { type: 'source_down' };
                });
            });
            return;
        }

        if (!this.directPlayFailed && error) {
            this.fallbackToHlsTranscoding(`Video error: ${error.message}`);
            return;
        }

        const message = error?.message || 'Unknown playback error';
        const errorCode = error?.code?.toString() || 'unknown';

        const telemetry = this.ensureTelemetry();
        if (telemetry) {
            telemetry.recordError(errorCode, message);
        }

        playerStore.setError(message);
        this.props.onerror?.({ message });
    }

    onVolumeChange(): void {
        if (this.videoElement) {
            playerStore.setVolume(this.videoElement.volume);
            if (this.videoElement.muted !== playerStore.isMuted) {
                playerStore.toggleMute();
            }
            if (!this.videoElement.muted) this.mutedByAutoplayFallback = false;
            // Only persist volume after initialization to avoid saving defaults
            // that overwrite the user's saved preferences, and never persist the
            // autoplay fallback's own mute (see startup-mute.ts).
            if (
                shouldPersistVolumeChange({
                    isInitialized: this.isInitialized,
                    muted: this.videoElement.muted,
                    mutedByAutoplayFallback: this.mutedByAutoplayFallback,
                })
            ) {
                updatePreferences({
                    volume: this.videoElement.volume,
                    isMuted: this.videoElement.muted,
                });
                // Also save to dedicated key for reliable restore (survives preferences store resets)
                try {
                    localStorage.setItem(
                        'playerVolume',
                        JSON.stringify({
                            volume: this.videoElement.volume,
                            muted: this.videoElement.muted,
                        }),
                    );
                } catch {
                    /* localStorage unavailable */
                }
            }

            if (!this.videoElement.muted && this.showAutoplayMutedPrompt) {
                this.showAutoplayMutedPrompt = false;
                this.showAutoplayTutorial = false;
            }
        }
    }

    onLoadedMetadata(): void {
        if (this.subtitleLoadDeferredUntilMetadata && this.videoElement) {
            this.loadSubtitles();
        }
        if (this.videoElement) {
            this.log(' Metadata loaded:', {
                videoWidth: this.videoElement.videoWidth,
                videoHeight: this.videoElement.videoHeight,
                duration: this.videoElement.duration,
                readyState: this.videoElement.readyState,
            });

            if (this.videoElement.videoWidth === 0 || this.videoElement.videoHeight === 0) {
                console.warn('[Player] Video has no dimensions - may be audio-only playback');
            }

            if (this.videoElement.duration && isFinite(this.videoElement.duration)) {
                const state = playerStore.getState();
                const effectiveDuration =
                    state.duration > 0 ? state.duration : this.videoElement.duration;
                if (!state.duration || state.duration <= 0) {
                    playerStore.setDuration(this.videoElement.duration);
                }
                this.watchTogetherCtrl.setMediaDuration(effectiveDuration);
            }

            const state = playerStore.getState();
            if (state.playMethod === 'DirectPlay' || this.isSafari) {
                // Safari exposes native audioTracks for both DirectPlay and transcoded HLS.
                // Reapply on every new source, including direct-file restarts.
                this.applyDirectPlayAudioTrack(state.currentAudioTrackIndex);

                const safariVideoEl = asSafariVideo(this.videoElement);
                const audioTracks = safariVideoEl?.audioTracks;
                if (audioTracks) {
                    const video = this.videoElement;
                    const sourceId = state.currentMediaSource?.id;
                    const generation = this.playbackGeneration;
                    const onAddTrack = () => {
                        if (
                            video !== this.videoElement ||
                            sourceId !== playerStore.currentMediaSource?.id ||
                            generation !== this.playbackGeneration
                        )
                            return;
                        this.log(' Safari: audio track added, re-applying selection');
                        this.applyDirectPlayAudioTrack(playerStore.currentAudioTrackIndex);
                    };
                    audioTracks.addEventListener('addtrack', onAddTrack);
                    setTimeout(() => {
                        audioTracks.removeEventListener('addtrack', onAddTrack);
                    }, TIMING.AUDIO_TRACK_CLEANUP_MS);
                }
            }

            if (!this.hasResumedInitialPosition && !this.isRestartingPlayback) {
                const sessionState =
                    watchTogether.isInWatchParty || this.mightBeInWatchParty()
                        ? watchTogether.getSessionState()
                        : null;

                if (sessionState) {
                    const drift = Math.abs(
                        this.videoElement.currentTime - sessionState.currentTime,
                    );
                    if (drift > 2) {
                        this.log(
                            ' Watch Party: fine-tuning to session position:',
                            sessionState.currentTime,
                        );
                        this.setVideoTime(sessionState.currentTime, 'watch_party_sync');
                    } else {
                        this.log(
                            ' Watch Party: already at session position (drift:',
                            drift.toFixed(1) + 's)',
                        );
                    }
                    // A position correction does not itself mean playback should
                    // stop. Pausing unconditionally here races a guest's first
                    // canplay against the already-completed party resume: when no
                    // later sync arrives, the guest remains paused even though the
                    // host is playing. Preserve the playing state unless the party
                    // is explicitly paused or an active barrier owns the resume.
                    if (!sessionState.isPlaying || watchTogether.isWatchPartySyncing) {
                        this.videoElement.pause();
                    }
                } else if (
                    this.props.initialStartTime !== undefined &&
                    this.props.initialStartTime > 0
                ) {
                    this.log(
                        ' Skipping resume fine-tuning (preview handoff):',
                        this.props.initialStartTime,
                    );
                } else if (
                    this.lumastraPlayMethod !== null &&
                    this.lumastraPlayMethod !== 'direct'
                ) {
                    const lumastraResumePosition = this.props.playbackInfo.userData
                        ?.playbackPositionTicks
                        ? this.props.playbackInfo.userData.playbackPositionTicks / 10000000
                        : 0;

                    if (lumastraResumePosition > 0) {
                        this.log(
                            ' Skipping resume fine-tuning (lumastra HLS startup):',
                            lumastraResumePosition,
                        );
                    }
                } else {
                    const resumePosition = this.props.playbackInfo.userData?.playbackPositionTicks
                        ? this.props.playbackInfo.userData.playbackPositionTicks / 10000000
                        : 0;

                    if (
                        resumePosition > 0 &&
                        Math.abs(this.videoElement.currentTime - resumePosition) > 2
                    ) {
                        this.log(' Fine-tuning to resume position:', resumePosition);
                        this.setVideoTime(resumePosition, 'resume_initial');
                    }
                }
                this.hasResumedInitialPosition = true;
            }
        }
    }

    // ============================================================================
    // Audio Track Management
    // ============================================================================

    requestAudioSwitch(targetIndex: number): void {
        this.pendingAudioTrackIndex = targetIndex;
        if (this.isRestartingPlayback) return;
        this.consumePendingAudioSwitch();
    }

    consumePendingAudioSwitch(): void {
        if (this.pendingAudioTrackIndex === null) return;
        const target = this.pendingAudioTrackIndex;
        this.pendingAudioTrackIndex = null;
        const revision = playerStore.audioSelectionRevision;
        if (
            target === this.lastAudioTrackIndex &&
            revision <= (this.lastAudioSwitchRevision ?? revision)
        )
            return;
        this.lastAudioSwitchRevision = revision;
        this.lastAudioTrackIndex = target;
        this.handleAudioTrackChange(target);
    }

    handleAudioTrackChange(newIndex: number): void {
        if (!playerStore.isLive && this.progressReporter instanceof PlaySessionReporter) {
            const attempt = (this.audioSwitchAttempt = (this.audioSwitchAttempt ?? 0) + 1);
            const revision = playerStore.audioSelectionRevision;
            const sourceId = playerStore.currentMediaSource?.id;
            this.audioSwitchInFlight = true;
            this.failedAudioSwitch = null;
            const settle = (): void => {
                if (attempt !== this.audioSwitchAttempt) return;
                this.audioSwitchInFlight = false;
                if (sourceId !== playerStore.currentMediaSource?.id) return;
                if (
                    playerStore.currentAudioTrackIndex === newIndex &&
                    playerStore.audioSelectionRevision === revision
                ) {
                    const desired = playerStore.currentMediaSource?.audioStreams.find(
                        (track) => track.index === newIndex,
                    );
                    const delivery = this.playbackStart?.delivery;
                    const applied =
                        delivery &&
                        'fileId' in delivery &&
                        delivery.fileId === sourceId &&
                        'applied' in delivery
                            ? delivery.applied
                            : undefined;
                    this.failedAudioSwitch =
                        desired?.absoluteIndex !== undefined &&
                        applied?.audioStreamIndex === desired.absoluteIndex
                            ? null
                            : { index: newIndex, revision, sourceId };
                }
                if (!this.isRestartingPlayback) this.consumePendingAudioSwitch();
            };
            void Promise.resolve(this.restartStreamWithNewQuality()).then(settle, settle);
            return;
        }
        const state = playerStore.getState();
        const audioStreams = state.currentMediaSource?.audioStreams || [];
        const targetTrack = audioStreams.find((t) => t.index === newIndex);

        // Safari native HLS (and DirectPlay) exposes videoElement.audioTracks.
        // This works for all play methods on Safari — DirectPlay, DirectStream (remux), etc.
        // Try this first since it's instant and preserves playback position.
        if (this.videoElement && (state.playMethod === 'DirectPlay' || this.isSafari)) {
            const safariVideo = asSafariVideo(this.videoElement);
            const audioTracks = safariVideo?.audioTracks;

            if (audioTracks && audioTracks.length > 1 && targetTrack) {
                const switched = this.applyDirectPlayAudioTrack(newIndex);

                if (switched && this.videoElement) {
                    // Force Safari to re-sync audio/video renditions by seeking
                    // to the current position. Without this, Safari may use stale
                    // buffered audio from the previous rendition at a wrong position.
                    const currentTime = this.videoElement.currentTime;
                    this.videoElement.currentTime = currentTime;
                    return;
                }
            }
        }

        if (this.playbackManager && targetTrack) {
            const switched = this.playbackManager.switchAudioTrack(
                newIndex,
                targetTrack.languageCode || targetTrack.language,
            );
            if (switched) {
                return;
            }
        }

        this.restartStreamWithNewQuality();
    }

    private nativeAudioTarget(storeAudioIndex: number): number | undefined {
        const streams = playerStore.currentMediaSource?.audioStreams ?? [];
        const target = streams.find((track) => track.index === storeAudioIndex);
        const native = this.videoElement
            ? asSafariVideo(this.videoElement)?.audioTracks
            : undefined;
        if (!target || !native?.length) return undefined;
        const targetLanguage = target.language || target.languageCode;
        const title = target.title?.trim().toLowerCase();
        const role = audioTrackRole(target.title ?? target.displayTitle);
        const fullList = native.length === streams.length;
        const exposedRole = (i: number): ReturnType<typeof audioTrackRole> | undefined => {
            const label = native[i].label?.trim().toLowerCase();
            if (!label) return undefined;
            const marked = audioTrackRole(label);
            if (marked !== 'main') return marked;
            if (/^[a-z]{2}(?:-[a-z0-9]+)*$/.test(normalizeLanguage(label))) return undefined;
            const identified = streams.find((track) => track.title?.trim().toLowerCase() === label);
            return identified ? audioTrackRole(identified.title) : undefined;
        };
        const candidates: number[] = [];
        for (let i = 0; i < native.length; i++) {
            const track = native[i];
            const knownRole = exposedRole(i);
            if (knownRole !== undefined && role !== knownRole) continue;
            if (
                !isUnknownLanguage(targetLanguage) &&
                !isUnknownLanguage(track.language) &&
                !languagesMatch(targetLanguage, track.language)
            )
                continue;
            candidates.push(i);
        }
        const bestLanguageScore = Math.max(
            0,
            ...candidates.map((i) => languageMatchScore(native[i].language, targetLanguage)),
        );
        const ranked = bestLanguageScore
            ? candidates.filter(
                  (i) =>
                      languageMatchScore(native[i].language, targetLanguage) === bestLanguageScore,
              )
            : candidates;
        const exactTitle =
            title && !/^[a-z]{2}(?:-[a-z0-9]+)*$/.test(normalizeLanguage(title))
                ? ranked.filter((i) => native[i].label?.trim().toLowerCase() === title)
                : [];
        if (exactTitle.length === 1) return exactTitle[0];
        const sourceEditions = streams.filter(
            (track) =>
                audioTrackRole(track.title ?? track.displayTitle) === role &&
                languageMatchScore(track.language || track.languageCode, targetLanguage) >=
                    bestLanguageScore,
        );
        // Missing role metadata cannot disambiguate partial lists containing main/AD/commentary.
        const rolesAmbiguous = streams.some(
            (track) =>
                audioTrackRole(track.title ?? track.displayTitle) !== role &&
                languagesMatch(track.language || track.languageCode, targetLanguage),
        );
        if (
            ranked.length === 1 &&
            bestLanguageScore > 0 &&
            sourceEditions.length <= 1 &&
            (!rolesAmbiguous || exposedRole(ranked[0]) !== undefined)
        )
            return ranked[0];
        const position = streams.findIndex((track) => track.index === storeAudioIndex);
        if (fullList && ranked.includes(position)) return position;
        return undefined;
    }

    applyDirectPlayAudioTrack(storeAudioIndex: number): boolean {
        const native = this.videoElement
            ? asSafariVideo(this.videoElement)?.audioTracks
            : undefined;
        const target = this.nativeAudioTarget(storeAudioIndex);
        if (!native || target === undefined) return false;
        for (let i = 0; i < native.length; i++) native[i].enabled = i === target;
        return true;
    }

    // ============================================================================
    // Control functions
    // ============================================================================

    togglePlayPause(): void {
        if (this.videoElement) {
            const willPlay =
                this.watchTogetherCtrl?.isSourceReplacing && watchTogether.session
                    ? !watchTogether.session.isPlaying
                    : this.videoElement.paused;

            this.log(' togglePlayPause called', {
                isInWatchParty: watchTogether.isInWatchParty,
                isLive: playerStore.isLive,
                hasSyncedInitially: watchTogether.getHasSyncedInitially(),
                willPlay,
            });

            // Audio-only exists so the screen can go off — don't let the everyday
            // play button undo the suppression applied elsewhere.
            if (willPlay && playerStore.qualityMode !== 'audio-only') {
                requestWakeLock();
            }

            if (watchTogether.isInWatchParty && !watchTogether.getHasSyncedInitially()) {
                const sessionState = watchTogether.getSessionState();
                this.log(' Fresh joiner check - not synced yet', {
                    sessionState,
                });
                if (sessionState) {
                    if (Math.abs(this.videoElement.currentTime - sessionState.currentTime) > 2) {
                        this.setVideoTime(sessionState.currentTime, 'watch_party_sync');
                    }
                    return;
                }
            }

            if (this.canSyncToWatchParty) {
                const currentTime = this.watchTogetherCtrl?.isSourceReplacing
                    ? ((watchTogether.isWatchPartySyncing
                          ? watchTogether.session?.currentTime
                          : this.restartQueue?.currentResume()?.position) ??
                      (this.videoElement.readyState >= 3 && !this.videoElement.seeking
                          ? this.videoElement.currentTime
                          : undefined) ??
                      watchTogether.session?.currentTime ??
                      this.videoElement.currentTime)
                    : this.videoElement.currentTime;
                this.log(' Broadcasting sync to watch party', {
                    currentTime,
                    willPlay,
                });
                const holdPartyPlay =
                    watchTogether.isWatchPartySyncing ||
                    watchTogether.isStalled ||
                    watchTogether.isPlayerAttachmentPending ||
                    this.watchTogetherCtrl?.isPlaybackHeld();
                watchTogether.syncPlaybackState(currentTime, willPlay);
                if (willPlay && !holdPartyPlay) {
                    // Apply this input now. A delayed Play can run after a newer
                    // canonical Pause or after navigation replaces the element.
                    this.videoElement.play().catch((e: Error) => this.handlePlayError(e));
                } else if (!willPlay) {
                    this.videoElement.pause();
                }
            } else {
                if (willPlay) {
                    playerStore.setPausedByUser(false);
                    this.updatePlaybackIntent();
                    // Inside the tap: attach an iOS source that waited for a gesture.
                    this.playbackManager?.startDeferredSource();
                    this.videoElement.play().catch((e: Error) => this.handlePlayError(e));
                } else {
                    // Deliberate user pause — record intent so reconnect/watchdog
                    // never auto-resume against the user's wishes.
                    playerStore.setPausedByUser(true);
                    this.updatePlaybackIntent();
                    this.videoElement.pause();
                }
            }
        }
    }

    seek(seconds: number): void {
        if (!this.videoElement) return;

        if (this.isWatchPartyGuest) {
            console.log('[Player] Guest cannot seek - only host can');
            return;
        }

        const videoTime = this.videoElement.currentTime;
        const storeTime = playerStore.playheadTime || playerStore.currentTime;
        const videoTimeLooksReset =
            this.playbackManager?.isHlsMode() &&
            playerStore.isBuffering &&
            videoTime < 0.5 &&
            storeTime > 1;
        const baseTime =
            (playerStore.isSeeking || videoTimeLooksReset) && storeTime > 0 ? storeTime : videoTime;
        const toTime = this.clampSeekTime(baseTime + seconds);
        if (toTime === null) {
            this.warn(' seek() ignored non-finite target time', {
                currentTime: videoTime,
                seconds,
            });
            return;
        }

        this.seekTo(toTime, true, 'seek_relative');
        playerStore.showControlsTemporarily();

        if (!playerStore.isLive) {
            const side: 'left' | 'right' = seconds < 0 ? 'left' : 'right';
            this.clearSkipAnimationTimer();
            this.skipAnimation = updateSkipAnimation(this.skipAnimation, side, Math.abs(seconds));
            this.skipAnimationTimeout = setTimeout(() => {
                this.skipAnimation = null;
            }, TIMING.SKIP_ANIMATION_DURATION_MS);
        }
    }

    seekToPercent(percent: number): void {
        if (this.videoElement) {
            if (this.isWatchPartyGuest) {
                console.log('[Player] Guest cannot seek - only host can');
                return;
            }

            const duration = Number.isFinite(playerStore.duration)
                ? playerStore.duration
                : Number.isFinite(this.videoElement.duration)
                  ? this.videoElement.duration
                  : null;
            if (duration === null) {
                this.warn(' seekToPercent() ignored - unknown duration', {
                    percent,
                });
                return;
            }
            const toTime = (duration * percent) / 100;
            this.log(' seekToPercent():', {
                percent: percent.toFixed(1) + '%',
                to: toTime.toFixed(2) + 's',
                duration: duration.toFixed(2) + 's',
            });
            this.seekTo(toTime);
            playerStore.showControlsTemporarily();
        }
    }

    /**
     * The entry this playback reports (watch-entry.ts). A watch party is
     * explicit: what plays there is the host's choice, not the viewer's chain.
     */
    private currentWatchEntry(): WatchEntry {
        if (watchTogether.isInWatchParty) return 'explicit';
        return readWatchEntry();
    }

    seekTo(time: number, broadcastToWatchParty = true, source: SeekSource = 'seekTo'): void {
        if (this.videoElement) {
            if (this.isWatchPartyGuest && broadcastToWatchParty) {
                console.log('[Player] Guest cannot seek - only host can');
                return;
            }
            const toTime = this.clampSeekTime(time);
            if (toTime === null) {
                this.warn(' seekTo() ignored non-finite target time', {
                    time,
                    duration: playerStore.duration,
                });
                return;
            }

            const buffered = this.videoElement.buffered;
            let isWithinBuffered = false;
            for (let i = 0; i < buffered.length; i++) {
                if (toTime >= buffered.start(i) && toTime <= buffered.end(i)) {
                    isWithinBuffered = true;
                    break;
                }
            }

            const isHlsMode = this.playbackManager?.isHlsMode() ?? false;
            const originalTime = this.videoElement.currentTime;
            // A viewer's own seek (external and party-sync seeks pass false) is an
            // action: the resume handoff only follows playback that started after it.
            if (broadcastToWatchParty) playerStore.lastUserSeekAt = Date.now();
            const isCoordinatedWatchPartySeek = broadcastToWatchParty && this.canSyncToWatchParty;
            // Our own earlier seek may have paused the element for its barrier; its
            // intent counts as "playing" (watchTogether.seekResumeIntent).
            const shouldResumeAfterWatchPartySeek = isCoordinatedWatchPartySeek
                ? watchTogether.seekResumeIntent(!this.videoElement.paused)
                : !this.videoElement.paused;

            const needsRestartForSeek = !isWithinBuffered && this.isDirectStreamMode && !isHlsMode;

            this.log(` seekTo(${source}):`, {
                from: originalTime.toFixed(2) + 's',
                to: toTime.toFixed(2) + 's',
                duration: playerStore.duration.toFixed(2) + 's',
                isWithinBuffered,
                playMethod: playerStore.playMethod,
                isHlsMode,
                needsRestartForSeek,
            });

            // A party seek resumes exclusively through the buffer_check /
            // all_ready protocol. Pause before any source rebuild can capture
            // the old playing state and resume independently; retain that
            // pre-pause intent for the server payload below.
            if (isCoordinatedWatchPartySeek) {
                this.videoElement.pause();
            }

            // A seek to the already-current position may emit no seeked event.
            // Do not leave timeupdate/display writes waiting for that event.
            const seeksPosition = toTime !== originalTime || this.videoElement.seeking;
            this.telemetryCtrl.seekStartPosition = seeksPosition ? playerStore.currentTime : null;
            playerStore.setSeeking(seeksPosition);
            playerStore.setBuffering(seeksPosition || this.videoElement.readyState < 2);
            playerStore.setCurrentTime(toTime);
            // Reset throttle so lock screen / OS media controls update immediately after seek
            this.lastMediaSessionPositionUpdate = 0;

            if (needsRestartForSeek) {
                this.log(' DirectStream seek beyond buffered - restarting');
                this.restartStreamAtPosition(toTime);
            } else {
                this.setVideoTime(toTime, source);
                // Let native HLS seek the existing source, as fullscreen
                // controls do. Replacing its source here interrupts
                // the seek and discards buffers. HLS.js still needs its reset
                // after currentTime so stale demuxed-audio state is cleared.
                // Use engine identity: a temporarily absent Hls instance during
                // a rebuild must still accept and coalesce a newer target.
                if (
                    isHlsMode &&
                    !isWithinBuffered &&
                    this.playbackManager &&
                    !this.playbackManager.isNativeEngine()
                ) {
                    this.playbackManager.resetForSeek(toTime, false, watchTogether.isInWatchParty);
                }
            }

            if (isCoordinatedWatchPartySeek || source === 'watch_party_seek') {
                this.playbackManager?.recoverNativePartySeekBurst(toTime);
            }

            // DEBUG: track video.currentTime after seek settles
            if (isHlsMode && !isWithinBuffered) {
                const seekTarget = toTime;
                const checkTiming = () => {
                    if (!this.videoElement) return;
                    console.log('[SEEK TIMING]', {
                        seekTarget,
                        videoCurrentTime: this.videoElement.currentTime,
                        delta: this.videoElement.currentTime - seekTarget,
                        playMethod: playerStore.playMethod,
                        bufferedRanges: Array.from(
                            { length: this.videoElement.buffered.length },
                            (_, i) =>
                                `${this.videoElement!.buffered.start(i).toFixed(2)}-${this.videoElement!.buffered.end(i).toFixed(2)}`,
                        ),
                    });
                };
                // Check 1s and 3s after seek to see where video.currentTime lands
                setTimeout(checkTiming, 1000);
                setTimeout(checkTiming, 3000);
            }

            if (broadcastToWatchParty && this.canSyncToWatchParty) {
                // Pass the real play state — a seek while paused must not
                // force-resume the party (server defaults isPlaying to the
                // session state when omitted, but the element knows best)
                watchTogether.broadcastSeek(toTime, shouldResumeAfterWatchPartySeek);
            }
        }
    }

    adjustVolume(delta: number): void {
        if (this.videoElement) {
            const newVolume = clampVolume(this.videoElement.volume, delta);
            this.videoElement.volume = newVolume;
            playerStore.setVolume(newVolume);
            playerStore.showControlsTemporarily();
            this.showVolumeIndicator();
        }
    }

    adjustSpeed(direction: number): void {
        // Match the speed menu: live streams and watch parties own their rate.
        if (!this.videoElement || playerStore.isLive || watchTogether.isInWatchParty) return;

        const currentSpeed = this.videoElement.playbackRate;
        let currentIndex = this.SPEED_LEVELS.findIndex((s) => Math.abs(s - currentSpeed) < 0.01);
        if (currentIndex === -1) {
            currentIndex = this.SPEED_LEVELS.reduce(
                (nearest, speed, index) =>
                    Math.abs(speed - currentSpeed) <
                    Math.abs(this.SPEED_LEVELS[nearest] - currentSpeed)
                        ? index
                        : nearest,
                0,
            );
        }

        const newIndex = Math.max(
            0,
            Math.min(this.SPEED_LEVELS.length - 1, currentIndex + direction),
        );
        const newSpeed = this.SPEED_LEVELS[newIndex];

        this.videoElement.playbackRate = newSpeed;
        playerStore.setPlaybackRate(newSpeed);
        playerStore.showControlsTemporarily();
        this.osdIndicators.showSpeedIndicator(newSpeed);
    }

    stepFrame(direction: number): void {
        if (!this.videoElement) return;

        // Frame stepping moves the playback position, which is host-only in a
        // watch party (like seek). A guest stepping would desync and get pulled
        // back by the host's position.
        if (this.isWatchPartyGuest) {
            console.log('[Player] Guest cannot frame-step - only host can');
            return;
        }

        if (!this.videoElement.paused) {
            // Frame-stepping is a deliberate user pause — record intent so
            // reconnect/watchdog never auto-resume against the user's wishes.
            playerStore.setPausedByUser(true);
            this.updatePlaybackIntent();
            this.videoElement.pause();
            playerStore.setPlaying(false);
        }

        const frameDuration = 1 / FRAME.DEFAULT_FPS;

        const newTime = Math.max(
            0,
            Math.min(
                this.videoElement.duration,
                this.videoElement.currentTime + frameDuration * direction,
            ),
        );

        this.setVideoTime(newTime, 'frame_step');
        playerStore.showControlsTemporarily();
        this.osdIndicators.showFrameStepIndicator(direction > 0 ? 'forward' : 'backward');
    }

    toggleSubtitles(): void {
        const state = playerStore.getState();
        const fileId = state.currentMediaSource?.id;
        if (state.currentSubtitleTrackIndex !== null) {
            const selected = playerStore.subtitleTracks.find(
                (track) => track.index === state.currentSubtitleTrackIndex,
            );
            this.previousToggledSubtitle =
                fileId && selected
                    ? {
                          fileId,
                          id: selected.id ?? `${fileId}:${selected.index}`,
                          index: selected.index,
                      }
                    : null;
            playerStore.setSubtitleTrack(null);
        } else {
            const previous = this.previousToggledSubtitle;
            const restored =
                previous && previous.fileId === fileId
                    ? playerStore.subtitleTracks.find(
                          (track) => (track.id ?? `${fileId}:${track.index}`) === previous.id,
                      )
                    : undefined;
            playerStore.setSubtitleTrack(restored?.index ?? playerStore.savedSubtitleTrackIndex());
        }
        this.updateSubtitleDisplay();
    }

    toggleFullscreen(): void {
        if (!browser) return;

        const safariVideoFs = asSafariVideo(this.videoElement ?? null);

        // iPhone/iPad Safari's native video fullscreen is the only mode that
        // removes browser/page chrome. It cannot see the DOM subtitle overlay,
        // so expose the selected native VTT track before handing it the video.
        if (this.isIOS && safariVideoFs?.webkitEnterFullscreen) {
            this.handleIOSFullscreenStart();
            safariVideoFs.webkitEnterFullscreen();
            return;
        }

        if (!document.fullscreenElement) {
            // The watch-page survives episode/item remounts. Enter fullscreen on
            // it during the user's gesture: transferring later needs another
            // activation in Safari and races the old player's removal.
            const fullscreenTarget =
                this.playerContainer?.closest<HTMLElement>('.watch-page') ?? this.playerContainer;
            if (fullscreenTarget?.requestFullscreen) {
                fullscreenTarget.requestFullscreen().catch(() => {
                    safariVideoFs?.webkitEnterFullscreen?.();
                });
            } else if (safariVideoFs?.webkitEnterFullscreen) {
                safariVideoFs.webkitEnterFullscreen();
            }
            // fullscreenchange is authoritative; requests may be denied.
        } else {
            void document.exitFullscreen?.().catch(() => {
                playerStore.setFullscreen(!!document.fullscreenElement);
            });
        }
    }

    private handleIOSFullscreenStart(): void {
        if (!this.isIOS || this.isIOSNativeFullscreen) return;

        this.isIOSNativeFullscreen = true;
        playerStore.setFullscreen(true);
        // Do this synchronously before WebKit moves the video into its native
        // controller; an effect would run too late for the first caption cue.
        this.lastAppliedOverlayMode = false;
        this.lastAppliedPositionY = null;
        this.updateSubtitleDisplay();
    }

    private handleIOSFullscreenEnd(): void {
        if (!this.isIOS || !this.isIOSNativeFullscreen) return;

        this.isIOSNativeFullscreen = false;
        playerStore.setFullscreen(false);
        this.lastAppliedOverlayMode = true;
        this.lastAppliedPositionY = null;
        this.updateSubtitleDisplay();
    }

    toggleWatchPartyPanel(): void {
        this.watchPartyPanelOpen = !this.watchPartyPanelOpen;
    }

    closeWatchPartyPanel(): void {
        this.watchPartyPanelOpen = false;
    }

    skipSegment(): void {
        // The overlay is hidden for guests, but keyboard input and a just-fired
        // auto-skip callback can still reach this method as party membership
        // changes. Keep the authority boundary at the action itself as well.
        if (this.isWatchPartyGuest) {
            this.log(' Guest cannot skip a segment - only host can');
            return;
        }
        const segment = playerStore.activeSegment;
        if (segment && this.videoElement) {
            const targetTime = segment.endMs / 1000;
            this.setVideoTime(targetTime, 'intro_skip');
            playerStore.showControlsTemporarily();
            if (this.canSyncToWatchParty) {
                watchTogether.broadcastSeek(
                    targetTime,
                    watchTogether.seekResumeIntent(!this.videoElement.paused),
                );
            }
        }
    }

    // Transfer native fullscreen from .player-container to the persistent .watch-page wrapper
    // so fullscreen survives the VideoPlayer remount that happens on episode/item navigation.
    private transferFullscreenToWrapper(): void {
        if (!browser || !document.fullscreenElement) return;
        const wrapper = this.playerContainer?.closest<HTMLElement>('.watch-page');
        if (wrapper && wrapper !== document.fullscreenElement) {
            wrapper.requestFullscreen?.().catch(() => {
                sessionStorage.setItem('restoreFullscreen', 'true');
            });
        }
    }

    async goToNextItem(
        event:
            | CustomEvent<{
                  type: 'playlist' | 'episode';
                  itemId: string;
                  playlistId?: number;
                  position?: number;
              }>
            | {
                  type: 'playlist' | 'episode';
                  itemId: string;
                  playlistId?: number;
                  position?: number;
              }
            | unknown,
    ): Promise<void> {
        const detail =
            event && typeof event === 'object' && 'detail' in event
                ? (
                      event as CustomEvent<{
                          type: 'playlist' | 'episode';
                          itemId: string;
                          playlistId?: number;
                          position?: number;
                      }>
                  ).detail
                : (event as {
                      type: 'playlist' | 'episode';
                      itemId: string;
                      playlistId?: number;
                      position?: number;
                  });
        const { type, itemId, playlistId, position } = detail;
        this.log(' goToNextItem called', {
            type,
            itemId,
            playlistId,
            position,
        });

        this.telemetryCtrl.flushViaBeacon();

        if (this.isPlaylistNavigation({ type, itemId, playlistId, position })) {
            this.log(' Dispatching nextPlaylistItem event', {
                itemId,
                playlistId,
                position,
            });

            const next = playerStore.effectiveNextItem;
            const owns = await this.acceptItemNavigation(
                itemId,
                next?.title || 'Playlist Item',
                'movie',
                playerStore.getState().currentMediaSource?.id,
                this.canSyncToWatchParty,
            );
            if (!owns?.()) return;
            await this.stopAndCleanup(owns);
            if (!owns()) return;
            this.props.onnextplaylistitem?.({
                itemId,
                playlistId: playlistId!,
                position: position!,
            });
        } else {
            const next = playerStore.nextEpisode;
            if (next) {
                // Audio-only: same in-place advance as goToNextEpisode() —
                // this branch is reached from the auto-skip countdown card
                // and the in-player "Next Episode" prompt, not just the
                // control-bar button.
                if (
                    shouldAdvanceInPlace(
                        playerStore.qualityMode,
                        'episode',
                        watchTogether.isInWatchParty,
                    )
                ) {
                    await this.advanceEpisodeInPlace(next);
                    return;
                }

                this.log(' Dispatching nextEpisode event', {
                    itemId: next.itemId,
                });

                const title = `S${String(next.seasonNumber).padStart(2, '0')}E${String(next.episodeNumber).padStart(2, '0')} - ${next.title}`;
                const owns = await this.acceptItemNavigation(
                    next.itemId,
                    title,
                    'episode',
                    playerStore.getState().currentMediaSource?.id,
                    this.canSyncToWatchParty,
                );
                if (!owns?.()) return;
                await this.stopAndCleanup(owns);
                if (!owns()) return;
                this.props.onnextepisode?.({ itemId: next.itemId });
            }
        }
    }

    // ============================================================================
    // Keyboard / Input Handlers
    // ============================================================================

    handleKeydown(event: KeyboardEvent): void {
        const state: KeyboardState = {
            isFullscreen: playerStore.isFullscreen,
            isWatchPartyGuest: this.isWatchPartyGuest,
            overlayHasActiveAutoSkip: this.overlayHasActiveAutoSkip,
            isActiveWatchPartyHost: this.isActiveWatchPartyHost,
            activeSegment: playerStore.activeSegment,
            effectiveNextItem: playerStore.effectiveNextItem,
            showNextItemPrompt: playerStore.showNextItemPrompt,
        };
        this.videoShortcuts.handleKeydown(event, state);
    }

    handleKeyup(event: KeyboardEvent): void {
        this.videoShortcuts.handleKeyup(event);
    }

    handleWindowBlur(): void {
        this.videoShortcuts.handleWindowBlur();
    }

    handleVideoClick(): void {
        if (this.closeAllOverlays()) {
            return;
        }
        this.togglePlayPause();
    }

    handleDoubleTapSkip(side: 'left' | 'right'): void {
        if (!this.videoElement || playerStore.isLive) return;
        const step = this.seekStepSeconds;
        const skipAmount = side === 'left' ? -step : step;
        this.seek(skipAmount);
    }

    handleVideoTap(event: MouseEvent | TouchEvent): void {
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        const result = detectDoubleTap(event, this.doubleTapState, rect);
        this.doubleTapState = result.newState;

        if (result.isDoubleTap) {
            event.preventDefault();
            event.stopPropagation();
            this.handleDoubleTapSkip(result.side);
        }
    }

    handleMouseMove(event: MouseEvent): void {
        const target = event.target;
        if (target instanceof Element && target.closest('[data-controls-hover-lock]')) {
            playerStore.setShowControls(true);
            return;
        }

        const dx = Math.abs(event.clientX - this.lastMouseX);
        const dy = Math.abs(event.clientY - this.lastMouseY);

        if (dx > 3 || dy > 3) {
            this.lastMouseX = event.clientX;
            this.lastMouseY = event.clientY;
            playerStore.showControlsTemporarily();
        }
    }

    handleMouseLeave(): void {
        if (playerStore.isPlaying && !playerStore.isPaused) {
            playerStore.setShowControls(false);
        }
    }

    handleWheel(event: WheelEvent): void {
        if (this.isAnyOverlayOpen) {
            return;
        }

        event.preventDefault();

        const { delta } = calculateWheelVolumeDelta(event.deltaY);
        this.adjustVolume(delta);
    }

    nonpassiveWheel(node: HTMLElement): { destroy(): void } {
        return playerWheelAction(node, (event) => this.handleWheel(event));
    }

    handleFullscreenChange(): void {
        playerStore.setFullscreen(!!document.fullscreenElement);
    }

    // ============================================================================
    // Navigation / UI Event Handlers
    // ============================================================================

    seekToLive(): void {
        if (!this.videoElement) return;

        const hls = this.playbackManager?.getHls();
        let livePosition: number | undefined;

        if (hls?.liveSyncPosition && hls.liveSyncPosition > 0) {
            livePosition = hls.liveSyncPosition;
        } else if (this.videoElement.seekable.length > 0) {
            livePosition = this.videoElement.seekable.end(this.videoElement.seekable.length - 1);
        } else if (isFinite(this.videoElement.duration) && this.videoElement.duration > 0) {
            livePosition = this.videoElement.duration;
        }

        if (livePosition !== undefined && livePosition > 0) {
            this.seekTo(livePosition, false, 'seek_to_live');
        }
    }

    async togglePip(): Promise<void> {
        if (!browser || !this.videoElement) return;

        const safariVideoPip = asSafariVideo(this.videoElement);

        this.log(' PiP toggle requested');
        this.log(
            ' - webkitSupportsPresentationMode:',
            typeof safariVideoPip?.webkitSupportsPresentationMode,
        );
        this.log(' - document.pictureInPictureEnabled:', document.pictureInPictureEnabled);
        this.log(' - current webkitPresentationMode:', safariVideoPip?.webkitPresentationMode);

        try {
            if (safariVideoPip?.webkitSupportsPresentationMode) {
                const supportsPip =
                    safariVideoPip.webkitSupportsPresentationMode('picture-in-picture');
                this.log(' - webkitSupportsPresentationMode("picture-in-picture"):', supportsPip);

                if (supportsPip && safariVideoPip.webkitSetPresentationMode) {
                    this.log(' Using Safari webkit PiP API');
                    if (safariVideoPip.webkitPresentationMode === 'picture-in-picture') {
                        safariVideoPip.webkitSetPresentationMode('inline');
                    } else {
                        safariVideoPip.webkitSetPresentationMode('picture-in-picture');
                    }
                    return;
                }
            }
            if (document.pictureInPictureElement) {
                this.log(' Exiting PiP via standard API');
                await document.exitPictureInPicture();
            } else if (
                document.pictureInPictureEnabled &&
                this.videoElement.requestPictureInPicture
            ) {
                this.log(' Entering PiP via standard API');
                await this.videoElement.requestPictureInPicture();
            } else {
                this.log(' PiP not supported on this device/browser');
            }
        } catch (error) {
            console.error('[Player] PiP error:', error);
        }
    }

    async toggleAirPlay(): Promise<void> {
        if (!browser || !this.videoElement) return;

        const safariVideoAirPlay = asSafariVideo(this.videoElement);

        if (!safariVideoAirPlay?.webkitShowPlaybackTargetPicker) {
            this.log(' AirPlay not supported');
            return;
        }

        if (this.isPreparingAirPlay) {
            this.log(' AirPlay preparation already in progress');
            return;
        }

        // Re-mint when there is no token, it is past its expiry, or the source
        // it feeds has failed — a session killed by the inactivity timeout
        // still looks valid here, and the picker alone would not repair it.
        const tokenUsable = isStreamTokenUsable(this.streamToken, this.streamTokenExpiresAt);
        if (this.props.enableAirPlay && (!tokenUsable || this.videoElement.error !== null)) {
            if (this.streamToken) this.dropStreamToken();
            this.isPreparingAirPlay = true;

            try {
                this.log(' Fetching stream token for AirPlay...');

                playerStore.setLoading(true);

                if (!this.streamTokenPromise) {
                    this.streamTokenPromise = this.fetchStreamToken();
                }
                this.streamToken = await this.streamTokenPromise;

                if (this.streamToken) {
                    this.log(' Stream token acquired, restarting with HLS for AirPlay');

                    const currentPosition = this.videoElement?.currentTime || 0;

                    await this.initializePlayback(false, currentPosition, true);

                    await new Promise((resolve) => setTimeout(resolve, TIMING.RETRY_DELAY_MS));
                } else {
                    this.log(
                        ' Failed to get stream token, AirPlay may not work on external device',
                    );
                    // Clear the memoized promise so the next AirPlay click retries
                    // instead of reusing this cached failure (e.g. a transient
                    // network error or a 429 rate limit).
                    this.streamTokenPromise = null;
                    playerStore.setLoading(false);
                    // Abort: do NOT open the picker with a cookie-scoped URL the
                    // receiver can't authenticate — that guarantees a 401 / black
                    // screen. Tell the user; the reset above lets them retry.
                    toasts.error('AirPlay unavailable — try again');
                    // Already routed wireless: still open the picker so the user
                    // can switch receivers or disconnect from our UI.
                    if (safariVideoAirPlay.webkitCurrentPlaybackTargetIsWireless) {
                        safariVideoAirPlay.webkitShowPlaybackTargetPicker();
                    }
                    return;
                }
            } catch (error) {
                // The rebuild threw: nothing else will clear the spinner.
                playerStore.setLoading(false);
                throw error;
            } finally {
                this.isPreparingAirPlay = false;
            }
        }

        this.log(' Opening AirPlay picker');
        safariVideoAirPlay.webkitShowPlaybackTargetPicker();
    }

    setupAirPlayListeners(): void {
        if (!browser || !this.videoElement) return;

        const safariVideoEvents = asSafariVideo(this.videoElement);
        if (!safariVideoEvents) return;

        const videoEl = this.videoElement as EventTarget;
        const onAvailabilityChanged = ((e: Event & { availability?: string }) => {
            this.log(' AirPlay availability changed:', e.availability);
        }) as EventListener;

        const onWirelessChanged = () => {
            this.isAirplayActive = safariVideoEvents.webkitCurrentPlaybackTargetIsWireless || false;
            this.log(' AirPlay wireless state changed:', this.isAirplayActive);
        };

        videoEl.addEventListener('webkitplaybacktargetavailabilitychanged', onAvailabilityChanged);
        videoEl.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', onWirelessChanged);

        this.airplayListenerCleanup = () => {
            videoEl.removeEventListener(
                'webkitplaybacktargetavailabilitychanged',
                onAvailabilityChanged,
            );
            videoEl.removeEventListener(
                'webkitcurrentplaybacktargetiswirelesschanged',
                onWirelessChanged,
            );
        };
    }

    async goToNextEpisode(): Promise<void> {
        this.log(' goToNextEpisode called', {
            nextEpisode: playerStore.nextEpisode,
        });
        const next = playerStore.nextEpisode;
        if (!next) {
            this.log(' No next episode available');
            return;
        }

        // Audio-only: advance without navigating so the media element (and
        // any backgrounded iOS audio session) survives the episode boundary.
        // See audio-only-advance.ts for why this is scoped to episodes only.
        if (
            shouldAdvanceInPlace(playerStore.qualityMode, 'episode', watchTogether.isInWatchParty)
        ) {
            await this.advanceEpisodeInPlace(next);
            return;
        }

        this.log(' Dispatching nextEpisode event', { itemId: next.itemId });
        this.telemetryCtrl.flushViaBeacon();
        const title = `S${String(next.seasonNumber).padStart(2, '0')}E${String(next.episodeNumber).padStart(2, '0')} - ${next.title}`;
        const owns = await this.acceptItemNavigation(
            next.itemId,
            title,
            'episode',
            playerStore.getState().currentMediaSource?.id,
            this.canSyncToWatchParty,
        );
        if (!owns?.()) return;
        await this.stopAndCleanup(owns);
        if (!owns()) return;
        this.props.onnextepisode?.({ itemId: next.itemId });
    }

    /**
     * Advance to the next episode WITHOUT navigating: keeps the same media
     * element and PlaybackManager alive so a backgrounded iOS audio session
     * survives the transition, instead of the normal stopAndCleanup() +
     * onnextepisode + goto() + {#key} remount path.
     *
     * Only reached via shouldAdvanceInPlace() (audio-only + episode, not in a
     * watch party). The video path and playlist transitions never call this
     * method.
     */
    private async advanceEpisodeInPlace(next: NextEpisodeInfo): Promise<void> {
        this.telemetryCtrl.flushViaBeacon();

        const newItemId = next.internalId ?? next.itemId;
        const newInfo = await this.fetchPlaybackProbe(newItemId);
        if (!newInfo || !newInfo.activeVersion.playable) {
            toasts.error('Failed to load next episode');
            return;
        }

        // resolveAvailableLumastraMethod is qualityMode-aware: since we're
        // still in audio-only here, it resolves 'audio_only' or null — and
        // on null it already toasts + reverts the quality profile away from
        // audio-only, which is the same fallback used everywhere else in
        // this file. We just decline to advance into a broken state.
        const method = this.resolveAvailableLumastraMethod(newInfo);
        if (!method) return;

        if (!this.tryStartRestart()) return;
        // New item: a restart queued (or a resume position captured) for the
        // previous episode must not run against this one.
        this.restartQueue.reset();

        try {
            await this.advanceEpisodeInPlaceInner(next, newInfo, method, newItemId);
        } catch (err) {
            // Same hazard restartStreamWithNewQuality() guards against: if any
            // awaited call below rejects (network error, HLS.js load failure,
            // etc.) without this, the explicit finishRestart() calls are
            // skipped and isRestartingPlayback stays true forever —
            // permanently blocking every future audio/quality switch and
            // error recovery via the coalescer's isRestartingPlayback guard.
            this.log(' advanceEpisodeInPlace failed:', err);
            // Also tear down any position-restore listener the inner call may
            // have attached before failing — left alone, it can fire later
            // against an unrelated, successful restart and call
            // finishRestart(true) + bootstrapFirstPlay() for a source that
            // never actually loaded, minting a phantom session.
            this.cleanupPositionRestore?.();
            this.cleanupPositionRestore = null;
            this.finishRestart();
        }
    }

    private async advanceEpisodeInPlaceInner(
        next: NextEpisodeInfo,
        newInfo: PlayerProbe,
        method: PlayerMethod,
        newItemId: string,
    ): Promise<void> {
        // Close out the current item's session BEFORE repointing the
        // reporter at the new item — otherwise the new episode's progress
        // would be misattributed to the old item's play_sessions row.
        await this.endCurrentSession('switch');

        if (this.progressReporter instanceof PlaySessionReporter) {
            this.progressReporter.setItemIdentity({
                mediaId: newItemId,
                jellyfinItemId: next.itemId !== newItemId ? next.itemId : undefined,
            });
        }

        // A stale onNextTrack closure would otherwise still target this
        // episode's own "next" item. NextEpisodeInfo doesn't carry the
        // episode after `next`, so clear it now — resolveAndApplyFollowingEpisode()
        // (fired below, in the background) patches it back in once the
        // following episode is resolved via the ordered episode-list
        // endpoints. Until then, the lock-screen "next track" control, the
        // in-player Next Episode prompt, and further countdown auto-advance
        // are unavailable.
        this.mediaSessionCtrl.deps.onNextTrack = undefined;

        this.playbackMethodOverride = undefined;
        this.setPlaybackProbe(newInfo);
        this.setLumastraPlayMethod(method);
        this.syncProbeVersionsToStore(newInfo);
        const newSource = this.buildLumastraSource(newInfo, newItemId);
        playerStore.updateCurrentMediaSource(newSource);
        // NOTE: playMethod is deliberately NOT set here. playerStore.initialize()
        // below re-derives it from the new source's supportsDirectPlay/Stream and
        // would overwrite whatever we wrote — and its derivation can never
        // produce 'AudioOnly'. It is set after initialize() instead; see below.
        playerStore.setTranscodingInfo(this.buildLumastraTranscodingInfo(newInfo, method));

        // Seed resume from the probe. The start below supplies the effective
        // entry point when this episode belongs to a combined file.
        const durationMs = newInfo.activeVersion.durationMs ?? 0;
        const effectiveStartMs = newInfo.resumePositionMs;
        let startPositionSeconds = effectiveStartMs / 1000;

        const mergedPlaybackInfo: PlaybackInfo = {
            ...this.currentPlaybackInfo,
            itemId: next.itemId,
            internalId: next.internalId,
            title: next.title,
            seriesName: next.seriesName ?? this.currentPlaybackInfo.seriesName,
            seasonNumber: next.seasonNumber,
            episodeNumber: next.episodeNumber,
            episodeStartNumber: undefined,
            episodeEndNumber: undefined,
            episodeSegment: undefined,
            runTimeTicks:
                durationMs > 0 ? durationMs * 10_000 : this.currentPlaybackInfo.runTimeTicks,
            userData: {
                playbackPositionTicks: effectiveStartMs * 10_000,
                playedPercentage: newInfo.isWatched ? 100 : 0,
                played: newInfo.isWatched,
            },
            isWatched: newInfo.isWatched,
            resumeAnchor: null,
            mediaSources: [newSource],
            // Fetched separately below (fetchTimeline, fire-and-
            // forget, mirrors the mount-time call) via the start's timeline href.
            chapters: [],
            mediaSegments: [],
            // NextEpisodeInfo doesn't carry the episode after `next` — resolved
            // separately below (resolveAndApplyFollowingEpisode, fire-and-forget)
            // and patched in via playerStore.setNextEpisode() once ready.
            nextEpisode: undefined,
            streamStartPositionTicks: 0,
            clientShouldSeek: false,
            playSessionId: generatePlaySessionId(),
        };

        this.currentPlaybackInfo = mergedPlaybackInfo;
        this.currentMediaDbId = newItemId;
        playerStore.initialize(mergedPlaybackInfo, this.props.nextEpisodePromptLeadSeconds ?? 0);
        // AFTER initialize(): it is the last writer of playMethod on this path
        // (it derives DirectPlay/DirectStream/Transcode from the media source),
        // and the audio-only rung is a client-side selection no source
        // capability can express. Setting it before would badge the new episode
        // as Remux.
        playerStore.setPlayMethod(lumastraMethodToPlayMethod(method));
        this.syncPlaySessionId(mergedPlaybackInfo.playSessionId);
        // Apply the server's resolved starting tracks now that the new item's
        // media source has real track data — initialize() only picked the new
        // source's OWN default track, same as mount() does via its second
        // applyTrackRecommendation() call (see mount() for why one call isn't
        // enough). Falls back to local resolution when the server expressed
        // no opinion (recommended absent) — see applyTrackRecommendation.
        playerStore.applyTrackRecommendation(probeTrackRecommendation(newInfo));
        // Re-seed from the new item's own resume anchor — otherwise
        // writeResumeCache() would keep comparing the new episode's playhead
        // against the OLD episode's anchor.
        this.latestServerAnchor = null;

        // Fetch chapters/media segments in the background (fire-and-forget,
        // same as mount()) — without this the new episode has no intro/outro
        // markers, and mediaSegments feeds the outro-driven auto-advance
        // itself.

        this.refreshTimeline(newInfo);
        this.setLumastraHdrInfo(newInfo);

        // Reset the "first play" bootstrap so bootstrapFirstPlay() re-runs
        // engagement tracking and reportProgress('start') for the new item,
        // instead of treating the next play event as a mid-session progress
        // tick against the old episode's accumulator. onPlay() itself won't
        // reach that branch here — see bootstrapFirstPlay()'s doc comment —
        // so it's called explicitly below once the swap is confirmed ready.
        this.isInitialized = false;

        // The old episode's stream token (if any) is now invalid — forward-auth
        // validates it against the item id in the URL path
        // (forward-auth.ts's sessionService.validate(streamTokenParam,
        // requestedItemId, ...), reason 'wrong_item' on mismatch). Leaving it
        // in place would 401 every playlist/segment request for the new
        // episode on Safari with AirPlay engaged — exactly the boundary this
        // feature exists to survive. Clear it unconditionally; re-mint only
        // when AirPlay is actually active, mirroring the same check
        // initializePlayback() uses for a resumed AirPlay session.
        this.dropStreamToken();
        const safariVideoForToken = asSafariVideo(this.videoElement ?? null);
        if (
            this.props.enableAirPlay &&
            this.isSafari &&
            safariVideoForToken?.webkitCurrentPlaybackTargetIsWireless
        ) {
            this.streamTokenPromise = this.fetchStreamToken();
            this.streamToken = await this.streamTokenPromise;
            if (!this.streamToken) {
                // Don't cache the failure: the AirPlay button reuses a memoized
                // promise, so a cached null would fail the user's retry instantly.
                // That click then re-mints and rebuilds with the token.
                this.streamTokenPromise = null;
                toasts.error('AirPlay unavailable — try again');
            }
        }

        const url = await this.buildLumastraPlaybackUrl(
            newInfo,
            method,
            startPositionSeconds > 0 ? startPositionSeconds : undefined,
        );
        startPositionSeconds =
            (this.playbackStart && 'startPositionMs' in this.playbackStart.delivery
                ? this.playbackStart.delivery.startPositionMs
                : effectiveStartMs) / 1000;
        playerStore.setLoading(true);

        if (this.videoElement) {
            const handler = createPositionRestoreHandler(
                this.videoElement,
                {
                    targetPosition: startPositionSeconds,
                    autoResume: false,
                    timeoutMs: RESTART_TIMING.RESTORE_TIMEOUT_MS,
                    onRestored: () => {
                        this.finishRestart(true);
                        // The whole onPlay() block is swallowed on this path —
                        // replay it, not just bootstrapFirstPlay(). Critically
                        // this clears `hasEnded`, which onEnded() set true just
                        // before the advance and which otherwise disables the
                        // reconnect auto-resume and the stall watchdog for the
                        // rest of the session. See playback-resumed-reset.ts.
                        this.applyPlaybackResumedReset();
                        this.bootstrapFirstPlay();
                    },
                },
                this.log,
                this.setVideoTime.bind(this) as (time: number, source: string) => void,
            );
            this.cleanupPositionRestore = handler.cleanup;
        }

        // Assign the new URL to the EXISTING media element without ever
        // clearing its src to empty — initializeHls/initializeDirectPlay
        // (via PlaybackManager.load()) already do this safely (skipVideoReset),
        // which is exactly why we don't call stopAndCleanup()/clearVideoSource()
        // here (that would end a backgrounded iOS audio session).
        if (method === 'direct') {
            this.initializeDirectPlay(url);
        } else {
            await this.initializeHls(url, startPositionSeconds);
        }

        if (!this.videoElement) {
            this.finishRestart(true);
            this.applyPlaybackResumedReset();
            this.bootstrapFirstPlay();
        }

        this.mediaSessionCtrl.setup(mergedPlaybackInfo);

        // SvelteKit shallow routing — updates the URL without re-running
        // load(), so the +page.svelte {#key data.playbackInfo.itemId} block
        // never sees a changed key and the player is never remounted.
        if (browser) {
            // eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() from $lib/paths wraps $app/paths resolve
            pushState(resolve(`/watch/${next.itemId}`), {});
        }

        // Resolve the episode AFTER `next` in the background — fire-and-forget
        // so it never delays the swap/playback start above. Without this the
        // in-place chain would stop after exactly one hop (no Next Episode
        // prompt, no lock-screen control, no further countdown auto-advance),
        // which defeats the point for a multi-episode background listen.
        void this.resolveAndApplyFollowingEpisode(
            mergedPlaybackInfo.seriesId,
            next,
            mergedPlaybackInfo.seriesName,
        );
    }

    /**
     * Background follow-up to advanceEpisodeInPlaceInner(): resolves the
     * episode strictly AFTER `after` and patches it into playerStore /
     * MediaSessionController once found, so the in-place chain can continue
     * past one hop instead of stopping dead.
     *
     * The default /next-episode lookup is watch-history-driven and would
     * very likely return `after` itself
     * again (the user hasn't watched it yet, having just started it). The explicit
     * playback cursor shares the loader's default-file-aware SQL resolver, so
     * combined files and custom ordering advance identically on every hop.
     */
    private async resolveAndApplyFollowingEpisode(
        seriesId: string | undefined,
        after: NextEpisodeInfo,
        seriesName: string | undefined,
    ): Promise<void> {
        if (!seriesId) return;
        const following = await this.resolveFollowingEpisode(seriesId, after, seriesName);
        if (!following) return;
        // Guard against a race: if another advance (or a real navigation) has
        // already moved the player past `after` by the time this resolves,
        // applying it now would attach the wrong "next episode" to whatever
        // the player is showing at that point.
        if (this.currentPlaybackInfo.itemId !== after.itemId) return;

        playerStore.setNextEpisode(following);

        // Re-wire onNextTrack now that there's something real to target, and
        // re-run mediaSessionCtrl.setup() so the lock screen's "next track"
        // control picks it up — setup() locks in whatever onNextTrack held at
        // call time, so simply reassigning deps.onNextTrack afterward would
        // not retroactively update the already-registered handler.
        this.mediaSessionCtrl.deps.onNextTrack = () => {
            const effectiveNext = playerStore.effectiveNextItem;
            if (!effectiveNext) return;
            if (this.isPlaylistNavigation(effectiveNext)) {
                this.props.onnextplaylistitem?.({
                    itemId: effectiveNext.itemId,
                    playlistId: effectiveNext.playlistId,
                    position: effectiveNext.position,
                });
            } else {
                this.props.onnextepisode?.({ itemId: effectiveNext.itemId });
            }
        };
        this.mediaSessionCtrl.setup(this.currentPlaybackInfo);
    }

    /**
     * Resolve the episode immediately following `after` (season/episode
     * ordering-aware, watch-history-independent — see
     * resolveAndApplyFollowingEpisode()'s doc comment). Returns null on any
     * failure or when `after` is the last episode of the series; callers
     * must treat that as "chain ends here", not as an error.
     */
    private async resolveFollowingEpisode(
        seriesId: string,
        after: NextEpisodeInfo,
        seriesName: string | undefined,
    ): Promise<NextEpisodeInfo | null> {
        // The endpoint only accepts the episode's catalog UUID (anything else is
        // a 422), so prefer the internal id and never send a Jellyfin-style id.
        const afterId = asInternalUuid(after.internalId) ?? asInternalUuid(after.itemId);
        if (!afterId) {
            this.log(' resolveFollowingEpisode skipped: no catalog UUID for', after.itemId);
            return null;
        }
        try {
            let result = await getNextEpisodeAfterPlayback(seriesId, afterId);
            // One retry on a server or network error (status 0): a transient
            // failure must not read as "no next episode" and end the chain.
            if (result.error && (result.status === 0 || result.status >= 500)) {
                result = await getNextEpisodeAfterPlayback(seriesId, afterId);
            }
            const { data: ep, error } = result;
            if (error || !ep) return null;
            return {
                itemId: ep.id,
                internalId: ep.id,
                title: ep.title,
                episodeNumber: ep.episodeNumber,
                seasonNumber: ep.seasonNumber,
                isNewSeason: ep.seasonNumber !== after.seasonNumber,
                seriesName,
                hasPrimaryImage: Boolean(ep.images.thumb || ep.images.primary),
                overview: ep.overview,
            };
        } catch (err) {
            this.log(' resolveFollowingEpisode failed:', err);
            return null;
        }
    }

    handleSeek(event: CustomEvent<number> | number): void {
        const time = typeof event === 'number' ? event : event.detail;
        this.seekTo(time);
    }

    handleVolume(newVolume: number): void {
        if (this.videoElement) {
            this.videoElement.volume = newVolume;
        }
    }

    handleVersionChange(event: CustomEvent<string> | string): void {
        const fileId = typeof event === 'string' ? event : event.detail;
        if (!fileId) return;

        if (watchTogether.isInWatchParty) {
            watchTogether.broadcastVersionChange(fileId);
        }

        // Notify listeners (page updates ?fileId= in URL so F5 resumes the
        // same version) before taking either branch — both the Lumastra
        // multi-version switch and the quality-only restart are version
        // changes from the user's perspective.
        this.props.onversionchange?.(fileId);

        if (this.playbackProbe?.versions && this.playbackProbe.versions.length > 1) {
            this.switchLumastraFile(fileId);
            return;
        }

        if (this.playbackProbe && !this.playbackProbe.versions?.length) {
            return;
        }

        this.restartStreamWithNewQuality();
    }

    private async cleanupBeforeLiveTvNavigation(): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                this.stopAndCleanup().catch(() => {}),
                new Promise<void>((done) => {
                    timer = setTimeout(done, 1000);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    handleLiveTvRetry(): void {
        if (this.wasKicked) return;
        if (
            this.liveTvFailure?.type === 'stream_failed' &&
            this.videoElement &&
            this.isInitialized
        ) {
            this.resetLiveTvRetryBudget();
            void this.retryLiveTvInPlace();
            return;
        }
        this.resetLiveTvRetryBudget();
        this.reloadLiveTvPage();
    }

    private reloadLiveTvPage(): void {
        if (this.wasKicked) return;
        this.reconnectDiagnosticEpoch++;
        this.liveTvFailure = null;
        if (browser) {
            // A fresh controller owns the retry; stale initialization cannot overwrite it.
            void this.cleanupBeforeLiveTvNavigation().then(() => window.location.reload());
        }
    }

    /** "Try another channel" on the failure card: the next station in the lineup (simple mode: next of the viewer's list). */
    async handleLiveTvAnotherChannel(): Promise<void> {
        this.resetLiveTvRetryBudget();
        if (liveTvSimpleContext.active && liveTvSimpleContext.zapNext) {
            liveTvSimpleContext.zapNext();
            return;
        }
        const result = await getLiveTvChannels();
        const next = nextStationId(result.data?.items ?? [], this.currentPlaybackInfo.itemId);
        if (!next) {
            this.handleLiveTvSwitchChannel();
            return;
        }
        await this.handleSelectChannel({ channelId: next });
    }

    handleLiveTvSwitchChannel(): void {
        this.resetLiveTvRetryBudget();
        this.reconnectDiagnosticEpoch++;
        if (browser) {
            void this.cleanupBeforeLiveTvNavigation().then(() => {
                // eslint-disable-next-line svelte/no-navigation-without-resolve -- $lib/paths resolve wraps the SvelteKit resolver
                void goto(resolve('/livetv'));
            });
        }
    }

    async handleSelectChannel(
        event: CustomEvent<{ channelId: string }> | { channelId: string },
    ): Promise<void> {
        this.showChannelSwitcher = false;
        this.resetLiveTvRetryBudget();
        if (browser) {
            this.transferFullscreenToWrapper();
            await this.stopAndCleanup();
            const detail = 'detail' in event ? event.detail : event;
            // eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() from $lib/paths wraps $app/paths resolve
            goto(resolve(`/watch/${detail.channelId}`), { replaceState: true });
        }
    }

    async handlePlayMovie(
        event: CustomEvent<{ itemId: string }> | { itemId: string },
    ): Promise<void> {
        this.showMovieSidebar = false;
        if (browser) {
            this.transferFullscreenToWrapper();
            await this.stopAndCleanup();
            const detail = 'detail' in event ? event.detail : event;
            // eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() from $lib/paths wraps $app/paths resolve
            goto(resolve(`/watch/${detail.itemId}`), { replaceState: true });
        }
    }

    async handleSelectEpisode(
        event:
            | CustomEvent<{
                  episodeId: string;
                  seasonNumber: number;
                  episodeNumber: number;
                  title: string;
              }>
            | {
                  episodeId: string;
                  seasonNumber: number;
                  episodeNumber: number;
                  title: string;
              },
    ): Promise<void> {
        this.showEpisodeBrowser = false;
        if (browser) {
            const detail = 'detail' in event ? event.detail : event;
            const title = `S${String(detail.seasonNumber).padStart(2, '0')}E${String(detail.episodeNumber).padStart(2, '0')} - ${detail.title}`;
            const owns = await this.acceptItemNavigation(
                detail.episodeId,
                title,
                'episode',
                undefined,
                watchTogether.isInWatchParty,
            );
            if (!owns?.()) return;
            this.transferFullscreenToWrapper();
            await this.stopAndCleanup(owns);
            if (!owns()) return;
            // eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() from $lib/paths wraps $app/paths resolve
            goto(resolve(`/watch/${detail.episodeId}`), { replaceState: true });
        }
    }

    async handleSelectPlaylistItem(
        event:
            | CustomEvent<{
                  itemId: string;
                  playlistId: number;
                  position: number;
                  title: string;
              }>
            | {
                  itemId: string;
                  playlistId: number;
                  position: number;
                  title: string;
              },
    ): Promise<void> {
        this.showPlaylistBrowser = false;
        if (browser) {
            const detail = 'detail' in event ? event.detail : event;
            const owns = await this.acceptItemNavigation(
                detail.itemId,
                detail.title,
                'movie',
                undefined,
                watchTogether.isInWatchParty,
            );
            if (!owns?.()) return;
            this.transferFullscreenToWrapper();
            await this.stopAndCleanup(owns);
            if (!owns()) return;
            const watchUrl = `/watch/${detail.itemId}?playlist=${detail.playlistId}&position=${detail.position}`;
            // eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() from $lib/paths wraps $app/paths resolve
            goto(resolve(watchUrl), { replaceState: true });
        }
    }

    async handleWatchPartySearchSelect(
        event:
            | CustomEvent<{
                  itemId: string;
                  title: string;
                  mediaType: string;
              }>
            | {
                  itemId: string;
                  title: string;
                  mediaType: string;
              },
    ): Promise<void> {
        this.showWatchPartySearch = false;
        if (browser) {
            const detail = 'detail' in event ? event.detail : event;
            const owns = await this.acceptItemNavigation(
                detail.itemId,
                detail.title,
                detail.mediaType.toLowerCase() as 'movie' | 'episode' | 'tv',
                undefined,
                true,
            );
            if (!owns?.()) return;
            await this.stopAndCleanup(owns);
            if (!owns()) return;
            // eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() from $lib/paths wraps $app/paths resolve
            goto(resolve(`/watch/${detail.itemId}`), { replaceState: true });
        }
    }

    async handleSearchSelect(
        event:
            | CustomEvent<{
                  itemId: string;
                  title: string;
                  mediaType: string;
              }>
            | {
                  itemId: string;
                  title: string;
                  mediaType: string;
              },
    ): Promise<void> {
        this.showSearch = false;
        if (browser) {
            await this.stopAndCleanup();
            const detail = 'detail' in event ? event.detail : event;
            // eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() from $lib/paths wraps $app/paths resolve
            goto(resolve(`/watch/${detail.itemId}`), { replaceState: true });
        }
    }

    // ============================================================================
    // Setup Helpers
    // ============================================================================

    setupMediaSession(): void {
        // Update the onNextTrack callback with current state
        this.mediaSessionCtrl.deps.onNextTrack = playerStore.effectiveNextItem
            ? () => {
                  const next = playerStore.effectiveNextItem;
                  if (next) {
                      if (this.isPlaylistNavigation(next)) {
                          this.props.onnextplaylistitem?.({
                              itemId: next.itemId,
                              playlistId: next.playlistId,
                              position: next.position,
                          });
                      } else {
                          this.props.onnextepisode?.({ itemId: next.itemId });
                      }
                  }
              }
            : undefined;
        this.mediaSessionCtrl.setup(this.props.playbackInfo);
    }

    setupResizeObserver(): void {
        this.resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const height = entry.contentRect.height;
                if (height > 0) {
                    this.videoHeight = height;
                }
            }
        });
    }

    async setupSubtitleAndProgressReporter(): Promise<void> {
        const generation = this.playbackGeneration;
        const renderer = createSubtitleRendererManager(
            {
                debug: this.DEBUG,
                onRendererError: (index) => {
                    if (
                        generation !== this.playbackGeneration ||
                        this.subtitleRenderer !== renderer ||
                        index !== playerStore.currentSubtitleTrackIndex
                    )
                        return;
                    const sourceId = playerStore.currentMediaSource?.id;
                    if (!sourceId) return;
                    this.subtitleInitializationFailure = {
                        index,
                        sourceId,
                        href: playerStore.subtitleTracks.find((track) => track.index === index)
                            ?.hrefs?.raw,
                        revision: playerStore.subtitleSelectionRevision,
                    };
                },
                // Native HLS can expose requestVideoFrameCallback without delivering
                // callbacks. Use libbitsub's currentTime/rAF clock for that engine.
                // Resolve lazily: the engine may not be selected during this setup.
                useFrameAwareSync: () => !this.playbackManager?.isNativeEngine(),
                sizeMultiplier: this.props.subtitleSizeMultiplier ?? 1.2,
                pgsScale: this.props.subtitlePgsScale ?? 55,
            },
            this.log,
        );
        this.subtitleRenderer = renderer;

        await serverCapabilities.fetch();
        if (generation !== this.playbackGeneration) return;
        // Live TV has its own playback session (POST /livetv/playback-sessions, kept
        // alive by its keepalive). The unified VOD start would refuse a channel id.
        if (this.props.mediaDbId && !this.props.playbackInfo.isLive) {
            // Reporter is constructed before `playbackProbe` resolves —
            // file selection arrives via setPlaybackProbe(); the started method
            // is diagnostic context, separate from requestedMethod overrides.
            // Same-browser tab coordinator — created lazily here so it
            // shares lifecycle with the reporter. setActive() is called
            // after start succeeds; clearActive() / close() on teardown.
            this.sameBrowserChannel = new SameBrowserChannel();
            this.abrSwitches = 0;
            this.abrRebuffers = 0;
            this.progressReporter = new PlaySessionReporter({
                getEntry: () => this.currentWatchEntry(),
                getAdaptiveReport: () => {
                    const hlsLevels = this.playbackManager?.getAdaptiveLevels() ?? null;
                    return buildAdaptiveReport({
                        liveLadder: playerStore.liveTvQuality?.ladder ?? null,
                        decodedResolution: playerStore.decodedResolution,
                        hlsLevels: hlsLevels?.levels ?? null,
                        hlsCurrentLevel: hlsLevels?.current ?? null,
                        bandwidthEstimate: this.playbackManager?.getBandwidthEstimate() ?? null,
                        switches: this.abrSwitches,
                        rebuffers: this.abrRebuffers,
                    });
                },
                onDelivery: (start) => {
                    if (generation !== this.playbackGeneration) return;
                    this.handlePlaybackDelivery(start);
                },
                onBeforeStart: (data) => {
                    this.subtitleStartRevision = data.subtitleSelectionRevision;
                    this.audioStartRevision = data.audioSelectionRevision;
                },
                deviceId: getDeviceId(),
                mediaId: this.props.mediaDbId,
                deviceName: (typeof navigator !== 'undefined'
                    ? navigator.userAgent
                    : 'Unknown'
                ).slice(0, 100),
                clientName: 'Lumastra Web',
                sessionId: playerStore.getState().playSessionId ?? undefined,
                jellyfinItemId:
                    this.props.playbackInfo.itemId !== this.props.playbackInfo.internalId
                        ? this.props.playbackInfo.itemId
                        : undefined,
                jellyfinMediaSourceId: playerStore.getState().currentMediaSource?.id,
                log: this.log,
                onError: (message) => toasts.error(message),
                onWarning: (message) => toasts.warning(message),
                onSessionRestarted: () => {
                    if (generation !== this.playbackGeneration) return;
                    playerStore.notifySessionRebuilt();
                    void this.restoreReportedSession();
                },
                onAuthLost: () => this.checkForLostBrowserSession('session-report-401'),
                onKill: (reason) => {
                    this.log('Session killed:', reason);
                    // A remote kill is terminal. Rebuilding here would mint a
                    // BRAND-NEW PlaySessionId the server never stopped — silently
                    // defeating the admin/takeover kill. Deploy/cleanup restarts
                    // do NOT reach onKill (the reporter filters 'session_ended',
                    // and graceful-shutdown sessions stay restorable → recovered
                    // via the segment-410 path). So treat onKill as terminal:
                    // stop reconnect handling and surface the terminal overlay.
                    // A stream-limit reconciler kick gets its own message
                    // instead of the generic admin-kick wording, so the user
                    // understands why playback stopped.
                    if (reason === 'stream_limit') {
                        this.pendingTerminalMessage = m.player_stream_limit_reached();
                    }
                    this.wasKicked = true;
                    clearTimeout(this.liveTvAutoRetryTimer);
                    // Live TV has its own dedicated, channel-aware "kicked" overlay
                    // ("Browse channels") — don't fall through to the generic
                    // web-player terminal reconnect banner.
                    if (playerStore.isLive) {
                        // That overlay carries no message, and pendingTerminalMessage
                        // is only consumed by the (now-skipped) terminal reconnect
                        // path — so surface a stream-limit reason as a toast, or it
                        // is lost entirely on the live path.
                        if (reason === 'stream_limit') {
                            toasts.error(m.player_stream_limit_reached());
                        }
                        this.liveTvFailure = {
                            type: 'kicked',
                            blocked: liveTvBlockPresentation(liveTvBlockCauseForKill(reason)),
                        };
                        return;
                    }
                    this.reconnect?.trigger('session-expired', {
                        terminal: true,
                    });
                },
                onPolicyBlocked: ({ kind, message }) => {
                    // A server-side policy block (e.g. stream_limit) is
                    // the same UX class as an admin kick: playback cannot
                    // continue, so tear it down and show the terminal overlay
                    // rather than leaving the toast as the only signal (which
                    // previously left the stream running — cosmetic-only limit).
                    if (this.wasKicked) return;
                    this.log('Session blocked by policy:', message);
                    toasts.error(message);
                    this.wasKicked = true;
                    this.playbackManager?.destroy();
                    clearVideoSource(this.videoElement ?? null);
                    playerStore.stopProgressReporting();
                    this.progressReporter?.cleanup();
                    // Live TV: show the dedicated overlay instead of the generic
                    // terminal banner (the toast above already carries the reason).
                    // The overlay must carry the POLICY reason — a viewer refused
                    // by their own concurrent-stream limit is not being evicted
                    // by anyone.
                    if (playerStore.isLive) {
                        this.liveTvFailure = {
                            type: 'kicked',
                            blocked: liveTvBlockPresentation(
                                liveTvBlockCauseForPolicy(kind, message),
                            ),
                        };
                        return;
                    }
                    this.pendingTerminalMessage = message;
                    this.reconnect?.trigger('session-expired', { terminal: true });
                },
                onSupersede: () => {
                    // Another tab/device took over. Stop audio immediately so
                    // the user isn't left with two streams playing while they
                    // read the toast — the toast itself is owned by the
                    // reporter (via fireSuperseded()).
                    this.log('Session superseded — auto-pausing');
                    this.videoElement?.pause();
                    // Stop announcing this tab as the active player —
                    // the new tab will take that role. Failing to clear
                    // would leave us responding to probes for a media
                    // we're no longer playing.
                    this.sameBrowserChannel?.clearActive();
                },
                onTranscodeProgress: (progress) => {
                    playerStore.setTranscodeProgress(progress);
                },
                onHeartbeatAck: ({ resume_anchor_epoch_ms, wrote_to_durable }) => {
                    if (
                        resume_anchor_epoch_ms !== null &&
                        Number.isFinite(resume_anchor_epoch_ms)
                    ) {
                        if (
                            this.latestServerAnchor === null ||
                            resume_anchor_epoch_ms > this.latestServerAnchor
                        ) {
                            this.latestServerAnchor = resume_anchor_epoch_ms;
                        }
                    }
                    if (wrote_to_durable) {
                        this.engagementGateOpened = true;
                    }
                },
            });
        }
    }

    setupPowerManagement(): void {
        this.wakeLockCtrl = new WakeLockController({
            getVideoElement: () => this.videoElement,
            isInitialized: () => this.isInitialized,
            reportProgress: () => this.reportProgress('progress'),
            initializeHls: (url, startTime) => this.initializeHls(url, startTime),
            log: (...args: unknown[]) => this.log(...args),
            isAudioOnly: () => playerStore.qualityMode === 'audio-only',
        });
        this.wakeLockCtrl.setup();
    }

    setupEventListeners(): void {
        window.addEventListener('keydown', this.boundHandleKeydown);
        window.addEventListener('keyup', this.boundHandleKeyup);
        window.addEventListener('blur', this.boundHandleWindowBlur);
        document.addEventListener('fullscreenchange', this.boundHandleFullscreenChange);
        this.videoElement?.addEventListener(
            'webkitbeginfullscreen',
            this.boundHandleIOSFullscreenStart,
        );
        this.videoElement?.addEventListener(
            'webkitendfullscreen',
            this.boundHandleIOSFullscreenEnd,
        );
        // Decoded resolution for the stats pill: 'resize' fires whenever the
        // intrinsic size changes (quality switch, ABR level change).
        this.videoElement?.addEventListener('loadedmetadata', this.boundHandleVideoDimensions);
        this.videoElement?.addEventListener('resize', this.boundHandleVideoDimensions);
        window.addEventListener('beforeunload', this.boundHandleBeforeUnload);
        window.addEventListener('pagehide', this.boundHandlePageHide);
    }

    removeEventListeners(): void {
        window.removeEventListener('keydown', this.boundHandleKeydown);
        window.removeEventListener('keyup', this.boundHandleKeyup);
        window.removeEventListener('blur', this.boundHandleWindowBlur);
        document.removeEventListener('fullscreenchange', this.boundHandleFullscreenChange);
        this.videoElement?.removeEventListener(
            'webkitbeginfullscreen',
            this.boundHandleIOSFullscreenStart,
        );
        this.videoElement?.removeEventListener(
            'webkitendfullscreen',
            this.boundHandleIOSFullscreenEnd,
        );
        this.videoElement?.removeEventListener('loadedmetadata', this.boundHandleVideoDimensions);
        this.videoElement?.removeEventListener('resize', this.boundHandleVideoDimensions);
        window.removeEventListener('beforeunload', this.boundHandleBeforeUnload);
        window.removeEventListener('pagehide', this.boundHandlePageHide);
    }

    private async acceptItemNavigation(
        itemId: string,
        title: string,
        mediaType: 'movie' | 'episode' | 'tv',
        fileId: string | undefined,
        broadcast: boolean,
    ): Promise<(() => boolean) | null> {
        const revision = ++this.navigationRequestRevision;
        let ownsParty = () => true;
        if (broadcast) {
            const request =
                fileId === undefined
                    ? watchTogether.broadcastNavigate(itemId, title, mediaType)
                    : watchTogether.broadcastNavigate(itemId, title, mediaType, fileId);
            ownsParty = watchTogether.captureNavigationOwnership();
            if (!(await request)) return null;
        }
        const owns = () => this.navigationRequestRevision === revision && ownsParty();
        return owns() ? owns : null;
    }

    async stopAndCleanup(isCurrent: () => boolean = () => true): Promise<void> {
        if (!isCurrent()) return;

        this.liveTvStartupCleanup?.();
        this.liveTvStartupCleanup = undefined;
        const generation = ++this.playbackGeneration;
        const owns = () => isCurrent() && generation === this.playbackGeneration;
        this.disposeAllSubtitleRenderers();
        clearTimeout(this.liveTvAutoRetryTimer);
        clearTimeout(this.liveTvBudgetResetTimer);
        this.liveTvBudgetResetTimer = undefined;
        this.liveTvQualityAbortController?.abort();
        this.liveTvQualityAbortController = null;
        const wasInitialized = this.isInitialized;
        this.isInitialized = false;

        // Clear stall timer to prevent stale reports against the dead session
        this.watchTogetherCtrl.clearStallTimer();

        if (this.playbackManager) {
            this.playbackManager.destroy();
        }
        clearVideoSource(this.videoElement ?? null);

        const heartbeat = this.liveTvHeartbeat;
        this.liveTvHeartbeat = null;
        this.liveTvSessionId = null;
        this.liveTvFeedId = undefined;
        this.liveTvCurrentFeedId = undefined;
        await heartbeat?.destroy();
        if (!owns()) return;

        // Always send stop if we have an active session — even if playback never
        // started (e.g. infinite buffering). Without this, stale sessions pile up
        // and trigger stream_limit on the next attempt.
        if (wasInitialized || this.progressReporter) {
            // Genuinely user-initiated: the viewer left the player.
            await this.endCurrentSession('user', owns);
            if (!owns()) return;
        }

        // Tear down same-browser channel — no point announcing as active
        // once the player is shutting down. Resolves any in-flight conflict
        // modal as cancelled so callers don't await forever during teardown.
        if (this.pendingTabConflict) {
            this.resolveTabConflict(false);
        }
        this.sameBrowserChannel?.close();
        this.sameBrowserChannel = null;
        // Reset Cancel-gate so a controller that's reused for a fresh
        // playback (e.g. another media item from the same tab) doesn't
        // permanently refuse to start.
        this.userCancelledTabConflict = false;
        this.hasProbedSameBrowser = false;
        this.probeAndModalPromise = null;

        // Reset the reusable ReconnectController too — playerStore.reset() clears
        // the badge flag, but a controller left mid-'recovering' would leak its
        // pending backoff retry into the next item and fire a stale rebuild
        // against the fresh session with no indicator shown.
        this.reconnectDiagnosticEpoch++;
        this.pendingReconnectDiagnostic = null;
        this.reconnect?.reset();
        // A restart queued for the previous item must never run on the next.
        this.restartQueue.reset();

        playerStore.reset();
    }

    handleBeforeUnload(): void {
        if (!this.isInitialized) return;
        // Buffered telemetry is otherwise DROPPED on a reload/tab-close: the
        // 10s auto-flush is the only other delivery path here, so anything
        // recorded since the last tick dies with the page. That biases the
        // record exactly where it hurts — a stuck-recovery incident ends in a
        // manual reload, so its reconnect_event rows were the ones being lost.
        this.telemetryCtrl.flushViaBeacon();
        this.incidentReporter?.onPageHide();
        this.liveTvHeartbeat?.destroyViaBeacon();
        this.liveTvHeartbeat = null;
        this.liveTvSessionId = null;
        this.liveTvFeedId = undefined;
        this.liveTvCurrentFeedId = undefined;
        // PlaySessionReporter is the only IProgressReporter implementation and
        // always exposes updateViaBeacon — no legacy fallback path remains.
        if (this.playbackProbe && this.progressReporter instanceof PlaySessionReporter) {
            const currentTime = this.videoElement?.currentTime ?? 0;
            // Send the required engagement counter so the server can distinguish
            // verified playback from a scrub-and-leave session.
            this.progressReporter.updateViaBeacon({
                position_ms: Math.round(currentTime * 1000),
                status: 'COMPLETED',
                end_reason: 'unload',
                session_elapsed_ms: Math.max(0, Math.round(this.playingMsAccumulator)),
            });
        }
        this.writeResumeCache(true);
    }

    // ============================================================================
    // Lifecycle: mount
    // ============================================================================

    async mount(): Promise<(() => void) | undefined> {
        if (!browser) return undefined;
        const generation = this.playbackGeneration;
        const isCurrent = (): boolean => generation === this.playbackGeneration;
        if (this.props.playbackInfo.isLive) {
            this.liveTvAutoRetryAttempts = readLiveTvRetryBudget(this.props.playbackInfo.itemId);
            this.liveTvStartupHasProgress = false;
            this.armLiveTvStartup();
        }

        // Sync fullscreen state immediately — playerStore.reset() cleared it, but if
        // we transferred native fullscreen to the .watch-page wrapper before navigating,
        // document.fullscreenElement is non-null and we need to reflect that.
        playerStore.setFullscreen(!!document.fullscreenElement);

        this.originalDocumentTitle = document.title;
        initFaviconController();

        this.unbindExternalControl = playerStore.bindExternalControl({
            isReady: () => this.isInitialized,
            seekTo: (seconds) => this.seekTo(seconds, false, 'seek_absolute'),
            sessionId: () =>
                this.progressReporter instanceof PlaySessionReporter
                    ? this.progressReporter.getSessionId()
                    : null,
        });

        this.setupResizeObserver();

        let asyncCleanupFn: (() => void) | undefined;

        const asyncInit = async () => {
            // Fresh attemptId + incident buffer/reporter for THIS playback
            // attempt — deliberately not rebuilt on reconnect (attemptId is
            // the stable correlation key across play_session_id renewal; see
            // playerStore.attemptId's doc comment).
            playerStore.generateNewAttemptId();
            this.incidentBuffer = new IncidentRingBuffer({
                maxEntries: PLAYBACK_INCIDENT_BUFFER_MAX_ENTRIES,
                maxAgeMs: PLAYBACK_INCIDENT_BUFFER_MAX_AGE_MS,
            });
            this.incidentReporter = new IncidentReporter({
                attemptId: playerStore.attemptId,
                buffer: this.incidentBuffer,
                deviceId: getDeviceId(),
                // The internal DB id (as every other mediaId send here) — itemId can
                // be an external id, which the reporter would drop as non-UUID.
                mediaId: () => this.currentMediaDbId,
                // A getter, not a snapshot: playMethod changes mid-session
                // (a direct-play attempt falling back to transcode is exactly
                // the case an incident needs to describe accurately).
                clientInfo: () => ({
                    userAgent: navigator.userAgent,
                    playMethod: playerStore.playMethod,
                    // State at the moment the incident is sent (the trigger).
                    media: this.getMediaSnapshot(),
                }),
                post: (body) =>
                    reportPlaybackIncident(body as PlaybackIncidentReportInput)
                        .then(() => undefined)
                        .catch(() => {
                            /* best-effort — never let a reporting failure affect playback */
                        }),
                patchResolve: (body) =>
                    resolvePlaybackIncident(body)
                        .then(() => undefined)
                        .catch(() => {
                            /* best-effort */
                        }),
                beacon: (body) => {
                    navigator.sendBeacon(
                        apiUrl('internal', '/diagnostics/events'),
                        new Blob(
                            [
                                JSON.stringify({
                                    events: [
                                        playbackIncidentEvent(body as PlaybackIncidentReportInput),
                                    ],
                                }),
                            ],
                            { type: 'application/json' },
                        ),
                    );
                },
            });

            await this.setupSubtitleAndProgressReporter();
            if (!isCurrent()) return;
            this.setupPowerManagement();

            if (this.props.initialSourceId) {
                const sourceExists = this.props.playbackInfo.mediaSources.some(
                    (s) => s.id === this.props.initialSourceId,
                );
                if (sourceExists) {
                    this.log(
                        ' Setting initial source from URL (early):',
                        this.props.initialSourceId,
                    );
                    playerStore.setMediaSource(this.props.initialSourceId);
                }
            }

            const caps = await detectCapabilities();
            if (!isCurrent()) return;
            this.caps = caps;
            await ensurePathScopedCapabilities();
            if (!isCurrent()) return;

            this.log(' Browser capabilities:', {
                h264: this.caps.h264.supported,
                h265: this.caps.h265.supported,
                vp9: this.caps.vp9.supported,
                av1: this.caps.av1.supported,
                hdr10: this.caps.hdr10.supported,
                dolbyVision: this.caps.dolbyVision.supported,
                hdrDisplay: this.caps.hdrDisplay,
            });

            const autoQualityAllowed = this.props.autoQualityEnabled ?? true;
            const effectiveDefaultMode = autoQualityAllowed
                ? (this.props.defaultQualityMode ?? 'original')
                : 'original';
            playerStore.loadSavedQualityPreference(effectiveDefaultMode, autoQualityAllowed);

            this.log(' Lumastra: preparing local playback info');

            await initializePreferences();
            if (!isCurrent()) return;

            // Restore audio before any source can autoplay. A late restore can
            // otherwise undo the browser's muted fallback or a user's control.
            if (this.videoElement) {
                try {
                    // Read from dedicated volume key (most reliable) then fall back to preferences
                    const raw = localStorage.getItem('playerVolume');
                    const volData = raw ? JSON.parse(raw) : null;
                    const prefs = getPreferences();
                    const vol = volData?.volume ?? prefs.volume ?? 1;
                    const muted = startupMuted(
                        volData?.muted ?? prefs.isMuted ?? false,
                        this.isIOS,
                    );
                    this.videoElement.volume = vol;
                    this.videoElement.muted = muted;
                    playerStore.setVolume(vol);
                    playerStore.isMuted = muted;
                } catch {
                    // Preferences may be unavailable
                }
            }

            playerStore.loadSavedTrackPreferences();
            this.logSub('Loaded track preferences', {
                prefs: playerStore.getState().currentSubtitleTrackIndex,
                forcedEnabled: playerStore.getState().forcedSubtitlesEnabled,
            });

            // Restore membership before choosing or loading a stream. Otherwise
            // saved episode progress can start an outro countdown and navigate
            // the party before setupInMount restores its canonical position.
            const rejoinedWatchParty =
                !this.props.playbackInfo.isLive &&
                (await watchTogether.tryRejoinFromStorage(this.props.userId, {
                    connect: false,
                    isCurrent,
                }));
            if (!isCurrent()) return;
            if (
                rejoinedWatchParty &&
                watchTogether.session?.itemId &&
                watchTogether.session.itemId !== this.currentPlaybackInfo.itemId
            ) {
                const reconciled = await this.watchTogetherCtrl.reconcileRestoredItem();
                if (!isCurrent()) return;
                if (!reconciled) {
                    if (watchTogether.isHost) {
                        playerStore.setError(
                            watchTogether.error ?? m.playback_refusal_unavailable(),
                        );
                    }
                    return;
                }
            }

            await tick();
            if (!isCurrent()) return;

            // Seed the server anchor from playbackInfo (synchronously available)
            // before the resume-selection ladder runs. playbackProbe resolves later.
            this.latestServerAnchor = this.currentPlaybackInfo.resumeAnchor ?? null;

            // Defensive clear: if another device marked this as watched, scrub the stale cache
            if (this.currentPlaybackInfo.isWatched) {
                const id = this.getCacheIdentity();
                if (id) clearResumeEntry(id.username, id.uuid);
            }

            let resumePositionSeconds: number;

            const watchPartySession =
                watchTogether.isInWatchParty || this.mightBeInWatchParty()
                    ? watchTogether.getSessionState()
                    : null;

            if (watchPartySession) {
                resumePositionSeconds = watchPartySession.currentTime;
                this.log(' Using watch party session position:', resumePositionSeconds);
            } else if (
                this.props.initialStartTime !== undefined &&
                this.props.initialStartTime > 0
            ) {
                resumePositionSeconds = this.props.initialStartTime;
                this.log(
                    ' Using URL start time parameter (preview handoff):',
                    resumePositionSeconds,
                );
            } else {
                // Compute server-side resume in ms (playbackInfo ticks are in 100ns units).
                const playbackInfoTicks =
                    this.currentPlaybackInfo.userData?.playbackPositionTicks ?? 0;
                const playbackInfoMs = playbackInfoTicks > 0 ? playbackInfoTicks / 10_000 : 0;
                // playbackProbe isn't fetched until later in mount(); playbackInfo carries
                // the same resolved position via the server-side resolveEffectiveResume call.
                const serverPositionMs = playbackInfoMs;

                // Cache override — resolve localStorage vs server position.
                const id = this.getCacheIdentity();
                const cached = id ? getResumeEntry(id.username, id.uuid) : null;

                const resolvedMs = resolveResumePosition({
                    serverPositionMs,
                    serverAnchor: this.currentPlaybackInfo.resumeAnchor ?? null,
                    isWatched: this.currentPlaybackInfo.isWatched ?? false,
                    cached,
                });

                resumePositionSeconds = resolvedMs / 1000;
                this.log(' Resolved resume position (ms → s):', {
                    serverPositionMs,
                    episodeSegmentStartMs: this.currentPlaybackInfo.episodeSegment?.startMs ?? null,
                    cachedPositionMs: cached?.positionMs ?? null,
                    resolvedMs,
                    resumePositionSeconds,
                });
            }

            // A combined file (S02E24E25) is ONE video holding both episodes back to
            // back — the timeline stays the whole file and you can scrub straight
            // from one episode into the next. What the episode's window gives us is
            // where to COME IN: opening episode 25 must land on its first frame
            // instead of starting the file at 0 and replaying episode 24.
            //
            // Only when there is nothing better to honour. A real resume position,
            // a preview handoff or a watch-party position all describe where the
            // viewer actually is and must win — including a resume that sits inside
            // an earlier episode of the same file.
            const entrySegment = this.currentPlaybackInfo.episodeSegment;
            if (!watchPartySession && entrySegment && resumePositionSeconds <= 0) {
                resumePositionSeconds = entrySegment.startMs / 1000;
                this.log(' Combined file: entering at this episode’s start', {
                    entrySeconds: resumePositionSeconds,
                });
            }

            if (this.currentPlaybackInfo.isLive) {
                const liveSource = this.currentPlaybackInfo.mediaSources?.[0];
                if (!liveSource) {
                    playerStore.setError('Live TV stream URL not available');
                    return;
                }
                playerStore.updateCurrentMediaSource(liveSource);
                const negotiated = await this.negotiateLiveTvStream(getLiveTvQualityPreference());
                if (!isCurrent()) return;
                if (!negotiated) return;
                const { result, applied } = negotiated;
                if (!result.ok) {
                    this.handleLiveTvNegotiationFailure(result);
                    playerStore.setLoading(false);
                    return;
                }
                this.applyLiveTvStreamInfo(result.streamInfo.delivery, applied);
                this.log(' LiveTV:', { url: result.streamInfo.delivery.url });
                await this.initializeHls(result.streamInfo.delivery.url, 0);
                if (!isCurrent()) return;
            } else {
                if (!this.props.mediaDbId) {
                    toasts.error('Playback requires a media database ID');
                    return;
                }
                const info = await this.fetchPlaybackProbe(
                    this.props.mediaDbId,
                    this.props.initialSourceId,
                );
                if (!isCurrent()) return;
                this.setPlaybackProbe(info);
                if (!this.playbackProbe) {
                    // fetchPlaybackProbe already surfaced the specific reason via
                    // toast; the player itself must also leave the loading state
                    // so the user doesn't see an endless spinner. Common cause:
                    // the catalog row has no media files (has_files=false) →
                    // playability probe responds 404 "No file versions available".
                    playerStore.setError(this.lastProbeRefusal ?? m.playback_refusal_unavailable());
                    return;
                }
                // Check if playback is actually possible before setting up player state
                if (!this.playbackProbe.activeVersion.playable) {
                    playerStore.setError(PLAYER_ERRORS.TRANSCODING_UNAVAILABLE);
                    return;
                }

                // Populate version picker for multi-version items
                this.syncProbeVersionsToStore(this.playbackProbe);

                this.updateProbedSource(this.playbackProbe, this.props.mediaDbId);

                // Apply the server's resolved starting tracks now that the media
                // source has actual track data. The earlier loadSavedTrackPreferences()
                // call ran before playability probe was fetched (mediaSources was empty).
                // Falls back to local resolution when the server expressed no
                // opinion (recommended absent) — see applyTrackRecommendation.
                playerStore.applyTrackRecommendation(probeTrackRecommendation(this.playbackProbe));

                const resolvedMethod = this.resolveAvailableLumastraMethod(this.playbackProbe);
                if (!resolvedMethod) {
                    playerStore.setError(PLAYER_ERRORS.TRANSCODING_UNAVAILABLE);
                    return;
                }

                if (
                    this.playbackProbe.activeVersion.durationMs &&
                    this.playbackProbe.activeVersion.durationMs > 0
                ) {
                    playerStore.setDuration(this.playbackProbe.activeVersion.durationMs / 1000);
                }

                this.refreshTimeline(this.playbackProbe);

                this.setLumastraPlayMethod(resolvedMethod);
                // The probe can outlive a party seek or rejoin.
                const latestPartyState = watchTogether.getSessionState();
                const explicitPosition =
                    this.props.initialStartTime !== undefined || !!latestPartyState;
                if (latestPartyState) {
                    resumePositionSeconds = latestPartyState.currentTime;
                } else if (!explicitPosition) {
                    const identity = this.getCacheIdentity();
                    if (identity && this.playbackProbe.isWatched)
                        clearResumeEntry(identity.username, identity.uuid);
                    resumePositionSeconds =
                        resolveResumePosition({
                            serverPositionMs: this.playbackProbe.resumePositionMs,
                            serverAnchor: this.currentPlaybackInfo.resumeAnchor ?? null,
                            isWatched: this.playbackProbe.isWatched,
                            cached:
                                identity && !this.playbackProbe.isWatched
                                    ? getResumeEntry(identity.username, identity.uuid)
                                    : null,
                        }) / 1000;
                    if (entrySegment && resumePositionSeconds <= 0)
                        resumePositionSeconds = entrySegment.startMs / 1000;
                }
                const requestedPosition = clampStartToPlayable(
                    resumePositionSeconds,
                    (this.playbackProbe.activeVersion.durationMs ?? 0) / 1000,
                );
                const lumastraStreamUrl = await this.buildLumastraPlaybackUrl(
                    this.playbackProbe,
                    resolvedMethod,
                    explicitPosition || requestedPosition > 0 || resumePositionSeconds > 0
                        ? requestedPosition
                        : undefined,
                );
                if (!isCurrent()) return;
                this.setLumastraHdrInfo(this.playbackProbe);
                const lumastraResumeSeconds =
                    (this.playbackStart && 'startPositionMs' in this.playbackStart.delivery
                        ? this.playbackStart.delivery.startPositionMs
                        : 0) / 1000;

                this.log(' Lumastra playback:', {
                    method: this.lumastraPlayMethod,
                    resumeSeconds: lumastraResumeSeconds,
                    url: lumastraStreamUrl.substring(0, 60) + '...',
                });

                playerStore.setCurrentTime(lumastraResumeSeconds);
                this.startupPositionResolved = true;

                if (this.lumastraPlayMethod === 'direct') {
                    this.initializeDirectPlay(lumastraStreamUrl, lumastraResumeSeconds);
                } else {
                    await this.initializeHls(lumastraStreamUrl, lumastraResumeSeconds, true);
                    if (!isCurrent()) return;
                }

                if (this.lumastraProgressIntervalRef) {
                    clearInterval(this.lumastraProgressIntervalRef);
                    this.lumastraProgressIntervalRef = null;
                }
            }

            if (this.props.playlistContext && !this.currentPlaybackInfo.playlistContext) {
                try {
                    const { data: ctxData, error: ctxErr } = await getPlaybackContext(
                        this.props.playlistContext.playlistId,
                        { position: this.props.playlistContext.position },
                    );
                    if (!isCurrent()) return;
                    if (!ctxErr && ctxData) {
                        const playlistContext = {
                            playlistId: ctxData.playlist.id,
                            playlistName: ctxData.playlist.name,
                            currentPosition: ctxData.current.position,
                            totalItems: ctxData.playlist.totalItems,
                        };
                        const entry = ctxData.next;
                        const nextItem: PlaybackInfo['nextPlaylistItem'] =
                            entry &&
                            (entry.mediaType === 'movie' ||
                                entry.mediaType === 'series' ||
                                entry.mediaType === 'episode')
                                ? {
                                      itemId: entry.mediaId,
                                      internalId: entry.mediaId,
                                      playlistId: ctxData.playlist.id,
                                      position: entry.position,
                                      title: entry.title,
                                      seriesName: entry.seriesName,
                                      seasonNumber: entry.seasonNumber,
                                      episodeNumber: entry.episodeNumber,
                                      mediaType: entry.mediaType,
                                      hasPrimaryImage: !!entry.posterPath,
                                  }
                                : undefined;
                        this.currentPlaybackInfo = {
                            ...this.currentPlaybackInfo,
                            playlistContext: playlistContext,
                            nextPlaylistItem: nextItem,
                        };
                        playerStore.setPlaylistContext(playlistContext, nextItem);
                    }
                } catch (err) {
                    console.warn('[Player] Failed to fetch playlist context:', err);
                }
            }

            if (!isCurrent()) return;
            this.loadSubtitles();

            this.setupEventListeners();

            this.setupMediaSession();

            this.setupAirPlayListeners();

            asyncCleanupFn =
                (await this.watchTogetherCtrl.setupInMount(
                    this.props.userId,
                    this.props.playbackInfo.isLive,
                )) ?? undefined;
            if (!isCurrent()) {
                asyncCleanupFn?.();
                asyncCleanupFn = undefined;
            }
        };

        await asyncInit();

        return () => {
            asyncCleanupFn?.();
        };
    }

    // ============================================================================
    // Lifecycle: destroy
    // ============================================================================

    destroy(): void {
        this.navigationRequestRevision += 1;
        const heartbeat = this.liveTvHeartbeat;
        this.liveTvHeartbeat = null;
        this.liveTvSessionId = null;
        this.liveTvFeedId = undefined;
        this.liveTvCurrentFeedId = undefined;
        void heartbeat?.destroy();
        this.liveTvStartupCleanup?.();
        this.liveTvStartupCleanup = undefined;
        this.unbindExternalControl?.();
        this.unbindExternalControl = null;
        this.playbackGeneration += 1;
        clearTimeout(this.liveTvAutoRetryTimer);
        clearTimeout(this.liveTvBudgetResetTimer);
        this.liveTvBudgetResetTimer = undefined;
        this.liveTvQualityAbortController?.abort();
        this.liveTvQualityAbortController = null;
        playerStore.stopProgressReporting();

        // Tear down any armed post-switch recovery ('playing' listener + 15s
        // timer) so it can't retain this destroyed controller via closure.
        this.clearPostSwitchRecovery();

        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }

        this.mediaSessionCtrl.clear();

        this.clearStallTimer();

        this.reconnectDiagnosticEpoch++;
        this.pendingReconnectDiagnostic = null;
        this.reconnect?.destroy();
        this.reconnect = null;
        if (this.reconnectVisibilityHandler && browser) {
            document.removeEventListener('visibilitychange', this.reconnectVisibilityHandler);
            this.reconnectVisibilityHandler = null;
        }

        this.clearSeekBufferingTimer();

        // Clear pending subtitle verification timeouts
        for (const timeoutId of this.pendingShowTimeouts) {
            clearTimeout(timeoutId);
        }
        this.pendingShowTimeouts.clear();

        this.clearSkipAnimationTimer();
        this.osdIndicators.destroy();

        this.wakeLockCtrl?.destroy();
        if (this.cleanupPositionRestore) {
            this.cleanupPositionRestore();
            this.cleanupPositionRestore = null;
        }

        this.airplayListenerCleanup?.();
        this.airplayListenerCleanup = null;

        if (this.autoplayTutorialTimer) {
            clearTimeout(this.autoplayTutorialTimer);
            this.autoplayTutorialTimer = null;
        }

        this.watchPartyPanelOpen = false;

        if (browser) {
            updatePreferences({
                volume: playerStore.volume,
                isMuted: playerStore.isMuted,
            });
            this.removeEventListeners();

            this.stopAcceleratingSeek();

            stopPlayingAnimation();
            if (this.originalDocumentTitle) {
                restoreOriginalTitle(this.originalDocumentTitle);
            }

            watchTogether.disconnect();

            // Send stop event if we have an active session — even when
            // isInitialized is false (playback never started, e.g. infinite
            // buffering). Prevents stale sessions from blocking future streams.
            if (
                (this.isInitialized || this.progressReporter) &&
                this.playbackProbe &&
                this.progressReporter instanceof PlaySessionReporter
            ) {
                const currentMs = Math.round((this.videoElement?.currentTime ?? 0) * 1000);
                this.progressReporter.updateViaBeacon({
                    position_ms: currentMs,
                    status: 'COMPLETED',
                    end_reason: this.isInitialized ? 'unload' : 'error',
                    session_elapsed_ms: Math.max(0, Math.round(this.playingMsAccumulator)),
                });
            }
        }

        if (this.lumastraProgressIntervalRef) {
            clearInterval(this.lumastraProgressIntervalRef);
            this.lumastraProgressIntervalRef = null;
        }

        this.cleanupEngagementTicker();

        this.destroyTelemetryViaBeacon();

        if (this.playbackManager) {
            this.playbackManager.destroy();
            this.playbackManager = null;
        }

        this.disposeAllSubtitleRenderers();

        // Clean up injected subtitle CSS from <head>
        if (browser) {
            document.getElementById('subtitle-dynamic-styles')?.remove();
        }

        // Clean up subtitle timers
        if (this.postSeekSubtitleTimer) {
            clearTimeout(this.postSeekSubtitleTimer);
            this.postSeekSubtitleTimer = null;
        }

        this.watchTogetherCtrl.dispose();

        this.progressReporter?.cleanup();

        if (browser) {
            // Deferred until the router is idle: this teardown normally runs
            // from inside the {#key itemId} remount of an in-flight goto()
            // (next episode, or leaving the player), and invalidating there
            // aborts that navigation and strands the global loading bar.
            // See invalidateWhenIdle().
            invalidateWhenIdle('app:watch-state');
        }

        playerStore.reset();
    }

    // ============================================================================
    // Effects
    // ============================================================================

    initEffects(): void {
        // currentPlaybackInfo is an overridable $derived — no sync effect needed.
        // It derives from this.props.playbackInfo and resets when the prop changes,
        // but can be temporarily overridden (e.g., when merging playlist context).

        // Initialize playerStore from props (guarded by storeInitialized flag)
        $effect(() => {
            if (browser && !this.storeInitialized) {
                playerStore.initialize(
                    this.props.playbackInfo,
                    this.props.nextEpisodePromptLeadSeconds ?? 0,
                );
                this.storeInitialized = true;
            }
        });

        // Recompute playback intent when watch-party membership or live status
        // changes. Without this, joining a watch party (or a stream becoming
        // live) while playing leaves `intendedPlaying` stale-true, and the
        // stall watchdog could fire a spurious reconnect on a sync-owned/live
        // session.
        $effect(() => {
            // Read the reactive deps so the effect re-runs on their change.
            void watchTogether.isInWatchParty;
            void playerStore.isLive;
            this.updatePlaybackIntent();
        });

        // Auto-open playlist browser
        $effect(() => {
            if (
                playerStore.isPlaylistMode &&
                playerStore.playlistContext &&
                !this.playlistBrowserAutoOpened
            ) {
                this.playlistBrowserAutoOpened = true;
                this.showPlaylistBrowser = true;
                console.log('[Player] Auto-opened playlist browser');
            }
        });

        // Quality profile change -> restart stream
        // NOTE: Read reactive state BEFORE conditionals to ensure Svelte 5 tracks the dependency.
        // Short-circuit evaluation (&&) would skip the reactive read if isInitialized is false,
        // preventing the $effect from ever re-running when the quality changes.
        $effect(() => {
            const qualityMode = playerStore.qualityMode;
            const currentProfile = playerStore.currentQualityProfile;
            const qualityRestartKey = this.buildQualityRestartKey(qualityMode, currentProfile);
            if (browser && this.isInitialized && qualityRestartKey !== this.lastQualityRestartKey) {
                this.log(' Quality profile changed, restarting stream...');
                this.lastQualityRestartKey = qualityRestartKey;
                this.restartStreamWithNewQuality();
            }
        });

        // Audio track change -> handle track switch
        // Coalesce rapid switches: record the latest desired track and kick the
        // applier. If a restart is already in flight (from this switch or any
        // other source), finishRestart() will drain the pending index.
        $effect(() => {
            const currentAudioIndex = playerStore.currentAudioTrackIndex;
            const revision = playerStore.audioSelectionRevision;
            const retry =
                revision !== this.lastAudioSwitchRevision &&
                (this.audioSwitchInFlight ||
                    (this.failedAudioSwitch?.index === currentAudioIndex &&
                        this.failedAudioSwitch.sourceId === playerStore.currentMediaSource?.id));
            if (
                browser &&
                this.isInitialized &&
                (currentAudioIndex !== this.lastAudioTrackIndex || retry)
            ) {
                this.requestAudioSwitch(currentAudioIndex);
            }
        });

        // Favicon/title update
        $effect(() => {
            const isPlaying = playerStore.isPlaying && !playerStore.isPaused;
            const title = playerStore.fullTitle || this.props.playbackInfo.title;
            if (browser && this.isInitialized) {
                setPlaybackState(isPlaying, title);
            }
        });

        // Subtitle burn-in toggle -> restart stream with ffmpeg subtitle overlay
        $effect(() => {
            const burnIn = playerStore.forceSubtitleBurnIn;
            if (browser && this.isInitialized) {
                if (burnIn !== this.lastBurnInState) {
                    this.log(
                        ` Subtitle burn-in ${burnIn ? 'enabled' : 'disabled'}, restarting stream...`,
                    );
                    this.lastBurnInState = burnIn;
                    this.restartStreamWithNewQuality();
                }
            }
        });

        // Follow the video element's lifetime, including element replacement.
        // Event callbacks read the latest selection, rather than capturing the
        // initial Off/track value while the stream is still loading.
        $effect(() => {
            const video = this.videoElement;
            if (browser && video) return this.observeNativeSubtitleSelection(video);
        });

        // Subtitle track change handling
        $effect(() => {
            const _subIdx = playerStore.currentSubtitleTrackIndex;
            const subtitleRevision = playerStore.subtitleSelectionRevision;
            if (browser && this.videoElement && _subIdx !== undefined) {
                const currentIndex = _subIdx;
                const nativeFailure = this.nativeSubtitleFailure;
                if (
                    nativeFailure &&
                    nativeFailure.index === currentIndex &&
                    nativeFailure.sourceId === playerStore.currentMediaSource?.id &&
                    nativeFailure.revision !== subtitleRevision
                ) {
                    this.nativeSubtitleFailure = null;
                    this.loadSubtitles();
                    this.previousSubtitleIndex = currentIndex;
                    return;
                }
                // The active video owns its encoded overlay, even when the desired
                // selection is Off or awaiting a client raw resource. Restarts queue.
                if (this.reconcileBurnedSubtitleSelection()) return;
                if (this.activeBurnedSubtitleId()) {
                    this.disposeAllSubtitleRenderers();
                    this.updateSubtitleDisplay();
                    this.previousSubtitleIndex = currentIndex;
                    return;
                }
                const failure = this.subtitleInitializationFailure;
                const rawHref = playerStore.subtitleTracks.find(
                    (track) => track.index === currentIndex,
                )?.hrefs?.raw;
                const renewedAfterFailure =
                    failure?.index === currentIndex &&
                    failure.sourceId === playerStore.currentMediaSource?.id &&
                    rawHref &&
                    rawHref !== failure.href;

                const retryRequested =
                    failure?.index === currentIndex &&
                    failure.sourceId === playerStore.currentMediaSource?.id &&
                    failure.revision !== subtitleRevision;
                if (
                    currentIndex !== this.previousSubtitleIndex ||
                    renewedAfterFailure ||
                    retryRequested
                ) {
                    const currentFlags = this.getSubtitleTypeFlags(currentIndex);
                    const previousFlags = this.getSubtitleTypeFlags(this.previousSubtitleIndex);
                    const currentIsClientRendered =
                        currentFlags.isPgs || currentFlags.isAss || currentFlags.isVobsub;
                    const previousIsClientRendered =
                        previousFlags.isPgs || previousFlags.isAss || previousFlags.isVobsub;

                    const currentTrack =
                        currentIndex !== null
                            ? playerStore.subtitleTracks.find((t) => t.index === currentIndex)
                            : null;
                    // Probe metadata arrives before start issues the raw resource.
                    // Keep the selection pending and track delivery reactively so the
                    // same index initializes as soon as its resource is available.
                    if (currentIsClientRendered && !currentTrack?.hrefs?.raw) {
                        if (this.previousSubtitleIndex !== null) {
                            this.disposeAllSubtitleRenderers();
                            this.updateSubtitleDisplay();
                            this.previousSubtitleIndex = null;
                        }
                        // A server overlay must be removed before delivery for a
                        // client-rendered selection can become available.
                        if (playerStore.forceSubtitleBurnIn) {
                            playerStore.setForceSubtitleBurnIn(false);
                        }
                        return;
                    }

                    const previousTrack =
                        this.previousSubtitleIndex !== null
                            ? playerStore.subtitleTracks.find(
                                  (t) => t.index === this.previousSubtitleIndex,
                              )
                            : null;

                    this.logSub('=== SUBTITLE TRACK CHANGE ===', {
                        previousIndex: this.previousSubtitleIndex,
                        previousTitle: previousTrack?.displayTitle ?? 'OFF',
                        previousCodec: previousTrack?.codec ?? 'N/A',
                        currentIndex,
                        currentTitle: currentTrack?.displayTitle ?? 'OFF',
                        currentCodec: currentTrack?.codec ?? 'N/A',
                        previousFlags,
                        currentFlags,
                        previousIsClientRendered,
                        currentIsClientRendered,
                    });

                    this.log(' Subtitle track changed:', {
                        previousIndex: this.previousSubtitleIndex,
                        currentIndex,
                        previousFlags,
                        currentFlags,
                    });

                    if (currentIsClientRendered && currentIndex !== null) {
                        this.disposeAllSubtitleRenderers();
                        this.initSpecialSubtitleRenderer(currentIndex);
                        this.updateSubtitleDisplay();
                    } else if (previousIsClientRendered && !currentIsClientRendered) {
                        this.disposeAllSubtitleRenderers();
                        this.updateSubtitleDisplay();
                    } else {
                        this.updateSubtitleDisplay();
                    }

                    const previousBurnInCheck = this.subtitleRequiresBurnIn(
                        this.previousSubtitleIndex,
                    );
                    const currentBurnInCheck = this.subtitleRequiresBurnIn(currentIndex);
                    const previousNeedsBurnIn = previousBurnInCheck && !previousIsClientRendered;
                    const currentNeedsBurnIn = currentBurnInCheck && !currentIsClientRendered;

                    this.log(' Burn-in analysis:', {
                        previousIndex: this.previousSubtitleIndex,
                        currentIndex,
                        previousBurnInCheck,
                        currentBurnInCheck,
                        previousNeedsBurnIn,
                        currentNeedsBurnIn,
                        willRestart:
                            this.previousSubtitleIndex !== null &&
                            previousNeedsBurnIn !== currentNeedsBurnIn,
                        hlsAudioTrack: this.playbackManager?.getAudioTracks()?.length,
                        playMethod: playerStore.playMethod,
                    });

                    // Auto-enable/disable burn-in for subtitle codecs without a
                    // client-side renderer (DVBSub, XSUB).
                    // When burn-in state changes, the burn-in $effect handles the restart.
                    // We only restart HERE when burn-in stays active but the track index
                    // changed (different subtitle stream to burn in).
                    if (
                        currentNeedsBurnIn &&
                        !this.activeBurnedSubtitleId() &&
                        !playerStore.forceSubtitleBurnIn
                    ) {
                        this.log(' Auto-enabling burn-in for burn-in-only subtitle');
                        playerStore.setForceSubtitleBurnIn(true);
                        // burn-in $effect will restart the stream
                    } else if (
                        !currentNeedsBurnIn &&
                        !currentBurnInCheck &&
                        playerStore.forceSubtitleBurnIn
                    ) {
                        // Only auto-disable when switching to a non-bitmap subtitle or off
                        this.log(' Auto-disabling burn-in (no longer needed)');
                        playerStore.setForceSubtitleBurnIn(false);
                        // burn-in $effect will restart the stream
                    } else if (
                        this.previousSubtitleIndex !== null &&
                        previousNeedsBurnIn &&
                        currentNeedsBurnIn
                    ) {
                        // Burn-in state unchanged but track changed — restart to re-encode
                        // with the new subtitle stream index
                        this.log(' Burn-in subtitle track changed, restarting stream:', {
                            previousIndex: this.previousSubtitleIndex,
                            currentIndex,
                        });
                        this.restartStreamWithNewQuality();
                    }

                    if (
                        this.isInitialized &&
                        !playerStore.isLive &&
                        this.progressReporter instanceof PlaySessionReporter &&
                        !this.isRestartingPlayback &&
                        !previousNeedsBurnIn &&
                        !currentNeedsBurnIn
                    ) {
                        void this.reportProgress('progress');
                    }

                    this.previousSubtitleIndex = currentIndex;
                }
            }
        });

        // Mute sync to video element
        $effect(() => {
            if (browser && this.videoElement) {
                this.videoElement.muted = playerStore.isMuted;
            }
        });

        // Playback rate sync to video element
        $effect(() => {
            if (
                browser &&
                this.videoElement &&
                playerStore.playbackRate &&
                playerStore.playbackRate !== this.lastAppliedPlaybackRate
            ) {
                this.lastAppliedPlaybackRate = playerStore.playbackRate;
                this.videoElement.playbackRate = playerStore.playbackRate;
            }
        });

        // Media source change -> restart playback
        $effect(() => {
            const currentMediaSourceId = playerStore.currentMediaSource?.id;
            if (browser && this.isInitialized && currentMediaSourceId) {
                const currentSourceId = currentMediaSourceId;
                if (this.lastMediaSourceId !== null && this.lastMediaSourceId !== currentSourceId) {
                    this.log(' Media source changed, restarting playback', {
                        from: this.lastMediaSourceId,
                        to: currentSourceId,
                    });
                    this.restartPlayback();
                }
                this.lastMediaSourceId = currentSourceId;
            }
        });

        // Resize observer on video element
        $effect(() => {
            if (this.videoElement && this.resizeObserver) {
                this.resizeObserver.observe(this.videoElement);
                const h = this.videoElement.clientHeight || this.videoElement.offsetHeight;
                if (h > 0) this.videoHeight = h;
            }
        });

        // subtitleStyle is $derived from playbackPreferences — no sync effect needed.

        // Subtitle position reapply — also fires on orientation change via effectiveSubtitleLineY
        $effect(() => {
            if (
                browser &&
                this.videoElement &&
                this.effectiveSubtitleLineY !== this.lastAppliedPositionY
            ) {
                this.lastAppliedPositionY = this.effectiveSubtitleLineY;
                const tracks = this.videoElement.textTracks;
                if (tracks) {
                    for (let i = 0; i < tracks.length; i++) {
                        const track = tracks[i];
                        if (track.mode === 'showing') {
                            // Bulk re-position all loaded cues for immediate
                            // feedback when the user drags the Position slider.
                            // Per-cue positioning of future/late cues is handled
                            // by the reposition cuechange handler installed in
                            // showTrackWithVerification (attachRepositionHandler).
                            if (track.cues) {
                                for (let j = 0; j < track.cues.length; j++) {
                                    const cue = track.cues[j] as VTTCue;
                                    cue.snapToLines = false;
                                    cue.line = this.effectiveSubtitleLineY;
                                }
                            }
                        }
                    }
                }
            }
        });

        // Re-apply subtitle rendering when the viewport flips between portrait
        // and landscape: useSubtitleOverlay changes which path renders (native
        // ::cue vs the custom overlay), so the track modes / cue handler must be
        // recomputed. (Constant for Safari, so this only fires on mobile rotate.)
        $effect(() => {
            const overlay = this.useSubtitleOverlay;
            if (browser && this.videoElement && overlay !== this.lastAppliedOverlayMode) {
                this.lastAppliedOverlayMode = overlay;
                // Invalidate the cached position so the position effect, when it
                // next runs (on mobile, effectiveSubtitleLineY changes on rotate),
                // re-attaches the native reposition cuechange handler to a track
                // returning to the 'showing' path, replacing any stale overlay
                // handler. Current cues are repositioned synchronously by
                // updateSubtitleDisplay -> positionSubtitlesAboveControls.
                this.lastAppliedPositionY = null;
                this.updateSubtitleDisplay();
            }
        });

        // Subtitle CSS injection
        $effect(() => {
            if (browser && this.subtitleCueCSS && this.subtitleCueCSS !== this.lastInjectedCSS) {
                this.lastInjectedCSS = this.subtitleCueCSS;
                let styleEl = document.getElementById('subtitle-dynamic-styles');
                if (!styleEl) {
                    styleEl = document.createElement('style');
                    styleEl.id = 'subtitle-dynamic-styles';
                    document.head.appendChild(styleEl);
                }
                styleEl.textContent = this.subtitleCueCSS;
            }
        });

        // Special subtitle renderer style application
        $effect(() => {
            // Read the style BEFORE the renderer check: `subtitleRenderer` is a plain
            // field that is still null when this effect first runs (it is created in
            // async setup), so short-circuiting on it would leave the effect with no
            // reactive dependencies and live size/position changes would never apply.
            const style = this.subtitleStyle;
            if (browser && style && this.subtitleRenderer) {
                const styleKey = `${style.fontSize}-${style.positionY}-${style.textColor}-${style.outlineWidth}-${style.shadowBlur}`;
                if (
                    styleKey !== this.lastAppliedStyle &&
                    this.subtitleRenderer.hasActiveSpecialRenderer()
                ) {
                    this.lastAppliedStyle = styleKey;
                    this.subtitleRenderer.applyStyle({
                        fontSize: style.fontSize,
                        positionY: style.positionY,
                        textColor: style.textColor,
                        outlineColor: style.outlineColor,
                        outlineWidth: style.outlineWidth,
                        shadowBlur: style.shadowBlur,
                        backgroundColor: style.backgroundColor,
                    });
                }
            }
        });
    }
}
