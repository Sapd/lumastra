// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/simple-mode/verify-pin.ts — POST /livetv/simple-mode/verify-pin
 *
 * Checks the lock PIN of the caller's simple mode, so a client can open the
 * setup (or leave simple mode on this device) after one PIN prompt. 204 when
 * right or when there is no lock; 403 `details: pin_invalid`; 429 after too
 * many attempts (shared counter with PATCH /livetv/simple-mode).
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    LiveTvSimpleModePinCheckSchema,
    type LiveTvSimpleModePinCheck,
} from '$lib/schemas/livetv-simple-mode.js';
import { verifySimpleModePin } from '$lib/server/services/livetv/simple-mode.service.js';
import { simpleModeProblem } from './errors.js';

export const def = defineEndpoint({
    docs: {
        POST: {
            tags: ['Live TV'],
            stability: 'beta',
            summary: 'Check your Live TV simple mode PIN',
            responses: {
                204: 'PIN is right (or simple mode is not locked)',
                401: 'Authentication required',
                404: 'Live TV not available',
                403: 'Wrong PIN (details pin_invalid) or no Live TV permission',
                422: 'Validation failed',
                429: 'Too many PIN attempts',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },
    auth: { kind: 'feature', flag: 'FEATURE_LIVETV', then: { kind: 'user' } },
    request: { body: LiveTvSimpleModePinCheckSchema },
    handlers: {
        POST: async (event, ctx) => {
            const { locals } = event;
            if (!locals.user?.hasLiveTvPermission) {
                return ApiProblem.notFound();
            }
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is unavailable');
            const body = ctx.input?.body as LiveTvSimpleModePinCheck | undefined;
            if (!body) return ApiProblem.validationFailed('Missing body');
            const result = await verifySimpleModePin(sql, locals.user.userId, body.pin);
            if (!result.ok) return simpleModeProblem(result.error);
            return new Response(null, { status: 204 });
        },
    },
});
