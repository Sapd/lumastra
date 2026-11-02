// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/v1/media/{id}/playability — request and response.
 *
 * A read-only look at what POST /play-sessions would decide for a title, before
 * any session exists. The request reuses the start's capabilities schema; the
 * response is camelCase throughout.
 */

import { z } from 'zod';
import { PlaybackCapabilitiesSchema } from './playback-capabilities.js';
import { PlayMethodSchema } from './play-sessions.js';
import { TranscodeReasonSchema } from './playback-plan.js';
import {
    AudioSelectionReasonSchema,
    LumastraHlsAudioModeSchema,
    SubtitleSelectionReasonSchema,
} from './api-playback-responses.js';

const hdr = z.enum(['hdr10', 'hdr10plus', 'hlg', 'dovi', 'dovi_hdr10', 'sdr']);

export const PlayabilityRequestSchema = z
    .object({
        capabilities: PlaybackCapabilitiesSchema.optional(),
        fileId: z
            .string()
            .uuid()
            .optional()
            .describe(
                'Probe only this file version. Omit to probe every version of the title and use the default version for the item-level fields.',
            ),
    })
    .meta({ id: 'PlayabilityRequest' });

export const PlayabilityAudioTrackSchema = z
    .object({
        index: z.number().int().describe('0-based position among the audio tracks, for display.'),
        absoluteIndex: z
            .number()
            .int()
            .describe(
                'Absolute stream index in the file. Send this as `audioStreamIndex` when you start playback.',
            ),
        codec: z.string(),
        channels: z.number().int(),
        language: z.string().nullable(),
        title: z.string().nullable(),
        default: z.boolean(),
    })
    .meta({ id: 'PlayabilityAudioTrack' });

export const PlayabilitySubtitleTrackSchema = z
    .object({
        id: z
            .string()
            .describe(
                'Stable identifier of the track. Embedded: `<fileId>:<stream index>`. Sidecar: the id of the subtitle file, which does not change when other sidecars come and go. Key your selection state on this, not on `index`.',
            ),
        index: z
            .number()
            .int()
            .describe(
                'Stream index in the file. Select by the stable `id` as `subtitleId` when starting playback. A sidecar has a synthetic position (1000 + its place among the sidecars of this file) that renumbers when a sidecar is added: do not store it.',
            ),
        absoluteIndex: z
            .number()
            .int()
            .describe('Same value as `index`: the absolute stream index (synthetic for sidecars).'),
        codec: z.string(),
        language: z.string().nullable(),
        title: z.string().nullable(),
        default: z.boolean(),
        forced: z.boolean(),
        format: z
            .enum(['text', 'bitmap', 'ass'])
            .describe('`text` (SRT, WebVTT), `bitmap` (PGS, VobSub) or `ass` (ASS, SSA).'),
        source: z
            .enum(['embedded', 'sidecar'])
            .describe(
                '`embedded` lives in the media file; `sidecar` is a separate subtitle file. Both embedded tracks and sidecars are selectable by stable `subtitleId`.',
            ),
        method: z
            .enum(['external_vtt', 'burn_in', 'client_render', 'none'])
            .describe(
                'How the server delivers this track for these capabilities: `external_vtt` (WebVTT link), `client_render` (your player draws it from the raw or rendered link), `burn_in` (encoded into the video; forces a full transcode) or `none` (no delivery).',
            ),
    })
    .meta({ id: 'PlayabilitySubtitleTrack' });

export const PlayabilityVideoTrackSchema = z
    .object({
        codec: z.string(),
        width: z.number().int(),
        height: z.number().int(),
        container: z.string().optional(),
        hdr,
        bitrate: z.number().optional().describe('Video bitrate, bits per second.'),
        fps: z.number().optional(),
        dvProfile: z
            .number()
            .int()
            .optional()
            .describe('Dolby Vision profile; absent for non-DV video.'),
        dvBlCompatId: z
            .number()
            .int()
            .optional()
            .describe('Dolby Vision base-layer compatibility id; absent for non-DV video.'),
    })
    .meta({ id: 'PlayabilityVideoTrack' });

export const PlayabilityVersionSchema = z
    .object({
        fileId: z
            .string()
            .describe('Send this as `fileId` when you start playback of this version.'),
        label: z.string().nullable().describe('Display label, e.g. "4K Director\'s Cut".'),
        isDefault: z.boolean(),
        playable: z
            .boolean()
            .describe(
                'False when a start of this version would fail or has no delivery for these capabilities; show an error instead of starting. See `blockedBy`.',
            ),
        blockedBy: z
            .array(z.enum(['probe_failed', 'play_method_not_allowed', 'transcoding_unavailable']))
            .describe(
                '`transcoding_unavailable`: the version needs ffmpeg and the server has none. `probe_failed`: the file could not be read (missing, unreachable or timed out), so no tracks or method are known. `play_method_not_allowed`: the account may not use `playMethod` (stream policy). Other policy rules (concurrent streams, IP) are not evaluated by a probe. Empty when nothing blocks the version.',
            ),
        playMethod: PlayMethodSchema.optional().describe(
            'What a start with these capabilities would use for this version. Absent when the file could not be read.',
        ),
        availableMethods: z
            .array(PlayMethodSchema)
            .describe('Delivery methods this server can serve for this version.'),
        reasons: z
            .array(z.string())
            .describe('Why `playMethod` is not `direct`, as English text. Empty for direct play.'),
        reasonCodes: z
            .array(TranscodeReasonSchema)
            .describe('The same reasons as stable codes; switch on these, not on `reasons`.'),
        outputHdr: hdr
            .optional()
            .describe(
                'HDR format the player receives with `playMethod`. Absent when the file could not be read.',
            ),
        hlsAudioMode: LumastraHlsAudioModeSchema.optional().describe(
            '`muxed`: audio travels inside the video segments. `demux`: audio is a separate HLS rendition, so tracks switch without a restart.',
        ),
        durationMs: z.number().int().nullable(),
        sizeBytes: z
            .number()
            .int()
            .optional()
            .describe('Size of the source file. Absent when not scanned yet; not zero.'),
        tracks: z.object({
            video: PlayabilityVideoTrackSchema.nullable(),
            audio: z.array(PlayabilityAudioTrackSchema),
            subtitles: z.array(PlayabilitySubtitleTrackSchema),
        }),
    })
    .meta({ id: 'PlayabilityVersion' });

export const PlayabilityResponseSchema = z
    .object({
        mediaId: z.string().uuid(),
        activeFileId: z
            .string()
            .describe(
                'The version a start without `fileId` would play: the requested `fileId`, else the default.',
            ),
        resumePositionMs: z
            .number()
            .int()
            .nonnegative()
            .describe(
                'Where a start without `startPositionMs` begins. 0 for a finished or untouched title.',
            ),
        isWatched: z.boolean(),
        hlsAudioMode: LumastraHlsAudioModeSchema.optional().describe(
            '`hlsAudioMode` of the active version.',
        ),
        recommended: z
            .object({
                audioStreamIndex: z
                    .number()
                    .int()
                    .optional()
                    .describe(
                        'Audio track to start on, as `tracks.audio[].absoluteIndex` of the active version.',
                    ),
                subtitleId: z
                    .string()
                    .optional()
                    .describe('`tracks.subtitles[].id` of the recommended subtitle track.'),
                reason: z
                    .object({
                        audio: AudioSelectionReasonSchema,
                        subtitle: SubtitleSelectionReasonSchema,
                    })
                    .describe('Why each pick was made; show it in the track picker.'),
            })
            .optional()
            .describe(
                "The tracks the server applies for the active version, from the user's language preferences: send them in the start unless the user chooses otherwise. Absent when it has no opinion.",
            ),
        versions: z.array(PlayabilityVersionSchema),
    })
    .meta({ id: 'PlayabilityResponse' });

export type PlayabilityRequest = z.infer<typeof PlayabilityRequestSchema>;
export type PlayabilitySubtitleTrack = z.infer<typeof PlayabilitySubtitleTrackSchema>;
export type PlayabilityResponse = z.infer<typeof PlayabilityResponseSchema>;
