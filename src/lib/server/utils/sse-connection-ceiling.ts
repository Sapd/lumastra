// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared per-user SSE connection-slot accounting (P1, 2026-09-13 fix plan;
 * rewritten 2026-09-26 to fix a production leak in the original design).
 *
 * Extracted from `sse-replay-hub.ts` (which used this to bound `/events`,
 * `/runs/stream`, and `/admin/ingest/stream`) so the watch-together SSE path
 * — a completely separate connection registry, not `createSseReplayHub` — can
 * reuse the EXACT same mechanism (fix round 1, finding 2) instead of
 * reimplementing it.
 *
 * ## The 2026-09-26 rewrite
 *
 * The original design kept ONE Valkey counter per (namespace, user): INCR on
 * connect, DECR on release, with a TTL "safety net" refreshed on every INCR
 * — and, after the final fix wave, on every keepalive tick of ANY live
 * connection too. That refresh was the bug: as long as the user kept even
 * ONE tab open, every keepalive tick re-armed the SAME shared key's TTL, so
 * phantom counts left behind by a replica that died mid-connection (every
 * deploy restarts replicas without running their in-flight DECRs) never
 * expired. On prod this pinned a user's counter at the cap with no real
 * connections behind most of it, so every new tab got a permanent 429.
 * There is no way to refresh "this connection's contribution" inside a
 * single shared counter — the old header comment's claim that a dead
 * replica "self-heals" was false.
 *
 * This version tracks membership instead of a count: a Valkey SORTED SET
 * `sse:conns:v2:${namespace}:${userId}` (a new key name so any stale v1
 * counter left over from before this deploy is simply ignored — it is a
 * different key and has its own, much shorter, TTL anyway), one member per
 * live connection (a random id), scored by that connection's own last-seen
 * time. `refresh()` now only touches ITS OWN member's score, so a dead
 * replica's abandoned members age out independently of whatever the user's
 * other tabs are doing. `acquireUserConnectionSlot()` prunes every member
 * older than `staleMs` before checking the cap, so a leaked member is
 * reclaimed automatically the next time this user tries to open a
 * connection — no separate sweep process needed.
 *
 * Falls back to an in-process `Map` per `namespace` when Valkey is
 * unavailable — same fallback philosophy as `checkRateLimit()` in
 * valkey-rate-limit.ts: degrade to a per-process budget, never silently
 * "open". Semantics of the fallback are unchanged from the original design.
 */

import { randomUUID } from 'node:crypto';
import { getCoordinationClient } from '$lib/server/cache/valkey.js';
import { SSE_KEEPALIVE_MS } from '$lib/server/utils/sse.js';

type ValkeyLike = { customCommand: (cmd: string[]) => Promise<unknown> };

/**
 * How long a connection's membership survives without a `refresh()` before
 * `acquireUserConnectionSlot()` prunes it as dead.
 *
 * Every caller of `acquireUserConnectionSlot()` refreshes its slot from its
 * own keepalive tick (see `sse-connection-guard.ts`'s
 * `startGuardedSseKeepalive`, `sse-replay-hub.ts`'s `streamResponse()`, and
 * the watch-together SSE route — all three call `slot.refresh()` on every
 * tick). All of them run on the single shared {@link SSE_KEEPALIVE_MS}
 * cadence (10 s) — there is no caller with a longer interval today. Staleness
 * is set to 3x that cadence (30 s) so a member survives at least two missed
 * ticks (a slow event loop, a GC pause, a brief Valkey blip) before being
 * treated as abandoned. If a future caller ever refreshes on a slower
 * cadence, this constant must grow to stay >= 3x THAT interval, or its
 * connections will be pruned while still alive.
 */
const STALE_MS = 3 * SSE_KEEPALIVE_MS;

/**
 * TTL applied to the whole sorted-set key on every acquire/refresh. Purely a
 * safety net for the case where NOTHING ever refreshes again (e.g. every
 * connection for this user dies without releasing) — `staleMs`-based pruning
 * on the next acquire already reclaims individual members long before this
 * fires. Comfortably longer than `STALE_MS` so a live connection's own
 * refresh always re-arms it first.
 */
const KEY_TTL_MS = STALE_MS * 2;

/**
 * In-process fallback counters, one Map per `namespace` so unrelated callers
 * (the shared SSE hub, watch-together, …) never share counters when Valkey is
 * unavailable.
 */
const localCountsByNamespace = new Map<string, Map<string, number>>();

function localCountsFor(namespace: string): Map<string, number> {
    let m = localCountsByNamespace.get(namespace);
    if (!m) {
        m = new Map();
        localCountsByNamespace.set(namespace, m);
    }
    return m;
}

export interface ConnectionSlot {
    /** Whether a slot was reserved. `false` means the caller is at their cap. */
    ok: boolean;
    /**
     * Give the slot back. Idempotent — safe to call more than once (only the
     * first call has any effect), so every teardown path of a connection
     * registry can call it unconditionally without coordinating who "owns"
     * the release.
     */
    release: () => void;
    /**
     * Refresh THIS connection's own membership — bumps its score to "now"
     * (only if it is still present in the set) and re-arms the key's overall
     * TTL. Call this periodically from a long-lived connection's own
     * keepalive tick (see `sse-connection-guard.ts` and the watch-together
     * SSE route, which both already have one). No-op for the in-process
     * fallback (a local counter has no per-connection membership to refresh)
     * and for a slot that was never granted (`ok: false`).
     */
    refresh: () => void;
}

/** Lua: prune stale members, then admit a new member if under the cap. */
const ACQUIRE_LUA = `
    redis.call("zremrangebyscore", KEYS[1], "-inf", tonumber(ARGV[2]) - tonumber(ARGV[4]))
    local card = redis.call("zcard", KEYS[1])
    if card >= tonumber(ARGV[3]) then
        return 0
    end
    redis.call("zadd", KEYS[1], ARGV[2], ARGV[1])
    redis.call("pexpire", KEYS[1], ARGV[5])
    return 1
`;

/** Lua: bump this connection's own score, only if it is still a member. */
const REFRESH_LUA = `
    local updated = redis.call("zadd", KEYS[1], "XX", ARGV[2], ARGV[1])
    if updated == 1 then
        redis.call("pexpire", KEYS[1], ARGV[3])
    end
    return updated
`;

/**
 * Reserve one connection slot for `userId` within `namespace` (a short,
 * stable string identifying the CALLER — e.g. a hub's `replayKey`, or
 * `'watch-together'` — so different SSE surfaces never share one budget).
 *
 * Returns `{ok: false}` immediately (no slot reserved) once the user already
 * holds `maxPerUser` live (non-stale) connections in this namespace.
 */
export async function acquireUserConnectionSlot(
    namespace: string,
    userId: string,
    maxPerUser: number,
): Promise<ConnectionSlot> {
    const client = getCoordinationClient() as unknown as ValkeyLike | null;
    if (client) {
        const key = `sse:conns:v2:${namespace}:${userId}`;
        const member = randomUUID();
        try {
            const now = Date.now();
            const raw = await client.customCommand([
                'EVAL',
                ACQUIRE_LUA,
                '1',
                key,
                member,
                String(now),
                String(maxPerUser),
                String(STALE_MS),
                String(KEY_TTL_MS),
            ]);
            const admitted = raw === 1 || raw === '1';
            if (!admitted) {
                return { ok: false, release: () => {}, refresh: () => {} };
            }

            let released = false;
            return {
                ok: true,
                release: () => {
                    if (released) return;
                    released = true;
                    void client.customCommand(['ZREM', key, member]).catch(() => {
                        // Best-effort — a failed release just leaves this
                        // member to be pruned by staleness on a future
                        // acquire.
                    });
                },
                refresh: () => {
                    void client
                        .customCommand([
                            'EVAL',
                            REFRESH_LUA,
                            '1',
                            key,
                            member,
                            String(Date.now()),
                            String(KEY_TTL_MS),
                        ])
                        .catch(() => {
                            // Best-effort — a missed refresh just means this
                            // member goes stale sooner than it otherwise
                            // would, which the next acquire's prune step
                            // handles gracefully.
                        });
                },
            };
        } catch {
            // Fall through to the in-process fallback below.
        }
    }

    const local = localCountsFor(namespace);
    const current = local.get(userId) ?? 0;
    if (current >= maxPerUser) {
        return { ok: false, release: () => {}, refresh: () => {} };
    }
    local.set(userId, current + 1);
    let released = false;
    return {
        ok: true,
        release: () => {
            if (released) return;
            released = true;
            const next = (local.get(userId) ?? 1) - 1;
            if (next <= 0) local.delete(userId);
            else local.set(userId, next);
        },
        // No per-connection membership on the in-process fallback — nothing
        // to refresh.
        refresh: () => {},
    };
}
