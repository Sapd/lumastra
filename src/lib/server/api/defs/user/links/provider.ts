// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/user/links/provider.ts — GET /me/links/{provider} + DELETE /me/links/{provider}
 *
 * Read or unlink a specific provider account.
 * Auth: {kind:'user'} — self-scoped; {provider} is a closed enum (mal | …).
 *
 * GET  — returns the linked status for a single provider.
 * DELETE — unlinks the provider (deletes stored credentials).
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { denyUnlessInteractiveSession } from '$lib/server/api/token-minting.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getMalLinkStatus,
    deleteMalCredential,
} from '$lib/server/database/queries/mal-credentials.queries.js';
import { config } from '$lib/server/config.js';

const ProviderLinkSchema = z.object({
    provider: z.string(),
    name: z.string().meta({ description: 'Human-readable provider name' }),
    configured: z
        .boolean()
        .meta({ description: 'Whether the operator has configured this provider' }),
    linked: z.boolean(),
    linkedAt: z.string().nullable().optional(),
    providerUsername: z.string().nullable().optional(),
});

const ProviderLinkResponseSchema = ProviderLinkSchema;

/** Closed enum of supported link providers. */
const SUPPORTED_PROVIDERS = new Set(['mal']);

/**
 * Params schema for GET|DELETE /me/links/{provider}.
 *
 * `provider` is a non-empty string. The handler validates the closed set
 * at runtime (SUPPORTED_PROVIDERS), so we stay lenient here to avoid
 * changing 404 → 400 for unknown providers.
 */
const UserLinksProviderParams = z.object({
    provider: z.string().min(1),
});

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['User'],
            summary: 'Get provider link status',
            stability: 'stable',
            auth: 'bearer',
            description: 'Returns the link status for a single OAuth provider. Self-scoped.',
            responses: {
                200: {
                    schema: ProviderLinkResponseSchema,
                    description: 'Provider link status',
                },
                401: 'Authentication required',
                404: 'Provider not supported',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        DELETE: {
            tags: ['User'],
            summary: 'Unlink a provider',
            stability: 'stable',
            auth: 'bearer',
            description:
                "Removes the OAuth link for the provider from the authenticated user's account. " +
                'Self-scoped.',
            responses: {
                204: 'Provider unlinked',
                401: 'Authentication required',
                403: 'Session required: API tokens and device tokens cannot do this (reason session_required)',
                404: 'Provider not linked or not supported',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    request: {
        params: UserLinksProviderParams,
    },
    handlers: {
        GET: async (event) => {
            const provider = event.params.provider ?? '';
            if (!SUPPORTED_PROVIDERS.has(provider)) {
                return ApiProblem.notFound(`Unknown provider: ${provider}`);
            }

            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            if (provider === 'mal') {
                const configured = Boolean(config.MAL_CLIENT_ID && config.MAL_CLIENT_SECRET);
                const status = configured ? await getMalLinkStatus(sql, userId) : null;

                return json({
                    provider: 'mal',
                    name: 'MyAnimeList',
                    configured,
                    linked: Boolean(status),
                    providerUsername: status?.providerUsername ?? null,
                    linkedAt: status?.createdAt ?? null,
                });
            }

            // Exhaustive guard — all supported providers handled above
            return ApiProblem.notFound(`Provider not yet implemented: ${provider}`);
        },

        DELETE: async (event) => {
            const notInteractive = denyUnlessInteractiveSession(event);
            if (notInteractive) return notInteractive;
            const provider = event.params.provider ?? '';
            if (!SUPPORTED_PROVIDERS.has(provider)) {
                return ApiProblem.notFound(`Unknown provider: ${provider}`);
            }

            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            if (provider === 'mal') {
                await deleteMalCredential(sql, userId);
                return new Response(null, { status: 204 });
            }

            return ApiProblem.notFound(`Provider not yet implemented: ${provider}`);
        },
    },
});
