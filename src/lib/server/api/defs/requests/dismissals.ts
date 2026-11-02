// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/requests/[id]/dismiss.ts — POST /requests/dismissals
 *
 * Dismisses a media request (notification read-state).
 *
 * The body accepts externalIds + mediaType as the dismiss key (the native
 * Jellyseerr request ID alone is not stable across re-requests).
 *
 * Auth: user.
 * Rate-limit: 10 / 60 s (STRICT preset).
 */

import { z } from 'zod';
import type { RequestEvent } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { config } from '$lib/server/config.js';
import { getEffectiveUser } from '$lib/server/dev-user.js';
import { upsertDismissal } from '$lib/server/services/request-status/index.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { getClientIp } from '$lib/server/utils/client-ip.js';
import type { ExternalIds } from '$lib/types/api-common.js';

const DismissBodySchemaFromDocs = z.object({
    externalIds: z
        .record(z.string(), z.string())
        .meta({ description: 'At least one external ID is required (e.g. { "tmdb": "603" })' }),
    mediaType: z.enum(['movie', 'series']).meta({
        description: 'Media type: movie or series.',
    }),
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Body schema for POST /requests/dismissals.
 *
 * Lenient: unknown fields are stripped (no .strict()).
 */
const DismissBodySchema = z.object({
    externalIds: z
        .record(z.string(), z.string())
        .refine((ids) => Object.values(ids).some((v) => typeof v === 'string' && v.length > 0), {
            message: 'At least one external ID is required',
        }),
    /** Canonical: `movie` or `series`.  Storage conversion happens after validation. */
    mediaType: z
        .enum(['movie', 'series'])
        // constrained: enum-validated to movie|series|tv, and 'series' is
        // mapped away by this same transform.
        // eslint-disable-next-line callback-safety/no-narrowing-media-type-cast
        .transform((v) => (v === 'series' ? 'tv' : v) as 'movie' | 'tv'),
});

// ---------------------------------------------------------------------------
// Rate-limit constants (STRICT: 10 / 60 s)
// ---------------------------------------------------------------------------

const DISMISS_RATE_LIMIT = 10;
const DISMISS_RATE_WINDOW = 60;

/** Shared limiter (per ip+user). Also used by POST /requests/{id}/dismissal. */
export async function enforceDismissRateLimit(event: RequestEvent): Promise<Response | null> {
    const ip = getClientIp(event);
    const username = event.locals.user?.username || 'anonymous';
    const key = `${ip}:${username}:requests-dismiss`;
    const rl = await checkRateLimit(key, DISMISS_RATE_LIMIT, DISMISS_RATE_WINDOW);
    return rl.allowed ? null : ApiProblem.rateLimited(rl.resetAt);
}

/** Persist the dismissal (after rate limiting and body validation). */
export async function saveDismissal(
    event: RequestEvent,
    externalIds: Record<string, string>,
    mediaType: 'movie' | 'tv',
): Promise<Response> {
    const effectiveUsername = getEffectiveUser(
        event.request,
        event.locals.user?.username || config.DEFAULT_USER,
    );

    const result = await upsertDismissal(effectiveUsername, externalIds as ExternalIds, mediaType);

    if (!result.success || !result.dismissedAt) {
        if (result.error === 'Cannot identify media') {
            return ApiProblem.validationFailed(result.error);
        }
        if (result.error === 'Unknown user') {
            return ApiProblem.notFound('User not found');
        }
        return ApiProblem.internalError(result.error ?? 'Failed to save dismissal');
    }

    return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    docs: {
        POST: {
            tags: ['Request'],
            summary: 'Dismiss request notifications by title',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Dismisses a media request notification for the authenticated user. ' +
                'The dismiss key is derived from `externalIds + mediaType` — this is stable ' +
                'across re-requests (the notification re-surfaces if the user submits the same request again). ' +
                'Rate-limited: 10 requests per 60 seconds.',
            body: DismissBodySchemaFromDocs,
            responses: {
                204: 'Request dismissed',
                422: 'Validation error',
                401: 'Authentication required',
                429: 'Rate limit exceeded',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    request: {
        body: DismissBodySchema,
    },
    handlers: {
        /**
         * POST /requests/dismissals
         *
         * Dismiss a request notification for the current user. The notification
         * re-surfaces automatically if the user submits the same request again
         * (no "un-dismiss" write is needed — comparison is timestamp-based).
         *
         * The path `{id}` is the Jellyseerr request ID and is used for routing only;
         * the actual dismiss key is `externalIds + mediaType` in the body (stable
         * across re-requests).
         *
         * Response: 204 No Content.
         */
        POST: async (event, ctx) => {
            // Rate limit: 10 req / 60 s per user
            const limited = await enforceDismissRateLimit(event);
            if (limited) return limited;

            // When called via mount(), the body was already validated by validateRequest
            // and is available on ctx.input.body (body stream consumed).  When the handler
            // is called directly (unit tests, legacy wiring without mount()), fall back to
            // re-parsing the body from the request stream.
            let parsedBody: { externalIds: Record<string, string>; mediaType: 'movie' | 'tv' };
            if (ctx.input?.body) {
                parsedBody = ctx.input.body;
            } else {
                let rawBody: unknown;
                try {
                    rawBody = await event.request.json();
                } catch {
                    return ApiProblem.validationFailed('Request body must be valid JSON');
                }
                const result = DismissBodySchema.safeParse(rawBody);
                if (!result.success) {
                    return ApiProblem.validationFailed(
                        result.error.issues.map((e) => ({
                            field: e.path.join('.'),
                            message: e.message,
                        })),
                    );
                }
                parsedBody = result.data;
            }
            const { externalIds, mediaType } = parsedBody;
            return saveDismissal(event, externalIds, mediaType);
        },
    },
});
