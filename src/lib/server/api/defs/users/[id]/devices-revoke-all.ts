// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { defineEndpoint } from '$lib/server/api/define.js';
import { def as admin } from '../../admin/devices/all/index.js';
import { RevokeAllDevicesResponseSchema } from '$lib/schemas/devices.js';
export const def = defineEndpoint({
    auth: admin.auth,
    request: admin.request,
    docs: {
        POST: {
            tags: ['Devices'],
            summary: 'Revoke all of a user’s device sessions',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: RevokeAllDevicesResponseSchema,
                    description: 'Revoked credentials and failed stores',
                },
                404: 'User not found',
                422: 'Invalid user ID',
            },
        },
    },
    handlers: { POST: admin.handlers.POST! },
});
