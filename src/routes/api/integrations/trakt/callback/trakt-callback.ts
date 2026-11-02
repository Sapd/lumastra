// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { appPath } from '$lib/shared/api-urls.js';
import { integrationRedirectUri } from '$lib/shared/public-base-url.js';
import type postgres from 'postgres';
import { config } from '$lib/server/config';
import { cacheGet, cacheDel } from '$lib/server/cache/valkey';
import { upsertTraktCredential } from '$lib/server/database/queries/trakt-credentials.queries';
import { setWatermark } from '$lib/server/database/queries/watch-sync-preferences.queries';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { Logger } from '$lib/server/utils/logger.js';
import { isRecord, toString } from '$lib/utils/data-extraction';
import type { UserId } from '$lib/shared/user-id';

const logger = Logger.for('Trakt-OAuth');
const TRAKT_TOKEN_URL = 'https://api.trakt.tv/oauth/token';
const TRAKT_SETTINGS_URL = 'https://api.trakt.tv/users/settings';
// Cloudflare in front of api.trakt.tv rejects User-Agent-less requests with 403.
const TRAKT_USER_AGENT = 'Lumastra/1.0';

function failure(reason: string): { redirectTo: string } {
    return { redirectTo: appPath(`/settings/connections?trakt_link=error&reason=${reason}`) };
}

interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
}

export interface TraktCallbackDeps {
    url: URL;
    user: { username: string; userId: UserId } | null;
    sql: postgres.Sql | null;
    fetchImpl?: typeof fetch;
}

export async function handleTraktCallback(
    deps: TraktCallbackDeps,
): Promise<{ redirectTo: string }> {
    const doFetch = deps.fetchImpl ?? fetch;
    const username = deps.user?.username;
    const userId = deps.user?.userId;
    if (!username || !userId) return failure('session');

    const clientId = config.TRAKT_CLIENT_ID;
    const clientSecret = config.TRAKT_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        logger.warn('Trakt OAuth callback but TRAKT_CLIENT_ID/SECRET not configured');
        return failure('configuration');
    }
    const redirectUri = integrationRedirectUri(config.PUBLIC_BASE_URL, 'trakt');
    if (!redirectUri) return failure('configuration');

    const code = deps.url.searchParams.get('code');
    const state = deps.url.searchParams.get('state');
    if (deps.url.searchParams.get('error')) return failure('denied');
    if (!code || !state) return failure('state');

    let stateData: string | null;
    try {
        stateData = await cacheGet(`trakt:oauth:${state}`);
        if (!stateData) return failure('state');
        await cacheDel(`trakt:oauth:${state}`);
    } catch {
        return failure('state');
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(stateData);
    } catch {
        return failure('state');
    }
    if (!isRecord(parsed) || toString(parsed.username) !== username) return failure('state');

    let tokens: TokenResponse;
    try {
        const tokenResp = await doFetch(TRAKT_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': TRAKT_USER_AGENT },
            body: JSON.stringify({
                code,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code',
            }),
        });
        if (!tokenResp.ok) return failure('token');
        tokens = (await tokenResp.json()) as TokenResponse;
        if (typeof tokens?.access_token !== 'string' || !tokens.access_token.trim())
            return failure('token');
    } catch {
        return failure('token');
    }

    // Load a usable provider username before persisting any credentials.
    let traktUsername = '';
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const meResp = await doFetch(TRAKT_SETTINGS_URL, {
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': TRAKT_USER_AGENT,
                    'trakt-api-version': '2',
                    'trakt-api-key': clientId,
                    Authorization: `Bearer ${tokens.access_token}`,
                },
            });
            if (meResp.ok) {
                const me = (await meResp.json()) as { user?: { username?: string } };
                traktUsername =
                    typeof me.user?.username === 'string' ? me.user.username.trim() : '';
                if (traktUsername) break;
            }
        } catch {
            /* retry */
        }
        if (attempt === 0) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!traktUsername) return failure('profile');

    // No false-success: a missing DB handle or a failed upsert is an error.
    if (!deps.sql) {
        logger.error('Trakt callback: database unavailable, cannot store credentials', undefined, {
            username,
        });
        return failure('storage');
    }
    try {
        await upsertTraktCredential(deps.sql, {
            userId,
            providerUsername: traktUsername,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            tokenExpiresAt: tokens.expires_in
                ? new Date(Date.now() + tokens.expires_in * 1000)
                : undefined,
        });
    } catch {
        logger.error('Trakt callback: failed to persist credentials', undefined, { username });
        return failure('storage');
    }

    try {
        await deps.sql`DELETE FROM watch_sync_activity WHERE user_id = ${userId}::uuid AND provider = 'trakt'`;
    } catch {
        // best-effort: a stale-row purge failure must not fail the link
    }

    // Auto-pull on link (spec: linking immediately imports the user's Trakt
    // history; export stays manual). Watermark set is fast/awaited; never
    // let it fail the link.
    try {
        await setWatermark(deps.sql, userId, 'trakt', new Date());
    } catch (err) {
        logger.warn('Trakt callback: failed to set push watermark', {
            username,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    // Fire-and-forget: startRun only enqueues the run (the actual sync
    // happens out-of-band via the task runner), so awaiting it here does
    // not block this redirect on the sync itself. A failure to even
    // enqueue must never fail the link.
    try {
        await orchestrator.startRun(
            'watch-sync-manual',
            { userId, provider: 'trakt', direction: 'pull' },
            {
                userId,
                trigger: {
                    kind: 'in-process',
                    by: 'link',
                    sourceRoute: 'api/integrations/trakt/callback',
                },
            },
        );
    } catch (err) {
        logger.warn('Trakt callback: failed to start auto-import run', {
            username,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    logger.info('Trakt account linked', { username, traktUsername });
    return { redirectTo: appPath('/settings/connections?trakt_link=success') };
}
