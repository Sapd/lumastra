// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Shared plumbing for the `/j/Sessions/{sessionId}/…` command routes. */

import { localsIsAdmin } from '$lib/server/auth/locals-admin';
import {
    BODY_TOO_LARGE,
    DEFAULT_MAX_BODY_BYTES,
    readBoundedBodyText,
} from '$lib/server/utils/bounded-body-reader';
import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import { getDb } from '$lib/server/database';
import type { UserContext } from '$lib/server/types';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import type { RemoteDeviceRecord } from './device-registry';
import { resolveControllableTarget } from './commands';
import { resolveNativeTarget, type NativeCommandContext } from './native-devices';

const logger = Logger.for('JellyfinCompat:RemoteControl');

export const noContent = (): Response => new Response(null, { status: 204 });

/**
 * A plain 400, as Jellyfin's model validation answers a missing/invalid
 * parameter (ApiResponses.badRequest maps to 422 in Lumastra's taxonomy).
 */
export function badRequest(message: string): Response {
    return new Response(JSON.stringify({ error: message }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
    });
}

/**
 * Resolve `params.sessionId` to a device the caller may control and run `fn`.
 * Unknown and not-yours both answer 404 (no existence leak).
 *
 * With `native`, a session id that is not a /j device but a native Lumastra
 * device session (see native-devices.ts) runs `native` instead, with the
 * command translated to the device-command registry.
 */
export async function withControllableTarget(
    event: Pick<RequestEvent, 'locals' | 'params'>,
    fn: (ctx: {
        sql: postgres.Sql;
        target: RemoteDeviceRecord;
        caller: UserContext;
    }) => Promise<Response>,
    native?: (ctx: NativeCommandContext) => Promise<Response>,
): Promise<Response> {
    const caller = event.locals.user;
    if (!caller) return ApiResponses.unauthorized();
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');
    const viewer = { userId: caller.userId, ownerIsAdmin: localsIsAdmin(event.locals) };
    const sessionId = (event.params as Record<string, string | undefined>).sessionId ?? '';
    try {
        const target = await resolveControllableTarget(sql, sessionId, viewer);
        if (target) return await fn({ sql, target, caller });
        if (native) {
            const nativeTarget = await resolveNativeTarget(sql, sessionId, viewer);
            if (nativeTarget) {
                return await native({ sql, target: nativeTarget, caller, locals: event.locals });
            }
        }
        return ApiResponses.notFound('Session not found');
    } catch (err) {
        logger.error('Remote-control command failed', err as Error);
        return ApiResponses.error('Remote-control command failed');
    }
}

/** Read a JSON body; null when absent, malformed or over the body cap. */
export async function readJsonBody(request: Request): Promise<unknown> {
    try {
        const text = await readBoundedBodyText(request, DEFAULT_MAX_BODY_BYTES);
        if (text === BODY_TOO_LARGE) return null;
        return text ? (JSON.parse(text) as unknown) : null;
    } catch {
        return null;
    }
}
