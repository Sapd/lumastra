// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `zAddBoundedExpiring` against a REAL Valkey server.
 *
 * `valkey-zadd-bounded.test.ts` (the mocked unit suite) proves the JS wrapper
 * issues one `EVAL` with the right KEYS/ARGV and interprets the reply
 * correctly — it asserts the Lua SOURCE by regex and re-implements the
 * admission decision in JS to simulate the server's reply. It never runs the
 * actual script. That leaves exactly one failure direction uncovered: a
 * script that is silently too PERMISSIVE (an overshoot-undo branch never
 * taken, a prune-boundary comparison off by a sign) would still make every
 * mocked assertion pass, because the mock supplies the "correct" reply
 * instead of a real server computing it. Fail-closed (this primitive's other
 * safety property) only catches a script that ERRORS — not one that quietly
 * lifts the cap it exists to enforce. This file closes that gap by running
 * the real script against a real server for the three properties that matter:
 *
 *  1. Admission up to the cap and refusal past it — from TWO INDEPENDENT
 *     client connections (two separate `cache/valkey.js` module instances,
 *     each with its own `GlideClient`), standing in for two web replicas that
 *     share nothing but the network. This is the property P1 exists to fix.
 *  2. The overshoot-undo path: a refused admission must not leave the
 *     just-added member behind.
 *  3. The prune boundary: a member older than its TTL is swept by a LATER
 *     admission call, and its slot becomes reusable.
 *
 * Skips (does not fail) when no Valkey is reachable via `CACHE_URL`, matching
 * the rest of the integration suite's posture toward an optional/absent
 * backend (see `valkey.integration.test.ts` in this directory). Point
 * `CACHE_URL` at a THROWAWAY Valkey you start yourself — these tests write
 * and delete arbitrary `test:integration:zadd-bounded:*` keys and must never
 * run against anything shared.
 *
 * Run standalone (no Postgres needed, unlike `npm run test:integration`):
 *   CACHE_URL=redis://localhost:<port>/0 \
 *     npx vitest run --config vitest.config.valkey-integration.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

type ValkeyModule = typeof import('./valkey.js');

let testKeyCounter = 0;
const uniqueKey = () => `test:integration:zadd-bounded:${testKeyCounter++}-${Date.now()}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A fresh `cache/valkey.js` module instance, connected to the same real
 * server every other instance in this file connects to. Each call is a
 * SEPARATE `GlideClient` — the closest a single Node process can get to
 * simulating two independent web replicas talking to one physical Valkey,
 * short of actually starting two processes.
 */
async function freshClient(): Promise<{ valkey: ValkeyModule; ok: boolean }> {
    const { vi } = await import('vitest');
    vi.resetModules();
    const valkey = (await import('./valkey.js')) as ValkeyModule;
    const ok = await valkey.connectValkey().catch(() => false);
    return { valkey, ok };
}

let available = false;
const usedKeys: string[] = [];
const cleanupClients: ValkeyModule[] = [];

beforeAll(async () => {
    if (!process.env.CACHE_URL) {
        console.warn(
            '⚠️  CACHE_URL not set — skipping zAddBoundedExpiring integration tests. ' +
                'Start a throwaway Valkey and set CACHE_URL to run these.',
        );
        return;
    }
    const { ok } = await freshClient();
    available = ok;
    if (!available) {
        console.warn('⚠️  Valkey unreachable at CACHE_URL — skipping.');
    } else {
        console.log('✓ Valkey connected for zAddBoundedExpiring integration tests');
    }
});

afterAll(async () => {
    if (!available) return;
    // Best-effort cleanup: remove every key this file wrote, on every client
    // connection this file opened (a key may have been written through a
    // different connection than the one closing here).
    for (const valkey of cleanupClients) {
        for (const key of usedKeys) {
            try {
                await valkey.getValkeyClient()?.customCommand(['DEL', key]);
            } catch {
                // best-effort
            }
        }
        try {
            await valkey.disconnectValkey();
        } catch {
            // best-effort
        }
    }
});

describe('zAddBoundedExpiring — real Valkey', () => {
    it('two independent client connections admit up to the cap TOGETHER, then both are refused', async (ctx) => {
        if (!available) return ctx.skip();

        const { valkey: clientA, ok: okA } = await freshClient();
        const { valkey: clientB, ok: okB } = await freshClient();
        expect(okA).toBe(true);
        expect(okB).toBe(true);
        cleanupClients.push(clientA, clientB);

        const key = uniqueKey();
        usedKeys.push(key);
        const cap = 2;
        const ttl = 60; // generous — this test does not exercise pruning

        // Cap is 2. One admission from each connection fills it exactly —
        // proving the two connections are deciding against the SAME server
        // state, not two independent in-memory counters.
        expect(await clientA.zAddBoundedExpiring(key, 'a-1', cap, ttl, { failOpen: false })).toBe(
            true,
        );
        expect(await clientB.zAddBoundedExpiring(key, 'b-1', cap, ttl, { failOpen: false })).toBe(
            true,
        );

        // The cap is now full. A THIRD admission from EITHER connection must
        // be refused — if the cap were per-connection (the P1 bug), clientA
        // and clientB would each have room for a second member here.
        expect(await clientA.zAddBoundedExpiring(key, 'a-2', cap, ttl, { failOpen: false })).toBe(
            false,
        );
        expect(await clientB.zAddBoundedExpiring(key, 'b-2', cap, ttl, { failOpen: false })).toBe(
            false,
        );

        // Both original members are still held — a refusal must never evict
        // an existing holder.
        expect(await clientA.zCountFrom(key, 0)).toBe(2);
    });

    it('overshoot-undo: a refused admission does not leave its member in the set', async (ctx) => {
        if (!available) return ctx.skip();

        const { valkey, ok } = await freshClient();
        expect(ok).toBe(true);
        cleanupClients.push(valkey);

        const key = uniqueKey();
        usedKeys.push(key);
        const cap = 1;

        expect(await valkey.zAddBoundedExpiring(key, 'holder', cap, 60, { failOpen: false })).toBe(
            true,
        );
        expect(await valkey.zAddBoundedExpiring(key, 'refused', cap, 60, { failOpen: false })).toBe(
            false,
        );

        // The whole point of the overshoot-undo branch: `refused` must never
        // have been left behind by the ZADD the script issued before it
        // discovered the cardinality check failed. zRem reports how many
        // members it actually removed — 0 means "was never a member".
        expect(await valkey.zRem(key, 'refused')).toBe(0);
        // The original holder is untouched.
        expect(await valkey.zRem(key, 'holder')).toBe(1);
    });

    it('prune boundary: a member older than its TTL is swept by a later admission, freeing its slot', async (ctx) => {
        if (!available) return ctx.skip();

        const { valkey, ok } = await freshClient();
        expect(ok).toBe(true);
        cleanupClients.push(valkey);

        const key = uniqueKey();
        usedKeys.push(key);
        const cap = 1;
        const shortTtlSeconds = 1;

        // Fill the (cap=1) set with a short-lived member.
        expect(
            await valkey.zAddBoundedExpiring(key, 'stale', cap, shortTtlSeconds, {
                failOpen: false,
            }),
        ).toBe(true);

        // While still fresh, a second admission is correctly refused — the
        // slot is genuinely occupied, not already free.
        expect(
            await valkey.zAddBoundedExpiring(key, 'too-early', cap, shortTtlSeconds, {
                failOpen: false,
            }),
        ).toBe(false);

        // Let the first member age past its TTL.
        await sleep(1500);

        // A later admission's own prune step (ZREMRANGEBYSCORE, run before the
        // cardinality check in the same script) must sweep the stale member
        // and free its slot — this is what makes a crash/lost-release
        // survivable instead of a cap that fills with zombies and refuses
        // forever under continuous traffic.
        expect(
            await valkey.zAddBoundedExpiring(key, 'fresh', cap, shortTtlSeconds, {
                failOpen: false,
            }),
        ).toBe(true);

        // The stale member is genuinely gone (not just "over cap and ignored").
        expect(await valkey.zRem(key, 'stale')).toBe(0);
        // The fresh member holds the slot.
        expect(await valkey.zRem(key, 'fresh')).toBe(1);
    });
});
