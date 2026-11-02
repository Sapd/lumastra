// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { def as admin } from './admin/pats.js';
export const def = defineEndpoint({
    auth: {
        kind: 'feature',
        flag: 'FEATURE_USER_PATS',
        then: { kind: 'scope', anyOf: ['tokens:admin'] },
    },
    request: { params: z.object({ id: z.coerce.number().int().positive() }) },
    docs: {
        DELETE: {
            tags: ['User'],
            summary: 'Revoke a PAT',
            stability: 'beta',
            auth: 'bearer',
            responses: { 204: 'Revoked', 404: 'Token not found', 422: 'Invalid token ID' },
        },
    },
    handlers: {
        DELETE: async (event, ctx) => admin.handlers.DELETE!(event, { surface: ctx.surface }),
    },
});
