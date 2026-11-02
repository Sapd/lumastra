// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PlaybackPlan Zod Schema
 *
 * SINGLE SOURCE OF TRUTH for the PlaybackPlan type.
 * A PlaybackPlan is the canonical decision object flowing from
 * browser capabilities → server planner → executor.
 */

import { z } from 'zod';

export const DeliveryPathEnum = z.enum(['direct_file', 'native_hls', 'mse_hls']);
export const VideoActionEnum = z.enum(['copy', 'transcode']);
export const AudioActionEnum = z.enum(['copy', 'transcode']);
export const SubtitleMethodEnum = z.enum(['external_vtt', 'burn_in', 'client_render', 'none']);
/**
 * Subset reportable by the client. `burn_in` is a server-side decision
 * (FFmpeg encodes subs into video) and must never originate from heartbeats;
 * excluding it here makes that a schema-enforced invariant.
 */
export const ClientSubtitleMethodEnum = z.enum(['external_vtt', 'client_render', 'none']);
export const PlanIntentEnum = z.enum(['play', 'preview']);
export const PlanMethodEnum = z.enum([
    'direct',
    'remux',
    'audio_transcode',
    'full_transcode',
    'audio_only',
]);
export const PlaybackBranchEnum = z.enum([
    'direct',
    'remux_api',
    'web_hls_single_audio',
    'native_hls_multi_audio',
    'full_transcode',
]);
export const HlsAudioModeEnum = z.enum(['muxed', 'demux']);

/**
 * Structured, language-agnostic transcode reason emitted by the planner.
 *
 * Clients prefer `transcode_reason_codes` for i18n rendering; the legacy
 * `transcode_reasons` string array is still emitted for replicas / clients
 * that haven't migrated yet. Both arrays describe the same concerns in the
 * same order.
 */
export const TranscodeReasonCodeEnum = z.enum([
    'video_codec_incompatible',
    'video_10bit_h264',
    'audio_codec_incompatible',
    'container_incompatible',
    'hdr_tonemap_dolby_vision',
    'multi_audio_needs_hls',
    'video_level_exceeded',
    'video_profile_excluded',
    'video_profile_exceeded',
    'resolution_exceeded',
    'resolution_exceeded_user_cap',
    'bitrate_exceeded',
    'bitrate_exceeded_user_cap',
    'audio_channels_exceeded',
    'preview_mode',
    'client_requested',
    'subtitle_burn_in',
    'audio_format_requested',
    'audio_bitrate_requested',
    'audio_bitrate_exceeded',
    'audio_container_incompatible',
]);

export const TranscodeReasonSchema = z.object({
    code: TranscodeReasonCodeEnum,
    params: z
        .record(z.string(), z.union([z.string(), z.number()]))
        .optional()
        .describe('Interpolation params for the reason message (e.g. { codec: "truehd" })'),
});

export const PlaybackPlanSchema = z.object({
    plan_id: z
        .string()
        .guid()
        .optional()
        .describe('Unique plan identifier — absent when Valkey storage failed'),
    intent: PlanIntentEnum.describe('Play or preview'),
    delivery_path: DeliveryPathEnum.describe('How content reaches the player'),
    playback_branch: PlaybackBranchEnum.optional().describe(
        'Stable playback branch contract chosen by the planner',
    ),
    method: PlanMethodEnum.describe('Playback method matching media-compatibility recommendation'),
    video_action: VideoActionEnum.describe('What to do with video stream'),
    audio_action: AudioActionEnum.describe('What to do with audio stream'),
    hls_audio_mode: HlsAudioModeEnum.optional().describe(
        'HLS audio layout required by the chosen playback branch',
    ),
    target_video_codec: z.string().optional().describe('Target video codec if transcoding'),
    target_audio_codec: z.string().optional().describe('Target audio codec if transcoding'),
    subtitle_method: SubtitleMethodEnum.describe('How subtitles are delivered'),
    transcode_reasons: z
        .array(z.string())
        .describe('Human-readable reasons for this plan (legacy, English only)'),
    transcode_reason_codes: z
        .array(TranscodeReasonSchema)
        .optional()
        .describe('Structured, i18n-friendly reasons for this plan'),
    output_hdr: z.string().optional().describe('Output HDR type (hdr10, hlg, sdr, etc.)'),
    needs_tonemapping: z.boolean().describe('Whether HDR→SDR tonemapping is needed'),
    source_video_codec: z
        .string()
        .optional()
        .describe('Source video codec at plan creation time (for drift detection)'),
    source_audio_codec: z
        .string()
        .optional()
        .describe('Primary source audio codec at plan creation time'),
    gpu_encoder: z.string().optional().describe('GPU encoder name (e.g. h264_nvenc)'),
    gpu_decoder: z.string().optional().describe('GPU decoder name'),
    client_hdr_formats: z
        .array(z.string())
        .optional()
        .describe(
            'HDR formats the requesting client can display (hdr10, hlg, dovi), from the capabilities the plan was built with. Absent when the client sent none. Lets the HLS job give a copy plan that it must re-encode the HDR handling a planned transcode would get (tone-map vs preserve).',
        ),
    quality_cap: z
        .object({
            max_bitrate: z.number().positive().optional(),
            max_height: z.number().positive().optional(),
        })
        .optional()
        .describe(
            'The per-request quality cap (user-selected max bitrate in bits/s / max height in px) this plan was evaluated against. Absent when the plan was built without one. The HLS job trusts the plan for any cap it covers.',
        ),
    file_id: z.string().guid().describe('Media file version ID'),
    created_at: z.string().datetime().describe('Plan creation timestamp'),
    expires_at: z.string().datetime().describe('Plan expiration timestamp'),
});

export type PlaybackPlan = z.infer<typeof PlaybackPlanSchema>;
export type DeliveryPath = z.infer<typeof DeliveryPathEnum>;
export type SubtitleMethod = z.infer<typeof SubtitleMethodEnum>;
export type ClientSubtitleMethod = z.infer<typeof ClientSubtitleMethodEnum>;
export type PlanIntent = z.infer<typeof PlanIntentEnum>;
export type PlanMethod = z.infer<typeof PlanMethodEnum>;
export type PlaybackBranch = z.infer<typeof PlaybackBranchEnum>;
export type HlsAudioMode = z.infer<typeof HlsAudioModeEnum>;
export type TranscodeReasonCode = z.infer<typeof TranscodeReasonCodeEnum>;
export type TranscodeReason = z.infer<typeof TranscodeReasonSchema>;
