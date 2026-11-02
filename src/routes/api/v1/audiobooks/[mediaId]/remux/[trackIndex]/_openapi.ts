// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';

export const route: RouteMetadata = {
    GET: {
        auth: 'bearer-or-grant',
        tags: ['Audiobooks'],
        stability: 'protocol',
        summary: 'Stream one audiobook file re-encoded to AAC',
        description:
            'Follow the issued delivery URL. The Lumastra playback session must be active or paused, owned by the caller and bound to this book; the track index resolves only through its persisted server map. No ABS ids or paths are accepted. Pre-stream errors are application/problem+json. Returns binary ADTS AAC. Seek by requesting a new startPositionSeconds (file-relative seconds). Accept-Ranges: none; no Content-Length. HEAD validates the session and track without spawning an encoder.',
        params: z.object({
            mediaId: z.string().uuid().describe('Lumastra book id'),
            trackIndex: z.coerce
                .number()
                .int()
                .nonnegative()
                .describe('Index in the issued session track list'),
        }),
        query: z
            .object({
                PlaySessionId: z
                    .string()
                    .uuid()
                    .describe('Required owned Lumastra playback session'),
                startPositionSeconds: z.coerce
                    .number()
                    .min(0)
                    .max(200000)
                    .optional()
                    .describe('File-relative start offset, seconds; defaults to zero.'),
                grant: z
                    .string()
                    .optional()
                    .describe(
                        'Item/session-bound playback grant; alternatively send an account Bearer',
                    ),
            })
            .strict(),
        responses: {
            200: { binary: ['audio/aac'], description: 'Audio bytes' },
            400: 'Missing or malformed session selector, retired query, or invalid seek',
            401: 'Missing or expired credential',
            403: 'Missing media scope or AudiobookShelf account link',
            404: 'Book, owned live session or mapped track not found',
            502: 'Upstream failed or returned non-media',
            503: 'Dependency unavailable or remux concurrency cap reached',
        },
    },
};
