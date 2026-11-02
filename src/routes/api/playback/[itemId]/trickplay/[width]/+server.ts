// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withIdResolution } from '$lib/server/middleware/id-resolution.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { withMediaAccess } from '$lib/server/middleware/media-access.js';
import { withValidation } from '$lib/server/middleware/validate';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { trickplayParamsSchema } from '$lib/schemas/playback';
import { trickplayQuerySchema } from './_openapi';
import { createHash } from 'node:crypto';
import { buildTrickplayManifest } from '$lib/server/services/playback-trickplay.service.js';
import {
    matchesImageEtag,
    revisionCacheControl,
} from '$lib/server/services/playback-image-revision.js';
import { getSpriteSheet } from '$lib/server/services/trickplay-storage.service.js';
import { getJellyfinDiskSpriteSheet } from '$lib/server/tasks/builtin/native/trickplay-providers/jellyfin-disk.js';
import { bandwidthTracker } from '$lib/server/services/bandwidth-tracker.service.js';
import { resolvePlaybackSelection } from '$lib/server/database/queries/media-file-resolution.queries.js';
import { getDb } from '$lib/server/database/connection.js';

/**
 * GET /api/playback/[itemId]/trickplay/[width]
 *
 * Serves trickplay sprite sheet images from local storage.
 *
 * Query parameters:
 * - index: The tile/sprite sheet index (0-based)
 */
export const GET: RequestHandler = requireAuth(
    withIdResolution(
        withMediaAccess(
            withErrorHandler(
                withValidation(
                    async ({ validated, locals, request, url }) => {
                        const { internalId } = locals.resolvedIds ?? {};
                        if (!internalId) return ApiResponses.notFound('Item not found');
                        const { width } = validated.params as { width: number };
                        const { index, fileId: requestedFileId } = validated.query;
                        const sql = getDb();
                        const selection =
                            sql && internalId
                                ? await resolvePlaybackSelection(sql, internalId, {
                                      fileId: requestedFileId,
                                  })
                                : null;
                        const fileId = selection?.fileId ?? null;
                        const mediaFilePath =
                            selection?.files.find((file) => file.id === fileId)?.file_path ?? null;
                        if (requestedFileId && !fileId) {
                            return ApiResponses.notFound(
                                'Trickplay not available for selected version',
                            );
                        }

                        if (!sql || !fileId)
                            return ApiResponses.notFound('Trickplay not available');
                        const result = await buildTrickplayManifest(
                            sql,
                            internalId,
                            fileId,
                            width,
                            mediaFilePath,
                            url.pathname.startsWith('/api/v1/') ? 'v1' : 'internal',
                        );
                        if (
                            !result ||
                            !result.manifest.sheets.some((sheet) => sheet.index === index)
                        ) {
                            return ApiResponses.notFound('Trickplay not available');
                        }
                        const data =
                            result.source === 'local'
                                ? await getSpriteSheet(fileId, width, index, mediaFilePath).then(
                                      (buffer) =>
                                          buffer ? { buffer, contentType: 'image/webp' } : null,
                                  )
                                : await getJellyfinDiskSpriteSheet(
                                      internalId,
                                      width,
                                      index,
                                      mediaFilePath,
                                  );
                        if (data) {
                            // Strong identity includes the selected file, exact width, sheet index,
                            // stored manifest/discovery revision, and bytes of the served sheet.
                            const etag = `"${createHash('sha256').update(`${fileId}:${width}:${index}:${result.revision}:`).update(data.buffer).digest('hex')}"`;
                            const headers = {
                                ETag: etag,
                                'Cache-Control': revisionCacheControl(
                                    url.searchParams.get('rev'),
                                    result.revision,
                                ),
                                'Access-Control-Allow-Origin': '*',
                            };
                            if (matchesImageEtag(request.headers.get('if-none-match'), etag))
                                return new Response(null, { status: 304, headers });
                            bandwidthTracker.trackTrickplay(data.buffer.byteLength);
                            return new Response(new Uint8Array(data.buffer), {
                                headers: {
                                    ...headers,
                                    'Content-Type': data.contentType,
                                    'Content-Length': data.buffer.byteLength.toString(),
                                },
                            });
                        }

                        return ApiResponses.notFound(
                            'Trickplay not available for selected version',
                        );
                    },
                    {
                        params: trickplayParamsSchema,
                        query: trickplayQuerySchema,
                    },
                ),
            ),
        ),
    ),
);
