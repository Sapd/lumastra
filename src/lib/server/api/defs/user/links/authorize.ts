// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/user/links/authorize.ts — POST /me/links/{provider}/authorize
 *
 * Initiates the OAuth linking flow for a provider.
 * Auth: {kind:'user'} — self-scoped.
 *
 * Returns the provider's OAuth authorization URL and a state token.
 * The caller (browser) redirects to authUrl; on return the unversioned
 * callback handler at GET /oauth/links/{provider}/callback stores the
 * credentials and redirects the browser to /settings/connections.
 *
 * Note: the callback NEVER returns problem+json — it always redirects.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { denyUnlessInteractiveSession } from '$lib/server/api/token-minting.js';
import { config } from '$lib/server/config.js';
import { cacheSet } from '$lib/server/cache/valkey.js';
import crypto from 'node:crypto';

const AuthorizeResponseSchema = z.object({
    authUrl: z.string().meta({
        description: 'OAuth authorization URL to redirect the user to',
    }),
    state: z.string().meta({ description: 'CSRF state parameter (opaque)' }),
});

const MAL_AUTH_URL = 'https://myanimelist.net/v1/oauth2/authorize';

/** Closed enum of supported link providers. */
const SUPPORTED_PROVIDERS = new Set(['mal']);

/**
 * Params schema for POST /me/links/{provider}/authorize.
 *
 * `provider` is a non-empty string; the handler validates the closed set
 * at runtime (SUPPORTED_PROVIDERS) to keep unknown-provider errors as 404.
 */
const UserLinksAuthorizeParams = z.object({
    provider: z.string().min(1),
});

export const def = defineEndpoint({
    docs: {
        POST: {
            tags: ['User'],
            summary: 'Initiate provider OAuth linking',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Initiates the OAuth linking flow for the provider. ' +
                'Returns an `authUrl` that the client should redirect the browser to. ' +
                'The OAuth callback (`/oauth/links/{provider}/callback`) is browser-session scoped. ' +
                'Self-scoped.',
            responses: {
                200: {
                    schema: AuthorizeResponseSchema,
                    description: 'OAuth authorization URL',
                },
                401: 'Authentication required',
                403: 'Session required: API tokens and device tokens cannot do this (reason session_required)',
                404: 'Provider not supported',
                409: 'Provider is already linked',
                503: 'Cache unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    request: {
        params: UserLinksAuthorizeParams,
    },
    handlers: {
        POST: async (event) => {
            const notInteractive = denyUnlessInteractiveSession(event);
            if (notInteractive) return notInteractive;
            const provider = event.params.provider ?? '';
            if (!SUPPORTED_PROVIDERS.has(provider)) {
                return ApiProblem.notFound(`Unknown provider: ${provider}`);
            }

            const username = event.locals.principal?.username ?? event.locals.user?.username;
            if (!username) return ApiProblem.unauthorized();

            if (provider === 'mal') {
                const clientId = config.MAL_CLIENT_ID;
                if (!clientId || !config.MAL_CLIENT_SECRET) {
                    return ApiProblem.dependencyUnavailable(
                        'MyAnimeList integration is not configured on this server. ' +
                            'Ask your administrator to set MAL_CLIENT_ID and MAL_CLIENT_SECRET.',
                    );
                }

                // PKCE verifier — MAL only supports the "plain" challenge method
                const codeVerifier = crypto.randomBytes(32).toString('hex');
                const state = crypto.randomBytes(16).toString('hex');

                await cacheSet(
                    `mal:oauth:${state}`,
                    JSON.stringify({ codeVerifier, username }),
                    300,
                );

                const params = new URLSearchParams({
                    response_type: 'code',
                    client_id: clientId,
                    state,
                    code_challenge: codeVerifier,
                    code_challenge_method: 'plain',
                });

                return json({ authUrl: `${MAL_AUTH_URL}?${params.toString()}`, state });
            }

            // Exhaustive guard
            return ApiProblem.notFound(`Provider not yet implemented: ${provider}`);
        },
    },
});
