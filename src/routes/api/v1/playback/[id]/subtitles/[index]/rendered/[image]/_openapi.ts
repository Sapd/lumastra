// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { renderedSubtitleQuerySchema } from '$lib/schemas/playback';

export const route: RouteMetadata = {
    GET: {
        tags: ['Playback'],
        summary: 'Get rendered bitmap subtitle image',
        stability: 'protocol',
        description:
            'Serves one PNG referenced by a rect in the `/subtitles/{index}/rendered` manifest. `index` is the ABSOLUTE container stream index, as reported in PlaybackInfo `mediaStreams[].index` — not a 0-based subtitle ordinal. The manifest rect `href` points directly to this PNG. Path param `image` is its content-addressed identity, with an optional `.png` suffix; `fileId` is required and must match the manifest request. Images are served individually rather than as a sprite sheet because a feature film totals roughly 75 megapixels of cues — as one sheet that is ~1920x39000 and costs a client ~300 MB decoded, and would force the entire film to be fetched before the first cue could draw. Binary streaming surface — shape is dictated by the subtitle/playback client protocol, not a general JSON contract.',
        query: renderedSubtitleQuerySchema,
        responses: {
            200: {
                binary: ['image/png'],
                description: 'PNG image for one subtitle rect',
            },
            422: 'Missing/invalid itemId, subtitle index, image id, or fileId',
            404: 'Unknown image id, or no renderable bitmap subtitle for this track',
            401: 'Authentication required',
            503: 'Database unavailable',
            500: 'Internal server error',
        },
    },
};
