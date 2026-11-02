// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// gen-api-routes: skip
// Composed by users/[id]/devices-revoke-all.ts; preserve the canonical route.

/**
 * defs/admin/devices/all/index.ts
 *
 * DELETE /api/admin/devices/all?username=<user>
 *
 * Revoke ALL DEVICE-class sessions for a user: Jellyfin OAuth device tokens,
 * OAuth refresh tokens, native (browser) sessions, and /j (Jellyfin-compat)
 * live sessions. Deliberately narrower than the full credential fan-out
 * (`revokeAllCredentialsForUser`) used by disable / admin password-reset /
 * self password-change / delete: this endpoint's name and its admin-UI
 * button ("revoke all device sessions") promise only devices, so it must NOT
 * also silently wipe a user's Personal Access Tokens or Subsonic client
 * password — an admin reaching for "sign this user out everywhere" here
 * would otherwise break their API integrations and third-party Subsonic
 * clients with no warning (final fix wave, 2026-09-13). Use the
 * disable/reset-password path when the intent is a full credential wipe.
 *
 * Auth: admin (tokens:admin scope for token-based callers).
 * Surface: internal-only.
 * Response: { username, revoked, failedStores, jellyfinRevoked, oauthRevoked,
 *             nativeSessionsRevoked, jellyfinCompatSessionsRevoked, totalRevoked }
 * `revoked` is true only when every device-class store revoked cleanly;
 * `failedStores` names any that threw inside the best-effort fan-out (still
 * 200 — this is a best-effort sweep, not an all-or-nothing transaction).
 * 503 dependency_unavailable when the DB is down (not gated on device auth).
 * 404 not_found when the user does not exist.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { Logger } from '$lib/server/utils/logger.js';
import { revokeDeviceClassCredentialsForUser } from '$lib/server/services/credential-revocation.service.js';
import { readSessionCookie } from '$lib/server/auth/native-session.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { z } from 'zod';
import { requireAdminCeilingForTarget } from '$lib/server/api/token-minting.js';
import { getUserById } from '$lib/server/database/queries/users.queries.js';
import { toUserId } from '$lib/shared/user-id.js';

const logger = Logger.for('Admin:Devices');

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['users:admin'] },
    visibility: 'internal',
    request: {
        params: z.object({ id: z.string().uuid() }),
    },
    handlers: {
        POST: async (event, ctx) => {
            // Not gated on FEATURE_DEVICE_AUTH: native browser sessions and /j
            // compat sessions exist whether or not the OAuth device flow is
            // on, and the fan-out below revokes each store on its own
            // (admin/users review 2026-10-07, item 8e). With the flag off the
            // OAuth stores simply have nothing to revoke.
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const userId = toUserId(ctx.input?.params.id ?? event.params.id!);
            const user = await getUserById(sql, userId);
            const username = user?.username ?? '';
            if (!user) return ApiProblem.notFound('User not found');
            const ceilingErr = await requireAdminCeilingForTarget(
                event,
                sql,
                user.username,
                "Only administrators can revoke an administrator's devices",
            );
            if (ceilingErr) return ceilingErr;

            // Revoke every DEVICE-class store in one fan-out — native sessions,
            // OAuth refresh tokens, Jellyfin OAuth device tokens, and /j
            // (Jellyfin-compat) live sessions. Deliberately NOT the full
            // revokeAllCredentialsForUser fan-out: see the file docstring for
            // why PATs and the Subsonic token must survive this action.
            // An admin revoking their OWN devices keeps the browser session
            // they are doing it from; otherwise the 200 is followed by a
            // silent sign-out on the next request.
            const isSelf = event.locals.user?.userId === userId;
            const keepSessionToken = isSelf
                ? (readSessionCookie(event.cookies) ?? undefined)
                : undefined;
            const { failedStores, counts } = await revokeDeviceClassCredentialsForUser(
                sql,
                userId,
                username,
                { keepSessionToken },
            );
            if (failedStores.length > 0) {
                logger.warn('Admin revoke-all-devices: some device credential stores failed', {
                    targetUser: username,
                    failedStores,
                });
            }

            const jellyfinRevoked = counts.jellyfin_oauth_tokens ?? 0;
            const oauthRevoked = counts.refresh_tokens ?? 0;
            const nativeSessionsRevoked = counts.native_sessions ?? 0;
            const jellyfinCompatSessionsRevoked = counts.jellyfin_compat_sessions ?? 0;
            const totalRevoked =
                jellyfinRevoked +
                oauthRevoked +
                nativeSessionsRevoked +
                jellyfinCompatSessionsRevoked;

            auditLog('user.devices_revoke_all', username, auditActor(event), {
                totalRevoked,
                failedStores,
                keptOwnSession: keepSessionToken !== undefined,
            });
            logger.info('Admin revoked all device sessions for user', {
                admin: event.locals.principal?.username ?? event.locals.user?.username,
                targetUser: username,
                jellyfinRevoked,
                oauthRevoked,
                nativeSessionsRevoked,
                jellyfinCompatSessionsRevoked,
                totalRevoked,
            });

            return json({ revoked: totalRevoked, failedStores });
        },
    },
});
