// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin-compat HLS Segment Serving Endpoint
 *
 * Serves FFmpeg-generated HLS segments and sub-playlists for Jellyfin clients.
 * Delegates all logic to the shared handler in hls-lumastra-segment-handler.ts.
 *
 * Auth: GET is wrapped in withJellyfinAuth (header or api_key query param, just
 * like master.m3u8 which propagates api_key into segment URLs), and the
 * authenticated username is passed to handleHlsSegment so play-session
 * ownership is verified. OPTIONS stays unauthenticated for CORS preflight.
 *
 * Routes:
 * - /Videos/{itemId}/hls/stream_0/index.m3u8
 * - /Videos/{itemId}/hls/stream_0/init_0.mp4
 * - /Videos/{itemId}/hls/stream_0/segment_00000.m4s
 * - /Videos/{itemId}/hls/subs_0/index.m3u8
 * - /Videos/{itemId}/hls/subs_0/seg_00000.vtt
 * - Jellyfin's legacy /Videos/{itemId}/hls/{playlistId}/stream.m3u8 and
 *   /Videos/{itemId}/hls/{playlistId}/{segmentId}.{ext}, rewritten onto the
 *   above by aliasJellyfinHlsPath (hls-path-alias.ts)
 *
 * Query parameters:
 * - PlaySessionId: Required - identifies the transcode job (Jellyfin's
 *   camelCase `playSessionId` is accepted too)
 */

import type { RequestHandler } from './$types';
import { handleHlsOptions } from '$lib/server/handlers/hls/lumastra-segment-handler.js';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { serveJellyfinHlsSegment } from '$lib/server/proprietary/jellyfin-compat/hls-segment-route';
import {
    aliasJellyfinHlsPath,
    normalizePlaySessionIdParam,
} from '$lib/server/proprietary/jellyfin-compat/hls-path-alias';

// Access re-check, silent-start disarm and the shared segment handler live in
// jellyfin-compat/hls-segment-route.ts (also behind /Audio/{itemId}/hls1/...).
export const GET: RequestHandler = withJellyfinAuth(
    (event) => {
        // Jellyfin's URLs carry camelCase `playSessionId`; its legacy
        // hls/{playlistId}/… names are rewritten onto our segment files here,
        // not inside serveJellyfinHlsSegment (the Audio hls1 route passes its
        // own names through it unchanged).
        normalizePlaySessionIdParam(event.url);
        const path = event.params.path;
        return serveJellyfinHlsSegment(
            event,
            event.params.itemId,
            path?.trim() ? aliasJellyfinHlsPath(path) : path,
        );
    },
    { pat: 'deny' },
);

/**
 * OPTIONS for CORS preflight
 */
export const OPTIONS: RequestHandler = async () => {
    return handleHlsOptions();
};
