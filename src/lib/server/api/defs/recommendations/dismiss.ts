// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// gen-api-routes: skip — this def is NOT generator-mounted. Its internal
// counterpart (src/routes/api/recommendations/dismiss/+server.ts) mounts its own
// INLINE def and stays authoritative and untouched; this def exists ONLY to
// carry the /api/v1/recommendations/dismiss doc metadata and delegate the v1
// request to that internal handler (Option B — v1-only delegate).

/**
 * defs/recommendations/dismiss.ts — /api/v1/recommendations/dismiss
 * (public/native surface; GET, POST, DELETE).
 *
 * WHY A DELEGATE (not a shared dual-mounted def): the internal route defines its
 * def INLINE and mounts it itself with `auth: { kind: 'user' }`. Extracting that
 * inline def into a shared module (Option A) would move handler logic and risk a
 * behaviour change; instead we forward the v1 request to the untouched internal
 * mounted handler, which runs its OWN enforce()+validation+handler chain — byte
 * identical to today, where the v1 route re-exported those same handlers.
 *
 * AUTH: `auth: { kind: 'public' }` makes THIS mount()'s enforce() a NO-OP; the
 * REAL gate is the internal mount's `enforce({ kind: 'user' })` reached via the
 * delegate. Because the internal handler is itself mount()-wrapped, its 401 body
 * is identical whether reached directly (old re-export) or via this delegate.
 *
 * The internal dismiss handler emits no image URLs, so `surface` is irrelevant.
 */

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { dismissBodySchema } from '$lib/schemas/ai.js';
import { DismissRecommendationResponseSchema } from '$lib/schemas/api-for-you-responses.js';

// Delegate one method to the untouched internal mounted handler. Dynamic import
// keeps the OpenAPI generator (which statically imports THIS def to read `docs`)
// from loading the internal handler's runtime deps (aiDbService/dismiss service
// → valkey-glide native), which would otherwise hang the generator.
async function delegate(method: 'GET' | 'POST' | 'DELETE', event: RequestEvent): Promise<Response> {
    const internal =
        (await import('../../../../../routes/api/recommendations/dismiss/+server.js')) as Partial<
            Record<'GET' | 'POST' | 'DELETE', RequestHandler>
        >;
    const handler = internal[method];
    if (!handler) {
        return new Response('Method Not Allowed', { status: 405 });
    }
    return handler(event) as Promise<Response>;
}

export const def = defineEndpoint({
    // Runtime gate is the internal mount's enforce({ kind: 'user' }) via delegate.
    auth: { kind: 'public' },

    // OpenAPI docs for the /api/v1/recommendations/dismiss surface. Migrated
    // verbatim from the retired v1 _openapi.ts, which re-exported the internal
    // recommendations/dismiss/_openapi.ts `route` (POST only; GET/DELETE stay
    // undocumented as before). No `auth`/`stability` fields.
    docs: {
        POST: {
            tags: ['Recommendations'],
            stability: 'beta',
            summary: 'Dismiss a recommendation',
            body: dismissBodySchema,
            responses: {
                200: {
                    schema: DismissRecommendationResponseSchema,
                    description: 'Recommendation dismissed',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },

    handlers: {
        GET: (event: RequestEvent) => delegate('GET', event),
        POST: (event: RequestEvent) => delegate('POST', event),
        DELETE: (event: RequestEvent) => delegate('DELETE', event),
    },
});
