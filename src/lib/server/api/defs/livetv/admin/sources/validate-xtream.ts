// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/sources/validate-xtream.ts
 *
 * POST /livetv/admin/sources/validate-xtream
 *   Validate Xtream Codes credentials against a server.
 *   Returns server info on success, or a validation failure reason.
 *
 * Auth: { kind: 'scope', anyOf: ['livetv:admin'] }
 * Response bodies:
 *   { valid: true, serverInfo? }
 *   { valid: false, reason: string }
 *   503 dependency_unavailable when the Xtream server is unreachable
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { validateXtreamCredentials } from '$lib/server/services/livetv/index.js';
import { ValidateXtreamRequestSchema } from '$lib/schemas/livetv.js';
import { ValidateXtreamResponseSchema } from '$lib/schemas/livetv';

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        POST: {
            tags: ['Live TV'],
            summary: 'Validate Xtream Codes credentials',
            stability: 'experimental',
            auth: 'bearer',
            description:
                'Validates Xtream Codes credentials against a server. Returns server info on ' +
                'success or a failure reason. An unreachable server returns ' +
                '`503 dependency_unavailable`.',
            body: ValidateXtreamRequestSchema,
            responses: {
                200: { schema: ValidateXtreamResponseSchema, description: 'Validation result' },
                401: 'Authentication required',
                422: 'Validation failed',
                503: 'Xtream provider unreachable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    request: {
        body: ValidateXtreamRequestSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const { serverUrl, username, password } = ctx.input!.body;

            let result;
            try {
                result = await validateXtreamCredentials({ serverUrl, username, password });
            } catch {
                return ApiProblem.dependencyUnavailable('Xtream provider unreachable');
            }

            if (result.valid) {
                return json({ valid: true, serverInfo: result.serverInfo ?? undefined });
            }

            return json({ valid: false, reason: result.reason ?? 'Validation failed' });
        },
    },
});
