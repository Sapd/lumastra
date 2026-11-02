// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { z } from 'zod';

/**
 * As with the sibling `files/[trackIndex]` route, the `+server.ts` bare-re-exports its
 * handler (a `+server.ts` may export only reserved names), so the spec scanner
 * has nothing to read and the metadata has to live here.
 */
export const route: RouteMetadata = {
    GET: {
        auth: 'bearer-or-grant',
        tags: ['Audiobooks'],
        summary: 'Stream a transcoded audiobook (HLS playlist and segments)',
        stability: 'protocol',
        description:
            'Streams an audiobook HLS playlist or segment (opaque). Do not build this URL: the play-session start returns the playlist URL (`delivery.url`) and the playlists link their segments; follow them. The path components are an implementation detail and may change in any release. Authenticate with an account Bearer token or ?grant=<secret>. Every child URI carries the grant; the `playback` marker and Lumastra session id are server-issued. Raw upstream sessions are rejected. The upstream session must belong to this user and book. Seeking beyond the upstream encoder position may return 404.',
        query: z.object({ grant: z.string().optional(), PlaySessionId: z.string().uuid() }),
        responses: {
            200: {
                binary: ['application/vnd.apple.mpegurl', 'video/mp2t'],
                description:
                    'The HLS playlist (`application/vnd.apple.mpegurl`) or one media segment (`video/mp2t`).',
            },
            400: 'Missing or malformed path parameters',
            401: 'Missing, expired or invalid stream token',
            403: 'Stream token does not authorise this media item, or the session does not belong to the caller',
            404: 'Segment not yet encoded, or session/book not found',
            502: 'Upstream AudiobookShelf server unreachable or errored',
            500: 'Internal server error',
        },
    },
};
