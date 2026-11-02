// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/plugins/external/install.ts — POST /api/admin/plugins/external/install
 *
 * Internal admin BFF (cookie/session, auth:{kind:'admin'}) twin of the v1
 * `tasks:admin` install endpoint. Same body validation, same installer. The
 * shared Bearer producer (`resolve-bearer-principal.ts`) also reaches this
 * admin-scoped internal surface, so it is no longer cookie-auth-only — it
 * adds no new capability beyond what `tasks:admin` already grants there.
 * All fetch/crypto/SSRF guards live inside `installExternalPlugin` (unchanged).
 */

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader.js';
import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { getDb } from '$lib/server/database/connection.js';
import { auditActor } from '$lib/server/utils/audit-log.js';
import {
    installExternalPlugin,
    type InstallInput,
} from '$lib/server/services/external-plugin-manager.service.js';

const InstallBodySchema = z.object({
    manifestUrl: z.string().url(),
    signature: z.string(),
    checksum: z.string().optional(),
    force: z.boolean().optional(),
});

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        POST: async (event: RequestEvent) => {
            const sql = getDb();
            if (!sql) return ApiResponses.error('database unavailable');
            const raw: unknown = await readBoundedJson(event.request).catch(() => ({}));
            const parsed = InstallBodySchema.safeParse(raw);
            if (!parsed.success) return ApiResponses.badRequest('invalid install request');
            const actor = auditActor(event);
            const input: InstallInput = parsed.data;
            const result = await installExternalPlugin(sql, input, actor);
            return new Response(JSON.stringify(result.body), {
                status: result.status,
                headers: { 'Content-Type': 'application/json' },
            });
        },
    },
});
