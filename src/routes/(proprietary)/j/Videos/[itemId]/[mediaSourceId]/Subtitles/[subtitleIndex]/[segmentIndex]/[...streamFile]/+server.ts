// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin Compat: Subtitle Delivery
 *
 * GET /Videos/{itemId}/{mediaSourceId}/Subtitles/{subtitleIndex}/{startPositionTicks}/Stream.{format}
 *
 * Jellyfin's `GetSubtitleWithTicks`. The second-to-last segment is the start
 * position in ticks (PlaybackInfo's DeliveryUrls use 0). Serves both external
 * and embedded subtitles via the unified SubtitleResolverService — see
 * subtitle-stream.ts for the shared handler and its query params.
 */

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { serveSubtitleStream } from '$lib/server/proprietary/jellyfin-compat/subtitle-stream';

export const GET: RequestHandler = withJellyfinAuth(async (event) => {
    const { params } = event;
    return serveSubtitleStream(event, {
        itemId: params.itemId,
        mediaSourceId: params.mediaSourceId,
        index: params.subtitleIndex,
        streamFile: params.streamFile,
        routeStartTicks: params.segmentIndex,
    });
});
