// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/playback/{id}/hls/{...path}
 *
 * Serves FFmpeg-generated HLS segments and sub-playlists from the transcode output directory.
 * Delegates all logic to the shared handler in lumastra-segment-handler.ts.
 *
 * Segments:
 * - /stream_0/index.m3u8         — audio track 0 media playlist
 * - /stream_0/init_0.mp4         — audio track 0 init segment
 * - /stream_0/segment_00000.m4s  — audio track 0 media segments
 * - /stream_N/...                — video stream (last stream index)
 * - /subs_0/index.m3u8           — subtitle track 0 playlist
 * - /subs_0/seg_00000.vtt        — subtitle segment
 *
 * Returns 410 Gone for deleted/expired segments (client must restart stream).
 */

import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { withIdResolution } from '$lib/server/middleware/id-resolution.js';
import { withMediaAccess } from '$lib/server/middleware/media-access.js';
import {
    handleHlsSegment,
    handleHlsOptions,
} from '$lib/server/handlers/hls/lumastra-segment-handler.js';
import { base } from '$app/paths';

export const GET: RequestHandler = requireAuth(
    withIdResolution(
        withMediaAccess(
            withErrorHandler(async ({ params, url, request, locals }) => {
                // The media id param is `id` on /api/v1/playback/{id}/... and `itemId`
                // on the re-exported /api/playback/{itemId}/... forward-auth mirror.
                const itemId = params.id ?? (params as Record<string, string | undefined>).itemId;
                if (!itemId || !params.path) {
                    return new Response('Missing id or path', { status: 400 });
                }

                return handleHlsSegment({
                    itemId,
                    segmentPath: params.path,
                    url,
                    request,
                    basePath: base,
                    username: locals.user?.username,
                    internalId: locals.resolvedIds?.internalId ?? undefined,
                    mount: 'api',
                });
            }),
        ),
    ),
);

export const OPTIONS: RequestHandler = async () => {
    return handleHlsOptions();
};
