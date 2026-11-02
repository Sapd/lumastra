// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Video Player Components
export { default as VideoPlayer } from './VideoPlayer.svelte';
export { default as PlayerSurface } from './PlayerSurface.svelte';
export { default as PlayerControls } from './PlayerControls.svelte';
export { default as PlayerOverlay } from './PlayerOverlay.svelte';
export { default as TrackSelector } from './TrackSelector.svelte';
export { default as QualitySelector } from './QualitySelector.svelte';
export { default as LiveTvOverlay } from './LiveTvOverlay.svelte';
export { default as ChannelSwitcher } from './ChannelSwitcher.svelte';
export { default as ToggleSwitch } from './ToggleSwitch.svelte';

// Player Store — Svelte 5 runes class with reactive state and derived values.
// Derived values (audioTracks, subtitleTracks, fullTitle, etc.) are now $derived
// fields on the PlayerStore class. Access via playerStore.audioTracks, etc.
export {
    playerStore,
    DEFAULT_TRANSCODING_PROFILES,
    LIVE_EDGE_THRESHOLD_SECONDS,
} from './playerStore.svelte';

export type { PlayerState, EffectiveNextItem } from './playerStore.svelte';

// Player Utilities — time formatting, bandwidth estimation, codec helpers.
export {
    detectHdrFormat,
    isHevcCodec,
    getSmoothedBandwidth,
    // formatTime, secondsToTicks, ticksToSeconds sourced from player-utils.ts. (ref: DL-006)
    formatTime,
    secondsToTicks,
    ticksToSeconds,
    INITIAL_STABILITY_PERIOD,
    SWITCH_DOWN_COOLDOWN,
    SWITCH_UP_COOLDOWN,
    BANDWIDTH_SAMPLE_COUNT,
    MIN_SAMPLES_BEFORE_SWITCH,
    MIN_ADAPTIVE_BITRATE,
    type HdrDetectionResult,
} from './player-utils';

// HLS Configuration
export { buildHlsConfig, MAX_RECOVERY_ATTEMPTS, isTranscodingNotReadyError } from './hls-config';

// Playback Decision Logic
export {
    // getPlayMethodLabel and getPlayMethodBadgeClass are exported separately below
    // because they live in playback-display.ts, not playback-decision.ts. (ref: DL-008)
    shouldForceTranscode,
    isSameQuality,
    buildCodecPreferenceList,
    type PlayMethod,
} from './playback-decision';

// Playback Display Helpers (UI formatting, not decision logic)
export { getPlayMethodLabel, getPlayMethodBadgeClass } from './playback-display';

// Subtitle Utilities
export {
    // Codec detection
    isPgsCodec,
    isAssCodec,
    isVobsubCodec,
    isTextCodec,
    isBurnInCodec,
    // Stream analysis
    analyzeSubtitleStream,
    subtitleRequiresBurnIn,
    isPgsSubtitle,
    isAssSubtitle,
    isVobsubSubtitle,
    // Display helpers
    positionSubtitleCues,
    getSubtitleDisplayName,
    // Constants
    PGS_CODECS,
    ASS_CODECS,
    VOBSUB_CODECS,
    BURN_IN_CODECS,
    TEXT_CODECS,
    // Types
    type SubtitleRenderMethod,
    type SubtitleAnalysis,
} from './subtitle-utils';

// Stream URL Building
export {
    buildStreamUrl,
    type StreamUrlConfig,
    type StreamUrlResult,
    type StreamUrlContext,
    type TranscodingInfo,
    type HdrInfo,
} from './stream-url-builder';

// Adaptive Bitrate Management
export {
    createAdaptiveBitrateState,
    resetAdaptiveBitrateState,
    setPlaybackStartTime,
    checkQualitySwitch,
    handleBufferStall,
    clearBandwidthSamples,
    formatBitrateMbps,
    isAtSourceQuality,
    getEffectiveBitrate,
    type AdaptiveBitrateState,
    type QualitySwitchResult,
    type AdaptiveBitrateConfig,
} from './adaptive-bitrate';

// Subtitle Renderer Management
export {
    SubtitleRendererManager,
    createSubtitleRendererManager,
    type SubtitleRendererConfig,
    type SubtitleContext,
} from './subtitle-renderer';

// Progress Reporting — types only; ProgressReporter class removed (use PlaySessionReporter)
export type {
    IProgressReporter,
    ProgressEventType,
    ProgressReportData,
    ProgressReporterConfig,
} from './progress-reporter.types';

// Device ID
export { getDeviceId } from './device-id';

// Watch Together Handlers
export {
    WatchTogetherHandlers,
    createWatchTogetherHandlers,
    createVideoControllerFromElement,
    type VideoController,
    type WatchTogetherHandlersConfig,
    type WatchTogetherHandlersState,
} from './watch-together-handlers';

// Playback Error Types — exported so consumers can discriminate error severity
// without importing from playback-manager.ts directly. (ref: DL-004)
export { type PlaybackErrorSeverity, type PlaybackErrorInfo } from './playback-manager';

// Playability metadata shared by the controller and its track adapters.
export { selectPlayerProbe, probeTrackRecommendation } from './player-probe';
export type { PlayerProbe, ProbeVersion, PlayerMethod } from './player-probe';
