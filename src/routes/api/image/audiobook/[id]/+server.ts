// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// authz: authenticated artwork policy in route-policy/rules.ts; object gate for signed-in viewers

import type { RequestHandler } from './$types';
import { getImageProxyService, imageResponse } from '$lib/server/services/image-proxy';
import { Logger } from '$lib/server/utils/logger';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { withImageProxyRateLimit } from '$lib/server/middleware/valkey-rate-limit';

import { getDb } from '$lib/server/database/index.js';
import { findMediaIdByProviderExternalId } from '$lib/server/database/queries/external-ids.queries.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { toLibraryAccessUser } from '$lib/server/cache/library-group-permissions-cache.js';

const logger = Logger.for('AudiobookImageAPI');

export const GET: RequestHandler = withImageProxyRateLimit(
    withErrorHandler(async ({ params, request, locals }) => {
        try {
            // Hooks/route policy own authentication, including anonymous artwork
            // exemptions. Authenticated viewers must pass the same object gate
            // as details and playback, before touching an upstream/cache cover.
            if (locals.user && !toLibraryAccessUser(locals.user)?.isAdmin) {
                const sql = getDb();
                if (!sql) return new Response('Image not found', { status: 404 });
                const mediaId = await findMediaIdByProviderExternalId(sql, {
                    provider: 'audiobookshelf',
                    externalId: params.id!,
                    mediaType: 'audiobook',
                });
                if (!mediaId || !(await checkMediaAccess(sql, mediaId, locals.user))) {
                    return new Response('Image not found', { status: 404 });
                }
            }
            const service = getImageProxyService();
            const result = await service.getAudiobookImage(params.id!);

            if (!result) {
                logger.debug('Audiobook image not found', { id: params.id });
                return new Response('Image not found', { status: 404 });
            }

            const response = imageResponse(result, request);
            // An authenticated authorization result must not become a shared
            // cache entry that can outlive a library restriction or retirement:
            // private, and revalidated (ETag) on every use instead of no-store.
            if (locals.user) response.headers.set('Cache-Control', 'private, no-cache');
            return response;
        } catch (error) {
            logger.error('Failed fetching Audiobook Image', error as Error, {
                id: params.id,
            });
            return new Response('Image not found', { status: 404 });
        }
    }),
);
