// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/integrations/keys/[id].ts
 *
 *   GET /api/v1/integrations/keys/{id}  — check if an integration key is set (presence + last 4)
 *   PUT /api/v1/integrations/keys/{id}  — store an integration key (write-only; never returns secret)
 *
 * `{id}` is a closed enum: tmdb | openai | voyage | jellyseerr | radarr | sonarr.
 *
 * Security contract: GET returns presence + last-4 chars only — never the full key.
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/integrations/keys/[id]/`
 * `+server.ts`, which did its own inline `enforce({kind:'scope',
 * anyOf:['providers:admin']})` gate shared by both methods. Behaviour is
 * preserved exactly — mount() runs the SAME enforce() with the SAME AuthSpec
 * before each handler; the inline `gate()` helper is no longer needed and has
 * been dropped.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { saveConfig } from '$lib/server/config/config.service.js';
import { get as getConfigValue } from '$lib/server/config/config.service.js';
import { isRecord, toStringOr } from '$lib/utils/data-extraction.js';

/** Mapping from integration ID to config key. */
const KEY_MAP: Record<string, string> = {
    tmdb: 'TMDB_API_KEY',
    openai: 'OPENAI_API_KEY',
    voyage: 'VOYAGE_API_KEY',
};

const MAX_KEY_LENGTH = 4096;

function resolveConfigKey(id: string): string | null {
    return KEY_MAP[id] ?? null;
}

const IntegrationKeyStatusSchema = z
    .object({
        id: z.string().describe('Integration key identifier'),
        set: z.boolean().describe('Whether the key has been configured'),
        last4: z.string().nullable().describe('Last 4 characters of the key (null when not set)'),
    })
    .meta({
        id: 'IntegrationKeyStatus',
        description: 'Integration key presence (never returns the full value)',
    });

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['providers:admin'] },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin'],
            summary: 'Get integration key status',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: IntegrationKeyStatusSchema,
                    description: 'Key presence and last 4 characters (value never returned)',
                },
                401: 'Authentication required',
                404: 'Unknown integration key id',
                500: 'Internal server error',
            },
        },
        PUT: {
            tags: ['Admin'],
            summary: 'Store an integration key',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                204: 'Key stored (no body returned — key is never echoed back)',
                401: 'Authentication required',
                404: 'Unknown integration key id',
                422: 'Validation failed',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        GET: async (event) => {
            const id = event.params.id ?? '';
            const configKey = resolveConfigKey(id);
            if (!configKey) {
                return ApiProblem.notFound(`Unknown integration key id: ${id}`);
            }

            const value = getConfigValue(configKey as never) as string | undefined;
            const set = Boolean(value);
            const last4 = set && value ? value.slice(-4) : null;

            return json({ id, set, last4 });
        },

        PUT: async (event) => {
            const id = event.params.id ?? '';
            const configKey = resolveConfigKey(id);
            if (!configKey) {
                return ApiProblem.notFound(`Unknown integration key id: ${id}`);
            }

            let body: unknown;
            try {
                body = await event.request.json();
            } catch {
                return ApiProblem.validationFailed([
                    { field: 'body', message: 'Invalid request body' },
                ]);
            }
            if (!isRecord(body)) {
                return ApiProblem.validationFailed([
                    { field: 'body', message: 'Expected JSON object' },
                ]);
            }

            const key = toStringOr(body.key, '').trim();
            if (!key) {
                return ApiProblem.validationFailed([{ field: 'key', message: 'key is required' }]);
            }
            if (key.length > MAX_KEY_LENGTH) {
                return ApiProblem.validationFailed([{ field: 'key', message: 'key is too long' }]);
            }

            await saveConfig({ [configKey]: key });

            // 204 No Content — security contract: never echo the key back
            return new Response(null, { status: 204 });
        },
    },
});
