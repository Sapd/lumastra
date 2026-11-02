// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/plugins/internal/[id]/index.ts
 *
 * GET  /api/v1/plugins/internal/{id} — plugin status (isRunning, progress)
 * POST /api/v1/plugins/internal/{id} — trigger plugin run or abort
 *
 * Per-method auth: GET requires `tasks:admin`, POST requires `tasks:run`. GET
 * WAS `tasks:read` — moved 2026-09-18 fix-plan-4 Task 2, Shape C ruling's
 * five-endpoint sweep; belt-and-braces on top of removing `tasks:read`'s
 * auto-grant to every non-admin session, the load-bearing fix. See
 * defs/library/paths.ts for the full rationale.
 *
 * NOTE: The admin handler reads params.pluginId; we normalize params.id →
 * params.pluginId before delegating, exactly as the hand-written route did.
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/plugins/internal/[id]/`
 * `+server.ts` — see defs/libraries/integrity.ts for the full rationale.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin
 * generated.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import {
    GET as adminGET,
    POST as adminPOST,
} from '../../../../../../../routes/api/admin/plugins/[pluginId]/+server.js';
import { PluginStatusResponseSchema } from '$lib/schemas/api-admin-library-responses';

function normalizeParams(event: RequestEvent): void {
    if (!event.params.pluginId) {
        (event.params as Record<string, string>).pluginId = event.params.id ?? '';
    }
}

export const def = defineEndpoint({
    auth: {
        GET: { kind: 'scope', anyOf: ['tasks:admin'] },
        POST: { kind: 'scope', anyOf: ['tasks:run'] },
    },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin'],
            summary: 'Get internal plugin status',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: PluginStatusResponseSchema,
                    description: 'Plugin status (isRunning, progress)',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
        POST: {
            tags: ['Admin'],
            summary: 'Trigger or abort internal plugin run',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: PluginStatusResponseSchema,
                    description: 'Plugin status after trigger',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        GET: async (event) => {
            normalizeParams(event);
            return delegateToAdmin(event, adminGET!);
        },
        POST: async (event) => {
            normalizeParams(event);
            return delegateToAdmin(event, adminPOST!);
        },
    },
});
