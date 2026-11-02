// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { TimelineChapterSchema } from './playback-types.js';
import { z } from 'zod';
import { AudiobookSessionBookSchema } from './api-audiobook-session.js';
import { reportingBlockSchema } from './play-reporting.js';
import { ImageDescriptorSchema } from './api-image-descriptor.js';
import { TranscodeReasonSchema } from './playback-plan.js';
import { PlayMethodSchema } from './play-sessions.js';
import { LumastraHlsAudioModeSchema, LumastraVersionSchema } from './api-playback-responses.js';
import { timelineSubtitleDescriptorSchema } from './playback.js';
import { LiveHlsDeliverySchema } from './livetv-delivery.js';

export { PlaybackCapabilitiesSchema } from './playback-capabilities.js';
import { PlaybackCapabilitiesSchema } from './playback-capabilities.js';

export const PlaySessionEntrySchema = z
    .enum(['continue', 'next_up', 'autoplay', 'resume', 'explicit'])
    .meta({ id: 'PlaySessionEntry' });

export const PlaybackStartRequestSchema = z
    .object({
        purpose: z
            .enum(['play', 'prefetch'])
            .default('play')
            .optional()
            .describe(
                'Defaults to play. Music tracks only: prefetch requires an admitted ACTIVE or PAUSED play session on the same user and device; otherwise 422 prefetch_requires_current_session means fall back to purpose=play. At most one unpromoted prefetch per device; a new allocation replaces the previous one. Prefetch consumes no stream slot and stays hidden. First ACTIVE or positive-position/heard-time report promotes atomically with normal admission (422 stream_limit on refusal). It expires after 10 minutes or immediately when its current session ends.',
            ),
        mediaId: z.string().uuid(),
        fileId: z.string().uuid().optional(),
        versionId: z
            .string()
            .uuid()
            .optional()
            .describe('Deprecated and ignored. Older Apple builds may still send it.'),
        deviceId: z.string().min(1).max(128),
        clientInfo: z
            .object({
                name: z.string().optional(),
                carPlay: z
                    .boolean()
                    .optional()
                    .describe(
                        'Client-reported CarPlay connection context; display only, never identity or authorization.',
                    ),
                client: z
                    .string()
                    .optional()
                    .describe('Diagnostic app name; trimmed and capped at 200 characters.'),
                version: z
                    .string()
                    .optional()
                    .describe(
                        'Diagnostic app version and build; trimmed and capped at 200 characters.',
                    ),
                userAgent: z
                    .string()
                    .optional()
                    .describe(
                        'Diagnostic User-Agent; falls back to the request header. Trimmed and capped at 200 characters.',
                    ),
            })
            .strict()
            .optional(),
        capabilities: PlaybackCapabilitiesSchema.optional(),
        requestedMethod: PlayMethodSchema.optional(),
        audioStreamIndex: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('Absolute stream index from the selected file.'),
        subtitleId: z
            .string()
            .min(1)
            .optional()
            .describe(
                'Stable subtitles[].id from playability; "none" explicitly disables subtitles. Omitted applies recommended.',
            ),
        startPositionMs: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe(
                'Start position in milliseconds. Omitted video resumes local watch state; audiobooks resume upstream AudiobookShelf progress; music has no durable resume.',
            ),
        audio: z
            .object({
                format: z.string().min(1).optional(),
                bitrateKbps: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe('Audio bitrate, kilobits per second.'),
                download: z
                    .boolean()
                    .optional()
                    .describe(
                        'Audiobook only: prepare an offline transfer. Music downloads use Bearer GET /music/tracks/{id}/stream?download=1, without a listening start.',
                    ),
            })
            .strict()
            .optional(),
        entry: PlaySessionEntrySchema.optional().describe(
            'How the viewer opened this playback: continue, next_up, autoplay and resume are linear watching, and only such a session can continue a chain another device follows (GET /me/resume-handoff). explicit (an episode or chapter pick, a start time, a watch party) or omitted never does.',
        ),
        castTarget: z
            .boolean()
            .default(false)
            .optional()
            .describe(
                'Allow another IP to fetch this session when server policy permits. Defaults to false.',
            ),
    })
    .strict();

const ms = z.number().int().nonnegative();
// One subtitle list per start (package 9's descriptor): every href is on the caller's
// surface and carries the start's grant. Lazy: playback.ts imports this module.
const subtitleTrack = z.lazy(() => timelineSubtitleDescriptorSchema);
const timeline = z
    .object({
        href: z
            .string()
            .describe(
                'Chapters, skip segments and trickplay for the selected file; carries the grant.',
            ),
    })
    .describe('Where to read the timeline of the selected file.');
const common = {
    startPositionMs: ms,
    durationMs: ms.nullable(),
    timeline: timeline.optional(),
    stills: z.array(ImageDescriptorSchema).optional(),
};
const video = {
    ...common,
    fileId: z.string(),
    playMethod: PlayMethodSchema,
    outputHdr: LumastraVersionSchema.shape.output_hdr
        .optional()
        .describe('HDR format delivered by the selected play method.'),
    transcodeCodec: z
        .enum(['h264', 'hevc', 'av1'])
        .optional()
        .describe('Video encoder target for full transcode delivery.'),
    hlsAudioMode: LumastraHlsAudioModeSchema.optional().describe(
        'HLS audio layout of this session: muxed (audio in video segments) or demux (separate audio renditions). Absent for direct file delivery.',
    ),
    reasons: z.array(z.string()),
    reasonCodes: z.array(TranscodeReasonSchema),
    applied: z.object({ audioStreamIndex: z.number().int().optional(), subtitleId: z.string() }),
    tracks: LumastraVersionSchema.shape.tracks,
    subtitles: z
        .array(subtitleTrack)
        .describe(
            'Every subtitle track of the selected file, embedded and external, with ready hrefs: `text` (WebVTT) for text tracks, `raw` (original format) and, for bitmap tracks, `rendered` (pre-rendered images).',
        ),
    seek: z.object({ clientShouldSeek: z.boolean(), streamStartPositionMs: ms }),
    trickplay: z.object({ href: z.string(), intervalMs: ms }).optional(),
    recommended: z
        .object({
            audioStreamIndex: z
                .number()
                .int()
                .optional()
                .describe(
                    'Audio track to start on (absolute stream index, as audioStreamIndex in the request).',
                ),
            subtitleId: z
                .string()
                .optional()
                .describe('Stable subtitle id to start on; none disables subtitles.'),
        })
        .optional()
        .describe(
            "The server's preselection from the user's language preferences; absent when it has no opinion.",
        ),
};
export const PlaybackDeliverySchema = z.discriminatedUnion('kind', [
    z.object({
        ...common,
        kind: z.literal('file'),
        live: z
            .boolean()
            .optional()
            .describe(
                'True for internet radio: unbounded live audio; no seeking, resume or prefetch.',
            ),
        url: z.string(),
        container: z.string(),
        fileId: z.string().optional(),
        playMethod: PlayMethodSchema.optional(),
        outputHdr: video.outputHdr,
        transcodeCodec: video.transcodeCodec,
        hlsAudioMode: video.hlsAudioMode,
        reasons: z.array(z.string()).optional(),
        reasonCodes: video.reasonCodes.optional(),
        applied: video.applied.optional(),
        codec: z.string().optional().describe('Actual delivered audio codec for music.'),
        bitrateKbps: z
            .number()
            .nonnegative()
            .optional()
            .describe('Actual delivered audio bitrate for music, kilobits per second.'),
        tracks: video.tracks.optional(),
        subtitles: video.subtitles.optional(),
        seek: video.seek.optional(),
        trickplay: video.trickplay,
        recommended: video.recommended,
    }),
    z.object({ ...video, kind: z.literal('hls'), url: z.string() }),
    z.object({
        ...common,
        kind: z.literal('multipart-audio'),
        tracks: z
            .array(
                z.object({
                    index: z.number().int(),
                    url: z.string(),
                    startMs: ms,
                    durationMs: ms,
                    mime: z.string(),
                    remuxUrl: z.string().optional(),
                    codec: z.string().nullable().optional(),
                    title: z.string().nullable().optional(),
                    needsRemux: z.boolean().optional(),
                }),
            )
            .describe(
                "The book's files on the book clock. When the server transcodes, one entry: an HLS playlist (application/vnd.apple.mpegurl) for the whole book. Every URL starts at 0: seek to startPositionMs yourself.",
            ),
        book: AudiobookSessionBookSchema.optional(),
        chapters: z.array(TimelineChapterSchema),
    }),
    LiveHlsDeliverySchema,
]);
/** The credential of one playback session; start and renew return this same object. */
export const PlaybackGrantSchema = z.object({
    id: z.string().uuid().describe('Public grant identifier, distinct from its secret'),
    token: z.string().describe('Opaque media delivery credential; use the grant query parameter'),
    param: z.literal('grant'),
    mediaId: z.string(),
    playbackSessionId: z.string().nullable(),
    kind: z.enum(['video', 'music', 'audiobook', 'live', 'preview']),
    ipPinned: z.boolean(),
    expiresAt: z.string().datetime(),
    renewAfter: z.string().datetime(),
    renewHref: z.string(),
});
export const PlaybackStartResponseSchema = z.object({
    playbackSessionId: z.string().uuid(),
    mediaId: z.string().uuid(),
    kind: z.enum(['video', 'music', 'audiobook', 'live']),
    delivery: PlaybackDeliverySchema,
    grant: PlaybackGrantSchema,
    reporting: reportingBlockSchema,
});
export type { PlaybackCapabilities } from './playback-capabilities.js';
export type PlaybackStartRequest = z.infer<typeof PlaybackStartRequestSchema>;
export type PlaybackStartResponse = z.infer<typeof PlaybackStartResponseSchema>;
