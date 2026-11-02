// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Shared admin device read/revoke implementation. Lists use {items,page};
 * member revocations are mounted at /users/{id}/devices/{deviceSessionId} and return 204. */

import { z } from 'zod';
import type { RequestEvent } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { DevicesListResponseSchema } from '$lib/schemas/devices.js';
import { parsePagination } from '$lib/server/utils/pagination.js';
import { toUserId } from '$lib/shared/user-id.js';
import { getUserById } from '$lib/server/database/queries/users.queries.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { getUserDevices } from '$lib/server/services/user-devices.service.js';
import { features } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { requireAdminCeilingForTarget } from '$lib/server/api/token-minting.js';
import { revokeDeviceSession } from '$lib/server/oauth/device-session-revocation.js';

const logger = Logger.for('Admin:Devices');

// ---------------------------------------------------------------------------
// Typed shapes
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['users:admin'] },
    visibility: 'internal',
    request: {
        query: z.object({
            userId: z.string().uuid(),
        }),
    },
    handlers: {
        GET: async (event, _ctx) => {
            if (!features.deviceAuth) {
                return ApiProblem.dependencyUnavailable('Device auth is not enabled');
            }

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const userId = toUserId(event.params.id ?? event.url.searchParams.get('userId')!);
            const user = await getUserById(sql, userId);
            if (!user) return ApiProblem.notFound('User not found');
            // Admin ceiling: a users:admin-only delegation token must not read an
            // administrator's devices.
            const ceilingErr = await requireAdminCeilingForTarget(
                event,
                sql,
                user.username,
                "Only administrators can view an administrator's devices",
            );
            if (ceilingErr) return ceilingErr;

            // Single read model — see services/user-devices.service.ts. Reads no
            // Jellyfin table, so an admin sees the same names the user sees.
            let sessions = await getUserDevices(sql, userId, { withPresence: true });
            if (event.url.searchParams.get('onlineOnly') === 'true')
                sessions = sessions.filter((s) => s.isOnline);
            if (event.url.searchParams.get('watchTogether') === 'true')
                sessions = sessions.filter((s) => s.supportsWatchTogether);
            const { limit, offset } = parsePagination(event.url, {
                defaultLimit: 50,
                maxLimit: 200,
            });

            return json(
                DevicesListResponseSchema.parse({
                    items: sessions.slice(offset, offset + limit),
                    page: {
                        limit,
                        offset,
                        hasMore: sessions.length > offset + limit,
                        total: sessions.length,
                    },
                }),
            );
        },

    },
});

export async function revokeUserDeviceSession(
    event: RequestEvent,
): Promise<Response> {
            if (!features.deviceAuth) {
                return ApiProblem.dependencyUnavailable('Device auth is not enabled');
            }

            const deviceSessionId = event.params.deviceSessionId;
            if (!deviceSessionId) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Device session ID is required' },
                ]);
            }

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const userId = toUserId(event.params.id ?? event.url.searchParams.get('userId')!);
            const user = await getUserById(sql, userId);
            const username = user?.username ?? '';
            if (!user) return ApiProblem.notFound('Device session not found');
            const ceilingErr = await requireAdminCeilingForTarget(
                event,
                sql,
                user.username,
                "Only administrators can revoke an administrator's devices",
            );
            if (ceilingErr) return ceilingErr;

            // Existence and revocation come from core state only. A device session is
            // an OAuth session; whether Jellyfin also holds a token for it is an
            // implementation detail of an optional integration and must not decide
            // whether this endpoint finds or revokes the session.
            // Revokes under the session lock and cuts off the device's access
            // JWTs and stream tokens. An already-revoked session still gets the
            // idempotent cut-off (retry cleanup) and then answers 404 as before.
            const { revokedCount } = await revokeDeviceSession(sql, deviceSessionId, { userId });
            if (revokedCount === 0) {
                return ApiProblem.notFound('Device session not found');
            }

            // Optional integration cleanup — lazily imported and failure-tolerant so
            // that on an install without Jellyfin this costs nothing and can never
            // fail the core revoke.
            let jellyfinRevoked = false;
            try {
                const { getJellyfinTokenService } =
                    await import('$lib/server/oauth/jellyfin-token.service.js');
                jellyfinRevoked = await getJellyfinTokenService().revoke(deviceSessionId, userId);
            } catch (error) {
                logger.warn('Jellyfin token cleanup failed; core session was still revoked', {
                    deviceSessionId: deviceSessionId.substring(0, 8) + '...',
                    error: String(error),
                });
            }

            auditLog('user.device_revoke', username, auditActor(event), {
                deviceSessionId: deviceSessionId.substring(0, 8),
                jellyfinRevoked,
            });
            logger.info('Admin revoked device session', {
                admin: event.locals.principal?.username ?? event.locals.user?.username,
                targetUser: username,
                deviceSessionId: deviceSessionId.substring(0, 8) + '...',
            });

            return new Response(null, { status: 204 });
        
}
