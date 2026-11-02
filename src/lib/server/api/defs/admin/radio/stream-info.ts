// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/radio/stream-info.ts
 *
 * POST /api/admin/radio/stream-info
 *   Reads what a stream announces about itself (`icy-name`, `icy-genre`,
 *   `icy-description`, `icy-url`) so the create form can prefill a new
 *   station. Only the response headers are read.
 *
 * Auth: admin.  Surface: internal.
 * Scope: { kind: 'admin' } — internal admin BFF; no v1 surface.
 *
 * POST response: bare RadioStreamInfo object; `reachable: false` when the
 * stream could not be reached (private address, timeout, upstream error).
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { getStreamInfo } from '$lib/server/services/icy-metadata.service.js';
import { RadioStreamInfoRequestSchema, RadioStreamInfoSchema } from '$lib/schemas/radio.js';

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: RadioStreamInfoRequestSchema,
    },
    handlers: {
        POST: async (_event, ctx) => {
            const info = await getStreamInfo(ctx.input!.body.streamUrl);
            return json(
                RadioStreamInfoSchema.parse(
                    info ? { reachable: true, ...info } : { reachable: false },
                ),
            );
        },
    },
});
