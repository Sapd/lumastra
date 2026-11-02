// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/users/[id]/stream-policy.ts
 *
 * GET /api/v1/users/{id}/stream-policy — get effective stream policy for user
 * PUT /api/v1/users/{id}/stream-policy — set user stream policy
 *
 * Requires `users:admin` scope. The delegated admin handler resolves by
 * username (user_stream_policies.user_id stores usernames, not UUIDs); we
 * resolve the UUID to a username first, exactly as the hand-written route did.
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/users/[id]/stream-policy/`
 * `+server.ts` — see defs/libraries/integrity.ts for the full rationale.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin
 * generated.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import { getDb } from '$lib/server/database/index.js';
import { getUserById } from '$lib/server/database/queries/users.queries.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import {
    GET as adminGET,
    PUT as adminPUT,
} from '../../../../../../routes/api/admin/users/[username]/stream-policy/+server.js';
import { StreamPolicySchema, UpdatePolicyRequestSchema } from '$lib/schemas/play-sessions';

async function resolveUsername(event: RequestEvent): Promise<string | Response> {
    const db = getDb();
    if (!db) return ApiProblem.dependencyUnavailable('Database not available');
    const user = await getUserById(db, event.params.id ?? '');
    if (!user) return ApiProblem.notFound('User not found');
    (event.params as Record<string, string>).username = user.username;
    return user.username;
}

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['users:admin'] },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Users'],
            summary: 'Get effective stream policy for a user',
            stability: 'protocol',
            auth: 'bearer',
            responses: {
                200: {
                    schema: StreamPolicySchema,
                    description: 'Effective stream policy for the user',
                },
                401: 'Authentication required',
                404: 'User not found',
                500: 'Internal server error',
            },
        },
        PUT: {
            tags: ['Users'],
            summary: 'Set stream policy for a user',
            stability: 'protocol',
            auth: 'bearer',
            body: UpdatePolicyRequestSchema,
            responses: {
                200: { schema: StreamPolicySchema, description: 'Updated stream policy' },
                401: 'Authentication required',
                404: 'User not found',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        GET: async (event) => {
            const result = await resolveUsername(event);
            if (result instanceof Response) return result;
            return delegateToAdmin(event, adminGET!);
        },
        PUT: async (event) => {
            const result = await resolveUsername(event);
            if (result instanceof Response) return result;
            return delegateToAdmin(event, adminPUT!);
        },
    },
});
