// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { cacheGet, cacheDel } from '$lib/server/cache/valkey';
import { getDb } from '$lib/server/database/connection';
import { upsertMalCredential } from '$lib/server/database/queries/mal-credentials.queries';
import { setWatermark } from '$lib/server/database/queries/watch-sync-preferences.queries';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { Logger } from '$lib/server/utils/logger.js';
import { isRecord, toString } from '$lib/utils/data-extraction';
import { integrationRedirectUri } from '$lib/shared/public-base-url.js';
import { appPath } from '$lib/shared/api-urls.js';

const logger = Logger.for('MAL-OAuth');
const MAL_TOKEN_URL = 'https://myanimelist.net/v1/oauth2/token';
const MAL_API_BASE = 'https://api.myanimelist.net/v2';

function fail(reason: string): never {
    throw redirect(302, appPath(`/settings/connections?mal_link=error&reason=${reason}`));
}

interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
}

interface MalUserResponse {
    name?: string;
}

export const GET: RequestHandler = async ({ url, locals }) => {
    const username = locals.user?.username;
    const userId = locals.user?.userId;
    if (!username || !userId) {
        fail('session');
    }

    const clientId = config.MAL_CLIENT_ID;
    const clientSecret = config.MAL_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        logger.warn('MAL OAuth callback received but MAL_CLIENT_ID/SECRET not configured');
        fail('configuration');
    }
    const redirectUri = integrationRedirectUri(config.PUBLIC_BASE_URL, 'mal');
    if (!redirectUri) fail('configuration');

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const errorParam = url.searchParams.get('error');

    if (errorParam) {
        fail('denied');
    }

    if (!code || !state) {
        fail('state');
    }

    let parsed: unknown;
    try {
        const stateData = await cacheGet(`mal:oauth:${state}`);
        if (!stateData) fail('state');
        await cacheDel(`mal:oauth:${state}`);
        parsed = JSON.parse(stateData);
    } catch {
        fail('state');
    }
    if (!isRecord(parsed)) {
        fail('state');
    }
    const codeVerifier = toString(parsed.codeVerifier);
    const stateUsername = toString(parsed.username);

    if (stateUsername !== username) {
        fail('state');
    }

    if (!codeVerifier) {
        fail('state');
    }

    const tokenBody = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
    });

    let tokens: TokenResponse;
    try {
        const tokenResp = await fetch(MAL_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: tokenBody.toString(),
        });
        if (!tokenResp.ok) fail('token');
        tokens = (await tokenResp.json()) as TokenResponse;
        if (typeof tokens?.access_token !== 'string' || !tokens.access_token.trim()) fail('token');
    } catch {
        fail('token');
    }

    // Without a malUsername, the plugin's pullWatchState skips this user
    // forever (line 936 of the plugin). Retry once on transient failure
    // before giving up — the user has just authorized, so any MAL blip
    // here would otherwise force them to unlink and try again.
    let malUsername = '';
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const meResp = await fetch(`${MAL_API_BASE}/users/@me`, {
                headers: { Authorization: `Bearer ${tokens.access_token}` },
            });
            if (meResp.ok) {
                const me = (await meResp.json()) as MalUserResponse;
                malUsername = typeof me.name === 'string' ? me.name.trim() : '';
                if (malUsername) break;
            }
        } catch {
            // retry on next iteration
        }
        if (attempt === 0) {
            await new Promise((r) => setTimeout(r, 1000));
        }
    }
    if (!malUsername) fail('profile');

    const expiresAt = tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000)
        : undefined;

    const sql = getDb();
    if (!sql) fail('storage');
    try {
        await upsertMalCredential(sql, {
            userId,
            providerUsername: malUsername,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            tokenExpiresAt: expiresAt,
        });
    } catch {
        fail('storage');
    }

    try {
        await sql`DELETE FROM watch_sync_activity WHERE user_id = ${userId}::uuid AND provider = 'mal'`;
    } catch {
        // best-effort: a stale-row purge failure must not fail the link
    }

    // Auto-pull on link (spec: linking immediately imports the user's
    // MAL history; export stays manual). Watermark set is fast/awaited;
    // never let it fail the link.
    try {
        await setWatermark(sql, userId, 'mal', new Date());
    } catch (err) {
        logger.warn('MAL callback: failed to set push watermark', {
            username,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    // Fire-and-forget: startRun only enqueues the run (the actual
    // sync happens out-of-band via the task runner), so awaiting it
    // here does not block this redirect on the sync itself. A failure
    // to even enqueue must never fail the link.
    try {
        await orchestrator.startRun(
            'watch-sync-manual',
            { userId, provider: 'mal', direction: 'pull' },
            {
                userId,
                trigger: {
                    kind: 'in-process',
                    by: 'link',
                    sourceRoute: 'api/integrations/mal/callback',
                },
            },
        );
    } catch (err) {
        logger.warn('MAL callback: failed to start auto-import run', {
            username,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    logger.info('MAL account linked', { username, malUsername });

    throw redirect(302, appPath('/settings/connections?mal_link=success'));
};
