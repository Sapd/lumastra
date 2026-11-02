// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// authz: authenticated — library-group artwork proxy (rate-limited); not media-item content

/**
 * Library Image Proxy
 *
 * Returns the auto-generated montage backdrop for a library
 * (CollectionFolder). The same image is served for `primary`, `backdrop`,
 * `poster`, and `thumb` — clients pick the type they need; the underlying
 * asset is one 16:9 mosaic generated from the library's items.
 *
 * URL: /api/image/library/{libraryGroupId}/{type}
 *   type: primary | backdrop | poster | thumb (case-insensitive)
 *
 * Empty libraries fall back to a static placeholder.
 */

import { libraryImageResponse, LibraryImageQuery } from '$lib/server/services/image-proxy/library-response.js';
import type { RequestHandler } from './$types';
import { Logger } from '$lib/server/utils/logger';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { getDb } from '$lib/server/database';
import {
    getLibraryBackdrop,
    getLibraryPlaceholder,
    isLibraryGroup,
} from '$lib/server/services/library-backdrop.service';
import { toLibraryAccessUser } from '$lib/server/cache/library-group-permissions-cache.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { withImageProxyRateLimit } from '$lib/server/middleware/valkey-rate-limit';
import { problem } from '$lib/server/api/problem.js';

const logger = Logger.for('LibraryImage');

const ALLOWED_TYPES = new Set(['primary', 'backdrop', 'poster', 'thumb', 'logo']);

export const GET: RequestHandler = withImageProxyRateLimit(
    withErrorHandler(async ({ params, request, locals }) => {
        if (!locals.user) return problem('unauthorized');
        const query = LibraryImageQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
        if (!query.success) return problem('validation_failed', { error: 'Invalid image size' });
        const id = params.id;
        const type = (params.type ?? '').toLowerCase();

        if (!id || !isUuid(id)) {
            return problem('validation_failed', { error: 'Invalid library id' });
        }
        if (!ALLOWED_TYPES.has(type)) {
            return problem('validation_failed', {
                error: `Invalid image type. Valid: ${[...ALLOWED_TYPES].join(', ')}`,
            });
        }

        const sql = getDb();
        if (!sql) {
            return problem('dependency_unavailable', { error: 'Database unavailable' });
        }

        // Distinguish "library doesn't exist" (404) from "DB blip" (503).
        // isLibraryGroup throws on transient DB errors; without this guard
        // those would surface as a generic 500 from the error handler.
        let exists: boolean;
        try {
            exists = await isLibraryGroup(sql, id, toLibraryAccessUser(locals.user));
        } catch (err) {
            logger.warn('isLibraryGroup failed', {
                id,
                error: (err as Error).message,
            });
            return problem('dependency_unavailable', { error: 'Database error' });
        }
        if (!exists) {
            return problem('not_found', { error: 'Library not found' });
        }

        const result =
            (await getLibraryBackdrop(sql, id)) ?? (await getLibraryPlaceholder(sql, id));
        if (!result) {
            logger.debug('No backdrop or placeholder available', { id });
            return new Response(null, { status: 404 });
        }

        return libraryImageResponse(result, request);
    }),
);
