// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { denyUnlessInteractiveSession } from '$lib/server/api/token-minting.js';
import { getDb } from '$lib/server/database/connection.js';
import { revokeDeviceClassCredentialsForUser } from '$lib/server/services/credential-revocation.service.js';
import { readSessionCookie } from '$lib/server/auth/native-session.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { RevokeAllDevicesResponseSchema } from '$lib/schemas/devices.js';
export const def = defineEndpoint({
    auth: { kind: 'user' },
    docs: {
        POST: {
            tags: ['Devices'],
            summary: 'Revoke all device sessions',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: RevokeAllDevicesResponseSchema,
                    description: 'Revoked credentials and failed stores',
                },
                403: 'Session required: API tokens and device tokens cannot do this (reason session_required)',
                503: 'Database unavailable',
            },
        },
    },
    handlers: {
        POST: async (event) => {
            const notInteractive = denyUnlessInteractiveSession(event);
            if (notInteractive) return notInteractive;
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            const user = event.locals.user!;
            const { counts, failedStores } = await revokeDeviceClassCredentialsForUser(
                sql,
                user.userId,
                user.username,
                { keepSessionToken: readSessionCookie(event.cookies) ?? undefined },
            );
            const revoked = Object.values(counts).reduce<number>((sum, n) => sum + (n ?? 0), 0);
            // Not gated on FEATURE_DEVICE_AUTH (as the admin twin): native and /j
            // sessions exist without the OAuth device flow. auditActor() records
            // the credential kind, so a service-token principal acting as the
            // user shows up as such.
            auditLog('user.devices_revoke_all', user.username, auditActor(event), {
                totalRevoked: revoked,
                failedStores,
                self: true,
            });
            return Response.json({ revoked, failedStores });
        },
    },
});
