// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { DevicesListResponseSchema } from '$lib/schemas/devices.js';
import { def as admin } from '../../admin/devices/index.js';
export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['users:admin'] },
    request: {
        params: z.object({ id: z.string().uuid() }),
        query: z.object({
            limit: z.coerce.number().int().optional(),
            offset: z.coerce.number().int().optional(),
            onlineOnly: z.enum(['true', 'false']).optional(),
            watchTogether: z.enum(['true', 'false']).optional(),
        }),
    },
    docs: {
        GET: {
            tags: ['Devices'],
            summary: 'List a user’s devices',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: DevicesListResponseSchema,
                    description: 'Device sessions with presence',
                },
                404: 'User not found',
                422: 'Invalid user ID',
            },
        },
    },
    handlers: { GET: async (event, ctx) => admin.handlers.GET!(event, { surface: ctx.surface }) },
});
