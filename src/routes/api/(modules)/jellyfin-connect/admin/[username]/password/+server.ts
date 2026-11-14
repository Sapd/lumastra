// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin Jellyfin Connect Password Management API
 *
 * Lets an admin manage the Jellyfin-compat (`/j`) client password of a TARGET
 * user (help-desk: provision a password for a user who can't, or revoke a
 * compromised one). Mirrors the self-service handler at
 * /api/jellyfin-connect/password but resolves the target from the route param
 * and is admin-gated + audit-logged.
 *
 * Lives under the jellyfin-connect tree (not /api/admin) because it statically
 * imports the jellyfin-compat auth module, which core does not.
 *
 * GET    - Whether the target user has a client password configured
 * POST   - Generate/reset the target's password, returning it once for the admin to relay
 * DELETE - Revoke the target's password
 */

import type { RequestHandler } from './$types';
import { z } from 'zod';
import { typedJson } from '$lib/server/utils/typed-response.js';
import { requireAdmin } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { features } from '$lib/server/config.js';
import {
    getOrCreatePassword,
    resetPassword,
    deletePasswordForUser,
    formatPasswordForDisplay,
} from '$lib/server/jellyfin-compat/auth.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getPasswordByUserId } from '$lib/server/database/queries/jellyfin-client-passwords.queries.js';
import { getUserByUsername } from '$lib/server/database/queries/users.queries.js';
import { auditLog, auditActorFromLocals } from '$lib/server/utils/audit-log.js';

const HasPasswordResponseSchema = z.object({ hasPassword: z.boolean() });
const PasswordResponseSchema = z.object({ password: z.string() });
const SuccessResponseSchema = z.object({ success: z.boolean() });

/** Resolve the target user row (lowercased username) or null. */
async function resolveTarget(
    sql: NonNullable<Awaited<ReturnType<typeof aiDbService.getSql>>>,
    rawUsername: string | undefined,
): Promise<{ id: string; username: string } | null> {
    const username = (rawUsername ?? '').toLowerCase();
    if (!username) return null;
    const row = await getUserByUsername(sql, username);
    return row ? { id: row.id, username } : null;
}

export const GET: RequestHandler = requireAdmin(
    withErrorHandler(async ({ params }) => {
        if (!features.jellyfinCompat) return ApiResponses.notFound('Feature');
        const sql = await aiDbService.getSql();
        if (!sql) return ApiResponses.error('Database unavailable', new Error('No SQL'), 503);

        const target = await resolveTarget(sql, params.username);
        if (!target) return ApiResponses.notFound('User');

        const row = await getPasswordByUserId.one(sql, { userId: target.id });
        return typedJson(HasPasswordResponseSchema, { hasPassword: row !== null });
    }),
);

export const POST: RequestHandler = requireAdmin(
    withErrorHandler(async ({ params, locals }) => {
        if (!features.jellyfinCompat) return ApiResponses.notFound('Feature');
        const sql = await aiDbService.getSql();
        if (!sql) return ApiResponses.error('Database unavailable', new Error('No SQL'), 503);

        const target = await resolveTarget(sql, params.username);
        if (!target) return ApiResponses.notFound('User');

        const existing = await getPasswordByUserId.one(sql, { userId: target.id });
        const plaintext = existing
            ? await resetPassword(target.id)
            : await getOrCreatePassword(target.id);

        auditLog('user.jellyfin_password_reset', target.username, auditActorFromLocals(locals), {
            targetUsername: target.username,
            reset: existing !== null,
        });

        return typedJson(PasswordResponseSchema, { password: formatPasswordForDisplay(plaintext) });
    }),
);

export const DELETE: RequestHandler = requireAdmin(
    withErrorHandler(async ({ params, locals }) => {
        if (!features.jellyfinCompat) return ApiResponses.notFound('Feature');
        const sql = await aiDbService.getSql();
        if (!sql) return ApiResponses.error('Database unavailable', new Error('No SQL'), 503);

        const target = await resolveTarget(sql, params.username);
        if (!target) return ApiResponses.notFound('User');

        await deletePasswordForUser(target.id);
        auditLog('user.jellyfin_password_revoke', target.username, auditActorFromLocals(locals), {
            targetUsername: target.username,
        });

        return typedJson(SuccessResponseSchema, { success: true });
    }),
);
