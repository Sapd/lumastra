// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { Logger } from '../../utils/logger.js';
import { classifyHdrSource } from './types.js';
import type { TranscodeDecision } from './types.js';
import type { FullStrategyConfig } from './transcode-strategy.js';

const logger = Logger.for('EffectiveTranscodePlan');

export type EffectiveVideoAction = ReturnType<typeof selectVideoAction>;
type VideoPlanInput = Pick<
    FullStrategyConfig,
    | 'decision'
    | 'videoInfo'
    | 'videoDisabled'
    | 'subtitleBurnIn'
    | 'burnInHdrStrategy'
    | 'gpuAcceleration'
    | 'tonemappingAlgorithm'
>;
type EffectivePlanInput = VideoPlanInput &
    Pick<
        FullStrategyConfig,
        | 'segmentDuration'
        | 'startTimeSeconds'
        | 'startNumber'
        | 'gopSegments'
        | 'maxWidth'
        | 'maxHeight'
        | 'maxVideoBitrateMbps'
        | 'qualityCapAudioReservationBps'
        | 'videoBitrateMbps'
    >;

/** Serializable job contract. Geometry is derived once for each generation. */
export interface EffectiveTranscodePlan {
    version: 1;
    video: EffectiveVideoAction | { action: 'drop' };
    codecRequestHdr?:
        { kind: 'tonemap'; algorithm: string } | { kind: 'preserve'; range: 'HLG' | 'HDR10' };
    videoDisabled: boolean;
    tonemappingAlgorithm: string;
    decision: TranscodeDecision | undefined;
    tonemapBurnInToSdr: boolean;
    subtitleBurnIn: FullStrategyConfig['subtitleBurnIn'];
    grid: 'uniform' | 'keyframe' | 'gop';
    segmentDuration: number;
    startTimeSeconds: number;
    segmentOffset: number;
    startNumber: number;
    caps: { qualityCapTotalBudgetBps?: number } & Pick<
        FullStrategyConfig,
        | 'maxWidth'
        | 'maxHeight'
        | 'maxVideoBitrateMbps'
        | 'qualityCapAudioReservationBps'
        | 'videoBitrateMbps'
    >;
}

/**
 * Resolve video/HDR once, before the job exposes its grid. Standalone strategy
 * callers also use this planner; the argv strategy never selects an encoder.
 */
export function resolveEffectiveVideo(
    config: VideoPlanInput,
): Pick<
    EffectiveTranscodePlan,
    | 'video'
    | 'decision'
    | 'tonemapBurnInToSdr'
    | 'videoDisabled'
    | 'subtitleBurnIn'
    | 'codecRequestHdr'
> {
    const decision = config.decision ? structuredClone(config.decision) : undefined;
    config = { ...config, decision };
    const burnInForcesTranscode = !!config.subtitleBurnIn && decision?.videoAction === 'copy';
    if (config.videoDisabled) {
        // Match the job boundary for standalone argv callers too: a real
        // decision uses absolute audio-only numbering; legacy absence does not.
        if (decision) decision.videoAction = 'transcode';
        return {
            video: { action: 'drop' },
            decision,
            tonemapBurnInToSdr: false,
            videoDisabled: true,
            subtitleBurnIn: undefined,
        };
    }
    let tonemapBurnInToSdr = false;
    if (config.subtitleBurnIn && decision) {
        const peeked = selectVideoAction(config, burnInForcesTranscode);
        const sourceHdr = classifyHdrSource(
            config.videoInfo?.videoRange,
            config.videoInfo?.videoRangeType,
        );
        if (peeked.action === 'transcode' && peeked.isGpu && peeked.isHevc && sourceHdr.isHdr) {
            const strategy = config.burnInHdrStrategy ?? 'tonemap';
            const clientWantsSdr = !!decision.needsTonemapping;
            if (strategy === 'software') {
                // Keep HDR (10-bit): drop to software so libx265 derives its
                // profile from the real frames (no Main10-over-8-bit mismatch).
                decision.useGpu = false;
                decision.gpuEncoder = undefined;
                decision.gpuDecoder = undefined;
                // Also clear a GPU encoder left in targetCodec (e.g. 'hevc_qsv'),
                // or video planning would pick it back up as a "software"
                // encoder and never fall through to the libx265 CPU path.
                if (decision.targetCodec) {
                    decision.targetCodec.video = undefined;
                }
                logger.info('HDR subtitle burn-in → software encode (preserve HDR)', {
                    subtitleIndex: config.subtitleBurnIn.absoluteIndex,
                    clientWantsSdr,
                    videoRange: config.videoInfo?.videoRange,
                });
            } else {
                // Keep GPU encode: tonemap HDR→SDR *before* the overlay so the
                // 8-bit composited frames match an 8-bit SDR (Main) profile. The
                // burn-in chain owns the tonemap, so disable the general one.
                decision.needsTonemapping = false;
                decision.preserveHdr10 = false;
                decision.outputVideoRange = 'SDR';
                tonemapBurnInToSdr = true;
                logger.info('HDR subtitle burn-in → GPU encode with HDR→SDR tonemap', {
                    subtitleIndex: config.subtitleBurnIn.absoluteIndex,
                    clientWantsSdr,
                    videoRange: config.videoInfo?.videoRange,
                });
            }
        }
    }

    const video = selectVideoAction(config, burnInForcesTranscode);
    if (decision) {
        decision.videoAction = video.action;
    }
    let codecRequestHdr: EffectiveTranscodePlan['codecRequestHdr'];
    const needsCodecChange =
        !!config.videoInfo?.outputCodec &&
        config.videoInfo.outputCodec.toLowerCase() !== config.videoInfo.codec?.toLowerCase();
    if (
        video.action === 'transcode' &&
        needsCodecChange &&
        !tonemapBurnInToSdr &&
        !decision?.needsTonemapping &&
        !decision?.preserveHdr10
    ) {
        const hdr = classifyHdrSource(
            config.videoInfo?.videoRange,
            config.videoInfo?.videoRangeType,
        );
        if (hdr.isHdr && video.isH264) {
            codecRequestHdr = {
                kind: 'tonemap',
                algorithm:
                    !video.isGpu && config.tonemappingAlgorithm === 'bt2390'
                        ? 'hable'
                        : config.tonemappingAlgorithm,
            };
        } else if (hdr.isHdr && video.isHevc) {
            codecRequestHdr = { kind: 'preserve', range: hdr.isHlg ? 'HLG' : 'HDR10' };
        }
    }
    return {
        video,
        decision,
        tonemapBurnInToSdr,
        videoDisabled: false,
        subtitleBurnIn: config.subtitleBurnIn,
        codecRequestHdr,
    };
}

/** Adapter for standalone callers without a job (probes and argv unit tests). */
export function planStandaloneTranscode(config: EffectivePlanInput): EffectiveTranscodePlan {
    const video = resolveEffectiveVideo(config);
    const copy = !video.videoDisabled && video.video.action === 'copy';
    return {
        version: 1,
        ...video,
        tonemappingAlgorithm: config.tonemappingAlgorithm,
        grid: copy ? (config.gopSegments ? 'gop' : 'keyframe') : 'uniform',
        segmentDuration: config.segmentDuration,
        startTimeSeconds: config.startTimeSeconds ?? 0,
        segmentOffset: config.startNumber ?? 0,
        startNumber:
            copy || (video.videoDisabled && video.decision?.videoAction !== 'transcode')
                ? 0
                : (config.startNumber ?? 0),
        caps: {
            maxWidth: config.maxWidth,
            maxHeight: config.maxHeight,
            videoBitrateMbps: config.videoBitrateMbps,
            maxVideoBitrateMbps: config.maxVideoBitrateMbps,
            qualityCapAudioReservationBps: config.qualityCapAudioReservationBps,
        },
    };
}

function selectVideoAction(
    config: VideoPlanInput,
    forcedTranscode: boolean = false,
):
    | { action: 'copy' }
    | {
          action: 'transcode';
          encoder: string;
          isH264: boolean;
          isHevc: boolean;
          isAv1: boolean;
          isGpu: boolean;
          source: 'gpuEncoder' | 'targetCodec' | 'outputCodec' | 'fallback';
      } {
    const { decision, videoInfo } = config;

    const needsCodecChange =
        !!videoInfo?.outputCodec &&
        videoInfo.outputCodec.toLowerCase() !== (videoInfo.codec?.toLowerCase() ?? '');

    // 1. GPU encoder from decision engine
    if (decision?.gpuEncoder) {
        const e = decision.gpuEncoder.toLowerCase();
        return {
            action: 'transcode',
            encoder: decision.gpuEncoder,
            isH264: e.includes('264'),
            isHevc: e.includes('hevc') || e.includes('265'),
            isAv1: e.includes('av1'),
            isGpu: true,
            source: 'gpuEncoder',
        };
    }

    // 2. Software encoder from decision engine
    if (decision?.targetCodec?.video) {
        const e = decision.targetCodec.video.toLowerCase();
        return {
            action: 'transcode',
            encoder: decision.targetCodec.video,
            isH264: e.includes('264'),
            isHevc: e.includes('265') || e.includes('hevc') || e.includes('x265'),
            isAv1: e.includes('av1') || e.includes('svtav1') || e.includes('aom'),
            isGpu: false,
            source: 'targetCodec',
        };
    }

    // Standalone/legacy callers can force encoding without a codec change (burn-in).
    // Honour the requested output, then the source family, using the same GPU
    // mapping as a codec change. Unknown families use the compatible H.264 default.
    const requiredTranscode = decision?.videoAction === 'transcode' || forcedTranscode;
    if (needsCodecChange || requiredTranscode) {
        const target = (videoInfo?.outputCodec ?? videoInfo?.codec ?? 'h264').toLowerCase();
        const isHevc = target.includes('265') || target.includes('hevc');
        const isAv1 = target.includes('av1') || target.includes('svtav1');
        const isH264 = !isHevc && !isAv1;
        const source = needsCodecChange ? 'outputCodec' : 'fallback';

        if (decision?.useGpu && config.gpuAcceleration && config.gpuAcceleration !== 'none') {
            const suffix =
                config.gpuAcceleration === 'nvenc'
                    ? '_nvenc'
                    : config.gpuAcceleration === 'qsv'
                      ? '_qsv'
                      : config.gpuAcceleration === 'vaapi'
                        ? '_vaapi'
                        : config.gpuAcceleration === 'amf'
                          ? '_amf'
                          : config.gpuAcceleration === 'videotoolbox'
                            ? '_videotoolbox'
                            : undefined;
            const gpuEncoder = suffix
                ? isH264
                    ? `h264${suffix}`
                    : isHevc
                      ? `hevc${suffix}`
                      : isAv1
                        ? `av1${suffix}`
                        : undefined
                : undefined;
            if (gpuEncoder) {
                return {
                    action: 'transcode',
                    encoder: gpuEncoder,
                    isH264,
                    isHevc,
                    isAv1,
                    isGpu: true,
                    source,
                };
            }
        }

        const encoder = isH264 ? 'libx264' : isHevc ? 'libx265' : isAv1 ? 'libsvtav1' : 'libx264';
        return {
            action: 'transcode',
            encoder,
            isH264,
            isHevc,
            isAv1,
            isGpu: false,
            source,
        };
    }

    // 5. Copy (includes decision.videoAction === 'copy' when no codec change)
    return { action: 'copy' };
}
