// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/user/profile.ts — GET /me
 *
 * Auth: {kind:'user'} — self-scoped identity endpoint.
 * `user/*` (singular) = self identity; never add {id} to this path.
 * Errors: problem+json.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { z } from 'zod';
import { CallerPermissionsSchema, callerPermissions } from '$lib/schemas/server-info.js';

const UserProfileResponseSchema = z.object({
    id: z.string().uuid(),
    username: z.string(),
    isAdmin: z.boolean(),
    isAgeRestricted: z.boolean(),
    permissions: CallerPermissionsSchema,
    groups: z.array(z.string()),
});

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['User'],
            summary: "Get the authenticated user's profile",
            stability: 'stable',
            auth: 'bearer',
            description:
                "Returns the current user's profile: admin and age-restriction flags, permissions (the same " +
                'object as `caller.permissions` on GET /server) and group memberships. ' +
                'Self-scoped endpoint — always returns data for the authenticated caller.',
            responses: {
                200: {
                    schema: UserProfileResponseSchema,
                    description: 'User profile',
                },
                401: 'Authentication required',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    handlers: {
        /**
         * GET /me
         *
         * Returns the authenticated user's profile information.
         * Response: bare object.
         */
        GET: async (event, _ctx) => {
            const user = event.locals.user;

            return json({
                id: user?.userId,
                username: user?.username,
                isAdmin: event.locals.principal?.isAdmin === true,
                isAgeRestricted: user?.isAgeRestricted ?? false,
                permissions: callerPermissions(user),
                groups: user?.userGroups ?? [],
            });
        },
    },
});
