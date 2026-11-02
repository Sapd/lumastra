// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/simple-mode/index.ts — GET/PATCH /livetv/simple-mode
 *
 * The caller's own Live TV simple mode (senior-friendly Live TV screen).
 * GET returns defaults (off) for a user who never set it up.
 * PATCH is a partial update. A locked setup needs `pin` for every change:
 * 403 `details: pin_required` / `pin_invalid`, 429 after too many attempts.
 * `stationIds` replaces the caller's favorites (set and order).
 *
 * Auth: feature:FEATURE_LIVETV → user, plus the inline Live TV permission
 * check (same as /livetv/favorites).
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    LiveTvSimpleModeSchema,
    LiveTvSimpleModeUpdateSchema,
    type LiveTvSimpleModeUpdate,
} from '$lib/schemas/livetv-simple-mode.js';
import {
    getSimpleMode,
    updateSimpleMode,
} from '$lib/server/services/livetv/simple-mode.service.js';
import { simpleModeProblem } from './errors.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';

const NO_STORE = { 'Cache-Control': 'no-cache, no-store, must-revalidate' };

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Live TV'],
            stability: 'beta',
            summary: 'Get your Live TV simple mode',
            responses: {
                200: { schema: LiveTvSimpleModeSchema, description: 'Simple mode settings' },
                401: 'Authentication required',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        PATCH: {
            tags: ['Live TV'],
            stability: 'beta',
            summary: 'Change your Live TV simple mode',
            responses: {
                200: { schema: LiveTvSimpleModeSchema, description: 'Updated settings' },
                401: 'Authentication required',
                404: 'Unknown channel',
                422: 'Validation failed',
                429: 'Too many PIN attempts',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },
    auth: { kind: 'feature', flag: 'FEATURE_LIVETV', then: { kind: 'user' } },
    request: { body: LiveTvSimpleModeUpdateSchema },
    handlers: {
        GET: async (event, _ctx) => {
            const { locals } = event;
            if (!locals.user?.hasLiveTvPermission) {
                return ApiProblem.notFound();
            }
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is unavailable');
            return json(await getSimpleMode(sql, locals.user.userId), { headers: NO_STORE });
        },
        PATCH: async (event, ctx) => {
            const { locals } = event;
            if (!locals.user?.hasLiveTvPermission) {
                return ApiProblem.notFound();
            }
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is unavailable');
            const body = ctx.input?.body as LiveTvSimpleModeUpdate | undefined;
            if (!body) return ApiProblem.validationFailed('Missing body');

            const result = await updateSimpleMode(sql, locals.user.userId, body, {
                actorUserId: locals.user.userId,
                asAdmin: false,
            });
            if (!result.ok) return simpleModeProblem(result.error);
            if (body.locked !== undefined || body.newPin !== undefined || body.enabled === false) {
                auditLog('user.livetv_simple_mode', locals.user.username, auditActor(event), {
                    enabled: result.value.enabled,
                    locked: result.value.locked,
                    pinChanged: body.newPin !== undefined,
                });
            }
            return json(result.value, { headers: NO_STORE });
        },
    },
});
