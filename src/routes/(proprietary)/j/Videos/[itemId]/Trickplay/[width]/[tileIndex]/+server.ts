// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin Compat: Trickplay Tile Delivery
 *
 * GET /Videos/{itemId}/Trickplay/{width}/{tileIndex}
 *
 * Serves locally-generated trickplay sprite sheet images.
 * Falls back to 404 when tiles are not available (clients handle gracefully).
 */

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { getDb } from '$lib/server/database/connection.js';
import { resolvePlaybackSelection } from '$lib/server/database/queries/media-file-resolution.queries.js';
import { getOwnerItemForFile } from '$lib/server/database/queries/media-files.queries.js';
import { getSpriteSheet } from '$lib/server/services/trickplay-storage.service.js';
import { getJellyfinDiskSpriteSheet } from '$lib/server/tasks/builtin/native/trickplay-providers/jellyfin-disk.js';
import { bandwidthTracker } from '$lib/server/services/bandwidth-tracker.service.js';
import {
    checkMediaAccess,
    userNeedsMediaAccessCheck,
} from '$lib/server/middleware/media-access.js';

const logger = Logger.for('JellyfinCompat:TrickplayTile');

export const GET: RequestHandler = withJellyfinAuth(
    async (event) => {
        const { params, locals } = event;
        const { itemId, width, tileIndex } = params;
        const requestedSourceId =
            event.url.searchParams.get('mediaSourceId') ??
            event.url.searchParams.get('MediaSourceId');

        if (!itemId || !width || !tileIndex) {
            return ApiResponses.badRequest('Missing required parameters');
        }

        const widthNum = parseInt(width, 10);
        const tileIndexNum = parseInt(tileIndex, 10);

        if (
            isNaN(widthNum) ||
            isNaN(tileIndexNum) ||
            tileIndexNum < 0 ||
            widthNum <= 0 ||
            widthNum > 10000 ||
            tileIndexNum > 100000
        ) {
            return ApiResponses.badRequest('Invalid width or tile index');
        }

        try {
            const sql = getDb();
            if (!sql) {
                return ApiResponses.error('Database not initialized');
            }

            // Android TV passes MediaSource.Id (media_files uuid) as itemId.
            // Resolve file → owning media item so resolvePlaybackSelection (which
            // queries by media_item_id) and the library gate both see a real
            // media_items.id. getOwnerItemForFile is cached, so repeated tile
            // requests for the same file pay a single round trip.
            const ownerItemId = await getOwnerItemForFile(sql, itemId);
            const resolvedItemId = ownerItemId ?? itemId;

            // Skip the access query entirely when the user has no restrictions
            // (admin, no library group denied, not age-restricted). This is the
            // common case on single-user installs and saves one query per tile.
            if (
                (await userNeedsMediaAccessCheck(sql, locals.user)) &&
                !(await checkMediaAccess(sql, resolvedItemId, locals.user))
            ) {
                return new Response(null, { status: 404 });
            }

            const selection = await resolvePlaybackSelection(sql, resolvedItemId, {
                fileId: requestedSourceId,
            });
            const fileId = selection.fileId;
            const mediaFilePath = selection.files[0]?.file_path ?? null;
            if (!fileId) {
                logger.debug('No trickplay source resolved for item', {
                    itemId,
                    requestedSourceId,
                });
                return new Response(null, { status: 404 });
            }

            const data = await getSpriteSheet(fileId, widthNum, tileIndexNum, mediaFilePath);

            if (!data) {
                // Fallback: try Jellyfin-format trickplay from disk
                const jellyfinTile = await getJellyfinDiskSpriteSheet(
                    resolvedItemId,
                    widthNum,
                    tileIndexNum,
                    mediaFilePath,
                );
                if (jellyfinTile) {
                    logger.debug('Serving Jellyfin disk trickplay tile (compat)', {
                        itemId,
                        width: widthNum,
                        tileIndex: tileIndexNum,
                    });
                    bandwidthTracker.trackTrickplay(jellyfinTile.buffer.byteLength);
                    return new Response(new Uint8Array(jellyfinTile.buffer), {
                        status: 200,
                        headers: {
                            'Content-Type': jellyfinTile.contentType,
                            'Cache-Control': 'public, max-age=86400',
                            'Access-Control-Allow-Origin': '*',
                        },
                    });
                }

                logger.debug('Trickplay tile not found', {
                    itemId,
                    fileId,
                    width: widthNum,
                    tileIndex: tileIndexNum,
                });
                return new Response(null, { status: 404 });
            }

            logger.debug('Serving trickplay tile', {
                itemId,
                fileId,
                width: widthNum,
                tileIndex: tileIndexNum,
                size: data.byteLength,
            });

            // Serve with image content type — Streamyfin requests .jpg but files are .webp
            // Use generic image type so browsers/players handle it correctly
            bandwidthTracker.trackTrickplay(data.byteLength);
            return new Response(new Uint8Array(data), {
                status: 200,
                headers: {
                    'Content-Type': 'image/jpeg',
                    'Cache-Control': 'public, max-age=86400',
                    'Access-Control-Allow-Origin': '*',
                },
            });
        } catch (error) {
            logger.error('Failed to serve trickplay tile', error as Error, {
                itemId,
                width: widthNum,
                tileIndex: tileIndexNum,
            });
            return ApiResponses.error('Failed to serve trickplay tile');
        }
    },
    { pat: 'deny' },
);
