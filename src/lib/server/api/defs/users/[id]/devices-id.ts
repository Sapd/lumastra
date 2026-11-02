// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { revokeUserDeviceSession } from '../../admin/devices/index.js';
export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['users:admin'] },
    request: { params: z.object({ id: z.string().uuid(), deviceSessionId: z.string().min(1) }) },
    docs: {
        DELETE: {
            tags: ['Devices'],
            summary: 'Revoke a user’s device session',
            stability: 'stable',
            auth: 'bearer',
            responses: { 204: 'Revoked', 404: 'Device not found', 422: 'Invalid ID' },
        },
    },
    handlers: {
        DELETE: async (event) => revokeUserDeviceSession(event),
    },
});
