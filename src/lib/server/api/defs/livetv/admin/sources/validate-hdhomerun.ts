// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/sources/validate-hdhomerun.ts
 *
 * POST /livetv/admin/sources/validate-hdhomerun
 *   Validate an HDHomeRun device by IP address.
 *   Returns device info on success, or a validation failure reason.
 *
 * Auth: { kind: 'scope', anyOf: ['livetv:admin'] }
 * Response bodies:
 *   { valid: true, deviceInfo: { friendlyName, modelNumber, deviceId, tunerCount } }
 *   { valid: false, reason: string }
 *   503 dependency_unavailable when the device is unreachable
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { validateHdHomeRunDevice } from '$lib/server/services/livetv/index.js';
import { ValidateHdHomeRunRequestSchema } from '$lib/schemas/livetv.js';
import { ValidateHdHomeRunResponseSchema } from '$lib/schemas/livetv';

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        POST: {
            tags: ['Live TV'],
            summary: 'Validate an HDHomeRun device',
            stability: 'experimental',
            auth: 'bearer',
            description:
                'Validates an HDHomeRun device by IP. Returns device info on success or a failure ' +
                'reason. An unreachable device returns `503 dependency_unavailable`.',
            body: ValidateHdHomeRunRequestSchema,
            responses: {
                200: { schema: ValidateHdHomeRunResponseSchema, description: 'Validation result' },
                401: 'Authentication required',
                422: 'Validation failed',
                503: 'HDHomeRun device unreachable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    request: {
        body: ValidateHdHomeRunRequestSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const { deviceIp } = ctx.input!.body;

            let result;
            try {
                result = await validateHdHomeRunDevice(deviceIp);
            } catch {
                return ApiProblem.dependencyUnavailable('HDHomeRun device unreachable');
            }

            if (result.valid) {
                return json({
                    valid: true,
                    deviceInfo: {
                        friendlyName: result.deviceInfo.friendlyName,
                        modelNumber: result.deviceInfo.modelNumber,
                        deviceId: result.deviceInfo.deviceId,
                        tunerCount: result.deviceInfo.tunerCount,
                    },
                });
            }

            return json({ valid: false, reason: result.reason });
        },
    },
});
