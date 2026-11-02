// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/images/index.ts
 *
 * GET    /api/admin/media/[id]/images  — list artwork with inheritance
 * POST   /api/admin/media/[id]/images  — upload custom artwork (file or URL)
 * DELETE /api/admin/media/[id]/images?type=poster — delete custom artwork
 *
 * Auth: admin.  Surface: internal-only.
 *
 * GET response: artwork[] with optional discogsUrl (exact catalogue page of the artwork owner)
 * POST response: { filePath: string, serveUrl: string }
 * DELETE response: { deleted: boolean }
 * 503 dependency_unavailable when DB is down.
 */

import { projectDiscogsAttribution } from '$lib/shared/music-provenance';
import { getMediaItemById } from '$lib/server/database/queries/admin-media.queries.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, isDependencyUnavailable } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { config } from '$lib/server/config.js';
import {
    storeMediaImage,
    deleteMediaImage,
} from '$lib/server/services/media-image-storage.service.js';
import { ImageUploadUrlSchema } from '$lib/schemas/media-image-upload.js';
import type { ArtworkType } from '$lib/server/utils/media-extras.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { getArtworkWithInheritance } from '$lib/server/database/queries/media-artwork.queries.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('AdminMediaImages');

const VALID_ARTWORK_TYPES = new Set<ArtworkType>(['poster', 'backdrop', 'logo', 'thumb']);
function isValidArtworkType(value: string | null): value is ArtworkType {
    return value !== null && VALID_ARTWORK_TYPES.has(value as ArtworkType);
}

/**
 * Turn a storage failure into a readable problem response.
 *
 * Everything reachable here is an operator-facing storage condition — an
 * unwritable library mount under a strict METADATA_STORAGE_LOCATION, a
 * rejected upstream URL, a disk error. These used to escape the handler and
 * surface as a bare 500 with the cause visible only in the server log, which
 * is what made a failed artist upload impossible to diagnose from the UI.
 *
 * Catching them here bypasses the mount layer's error logging, so log the
 * full error (stack included) before returning. The message is echoed to the
 * caller because this surface is admin-only and already returns the resolved
 * absolute `filePath` on success — but only for genuine storage errors, not
 * for infrastructure failures, whose text can carry driver internals.
 */
function imageStorageProblem(mediaItemId: string, err: unknown): Response {
    logger.error('Failed to store admin artwork', {
        mediaItemId,
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });

    if (isDependencyUnavailable(err)) {
        return ApiProblem.dependencyUnavailable();
    }

    const message = err instanceof Error ? err.message : String(err);
    return ApiProblem.internalError(`Could not store image: ${message}`);
}

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

export const ImageUploadResponseSchema = z.object({
    filePath: z.string(),
    serveUrl: z.string(),
    undoId: z.uuid().optional(),
});

export const ImageDeleteResponseSchema = z.object({
    deleted: z.boolean(),
});

export type ImageUploadResponse = z.infer<typeof ImageUploadResponseSchema>;
export type ImageDeleteResponse = z.infer<typeof ImageDeleteResponseSchema>;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            // Guard non-UUID ids (e.g. an unresolved composite key) — the query
            // hits a uuid column, so a bad value would 22P02 → 500 instead of 404.
            if (!internalId || !isUuid(internalId)) return ApiProblem.notFound('Media item');

            const items = await getArtworkWithInheritance(sql, internalId);
            const owners = new Map(
                await Promise.all(
                    [...new Set(items.map((item) => item.sourceId))].map(
                        async (id) => [id, await getMediaItemById(sql, id)] as const,
                    ),
                ),
            );
            return json(
                items.map((item) => {
                    const owner = owners.get(item.sourceId);
                    const attribution =
                        owner && (owner.media_type === 'artist' || owner.media_type === 'album')
                            ? projectDiscogsAttribution(
                                  owner.custom_metadata,
                                  owner.media_type === 'artist'
                                      ? 'artist_enrichment'
                                      : 'album_enrichment',
                                  {
                                      poster: owner.custom_poster_url,
                                      backdrop: owner.custom_backdrop_url,
                                      logo: owner.custom_logo_url,
                                  },
                              )
                            : undefined;
                    return { ...item, discogsUrl: attribution?.[item.artworkType] };
                }),
            );
        },

        POST: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            // Guard non-UUID ids (e.g. an unresolved composite key) — the query
            // hits a uuid column, so a bad value would 22P02 → 500 instead of 404.
            if (!internalId || !isUuid(internalId)) return ApiProblem.notFound('Media item');

            const username = event.locals.user?.username;
            if (!username) return ApiProblem.unauthorized();

            const contentType = event.request.headers.get('content-type') ?? '';

            // CSRF guard for multipart (same as original route)
            if (contentType.includes('multipart/form-data')) {
                const origin = event.request.headers.get('origin');
                const referer = event.request.headers.get('referer');
                let sourceHost: string | null = null;
                if (origin && origin !== 'null') {
                    try {
                        sourceHost = new URL(origin).host;
                    } catch {
                        sourceHost = null;
                    }
                } else if (referer) {
                    try {
                        sourceHost = new URL(referer).host;
                    } catch {
                        sourceHost = null;
                    }
                }
                if (sourceHost !== event.url.host) {
                    return ApiProblem.forbidden('Cross-origin multipart upload not allowed');
                }
            }

            if (contentType.includes('multipart/form-data')) {
                // A malformed body is the client's error (422), not a 500.
                let formData: FormData;
                try {
                    formData = await event.request.formData();
                } catch {
                    return ApiProblem.validationFailed('Invalid multipart body');
                }
                const file = formData.get('file');
                const artworkTypeValue = formData.get('artworkType');

                if (!(file instanceof File)) {
                    return ApiProblem.validationFailed('Missing file field in form data');
                }

                const limitBytes = config.MAX_IMAGE_UPLOAD_MB * 1024 * 1024;
                if (file.size > limitBytes) {
                    return ApiProblem.validationFailed(
                        `File too large. Maximum allowed size is ${config.MAX_IMAGE_UPLOAD_MB} MB.`,
                    );
                }

                const artworkType = typeof artworkTypeValue === 'string' ? artworkTypeValue : null;
                if (!isValidArtworkType(artworkType)) {
                    return ApiProblem.validationFailed(
                        'Invalid artworkType. Must be one of: poster, backdrop, logo, thumb',
                    );
                }

                const arrayBuffer = await file.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);
                const fileContentType = file.type || 'application/octet-stream';

                try {
                    const { filePath, serveUrl, undoId } = await storeMediaImage(
                        sql,
                        internalId,
                        artworkType,
                        { type: 'file', buffer, contentType: fileContentType },
                        username,
                    );
                    return json(ImageUploadResponseSchema.parse({ filePath, serveUrl, undoId }));
                } catch (err) {
                    return imageStorageProblem(internalId, err);
                }
            }

            if (contentType.includes('application/json')) {
                let body: unknown;
                try {
                    body = await event.request.json();
                } catch {
                    return ApiProblem.validationFailed('Invalid JSON body');
                }
                const parsed = ImageUploadUrlSchema.safeParse(body);

                if (!parsed.success) {
                    return ApiProblem.validationFailed('Invalid request body');
                }

                const { artworkType, url } = parsed.data;

                try {
                    const { filePath, serveUrl, undoId } = await storeMediaImage(
                        sql,
                        internalId,
                        artworkType,
                        { type: 'url', url },
                        username,
                    );
                    return json(ImageUploadResponseSchema.parse({ filePath, serveUrl, undoId }));
                } catch (err) {
                    return imageStorageProblem(internalId, err);
                }
            }

            return ApiProblem.validationFailed(
                'Content-Type must be multipart/form-data or application/json',
            );
        },

        DELETE: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            // Guard non-UUID ids (e.g. an unresolved composite key) — the query
            // hits a uuid column, so a bad value would 22P02 → 500 instead of 404.
            if (!internalId || !isUuid(internalId)) return ApiProblem.notFound('Media item');

            const typeParam = event.url.searchParams.get('type');
            if (!isValidArtworkType(typeParam)) {
                return ApiProblem.validationFailed(
                    'Invalid or missing type parameter. Must be one of: poster, backdrop, logo, thumb',
                );
            }

            const deleted = await deleteMediaImage(
                sql,
                internalId,
                typeParam,
                event.locals.user?.username ?? 'admin',
            );
            return json(ImageDeleteResponseSchema.parse({ deleted }));
        },
    },
});
