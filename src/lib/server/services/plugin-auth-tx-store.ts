// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Single-use transaction store for redirect-kind auth providers.
 *
 * Between `/api/auth/plugin/<id>/start` and `/api/auth/plugin/<id>/callback` the
 * host must remember where to land the user and whatever opaque `txData` the
 * plugin asked to have echoed back — keyed by `state`.
 *
 * All of it lives SERVER-side. The obvious cheaper design is to put `txData` in
 * the cookie, and it is wrong: a cookie is attacker-supplied on the way back in
 * (HttpOnly stops a page reading it, not a client sending whatever it likes),
 * so a plugin's `completeLogin` would be handed tamperable input while
 * believing it came from its own `beginLogin`.
 *
 * Consumed exactly once via GETDEL, so two concurrent callbacks cannot both
 * read the same transaction and a replayed callback finds nothing. The `state`
 * is ALSO mirrored into an HttpOnly cookie by the route, binding the callback
 * to the browser that started the flow (login-CSRF defense) — the store gives
 * single-use, the cookie gives same-browser, and neither substitutes for the
 * other.
 *
 * Modelled on `oidc-tx-store.ts`, deliberately: this is the same problem, and
 * two different answers to it would be two things to review.
 */

import { cacheSet, getDel, isCoordinationValkeyReady } from '$lib/server/cache/valkey.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('PluginAuthTx');

/** Key namespace + version. Bump the version on a shape change. */
const TX_PREFIX = 'plugin-auth:tx:v1:';

/** How long a started login may sit before the user must restart it. */
const TX_TTL_SECONDS = 600; // 10 minutes

export interface PluginAuthTransaction {
    /** Which provider minted this. Verified at consume — see below. */
    pluginId: string;
    /** Same-origin relative path to land on after login (open-redirect guarded). */
    returnTo: string;
    /** Opaque plugin data, echoed back to `completeLogin` verbatim. */
    txData?: string;
}

/**
 * Persist a transaction under `state`. Returns false when the cache is down —
 * the caller must then refuse to start, rather than redirect a user into a flow
 * whose callback can never succeed.
 */
export async function storePluginAuthTx(
    state: string,
    tx: PluginAuthTransaction,
): Promise<boolean> {
    if (!isCoordinationValkeyReady()) {
        logger.warn('cannot start a plugin redirect login: cache unavailable');
        return false;
    }
    return cacheSet(TX_PREFIX + state, JSON.stringify(tx), TX_TTL_SECONDS);
}

/**
 * Atomically fetch-and-delete a transaction, then check it belongs to the
 * provider whose callback is asking.
 *
 * The provider check matters because the state cookie is scoped to the whole
 * `/api/auth/plugin` prefix — without it, a state issued by one provider could
 * be presented at another provider's callback, handing plugin B a transaction
 * plugin A started.
 *
 * A mismatch still CONSUMES the record. Putting it back would leave a state the
 * attacker now knows is live and replayable.
 */
export async function consumePluginAuthTx(
    state: string,
    expectedPluginId: string,
): Promise<PluginAuthTransaction | null> {
    if (!state || !isCoordinationValkeyReady()) return null;
    const raw = await getDel(TX_PREFIX + state);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as PluginAuthTransaction;
        if (typeof parsed.pluginId !== 'string' || typeof parsed.returnTo !== 'string') return null;
        if (parsed.pluginId !== expectedPluginId) {
            logger.warn('plugin auth state presented at the wrong provider callback', {
                issuedFor: parsed.pluginId,
                presentedAt: expectedPluginId,
            });
            return null;
        }
        return {
            pluginId: parsed.pluginId,
            returnTo: parsed.returnTo,
            txData: typeof parsed.txData === 'string' ? parsed.txData : undefined,
        };
    } catch {
        return null;
    }
}
