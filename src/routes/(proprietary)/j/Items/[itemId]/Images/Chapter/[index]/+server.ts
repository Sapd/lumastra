// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// authz: Jellyfin session (withJellyfinAuth) — a chapter image is a frame cut from the
// user's own video file, so it is not public like poster art. Returns 404 (not a
// placeholder) when no trickplay-derived tile exists, matching how clients treat a
// missing chapter image. reroute-pathname.ts must keep `Images/Chapter/{n}` on this
// route: stripping the index sent it to the public [imageType] handler.

/**
 * Jellyfin Compat: Chapter Image
 *
 * GET /Items/{itemId}/Images/Chapter/{index}
 *
 * Serves a per-chapter thumbnail cropped from the item's trickplay sprite
 * sheet. 404s (client shows a title-only chapter marker) when the item has no
 * trickplay data or the chapter falls past the generated thumbnails.
 */

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { getDb } from '$lib/server/database/connection.js';
import { config } from '$lib/server/config.js';
import { resolvePlaybackSelection } from '$lib/server/database/queries/media-file-resolution.queries.js';
import { getOwnerItemForFile } from '$lib/server/database/queries/media-files.queries.js';
import { getChaptersForItem } from '$lib/server/database/queries/jellyfin-item-detail.queries.js';
import { getTrickplayParams } from '$lib/server/database/queries/trickplay-params.queries.js';
import { getSpriteSheet } from '$lib/server/services/trickplay-storage.service.js';
import {
    computeNearestChapterTiles,
    pickBestTrickplayParams,
    cropChapterTile,
} from '$lib/server/utils/chapter-thumbnail.js';
import {
    checkMediaAccess,
    userNeedsMediaAccessCheck,
} from '$lib/server/middleware/media-access.js';

const logger = Logger.for('JellyfinCompat:ChapterImage');

export const GET: RequestHandler = withJellyfinAuth(
    async (event) => {
        const { params, locals, request } = event;
        const { itemId, index } = params;
        if (!itemId || index === undefined) {
            return ApiResponses.badRequest('Missing required parameters');
        }
        const chapterIndex = Number.parseInt(index, 10);
        if (Number.isNaN(chapterIndex) || chapterIndex < 0 || chapterIndex > 100000) {
            return ApiResponses.badRequest('Invalid chapter index');
        }

        if (!config.TRICKPLAY_SERVE_LOCAL) return new Response(null, { status: 404 });

        const sql = getDb();
        if (!sql) return ApiResponses.error('Database not initialized');

        // Android TV passes a media_files uuid as itemId; resolve to owner item.
        const ownerItemId = await getOwnerItemForFile(sql, itemId);
        const resolvedItemId = ownerItemId ?? itemId;

        // Library/age gate (skipped for unrestricted users — the common case).
        if (
            (await userNeedsMediaAccessCheck(sql, locals.user)) &&
            !(await checkMediaAccess(sql, resolvedItemId, locals.user))
        ) {
            return new Response(null, { status: 404 });
        }

        const chapters = await getChaptersForItem(sql, resolvedItemId);
        const chapter = chapters[chapterIndex];
        if (!chapter) return new Response(null, { status: 404 });

        const selection = await resolvePlaybackSelection(sql, resolvedItemId, {});
        const fileId = selection.fileId;
        const mediaFilePath = selection.files.find((f) => f.id === fileId)?.file_path ?? null;
        if (!fileId) return new Response(null, { status: 404 });

        const best = pickBestTrickplayParams(await getTrickplayParams(sql, resolvedItemId, fileId));
        if (!best) return new Response(null, { status: 404 });

        const locations = computeNearestChapterTiles(Number(chapter.start_ticks), best);
        if (locations.length === 0) return new Response(null, { status: 404 });

        // Underlying sprite data only changes on re-scan; safe to cache hard.
        const etag = `"chap-${resolvedItemId.replace(/-/g, '').slice(0, 16)}-${chapterIndex}"`;
        if (request.headers.get('if-none-match') === etag) {
            return new Response(null, {
                status: 304,
                headers: { ETag: etag, 'Cache-Control': 'public, max-age=86400' },
            });
        }

        for (const loc of locations) {
            const sheet = await getSpriteSheet(fileId, best.width, loc.sheetIndex, mediaFilePath);
            if (!sheet) continue;
            try {
                const tile = await cropChapterTile(sheet, loc, best);
                return new Response(new Uint8Array(tile), {
                    status: 200,
                    headers: {
                        'Content-Type': 'image/webp',
                        'Cache-Control': 'public, max-age=86400',
                        'Access-Control-Allow-Origin': '*',
                        ETag: etag,
                    },
                });
            } catch (error) {
                logger.warn('Failed to crop chapter tile', {
                    itemId: resolvedItemId,
                    chapterIndex,
                    sheetIndex: loc.sheetIndex,
                    error: (error as Error).message,
                });
            }
        }
        return new Response(null, { status: 404 });
    },
    { pat: 'deny' },
);
