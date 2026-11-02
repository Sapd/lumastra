// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Transcoding Types
 *
 * Type definitions for the full FFmpeg transcoding mode feature.
 * Includes hardware capabilities, device profiles, and transcode decisions.
 * Also includes job state types for FFmpegTranscodeService.
 */

import type { EffectiveTranscodePlan } from './effective-transcode-plan.js';
import type { ChildProcess } from 'child_process';
import type { AudioTrackInfo, SubtitleTrackInfo } from '../../utils/hls-audio-injection.js';
import type { PlaybackPlan } from '$lib/schemas/playback-plan.js';
import type { EndSegmentCache } from '../hls/end-segment-cache.js';
import type { GopGrid } from '../hls/gop-grid.js';
import type { GopSegmentAssembler } from '../hls/gop-segment-assembler.js';
import type { SlowTranscodeReason, SlowTranscodeState } from './slow-transcode.js';

// ============================================================================
// Hardware Capabilities
// ============================================================================

export type GpuAcceleration = 'none' | 'nvenc' | 'qsv' | 'vaapi' | 'amf' | 'videotoolbox';

export interface HardwareCapabilities {
    /** Available video encoders from FFmpeg */
    encoders: string[];

    /** Available video decoders from FFmpeg */
    decoders: string[];

    /** Available hardware accelerators */
    hwaccels: string[];

    /** Available FFmpeg filters (for tonemapping, scaling, etc.) */
    filters: string[];

    /** FFmpeg version string */
    ffmpegVersion: string;

    /** Whether hardware capabilities have been detected */
    detected: boolean;
}

// ============================================================================
// Device Profiles (Jellyfin-compatible format)
// ============================================================================

export type ProfileConditionType =
    'Equals' | 'NotEquals' | 'EqualsAny' | 'LessThanEqual' | 'GreaterThanEqual';

export type ProfileConditionProperty =
    | 'VideoProfile'
    | 'VideoLevel'
    | 'VideoRangeType'
    | 'IsAnamorphic'
    | 'IsInterlaced'
    | 'AudioChannels'
    | 'AudioBitrate'
    | 'AudioProfile'
    | 'AudioSampleRate'
    | 'RefFrames'
    | 'Width'
    | 'Height'
    | 'IsSecondaryAudio'
    | 'NumStreams';

export interface ProfileCondition {
    Condition: ProfileConditionType;
    Property: ProfileConditionProperty;
    Value: string;
    IsRequired: boolean;
}

export type MediaType = 'Audio' | 'Video' | 'Photo';

export interface DirectPlayProfile {
    Container: string;
    Type: MediaType;
    VideoCodec?: string;
    AudioCodec?: string;
}

export interface TranscodingProfile {
    Container: string;
    Type: MediaType;
    VideoCodec?: string;
    AudioCodec?: string;
    Protocol: 'hls' | 'http' | '';
    Context: 'Streaming' | 'Static';
    MaxAudioChannels?: string;
    MinSegments?: number;
    BreakOnNonKeyFrames?: boolean;
    Conditions?: ProfileCondition[];
}

export interface CodecProfile {
    Type: 'Video' | 'Audio' | 'VideoAudio';
    Codec?: string;
    Container?: string;
    Conditions: ProfileCondition[];
    ApplyConditions?: ProfileCondition[];
}

export interface SubtitleProfile {
    Format: string;
    Method: 'External' | 'Embed' | 'Encode' | 'Hls' | 'Drop';
    /** Comma list of containers the profile applies to; empty = any. */
    Container?: string;
    /** Comma list of languages the profile applies to; empty = any. */
    Language?: string;
}

export interface ContainerProfile {
    Type: MediaType;
    Container?: string;
    Conditions: ProfileCondition[];
}

export interface ResponseProfile {
    Type: MediaType;
    Container: string;
    MimeType: string;
}

/**
 * Jellyfin-compatible device profile format.
 * These profiles define what a client device can play directly
 * and how to transcode when direct play isn't possible.
 */
export interface JellyfinDeviceProfile {
    Name?: string;
    EnableAlbumArtInDidl?: boolean;
    EnableSingleAlbumArtLimit?: boolean;
    EnableSingleSubtitleLimit?: boolean;
    SupportedMediaTypes?: string;
    MaxAlbumArtWidth?: number;
    MaxAlbumArtHeight?: number;
    MaxStreamingBitrate?: number;
    MaxStaticBitrate?: number;
    MusicStreamingTranscodingBitrate?: number;
    TimelineOffsetSeconds?: number;
    RequiresPlainVideoItems?: boolean;
    RequiresPlainFolders?: boolean;
    EnableMSMediaReceiverRegistrar?: boolean;
    IgnoreTranscodeByteRangeRequests?: boolean;
    DirectPlayProfiles: DirectPlayProfile[];
    TranscodingProfiles: TranscodingProfile[];
    ContainerProfiles: ContainerProfile[];
    CodecProfiles: CodecProfile[];
    SubtitleProfiles: SubtitleProfile[];
    ResponseProfiles?: ResponseProfile[];
}

/**
 * Simplified device profile for our transcode decision engine.
 * Adds User-Agent matching and a friendly ID system.
 */
export interface DeviceProfile extends JellyfinDeviceProfile {
    /** Unique profile identifier */
    id: string;

    /** Regex pattern to match User-Agent headers */
    userAgentMatch?: string;

    /** Whether this device supports HDR output */
    supportsHdr?: boolean;

    /** Whether this device supports Dolby Vision */
    supportsDolbyVision?: boolean;

    /** Whether this device supports Dolby Atmos */
    supportsAtmos?: boolean;

    /** Preferred output container */
    preferredContainer?: 'fmp4' | 'ts' | 'mp4';
}

// ============================================================================
// Transcode Decision
// ============================================================================

/**
 * Bitwise flags explaining why transcoding is required.
 * Multiple reasons can be combined (e.g., VideoCodecNotSupported | BitrateExceedsLimit).
 */
export enum TranscodeReason {
    None = 0,
    VideoCodecNotSupported = 1 << 0,
    AudioCodecNotSupported = 1 << 1,
    ContainerNotSupported = 1 << 2,
    ResolutionExceedsLimit = 1 << 3,
    BitrateExceedsLimit = 1 << 4,
    VideoRangeNotSupported = 1 << 5, // HDR on non-HDR device
    VideoProfileNotSupported = 1 << 6,
    VideoLevelNotSupported = 1 << 7,
    AudioChannelsNotSupported = 1 << 8,
    SecondaryAudioNotSupported = 1 << 9,
    InterlacedNotSupported = 1 << 10,
    AnamorphicNotSupported = 1 << 11,
    ForcedByConfig = 1 << 12,
    SyncIssueWorkaround = 1 << 13,
    RefFramesExceedsLimit = 1 << 14,
}

/**
 * Helper to get human-readable reason strings from TranscodeReason flags.
 */
export function getTranscodeReasonStrings(reasons: TranscodeReason): string[] {
    const result: string[] = [];
    if (reasons & TranscodeReason.VideoCodecNotSupported) result.push('VideoCodecNotSupported');
    if (reasons & TranscodeReason.AudioCodecNotSupported) result.push('AudioCodecNotSupported');
    if (reasons & TranscodeReason.ContainerNotSupported) result.push('ContainerNotSupported');
    if (reasons & TranscodeReason.ResolutionExceedsLimit) result.push('ResolutionExceedsLimit');
    if (reasons & TranscodeReason.BitrateExceedsLimit) result.push('BitrateExceedsLimit');
    if (reasons & TranscodeReason.VideoRangeNotSupported) result.push('VideoRangeNotSupported');
    if (reasons & TranscodeReason.VideoProfileNotSupported) result.push('VideoProfileNotSupported');
    if (reasons & TranscodeReason.VideoLevelNotSupported) result.push('VideoLevelNotSupported');
    if (reasons & TranscodeReason.AudioChannelsNotSupported)
        result.push('AudioChannelsNotSupported');
    if (reasons & TranscodeReason.SecondaryAudioNotSupported)
        result.push('SecondaryAudioNotSupported');
    if (reasons & TranscodeReason.InterlacedNotSupported) result.push('InterlacedNotSupported');
    if (reasons & TranscodeReason.AnamorphicNotSupported) result.push('AnamorphicNotSupported');
    if (reasons & TranscodeReason.ForcedByConfig) result.push('ForcedByConfig');
    if (reasons & TranscodeReason.SyncIssueWorkaround) result.push('SyncIssueWorkaround');
    if (reasons & TranscodeReason.RefFramesExceedsLimit) result.push('RefFramesExceedsLimit');
    return result;
}

export type TranscodeMode = 'direct' | 'full';
export type CodecAction = 'copy' | 'transcode';

/**
 * Hints from the lumastra-info planner that the transcode decision engine
 * should respect instead of re-deriving from device profile / User-Agent.
 *
 * When provided, the engine skips its own codec selection and uses the
 * planner's choices, while still handling GPU encoder selection and HDR.
 */
export interface PlanHints {
    /** Target video codec from the planner (e.g. 'h264', 'hevc', 'av1'). 'copy' means no video transcode. */
    targetVideoCodec?: string;
    /** Target audio codec from the planner (e.g. 'aac'). 'copy' means no audio transcode. */
    targetAudioCodec?: string;
}

export interface TranscodeDecision {
    /** Selected transcoding mode */
    mode: TranscodeMode;

    /** Bitwise flags explaining why this decision was made */
    reasons: TranscodeReason;

    /** What to do with the video stream */
    videoAction: CodecAction;

    /** What to do with the audio stream */
    audioAction: CodecAction;

    /** Target codecs if transcoding */
    targetCodec?: {
        video?: string;
        audio?: string;
    };

    /** Whether to use GPU acceleration */
    useGpu: boolean;

    /** Specific GPU encoder to use (e.g., 'h264_nvenc', 'hevc_qsv') */
    gpuEncoder?: string;

    /** Specific GPU decoder to use */
    gpuDecoder?: string;

    /** Whether HDR to SDR tonemapping is needed */
    needsTonemapping: boolean;

    /**
     * Whether tonemapping in the FINAL assembled ffmpeg args for this job ran
     * on the GPU or CPU — set from {@link resolveTonemapMode} after the args
     * are built, since subtitle burn-in can rewrite an already-emitted
     * hardware tonemap filter into a software one. Unset until the job's args
     * have actually been built at least once.
     */
    hdrTonemapMode?: 'hardware' | 'software' | 'n/a';

    /** Tonemapping algorithm to use */
    tonemappingAlgorithm?: string;

    /** Whether to preserve HDR10 output (DV → HDR10 fallback) */
    preserveHdr10: boolean;

    /** HDR10 metadata to pass through when preserveHdr10 is true */
    hdr10Metadata?: Hdr10Metadata;

    /** Output video range when transcoding (SDR, HDR10, HLG) */
    outputVideoRange?: 'SDR' | 'HDR10' | 'HLG';
}

// ============================================================================
// Media Source Info (for decision making)
// ============================================================================

/**
 * HDR10 static metadata for mastering display and content light levels.
 * Used for preserving HDR quality when transcoding DV → HDR10.
 */
export interface Hdr10Metadata {
    /** Mastering display color primaries and luminance (SMPTE ST 2086) */
    masteringDisplayMetadata?: string; // e.g., "G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)"

    /** Maximum Content Light Level (MaxCLL) and Maximum Frame-Average Light Level (MaxFALL) */
    maxCll?: string; // e.g., "1000,400" (MaxCLL,MaxFALL in cd/m²)

    /** Color primaries (bt709, bt2020, etc.) */
    colorPrimaries?: string;

    /** Transfer characteristics (bt709, smpte2084 for PQ, arib-std-b67 for HLG) */
    colorTransfer?: string;

    /** Color matrix coefficients (bt709, bt2020nc, etc.) */
    colorSpace?: string;

    /** Dolby Vision profile if source is DV */
    dvProfile?: number;

    /** Dolby Vision level */
    dvLevel?: number;

    /** Dolby Vision base layer compatibility ID */
    dvBlCompatId?: number;
}

export interface MediaStreamInfo {
    index: number;
    type: 'Video' | 'Audio' | 'Subtitle';
    codec?: string;
    profile?: string;
    level?: number;
    width?: number;
    height?: number;
    bitrate?: number;
    channels?: number;
    sampleRate?: number;
    isDefault?: boolean;
    isInterlaced?: boolean;
    isAnamorphic?: boolean;
    refFrames?: number;
    videoRange?: string; // 'SDR' | 'HDR' | 'HDR10' | 'HDR10+' | 'HLG' | 'DolbyVision'
    videoRangeType?: string;
    language?: string;
    title?: string;

    /** HDR10 metadata for video streams */
    hdr10Metadata?: Hdr10Metadata;

    /** Pixel format (e.g., yuv420p, yuv420p10le) */
    pixelFormat?: string;

    /** Bit depth (8, 10, 12) */
    bitDepth?: number;
}

export interface MediaSourceInfo {
    id: string;
    path?: string;
    container?: string;
    bitrate?: number;
    size?: number;
    streams: MediaStreamInfo[];
}

// ============================================================================
// HDR Source Classification
// ============================================================================

/**
 * Result of classifying a video source's HDR type from container metadata.
 * Used by the decision engine, transcode strategy, and playlist generator
 * to make consistent HDR decisions from a single code path.
 */
export interface HdrClassification {
    /** Whether the source carries any HDR signal (HDR10, HLG, or Dolby Vision) */
    isHdr: boolean;
    /** HDR10 or HDR10+ (PQ transfer) */
    isHdr10: boolean;
    /** Hybrid Log-Gamma */
    isHlg: boolean;
    /** Any Dolby Vision profile */
    isDolbyVision: boolean;
}

/**
 * The play method a transcode decision actually represents.
 *
 * `play_sessions.play_method` is written from the client's *requested* method at
 * session start, which is not always what the server ends up doing — the Stellar
 * tvOS client, for instance, reports `full_transcode` for every session including
 * plain stream copies. This maps the real decision onto the same vocabulary so the
 * stored value can be corrected once the job resolves.
 *
 * `direct` is never returned: a transcode job exists only when we are serving HLS,
 * so the floor is `remux` (container change with both streams copied).
 */
export function playMethodFromDecision(decision: {
    videoAction: CodecAction;
    audioAction: CodecAction;
}): 'remux' | 'audio_transcode' | 'full_transcode' {
    if (decision.videoAction === 'transcode') return 'full_transcode';
    if (decision.audioAction === 'transcode') return 'audio_transcode';
    return 'remux';
}

/**
 * What a Dolby Vision stream degrades to once the DV layer is gone.
 *
 * Our pipeline NEVER preserves DV: a remux loses the `dvvC` configuration box
 * (ffmpeg's mov muxer does not write it when copying HEVC out of Matroska) and a
 * re-encode drops the RPU. So every DV source is delivered as its base layer, and
 * the only question is what that base layer is.
 *
 * That is answered by `dv_bl_signal_compatibility_id`, NOT by the profile number:
 *   1 → HDR10 base    2 → SDR base    4 → HLG base    0 → none (pure DV)
 *
 * Keying on `dvProfile === 8` instead was wrong twice over: it missed profile 10
 * (DV over AV1), which is equally cross-compatible, and it lumped the SDR-base
 * variant (8.2) in with the HDR ones.
 *
 * @param blCompatId - dv_bl_signal_compatibility_id (0 when the probe didn't record it)
 * @param dvProfile  - DV profile number, used only as a fallback
 */
export function dvBaseLayerIsHdr(blCompatId: number, dvProfile?: number): boolean {
    // 2 = SDR base layer. It IS a usable fallback, but it is not HDR — treating it
    // as HDR would stamp an HDR10 tone curve onto SDR content.
    if (blCompatId === 2) return false;
    if (blCompatId === 1 || blCompatId === 4) return true;
    // Profile 8 is cross-compatible by definition (8.1/8.2/8.4). When the probe left
    // the id at 0 we can still trust the profile; 8.2 is vanishingly rare and the
    // explicit check above catches it whenever the id is actually present.
    return blCompatId === 0 && dvProfile === 8;
}

/** The HDR flavour a DV base layer carries, for output/manifest signalling. */
export function dvBaseLayerRange(blCompatId: number): 'HDR10' | 'HLG' | 'SDR' {
    if (blCompatId === 4) return 'HLG';
    if (blCompatId === 2) return 'SDR';
    return 'HDR10';
}

/**
 * Single source of truth for HDR source detection.
 *
 * Classifies whether a video source is HDR from Jellyfin-style videoRange /
 * videoRangeType strings and optional HDR10 metadata. Every code path that
 * needs to answer "is this source HDR?" should call this function instead
 * of doing ad-hoc string matching.
 *
 * Accepts uppercased or mixed-case strings — normalizes internally.
 */
export function classifyHdrSource(
    videoRange?: string,
    videoRangeType?: string,
    hdr10Metadata?: Hdr10Metadata,
): HdrClassification {
    const range = (videoRange || '').toUpperCase();
    const rangeType = (videoRangeType || '').toUpperCase();

    const isHlg = range.includes('HLG') || rangeType.includes('HLG');

    const isDolbyVision =
        range.includes('DOLBY') ||
        range.includes('DOLBYVISION') ||
        rangeType.includes('DOVI') ||
        hdr10Metadata?.dvProfile !== undefined;

    // PQ-based HDR: HDR10, HDR10+, or generic HDR / PQ labels
    const isHdr10 =
        range.includes('HDR10') ||
        range.includes('HDR') ||
        range.includes('PQ') ||
        rangeType.includes('HDR10') ||
        rangeType.includes('HDR') ||
        rangeType.includes('PQ');

    const isHdr = isHdr10 || isHlg || isDolbyVision;

    return { isHdr, isHdr10, isHlg, isDolbyVision };
}

// ============================================================================
// Encoder Selection
// ============================================================================

/**
 * Mapping of codec names to their hardware-accelerated encoder variants.
 */
export const CODEC_ENCODER_MAP: Record<string, Record<GpuAcceleration, string>> = {
    h264: {
        none: 'libx264',
        nvenc: 'h264_nvenc',
        qsv: 'h264_qsv',
        vaapi: 'h264_vaapi',
        amf: 'h264_amf',
        videotoolbox: 'h264_videotoolbox',
    },
    hevc: {
        none: 'libx265',
        nvenc: 'hevc_nvenc',
        qsv: 'hevc_qsv',
        vaapi: 'hevc_vaapi',
        amf: 'hevc_amf',
        videotoolbox: 'hevc_videotoolbox',
    },
    av1: {
        none: 'libsvtav1',
        nvenc: 'av1_nvenc',
        qsv: 'av1_qsv',
        vaapi: 'av1_vaapi',
        amf: 'av1_amf',
        videotoolbox: 'av1_videotoolbox', // Not yet available, fallback to software
    },
};

/**
 * Mapping of codec names to their hardware-accelerated decoder variants.
 */
export const CODEC_DECODER_MAP: Record<string, Record<GpuAcceleration, string>> = {
    h264: {
        none: 'h264',
        nvenc: 'h264_cuvid',
        qsv: 'h264_qsv',
        vaapi: 'h264',
        amf: 'h264', // AMF uses d3d11va hwaccel for decoding
        videotoolbox: 'h264',
    },
    hevc: {
        none: 'hevc',
        nvenc: 'hevc_cuvid',
        qsv: 'hevc_qsv',
        vaapi: 'hevc',
        amf: 'hevc', // AMF uses d3d11va hwaccel for decoding
        videotoolbox: 'hevc',
    },
    av1: {
        none: 'av1',
        nvenc: 'av1_cuvid',
        qsv: 'av1_qsv',
        vaapi: 'av1',
        amf: 'av1', // AMF uses d3d11va hwaccel for decoding
        videotoolbox: 'av1',
    },
};

// ============================================================================
// HLS Output Configuration
// ============================================================================

/**
 * HLS output format configuration.
 *
 * Controls container format, playlist type, audio muxing, and HLS version.
 * Callers pass these to produce Jellyfin-compatible (MPEG-TS muxed VOD) or
 * Apple TV-optimized (fMP4 demuxed EVENT) output.
 */
export interface HlsOutputConfig {
    /** Container format: fMP4 (.m4s) or MPEG-TS (.ts). Default: 'fmp4' */
    hlsContainer?: 'fmp4' | 'mpegts';
    /** Playlist type: EVENT (growing) or VOD (all segments known). Default: 'event' */
    hlsPlaylistType?: 'event' | 'vod';
    /** Audio mode: demux (separate renditions) or muxed (single stream). Default: 'demux' */
    hlsAudioMode?: 'demux' | 'muxed';
    /** For muxed mode: which audio track index to include (default: first/default track) */
    hlsAudioTrackIndex?: number;
    /** HLS protocol version (3=MPEG-TS compat, 7=fMP4). Default: 7 */
    hlsVersion?: 3 | 6 | 7;
}

// ============================================================================
// FFmpeg Transcode Job State (from ffmpeg-transcode.service.ts)
// ============================================================================

export interface TranscodeJobConfig {
    /** Persisted effective contract, including the generation's segment geometry. */
    effectivePlan?: EffectiveTranscodePlan;
    /**
     * Media item ID, verbatim from whichever mount created this job — NOT
     * always a canonicalized internal UUID: `internalId` on `/api`(/v1), the
     * raw (possibly dashless) `/j` URL param, a preview's resolved trailer-
     * child/Next-Up-episode id, and — for a `preview-cache-*` shared
     * artifact — whichever viewer first (or most recently re-) warmed it,
     * which is NOT necessarily the item any given later viewer of that same
     * artifact is playing (`media_file_items` is M:N). This is the field the
     * job->item binding check (fix plan 6, C1 — `services/hls/
     * job-item-binding.ts`) compares against a request's resolved+raw id
     * pair; see that module and `resolveJobPlaySessionId`'s doc for how a
     * cache-backed preview's OWN item is determined instead (its
     * `PreviewSession.itemId`, never this field).
     */
    itemId: string;
    /** Username of the requester */
    username: string;
    /** Device ID for session binding */
    deviceId: string;
    /** Play session ID */
    playSessionId: string;
    /** Primary input path (local file path to media) */
    inputUrl: string;
    /** Audio tracks to include */
    audioTracks: AudioTrackInfo[];
    /** Subtitle tracks to include in master playlist (text-based only) */
    subtitleTracks?: SubtitleTrackInfo[];
    /** Selected file ID (needed for subtitle URLs) */
    fileId?: string;
    /**
     * SOURCE video stream info. Every field here describes the file being read,
     * NOT the encode being produced — `outputCodec` is the single exception and
     * is marked as such. Populating any of these with a target value silently
     * corrupts decisions made downstream: `codec` + `bitDepth` key the GPU
     * decode-capability deny-map on a learn-on-failure exit, and `height` drives
     * the CPU 1080p downscale cap (see computeMaxDimensions).
     */
    videoInfo?: {
        /** Source codec as probed (e.g. 'h264', 'hevc') — never the encode target. */
        codec: string;
        /** Source pixel width — never the output cap. */
        width: number;
        /** Source pixel height — never the output cap. */
        height: number;
        /** Output codec (if transcoding, this is the target codec) */
        outputCodec?: string;
        /** Video dynamic range: SDR, HDR, HDR10, HLG, etc. */
        videoRange?: string;
        /** Video range type from Jellyfin: SDR, HDR10, HLG, DOVIWithHDR10, etc. */
        videoRangeType?: string;
        /** Average frame rate (e.g., 23.976, 24, 29.97, 60) for HLS FRAME-RATE attribute */
        frameRate?: number;
        /** Dolby Vision profile number (5, 7, 8) for correct CODECS string */
        dvProfile?: number;
        /** Dolby Vision level (typically 6 for 4K60) */
        dvLevel?: number;
        /** Base layer signal compatibility ID (0 = not compatible) */
        dvBlSignalCompatibilityId?: number;
        /**
         * Whether video is being transcoded (vs direct stream copy).
         * Used for HLS CODECS string generation.
         */
        isTranscoded?: boolean;
        /**
         * Whether HDR metadata is preserved during transcoding (full mode FFmpeg).
         * - true + HDR source → HEVC Main 10 profile codec string + VIDEO-RANGE=PQ
         * - false → HEVC Main profile codec string (8-bit SDR, tone-mapped)
         */
        preserveHdr?: boolean;
        /**
         * SOURCE video bit depth (8, 10, 12). Used to detect 10-bit SDR (Main 10
         * profile) and to scope GPU decode-capability lessons. Leave it unset only
         * when genuinely unknown — an absent depth makes a learn-on-failure exit
         * un-keyable and the lesson is discarded rather than over-applied.
         */
        bitDepth?: number;
        /** Video profile name (e.g. 'Main', 'Main 10', 'High'). */
        profile?: string;
        /**
         * Source video codec level as general_level_idc (HEVC: 120 = L4.0,
         * 153 = L5.1). On the copy path the CODECS string declares this real
         * level instead of the transcoder's fixed L153, so strict decoders
         * (Firefox/Linux) don't reject an over-declared level. Absent → L153.
         */
        level?: number;
    };
    /** Start position in seconds */
    startTimeSeconds?: number;
    /**
     * Media ranges (seconds) that EARLIER generations of this playback session
     * transcoded — a seek hands them on (transcode-coverage.ts); the current
     * generation's own range is derived, not stored. Kept in the config so it
     * is persisted with the job row: a restore after a deploy and a read from
     * another pod see the same coverage as the owner.
     */
    coveredRanges?: [number, number][];
    /** Total duration in seconds (for VOD manifest generation) */
    totalDurationSeconds?: number;
    /** Effective segment duration for this job. In copy mode, matches the source
     *  keyframe interval so audio and video have the same cadence (no offset
     *  translation needed). In transcode mode, uses FFMPEG_SEGMENT_DURATION. */
    segmentDurationSeconds?: number;

    /**
     * Pre-probed keyframe PTS values (seconds) for copy/remux video.
     * Used to generate accurate VOD playlist segment durations instead of
     * synthetic uniform estimates. Without this, cumulative EXTINF drift
     * causes hls.js to compute wrong segment numbers on seek.
     *
     * Only required when video is copied (not transcoded). When transcoding,
     * FFmpeg creates keyframes at exact segment boundaries.
     */
    keyframeData?: number[];

    /**
     * Demux copy-video "GOP mode" (services/hls/gop-grid.ts): FFmpeg writes one
     * file per keyframe and the assembler joins them into keyframe-grid entries.
     * Decided once at job start and carried into every generation; it also
     * switches `segmentOffset`/`segmentsReady` to grid-entry units. Persisted with
     * the config, so a restored job keeps the same mode.
     */
    gopSegments?: boolean;

    // Trickplay Support for HLS
    trickplayInfo?: {
        width: number;
        height: number;
        tileWidth: number;
        tileHeight: number;
        thumbnailCount: number;
        interval: number;
        bandwidth: number;
    };

    // Full Transcoding Mode
    transcodeMode?: 'full';
    localFilePath?: string;
    /**
     * When true, the localFilePath is an FFmpeg concat demuxer list file.
     * FFmpeg will be invoked with -f concat -safe 0 before -i.
     * Used for split-file playback (e.g. Part1.mkv + Part2.mkv).
     */
    useConcatDemuxer?: boolean;
    /**
     * Path to the temporary concat list file created for split-file playback.
     * Stored here so the service can delete it when the job is stopped (after
     * FFmpeg no longer needs it).  Must NOT be deleted before the job ends —
     * FFmpeg re-reads the concat list at every part boundary.
     */
    concatTmpFile?: string;
    deviceProfileId?: string;
    userAgent?: string;
    mediaSourceInfo?: MediaSourceInfo;
    /** Plan hints from lumastra-info planner — when set, the decision engine respects
     *  these codec choices instead of re-deriving from device profile / User-Agent. */
    planHints?: PlanHints;
    /** Resolved PlaybackPlan — when present, executor uses consumePlan() instead of decide().
     *  Takes precedence over planHints and device profile decisions. */
    playbackPlan?: PlaybackPlan;

    /**
     * When true, always transcode audio to AAC even if the source codec is
     * HLS-compatible (e.g. AC3/EAC3).  Used by the lumastra endpoint when the
     * client requests audioCodec=aac so that Chrome/non-Safari browsers can
     * play the stream.
     */
    forceAudioTranscode?: boolean;

    /**
     * Subtitle burn-in configuration.
     * When set, the specified subtitle stream is overlaid onto the video
     * via FFmpeg filter_complex. Forces video transcode (can't burn into copied video).
     * Hardware decode is disabled (overlay operates on CPU frames) but GPU encode still works.
     *
     * Used when:
     * - Client sends SubtitleStreamIndex + SubtitleMethod=Encode
     * - Bitmap subtitles (DVBSub, XSUB) with no client-side renderer
     * - Client explicitly requests server-side rendering for any subtitle type
     */
    subtitleBurnIn?: {
        /** Absolute stream index in the media file (FFmpeg 0:N notation) */
        absoluteIndex: number;
        /** Subtitle codec name (for logging) */
        codec?: string;
        text?: { filePath: string; relativeIndex: number };
    };

    /**
     * Drop the video stream entirely (audio-only rung). Emits -vn; no video codec,
     * filter, or bitrate args. `buildAudioOnlyArgs` returns before any subtitle
     * burn-in logic runs, so `subtitleBurnIn` is silently ignored when this is set.
     */
    videoDisabled?: boolean;

    /**
     * Per-request quality cap (see `quality-cap.ts`). When set and the source
     * exceeds either bound, forces a video transcode (no copy/remux) even if
     * the client asked for one, and constrains the encode's video bitrate
     * (VBV cap) and output resolution. Included in `hasPlaybackConfigChanged`
     * so a cap change restarts the job instead of reusing one made with
     * different caps.
     */
    qualityCap?: { maxBitrate?: number; maxHeight?: number };

    /**
     * The client's audio channel cap (`?maxAudioChannels`). A transcoded audio
     * track is downmixed to at most this many channels; the caller already
     * forced the transcode (`forceAudioTranscode`) for any delivered track that
     * exceeds it. Included in `hasPlaybackConfigChanged`.
     */
    maxAudioChannels?: number;

    // Encoding Quality Overrides (for preview mode, etc.)
    /** Override software encoding preset (e.g., 'veryfast', 'fast') - defaults to config.ENCODING_PRESET */
    encodingPreset?: string;
    /** Override NVENC preset (e.g., 'p1', 'p2') - defaults to config.NVENC_PRESET */
    nvencPreset?: string;

    /**
     * Hover-preview job. The preview is a self-contained, short-lived
     * transcode whose playlist begins at the seek point — there is no
     * "before the offset" timeline, so segments must be numbered from 0
     * (FFmpeg `-start_number 0`) and the per-stream offset must stay 0.
     * Without this, FFmpeg writes `segment_00064.m4s` and the manifest
     * advertises `EXT-X-MEDIA-SEQUENCE:64`; hls.js then maps seq×targetDur
     * to absolute time and `startLoad(0)` fetches a non-existent
     * `segment_00000.m4s`, which the segment handler interprets as a
     * backward seek and restarts FFmpeg from position 0.
     */
    isPreview?: boolean;

    /**
     * Per-job duration cap override in seconds (ffmpeg `-t`). Used by trailer
     * previews, which play full-length (TRAILER_MAX_SECONDS) instead of the
     * 30s hover snippet. When absent, preview jobs fall back to the global
     * PREVIEW_TRANSCODE_MAX_SECONDS clamp.
     */
    maxDurationSeconds?: number;

    /** When set, the job writes its (single-generation) HLS output into this exact
     *  directory instead of the derived per-session dir. Used by the preview cache,
     *  whose artifacts are shared and therefore must never be re-generated in place. */
    outputDir?: string;
    /** Preview cache key this job is warming; lets onExit flip the artifact
     *  ready/failed in the PreviewCacheStore. */
    cacheKey?: string;

    /**
     * Force the GPU software-decode bridge (software decode → hwupload) for this
     * one job, independent of the learned deny-map. Set by the transcode service
     * when a GPU job failed twice with a surface mismatch that lacked a genuine
     * decode-capability signature (likely transient GPU pressure): the job is
     * rescued through the bridge WITHOUT persisting a lesson, so a busy-GPU episode
     * never poisons a decodable codec for future jobs. Not set from client input.
     */
    forceSoftwareDecodeBridge?: boolean;

    /**
     * The GPU encoder (e.g. 'hevc_nvenc') this job gave up on because it could
     * not open an encode session — another app (game streaming, OBS, instant
     * replay) holds the encoder, or the driver's session limit is reached. Set
     * by the transcode service's exit handler; from then on this job encodes in
     * software at the same output size. Not set from client input.
     */
    softwareEncodeFallback?: string;

    // I-Frame Playlist Support (Apple TV)
    isJellyfinTranscoded?: boolean;

    // HLS Output Format Configuration
    /** HLS output format options (container, playlist type, audio mode, version) */
    hlsOutput?: HlsOutputConfig;
}

// ============================================================================
// Job Status Constants
// ============================================================================

/**
 * Result of waiting for an in-progress seek to complete.
 * Distinguishes "seek needed" from "already covered" and "failed".
 */
export type SeekWaitResult = 'proceed' | 'covered' | 'failed';

/**
 * Job status constants to avoid magic strings in code.
 * Use these instead of hardcoded string literals in SQL queries and conditionals.
 *
 * Example:
 *   if (job.status === JobStatus.Running) { ... }
 *   WHERE status = ${JobStatus.Stopped}
 */
export const JobStatus = {
    Starting: 'starting',
    Running: 'running',
    Ready: 'ready',
    Stopping: 'stopping',
    Stopped: 'stopped',
    Error: 'error',
} as const;

/**
 * Type derived from JobStatus values for type safety.
 */
export type JobStatusValue = (typeof JobStatus)[keyof typeof JobStatus];

export const GenerationRole = {
    Current: 'current',
    Previous: 'previous',
} as const;

export type GenerationRoleValue = (typeof GenerationRole)[keyof typeof GenerationRole];

export interface PlaybackSession {
    playSessionId: string;
    currentJobId?: string;
    previousJobId?: string;
    retainedJobIds: string[];
    nextGenerationIndex: number;
    createdAt: Date;
    lastAccessedAt: Date;
}

// ============================================================================
// Transcode Job
// ============================================================================

export interface TranscodeJob {
    /** Actual -start_number captured from the argv given to this generation. */
    ffmpegOutputStartNumber?: number;
    /** Coalesces simultaneous recovery requests for one inconsistent generation. */
    outputStartRecoveryPromise?: Promise<boolean>;
    /** Unique job ID */
    id: string;
    /** Job configuration */
    config: TranscodeJobConfig;
    /** Output directory */
    outputDir: string;
    /** Session root directory containing all generation outputs */
    sessionOutputDir: string;
    /** Monotonic generation index within a playback session */
    generationIndex: number;
    /** Whether this generation is the active one or the retained previous one */
    generationRole: GenerationRoleValue;
    /** FFmpeg process */
    process: ChildProcess | null;
    /** Job status */
    status: 'starting' | 'running' | 'ready' | 'stopping' | 'stopped' | 'error';
    /** Error message if status is 'error' */
    error?: string;
    /** When the job was started */
    startedAt: Date;
    /**
     * When this job object became live *in this process* — the anchor for the
     * never-watched reaper's grace period, and ONLY for that.
     *
     * For a fresh job this equals `startedAt`. For a job restored from
     * persistence (rolling deploy, container restart) it is the restore time,
     * while `startedAt` deliberately keeps the ORIGINAL session start so admin
     * reporting still shows true job age.
     *
     * The distinction matters because the never-watched heuristic keys off
     * `lastServedSegment`, which is per-process and therefore always empty on
     * the restoring pod. Anchoring its grace period to `startedAt` made every
     * restored job instantly reapable — the reaper then deleted the DB row and
     * the session 410'd for good. See cleanupInactiveJobs.
     */
    unwatchedGraceAnchor: Date;
    /** When the job was last accessed (for inactivity cleanup based on segment requests) */
    lastAccessedAt: Date;
    /**
     * When the last progress heartbeat (of ANY status — ACTIVE or PAUSED) was
     * received from the client. Drives the reaper's "is anyone still connected
     * at all" decision (`shouldReapJob`), where a paused-but-alive client
     * MUST keep the job from being fully torn down — that's the whole point
     * of heartbeating through a pause. Do NOT use this to decide who to
     * sacrifice under eviction pressure — see `lastActiveProgressAt`.
     *
     * NOT client-only: the process runner also bumps it on every FFmpeg
     * progress line, so it stays fresh for as long as FFmpeg encodes, client
     * or no client. Use `lastClientHeartbeatAt` to ask "is the client still
     * there".
     */
    lastProgressAt: Date;
    /**
     * When the last progress heartbeat from the CLIENT reached this pod (any
     * status), or the job object was created. Unlike `lastProgressAt`, FFmpeg
     * never touches it. Drives the client-gone reaper arm in
     * cleanupInactiveJobs, together with `lastAccessedAt` and the DB row's
     * `last_progress_at` (where a heartbeat routed to another pod lands).
     */
    lastClientHeartbeatAt: Date;
    /**
     * When the last progress heartbeat reporting status ACTIVE (not PAUSED)
     * was received — i.e., genuinely playing, not just present. Unlike
     * `lastProgressAt`, this does NOT advance while paused, so a long-paused
     * session ages normally instead of looking permanently fresh. This is the
     * signal `selectEvictionVictim` uses (combined with `lastAccessedAt`) to
     * pick who to sacrifice when a concurrency cap is reached — `lastProgressAt`
     * alone would make an indefinitely-paused session un-evictable forever,
     * the same failure shape a paused tab's keepalive caused for the
     * stream-limit policy (fixed there in `be05ab4c0`), just here in the
     * transcode-job eviction path instead.
     */
    lastActiveProgressAt: Date;
    /**
     * Client activity another pod recorded on this job's DB row
     * (`last_progress_at`: a heartbeat the router hashed elsewhere, or a
     * segment served from disk by a non-owner pod), copied in by each reaper
     * sweep. Without it the owner's in-memory signals can both look stale
     * while the viewer is watching through another pod, and the global cap's
     * idle floor would treat that job as idle. Undefined until the first sweep.
     */
    lastPersistedClientActivityAt?: Date;
    /** Whether master playlist is ready */
    masterPlaylistReady: boolean;
    /** Number of segments transcoded (approximate, based on FFmpeg progress) */
    segmentsReady: number;
    /** Last FFmpeg-reported processing FPS. */
    transcodeFps?: number;
    /** Last FFmpeg-reported processing speed multiplier. */
    transcodeSpeed?: number;
    /**
     * Window state for {@link updateLiveRates} (live-rates.ts): where the
     * current speed/fps measurement started, and whether a windowed rate has
     * replaced FFmpeg's since-start average yet. Reset per process.
     */
    rateSample?: {
        measured: boolean;
        anchor?: { at: number; mediaSeconds: number; frames?: number };
    };
    /**
     * Whether this process keeps up with real time (slow-transcode.ts).
     * Reset per process and on every throttle pause/resume.
     */
    slowTranscode?: SlowTranscodeState;
    /** Tracks the highest segment index served per stream directory */
    lastServedSegment: Map<string, number>;
    /**
     * Media time (seconds from the start of the file) covered by the newest
     * segment the client requested, per stream directory. Latest, not highest:
     * a backward seek must pull the player position back. Feeds the transcode
     * throttle, which compares it with what FFmpeg has produced. Seconds rather
     * than an index because remux, transcode and keyframe-aligned streams each
     * number their segments differently.
     */
    requestedMediaSeconds?: Map<string, number>;
    /**
     * Set while the transcode throttle holds FFmpeg stopped (SIGSTOP) because
     * it is far enough ahead of the player. Undefined while FFmpeg runs.
     */
    throttledAt?: Date;
    /** True only while the throttle has successfully SIGSTOPped FFmpeg. */
    throttlePaused?: boolean;
    /** Segment demand, independent of player/FFmpeg progress heartbeats. */
    lastSegmentRequestedAt?: number;
    /**
     * Set while a retained generation is parked: stopped (SIGSTOP, with
     * `throttledAt` set so every kill path continues it first) because another
     * generation is the one being read. The throttle tick leaves a parked job
     * alone; only a reclaim or a kill continues it.
     *
     * - `unwatched`: demoted by a backward seek before it served a single
     *   segment. A Jellyfin client resuming at position T requests segment 0
     *   first and then jumps to T: the generation already running at T was
     *   abandoned for a probe. A request back near its offset reclaims it.
     * - `superseded`: the probe generation a reclaim demoted. Not reclaimable;
     *   the retained-generation TTL retires it.
     */
    parked?: 'unwatched' | 'superseded';
    /** When `parked` was set; bounds how long a parked-unwatched generation waits. */
    parkedAt?: Date;
    /**
     * Epoch ms before which the throttle must not pause this job: set when a
     * segment request had to wait for FFmpeg, so a mis-measured lead cannot
     * re-pause the process while that request is still waiting.
     */
    throttleHoldUntil?: number;
    /** Tracks which segment indices have been deleted per stream */
    deletedUpTo: Map<string, number>;
    /** Segment offset for seek-ahead handling */
    segmentOffset: number;
    /** Effective segment duration for this job in seconds.
     *  Copy mode: source keyframe interval or 10s default (matches video cadence).
     *  Transcode mode: FFMPEG_SEGMENT_DURATION (6s, controls both audio and video). */
    segmentDurationSeconds: number;
    /** Flag to prevent concurrent seeks */
    isSeeking: boolean;
    /**
     * True when killFFmpeg escalated SIGTERM → SIGKILL for this job.
     * Distinguishes our intentional SIGKILL fallback from kernel-initiated
     * SIGKILL (OOM, external cleanup). Set inside killFFmpeg before the
     * escalation; read in handleExit's signal branch.
     */
    killEscalated?: boolean;
    /**
     * True once killFFmpeg has signalled this job's process — set BEFORE the
     * SIGTERM, so it is already visible when the exit lands.
     *
     * This is the only *deterministic* record that the termination was ours.
     * `status === 'stopping'` is the usual tell, but it is a mutable field that
     * the ladder's retry branches restore to `wasStatus`, and the segment/tail
     * teardown paths do not all set it — so an exit that we caused can still
     * arrive with a running-looking status. FFmpeg answers a SIGTERM by
     * flushing the current segment and exiting **255 with no signal** (it
     * handles the signal itself), which is indistinguishable from a genuine
     * error exit unless we remember that we asked. Ten of the fifteen rows on
     * the prod transcode-failures page were exactly that: normal stops filed as
     * FFmpeg failures. Read in handleExit's `isIntentional`.
     */
    killRequested?: boolean;
    /** Set by shutdown retirement before killFFmpeg; meaningful once killRequested is true. */
    shutdownKillRequested?: boolean;
    /**
     * This FFmpeg process exited 0 without us asking: it read its input to the
     * end, so a segment its closed
     * manifest lacks will never exist. A stop we caused also closes the
     * manifest (SIGTERM flushes and writes ENDLIST), which is why the closed
     * manifest alone proves nothing (nor does a restore adopting closed
     * output). Cleared at every spawn: ladder respawns reuse the job object.
     * Read by the segment handler's past-end check.
     */
    reachedEndOfInput?: boolean;
    /**
     * True once this job has been transparently re-spawned with the GPU
     * software-decode bridge after a hardware-decode surface mismatch
     * (learn-on-failure). Prevents an infinite retry loop if the bridge attempt
     * also fails. See the GPU retry branch in spawnFFmpeg's handleExit.
     */
    gpuBridgeRetried?: boolean;
    /**
     * True once this job has been transparently re-spawned once with the exact
     * same (unbridged) hardware-decode args after a surface-mismatch exit, to
     * distinguish a genuine per-codec decode incapability from a transient
     * failure (e.g. the GPU was at its concurrent-session limit). Only a SECOND
     * surface-mismatch failure whose stderr carries the STRICT decode-capability
     * signature (isLearnableGpuDecodeFailure) is taught to
     * {@link HardwareDetectionService.markSourceNotHardwareDecodable}; a second
     * failure lacking that signature bridges the single job via
     * {@link TranscodeJobConfig.forceSoftwareDecodeBridge} without learning, and a
     * successful plain retry leaves the codec untouched. See the GPU retry branch
     * in spawnFFmpeg's handleExit.
     */
    hwDecodeRetried?: boolean;
    /** Counter for seek operations */
    seekCount: number;
    /** Debug: what triggered the last seek (e.g. "forward:stream_2:seg336") */
    lastSeekTrigger: string;
    /** Timestamp (ms) when the current FFmpeg process was spawned. Used to detect
     *  stale segment files from a previous FFmpeg run (pre-seek) via mtime comparison. */
    lastFFmpegSpawnTime: number;
    /**
     * Timestamp (ms) of the spawn `lastFFmpegSpawnTime` replaced, or `null` on the
     * job's first spawn. `applyStaleSegmentGuard`'s mtime-freshness check uses the
     * gap between the two to bound how much clock-skew tolerance it can safely
     * grant: on a rapid respawn (retry loop, quick failure) the gap can be smaller
     * than the tolerance window, and without this a leftover segment file from
     * THIS previous generation could still land inside that window and be served
     * as if it belonged to the new one.
     */
    previousFFmpegSpawnTime?: number | null;
    /**
     * 1-based count of FFmpeg spawns for THIS job object. The recovery ladder in
     * handleExit tracks its state with two booleans rather than a counter, so this
     * is the only ordering signal a failure row can carry.
     *
     * NOTE: a seek builds a NEW job object, so this restarts mid-session. Failure
     * chains are therefore ordered by (play_session_id, occurred_at), never by this.
     */
    spawnAttempt: number;
    /**
     * Per-stream HLS TARGETDURATION from FFmpeg manifests.
     * Video in remux mode has ~10s segments (keyframe-aligned) while audio has ~6s.
     * Used to compute per-stream segment offsets and correct segment counts.
     */
    streamTargetDurations: Map<string, number>;
    /**
     * Optional per-stream segment offsets when a stream has a distinct cadence
     * from the job's base segment duration.
     */
    streamSegmentOffsets?: Map<string, number>;

    // I-Frame Analysis (for direct stream mode)
    iframeData: IFrameEntry[];
    iframeAnalyzedCount: number;
    iframeAnalysisComplete: boolean;

    /** Transcode decision for this job (if using full mode or auto mode) */
    transcodeDecisionResult?: TranscodeDecision;

    /**
     * Original requested non-zero start/seek time before any copy-mode keyframe
     * alignment is applied. Used only for sync diagnostics.
     */
    requestedStartTimeSeconds?: number;

    /**
     * Whether this generation came from initial startup, a later seek, or the
     * initial origin position. Used only for sync diagnostics.
     */
    syncTraceOrigin?: 'origin' | 'startup' | 'seek';

    /**
     * Tracks which streams already emitted a one-time sync diagnostic for this
     * generation so logs stay readable.
     */
    syncTraceLoggedStreams: Set<string>;

    /**
     * Pre-probed keyframe PTS values (seconds) for copy/remux video.
     * Used by VOD playlist generation to compute accurate per-segment durations.
     * Undefined when video is transcoded (keyframes at exact boundaries).
     */
    keyframeData?: number[];

    /**
     * GOP mode (config.gopSegments; services/hls/gop-grid.ts). The grid is built
     * once per job from keyframeData; the assembler joins this generation's
     * per-keyframe parts into `stream_<i>/segment_*.m4s`. `gopBroken` is set when
     * the assembler refuses to build a shifted entry — the job then fails closed.
     * `gopLastFfmpegSeconds` keeps the stall watchdog fed from FFmpeg's `time=`
     * while `segmentsReady` comes from the assembler.
     */
    gopGrid?: GopGrid;
    gopAssembler?: GopSegmentAssembler;
    gopBroken?: string;
    gopLastFfmpegSeconds?: number;

    /**
     * Built by restoreJob from a persisted row. The earlier incarnation may have
     * served segments (and an init segment) under its encoder that this process
     * never saw, so `segmentsReady === 0` does not mean "nothing was served":
     * the software-encode fallback must not switch encoders behind them.
     */
    restoredFromPersistence?: boolean;

    /**
     * Cache of end-of-stream segments for instant serving after seek.
     * Maps streamDir (e.g., 'stream_0') → ONE buffer and the playlist entry it
     * answers (services/hls/end-segment-cache.ts); any other index misses.
     *
     * hls.js probes the last VOD segment during seek for duration detection.
     * After a seek, FFmpeg restarts and hasn't produced the end yet. Without
     * this cache, the probe blocks audio for 60+ seconds until FFmpeg catches up.
     * The cached segment has valid PTS (~end of file) regardless of seek position.
     */
    endSegmentCache: EndSegmentCache;

    /**
     * AbortController for the background tail-cache FFmpeg worker.
     * Set when a tail-cache worker is spawned; aborted in retireJobGeneration
     * so the worker process is killed on stop, seek, eviction, or supersede.
     * Null when no tail-cache worker is running.
     */
    tailCacheAbortController: AbortController | null;
}

/**
 * I-frame entry for HLS I-frame playlist.
 * Represents a single keyframe position within a segment.
 */
export interface IFrameEntry {
    /** Segment index (0-based) */
    segmentIndex: number;
    /** Relative URI to the segment file (e.g., "stream_2/segment_00005.m4s") */
    segmentUri: string;
    /** Byte offset within the segment file */
    byteOffset: number;
    /** Number of bytes to read for this keyframe */
    byteSize: number;
    /** Duration in seconds until the next keyframe */
    duration: number;
    /** Absolute timestamp in the stream (seconds) */
    timestamp: number;
}

export interface TranscodeJobStatus {
    jobId: string;
    status: TranscodeJob['status'];
    segmentsReady: number;
    masterPlaylistReady: boolean;
    error?: string;
    elapsedSeconds: number;
}

export interface PlayerTranscodeProgressInfo {
    /** Share of the file this session has transcoded (coverage, not FFmpeg's position). */
    progressPercent: number;
    segmentsReady: number;
    totalSegments: number;
    elapsedSeconds: number;
    fps?: number;
    speed?: number;
    /** FFmpeg is paused because it is far enough ahead of the player. */
    throttled?: boolean;
    /**
     * Seconds of media FFmpeg has produced ahead of the newest segment the
     * player requested. Undefined until the player has requested a segment.
     */
    bufferAheadSeconds?: number;
    /** Seconds until FFmpeg reaches the end at its current speed (wall clock). */
    etaSeconds?: number;
    /** Transcoded parts of the file in % — progressPercent is their (rounded-down) sum. */
    coveredRanges?: { start: number; end: number }[];
    /** Where FFmpeg currently is, % of the file. */
    encoderPercent?: number;
    /**
     * The same union as the admin surface, and not a narrower one: this is filled
     * from `getAllActiveJobsInfoMultiPod`, which reads the SHARED
     * `active_transcode_jobs` table, so every value that table can produce can
     * arrive here. `formatTranscodeType` in `PlayerOverlay.svelte` has a `default:`
     * arm, so an unexpected kind degrades to "unknown" rather than rendering blank.
     */
    transcodeType?: TranscodeDisplayType;
    videoAction?: 'copy' | 'transcode';
    audioAction?: 'copy' | 'transcode';
    isHardwareAccelerated?: boolean;
    gpuEncoder?: string;
    gpuDecoder?: string;
    hdrTonemapMode?: 'hardware' | 'software' | 'n/a';
    /**
     * The encode has run below real time for a while (slow-transcode.ts):
     * `gpu_busy` when the GPU encoder is shared with another app, `cpu_slow`
     * for a software encode the CPU cannot keep up with. Absent when fine.
     */
    slowReason?: SlowTranscodeReason;
    /** The GPU encoder this job fell back from because it had no free session. */
    softwareFallbackFrom?: string;
}

export interface VodManifestInfo {
    totalDurationSeconds: number;
    segmentDurationSeconds: number;
    totalSegments: number;
    segmentsReady: number;
    /**
     * Pre-computed segment durations from keyframe data for copy/remux video.
     * When present, VOD playlist uses these instead of synthetic uniform durations.
     * Only set for copy-mode video — transcode mode has exact keyframe boundaries.
     */
    keyframeSegmentDurations?: number[];
    /**
     * Keyframe segment index that covers the FFmpeg start time.
     * Used as streamOffset when keyframeSegmentDurations is present,
     * because keyframe segments diverge from uniform segment numbering.
     */
    keyframeStreamOffset?: number;
    isComplete: boolean;
    /** Current segment offset (FFmpeg segment 0 = VOD segment segmentOffset) */
    segmentOffset: number;
    /** FFmpeg start time for the current generation. */
    startTimeSeconds?: number;
}

/**
 * What an admin sees as the KIND of a transcode.
 *
 * `active_transcode_jobs` is shared by more than the video pipeline, so this is
 * not derivable from a `TranscodeDecision` alone: an audiobook remux has no video
 * stream and therefore no decision, and would otherwise fall through `'unknown'`
 * into the `'full'` fallback and be displayed as a full video transcode.
 *
 * Mirrored by `FFmpegJobInfoSchema.mode` / `.transcodeType` in
 * `$lib/schemas/admin-types.ts` — widen both together or the API strips the value.
 */
export type TranscodeDisplayType =
    | 'remux'
    /** Video COPIED, audio transcoded. NOT the same as 'audio-drop'. */
    | 'audio-only'
    /** Video DROPPED entirely (-vn). The audio-only rung. */
    | 'audio-drop'
    | 'full'
    | 'tonemapping'
    | 'audiobook-remux'
    | 'unknown';

/**
 * FFmpeg job information for admin display (serializable)
 */
export interface FFmpegJobInfo {
    jobId: string;
    playSessionId: string;
    itemId: string;
    username: string;
    deviceId: string;
    status: TranscodeJob['status'];
    mode: TranscodeDisplayType;
    error?: string;

    // Timing
    startedAt: string;
    elapsedSeconds: number;
    lastAccessedAt: string;
    lastAccessedSecondsAgo: number;
    lastProgressAt: string;
    lastProgressSecondsAgo: number;

    // Progress
    segmentsReady: number;
    segmentOffset: number;
    totalSegments: number;
    /** This job's segment length: copy-mode jobs use 10 s, not the global setting. */
    segmentDurationSeconds: number;
    progressPercent: number;
    masterPlaylistReady: boolean;
    isSeeking: boolean;
    seekCount: number;

    // Video
    videoCodec?: string;
    videoOutputCodec?: string;
    resolution?: string;
    videoRange?: string;

    // Audio
    audioTrackCount: number;
    audioTracks: {
        index: number;
        language?: string;
        codec?: string;
        channels?: number;
        displayTitle?: string;
    }[];

    // Subtitles
    subtitleTrackCount: number;
    subtitles: {
        index: number;
        language?: string;
        codec?: string;
        displayTitle?: string;
    }[];

    // Transcode decision
    transcodeDecision?: {
        videoAction: 'copy' | 'transcode';
        audioAction: 'copy' | 'transcode';
        useGpu: boolean;
        gpuEncoder?: string;
        gpuDecoder?: string;
        needsTonemapping: boolean;
        hdrTonemapMode?: 'hardware' | 'software' | 'n/a';
        tonemappingAlgorithm?: string;
    };

    // Process
    processRunning: boolean;
    processPid?: number;

    // Resource usage
    cpuPercent?: number;
    memoryMB?: number;
    /** GPU video engine usage percentage (Intel QSV/VAAPI only) */
    gpuVideoPercent?: number;

    // Bitrates
    /** Source bitrate in Mbps */
    sourceBitrateMbps?: number;
    /** Target/output bitrate in Mbps */
    targetBitrateMbps?: number;

    // Transcode type
    transcodeType?: TranscodeDisplayType;

    // Source file path
    sourceFilePath?: string;

    // Output
    outputDir: string;

    // Pod name (for multi-pod setups)
    podName?: string;

    /** The encode cannot keep up with real time (slow-transcode.ts). */
    slowReason?: SlowTranscodeReason;
    /** GPU encoder the job fell back from to software (no free encode session). */
    softwareFallbackFrom?: string;
}
