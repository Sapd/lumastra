// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/radio/stations/index.ts
 *
 * GET  /api/v1/radio/stations — list radio stations (admin CRUD)
 * POST /api/v1/radio/stations — create radio station
 *
 * Requires `providers:admin` scope. Distinct from the client-facing
 * music/radio/stations.
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/radio/stations/`
 * `+server.ts` — see defs/libraries/integrity.ts for the full rationale.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin
 * generated.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import {
    GET as adminGET,
    POST as adminPOST,
} from '../../../../../../routes/api/admin/radio/+server.js';
import {
    AdminRadioListResponseSchema,
    AdminRadioCreateResponseSchema,
} from '$lib/schemas/api-admin-responses';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['providers:admin'] },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Music'],
            summary: 'List radio stations (admin)',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: AdminRadioListResponseSchema,
                    description:
                        'List of all radio stations with admin-level fields (stream URL, metadata source, last error)',
                },
                401: 'Authentication required',
                403: 'Insufficient scope (providers:admin required)',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        POST: {
            tags: ['Music'],
            summary: 'Create radio station (admin)',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: AdminRadioCreateResponseSchema,
                    description: 'Newly created radio station',
                },
                401: 'Authentication required',
                403: 'Insufficient scope (providers:admin required)',
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
        POST: async (event) => {
            return delegateToAdmin(event, adminPOST!);
        },
    },
});
