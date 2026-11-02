// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/user/links/index.ts — GET /me/links
 *
 * List all linked provider accounts for the authenticated user.
 * Auth: {kind:'user'} — self-scoped.
 *
 * Returns the set of providers the operator has configured, with linked status
 * for each.  Providers not yet configured (e.g. MAL_CLIENT_ID unset) are still
 * enumerated with {configured:false} so the UI can show "not available on this
 * server" rather than hiding the option entirely.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { getMalLinkStatus } from '$lib/server/database/queries/mal-credentials.queries.js';
import { config } from '$lib/server/config.js';
import { z } from 'zod';

const ProviderLinkSchema = z.object({
    provider: z.string().meta({ description: 'Provider slug (e.g. "mal")' }),
    name: z.string().meta({ description: 'Human-readable provider name' }),
    configured: z
        .boolean()
        .meta({ description: 'Whether the operator has configured this provider' }),
    linked: z.boolean(),
    linkedAt: z.string().nullable().optional(),
    providerUsername: z.string().nullable().optional(),
});

const LinksResponseSchema = z.object({
    links: z.array(ProviderLinkSchema),
});

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['User'],
            summary: 'List provider link statuses',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Returns all OAuth provider link statuses for the authenticated user. ' +
                'Self-scoped endpoint.',
            responses: {
                200: {
                    schema: LinksResponseSchema,
                    description: 'Provider link statuses',
                },
                401: 'Authentication required',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    handlers: {
        GET: async (event) => {
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            // MAL — only provider currently supported
            const malConfigured = Boolean(config.MAL_CLIENT_ID && config.MAL_CLIENT_SECRET);
            const malStatus = malConfigured ? await getMalLinkStatus(sql, userId) : null;

            return json({
                links: [
                    {
                        provider: 'mal',
                        name: 'MyAnimeList',
                        configured: malConfigured,
                        linked: Boolean(malStatus),
                        providerUsername: malStatus?.providerUsername ?? null,
                        linkedAt: malStatus?.createdAt ?? null,
                    },
                ],
            });
        },
    },
});
