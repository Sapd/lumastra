// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';

export const route: RouteMetadata = {
    GET: {
        tags: ['Playback'],
        summary: 'Get HLS manifest',
        stability: 'protocol',
        description:
            'The HLS master playlist of a video playback session. Do not build this URL: a play-session start returns it as `delivery.url`, already carrying `?grant=`. Fetch it and follow the URLs inside the playlists.',
        auth: 'bearer-or-grant',
        query: z.object({
            grant: z.string().optional().meta({
                description: 'Streaming session token (URL auth for AVPlayer)',
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
        }),
        responses: {
            200: {
                binary: ['application/vnd.apple.mpegurl'],
                description: 'Streaming response',
            },
            401: 'Authentication required',
            404: 'Not found',
            500: 'Internal server error',
        },
    },
};
