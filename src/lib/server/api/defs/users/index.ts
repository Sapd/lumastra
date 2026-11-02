// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * users/ — user management collection.
 *
 * GET  /users           list all users           (users:admin)
 * POST /users           create a native user      (users:admin)
 *
 * Auth: users:admin (token) OR admin session.
 * User DELETE stays session-only (GDPR erasure requires interactive confirm).
 *
 * Response contract: bare { items, page } for GET; bare { user, warnings? } + 201 for POST.
 * Error contract: problem+json.
 *
 * Admin ceiling (security review 2026-09-13, C1): `users:admin` is a
 * fine-grained, non-admin-equivalent delegation scope. Creating a user with
 * `isAdmin: true` requires the caller to already be an administrator
 * (`requireAdminCeiling()`), judged from the credential that passed the OUTER
 * auth gate.
 */

import { createHash } from 'node:crypto';
import * as m from '$lib/paraglide/messages.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { requireAdminCeiling } from '$lib/server/api/token-minting.js';
import { getDb } from '$lib/server/database/index.js';
import { listUsers } from '$lib/server/database/queries/users.queries.js';
import { mapUserToApi } from '$lib/server/mappers/user.mapper.js';
import { createUser } from '$lib/server/services/admin-user.service.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { AdminUserEmailSchema } from '$lib/schemas/admin-user.js';
import { ApiUserSchema } from '$lib/schemas/api-user-responses.js';

// GET list items are mapUserToApi output — use the canonical 24-field schema.
const UsersListResponseSchema = z.object({
    items: z.array(ApiUserSchema),
    page: z.object({
        limit: z.number().int(),
        offset: z.number().int(),
        hasMore: z.boolean(),
    }),
});

const CreateUserBodySchema = z.object({
    username: z.string().min(1).max(64),
    email: AdminUserEmailSchema.optional().describe(
        'Optional unique email for verified-email SSO linking',
    ),
    password: z.string().min(8),
    isAdmin: z.boolean().optional().meta({ description: 'Default: false' }),
});

// POST returns only what createUser() produces — { id, username, isAdmin } — not the
// full user record. Derive that exact subset from the canonical schema so there
// is still a single source of truth for the user shape.
const CreateUserResponseSchema = z.object({
    user: ApiUserSchema.pick({ id: true, username: true, isAdmin: true }),
    warnings: z
        .array(z.enum(['native_login_disabled']))
        .optional()
        .describe('Account created but built-in login is disabled'),
});

const CreateUserBody = z.object({
    username: z.string().min(1).max(64),
    email: AdminUserEmailSchema.optional().describe(
        'Optional unique email for verified-email SSO linking',
    ),
    password: z.string().min(8),
    isAdmin: z.boolean().optional().default(false),
});

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Users'],
            summary: 'List users',
            stability: 'stable',
            auth: 'bearer',
            description: 'Returns all user accounts. Requires `users:admin` scope.',
            responses: {
                200: {
                    schema: UsersListResponseSchema,
                    description: 'User list',
                },
                401: 'Authentication required',
                403: 'Insufficient scope (requires users:admin)',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        POST: {
            tags: ['Users'],
            summary: 'Create a native user',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Creates a new native user account with username/password authentication. ' +
                'Requires `users:admin` scope. Creating an admin account ' +
                '(`isAdmin: true`) additionally requires the caller to already be an ' +
                'administrator — `users:admin` alone cannot create an admin. ' +
                'Setting an email also requires an administrator, for every target account.',
            body: CreateUserBodySchema,
            responses: {
                201: {
                    schema: CreateUserResponseSchema,
                    description: 'User created',
                },
                400: 'Validation error',
                409: 'Username or email already belongs to another user',
                401: 'Authentication required',
                403: 'Insufficient scope, or caller is not an administrator (creating an admin or setting an email)',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: {
        GET: { kind: 'scope', anyOf: ['users:admin'] },
        POST: { kind: 'scope', anyOf: ['users:admin'] },
    },
    request: {
        body: CreateUserBody,
    },
    handlers: {
        GET: async (_event, _ctx) => {
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const users = await listUsers(db);
            return json(
                paginate(
                    users.map((row) => mapUserToApi(row as Parameters<typeof mapUserToApi>[0])),
                    {
                        limit: users.length,
                        offset: 0,
                        hasMore: false,
                    },
                ),
            );
        },

        POST: async (event, ctx) => {
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            // Body already validated by mount(); ctx.input!.body is typed + stripped.
            const { username, password, isAdmin, email } = ctx.input!.body;

            // Admin ceiling (security review 2026-09-13, C1): users:admin is a
            // non-admin delegation scope — creating an admin requires the caller
            // to already be an administrator.
            if (email !== undefined) {
                const ceilingErr = await requireAdminCeiling(
                    event,
                    m.admin_users_email_admin_only(),
                );
                if (ceilingErr) return ceilingErr;
            }
            if (isAdmin) {
                const ceilingErr = await requireAdminCeiling(
                    event,
                    'Only administrators can create an admin account',
                );
                if (ceilingErr) return ceilingErr;
            }

            const result = await createUser(db, { username, password, isAdmin, email });

            if (!result.ok) {
                if (result.status === 409) {
                    return ApiProblem.conflict(result.message);
                }
                if (result.status === 400) {
                    return ApiProblem.validationFailed(result.message);
                }
                return ApiProblem.internalError(result.message);
            }

            auditLog('user.create', username.toLowerCase(), auditActor(event), {
                isAdmin: isAdmin === true,
                ...(email !== undefined
                    ? {
                          emailHash: email
                              ? createHash('sha256')
                                    .update(email.trim().toLowerCase())
                                    .digest('hex')
                              : null,
                      }
                    : {}),
            });
            return json({ user: result.data, warnings: result.warnings }, { status: 201 });
        },
    },
});
