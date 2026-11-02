// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withIdResolution } from '$lib/server/middleware/id-resolution.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { withMediaAccess } from '$lib/server/middleware/media-access.js';
import { withValidation } from '$lib/server/middleware/validate';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { trickplayParamsSchema, trickplayQuerySchema } from '$lib/schemas/playback';
import { json } from '@sveltejs/kit';
import { buildTrickplayManifest } from '$lib/server/services/playback-trickplay.service.js';
import { resolvePlaybackSelection } from '$lib/server/database/queries/media-file-resolution.queries.js';
import { getDb } from '$lib/server/database/connection.js';

/** JSON manifest for the selected file and exact requested width. */
export const GET: RequestHandler = requireAuth(
    withIdResolution(
        withMediaAccess(
            withErrorHandler(
                withValidation(
                    async ({ validated, locals, url }) => {
                        const { internalId } = locals.resolvedIds ?? {};
                        if (!internalId) return ApiResponses.notFound('Item not found');
                        const { width } = validated.params as { width: number };
                        const { fileId: requestedFileId } = validated.query as {
                            fileId?: string;
                        };
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
                            return ApiResponses.notFound('Trickplay not available');
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
                        if (result)
                            return json(result.manifest, {
                                headers: { 'Access-Control-Allow-Origin': '*' },
                            });

                        return ApiResponses.notFound('Trickplay not available');
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
