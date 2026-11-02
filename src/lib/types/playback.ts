// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Video Playback Types (shared between client and server)
 *
 * Types are re-exported from Zod schemas in '$lib/schemas/playback-types'.
 * This file maintains backward compatibility while using schemas as the single source of truth.
 */

// Re-export all types from schemas
export type {
    TimelineChapter,
    TimelineSegment,
    MediaSegmentType,
    MediaSegment,
    NextEpisodeInfo,
    NextPlaylistItemInfo,
    PlaylistContext,
    TrickplayInfo,
    LiveTvProgramInfo,
    PlaybackInfo,
    MediaSourceInfo,
    PlaybackVariant,
    VideoStreamInfo,
    AudioStreamInfo,
    SubtitleStreamInfo,
    StreamOptions,
    PlaybackProgressReport,
    ProgressRequestBody,
    PlaybackEventType,
    QualityMode,
    TranscodingProfile,
} from '$lib/schemas/playback-types';

// Runtime constants for transcoding profiles
// These must remain in the types file as they are runtime values, not types

export const ORIGINAL_PROFILE = {
    maxBitrate: 0, // 0 = unlimited (use source bitrate)
    width: 0,
    height: 0,
    label: 'Original',
    mode: 'original',
} as const;

export const AUTO_PROFILE = {
    maxBitrate: 0, // Will be set dynamically based on bandwidth
    width: 0,
    height: 0,
    label: 'Auto',
    mode: 'auto',
} as const;

/**
 * Audio-only rung: the server drops the video stream entirely.
 *
 * `maxBitrate` is DISPLAY/TELEMETRY METADATA ONLY. Never send it as ?maxBitrate= —
 * the server would plan a 128 kbps *video* transcode. Selection happens by choosing
 * the `audio_only` play method.
 */
export const AUDIO_ONLY_PROFILE = {
    maxBitrate: 128_000,
    width: 0,
    height: 0,
    label: 'Audio only',
    mode: 'audio-only',
} as const;

export const DEFAULT_TRANSCODING_PROFILES = [
    {
        maxBitrate: 120000000,
        width: 3840,
        height: 2160,
        label: '4K - 120 Mbps',
    },
    { maxBitrate: 80000000, width: 3840, height: 2160, label: '4K - 80 Mbps' },
    {
        maxBitrate: 40000000,
        width: 1920,
        height: 1080,
        label: '1080p - 40 Mbps',
    },
    {
        maxBitrate: 20000000,
        width: 1920,
        height: 1080,
        label: '1080p - 20 Mbps',
    },
    {
        maxBitrate: 10000000,
        width: 1920,
        height: 1080,
        label: '1080p - 10 Mbps',
    },
    { maxBitrate: 8000000, width: 1280, height: 720, label: '720p - 8 Mbps' },
    { maxBitrate: 4000000, width: 1280, height: 720, label: '720p - 4 Mbps' },
    { maxBitrate: 2000000, width: 854, height: 480, label: '480p - 2 Mbps' },
    { maxBitrate: 1000000, width: 640, height: 360, label: '360p - 1 Mbps' },
    { maxBitrate: 500000, width: 426, height: 240, label: '240p - 500 Kbps' },
] as const;

// Minimum bitrate for adaptive mode (below this, playback becomes unusable)
export const MIN_ADAPTIVE_BITRATE = 400000; // 400 Kbps
