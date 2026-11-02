// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/providers/reconnect.ts — POST /api/v1/admin/providers/reconnect
 *
 * Triggers an immediate Jellyfin reconnection attempt. Requires `providers:admin`
 * scope.
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/admin/providers/reconnect/`
 * `+server.ts`, which did its own inline `enforce({kind:'scope',
 * anyOf:['providers:admin']})` call. Behaviour is preserved exactly — mount()
 * runs the SAME enforce() with the SAME AuthSpec before the handler, so the
 * 401/403 gate is byte-for-byte the same; the inline `gate()` helper is no
 * longer needed and has been dropped.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin.
 */

import { ApiProblem } from '$lib/server/api/problem.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { connectionStatus } from '$lib/server/services/connection-status.service.js';
import { reconnectJellyfin } from '$lib/server/jellyfin/connection-lifecycle.js';
import { ProviderReconnectResponseSchema } from '$lib/schemas/api-integrations-responses';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['providers:admin'] },
    docs: {
        visibility: 'internal',
        POST: {
            tags: ['Admin'],
            summary: 'Trigger an immediate provider reconnection attempt',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: ProviderReconnectResponseSchema,
                    description: 'Reconnection attempt result',
                },
                401: 'Authentication required',
                403: 'Insufficient scope (providers:admin required)',
                422: 'Unknown or unsupported service, or Jellyfin not configured',
                503: 'Provider dependency unavailable (dependency_unavailable)',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        POST: async (event) => {
            const service = event.url.searchParams.get('service');

            if (service === 'jellyfin') {
                // Re-reads and applies the settings first, so Reconnect also
                // works when this process never initialised the connection.
                const success = await reconnectJellyfin();
                if (success === null) {
                    return ApiProblem.validationFailed('Jellyfin is not configured');
                }
                return new Response(
                    JSON.stringify({
                        service: 'jellyfin',
                        success,
                        state: connectionStatus.getStatus('jellyfin').state,
                    }),
                    { status: 200, headers: { 'Content-Type': 'application/json' } },
                );
            }

            return ApiProblem.validationFailed('Unknown or unsupported service');
        },
    },
});
