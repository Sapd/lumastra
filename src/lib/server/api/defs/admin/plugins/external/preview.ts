// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/plugins/external/preview.ts — POST /api/admin/plugins/external/preview
 *
 * Dry-run an install and report what WOULD happen: the manifest as actually
 * signed, the key that actually verified it, and the host's real verdict on
 * version, publisher continuity and ABI.
 *
 * Performs no writes and does not fetch the bundle. Its value is that every
 * value in the confirmation an operator reads is verified rather than claimed
 * — which matters most once a catalog is advertising plugins, but already
 * upgrades the manual paste-a-URL flow from "install and find out" to "look,
 * then install".
 *
 * Adds no capability: same admin auth, same guards, a strict subset of what
 * install already does.
 */

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader.js';
import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { getDb } from '$lib/server/database/connection.js';
import { previewExternalPlugin } from '$lib/server/plugins/external-install/installer.js';

const PreviewBodySchema = z.object({
    manifestUrl: z.string().url(),
    signature: z.string(),
});

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        POST: async (event: RequestEvent) => {
            const sql = getDb();
            if (!sql) return ApiResponses.error('database unavailable');
            const raw: unknown = await readBoundedJson(event.request).catch(() => ({}));
            const parsed = PreviewBodySchema.safeParse(raw);
            if (!parsed.success) return ApiResponses.badRequest('invalid preview request');
            const result = await previewExternalPlugin(sql, parsed.data);
            return new Response(JSON.stringify(result.body), {
                status: result.status,
                headers: { 'Content-Type': 'application/json' },
            });
        },
    },
});
