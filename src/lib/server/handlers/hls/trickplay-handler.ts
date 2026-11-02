// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * HLS Trickplay Handler
 *
 * Handles trickplay image playlist requests for HLS streams.
 * Generates HLS image playlist with #EXT-X-IMAGES-ONLY for tvOS scrubbing.
 *
 * Route: trickplay.m3u8
 */

import { Logger } from '$lib/server/utils/logger.js';
import { createImagePlaylistHeader, HLS_CONTENT_TYPE } from '$lib/server/utils/hls-definitions.js';
import {
    parseTrickplayParams,
    extractAuthParams,
    addAuthToSearchParams,
} from '$lib/server/utils/hls-request-utils.js';
import { base } from '$app/paths';

const logger = Logger.for('HLSTrickplayHandler');

/** CORS headers */
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
} as const;

// ============================================================================
// HANDLERS
// ============================================================================

/**
 * Handle trickplay image playlist request (trickplay.m3u8).
 *
 * Generates HLS image playlist that references trickplay sprite sheet tiles
 * served by the existing /api/v1/playback/[itemId]/trickplay endpoint.
 *
 * @param itemId - Jellyfin item ID
 * @param url - Request URL with trickplay parameters
 * @returns Response with HLS image playlist
 */
export async function handleTrickplayPlaylist(itemId: string, url: URL): Promise<Response> {
    // Parse trickplay parameters
    const trickplayParams = parseTrickplayParams(url);

    if (!trickplayParams) {
        logger.error('Missing trickplay parameters for trickplay.m3u8', undefined, {
            itemId,
            width: url.searchParams.get('trickplay_width'),
            interval: url.searchParams.get('trickplay_interval'),
            count: url.searchParams.get('trickplay_count'),
        });
        return new Response('Missing trickplay parameters', {
            status: 400,
            headers: CORS_HEADERS,
        });
    }

    const {
        width,
        height: trickplayHeight,
        interval: intervalMs,
        count: thumbnailCount,
        tileWidth,
        tileHeight,
        fileId,
    } = trickplayParams;

    // Guard against invalid tile dimensions or interval
    if (tileWidth <= 0 || tileHeight <= 0 || intervalMs <= 0 || thumbnailCount <= 0) {
        return new Response('Invalid trickplay parameters', {
            status: 400,
            headers: CORS_HEADERS,
        });
    }

    // Calculate sprite sheet layout
    const tilesPerSheet = tileWidth * tileHeight;
    const totalSheets = Math.ceil(thumbnailCount / tilesPerSheet);

    // Duration per thumbnail in seconds
    const thumbnailDurationSec = intervalMs / 1000;

    // Duration covered by each sprite sheet
    const sheetDurationSec = tilesPerSheet * thumbnailDurationSec;

    // Build auth params (added per-tile below via URLSearchParams, which
    // percent-encodes every value — a raw template here would let a
    // CRLF-bearing fileId/grant split the playlist line it's built into)
    const auth = extractAuthParams(url);

    // Generate HLS Image playlist using centralized builder
    const builder = createImagePlaylistHeader(sheetDurationSec);

    // Generate entries for each sprite sheet tile
    for (let sheetIndex = 0; sheetIndex < totalSheets; sheetIndex++) {
        // Calculate how many thumbnails are in this sheet (last sheet may be partial)
        const remainingThumbnails = thumbnailCount - sheetIndex * tilesPerSheet;
        const thumbnailsInSheet = Math.min(tilesPerSheet, remainingThumbnails);
        const sheetDuration = thumbnailsInSheet * thumbnailDurationSec;

        // Build tile URL - uses existing trickplay endpoint. URLSearchParams
        // percent-encodes every value, so a fileId/grant containing
        // CR/LF cannot split this into extra playlist lines.
        const tileParams = new URLSearchParams();
        tileParams.set('index', String(sheetIndex));
        addAuthToSearchParams(tileParams, auth);
        if (fileId) tileParams.set('fileId', fileId);

        // Use base path for tile URL
        const tileUri = `${base}/api/v1/playback/${itemId}/trickplay/${width}?${tileParams.toString()}`;

        // #EXT-X-TILES for sprite sheet layout
        const height = trickplayHeight > 0 ? trickplayHeight : Math.floor((width * 9) / 16);
        const resolution = `${width}x${height}`;
        const layout = `${tileWidth}x${tileHeight}`;
        builder.tiles(resolution, layout, thumbnailDurationSec);
        builder.segment(sheetDuration, tileUri);
    }

    builder.endlist();

    logger.info('Serving trickplay HLS image playlist', {
        itemId,
        width,
        thumbnailCount,
        totalSheets,
        intervalMs,
    });

    return new Response(builder.build(), {
        status: 200,
        headers: {
            'Content-Type': HLS_CONTENT_TYPE.PLAYLIST,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'max-age=3600',
        },
    });
}
