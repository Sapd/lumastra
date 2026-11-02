// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared pieces of the device remote-control defs: who owns a device, who is
 * sending, and how a service error becomes problem+json.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { ApiProblem } from '$lib/server/api/problem.js';
import { denyUnlessInteractiveSession } from '$lib/server/api/token-minting.js';
import { getDb } from '$lib/server/database/connection.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { getHeartbeat } from '$lib/server/services/device-presence.service.js';
import { isDeviceSessionTombstoned } from '$lib/server/oauth/device-session-liveness.js';
import { sanitizeDisplayName } from '$lib/server/utils/display-name.js';
import type {
    CommandSender,
    DeviceCommandError,
} from '$lib/server/services/device-commands.service.js';

export interface DeviceAccess {
    deviceName: string | null;
    ownerUserId: string;
    ownerUsername: string;
    /** True when the caller is a granted helper, not the owner. */
    viaGrant: boolean;
}

/** Credentials that are not a person at the keyboard: they may not change who controls a device. */
const NON_INTERACTIVE_AUTH = new Set([
    'pat',
    'service_token',
    'stream_token',
    'jellyfin_compat_pat',
    'jellyfin_compat_session',
]);

const GRANT_WRITE_RATE_LIMIT = { limit: 10, windowSeconds: 60 };

/**
 * Gate for POST/DELETE `/devices/grants`: a grant hands over the remote of all
 * the owner's devices, so only a signed-in person (web session, forward auth,
 * OAuth app bearer) may change it, not a PAT, service token or media credential;
 * and not faster than 10 changes a minute. `null` = go ahead.
 */
export async function grantWriteGate(event: RequestEvent): Promise<Response | null> {
    // A grant outlives the credential that created it, so no bearer (device
    // JWT included) may change one: interactive session only.
    const notInteractive = denyUnlessInteractiveSession(event);
    if (notInteractive) return notInteractive;
    if (NON_INTERACTIVE_AUTH.has(String(event.locals.authMethod ?? ''))) {
        return ApiProblem.forbidden('Sign in to change who may control your devices');
    }
    const rl = await checkRateLimit(
        `devgrant:${event.locals.user!.userId}`,
        GRANT_WRITE_RATE_LIMIT.limit,
        GRANT_WRITE_RATE_LIMIT.windowSeconds,
    );
    if (!rl.allowed) {
        return ApiProblem.rateLimited(Math.max(1, rl.resetAt - Math.floor(Date.now() / 1000)));
    }
    return null;
}

/**
 * Whether `userId` may remote-control `deviceSessionId`: the device is theirs,
 * or its owner granted them control (`device_control_grants`). Read on every
 * request, so a revoked grant stops working at once. The caller's own device
 * wins when both match. Foreign, ungranted and unknown devices are `null`.
 */
export async function verifyDeviceControlAccess(
    deviceSessionId: string,
    userId: string,
): Promise<DeviceAccess | null | Response> {
    const sql = getDb();
    if (!sql) return ApiProblem.dependencyUnavailable('Database not initialised');
    const rows = await sql<
        { device_name: string | null; owner_id: string; username: string; own: boolean }[]
    >`
		SELECT t.device_name, u.id AS owner_id, u.username, (t.user_id = ${userId}::uuid) AS own
		FROM oauth_refresh_tokens t
		JOIN users u ON u.id = t.user_id
		WHERE t.device_session_id = ${deviceSessionId}
		  AND t.revoked_at IS NULL
		  AND (
		      t.user_id = ${userId}::uuid
		      OR (
		          u.deleted_at IS NULL AND u.disabled_at IS NULL
		          AND EXISTS (
		              SELECT 1 FROM device_control_grants g
		              JOIN users h ON h.id = g.grantee_user_id
		              WHERE g.owner_user_id = t.user_id AND g.grantee_user_id = ${userId}::uuid
		                AND h.deleted_at IS NULL AND h.disabled_at IS NULL
		          )
		      )
		  )
		ORDER BY (t.user_id = ${userId}::uuid) DESC
		LIMIT 1
	`;
    const row = rows[0];
    if (!row) return null;
    return {
        deviceName: row.device_name,
        ownerUserId: String(row.owner_id),
        ownerUsername: row.username,
        viaGrant: !row.own,
    };
}

/** The caller as a command sender. `source` comes from the credential, never the body. */
export async function commandSenderFor(event: RequestEvent): Promise<CommandSender> {
    const { locals } = event;
    const user = locals.user!;
    const automation = locals.authMethod === 'pat' || locals.authMethod === 'service_token';
    const deviceSessionId = locals.deviceSessionId ?? undefined;
    let deviceName: string | undefined;
    if (deviceSessionId) {
        // Shown next to a message on the target device: cleaned like every
        // device name, so it cannot carry hidden or text-direction characters.
        const raw = (await getHeartbeat(deviceSessionId).catch(() => null))?.deviceName;
        deviceName = raw ? sanitizeDisplayName(raw, 64) || undefined : undefined;
    }
    return {
        userId: String(user.userId),
        username: user.username,
        source: automation ? 'automation' : 'app',
        ...(deviceSessionId ? { deviceSessionId } : {}),
        ...(deviceName ? { deviceName } : {}),
    };
}

/**
 * The calling device is `{id}` (its own inbox, results and state): a device JWT
 * (`bearer`) of that very session, not revoked. A stream token also carries a
 * device session id, but it is a media credential, not the device's own.
 */
export function isCallingDevice(event: RequestEvent, deviceSessionId: string | undefined): boolean {
    return (
        Boolean(deviceSessionId) &&
        event.locals.authMethod === 'bearer' &&
        event.locals.deviceSessionId === deviceSessionId &&
        !isDeviceSessionTombstoned(deviceSessionId!)
    );
}

export function deviceCommandProblem(error: DeviceCommandError): Response {
    switch (error.kind) {
        case 'device_unsupported':
        case 'device_unreachable':
        case 'stale_target':
            return ApiProblem.conflict(error.message, { details: error.kind });
        case 'conflict':
            return ApiProblem.conflict(error.message);
        case 'simple_mode_locked':
            return ApiProblem.forbidden(error.message, { details: error.kind });
        case 'forbidden':
            return ApiProblem.forbidden(error.message);
        case 'feature_unavailable':
            return ApiProblem.notFound();
        case 'not_found':
            return ApiProblem.notFound(error.message);
        case 'rate_limited':
            return ApiProblem.rateLimited(error.retryAfter);
        case 'invalid':
            return ApiProblem.validationFailed(error.message);
        case 'unavailable':
            return ApiProblem.dependencyUnavailable(error.message);
    }
}

/** The 404 a foreign or unknown device gets (indistinguishable on purpose). */
export function unknownDevice(): Response {
    return ApiProblem.notFound('Device not found');
}
