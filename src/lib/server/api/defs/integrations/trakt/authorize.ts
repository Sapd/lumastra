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

const TRAKT_AUTH_URL = 'https://trakt.tv/oauth/authorize';

/**
 * POST /api/integrations/trakt/authorize
 * Initiates the Trakt OAuth flow. Returns { authUrl, state }.
 */
export const traktAuthorizeDef = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    handlers: {
        POST: async (event) => {
            const user = event.locals.user;
            if (!user?.username) return ApiProblem.unauthorized();

            const redirectUri = integrationRedirectUri(config.PUBLIC_BASE_URL, 'trakt');
            if (!redirectUri)
                return ApiProblem.validationFailed(m.connections_public_url_required(), {
                    status: 400,
                });

            const clientId = config.TRAKT_CLIENT_ID;
            if (!clientId || !config.TRAKT_CLIENT_SECRET) {
                return ApiProblem.dependencyUnavailable(
                    'Trakt integration is not configured on this deployment. Ask your admin to set TRAKT_CLIENT_ID and TRAKT_CLIENT_SECRET.',
                );
            }

            const state = crypto.randomBytes(16).toString('hex');
            await cacheSet(
                `trakt:oauth:${state}`,
                JSON.stringify({ username: user.username }),
                300,
            );

            const params = new URLSearchParams({
                response_type: 'code',
                client_id: clientId,
                // Registered with Trakt out-of-band and matched byte-for-byte by their
                // OAuth server, so it must NOT vary by surface — a v1-prefixed variant
                // would be rejected as an unregistered redirect_uri. PUBLIC_BASE_URL
                // already carries any install base path.
                redirect_uri: redirectUri,
                state,
            });
            return json({ authUrl: `${TRAKT_AUTH_URL}?${params.toString()}`, state });
        },
    },
});
