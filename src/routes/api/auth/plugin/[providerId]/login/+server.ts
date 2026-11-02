// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST /api/auth/plugin/<providerId>/login — credential login via an
// auth-provider plugin.
//
// authz: public — this route EXISTS to establish a session, so it is pre-auth
// by necessity. It is reachable only when an operator has named the provider in
// AUTH_PLUGIN_PROVIDERS; anything else 404s (never 401/403, which would confirm
// which providers are installed). The plugin verifies credentials and returns
// claims; this route does the identity mapping, the admin strip and the session
// mint, exactly as the native and OIDC paths do.

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import {
    checkRateLimit,
    peekRateLimit,
    resetRateLimit,
} from '$lib/server/middleware/valkey-rate-limit.js';
import {
    BODY_TOO_LARGE,
    isDeclaredContentLengthOverCap,
    readBoundedBodyText,
} from '$lib/server/utils/bounded-body-reader.js';
import { getClientIp, getClientIpStrict } from '$lib/server/utils/client-ip.js';
import { registry as taskRegistry } from '$lib/server/tasks/registry.js';
import { buildPluginContext } from '$lib/server/tasks/plugin-context.js';
import { Logger } from '$lib/server/utils/logger.js';
import { isRecord, toStringOr } from '$lib/utils/data-extraction.js';
import {
    isAuthProviderEnabled,
    normalizeVerdict,
} from '$lib/server/services/plugin-auth.service.js';
import { establishPluginSession } from '$lib/server/auth/plugin-auth-session.js';
import { sanitizeRedirect } from '$lib/server/utils/safe-redirect.js';

const logger = Logger.for('PluginAuthLogin');

// Same buckets as native login: a plugin login is still a login, and giving it
// its own weaker limits would just move the brute-force target.
const IP_ATTEMPT_LIMIT = 30;
const IP_ATTEMPT_WINDOW = 15 * 60;
const USER_FAIL_LIMIT = 10;
const USER_FAIL_WINDOW = 15 * 60;

/** Bounded before a plugin ever sees them. */
const MAX_USERNAME_LEN = 128;
const MAX_PASSWORD_LEN = 1024;

/** One generic failure for every rejection an attacker could probe with. */
const GENERIC_FAILURE = { error: 'invalid_credentials' } as const;

/** Provider budget. A hung directory must not hold the request open. */
const VERIFY_TIMEOUT_MS = 10_000;

// A login body is a username + password; never legitimately large (C16, same
// class as native/login's C15 fix).
const MAX_LOGIN_BODY_BYTES = 16 * 1024;

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

export const POST: RequestHandler = withErrorHandler(async (event) => {
    const providerId = event.params.providerId;

    // The operator gate, checked PER REQUEST so removing an id from the env
    // closes this surface immediately — no restart, and no dependence on the
    // plugin system's restart-only unload.
    if (!isAuthProviderEnabled(providerId)) {
        return json({ error: 'not_found' }, { status: 404 });
    }
    const provider = taskRegistry.getAuthProvider(providerId);
    if (!provider || typeof provider.verifyCredentials !== 'function') {
        return json({ error: 'not_found' }, { status: 404 });
    }

    const rateLimitIp = getClientIpStrict(event);
    const ipGate = await checkRateLimit(
        `plugin-auth:ip:${rateLimitIp}`,
        IP_ATTEMPT_LIMIT,
        IP_ATTEMPT_WINDOW,
    );
    if (!ipGate.allowed) return json({ error: 'rate_limited' }, { status: 429 });

    // Reject an oversized body before buffering it (C16): a declared
    // Content-Length over the cap is rejected without touching the body
    // stream; the streamed read below then bounds a missing/lying
    // Content-Length the same way, instead of buffering an unbounded body
    // via a bare `request.json()`. Runs only AFTER the per-IP rate-limit
    // gate above, so an unauthenticated flood is refused before ever
    // costing a streaming read.
    if (isDeclaredContentLengthOverCap(event.request, MAX_LOGIN_BODY_BYTES)) {
        return json({ error: 'payload_too_large' }, { status: 413 });
    }
    const bodyText = await readBoundedBodyText(event.request, MAX_LOGIN_BODY_BYTES);
    if (bodyText === BODY_TOO_LARGE) {
        return json({ error: 'payload_too_large' }, { status: 413 });
    }
    let body: unknown;
    try {
        body = bodyText.trim() === '' ? {} : JSON.parse(bodyText);
    } catch {
        body = {};
    }
    if (!isRecord(body)) return json(GENERIC_FAILURE, { status: 401 });
    const username = toStringOr(body.username, '').trim();
    const password = toStringOr(body.password, '');
    if (!username || !password) return json(GENERIC_FAILURE, { status: 401 });
    if (username.length > MAX_USERNAME_LEN || password.length > MAX_PASSWORD_LEN) {
        return json(GENERIC_FAILURE, { status: 401 });
    }

    // Peek, not consume: reading the lockout must not itself count as an
    // attempt, or a locked-out account could never age out of its window.
    const userKey = `plugin-auth:user:${providerId}:${username.toLowerCase()}`;
    const userGate = await peekRateLimit(userKey, USER_FAIL_LIMIT, USER_FAIL_WINDOW);
    if (!userGate.allowed) return json({ error: 'rate_limited' }, { status: 429 });

    const raw = await settleWithin(
        Promise.resolve(
            provider.verifyCredentials(buildPluginContext(providerId), {
                username,
                password,
                clientIp: getClientIp(event),
            }),
        ),
        VERIFY_TIMEOUT_MS,
    );
    // FAILS CLOSED. A throw, a timeout or a malformed verdict is not a login —
    // the opposite of the playback veto, because an auth check that fails open
    // is an authentication bypass.
    const verdict =
        raw === null
            ? { ok: false as const, reason: 'unavailable' as const }
            : normalizeVerdict(raw);

    if (!verdict.ok) {
        // An outage is not an attack on this account, so it does not consume
        // that account's lockout budget.
        if (verdict.reason === 'invalid_credentials') {
            await checkRateLimit(userKey, USER_FAIL_LIMIT, USER_FAIL_WINDOW);
        } else {
            logger.warn('auth provider unavailable', { provider: providerId });
        }
        return json(GENERIC_FAILURE, { status: 401 });
    }

    // Everything from here is shared with the redirect kind — account linking,
    // the first-admin refusal, the suspension check and the session mint all
    // live in one place so the two flows cannot drift apart.
    const outcome = await establishPluginSession(event, providerId, verdict.identity);

    if (outcome.kind === 'not-linked') {
        // Actionable rather than generic: this is the operator's configuration
        // talking, not a credential failure, and "ask an admin to link your
        // account" is the only thing the user can act on.
        return json({ error: 'account_not_linked' }, { status: 403 });
    }
    if (outcome.kind === 'account-refused') {
        // Same generic failure as a bad password — a suspended account must not
        // be distinguishable from a nonexistent one.
        return json(GENERIC_FAILURE, { status: 401 });
    }
    if (outcome.kind === 'unavailable') {
        return json({ error: 'unavailable' }, { status: 503 });
    }

    // Clear the failure counter so earlier typos don't linger against a
    // now-proven account.
    await resetRateLimit(userKey, USER_FAIL_WINDOW);

    return json({ redirect: sanitizeRedirect(toStringOr(body.redirect, ''), '/') });
});
