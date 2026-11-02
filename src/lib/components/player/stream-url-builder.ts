// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stream URL Builder
 *
 * Centralized logic for building playback URLs including:
 * - Direct Play URLs
 * - LiveTV stream URLs
 */

import type { PlayerState } from './playerStore.svelte';
import type { MediaSourceInfo } from '$lib/types/playback';
import type { TranscodeReason } from '$lib/schemas/playback-plan';
import { canPlayDirectly } from './browserCapabilities.svelte';
import { detectHdrFormat } from './player-utils';
import {
    formatCodecInfo,
    formatBitrateInfo,
    getFriendlyResolution,
} from '$lib/utils/media-display';
export { getDeviceId } from './device-id';

// ============================================================================
// Types
// ============================================================================

export interface StreamUrlConfig {
    /** Force transcoding even if direct play is possible */
    forceTranscode?: boolean;
    /** Start position in seconds (for resuming) */
    startPositionSeconds?: number;
    /** Current adaptive bitrate (null = source quality) */
    currentAdaptiveBitrate?: number | null;
}

export interface StreamUrlResult {
    /** The stream URL */
    url: string;
    /** Play method for this URL */
    playMethod: 'DirectPlay' | 'DirectStream' | 'Transcode';
    /** Transcoding info for display */
    transcodingInfo: TranscodingInfo;
    /** HDR info for display */
    hdrInfo: HdrInfo | null;
}

export interface TranscodingInfo {
    videoCodec: string;
    videoBitrate: string;
    resolution: string;
    isTranscoding: boolean;
    isAudioTranscoding: boolean;
    transcodeReasons: string[];
    transcodeReasonCodes: TranscodeReason[];
}

export interface HdrInfo {
    sourceFormat: string;
    outputFormat: string | null;
    isToneMapped: boolean;
}

export interface StreamUrlContext {
    state: PlayerState;
    isSafari: boolean;
    log: (...args: unknown[]) => void;
}

// ============================================================================
// URL Building Functions
// ============================================================================

/**
 * Build stream URL based on playback method and configuration.
 *
 * Only used for the legacy Jellyfin compat path. When lumastraInfo is available,
 * the player uses the server planner's delivery_path directly — see
 * player-controller.svelte.ts initializePlayback().
 */
export function buildStreamUrl(
    context: StreamUrlContext,
    config: StreamUrlConfig = {},
): StreamUrlResult | null {
    const { state, isSafari } = context;
    const { forceTranscode = false } = config;

    if (!state.currentMediaSource || !state.playSessionId) {
        return null;
    }

    const mediaSource = state.currentMediaSource;

    // Check for direct play
    const videoStream = mediaSource.videoStreams[0];
    const hasMultipleAudioTracks = (mediaSource.audioStreams?.length || 0) > 1;

    // Only Safari supports the HTML5 audioTracks API for switching audio in direct play.
    // Chrome/Firefox don't support this API, so we need HLS DirectStream for multi-audio files.
    const needsHlsForAudioSwitching = hasMultipleAudioTracks && !isSafari;

    const useDirectPlay =
        !forceTranscode &&
        !needsHlsForAudioSwitching &&
        mediaSource.supportsDirectPlay &&
        canPlayDirectly(videoStream?.codec || '', videoStream?.videoRange, mediaSource.container);

    if (useDirectPlay) {
        return buildDirectPlayUrl(context, mediaSource, state);
    }

    // No fallback HLS path — URLs come from lumastra-info.play_methods directly.
    return null;
}

/**
 * Build Direct Play URL
 */
function buildDirectPlayUrl(
    context: StreamUrlContext,
    mediaSource: MediaSourceInfo,
    state: PlayerState,
): StreamUrlResult {
    const { log } = context;
    const videoStream = mediaSource.videoStreams[0];

    log(' Using Direct Play', {
        codec: videoStream?.codec,
        range: videoStream?.videoRange,
        container: mediaSource.container,
    });

    const hdrInfo = detectHdrFormat(
        videoStream?.videoRangeType || '',
        videoStream?.videoRange || '',
    );

    return {
        url: buildDirectPlaybackUrl(state.itemId, mediaSource, state.playSessionId!),
        playMethod: 'DirectPlay',
        transcodingInfo: {
            videoCodec: formatCodecInfo(videoStream?.codec || '', '', false),
            videoBitrate: formatBitrateInfo(mediaSource?.bitrate || 0, 0, false),
            resolution: getFriendlyResolution(videoStream?.width || 0, videoStream?.height || 0),
            isTranscoding: false,
            isAudioTranscoding: false,
            transcodeReasons: [],
            transcodeReasonCodes: [],
        },
        hdrInfo: hdrInfo.sourceFormat
            ? {
                  sourceFormat: hdrInfo.sourceFormat,
                  outputFormat: null,
                  isToneMapped: false,
              }
            : null,
    };
}

function buildDirectPlaybackUrl(
    itemId: string | null,
    mediaSource: MediaSourceInfo,
    playSessionId: string,
): string {
    if (mediaSource.path) {
        try {
            const parsed = new URL(mediaSource.path, 'http://local');
            if (!parsed.searchParams.has('playSessionId')) {
                parsed.searchParams.set('playSessionId', playSessionId);
            }

            return mediaSource.path.startsWith('http://') || mediaSource.path.startsWith('https://')
                ? parsed.toString()
                : `${parsed.pathname}${parsed.search}${parsed.hash}`;
        } catch {
            // Fall through to the canonical local-file route below.
        }
    }

    const params = new URLSearchParams({
        fileId: mediaSource.id,
        playSessionId,
    });
    return `/api/playback/${itemId ?? ''}/file?${params.toString()}`;
}

