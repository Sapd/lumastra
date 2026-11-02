// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';

export const route: RouteMetadata = {
    GET: {
        tags: ['Playback'],
        summary: 'Serve HLS segment or sub-playlist',
        stability: 'protocol',
        auth: 'bearer-or-grant',
        description:
            'Serves the playlists and segments below a video HLS manifest (opaque). ' +
            'Follow the URLs the master playlist from the play-session start gives you, with the `grant` they carry. ' +
            'The paths below `/hls/` (media and subtitle playlists, init and media segments) are an implementation detail and may change in any release; never build them. ' +
            'Returns `410 Gone` for deleted or expired segments (client must restart the stream).',
        responses: {
            200: {
                binary: [
                    'application/vnd.apple.mpegurl',
                    'video/mp4',
                    'video/iso.segment',
                    'text/vtt',
                ],
                description: 'HLS playlist or segment bytes',
            },
            400: 'Invalid path',
            401: 'Missing or invalid stream token',
            404: 'Segment file not found',
            410: 'Segment expired (transcode session ended)',
            500: 'Internal server error',
        },
    },
};
