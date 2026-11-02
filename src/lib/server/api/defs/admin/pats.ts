// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// gen-api-routes: skip
// Composed by pats.ts, pats-id.ts and users/[id]/pats.ts; never mount by filename.

/**
 * admin/pats — cross-user Personal Access Token management.
 *
 * GET    /api/admin/pats  → list all active PATs (optionally filtered by username/scope)
 * POST   /api/admin/pats  → create a PAT for a specified user
 * DELETE /api/admin/pats  → revoke a PAT by id (admin can revoke any user's token)
 *
 * Feature-gated: FEATURE_USER_PATS (features.userPats) must be enabled, the same flag
 * the /users/{id}/pats mounts check.
 * Auth: tokens:admin scope OR admin session (internal surface only).
 *
 * Response contract:
 *   GET    → { items, page }  (paginate envelope, all active PATs)
 *   POST   → bare { id, token, username, message }  (201)
 *   DELETE → bare { id, revoked, username }
 * Errors: problem+json (incl. 503 dependency_unavailable).
 */

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/index.js';
import { features } from '$lib/server/config.js';
import { getPatService } from '$lib/server/oauth/pat.service.js';
import { jellyfinUserService } from '$lib/server/jellyfin/user.service.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { toUserId } from '$lib/shared/user-id.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    denyUnlessMayMint,
    callerIsAdmin,
    requireAdminCeilingForTargetId,
    MAX_TOKEN_LIFETIME_DAYS,
} from '$lib/server/api/token-minting.js';
import {
    resolveOwnerAdminStatus,
    resolveOwnerAdminStatusById,
} from '$lib/server/auth/resolve-owner-admin-status.js';
import { json } from '@sveltejs/kit';
import {
    patListQuerySchema,
    patCreateBodySchema,
    patRevokeQuerySchema,
} from '$lib/schemas/admin.js';

const logger = Logger.for('AdminPATs');

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['tokens:admin'] },
    visibility: 'internal',
    // GET/DELETE read query params; POST reads body — each handler parses its own
    // inputs to avoid incompatible shared schema across the three methods.
    handlers: {
        GET: async (event, _ctx) => {
            if (!features.userPats) return ApiProblem.notFound('API tokens feature is not enabled');

            const query = patListQuerySchema.safeParse(Object.fromEntries(event.url.searchParams));
            // An invalid filter used to be dropped, answering with EVERY user's
            // tokens to a caller who believed they were filtering.
            if (!query.success) {
                return ApiProblem.validationFailed(
                    query.error.issues.map((i) => ({
                        field: i.path.join('.'),
                        message: i.message,
                    })),
                );
            }
            const filterUserId = query.data.userId ? toUserId(query.data.userId) : undefined;
            const filterScope = query.data.scope;

            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            // Admin ceiling (release review 2026-10-21, finding 3): a
            // tokens:admin delegate sees no administrator's PATs.
            const callerAdmin = await callerIsAdmin(event);
            if (!callerAdmin && filterUserId) {
                const ceilingErr = await requireAdminCeilingForTargetId(
                    event,
                    db,
                    filterUserId,
                    "Only administrators can list an administrator's tokens",
                );
                if (ceilingErr) return ceilingErr;
            }

            const patService = getPatService();
            const filterOptions =
                filterUserId || filterScope
                    ? {
                          ...(filterUserId ? { userId: filterUserId } : {}),
                          ...(filterScope ? { scopes: [filterScope] } : {}),
                      }
                    : undefined;
            let tokens = await patService.listAll(filterOptions);
            if (!callerAdmin) {
                const adminOwner = new Map<string, boolean>();
                for (const t of tokens) {
                    const ownerId = t.owner.userId;
                    if (adminOwner.has(ownerId)) continue;
                    // Fail closed: an unresolvable owner hides the token.
                    const verdict = await resolveOwnerAdminStatusById(db, ownerId).catch(() => ({
                        isAdmin: true,
                    }));
                    adminOwner.set(ownerId, verdict?.isAdmin === true);
                }
                tokens = tokens.filter((t) => adminOwner.get(t.owner.userId) !== true);
            }

            const items = tokens.map((t) => ({
                ...t,
                allowedIps: t.allowedIps ?? null,
                createdAt: t.createdAt.toISOString(),
                expiresAt: t.expiresAt?.toISOString() ?? null,
                lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
                lastUsedIp: t.lastUsedIp,
            }));
            return json(paginate(items, { limit: items.length, offset: 0, hasMore: false }));
        },

        POST: async (event, _ctx) => {
            if (!features.userPats) return ApiProblem.notFound('API tokens feature is not enabled');

            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            let rawBody: unknown;
            try {
                rawBody = await readBoundedJson(event.request);
            } catch {
                return ApiProblem.validationFailed('Invalid JSON body');
            }
            const bodyParse = patCreateBodySchema.safeParse(rawBody);
            if (!bodyParse.success) {
                return ApiProblem.validationFailed(
                    bodyParse.error.issues.map((i) => ({
                        field: i.path.join('.'),
                        message: i.message,
                    })),
                );
            }
            const {
                userId: inputUserId,
                name,
                description,
                scopes,
                expiresInDays,
            } = bodyParse.data;

            // Look up user's id and groups. Match case-insensitively: usernames are
            // resolved case-insensitively everywhere else (login, getUserIdByUsername,
            // the User Management search) — an exact-case match here rejected e.g.
            // typed 'Test' against a stored 'test' with a misleading "user not found".
            if (expiresInDays != null && expiresInDays > MAX_TOKEN_LIFETIME_DAYS) {
                return ApiProblem.validationFailed([
                    {
                        field: 'expiresInDays',
                        message: `Must be at most ${MAX_TOKEN_LIFETIME_DAYS} days`,
                    },
                ]);
            }

            const rows = await db<{ id: string; username: string; groups: string[] | null }[]>`
                SELECT id, username, groups FROM users
                WHERE id = ${inputUserId}
                  AND deleted_at IS NULL
                  AND disabled_at IS NULL
                LIMIT 1
            `;
            // A disabled or deleted owner would get a dead token that becomes
            // live on re-enable, shown to the admin as if it worked.
            if (rows.length === 0) {
                return ApiProblem.validationFailed(
                    `User '${inputUserId}' not found. The user must have logged in at least once.`,
                );
            }
            const targetUserId = toUserId(rows[0].id);
            // Use the canonical stored casing for downstream (response, audit, Jellyfin lookup).
            const targetUsername = rows[0].username;
            const userGroups = rows[0].groups || [];

            // Authorization-of-authorization: this endpoint is reachable with a
            // `tokens:admin` scope alone, and a PAT it mints for an administrator
            // with `admin` scope satisfies deriveIsAdmin() everywhere. A non-admin
            // caller may not mint admin scope, nor any token for an administrator,
            // nor scopes it does not hold itself (security review 2026-09-12, C3).
            // Formula A (pin, IdP groups, in-app groups and the in-app admin
            // capability), as the service-token mint does since security review
            // 2026-09-23 C6: the raw is_admin column is false for an unpinned
            // in-app admin, which let a tokens:admin caller mint for them.
            const targetIsAdmin =
                (await resolveOwnerAdminStatus(db, targetUsername))?.isAdmin === true;
            const denied = await denyUnlessMayMint(event, { scopes, targetIsAdmin });
            if (denied) return denied;

            // Optional: look up Jellyfin user ID
            let jellyfinUserId: string | undefined;
            if (features.jellyfinSync) {
                try {
                    const jellyfinUser = await jellyfinUserService.getUserByName(targetUsername);
                    jellyfinUserId = jellyfinUser?.Id;
                    if (!jellyfinUserId) {
                        logger.warn('Jellyfin user not found during PAT creation', {
                            targetUsername,
                        });
                    }
                } catch (e) {
                    logger.warn('Jellyfin user lookup failed for PAT creation', {
                        targetUsername,
                        error: e,
                    });
                }
            }

            try {
                const patService = getPatService();
                const result = await patService.create({
                    userId: targetUserId,
                    name,
                    description,
                    scopes,
                    groups: userGroups,
                    jellyfinUserId,
                    expiresInDays: expiresInDays ?? null,
                });

                auditLog(
                    'pat.create',
                    targetUsername ||
                        event.locals.principal?.username ||
                        event.locals.user?.username ||
                        'unknown',
                    auditActor(event),
                    { patId: result.id, scopes, expiresInDays },
                );
                return json(
                    {
                        id: result.id,
                        token: result.token,
                        message:
                            'Token created successfully. Copy it now - you will not be able to see it again!',
                    },
                    { status: 201 },
                );
            } catch (error) {
                if (error instanceof Error && error.message.includes('Maximum')) {
                    return ApiProblem.validationFailed(error.message);
                }
                throw error;
            }
        },

        DELETE: async (event, _ctx) => {
            if (!features.userPats) return ApiProblem.notFound('API tokens feature is not enabled');

            const query = patRevokeQuerySchema.safeParse({ id: event.params.id });
            if (!query.success) {
                return ApiProblem.validationFailed(
                    query.error.issues.map((i) => ({
                        field: i.path.join('.'),
                        message: i.message,
                    })),
                );
            }
            const { id } = query.data;

            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');
            // Admin ceiling (release review 2026-10-21, finding 3): resolve the
            // token's owner first; a tokens:admin delegate may not revoke an
            // administrator's PAT.
            const [ownerRow] = await db<{ user_id: string | null }[]>`
                SELECT user_id FROM personal_access_tokens
                WHERE id = ${id} AND revoked_at IS NULL
            `;
            if (ownerRow?.user_id) {
                const ceilingErr = await requireAdminCeilingForTargetId(
                    event,
                    db,
                    ownerRow.user_id,
                    "Only administrators can revoke an administrator's tokens",
                );
                if (ceilingErr) return ceilingErr;
            }

            const patService = getPatService();
            const result = await patService.revokeAsAdmin(id);
            if (!result.revoked) return ApiProblem.notFound('Token');

            auditLog('pat.revoke', result.username ?? 'unknown', auditActor(event), { patId: id });
            return new Response(null, { status: 204 });
        },
    },
});
