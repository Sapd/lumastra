// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { jellyseerrClient } from '$lib/server/jellyseerr.js';
import { getEffectiveUser } from '$lib/server/dev-user.js';
import { config } from '$lib/server/config.js';
import { hasRequestsAdmin } from '../requests-admin.js';
import { enforceDismissRateLimit, saveDismissal } from '../dismissals.js';

export const def = defineEndpoint({
    auth: { kind: 'user' },
    request: { params: z.object({ id: z.coerce.number().int().positive() }) },
    docs: {
        POST: {
            tags: ['Request'],
            summary: 'Dismiss the notification for one request',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Derives the media identity from a request owned by the caller, or any request for an administrator.',
            responses: {
                204: 'Request dismissed',
                404: 'Request not found',
                422: 'Invalid request ID',
                429: 'Rate limit exceeded',
                503: 'Jellyseerr unavailable',
            },
        },
    },
    handlers: {
        POST: async (event, _ctx) => {
            const id = Number(event.params.id);
            if (!Number.isSafeInteger(id) || id <= 0)
                return ApiProblem.validationFailed('Invalid request ID');
            // Before any Jellyseerr call: same limiter as POST /requests/dismissals.
            const limited = await enforceDismissRateLimit(event);
            if (limited) return limited;
            if (!jellyseerrClient.isConfigured())
                return ApiProblem.dependencyUnavailable('Jellyseerr is not configured');
            const request = await jellyseerrClient.getRequestById(id);
            if (!request) return ApiProblem.notFound('Request not found');
            // Jellyseerr can return requests whose media/requestedBy were removed.
            const requestedById = (request.requestedBy as { id?: number } | undefined)?.id;
            const mediaTmdbId = (request.media as { tmdbId?: number } | undefined)?.tmdbId;
            if (!hasRequestsAdmin(event.locals)) {
                const username = getEffectiveUser(
                    event.request,
                    event.locals.user?.username || config.DEFAULT_USER,
                );
                const link = await jellyseerrClient.resolveUserLink(username);
                if (link.state === 'unavailable')
                    return ApiProblem.dependencyUnavailable('Jellyseerr unavailable');
                if (link.state !== 'linked' || link.user.id !== requestedById)
                    return ApiProblem.notFound('Request not found');
            }
            if (request.type !== 'movie' && request.type !== 'tv')
                return ApiProblem.notFound('Request not found');
            if (!mediaTmdbId) return ApiProblem.notFound('Request not found');
            return saveDismissal(event, { tmdb: String(mediaTmdbId) }, request.type);
        },
    },
});
