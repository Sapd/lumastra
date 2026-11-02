// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /api/auth/plugin/<providerId>/start — begin a redirect-kind login.
//
// authz: public by necessity — this is a login entrance. Reachable only for a
// provider the operator named in AUTH_PLUGIN_PROVIDERS; anything else 404s.
//
// The HOST owns this transaction. The plugin is asked exactly one question —
// where to send the browser — and its answer is treated as untrusted input,
// because a redirect target returned by third-party code is precisely the shape
// of an open redirect and of a `javascript:` payload. The host generates the
// `state`, binds it to this browser with an HttpOnly cookie, and keeps every
// piece of flow context server-side; the plugin gets no cookie access and no
// say in where the user lands afterwards.

import type { RequestHandler } from './$types';
import { randomBytes } from 'node:crypto';
import type { AuthFailureMessage } from '$lib/shared/auth-failure-ref.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getClientIpStrict } from '$lib/server/utils/client-ip.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { sanitizeRedirect } from '$lib/server/utils/safe-redirect.js';
import { registry as taskRegistry } from '$lib/server/tasks/registry.js';
import { buildPluginContext } from '$lib/server/tasks/plugin-context.js';
import { isAuthProviderEnabled } from '$lib/server/services/plugin-auth.service.js';
import { storePluginAuthTx } from '$lib/server/services/plugin-auth-tx-store.js';
import {
    PLUGIN_AUTH_TX_COOKIE,
    PLUGIN_AUTH_TX_COOKIE_PATH,
    PLUGIN_AUTH_TX_MAX_AGE,
    pluginAuthRedirect,
    isSafeProviderRedirect,
} from '$lib/server/auth/plugin-auth-redirect.js';

const logger = Logger.for('PluginAuth:start');

// Mirrors the OIDC login gate: a light per-IP cap so the transaction store
// cannot be flooded by an unauthenticated caller.
const START_IP_LIMIT = 30;
const START_IP_WINDOW = 15 * 60;

/** Provider budget. A hung `beginLogin` must not hold the request open. */
const BEGIN_TIMEOUT_MS = 10_000;

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

    // Re-read per request, so removing an id from the env closes this door
    // immediately rather than waiting on the restart-only plugin unload.
    if (!isAuthProviderEnabled(providerId)) return notFound();
    const provider = taskRegistry.getAuthProvider(providerId);
    // A credentials-kind provider has no redirect flow, and saying so with a
    // 404 keeps the two kinds indistinguishable from outside.
    if (!provider || typeof provider.beginLogin !== 'function') return notFound();

    const gate = await checkRateLimit(
        `plugin-auth:start:ip:${getClientIpStrict(event)}`,
        START_IP_LIMIT,
        START_IP_WINDOW,
    );
    if (!gate.allowed) return toLogin('Too many attempts. Try again later.');

    // Sanitized HERE, before it is stored, so the value that survives into the
    // callback is already same-origin and relative.
    const returnTo = sanitizeRedirect(event.url.searchParams.get('returnTo'), '/');
    const callbackUrl = `${event.url.origin}/api/auth/plugin/${encodeURIComponent(providerId)}/callback`;

    // 256 bits of unguessable state. The plugin receives it (it has to echo it
    // back) but does not choose it.
    const state = randomBytes(32).toString('base64url');

    const begun = await settleWithin(
        Promise.resolve(
            provider.beginLogin(buildPluginContext(providerId), { callbackUrl, state }),
        ),
        BEGIN_TIMEOUT_MS,
    );
    if (!begun || typeof begun.redirectUrl !== 'string') {
        logger.warn('auth provider failed to begin a redirect login', { provider: providerId });
        return toLogin('Sign-in is temporarily unavailable.');
    }

    // The plugin does not get to pick an arbitrary scheme or bounce the browser
    // back inside our own origin under its control.
    if (!isSafeProviderRedirect(begun.redirectUrl)) {
        logger.warn('auth provider returned an unusable redirect target', {
            provider: providerId,
        });
        return toLogin('Sign-in is temporarily unavailable.');
    }

    const stored = await storePluginAuthTx(state, {
        pluginId: providerId,
        returnTo,
        txData: typeof begun.txData === 'string' ? begun.txData : undefined,
    });
    // Do not send the user to the provider if the callback could never succeed —
    // that strands them there with no way back that works.
    if (!stored) return toLogin('Sign-in is temporarily unavailable.');

    // Binds the callback to THIS browser (login-CSRF defense). Lax, not Strict:
    // Strict would drop the cookie on the top-level redirect back.
    event.cookies.set(PLUGIN_AUTH_TX_COOKIE, state, {
        path: PLUGIN_AUTH_TX_COOKIE_PATH,
        httpOnly: true,
        sameSite: 'lax',
        maxAge: PLUGIN_AUTH_TX_MAX_AGE,
    });

    return pluginAuthRedirect(begun.redirectUrl, 302);
};
