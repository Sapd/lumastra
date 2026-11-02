// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';

export const route: RouteMetadata = {
    GET: {
        auth: 'bearer-or-grant',
        tags: ['Audiobooks'],
        stability: 'protocol',
        summary: 'Stream an audiobook file (direct play)',
        description:
            'Follow the issued delivery URL. The Lumastra playback session must be active or paused, owned by the caller and bound to this book; the track index resolves only through its persisted server map. No ABS ids or paths are accepted. Pre-stream errors are application/problem+json. Range and If-Range are supported; 206 preserves Content-Range, ETag and Last-Modified. HEAD returns headers without fetching a body.',
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
                grant: z
                    .string()
                    .optional()
                    .describe(
                        'Item/session-bound playback grant; alternatively send an account Bearer',
                    ),
            })
            .strict(),
        responses: {
            200: {
                binary: [
                    'audio/mpeg',
                    'audio/mp4',
                    'audio/flac',
                    'audio/ogg',
                    'application/octet-stream',
                ],
                description: 'Audio bytes',
            },
            206: {
                binary: [
                    'audio/mpeg',
                    'audio/mp4',
                    'audio/flac',
                    'audio/ogg',
                    'application/octet-stream',
                ],
                description: 'Partial file with Content-Range',
            },
            416: 'Invalid or unsatisfiable byte range; Content-Range reports the size',
            400: 'Missing or malformed session selector, retired query, or invalid seek',
            401: 'Missing or expired credential',
            403: 'Missing media scope or AudiobookShelf account link',
            404: 'Book, owned live session or mapped track not found',
            502: 'Upstream failed or returned non-media',
            503: 'Dependency unavailable or remux concurrency cap reached',
        },
    },
};
