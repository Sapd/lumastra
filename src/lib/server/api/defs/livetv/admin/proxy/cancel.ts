// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/proxy/cancel.ts
 *
 * POST /livetv/admin/proxy/cancel
 *   Cancel/kill proxy stream connection(s).
 *   - When viewerId is present: kick that specific viewer from the channel.
 *   - When viewerId is absent: kill entire channel upstream (removes all viewers).
 *   Canonical path is "cancel" (replaces legacy "kill").
 *   Only available when LIVETV_SOURCE === 'standalone'.
 *
 * Auth: { kind: 'scope', anyOf: ['livetv:admin'] }
 * Body: { channelId: string; viewerId?: string }
 * Response: { cancelled: true }  (bare object)
 *   422 validation_failed when not in standalone mode
 *   503 dependency_unavailable when the proxy is unreachable
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { config } from '$lib/server/config.js';
import { getStreamProxyClient } from '$lib/server/services/livetv/stream-proxy-client.js';
import { ProxyKillRequestSchema } from '$lib/schemas/livetv.js';
import { ProxyCancelledResponseSchema } from '$lib/schemas/livetv';

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        POST: {
            tags: ['Live TV'],
            summary: 'Cancel (kill) a proxy connection',
            stability: 'beta',
            auth: 'bearer',
            responses: {
                200: {
                    schema: ProxyCancelledResponseSchema,
                    description: 'Proxy connection cancelled',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    request: {
        body: ProxyKillRequestSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            if (config.LIVETV_SOURCE !== 'standalone') {
                return ApiProblem.validationFailed(
                    'Proxy actions are only available in standalone mode',
                );
            }

            const { channelId, viewerId } = ctx.input!.body;
            const client = getStreamProxyClient();

            try {
                if (viewerId) {
                    await client.leaveChannel(channelId, viewerId);
                } else {
                    await client.killChannel(channelId);
                }
                return json({ cancelled: true });
            } catch {
                return ApiProblem.dependencyUnavailable('Stream proxy unreachable');
            }
        },
    },
});
