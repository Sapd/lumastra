// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DELETE /play-sessions/{id} — cancellation without a progress report
 *
 * Owner-or-admin stop of a single play session. Reuses killSessionUnified;
 * a self-cancel (killedBy === owner_username) skips the 120s kick cooldown so
 * the user can immediately start a fresh within-limit stream.
 *
 * Auth: authenticated user, then ownership. VOD additionally requires
 * media:write; Live TV follows its authenticated-user leave contract.
 * Non-owner non-admin → 404 (existence-leak convention), NOT 403.
 * Response: 204 No Content on success.
 */

import { cancelLiveTvPlaybackSession } from '$lib/server/services/livetv-active-sessions.service.js';
import { enforce } from '$lib/server/api/mount.js';
import { z } from 'zod';
import type { RequestEvent } from '@sveltejs/kit';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { getSessionById } from '$lib/server/database/queries/play-sessions.queries.js';
import { killSessionUnified } from '$lib/server/services/session-kill.service.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';

const CancelIdParams = z.object({ id: z.string().guid() });

export const cancellationDef = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'public',
    docs: {
        DELETE: {
            tags: ['Play Sessions'],
            summary: 'Cancel a playback session',
            stability: 'stable',
            auth: 'bearer',
            description: 'Owner or admin can end the session and free its stream slot.',
            responses: {
                204: 'Session cancelled',
                401: 'Authentication required',
                404: 'Session not found or not owned',
            },
        },
    },
    request: { params: CancelIdParams },
    handlers: {
        DELETE: (event, ctx) =>
            cancelPlaybackSession(event, ctx.input?.params?.id ?? event.params.id),
    },
});

export async function cancelPlaybackSession(
    event: RequestEvent,
    sessionId?: string,
): Promise<Response> {
    const sql = await aiDbService.getSql();
    if (!sql) return ApiResponses.error('Database unavailable');

    const userId = event.locals.user?.userId;
    if (!userId) return ApiResponses.unauthorized();

    if (!sessionId || !isUuid(sessionId)) return ApiResponses.notFound('Session');
    const session = await getSessionById(sql, sessionId);

    if (!session) {
        return (
            (await cancelLiveTvPlaybackSession(event, sessionId)) ??
            ApiResponses.notFound('Session')
        );
    }
    const isOwner = !!session && session.user_id === userId;
    const isAdmin = event.locals.principal?.isAdmin === true;
    // 404 (not 403) for both missing and not-owned-non-admin — no existence leak.
    if (!session || (!isOwner && !isAdmin)) {
        return ApiResponses.notFound('Session');
    }

    const denied = await enforce({ kind: 'scope', anyOf: ['media:write'] }, event);
    if (denied) return denied;

    const cancelledBy = event.locals.principal?.username ?? event.locals.user?.username ?? 'user';
    const result = await killSessionUnified(sql, sessionId, cancelledBy);
    if (!result) return ApiResponses.notFound('Session');

    const auditAction = isOwner ? 'play_session.self_cancel' : 'play_session.cancel';
    auditLog(auditAction, sessionId, auditActor(event));
    return new Response(null, { status: 204 });
}
