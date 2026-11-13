// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /Videos/{itemId}/{mediaSourceId}/Subtitles/{subtitleIndex}/subtitles.m3u8?segmentLength=N
 *
 * Jellyfin's `GetSubtitlePlaylist`: an HLS subtitle playlist of windowed
 * `Stream.vtt` segments (subtitle-stream.ts). The segment URIs carry the
 * caller's session token as api_key, so a PAT (not replayable) is refused like
 * on the other stream routes.
 */

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { serveSubtitlePlaylist } from '$lib/server/proprietary/jellyfin-compat/subtitle-stream';

export const GET: RequestHandler = withJellyfinAuth(
    async (event) => {
        const { params } = event;
        return serveSubtitlePlaylist(event, {
            itemId: params.itemId,
            mediaSourceId: params.mediaSourceId,
            index: params.subtitleIndex,
        });
    },
    { pat: 'deny' },
);
