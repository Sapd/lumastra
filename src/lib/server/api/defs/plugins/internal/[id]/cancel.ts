// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/plugins/internal/[id]/cancel.ts — POST /api/v1/plugins/internal/{id}/cancel
 *
 * Abort a running plugin. Requires `tasks:run` scope.
 *
 * The base plugin route (`../index.ts`) uses POST / with a body to distinguish
 * run vs. abort; this endpoint normalizes params.id → params.pluginId and
 * injects `{ action: 'abort' }` as the body before delegating to the SAME
 * admin POST handler, exactly as the hand-written route did.
 *
 * Phase 3 port of the hand-written
 * `src/routes/api/v1/plugins/internal/[id]/cancel/` `+server.ts` — see
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
            summary: 'Abort a running internal plugin',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: PluginStatusResponseSchema,
                    description: 'Plugin status after abort',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        POST: async (event: RequestEvent) => {
            if (!event.params.pluginId) {
                (event.params as Record<string, string>).pluginId = event.params.id ?? '';
            }

            // Inject { action: 'abort' } as the body.
            const origRequest = event.request;
            const rawBody = (await origRequest.json().catch(() => ({}))) as Record<string, unknown>;
            const body: Record<string, unknown> = { ...rawBody, action: 'abort' };

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
