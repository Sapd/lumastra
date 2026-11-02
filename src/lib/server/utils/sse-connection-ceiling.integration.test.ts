// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real-Valkey coverage for the acquire/refresh Lua scripts in
 * `sse-connection-ceiling.ts` (production leak fix, 2026-09-26). The unit
 * tests in `sse-connection-ceiling.test.ts` reimplement the scripts'
 * semantics in JS against a mocked `customCommand`; this file runs the
 * ACTUAL Lua against a real Valkey instance so a subtle EVAL syntax or
 * argument-ordering mistake (which a JS reimplementation of the same mistake
 * would happily agree with) cannot hide behind a green unit suite.
 *
 * Requires:
 *   - CACHE_URL pointing at a Valkey instance (rewritten onto scratch DB 15
 *     by vitest.integration.config.ts).
 *
 * Skipped automatically when CACHE_URL is absent.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
    connectValkey,
    disconnectValkey,
    getCoordinationClient,
} from '$lib/server/cache/valkey.js';
import { acquireUserConnectionSlot } from './sse-connection-ceiling.js';

const CACHE_URL = process.env.CACHE_URL ?? '';
const RUN = Boolean(CACHE_URL);

describe.runIf(RUN)('acquireUserConnectionSlot — real Valkey', () => {
    // Unique namespace per test run so concurrent sessions against the same
    // scratch DB (15) never collide on the same sorted-set keys.
    const namespace = `it:sse-conn-ceiling:${randomUUID()}`;

    beforeAll(async () => {
        await connectValkey();
    }, 30_000);

    afterAll(async () => {
        await disconnectValkey();
    });

    beforeEach(async () => {
        // Best-effort cleanup between tests — each test uses its own userId
        // suffix too, but this keeps the scratch DB tidy either way.
        const client = getCoordinationClient() as unknown as {
            customCommand: (cmd: string[]) => Promise<unknown>;
        } | null;
        if (client) {
            const keys = await client.customCommand(['KEYS', `sse:conns:v2:${namespace}:*`]);
            if (Array.isArray(keys) && keys.length > 0) {
                await client.customCommand(['DEL', ...(keys as string[])]);
            }
        }
    });

    it('admits up to the cap and refuses the connection over it', async () => {
        const userId = `user-${randomUUID()}`;
        const first = await acquireUserConnectionSlot(namespace, userId, 2);
        const second = await acquireUserConnectionSlot(namespace, userId, 2);
        const third = await acquireUserConnectionSlot(namespace, userId, 2);

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        expect(third.ok).toBe(false);

        first.release();
        second.release();
    });

    it('release() frees a slot for a subsequent acquire', async () => {
        const userId = `user-${randomUUID()}`;
        const first = await acquireUserConnectionSlot(namespace, userId, 1);
        expect(first.ok).toBe(true);

        const blocked = await acquireUserConnectionSlot(namespace, userId, 1);
        expect(blocked.ok).toBe(false);

        first.release();
        // release() fires its ZREM fire-and-forget; give it a tick.
        await new Promise((r) => setTimeout(r, 50));

        const afterRelease = await acquireUserConnectionSlot(namespace, userId, 1);
        expect(afterRelease.ok).toBe(true);
        afterRelease.release();
    });

    it('a stale member (never refreshed, past the staleness window) is pruned on the next acquire', async () => {
        const userId = `user-${randomUUID()}`;
        const key = `sse:conns:v2:${namespace}:${userId}`;
        const client = getCoordinationClient() as unknown as {
            customCommand: (cmd: string[]) => Promise<unknown>;
        };

        // Seed a member scored well in the past — simulates a connection
        // whose replica died before ever refreshing it, long enough ago to
        // be past the module's staleness window (3x the 10s keepalive
        // cadence = 30s).
        const staleMember = randomUUID();
        await client.customCommand(['ZADD', key, String(Date.now() - 120_000), staleMember]);

        // Cap of 1: the stale member alone would occupy the only slot if it
        // were not pruned first.
        const slot = await acquireUserConnectionSlot(namespace, userId, 1);
        expect(slot.ok).toBe(true);

        const card = await client.customCommand(['ZCARD', key]);
        // The stale member was pruned; only the newly-acquired one remains.
        expect(Number(card)).toBe(1);

        slot.release();
    });

    it("refresh() keeps a live member's score current so it survives a prune that removes an abandoned sibling", async () => {
        const userId = `user-${randomUUID()}`;
        const key = `sse:conns:v2:${namespace}:${userId}`;
        const client = getCoordinationClient() as unknown as {
            customCommand: (cmd: string[]) => Promise<unknown>;
        };

        const live = await acquireUserConnectionSlot(namespace, userId, 2);
        expect(live.ok).toBe(true);

        // Manually plant a second, abandoned member scored in the past —
        // stands in for a sibling connection whose replica died.
        const abandonedMember = randomUUID();
        await client.customCommand(['ZADD', key, String(Date.now() - 120_000), abandonedMember]);

        // Refresh the live slot repeatedly — its score stays "now".
        live.refresh();
        await new Promise((r) => setTimeout(r, 50));

        // A third acquire prunes the abandoned member (score too old) but
        // must NOT touch the live one, then admits itself into the freed slot.
        const third = await acquireUserConnectionSlot(namespace, userId, 2);
        expect(third.ok).toBe(true);

        const members = await client.customCommand(['ZRANGE', key, '0', '-1']);
        expect(Array.isArray(members)).toBe(true);
        expect(members as string[]).not.toContain(abandonedMember);

        live.release();
        third.release();
    });
});
