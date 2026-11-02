// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/plugins/internal/[id]/run.ts — POST /api/v1/plugins/internal/{id}/run
 *
 * Trigger a plugin run. Requires `tasks:run` scope.
 *
 * The admin handler uses POST / with a body; we normalize params.id →
 * params.pluginId and forward the request with `{ action: 'run' }` injected
 * (unless the caller already specified an `action`), exactly as the
 * hand-written route did.
 *
 * Phase 3 port of the hand-written
 * `src/routes/api/v1/plugins/internal/[id]/run/` `+server.ts` — see
 * defs/libraries/integrity.ts for the full rationale.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin
 * generated.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import { POST as adminPOST } from '../../../../../../../routes/api/admin/plugins/[pluginId]/+server.js';
import { PluginStatusResponseSchema } from '$lib/schemas/api-admin-library-responses';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['tasks:run'] },
    docs: {
        visibility: 'internal',
        POST: {
            tags: ['Admin'],
            summary: 'Trigger internal plugin run',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: PluginStatusResponseSchema,
                    description: 'Plugin status after triggering run',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        POST: async (event: RequestEvent) => {
            // Normalize: v1 uses params.id, admin uses params.pluginId.
            if (!event.params.pluginId) {
                (event.params as Record<string, string>).pluginId = event.params.id ?? '';
            }

            // Inject { action: 'run' } as the body if none provided.
            // The admin handler parses { action } from the request body.
            const origRequest = event.request;
            const rawBody = (await origRequest.json().catch(() => ({}))) as Record<string, unknown>;
            const body: Record<string, unknown> = {
                ...rawBody,
                action: rawBody['action'] ?? 'run',
            };

            // Replace the request with the modified body.
            const newRequest = new Request(origRequest.url, {
                method: origRequest.method,
                headers: origRequest.headers,
                body: JSON.stringify(body),
            });
            event.request = newRequest;

            return delegateToAdmin(event, adminPOST!);
        },
    },
});
