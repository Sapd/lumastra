// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { z } from 'zod';

const hlsQuerySchema = z.object({
    grant: z.string().optional().meta({
        description: 'Streaming session token (media URL credential)',
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
        stability: 'protocol',
        visibility: 'internal',
        summary: 'Get HLS manifest with cache-busting nonce',
        description:
            'AVFoundation-compatible HLS endpoint with a unique cacheNonce in the path to invalidate connection pool caches on seek. This is a cache-busting nonce, ignored for authentication.',
        query: hlsQuerySchema,
        responses: {
            200: {
                text: 'application/vnd.apple.mpegurl',
                description: 'HLS master playlist (M3U8)',
            },
            404: 'Not found',
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
