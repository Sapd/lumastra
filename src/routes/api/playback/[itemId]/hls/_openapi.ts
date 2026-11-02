// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { z } from 'zod';

const hlsQuerySchema = z.object({
    grant: z.string().optional().meta({
        description: 'Streaming session token (media URL credential)',
    }),
    maxBitrate: z.string().optional().meta({
        description:
            'Total stream budget in bits/s (clamped 250000–200000000). The source is transcoded down when it exceeds it. Delivery URLs from POST /play-sessions already carry the cap that request was evaluated against. Repeated: the last occurrence wins.',
    }),
    maxHeight: z.string().optional().meta({
        description:
            'Output height cap in px (clamped 144–4320). Same baking and last-occurrence rule as maxBitrate.',
    }),
    maxAudioChannels: z.string().optional().meta({
        description:
            'Audio channel cap (1–8), i.e. the mc: declared in /info caps. A track with more channels is transcoded and downmixed (never above 5.1). Baked into play_methods URLs; last occurrence wins.',
    }),
    SubtitleStreamIndex: z.string().optional().meta({
        description:
            'Absolute stream index of subtitle to burn into video (requires SubtitleMethod=Encode)',
    }),
    SubtitleMethod: z.enum(['Encode', 'Hls', 'External']).optional().meta({
        description:
            'Subtitle delivery method. Encode: server-side burn-in via FFmpeg overlay. Hls: sidecar WebVTT segments. External: separate file.',
    }),
});

export const route: RouteMetadata = {
    GET: {
        tags: ['Playback'],
        summary: 'Get Lumastra HLS manifest',
        description: 'Custom HLS manifest with enhanced features (trickplay, chapters).',
        query: hlsQuerySchema,
        responses: {
            200: {
                text: 'application/vnd.apple.mpegurl',
                description: 'Lumastra HLS manifest',
            },
            404: 'Not found',
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
