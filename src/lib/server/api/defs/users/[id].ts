// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as m from '$lib/paraglide/messages.js';
/**
 * users/{id} — per-user management.
 *
 * GET   /users/{id}   read one user              (users:admin)
 * PATCH /users/{id}   update user attributes      (users:admin)
 *
 * {id} is a stable users.id UUID (username is display-only).
 *
 * PATCH body fields (all optional):
 *   isAdmin?: boolean          — pin admin status (true/false; a boolean can only pin)
 *   maxAgeRating?: number|null — override max age rating (null = unpin)
 *   disabled?: boolean         — disable or re-enable the account
 *   email?: string             — unique SSO matching email; empty string clears it (send alone)
 *
 * DELETE (GDPR erasure + interactive confirm) stays session-only.
 * Note: users:admin only — scope anyOf so a token with only users:read cannot mutate.
 *
 * Admin ceiling (security review 2026-09-13, C1): `users:admin` is a
 * fine-grained, non-admin-equivalent delegation scope. Setting `isAdmin: true`
 * requires the caller to already be an administrator (`requireAdminCeiling()`),
 * judged from the credential that passed the OUTER auth gate. Demotion
 * (`isAdmin: false`) keeps its existing self- and last-admin guards.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import {
    requireAdminCeiling,
    requireAdminCeilingForTarget,
} from '$lib/server/api/token-minting.js';
import { getDb } from '$lib/server/database/index.js';
import { getUserById } from '$lib/server/database/queries/users.queries.js';
import {
    setDisabled,
    setUserAdmin,
    setUserAgeRating,
    setUserAllowLiveTv,
    setUserEmail,
} from '$lib/server/services/admin-user.service.js';
import { auditActor } from '$lib/server/utils/audit-log.js';
import { mapUserToApi } from '$lib/server/mappers/user.mapper.js';
import { ApiUserSchema } from '$lib/schemas/api-user-responses.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { AdminUserEmailSchema } from '$lib/schemas/admin-user.js';

// GET + PATCH both return mapUserToApi output — declare the canonical 24-field
// schema instead of a hand-duplicated 7-field copy.
const UserDetailResponseSchema = z.object({
    user: ApiUserSchema,
});

const PatchUserBodySchema = z.object({
    email: AdminUserEmailSchema.optional().describe(
        'Unique matching email; empty string clears it',
    ),
    isAdmin: z
        .boolean()
        .optional()
        .meta({ description: 'Pin admin status (true/false); a boolean can only pin' }),
    maxAgeRating: z
        .number()
        .nullable()
        .optional()
        .meta({ description: 'Override max age rating (null = unpin)' }),
    allowLiveTv: z
        .boolean({ error: () => m.admin_users_live_tv_invalid() })
        .optional()
        .describe('Allow this user to access Live TV'),
    disabled: z.boolean().optional().meta({ description: 'Disable or re-enable the account' }),
});

const PatchUserBody = z
    .object({
        email: AdminUserEmailSchema.optional(),
        isAdmin: z.boolean().optional(),
        maxAgeRating: z.number().int().min(0).max(21).nullable().optional(),
        disabled: z.boolean().optional(),
        allowLiveTv: z.boolean({ error: () => m.admin_users_live_tv_invalid() }).optional(),
    })
    .superRefine((data, ctx) => {
        if (data.email !== undefined && Object.keys(data).length !== 1) {
            ctx.addIssue({ code: 'custom', message: m.admin_users_email_separate() });
        }
    })
    .refine((d) => Object.keys(d).length > 0, { message: 'At least one field must be provided' });

const UserIdParams = z.object({
    id: z.string().min(1, 'User ID is required'),
});

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Users'],
            summary: 'Get a user',
            stability: 'stable',
            auth: 'bearer',
            description: 'Returns a single user by their UUID. Requires `users:admin` scope.',
            responses: {
                200: {
                    schema: UserDetailResponseSchema,
                    description: 'User details',
                },
                400: 'Invalid user ID',
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'User not found',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        PATCH: {
            tags: ['Users'],
            summary: 'Update user attributes',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Updates user attributes: `isAdmin`, `maxAgeRating`, `disabled`, or `email` (send email changes separately). ' +
                'At least one field must be provided. Requires `users:admin` scope. ' +
                'Setting `isAdmin: true` additionally requires the caller to already ' +
                'be an administrator — `users:admin` alone cannot grant admin status. ' +
                'Setting or clearing an email requires an administrator for every account. ' +
                "Setting `isAdmin: false` also narrows the user's admin-scoped Personal " +
                'Access Tokens and any service-token impersonation grants targeting them so ' +
                'they can no longer pass an admin-scope check (their non-admin scopes, ' +
                'other tokens, and sessions are left untouched).',
            body: PatchUserBodySchema,
            responses: {
                200: {
                    schema: UserDetailResponseSchema,
                    description: 'Updated user',
                },
                400: 'Validation error',
                409: 'Email already belongs to another user',
                401: 'Authentication required',
                403: 'Insufficient scope, cannot remove last admin, or caller is not an administrator (granting admin or changing any email)',
                404: 'User not found',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: {
        GET: { kind: 'scope', anyOf: ['users:admin'] },
        PATCH: { kind: 'scope', anyOf: ['users:admin'] },
    },
    request: {
        params: UserIdParams,
        body: PatchUserBody,
    },
    handlers: {
        GET: async (event, _ctx) => {
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const id = event.params.id ?? '';
            if (!id) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'User ID is required' },
                ]);
            }

            const user = await getUserById(db, id);
            if (!user) return ApiProblem.notFound('User not found');

            return json({ user: mapUserToApi(user as Parameters<typeof mapUserToApi>[0]) });
        },

        PATCH: async (event, ctx) => {
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const id = event.params.id ?? '';

            // Body already validated by mount(); ctx.input!.body is typed + stripped.
            const user = await getUserById(db, id);
            if (!user) return ApiProblem.notFound('User not found');

            const { isAdmin, maxAgeRating, disabled, allowLiveTv, email } = ctx.input!.body;

            // Check sensitive account changes before applying any field. An email
            // match can grant SSO access to the target, so it shares the admin ceiling.
            if (email !== undefined) {
                const ceilingErr = await requireAdminCeiling(
                    event,
                    m.admin_users_email_admin_only(),
                );
                if (ceilingErr) return ceilingErr;
            }
            if (disabled !== undefined) {
                const ceilingErr = await requireAdminCeilingForTarget(
                    event,
                    db,
                    user.username,
                    'Only administrators can disable or re-enable an admin account',
                );
                if (ceilingErr) return ceilingErr;
            }
            const actingUsername =
                event.locals.principal?.username ?? event.locals.user?.username ?? '';
            const actingUserId = event.locals.principal?.userId ?? event.locals.user?.userId;

            if (email !== undefined) {
                const result = await setUserEmail(db, {
                    targetUsername: user.username,
                    email,
                    actor: auditActor(event),
                });
                if (!result.ok) {
                    if (result.status === 409) return ApiProblem.conflict(result.message);
                    if (result.status === 400) return ApiProblem.validationFailed(result.message);
                    if (result.status === 404) return ApiProblem.notFound(result.message);
                    return ApiProblem.internalError(result.message);
                }
            }

            if (isAdmin !== undefined) {
                // Admin ceiling (security review 2026-09-13, C1): users:admin is a
                // non-admin delegation scope — granting admin requires the caller
                // to already be an administrator. Demotion is unaffected.
                if (isAdmin) {
                    const ceilingErr = await requireAdminCeiling(
                        event,
                        'Only administrators can grant admin status',
                    );
                    if (ceilingErr) return ceilingErr;
                }

                // Self-demotion guard, last-admin guard (in-app-aware), the
                // write, credential narrow/restore, cache invalidation, and
                // the audit row all live in setUserAdmin() now — one function
                // shared with the admin/users/[username] def (security review
                // 2026-09-23, C3 residual + Shape B; also fixes a latent
                // last-admin gap: this def used to gate the guard on
                // `user.is_admin` alone, so an in-app-group-only admin being
                // the last effective admin was never checked).
                const result = await setUserAdmin(db, {
                    targetUsername: user.username,
                    actingUsername,
                    actingUserId,
                    change: { kind: 'set', value: isAdmin },
                    actor: auditActor(event),
                });
                if (!result.ok) {
                    if (result.status === 409) return ApiProblem.conflict(result.message);
                    if (result.status === 400) return ApiProblem.validationFailed(result.message);
                    if (result.status === 404) return ApiProblem.notFound('User not found');
                    return ApiProblem.internalError(result.message);
                }
            }

            if (allowLiveTv !== undefined) {
                const result = await setUserAllowLiveTv(db, {
                    targetUsername: user.username,
                    allowed: allowLiveTv,
                    actor: auditActor(event),
                });
                if (!result.ok) return ApiProblem.notFound('User not found');
            }

            if (maxAgeRating !== undefined) {
                // `null` is a real unpin (security review 2026-09-23, R1
                // residual): the documented contract ("null = unpin") used to
                // pin the column to NULL instead of clearing the pin.
                // setUserAgeRating() also invalidates user-max-age-cache
                // (cross-replica) and writes the audit row — this def used to
                // do neither (C3).
                const change =
                    maxAgeRating === null
                        ? ({ kind: 'unpin' } as const)
                        : ({ kind: 'set', value: maxAgeRating } as const);
                const result = await setUserAgeRating(db, {
                    targetUsername: user.username,
                    change,
                    actor: auditActor(event),
                });
                if (!result.ok) {
                    if (result.status === 404) return ApiProblem.notFound('User not found');
                    return ApiProblem.internalError(result.message);
                }
            }

            if (disabled !== undefined) {
                const result = await setDisabled(db, {
                    targetUsername: user.username,
                    disabled,
                    actingUsername: actingUsername || 'api',
                    actor: auditActor(event),
                });
                if (!result.ok) {
                    if (result.status === 409) return ApiProblem.conflict(result.message);
                    if (result.status === 400) return ApiProblem.validationFailed(result.message);
                    return ApiProblem.internalError(result.message);
                }
            }

            const updated = await getUserById(db, id);
            if (!updated) return ApiProblem.notFound('User not found after update');

            return json({ user: mapUserToApi(updated as Parameters<typeof mapUserToApi>[0]) });
        },
    },
});
