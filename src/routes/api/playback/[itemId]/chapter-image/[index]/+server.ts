// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/playback/[itemId]/chapter-image/[index]
 *
 * Serves a per-chapter thumbnail cropped from the item's trickplay sprite
 * sheet. 404s when trickplay is unavailable or the chapter falls past the
 * generated thumbnails (clients render a title-only chapter marker).
 */

import { surfaceOfRequest } from '$lib/shared/api-urls.js';
import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withIdResolution } from '$lib/server/middleware/id-resolution.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { withMediaAccess } from '$lib/server/middleware/media-access.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getDb } from '$lib/server/database/connection.js';
import { resolvePlaybackSelection } from '$lib/server/database/queries/media-file-resolution.queries.js';
import { resolveEffectiveChapters } from '$lib/server/services/playback-chapters.service.js';
import {
    buildTrickplayManifest,
    manifestTileParams,
} from '$lib/server/services/playback-trickplay.service.js';
import { getJellyfinDiskSpriteSheet } from '$lib/server/tasks/builtin/native/trickplay-providers/jellyfin-disk.js';
import { getTrickplayParams } from '$lib/server/database/queries/trickplay-params.queries.js';
import {
    computeChapterImageRevision,
    matchesImageEtag,
    revisionCacheControl,
} from '$lib/server/services/playback-image-revision.js';
import { getSpriteSheet } from '$lib/server/services/trickplay-storage.service.js';
import {
    computeNearestChapterTiles,
    pickBestTrickplayParams,
    cropChapterTile,
} from '$lib/server/utils/chapter-thumbnail.js';

const logger = Logger.for('PlaybackChapterImage');

export const GET: RequestHandler = requireAuth(
    withIdResolution(
        withMediaAccess(
            withErrorHandler(async ({ params, locals, request, url }) => {
                const { internalId } = locals.resolvedIds ?? {};
                if (!internalId) return ApiResponses.notFound('Item not found');

                const chapterIndex = Number.parseInt(params.index ?? '', 10);
                if (Number.isNaN(chapterIndex) || chapterIndex < 0 || chapterIndex > 100000) {
                    return ApiResponses.badRequest('Invalid chapter index');
                }

                const sql = getDb();
                if (!sql) return ApiResponses.error('Database not initialized');

                const requestedFileId = url.searchParams.get('fileId');
                const selection = await resolvePlaybackSelection(sql, internalId, {
                    fileId: requestedFileId,
                });
                const fileId = selection.fileId;
                const mediaFilePath =
                    selection.files.find((f) => f.id === fileId)?.file_path ?? null;
                if (!fileId) return new Response(null, { status: 404 });

                const selectedFile = selection.files.find((file) => file.id === fileId);
                if (!selectedFile) return new Response(null, { status: 404 });
                const chapters = await resolveEffectiveChapters(sql, internalId, selectedFile);
                const chapter = chapters.find((c) => c.chapter_index === chapterIndex);
                if (!chapter) return new Response(null, { status: 404 });

                const trickplayParams = await getTrickplayParams(sql, internalId, fileId);
                const manifests = (
                    await Promise.all(
                        trickplayParams.map((param) =>
                            buildTrickplayManifest(
                                sql,
                                internalId,
                                fileId,
                                param.width,
                                mediaFilePath,
                                surfaceOfRequest(url),
                            ),
                        ),
                    )
                ).filter((result) => result !== null);
                const best = pickBestTrickplayParams(
                    manifests.map((result) => manifestTileParams(result.manifest)),
                );
                if (!best) return new Response(null, { status: 404 });

                const serving = manifests.find((result) => result.manifest.width === best.width);
                if (!serving) return new Response(null, { status: 404 });
                const locations = computeNearestChapterTiles(
                    Number(chapter.start_ticks),
                    best,
                ).filter((tile) =>
                    serving.manifest.sheets.some((sheet) => sheet.index === tile.sheetIndex),
                );
                if (locations.length === 0) return new Response(null, { status: 404 });

                const revision = computeChapterImageRevision(
                    fileId,
                    Number(chapter.start_ticks),
                    best.width,
                    serving.revision,
                );
                if (!revision) return new Response(null, { status: 404 });
                const etag = `"${revision}"`;
                const cacheControl = revisionCacheControl(url.searchParams.get('rev'), revision);
                if (matchesImageEtag(request.headers.get('if-none-match'), etag)) {
                    return new Response(null, {
                        status: 304,
                        headers: { ETag: etag, 'Cache-Control': cacheControl },
                    });
                }

                for (const loc of locations) {
                    const sheet =
                        serving.source === 'local'
                            ? await getSpriteSheet(
                                  fileId,
                                  best.width,
                                  loc.sheetIndex,
                                  mediaFilePath,
                              )
                            : (
                                  await getJellyfinDiskSpriteSheet(
                                      internalId,
                                      best.width,
                                      loc.sheetIndex,
                                      mediaFilePath,
                                  )
                              )?.buffer;
                    if (!sheet) continue;
                    try {
                        const tile = await cropChapterTile(sheet, loc, best);
                        return new Response(new Uint8Array(tile), {
                            status: 200,
                            headers: {
                                'Content-Type': 'image/webp',
                                'Cache-Control': cacheControl,
                                'Access-Control-Allow-Origin': '*',
                                ETag: etag,
                            },
                        });
                    } catch (error) {
                        logger.warn('Failed to crop chapter tile', {
                            itemId: internalId,
                            chapterIndex,
                            sheetIndex: loc.sheetIndex,
                            error: (error as Error).message,
                        });
                    }
                }
                return new Response(null, { status: 404 });
            }),
        ),
    ),
);
