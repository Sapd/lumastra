// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /Videos/{itemId}/{mediaSourceId}/Subtitles/{subtitleIndex}/Stream.{format}
 *
 * Jellyfin's `GetSubtitle`: the ticks-less form. The start position comes from
 * the `StartPositionTicks` query param (default 0). Shared handler and query
 * params: subtitle-stream.ts.
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
        streamFile: `Stream.${params.format}`,
    });
});
