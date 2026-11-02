// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/previews/index.ts
 *
 * GET  /api/admin/previews — admission status (incl. embedded cache stats)
 *                            plus the cache stats surfaced again at the top
 *                            level for convenience.
 * POST /api/admin/previews — operator toggle: `{ disabled: boolean }`.
 *                            Enables/disables previews and returns the fresh
 *                            status snapshot.
 *
 * Auth: admin. Surface: internal-only.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import {
    getPreviewAdmissionStatus,
    setPreviewsAdminDisabled,
} from '$lib/server/services/preview-admission.service.js';

const ToggleBody = z.object({
    disabled: z.boolean(),
});

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: ToggleBody,
    },
    handlers: {
        GET: async (_event, _ctx) => {
            const admission = await getPreviewAdmissionStatus();
            return json({ admission, cache: admission.cache });
        },

        POST: async (_event, ctx) => {
            const { disabled } = ctx.input!.body;
            await setPreviewsAdminDisabled(disabled);
            const admission = await getPreviewAdmissionStatus();
            return json({ admission, cache: admission.cache });
        },
    },
});
