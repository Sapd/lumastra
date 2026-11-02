// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/auth/plugin/<providerId>/callback — where a redirect-kind login lands.
//
// authz: public by necessity. It is a GET, so the CSRF origin guard (unsafe
// methods only) does not apply; the state↔cookie binding IS the login-CSRF
// defense here.
//
// This is the request an attacker gets to forge, so most of the route is about
// refusing one. Three independent checks, none of which substitutes for another:
//
//   1. the query `state` equals the state in this browser's HttpOnly cookie —
//      proves the same browser started the flow;
//   2. the server-side transaction for that state still exists and is consumed
//      atomically — proves it has not been replayed;
//   3. the transaction names THIS provider — proves the state was not minted by
//      a different one (the cookie is scoped to the whole /api/auth/plugin
//      prefix, so without this a state is portable between providers).
//
// Every failure bounces to /login with an allowlisted message. No internal
// detail reaches the browser, and no branch falls through to a session.

import type { RequestHandler } from './$types';
import type { AuthFailureMessage } from '$lib/shared/auth-failure-ref.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getClientIpStrict } from '$lib/server/utils/client-ip.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { sanitizeRedirect } from '$lib/server/utils/safe-redirect.js';
import { registry as taskRegistry } from '$lib/server/tasks/registry.js';
import { buildPluginContext } from '$lib/server/tasks/plugin-context.js';
import {
    isAuthProviderEnabled,
    normalizeVerdict,
} from '$lib/server/services/plugin-auth.service.js';
import { consumePluginAuthTx } from '$lib/server/services/plugin-auth-tx-store.js';
import { establishPluginSession } from '$lib/server/auth/plugin-auth-session.js';
import {
    PLUGIN_AUTH_TX_COOKIE,
    PLUGIN_AUTH_TX_COOKIE_PATH,
    pluginAuthRedirect,
} from '$lib/server/auth/plugin-auth-redirect.js';

const logger = Logger.for('PluginAuth:callback');

const CALLBACK_IP_LIMIT = 60;
const CALLBACK_IP_WINDOW = 15 * 60;

/** Provider budget. A hung `completeLogin` must not hold the request open. */
const COMPLETE_TIMEOUT_MS = 10_000;

/**
 * Bounds on what third-party code is handed. A provider controls the callback
 * URL it sent the browser to, so it controls this query string; the plugin's
 * own parser should not be the first thing that decides a 4KB value is fine.
 */
const MAX_PARAMS = 32;
const MAX_PARAM_LEN = 4096;

const notFound = (): Response => new Response(null, { status: 404 });

const toLogin = (msg: AuthFailureMessage): Response =>
    pluginAuthRedirect('/login?error=' + encodeURIComponent(msg));

function settleWithin<T>(p: Promise<T>, ms: number): Promise<T | null> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), ms);
        (timer as unknown as { unref?: () => void }).unref?.();
        p.then(
            (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            () => {
                clearTimeout(timer);
                resolve(null);
            },
        );
    });
}

export const GET: RequestHandler = async (event) => {
    const providerId = event.params.providerId;

    if (!isAuthProviderEnabled(providerId)) return notFound();
    const provider = taskRegistry.getAuthProvider(providerId);
    if (!provider || typeof provider.completeLogin !== 'function') return notFound();

    // Consume the binding cookie regardless of outcome, so one cookie can drive
    // at most one callback attempt.
    const cookieState = event.cookies.get(PLUGIN_AUTH_TX_COOKIE) ?? null;
    event.cookies.delete(PLUGIN_AUTH_TX_COOKIE, { path: PLUGIN_AUTH_TX_COOKIE_PATH });

    const gate = await checkRateLimit(
        `plugin-auth:callback:ip:${getClientIpStrict(event)}`,
        CALLBACK_IP_LIMIT,
        CALLBACK_IP_WINDOW,
    );
    if (!gate.allowed) return toLogin('Too many attempts. Try again later.');

    // The provider signalled a failure (user cancelled, access denied, …).
    // Checked before anything else is spent on the request.
    if (event.url.searchParams.get('error')) {
        logger.warn('auth provider returned an error to the callback', {
            provider: providerId,
            error: event.url.searchParams.get('error'),
        });
        return toLogin('Sign-in was cancelled or failed.');
    }

    const queryState = event.url.searchParams.get('state') ?? '';
    if (!queryState || !cookieState || queryState !== cookieState) {
        logger.warn('plugin auth callback state did not match the browser binding', {
            provider: providerId,
        });
        return toLogin('Sign-in failed. Please try again.');
    }

    // Single-use, and bound to this provider.
    const tx = await consumePluginAuthTx(queryState, providerId);
    if (!tx) {
        logger.warn('plugin auth callback had no live transaction', { provider: providerId });
        return toLogin('Sign-in failed. Please try again.');
    }

    const params: Record<string, string> = {};
    let count = 0;
    for (const [key, value] of event.url.searchParams) {
        if (count >= MAX_PARAMS) break;
        if (value.length > MAX_PARAM_LEN) continue;
        params[key] = value;
        count++;
    }

    const raw = await settleWithin(
        Promise.resolve(
            provider.completeLogin(buildPluginContext(providerId), {
                params,
                state: queryState,
                txData: tx.txData,
            }),
        ),
        COMPLETE_TIMEOUT_MS,
    );
    // FAILS CLOSED, exactly as the credentials kind does: a throw, a timeout or
    // a verdict the host cannot parse is not a login.
    const verdict =
        raw === null
            ? { ok: false as const, reason: 'unavailable' as const }
            : normalizeVerdict(raw);
    if (!verdict.ok) {
        logger.warn('auth provider refused a redirect login', {
            provider: providerId,
            reason: verdict.reason,
        });
        return toLogin('Sign-in failed. Please try again.');
    }

    // The shared tail — identical to the credentials route, so account linking,
    // the first-admin refusal and the suspension check cannot differ by kind.
    const outcome = await establishPluginSession(event, providerId, verdict.identity);
    if (outcome.kind === 'not-linked') {
        return toLogin(
            'That account is not linked on this server yet. Ask an administrator to link it.',
        );
    }
    if (outcome.kind === 'account-refused') return toLogin('This account is disabled.');
    if (outcome.kind === 'unavailable') return toLogin('Sign-in is temporarily unavailable.');

    // returnTo was sanitized at start; re-sanitize defensively. A value that has
    // been through a cache round-trip is not trusted a second time.
    return pluginAuthRedirect(sanitizeRedirect(tx.returnTo, '/'));
};
