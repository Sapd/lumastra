// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Single-use OIDC login-transaction store (Valkey-backed).
 *
 * Between the `/auth/oidc/login` redirect and the `/auth/oidc/callback` we must
 * remember the per-request `nonce`, PKCE `code_verifier`, and `returnTo`, keyed by
 * the `state` value. State lives server-side (never in a client-readable place) so
 * it can't be tampered with, has a short TTL, and is consumed exactly once on
 * callback — a replayed callback finds nothing and is rejected. The `state` is also
 * mirrored into an HttpOnly cookie by the route so the callback is bound to the
 * SAME browser that started the flow (login-CSRF defense).
 *
 * Cross-replica safe (Valkey is shared). AGPL-core.
 */

import { cacheSet, getDel, isCoordinationValkeyReady } from '$lib/server/cache/valkey.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('OidcTx');

/** Key namespace + version. Bump the version on a shape change. */
const TX_PREFIX = 'oidc:tx:v1:';

/** How long a started login may sit before the user must restart it. */
const TX_TTL_SECONDS = 600; // 10 minutes

export interface OidcTransaction {
    nonce: string;
    codeVerifier: string;
    /** Same-origin relative path to land on after login (open-redirect guarded). */
    returnTo: string;
    /** The redirect_uri sent to the IdP — must be replayed identically at exchange. */
    redirectUri: string;
}

/** Persist a login transaction under `state`. Returns false if Valkey is down. */
export async function storeTx(state: string, tx: OidcTransaction): Promise<boolean> {
    if (!isCoordinationValkeyReady()) {
        logger.warn('Cannot start OIDC login: cache unavailable');
        return false;
    }
    return cacheSet(TX_PREFIX + state, JSON.stringify(tx), TX_TTL_SECONDS);
}

/**
 * Atomically fetch-and-delete a login transaction (single use) via GETDEL, so two
 * concurrent callbacks can't both read the same transaction. Returns null if it is
 * unknown/expired/already-consumed.
 */
export async function consumeTx(state: string): Promise<OidcTransaction | null> {
    if (!state || !isCoordinationValkeyReady()) return null;
    const key = TX_PREFIX + state;
    const raw = await getDel(key);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as OidcTransaction;
        if (
            typeof parsed.nonce === 'string' &&
            typeof parsed.codeVerifier === 'string' &&
            typeof parsed.returnTo === 'string' &&
            typeof parsed.redirectUri === 'string'
        ) {
            return parsed;
        }
        return null;
    } catch {
        return null;
    }
}
