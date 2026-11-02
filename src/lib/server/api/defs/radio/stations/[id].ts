// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/radio/stations/[id].ts
 *
 * PATCH  /api/v1/radio/stations/{id} — update radio station
 * DELETE /api/v1/radio/stations/{id} — delete radio station
 *
 * Requires `providers:admin` scope.
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/radio/stations/[id]/`
 * `+server.ts` — see defs/libraries/integrity.ts for the full rationale.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin
 * generated.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import {
    PATCH as adminPATCH,
    DELETE as adminDELETE,
} from '../../../../../../routes/api/admin/radio/[id]/+server.js';
import { AdminRadioPatchResponseSchema } from '$lib/schemas/api-admin-responses';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['providers:admin'] },
    docs: {
        visibility: 'internal',
        DELETE: {
            tags: ['Music'],
            summary: 'Delete radio station (admin)',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                204: 'Station deleted',
                401: 'Authentication required',
                403: 'Insufficient scope (providers:admin required)',
                404: 'Station not found',
                422: 'Invalid station ID',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        PATCH: {
            tags: ['Music'],
            summary: 'Update radio station (admin)',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: AdminRadioPatchResponseSchema,
                    description:
                        'Station updated; optional validation result when metadataSource was changed',
                },
                401: 'Authentication required',
                403: 'Insufficient scope (providers:admin required)',
                404: 'Station not found',
                422: 'Validation failed',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        PATCH: async (event) => {
            return delegateToAdmin(event, adminPATCH!);
        },
        DELETE: async (event) => {
            return delegateToAdmin(event, adminDELETE!);
        },
    },
});
