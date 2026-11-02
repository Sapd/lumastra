// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/admin/providers/health
 *
 * Runs a live connectivity test for a specific provider.
 *
 * Auth: providers:admin. Surface: internal.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ProviderHealthResponseSchema } from '$lib/schemas/api-admin-responses.js';
import { runProviderHealthCheck } from '$lib/server/admin/provider-health.js';

const HealthBodySchema = z.object({
    provider: z.string().min(1),
    /**
     * Unsaved form values keyed by config key (e.g. `SONARRURL`). An empty
     * value or the stored-secret sentinel falls back to the saved setting.
     */
    overrides: z.record(z.string(), z.string().max(4096)).optional(),
});

const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['providers:admin'] },
    visibility: 'internal',
    request: {
        body: HealthBodySchema,
    },
    handlers: {
        POST: async (_event, ctx) => {
            const { provider, overrides } = ctx.input!.body;
            const result = await runProviderHealthCheck(provider, overrides);
            return json(
                ProviderHealthResponseSchema.parse({
                    provider,
                    healthy: result.healthy,
                    checkable: result.checkable,
                    latencyMs: result.latencyMs,
                    error: result.error,
                    rateLimited: result.rateLimited,
                    serverInfo: result.serverInfo,
                }),
            );
        },
    },
});

export const { POST } = mount(def, { surface: 'internal' });
