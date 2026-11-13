// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /Videos/{itemId}/hls1/{playlistId}/{segmentId}.{container} — Jellyfin's
 * `GetHlsVideoSegment`, the segment URIs of its main.m3u8.
 *
 * Served like the /j HLS segment route (serveJellyfinHlsSegment) with the segment id
 * rewritten to our file name (`{N}.ts` → `segment_0000N.ts`, `-1.mp4` → the
 * init segment); the job is the `PlaySessionId` query param, as on every other
 * segment URL. Auth, the per-segment access re-check, play-session ownership,
 * job→item binding and the silent-start disarm are that route's. Jellyfin's
 * transcode-shaping query params (runtimeTicks, actualSegmentLengthTicks, codecs)
 * are not needed: the job was configured when its playlist was requested.
 */

import type { RequestHandler } from './$types';
import {
    hls1SegmentPath,
    normalizePlaySessionIdParam,
} from '$lib/server/proprietary/jellyfin-compat/hls-path-alias';
import { handleHlsOptions } from '$lib/server/handlers/hls/lumastra-segment-handler.js';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { serveJellyfinHlsSegment } from '$lib/server/proprietary/jellyfin-compat/hls-segment-route';

export const GET: RequestHandler = withJellyfinAuth(
    (event) => {
        const path = hls1SegmentPath(event.params.segment ?? '');
        if (!path) return new Response('Invalid segment', { status: 400 });
        normalizePlaySessionIdParam(event.url);
        return serveJellyfinHlsSegment(event, event.params.itemId, path);
    },
    { pat: 'deny' },
);

export const OPTIONS: RequestHandler = async () => handleHlsOptions();
