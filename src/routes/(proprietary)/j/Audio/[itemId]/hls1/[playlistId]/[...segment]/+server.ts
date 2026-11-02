// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// GET /Audio/{itemId}/hls1/{playlistId}/{segmentId}.{container} — audio HLS
// segments, the URIs main.m3u8 lists. Served by the same segment handler as
// /Videos/{itemId}/hls/ (jellyfin-compat/hls-segment-route.ts); the playlistId
// segment only namespaces the URL, the job is found by PlaySessionId.

import type { RequestHandler } from './$types';
import { handleHlsOptions } from '$lib/server/handlers/hls/lumastra-segment-handler.js';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { serveJellyfinHlsSegment } from '$lib/server/proprietary/jellyfin-compat/hls-segment-route';

export const GET: RequestHandler = withJellyfinAuth(
    (event) => serveJellyfinHlsSegment(event, event.params.itemId, event.params.segment),
    { pat: 'deny' },
);

export const OPTIONS: RequestHandler = async () => handleHlsOptions();
