// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure function library for media playback compatibility checks.
 * No config reads, no database access, no side effects.
 */

import type { TranscodeReason, TranscodeReasonCode } from '$lib/schemas/playback-plan';
import * as m from '$lib/paraglide/messages';

// ──────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────

export type HdrType = 'sdr' | 'hdr10' | 'hdr10plus' | 'hlg' | 'dovi' | 'dovi_hdr10';

export interface DeviceCapabilities {
    videoCodecs: Set<string>;
    audioCodecs: Set<string>;
    /** HLS-specific audio codec support (e.g. AC-3 over HLS but not direct play). Falls back to audioCodecs when absent. */
    hlsAudioCodecs?: Set<string>;
    containers: Set<string>;
    hdrFormats?: Set<string>;
    /** Whether the device can switch audio tracks during direct play (e.g. Safari with HLS). */
    canSwitchAudioInDirectPlay: boolean;
    /** The client reloads copy-HLS sources for unbuffered seeks and audio changes.
     * Opts native clients into the muxed, keyframe-derived VOD timeline. */
    supportsHlsCopyReload?: boolean;
    /** Native HLS needs audio as separate renditions (demux master with CODECS), even
     *  for copied video. Sent by the iPhone/iPad web player (`da:1`); see
     *  PlaybackPlannerService.resolveHlsAudioMode. */
    prefersHlsDemuxAudio?: boolean;
    /** Allowed video profiles (pipe-separated, case-insensitive, e.g. "high|main|baseline").
     *  Content with a profile not in the list will be flagged as incompatible. */
    maxVideoProfile?: string;
    /** Maximum supported video level as raw ffprobe value (e.g. 51 for H.264 Level 5.1,
     *  153 for HEVC Level 5.1). Both sides must use the same encoding. */
    maxVideoLevel?: number;
    /** Maximum supported video width in pixels. */
    maxWidth?: number;
    /** Maximum supported video height in pixels. */
    maxHeight?: number;
    /** User-selected max height from the player's quality settings (pixels).
     *  Treated as an additional cap alongside `maxHeight` but reported differently
     *  so the UI can say "your quality cap" instead of "device maximum". */
    userSelectedMaxHeight?: number;
    /** Maximum supported bitrate in bits/sec (container-level) — hardware/device cap. */
    maxBitrate?: number;
    /** User-selected max bitrate from the player's quality settings (bits/sec).
     *  Treated as an additional cap alongside `maxBitrate` but reported differently
     *  so the UI can say "your quality cap" instead of "device maximum". */
    userSelectedMaxBitrate?: number;
    /** Maximum audio channels supported (e.g. 6 for 5.1). */
    maxAudioChannels?: number;
    /** Per-codec constraints (level, profile) keyed by lowercase codec name.
     *  When present, checkCompatibility() uses the entry matching the media's
     *  video codec instead of the flat maxVideoLevel / maxVideoProfile fields.
     *  - maxProfile: pipe-separated allowed profiles (from EqualsAny conditions)
     *  - excludedProfiles: pipe-separated excluded profiles (from NotEquals conditions) */
    codecConstraints?: Record<
        string,
        { maxLevel?: number; maxProfile?: string; excludedProfiles?: string }
    >;
}

export interface MediaInfo {
    videoCodec: string;
    /** Bit depth of the video stream (8, 10, 12). Used to detect 10-bit H.264 which no browser can decode. */
    videoBitDepth?: number;
    /** Video profile name as reported by ffprobe (e.g. 'High', 'Main 10'). */
    videoProfile?: string;
    /** Video level as reported by ffprobe (e.g. 51 for Level 5.1). */
    videoLevel?: number;
    /** Video width in pixels. */
    width?: number;
    /** Video height in pixels. */
    height?: number;
    /** Container-level bitrate in bits/sec. */
    bitrate?: number;
    /** All audio codec names present in the file (one per track). */
    audioCodecs: string[];
    audioTrackCount: number;
    /** Maximum audio channel count across all tracks. */
    audioChannels?: number;
    /** Container format as reported by ffprobe (may be comma-separated, e.g. 'matroska,webm'). */
    container: string;
    hdr: HdrType;
}

export type PlayRecommendation =
    'direct' | 'remux' | 'audio_transcode' | 'full_transcode' | 'audio_only';

export interface CompatibilityResult {
    videoCompatible: boolean;
    /** True when ALL audio tracks are device-compatible (alias for audioAllCompatible). */
    audioCompatible: boolean;
    /** Audio compatibility when using HLS delivery (alias for audioAllCompatibleInHls). */
    audioCompatibleInHls: boolean;
    /** True when ALL audio tracks are device-compatible. */
    audioAllCompatible: boolean;
    /** True when at least one audio track is device-compatible. */
    audioAnyCompatible: boolean;
    /** True when ALL audio tracks are compatible via HLS delivery. */
    audioAllCompatibleInHls: boolean;
    /** True when at least one audio track is compatible via HLS delivery. */
    audioAnyCompatibleInHls: boolean;
    /** Audio codecs that need transcoding (not supported by device). */
    incompatibleAudioCodecs: string[];
    containerCompatible: boolean;
    needsTonemapping: boolean;
    needsHlsForAudio: boolean;
    /** True when video level exceeds device max (e.g. H.264 Level 5.2 on a Level 5.1 device). */
    videoLevelExceeded: boolean;
    /** True when video profile doesn't match device allowed profiles (EqualsAny). */
    videoProfileExceeded: boolean;
    /** True when video profile matches a device-excluded profile (NotEquals). */
    videoProfileExcluded: boolean;
    /** True when video resolution exceeds device max width/height, or the
     *  user-selected height cap. */
    resolutionExceeded: boolean;
    /** Which cap triggered the resolution exceedance. `'user'` means the
     *  user-selected quality cap was the binding constraint; `'device'` means
     *  the device profile's maxWidth/maxHeight was; `null` when resolution
     *  was not exceeded. */
    resolutionExceededSource: 'user' | 'device' | null;
    /** True when container bitrate exceeds the effective (min of device/user) max. */
    bitrateExceeded: boolean;
    /** Which cap triggered the bitrate exceedance. `'user'` means the user-selected
     *  quality cap was the binding constraint; `'device'` means the device hardware
     *  cap was; `null` when bitrate was not exceeded. */
    bitrateExceededSource: 'user' | 'device' | null;
    /** True when audio channel count exceeds device max. */
    audioChannelsExceeded: boolean;
    recommended: PlayRecommendation;
}

export interface ServerEncodeCaps {
    canEncodeCodec: (codec: string) => boolean;
    /**
     * Whether the server can encode this codec efficiently (GPU hardware).
     * Used by selectTranscodeCodec to avoid picking codecs that would require
     * slow CPU-only encoding (e.g. libsvtav1 on a machine without av1_nvenc).
     */
    canEfficientlyEncodeCodec: (codec: string) => boolean;
}

// ──────────────────────────────────────────────────────────
// Defaults
// ──────────────────────────────────────────────────────────

const DEFAULT_CONTAINERS = new Set(['mp4', 'webm', 'm4v', 'mov']);

/**
 * ffprobe reports HEVC as 'hevc'; some Jellyfin-exported device profiles list
 * the 'h265' alias, which would otherwise never match a real stream.
 */
export function normalizeVideoCodecToken(codec: string): string {
    const c = codec.toLowerCase();
    if (c === 'h265' || c === 'h.265') return 'hevc';
    if (c === 'h.264') return 'h264';
    return c;
}

// ──────────────────────────────────────────────────────────
// checkCompatibility
// ──────────────────────────────────────────────────────────

/**
 * Determines whether `media` can be played by a device with `caps`.
 * Returns a CompatibilityResult including a play recommendation.
 */
export function checkCompatibility(
    media: MediaInfo,
    caps: DeviceCapabilities,
): CompatibilityResult {
    const containers = caps.containers.size > 0 ? caps.containers : DEFAULT_CONTAINERS;
    const hlsAudio = caps.hlsAudioCodecs ?? caps.audioCodecs;

    // Video — null/empty means no video stream (audio-only), which is always compatible.
    // 10-bit H.264 (Hi10P) is never decodable by browsers despite H.264 support.
    const is10BitH264 = media.videoCodec === 'h264' && (media.videoBitDepth ?? 8) > 8;
    const videoCompatible =
        !media.videoCodec || (caps.videoCodecs.has(media.videoCodec) && !is10BitH264);

    // Audio — per-track compatibility (.every() returns true for empty arrays — vacuous truth)
    const audioAllCompatible = media.audioCodecs.every((codec) => caps.audioCodecs.has(codec));
    const audioAnyCompatible =
        media.audioCodecs.length === 0 ||
        media.audioCodecs.some((codec) => caps.audioCodecs.has(codec));
    const audioAllCompatibleInHls = media.audioCodecs.every((codec) => hlsAudio.has(codec));
    const audioAnyCompatibleInHls =
        media.audioCodecs.length === 0 || media.audioCodecs.some((codec) => hlsAudio.has(codec));
    const incompatibleAudioCodecs = [
        ...new Set(media.audioCodecs.filter((codec) => !caps.audioCodecs.has(codec))),
    ];
    // Backwards-compatible aliases
    const audioCompatible = audioAllCompatible;
    const audioCompatibleInHls = audioAllCompatibleInHls;

    // Container — handle ffprobe comma-separated format
    const containerParts = media.container.split(',').map((s) => s.trim());
    const containerCompatible = containerParts.some((part) => containers.has(part));

    // Dolby Vision re-encode: any DV bitstream requires server-side re-encoding when
    // the client does not advertise `'dovi'` in its hdrFormats. This is the union of
    // two failure modes:
    //
    // Profile 5/7 (`'dovi'`): pure DV, no HDR10 base — non-DV decoders have nothing
    //   to fall back to.
    // Profile 8 (`'dovi_hdr10'`): HDR10 base + DV enhancement layer. In principle the
    //   base layer is playable, but in practice the DV metadata and `dvh1`/`dvhe`
    //   codec-parameter strings cause browser MSE SourceBuffer to throw
    //   `bufferAddCodecError` (observed on Chrome/Firefox/Edge). Native clients that
    //   can actually decode the P8 base layer should expose `'dovi'` in their caps to
    //   opt out of this path.
    //
    // We reuse the `needsTonemapping` name (and the `hdr_tonemap_dolby_vision` reason
    // code) because the full_transcode outcome is identical even though P8 isn't
    // strictly a tone-map — it's a codec-string sanitization.
    //
    // NOTE: Intentional divergence — this shared module does NOT trigger tonemapping
    // for HDR10/HLG on non-HDR devices. The FFmpeg engine (transcode-decision.ts) adds
    // that check separately because browsers handle HDR→SDR via their display pipeline,
    // while native clients (tvOS) may need explicit server-side tonemapping.
    const hasDvSupport = caps.hdrFormats?.has('dovi') ?? false;
    const needsTonemapping = (media.hdr === 'dovi' || media.hdr === 'dovi_hdr10') && !hasDvSupport;

    // Multi-audio track switching
    const needsHlsForAudio = media.audioTrackCount > 1 && !caps.canSwitchAudioInDirectPlay;

    // Resolve per-codec constraints: prefer codecConstraints[videoCodec], then _default, then flat fields
    const codecKey = media.videoCodec?.toLowerCase();
    const perCodec =
        (codecKey ? caps.codecConstraints?.[codecKey] : undefined) ??
        caps.codecConstraints?.['_default'];
    const effectiveMaxLevel = perCodec?.maxLevel ?? caps.maxVideoLevel;
    const effectiveMaxProfile = perCodec?.maxProfile ?? caps.maxVideoProfile;
    const effectiveExcludedProfiles = perCodec?.excludedProfiles;

    // Video level check (e.g. H.264 Level 5.2 on a device that maxes at 5.1)
    const videoLevelExceeded =
        effectiveMaxLevel !== undefined &&
        media.videoLevel !== undefined &&
        media.videoLevel > effectiveMaxLevel;

    // Video profile check — effectiveMaxProfile is pipe-separated allowed profiles (EqualsAny)
    const videoProfileExceeded =
        effectiveMaxProfile !== undefined &&
        media.videoProfile !== undefined &&
        !effectiveMaxProfile
            .toLowerCase()
            .split('|')
            .map((s) => s.trim())
            .includes(media.videoProfile.toLowerCase());

    // Excluded profiles check — pipe-separated excluded profiles (NotEquals)
    const videoProfileExcluded =
        effectiveExcludedProfiles !== undefined &&
        media.videoProfile !== undefined &&
        effectiveExcludedProfiles
            .toLowerCase()
            .split('|')
            .map((s) => s.trim())
            .includes(media.videoProfile.toLowerCase());

    // Resolution check — enforce both device cap and user-selected height cap.
    // Mirrors the bitrate check below: when both are set, the smaller one is
    // the binding constraint, and we record which one triggered the
    // exceedance so the UI can explain the cause accurately.
    const deviceResolutionExceeded =
        (caps.maxWidth !== undefined && media.width !== undefined && media.width > caps.maxWidth) ||
        (caps.maxHeight !== undefined &&
            media.height !== undefined &&
            media.height > caps.maxHeight);
    const userResolutionExceeded =
        caps.userSelectedMaxHeight !== undefined &&
        media.height !== undefined &&
        media.height > caps.userSelectedMaxHeight;
    const resolutionExceeded = deviceResolutionExceeded || userResolutionExceeded;
    let resolutionExceededSource: 'user' | 'device' | null = null;
    if (resolutionExceeded) {
        if (deviceResolutionExceeded && userResolutionExceeded) {
            resolutionExceededSource =
                caps.userSelectedMaxHeight !== undefined &&
                caps.maxHeight !== undefined &&
                caps.userSelectedMaxHeight <= caps.maxHeight
                    ? 'user'
                    : 'device';
        } else if (userResolutionExceeded) {
            resolutionExceededSource = 'user';
        } else {
            resolutionExceededSource = 'device';
        }
    }

    // Bitrate check — enforce both device cap and user-selected cap.
    // When both are set, the smaller one is the binding constraint; we record which
    // one triggered the exceedance so the UI can explain the cause accurately.
    let bitrateExceeded = false;
    let bitrateExceededSource: 'user' | 'device' | null = null;
    if (media.bitrate !== undefined) {
        const deviceExceeded = caps.maxBitrate !== undefined && media.bitrate > caps.maxBitrate;
        const userExceeded =
            caps.userSelectedMaxBitrate !== undefined &&
            media.bitrate > caps.userSelectedMaxBitrate;
        if (deviceExceeded || userExceeded) {
            bitrateExceeded = true;
            // Prefer the tighter cap as the "cause". If only one is exceeded, that's the source.
            if (deviceExceeded && userExceeded) {
                bitrateExceededSource =
                    caps.userSelectedMaxBitrate! <= caps.maxBitrate! ? 'user' : 'device';
            } else if (userExceeded) {
                bitrateExceededSource = 'user';
            } else {
                bitrateExceededSource = 'device';
            }
        }
    }

    // Audio channel count check
    const audioChannelsExceeded =
        caps.maxAudioChannels !== undefined &&
        media.audioChannels !== undefined &&
        media.audioChannels > caps.maxAudioChannels;

    // Any video-level constraint failure forces full_transcode
    const videoConstraintFailed =
        videoLevelExceeded ||
        videoProfileExceeded ||
        videoProfileExcluded ||
        resolutionExceeded ||
        bitrateExceeded;

    // Derive recommendation (priority order matches spec)
    let recommended: PlayRecommendation;
    if (needsTonemapping) {
        recommended = 'full_transcode';
    } else if (!videoCompatible || videoConstraintFailed) {
        recommended = 'full_transcode';
    } else if (audioChannelsExceeded) {
        recommended = 'audio_transcode';
    } else if (!audioAnyCompatible && !audioAnyCompatibleInHls) {
        // ALL tracks are incompatible in both direct play and HLS — must transcode audio
        recommended = 'audio_transcode';
    } else if (!audioAllCompatible && audioAnyCompatibleInHls) {
        // Some tracks are incompatible but at least one works in HLS — remux with per-track decisions
        recommended = 'remux';
    } else if (!audioAllCompatible && !audioAnyCompatibleInHls) {
        // Some tracks are incompatible and none work in HLS, but at least one works in direct play
        // — the player will use a compatible track, incompatible ones need transcoding
        recommended = 'audio_transcode';
    } else if (!containerCompatible) {
        recommended = 'remux';
    } else if (needsHlsForAudio) {
        recommended = 'remux';
    } else {
        recommended = 'direct';
    }

    return {
        videoCompatible,
        audioCompatible,
        audioCompatibleInHls,
        audioAllCompatible,
        audioAnyCompatible,
        audioAllCompatibleInHls,
        audioAnyCompatibleInHls,
        incompatibleAudioCodecs,
        containerCompatible,
        needsTonemapping,
        needsHlsForAudio,
        videoLevelExceeded,
        videoProfileExceeded,
        videoProfileExcluded,
        resolutionExceeded,
        resolutionExceededSource,
        bitrateExceeded,
        bitrateExceededSource,
        audioChannelsExceeded,
        recommended,
    };
}

// ──────────────────────────────────────────────────────────
// selectTranscodeCodec
// ──────────────────────────────────────────────────────────

export type TranscodeCodec = 'av1' | 'hevc' | 'h264';

const HARDWARE_CODEC_PRIORITY: readonly TranscodeCodec[] = ['av1', 'hevc', 'h264'];
const DEFAULT_SOFTWARE_CODEC_PRIORITY: readonly TranscodeCodec[] = ['h264', 'hevc', 'av1'];
const TRANSCODE_CODECS: ReadonlySet<TranscodeCodec> = new Set(['av1', 'hevc', 'h264']);

/** Delivery path for the selected codec. Mirrors the playback-plan enum — kept
 *  as a local string union so this module stays free of schema imports. */
export type TranscodeDeliveryPath = 'direct_file' | 'native_hls' | 'mse_hls';

export interface SelectTranscodeCodecContext {
    /** How content reaches the player. `mse_hls` gates AV1 unless
     *  `allowAv1OnMseHls` is true (hls.js fMP4 AV1 is unreliable cross-browser). */
    deliveryPath: TranscodeDeliveryPath;
    /** Source video width in pixels — triggers the software 4K clamp. */
    sourceWidth?: number;
    /** Operator override: allow AV1 for Chrome/Firefox (hls.js) clients.
     *  Default false because hls.js AV1 parse is flaky today. */
    allowAv1OnMseHls?: boolean;
    /** Kill switch: disable HEVC across both HW and SW paths. Default true. */
    allowHevcEncoding?: boolean;
    /** Kill switch: disable AV1 across both HW and SW paths. Default true. */
    allowAv1Encoding?: boolean;
    /** Codec priority order for the software fallback pass (fastest-first).
     *  Default `['h264', 'hevc', 'av1']` — libx264 is the only software encoder
     *  reliably fast enough to meet real-time on modest CPUs. */
    softwareCodecPreference?: readonly TranscodeCodec[];
    /** Source-width cap above which software encoding is forced to h264.
     *  Prevents libx265 / libsvtav1 at 4K on typical CPUs. 0 = no cap. */
    softwareMaxWidth?: number;
}

/**
 * Selects the best transcode codec by intersecting client decode support with
 * server encode capabilities, subject to delivery-path and operator constraints.
 *
 * Two-pass strategy:
 *   1. Hardware pass — prefers av1 > hevc > h264 when the server can GPU-encode.
 *   2. Software pass — prefers h264 > hevc > av1 (configurable) because
 *      libx264 is ~5–10× faster than libx265/libsvtav1 at the same quality tier,
 *      and the latter two routinely miss real-time on modest CPUs.
 *
 * Correctness gates applied to both passes:
 *   - AV1 is skipped when `deliveryPath === 'mse_hls'` unless explicitly allowed
 *     (hls.js fMP4 AV1 parse triggers fragParsingError cross-browser).
 *   - HEVC / AV1 are skipped when the corresponding kill switch is false.
 * Software-pass extra gate:
 *   - Sources wider than `softwareMaxWidth` are locked to h264 (4K safety).
 */
export function selectTranscodeCodec(
    caps: DeviceCapabilities,
    server: ServerEncodeCaps,
    context?: SelectTranscodeCodecContext,
): TranscodeCodec | null {
    const deliveryPath = context?.deliveryPath ?? 'mse_hls';
    const allowAv1OnMseHls = context?.allowAv1OnMseHls ?? false;
    const allowHevc = context?.allowHevcEncoding ?? true;
    const allowAv1Global = context?.allowAv1Encoding ?? true;
    const softwarePriority = context?.softwareCodecPreference ?? DEFAULT_SOFTWARE_CODEC_PRIORITY;
    const softwareMaxWidth = context?.softwareMaxWidth ?? 0;
    const sourceWidth = context?.sourceWidth ?? 0;

    const av1OkForDelivery = deliveryPath !== 'mse_hls' || allowAv1OnMseHls;
    // Unknown width (0) defensively trips the clamp when enabled: a failed probe
    // on a 4K source must not silently pick libx265/libsvtav1 — that is the exact
    // bug this knob exists to prevent.
    const softwareWidthUnknown = sourceWidth <= 0;
    const softwareExceedsWidth =
        softwareMaxWidth > 0 && (softwareWidthUnknown || sourceWidth > softwareMaxWidth);

    const isEligible = (
        codec: TranscodeCodec,
        { isSoftwarePass }: { isSoftwarePass: boolean },
    ): boolean => {
        if (!caps.videoCodecs.has(codec)) return false;
        if (codec === 'hevc' && !allowHevc) return false;
        if (codec === 'av1') {
            if (!allowAv1Global) return false;
            if (!av1OkForDelivery) return false;
        }
        // Software 4K clamp: only h264 is fast enough on CPU for 4K.
        if (isSoftwarePass && softwareExceedsWidth && codec !== 'h264') return false;
        return true;
    };

    // Pass 1 — hardware (efficient). Quality-first: av1 > hevc > h264.
    for (const codec of HARDWARE_CODEC_PRIORITY) {
        if (!isEligible(codec, { isSoftwarePass: false })) continue;
        if (server.canEfficientlyEncodeCodec(codec)) return codec;
    }

    // Pass 2 — software fallback. Speed-first by default: h264 > hevc > av1.
    for (const codec of softwarePriority) {
        if (!TRANSCODE_CODECS.has(codec)) continue;
        if (!isEligible(codec, { isSoftwarePass: true })) continue;
        if (server.canEncodeCodec(codec)) return codec;
    }

    return null;
}

/**
 * Parses a comma-separated codec-preference string (e.g. "h264,hevc,av1") into
 * a priority array. Unknown tokens are dropped; falls back to the default when
 * nothing valid remains.
 */
export function parseSoftwareCodecPreference(
    raw: string | undefined | null,
): readonly TranscodeCodec[] {
    if (!raw) return DEFAULT_SOFTWARE_CODEC_PRIORITY;
    const parsed = raw
        .split(',')
        .map((token) => token.trim().toLowerCase())
        .filter((token): token is TranscodeCodec => TRANSCODE_CODECS.has(token as TranscodeCodec));
    return parsed.length > 0 ? parsed : DEFAULT_SOFTWARE_CODEC_PRIORITY;
}

// ──────────────────────────────────────────────────────────
// buildTranscodeReasons / buildTranscodeReasonCodes
// ──────────────────────────────────────────────────────────

/**
 * Returns structured, language-agnostic reasons explaining why transcoding is
 * needed. Returns an empty array when direct play is possible.
 *
 * This is the canonical source of transcode reasons — `buildTranscodeReasons`
 * renders these to English strings for legacy clients.
 */
export function buildTranscodeReasonCodes(
    media: MediaInfo,
    compat: CompatibilityResult,
    caps?: DeviceCapabilities,
): TranscodeReason[] {
    if (compat.recommended === 'direct') {
        return [];
    }

    const reasons: TranscodeReason[] = [];

    if (compat.needsTonemapping) {
        reasons.push({ code: 'hdr_tonemap_dolby_vision' });
    }

    if (!compat.videoCompatible) {
        const is10BitH264 = media.videoCodec === 'h264' && (media.videoBitDepth ?? 8) > 8;
        if (is10BitH264) {
            reasons.push({ code: 'video_10bit_h264' });
        } else {
            reasons.push({
                code: 'video_codec_incompatible',
                params: { codec: media.videoCodec },
            });
        }
    }

    if (!compat.audioAllCompatible) {
        const unsupported =
            compat.incompatibleAudioCodecs.length > 0
                ? compat.incompatibleAudioCodecs
                : media.audioCodecs;
        if (unsupported.length > 0) {
            reasons.push({
                code: 'audio_codec_incompatible',
                params: {
                    codecs: unsupported.map((c) => c.toUpperCase()).join(', '),
                },
            });
        }
    }

    if (!compat.containerCompatible && media.container) {
        reasons.push({
            code: 'container_incompatible',
            params: { container: media.container.toUpperCase() },
        });
    }

    if (compat.needsHlsForAudio) {
        reasons.push({ code: 'multi_audio_needs_hls' });
    }

    if (compat.videoLevelExceeded) {
        const codecKey = media.videoCodec?.toLowerCase();
        const perCodec =
            (codecKey ? caps?.codecConstraints?.[codecKey] : undefined) ??
            caps?.codecConstraints?.['_default'];
        const effectiveMaxLevel = perCodec?.maxLevel ?? caps?.maxVideoLevel;
        const params: Record<string, string | number> = {
            level: media.videoLevel ?? '?',
        };
        if (effectiveMaxLevel !== undefined) params.max = effectiveMaxLevel;
        reasons.push({ code: 'video_level_exceeded', params });
    }

    if (compat.videoProfileExceeded) {
        const codecKey = media.videoCodec?.toLowerCase();
        const perCodec =
            (codecKey ? caps?.codecConstraints?.[codecKey] : undefined) ??
            caps?.codecConstraints?.['_default'];
        const effectiveMaxProfile = perCodec?.maxProfile ?? caps?.maxVideoProfile;
        const params: Record<string, string | number> = {
            profile: media.videoProfile ?? '?',
        };
        if (effectiveMaxProfile) params.allowed = effectiveMaxProfile;
        reasons.push({ code: 'video_profile_exceeded', params });
    }

    if (compat.videoProfileExcluded) {
        reasons.push({
            code: 'video_profile_excluded',
            params: { profile: media.videoProfile ?? '?' },
        });
    }

    if (compat.resolutionExceeded) {
        const fromUser = compat.resolutionExceededSource === 'user';
        const params: Record<string, string | number> = {
            width: media.width ?? '?',
            height: media.height ?? '?',
        };
        if (fromUser) {
            if (caps?.userSelectedMaxHeight !== undefined) {
                params.maxHeight = caps.userSelectedMaxHeight;
            }
        } else if (caps?.maxWidth !== undefined) {
            params.maxWidth = caps.maxWidth;
            params.maxHeight = caps.maxHeight ?? '?';
        }
        reasons.push({
            code: fromUser ? 'resolution_exceeded_user_cap' : 'resolution_exceeded',
            params,
        });
    }

    if (compat.bitrateExceeded) {
        const fromUser = compat.bitrateExceededSource === 'user';
        const limitingCap = fromUser ? caps?.userSelectedMaxBitrate : caps?.maxBitrate;
        const params: Record<string, string | number> = {
            mbps: media.bitrate ? (media.bitrate / 1_000_000).toFixed(1) : '?',
        };
        if (limitingCap !== undefined) {
            params.maxMbps = (limitingCap / 1_000_000).toFixed(1);
        }
        reasons.push({
            code: fromUser ? 'bitrate_exceeded_user_cap' : 'bitrate_exceeded',
            params,
        });
    }

    if (compat.audioChannelsExceeded) {
        reasons.push({
            code: 'audio_channels_exceeded',
            params: {
                channels: media.audioChannels ?? '?',
                max: caps?.maxAudioChannels ?? '?',
            },
        });
    }

    return reasons;
}

/**
 * Returns English reason strings. Kept as a thin wrapper over
 * `buildTranscodeReasonCodes` so both outputs stay in lockstep.
 */
export function buildTranscodeReasons(
    media: MediaInfo,
    compat: CompatibilityResult,
    caps?: DeviceCapabilities,
): string[] {
    return buildTranscodeReasonCodes(media, compat, caps).map(renderTranscodeReasonEn);
}

function renderTranscodeReasonEn(reason: TranscodeReason): string {
    const p = reason.params ?? {};
    switch (reason.code) {
        case 'hdr_tonemap_dolby_vision':
            return m.player_reason_hdr_tonemap_dolby_vision();
        case 'video_10bit_h264':
            return m.player_reason_video_10bit_h264();
        case 'video_codec_incompatible':
            return m.player_reason_video_codec_incompatible({
                codec: String(p.codec),
            });
        case 'audio_codec_incompatible':
            return m.player_reason_audio_codec_incompatible({
                codecs: String(p.codecs),
            });
        case 'container_incompatible':
            return m.player_reason_container_incompatible({
                container: String(p.container),
            });
        case 'multi_audio_needs_hls':
            return m.player_reason_multi_audio_needs_hls();
        case 'video_level_exceeded':
            if (p.max !== undefined) {
                return m.player_reason_video_level_exceeded_max({
                    level: String(p.level),
                    max: String(p.max),
                });
            }
            return m.player_reason_video_level_exceeded({
                level: String(p.level),
            });
        case 'video_profile_exceeded':
            if (p.allowed) {
                return m.player_reason_video_profile_exceeded_allowed({
                    profile: String(p.profile),
                    allowed: String(p.allowed),
                });
            }
            return m.player_reason_video_profile_exceeded({
                profile: String(p.profile),
            });
        case 'video_profile_excluded':
            return m.player_reason_video_profile_excluded({
                profile: String(p.profile),
            });
        case 'resolution_exceeded':
            if (p.maxWidth !== undefined) {
                return m.player_reason_resolution_exceeded_max({
                    width: String(p.width),
                    height: String(p.height),
                    maxWidth: String(p.maxWidth),
                    maxHeight: String(p.maxHeight ?? '?'),
                });
            }
            return m.player_reason_resolution_exceeded({
                width: String(p.width),
                height: String(p.height),
            });
        case 'resolution_exceeded_user_cap':
            if (p.maxHeight !== undefined) {
                return m.player_reason_resolution_exceeded_user_cap_max({
                    width: String(p.width),
                    height: String(p.height),
                    maxHeight: String(p.maxHeight),
                });
            }
            return m.player_reason_resolution_exceeded_user_cap({
                width: String(p.width),
                height: String(p.height),
            });
        case 'bitrate_exceeded':
            if (p.maxMbps !== undefined) {
                return m.player_reason_bitrate_exceeded_max({
                    mbps: String(p.mbps),
                    maxMbps: String(p.maxMbps),
                });
            }
            return m.player_reason_bitrate_exceeded({ mbps: String(p.mbps) });
        case 'bitrate_exceeded_user_cap':
            if (p.maxMbps !== undefined) {
                return m.player_reason_bitrate_exceeded_user_cap_max({
                    mbps: String(p.mbps),
                    maxMbps: String(p.maxMbps),
                });
            }
            return m.player_reason_bitrate_exceeded_user_cap({
                mbps: String(p.mbps),
            });
        case 'audio_channels_exceeded':
            return m.player_reason_audio_channels_exceeded({
                channels: String(p.channels),
                max: String(p.max),
            });
        case 'client_requested':
        case 'subtitle_burn_in':
        case 'audio_format_requested':
        case 'audio_bitrate_requested':
        case 'audio_bitrate_exceeded':
        case 'audio_container_incompatible':
            return reason.code.replaceAll('_', ' ');
        case 'preview_mode':
            return m.player_reason_preview_mode();
        default: {
            const exhaustive: never = reason.code;
            return exhaustive;
        }
    }
}

// Keep the unused-import of TranscodeReasonCode meaningful for type-safety downstream.
export type { TranscodeReason, TranscodeReasonCode };

// ──────────────────────────────────────────────────────────
// mediaInfoFromStreamRows
// ──────────────────────────────────────────────────────────

/**
 * Convert database stream rows to MediaInfo for compatibility checking.
 * Bridges the gap between Jellyfin-format stream data and the planner's media model.
 */
export function mediaInfoFromStreamRows(
    rows: Array<{
        stream_type: string;
        codec: string | null;
        channels?: number | null;
        is_default?: boolean;
        profile?: string | null;
        level?: number | null;
        width?: number | null;
        height?: number | null;
        bit_depth?: number | null;
        video_range_type?: string | null;
    }>,
    container: string,
    totalBitrate?: number | null,
): MediaInfo {
    const videoStream = rows.find((s) => s.stream_type === 'video');
    const audioStreams = rows.filter((s) => s.stream_type === 'audio');

    // Derive HDR type from video_range_type
    let hdr: HdrType = 'sdr';
    if (videoStream?.video_range_type) {
        const vrt = videoStream.video_range_type.toLowerCase();
        if (vrt.includes('dovi') || vrt === 'dolbyvision') hdr = 'dovi';
        else if (vrt === 'hdr10+' || vrt === 'hdr10plus') hdr = 'hdr10plus';
        else if (vrt === 'hdr10' || vrt === 'hdr') hdr = 'hdr10';
        else if (vrt === 'hlg') hdr = 'hlg';
    }

    const maxChannels = audioStreams.reduce((max, a) => Math.max(max, a.channels ?? 0), 0);

    return {
        videoCodec: videoStream?.codec ?? '',
        videoBitDepth: videoStream?.bit_depth ?? undefined,
        videoProfile: videoStream?.profile ?? undefined,
        videoLevel: videoStream?.level ?? undefined,
        width: videoStream?.width ?? undefined,
        height: videoStream?.height ?? undefined,
        bitrate: totalBitrate ?? undefined,
        audioCodecs: audioStreams.map((a) => a.codec).filter((c): c is string => c !== null),
        audioTrackCount: audioStreams.length,
        audioChannels: maxChannels > 0 ? maxChannels : undefined,
        container,
        hdr,
    };
}

// ──────────────────────────────────────────────────────────
// deviceCapsFromProfile
// ──────────────────────────────────────────────────────────

/**
 * Convert a Jellyfin DeviceProfile into DeviceCapabilities for shared compatibility checking.
 * Extracts codec/container sets from DirectPlayProfiles and codec constraints from CodecProfiles.
 */
export function deviceCapsFromProfile(profile: {
    DirectPlayProfiles?: Array<{
        Type?: string;
        Container?: string;
        VideoCodec?: string;
        AudioCodec?: string;
    }>;
    CodecProfiles?: Array<{
        Type?: string;
        Codec?: string;
        Conditions?: Array<{
            Property?: string;
            Condition?: string;
            Value?: string;
        }>;
    }>;
    MaxStreamingBitrate?: number;
}): DeviceCapabilities {
    const videoCodecs = new Set<string>();
    const audioCodecs = new Set<string>();
    const containers = new Set<string>();

    for (const dp of profile.DirectPlayProfiles ?? []) {
        if (dp.Container) {
            for (const c of dp.Container.split(',')) containers.add(c.trim().toLowerCase());
        }
        if (dp.VideoCodec) {
            for (const c of dp.VideoCodec.split(','))
                videoCodecs.add(normalizeVideoCodecToken(c.trim()));
        }
        if (dp.AudioCodec) {
            for (const c of dp.AudioCodec.split(',')) audioCodecs.add(c.trim().toLowerCase());
        }
    }

    // Extract codec constraints from CodecProfiles
    const codecConstraints: Record<
        string,
        { maxLevel?: number; maxProfile?: string; excludedProfiles?: string }
    > = {};
    for (const cp of profile.CodecProfiles ?? []) {
        if (cp.Type !== 'Video' || !cp.Conditions) continue;
        // Jellyfin's Codec field may be a comma list ("h264,hevc") — register
        // the constraint entry under every codec it names.
        const keys = cp.Codec
            ? cp.Codec.toLowerCase()
                  .split(',')
                  .map((c) => normalizeVideoCodecToken(c.trim()))
                  .filter(Boolean)
            : ['_default'];
        const entry: {
            maxLevel?: number;
            maxProfile?: string;
            excludedProfiles?: string;
        } = {};
        const excluded: string[] = [];

        for (const cond of cp.Conditions) {
            if (
                cond.Property === 'VideoLevel' &&
                cond.Condition === 'LessThanEqual' &&
                cond.Value
            ) {
                entry.maxLevel = parseInt(cond.Value, 10);
            }
            if (cond.Property === 'VideoProfile' && cond.Condition === 'EqualsAny' && cond.Value) {
                entry.maxProfile = cond.Value.toLowerCase();
            }
            if (cond.Property === 'VideoProfile' && cond.Condition === 'NotEquals' && cond.Value) {
                excluded.push(cond.Value.toLowerCase());
            }
        }
        if (excluded.length > 0) {
            entry.excludedProfiles = excluded.join('|');
        }

        if (
            entry.maxLevel !== undefined ||
            entry.maxProfile !== undefined ||
            entry.excludedProfiles !== undefined
        ) {
            for (const key of keys) {
                codecConstraints[key] = { ...codecConstraints[key], ...entry };
            }
        }
    }

    return {
        videoCodecs,
        audioCodecs,
        containers,
        canSwitchAudioInDirectPlay: true,
        maxBitrate: profile.MaxStreamingBitrate ?? undefined,
        ...(Object.keys(codecConstraints).length > 0 ? { codecConstraints } : {}),
    };
}
