// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/plugins/internal/[id]/settings.ts
 *
 * GET /api/v1/plugins/internal/{id}/settings — get plugin settings
 * PUT /api/v1/plugins/internal/{id}/settings — update plugin settings
 *
 * Requires `tasks:admin` scope. Normalizes params.id → params.pluginId before
 * delegating, exactly as the hand-written route did.
 *
 * Schema source: $lib/schemas/api-admin-responses (single source of truth,
 * mirrors the schemas in the admin def at defs/admin/plugins/[pluginId]/settings.ts
 * — the route delegates to that admin handler).
 *
 * Phase 3 port of the hand-written
 * `src/routes/api/v1/plugins/internal/[id]/settings/` `+server.ts` — see
 * defs/libraries/integrity.ts for the full rationale.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin
 * generated.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import {
    GET as adminGET,
    PUT as adminPUT,
} from '../../../../../../../routes/api/admin/plugins/[pluginId]/settings/+server.js';
import {
    PluginSettingsGetResponseSchema,
    PluginSettingsPutResponseSchema,
} from '$lib/schemas/api-admin-responses';

function normalizeParams(event: RequestEvent): void {
    if (!event.params.pluginId) {
        (event.params as Record<string, string>).pluginId = event.params.id ?? '';
    }
}

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin'],
            summary: 'Get internal plugin settings',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: PluginSettingsGetResponseSchema,
                    description: 'Plugin settings and schema',
                },
                401: 'Authentication required',
                404: 'Plugin not found',
                500: 'Internal server error',
            },
        },
        PUT: {
            tags: ['Admin'],
            summary: 'Update internal plugin settings',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: { schema: PluginSettingsPutResponseSchema, description: 'Settings updated' },
                401: 'Authentication required',
                404: 'Plugin not found',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        GET: async (event) => {
            normalizeParams(event);
            return delegateToAdmin(event, adminGET!);
        },
        PUT: async (event) => {
            normalizeParams(event);
            return delegateToAdmin(event, adminPUT!);
        },
    },
});
