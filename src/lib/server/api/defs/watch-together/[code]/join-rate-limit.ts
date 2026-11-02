// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared rate limit for the two Watch Together join paths.
 *
 * A join attempt is a guess at a 6-character code (32^6 ≈ 1.07e9), and nothing
 * else in this subsystem is rate limited — there is no per-endpoint limiter on
 * watch-together and no edge limiter to fall back on (the production reverse
 * proxy declares a `limit_conn_zone` it never applies, and a self-hosted install
 * may have no proxy at all).
 *
 * **This is friction, not a boundary, and the numbers say why.** Exhausting the
 * keyspace at 10 req/s takes ~3.4 years; the realistic attack was never brute
 * force but the missing access check on join, which is fixed separately. The
 * limit exists so an authenticated account cannot cheaply sweep for live
 * parties, and so a stuck client cannot hammer the endpoint.
 *
 * The budget is deliberately generous. Legitimate joins are rare — a person
 * joins a party once — but a reconnecting client re-joins, and a family all
 * arriving at once must not trip a shared limit. Keyed per user, so one noisy
 * account cannot lock anyone else out.
 *
 * Lives in a sibling module rather than inline because BOTH join paths need it
 * (`join.ts` and the `type:'join'` branch of `events.ts`), and a limit applied
 * to only one of two doors is not a limit. It is a plain `.ts` file, not a
 * `+server.ts`, because SvelteKit route files may export only reserved names.
 */

import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { isExistingParticipant } from '$lib/server/services/watch-together.service.js';

/** Attempts per window, per user, across both join paths. */
export const JOIN_RATE_LIMIT_MAX = 20;
export const JOIN_RATE_LIMIT_WINDOW_S = 60;

export interface JoinRateLimitVerdict {
    allowed: boolean;
    /** Seconds until the window resets — for the Retry-After header. */
    retryAfter: number;
}

/**
 * One shared key per user across both paths, so an attacker cannot double their
 * budget by alternating between `/join` and `/events`.
 *
 * **Idempotent rejoins are exempt.** A client that is already a participant
 * with this `clientId` is re-entering a party it passed the access gate for,
 * and `joinSession` will early-return without touching the roster. Charging
 * those meant a flaky connection could reconnect itself out of its own party:
 * twenty SSE drops in a minute exhausted the budget and the next rejoin got a
 * 429 instead of its session back. The exemption gives an attacker nothing — a
 * guessed code resolves to a session they are not in, so they still pay.
 */
export async function checkJoinRateLimit(
    code: string,
    userId: string,
    clientId: string | undefined,
): Promise<JoinRateLimitVerdict> {
    if (await isExistingParticipant(code, userId, clientId)) {
        return { allowed: true, retryAfter: 0 };
    }

    const rl = await checkRateLimit(
        `wt-join:${userId}`,
        JOIN_RATE_LIMIT_MAX,
        JOIN_RATE_LIMIT_WINDOW_S,
    );
    return {
        allowed: rl.allowed,
        retryAfter: Math.max(1, Math.ceil(rl.resetAt - Date.now() / 1000)),
    };
}
