// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Custom Image Serve Endpoint
 *
 * Serves locally-stored custom images from the media_artwork table.
 * Auth-protected (any authenticated user) so all users can view custom images.
 *
 * Route: GET /api/image/custom/[id]/[type]
 *   id   — UUID of the media item
 *   type — artwork type: poster, backdrop, logo, thumb
 */

import { withImageProxyRateLimit } from '$lib/server/middleware/valkey-rate-limit';
import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { getDb } from '$lib/server/database/connection.js';
import { getLocalArtwork } from '$lib/server/database/queries/media-artwork.queries.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import {
    parseImageSize,
    applySaveDataDowngrade,
    resolveImageFormat,
} from '$lib/server/utils/image-params.js';
import { resizeForPreset } from '$lib/server/utils/image-proxy.js';
import { imageResponse } from '$lib/server/services/image-proxy';
import { isPathWithinLibraryRoots, isPathWithin } from '$lib/server/utils/media-path-resolver.js';
import { readContainedFile } from '$lib/server/utils/contained-fs.js';
import { config } from '$lib/server/config.js';
import * as path from 'node:path';

const VALID_TYPES = new Set(['poster', 'backdrop', 'logo', 'thumb']);

/** Stored artwork is re-encoded on upload; this only bounds a hand-placed file. */
const MAX_CUSTOM_IMAGE_BYTES = 64 * 1024 * 1024;

const EXT_TO_CONTENT_TYPE: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.avif': 'image/avif',
};

const getCustomImage = requireAuth(
    withErrorHandler(async ({ params, url, request, locals }) => {
        const id = params.id;
        const type = params.type;

        if (!id || !type || !VALID_TYPES.has(type)) {
            return ApiResponses.notFound('Image type');
        }

        const sql = getDb();
        if (!sql) {
            return ApiResponses.error('Database not available', new Error('No database'), 503);
        }

        // Library + age gate. `id` is a media_items UUID; without this an
        // authenticated user restricted from a library (or above their age
        // rating) could fetch its custom artwork — and confirm the item's
        // existence — by UUID. Mirrors /api/image/[id]/[type]. 404 (not 403)
        // to avoid leaking existence. `requireAuth` guarantees locals.user.
        if (locals.user && !(await checkMediaAccess(sql, id, locals.user))) {
            return ApiResponses.notFound('Image');
        }

        const row = await getLocalArtwork(
            sql,
            id,
            type as 'poster' | 'backdrop' | 'logo' | 'thumb',
        );

        if (!row || !row.file_path) {
            return ApiResponses.notFound('Image');
        }

        // Defense-in-depth: artwork paths are DB-sourced (admin-written), but verify the
        // file resolves inside either the metadata store or a configured library root
        // (sidecar artwork) before reading, so a tampered media_artwork row cannot leak
        // arbitrary host files.
        // Mirror the catalog route's servable-path set exactly (ImageProxyService
        // .tryLocalArtwork) so the two endpoints agree: the .metadata store, a
        // configured library root (sidecar art), the ffmpeg extracted-frames dir
        // (BASE_PATH/image-sync), and the central music-cover dir
        // (BASE_PATH/metadata/music). Without the latter two, custom_*_url stamped
        // for extracted frames / centrally-stored music covers 404s here while the
        // catalog route serves them — a split-brain the callers can't predict.
        const metadataDir = path.join(config.BASE_PATH || '/data', '.metadata');
        const extractedFramesDir = path.join(config.BASE_PATH || '/tmp', 'image-sync');
        const musicMetadataDir = path.join(config.BASE_PATH || '/config', 'metadata', 'music');
        if (
            !isPathWithin(row.file_path, metadataDir) &&
            !isPathWithin(row.file_path, extractedFramesDir) &&
            !isPathWithin(row.file_path, musicMetadataDir) &&
            !(await isPathWithinLibraryRoots(sql, row.file_path))
        ) {
            return ApiResponses.notFound('Image');
        }

        // The check above is lexical. The row was written when the art was stored;
        // a link swapped in since then (for the file or a directory above it) must
        // not be followed out of these roots (contained-fs `parents`).
        let original: Buffer;
        try {
            original = await readContainedFile(row.file_path, {
                extraRoots: [metadataDir, extractedFramesDir, musicMetadataDir],
                maxBytes: MAX_CUSTOM_IMAGE_BYTES,
                parents: true,
            });
        } catch {
            return ApiResponses.notFound('Image');
        }

        const ext = path.extname(row.file_path).toLowerCase();
        const originalContentType = EXT_TO_CONTENT_TYPE[ext] ?? 'application/octet-stream';

        const size = applySaveDataDowngrade(parseImageSize(url), request);
        // Negotiate format from Accept header (or explicit ?format=) so AVIF-
        // capable clients get AVIF and others get WebP. Explicit ?format=jpg
        // and ?format=png are honored — they produce JPEG/PNG bytes; without
        // that, an admin testing format overrides would silently get WebP.
        const requestedFormat = resolveImageFormat(url, request);
        const encodeFormat: 'webp' | 'avif' | 'jpeg' | 'png' =
            requestedFormat === 'avif'
                ? 'avif'
                : requestedFormat === 'jpg'
                  ? 'jpeg'
                  : requestedFormat === 'png'
                    ? 'png'
                    : 'webp';
        const { buffer, contentType } = await resizeForPreset(
            original,
            originalContentType,
            size,
            encodeFormat,
        );

        // Use the shared imageResponse helper so we get a consistent ETag,
        // stale-while-revalidate, and Vary: Save-Data — the previous hand-rolled
        // Response omitted the ETag, so browsers couldn't issue conditional GETs.
        return imageResponse(
            {
                buffer,
                contentType,
                cacheControl: 'public, max-age=86400, stale-while-revalidate=604800',
            },
            request,
        );
    }),
);

export const GET: RequestHandler = withImageProxyRateLimit(getCustomImage);
