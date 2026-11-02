// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Transcode Strategy Interface
 *
 * Defines the contract for different transcoding strategies.
 * Each strategy handles FFmpeg argument building for a specific input mode.
 *
 * Strategies:
 * - FullTranscodeStrategy: Everything from local file (GPU-accelerated)
 */

import type { EffectiveTranscodePlan } from './effective-transcode-plan.js';
import type { AudioTrackInfo } from '../../utils/hls-audio-injection.js';
import type { TranscodeDecision, HlsOutputConfig, GpuAcceleration } from './types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration passed to transcode strategies
 */
export interface TranscodeStrategyConfig {
    /** Output directory for HLS segments */
    outputDir: string;

    /** Segment duration in seconds */
    segmentDuration: number;

    /** Start time in seconds (for seeking) */
    startTimeSeconds?: number;

    /** Audio tracks to include */
    audioTracks: AudioTrackInfo[];

    /** HLS output format configuration */
    hlsOutput?: HlsOutputConfig;

    /** Video stream information */
    videoInfo?: {
        codec: string;
        width: number;
        height: number;
        outputCodec?: string;
        videoRange?: string;
        videoRangeType?: string;
        frameRate?: number;
        /** Source video bitrate in bps (for dynamic bitrate calculation) */
        bitrate?: number;
        /** Source luma bit depth (8/10/12); keys the GPU decode-capability cache. */
        bitDepth?: number;
        dvProfile?: number;
        dvLevel?: number;
        dvBlSignalCompatibilityId?: number;
    };

    /**
     * Drop the video stream entirely (audio-only rung). Emits -vn; no video codec,
     * filter, or bitrate args. `buildAudioOnlyArgs` returns before any subtitle
     * burn-in logic runs, so `subtitleBurnIn` is silently ignored when this is set.
     */
    videoDisabled?: boolean;
}

/**
 * Full mode specific configuration
 */
export interface FullStrategyConfig extends TranscodeStrategyConfig {
    /** Required for job-owned invocations; standalone probes use the planner adapter. */
    effectivePlan?: EffectiveTranscodePlan;
    /** Local file path for full processing */
    localFilePath: string;

    /**
     * Cap on how much media (seconds) FFmpeg reads from the input (`-t` before
     * `-i`). Used for previews so a single job transcodes only a short snippet,
     * never the whole file. Undefined/0 = no cap.
     */
    maxDurationSeconds?: number;

    /**
     * Peak video bitrate cap in Mbps, applied as a VBV constraint
     * (-b:v/-maxrate/-bufsize) on the video encoder. Set for previews so a
     * high-motion / high-resolution source can't emit huge segments. Undefined
     * = no cap (encoder uses CRF-only quality control). See
     * PREVIEW_MAX_VIDEO_BITRATE_MBPS.
     */
    maxVideoBitrateMbps?: number;

    /** Starting segment number for HLS output (for seek scenarios).
     *  Only effective when video is transcoded (uniform segment cadence). */
    startNumber?: number;

    /**
     * Demux copy-video GOP mode (services/hls/gop-grid.ts): split the output
     * into a per-keyframe video output and a ~0.5 s audio-part output
     * (transcoding/gop-output-args.ts). `videoStartKeyframe` is the global
     * keyframe index this generation starts on, used as the video
     * `-start_number`.
     */
    gopSegments?: { videoStartKeyframe: number };

    /**
     * Write source-absolute tfdt on a seeked generation (`movflags=+frag_discont`),
     * as a generation from 0 has. Set for native-HLS clients (AVPlayer): they
     * place WebVTT cues against the media timestamps, and the edit list that
     * would re-base a zeroed timeline is stripped from the init for hls.js.
     * See `FFmpegArgsBuilder.keepSourceTimestamps`.
     */
    sourceTimestamps?: boolean;

    /**
     * The GPU encoder this job fell back from (TranscodeJobConfig.softwareEncodeFallback).
     * The master playlist was already served with the GPU encoder's profile (HEVC
     * Main, 8-bit, for SDR), so the software encoder must produce the same
     * profile instead of its own 10-bit default (CODECS mismatch breaks AVPlayer).
     */
    softwareEncodeFallback?: string;

    /**
     * When true, localFilePath is an FFmpeg concat demuxer list file.
     * FFmpeg is invoked with -f concat -safe 0 before -i.
     */
    useConcatDemuxer?: boolean;

    /** Transcode decision from the decision engine */
    decision?: TranscodeDecision;

    /**
     * Force the GPU software-decode bridge (software decode → hwupload) for
     * this job. Mirrors {@link TranscodeJobConfig.forceSoftwareDecodeBridge}.
     */
    forceSoftwareDecodeBridge?: boolean;

    /** GPU acceleration type */
    gpuAcceleration: GpuAcceleration;

    /** VAAPI device path (for VAAPI acceleration) */
    vaapiDevice?: string;

    /** Encoding preset */
    encodingPreset: string;

    /** NVENC preset (for NVENC acceleration) */
    nvencPreset: string;

    /** NVENC tune mode (hq, ll, ull, lossless) */
    nvencTune?: string;

    /** NVENC rate control (constqp, vbr, cbr) */
    nvencRc?: string;

    /** NVENC constant quality (0-51) */
    nvencCq?: number;

    /** H.264 CRF value */
    h264Crf: number;

    /** H.265 CRF value */
    h265Crf: number;

    /** Video bitrate in Mbps (0 = disabled) */
    videoBitrateMbps: number;

    /** Max video width (0 = no limit) */
    maxWidth: number;

    /** Max video height (0 = no limit) */
    maxHeight: number;

    /** Tonemapping algorithm */
    tonemappingAlgorithm: string;

    /** Deinterlace method */
    deinterlaceMethod: string;

    /** Audio codec */
    audioCodec: string;

    /** Stereo audio bitrate (e.g., "128k") */
    audioBitrateStereo: string;

    /** Surround audio bitrate (e.g., "256k") */
    audioBitrateSurround: string;

    /** Audio VBR enabled */
    audioVbr: boolean;

    /** Audio boost multiplier */
    audioBoost: number;

    /**
     * Audio's reserved share (bits/s) of the per-request quality cap's
     * effective total budget (see `quality-cap.ts`'s
     * `computeAudioReservationBps`). When set, a transcoded track's bitrate
     * is capped at this value and, below
     * `AUDIO_DOWNMIX_RESERVATION_THRESHOLD_BPS`, multi-channel audio is
     * downmixed to stereo. Undefined when no quality cap is active for this
     * job (leaves audio bitrate/channel selection untouched).
     */
    qualityCapAudioReservationBps?: number;

    /**
     * The client's audio channel cap (`?maxAudioChannels`). A transcoded track
     * is downmixed to at most this many channels. Undefined = no client cap
     * (the strategy's own 5.1 ceiling still applies).
     */
    maxAudioChannels?: number;

    /** Media source info for interlacing detection */
    mediaSourceInfo?: {
        streams: Array<{
            type: string;
            isInterlaced?: boolean;
        }>;
    };

    /**
     * When true, always transcode audio to AAC even if the source codec is
     * HLS-compatible.  See TranscodeJobConfig.forceAudioTranscode.
     */
    forceAudioTranscode?: boolean;

    /**
     * Subtitle burn-in configuration.
     * When set, the subtitle stream is overlaid onto the video via FFmpeg filter_complex.
     * Forces video transcode and disables hardware decode (overlay is CPU-only).
     */
    subtitleBurnIn?: {
        /** Absolute stream index in the media file */
        absoluteIndex: number;
        /** Subtitle codec name (for logging) */
        codec?: string;
        text?: { filePath: string; relativeIndex: number };
    };

    /**
     * How to reconcile subtitle burn-in with an HDR source (see
     * config.HLS_BURN_IN_HDR_STRATEGY). 'tonemap' (default) keeps the GPU encoder
     * and tonemaps HDR→SDR; 'software' keeps HDR by encoding in software.
     */
    burnInHdrStrategy?: 'tonemap' | 'software';
}

/**
 * Result from a transcode strategy
 */
export interface TranscodeStrategyResult {
    /** FFmpeg arguments array */
    args: string[];

    /** Human-readable description of the strategy used */
    description: string;

    /** True when the GOP-mode two-output layout was built (gop-output-args.ts). */
    gopSplit?: boolean;
}
