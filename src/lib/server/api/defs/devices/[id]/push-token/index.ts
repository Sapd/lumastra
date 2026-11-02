// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/devices/[id]/push-token — PUT / DELETE
 *
 * Registers the APNs device token for one of the caller's devices.
 *
 * `{id}` is the deviceSessionId, matching how every other device route addresses
 * a device; it is resolved to `user_devices.id` before any write, and a session
 * with no linked device returns 409 rather than silently doing nothing.
 *
 * PUT rather than POST because iOS hands the app a token on every launch, so
 * registration must be idempotent. Registering IS the opt-in and DELETE is the
 * opt-out; there are no per-kind preferences.
 *
 * Auth: feature:DEVICE_AUTH → user. A consequence worth knowing: with
 * FEATURE_DEVICE_AUTH off, push registration is unavailable.
 *
 * No def-level `request.body`: mount() applies a declared body schema to
 * every method that can carry one, including DELETE (see mount.ts
 * `methodCanHaveBody`). `PushTokenRegistrationSchema` has required fields, so
 * declaring it there would reject every DELETE (empty body) before this
 * handler ever runs. PUT validates the body itself instead, mirroring
 * `defs/playlists/[id]/index.ts`.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getDeviceIdForSession,
    getUserDeviceByDeviceId,
    sessionBelongsToUser,
} from '$lib/server/database/queries/user-devices.queries.js';
import {
    upsertPushToken,
    deletePushTokenForDevice,
} from '$lib/server/database/queries/user-push-tokens.queries.js';
import {
    PushTokenRegistrationSchema,
    PushTokenRegistrationResponseSchema,
} from '$lib/schemas/push-notifications.js';
import { Logger } from '$lib/server/utils/logger.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';

const logger = Logger.for('PushTokenDef');

/** Device tokens are credential-shaped; never log one in full. */
function redact(token: string): string {
    return token.length <= 8 ? '***' : `${token.substring(0, 8)}...`;
}

export const def = defineEndpoint({
    docs: {
        PUT: {
            tags: ['Devices'],
            summary: 'Register an APNs device token',
            stability: 'stable',
            auth: 'bearer',
            description:
                "Registers or refreshes the Apple push token for one of the caller's devices. " +
                'Idempotent — call it on every app launch. Registering is the opt-in for push; ' +
                'DELETE is the opt-out. Requires `FEATURE_DEVICE_AUTH`.',
            body: PushTokenRegistrationSchema,
            responses: {
                200: {
                    schema: PushTokenRegistrationResponseSchema,
                    description: 'Token registered',
                },
                401: 'Authentication required',
                404: 'Feature not enabled, or device session not found for this user',
                409: 'Session has no linked device',
                422: 'Invalid body',
                503: 'Database unavailable',
            },
        },
        DELETE: {
            tags: ['Devices'],
            summary: 'Deregister the APNs device token',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Removes every push token for this device. Requires `FEATURE_DEVICE_AUTH`.',
            responses: {
                200: { schema: PushTokenRegistrationResponseSchema, description: 'Token removed' },
                401: 'Authentication required',
                404: 'Feature not enabled, or device session not found for this user',
                409: 'Session has no linked device',
                503: 'Database unavailable',
            },
        },
    },

    auth: {
        kind: 'feature',
        flag: 'DEVICE_AUTH',
        then: { kind: 'user' },
    },
    handlers: {
        PUT: async (event) => {
            const { locals, params } = event;
            const deviceSessionId = params.id;
            if (!deviceSessionId) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Device session id is required' },
                ]);
            }

            let rawBody: unknown;
            try {
                rawBody = await event.request.json();
            } catch {
                return ApiProblem.validationFailed('Request body must be valid JSON');
            }

            const parsedBody = PushTokenRegistrationSchema.safeParse(rawBody);
            if (!parsedBody.success) {
                return ApiProblem.validationFailed(
                    parsedBody.error.issues.map((issue) => ({
                        field: issue.path.join('.'),
                        message: issue.message,
                    })),
                );
            }
            const body = parsedBody.data;

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not initialised');

            const userId = locals.user!.userId;
            const deviceId = await getDeviceIdForSession(sql, userId, deviceSessionId);
            if (!deviceId) {
                const owned = await sessionBelongsToUser(sql, userId, deviceSessionId);
                // 404 rather than 403 — do not confirm another user's session exists.
                if (!owned) return ApiProblem.notFound('Device session not found');
                return ApiProblem.conflict(
                    'This session is not linked to a device. Sign in again from the device.',
                );
            }

            // `deviceId` above is `oauth_refresh_tokens.device_id` — the
            // CLIENT-GENERATED TEXT id. `user_push_tokens.device_id` is a uuid
            // FK to `user_devices.id`. The two share a name and nothing else;
            // handing the text id straight to the write blows up on the uuid
            // cast for every real client. See the "two device_id columns"
            // section in migration 16.200.0.
            const device = await getUserDeviceByDeviceId(sql, userId, deviceId);
            if (!device) {
                return ApiProblem.conflict(
                    'This session is not linked to a device. Sign in again from the device.',
                );
            }

            const result = await upsertPushToken(sql, {
                userId,
                deviceId: device.id,
                token: body.token,
                bundleId: body.bundleId,
                environment: body.environment,
                locale: body.locale ?? null,
                payloadVersion: body.payloadVersion,
            });

            // Last-registrant-wins is the documented design (a device handed to
            // another person must re-register the same token under the new
            // account, spec `2026-08-11-apns-push-design.md:157-161`) — this is
            // NOT refused. `previousUserId` is only non-null when a different
            // user held the row, so this fires on a genuine cross-user rebind
            // and never on a same-user re-registration or a first registration.
            if (result.previousUserId) {
                auditLog('push_token.rebind', result.id, auditActor(event), {
                    previousUserId: result.previousUserId,
                    newUserId: userId,
                    previousWasActive: result.previousWasActive,
                });
            }

            logger.info('Push token registered', {
                username: locals.user!.username,
                deviceSessionId: deviceSessionId.substring(0, 8) + '...',
                bundleId: body.bundleId,
                environment: body.environment,
                token: redact(body.token),
            });

            return json({
                deviceSessionId,
                // The client-facing `deviceId` stays the client-generated id the
                // rest of the device routes speak, NOT the internal uuid.
                deviceId,
                environment: body.environment,
                registered: true,
            });
        },

        DELETE: async (event) => {
            const { locals, params } = event;
            const deviceSessionId = params.id;
            if (!deviceSessionId) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Device session id is required' },
                ]);
            }

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not initialised');

            const userId = locals.user!.userId;
            const deviceId = await getDeviceIdForSession(sql, userId, deviceSessionId);
            if (!deviceId) {
                const owned = await sessionBelongsToUser(sql, userId, deviceSessionId);
                if (!owned) return ApiProblem.notFound('Device session not found');
                return ApiProblem.conflict('This session is not linked to a device.');
            }

            // Text client id → internal uuid, same hop as PUT. See the comment
            // there: `user_push_tokens.device_id` is a uuid FK, not this string.
            const device = await getUserDeviceByDeviceId(sql, userId, deviceId);
            if (!device) {
                return ApiProblem.conflict('This session is not linked to a device.');
            }

            // Read back the environment BEFORE deleting so the response can report
            // it honestly — deletePushTokenForDevice only returns a row count.
            // Falls back to 'production' (the schema field is required) when there
            // was nothing to delete.
            const [existing] = await sql<{ environment: 'sandbox' | 'production' }[]>`
                SELECT environment FROM user_push_tokens
                WHERE user_id = ${userId} AND device_id = ${device.id}
                ORDER BY last_seen_at DESC
                LIMIT 1
            `;

            const removed = await deletePushTokenForDevice(sql, userId, device.id);
            logger.info('Push token deregistered', {
                username: locals.user!.username,
                deviceSessionId: deviceSessionId.substring(0, 8) + '...',
                removed,
            });

            return json({
                deviceSessionId,
                deviceId,
                environment: existing?.environment ?? 'production',
                registered: false,
            });
        },
    },
});
