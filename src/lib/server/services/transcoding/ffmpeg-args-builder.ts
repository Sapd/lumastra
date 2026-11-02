// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FFmpeg Arguments Builder
 *
 * Fluent API for building FFmpeg command arguments with support for
 * GPU acceleration, tone mapping, multi-audio demuxing, and HLS output.
 */

import { config } from '../../config.js';
import { Logger } from '../../utils/logger.js';
import type { GpuAcceleration, Hdr10Metadata } from './types.js';
import { MEDIA_PROTOCOL_WHITELIST } from '../../utils/media-protocol-whitelist.js';
import { readDeviceNodeVendorId } from './gpu-identity.js';
import {
    getConcatListFormatWhitelist,
    getMediaFormatWhitelist,
} from '../../utils/media-format-whitelist.js';

const logger = Logger.for('FFmpegArgsBuilder');

/** CPU deinterlacers whose `mode` option means frame (0) / field (1) rate. */
const SOFTWARE_DEINTERLACERS = new Set(['yadif', 'bwdif', 'w3fdif']);

/** AMD VCN codes HEVC/AV1 in 64x16 blocks — see alignAmdVaapiEncodeSurface(). */
const AMD_VAAPI_ALIGN_SCALE = 'scale_vaapi=w=ceil(iw/64)*64:h=ceil(ih/16)*16';
let warnedUnknownVaapiVendor = false;

/**
 * Derive hardware acceleration type from encoder name.
 * The hwaccel type must match the encoder for GPU memory transfers to work.
 */
export function getHwAccelFromEncoder(encoder: string): GpuAcceleration | null {
    const lowerEncoder = encoder.toLowerCase();
    if (lowerEncoder.includes('nvenc')) return 'nvenc';
    if (lowerEncoder.includes('qsv')) return 'qsv';
    if (lowerEncoder.includes('vaapi')) return 'vaapi';
    if (lowerEncoder.includes('amf')) return 'amf';
    if (lowerEncoder.includes('videotoolbox')) return 'videotoolbox';
    return null; // Software encoder (libx264, libx265, etc.)
}

/**
 * Whether HDR->SDR tonemapping in a FINAL assembled ffmpeg args array ran on
 * the GPU or CPU. Must be read from the args {@link FFmpegArgsBuilder.build}
 * returns, not tracked as build-time state: subtitle burn-in
 * (`applySubtitleBurnIn`) can rewrite an already-emitted hardware tonemap
 * filter (`tonemap_vaapi=`/`vpp_qsv=tonemap`/`tonemap_cuda=`) into a software
 * one, or add its own software tonemap directly via
 * `buildSoftwareTonemapxFilter`, entirely bypassing `enableTonemapping()`.
 * Scanning the `-vf`/`-filter_complex` filter-chain value(s) within those
 * final assembled args is the only point that reflects what FFmpeg actually
 * receives.
 */
export function resolveTonemapMode(args: readonly string[]): 'hardware' | 'software' | 'n/a' {
    const vfIndex = args.indexOf('-vf');
    const filterComplexIndex = args.indexOf('-filter_complex');
    const filterChain =
        (vfIndex !== -1 ? args[vfIndex + 1] : '') +
        ' ' +
        (filterComplexIndex !== -1 ? args[filterComplexIndex + 1] : '');
    if (/tonemap_vaapi=|vpp_qsv=tonemap|tonemap_cuda=/.test(filterChain)) return 'hardware';
    if (/tonemapx=|(?:^|[,;[\] ])tonemap=/.test(filterChain)) return 'software';
    return 'n/a';
}

/**
 * Map x264/x265-style preset names to SVT-AV1 numeric presets (0-13).
 * Lower number = slower/better quality.  If the value is already numeric, pass through.
 */
function mapToSvtAv1Preset(preset: string): string {
    // Already a number — pass through
    if (/^\d+$/.test(preset)) return preset;

    const map: Record<string, string> = {
        placebo: '2',
        veryslow: '3',
        slower: '4',
        slow: '5',
        medium: '6',
        fast: '7',
        faster: '8',
        veryfast: '9',
        superfast: '11',
        ultrafast: '12',
    };
    return map[preset.toLowerCase()] ?? '9';
}

/**
 * Options for video encoding.
 */
export interface VideoCodecOptions {
    preset?: string;
    crf?: number;
    bitrate?: number; // in Mbps
    maxBitrate?: number; // strict VBV ceiling in Mbps
    profile?: string;
    level?: string;
    tune?: string;
    // B-frame settings (improve compression, 3-4 is typical for streaming)
    bframes?: number; // -bf: Number of B-frames between reference frames
    // Keyframe settings (critical for HLS segment alignment)
    gopSize?: number; // -g: GOP size in frames
    keyframeIntervalSeconds?: number; // Alternative: seconds between keyframes (requires frameRate)
    forceKeyframes?: boolean; // Use -force_key_frames for exact segment alignment
    sceneChangeDetection?: boolean; // Whether to allow extra keyframes on scene changes
    // NVENC specific
    nvencPreset?: string;
    nvencTune?: string;
    nvencRc?: string;
    nvencCq?: number;
    // QSV specific
    qsvPreset?: string;
    qsvLookAhead?: boolean;
    qsvGlobalQuality?: number; // 1-51, like CRF
    // VAAPI specific
    vaapiRcMode?: string; // auto, CQP, CBR, VBR, ICQ, QVBR
    vaapiQp?: number; // 0-52 for CQP mode
}

/**
 * Options for audio encoding.
 */
export interface AudioCodecOptions {
    bitrate?: string;
    channels?: number;
    sampleRate?: number;
    vbr?: boolean;
}

/**
 * Options for HLS output.
 */
export interface HlsOutputOptions {
    segmentDuration?: number;
    playlistType?: 'event' | 'vod';
    segmentType?: 'fmp4' | 'mpegts';
    initFilename?: string;
    segmentFilename?: string;
    masterPlaylistName?: string;
    flags?: string[];
    /** Starting segment number for HLS output. When set > 0, FFmpeg outputs
     *  files numbered from this value (e.g., segment_00500.m4s) so filenames
     *  match the logical manifest timeline directly. Only used in transcode
     *  mode where all streams share the same segment cadence. */
    startNumber?: number;
}

/**
 * Options for tone mapping.
 */
export interface TonemappingOptions {
    algorithm?: string;
    mode?: string;
    range?: string;
    desat?: number;
    peak?: number;
    param?: number;
    useGpu?: boolean;
    gpuType?: GpuAcceleration;
}

/**
 * Options for HDR10 output preservation.
 */
export interface Hdr10OutputOptions {
    /** HDR10 metadata from source (mastering display, MaxCLL, etc.) */
    metadata?: Hdr10Metadata;

    /** Output video range type */
    outputRange?: 'HDR10' | 'HLG';
}

/**
 * Fluent builder for FFmpeg command arguments.
 */
export class FFmpegArgsBuilder {
    private args: string[] = [];
    private inputCount = 0;
    private audioStreamCount = 0;
    private hasHwAccel = false;
    private hwAccelType: GpuAcceleration = 'none';
    private hasSeeking = false; // Track if seeking is used for correct timestamp handling
    private seekTimeSeconds = 0; // Store seek time for -output_ts_offset
    private isVideoCopy = false; // Video is copy/remux — affects audio PTS anchoring
    private copyTimestampsForced = false; // GOP mode: -copyts path even without a seek
    private sourceTimestamps = false; // Native HLS: absolute tfdt on a seeked copy generation
    // Caps how much INPUT is read (`-t` before `-i`). Used by previews so a hover/
    // hero snippet transcodes only a short window instead of the whole movie.
    // Emitted as an input option so it is unaffected by -copyts/seek timestamp math.
    private maxInputDurationSeconds = 0;
    private subtitleBurnInConfig: {
        absoluteIndex: number;
        text?: { filePath: string; relativeIndex: number };
        /**
         * Tonemap the (HDR) video to SDR *before* compositing the overlay. Required
         * when burning subs into an HDR source on a GPU encoder: the CPU overlay
         * produces 8-bit frames, so the encoder must target an 8-bit SDR profile
         * (Main), and a proper tonemap keeps the colors correct rather than crushed.
         */
        tonemapHdrToSdr?: boolean;
    } | null = null;
    // Set to the GPU backend when the source codec can't be hardware-decoded
    // (e.g. MPEG-4 ASP/VC-1 on Intel Arc): we software-decode and bridge frames
    // onto a GPU surface via hwupload instead of forcing -hwaccel_output_format.
    // Only the VA-API family (qsv/vaapi) needs the upload bridge — their filters
    // and encoders require a hardware surface. See enableHwAccel().
    private softwareDecodeBridge: GpuAcceleration | null = null;
    // Where the hwupload bridge is inserted in the -vf chain. 'head' (default) for
    // the decode bridge — frames go onto the GPU surface immediately, then run
    // hardware filters (scale_qsv/scale_vaapi). 'tail' for the VA-API software-HDR
    // path — all filtering (tonemapx, scale) runs in software first, then the SDR
    // result is uploaded once at the end for the VA-API encoder.
    private bridgeUploadPosition: 'head' | 'tail' = 'head';
    // DRM node the VA-API encoder runs on (enableHwAccel 'vaapi'), read back by
    // alignAmdVaapiEncodeSurface() to tell AMD (radeonsi) from Intel (iHD).
    private vaapiDevice: string | null = null;

    constructor() {
        // Start with global options
        this.args.push('-hide_banner');
        this.args.push('-loglevel', 'warning');
        this.args.push('-stats');
    }

    /**
     * Mark this build as using video copy/remux (no video decoding).
     * Affects audio PTS anchoring: first_pts=0 is suppressed because
     * copied video retains its source PTS, so audio must also keep its
     * natural PTS to stay aligned.
     */
    setVideoCopy(): this {
        this.isVideoCopy = true;
        return this;
    }

    /**
     * Demux copy-video GOP mode: take the seeking timestamp path
     * (`-copyts -start_at_zero -avoid_negative_ts disabled`) even when this
     * generation starts at 0, so every generation writes the same source-based
     * timeline (measured: gen0 and seek generations then agree per GOP).
     */
    forceCopyTimestamps(): this {
        this.copyTimestampsForced = true;
        return this;
    }

    /**
     * Native-HLS clients (AVPlayer): a seeked generation writes the source's
     * absolute timestamps into each fragment's tfdt (`movflags=+frag_discont`),
     * as a generation from 0 does, so tfdt matches the playlist.
     *
     * Without it the fMP4 muxer re-bases each track to its first DTS and records
     * the offset only in an edit list — which `stripMp4InitEditLists` removes
     * from the init for hls.js. A copy-video generation never gets the
     * `startNumber`-based `frag_discont` below (its playlist positions come from
     * the keyframe grid), so a resume or long seek ran on a timeline starting
     * near 0. AVPlayer plays the video from the playlist but places WebVTT cues
     * against the media timestamps (`X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:0`): prod
     * 2026-10-15 (Lanterns S1E5, iPhone app) — the segment at 604.6 s carried
     * tfdt 12.0 s, every cue ~10 min late, no subtitles after a resume.
     */
    keepSourceTimestamps(): this {
        this.sourceTimestamps = true;
        return this;
    }

    // =========================================================================
    // Input Configuration
    // =========================================================================

    /**
     * Cap how much input FFmpeg reads, in seconds (`-t` placed BEFORE `-i`).
     * Must be called before any add*Input* method. 0/negative = no cap. Used for
     * previews so a single job can never transcode more than a short snippet.
     */
    setMaxInputDuration(seconds: number): this {
        if (seconds > 0) {
            this.maxInputDurationSeconds = seconds;
        }
        return this;
    }

    /** Push `-format_whitelist <list>` as an input option unless the list is null. */
    private pushFormatWhitelist(list: string | null): void {
        if (list) {
            this.args.push('-format_whitelist', list);
        }
    }

    /** Push `-t <maxInputDuration>` as an input option when a cap is set. */
    private pushInputDurationLimit(): void {
        if (this.maxInputDurationSeconds > 0) {
            this.args.push('-t', this.maxInputDurationSeconds.toString());
        }
    }

    /**
     * Add a local file input with optional seeking.
     *
     * Uses accurate seeking (default FFmpeg behavior) which decodes pre-roll frames
     * from the nearest keyframe to the exact seek position. For transcoded streams
     * this produces precise output; for copy-mode video, output starts at the
     * nearest keyframe (up to one GOP before the seek point).
     *
     * A/V sync after seek is handled by -copyts + -start_at_zero in addOutputOptions(),
     * which preserves the correct relative timing between streams.
     */
    addInputFile(path: string, seekSeconds?: number): this {
        if (seekSeconds && seekSeconds > 0) {
            this.hasSeeking = true;
            this.seekTimeSeconds = seekSeconds;
            // Seek before input for faster seeking. With copied video, disable
            // accurate seek so FFmpeg keeps the boundary keyframe instead of
            // discarding it and making video wait for the next GOP.
            this.args.push('-ss', seekSeconds.toString());
            if (this.isVideoCopy) {
                this.args.push('-noaccurate_seek');
            }
        }
        this.pushInputDurationLimit();
        // F4: never a demuxer that opens files the content names (the sniff
        // ran before this spawn; the file can change in between) — see
        // media-format-whitelist.ts. Null when the binary could not be enumerated.
        this.pushFormatWhitelist(getMediaFormatWhitelist());
        // P1+R2 residual (S-P1c): media-plane inputs are always a resolved
        // local path — see media-protocol-whitelist.ts.
        this.args.push('-protocol_whitelist', MEDIA_PROTOCOL_WHITELIST);
        this.args.push('-i', path);
        this.inputCount++;
        return this;
    }

    /**
     * Add a concat demuxer input file. Used for split-file playback where
     * multiple physical files form a single logical media item.
     *
     * The path must be an FFmpeg concat list file:
     *   file '/absolute/path/to/Part1.mkv'
     *   file '/absolute/path/to/Part2.mkv'
     */
    addConcatInputFile(path: string, seekSeconds?: number): this {
        if (seekSeconds && seekSeconds > 0) {
            this.hasSeeking = true;
            this.seekTimeSeconds = seekSeconds;

            this.args.push('-ss', seekSeconds.toString());
            if (this.isVideoCopy) {
                this.args.push('-noaccurate_seek');
            }
        }
        this.pushInputDurationLimit();
        // F4: the list itself needs `concat`; each part's open inherits this
        // list (so no hls/dash/imf/sdp/sap) — see media-format-whitelist.ts.
        this.args.push('-f', 'concat', '-safe', '0');
        this.pushFormatWhitelist(getConcatListFormatWhitelist());
        // P1+R2 residual (S-P1c): the concat list itself is the app's own
        // temp file (`file:`) — see media-protocol-whitelist.ts.
        this.args.push('-protocol_whitelist', MEDIA_PROTOCOL_WHITELIST, '-i', path);
        this.inputCount++;
        return this;
    }

    // =========================================================================
    // Hardware Acceleration
    // =========================================================================

    /**
     * Check if hardware acceleration has been enabled.
     */
    hasHwAccelEnabled(): boolean {
        return this.hasHwAccel;
    }

    /**
     * The GPU backend whose filters should be used for scaling/tonemapping/etc.
     * This is `hwAccelType`, which the NVENC encoder-only bridge deliberately sets
     * to 'none' (software filters, encoder ingests system frames) while the
     * VA-API-family bridge keeps 'qsv'/'vaapi' (hardware filters after hwupload).
     * Callers building filters from the encoder name should use this instead.
     */
    getActiveFilterHwAccel(): GpuAcceleration {
        return this.hwAccelType;
    }

    /**
     * Check if the video encoder is libx265 (software HEVC).
     */
    private isUsingLibx265(): boolean {
        const idx = this.args.indexOf('-c:v');
        return idx !== -1 && this.args[idx + 1] === 'libx265';
    }

    /**
     * Enable hardware acceleration for decoding.
     */
    enableHwAccel(
        type: GpuAcceleration,
        device?: string,
        opts?: { softwareDecodeBridge?: boolean; vaapiSoftwareTonemap?: boolean },
    ): this {
        this.hasHwAccel = true;
        this.hwAccelType = type;
        this.vaapiDevice = null;

        switch (type) {
            case 'nvenc':
                if (opts?.softwareDecodeBridge) {
                    // Source codec can't be NVDEC-hardware-decoded (e.g. 10-bit
                    // H.264 / 4:4:4 on any NVIDIA GPU). Unlike the VA-API family,
                    // NVENC encoders ingest system-memory frames directly, so the
                    // bridge is "encoder-only": no CUDA decode, no scale_cuda — the
                    // frames stay in system memory and software filters handle
                    // scale/format. We model that by leaving hwAccelType 'none' so
                    // every filter selection (scale/tonemap/deinterlace) resolves to
                    // its software variant, while the hevc_nvenc/h264_nvenc encoder
                    // (set separately) uploads internally. Keep hasHwAccel=true so
                    // the strategy's "re-enable if no hwaccel" guard doesn't fire.
                    // Verified on an RTX 3090: 10-bit H.264 → hevc_nvenc encodes.
                    this.softwareDecodeBridge = 'nvenc';
                    this.hwAccelType = 'none';
                } else {
                    // NVIDIA CUDA acceleration
                    this.args.unshift('-hwaccel_output_format', 'cuda');
                    this.args.unshift('-hwaccel', 'cuda');
                }
                break;
            case 'qsv':
                // Intel Quick Sync Video
                // QSV can use VA-API as backend on Linux, or D3D11VA on Windows
                if (opts?.softwareDecodeBridge) {
                    // Source codec can't be QSV-hardware-decoded (e.g. MPEG-4 ASP
                    // or VC-1 on Intel Arc/DG2). Forcing `-hwaccel qsv
                    // -hwaccel_output_format qsv` makes FFmpeg silently fall back
                    // to a software decoder while still demanding QSV surfaces
                    // downstream — scale_qsv/vpp_qsv/hevc_qsv then can't ingest the
                    // system-memory frames and the encoder fails to open
                    // (auto_scale -38 → "Could not open encoder" → -22). Instead we
                    // software-decode (no -hwaccel) and explicitly create a QSV
                    // filter device; build() inserts a `hwupload=...,format=qsv`
                    // bridge at the head of the filter chain.
                    this.softwareDecodeBridge = 'qsv';
                    const dev = device || config.QSV_DEVICE || config.VAAPI_DEVICE;
                    this.args.unshift('-filter_hw_device', 'qs');
                    this.args.unshift('-init_hw_device', 'qsv=qs@va');
                    this.args.unshift('-init_hw_device', `vaapi=va:${dev}`);
                } else {
                    this.args.unshift('-hwaccel_output_format', 'qsv');
                    this.args.unshift('-hwaccel', 'qsv');
                    // Set device path if specified (Linux: /dev/dri/renderD128)
                    if (device || config.QSV_DEVICE) {
                        this.args.unshift('-qsv_device', device || config.QSV_DEVICE);
                    }
                }
                break;
            case 'vaapi':
                // VA-API (Linux AMD/Intel)
                this.vaapiDevice = device || config.VAAPI_DEVICE;
                if (opts?.vaapiSoftwareTonemap) {
                    // AMD Mesa radeonsi has no hardware HDR tone-map VPP
                    // (tonemap_vaapi → "VAAPI driver doesn't support HDR" → -22).
                    // Software-decode + software tonemapx + software scale, then
                    // upload the SDR result to a VA-API surface at the TAIL of the
                    // filter chain for the encoder. hwAccelType 'none' makes every
                    // filter resolve to its software variant. Verified on a Radeon
                    // 760M. (Takes precedence over softwareDecodeBridge: HDR sources
                    // are HEVC/AV1, never the MPEG-4/VC-1 the decode bridge targets.)
                    this.softwareDecodeBridge = 'vaapi';
                    this.hwAccelType = 'none';
                    this.bridgeUploadPosition = 'tail';
                    this.args.unshift('-vaapi_device', device || config.VAAPI_DEVICE);
                } else if (opts?.softwareDecodeBridge) {
                    // Same surface mismatch as QSV above: the source codec can't be
                    // VA-API-hardware-decoded (e.g. MPEG-4 ASP / VC-1 on Intel Arc,
                    // MPEG-4 on AMD), so software-decode (no -hwaccel) and let
                    // build() insert `format=nv12,hwupload` to put frames on a
                    // VA-API surface for scale_vaapi/tonemap_vaapi/*_vaapi. The
                    // device must still be initialised for the upload + encoder.
                    this.softwareDecodeBridge = 'vaapi';
                    this.args.unshift('-vaapi_device', device || config.VAAPI_DEVICE);
                } else {
                    this.args.unshift('-hwaccel_output_format', 'vaapi');
                    this.args.unshift('-hwaccel', 'vaapi');
                    this.args.unshift('-vaapi_device', device || config.VAAPI_DEVICE);
                }
                break;
            case 'videotoolbox':
                // Apple VideoToolbox (macOS)
                // videotoolbox_vld keeps decoded frames on GPU surface for efficient transcode
                this.args.unshift('-hwaccel_output_format', 'videotoolbox_vld');
                this.args.unshift('-hwaccel', 'videotoolbox');
                break;
            case 'amf':
                // AMD AMF (Windows) - use d3d11va for hardware decoding
                this.args.unshift('-hwaccel_output_format', 'd3d11');
                this.args.unshift('-hwaccel', 'd3d11va');
                break;
        }

        return this;
    }

    /**
     * Set the hardware device for encoding.
     */
    setHwDevice(_device: string): this {
        // This is handled by enableHwAccel
        return this;
    }

    // =========================================================================
    // Video Encoding
    // =========================================================================

    /**
     * Set video codec with encoding options.
     */
    setVideoCodec(codec: string, options?: VideoCodecOptions): this {
        this.args.push('-c:v', codec);

        if (!options) return this;

        const lowerCodec = codec.toLowerCase();

        // Check which encoder family this is
        const isAv1 =
            lowerCodec.includes('av1') ||
            lowerCodec.includes('svtav1') ||
            lowerCodec.includes('aom');
        const isVideoToolbox = lowerCodec.includes('videotoolbox');
        const isVaapi = lowerCodec.includes('vaapi');

        // Profile/Level: Only supported by H.264/HEVC encoders (not AV1, VideoToolbox, VAAPI)
        // AV1 uses different parameters (-svtav1-params, -av1-params, etc.)
        // VideoToolbox and VAAPI auto-detect profile/level from input
        const supportsProfileLevel = !isAv1 && !isVideoToolbox && !isVaapi;
        const isQsv = lowerCodec.includes('qsv');
        if (supportsProfileLevel) {
            if (options.profile) {
                this.args.push('-profile:v', options.profile);
            }
            if (options.level) {
                // QSV uses integer level format (e.g., 51 for level 5.1)
                // HEVC level values are 30x the decimal (5.1 -> 153 internally, but QSV wants 51)
                // H.264 level values are 10x the decimal (4.2 -> 42)
                let levelValue = options.level;
                if (isQsv && options.level.includes('.')) {
                    // Convert "5.1" to "51", "4.0" to "40", etc.
                    levelValue = options.level.replace('.', '');
                }
                this.args.push('-level:v', levelValue);
            }
        }

        // B-frames: Jellyfin doesn't set explicit B-frames for hardware encoders
        // Only set for software encoders (libx264, libx265)
        // Hardware encoders: VideoToolbox, VAAPI, QSV, AMF don't get explicit -bf
        // Software AV1 (svtav1, aom) also don't use -bf
        const isSoftwareEncoder =
            codec.startsWith('lib') &&
            !lowerCodec.includes('svtav1') &&
            !lowerCodec.includes('aom');
        const isNvenc = lowerCodec.includes('nvenc');
        // Only NVENC and software (non-AV1) get explicit B-frames
        const supportsBframes = isSoftwareEncoder || isNvenc;
        if (supportsBframes && options.bframes !== undefined) {
            this.args.push('-bf', options.bframes.toString());
        }

        // Software encoder options (libx264, libx265, libsvtav1)
        if (codec.startsWith('lib')) {
            const rawPreset = options.preset || config.ENCODING_PRESET;
            // SVT-AV1 uses numeric presets (0-13), not x264-style names
            const preset = codec === 'libsvtav1' ? mapToSvtAv1Preset(rawPreset) : rawPreset;
            this.args.push('-preset', preset);
            if (options.crf !== undefined) {
                this.args.push('-crf', options.crf.toString());
            } else if (options.bitrate && options.bitrate > 0) {
                // An explicit target bitrate (e.g. the preview VBV cap) was
                // requested: run pure ABR (the bitrate block below adds
                // -b:v/-maxrate/-bufsize). Do NOT also push a default -crf —
                // libx264/x265 let -crf win over -b:v, which would silently
                // defeat the cap.
            } else if (codec === 'libx264') {
                this.args.push('-crf', config.H264_CRF.toString());
            } else if (codec === 'libx265') {
                this.args.push('-crf', config.H265_CRF.toString());
            }
            if (options.tune) {
                this.args.push('-tune', options.tune);
            }
        }

        // NVENC options
        if (codec.includes('nvenc')) {
            const preset = options.nvencPreset || config.NVENC_PRESET;
            this.args.push('-preset', preset);
            if (options.nvencTune) {
                this.args.push('-tune', options.nvencTune);
            }
            // Rate control mode
            // -cq requires vbr mode, so default to vbr when cq is set
            if (options.nvencRc) {
                this.args.push('-rc', options.nvencRc);
            } else if (options.nvencCq !== undefined) {
                // CQ mode requires VBR rate control
                this.args.push('-rc', 'vbr');
            }
            if (options.nvencCq !== undefined) {
                this.args.push('-cq', options.nvencCq.toString());
            }
        }

        // QSV options (following Jellyfin's approach exactly)
        // Jellyfin uses bitrate-based VBR, NOT global_quality or look_ahead
        // These options cause "Invalid argument" errors on Intel Arc GPUs
        if (codec.includes('qsv')) {
            if (options.qsvPreset) {
                this.args.push('-preset', options.qsvPreset);
            }
            // MacroBlock-level bitrate control for better visual quality (H.264/HEVC only, not AV1)
            if (codec === 'h264_qsv' || codec === 'hevc_qsv') {
                this.args.push('-mbbrc', '1');
                // Make forced keyframes true IDR frames. Apple TV's HLS client can
                // start decoding a freshly sought segment only when its boundary is
                // independently decodable.
                this.args.push('-forced_idr', '1');
            }

            // Intel Low Power Encoding (optional, user-configurable like Jellyfin)
            // Saves CPU-GPU synchronization overhead for 4K transcoding and tonemapping
            // Note: Don't combine with global_quality or look_ahead (causes errors on Arc)
            const useLowPower =
                (codec === 'h264_qsv' && config.INTEL_LP_H264) ||
                (codec === 'hevc_qsv' && config.INTEL_LP_HEVC);
            if (useLowPower) {
                this.args.push('-low_power', '1');
            }
            // Bitrate control is handled separately via setVideoBitrate() or the bitrate option
        }

        // VAAPI options
        if (codec.includes('vaapi')) {
            // Rate control mode (auto, CQP, CBR, VBR, ICQ, QVBR)
            if (options.vaapiRcMode) {
                this.args.push('-rc_mode', options.vaapiRcMode);
            }
            // Constant QP (0-52) for CQP mode
            if (options.vaapiQp !== undefined) {
                this.args.push('-qp', options.vaapiQp.toString());
            }
        }

        // VideoToolbox options (macOS)
        if (codec.includes('videotoolbox')) {
            // prio_speed: 0 = quality, 1 = speed
            const prioSpeed = config.VIDEOTOOLBOX_PRIO_SPEED ? '1' : '0';
            this.args.push('-prio_speed', prioSpeed);
            // Allow software fallback when hardware encoder is busy/unavailable
            this.args.push('-allow_sw', '1');
        }

        // AMF options (AMD GPUs)
        if (codec.includes('amf')) {
            // Quality preset: quality, balanced, speed
            this.args.push('-quality', config.AMF_QUALITY);
            // GOP header insertion for seeking compatibility
            this.args.push('-header_insertion_mode', 'gop');
            // HEVC: Additional GOP settings for proper keyframe handling
            if (codec === 'hevc_amf' || codec === 'av1_amf') {
                this.args.push('-gops_per_idr', '1');
            }
            // Enable adaptive quantization for better visual quality (esp. dark scenes)
            if (config.AMF_QUALITY === 'quality' || config.AMF_QUALITY === 'balanced') {
                this.args.push('-vbaq', '1');
                this.args.push('-preanalysis', '1');
            }
        }

        // Bitrate mode (alternative to CRF) - encoder-specific handling per Jellyfin
        if (options.bitrate && options.bitrate > 0) {
            const ceiling = options.maxBitrate
                ? Math.floor(options.maxBitrate * 1_000_000)
                : undefined;
            const bitrate = Math.min(
                options.bitrate * 1_000_000,
                ceiling === undefined ? Infinity : codec.includes('qsv') ? ceiling - 1 : ceiling,
            );

            if (codec.includes('qsv')) {
                // QSV: Set maxrate=bitrate+1 to trigger VBR, larger bufsize for scene changes
                this.args.push('-b:v', bitrate.toString());
                this.args.push('-maxrate', (ceiling ?? bitrate + 1).toString());
                this.args.push('-rc_init_occupancy', Math.floor(bitrate * 2).toString());
                this.args.push('-bufsize', Math.floor(bitrate * 4).toString());
            } else if (codec.includes('videotoolbox')) {
                // VideoToolbox: No maxrate/bufsize (can cause hangs)
                this.args.push('-b:v', bitrate.toString());
            } else if (codec.includes('amf')) {
                // AMF: CBR with buffer control
                this.args.push('-rc', 'cbr');
                this.args.push('-b:v', bitrate.toString());
                this.args.push('-maxrate', bitrate.toString());
                this.args.push('-bufsize', Math.floor(bitrate * 2).toString());
            } else {
                // Default (NVENC, VAAPI, software): Standard VBR
                this.args.push('-b:v', bitrate.toString());
                this.args.push('-maxrate', (ceiling ?? Math.floor(bitrate * 1.5)).toString());
                this.args.push('-bufsize', Math.floor(bitrate * 2).toString());
            }
        }

        return this;
    }

    /**
     * Copy video without re-encoding.
     */
    copyVideo(): this {
        this.args.push('-c:v', 'copy');
        return this;
    }

    /**
     * Drop the video stream entirely (audio-only output).
     *
     * Distinct from copyVideo()/setVideoCodec(): there is no video codec at all, so
     * no -c:v, no scale/tonemap filters, no video bitrate flags. Must not be combined
     * with subtitle burn-in — an overlay filter needs a video stream to draw onto.
     */
    disableVideo(): this {
        if (!this.args.includes('-vn')) {
            this.args.push('-vn');
        }
        return this;
    }

    /**
     * Set video bitrate limit.
     * Uses encoder-specific bitrate patterns (following Jellyfin).
     */
    setVideoBitrate(bitrateMbps: number): this {
        const bitrate = bitrateMbps * 1_000_000;

        if (this.hwAccelType === 'qsv') {
            // QSV: Jellyfin's VBR pattern
            // Set maxrate=bitrate+1 to trigger VBR, larger bufsize for scene changes
            this.args.push('-b:v', bitrate.toString());
            this.args.push('-maxrate', (bitrate + 1).toString());
            this.args.push('-rc_init_occupancy', Math.floor(bitrate * 2).toString());
            this.args.push('-bufsize', Math.floor(bitrate * 4).toString());
        } else if (this.hwAccelType === 'videotoolbox') {
            // VideoToolbox: No maxrate/bufsize (can cause hangs)
            this.args.push('-b:v', bitrate.toString());
        } else if (this.hwAccelType === 'amf') {
            // AMF: CBR with buffer control
            this.args.push('-rc', 'cbr');
            this.args.push('-b:v', bitrate.toString());
            this.args.push('-maxrate', bitrate.toString());
            this.args.push('-bufsize', Math.floor(bitrate * 2).toString());
        } else {
            // Default (NVENC, VAAPI, software): Standard VBR
            this.args.push('-b:v', bitrate.toString());
            this.args.push('-maxrate', Math.floor(bitrate * 1.5).toString());
            this.args.push('-bufsize', Math.floor(bitrate * 2).toString());
        }
        return this;
    }

    /**
     * Set video CRF (quality).
     */
    setVideoCrf(crf: number): this {
        this.args.push('-crf', crf.toString());
        return this;
    }

    /**
     * Scale video to target resolution.
     */
    setVideoScale(width: number, height: number): this {
        const scaleFilter =
            this.hwAccelType === 'vaapi'
                ? `scale_vaapi=w=${width}:h=${height}`
                : this.hwAccelType === 'nvenc'
                  ? `scale_cuda=w=${width}:h=${height}`
                  : this.hwAccelType === 'qsv'
                    ? `scale_qsv=w=${width}:h=${height}`
                    : `scale=${width}:${height}`;

        this.addVideoFilter(scaleFilter);
        return this;
    }

    /**
     * Add a video filter.
     */
    addVideoFilter(filter: string): this {
        // Find existing -vf or add new one
        const vfIndex = this.args.indexOf('-vf');
        if (vfIndex !== -1) {
            this.args[vfIndex + 1] += ',' + filter;
        } else {
            this.args.push('-vf', filter);
        }
        return this;
    }

    // =========================================================================
    // Keyframe Settings (Critical for HLS)
    // =========================================================================

    /**
     * Set keyframe interval for HLS segment alignment.
     *
     * For proper HLS playback, keyframes should occur at segment boundaries.
     * This ensures:
     * - Clean segment cuts (no decoding from previous segment needed)
     * - Accurate seeking to segment positions
     * - Proper I-frame playlist generation
     *
     * @param segmentDuration - HLS segment duration in seconds (default: 6)
     * @param frameRate - Video frame rate (default: 24, common for films)
     */
    setKeyframeInterval(
        segmentDuration: number = config.FFMPEG_SEGMENT_DURATION,
        frameRate: number = 24,
    ): this {
        // GOP size = segment duration * frame rate
        // For 6-second segments at 24fps: GOP = 144 frames
        const gopSize = Math.round(segmentDuration * frameRate);

        // -g: Maximum GOP size (keyframe interval in frames)
        this.args.push('-g', gopSize.toString());

        // -keyint_min: Minimum keyframe interval (same as max for consistent segments)
        // This prevents the encoder from inserting keyframes too frequently
        this.args.push('-keyint_min', gopSize.toString());

        // -sc_threshold 0: Disable scene-change detection
        // Without this, encoder may insert extra keyframes on scene changes,
        // which doesn't hurt but wastes bits
        this.args.push('-sc_threshold', '0');

        return this;
    }

    /**
     * Force keyframes at exact intervals using -force_key_frames.
     *
     * More precise than -g for exact segment alignment, but slightly higher overhead.
     * Use this when segment timing must be exact (e.g., for ad insertion).
     *
     * @param intervalSeconds - Interval between forced keyframes
     */
    forceKeyframesAtInterval(intervalSeconds: number): this {
        // expr:gte(t,n_forced*interval) forces keyframe every N seconds
        this.args.push('-force_key_frames', `expr:gte(t,n_forced*${intervalSeconds})`);
        return this;
    }

    // =========================================================================
    // HDR Tone Mapping
    // =========================================================================

    /**
     * Enable HDR to SDR tone mapping.
     */
    enableTonemapping(options?: TonemappingOptions): this {
        const opts = options || {};
        const algorithm = opts.algorithm || config.TONEMAPPING_ALGORITHM;
        const desat = opts.desat ?? config.TONEMAPPING_DESAT;
        const peak = opts.peak ?? config.TONEMAPPING_PEAK;
        // 0 = the algorithm's own default, so the option is left out.
        const param = opts.param ?? config.TONEMAPPING_PARAM;
        const gpuType = opts.gpuType || this.hwAccelType;

        // GPU tone mapping. When a GPU encoder is selected the frames live on a
        // hardware surface, so tone mapping MUST also happen on the GPU — a
        // software tonemap (tonemapx below) produces system-memory frames the
        // hardware encoder can't ingest (h264_vaapi/qsv fail to open the encoder,
        // VA-API -38). So for vaapi/qsv we ALWAYS use the hardware VPP tonemap
        // here — it is NOT gated on VPP_TONEMAPPING (that flag's true intent is
        // brightness/contrast tuning, not whether to tonemap at all; gating the
        // tonemap on it left HDR->h264_vaapi feeding 10-bit HDR straight into an
        // 8-bit encoder). VPP_TONEMAPPING_* still tune the QSV path below.
        if (opts.useGpu !== false && gpuType !== 'none') {
            if (gpuType === 'vaapi') {
                // Intel/AMD VA-API VPP tone mapping (HDR10/HLG/DV -> SDR nv12)
                this.addVideoFilter(
                    `tonemap_vaapi=format=nv12:primaries=bt709:transfer=bt709:matrix=bt709`,
                );
                return this;
            }

            if (gpuType === 'nvenc') {
                // CUDA tone mapping + convert to 8-bit for h264_nvenc
                // (h264_nvenc doesn't support 10-bit; tonemap_cuda outputs 10-bit CUDA frames)
                const paramOpt = param > 0 ? `:param=${param}` : '';
                const tonemapFilter = `tonemap_cuda=tonemap=${algorithm}${paramOpt}:desat=${desat}:peak=${peak || 100},scale_cuda=format=yuv420p`;
                this.addVideoFilter(tonemapFilter);
                return this;
            }

            if (gpuType === 'qsv') {
                // Intel QSV VPP tone mapping. `format=nv12` is load-bearing: vpp_qsv
                // keeps the surface at its INPUT depth unless told otherwise, so an
                // HDR (10-bit) source stays p010 after the tone-map and h264_qsv —
                // which has no 10-bit mode at all — refuses to open:
                //   "[h264_qsv] Current pixel format is unsupported"
                //   → "[vost#0:0/h264_qsv] Task finished with error code: -22"
                // The output is SDR Rec.709 8-bit by definition here, so nv12 is
                // also what it should be. (tonemap_vaapi/scale_cuda in the sibling
                // branches already pin their output format for the same reason.)
                const brightness = config.VPP_TONEMAPPING_BRIGHTNESS;
                const contrast = config.VPP_TONEMAPPING_CONTRAST;
                this.addVideoFilter(
                    `vpp_qsv=tonemap=1:brightness=${brightness}:contrast=${contrast}:format=nv12`,
                );
                return this;
            }
        }

        // Software (CPU) tone mapping via jellyfin-ffmpeg's `tonemapx` filter.
        //
        // The previous chain — `zscale=t=linear:npl=100,tonemap=<algo>,
        // zscale=t=bt709:m=bt709:r=tv` — was broken for real HDR sources:
        //   • Dolby Vision (IPT-PQ input) made zscale abort with
        //     "code 3074: no path between colorspaces", and
        //   • it never converted to a libx264-compatible 8-bit pixel format,
        // so the filter graph produced zero frames and libx264 aborted with
        // "Could not open encoder before EOF" → exit -22 (Invalid argument).
        // This hit ALL HDR content on the CPU path (HDR10 and DV alike).
        //
        // `tonemapx` (SIMD HDR→SDR) handles HDR10/HLG/Dolby Vision input and
        // emits the requested 8-bit format directly, so libx264 opens cleanly.
        // It accepts a broader algorithm set than the legacy `tonemap` filter
        // (incl. bt2390/bt2446a/spline); fall back to hable if misconfigured.
        const tonemapxAlgorithms = new Set([
            'none',
            'clip',
            'linear',
            'gamma',
            'reinhard',
            'hable',
            'mobius',
            'bt2390',
            'bt2446a',
            'spline',
        ]);
        const softwareAlgorithm = tonemapxAlgorithms.has(algorithm) ? algorithm : 'hable';

        let tonemapx = `tonemapx=tonemap=${softwareAlgorithm}`;
        if (param > 0) {
            tonemapx += `:param=${param}`;
        }
        if (!Number.isNaN(desat)) {
            tonemapx += `:desat=${desat}`;
        }
        if (peak > 0) {
            tonemapx += `:peak=${peak}`;
        }
        // SDR Rec.709 output in a libx264-friendly 8-bit pixel format.
        tonemapx += ':p=bt709:t=bt709:m=bt709:r=tv:format=yuv420p';

        this.addVideoFilter(tonemapx);
        return this;
    }

    // =========================================================================
    // HDR10 Output Preservation
    // =========================================================================

    /**
     * Enable HDR10 output preservation when transcoding.
     *
     * This preserves HDR quality when transcoding DV Profile 8 content to HDR10,
     * or when transcoding between HDR10-compatible codecs. Uses 10-bit encoding
     * and copies HDR10 static metadata (mastering display info, MaxCLL/MaxFALL).
     *
     * @param options HDR10 output configuration
     */
    enableHdr10Output(options?: Hdr10OutputOptions): this {
        const opts = options || {};
        const outputRange = opts.outputRange || 'HDR10';
        const metadata = opts.metadata;

        // Set 10-bit pixel format for HDR — ONLY on fully-software pipelines.
        // When a hardware decode is active (this.hasHwAccel) the frames live in
        // GPU memory (CUDA p010 from nvdec/scale_cuda, or QSV/VAAPI surfaces).
        // Forcing a software -pix_fmt there makes FFmpeg insert an `auto_scale`
        // that cannot bridge GPU↔system formats:
        //   "Impossible to convert between the formats supported by the filter
        //    'Parsed_scale_cuda_0' and the filter 'auto_scale_0'"  → code -38
        //    ("Could not open encoder") — which broke EVERY hardware HDR10
        //    transcode (e.g. 4K HDR10 → hevc_nvenc on an RTX 3090).
        // The GPU filter chain (scale_cuda / tonemap_cuda) already carries the
        // correct 10-bit format, and QSV manages its own surface format.
        if (this.hwAccelType !== 'qsv' && !this.hasHwAccel) {
            this.args.push('-pix_fmt', 'yuv420p10le');
        }

        // Set color space for HDR10/HLG
        if (outputRange === 'HDR10') {
            // HDR10 uses BT.2020 color space with PQ (SMPTE ST 2084) transfer
            this.args.push('-colorspace', 'bt2020nc');
            this.args.push('-color_primaries', 'bt2020');
            this.args.push('-color_trc', 'smpte2084');
        } else if (outputRange === 'HLG') {
            // HLG uses BT.2020 color space with HLG (ARIB STD-B67) transfer
            this.args.push('-colorspace', 'bt2020nc');
            this.args.push('-color_primaries', 'bt2020');
            this.args.push('-color_trc', 'arib-std-b67');
        }

        // Set color range to limited (TV range) — but NOT when the frames sit on a
        // VA-API-family (or other non-CUDA) hardware surface.
        //
        // -color_range is a CONVERSION request, not a tag: whenever it differs from
        // the range the decoded frames already carry (plenty of HDR remuxes signal
        // full range), FFmpeg inserts an auto_scale to perform the conversion — and
        // auto_scale cannot touch a QSV/VA-API surface:
        //   "Impossible to convert between the formats supported by the filter
        //    'Parsed_scale_qsv_0' and the filter 'auto_scale_0'"  → vf code -38
        //   → "[vost#0:0/hevc_qsv] Task finished with error code: -22"
        // That killed EVERY HDR10/HLG-preserving QSV or VA-API transcode — a user
        // hitting a DV-P10/AV1 4K episode on iOS Safari got "Playback failed to
        // start" with exactly that -22. Reproduced on an Arc A380 against the real
        // source: dropping only this flag turns the failure into a clean encode,
        // and hevc_vaapi fails identically with it. Nothing converts the range on
        // that path, so omitting the flag is also the truthful choice — the output
        // then carries whatever range the source had.
        //
        // CUDA is deliberately NOT in this list: verified on an RTX 3090 against a
        // genuinely full-range (pc) 10-bit HDR source, `-color_range tv` encodes
        // cleanly — scale_cuda absorbs the range conversion that auto_scale cannot do
        // on a VA-API surface. NVENC therefore keeps the correct limited-range tag.
        // (The same harness DOES reproduce the auto_scale break on CUDA for -pix_fmt,
        // so this is a real difference between the flags, not an inert test.)
        //
        // AMF/VideoToolbox are included conservatively: both are marked "untested" in
        // the settings UI and have no hardware filters here at all, so there is no
        // evidence they can absorb the conversion.
        const framesOnUnbridgeableSurface =
            this.hwAccelType === 'qsv' ||
            this.hwAccelType === 'vaapi' ||
            this.hwAccelType === 'amf' ||
            this.hwAccelType === 'videotoolbox' ||
            // The VA-API software-HDR bridge leaves hwAccelType 'none' but uploads to
            // a VA-API surface at the TAIL, so the graph output is still one.
            this.softwareDecodeBridge === 'vaapi';
        if (!framesOnUnbridgeableSurface) {
            this.args.push('-color_range', 'tv');
        }

        // Copy HDR10 static metadata if available
        if (metadata) {
            // libx265 requires HDR metadata via -x265-params, not as standalone
            // FFmpeg options. Hardware encoders (hevc_nvenc, etc.) accept them directly.
            const isX265Software = this.isUsingLibx265();

            if (isX265Software) {
                const x265Params: string[] = [];
                if (metadata.masteringDisplayMetadata) {
                    const raw = metadata.masteringDisplayMetadata;
                    const sanitized = raw.includes(':') ? raw.replace(/:/g, '') : raw;
                    if (sanitized !== raw) {
                        logger.warn(
                            'Stripped colon(s) from masteringDisplayMetadata — malformed HDR tag?',
                            { original: raw },
                        );
                    }
                    x265Params.push(`master-display=${sanitized}`);
                }
                if (metadata.maxCll) {
                    const raw = metadata.maxCll;
                    if (!/^\d+,\d+$/.test(raw)) {
                        logger.warn(
                            'Skipping maxCll — value does not match expected format \\d+,\\d+',
                            { value: raw },
                        );
                    } else {
                        x265Params.push(`max-cll=${raw}`);
                    }
                }
                if (x265Params.length > 0) {
                    // Merge with existing -x265-params if present
                    const existingIdx = this.args.indexOf('-x265-params');
                    if (existingIdx !== -1 && existingIdx + 1 < this.args.length) {
                        this.args[existingIdx + 1] += ':' + x265Params.join(':');
                    } else {
                        this.args.push('-x265-params', x265Params.join(':'));
                    }
                }
            } else {
                // Hardware HEVC encoders (hevc_nvenc, hevc_qsv, hevc_vaapi,
                // hevc_amf) do NOT accept `-master_display` / `-max_cll` — those
                // are libx265-only params, not FFmpeg CLI options. Passing them
                // makes FFmpeg abort parsing with "Unrecognized option
                // 'master_display'", which surfaces from NVENC as "Could not
                // open encoder" / code -38 and broke EVERY hardware HDR10
                // transcode (e.g. 4K HDR10 on an RTX 3090). HDR10 is still
                // correctly signaled to the display via the BT.2020 + PQ color
                // VUI (-colorspace/-color_primaries/-color_trc set above); only
                // the static mastering-luminance hints are dropped, which players
                // tolerate (NVENC has no standalone option to carry them).
                if (metadata.masteringDisplayMetadata || metadata.maxCll) {
                    logger.debug(
                        'Omitting static HDR10 mastering metadata for hardware encoder (no valid FFmpeg option); HDR10 signaled via color VUI',
                        {
                            hasMasterDisplay: !!metadata.masteringDisplayMetadata,
                            hasMaxCll: !!metadata.maxCll,
                        },
                    );
                }
            }
        }

        // For HEVC, ensure Main10 profile is used
        // Find if we already have -c:v set to hevc encoder (hevc_*, libx265, x265)
        const codecIndex = this.args.findIndex(
            (arg, i) =>
                arg === '-c:v' &&
                (this.args[i + 1]?.includes('hevc') ||
                    this.args[i + 1]?.includes('x265') ||
                    this.args[i + 1]?.includes('265')),
        );
        if (codecIndex !== -1) {
            // Set Main10 profile for HEVC HDR
            const profileIndex = this.args.indexOf('-profile:v');
            if (profileIndex === -1) {
                this.args.push('-profile:v', 'main10');
            }
        }

        return this;
    }

    /**
     * Set pixel format explicitly.
     */
    setPixelFormat(format: string): this {
        this.args.push('-pix_fmt', format);
        return this;
    }

    // =========================================================================
    // Deinterlacing
    // =========================================================================

    /**
     * Add the deinterlacer for the active filter backend, at the HEAD of the
     * video filter chain.
     *
     * Head, not tail: the strategy calls this after scale/tonemap are already in
     * the chain, and a vertical scale of an interlaced frame blends the two
     * fields into each other — a deinterlacer after it has nothing left to
     * separate and the combing survives (just resampled). Decode-bridge uploads
     * are inserted by build() ahead of this, so a GPU deinterlacer still sees a
     * GPU surface.
     *
     * DEINTERLACE_DOUBLE_RATE (one frame per field, 50i → 50p) is honoured on
     * every backend. QSV picks the filter by rate: `deinterlace_qsv` ALWAYS
     * emits field rate (measured on an Arc A380: 150 frames of 25i in, 299
     * out, for mode 1 and 2 alike), while `vpp_qsv=deinterlace=2` keeps the
     * frame rate (framerate=0 = the input's).
     */
    enableDeinterlacing(): this {
        const doubleRate = config.DEINTERLACE_DOUBLE_RATE;

        let filter: string;
        if (this.hwAccelType === 'vaapi') {
            filter = `deinterlace_vaapi=rate=${doubleRate ? 'field' : 'frame'}`;
        } else if (this.hwAccelType === 'nvenc') {
            filter = `yadif_cuda=mode=${doubleRate ? 'send_field' : 'send_frame'}`;
        } else if (this.hwAccelType === 'qsv') {
            // 2 = advanced (motion-adaptive) in both.
            filter = doubleRate ? 'deinterlace_qsv=mode=2' : 'vpp_qsv=deinterlace=2';
        } else {
            filter = this.softwareDeinterlaceFilter();
        }

        this.prependVideoFilter(filter);
        return this;
    }

    /**
     * Whether enableDeinterlacing() has a filter for the active backend.
     * VideoToolbox and AMF decode to hardware surfaces (videotoolbox_vld /
     * d3d11) that the CPU deinterlacers can't take, and their own deinterlacers
     * are unverified here — the caller skips deinterlacing (as before) rather
     * than emit a graph that fails to configure.
     */
    supportsDeinterlacing(): boolean {
        return this.hwAccelType !== 'videotoolbox' && this.hwAccelType !== 'amf';
    }

    /**
     * Whether enableDeinterlacing() will emit one frame per FIELD (50i → 50p),
     * so the caller can size the GOP for the doubled output rate.
     */
    deinterlaceDoublesRate(): boolean {
        return this.supportsDeinterlacing() && config.DEINTERLACE_DOUBLE_RATE;
    }

    /**
     * The CPU deinterlacer (DEINTERLACE_METHOD: yadif / bwdif / w3fdif). All
     * three take `mode=0` (one frame per frame) / `mode=1` (one per field).
     * Any other value falls back to yadif: the setting is a free string, and
     * a filter that doesn't exist (or takes other options) fails every
     * interlaced transcode — burn-in included.
     */
    private softwareDeinterlaceFilter(): string {
        const method = SOFTWARE_DEINTERLACERS.has(config.DEINTERLACE_METHOD)
            ? config.DEINTERLACE_METHOD
            : 'yadif';
        const mode = config.DEINTERLACE_DOUBLE_RATE ? '1' : '0';
        return `${method}=mode=${mode}`;
    }

    /**
     * Put a filter at the head of the -vf chain (see enableDeinterlacing).
     */
    private prependVideoFilter(filter: string): void {
        const vfIndex = this.args.indexOf('-vf');
        if (vfIndex !== -1) {
            this.args[vfIndex + 1] = `${filter},${this.args[vfIndex + 1]}`;
        } else {
            this.args.push('-vf', filter);
        }
    }

    // =========================================================================
    // Audio Encoding
    // =========================================================================

    /**
     * Set audio codec for a specific stream.
     */
    setAudioCodec(codec: string, streamIndex: number, options?: AudioCodecOptions): this {
        this.args.push(`-c:a:${streamIndex}`, codec);

        if (!options) return this;

        if (options.bitrate) {
            this.args.push(`-b:a:${streamIndex}`, options.bitrate);
        }
        if (options.channels) {
            this.args.push(`-ac:a:${streamIndex}`, options.channels.toString());
        }
        if (options.sampleRate) {
            this.args.push(`-ar:a:${streamIndex}`, options.sampleRate.toString());
        }
        if (options.vbr && codec === 'aac') {
            this.args.push(`-q:a:${streamIndex}`, '2'); // VBR quality
        }

        return this;
    }

    /**
     * Copy audio without re-encoding.
     */
    copyAudio(streamIndex?: number): this {
        if (streamIndex !== undefined) {
            this.args.push(`-c:a:${streamIndex}`, 'copy');
        } else {
            this.args.push('-c:a', 'copy');
        }
        return this;
    }

    /**
     * Set audio bitrate.
     */
    setAudioBitrate(bitrate: string, streamIndex: number): this {
        this.args.push(`-b:a:${streamIndex}`, bitrate);
        return this;
    }

    /**
     * Set audio channel count.
     */
    setAudioChannels(channels: number, streamIndex: number): this {
        this.args.push(`-ac:a:${streamIndex}`, channels.toString());
        return this;
    }

    /**
     * Add an audio filter (properly chains with existing filters).
     */
    addAudioFilter(filter: string): this {
        // Find existing -af or add new one
        const afIndex = this.args.indexOf('-af');
        if (afIndex !== -1) {
            this.args[afIndex + 1] += ',' + filter;
        } else {
            this.args.push('-af', filter);
        }
        return this;
    }

    /**
     * Add a filter for ONE audio output stream (`-filter:a:<i>`). Unlike `-af`,
     * which applies to every audio output and therefore cannot coexist with a
     * copied track ("Filtering and streamcopy cannot be used together"), this
     * touches only the stream that is actually encoded.
     */
    addStreamAudioFilter(streamIndex: number, filter: string): this {
        const flag = `-filter:a:${streamIndex}`;
        const at = this.args.indexOf(flag);
        if (at !== -1) {
            this.args[at + 1] += ',' + filter;
        } else {
            this.args.push(flag, filter);
        }
        return this;
    }

    /**
     * Apply audio boost when downmixing.
     */
    setAudioBoost(factor: number): this {
        if (factor !== 1.0) {
            this.addAudioFilter(`volume=${factor}`);
        }
        return this;
    }

    /**
     * Enable async resampling to fix A/V sync.
     *
     * Even with accurate seeking, source files may have small timestamp gaps or
     * erratic offsets. aresample=async=1 forces FFmpeg to stretch/squeeze/pad
     * the audio to match video timestamps perfectly.
     *
     * CRITICAL: This is required for proper audio playback in HLS multi-audio mode.
     * Without it, audio may appear "silent" due to timestamp drift, even though
     * the audio data exists in the segments.
     *
     * IMPORTANT: This only works when transcoding audio (-c:a is not 'copy').
     * If audio is being copied, this filter has no effect and will error.
     */
    enableAsyncResample(): this {
        // async=1: Fixes internal timestamp drift by stretching/squeezing audio
        // to match video timestamps.
        //
        // first_pts=0 must be SUPPRESSED in these cases:
        //
        // 1. WITH SEEKING: We use -copyts to preserve source timestamps, and
        //    first_pts=0 with -copyts generates hours of silence (from PTS=0 to
        //    the source timestamp). The natural PTS gap between video (from
        //    keyframe) and audio (from seek point) is preserved, and hls.js
        //    calibrates each demuxed stream's timestampOffset independently.
        //
        // 2. VIDEO COPY MODE (audio_transcode): Video packets pass through the
        //    muxer at their original container PTS. If the source has a non-zero
        //    initial PTS (common in MKV), first_pts=0 forces audio to start at
        //    PTS=0 while video retains its natural offset, creating a constant
        //    A/V desync (e.g. audio ~5s ahead of video). Without first_pts=0,
        //    both streams keep their natural PTS and -avoid_negative_ts make_zero
        //    shifts them uniformly.
        //
        // ONLY USE first_pts=0 when video is being decoded (full transcode) and
        // no seeking is active. In that case, HEVC/AV1 decode pre-roll delays
        // audio demuxing by ~6-10s, and first_pts=0 anchors audio to PTS 0 to
        // match the decoded video output.
        const needsFirstPtsZero = !this.hasSeeking && !this.isVideoCopy;
        const filter = needsFirstPtsZero ? 'aresample=async=1:first_pts=0' : 'aresample=async=1';

        // Add at the beginning of the audio filter chain for proper ordering
        const afIndex = this.args.indexOf('-af');
        if (afIndex !== -1) {
            // Prepend to existing chain
            this.args[afIndex + 1] = filter + ',' + this.args[afIndex + 1];
        } else {
            this.args.push('-af', filter);
        }
        return this;
    }

    // =========================================================================
    // HLS Output
    // =========================================================================

    /**
     * Configure HLS output.
     */
    configureHlsOutput(options?: HlsOutputOptions): this {
        const opts = options || {};

        this.args.push('-f', 'hls');
        // -max_delay: Maximum muxing delay in microseconds (5 seconds)
        // This helps with A/V sync by allowing more buffering during muxing
        this.args.push('-max_delay', '5000000');
        this.args.push(
            '-hls_time',
            (opts.segmentDuration || config.FFMPEG_SEGMENT_DURATION).toString(),
        );

        // Always use 'event' in FFmpeg so the playlist is written incrementally.
        // For VOD semantics, we set hls_list_size=0 to keep all segments and
        // add #EXT-X-ENDLIST in our serving layer when the transcode completes.
        // Using -hls_playlist_type vod in FFmpeg would delay the playlist until
        // the entire transcode finishes, which causes startup timeouts.
        this.args.push('-hls_playlist_type', 'event');

        // For VOD mode, keep all segments in the playlist (don't cap the list)
        if (opts.playlistType === 'vod') {
            this.args.push('-hls_list_size', '0');
        }

        if (opts.segmentType === 'fmp4' || !opts.segmentType) {
            this.args.push('-hls_segment_type', 'fmp4');
            this.args.push('-hls_fmp4_init_filename', opts.initFilename || 'init_%v.mp4');
            // frag_discont tells the fMP4 muxer that fragments may have
            // discontinuous timestamps (e.g., after a seek restart). This
            // writes correct DTS/PTS into MOOF::TRAF::TFDT, matching
            // Jellyfin's approach for fMP4 HLS.
            if (
                (opts.startNumber && opts.startNumber > 0) ||
                (this.sourceTimestamps && this.hasSeeking && this.isVideoCopy)
            ) {
                this.args.push('-hls_segment_options', 'movflags=+frag_discont');
            }
        } else {
            this.args.push('-hls_segment_type', 'mpegts');
        }

        if (opts.segmentFilename) {
            this.args.push('-hls_segment_filename', opts.segmentFilename);
        }

        // HLS flags
        // split_by_time is NOT in the defaults, and no caller passes it any more.
        // With -c:v copy the source keyframes are fixed, so it creates non-IDR
        // segment starts that Chrome's MSE silently skips (video appears stuck
        // buffering). On a re-encode it is merely redundant — FullTranscodeStrategy
        // forces an IDR at every segment boundary, so ffmpeg's default keyframe
        // split already yields identical segments — and actively harmful, because
        // ffmpeg suppresses independent_segments (and its #EXT-X-INDEPENDENT-SEGMENTS
        // tag) whenever split_by_time is set. See the measurements in
        // full-transcode-strategy.ts before reintroducing it.
        const defaultFlags = ['independent_segments', 'program_date_time', 'temp_file'];
        const flags = opts.flags || defaultFlags;
        this.args.push('-hls_flags', flags.join('+'));

        // Start numbering segments from this value. With -start_number N,
        // FFmpeg outputs segment_N.m4s, segment_N+1.m4s, etc. This aligns
        // file names with the logical manifest timeline after a seek, so
        // the server doesn't need to translate between logical and physical
        // segment indices.
        if (opts.startNumber && opts.startNumber > 0) {
            this.args.push('-start_number', opts.startNumber.toString());
        }

        return this;
    }

    /**
     * Set var_stream_map for multi-audio HLS demuxing.
     */
    setVarStreamMap(map: string): this {
        this.args.push('-var_stream_map', map);
        return this;
    }

    /**
     * Set master playlist name.
     */
    setMasterPlaylist(name: string): this {
        this.args.push('-master_pl_name', name);
        return this;
    }

    // =========================================================================
    // Output Configuration
    // =========================================================================

    /**
     * Add generic output options.
     *
     * Timestamp handling has three modes:
     *
     * **Non-seeking:** Simple timestamp reset with -avoid_negative_ts make_zero.
     * Audio uses first_pts=0 to handle HEVC/AV1 decode-delay offset.
     *
     * **Seeking + video copy:** Uses -copyts + -start_at_zero. Video starts at
     * the nearest keyframe before seekTime while audio is transcoded from the
     * exact seek point; -start_at_zero normalizes the earliest stream to PTS=0
     * so the keyframe gap appears as a consistent A/V offset rather than a
     * desync.
     *
     * 🔴 What actually reaches the client is NOT a PTS shift. Verified against
     * real prod segments (2026-09-12): with input-side `-ss` the packets keep
     * their source timestamps (first pkt pts 141.141 for a seek to 141.641),
     * `-start_at_zero` shifts by the input's start_time which is 0, and the mov
     * muxer then writes `tfdt` RELATIVE to each track's first DTS — storing the
     * 141.141s as an **empty edit in the init segment's `elst`**. So BMDT really
     * is ~0 in segment 0, but because of the muxer, not this flag.
     *
     * That matters because hls.js 1.7.3 has **zero `elst` handling**: it reads
     * tfdt=0 and rewrites it to `frag.start`, so placement is exact and the
     * playlist's declared times match the buffer (measured: 0.000s diff across
     * 20 segments). A player that DOES honour `elst` would instead apply the
     * empty edit on top — a latent 141s displacement. Do not assume this is
     * safe for AVPlayer/ExoPlayer without checking.
     *
     * **Seeking + video transcode:** Uses -copyts WITHOUT -start_at_zero. Both
     * streams are re-encoded from the exact seek point (no keyframe gap), so
     * source PTS (= seekTime + epsilon) flows through to the output and the
     * fMP4 BMDT aligns with the playlist's cumulative segment timing. With
     * -start_at_zero here, BMDT would be 0 while the playlist declares segment
     * N at N*segmentDuration seconds — a mismatch that hls.js papers over with
     * timestampOffset for a fresh load but trips fragParsingError on mid-stream
     * rebuilds (e.g., version switches).
     *
     * Why not make_zero + -output_ts_offset? -output_ts_offset does NOT
     * affect fMP4 BMDT values (only mpegts PTS). With fMP4 HLS, BMDT starts
     * at ~0 regardless of -output_ts_offset, causing cumulative drift between
     * manifest segment positions and actual buffer positions over hundreds
     * of segments.
     */
    addOutputOptions(): this {
        this.args.push('-fflags', '+genpts');
        this.args.push('-max_muxing_queue_size', config.MAX_MUXING_QUEUE_SIZE.toString());

        if (this.hasSeeking || this.copyTimestampsForced) {
            // Preserve source timestamps so fMP4 BMDT matches the playlist's
            // cumulative segment time (segment N declared at N*segmentDuration).
            this.args.push('-copyts');
            if (this.isVideoCopy) {
                // Video copy starts at the nearest keyframe (possibly BEFORE
                // seekTime) while audio is transcoded from the exact seek.
                // -start_at_zero normalizes the earliest stream to PTS=0 so
                // the keyframe gap is represented as a consistent offset
                // within the fragment. hls.js calibrates timestampOffset from
                // initPTS to bridge the BMDT=0 vs playlist delta.
                this.args.push('-start_at_zero');
            }
            // -avoid_negative_ts disabled prevents FFmpeg from shifting
            // timestamps after we've chosen their anchor.
            this.args.push('-avoid_negative_ts', 'disabled');
        } else {
            // Non-seeking: simple timestamp reset. first_pts=0 in the audio
            // resampler handles the HEVC/AV1 decode-delay offset (see
            // enableAsyncResample). No -copyts needed here.
            this.args.push('-avoid_negative_ts', 'make_zero');
        }

        // Thread count
        if (config.TRANSCODE_THREAD_COUNT > 0) {
            this.args.push('-threads', config.TRANSCODE_THREAD_COUNT.toString());
        }

        return this;
    }

    /**
     * Set output path.
     */
    setOutput(path: string): this {
        this.args.push(path);
        return this;
    }

    /**
     * Set video tag (e.g., for Dolby Vision).
     */
    setVideoTag(tag: string): this {
        this.args.push('-vtag', tag);
        return this;
    }

    /**
     * Apply a video bitstream filter (`-bsf:v`).
     *
     * Bitstream filters operate on the compressed stream without re-encoding, so
     * they are usable on the copy path.
     */
    setVideoBitstreamFilter(filter: string): this {
        this.args.push('-bsf:v', filter);
        return this;
    }

    /**
     * Enable strict mode for experimental codecs.
     */
    enableStrict(): this {
        this.args.push('-strict', 'unofficial');
        return this;
    }

    // =========================================================================
    // Map Streams
    // =========================================================================

    /**
     * Map a video stream from input.
     */
    mapVideo(inputIndex: number, streamIndex: number = 0): this {
        this.args.push('-map', `${inputIndex}:v:${streamIndex}`);
        return this;
    }

    /**
     * Map an audio stream from input.
     */
    mapAudio(inputIndex: number, streamIndex: number): this {
        this.args.push('-map', `${inputIndex}:a:${streamIndex}`);
        this.audioStreamCount++;
        return this;
    }

    /**
     * Map all audio streams from input.
     */
    mapAllAudio(inputIndex: number): this {
        this.args.push('-map', `${inputIndex}:a`);
        return this;
    }

    /**
     * Map a subtitle stream from input.
     */
    mapSubtitle(inputIndex: number, streamIndex: number): this {
        this.args.push('-map', `${inputIndex}:s:${streamIndex}`);
        return this;
    }

    /**
     * Map all subtitle streams from input.
     */
    mapAllSubtitles(inputIndex: number): this {
        this.args.push('-map', `${inputIndex}:s?`);
        return this;
    }

    /**
     * Set subtitle codec for a specific stream.
     * @param codec Codec name (webvtt, mov_text, srt, ass)
     * @param streamIndex Stream index (optional, applies to all if not specified)
     */
    setSubtitleCodec(codec: string, streamIndex?: number): this {
        if (streamIndex !== undefined) {
            this.args.push(`-c:s:${streamIndex}`, codec);
        } else {
            this.args.push('-c:s', codec);
        }
        return this;
    }

    /**
     * Copy subtitles without re-encoding.
     */
    copySubtitles(streamIndex?: number): this {
        if (streamIndex !== undefined) {
            this.args.push(`-c:s:${streamIndex}`, 'copy');
        } else {
            this.args.push('-c:s', 'copy');
        }
        return this;
    }

    // =========================================================================
    // Subtitle Burn-In
    // =========================================================================

    /**
     * Enable subtitle burn-in via overlay filter.
     *
     * Burns a bitmap or text subtitle stream into the video using FFmpeg's
     * filter_complex with the overlay filter. This is used when:
     * - The client requests SubtitleMethod=Encode
     * - Bitmap subtitles (DVBSub, XSUB) have no client-side renderer
     * - Third-party clients prefer server-side rendering
     *
     * Trade-offs:
     * - Hardware decode is disabled (overlay operates on CPU frames)
     * - GPU encode still works (NVENC, QSV, VideoToolbox accept CPU input)
     * - VAAPI encode requires an automatic hwupload filter
     * - Video must be transcoded (can't burn into a copied stream)
     *
     * @param absoluteIndex - Absolute stream index in the media file (e.g., 3 for the 4th stream)
     * @param options.tonemapHdrToSdr - Tonemap HDR→SDR before the overlay (see field docs)
     */
    enableSubtitleBurnIn(
        absoluteIndex: number,
        options?: { tonemapHdrToSdr?: boolean; text?: { filePath: string; relativeIndex: number } },
    ): this {
        this.subtitleBurnInConfig = {
            absoluteIndex,
            text: options?.text,
            tonemapHdrToSdr: options?.tonemapHdrToSdr,
        };
        return this;
    }

    /**
     * Post-process args to apply subtitle burn-in overlay.
     *
     * Transforms the pipeline:
     * 1. Removes hardware decode flags (keeps device args for GPU encode)
     * 2. Extracts existing -vf filters and converts GPU-specific filters to CPU equivalents
     * 3. Builds -filter_complex chain: [0:v]filters[vf];[vf][0:N]overlay[vout]
     * 4. Replaces -map 0:v:0 with -map [vout]
     * 5. For VAAPI: appends format=nv12,hwupload to the chain
     */
    private applySubtitleBurnIn(): void {
        const subIdx = this.subtitleBurnInConfig!.absoluteIndex;

        // 1. Remove hardware decode acceleration (overlay filter operates on CPU frames)
        //    Keep device args (-vaapi_device, -qsv_device) for GPU encode
        this.removeArgPair('-hwaccel');
        this.removeArgPair('-hwaccel_output_format');

        // 2. Extract and transform existing -vf filters
        let existingFilters = '';
        const vfIndex = this.args.indexOf('-vf');
        if (vfIndex !== -1) {
            existingFilters = this.args[vfIndex + 1];
            this.args.splice(vfIndex, 2);

            // Replace GPU-specific filters with CPU equivalents
            existingFilters = existingFilters
                // NVENC's HDR chain is `tonemap_cuda=…,scale_cuda=format=yuv420p`.
                // Mapped piecewise it became `tonemap=hable,scale=format=yuv420p`,
                // which FFmpeg refuses at parse time (software `scale` has no
                // `format` option) — every HDR burn-in on NVIDIA failed to start,
                // and a bare `tonemap` would have mangled colours anyway. Same
                // software tonemapx as VA-API/QSV; verified on an RTX 3090.
                .replace(
                    /tonemap_cuda=[^,]*(,scale_cuda=format=[^,]*)?/g,
                    this.buildSoftwareTonemapxFilter('yuv420p'),
                )
                .replace(/scale_cuda=format=([^,:]+)/g, 'format=$1')
                .replace(/scale_cuda=/g, 'scale=')
                .replace(/scale_vaapi=/g, 'scale=')
                .replace(/scale_qsv=/g, 'scale=')
                // The configured CPU deinterlacer at the configured rate. A bare
                // `yadif` here silently dropped DEINTERLACE_DOUBLE_RATE (50i came
                // out 25p) and ignored DEINTERLACE_METHOD.
                .replace(
                    /deinterlace_vaapi(=[^,]*)?|deinterlace_qsv(=[^,]*)?|vpp_qsv=deinterlace[^,]*|yadif_cuda(=[^,]*)?/g,
                    this.softwareDeinterlaceFilter(),
                )
                // Burn-in decodes in software (the overlay is CPU), so a GPU VPP
                // tonemap must become the SOFTWARE tonemapx — a bare `tonemap`
                // needs linear-light input (zscale) it never gets here and
                // produces garbled colors / a filtergraph error. HEVC is reconciled
                // away from tonemapping earlier (burn-in owns its tonemap prefix);
                // h264/av1 HDR burn-in reach this substitution and must tonemap
                // correctly. (tonemap_cuda is handled at the top of this chain.)
                .replace(/tonemap_vaapi=[^,]*/g, this.buildSoftwareTonemapxFilter('nv12'))
                // vpp_qsv handles tonemapping, deinterlacing, and scaling — replace based on params
                .replace(/vpp_qsv=tonemap[^,]*/g, this.buildSoftwareTonemapxFilter('nv12'))
                .replace(/vpp_qsv=[^,]*/g, 'yadif');
        }

        // 3. Replace video map: -map 0:v:0 → -map [vout]
        for (let i = 0; i < this.args.length; i++) {
            if (this.args[i] === '-map' && /^0:v/.test(this.args[i + 1] ?? '')) {
                this.args[i + 1] = '[vout]';
                break;
            }
        }

        // 4. Build filter_complex chain
        let chain: string;
        // After a CPU overlay the frames are in system memory. GPU encoders that
        // need a hardware surface require an explicit upload: QSV uploads to a QSV
        // surface (whenever the encoder is QSV — burn-in always strips the hwaccel
        // decode, so the frames are always in system memory, bridge or not); VA-API
        // uses a plain hwupload.
        const suffix =
            this.hwAccelType === 'qsv' || this.softwareDecodeBridge === 'qsv'
                ? `,${this.bridgeUploadFilter('qsv')}`
                : this.softwareDecodeBridge === 'vaapi' || this.hwAccelType === 'vaapi'
                  ? // Also via bridgeUploadFilter, NOT a literal `format=nv12`: burn-in
                    // over a 10-bit HDR source reaches here with `-profile:v main10`
                    // (VA-API is excluded from setVideoCodec's profile handling, so
                    // enableHdr10Output pushes it), and an 8-bit surface under a Main10
                    // profile is the same encoder-init rejection, one vendor over.
                    `,${this.bridgeUploadFilter('vaapi')}`
                  : '';

        // HDR→SDR tonemap applied to the video BEFORE the overlay. Needed so the
        // 8-bit CPU-composited frames match an 8-bit SDR encoder profile (Main) and
        // the picture is correctly tonemapped rather than a naive 10→8 bit crush.
        const tonemapPrefix = this.subtitleBurnInConfig!.tonemapHdrToSdr
            ? this.buildSoftwareTonemapxFilter('nv12')
            : '';
        const preOverlay = [existingFilters, tonemapPrefix].filter(Boolean).join(',');

        // A bitmap subtitle (PGS/VobSub) is drawn on its own canvas, which often
        // differs from the frame we overlay onto: the source is downscaled first
        // (so tonemap + overlay run at output size, not 4K), a 720p Blu-ray encode
        // keeps the disc's 1920x1080 PGS track, a 2.39:1 encode is cropped from a
        // 16:9 canvas. Overlaid unscaled, bottom captions land below the frame.
        // scale2ref fits the canvas to the frame WIDTH keeping its aspect, and the
        // overlay anchors it to the bottom: same-shape canvases map exactly, and on
        // a cropped film captions keep their shape and stay near the bottom (a
        // plain rw:rh squashed them). Verified on a Radeon 760M.
        const video = preOverlay ? '[_vf]' : '[0:v]';
        const head = preOverlay ? `[0:v]${preOverlay}[_vf];` : '';
        // format=auto can negotiate 4:4:4 from the PGS palette, which Main10
        // rejects. Constrain chroma AFTER compositing; hardware upload already
        // selects nv12/p010le. GPU encoders consuming system-memory frames use
        // p010le for 10-bit; software encoders use planar yuv420p10le.
        const tenBit = this.isTenBitOutput();
        const overlayFormat = tenBit ? ':format=auto' : '';
        const encoderIdx = this.args.indexOf('-c:v');
        const encoder = encoderIdx >= 0 ? (this.args[encoderIdx + 1] ?? '') : '';
        const tenBitFormat = /_(nvenc|amf|videotoolbox)$/i.test(encoder) ? 'p010le' : 'yuv420p10le';
        const outputFormat = suffix || `,format=${tenBit ? tenBitFormat : 'yuv420p'}`;
        chain =
            `${head}[0:${subIdx}]${video}scale2ref=w=rw:h=rw*ih/iw[_sub][_ref];` +
            `[_ref][_sub]overlay=x=(W-w)/2:y=H-h${overlayFormat}${outputFormat}[vout]`;

        const text = this.subtitleBurnInConfig!.text;
        if (text) {
            // FFmpeg parses the filter graph, then the filter's option value.
            // Escape both layers; argv is passed directly without a shell.
            const escaped = text.filePath
                .replace(/[\\':\s]/g, '\\$&')
                .replace(/[\\'[\],;\s]/g, '\\$&');
            chain = `[0:v]${preOverlay ? preOverlay + ',' : ''}subtitles=filename=${escaped}:si=${text.relativeIndex}${suffix}[vout]`;
        }

        // Insert -filter_complex before the first -map
        const firstMapIdx = this.args.indexOf('-map');
        if (firstMapIdx !== -1) {
            this.args.splice(firstMapIdx, 0, '-filter_complex', chain);
        } else {
            this.args.push('-filter_complex', chain);
        }
    }

    /**
     * Remove an argument and its value from the args array.
     */
    private removeArgPair(arg: string): void {
        const idx = this.args.indexOf(arg);
        if (idx !== -1) {
            this.args.splice(idx, 2);
        }
    }

    // =========================================================================
    // Build
    // =========================================================================

    /**
     * Build and return the FFmpeg arguments array.
     */
    build(): string[] {
        const hadBurnIn = !!this.subtitleBurnInConfig;
        if (this.subtitleBurnInConfig) {
            this.applySubtitleBurnIn();
            this.subtitleBurnInConfig = null; // Prevent double-apply on repeated build() calls
        }
        // Software-decode/HDR bridge: software-processed frames live in system
        // memory, so upload them to a GPU surface for the VA-API-family encoder.
        // 'head' (decode bridge) uploads first, then hardware filters run; 'tail'
        // (VA-API software HDR) runs software filters first, then uploads the SDR
        // result. NVENC needs no upload (its encoder ingests system frames).
        // Skipped for burn-in, which appends its own upload after the overlay.
        if (this.softwareDecodeBridge && !hadBurnIn) {
            this.insertSoftwareDecodeBridge();
        }
        this.pinEightBitSurfaceForEncoder();
        this.alignAmdVaapiEncodeSurface();
        return [...this.args];
    }

    /**
     * Scale the frames handed to `hevc_vaapi`/`av1_vaapi` on an AMD GPU up to a
     * 64x16-aligned size, with the sample aspect ratio corrected so the DISPLAY
     * aspect is unchanged (1920x1080 → 1920x1088 at SAR 136:135 = still 16:9).
     *
     * AMD's VCN encoder (Mesa radeonsi) codes in 64x16 blocks. For any other size
     * the stream comes out broken, in two ways (verified on a Radeon 760M):
     *   • HEVC: the in-band SPS the hardware writes (2560x1088) disagrees with the
     *     one FFmpeg puts in the hvcC (2536x1080). Decoders show green rows at the
     *     bottom / a green right edge, and AVFoundation refuses the file outright
     *     ("Cannot Decode" -12911 / -12430). The Apple apps are HEVC clients, so
     *     on an AMD server every transcode to them failed. How bad it is depends on
     *     the FFmpeg/Mesa pair (jellyfin-ffmpeg + Mesa 25.2.8 and Debian FFmpeg
     *     7.1.5 + Mesa 25.0.7 break; jellyfin-ffmpeg + 25.0.7/26.1 happen not to).
     *     Upstream: FFmpeg trac #11298.
     *   • AV1: dark/black padding at the bottom and right, and AVFoundation can't
     *     decode it with ANY of those pairs.
     * An aligned input leaves nothing to crop, so both SPS agree and every decoder
     * (FFmpeg, AVFoundation) shows a clean picture. 1080p is the common case here:
     * 1080 is not a multiple of 16.
     *
     * Runs last in build() so it sits right before the encoder: after the upload
     * of every software path (decode bridge, VA-API HDR tail, burn-in overlay), so
     * `scale_vaapi` always sees a VA-API surface. `setsar=sar` first turns an
     * UNSET source SAR (0:1, common) into 1:1, so scale_vaapi's SAR compensation
     * has something to scale. Without it the 8 extra rows would stretch the picture.
     * scale_vaapi is a no-op for already-aligned sizes (720p, 2160p).
     *
     * AMD only (PCI vendor 0x1002 — radeonsi is the only AMD VA-API driver).
     * Intel iHD writes consistent headers. h264_vaapi on AMD is clean, so it is
     * left alone. The HLS RESOLUTION attribute keeps the display size, which is
     * what that attribute means.
     */
    private alignAmdVaapiEncodeSurface(): void {
        const encoderIdx = this.args.indexOf('-c:v');
        const encoder = encoderIdx === -1 ? '' : (this.args[encoderIdx + 1] ?? '').toLowerCase();
        if (!/^(hevc|av1)_vaapi$/.test(encoder)) return;
        // scale_vaapi needs a VA-API surface. One reaches the encoder via VA-API
        // hardware decode, or via the upload of the decode bridge / software-HDR
        // path. Neither of those happened without enableHwAccel('vaapi'), and then
        // a VA-API filter would only break a graph that otherwise might run.
        if (
            !this.vaapiDevice ||
            (this.hwAccelType !== 'vaapi' && this.softwareDecodeBridge !== 'vaapi')
        ) {
            return;
        }
        const vendor = readDeviceNodeVendorId(this.vaapiDevice);
        if (vendor === '' && !warnedUnknownVaapiVendor) {
            // Not an error on its own (Intel without sysfs is fine), but an AMD host
            // in this state ships the broken stream, so leave a trace once.
            warnedUnknownVaapiVendor = true;
            logger.warn(
                'Cannot read the VA-API GPU vendor from sysfs; AMD 64x16 HEVC/AV1 alignment not applied',
                { device: this.vaapiDevice },
            );
        }
        if (vendor !== '0x1002') return;

        const align = `setsar=sar,${AMD_VAAPI_ALIGN_SCALE}`;

        // Burn-in moved the video chain into -filter_complex, which ends in the
        // VA-API upload just before [vout]; a -vf next to it is rejected.
        const fcIndex = this.args.indexOf('-filter_complex');
        if (fcIndex !== -1) {
            const graph = this.args[fcIndex + 1] ?? '';
            if (graph.includes(AMD_VAAPI_ALIGN_SCALE)) return;
            const aligned = graph.replace(/\[vout\]$/, `,${align}[vout]`);
            if (aligned === graph) {
                logger.warn('AMD VA-API alignment skipped: filter graph has no trailing [vout]', {
                    graph,
                });
                return;
            }
            this.args[fcIndex + 1] = aligned;
            return;
        }

        const vfIndex = this.args.indexOf('-vf');
        if (vfIndex !== -1 && this.args[vfIndex + 1].includes(AMD_VAAPI_ALIGN_SCALE)) return;
        this.addVideoFilter(align);
    }

    /**
     * Force an 8-bit surface when the hardware H.264 encoder has no 10-bit mode.
     *
     * NO hardware H.264 encoder can produce 10-bit — not on Intel, not on NVIDIA:
     *   • `h264_qsv` advertises only `nv12 qsv` and rejects a p010 surface outright
     *     ("Current pixel format is unsupported" → vost -22). Reproduced on prod.
     *   • `h264_nvenc` exposes no `high10` profile (baseline/main/high/high444p only)
     *     yet still ADVERTISES `p010le` in nvenc's shared pix_fmt list — so FFmpeg
     *     negotiates happily, passes 10-bit through, and NVENC fails at encoder init.
     *     The advertised format is why nothing auto-converts on its own.
     *   • `h264_vaapi` takes an opaque `vaapi` surface whose sw_format carries the depth.
     * HEVC/AV1 are fine everywhere (hevc_qsv lists p010le, hevc_nvenc has main10) and
     * must KEEP their 10-bit surface for HDR — so this is H.264-only by design.
     *
     * Nothing else in the chain converts. The HDR tone-map does emit 8-bit, but a
     * 10-bit **SDR** source (very common for anime remuxes) is not HDR, so no tone-map
     * is added and the 10-bit surface reached the encoder untouched — that was live on
     * prod, failing every preview/transcode of such a file.
     *
     * The encoder can only ever output 8-bit, so pinning is unconditionally correct:
     * for an 8-bit source it is a no-op, for a 10-bit one it is the missing conversion.
     * Skipped when the chain already pins a format (the tone-map branches do) so we
     * don't stack a redundant pass.
     *
     * Verified on prod hardware for QSV. The NVENC arm is verified against the
     * encoder's advertised capabilities (no high10 profile) but not on an NVIDIA GPU.
     */
    private pinEightBitSurfaceForEncoder(): void {
        const encoderIdx = this.args.indexOf('-c:v');
        const encoder = encoderIdx === -1 ? '' : (this.args[encoderIdx + 1] ?? '').toLowerCase();
        if (!/^h264_(qsv|vaapi|nvenc)$/.test(encoder)) return;

        // Subtitle burn-in moved the video chain into -filter_complex. A -vf on the
        // same stream is rejected outright ("Simple and complex filtering cannot be
        // used together") — every H.264 burn-in failed to start. Pin inside the
        // graph instead. VA-API/QSV burn-in already ends in a `format=nv12` upload;
        // NVENC's overlay output is a system-memory frame (burn-in strips -hwaccel),
        // so a plain software `format` is the conversion there.
        const fcIndex = this.args.indexOf('-filter_complex');
        if (fcIndex !== -1) {
            const graph = this.args[fcIndex + 1] ?? '';
            if (/format=(nv12|yuv420p)\b[^;]*\[vout\]$/.test(graph)) return;
            this.args[fcIndex + 1] = graph.replace(/\[vout\]$/, ',format=yuv420p[vout]');
            return;
        }

        // The filter backend, NOT the encoder: NVENC's encoder-only bridge leaves the
        // frames in system memory (backend 'none') while the encoder is still nvenc,
        // and there a plain software `format` is the right conversion. On a GPU
        // surface only that backend's own filter can do it.
        const backend = this.getActiveFilterHwAccel();
        const pin =
            backend === 'qsv'
                ? 'vpp_qsv=format=nv12'
                : backend === 'vaapi'
                  ? 'scale_vaapi=format=nv12'
                  : backend === 'nvenc'
                    ? 'scale_cuda=format=yuv420p'
                    : 'format=yuv420p';

        const vfIndex = this.args.indexOf('-vf');
        const chain = vfIndex === -1 ? '' : this.args[vfIndex + 1];
        if (/format=(nv12|yuv420p)\b/.test(chain)) return;

        this.addVideoFilter(pin);
    }

    /**
     * The hwupload filter chain that moves system-memory frames onto a GPU
     * surface for the active bridge backend. QSV needs an explicit `format=qsv`
     * after the upload; VA-API uploads directly. NVENC (and 'none') return ''
     * because the encoder ingests system frames — no upload.
     */
    private bridgeUploadFilter(backend?: 'qsv' | 'vaapi'): string {
        const target = backend ?? this.softwareDecodeBridge;
        // The uploaded surface must carry the SAME bit depth the encoder was asked
        // to produce. `nv12` is 8-bit: uploading it under a 10-bit encoder profile
        // is a contradiction the QSV runtime rejects at encoder init —
        //   "[hevc_qsv] Current profile is unsupported"
        //   → "Could not open encoder before EOF" → vost -22 (Invalid argument)
        // — with no frame ever produced, so the client only sees a dead stream.
        // Reproduced on the prod Arc A380 against a 10-bit DV-P10/AV1 4K remux:
        // swapping ONLY this token to p010le turns the same command into a clean
        // encode. (8-bit output keeps nv12 — a tone-mapped SDR pipeline really is
        // 8-bit, and p010 there would be a pointless widening.)
        const uploadFormat = this.isTenBitOutput() ? 'p010le' : 'nv12';
        if (target === 'qsv')
            return `format=${uploadFormat},hwupload=extra_hw_frames=16,format=qsv`;
        if (target === 'vaapi') return `format=${uploadFormat},hwupload`;
        return '';
    }

    /**
     * Whether the configured ENCODER will emit >8-bit video.
     *
     * Read off the already-assembled args rather than tracked as state, because
     * the only caller runs from {@link build} — after every encoder/HDR option has
     * been pushed — and the args are what FFmpeg actually receives. `main10` is
     * set by {@link enableHdr10Output} for HEVC; the 10-bit `-pix_fmt` covers the
     * fully-software pipelines where that flag is emitted instead.
     *
     * A tone-mapped HDR→SDR pipeline never sets either, so it correctly reads as
     * 8-bit — the tone-map genuinely produces an 8-bit image.
     */
    private isTenBitOutput(): boolean {
        // NO hardware H.264 encoder can emit >8-bit (see pinEightBitSurfaceForEncoder
        // for the per-vendor evidence). Answering "true" for one would upload a p010
        // surface only for that pin to convert it straight back down — or, on a
        // vendor without the pin, hand the encoder a surface it rejects outright.
        const encoderIdx = this.args.indexOf('-c:v');
        if (/^h264_/i.test(this.args[encoderIdx + 1] ?? '')) return false;

        const profileIdx = this.args.indexOf('-profile:v');
        if (profileIdx !== -1 && /main\s*10/i.test(this.args[profileIdx + 1] ?? '')) return true;

        // An HDR transfer function implies a 10-bit pipeline, and it is the ONLY
        // 10-bit signal some encoders carry: `enableHdr10Output` pushes -color_trc
        // unconditionally, but its `main10` is HEVC-keyed and AV1 is given no
        // `-profile:v` at all. Without this, an HDR AV1 encode on a bridged decode
        // would upload 8-bit nv12 and — because av1_qsv ACCEPTS nv12 — succeed
        // silently, shipping a crushed 8-bit image tagged BT.2020/PQ. No error, no
        // failure event, just banding on a stream that claims to be HDR.
        const trcIdx = this.args.indexOf('-color_trc');
        if (trcIdx !== -1 && /^(smpte2084|arib-std-b67)$/i.test(this.args[trcIdx + 1] ?? ''))
            return true;

        // Anchored on an explicit depth SUFFIX. A bare trailing "12" would match
        // `nv12` — the natural thing to write for an 8-bit QSV/VA-API pipeline —
        // and flip the upload to p010 under an 8-bit `-pix_fmt`, reproducing the
        // auto_scale -38 → vost -22 chain this method exists to prevent.
        const pixFmt = this.args[this.args.indexOf('-pix_fmt') + 1] ?? '';
        return /^p0(10|12|16)(le|be)?$/i.test(pixFmt) || /(10|12|16)(le|be)$/i.test(pixFmt);
    }

    /**
     * jellyfin-ffmpeg's `tonemapx` SIMD HDR→SDR filter, emitting an 8-bit SDR
     * Rec.709 image in the requested pixel format. Handles HDR10/HLG/Dolby Vision
     * input. Same construction as {@link enableTonemapping}'s software branch;
     * used by the subtitle burn-in path, which must tonemap in software (the frames
     * are already on the CPU for the overlay).
     */
    private buildSoftwareTonemapxFilter(format: 'nv12' | 'yuv420p'): string {
        const tonemapxAlgorithms = new Set([
            'none',
            'clip',
            'linear',
            'gamma',
            'reinhard',
            'hable',
            'mobius',
            'bt2390',
            'bt2446a',
            'spline',
        ]);
        const algorithm = tonemapxAlgorithms.has(config.TONEMAPPING_ALGORITHM)
            ? config.TONEMAPPING_ALGORITHM
            : 'hable';
        const desat = config.TONEMAPPING_DESAT;
        const peak = config.TONEMAPPING_PEAK;
        const param = config.TONEMAPPING_PARAM;

        let tonemapx = `tonemapx=tonemap=${algorithm}`;
        if (param > 0) tonemapx += `:param=${param}`;
        if (!Number.isNaN(desat)) tonemapx += `:desat=${desat}`;
        if (peak > 0) tonemapx += `:peak=${peak}`;
        tonemapx += `:p=bt709:t=bt709:m=bt709:r=tv:format=${format}`;
        return tonemapx;
    }

    /**
     * Insert the hwupload bridge into the video filter chain — at the head (decode
     * bridge: upload then hardware filters) or the tail (VA-API software HDR:
     * software filters then upload). No-op when the backend needs no upload
     * (NVENC) or an hwupload already exists in the chain.
     */
    private insertSoftwareDecodeBridge(): void {
        const bridge = this.bridgeUploadFilter();
        if (!bridge) return;
        const vfIndex = this.args.indexOf('-vf');
        if (vfIndex === -1) {
            this.args.push('-vf', bridge);
            return;
        }
        const existing = this.args[vfIndex + 1];
        if (existing.includes('hwupload')) return;
        this.args[vfIndex + 1] =
            this.bridgeUploadPosition === 'tail'
                ? `${existing},${bridge}`
                : `${bridge},${existing}`;
    }
}

// Export the class
export { FFmpegArgsBuilder as default };
