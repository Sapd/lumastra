// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Transcoding Module
 *
 * Full FFmpeg transcoding mode with GPU acceleration support,
 * device profiles, and automatic encoder selection.
 */

// Types
export * from './types.js';
export type {
    TranscodeStrategyConfig,
    TranscodeStrategyResult,
    FullStrategyConfig,
} from './transcode-strategy.js';

// Services
export { hardwareDetection, HardwareDetectionService } from './hardware-detection.js';
export { deviceProfiles, DeviceProfileService, DEFAULT_PROFILE } from './device-profiles.js';
export { transcodeDecision, TranscodeDecisionEngine } from './transcode-decision.js';
export {
    FFmpegArgsBuilder,
    getHwAccelFromEncoder,
    resolveTonemapMode,
    type VideoCodecOptions,
    type AudioCodecOptions,
    type HlsOutputOptions,
    type TonemappingOptions,
} from './ffmpeg-args-builder.js';

// Transcode Strategies
export { FullTranscodeStrategy } from './full-transcode-strategy.js';

// HLS Utilities
export {
    buildVarStreamMap,
    buildHlsOutputPattern,
    isHlsCompatibleAudioCodec,
    requiresAudioTranscode,
    determineAudioAction,
    HLS_COMPATIBLE_AUDIO_CODECS,
    HLS_INCOMPATIBLE_AUDIO_CODECS,
    type AudioTrackMapInfo,
} from './hls-utils.js';

export {
    planStandaloneTranscode,
    resolveEffectiveVideo,
    type EffectiveTranscodePlan,
    type EffectiveVideoAction,
} from './effective-transcode-plan.js';
