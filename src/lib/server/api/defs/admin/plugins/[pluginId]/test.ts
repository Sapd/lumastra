// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/plugins/[pluginId]/test.ts
 *
 * POST /api/admin/plugins/[pluginId]/test — validate an integration credential.
 *
 * Currently only the `discogs` integration supports a connectivity test. It
 * calls the Discogs identity endpoint using either the token supplied in the
 * request body (a value the operator just typed but has NOT saved yet) or —
 * when that is absent or the masked `__CONFIGURED__` sentinel — the stored
 * shared token. Returns `{ ok, username?, error? }`.
 *
 * Auth: admin. Surface: internal.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { pluginIdParamsSchema } from '$lib/schemas/admin.js';
import { getDb } from '$lib/server/database/connection.js';
import { PluginSecrets } from '$lib/server/tasks/secrets.js';
import { verifyDiscogsToken } from '$lib/server/services/discogs-api.js';
import { DISCOGS_PLUGIN_ID, DISCOGS_TOKEN_KEY } from '$lib/server/services/discogs-token.js';
import type postgres from 'postgres';

// Matches the mask the settings GET returns for a set-but-hidden secret.
const SECRET_CONFIGURED_SENTINEL = '__CONFIGURED__';

const PostBodySchema = z
    .object({
        // Optional freshly-typed token to test before saving. Omit (or send the
        // sentinel) to test the currently-stored token.
        token: z
            .string()
            .max(64 * 1024)
            .optional(),
    })
    .strict();

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        params: pluginIdParamsSchema,
        body: PostBodySchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const pluginId = event.params.pluginId;
            if (pluginId !== DISCOGS_PLUGIN_ID) {
                return ApiProblem.notFound(
                    `No connectivity test available for plugin '${pluginId}'`,
                );
            }

            const body = (ctx.input?.body ?? {}) as { token?: string };
            const provided = (body.token ?? '').trim();
            const useProvided = provided !== '' && provided !== SECRET_CONFIGURED_SENTINEL;

            let token = useProvided ? provided : '';
            if (!useProvided) {
                const sql = getDb();
                if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
                token =
                    (await new PluginSecrets(sql as unknown as postgres.Sql).getOptional(
                        DISCOGS_PLUGIN_ID,
                        DISCOGS_TOKEN_KEY,
                    )) ?? '';
            }

            if (!token) {
                return json({ ok: false, error: 'No token to test — enter or save one first.' });
            }

            const result = await verifyDiscogsToken(token, event.request.signal);
            return json(result);
        },
    },
});
