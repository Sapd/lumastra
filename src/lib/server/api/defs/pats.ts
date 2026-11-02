// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/pats.ts
 *
 * GET    /api/admin/pats?user={username} — list PATs for any user (admin cross-user)
 * POST   /api/admin/pats?user={username} — create PAT on behalf of any user
 * DELETE /api/admin/pats/{id}            — revoke any PAT
 *
 * Gated behind the `FEATURE_USER_PATS` flag, then `tokens:admin` scope.
 * Distinct from self-service GET/POST/DELETE /api/v1/me/pats (no admin scope).
 *
 * Mounted on the internal surface only (`/api/admin/pats`, the admin UI). The
 * public API manages another user's tokens through `/api/v1/users/{id}/pats`.
 */

import { patListQuerySchema, patCreateBodySchema } from '$lib/schemas/admin.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { def as admin } from './admin/pats.js';
import {
    AdminPatListResponseSchema,
    AdminPatCreateResponseSchema,
} from '$lib/schemas/api-user-responses';

export const def = defineEndpoint({
    auth: {
        kind: 'feature',
        flag: 'FEATURE_USER_PATS',
        then: { kind: 'scope', anyOf: ['tokens:admin'] },
    },
    docs: {
        GET: {
            tags: ['User'],
            summary: 'List all PATs across users (admin)',
            query: patListQuerySchema,
            stability: 'beta',
            auth: 'bearer',
            responses: {
                200: {
                    schema: AdminPatListResponseSchema,
                    description: 'Paginated list of all personal access tokens',
                },
                422: 'Invalid filter',
                401: 'Authentication required',
                403: 'Insufficient scope (tokens:admin required)',
                404: 'Feature not enabled',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        POST: {
            tags: ['User'],
            summary: 'Create a PAT for any user (admin)',
            body: patCreateBodySchema,
            stability: 'beta',
            auth: 'bearer',
            responses: {
                201: {
                    schema: AdminPatCreateResponseSchema,
                    description: 'Token created (copy the token value — shown once)',
                },
                401: 'Authentication required',
                403: 'Insufficient scope (tokens:admin required)',
                404: 'Feature not enabled',
                422: 'Validation failed',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        GET: async (event, ctx) => {
            return admin.handlers.GET!(event, { surface: ctx.surface });
        },
        POST: async (event, ctx) => {
            return admin.handlers.POST!(event, { surface: ctx.surface });
        },
    },
});
