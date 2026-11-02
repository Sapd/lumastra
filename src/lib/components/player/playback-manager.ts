// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Playback Manager
 *
 * Handles the heavy lifting for stream initialization, HLS management,
 * error recovery, and quality switching. Decouples playback logic from
 * the VideoPlayer component.
 */
import type Hls from 'hls.js';
import type {
    ErrorData,
    MediaPlaylist,
    LoaderStats,
    FragLoadingData,
    LevelLoadedData,
} from 'hls.js';
import {
    buildHlsConfig,
    MAX_RECOVERY_ATTEMPTS,
    isTranscodingNotReadyError,
    type HlsVodBufferSettings,
} from './hls-config';
import { formatCodecInfo, formatBitrateInfo } from '$lib/utils/media-display';
import {
    classifyHlsFailureStage,
    parseStreamDiagnosticCode,
    type PlaybackFailureStage,
    type StreamDiagnosticCode,
} from '$lib/utils/playback-diagnostics';
import { triageNetworkStatus } from './reconnect-policy';
import { describeManifestRefusal } from './playback-refusal';
import { liveTvFailureField } from './hls-error-body';
import type { LiveTvFailureInfo } from '$lib/api/livetv-failure-problem.js';
import type { FragmentDeliverySample } from './delivery-window-aggregator';

/**
 * Lazy-loaded hls.js instance (only loaded when needed, not on Safari)
 */
let HlsConstructor: typeof Hls | null = null;

/**
 * Load hls.js dynamically (only when needed)
 */
async function loadHls(): Promise<typeof Hls> {
    if (!HlsConstructor) {
        // Full build required for multi-audio HLS (audioStreamController).
        // hls.js/light excludes it, breaking demuxed audio in Lumastra HLS.
        const module = await import('hls.js');
        HlsConstructor = module.default;
    }
    return HlsConstructor;
}

/**
 * Logging function type
 */
type LogFn = (...args: unknown[]) => void;

type HlsTraceStatus = 'loading' | 'loaded' | 'error';

interface HlsTraceFragment {
    sn: number | string;
    type?: string;
    start?: number;
    url?: string;
    relurl?: string;
}

interface HlsRequestTraceEntry {
    key: string;
    stream: string;
    sn: number | string;
    type?: string;
    start?: number;
    statuses: HlsTraceStatus[];
    lastStatus: HlsTraceStatus;
}

interface HlsRequestTraceSession {
    id: number;
    reason: 'initial' | 'seek-reset';
    targetPosition?: number;
    startedAt: number;
    events: number;
    entries: Map<string, HlsRequestTraceEntry>;
    loadedByStream: Map<string, number>;
    errors: number;
    lastSummaryAt: number;
}

/**
 * Autoplay policy status
 */
export type AutoplayPolicy = 'allowed' | 'allowed-muted' | 'disallowed' | 'unknown';

/**
 * Autoplay result info
 */
export interface AutoplayResult {
    /** Whether autoplay succeeded */
    success: boolean;
    /** Whether playing muted as fallback */
    playingMuted: boolean;
    /** Whether autoplay had to override an unmuted playback preference. */
    usedMutedFallback?: boolean;
    /** iOS: the source waits for the user's tap (deferNativeSourceUntilGesture). */
    awaitingTap?: boolean;
    /** The detected autoplay policy */
    policy: AutoplayPolicy;
}

/**
 * Events emitted by the PlaybackManager
 */
export interface PlaybackManagerEvents {
    onManifestParsed: () => void;
    onFragmentLoaded: (bandwidth: number) => void;
    onBufferLow: (bufferAhead: number) => void;
    onLevelSwitching: (level: number) => void;
    onError: (error: PlaybackError) => void;
    onNetworkRecoveryAttempt: (attempt: number, maxAttempts: number) => void;
    /**
     * Fires on each MEDIA_ERROR. Return `true` to signal the handler took
     * over recovery (e.g. via a full HLS instance rebuild) — skips the
     * built-in recoverMediaError() call AND short-circuits the remaining
     * retry budget so the fatal error path doesn't fire afterwards.
     */
    onMediaRecoveryAttempt: (
        attempt: number,
        maxAttempts: number,
        details?: string,
    ) => boolean | void;
    onBufferStall: () => void;
    onCodecDetected: (info: CodecDetectionResult) => void;
    onLoadingChange: (isLoading: boolean) => void;
    onDirectPlayFailed: () => void;
    onPlayError: (error: Error) => void;
    /** Called when autoplay completes (success or fallback) */
    onAutoplayResult: (result: AutoplayResult) => void;
    /** The muted-autoplay fallback is about to mute the element (fires before `muted` changes) */
    onMutedFallbackStart: () => void;
    /**
     * The element is about to get a new `src` (native HLS or direct play), fired
     * synchronously before the assignment. iOS hands every <track> child that
     * exists at load time to AVFoundation, which rejects them next to an HLS
     * master (MediaError 4), so the controller detaches tracks here.
     */
    onBeforeSourceChange: () => void;
    /** Called when a quality level switch occurs (for telemetry) */
    onQualitySwitch: (newLevel: number, bitrate: number, bandwidth: number) => void;
    /** Called when rebuffering starts */
    onRebufferStart: (position: number) => void;
    /** Called when rebuffering ends */
    onRebufferEnd: (position: number, durationMs: number) => void;
    /** Called when buffer starvation is detected */
    onBufferStarvation: (bufferBefore: number) => void;
    /** A retryable server-diagnosed failure that HLS.js will handle itself. */
    onTransientDiagnostic?: (error: PlaybackError) => void;
    /**
     * hls.js only: fires when the currently-loading fragment's LIVE
     * LoaderStats show genuine new bytes since the last poll (~2s interval).
     * Unlike the DOM 'progress' event (which can keep firing on a
     * dead-but-trickling connection with no real bytes arriving), this is
     * byte-verified — safe for ReconnectController to treat as proof the
     * connection is still alive.
     */
    onVerifiedNetworkActivity?: () => void;
    /**
     * hls.js only: one completed 'main' fragment download, timed by the
     * receiver. This is the raw material for the 30 s delivery windows — the
     * only honest measurement of what the link actually carried, since
     * server-side segment timing only sees a write into a 16 MB socket buffer.
     * Native HLS (Safari) has no equivalent event and reports nothing here.
     */
    onFragmentDelivered?: (sample: FragmentDeliverySample) => void;
}

/**
 * Error information from playback manager
 */
export interface PlaybackError {
    type: 'network' | 'media' | 'fatal' | 'decode' | 'session_expired';
    message: string;
    details?: string;
    recoverable: boolean;
    /** HTTP status of the failing request, when known (network errors). */
    httpStatus?: number;
    /** The HLS request stage observed by the browser. */
    stage?: PlaybackFailureStage;
    /** Sanitised, allow-listed cause confirmed by the stream server. */
    serverDiagnosticCode?: StreamDiagnosticCode;
    /** True when the server flagged the session unrecoverable (admin stop). */
    sessionTerminal?: boolean;
    /** Live TV: the typed failure in the body of a 410 response, when it carried one. */
    liveTvFailure?: LiveTvFailureInfo;
}

/**
 * Severity level for playback errors. (ref: DL-004)
 * - fatal:       unrecoverable; playback cannot continue. Forwarded to onPlayError.
 *                Note: HLS-level fatal errors bypass emitError and go through
 *                handleFatalError() → events.onError directly. emitError 'fatal'
 *                is reserved for non-HLS unrecoverable failures.
 * - recoverable: operation failed but playback may retry. Forwarded to onPlayError.
 * - swallowed:   expected browser behavior (e.g., autoplay block). Logged only; not forwarded.
 */
export type PlaybackErrorSeverity = 'fatal' | 'recoverable' | 'swallowed';

/**
 * Structured error info passed through the unified error path.
 */
export interface PlaybackErrorInfo {
    severity: PlaybackErrorSeverity;
    error: Error;
    context: string;
    source: 'autoplay' | 'muted-autoplay' | 'manual-play' | 'akarisub' | 'restore';
}

/**
 * Result of codec detection from HLS manifest
 */
export interface CodecDetectionResult {
    manifestCodec: string;
    sourceCodec: string;
    isActuallyTranscoding: boolean;
    formattedCodec: string;
    bitrate: number;
    formattedBitrate: string;
}

/**
 * Configuration for the playback manager
 */
export interface PlaybackManagerConfig {
    videoElement: HTMLVideoElement;
    isSafari: boolean;
    isLive: boolean;
    autoPlay: boolean;
    /** Whether this is a continuation (next episode) - uses more aggressive autoplay */
    isContinuation?: boolean;
    /**
     * Whether a blocked autoplay may fall back to MUTED playback (default true).
     * False on iOS: a muted native-HLS start of a stream with audio can sit on
     * its first segment indefinitely (AVFoundation re-fetches it ~10x/s until
     * MediaError 3/4), so there a blocked autoplay shows the play control instead.
     */
    mutedAutoplayFallback?: boolean;
    /**
     * iOS: attach a native-HLS source only inside a user gesture (default false).
     * Without one, WebKit blocks playback with sound ("PreventedAutoplay") and,
     * while blocked, iOS rebuilds the player item over and over (audio track
     * added, refused, removed), fetching the first segment ~10x/s until
     * MediaError 3/4 or a tap. With this on, a load outside a gesture keeps the
     * source detached until startDeferredSource() runs from the tap.
     */
    deferNativeSourceUntilGesture?: boolean;
    /** VOD-only hls.js buffer settings. Ignored for live streams and native HLS. */
    hlsVodBufferSettings?: HlsVodBufferSettings;
    /** Whether the user might be in a watch party (prevents autoplay) */
    mightBeInWatchParty: () => boolean;
    /** Whether currently in a watch party */
    isInWatchParty: () => boolean;
    /** Log function for debugging */
    log: LogFn;
    /** Event callbacks */
    events: Partial<PlaybackManagerEvents>;
    /** Source codec for comparison during transcoding detection */
    sourceCodec?: string;
    /** Source bitrate for comparison */
    sourceBitrate?: number;
}

/**
 * Options for loading a stream
 */
export interface LoadOptions {
    /** Source codec for transcoding detection */
    sourceCodec?: string;
    /** Source bitrate for transcoding detection */
    sourceBitrate?: number;
    /** Start position in seconds (for resuming playback) */
    startPosition?: number;
    /** Initial party startup only; ordinary source replacements preserve startPosition. */
    getStartupPosition?: () => number | undefined;
}

/**
 * Playback mode
 */
export type PlaybackMode = 'hls' | 'direct';

/**
 * Playback Manager class
 *
 * Manages HLS.js instance and direct playback, handling initialization,
 * error recovery, and cleanup.
 */
export class PlaybackManager {
    private hls: Hls | null = null;
    /** True when the active engine is native Safari HLS (no Hls instance). In
     *  this mode restartLoad() is a no-op and a dead session can only be
     *  recovered by a fresh-session rebuild — see decideRecovery. */
    private usingNativeHls = false;
    private HlsClass: typeof Hls | null = null; // Store Hls constructor for accessing static enums
    private readonly config: PlaybackManagerConfig;
    private networkErrorRecoveryAttempts = 0;
    private mediaErrorRecoveryAttempts = 0;
    private suppressErrors = false;
    private isDestroyed = false;
    private sourceGeneration = 0;
    private pendingHlsSourceGeneration: number | null = null;
    /** Native-HLS source held back until a user gesture (see deferNativeSourceUntilGesture). */
    private deferredNativeStart: (() => void) | null = null;
    /** One-shot 'play' listener that attaches a deferred source on any play() route. */
    private deferredPlayListener: (() => void) | null = null;
    private playbackWarningLogged = false;
    private directPlayErrorHandler: (() => void) | null = null;
    private currentSourceCodec?: string;
    private currentSourceBitrate?: number;
    private currentUrl?: string;
    private currentStartPosition?: number;
    private startupPositionResolver?: () => number | undefined;
    // Track if playback has started (to distinguish initial buffering from rebuffering)
    private hasStartedPlayback = false;
    // Track current playback mode (hls or direct)
    private currentMode: PlaybackMode | null = null;
    // Visibility change handler for re-attaching media when tab becomes visible
    private visibilityHandler: (() => void) | null = null;
    private playbackEventListenersSetup = false;
    private rebufferStartTime: number | null = null;
    private lastBufferHealth = 0;
    private lastSeekTime = 0;
    private seekResetInFlight = false;
    private pendingSeekResetPosition: number | null = null;
    private pendingSeekResetIsVideoCopyMode = false;
    private pendingSeekResetDeferResume = false;
    // null: initial load; false: preserve pause; true: resume after the seek.
    private pendingResumeAfterSeekReset: boolean | null = null;
    private partySeekBurstStartedAt = 0;
    private partySeekBurstCount = 0;
    private partySeekLastAt = 0;
    private partySeekTimes: number[] = [];
    private partySeekBurstRecovered = false;
    private partySeekRecoveryTarget = 0;
    private partySeekRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
    private nativeSeekResetTimeout: ReturnType<typeof setTimeout> | null = null;
    private nativeSeekResetHandler: (() => void) | null = null;
    private fineTuneHandler: (() => void) | null = null;
    private videoReadyPlayHandler: (() => void) | null = null;
    private hlsTraceSessionCounter = 0;
    private hlsRequestTrace: HlsRequestTraceSession | null = null;
    // Byte-verified network-activity poll (hls.js only — see
    // onVerifiedNetworkActivity). currentFragBytesRef points at the LIVE,
    // mutating LoadStats of the fragment currently loading; lastPolledFragBytes
    // is the `.loaded` value observed on the previous poll tick.
    private currentFragBytesRef: LoaderStats | null = null;
    private lastPolledFragBytes = 0;
    private fragBytesPollTimer: ReturnType<typeof setInterval> | null = null;

    constructor(config: PlaybackManagerConfig) {
        this.config = config;
        this.currentSourceCodec = config.sourceCodec;
        this.currentSourceBitrate = config.sourceBitrate;
        trackPlayedElement(config.videoElement);
    }

    /**
     * Update configuration (e.g., when isLive changes)
     *
     * `hlsVodBufferSettings` is read fresh by `load()` on every rebuild
     * (buildHlsConfig, see initializeHls), so updating it here changes the
     * buffer depth of the NEXT load. That matters because the manager is a
     * lazy singleton on PlayerController: switching to the audio-only quality
     * rung mid-playback reuses the existing instance, so without this the deep
     * audio-only buffer could never take effect — the manager kept the settings
     * frozen at construction time (video defaults, 600 s), which is exactly
     * what preprod showed (observed buffers 507–583 s, never near 1800).
     *
     * Uses an `in` check rather than `!== undefined` so a caller CAN clear the
     * override back to `undefined` when returning to video.
     */
    updateConfig(
        updates: Partial<
            Pick<
                PlaybackManagerConfig,
                'isLive' | 'autoPlay' | 'sourceCodec' | 'sourceBitrate' | 'hlsVodBufferSettings'
            >
        >,
    ): void {
        if (updates.isLive !== undefined) this.config.isLive = updates.isLive;
        if (updates.autoPlay !== undefined) this.config.autoPlay = updates.autoPlay;
        if (updates.sourceCodec !== undefined) this.currentSourceCodec = updates.sourceCodec;
        if (updates.sourceBitrate !== undefined) this.currentSourceBitrate = updates.sourceBitrate;
        if ('hlsVodBufferSettings' in updates) {
            this.config.hlsVodBufferSettings = updates.hlsVodBufferSettings;
        }
    }

    /**
     * Get the current HLS instance (if any)
     */
    getHls(): Hls | null {
        return this.hls;
    }

    /**
     * Check if HLS.js is supported in this browser
     * Uses feature detection instead of requiring hls.js import
     */
    static isHlsSupported(): boolean {
        // Feature detection for HLS.js support (without importing the library)
        // This checks for MediaSource API support
        const mediaSource =
            typeof window !== 'undefined' &&
            (window.MediaSource || (window as { WebKitMediaSource?: unknown }).WebKitMediaSource);
        return !!mediaSource;
    }

    /**
     * Check if native HLS is supported (Safari)
     */
    isNativeHlsSupported(): boolean {
        return !!this.config.videoElement.canPlayType('application/vnd.apple.mpegurl');
    }

    /**
     * Suppress errors during quality switches (transient errors are expected)
     */
    setSuppressErrors(suppress: boolean): void {
        this.suppressErrors = suppress;
    }

    /**
     * Load a stream URL
     *
     * @param url - The stream URL (HLS manifest or direct video URL)
     * @param mode - Playback mode ('hls' or 'direct')
     * @param options - Optional load options (sourceCodec, sourceBitrate)
     * @returns Promise that resolves when loading starts
     */
    async load(url: string, mode: PlaybackMode, options?: LoadOptions): Promise<void> {
        const { log } = this.config;

        // Update source info if provided
        if (options?.sourceCodec !== undefined) this.currentSourceCodec = options.sourceCodec;
        if (options?.sourceBitrate !== undefined) this.currentSourceBitrate = options.sourceBitrate;
        if (options?.startPosition !== undefined) this.currentStartPosition = options.startPosition;
        this.startupPositionResolver = options?.getStartupPosition;
        const partyPosition = this.startupPositionResolver?.();
        if (partyPosition !== undefined) this.currentStartPosition = partyPosition;
        this.currentUrl = mode === 'hls' ? this.withSeekParam(url, this.currentStartPosition) : url;

        // Cleanup any existing error handler
        this.cleanupDirectPlayErrorHandler();

        // Destroy any existing HLS instance.
        // skipVideoReset=true: we are about to set a new src, so there is no
        // need to run videoElement.src=''+load() which would queue a spurious
        // "Empty src attribute" error event.
        this.destroy(true);
        this.isDestroyed = false;
        this.playbackWarningLogged = false;
        this.hasStartedPlayback = false; // Reset for new content
        this.currentMode = mode; // Track current playback mode

        log(' PlaybackManager.load:', {
            mode,
            startPosition: this.currentStartPosition,
            url: this.currentUrl.replace(/grant=[^&]+/g, 'grant=***').substring(0, 100),
        });

        if (mode === 'direct') {
            await this.initializeDirectPlay(this.currentUrl);
        } else {
            this.startHlsRequestTrace('initial', this.currentStartPosition);
            await this.initializeHls(this.currentUrl);
        }
    }

    private withSeekParam(url: string, startPosition?: number): string {
        const seekSeconds =
            startPosition !== undefined && startPosition > 0 ? startPosition : undefined;

        try {
            const parsed = new URL(
                url,
                typeof window !== 'undefined' ? window.location.origin : 'http://local',
            );

            if (seekSeconds !== undefined) {
                parsed.searchParams.set('seek', seekSeconds.toString());
            } else {
                parsed.searchParams.delete('seek');
                parsed.searchParams.delete('StartTimeTicks');
            }

            const isAbsolute = url.startsWith('http://') || url.startsWith('https://');
            return isAbsolute
                ? parsed.toString()
                : `${parsed.pathname}${parsed.search}${parsed.hash}`;
        } catch {
            return url;
        }
    }

    /**
     * Cleanup loadedmetadata fine-tune handler (prevents stale resume targets
     * from leaking across source rebuilds).
     */
    private cleanupFineTuneHandler(): void {
        if (this.fineTuneHandler) {
            this.config.videoElement.removeEventListener('loadedmetadata', this.fineTuneHandler);
            this.fineTuneHandler = null;
        }
    }

    private cleanupNativeSeekResetHandler(): void {
        if (this.nativeSeekResetTimeout) clearTimeout(this.nativeSeekResetTimeout);
        this.nativeSeekResetTimeout = null;
        if (this.nativeSeekResetHandler) {
            this.config.videoElement.removeEventListener(
                'loadedmetadata',
                this.nativeSeekResetHandler,
            );
            this.nativeSeekResetHandler = null;
        }
    }

    private cleanupVideoReadyPlayHandler(): void {
        if (this.videoReadyPlayHandler) {
            this.config.videoElement.removeEventListener('loadeddata', this.videoReadyPlayHandler);
            this.videoReadyPlayHandler = null;
        }
    }

    private playWhenVideoReady(reason: 'resume-start' | 'seek-reset-resume'): void {
        const { videoElement, log } = this.config;
        const target = this.currentStartPosition;

        const resumePlayback = () => {
            this.cleanupVideoReadyPlayHandler();
            // A party may join after MANIFEST_PARSED queued this personal
            // resume. Party commands own both the clock and play intent now.
            if (
                this.config.isInWatchParty() ||
                this.config.mightBeInWatchParty() ||
                (reason === 'resume-start' && !this.shouldAutoPlay())
            ) {
                if (reason === 'seek-reset-resume') this.pendingResumeAfterSeekReset = null;
                return;
            }

            if (target !== undefined && target > 0) {
                const drift = Math.abs(videoElement.currentTime - target);
                if (drift > 0.25) {
                    log(' Fine-tuning decoded video start position', {
                        reason,
                        from: videoElement.currentTime,
                        to: target,
                        drift,
                    });
                    videoElement.currentTime = target;
                }
            }

            if (reason === 'seek-reset-resume') {
                this.pendingResumeAfterSeekReset = null;
            }
            this.play().catch((error: Error) => {
                if (error.name !== 'AbortError') {
                    this.emitError({
                        severity: 'recoverable',
                        error,
                        context: `Deferred HLS playback resume failed (${reason})`,
                        source: 'restore',
                    });
                }
            });
        };

        if (videoElement.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            resumePlayback();
            return;
        }

        this.cleanupVideoReadyPlayHandler();
        this.videoReadyPlayHandler = () => {
            log(' Decoded video frame ready, resuming playback', { reason });
            resumePlayback();
        };
        videoElement.addEventListener('loadeddata', this.videoReadyPlayHandler, {
            once: true,
        });
    }

    /**
     * Cleanup direct play error handler
     */
    private cleanupDirectPlayErrorHandler(): void {
        if (this.directPlayErrorHandler) {
            this.config.videoElement.removeEventListener('error', this.directPlayErrorHandler);
            this.directPlayErrorHandler = null;
        }
    }

    /**
     * Chrome defers MediaSource sourceopen for hidden/background tabs.
     * This handler re-attaches media when the tab becomes visible so the
     * MediaSource can open and HLS.js can start loading fragments.
     */
    private setupVisibilityHandler(videoElement: HTMLVideoElement): void {
        this.cleanupVisibilityHandler();

        const hls = this.hls;
        if (!hls) return;

        const { log } = this.config;
        this.visibilityHandler = () => {
            if (document.hidden || !hls || this.isDestroyed) return;

            // Check if the MediaSource is still closed (never opened)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const bc = (hls as any).bufferController;
            const ms = bc?.mediaSource;
            if (ms && ms.readyState === 'closed') {
                log(' Tab became visible with closed MediaSource — re-attaching media');
                hls.detachMedia();
                hls.attachMedia(videoElement);
            } else {
                // MediaSource is already open, no action needed
                this.cleanupVisibilityHandler();
            }
        };
        document.addEventListener('visibilitychange', this.visibilityHandler);
    }

    private cleanupVisibilityHandler(): void {
        if (this.visibilityHandler) {
            document.removeEventListener('visibilitychange', this.visibilityHandler);
            this.visibilityHandler = null;
        }
    }

    /** Point the element at a native-HLS URL and load it, seeking to the start position. */
    private attachNativeSource(url: string): void {
        const { videoElement, log } = this.config;
        this.cleanupFineTuneHandler();
        const partyPosition = this.startupPositionResolver?.();
        if (partyPosition !== undefined) {
            this.currentStartPosition = partyPosition;
            url = this.withSeekParam(url, partyPosition);
            this.currentUrl = url;
        }
        this.config.events.onBeforeSourceChange?.();
        videoElement.src = url;

        // For Safari native HLS: set currentTime before load to hint where to start
        // This helps Safari's native player start buffering from the right position
        if (
            (this.currentStartPosition !== undefined && this.currentStartPosition > 0) ||
            this.startupPositionResolver !== undefined
        ) {
            log(' Safari: setting initial currentTime to:', this.currentStartPosition);
            // Set up a listener to seek once metadata is loaded
            const seekOnLoad = () => {
                const partyPosition = this.startupPositionResolver?.();
                const target = partyPosition ?? this.currentStartPosition!;
                const needsSeek =
                    partyPosition !== undefined
                        ? Math.abs(videoElement.currentTime - target) > 2
                        : videoElement.currentTime < target - 2;
                if (needsSeek) {
                    log(' Safari: seeking to start position:', target);
                    videoElement.currentTime = target;
                }
                this.cleanupFineTuneHandler();
                this.startupPositionResolver = undefined;
            };
            this.fineTuneHandler = seekOnLoad;
            videoElement.addEventListener('loadedmetadata', seekOnLoad);
        }

        videoElement.load();
    }

    /**
     * Attach a native-HLS source that was held back for a user gesture. Call it
     * synchronously from the tap handler, before play(). Returns false when no
     * source was waiting.
     */
    startDeferredSource(): boolean {
        const start = this.deferredNativeStart;
        if (!start) return false;
        this.deferredNativeStart = null;
        this.cleanupDeferredPlayListener();
        this.config.log(' iOS native HLS: attaching the source inside the tap');
        start();
        return true;
    }

    private cleanupDeferredPlayListener(): void {
        if (this.deferredPlayListener) {
            this.config.videoElement.removeEventListener('play', this.deferredPlayListener);
            this.deferredPlayListener = null;
        }
    }

    /** True while a native-HLS source waits for a tap. */
    hasDeferredSource(): boolean {
        return this.deferredNativeStart !== null;
    }

    /**
     * Initialize HLS playback
     * Safari: Uses native HLS for best compatibility
     * Other browsers: Uses hls.js (lazy-loaded)
     */
    private async initializeHls(url: string): Promise<void> {
        const generation = ++this.sourceGeneration;
        const { videoElement, isSafari, log, events } = this.config;

        // A source still waiting for a tap is superseded by this one; drop its
        // one-shot 'play' listener or it stays on the element until the next play.
        this.deferredNativeStart = null;
        this.cleanupDeferredPlayListener();

        const nativeHlsSupported = this.isNativeHlsSupported();
        const hlsJsSupported = PlaybackManager.isHlsSupported();

        log(' Initializing HLS playback', {
            hlsSupported: hlsJsSupported,
            nativeHlsSupported,
            isSafari,
            useNative: isSafari && nativeHlsSupported,
        });

        // Safari: Always prefer native HLS (no hls.js needed!)
        if (isSafari && nativeHlsSupported) {
            log(' Using native Safari HLS (hls.js not loaded)');
            this.usingNativeHls = true;

            // Reads currentUrl at attach time: a seek before the tap updates it.
            const attachSource = (): void => {
                if (generation !== this.sourceGeneration) return;
                this.attachNativeSource(this.currentUrl ?? url);
            };
            // Once the element has played, WebKit allows later play() calls without a
            // gesture (stall reconnects, quality restarts): only the first start waits.
            if (
                this.config.deferNativeSourceUntilGesture &&
                !playedElements.has(videoElement) &&
                !hasUserActivation()
            ) {
                log(' iOS native HLS: no user gesture, source waits for a tap');
                this.deferredNativeStart = attachSource;
                // Any play() route (party sync, OS controls, a direct element call)
                // attaches the source too: play() inside a tap grants the element
                // its playback permission, so a source attached right after it
                // starts normally.
                const onPlay = (): void => {
                    this.startDeferredSource();
                };
                this.deferredPlayListener = onPlay;
                videoElement.addEventListener('play', onPlay, { once: true });
                events.onLoadingChange?.(false);
                if (this.shouldAutoPlay()) {
                    events.onAutoplayResult?.({
                        success: false,
                        playingMuted: false,
                        policy: 'disallowed',
                        awaitingTap: true,
                    });
                }
                return;
            }
            this.deferredNativeStart = null;
            attachSource();

            events.onLoadingChange?.(false);

            if (this.shouldAutoPlay()) {
                this.tryAutoPlay();
            }
            return;
        }

        // Use hls.js for non-Safari browsers (lazy-load it + subtitle libraries)
        if (hlsJsSupported) {
            this.usingNativeHls = false;
            log(' Loading video player libraries (hls.js + subtitles)...');

            // Load hls.js and subtitle libraries in parallel
            this.pendingHlsSourceGeneration = generation;
            const [HlsModule] = await Promise.all([
                loadHls(),
                // Preload subtitle libraries (will be cached for when needed)
                // AkariSub is optional — subtitle rendering degrades to plain text on failure.
                import('akarisub').catch((err: Error) => {
                    this.emitError({
                        severity: 'swallowed',
                        error: err,
                        context:
                            'AkariSub preload failed; subtitle rendering will degrade to plain text',
                        source: 'akarisub',
                    });
                    return null;
                }),
                import('libbitsub').catch(() => null),
            ]);

            // A later source load or teardown owns the element after this await.
            if (this.isDestroyed || generation !== this.sourceGeneration) return;
            this.pendingHlsSourceGeneration = null;
            url = this.currentUrl ?? url;

            this.HlsClass = HlsModule;
            log(' Video player libraries loaded');

            const hlsConfig = buildHlsConfig(this.config.isLive, this.config.hlsVodBufferSettings);

            const partyPosition = this.startupPositionResolver?.();
            if (partyPosition !== undefined) this.currentStartPosition = partyPosition;
            const hasNonZeroStartPosition =
                this.currentStartPosition !== undefined && this.currentStartPosition > 0;
            const shouldForceStartLoadAtPosition =
                this.seekResetInFlight && hasNonZeroStartPosition;

            // Provide hls.js with the intended initial playback position so it
            // does not begin fragment selection at segment 0 on resumed startup.
            // The heavier startLoad(position) override remains reserved for
            // explicit seek-reset rebuilds.
            if (hasNonZeroStartPosition) {
                (hlsConfig as { startPosition?: number }).startPosition = this.currentStartPosition;
                log(' HLS.js startPosition set to:', this.currentStartPosition);
            }

            log(' Creating HLS instance');
            this.hls = new this.HlsClass(hlsConfig);

            // Disable HLS.js subtitle display - we manage subtitles manually
            this.hls.subtitleDisplay = false;

            if (partyPosition !== undefined) {
                url = this.withSeekParam(url, partyPosition);
                this.currentUrl = url;
            }
            this.hls.loadSource(url);
            this.hls.attachMedia(videoElement);

            // On initial non-zero startup, hls.js startPosition is enough to choose
            // the correct fragment, but not always enough to land at the exact
            // in-segment resume time. Fine-tune once metadata is available.
            if (
                (hasNonZeroStartPosition || this.startupPositionResolver !== undefined) &&
                !this.seekResetInFlight
            ) {
                const initialResumeTarget = this.currentStartPosition ?? 0;
                // Remove any stale fine-tune listener from a previous load
                this.cleanupFineTuneHandler();
                const fineTuneOnMetadata = () => {
                    this.fineTuneHandler = null;
                    const resumeTarget = this.startupPositionResolver?.() ?? initialResumeTarget;
                    this.startupPositionResolver = undefined;
                    const drift = Math.abs(videoElement.currentTime - resumeTarget);
                    if (drift > 2) {
                        log(' HLS.js fine-tuning initial startup position:', {
                            from: videoElement.currentTime,
                            to: resumeTarget,
                            drift,
                        });
                        videoElement.currentTime = resumeTarget;
                    } else {
                        log(' HLS.js initial startup already near target position:', {
                            currentTime: videoElement.currentTime,
                            target: resumeTarget,
                            drift,
                        });
                    }
                };
                this.fineTuneHandler = fineTuneOnMetadata;
                videoElement.addEventListener('loadedmetadata', fineTuneOnMetadata, { once: true });
            }

            if (import.meta.env.DEV) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (window as any).__hls = this.hls;
            }

            // Chrome defers MediaSource sourceopen for background/hidden tabs.
            // If the tab is hidden when we attach, the MediaSource stays "closed"
            // and HLS.js never starts loading fragments. Re-attach when tab becomes visible.
            this.setupVisibilityHandler(videoElement);

            if (shouldForceStartLoadAtPosition) {
                this.hls.startLoad(this.currentStartPosition);
                log(' HLS.js startLoad called with position:', this.currentStartPosition);
            }

            this.setupHlsEventHandlers();

            return;
        }

        // HLS not supported
        events.onError?.({
            type: 'fatal',
            message: 'HLS is not supported in this browser',
            recoverable: false,
        });
    }

    /**
     * Initialize direct playback (for DirectPlay/DirectStream)
     */
    private async initializeDirectPlay(url: string): Promise<void> {
        const { videoElement, log, events } = this.config;

        // Direct play is not native HLS — clear the flag so isNativeEngine()
        // doesn't stay stuck true after a native-HLS → direct-play switch on the
        // same reused PlaybackManager instance.
        this.usingNativeHls = false;

        log(' Setting direct play URL:', url.replace(/grant=[^&]+/g, 'grant=***'));
        events.onBeforeSourceChange?.();
        videoElement.src = url;
        videoElement.load();

        // Add error handler for direct play fallback
        this.directPlayErrorHandler = () => {
            log(' Direct play failed, notifying for fallback');
            this.cleanupDirectPlayErrorHandler();
            events.onDirectPlayFailed?.();
        };
        videoElement.addEventListener('error', this.directPlayErrorHandler, {
            once: true,
        });

        events.onLoadingChange?.(false);

        if (this.shouldAutoPlay()) {
            this.tryAutoPlay();
        }
    }

    /**
     * Check if autoplay should be attempted
     */
    private shouldAutoPlay(): boolean {
        const { autoPlay, isInWatchParty, mightBeInWatchParty, log } = this.config;

        if (!autoPlay) return false;
        if (isInWatchParty()) {
            log(' Skipping autoplay - in watch party');
            return false;
        }
        if (mightBeInWatchParty()) {
            log(' Skipping autoplay - watch party detected, waiting for sync');
            return false;
        }
        return true;
    }

    /**
     * Detect the browser's autoplay policy using the modern API if available
     */
    private detectAutoplayPolicy(): AutoplayPolicy {
        const { log } = this.config;

        // Use the Autoplay Policy Detection API if available
        // https://developer.mozilla.org/en-US/docs/Web/API/Navigator/getAutoplayPolicy
        if (typeof navigator !== 'undefined' && 'getAutoplayPolicy' in navigator) {
            try {
                // Type assertion since this API is not in all TypeScript DOM libs yet
                const policy = (
                    navigator as { getAutoplayPolicy: (type: string) => string }
                ).getAutoplayPolicy('mediaelement');
                log(' Detected autoplay policy via API:', policy);
                if (policy === 'allowed') return 'allowed';
                if (policy === 'allowed-muted') return 'allowed-muted';
                if (policy === 'disallowed') return 'disallowed';
            } catch {
                log(' getAutoplayPolicy API error, falling back to unknown');
            }
        }

        return 'unknown';
    }

    /**
     * Log debug headers from segment responses to the browser console.
     * Helps diagnose seek/offset issues during playback.
     */
    private logFragmentDebugHeaders(data: {
        frag: { sn: number | string; type: string; start: number };
        networkDetails?: unknown;
    }): void {
        const { networkDetails, frag } = data;
        if (!networkDetails || frag.sn === 'initSegment') return;

        const headers = this.getLumastraDebugHeaders(networkDetails);
        const offset = headers.offset;
        if (offset === null) return; // Not a Lumastra segment

        const seeking = headers.seeking;
        const seekNum = parseInt(headers.seekCount ?? '0', 10);
        const prefix = seeking === 'true' ? `%c[Lumastra SEEKING #${seekNum}]` : `%c[Lumastra seg]`;
        const style = seeking === 'true' ? 'color: #ff6b6b; font-weight: bold' : 'color: #69db7c';

        const triggerInfo = headers.trigger ? ` trigger=${headers.trigger}` : '';
        const branchInfo = headers.branch ? ` branch=${headers.branch}` : '';
        const progressInfo = headers.progress ? ` progress=${headers.progress}` : '';
        const deletedInfo = headers.deleted ? ` deleted=${headers.deleted}` : '';
        const canSeekInfo = headers.canSeek ? ` canSeek=${headers.canSeek}` : '';
        const modeInfo = headers.mode ? ` mode=${headers.mode}` : '';
        console.log(
            `${prefix} ${headers.stream} req=${frag.sn} actual=${headers.actual} offset=${offset} ready=${headers.ready} start=${frag.start.toFixed(1)}s${progressInfo}${deletedInfo}${canSeekInfo}${branchInfo}${modeInfo}${triggerInfo}`,
            style,
        );
    }

    private getLumastraDebugHeaders(networkDetails?: unknown): Record<string, string | null> {
        const getHeader = (name: string): string | null => {
            if (!networkDetails) return null;
            if (networkDetails instanceof XMLHttpRequest) {
                return networkDetails.getResponseHeader(name);
            }
            if (networkDetails instanceof Response) {
                return networkDetails.headers.get(name);
            }
            return null;
        };

        return {
            offset: getHeader('X-Lumastra-Offset'),
            actual: getHeader('X-Lumastra-Actual'),
            ready: getHeader('X-Lumastra-Ready'),
            seeking: getHeader('X-Lumastra-Seeking'),
            stream: getHeader('X-Lumastra-Stream'),
            seekCount: getHeader('X-Lumastra-SeekCount'),
            trigger: getHeader('X-Lumastra-SeekTrigger'),
            progress: getHeader('X-Lumastra-Progress'),
            deleted: getHeader('X-Lumastra-Deleted'),
            canSeek: getHeader('X-Lumastra-CanSeek'),
            branch: getHeader('X-Lumastra-Branch'),
            mode: getHeader('X-Lumastra-Mode'),
            targetDuration: getHeader('X-Lumastra-TargetDuration'),
            sessionTerminal: getHeader('X-Lumastra-Session-Terminal'),
            diagnosticCode: getHeader('X-Lumastra-Diagnostic-Code'),
        };
    }

    private startHlsRequestTrace(
        reason: HlsRequestTraceSession['reason'],
        targetPosition?: number,
    ): void {
        this.hlsRequestTrace = {
            id: ++this.hlsTraceSessionCounter,
            reason,
            targetPosition,
            startedAt: Date.now(),
            events: 0,
            entries: new Map(),
            loadedByStream: new Map(),
            errors: 0,
            lastSummaryAt: 0,
        };
    }

    private getHlsFragmentKey(frag: HlsTraceFragment): {
        key: string;
        stream: string;
    } {
        const url = frag.relurl || frag.url || '';
        const streamMatch = url.match(/(?:^|\/)(stream_[^/]+)\//);
        const stream = streamMatch?.[1] ?? frag.type ?? 'unknown';
        return {
            key: `${stream}:${String(frag.sn)}`,
            stream,
        };
    }

    /**
     * Turn a finished 'main' fragment's LoadStats into a delivery sample.
     *
     * `stats.loading` is a performance.now()-based triple: `start` (request
     * issued), `first` (first byte in), `end` (last byte in). The interval that
     * actually carried the bytes is first→end; start→end would fold queueing
     * and server think-time into the rate and make a slow server look like a
     * slow link.
     *
     * Emits nothing unless the timings describe a real transfer:
     *  - `end <= first`: sub-millisecond or unrecorded — no measurable rate.
     *  - `first < start`: `first` was never stamped (LoadStats initialises the
     *    triple to 0), so first→end would be the whole page uptime.
     *  - `loaded <= 0`: nothing arrived to measure.
     */
    private emitFragmentDelivery(
        frag: { duration?: number; stats?: LoaderStats },
        onFragmentDelivered: PlaybackManagerEvents['onFragmentDelivered'],
    ): void {
        if (!onFragmentDelivered) return;

        const stats = frag.stats;
        if (!stats) return;
        const { start, first, end } = stats.loading;
        if (end <= first || first < start || stats.loaded <= 0) return;

        onFragmentDelivered({
            bytes: stats.loaded,
            mediaSec: frag.duration ?? 0,
            requestMs: end - start,
            transferMs: end - first,
            ttfbMs: first - start,
            endedAt: end,
        });
    }

    private recordHlsTraceFragment(
        status: HlsTraceStatus,
        frag?: HlsTraceFragment,
        details?: string,
    ): void {
        if (!frag || frag.sn === 'initSegment') return;
        const trace = this.hlsRequestTrace;
        if (!trace) return;

        const { key, stream } = this.getHlsFragmentKey(frag);
        const existing = trace.entries.get(key);
        const loadedStreamCountBefore = trace.loadedByStream.size;
        const entry = existing ?? {
            key,
            stream,
            sn: frag.sn,
            type: frag.type,
            start: frag.start,
            statuses: [],
            lastStatus: status,
        };
        entry.statuses.push(status);
        entry.lastStatus = status;
        trace.entries.set(key, entry);
        trace.events += 1;

        if (status === 'loaded') {
            trace.loadedByStream.set(stream, (trace.loadedByStream.get(stream) ?? 0) + 1);
        } else if (status === 'error') {
            trace.errors += 1;
        }

        const becameMultiStream = loadedStreamCountBefore < 2 && trace.loadedByStream.size >= 2;
        const shouldSummarize =
            status === 'error' ||
            trace.events <= 4 ||
            trace.events - trace.lastSummaryAt >= 8 ||
            becameMultiStream;
        if (!shouldSummarize) return;

        trace.lastSummaryAt = trace.events;
        this.config.log('[Lumastra HLS request graph]', {
            traceId: trace.id,
            reason: trace.reason,
            targetPosition: trace.targetPosition,
            ageMs: Date.now() - trace.startedAt,
            events: trace.events,
            uniqueRequests: trace.entries.size,
            loadedByStream: Object.fromEntries(trace.loadedByStream),
            errors: trace.errors,
            last: {
                status,
                stream,
                sn: frag.sn,
                start: frag.start,
                details,
            },
            recent: [...trace.entries.values()].slice(-8).map((item) => ({
                stream: item.stream,
                sn: item.sn,
                status: item.lastStatus,
                attempts: item.statuses.length,
                start: item.start,
            })),
        });
    }

    /**
     * Try to auto-play the video
     * For continuations (next episode), uses muted autoplay fallback if blocked
     * Does NOT auto-unmute - caller should show UI for user to unmute
     */
    private tryAutoPlay(): void {
        const generation = this.sourceGeneration;
        const { videoElement, events, log, isContinuation } = this.config;
        const mutedFallback = this.config.mutedAutoplayFallback !== false;

        // First, check autoplay policy if API is available
        const policy = this.detectAutoplayPolicy();
        log(' Autoplay attempt', { policy, isContinuation, mutedFallback });

        // If policy says only muted is allowed and this is a continuation,
        // go straight to muted playback for better UX
        if (policy === 'allowed-muted' && isContinuation && mutedFallback) {
            log(' Policy allows muted only, starting muted for continuation');
            this.startMutedPlayback();
            return;
        }

        // Try normal playback first
        videoElement
            .play()
            .then(() => {
                if (this.isDestroyed || generation !== this.sourceGeneration) return;
                log(' Autoplay succeeded');
                events.onAutoplayResult?.({
                    success: true,
                    playingMuted: videoElement.muted,
                    policy,
                });
            })
            .catch((error: Error) => {
                if (this.isDestroyed || generation !== this.sourceGeneration) return;
                if (error.name === 'NotAllowedError') {
                    // Autoplay was blocked by the browser. Retry muted regardless
                    // of isContinuation — a fresh (non-continuation) load can lose
                    // its triggering user gesture too, since the actual play() call
                    // here happens after an async data fetch. Browsers vary in how
                    // long they honor a gesture across that gap (e.g. Brave enforces
                    // its autoplay policy more strictly than Chrome's default), so
                    // without this fallback the video silently stays paused at 0:00
                    // with no obvious explanation to the user.
                    if (!mutedFallback) {
                        log(' Autoplay blocked, muted fallback disabled - waiting for a tap');
                        events.onAutoplayResult?.({
                            success: false,
                            playingMuted: false,
                            policy,
                        });
                        return;
                    }
                    log(' Autoplay blocked, trying muted autoplay', { isContinuation });
                    this.startMutedPlayback();
                } else if (error.name !== 'AbortError') {
                    this.emitError({
                        severity: 'recoverable',
                        error,
                        context: 'Autoplay attempt failed',
                        source: 'autoplay',
                    });
                }
            });
    }

    /**
     * Start playback muted as a fallback when autoplay is blocked
     * Does NOT auto-unmute - shows indicator for user to unmute
     */
    private startMutedPlayback(): void {
        // iOS: a muted native-HLS start loops on its first segment.
        if (this.config.mutedAutoplayFallback === false) return;
        const generation = this.sourceGeneration;
        const { videoElement, events, log } = this.config;
        const wasMuted = videoElement.muted;

        if (!wasMuted) events.onMutedFallbackStart?.();
        videoElement.muted = true;

        videoElement
            .play()
            .then(() => {
                if (this.isDestroyed || generation !== this.sourceGeneration) return;
                log(' Muted autoplay succeeded - waiting for user to unmute');
                // Do NOT auto-unmute - let UI show an indicator
                events.onAutoplayResult?.({
                    success: true,
                    playingMuted: true,
                    usedMutedFallback: !wasMuted,
                    policy: 'allowed-muted',
                });
            })
            .catch((err: Error) => {
                if (this.isDestroyed || generation !== this.sourceGeneration) return;
                log(' Even muted autoplay failed');
                videoElement.muted = wasMuted;
                this.emitError({
                    severity: 'recoverable',
                    error: err,
                    context: 'Muted autoplay fallback also blocked',
                    source: 'muted-autoplay',
                });
                events.onAutoplayResult?.({
                    success: false,
                    playingMuted: false,
                    policy: 'disallowed',
                });
            });
    }

    /**
     * Manually trigger play (for use after user interaction)
     */
    play(): Promise<void> {
        this.startDeferredSource();
        return this.config.videoElement.play().catch((error: Error) => {
            if (error.name !== 'AbortError') {
                this.emitError({
                    severity: 'recoverable',
                    error,
                    context: 'Manual play() call rejected',
                    source: 'manual-play',
                });
            }
            throw error;
        });
    }

    /**
     * Pause playback
     */
    pause(): void {
        this.config.videoElement.pause();
    }

    /**
     * Set up HLS.js event handlers
     */
    private setupHlsEventHandlers(): void {
        if (!this.hls) return;

        const { log, events } = this.config;
        const hls = this.hls;
        const isCurrentHls = (): boolean => !this.isDestroyed && this.hls === hls;

        // Byte-verified network-activity poll (see onVerifiedNetworkActivity).
        // This method is re-entered on every resetForSeek rebuild (a fresh Hls
        // instance is attached to the SAME PlaybackManager), so the previous
        // interval MUST be cleared first — otherwise it leaks a duplicate
        // interval forever (resetForSeek calls hls.destroy(), not
        // PlaybackManager.destroy(), so nothing else would ever clear it).
        if (this.fragBytesPollTimer) {
            clearInterval(this.fragBytesPollTimer);
        }
        this.currentFragBytesRef = null;
        this.lastPolledFragBytes = 0;
        this.fragBytesPollTimer = setInterval(() => this.pollFragBytesProgress(), 2000);

        // Media attached - MediaSource is open, visibility handler no longer needed
        hls.on(this.HlsClass!.Events.MEDIA_ATTACHED, () => {
            if (!isCurrentHls()) return;
            this.cleanupVisibilityHandler();
        });

        // Manifest parsed - stream is ready
        hls.on(this.HlsClass!.Events.MANIFEST_PARSED, () => {
            if (!isCurrentHls()) return;

            // Reset recovery counters
            this.networkErrorRecoveryAttempts = 0;
            this.mediaErrorRecoveryAttempts = 0;
            this.suppressErrors = false;

            events.onLoadingChange?.(false);
            events.onManifestParsed?.();

            // Detect codec from manifest using current source info
            this.detectCodecFromManifest(this.currentSourceCodec, this.currentSourceBitrate);

            // Log audio tracks
            if (this.hls?.audioTracks && this.hls.audioTracks.length > 0) {
                log(
                    ' HLS audio tracks available:',
                    this.hls.audioTracks.map((t) => ({
                        id: t.id,
                        name: t.name,
                        lang: t.lang,
                        default: t.default,
                    })),
                );
            }

            const pendingSeekResetPosition = this.pendingSeekResetPosition;
            if (this.seekResetInFlight && pendingSeekResetPosition !== null) {
                const pendingIsVideoCopyMode = this.pendingSeekResetIsVideoCopyMode;
                const pendingDeferResume = this.pendingSeekResetDeferResume;
                this.pendingSeekResetPosition = null;
                this.pendingSeekResetIsVideoCopyMode = false;
                this.pendingSeekResetDeferResume = false;
                this.seekResetInFlight = false;
                // The reset itself paused the element. Retain the original
                // play/pause intent for the replacement seek.
                log(
                    ' HLS seek reset completed with newer pending target; rebuilding again at',
                    pendingSeekResetPosition.toFixed(2) + 's',
                );
                this.resetForSeek(
                    pendingSeekResetPosition,
                    pendingIsVideoCopyMode,
                    pendingDeferResume,
                );
                return;
            }

            const shouldResumeAfterSeekReset = this.pendingResumeAfterSeekReset;
            // Keep a pending resume until decoded video can play: a newer
            // seek arriving before loadeddata must inherit that play intent.
            if (shouldResumeAfterSeekReset !== true) {
                this.pendingResumeAfterSeekReset = null;
            }
            if (this.seekResetInFlight) {
                this.seekResetInFlight = false;
            }

            if (shouldResumeAfterSeekReset) {
                log(' Waiting for decoded video before resuming after HLS seek reset');
                this.playWhenVideoReady('seek-reset-resume');
            } else if (shouldResumeAfterSeekReset === null && this.shouldAutoPlay()) {
                if (this.currentStartPosition !== undefined && this.currentStartPosition > 0) {
                    log(' Waiting for decoded video before autoplay at non-zero start');
                    this.playWhenVideoReady('resume-start');
                } else {
                    this.tryAutoPlay();
                }
            }
        });

        // Check for playback warnings from media playlist responses
        hls.on(this.HlsClass!.Events.LEVEL_LOADED, (_event, data: LevelLoadedData) => {
            if (!isCurrentHls() || this.playbackWarningLogged) return;
            const nd = data.networkDetails;
            if (!nd) return;
            const warning =
                nd instanceof XMLHttpRequest
                    ? nd.getResponseHeader('X-Lumastra-Playback-Warning')
                    : nd instanceof Response
                      ? nd.headers.get('X-Lumastra-Playback-Warning')
                      : null;
            if (warning) {
                this.playbackWarningLogged = true;
                console.warn(
                    '%c[Lumastra] ⚠️ DEGRADED PLAYBACK: %s',
                    'color: #ffa500; font-weight: bold; font-size: 14px',
                    warning,
                );
                console.warn(
                    '%c[Lumastra] Seeking may target wrong segments. ' +
                        'Run the media-probe sync task to generate keyframe data.',
                    'color: #ffa500',
                );
            }
        });

        hls.on(this.HlsClass!.Events.FRAG_LOADING, (_event: unknown, data: unknown) => {
            if (!isCurrentHls()) return;
            const fragData = data as { frag?: HlsTraceFragment };
            this.recordHlsTraceFragment('loading', fragData.frag);

            // Track the LIVE LoadStats of the fragment now loading so the
            // 2s poll (pollFragBytesProgress) can detect genuine byte progress —
            // see onVerifiedNetworkActivity. Only the 'main' stream: if audio is
            // ever demuxed through hls.js, concurrent audio+video loaders would
            // otherwise clobber each other's stats ref and could mask a frozen
            // video fragment. All current hls.js modes are muxed (native handles
            // demux, and never reaches here) — this guard is future-proofing.
            const fragLoadingData = data as FragLoadingData;
            if (fragLoadingData.frag.type !== 'main') return;
            this.currentFragBytesRef = fragLoadingData.frag.stats;
            this.lastPolledFragBytes = 0;
        });

        // Fragment loaded - update bandwidth + debug logging
        hls.on(this.HlsClass!.Events.FRAG_LOADED, (_event: unknown, data: unknown) => {
            if (!isCurrentHls()) return;
            const fragData = data as {
                frag: {
                    sn: number | string;
                    type: string;
                    start: number;
                    duration?: number;
                    stats?: LoaderStats;
                };
                networkDetails?: XMLHttpRequest | Response;
            };

            // This fragment finished — stop polling its (now-final) stats. Guard
            // on the 'main' stream (symmetric with FRAG_LOADING) so a future
            // concurrent non-main FRAG_LOADED can't null the main fragment's
            // still-live stats mid-download.
            if (fragData.frag.type === 'main') {
                this.currentFragBytesRef = null;
                // Fire the verified-activity signal directly here too, not just
                // from the 2s poll (pollFragBytesProgress): a fragment that
                // loads faster than the poll interval — the common case for a
                // small/cached segment — would otherwise never get sampled with
                // non-zero bytes before this handler nulls the ref, so a
                // perfectly successful load could go completely undetected.
                // FRAG_LOADED only ever fires for a load that actually
                // completed (a failed/error fragment goes through
                // FRAG_LOAD_ERROR/ERROR instead, handled by handleHlsError,
                // which is exactly why this is safe from the "byte-verified"
                // requirement's own name: an errored fragment can never reach
                // this branch.
                events.onVerifiedNetworkActivity?.();

                this.emitFragmentDelivery(fragData.frag, events.onFragmentDelivered);
            }

            this.networkErrorRecoveryAttempts = 0;

            if (this.hls?.bandwidthEstimate) {
                events.onFragmentLoaded?.(this.hls.bandwidthEstimate);
            }

            // Log seek debug headers from segment responses
            this.logFragmentDebugHeaders(fragData);
            this.recordHlsTraceFragment('loaded', fragData.frag);
        });

        // Buffer level check
        hls.on(this.HlsClass!.Events.FRAG_BUFFERED, () => {
            if (!isCurrentHls() || !this.hls) return;

            const { videoElement } = this.config;
            const buffered = videoElement.buffered;

            if (buffered.length > 0) {
                const bufferEnd = buffered.end(buffered.length - 1);
                const bufferAhead = bufferEnd - videoElement.currentTime;

                if (bufferAhead < 5) {
                    events.onBufferLow?.(bufferAhead);
                }
            }
        });

        // Level switching (includes telemetry event)
        hls.on(this.HlsClass!.Events.LEVEL_SWITCHING, (_, data) => {
            if (!isCurrentHls() || !this.hls) return;
            events.onLevelSwitching?.(data.level);

            // Emit quality switch telemetry
            const level = this.hls.levels[data.level];
            if (level) {
                events.onQualitySwitch?.(
                    data.level,
                    level.bitrate || 0,
                    this.hls.bandwidthEstimate || 0,
                );
            }
        });

        // Waiting event (rebuffering start)
        const videoElement = this.config.videoElement;
        const SEEK_GRACE_PERIOD_MS = 3000; // Don't count buffering within 3s of seek as rebuffer

        if (!this.playbackEventListenersSetup) {
            this.playbackEventListenersSetup = true;

            // Track when seeks complete
            videoElement.addEventListener('seeked', () => {
                this.lastSeekTime = Date.now();
            });

            videoElement.addEventListener('waiting', () => {
                if (this.isDestroyed) return;

                // Only count as rebuffering if:
                // 1. Playback has already started (initial buffering is normal)
                // 2. We're not currently seeking (seek buffering is user-initiated)
                // 3. We're not within the grace period after a seek
                // 4. We're not in a watch party (sync operations cause expected pauses)
                if (!this.hasStartedPlayback) {
                    log(' Initial buffering (not counting as rebuffer)');
                    return;
                }

                if (this.config.isInWatchParty()) {
                    log(' In watch party (not counting as rebuffer)');
                    return;
                }

                if (videoElement.seeking) {
                    log(' Buffering during seek (not counting as rebuffer)');
                    return;
                }

                const timeSinceSeek = Date.now() - this.lastSeekTime;
                if (timeSinceSeek < SEEK_GRACE_PERIOD_MS) {
                    log(` Buffering ${timeSinceSeek}ms after seek (not counting as rebuffer)`);
                    return;
                }

                this.rebufferStartTime = Date.now();

                // Check buffer health before the stall
                const buffered = videoElement.buffered;
                if (buffered.length > 0) {
                    this.lastBufferHealth =
                        buffered.end(buffered.length - 1) - videoElement.currentTime;
                    if (this.lastBufferHealth < 0.5) {
                        events.onBufferStarvation?.(this.lastBufferHealth);
                    }
                }

                events.onRebufferStart?.(videoElement.currentTime);
            });

            // Playing event (rebuffering end)
            videoElement.addEventListener('playing', () => {
                if (this.isDestroyed) return;

                // Mark that playback has started
                if (!this.hasStartedPlayback) {
                    this.hasStartedPlayback = true;
                    log(' Playback started (future waiting events will be counted as rebuffers)');
                }

                // Report rebuffer end if we were tracking one
                if (this.rebufferStartTime !== null) {
                    const duration = Date.now() - this.rebufferStartTime;
                    this.rebufferStartTime = null;

                    // Only report if stall was significant (> 100ms)
                    if (duration > 100) {
                        events.onRebufferEnd?.(videoElement.currentTime, duration);
                    }
                }
            });
        }

        // Error handling
        hls.on(this.HlsClass!.Events.ERROR, (_, data) => {
            if (!isCurrentHls()) return;
            this.handleHlsError(data);
        });
    }

    /**
     * Poll tick (~2s, see setupHlsEventHandlers) for the byte-verified
     * network-activity signal. Fires onVerifiedNetworkActivity only when the
     * currently-loading fragment's LIVE LoaderStats show genuine new bytes
     * since the last tick — unlike the DOM 'progress' event, this cannot be
     * spoofed by a dead-but-trickling connection with no real bytes arriving.
     */
    private pollFragBytesProgress(): void {
        if (this.isDestroyed || !this.currentFragBytesRef) return;
        const loaded = this.currentFragBytesRef.loaded;
        if (loaded > this.lastPolledFragBytes) {
            this.lastPolledFragBytes = loaded;
            this.config.events.onVerifiedNetworkActivity?.();
        }
    }

    /**
     * Detect codec from HLS manifest and compare with source
     */
    private detectCodecFromManifest(sourceCodec?: string, sourceBitrate?: number): void {
        if (!this.hls?.levels || this.hls.levels.length === 0) return;

        const { log, events } = this.config;
        const level = this.hls.levels[0];
        const videoCodec = level.videoCodec || level.codecSet?.split(',')[0] || '';

        if (!videoCodec || !sourceCodec) return;

        // Normalize codec names for comparison
        const normalizeCodec = (codec: string): string => {
            const c = codec.toLowerCase().split('.')[0];
            if (c.includes('avc') || c.includes('h264') || c === 'h.264') return 'h264';
            if (
                c.includes('hvc') ||
                c.includes('hev') ||
                c.includes('hevc') ||
                c.includes('h265') ||
                c === 'h.265'
            )
                return 'hevc';
            if (c.includes('av01') || c.includes('av1')) return 'av1';
            if (c.includes('vp9') || c.includes('vp09')) return 'vp9';
            return c;
        };

        const normalizedManifest = normalizeCodec(videoCodec);
        const normalizedSource = normalizeCodec(sourceCodec);
        const isActuallyTranscoding = normalizedManifest !== normalizedSource;

        const actualCodec = videoCodec
            .split('.')[0]
            .toUpperCase()
            .replace('HVC1', 'HEVC')
            .replace('HEV1', 'HEVC')
            .replace('AVC1', 'H264')
            .replace('AV01', 'AV1');

        const actualBitrate = level.bitrate || 0;

        log(' HLS manifest codec check:', {
            manifestCodec: videoCodec,
            sourceCodec,
            isActuallyTranscoding,
        });

        events.onCodecDetected?.({
            manifestCodec: videoCodec,
            sourceCodec,
            isActuallyTranscoding,
            formattedCodec: formatCodecInfo(sourceCodec, actualCodec, isActuallyTranscoding),
            bitrate: actualBitrate,
            // BANDWIDTH is a conservative peak allowance (40 Mbps minimum for
            // 1080p copy-HLS), not measured video bitrate. Never display it as
            // source/output bitrate; the separate stream meter measures delivery.
            formattedBitrate: formatBitrateInfo(sourceBitrate),
        });
    }

    /**
     * Handle HLS.js errors
     */
    private handleHlsError(data: ErrorData): void {
        // Whatever fragment was loading when this error fired is no longer
        // trustworthy — stop polling its stats for verified network activity.
        this.currentFragBytesRef = null;

        const { log, events } = this.config;
        this.recordHlsTraceFragment(
            'error',
            (data as ErrorData & { frag?: HlsTraceFragment }).frag,
            data.details,
        );

        // Suppress errors during quality switches
        if (this.suppressErrors) {
            log(' Suppressing error during quality switch:', data.details);
            return;
        }

        const responseCode =
            typeof data.response === 'number'
                ? data.response
                : (data.response as { code?: number })?.code;
        const headers = this.getLumastraDebugHeaders(
            (
                data as ErrorData & {
                    networkDetails?: XMLHttpRequest | Response;
                }
            ).networkDetails,
        );

        // HLS.js retries ordinary startup 503s by itself. Preserve only a
        // server-confirmed diagnostic for incident forensics; do not surface
        // it through onError, which would trigger a competing reconnect.
        if (isTranscodingNotReadyError(data.response) && !data.fatal) {
            const serverDiagnosticCode = parseStreamDiagnosticCode(headers.diagnosticCode);
            if (serverDiagnosticCode) {
                events.onTransientDiagnostic?.({
                    type: 'network',
                    message: 'Transcoding not ready',
                    recoverable: true,
                    httpStatus: responseCode,
                    stage: classifyHlsFailureStage(
                        data.details,
                        (data as ErrorData & { frag?: HlsTraceFragment }).frag?.type,
                        (data as ErrorData & { frag?: HlsTraceFragment }).frag?.sn,
                    ),
                    serverDiagnosticCode,
                });
            }
            log(' Transcoding not ready (503), hls.js will retry:', data.details);
            return;
        }

        log(' HLS.js error:', {
            type: data.type,
            details: data.details,
            fatal: data.fatal,
            response: responseCode,
            lumastra:
                headers.offset === null
                    ? undefined
                    : {
                          offset: headers.offset,
                          actual: headers.actual,
                          ready: headers.ready,
                          progress: headers.progress,
                          deleted: headers.deleted,
                          canSeek: headers.canSeek,
                          stream: headers.stream,
                          branch: headers.branch,
                          mode: headers.mode,
                          trigger: headers.trigger,
                      },
        });

        // 410 Gone = session expired/terminated. Don't retry — trigger full restart.
        if (responseCode === 410) {
            log(' Session expired (410), requesting full restart');
            events.onError?.({
                type: 'session_expired',
                message:
                    headers.sessionTerminal === 'true'
                        ? 'Stream session was stopped by the server'
                        : 'Stream session expired',
                recoverable: true,
                httpStatus: responseCode,
                sessionTerminal: headers.sessionTerminal === 'true',
                ...liveTvFailureField(data),
                stage: classifyHlsFailureStage(
                    data.details,
                    (data as ErrorData & { frag?: HlsTraceFragment }).frag?.type,
                    (data as ErrorData & { frag?: HlsTraceFragment }).frag?.sn,
                ),
                serverDiagnosticCode:
                    parseStreamDiagnosticCode(headers.diagnosticCode) ?? undefined,
            });
            return;
        }

        if (data.fatal) {
            this.handleFatalError(data);
        } else if (data.details === 'bufferStalledError') {
            // Non-fatal buffer stall
            events.onBufferStall?.();
        }
    }

    /**
     * Handle fatal HLS errors with recovery attempts
     */
    private handleFatalError(data: ErrorData): void {
        const { events } = this.config;
        const responseCode =
            typeof data.response === 'number'
                ? data.response
                : (data.response as { code?: number })?.code;
        const errorFragment = (data as ErrorData & { frag?: HlsTraceFragment }).frag;
        const headers = this.getLumastraDebugHeaders(
            (
                data as ErrorData & {
                    networkDetails?: XMLHttpRequest | Response;
                }
            ).networkDetails,
        );
        const stage = classifyHlsFailureStage(data.details, errorFragment?.type, errorFragment?.sn);
        const serverDiagnosticCode = parseStreamDiagnosticCode(headers.diagnosticCode) ?? undefined;

        switch (data.type) {
            case this.HlsClass!.ErrorTypes.NETWORK_ERROR:
                // Terminal HTTP statuses (404 not-found, 401/403 auth, 429 stream
                // limit) will NEVER recover by retrying — surface a clear error
                // immediately instead of burning MAX_RECOVERY_ATTEMPTS (which looks
                // like endless buffering) and then showing a misleading generic
                // "check your connection" / "session ended". 404 specifically means
                // the media file is gone or was never there (e.g. a discovery item
                // with no local file); 429 means the manifest fetch was refused
                // because the per-user parallel-stream limit is already reached.
                if (triageNetworkStatus(responseCode) === 'terminal') {
                    events.onError?.({
                        type: 'network',
                        message: describeManifestRefusal(responseCode, serverDiagnosticCode),
                        recoverable: false,
                        httpStatus: responseCode,
                        stage,
                        serverDiagnosticCode,
                    });
                    break;
                }
                // A manifest that never loaded cannot be nudged. The loop below
                // re-kicks `hls.startLoad()`, which resumes level/fragment
                // loading on a PARSED manifest; after a fatal manifestLoadError
                // it sends nothing, so no further ERROR event arrives, the
                // attempt counter never advances, and the loop never reaches
                // its `onError` exit — the player sits silent with no badge and
                // no error (measured 2026-09-11: a controlled 503 on the
                // manifest, five hls.js retries, then 60 s of nothing). Hand
                // it to the controller now: its reconnect path carries the
                // HTTP diagnostics and can rebuild the session, which is the
                // only recovery that re-requests a manifest.
                if (stage === 'manifest' && data.details?.startsWith('manifest')) {
                    events.onError?.({
                        type: 'network',
                        message: 'The stream playlist could not be loaded',
                        details: data.details,
                        recoverable: true,
                        httpStatus: responseCode,
                        stage,
                        serverDiagnosticCode,
                    });
                    break;
                }
                this.networkErrorRecoveryAttempts++;
                if (this.networkErrorRecoveryAttempts <= MAX_RECOVERY_ATTEMPTS) {
                    events.onNetworkRecoveryAttempt?.(
                        this.networkErrorRecoveryAttempts,
                        MAX_RECOVERY_ATTEMPTS,
                    );
                    // Progressive backoff: 1.5s, 3s, 6s (exponential, more gradual than linear)
                    const backoffMs = Math.min(
                        1500 * Math.pow(2, this.networkErrorRecoveryAttempts - 1),
                        10000,
                    );
                    const hlsAtSchedule = this.hls;
                    setTimeout(() => {
                        // Generation guard: load() reuses this PlaybackManager and
                        // resets isDestroyed=false, so a stale backoff timer from a
                        // previous stream must not startLoad() on the NEW hls.
                        if (!this.isDestroyed && this.hls === hlsAtSchedule) {
                            this.hls?.startLoad();
                        }
                    }, backoffMs);
                } else {
                    events.onError?.({
                        type: 'network',
                        message: 'Network error - check your connection',
                        recoverable: false,
                        httpStatus: responseCode,
                        stage,
                        serverDiagnosticCode,
                    });
                }
                break;

            case this.HlsClass!.ErrorTypes.MEDIA_ERROR:
                this.mediaErrorRecoveryAttempts++;
                if (this.mediaErrorRecoveryAttempts <= MAX_RECOVERY_ATTEMPTS) {
                    const handled = events.onMediaRecoveryAttempt?.(
                        this.mediaErrorRecoveryAttempts,
                        MAX_RECOVERY_ATTEMPTS,
                        data.details,
                    );
                    if (handled === true) {
                        // Handler rebuilt the HLS instance — skip the built-in
                        // recoverMediaError() and short-circuit further retries
                        // so the fatal path doesn't fire after recovery.
                        this.mediaErrorRecoveryAttempts = MAX_RECOVERY_ATTEMPTS + 1;
                    } else if (!this.isDestroyed) {
                        this.hls?.recoverMediaError();
                    }
                } else {
                    events.onError?.({
                        type: 'media',
                        message: `Playback error: ${data.details}`,
                        details: data.details,
                        recoverable: false,
                        stage,
                    });
                }
                break;

            default:
                events.onError?.({
                    type: 'fatal',
                    message: `Playback error: ${data.details}`,
                    details: data.details,
                    recoverable: false,
                    stage,
                });
                break;
        }
    }

    /**
     * Switch audio track in HLS stream
     *
     * @param trackIndex - Index of the audio track to switch to
     * @returns true if switch was successful via HLS, false if stream restart needed
     */
    switchAudioTrack(trackIndex: number, targetLanguage?: string): boolean {
        if (!this.hls?.audioTracks || this.hls.audioTracks.length <= 1) {
            return false;
        }

        const hlsTrackIndex = targetLanguage
            ? this.hls.audioTracks.findIndex(
                  (t) =>
                      t.lang === targetLanguage ||
                      t.name?.toLowerCase().includes(targetLanguage.toLowerCase()),
              )
            : trackIndex;

        if (hlsTrackIndex >= 0 && hlsTrackIndex !== this.hls.audioTrack) {
            this.config.log(' Switching hls.js audio track:', {
                from: this.hls.audioTrack,
                to: hlsTrackIndex,
                targetLang: targetLanguage,
            });
            this.hls.audioTrack = hlsTrackIndex;
            return true;
        }

        return false;
    }

    /**
     * Get current bandwidth estimate
     */
    getBandwidthEstimate(): number | null {
        return this.hls?.bandwidthEstimate ?? null;
    }

    /** hls.js levels and the one playing (-1 while unknown); null on native HLS. */
    getAdaptiveLevels(): {
        levels: Array<{ height: number; bitrate: number }>;
        current: number;
    } | null {
        if (!this.hls) return null;
        return {
            levels: this.hls.levels.map((level) => ({
                height: level.height,
                bitrate: level.bitrate,
            })),
            current: this.hls.currentLevel,
        };
    }

    /**
     * Get HLS audio tracks
     */
    getAudioTracks(): MediaPlaylist[] {
        return this.hls?.audioTracks ?? [];
    }

    /**
     * Re-kick HLS fragment loading. Used by the ReconnectController to resume
     * loading after HLS.js has exhausted its own retry budget.
     */
    restartLoad(): void {
        if (this.isDestroyed) return;
        this.hls?.startLoad();
    }

    /**
     * True when playback is running on native Safari HLS (no Hls instance).
     * The ReconnectController uses this to escalate a persistent stall to a
     * fresh-session rebuild, since restartLoad() cannot recover native playback.
     */
    isNativeEngine(): boolean {
        return this.usingNativeHls;
    }

    /**
     * True while resetForSeek() is reloading the source. It paused the element
     * itself and resumes it on its own, so the controller must not read that
     * `pause` as the user pausing.
     */
    isSeekResetInFlight(): boolean {
        return this.seekResetInFlight;
    }

    /**
     * Destroy the playback manager and cleanup resources.
     * @param skipVideoReset - When true, omit the remove-src + load() step.
     *   Pass true when destroy() is called immediately before loading new
     *   content: the upcoming load() will reset the element anyway.
     */
    destroy(skipVideoReset = false): void {
        this.isDestroyed = true;
        this.sourceGeneration++;
        this.deferredNativeStart = null;
        this.cleanupDeferredPlayListener();
        if (this.partySeekRecoveryTimer) clearTimeout(this.partySeekRecoveryTimer);
        this.partySeekRecoveryTimer = null;
        this.partySeekBurstCount = 0;
        this.partySeekTimes = [];

        // Cleanup event handlers
        this.cleanupNativeSeekResetHandler();
        this.cleanupFineTuneHandler();
        this.cleanupVideoReadyPlayHandler();
        this.cleanupDirectPlayErrorHandler();
        this.cleanupVisibilityHandler();

        if (this.fragBytesPollTimer) {
            clearInterval(this.fragBytesPollTimer);
            this.fragBytesPollTimer = null;
        }
        this.currentFragBytesRef = null;

        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }

        // For Safari native HLS: clear the video source to stop segment fetching
        // Without this, Safari continues requesting segments after the player is closed
        const { videoElement } = this.config;
        if (videoElement) {
            videoElement.pause();
            if (!skipVideoReset) {
                // Remove the attribute, never `src = ''`: an empty src resolves
                // to the page URL and WebKit fires MediaError 4 ("Empty src
                // attribute") at the still-attached onerror handler, which then
                // reported a bogus playback incident and probed the session on
                // every close. Without a src, load() aborts the fetch and
                // fires no error (same as clearVideoSource()).
                videoElement.removeAttribute('src');
                videoElement.load(); // Abort pending network requests
            }
        }

        // Reset state
        this.networkErrorRecoveryAttempts = 0;
        this.mediaErrorRecoveryAttempts = 0;
        this.suppressErrors = false;
        this.seekResetInFlight = false;
        this.pendingSeekResetPosition = null;
        this.pendingSeekResetIsVideoCopyMode = false;
        this.pendingSeekResetDeferResume = false;
        this.pendingResumeAfterSeekReset = null;
    }

    /**
     * Start loading (for recovery)
     */
    startLoad(): void {
        this.hls?.startLoad();
    }

    /** Mitigate Safari native A/V drift after explicit party seek bursts.
     * A single seek uses Safari's ordinary seek path. Three seeks within one
     * second schedule one reload, coalesced to the latest target, within 1.2s.
     * Audible real-Safari verification is still required for this mitigation.
     */
    recoverNativePartySeekBurst(position: number): void {
        if (!this.config.isSafari || !this.isNativeEngine() || this.currentMode !== 'hls') return;
        const now = Date.now();
        if (this.partySeekBurstCount === 0 || now - this.partySeekLastAt > 1000) {
            if (!this.partySeekRecoveryTimer) {
                this.partySeekBurstStartedAt = now;
                this.partySeekBurstCount = 0;
                this.partySeekBurstRecovered = false;
            }
        }
        this.partySeekLastAt = now;
        this.partySeekTimes = this.partySeekTimes.filter((at) => now - at <= 1000);
        this.partySeekTimes.push(now);
        this.partySeekBurstCount = this.partySeekTimes.length;
        this.partySeekRecoveryTarget = position;
        if (this.nativeSeekResetHandler) {
            this.currentStartPosition = position;
            this.pendingSeekResetPosition = position;
            this.pendingSeekResetDeferResume = true;
            return;
        }
        if (this.partySeekBurstCount < 3 || this.partySeekBurstRecovered) return;
        if (!this.partySeekRecoveryTimer) this.partySeekBurstStartedAt = this.partySeekTimes[0];
        if (this.partySeekRecoveryTimer) clearTimeout(this.partySeekRecoveryTimer);
        const generation = this.sourceGeneration;
        const delay = Math.max(0, Math.min(250, 1200 - (now - this.partySeekBurstStartedAt)));
        this.partySeekRecoveryTimer = setTimeout(() => {
            this.partySeekRecoveryTimer = null;
            this.partySeekBurstRecovered = true;
            if (
                this.isDestroyed ||
                this.sourceGeneration !== generation ||
                !this.config.videoElement.paused
            )
                return;
            this.resetForSeek(this.partySeekRecoveryTarget, false, true, true);
        }, delay);
    }

    /**
     * Reset HLS loading state for a seek to a new position.
     *
     * For out-of-buffer seeks after a server-side FFmpeg restart, hls.js can
     * keep stale demuxed-audio state and request a phantom segment at
     * (newOffset + oldRelativeCursor). A plain startLoad(position) is not
     * always enough to clear that state.
     *
     * Rebuild only the Hls instance on the SAME <video> element.
     * This clears stale demuxed-audio controller state more aggressively while
     * avoiding a full player teardown or replacing the media element.
     */
    resetForSeek(
        position: number,
        isVideoCopyMode = false,
        deferResume = false,
        nativeBurstRecovery = false,
    ): void {
        this.startupPositionResolver = undefined;
        const { videoElement, log } = this.config;

        if (this.seekResetInFlight) {
            this.currentStartPosition = position;
            if (this.currentUrl && this.currentMode === 'hls') {
                this.currentUrl = this.withSeekParam(this.currentUrl, position);
            }
            this.pendingSeekResetPosition = position;
            this.pendingSeekResetIsVideoCopyMode = isVideoCopyMode;
            this.pendingSeekResetDeferResume = deferResume;
            log(' HLS seek reset already in flight, updated target to', position.toFixed(2) + 's');
            return;
        }

        // Safari native HLS with copy-mode video: reload source so the server
        // can serve a new VOD playlist with EXTINF values matching FFmpeg's
        // post-seek segment grid.  Without this, cumulative EXTINF drift causes
        // PGS subtitle desync because Safari derives video.currentTime from
        // EXTINF sums, not fMP4 tfdt.
        // Transcode mode reloads only for the explicit native burst mitigation.
        if (!this.hls) {
            if (this.pendingHlsSourceGeneration === this.sourceGeneration) {
                this.currentStartPosition = position;
                if (this.currentUrl)
                    this.currentUrl = this.withSeekParam(this.currentUrl, position);
                return;
            }
            // Source still waiting for the first tap: move its start, attach nothing
            // (attaching outside a gesture is what makes iOS loop).
            if (this.deferredNativeStart) {
                this.currentStartPosition = position;
                if (this.currentUrl)
                    this.currentUrl = this.withSeekParam(this.currentUrl, position);
                log(' Deferred native source: start moved to', position.toFixed(2) + 's');
                return;
            }
            if (!isVideoCopyMode && !nativeBurstRecovery) return;
            if (!this.currentUrl || this.currentMode !== 'hls') return;
            const generation = ++this.sourceGeneration;
            log(' Safari native resetForSeek: reloading source at', position.toFixed(2) + 's');
            this.cleanupFineTuneHandler();
            this.cleanupNativeSeekResetHandler();

            // A queued seek inherits the original play intent: the preceding
            // source reload already paused the element on our behalf.
            const wasPlaying = this.pendingResumeAfterSeekReset || !videoElement.paused;
            this.seekResetInFlight = true;
            this.pendingSeekResetPosition = null;
            this.pendingSeekResetIsVideoCopyMode = false;
            this.pendingSeekResetDeferResume = false;
            this.pendingResumeAfterSeekReset = wasPlaying && !deferResume;
            this.currentStartPosition = position;
            this.currentUrl = this.withSeekParam(this.currentUrl, position);

            videoElement.pause();
            this.config.events.onBeforeSourceChange?.();
            videoElement.src = this.currentUrl;

            const onLoaded = (): void => {
                if (this.isDestroyed || this.sourceGeneration !== generation) return;
                this.cleanupNativeSeekResetHandler();
                const pendingSeekResetPosition = this.pendingSeekResetPosition;
                if (pendingSeekResetPosition !== null && !nativeBurstRecovery) {
                    const pendingDeferResume = this.pendingSeekResetDeferResume;
                    this.pendingSeekResetPosition = null;
                    this.pendingSeekResetIsVideoCopyMode = false;
                    this.pendingSeekResetDeferResume = false;
                    this.seekResetInFlight = false;
                    log(
                        ' Safari native seek reset completed with newer pending target; reloading again at',
                        pendingSeekResetPosition.toFixed(2) + 's',
                    );
                    this.resetForSeek(
                        pendingSeekResetPosition,
                        // This in-flight native reload is already copy-mode.
                        // A small queued seek may arrive via the generic call
                        // with its default false; it still needs to finish it.
                        true,
                        pendingDeferResume,
                    );
                    return;
                }
                // Use currentStartPosition (not closure) in case a rapid second
                // seek updated the target while we were waiting for metadata.
                const target = this.currentStartPosition ?? position;
                if (target > 0) {
                    videoElement.currentTime = target;
                }
                this.seekResetInFlight = false;
                this.pendingSeekResetPosition = null;
                const shouldResume = this.pendingResumeAfterSeekReset;
                this.pendingResumeAfterSeekReset = null;
                if (shouldResume) {
                    videoElement.play().catch(() => {});
                }
                this.config.events.onLoadingChange?.(false);
            };
            this.nativeSeekResetHandler = onLoaded;
            videoElement.addEventListener('loadedmetadata', onLoaded);
            // Bound the mitigation's in-flight flag, while retaining its late
            // metadata listener and newest target. Ordinary copy reloads retain
            // their existing late metadata resume semantics.
            if (nativeBurstRecovery) {
                this.nativeSeekResetTimeout = setTimeout(() => {
                    if (this.sourceGeneration !== generation) return;
                    this.nativeSeekResetTimeout = null;
                    this.seekResetInFlight = false;
                }, 8000);
            }
            videoElement.load();
            return;
        }

        if (!this.currentUrl || this.currentMode !== 'hls') {
            log(' HLS resetForSeek fallback: missing URL or non-HLS mode');
            this.hls.startLoad(position);
            return;
        }
        log(' HLS resetForSeek: rebuilding HLS instance at', position.toFixed(2) + 's');

        const wasPlaying = this.pendingResumeAfterSeekReset || !videoElement.paused;
        this.seekResetInFlight = true;
        this.pendingSeekResetPosition = null;
        this.pendingSeekResetIsVideoCopyMode = false;
        this.pendingSeekResetDeferResume = false;
        this.pendingResumeAfterSeekReset = wasPlaying && !deferResume;
        this.currentStartPosition = position;
        this.currentUrl = this.withSeekParam(this.currentUrl, position);
        this.startHlsRequestTrace('seek-reset', position);

        try {
            videoElement.pause();
            this.cleanupFineTuneHandler();
            this.cleanupVideoReadyPlayHandler();
            this.cleanupVisibilityHandler();
            this.suppressErrors = true;
            this.hls.destroy();
            this.hls = null;

            // Fully flush the existing MediaSource/buffered media from the same
            // <video> element before re-attaching a new HLS instance. Without
            // this, stale demuxed audio from the old seek position can survive
            // long enough to be requested/played after a later long seek.
            videoElement.removeAttribute('src');
            videoElement.load();

            this.isDestroyed = false;

            void this.initializeHls(this.currentUrl).catch((error: Error) => {
                this.seekResetInFlight = false;
                this.pendingResumeAfterSeekReset = null;
                this.suppressErrors = false;
                this.emitError({
                    severity: 'recoverable',
                    error,
                    context: 'HLS seek reset rebuild failed',
                    source: 'restore',
                });
            });
        } catch (error) {
            this.seekResetInFlight = false;
            this.pendingResumeAfterSeekReset = null;
            this.suppressErrors = false;
            log(
                ' HLS resetForSeek fallback: startLoad only',
                error instanceof Error ? error.message : String(error),
            );
            this.hls?.startLoad(position);
        }
    }

    /**
     * Recover from media error
     */
    recoverMediaError(): void {
        this.hls?.recoverMediaError();
    }

    /**
     * Check if HLS.js is currently active (non-Safari browsers)
     */
    isHlsActive(): boolean {
        return this.hls !== null;
    }

    /**
     * Check if we're in HLS mode (either hls.js or native Safari HLS)
     * This is true for any HLS stream, regardless of whether hls.js or native player is used
     */
    isHlsMode(): boolean {
        return this.currentMode === 'hls';
    }

    /**
     * Prepare for stream restart (quality change, audio track change, etc.)
     * This destroys the current stream and resets the video element.
     *
     * @returns Object with saved playback state to restore after restart
     */
    prepareForRestart(): { savedPosition: number; wasPlaying: boolean } {
        const { videoElement, log } = this.config;

        // Save current state
        const savedPosition = videoElement.currentTime;
        const wasPlaying = !videoElement.paused;

        log(' PlaybackManager.prepareForRestart:', {
            savedPosition: savedPosition.toFixed(2) + 's',
            wasPlaying,
        });

        // Pause and reset video element (remove src, never `src = ''`: see destroy())
        videoElement.pause();
        videoElement.removeAttribute('src');
        videoElement.load();

        // Destroy HLS/direct play
        this.destroy();
        this.isDestroyed = false; // Reset so we can reload

        return { savedPosition, wasPlaying };
    }

    /**
     * Restore playback state after restart
     * Call this after load() completes
     *
     * @param savedState State from prepareForRestart()
     * @param seekToPosition Position to seek to (may differ from saved if adjusted)
     */
    restoreAfterRestart(savedState: { wasPlaying: boolean }, seekToPosition: number): void {
        const { videoElement, log } = this.config;

        log(' PlaybackManager.restoreAfterRestart:', {
            seekTo: seekToPosition.toFixed(2) + 's',
            willPlay: savedState.wasPlaying,
        });

        // Seek to position
        if (seekToPosition > 0) {
            videoElement.currentTime = seekToPosition;
        }

        // Resume if was playing
        if (savedState.wasPlaying) {
            this.play().catch((err: Error) => {
                // Browser may block autoplay after a quality-switch restart.
                // This is expected behavior, not an error requiring user notification. (ref: DL-004)
                this.emitError({
                    severity: 'swallowed',
                    error: err,
                    context: 'Autoplay blocked after quality switch restart',
                    source: 'restore',
                });
            });
        }
    }

    /**
     * Single error exit point for all catch blocks in PlaybackManager.
     * Always logs; forwards to onPlayError only for fatal and recoverable severity.
     * Swallowed errors are logged only; each call site documents why the error does not require user notification. (ref: DL-004)
     */
    private emitError(info: PlaybackErrorInfo): void {
        this.config.log(' [PlaybackError]', info.severity, info.source, info.error.message);
        if (info.severity !== 'swallowed') {
            this.config.events.onPlayError?.(info.error);
        }
    }
}

/**
 * Create a new PlaybackManager instance
 */
/** Video elements that have reached 'playing' at least once. */
const playedElements = new WeakSet<HTMLVideoElement>();

function trackPlayedElement(videoElement: HTMLVideoElement): void {
    if (playedElements.has(videoElement)) return;
    videoElement.addEventListener('playing', () => playedElements.add(videoElement), {
        once: true,
    });
}

/**
 * Whether the page is inside a user gesture (transient activation). Browsers
 * without navigator.userActivation report true, keeping their old behaviour.
 */
function hasUserActivation(): boolean {
    if (typeof navigator === 'undefined') return true;
    const activation = (navigator as { userActivation?: { isActive: boolean } }).userActivation;
    return activation ? activation.isActive : true;
}

export function createPlaybackManager(config: PlaybackManagerConfig): PlaybackManager {
    return new PlaybackManager(config);
}
