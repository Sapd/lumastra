// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

/** Live TV keeps station/feed delivery separate from its reporting protocol. */
export const LiveTvQualitySchema = z.enum([
    'server',
    'adaptive',
    'original',
    '1080p8m',
    '720p4m',
    '540p2m',
    '360p1m',
]);
export const LiveHlsDeliverySchema = z.object({
    kind: z.literal('live-hls'),
    url: z.string().meta({
        description: 'HLS proxy URL for this channel, rewritten to the caller’s surface prefix',
    }),
    feedId: z.string().guid(),
    requestedQuality: LiveTvQualitySchema.describe(
        'Requested quality; server means the administrator default (or an explicit bitrate cap).',
    ),
    appliedQuality: z
        .enum(['original', 'adaptive', '1080p8m', '720p4m', '540p2m', '360p1m'])
        .describe('Quality actually delivered after policy and capacity decisions.'),
    sourceId: z.string().optional().meta({ description: 'Upstream source id backing the stream' }),
    requiresProxy: z
        .boolean()
        .meta({ description: 'Whether the stream must be pulled through the Live TV proxy' }),
    maxStreams: z
        .number()
        .optional()
        .meta({ description: 'Concurrent-stream limit for the channel, when enforced' }),
    rungId: z.string().nullable(),
    requestedMaxBitrateBps: z.number().nullable(),
    appliedMaxBitrateBps: z.number().nullable(),
    appliedMaxHeight: z.number().nullable(),
    reason: z
        .enum([
            'ladder_disabled',
            'source_within_cap',
            'hdr_source',
            'unprobeable',
            'capacity',
            'below_ladder',
            'insufficient_ladder',
        ])
        .nullable(),
    adaptive: z
        .object({
            rungs: z.array(
                z.object({
                    id: z.string(),
                    height: z.number(),
                    maxBitrateBps: z.number(),
                    codec: z.literal('h264'),
                }),
            ),
            includesOriginal: z.boolean(),
        })
        .optional(),
    variant: z.enum(['fmp4', 'h264']).optional().meta({
        description:
            'Set when an HEVC channel is served as a compatibility output for this player (see the `hevc` parameter)',
    }),
});

export type LiveHlsDelivery = z.infer<typeof LiveHlsDeliverySchema>;
