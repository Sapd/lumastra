// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Transcode Decision Engine
 *
 * Evaluates media source information against device profiles and server
 * configuration to determine the optimal transcoding strategy.
 */

import { config } from '../../config.js';
import { Logger } from '../../utils/logger.js';
import {
    checkCompatibility,
    normalizeVideoCodecToken,
    type CompatibilityResult,
    type DeviceCapabilities,
    type MediaInfo,
    type HdrType,
} from '../../utils/media-compatibility.js';
import { hardwareDetection, isGpuEncoder, isGpuDecoder } from './hardware-detection.js';
import { deviceProfiles } from './device-profiles.js';
import {
    TranscodeReason,
    getTranscodeReasonStrings,
    CODEC_ENCODER_MAP,
    classifyHdrSource,
    dvBaseLayerIsHdr,
    dvBaseLayerRange,
    type TranscodeDecision,
    type TranscodeMode,
    type CodecAction,
    type DeviceProfile,
    type MediaSourceInfo,
    type MediaStreamInfo,
    type HardwareCapabilities,
    type GpuAcceleration,
    type Hdr10Metadata,
    type PlanHints,
} from './types.js';
import type { PlaybackPlan } from '$lib/schemas/playback-plan.js';

const logger = Logger.for('TranscodeDecision');

/**
 * Generic audio codec hint (as sent by a client override or the lumastra-info
 * planner) → real ffmpeg encoder name. Mirrors CODEC_ENCODER_MAP's
 * generic-name convention for video; audio encoders aren't GPU/backend
 * dependent so this is a flat map. An unrecognised hint is ignored rather
 * than reaching ffmpeg argv unmapped (security review 2026-09-12, C17).
 */
const AUDIO_HINT_ENCODER_MAP: Record<string, string> = {
    aac: 'aac',
    ac3: 'ac3',
    eac3: 'eac3',
    mp3: 'libmp3lame',
    opus: 'libopus',
    flac: 'flac',
};

interface ProfileCaps {
    caps: DeviceCapabilities;
    /** True when at least one Video DirectPlayProfile has no AudioCodec restriction (accepts any audio in video playback). */
    unrestrictedVideoAudio: boolean;
    /** True when at least one Audio DirectPlayProfile has no AudioCodec restriction (audio-only files). */
    unrestrictedAudioOnly: boolean;
}

/**
 * Jellyfin's CodecProfile.Codec may be a comma-separated list (e.g. "ac3,eac3").
 * An absent Codec means the profile applies to every codec of its Type.
 */
function codecProfileMatchesCodec(cpCodec: string | undefined, codec: string | undefined): boolean {
    if (!cpCodec) return true;
    if (!codec) return false;
    const target = normalizeVideoCodecToken(codec);
    return cpCodec
        .toLowerCase()
        .split(',')
        .map((c) => normalizeVideoCodecToken(c.trim()))
        .includes(target);
}

/**
 * Jellyfin's CodecProfile.Container scopes conditions to containers. A leading
 * '-' inverts the list ("-mp4,ts" = all containers EXCEPT mp4/ts). Absent
 * Container (or unknown media container) means the profile always applies.
 */
function codecProfileAppliesToContainer(
    cpContainer: string | undefined,
    container: string | undefined,
): boolean {
    if (!cpContainer || !container) return true;
    const c = container.toLowerCase();
    const negated = cpContainer.startsWith('-');
    const list = (negated ? cpContainer.slice(1) : cpContainer)
        .toLowerCase()
        .split(',')
        .map((s) => s.trim());
    return negated ? !list.includes(c) : list.includes(c);
}

interface VideoStreamConstraints {
    disallowInterlaced: boolean;
    disallowAnamorphic: boolean;
    maxRefFrames?: number;
}

/**
 * Extract stream-property constraints (interlacing, anamorphic, ref frames)
 * from CodecProfiles matching the media's codec/container. ApplyConditions
 * gate a CodecProfile on media properties (Width/Height). An ApplyCondition
 * on an unknown PROPERTY is treated as passing, but a known property with an
 * unknown media VALUE fails the gate — otherwise an unknown-width source
 * would satisfy every width tier at once and inherit the tightest RefFrames
 * cap meant for 4K.
 */
function extractVideoStreamConstraints(
    profile: DeviceProfile,
    videoCodec: string | undefined,
    container: string | undefined,
    video: MediaStreamInfo,
): VideoStreamConstraints {
    const result: VideoStreamConstraints = {
        disallowInterlaced: false,
        disallowAnamorphic: false,
    };
    if (!profile.CodecProfiles || !videoCodec) return result;

    const applyConditionPasses = (cond: { Property: string; Condition: string; Value: string }) => {
        if (cond.Property !== 'Width' && cond.Property !== 'Height') return true;
        const mediaValue = cond.Property === 'Width' ? video.width : video.height;
        if (mediaValue === undefined) return false;
        const limit = Number(cond.Value);
        if (isNaN(limit)) return true;
        switch (cond.Condition) {
            case 'GreaterThanEqual':
                return mediaValue >= limit;
            case 'LessThanEqual':
                return mediaValue <= limit;
            case 'Equals':
                return mediaValue === limit;
            default:
                return true;
        }
    };

    for (const cp of profile.CodecProfiles) {
        if (cp.Type !== 'Video') continue;
        if (!codecProfileMatchesCodec(cp.Codec, videoCodec)) continue;
        if (!codecProfileAppliesToContainer(cp.Container, container)) continue;
        if (cp.ApplyConditions && !cp.ApplyConditions.every(applyConditionPasses)) continue;

        for (const cond of cp.Conditions) {
            if (
                cond.Property === 'IsInterlaced' &&
                cond.Condition === 'NotEquals' &&
                cond.Value.toLowerCase() === 'true'
            ) {
                result.disallowInterlaced = true;
            }
            if (
                cond.Property === 'IsAnamorphic' &&
                cond.Condition === 'NotEquals' &&
                cond.Value.toLowerCase() === 'true'
            ) {
                result.disallowAnamorphic = true;
            }
            if (cond.Property === 'RefFrames' && cond.Condition === 'LessThanEqual') {
                const limit = Number(cond.Value);
                if (!isNaN(limit)) {
                    result.maxRefFrames =
                        result.maxRefFrames === undefined
                            ? limit
                            : Math.min(result.maxRefFrames, limit);
                }
            }
        }
    }

    return result;
}

/**
 * Extract DeviceCapabilities from a DeviceProfile for use with the shared
 * media-compatibility module.
 *
 * @param videoCodec  Current media's video codec (needed to select codec-specific profile limits)
 * @param audioCodec  Current media's primary audio codec (needed for audio channel limits)
 */
function profileToDeviceCaps(
    profile: DeviceProfile,
    videoCodec?: string,
    audioCodec?: string,
    container?: string,
): ProfileCaps {
    const videoCodecs = new Set<string>();
    const audioCodecs = new Set<string>();
    const hlsAudioCodecs = new Set<string>();
    const containers = new Set<string>();
    let unrestrictedVideoAudio = false;
    let unrestrictedAudioOnly = false;

    for (const dp of profile.DirectPlayProfiles) {
        // Containers
        for (const c of dp.Container.split(',')) {
            const trimmed = c.trim().toLowerCase();
            if (trimmed) containers.add(trimmed);
        }

        // Video codecs
        if (dp.Type === 'Video' && dp.VideoCodec) {
            for (const c of dp.VideoCodec.split(',')) {
                const trimmed = normalizeVideoCodecToken(c.trim());
                if (trimmed) videoCodecs.add(trimmed);
            }
        }

        // Audio codecs (from both Video and Audio profiles).
        // An entry without AudioCodec accepts any audio — but ONLY for its own
        // Type: a bare audio-file entry like {Container:'mp3',Type:'Audio'}
        // must not disable the audio codec check for VIDEO playback.
        if ((dp.Type === 'Video' || dp.Type === 'Audio') && dp.AudioCodec) {
            for (const c of dp.AudioCodec.split(',')) {
                const trimmed = c.trim().toLowerCase();
                if (trimmed) audioCodecs.add(trimmed);
            }
        } else if (dp.Type === 'Video') {
            unrestrictedVideoAudio = true;
        } else if (dp.Type === 'Audio') {
            unrestrictedAudioOnly = true;
        }
    }

    // HLS audio codecs from TranscodingProfiles
    for (const tp of profile.TranscodingProfiles || []) {
        if (tp.Protocol !== 'hls') continue;
        if (tp.AudioCodec) {
            for (const c of tp.AudioCodec.split(',')) {
                const trimmed = c.trim().toLowerCase();
                if (trimmed) hlsAudioCodecs.add(trimmed);
            }
        }
        // Also add video codecs from transcoding profiles
        if (tp.Type === 'Video' && tp.VideoCodec) {
            for (const c of tp.VideoCodec.split(',')) {
                const trimmed = normalizeVideoCodecToken(c.trim());
                if (trimmed) videoCodecs.add(trimmed);
            }
        }
    }

    // HDR format support
    const hdrFormats = new Set<string>();
    if (profile.supportsHdr) {
        hdrFormats.add('hdr10');
        hdrFormats.add('hlg');
    }
    if (profile.supportsDolbyVision) {
        hdrFormats.add('dovi');
    }

    // Extract codec-specific limits from CodecProfiles
    let maxVideoProfile: string | undefined;
    let maxVideoLevel: number | undefined;
    let maxAudioChannels: number | undefined;

    if (profile.CodecProfiles) {
        const vcLower = videoCodec?.toLowerCase();
        const acLower = audioCodec?.toLowerCase();

        for (const cp of profile.CodecProfiles) {
            // Honour Jellyfin container scoping ("-mp4,ts" = everything except mp4/ts)
            if (!codecProfileAppliesToContainer(cp.Container, container)) continue;

            // Video profile/level limits (codec-specific)
            if (cp.Type === 'Video' && vcLower) {
                if (!codecProfileMatchesCodec(cp.Codec, vcLower)) continue;
                for (const cond of cp.Conditions) {
                    if (cond.Property === 'VideoProfile' && cond.Condition === 'EqualsAny') {
                        maxVideoProfile = cond.Value;
                    }
                    if (cond.Property === 'VideoLevel' && cond.Condition === 'LessThanEqual') {
                        const level = Number(cond.Value);
                        if (!isNaN(level)) {
                            maxVideoLevel =
                                maxVideoLevel === undefined
                                    ? level
                                    : Math.min(maxVideoLevel, level);
                        }
                    }
                }
            }

            // Audio channel limits
            if (cp.Type === 'Audio' || cp.Type === 'VideoAudio') {
                if (cp.Codec && acLower && !codecProfileMatchesCodec(cp.Codec, acLower)) continue;
                for (const cond of cp.Conditions) {
                    if (cond.Property === 'AudioChannels' && cond.Condition === 'LessThanEqual') {
                        const ch = Number(cond.Value);
                        if (!isNaN(ch)) {
                            maxAudioChannels =
                                maxAudioChannels === undefined
                                    ? ch
                                    : Math.min(maxAudioChannels, ch);
                        }
                    }
                }
            }
        }
    }

    // Resolution limits from server config
    const maxWidth = config.MAX_WIDTH > 0 ? config.MAX_WIDTH : undefined;
    const maxHeight = config.MAX_HEIGHT > 0 ? config.MAX_HEIGHT : undefined;

    // Bitrate limit from device profile
    const maxBitrate = profile.MaxStreamingBitrate ?? undefined;

    return {
        caps: {
            videoCodecs,
            audioCodecs,
            hlsAudioCodecs: hlsAudioCodecs.size > 0 ? hlsAudioCodecs : undefined,
            containers,
            hdrFormats: hdrFormats.size > 0 ? hdrFormats : undefined,
            canSwitchAudioInDirectPlay: false,
            maxVideoProfile,
            maxVideoLevel,
            maxWidth,
            maxHeight,
            maxBitrate,
            maxAudioChannels,
        },
        unrestrictedVideoAudio,
        unrestrictedAudioOnly,
    };
}

/**
 * Transcode Decision Engine
 *
 * Determines whether media can be direct played or requires full transcoding.
 */
class TranscodeDecisionEngine {
    private hardwareCaps: HardwareCapabilities | null = null;

    /**
     * Make a transcoding decision for the given media and device.
     */
    async decide(
        mediaSource: MediaSourceInfo,
        deviceProfileId?: string,
        userAgent?: string,
        planHints?: PlanHints,
    ): Promise<TranscodeDecision> {
        // Get device profile
        const profile = deviceProfileId
            ? await deviceProfiles.getProfile(deviceProfileId)
            : await deviceProfiles.getProfileByUserAgent(userAgent || '');

        // Log which profile was selected
        logger.info('Transcode decision using device profile', {
            profileId: profile.id,
            profileName: profile.Name,
            requestedProfileId: deviceProfileId,
            userAgent: userAgent ? userAgent.substring(0, 60) : undefined,
            directPlayAudioCodecs: profile.DirectPlayProfiles.filter((dp) => dp.AudioCodec).map(
                (dp) => dp.AudioCodec,
            ),
        });

        // Get hardware capabilities
        if (!this.hardwareCaps) {
            this.hardwareCaps = await hardwareDetection.getCapabilities();
        }

        // Extract video and audio streams
        const videoStream = mediaSource.streams.find((s) => s.type === 'Video');
        const audioStreams = mediaSource.streams.filter((s) => s.type === 'Audio');

        if (!videoStream) {
            // Audio-only content - different logic
            return this.decideAudioOnly(mediaSource, profile, audioStreams);
        }

        // Build MediaInfo and DeviceCapabilities for shared compatibility check
        const primaryAudio = audioStreams.find((a) => a.isDefault) || audioStreams[0];

        const mediaInfo: MediaInfo = {
            videoCodec: videoStream.codec ? normalizeVideoCodecToken(videoStream.codec) : '',
            videoBitDepth: videoStream.bitDepth,
            videoProfile: videoStream.profile,
            videoLevel: videoStream.level,
            width: videoStream.width,
            height: videoStream.height,
            bitrate: mediaSource.bitrate,
            audioCodecs: audioStreams.map((s) => s.codec?.toLowerCase() ?? '').filter(Boolean),
            audioTrackCount: audioStreams.length,
            audioChannels: primaryAudio?.channels,
            container: mediaSource.container?.toLowerCase() ?? '',
            hdr: this.detectHdrType(videoStream),
        };

        const { caps: deviceCaps, unrestrictedVideoAudio } = profileToDeviceCaps(
            profile,
            videoStream.codec,
            primaryAudio?.codec,
            mediaInfo.container,
        );
        const compat = checkCompatibility(mediaInfo, deviceCaps);

        // Evaluate transcoding requirements
        let reasons = TranscodeReason.None;

        // Check forced mode from config
        const configMode = config.TRANSCODING_MODE;
        if (configMode === 'full') {
            reasons |= TranscodeReason.ForcedByConfig;
        }

        // Container support (from shared module)
        if (!compat.containerCompatible) {
            reasons |= TranscodeReason.ContainerNotSupported;
        }

        // Video codec support (from shared module)
        if (!compat.videoCompatible) {
            reasons |= TranscodeReason.VideoCodecNotSupported;
        }

        // A real video stream whose codec could not be identified must never be
        // stream-copied: the shared module treats '' as "no video" (vacuously
        // compatible), which would copy an unknown bitstream to the client.
        if (!mediaInfo.videoCodec) {
            reasons |= TranscodeReason.VideoCodecNotSupported;
        }

        // Stream-property constraints from CodecProfiles (interlacing,
        // anamorphic, ref frames) — previously authored in the profiles but
        // never enforced. Unknown media properties pass (IsRequired=false).
        const streamConstraints = extractVideoStreamConstraints(
            profile,
            mediaInfo.videoCodec,
            mediaInfo.container,
            videoStream,
        );
        if (videoStream.isInterlaced && streamConstraints.disallowInterlaced) {
            reasons |= TranscodeReason.InterlacedNotSupported;
        }
        if (videoStream.isAnamorphic && streamConstraints.disallowAnamorphic) {
            reasons |= TranscodeReason.AnamorphicNotSupported;
        }
        if (
            streamConstraints.maxRefFrames !== undefined &&
            videoStream.refFrames !== undefined &&
            videoStream.refFrames > streamConstraints.maxRefFrames
        ) {
            reasons |= TranscodeReason.RefFramesExceedsLimit;
        }

        // Video profile/level/resolution checks (from shared module)
        if (compat.videoProfileExceeded) {
            reasons |= TranscodeReason.VideoProfileNotSupported;
        }
        if (compat.videoLevelExceeded) {
            reasons |= TranscodeReason.VideoLevelNotSupported;
        }
        if (compat.resolutionExceeded) {
            reasons |= TranscodeReason.ResolutionExceedsLimit;
        }

        // Audio codec support (from shared module, unless the profile's VIDEO
        // entries accept any audio)
        if (!unrestrictedVideoAudio && !compat.audioCompatible && primaryAudio) {
            reasons |= TranscodeReason.AudioCodecNotSupported;
        }

        // Audio channel count (from shared module)
        if (compat.audioChannelsExceeded) {
            reasons |= TranscodeReason.AudioChannelsNotSupported;
        }

        // Bitrate limits (from shared module)
        if (compat.bitrateExceeded) {
            reasons |= TranscodeReason.BitrateExceedsLimit;
        }

        // Determine video/audio actions
        let videoNeedsTranscode =
            (reasons &
                (TranscodeReason.VideoCodecNotSupported |
                    TranscodeReason.VideoProfileNotSupported |
                    TranscodeReason.VideoLevelNotSupported |
                    TranscodeReason.VideoRangeNotSupported |
                    TranscodeReason.ResolutionExceedsLimit |
                    TranscodeReason.BitrateExceedsLimit |
                    TranscodeReason.InterlacedNotSupported |
                    TranscodeReason.AnamorphicNotSupported |
                    TranscodeReason.RefFramesExceedsLimit)) !==
            0;

        let audioNeedsTranscode =
            (reasons & TranscodeReason.AudioCodecNotSupported) !== 0 ||
            (reasons & TranscodeReason.AudioChannelsNotSupported) !== 0;

        // Determine target codecs (considering device profile supported codecs)
        let targetCodec = await this.selectTargetCodecs(
            profile,
            videoStream,
            primaryAudio,
            videoNeedsTranscode,
            audioNeedsTranscode,
        );

        // ── Plan hints override ─────────────────────────────────────────
        // When the lumastra-info planner already chose codecs, use them
        // instead of the decision engine's own selection.
        if (planHints?.targetVideoCodec && planHints.targetVideoCodec !== 'copy') {
            const hint = planHints.targetVideoCodec.toLowerCase();
            // Map generic codec names to hardware-accelerated encoders
            const gpuAccel = config.GPU_ACCELERATION;
            const mapped = CODEC_ENCODER_MAP[hint]?.[gpuAccel];
            let resolvedEncoder: string | undefined;
            if (mapped && (await hardwareDetection.supportsEncoder(mapped))) {
                resolvedEncoder = mapped;
            } else {
                // Fallback: use the software encoder for a known generic name.
                const softwareMap: Record<string, string> = {
                    h264: 'libx264',
                    hevc: 'libx265',
                    av1: 'libsvtav1',
                };
                resolvedEncoder = softwareMap[hint] ?? CODEC_ENCODER_MAP[hint]?.none;
            }
            if (resolvedEncoder) {
                targetCodec.video = resolvedEncoder;
                // If planner says transcode but engine said copy, force transcode
                if (!videoNeedsTranscode) {
                    videoNeedsTranscode = true;
                }
                logger.info('Plan hints overrode video codec selection', {
                    hint: planHints.targetVideoCodec,
                    resolved: targetCodec.video,
                });
            } else {
                // security review 2026-09-12, C17: an unrecognised codec hint
                // must never reach ffmpeg argv — ignore it and keep whatever
                // the decision engine already picked above.
                logger.warn('Ignoring unknown video codec hint — not in the known encoder table', {
                    hint: planHints.targetVideoCodec,
                });
            }
        } else if (planHints?.targetVideoCodec === 'copy' && videoNeedsTranscode) {
            // Planner says copy but engine says transcode — trust the planner
            // (the planner ran the same compatibility check with the actual client caps)
            videoNeedsTranscode = false;
            // Clear stale targetCodec.video so effective video planning doesn't
            // see a leftover encoder and override the copy decision.
            targetCodec.video = undefined;
            // Also clear the video reason bits the planner overruled, so
            // decision.reasons / mode don't report a transcode that isn't happening.
            reasons &= ~(
                TranscodeReason.VideoCodecNotSupported |
                TranscodeReason.VideoProfileNotSupported |
                TranscodeReason.VideoLevelNotSupported |
                TranscodeReason.VideoRangeNotSupported |
                TranscodeReason.ResolutionExceedsLimit |
                TranscodeReason.BitrateExceedsLimit |
                TranscodeReason.InterlacedNotSupported |
                TranscodeReason.AnamorphicNotSupported |
                TranscodeReason.RefFramesExceedsLimit
            );
            logger.info(
                'Plan hints overrode video to copy (planner determined direct-compatible)',
                {},
            );
        }

        if (planHints?.targetAudioCodec && planHints.targetAudioCodec !== 'copy') {
            // security review 2026-09-12, C17: map through the known-encoder
            // table instead of using the raw hint string — an unrecognised
            // hint is ignored rather than reaching ffmpeg argv unmapped.
            const audioHint = planHints.targetAudioCodec.toLowerCase();
            const resolvedAudioEncoder = AUDIO_HINT_ENCODER_MAP[audioHint];
            if (resolvedAudioEncoder) {
                targetCodec.audio = resolvedAudioEncoder;
                if (!audioNeedsTranscode) {
                    audioNeedsTranscode = true;
                }
                logger.info('Plan hints overrode audio codec selection', {
                    hint: planHints.targetAudioCodec,
                    resolved: targetCodec.audio,
                });
            } else {
                logger.warn('Ignoring unknown audio codec hint — not in the known encoder table', {
                    hint: planHints.targetAudioCodec,
                });
            }
        } else if (planHints?.targetAudioCodec === 'copy' && audioNeedsTranscode) {
            audioNeedsTranscode = false;
            reasons &= ~(
                TranscodeReason.AudioCodecNotSupported | TranscodeReason.AudioChannelsNotSupported
            );
            logger.info('Plan hints overrode audio to copy', {});
        }

        // HDR tonemapping: use shared module result, but gate on config
        // The shared module checks DV without device DV support; we also
        // check general HDR-on-non-HDR-device and DV Profile 8 fallback.
        const needsTonemapping = this.needsTonemapping(videoStream, profile, compat);
        const hdrPreservation = this.checkHdr10Preservation(
            videoStream,
            profile,
            videoNeedsTranscode,
        );

        // HDR10 requires HEVC (H.264 doesn't support 10-bit or HDR metadata)
        // Override video codec to HEVC if preserving HDR10
        if (hdrPreservation.preserveHdr10) {
            if (!targetCodec.video) {
                // No video codec selected but HDR10 preservation needed - default to HEVC
                logger.info('Setting HEVC for HDR10 output (no codec was selected)', {});
                const gpuAccel = config.GPU_ACCELERATION;
                const hevcEncoders: Record<GpuAcceleration, string> = {
                    none: 'libx265',
                    nvenc: 'hevc_nvenc',
                    qsv: 'hevc_qsv',
                    vaapi: 'hevc_vaapi',
                    amf: 'hevc_amf',
                    videotoolbox: 'hevc_videotoolbox',
                };
                targetCodec.video = hevcEncoders[gpuAccel] || 'libx265';
            } else {
                const currentCodec = targetCodec.video.toLowerCase();
                // Check if current codec is H.264 (not HEVC-compatible)
                if (currentCodec.includes('264') || currentCodec.includes('x264')) {
                    logger.info('Forcing HEVC for HDR10 output (H.264 does not support HDR)', {
                        originalCodec: targetCodec.video,
                    });
                    // Replace with HEVC equivalent
                    if (currentCodec.includes('nvenc')) {
                        targetCodec.video = 'hevc_nvenc';
                    } else if (currentCodec.includes('qsv')) {
                        targetCodec.video = 'hevc_qsv';
                    } else if (currentCodec.includes('vaapi')) {
                        targetCodec.video = 'hevc_vaapi';
                    } else if (currentCodec.includes('amf')) {
                        targetCodec.video = 'hevc_amf';
                    } else if (currentCodec.includes('videotoolbox')) {
                        targetCodec.video = 'hevc_videotoolbox';
                    } else {
                        targetCodec.video = 'libx265';
                    }
                }
            }
        }

        // Tonemapping requires video re-encoding (can't apply filters with stream copy)
        if (needsTonemapping && !videoNeedsTranscode) {
            videoNeedsTranscode = true;
            // Set HEVC encoder for tonemapping output
            const gpuAccel = config.GPU_ACCELERATION;
            const hevcEncoders: Record<GpuAcceleration, string> = {
                none: 'libx265',
                nvenc: 'hevc_nvenc',
                qsv: 'hevc_qsv',
                vaapi: 'hevc_vaapi',
                amf: 'hevc_amf',
                videotoolbox: 'hevc_videotoolbox',
            };
            if (!targetCodec.video) {
                targetCodec.video = hevcEncoders[gpuAccel] || 'libx265';
            }
            logger.info('Tonemapping requires video transcoding — forced videoNeedsTranscode', {
                encoder: targetCodec.video,
            });
        }

        // Select GPU encoder if using GPU
        const useGpu = config.HW_ENCODING_ENABLED && config.GPU_ACCELERATION !== 'none';

        let gpuEncoder: string | undefined;
        let gpuDecoder: string | undefined;

        // Select GPU encoder when video needs transcoding
        if (useGpu && videoNeedsTranscode && targetCodec.video) {
            gpuEncoder = await this.selectGpuEncoder(targetCodec.video);
            if (this.shouldUseHwDecoder(videoStream.codec || '')) {
                const is10Bit = videoStream.bitDepth ? videoStream.bitDepth >= 10 : false;
                gpuDecoder =
                    (await hardwareDetection.getBestDecoder(videoStream.codec || '', is10Bit)) ??
                    undefined;
            }
        }

        // HLS cannot carry these codecs — force audio transcode
        const hlsIncompatibleAudio = [
            'dts',
            'truehd',
            'mlp',
            'pcm_s16le',
            'pcm_s24le',
            'pcm_s32le',
            'pcm_s16be',
            'pcm_f32le',
            'pcm_f64le',
            'pcm_alaw',
            'pcm_mulaw',
            'flac',
            'vorbis',
        ];
        const primaryAudioCodec = primaryAudio?.codec?.toLowerCase() ?? '';
        const audioForceTranscode = hlsIncompatibleAudio.some((c) => primaryAudioCodec.includes(c));
        if (audioForceTranscode && !audioNeedsTranscode) {
            audioNeedsTranscode = true;
        }

        // Mode is computed AFTER plan-hint overrides and the HLS audio force —
        // otherwise it can report 'direct' while an action says 'transcode'.
        const mode: TranscodeMode =
            reasons === TranscodeReason.None && !videoNeedsTranscode && !audioNeedsTranscode
                ? 'direct'
                : 'full';

        const decision: TranscodeDecision = {
            mode,
            reasons,
            videoAction: videoNeedsTranscode ? 'transcode' : 'copy',
            audioAction: audioNeedsTranscode ? 'transcode' : 'copy',
            targetCodec,
            useGpu,
            gpuEncoder,
            gpuDecoder,
            needsTonemapping,
            tonemappingAlgorithm: needsTonemapping ? config.TONEMAPPING_ALGORITHM : undefined,
            preserveHdr10: hdrPreservation.preserveHdr10,
            hdr10Metadata: hdrPreservation.metadata,
            outputVideoRange: hdrPreservation.outputRange,
        };

        logger.debug('Transcode decision made', {
            mediaId: mediaSource.id,
            container: mediaSource.container,
            videoCodec: videoStream.codec,
            mode: decision.mode,
            reasons: getTranscodeReasonStrings(reasons),
            videoAction: decision.videoAction,
            audioAction: decision.audioAction,
            useGpu: decision.useGpu,
            gpuEncoder: decision.gpuEncoder,
            needsTonemapping: decision.needsTonemapping,
            preserveHdr10: decision.preserveHdr10,
            outputVideoRange: decision.outputVideoRange,
        });

        return decision;
    }

    /**
     * Translate a PlaybackPlan into a TranscodeDecision.
     * No compatibility checks — the plan already made all decisions.
     * Only used for Lumastra playback; /j/ compat still uses decide().
     */
    async consumePlan(
        plan: PlaybackPlan,
        mediaSource: MediaSourceInfo,
    ): Promise<TranscodeDecision> {
        if (!this.hardwareCaps) {
            this.hardwareCaps = await hardwareDetection.getCapabilities();
        }

        // Validate that the media still matches what the plan was built for.
        // The plan records the source codec at creation time; if the file was
        // re-encoded or replaced within the 30-min TTL, the plan's decisions
        // (copy vs transcode) may be wrong. Log a warning for diagnostics.
        const videoStream = mediaSource.streams.find((s) => s.type === 'Video');
        if (videoStream?.codec && plan.source_video_codec) {
            const currentCodec = videoStream.codec.toLowerCase();
            const expectedCodec = plan.source_video_codec.toLowerCase();
            if (currentCodec !== expectedCodec) {
                logger.warn('Plan/media drift: source video codec changed since plan creation', {
                    planId: plan.plan_id,
                    expected: expectedCodec,
                    actual: currentCodec,
                    planMethod: plan.method,
                });
            }
        }

        const videoAction: CodecAction = plan.video_action === 'transcode' ? 'transcode' : 'copy';
        const audioAction: CodecAction = plan.audio_action === 'transcode' ? 'transcode' : 'copy';

        // Re-verify GPU encoder availability — it may have become unavailable
        // (driver crash, device reset) since the plan was created up to 30 min ago.
        // Note: `plan.gpu_encoder` is a misnomer — it may actually hold a software
        // encoder ID (libx264 / libx265 / libsvtav1) when no GPU is configured,
        // because `hardwareDetection.getBestEncoder` falls back to software.
        const storedEncoder = plan.gpu_encoder ?? undefined;
        const resolvedEncoder =
            storedEncoder && (await hardwareDetection.supportsEncoder(storedEncoder))
                ? storedEncoder
                : undefined;
        if (storedEncoder && !resolvedEncoder) {
            logger.warn('Plan encoder no longer available, falling back to software', {
                planId: plan.plan_id,
                encoder: storedEncoder,
            });
        }
        // Only count it as `gpuEncoder` for reporting / downstream GPU-only code
        // paths when the encoder ID actually refers to hardware.
        const gpuEncoder = isGpuEncoder(resolvedEncoder) ? resolvedEncoder : undefined;
        // `plan.gpu_decoder` may hold the bare codec name (e.g. 'hevc') when
        // `getBestDecoder` had no hardware match — symmetric classification
        // with gpuEncoder prevents useGpu=true on software-only boxes.
        const storedDecoder = plan.gpu_decoder ?? undefined;
        const gpuDecoder = isGpuDecoder(storedDecoder) ? storedDecoder : undefined;
        const useGpu = !!(gpuEncoder || gpuDecoder);

        const targetCodec: { video?: string; audio?: string } = {};
        if (plan.target_video_codec && videoAction === 'transcode') {
            targetCodec.video = gpuEncoder ?? this.getSoftwareEncoder(plan.target_video_codec);
        }
        if (plan.target_audio_codec && audioAction === 'transcode') {
            targetCodec.audio = plan.target_audio_codec;
        }

        // 'direct' only when the plan really serves the file untouched — a
        // method:'direct' plan can still ride an HLS remux branch (container /
        // multi-audio), which is not direct for reporting purposes. Legacy
        // plans without playback_branch fall back to method alone.
        const mode: TranscodeMode =
            plan.method === 'direct' && (plan.playback_branch ?? 'direct') === 'direct'
                ? 'direct'
                : 'full';

        // Derive HDR preservation from the actual video stream.
        // The plan's output_hdr decides WHETHER to preserve (based on device caps,
        // intent, tonemapping); the executor decides HOW (metadata extraction,
        // HDR10 vs HLG output range) from actual stream properties.
        const hdrResult = this.resolveHdrFromPlan(plan, videoStream);

        return {
            mode,
            reasons: 0,
            videoAction,
            audioAction,
            targetCodec: targetCodec.video || targetCodec.audio ? targetCodec : undefined,
            useGpu,
            gpuEncoder,
            gpuDecoder,
            needsTonemapping: plan.needs_tonemapping,
            tonemappingAlgorithm: plan.needs_tonemapping ? config.TONEMAPPING_ALGORITHM : undefined,
            ...hdrResult,
        };
    }

    /**
     * Resolve HDR preservation details from the plan + actual video stream.
     *
     * Uses `output_hdr` (the planner's authoritative output format) to decide
     * WHETHER HDR should be preserved, then derives the HOW (output range,
     * metadata) from the actual video stream properties.
     *
     * `output_hdr` is the correct signal: it accounts for source HDR type,
     * device capabilities, and tonemapping needs.
     */
    private resolveHdrFromPlan(
        plan: PlaybackPlan,
        videoStream?: MediaStreamInfo,
    ): Pick<TranscodeDecision, 'preserveHdr10' | 'hdr10Metadata' | 'outputVideoRange'> {
        // Tonemapping takes priority — output is SDR
        if (plan.needs_tonemapping) {
            return { preserveHdr10: false, outputVideoRange: 'SDR' };
        }

        // output_hdr tells us what the planner decided the output format should be.
        // If it's 'sdr' or absent, no HDR flags are needed.
        const outputHdr = plan.output_hdr ?? 'sdr';
        if (outputHdr === 'sdr') {
            return { preserveHdr10: false };
        }

        // No video stream to validate against
        if (!videoStream) {
            return { preserveHdr10: false };
        }

        // For copy/remux, HDR is preserved by nature (bitstream unchanged).
        // Setting preserveHdr10=true would cause configureHdrHandling() to inject
        // -colorspace/-color_trc/-pix_fmt flags alongside -c:v copy, which FFmpeg
        // rejects or which produces inconsistent container metadata.
        if (plan.video_action !== 'transcode') {
            return { preserveHdr10: false };
        }

        // Validate that the source is actually HDR before applying HDR output flags.
        // Defense-in-depth: catches stale plans or planner bugs.
        const hdr = classifyHdrSource(
            videoStream.videoRange,
            videoStream.videoRangeType,
            videoStream.hdr10Metadata,
        );

        if (!hdr.isHdr) {
            logger.warn('Plan output_hdr is non-SDR but video stream is not HDR, overriding', {
                planId: plan.plan_id,
                outputHdr,
                videoRange: videoStream.videoRange,
                videoRangeType: videoStream.videoRangeType,
            });
            return { preserveHdr10: false };
        }

        // Determine correct output range from actual source type
        let outputVideoRange: 'HDR10' | 'HLG';
        if (hdr.isHlg) {
            outputVideoRange = 'HLG';
        } else if (hdr.isDolbyVision && videoStream.hdr10Metadata?.dvBlCompatId === 4) {
            // DV Profile 8 with HLG base layer
            outputVideoRange = 'HLG';
        } else {
            outputVideoRange = 'HDR10';
        }

        // Extract metadata from the actual video stream
        const hdr10Metadata = this.extractHdr10Metadata(videoStream);

        return {
            preserveHdr10: true,
            hdr10Metadata,
            outputVideoRange,
        };
    }

    /**
     * Give a decision that was just flipped copy→transcode AFTER planning (the
     * quality-cap safety net in ffmpeg-transcode.service) the encoder a planned
     * transcode would have got.
     *
     * A copy plan carries no encoder — `consumePlan` leaves `useGpu` false and
     * `gpuEncoder` unset because nothing was to be encoded — so a flip that only
     * changed `videoAction` fell through to a SOFTWARE encode even on an NVENC
     * host (Windows e2e 2026-09-27: a 1080p HEVC source re-encoded on the CPU
     * with `useGpu false`). Same selection the planner uses:
     * `hardwareDetection.getBestEncoder` for the target codec (which applies
     * the GPU_ACCELERATION config and the HEVC/AV1-encoding switches), a GPU
     * decoder for the source when there is one, software only as the fallback.
     *
     * The target codec is the source's own family by default: a copy plan means
     * the client already plays it. Anything outside h264/hevc/av1 targets h264.
     * A flip caused by the request asking for a DIFFERENT codec (?videoCodec=h264
     * on an HEVC source) passes that codec as `requestedTarget`.
     */
    async assignEncoderForFlippedTranscode(
        decision: TranscodeDecision,
        source: { codec?: string; is10Bit?: boolean },
        requestedTarget?: 'h264' | 'hevc' | 'av1',
    ): Promise<void> {
        const family = (source.codec ?? '').toLowerCase();
        const targetCodec: 'h264' | 'hevc' | 'av1' =
            requestedTarget ??
            (family === 'hevc' || family === 'h265' ? 'hevc' : family === 'av1' ? 'av1' : 'h264');
        const encoder = (await hardwareDetection.getBestEncoder(targetCodec)) ?? undefined;
        const gpuEncoder = isGpuEncoder(encoder) ? encoder : undefined;
        const decoder = source.codec
            ? ((await hardwareDetection.getBestDecoder(source.codec, source.is10Bit)) ?? undefined)
            : undefined;
        const gpuDecoder = isGpuDecoder(decoder) ? decoder : undefined;
        // getBestEncoder may itself fall back to a different codec (HEVC
        // encoding disabled → h264) or to software; derive the software encoder
        // from what it actually returned so the family stays consistent.
        const softwareEncoder =
            encoder && !gpuEncoder ? encoder : this.getSoftwareEncoder(targetCodec);

        decision.gpuEncoder = gpuEncoder;
        decision.gpuDecoder = gpuDecoder;
        decision.useGpu = !!(gpuEncoder || gpuDecoder);
        decision.targetCodec = {
            ...decision.targetCodec,
            video: gpuEncoder ?? softwareEncoder,
        };
    }

    /**
     * HDR handling for a decision flipped copy→transcode after planning — what
     * a planned transcode would do for this client.
     *
     * A copy plan's HDR fields describe a COPY: `preserveHdr10` is false (the
     * bitstream keeps its HDR by nature) and nothing is tone-mapped. Left as
     * is, a flipped HDR source would be re-encoded with neither — no HDR
     * signalling, no tone-map. So, once the encoder is known:
     *
     *  - PRESERVE (HDR10 / HLG out, source metadata carried) when the client
     *    can display the source's HDR (`clientHdrFormats` from the capabilities
     *    the info request carried, recorded on the plan), HDR10 preservation is
     *    enabled (the planner's `enableHdrPreservation` input), and the chosen
     *    encoder can carry it (HEVC/AV1 — H.264 is 8-bit SDR only).
     *  - otherwise TONE-MAP to SDR.
     *
     * Dolby Vision: a re-encode drops the RPU, so what can survive is the base
     * layer — HDR10/HLG when the DV profile has an HDR base (8.1/8.4/10),
     * nothing otherwise. Unknown client formats (a plan from before this field,
     * or the /j/ path): the copy was going to hand the client the HDR
     * bitstream, so keep HDR if everything else allows it.
     */
    assignHdrForFlippedTranscode(
        decision: TranscodeDecision,
        videoStream: MediaStreamInfo | undefined,
        clientHdrFormats: readonly string[] | undefined,
    ): void {
        const hdr = classifyHdrSource(
            videoStream?.videoRange,
            videoStream?.videoRangeType,
            videoStream?.hdr10Metadata,
        );
        if (!videoStream || !hdr.isHdr) {
            decision.preserveHdr10 = false;
            decision.needsTonemapping = false;
            decision.tonemappingAlgorithm = undefined;
            return;
        }

        // What an HDR-preserving re-encode would output for this source.
        let outputRange: 'HDR10' | 'HLG' | undefined;
        if (hdr.isDolbyVision) {
            const blCompatId = videoStream.hdr10Metadata?.dvBlCompatId ?? 0;
            outputRange = dvBaseLayerIsHdr(blCompatId, videoStream.hdr10Metadata?.dvProfile)
                ? (dvBaseLayerRange(blCompatId) as 'HDR10' | 'HLG')
                : undefined;
        } else {
            outputRange = hdr.isHlg ? 'HLG' : 'HDR10';
        }

        const formats = clientHdrFormats?.map((f) => f.toLowerCase());
        const clientDisplays =
            outputRange !== undefined &&
            (formats === undefined || formats.includes(outputRange.toLowerCase()));
        const encoder = (decision.gpuEncoder ?? decision.targetCodec?.video ?? '').toLowerCase();
        const encoderCarriesHdr =
            encoder.includes('hevc') ||
            encoder.includes('265') ||
            encoder.includes('av1') ||
            encoder.includes('svtav1');
        const preserve =
            clientDisplays && encoderCarriesHdr && config.ENABLE_HDR10_PRESERVATION === true;

        if (preserve) {
            decision.preserveHdr10 = true;
            decision.outputVideoRange = outputRange;
            decision.hdr10Metadata = this.extractHdr10Metadata(videoStream);
            decision.needsTonemapping = false;
            decision.tonemappingAlgorithm = undefined;
        } else {
            decision.preserveHdr10 = false;
            decision.hdr10Metadata = undefined;
            decision.outputVideoRange = 'SDR';
            decision.needsTonemapping = true;
            decision.tonemappingAlgorithm = config.TONEMAPPING_ALGORITHM;
        }
    }

    private getSoftwareEncoder(codec: string): string {
        const map: Record<string, string> = {
            h264: 'libx264',
            hevc: 'libx265',
            av1: 'libsvtav1',
        };
        return map[codec] ?? codec;
    }

    /**
     * Detect the HDR type from video stream metadata.
     * Maps Jellyfin/FFprobe video range strings to the shared module's HdrType.
     */
    private detectHdrType(video: MediaStreamInfo): HdrType {
        const isDolbyVision =
            video.videoRange?.includes('DolbyVision') ||
            video.videoRange?.includes('Dolby Vision') ||
            video.videoRangeType?.includes('DOVI') ||
            video.hdr10Metadata?.dvProfile !== undefined;

        if (isDolbyVision) {
            // Report DV that has a playable base layer as dovi_hdr10, so the shared
            // module can distinguish it from pure DV (profile 5/7) which must be
            // re-encoded. The deciding signal is the base-layer compatibility id
            // (1 = HDR10, 2 = SDR, 4 = HLG, 0 = none), not the profile number —
            // keying on profile 8 alone missed profile 10 (DV over AV1). Profile 8 is
            // cross-compatible by definition and kept as an explicit fallback for
            // files whose probe did not record the id. Mirrors ffprobe.ts.
            // NB: on Hdr10Metadata the field is `dvBlCompatId`; the HLS videoInfo type
            // spells the same value `dvBlSignalCompatibilityId`. Don't mix them up —
            // reading the wrong name yields undefined and silently disables this.
            const blCompatId = video.hdr10Metadata?.dvBlCompatId ?? 0;
            if (dvBaseLayerIsHdr(blCompatId, video.hdr10Metadata?.dvProfile)) {
                return 'dovi_hdr10';
            }
            return 'dovi';
        }

        if (video.videoRange?.includes('HLG') || video.videoRangeType?.includes('HLG')) {
            return 'hlg';
        }

        if (
            video.videoRange?.includes('HDR10') ||
            video.videoRange?.includes('HDR') ||
            video.videoRangeType?.includes('HDR10') ||
            video.videoRangeType?.includes('HDR')
        ) {
            return 'hdr10';
        }

        return 'sdr';
    }

    /**
     * Select target codecs for transcoding.
     *
     * The encoder selection considers:
     * 1. What codecs the target device supports (from profile)
     * 2. What encoders are available on the server (GPU/CPU)
     * 3. Preference order: HEVC > H.264 (for better compression)
     */
    private async selectTargetCodecs(
        profile: DeviceProfile,
        video: MediaStreamInfo | undefined,
        audio: MediaStreamInfo | undefined,
        videoNeedsTranscode: boolean,
        audioNeedsTranscode: boolean,
    ): Promise<{ video?: string; audio?: string }> {
        const result: { video?: string; audio?: string } = {};

        if (videoNeedsTranscode && video) {
            // Get supported video codecs from device profile
            const supportedCodecs = this.getProfileSupportedVideoCodecs(profile);

            // Auto-detect best encoder for a supported codec
            if (config.VIDEO_CODEC_AUTO) {
                // Try to find best encoder for supported codecs (prefer AV1 > HEVC > H.264).
                // AV1 only via a GPU encoder — software AV1 (libsvtav1) routinely
                // misses real-time on typical CPUs, so it must never be auto-picked.
                const codecPreference: Array<'av1' | 'hevc' | 'h264'> = [];
                if (supportedCodecs.includes('av1')) {
                    const av1Encoder = await hardwareDetection.getBestEncoder('av1');
                    if (av1Encoder && isGpuEncoder(av1Encoder)) {
                        codecPreference.push('av1');
                    }
                }
                if (supportedCodecs.includes('hevc') || supportedCodecs.includes('h265')) {
                    codecPreference.push('hevc');
                }
                if (supportedCodecs.includes('h264') || supportedCodecs.includes('avc')) {
                    codecPreference.push('h264');
                }

                // Find best available encoder for supported codecs
                for (const codec of codecPreference) {
                    const encoder = await hardwareDetection.getBestEncoder(codec);
                    if (encoder) {
                        result.video = encoder;
                        logger.debug('Selected encoder for device-compatible codec', {
                            codec,
                            encoder,
                            supportedCodecs,
                        });
                        break;
                    }
                }

                // Fallback to libx264 if nothing else available
                if (!result.video) {
                    result.video = 'libx264';
                    logger.warn(
                        'Falling back to libx264 - no GPU encoder found for supported codecs',
                        {
                            supportedCodecs,
                        },
                    );
                }
            } else {
                // Use configured codec (but verify it's supported by device)
                const codec = config.VIDEO_CODEC;
                if (codec !== 'copy') {
                    const gpuAccel = config.GPU_ACCELERATION;
                    const encoderMap = CODEC_ENCODER_MAP[codec];
                    if (encoderMap) {
                        // Honour the hardware-capability list: a GPU encoder may
                        // be listed by FFmpeg yet unavailable on this GPU (e.g.
                        // av1_nvenc on pre-Ada cards, pruned in detectCapabilities)
                        // — picking it would hard-fail with no fallback. Use the
                        // GPU encoder only when actually supported, else fall back
                        // to the software encoder for the requested codec.
                        const gpuEncoder = encoderMap[gpuAccel];
                        if (gpuEncoder && (await hardwareDetection.supportsEncoder(gpuEncoder))) {
                            result.video = gpuEncoder;
                        } else {
                            result.video = encoderMap['none'] ?? codec;
                        }
                    } else {
                        result.video = codec;
                    }
                }
            }
        }

        if (audioNeedsTranscode) {
            result.audio = config.AUDIO_CODEC || 'aac';
        }

        return result;
    }

    /**
     * Extract supported video codecs from device profile's DirectPlayProfiles.
     */
    private getProfileSupportedVideoCodecs(profile: DeviceProfile): string[] {
        const codecs: string[] = [];

        for (const dp of profile.DirectPlayProfiles) {
            if (dp.Type !== 'Video' || !dp.VideoCodec) continue;
            const profileCodecs = dp.VideoCodec.split(',').map((c) => c.trim().toLowerCase());
            codecs.push(...profileCodecs);
        }

        // Also check TranscodingProfiles for supported output codecs
        for (const tp of profile.TranscodingProfiles || []) {
            if (tp.Type !== 'Video' || !tp.VideoCodec) continue;
            const profileCodecs = tp.VideoCodec.split(',').map((c) => c.trim().toLowerCase());
            codecs.push(...profileCodecs);
        }

        // Remove duplicates
        return [...new Set(codecs)];
    }

    /**
     * Check if HDR to SDR tonemapping is needed.
     *
     * Uses the shared module's DV detection (compat.needsTonemapping) for the
     * Dolby Vision case and adds DV Profile 8 fallback + general HDR-on-non-HDR
     * device checks that require runtime side_data knowledge.
     */
    private needsTonemapping(
        video: MediaStreamInfo,
        profile: DeviceProfile,
        compat: CompatibilityResult,
    ): boolean {
        if (!config.ENABLE_TONEMAPPING) return false;

        // Shared module flags DV content when device lacks DV support
        if (compat.needsTonemapping) {
            // DV with an HDR base layer can be preserved without tonemapping (handled
            // by checkHdr10Preservation). Everything else — pure DV, and the SDR-base
            // variant — must tonemap. Keyed on the compatibility id so DV over AV1
            // (profile 10) is covered too; see dvBaseLayerIsHdr.
            return !dvBaseLayerIsHdr(
                video.hdr10Metadata?.dvBlCompatId ?? 0,
                video.hdr10Metadata?.dvProfile,
            );
        }

        // General HDR-on-non-HDR-device check (HDR10, HLG, etc.)
        const isHdr = ['HDR', 'HDR10', 'HDR10+', 'HLG', 'DolbyVision', 'DOVI'].some(
            (range) => video.videoRange?.includes(range) || video.videoRangeType?.includes(range),
        );

        if (!isHdr) return false;

        // Check if device supports HDR
        return !profile.supportsHdr;
    }

    /**
     * Check if HDR10 output should be preserved when transcoding.
     *
     * This handles the DV → HDR10 fallback case where:
     * - Source is Dolby Vision Profile 8 (has HDR10 base layer)
     * - Device supports HDR but not DV
     * - Video needs transcoding (e.g., codec change)
     *
     * Also handles HDR10/HLG → HDR10/HLG when transcoding is needed.
     */
    private checkHdr10Preservation(
        video: MediaStreamInfo,
        profile: DeviceProfile,
        videoNeedsTranscode: boolean,
    ): {
        preserveHdr10: boolean;
        metadata?: Hdr10Metadata;
        outputRange?: 'SDR' | 'HDR10' | 'HLG';
    } {
        // Check if HDR10 preservation is enabled in config
        if (!config.ENABLE_HDR10_PRESERVATION) {
            return { preserveHdr10: false };
        }

        // If video doesn't need transcoding, no HDR10 preservation needed
        if (!videoNeedsTranscode) {
            return { preserveHdr10: false };
        }

        // If device doesn't support HDR, we'll tonemap to SDR instead
        if (!profile.supportsHdr) {
            return { preserveHdr10: false };
        }

        // Classify source HDR type using shared helper
        const hdr = classifyHdrSource(video.videoRange, video.videoRangeType, video.hdr10Metadata);
        const { isDolbyVision, isHdr10, isHlg } = hdr;

        // DV → HDR10 fallback
        // Only works for DV Profile 8 which has HDR10 base layer
        if (isDolbyVision && !profile.supportsDolbyVision) {
            const dvProfile = video.hdr10Metadata?.dvProfile;
            const blCompatId = video.hdr10Metadata?.dvBlCompatId ?? 0;

            // DV with an HDR base layer (compat id 1 = HDR10, 4 = HLG) preserves HDR
            // quality. Covers profile 10 (DV over AV1), not just profile 8.
            if (dvBaseLayerIsHdr(blCompatId, dvProfile)) {
                const outputRange = dvBaseLayerRange(blCompatId) as 'HDR10' | 'HLG';
                logger.info('DV → HDR base-layer fallback enabled', {
                    dvProfile,
                    dvBlCompatId: blCompatId,
                    outputRange,
                });

                return {
                    preserveHdr10: true,
                    metadata: this.extractHdr10Metadata(video),
                    outputRange,
                };
            }

            // No HDR base layer: profiles 5/7 have none at all, and the 8.2 variant's
            // base layer is SDR. Either way the output is SDR — for 8.2 that is the
            // source's own base layer, so it is correct rather than a quality loss.
            logger.warn('DV without an HDR base layer - will tonemap to SDR', {
                dvProfile,
                dvBlCompatId: blCompatId,
            });
            return { preserveHdr10: false, outputRange: 'SDR' };
        }

        // HDR10 → HDR10 preservation (when transcoding is needed for other reasons)
        if (isHdr10 && profile.supportsHdr) {
            return {
                preserveHdr10: true,
                metadata: this.extractHdr10Metadata(video),
                outputRange: 'HDR10',
            };
        }

        // HLG → HLG preservation
        if (isHlg && profile.supportsHdr) {
            return {
                preserveHdr10: true,
                metadata: this.extractHdr10Metadata(video),
                outputRange: 'HLG',
            };
        }

        return { preserveHdr10: false };
    }

    /**
     * Extract HDR10 metadata from a video stream.
     */
    private extractHdr10Metadata(video: MediaStreamInfo): Hdr10Metadata | undefined {
        // If stream already has parsed metadata, use it
        if (video.hdr10Metadata) {
            return video.hdr10Metadata;
        }

        // Otherwise, return undefined - FFmpeg will try to copy from source
        // Note: Full metadata extraction requires reading stream info with ffprobe
        return undefined;
    }

    /**
     * Select the best GPU encoder for a target codec.
     */
    private async selectGpuEncoder(targetCodec: string): Promise<string | undefined> {
        // If already a specific encoder (e.g., h264_nvenc), return it
        if (targetCodec.includes('_')) {
            const supported = await hardwareDetection.supportsEncoder(targetCodec);
            return supported ? targetCodec : undefined;
        }

        // Map generic codec to specific GPU encoder
        const codec = targetCodec
            .replace('lib', '')
            .replace('x264', 'h264')
            .replace('x265', 'hevc');
        return (
            (await hardwareDetection.getBestEncoder(codec as 'h264' | 'hevc' | 'av1')) ?? undefined
        );
    }

    /**
     * Check if hardware decoding should be used for a codec.
     */
    private shouldUseHwDecoder(codec: string): boolean {
        if (!config.HW_ENCODING_ENABLED) return false;

        const hwDecodeCodecs = config.HW_DECODE_CODECS.split(',').map((c) =>
            c.trim().toLowerCase(),
        );
        return hwDecodeCodecs.includes(codec.toLowerCase());
    }

    /**
     * Handle audio-only content.
     */
    private async decideAudioOnly(
        mediaSource: MediaSourceInfo,
        profile: DeviceProfile,
        audioStreams: MediaStreamInfo[],
    ): Promise<TranscodeDecision> {
        const primaryAudio = audioStreams.find((a) => a.isDefault) || audioStreams[0];

        if (!primaryAudio) {
            // No audio - weird, but return direct
            return {
                mode: 'direct',
                reasons: TranscodeReason.None,
                videoAction: 'copy',
                audioAction: 'copy',
                useGpu: false,
                needsTonemapping: false,
                preserveHdr10: false,
            };
        }

        // Use shared module for audio codec check
        const { caps: deviceCaps, unrestrictedAudioOnly } = profileToDeviceCaps(
            profile,
            undefined,
            primaryAudio.codec,
            mediaSource.container?.toLowerCase(),
        );
        const audioCodecList = audioStreams
            .map((s) => s.codec?.toLowerCase() ?? '')
            .filter(Boolean);
        const audioCompatible =
            unrestrictedAudioOnly ||
            audioCodecList.every((codec) => deviceCaps.audioCodecs.has(codec));

        if (audioCompatible) {
            return {
                mode: 'direct',
                reasons: TranscodeReason.None,
                videoAction: 'copy',
                audioAction: 'copy',
                useGpu: false,
                needsTonemapping: false,
                preserveHdr10: false,
            };
        }

        return {
            mode: 'full',
            reasons: TranscodeReason.AudioCodecNotSupported,
            videoAction: 'copy',
            audioAction: 'transcode',
            targetCodec: { audio: config.AUDIO_CODEC || 'aac' },
            useGpu: false,
            needsTonemapping: false,
            preserveHdr10: false,
        };
    }
}

// Export singleton instance
export const transcodeDecision = new TranscodeDecisionEngine();

// Export class for testing
export { TranscodeDecisionEngine };
