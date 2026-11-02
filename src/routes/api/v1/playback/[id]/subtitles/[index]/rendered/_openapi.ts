// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { renderedSubtitleManifestQuerySchema, renderedSubtitleManifestSchema } from '$lib/schemas/playback';

export const route: RouteMetadata = {
    GET: {
        tags: ['Playback'],
        summary: 'Get rendered bitmap subtitle manifest',
        stability: 'protocol',
        description:
            'Returns timing and positions for a bitmap subtitle track (PGS or VobSub/DVD) rendered server-side to PNG images, so a client can composite subtitles in its own overlay without carrying a subtitle decoder and without the server re-encoding the video to burn them in (`SubtitleMethod=Encode`). Path params `itemId` (media item UUID; an underlying media-file UUID is also accepted and resolved to its owning item) and `index` (the ABSOLUTE container stream index, as reported in PlaybackInfo `mediaStreams[].index` — not a 0-based subtitle ordinal); `fileId` selects the file; omitted resolves the server default file. Each rect carries a ready PNG `href`, including the selected `fileId`. Cue times are milliseconds on the player timeline (what `currentTime` reads), absolute over the whole title and never rebased per seek; they equal source media time except for containers with a non-zero `start_time`, which is removed so cues agree with a transcode starting at PTS 0. Rendering is cached; the first call for an uncached track pays a full FFmpeg pass over the source container. The manifest is revalidated via ETag (the images it references are immutable, but the manifest itself changes when the source file is replaced and re-rendered). Returns 404 when the track is not a bitmap format or yields no displayable cues.',
        query: renderedSubtitleManifestQuerySchema,
        responses: {
            200: {
                schema: renderedSubtitleManifestSchema,
                description: 'Timing and positions for the rendered subtitle track',
            },
            422: 'Missing/invalid itemId, subtitle index, or fileId',
            404: 'No renderable bitmap subtitle for this track',
            401: 'Authentication required',
            503: 'Database unavailable',
            500: 'Internal server error',
        },
    },
};
