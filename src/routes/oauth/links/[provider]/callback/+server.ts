// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /oauth/links/{provider}/callback
 *
 * Unversioned OAuth callback for account linking.
 * Stays at /oauth/* (not /api/v1/*) because:
 *   1. The OAuth provider redirects here via a pre-registered redirect_uri.
 *   2. It requires a browser session (cookie auth), not a Bearer token.
 *   3. It ALWAYS redirects — never returns problem+json.
 *
 * Current provider: mal (MyAnimeList).  Add new providers here as needed —
 * the {provider} param is a closed enum.
 *
 * On success  → redirect /settings/connections?{provider}_link=success
 * On any error → redirect /settings/connections?{provider}_link=error
 */

import { isRedirect, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config.js';
import { cacheGet, cacheDel } from '$lib/server/cache/valkey.js';
import { getDb } from '$lib/server/database/connection.js';
import { upsertMalCredential } from '$lib/server/database/queries/mal-credentials.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import { isRecord, toString } from '$lib/utils/data-extraction.js';
import { appPath } from '$lib/shared/api-urls.js';

const logger = Logger.for('OAuthLinkCallback');

const MAL_TOKEN_URL = 'https://myanimelist.net/v1/oauth2/token';
const MAL_API_BASE = 'https://api.myanimelist.net/v2';

/** Supported providers (closed enum). */
const SUPPORTED_PROVIDERS = new Set(['mal']);

interface MalTokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
}

interface MalUserResponse {
    name?: string;
}

export const GET: RequestHandler = async ({ url, params, locals }) => {
    const provider = params.provider ?? '';

    if (!SUPPORTED_PROVIDERS.has(provider)) {
        // Unknown provider — can't redirect to a provider-specific page; use generic settings.
        throw redirect(302, appPath('/settings/connections?link=error'));
    }

    const successUrl = appPath(`/settings/connections?${provider}_link=success`);
    const errorUrl = appPath(`/settings/connections?${provider}_link=error`);

    if (provider === 'mal') {
        try {
            return await handleMalCallback({ url, locals, successUrl, errorUrl });
        } catch (error) {
            if (isRedirect(error)) throw error;
            // The browser came from the provider's consent page: a malformed
            // state, a provider or DB failure must land on the "linking
            // failed" page, never a bare error response.
            logger.error('MAL OAuth callback failed', error as Error);
            throw redirect(302, errorUrl);
        }
    }

    throw redirect(302, errorUrl);
};

async function handleMalCallback({
    url,
    locals,
    successUrl,
    errorUrl,
}: {
    url: URL;
    locals: App.Locals;
    successUrl: string;
    errorUrl: string;
}): Promise<Response> {
    const username = locals.user?.username;
    const userId = locals.user?.userId;
    if (!username || !userId) {
        throw redirect(302, errorUrl);
    }

    const clientId = config.MAL_CLIENT_ID;
    const clientSecret = config.MAL_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        logger.warn('MAL OAuth callback received but MAL_CLIENT_ID/SECRET not configured');
        throw redirect(302, errorUrl);
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const errorParam = url.searchParams.get('error');

    if (errorParam) {
        logger.warn('MAL OAuth error', { error: errorParam });
        throw redirect(302, errorUrl);
    }

    if (!code || !state) {
        throw redirect(302, errorUrl);
    }

    const stateData = await cacheGet(`mal:oauth:${state}`);
    if (!stateData) {
        throw redirect(302, errorUrl);
    }
    await cacheDel(`mal:oauth:${state}`);

    const parsed: unknown = JSON.parse(stateData);
    if (!isRecord(parsed)) {
        throw redirect(302, errorUrl);
    }
    const codeVerifier = toString(parsed.codeVerifier);
    const stateUsername = toString(parsed.username);

    if (stateUsername !== username || !codeVerifier) {
        throw redirect(302, errorUrl);
    }

    const tokenBody = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
    });

    const tokenResp = await fetch(MAL_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenBody.toString(),
    });

    if (!tokenResp.ok) {
        const text = await tokenResp.text();
        logger.error('MAL token exchange failed', undefined, {
            status: tokenResp.status,
            body: text,
        });
        throw redirect(302, errorUrl);
    }

    const tokens = (await tokenResp.json()) as MalTokenResponse;

    // Without a malUsername, the plugin's pullWatchState skips this user
    // forever. Retry once on transient failure before giving up.
    let malUsername = '';
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const meResp = await fetch(`${MAL_API_BASE}/users/@me`, {
                headers: { Authorization: `Bearer ${tokens.access_token}` },
            });
            if (meResp.ok) {
                const me = (await meResp.json()) as MalUserResponse;
                malUsername = me.name ?? '';
                if (malUsername) break;
            }
        } catch {
            // retry on next iteration
        }
        if (attempt === 0) {
            await new Promise((r) => setTimeout(r, 1000));
        }
    }
    if (!malUsername) {
        logger.warn(
            'MAL link stored without provider username — pullWatchState will skip this user until they re-link',
            { username },
        );
    }

    const expiresAt = tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000)
        : undefined;

    const sql = getDb();
    if (sql) {
        await upsertMalCredential(sql, {
            userId,
            providerUsername: malUsername,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            tokenExpiresAt: expiresAt,
        });
    }

    logger.info('MAL account linked via /oauth/links/mal/callback', { username, malUsername });

    throw redirect(302, successUrl);
}
