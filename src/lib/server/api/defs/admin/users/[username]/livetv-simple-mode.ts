// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/users/[username]/livetv-simple-mode — set up Live TV simple mode for
 * another user (the senior-friendly Live TV screen).
 *
 * GET /api/admin/users/:username/livetv-simple-mode → LiveTvSimpleMode
 * PATCH /api/admin/users/:username/livetv-simple-mode → partial update, no PIN
 *   needed; `locked: false` removes the lock and its PIN (forgotten-PIN
 *   recovery). `stationIds` replaces the user's favorites.
 *
 * Auth: users:admin scope OR admin session (internal surface only), plus the
 * admin ceiling: a non-admin users:admin token cannot change an admin.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { requireAdminCeilingForTarget } from '$lib/server/api/token-minting.js';
import { getDb } from '$lib/server/database/index.js';
import { getUserIdByUsername } from '$lib/server/database/queries/users.queries.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import {
    LiveTvSimpleModeSchema,
    LiveTvSimpleModeUpdateSchema,
    type LiveTvSimpleModeUpdate,
} from '$lib/schemas/livetv-simple-mode.js';
import {
    getSimpleMode,
    updateSimpleMode,
} from '$lib/server/services/livetv/simple-mode.service.js';
import { simpleModeProblem } from '../../../livetv/simple-mode/errors.js';
import type { UserId } from '$lib/shared/user-id';

const NO_STORE = { 'Cache-Control': 'no-store' };

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['users:admin'] },
    visibility: 'internal',
    docs: {
        GET: {
            tags: ['Live TV'],
            stability: 'beta',
            summary: "Get a user's Live TV simple mode",
            responses: {
                200: { schema: LiveTvSimpleModeSchema, description: 'Simple mode settings' },
                401: 'Authentication required',
                403: 'Admin required',
                404: 'User not found',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        PATCH: {
            tags: ['Live TV'],
            stability: 'beta',
            summary: "Change a user's Live TV simple mode",
            responses: {
                200: { schema: LiveTvSimpleModeSchema, description: 'Updated settings' },
                401: 'Authentication required',
                403: 'Admin required',
                404: 'User or channel not found',
                422: 'Validation failed',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },
    request: { body: LiveTvSimpleModeUpdateSchema },
    handlers: {
        GET: async (event, _ctx) => {
            const username = (event.params.username ?? '').toLowerCase();
            if (!username) return ApiProblem.validationFailed('Missing username');
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');
            const uid = await getUserIdByUsername(db, username);
            if (!uid) return ApiProblem.notFound('User not found');
            return json(await getSimpleMode(db, uid as UserId), { headers: NO_STORE });
        },
        PATCH: async (event, ctx) => {
            const username = (event.params.username ?? '').toLowerCase();
            if (!username) return ApiProblem.validationFailed('Missing username');
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const ceilingErr = await requireAdminCeilingForTarget(
                event,
                db,
                username,
                "Only administrators can change an admin's Live TV simple mode",
            );
            if (ceilingErr) return ceilingErr;

            const uid = await getUserIdByUsername(db, username);
            if (!uid) return ApiProblem.notFound('User not found');
            const actor = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!actor) return ApiProblem.unauthorized();

            const body = ctx.input?.body as LiveTvSimpleModeUpdate | undefined;
            if (!body) return ApiProblem.validationFailed('Missing body');

            const result = await updateSimpleMode(db, uid as UserId, body, {
                actorUserId: actor as UserId,
                asAdmin: true,
            });
            if (!result.ok) return simpleModeProblem(result.error);

            auditLog('user.livetv_simple_mode', username, auditActor(event), {
                enabled: result.value.enabled,
                layout: result.value.layout,
                locked: result.value.locked,
                channels: result.value.stationIds.length,
            });
            return json(result.value, { headers: NO_STORE });
        },
    },
});
