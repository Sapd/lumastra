// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The APNs provider authentication token: an ES256 JWT, minted locally, cached,
 * and re-minted on a schedule Apple dictates.
 *
 * Apple's rules and why each one shapes the code here:
 *
 * - The token must be **regenerated between 20 and 60 minutes**. Reuse past 60
 *   minutes returns `403 ExpiredProviderToken`; minting a fresh one more often
 *   than every 20 minutes returns `429 TooManyProviderTokenUpdates`. Both are
 *   failures, in opposite directions, so the TTL sits in the middle at ~40 min.
 * - A token is *not* per-request. Minting one per push would trip the 20-minute
 *   floor almost immediately at any real volume.
 *
 * @module services/push/apns-provider-token
 */

import { importPKCS8, SignJWT, type CryptoKey } from 'jose';
import { Logger } from '$lib/server/utils/logger.js';

const log = Logger.for('ApnsProviderToken');

export interface ProviderTokenOptions {
    keyP8: string;
    keyId: string;
    teamId: string;
    /** Reuse window. Must stay inside Apple's 20–60 minute band. */
    ttlMs: number;
    /**
     * Floor between *forced* re-mints (the 403 path). Without it, a key Apple
     * has stopped recognising turns every push into mint-retry-fail and earns
     * a `TooManyProviderTokenUpdates` throttle on top of the original fault.
     */
    minRemintIntervalMs: number;
    now?: () => number;
}

interface CachedToken {
    jwt: string;
    mintedAt: number;
}

export class ProviderTokenStore {
    readonly #options: ProviderTokenOptions;
    readonly #now: () => number;

    #signingKey: Promise<CryptoKey> | null = null;
    #cached: CachedToken | null = null;
    /** De-duplicates concurrent mints across a fan-out. */
    #inflight: Promise<CachedToken> | null = null;
    #lastForcedRemintAt = 0;

    /** Test/metrics hook: how many JWTs this store has actually signed. */
    #mintCount = 0;

    constructor(options: ProviderTokenOptions) {
        this.#options = options;
        this.#now = options.now ?? Date.now;
    }

    get mintCount(): number {
        return this.#mintCount;
    }

    /**
     * The current provider token, minting one only if there is none or the
     * cached one has aged past the TTL.
     */
    async get(): Promise<string> {
        const cached = this.#cached;
        if (cached && this.#now() - cached.mintedAt < this.#options.ttlMs) {
            return cached.jwt;
        }
        return (await this.#mintShared()).jwt;
    }

    /**
     * Force a re-mint after APNs rejected `staleJwt` with
     * `403 ExpiredProviderToken`, and return the token to retry with.
     *
     * A fan-out of N tokens gets N simultaneous 403s from one expired JWT. Each
     * calls this, and only the first re-mints: the rest observe that the cache
     * no longer holds `staleJwt` and take the fresh one. Without the
     * compare-and-swap, one expiry would mint N tokens and convert a recoverable
     * 403 into a `TooManyProviderTokenUpdates` throttle.
     */
    async refresh(staleJwt: string): Promise<string> {
        const cached = this.#cached;
        if (cached && cached.jwt !== staleJwt) {
            // Someone already replaced it.
            return cached.jwt;
        }

        const now = this.#now();
        const sinceLast = now - this.#lastForcedRemintAt;
        if (this.#lastForcedRemintAt !== 0 && sinceLast < this.#options.minRemintIntervalMs) {
            log.warn('suppressing forced provider-token re-mint', {
                sinceLastForcedRemintMs: sinceLast,
                minRemintIntervalMs: this.#options.minRemintIntervalMs,
                hint: 'Repeated ExpiredProviderToken with a fresh JWT usually means server clock skew or a revoked key, not an expired token.',
            });
            return cached?.jwt ?? (await this.#mintShared()).jwt;
        }

        this.#lastForcedRemintAt = now;
        this.#cached = null;
        const minted = await this.#mintShared();
        log.info('re-minted provider token after ExpiredProviderToken');
        return minted.jwt;
    }

    /** Drops the cache. Correct after a configuration reload. */
    invalidate(): void {
        this.#cached = null;
    }

    async #mintShared(): Promise<CachedToken> {
        if (this.#inflight) return this.#inflight;

        const pending = this.#mint()
            .then((token) => {
                this.#cached = token;
                return token;
            })
            .finally(() => {
                this.#inflight = null;
            });

        this.#inflight = pending;
        return pending;
    }

    async #mint(): Promise<CachedToken> {
        this.#signingKey ??= importPKCS8(this.#options.keyP8, 'ES256');
        const key = await this.#signingKey;

        const mintedAt = this.#now();
        const issuedAtSeconds = Math.floor(mintedAt / 1000);

        // Apple's provider token carries exactly two claims. `exp` is
        // deliberately absent: Apple derives validity from `iat` and its own
        // 60-minute rule, and an `exp` we invent is not consulted.
        const jwt = await new SignJWT({})
            .setProtectedHeader({ alg: 'ES256', kid: this.#options.keyId })
            .setIssuer(this.#options.teamId)
            .setIssuedAt(issuedAtSeconds)
            .sign(key);

        this.#mintCount += 1;
        return { jwt, mintedAt };
    }
}
