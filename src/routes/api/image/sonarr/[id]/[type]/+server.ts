// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// authz: authenticated — Sonarr artwork proxy (rate-limited); no user-scoped data

import type { RequestHandler } from './$types';
import type { RequestHandler as KitRequestHandler } from '@sveltejs/kit';
import { getImageProxyService } from '$lib/server/services/image-proxy';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { withImageProxyRateLimit } from '$lib/server/middleware/valkey-rate-limit';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { VALID_IMAGE_TYPES, isValidImageType } from '$lib/server/utils/image-validation.js';

const logger = Logger.for('SonarrImageRoute');

export const GET: RequestHandler = withImageProxyRateLimit(
    withErrorHandler(
        async ({
            params,
            url,
        }: {
            params: Parameters<RequestHandler>[0]['params'];
            url: Parameters<RequestHandler>[0]['url'];
        }) => {
            const { id, type } = params;

            // Validate ID parameter — must be a positive integer to prevent path traversal
            // when constructing `/api/v3/mediacover/${id}/${type}.jpg` upstream.
            if (!/^\d+$/.test(id)) {
                logger.warn('Sonarr image request invalid ID', { id });
                return ApiResponses.badRequest('Invalid ID');
            }

            // Validate type parameter
            if (!type || !isValidImageType(type)) {
                logger.warn('Sonarr image request invalid type', {
                    type,
                    validTypes: VALID_IMAGE_TYPES,
                });
                return new Response(
                    `Invalid image type. Must be one of: ${VALID_IMAGE_TYPES.join(', ')}`,
                    {
                        status: 400,
                    },
                );
            }

            const service = getImageProxyService();
            return service.getArrImage('sonarr', id, type, url);
        },
        // withErrorHandler is generic only over its Params type parameter, so its return
        // type widens RouteId to the full app-wide route-id union; the shared
        // withImageProxyRateLimit middleware is typed against the bare (non-generic)
        // Kit.RequestHandler, which pins Params/RouteId to the root layout's shape
        // instead of this route's. Both sides describe the same runtime handler; only
        // the shared middleware's generics (out of scope here) would let this be
        // expressed without a cast.
    ) as KitRequestHandler,
);
