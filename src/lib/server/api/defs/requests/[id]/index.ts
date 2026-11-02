// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/requests/[id]/index.ts — GET /requests/{id}
 *
 * Fetches a single media request by its Jellyseerr request ID.
 *
 * Auth:
 *   - Any authenticated user may fetch their own request.
 *   - `requests:admin` scope OR admin session is required to fetch requests
 *     belonging to other users.
 *
 * Response: the same RequestItem shape emitted by GET /requests.
 *
 * Errors:
 *   404 — request not found in Jellyseerr.
 *   403 — caller does not own the request and lacks requests:admin.
 *   503 — Jellyseerr is not reachable.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { jellyseerrClient } from '$lib/server/jellyseerr.js';
import { getSimpleStatusLabel } from '$lib/server/services/request-status/index.js';
import { getEffectiveUser } from '$lib/server/dev-user.js';
import { config } from '$lib/server/config.js';
import type { ExternalIds } from '$lib/types/api-common.js';
import { toPublicMediaType } from '$lib/shared/media-type-domain';
import { buildRequestDismissalExtKey } from '$lib/shared/request-dismissal-key.js';
import { hasRequestsAdmin } from '../requests-admin.js';

const RequestItemSchema = z.object({
    id: z.number().int(),
    dismissalKey: z.string(),
    externalIds: z.record(z.string(), z.string()),
    mediaType: z.enum(['movie', 'series']),
    title: z.string(),
    posterPath: z.string().nullable(),
    status: z.string(),
    requestedAt: z.string().meta({ description: 'ISO-8601 creation timestamp' }),
    is4k: z.boolean(),
});

// ---------------------------------------------------------------------------
// Request contract
// ---------------------------------------------------------------------------

/**
 * Path params schema for GET /requests/{id}.
 *
 * The handler validates the id in-line; this schema provides the declarative
 * contract layer that mount() can validate before the handler runs.
 * Lenient: coerces the string param — unknown fields are stripped.
 */
const RequestByIdParamsSchema = z.object({
    id: z.coerce.number().int().positive(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Canonicalise Jellyseerr `tv` media type to public `series` discriminator.
 * Only movie/series are renderable request types; anything else → null (404). */
function canonicalMediaType(type: string): 'movie' | 'series' | null {
    const p = toPublicMediaType(type);
    return p === 'movie' || p === 'series' ? p : null;
}

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Request'],
            summary: 'Get a single media request',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Returns a single media request by its Jellyseerr request ID. ' +
                'The response shape matches the items returned by `GET /requests`. ' +
                'Callers may only read their own requests unless they hold the `requests:admin` scope. ' +
                'This endpoint restores the read capability lost when `POST /request/status` was removed.',
            responses: {
                200: {
                    schema: RequestItemSchema,
                    description: 'Media request',
                },
                422: 'Invalid request ID (not a positive integer)',
                401: 'Authentication required',
                403: 'Request belongs to another user and caller lacks requests:admin',
                404: 'Request not found',
                503: 'Jellyseerr unavailable',
            },
        },
    },

    auth: { kind: 'user' },
    request: {
        params: RequestByIdParamsSchema,
    },
    handlers: {
        /**
         * GET /requests/{id}
         *
         * Returns a single media request by its Jellyseerr request ID.
         *
         * Ownership check: callers who don't own the request must hold
         * `requests:admin` scope (or be an admin session).
         *
         * Response shape matches the items emitted by GET /requests:
         * ```jsonc
         * {
         *   "id": 42,
         *   "externalIds": { "tmdb": "550" },
         *   "type": "movie",
         *   "title": "The Last Signal",
         *   "images": { "poster": "/api/image/tmdb:550:movie/poster" },
         *   "status": "pending",
         *   "requestedAt": "2026-01-01T00:00:00Z",
         *   "is4k": false
         * }
         * ```
         */
        GET: async (event, _ctx) => {
            const { locals, params } = event;

            // Parse + validate path param
            const rawId = params.id ?? '';
            const requestId = Number(rawId);
            if (!Number.isInteger(requestId) || requestId <= 0) {
                return ApiProblem.validationFailed('id must be a positive integer');
            }

            // Fetch from Jellyseerr
            if (!jellyseerrClient.isConfigured()) {
                return ApiProblem.dependencyUnavailable('Jellyseerr is not configured');
            }

            const req = await jellyseerrClient.getRequestById(requestId);
            if (!req) {
                return ApiProblem.notFound(`Request ${requestId} not found`);
            }

            // Ownership check — non-admins may only read their own requests.
            // Admin path: requests:admin scope OR an admin identity.
            //
            // This was written with `??`, which only falls through on null /
            // undefined. `scopes.includes(...)` returns a BOOLEAN, so for any
            // caller carrying a Principal with a scopes array a `false` ended the
            // chain and neither admin flag was ever consulted — the documented
            // "or be an admin session" path could not fire, and the 403 below
            // told the caller to use a scope that would not have helped either.
            // Fails closed, so this was a correctness bug rather than a hole.
            //
            // Precedence mirrors enforce({kind:'admin'}) exactly: the Principal is
            // AUTHORITATIVE and `locals.user.isAdmin` is never consulted (no
            // principal = no admin rights; see requests-admin.ts).
            // That is deliberate — `locals.user.isAdmin` comes from the user's live
            // groups alone and ignores the token's scopes, so falling through to it
            // would re-grant admin to a low-scope PAT merely because its owner is an
            // admin. `principal.isAdmin` already folds in the scope check
            // (deriveIsAdmin), which is why an `admin`-scoped token needs no
            // separate literal match here.
            const hasAdminScope = hasRequestsAdmin(locals);

            if (!hasAdminScope) {
                // Resolve the effective username for this session and compare to
                // the Jellyseerr requestedBy.  The Jellyseerr user's jellyfinUsername
                // (or displayName fallback) is what the client is linked by.
                const effectiveUsername = getEffectiveUser(
                    event.request,
                    locals.user?.username || config.DEFAULT_USER,
                );

                const requestedByUsername =
                    req.requestedBy.username?.toLowerCase() ||
                    req.requestedBy.displayName?.toLowerCase();
                const effectiveLower = effectiveUsername.toLowerCase();

                if (requestedByUsername !== effectiveLower) {
                    return ApiProblem.forbidden(
                        'You can only view your own requests. Use requests:admin scope to view others.',
                    );
                }
            }

            const mediaType = canonicalMediaType(req.type);
            if (!mediaType) {
                // Unknown media type from Jellyseerr — treat as not renderable
                return ApiProblem.notFound(`Request ${requestId} has an unrecognised media type`);
            }

            const relevantStatus =
                req.is4k && req.media.status4k !== undefined
                    ? req.media.status4k
                    : req.media.status;

            const externalIds: ExternalIds = { tmdb: String(req.media.tmdbId) };
            const title = req.mediaInfo?.title || req.mediaInfo?.name || `Request #${req.id}`;

            return json({
                id: req.id,
                dismissalKey: buildRequestDismissalExtKey(externalIds, mediaType)!,
                externalIds,
                // Field name is `mediaType` to match the published RequestItem
                // schema (_openapi.ts) and the list endpoint; value is canonical
                // (movie|series). This is the documented field for the requests
                // resource (not the polymorphic media `type` discriminator), so
                // the discriminator-leak guard is intentionally suppressed here.
                // eslint-disable-next-line callback-safety/no-discriminator-leak-in-response
                mediaType,
                title,
                // `posterPath` (not an `images: {}` map) matches the documented
                // RequestItem schema and the list endpoint's actual field name —
                // this is the established contract for this resource, not a leak.
                // eslint-disable-next-line callback-safety/no-discriminator-leak-in-response
                posterPath: req.mediaInfo?.posterPath ?? null,
                status: getSimpleStatusLabel(req.status, relevantStatus),
                requestedAt: req.createdAt,
                is4k: req.is4k,
            });
        },
    },
});
