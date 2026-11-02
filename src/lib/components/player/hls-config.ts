// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * HLS.js configuration and constants
 */

import type { HlsConfig } from 'hls.js';

/** Maximum recovery attempts for network/media errors */
export const MAX_RECOVERY_ATTEMPTS = 3;

export interface HlsVodBufferSettings {
    maxBufferSize: number;
    maxBufferLength: number;
    maxMaxBufferLength: number;
    backBufferLength: number;
}

export const DEFAULT_HLS_VOD_BUFFER_SETTINGS: HlsVodBufferSettings = {
    maxBufferSize: 1_000_000_000,
    maxBufferLength: 600,
    maxMaxBufferLength: 1800,
    backBufferLength: 30,
};

const HLS_LIVE_BUFFER_SETTINGS: HlsVodBufferSettings = {
    maxBufferSize: 60 * 1000000,
    maxBufferLength: 30,
    maxMaxBufferLength: 60,
    backBufferLength: 30,
};

/**
 * Buffer settings for the audio-only rung. At 128 kbps, 1800 s is ~29 MB.
 *
 * hls.js ONLY. Safari never loads hls.js (playback-manager.ts:536) and these are
 * ignored on native HLS (:198), so iOS gets AVPlayer's own shallower buffer. Accepted
 * — do not work around it.
 */
export const AUDIO_ONLY_HLS_BUFFER_SETTINGS: HlsVodBufferSettings = {
    maxBufferSize: 96_000_000,
    maxBufferLength: 1800,
    maxMaxBufferLength: 3600,
    backBufferLength: 60,
};

/**
 * Build HLS.js configuration optimized for Jellyfin transcoding
 *
 * Key considerations:
 * - Reasonable timeouts (not too long - detect issues faster)
 * - Reduced retries (proxy already retries, let HLS.js detect failures faster)
 * - Good buffer sizes for reliability on variable connections
 * - Note: Quality adaptation doesn't exist in practice, so large buffers help smooth playback
 */
export function buildHlsConfig(
    isLive: boolean = false,
    vodBufferSettings: Partial<HlsVodBufferSettings> = {},
): Partial<HlsConfig> {
    const bufferSettings = isLive
        ? HLS_LIVE_BUFFER_SETTINGS
        : {
              ...DEFAULT_HLS_VOD_BUFFER_SETTINGS,
              ...vodBufferSettings,
          };

    return {
        // Worker & Performance
        enableWorker: true,
        debug: false,
        // Note: lowLatencyMode is for LL-HLS streams only, not standard live TV
        // Standard Jellyfin live TV uses regular HLS, so keep this disabled
        lowLatencyMode: false,
        // Disable interstitials controller — it interfered with fMP4 live stream
        // fragment loading in HLS.js 1.6.x (stream-controller stayed IDLE).
        // We use the full build (not hls.js/light) for multi-audio support.
        // @ts-expect-error enableInterstitials is not in the bundled HLS.js types but is a valid runtime option
        enableInterstitials: false,

        // IMPORTANT: Disable HLS.js native text track rendering
        // We manage subtitles manually via <track> elements and the TextTrack API.
        // If renderTextTracksNatively is true (default), HLS.js will manipulate TextTrack
        // modes during segment loading, interfering with our manual subtitle management.
        renderTextTracksNatively: false,

        // Live stream settings - keep closer to live edge but with enough buffer
        ...(isLive
            ? {
                  liveSyncDurationCount: 3, // Stay 3 segments behind live edge
                  liveMaxLatencyDurationCount: 6, // Max 6 segments behind before seeking to live
                  liveDurationInfinity: true, // Treat live stream duration as infinite
              }
            : {}),

        // Buffer settings - larger buffers help smooth out network hiccups
        // (quality adaptation doesn't exist in practice anyway)
        maxBufferLength: bufferSettings.maxBufferLength, // Buffer ahead
        maxMaxBufferLength: bufferSettings.maxMaxBufferLength, // Max buffer duration cap
        maxBufferSize: bufferSettings.maxBufferSize, // Buffer size cap
        maxBufferHole: 0.5, // Tolerate 0.5s gaps in buffer
        backBufferLength: bufferSettings.backBufferLength, // Keep behind current position

        // Fragment loading. Expressed as an explicit policy, NOT the legacy
        // `fragLoadingTimeOut` family, because hls.js maps that single value
        // onto BOTH `maxTimeToFirstByteMs` and `maxLoadTimeMs` — and XhrLoader
        // re-arms its timer on first byte only when the two DIFFER
        // (`config.timeout !== config.loadPolicy.maxLoadTimeMs`). With one
        // value, a fragment that needs longer than the cap is aborted no matter
        // how steadily it is arriving: `loadprogress` updates stats, never the
        // timer.
        //
        // A large copy-mode segment on a slow link can take longer than the
        // timeout even when the server delivers every byte promptly. Repeated
        // retries then abort the same download before it can complete.
        //
        // So: keep first-byte detection tight (a server that never answers is
        // still caught in 20s) and let a fragment that IS arriving take as long
        // as it needs. 120s is hls.js's own default for maxLoadTimeMs.
        fragLoadPolicy: {
            default: {
                maxTimeToFirstByteMs: 20000,
                maxLoadTimeMs: 120000,
                // Mirrors the retry budget/backoff the legacy fields expressed.
                // timeoutRetry keeps hls.js's zero-delay default: a timeout has
                // already waited maxLoadTimeMs, so there is nothing to back off.
                timeoutRetry: {
                    maxNumRetry: 4,
                    retryDelayMs: 0,
                    maxRetryDelayMs: 0,
                },
                errorRetry: {
                    maxNumRetry: 4,
                    retryDelayMs: 500,
                    maxRetryDelayMs: 16000,
                },
            },
        },

        // Manifest loading - reduced retries
        manifestLoadingTimeOut: 20000, // 20s timeout (reduced from 30s)
        manifestLoadingMaxRetry: 4, // Reduced from 10
        manifestLoadingRetryDelay: 500,

        // Level loading (quality variants) - reduced retries
        levelLoadingTimeOut: 20000, // Reduced from 30s
        levelLoadingMaxRetry: 4, // Reduced from 15
        levelLoadingRetryDelay: 500,

        // ABR (Adaptive Bitrate) settings
        startLevel: -1, // Auto-select starting quality
        abrEwmaDefaultEstimate: 5000000, // Assume 5 Mbps initially
        abrBandWidthFactor: 0.8, // Use 80% of measured bandwidth (conservative)
        abrBandWidthUpFactor: 0.7, // Be more conservative when switching up
        abrMaxWithRealBitrate: true, // Consider actual segment bitrate

        // Stall recovery - more aggressive to handle network hiccups
        nudgeOffset: 0.1, // Small nudge to recover from stalls
        nudgeMaxRetry: 10, // Try nudging 10 times before giving up (increased from 5)
        maxStarvationDelay: 6, // Max 6s starvation before error (increased from 4)
        maxLoadingDelay: 6, // Max 6s loading delay before error (increased from 4)
    };
}

/**
 * Check if an HLS error response indicates transcoding not ready
 */
export function isTranscodingNotReadyError(response: unknown): boolean {
    const responseCode =
        typeof response === 'number' ? response : (response as { code?: number })?.code;
    return responseCode === 503;
}
