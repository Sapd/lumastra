// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/proxy/reconnect.ts
 *
 * POST /livetv/admin/proxy/reconnect
 *   Kill channel upstream so viewers re-trigger join on next heartbeat,
 *   causing the proxy to open a fresh upstream connection.
 *   Only available when LIVETV_SOURCE === 'standalone'.
 *
 * Auth: { kind: 'scope', anyOf: ['livetv:admin'] }
 * Body: { channelId: string }
 * Response: { reconnected: true }  (bare object)
 *   422 validation_failed when not in standalone mode
 *   503 dependency_unavailable when the proxy is unreachable
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { config } from '$lib/server/config.js';
import { getStreamProxyClient } from '$lib/server/services/livetv/stream-proxy-client.js';
import { ProxyReconnectRequestSchema } from '$lib/schemas/livetv.js';
import { ProxyReconnectedResponseSchema } from '$lib/schemas/livetv';

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        POST: {
            tags: ['Live TV'],
            summary: 'Trigger proxy reconnect for a channel',
            stability: 'beta',
            auth: 'bearer',
            responses: {
                200: {
                    schema: ProxyReconnectedResponseSchema,
                    description: 'Proxy reconnect triggered',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    request: {
        body: ProxyReconnectRequestSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            if (config.LIVETV_SOURCE !== 'standalone') {
                return ApiProblem.validationFailed(
                    'Proxy actions are only available in standalone mode',
                );
            }

            const { channelId } = ctx.input!.body;
            const client = getStreamProxyClient();

            try {
                await client.killChannel(channelId);
                return json({ reconnected: true });
            } catch {
                return ApiProblem.dependencyUnavailable('Stream proxy unreachable');
            }
        },
    },
});
