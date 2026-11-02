// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/proxy/status.ts
 *
 * GET /livetv/admin/proxy/status
 *   Returns stream proxy status and active connections.
 *   Only available when LIVETV_SOURCE === 'standalone'.
 *
 * Auth: { kind: 'scope', anyOf: ['livetv:admin'] }
 * Response: ProxyStatus (bare object — passed through from getStreamProxyClient)
 *   422 validation_failed when not in standalone mode
 *   503 dependency_unavailable when the proxy is unreachable
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { config } from '$lib/server/config.js';
import { getStreamProxyClient } from '$lib/server/services/livetv/stream-proxy-client.js';
import { ProxyStatusResponseSchema } from '$lib/schemas/livetv';

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Live TV'],
            summary: 'Get live TV proxy status',
            stability: 'beta',
            auth: 'bearer',
            responses: {
                200: {
                    schema: ProxyStatusResponseSchema,
                    description: 'Proxy health, channels, and per-source limits',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    handlers: {
        GET: async () => {
            if (config.LIVETV_SOURCE !== 'standalone') {
                return ApiProblem.validationFailed(
                    'Proxy monitoring is only available in standalone mode',
                );
            }

            try {
                const status = await getStreamProxyClient().getProxyStatus();
                return json(status as unknown as Record<string, unknown>);
            } catch {
                return ApiProblem.dependencyUnavailable(
                    `Stream proxy unreachable at ${config.STREAM_PROXY_URL || '(not configured)'}`,
                );
            }
        },
    },
});
