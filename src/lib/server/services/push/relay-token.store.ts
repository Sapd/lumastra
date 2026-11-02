// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The relay credential, from either of two sources.
 *
 * ## Precedence: `config.PUSH_RELAY_TOKEN` first, licence-minted token second
 *
 * The configured key wins whenever it is non-empty. It is what an operator
 * running their own relay sets (point `PUSH_RELAY_URL` at it, put the bearer it
 * expects here, done), and an operator-supplied value is never overridden by
 * whatever the licence server said.
 *
 * Otherwise the credential is the **licence-minted relay token**: every licence
 * issue/refresh response from lumastra.org carries a `relayToken` — an ES256 JWT
 * bound to this install's uuid, valid for at most 24 hours — and
 * `maybeRefreshLicense()` hands it to {@link setRelayToken}. The refresh loop
 * calls the server whenever {@link relayTokenNeedsRenewal} says so (in practice
 * every 6-hour tick while push uses the default relay), independently of whether
 * the licence itself needs renewing. That is what makes push work out of the box
 * on every install, free tier included.
 *
 * ## Why a separate short-lived token, not the license JWT
 *
 * The license JWT's `exp` is the license term, the relay is stateless so
 * nothing can be revoked against it, and a relay checking `exp` strictly would
 * reject during exactly the license-server outage that the local grace window
 * exists to absorb. A ≤24h relay-scoped token bounds replay to a day, makes
 * revocation effective within one refresh cycle, and keeps the grace question
 * away from the relay entirely.
 *
 * ## Expiry
 *
 * The store remembers when the minted token expires (the server's
 * `relayTokenExp`, else the JWT's own `exp`, capped at 24h from receipt) and
 * {@link getRelayToken} stops returning it a minute before then. An install
 * whose refreshes keep failing therefore degrades cleanly: capabilities report
 * `unavailable_reason: 'no_relay_credential'` and `RelayTransport` raises
 * `no_credential` without calling the relay, instead of sending a token the
 * relay would 401.
 *
 * The token is held in memory per process. Every process that needs it (web for
 * capabilities, worker for delivery) runs its own refresh loop — the licensing
 * module is loaded at boot in each. The loop also shares the minted token via
 * Valkey (relay-token.shared.ts) and adopts a sibling's fresher copy
 * ({@link adoptRelayTokenIfFresher}) before deciding to call the server, so a
 * restart or a second process does not fetch a token of its own.
 *
 * @module services/push/relay-token
 */

import { decodeJwt } from 'jose';
import { config } from '$lib/server/config.js';

/** The licensing server never mints longer; a claim beyond this is capped. */
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** Stop presenting a token this long before it expires (relay clock skew is 60s). */
const EXPIRY_MARGIN_MS = 60 * 1000;
/**
 * Renew once less than this much life is left. With 24h tokens and the 6h
 * refresh tick this renews on every tick, so three consecutive failed ticks
 * still leave a valid token.
 */
const RENEW_WHEN_REMAINING_MS = 20 * 60 * 60 * 1000;

interface HeldToken {
    token: string;
    expiresAtMs: number;
}

let held: HeldToken | null = null;
const invalidationListeners = new Set<() => void>();

function unverifiedExpMs(token: string): number | null {
    try {
        const exp = decodeJwt(token).exp;
        return typeof exp === 'number' ? exp * 1000 : null;
    } catch {
        return null;
    }
}

/**
 * Called by the license refresh loop when the server returns a relay token.
 *
 * @param expiresAtEpochSeconds the server's `relayTokenExp`; when absent the
 *   JWT's own `exp` is read (unverified — the relay verifies), and failing
 *   that the token is assumed to live 24h. Always capped at 24h from now.
 */
export function setRelayToken(
    token: string | null,
    expiresAtEpochSeconds?: number,
    now: number = Date.now(),
): void {
    if (!token) {
        held = null;
        return;
    }
    const claimed =
        typeof expiresAtEpochSeconds === 'number' && Number.isFinite(expiresAtEpochSeconds)
            ? expiresAtEpochSeconds * 1000
            : (unverifiedExpMs(token) ?? now + MAX_LIFETIME_MS);
    held = { token, expiresAtMs: Math.min(claimed, now + MAX_LIFETIME_MS) };
}

/**
 * Adopt a token another process minted (see relay-token.shared.ts) when it
 * outlives the one held here. Returns true when it was adopted.
 */
export function adoptRelayTokenIfFresher(
    token: string,
    expiresAtMs: number,
    now: number = Date.now(),
): boolean {
    if (!token) return false;
    const capped = Math.min(expiresAtMs, now + MAX_LIFETIME_MS);
    if (held && held.expiresAtMs >= capped) return false;
    held = { token, expiresAtMs: capped };
    return true;
}

/** Expiry (epoch ms) of the held minted token, or null. */
export function heldRelayTokenExpiresAtMs(): number | null {
    return held?.expiresAtMs ?? null;
}

function configuredToken(): string | null {
    const configured = config.PUSH_RELAY_TOKEN.trim();
    return configured.length > 0 ? configured : null;
}

function liveMintedToken(now: number): string | null {
    if (!held) return null;
    return now < held.expiresAtMs - EXPIRY_MARGIN_MS ? held.token : null;
}

/**
 * The credential to present to the relay, or null when this install has none.
 *
 * Null is a structural fact about the install at this moment, not a transient
 * outage — callers must treat it that way (see `RelayTransport.send`, which
 * raises `no_credential` rather than `unauthenticated`).
 */
export function getRelayToken(now: number = Date.now()): string | null {
    const configured = configuredToken();
    if (configured) return configured;
    try {
        if (new URL(config.PUSH_RELAY_URL).origin !== new URL('https://push.lumastra.org').origin)
            return null;
    } catch {
        return null;
    }
    return liveMintedToken(now);
}

/**
 * Whether this install holds a relay credential at all.
 *
 * Read by the capabilities endpoint so a client is never told push is available
 * on an install that cannot authenticate to the relay.
 */
export function hasRelayCredential(now: number = Date.now()): boolean {
    return getRelayToken(now) !== null;
}

/**
 * Whether the licence refresh should fetch a new minted token: no configured
 * token, and none held or the held one past its renewal point. Says nothing
 * about whether push is on or uses the relay — the caller checks that.
 */
export function relayTokenNeedsRenewal(now: number = Date.now()): boolean {
    if (configuredToken()) return false;
    return !held || held.expiresAtMs - now < RENEW_WHEN_REMAINING_MS;
}

/** Whether a minted (not configured) token is currently usable. */
export function hasLiveMintedRelayToken(now: number = Date.now()): boolean {
    return liveMintedToken(now) !== null;
}

/**
 * Called on a 401 so the next refresh replaces the licence-minted token, and
 * tells listeners (the refresh loop) to fetch one soon rather than at the next
 * 6-hour tick.
 *
 * Deliberately does NOT clear `config.PUSH_RELAY_TOKEN` — an operator-supplied
 * credential is not ours to discard, and nothing would ever put it back. A
 * configured token the relay rejects keeps 401ing, which surfaces as the row
 * riding the ladder and dying `max_attempts`, with the relay's rejection in the
 * logs. That is the correct signal: the operator has to fix the value.
 */
export function invalidateRelayToken(): void {
    const hadMinted = held !== null;
    held = null;
    if (!hadMinted || configuredToken()) return;
    for (const listener of invalidationListeners) {
        try {
            listener();
        } catch {
            // A listener's failure must not break the transport that called us.
        }
    }
}

/**
 * Register a callback for "the minted token was rejected". Used by the
 * proprietary licence refresh loop (proprietary → core, the permitted
 * direction) to schedule an early refresh. Returns an unsubscribe function.
 */
export function onRelayTokenInvalidated(listener: () => void): () => void {
    invalidationListeners.add(listener);
    return () => invalidationListeners.delete(listener);
}
