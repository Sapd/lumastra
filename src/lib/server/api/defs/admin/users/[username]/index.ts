// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as m from '$lib/paraglide/messages.js';
/**
 * admin/users/[username] — per-user management (username-keyed, SPA surface).
 *
 * PATCH  /api/admin/users/:username  — update admin status, age rating, or disabled flag
 * DELETE /api/admin/users/:username  — GDPR Art. 17 hard-erasure (interactive confirm)
 *
 * Auth: users:admin scope OR admin session.
 * Scope: internal only (dashboard BFF; not published to the v1 spec).
 *
 * Response contract:
 *   PATCH  → bare { username, ... } (varies by field patched)
 *   DELETE → bare { username, deleted, erasure }
 * Errors: problem+json (incl. 503 dependency_unavailable, 409 conflict, 422 validation_failed).
 *
 * Admin ceiling (security review 2026-09-13, C1; extended fix round 1,
 * 2026-09-23): `users:admin` is a fine-grained, non-admin-equivalent
 * delegation scope. Both PATCH `isAdmin: true` and PATCH `unpin: true` (an
 * unpin can itself be a promotion, when the target's IdP groups grant admin)
 * require the caller to already be an administrator (`requireAdminCeiling()`),
 * judged from the credential that passed the OUTER auth gate — so a
 * `users:admin` token cannot promote its own owner (or anyone else) to full
 * admin, directly or by unpinning. Demotion keeps its existing self- and
 * last-admin guards.
 *
 * Admin write orchestration (security review 2026-09-23, Shape B): the
 * `isAdmin` and `unpin` branches both call `setUserAdmin()` in
 * `admin-user.service.ts` (shared with `defs/users/[id].ts`), which owns the
 * last-admin guard, the write, admin-scoped credential narrow/restore (see
 * `narrowAdminScopedCredentialsForUser()`/`restoreAdminScopedCredentialsForUser()`
 * in `credential-revocation.service.ts` — without these, a demoted admin's
 * own `admin`-scoped PAT or an admin-scoped service token impersonating them
 * kept full `{kind:'scope'}` admin-plane access forever, since `setIsAdmin()`/
 * `unpinAdmin()` only ever touch `is_admin`/`admin_pinned`), cache
 * invalidation, and the audit row.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import {
    requireAdminCeiling,
    requireAdminCeilingForTarget,
} from '$lib/server/api/token-minting.js';
import { getDb } from '$lib/server/database/index.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import {
    setDisabled,
    deleteUser,
    setUserAgeRating,
    setUserAdmin,
    setUserAllowLiveTv,
} from '$lib/server/services/admin-user.service.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { getClientIpStrict } from '$lib/server/utils/client-ip.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

/** Highest age rating the admin UI accepts (UserDetailDrawer's 0-21 range). */
const MAX_AGE_RATING = 21;

const PatchUserBody = z
    .object({
        isAdmin: z.boolean().optional(),
        unpin: z.boolean().optional(),
        maxAgeRating: z.number().int().min(0).max(MAX_AGE_RATING).nullable().optional(),
        unpinAgeRating: z.boolean().optional(),
        disabled: z.boolean().optional(),
        allowLiveTv: z.boolean({ error: () => m.admin_users_live_tv_invalid() }).optional(),
    })
    // The handler applies exactly one action and returns its result, so a
    // body carrying two would silently drop the second. Reject it instead.
    .refine(
        (d) =>
            [
                d.isAdmin !== undefined,
                d.unpin === true,
                d.maxAgeRating !== undefined,
                d.unpinAgeRating === true,
                d.disabled !== undefined,
                d.allowLiveTv !== undefined,
            ].filter(Boolean).length <= 1,
        { message: 'Send one change per request' },
    )
    .refine((d) => !(d.unpin && d.isAdmin !== undefined), {
        message: 'Cannot set isAdmin and unpin simultaneously',
    })
    .refine((d) => !(d.unpinAgeRating && d.maxAgeRating !== undefined), {
        message: 'Cannot set maxAgeRating and unpinAgeRating simultaneously',
    });

const DeleteUserBody = z.object({
    confirmUsername: z.string().min(1, 'confirmUsername is required'),
});

/** Per-admin rate limit for the GDPR erasure endpoint: 3 requests per 5 minutes. */
const DELETE_RATE_LIMIT = { limit: 3, windowSeconds: 300 };

// ---------------------------------------------------------------------------
// Endpoint def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['users:admin'] },
    visibility: 'internal',
    // Each method has a different body schema; handlers parse their own bodies
    // rather than using a shared ctx.input.body to avoid union-schema confusion.
    handlers: {
        PATCH: async (event, _ctx) => {
            const username = (event.params.username ?? '').toLowerCase();
            if (!username) return ApiProblem.validationFailed('Missing username');

            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            let body: unknown;
            try {
                body = await event.request.json();
            } catch {
                return ApiProblem.validationFailed('Invalid JSON body');
            }

            const parse = PatchUserBody.safeParse(body);
            if (!parse.success) {
                return ApiProblem.validationFailed(
                    parse.error.issues.map((i) => ({
                        field: i.path.join('.'),
                        message: i.message,
                    })),
                );
            }
            const {
                isAdmin,
                unpin,
                maxAgeRating,
                unpinAgeRating: doUnpinAge,
                disabled,
                allowLiveTv,
            } = parse.data;

            const actingUsername =
                event.locals.principal?.username ?? event.locals.user?.username ?? '';
            const actingUserId = event.locals.principal?.userId ?? event.locals.user?.userId;

            if (allowLiveTv !== undefined) {
                const result = await setUserAllowLiveTv(db, {
                    targetUsername: username,
                    allowed: allowLiveTv,
                    actor: auditActor(event),
                });
                if (!result.ok) return ApiProblem.notFound();
                return json(result.data);
            }

            // Disable / re-enable
            if (disabled !== undefined) {
                const ceilingErr = await requireAdminCeilingForTarget(
                    event,
                    db,
                    username,
                    'Only administrators can disable or re-enable an admin account',
                );
                if (ceilingErr) return ceilingErr;

                const result = await setDisabled(db, {
                    targetUsername: username,
                    disabled,
                    actingUsername,
                    actor: auditActor(event),
                });
                if (!result.ok) {
                    if (result.status === 409) return ApiProblem.conflict(result.message);
                    if (result.status === 400) return ApiProblem.validationFailed(result.message);
                    return ApiProblem.internalError(result.message);
                }
                return json({ username, disabled });
            }

            // Unpin admin
            if (unpin === true) {
                // Admin ceiling (security review 2026-09-23, fix round 1 new
                // finding): unpinning hands control back to IdP groups, which
                // can itself be a PROMOTION when those groups grant admin — a
                // delegated `users:admin` token must not be able to trigger
                // that any more than it can send `{isAdmin:true}` directly.
                const ceilingErr = await requireAdminCeiling(
                    event,
                    'Only administrators can grant admin status',
                );
                if (ceilingErr) return ceilingErr;

                const result = await setUserAdmin(db, {
                    targetUsername: username,
                    actingUsername,
                    actingUserId,
                    change: { kind: 'unpin' },
                    actor: auditActor(event),
                });
                if (!result.ok) {
                    if (result.status === 409) return ApiProblem.conflict(result.message);
                    if (result.status === 400) return ApiProblem.validationFailed(result.message);
                    if (result.status === 404)
                        return ApiProblem.notFound(`User '${username}' not found`);
                    return ApiProblem.internalError(result.message);
                }
                return json(result.data);
            }

            // Unpin age rating
            if (doUnpinAge === true) {
                const result = await setUserAgeRating(db, {
                    targetUsername: username,
                    change: { kind: 'unpin' },
                    actor: auditActor(event),
                });
                if (!result.ok) {
                    if (result.status === 404)
                        return ApiProblem.notFound(`User '${username}' not found`);
                    return ApiProblem.internalError(result.message);
                }
                return json(result.data);
            }

            // Set age rating
            if (maxAgeRating !== undefined) {
                // The cache invalidation below is also what makes a lowered
                // cap take effect immediately on the user's live `/j` session
                // (security review C9, 2026-09-15/16): the session branch in
                // jellyfin-compat/middleware.ts resolves permissions via
                // resolveTokenUserAccess() on every request, which reads
                // max_age_rating through this SAME cache. It also publishes
                // to the auth-cache-bus (fix round 1, Important 2) so a
                // sibling replica's `/j` session sees the change too.
                const result = await setUserAgeRating(db, {
                    targetUsername: username,
                    change: { kind: 'set', value: maxAgeRating },
                    actor: auditActor(event),
                });
                if (!result.ok) {
                    if (result.status === 404)
                        return ApiProblem.notFound(`User '${username}' not found`);
                    return ApiProblem.internalError(result.message);
                }
                return json(result.data);
            }

            // Toggle admin (pin)
            if (isAdmin === undefined) {
                return ApiProblem.validationFailed(m.admin_users_change_required());
            }

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

            const result = await setUserAdmin(db, {
                targetUsername: username,
                actingUsername,
                actingUserId,
                change: { kind: 'set', value: isAdmin },
                actor: auditActor(event),
            });
            if (!result.ok) {
                if (result.status === 409) return ApiProblem.conflict(result.message);
                if (result.status === 400) return ApiProblem.validationFailed(result.message);
                if (result.status === 404)
                    return ApiProblem.notFound(`User '${username}' not found`);
                return ApiProblem.internalError(result.message);
            }
            return json(result.data);
        },

        DELETE: async (event, _ctx) => {
            const username = (event.params.username ?? '').toLowerCase();
            if (!username) return ApiProblem.validationFailed('Missing username');

            let body: unknown;
            try {
                body = await event.request.json();
            } catch {
                return ApiProblem.validationFailed('Invalid JSON body');
            }

            const parse = DeleteUserBody.safeParse(body);
            if (!parse.success) {
                return ApiProblem.validationFailed(
                    parse.error.issues.map((i) => ({
                        field: i.path.join('.'),
                        message: i.message,
                    })),
                );
            }
            const { confirmUsername } = parse.data;
            if (confirmUsername.toLowerCase() !== username) {
                return ApiProblem.validationFailed(
                    'confirmUsername does not match the target username',
                );
            }

            // Per-admin rate limit
            const actingAdmin =
                event.locals.principal?.username ?? event.locals.user?.username ?? 'unknown';
            const ip = getClientIpStrict(event);
            const rateLimitKey = `gdpr-delete:${ip}:${actingAdmin}`;
            const rl = await checkRateLimit(
                rateLimitKey,
                DELETE_RATE_LIMIT.limit,
                DELETE_RATE_LIMIT.windowSeconds,
            );
            if (!rl.allowed) {
                return ApiProblem.rateLimited(
                    Math.max(0, rl.resetAt - Math.floor(Date.now() / 1000)),
                );
            }

            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const ceilingErr = await requireAdminCeilingForTarget(
                event,
                db,
                username,
                'Only administrators can delete an admin account',
            );
            if (ceilingErr) return ceilingErr;

            const result = await deleteUser(db, {
                targetUsername: username,
                actingUsername: actingAdmin,
            });
            if (!result.ok) {
                if (result.status === 409) return ApiProblem.conflict(result.message);
                if (result.status === 400) return ApiProblem.validationFailed(result.message);
                return ApiProblem.internalError(result.message);
            }
            auditLog('user.delete', username, auditActor(event), {
                targetUsername: username,
                totalDeleted: result.data.totalDeleted,
                totalAnonymized: result.data.totalAnonymized,
            });
            return json({
                username,
                deleted: true,
                erasure: {
                    totalDeleted: result.data.totalDeleted,
                    totalAnonymized: result.data.totalAnonymized,
                    tables: result.data.tables,
                },
            });
        },
    },
});
