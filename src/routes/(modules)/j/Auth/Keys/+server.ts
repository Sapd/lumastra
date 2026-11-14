// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Jellyfin compat: /Auth/Keys
//
// Used by Jellyseerr (and similar TV/aggregator clients) during their setup
// wizard to obtain a long-lived API key.
//
// Real Jellyfin's behavior:
//   POST /Auth/Keys?App=<name>  -> 204, server generates and stores a key
//   GET  /Auth/Keys             -> { Items: [{ AccessToken, AppName, ... }] }
//
// Lumastra's implementation (Task 14, Task 15):
//   POST mints a `jellyfin_compat`-scoped Personal Access Token named
//   "Jellyfin Connect: <App>", revokes any prior un-revoked PAT with the same
//   name (idempotent re-runs of the wizard), and stashes the plaintext in
//   Valkey under a UUID nonce keyed by PAT id with a 10-minute TTL.
//   GET (Task 15) atomically consumes the stash via GETDEL and returns the
//   plaintext exactly once — inbox semantics, NOT real-Jellyfin's
//   "always-readable" contract. Only PATs with an active stash appear in the
//   response; PATs whose stash has already been consumed or expired are
//   filtered out.
//
// Auth: admin only. PAT auth is denied (`pat: 'deny'`) — admin token-management
// must not be reachable via a token issued by the same mechanism. The
// in-handler isAdmin check is defense-in-depth in case the middleware is ever
// rewired.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { getPatService } from '$lib/server/oauth/pat.service';
import {
    consumeAuthKey,
    stashAuthKey,
} from '$lib/server/jellyfin-compat/auth-keys-stash';
import { Logger } from '$lib/server/utils/logger';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

const logger = Logger.for('JellyfinCompat:AuthKeys');

const APP_PARAM_MAX_LENGTH = 64;
const PAT_NAME_PREFIX = 'Jellyfin Connect: ';

/** Build the canonical PAT name for a given Connect app. */
function patNameFor(app: string): string {
    return `${PAT_NAME_PREFIX}${app}`;
}

interface AuthKeyItem {
    AppName: string;
    AccessToken: string;
    DateCreated: string;
    Id: number;
}

const postHandler: RequestHandler = async (event) => {
    // Defense-in-depth: middleware enforces auth, but only this handler enforces
    // admin. Real Jellyfin's /Auth/Keys is admin-only; Seerr's wizard fails
    // upstream for non-admins, but we must not rely on that.
    if (!localsIsAdmin(event.locals)) {
        return ApiResponses.forbidden('Administrator privileges required');
    }

    const rawApp = event.url.searchParams.get('App') ?? '';
    // Strip control chars (NUL/ASCII control + DEL) before length cap so a
    // wizard sending `Jellyseerr\x00` doesn't mint a PAT with a mangled name.
    const app = rawApp
        .split('')
        .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f)
        .join('')
        .trim()
        .slice(0, APP_PARAM_MAX_LENGTH);
    if (!app) {
        return ApiResponses.badRequest('App query parameter required');
    }

    const username = event.locals.user.username;
    const userGroups = event.locals.user.userGroups || [];
    const patName = patNameFor(app);

    // Idempotent revoke: any prior un-revoked jellyfin_compat PAT for this
    // user with the same connect-app name is revoked before we mint a new one.
    // Re-running the Seerr wizard is a supported flow.
    //
    // We don't wrap revoke + create in a transaction — patService.create() owns
    // its own transaction-scoped advisory lock and the race window between the
    // two calls is bounded to a single handler invocation. Worst case, two
    // concurrent admins running the wizard at the same instant could leave
    // two active PATs with the same name; the next wizard run revokes both.
    try {
        await getPatService().revokeJellyfinCompatByName(event.locals.user.userId, patName);
    } catch (error) {
        logger.error('Failed to revoke prior Jellyfin Connect PAT', error as Error, {
            username,
            app,
        });
        return ApiResponses.error('Failed to revoke prior token');
    }

    // Mint new jellyfin_compat PAT with no expiration (matches real Jellyfin
    // semantics: API keys are permanent until the admin revokes them).
    let minted: { id: number; token: string };
    try {
        minted = await getPatService().create({
            userId: event.locals.user.userId,
            name: patName,
            description: `Auto-issued for ${app} via /Auth/Keys`,
            scopes: ['jellyfin_compat'],
            groups: userGroups,
            expiresInDays: null,
        });
    } catch (error) {
        logger.error('Failed to mint Jellyfin Connect PAT', error as Error, {
            username,
            app,
        });
        return ApiResponses.error('Failed to mint API key');
    }

    // Stash plaintext for the upcoming GET to consume (10-minute TTL).
    try {
        await stashAuthKey(minted.id, minted.token);
    } catch (error) {
        logger.error('Failed to stash Jellyfin Connect PAT plaintext', error as Error, {
            username,
            app,
            patId: minted.id,
        });
        // The PAT exists in DB but the wizard can't pick it up. Revoke the
        // orphan so it doesn't count against MAX_PATS_PER_USER on retry, then
        // return 503 so Seerr retries instead of assuming success.
        try {
            await getPatService().revoke(minted.id, event.locals.user.userId);
        } catch (revokeError) {
            logger.error(
                'Failed to revoke orphan Jellyfin Connect PAT after stash failure',
                revokeError as Error,
                { username, app, patId: minted.id },
            );
        }
        return ApiResponses.serviceUnavailable('Cache', 'Failed to stash API key for retrieval');
    }

    logger.info('Minted Jellyfin Connect PAT', {
        username,
        app,
        patId: minted.id,
    });

    return new Response(null, { status: 204 });
};

// ----------------------------------------------------------------------------
// GET handler — inbox semantics
//
// We deliberately deviate from real Jellyfin's contract (which always returns
// plaintext for every key on every call) because we never store plaintext PAT
// values at rest. Instead, the POST handler stashes plaintext under a
// short-TTL nonce keyed by PAT id, and this handler atomically GETDELs the
// stash on read. Only PATs with an active stash are surfaced; everything else
// is filtered out.
//
// Behavior:
//   1. List the caller's `jellyfin_compat`-scoped PATs (DESC by created_at).
//   2. For each PAT, attempt consumeAuthKey(pat.id) — atomic dual GETDEL.
//   3. Drop PATs whose stash returned null.
//   4. Build response items with the "Jellyfin Connect: " prefix stripped
//      from the visible AppName.
// ----------------------------------------------------------------------------

const getHandler: RequestHandler = async (event) => {
    if (!localsIsAdmin(event.locals)) {
        return ApiResponses.forbidden('Administrator privileges required');
    }

    const pats = await getPatService().listForUser(event.locals.user.userId, {
        scopes: ['jellyfin_compat'],
    });

    const items: AuthKeyItem[] = [];
    for (const pat of pats) {
        const plaintext = await consumeAuthKey(pat.id);
        if (!plaintext) continue;
        items.push({
            AppName: pat.name.startsWith(PAT_NAME_PREFIX)
                ? pat.name.slice(PAT_NAME_PREFIX.length)
                : pat.name,
            AccessToken: plaintext,
            DateCreated: pat.createdAt.toISOString(),
            Id: pat.id,
        });
    }

    return json({
        Items: items,
        TotalRecordCount: items.length,
        StartIndex: 0,
    });
};

// POST mints a new PAT — pat:deny + mode:'write'. mode is technically moot
// since pat:deny rejects every PAT, but be explicit so the audit trail is
// uniform across write routes.
export const POST = withJellyfinAuth(postHandler, {
    pat: 'deny',
    mode: 'write',
});
// GET reads the inbox-style stash; default mode='read' is correct.
export const GET = withJellyfinAuth(getHandler, { pat: 'deny' });
