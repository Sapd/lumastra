// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/users/[id]/identities.ts
 *
 * GET    /api/v1/users/{id}/identities — list IdP identities for a user
 * DELETE /api/v1/users/{id}/identities — unlink an IdP identity
 *
 * Requires `users:admin` scope. The delegated admin handler resolves by
 * username; we resolve UUID to username first, exactly as the hand-written
 * route did.
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/users/[id]/identities/`
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
    DELETE as adminDELETE,
} from '../../../../../../routes/api/admin/users/[username]/identities/+server.js';
import {
    UserIdentitiesResponseSchema,
    UserIdentityUnlinkResponseSchema,
} from '$lib/schemas/api-user-responses';

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
        GET: {
            tags: ['Users'],
            summary: 'List federated identities for a user (admin)',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: UserIdentitiesResponseSchema,
                    description: 'Federated identities and Jellyfin mapping for the user',
                },
                401: 'Authentication required',
                403: 'Insufficient scope (users:admin required)',
                404: 'User not found',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        DELETE: {
            tags: ['Users'],
            summary: 'Unlink a federated identity from a user (admin)',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: UserIdentityUnlinkResponseSchema,
                    description: 'Identity unlinked',
                },
                401: 'Authentication required',
                403: 'Insufficient scope (users:admin required)',
                404: 'User or identity not found',
                409: 'Cannot unlink: would leave user with no login methods',
                503: 'Database unavailable',
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
        DELETE: async (event) => {
            const result = await resolveUsername(event);
            if (result instanceof Response) return result;
            return delegateToAdmin(event, adminDELETE!);
        },
    },
});
