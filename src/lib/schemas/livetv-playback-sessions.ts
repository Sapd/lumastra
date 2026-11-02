// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { PlaybackStartResponseSchema } from './playback-start.js';
import { keepaliveReportingSchema } from './play-reporting.js';
import { LiveHlsDeliverySchema, LiveTvQualitySchema } from './livetv-delivery.js';
import {
    LiveTvFailureCodeSchema,
    LiveTvFeedTriedSchema,
    LiveTvSessionFailureSchema,
} from './livetv-failures.js';

export const PlaybackSessionStartSchema = z
    .object({
        castTarget: z.boolean().optional(),
        stationId: z.string().guid(),
        purpose: z
            .enum(['playback', 'preview'])
            .optional()
            .meta({
                description:
                    'playback (default) or preview. A preview is its own viewer: it never supersedes or evicts ' +
                    "the caller's real playback session, joins with low priority (so it only runs when a provider " +
                    'slot is free), is not recorded as a watch and is not a playback session in any "now playing" list.',
            }),
        feedId: z.string().guid().optional(),
        quality: LiveTvQualitySchema.optional().meta({
            description: 'Live TV quality selection; server follows the administrator default',
        }),
        maxBitrateBps: z.number().finite().positive().optional().meta({
            description: 'Maximum total Live TV mux bitrate in bits per second',
        }),
        hevc: z
            .enum(['any', 'fmp4', 'none'])
            .optional()
            .meta({
                description:
                    'What the player can do with HEVC video: any (decodes it from MPEG-TS and fMP4, e.g. hls.js with HEVC support), ' +
                    'fmp4 (only from fMP4 segments: Apple native HLS, AVPlayer), none (cannot decode HEVC). ' +
                    'For an HEVC channel the server then serves the same video in fMP4 segments, or an H.264 encode, ' +
                    'and says so in `variant`. Omitted: the original stream as before.',
            }),
    })
    .strict();

// The Live TV start answers with the shared playback-session envelope. The Live TV
// delivery keeps feed and quality decisions; reporting describes its POST lease.
// Built in start-playback.ts.
export const PlaybackSessionStartResponseSchema = z.object({
    playbackSessionId: z.string().guid(),
    kind: z.literal('live'),
    stationId: z.string().guid(),
    purpose: z.enum(['playback', 'preview']).optional(),
    delivery: LiveHlsDeliverySchema,
    grant: PlaybackStartResponseSchema.shape.grant,
    reporting: keepaliveReportingSchema,
});

export const PlaybackSessionStateSchema = z.object({
    playbackSessionId: z.string().guid(),
    stationId: z.string().guid(),
    feedId: z.string().guid(),
    purpose: z.enum(['playback', 'preview']).optional(),
    state: z.enum(['active', 'ended']),
    endReason: z.enum(['evicted', 'superseded', 'expired', 'left', 'failed']).optional(),
    failure: LiveTvSessionFailureSchema.optional().meta({
        description:
            'Present when endReason is "failed": the typed reason the channel stopped, and whether to retry',
    }),
    adaptive: LiveHlsDeliverySchema.shape.adaptive,
    variant: LiveHlsDeliverySchema.shape.variant,
});
export const PlaybackSessionEndedSchema = z.object({
    code: z.union([z.literal('gone'), LiveTvFailureCodeSchema]).meta({
        description:
            '"gone" for evicted/superseded/expired/left; the failure code when reason is "failed"',
    }),
    error: z.literal('playback_session_ended'),
    reason: z.enum(['evicted', 'superseded', 'expired', 'left', 'failed']),
    status: z.literal(410),
    details: z.string().optional(),
    retryable: z.boolean().optional().meta({ description: 'Only with reason "failed"' }),
    retryAfterMs: z.number().int().nonnegative().optional(),
    feedsTried: z
        .array(LiveTvFeedTriedSchema)
        .optional()
        .meta({ description: 'Only with reason "failed", administrators only' }),
});

export type PlaybackSessionStart = z.infer<typeof PlaybackSessionStartSchema>;
export type PlaybackSessionStartResponse = z.infer<typeof PlaybackSessionStartResponseSchema>;
export type PlaybackSessionState = z.infer<typeof PlaybackSessionStateSchema>;
export type PlaybackSessionEnded = z.infer<typeof PlaybackSessionEndedSchema>;
