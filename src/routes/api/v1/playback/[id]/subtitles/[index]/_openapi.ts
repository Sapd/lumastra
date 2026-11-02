// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { subtitleQuerySchema } from '$lib/schemas/playback';

export const route: RouteMetadata = {
    GET: {
        tags: ['Playback'],
        summary: 'Get subtitle track',
        stability: 'protocol',
        description:
            'Returns subtitle content for an item track by index. Path params `itemId` (media item UUID; an underlying media-file UUID is also accepted and resolved to its owning item) and `index` (absolute container stream index; external sidecars use 1000 + position within the selected file). `fileId` selects the file; omitted resolves the server default file. Text formats (`vtt`, `srt`, `ass`) are extracted/converted from the local file; binary bitmap formats (`pgssub`, `sub`) are returned as `application/octet-stream`. An explicit `format` the track cannot carry (a text format for a bitmap track, `pgssub`/`sub` for a text track) answers 422; without `format` the track is served in its own format. The `Content-Type` reflects the resolved format. CORS-enabled (`Access-Control-Allow-Origin: *`); responses are cached for 24h. Binary streaming surface — shape is dictated by the subtitle/playback client protocol, not a general JSON contract.',
        query: subtitleQuerySchema,
        responses: {
            200: {
                binary: ['text/vtt', 'text/srt', 'text/x-ssa', 'application/octet-stream'],
                description:
                    'Subtitle track in the requested format (VTT, SRT, ASS, or PGS/VobSub binary as application/octet-stream)',
            },
            400: 'Missing/invalid itemId or subtitle index',
            404: 'Subtitle not available',
            422: 'Requested format does not fit the track (text vs bitmap)',
            401: 'Authentication required',
            503: 'Database unavailable',
            500: 'Internal server error',
        },
    },
};
