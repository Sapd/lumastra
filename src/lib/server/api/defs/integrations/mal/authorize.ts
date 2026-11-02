// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as m from '$lib/paraglide/messages.js';
import { integrationRedirectUri } from '$lib/shared/public-base-url.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { config } from '$lib/server/config.js';
import { cacheSet } from '$lib/server/cache/valkey.js';
import crypto from 'node:crypto';

const MAL_AUTH_URL = 'https://myanimelist.net/v1/oauth2/authorize';

/**
 * POST /api/integrations/mal/authorize
 *
 * Initiates the MAL OAuth flow. Returns { authUrl, state } for the caller to redirect.
 */
export const malAuthorizeDef = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    handlers: {
        POST: async (event) => {
            const user = event.locals.user;
            if (!user?.username) return ApiProblem.unauthorized();

            const redirectUri = integrationRedirectUri(config.PUBLIC_BASE_URL, 'mal');
            if (!redirectUri)
                return ApiProblem.validationFailed(m.connections_public_url_required(), {
                    status: 400,
                });

            const clientId = config.MAL_CLIENT_ID;
            if (!clientId || !config.MAL_CLIENT_SECRET) {
                return ApiProblem.dependencyUnavailable(
                    'MyAnimeList integration is not configured on this deployment. Ask your admin to set MAL_CLIENT_ID and MAL_CLIENT_SECRET.',
                );
            }

            // PKCE verifier (MAL only supports the "plain" challenge method)
            const codeVerifier = crypto.randomBytes(32).toString('hex');
            const state = crypto.randomBytes(16).toString('hex');

            await cacheSet(
                `mal:oauth:${state}`,
                JSON.stringify({ codeVerifier, username: user.username }),
                300,
            );

            const params = new URLSearchParams({
                response_type: 'code',
                client_id: clientId,
                redirect_uri: redirectUri,
                state,
                code_challenge: codeVerifier,
                code_challenge_method: 'plain',
            });

            const authUrl = `${MAL_AUTH_URL}?${params.toString()}`;
            return json({ authUrl, state });
        },
    },
});
