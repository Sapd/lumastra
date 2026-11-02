// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/providers.ts
 *
 * GET   /api/v1/providers — list metadata provider configs
 * PATCH /api/v1/providers — update provider configuration
 * PUT   /api/v1/providers — replace provider configuration
 *
 * Requires `providers:admin` scope; delegates to the internal admin handlers.
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/providers/` `+server.ts`
 * — see defs/libraries/integrity.ts for the full rationale.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin
 * generated.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import {
    GET as adminGET,
    PATCH as adminPATCH,
    PUT as adminPUT,
} from '../../../../routes/api/admin/providers/+server.js';
import {
    ProvidersResponseSchema,
    ProviderUpdateResponseSchema,
    MetadataChainReorderResponseSchema,
} from '$lib/schemas/api-admin-responses';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['providers:admin'] },
    docs: {
        GET: {
            visibility: 'internal',
            tags: ['Admin'],
            summary: 'Get provider dashboard data',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: ProvidersResponseSchema,
                    description: 'Provider configuration, status, and field authorities',
                },
                401: 'Authentication required',
                403: 'Insufficient scope (providers:admin required)',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        PUT: {
            visibility: 'internal',
            tags: ['Admin'],
            summary: 'Set the metadata provider chain order',
            description:
                "Body `{ chain: string[] }` — source names in fallback order (e.g. `['tmdb','mdblist']`), 'aggregated' excluded. Saved as METADATA_PROVIDERS.",
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: MetadataChainReorderResponseSchema,
                    description: 'Metadata chain saved',
                },
                401: 'Authentication required',
                403: 'Insufficient scope (providers:admin required)',
                409: 'METADATA_PROVIDERS is set by an environment variable',
                422: 'Validation failed (unknown or duplicate source, empty chain)',
                500: 'Internal server error',
            },
        },
        PATCH: {
            visibility: 'internal',
            tags: ['Admin'],
            summary: 'Update a provider enabled state or priority',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: ProviderUpdateResponseSchema,
                    description: 'Updated provider state',
                },
                401: 'Authentication required',
                403: 'Insufficient scope (providers:admin required)',
                404: 'Provider not found',
                422: 'Validation failed',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        GET: async (event) => {
            return delegateToAdmin(event, adminGET!);
        },
        PATCH: async (event) => {
            return delegateToAdmin(event, adminPATCH!);
        },
        PUT: async (event) => {
            return delegateToAdmin(event, adminPUT!);
        },
    },
});
