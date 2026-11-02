// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';

export const route: RouteMetadata = {
    GET: {
        tags: ['Music'],
        summary: 'Stream a shuffled track from a sonic mix',
        stability: 'beta',
        description:
            'Returns track `i` of the cluster `id` (from `GET /api/v1/music/sonic-mixes`) shuffled by `seed`, ' +
            'as the MP3 itself — no JSON. Stateless: the same `seed` and `i` give the same track until the ' +
            'cluster or your library access changes; skip is `i+1`, a new `seed` is a new order, and `i` ' +
            'wraps modulo the track count. The audio is ALWAYS re-encoded to MP3, 44.1 kHz, stereo, with no ' +
            'ID3 tag or cover art (unlike `music/tracks/{id}/stream?format=mp3`, which serves an MP3 source ' +
            'untouched). Track metadata is in the response headers: `X-Track-Id`, `X-Artist` and `X-Title` ' +
            '(percent-encoded UTF-8), `X-Track-Index` (the position actually served, `i mod count`) and ' +
            '`X-Track-Count`. `HEAD` returns the same headers without encoding anything. A cached encode ' +
            'carries Content-Length; a live one has none, so send an HTTP/1.0 request if your client cannot ' +
            'read chunked transfer encoding. Cluster ids are stable across re-clustering; an id that no ' +
            'longer exists is a 404. Requires the musicClusters feature.',
        auth: 'bearer',
        params: z.object({
            id: z.coerce
                .number()
                .int()
                .min(0)
                .meta({ description: 'Cluster id from `music/sonic-mixes`.' }),
        }),
        query: z.object({
            seed: z.coerce.number().int().min(0).max(4_294_967_295).meta({
                description: 'Shuffle seed (unsigned 32-bit). A new seed gives a new order.',
            }),
            i: z.coerce.number().int().min(0).max(2_147_483_647).meta({
                description:
                    'Position in the shuffled order, 0-based. Wraps modulo the track count.',
            }),
            bitrateKbps: z.coerce.number().int().optional().meta({
                description:
                    'MP3 bitrate in kbps, snapped down to 64, 96, 128, 160, 192, 256 or 320. Default 128.',
            }),
        }),
        responses: {
            200: {
                binary: ['audio/mpeg'],
                description:
                    'MP3, 44.1 kHz stereo, no ID3. Metadata in X-Track-* / X-Artist / X-Title headers.',
            },
            422: 'Invalid cluster id, seed or i',
            401: 'Authentication required',
            404: 'Cluster not found, retired, or no tracks visible to the caller; or musicClusters is off',
            503: 'Transcoding disabled or server busy — retry after Retry-After seconds',
        },
    },
};
