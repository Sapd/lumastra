// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fail-closed policy for acquireLock / renewLock under HA split.
 *
 * valkey.ts reads CACHE_URL and TASK_CACHE_URL into module-level consts
 * (COORD_IS_SEPARATE, COORD_URL) at import time. To vary those consts we must
 * set the env BEFORE a fresh dynamic import (vi.resetModules()) — the same
 * pattern used by valkey.integration.test.ts.
 *
 * Two scenarios:
 *
 * A) COORD_IS_SEPARATE === true AND the coordination client is null (down at
 *    boot, or failed to connect). acquireLock must return null and renewLock
 *    must return false — they must NOT fall back to the per-process in-memory
 *    store, because that would grant each replica its own "exclusive" lock
 *    (no cross-replica exclusion at all).
 *
 * B) COORD_IS_SEPARATE === false (single-node / dev). When valkeyClient is
 *    also null (Valkey unreachable), the in-memory fallback IS used and
 *    acquireLock returns a non-null token.
 *
 * Neither scenario needs a live Valkey server: the module can be imported,
 * connectValkey() deliberately skipped (leaving valkeyClient null), and the
 * behaviour observed through the exported lock helpers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Fresh import of valkey.ts with the given environment variables pre-set.
 * Uses vi.resetModules() so the module-level COORD_IS_SEPARATE const is
 * re-evaluated against the env we pass in.
 */
async function freshValkey(env: Record<string, string>) {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) {
        process.env[k] = v;
    }
    return import('./valkey.js') as Promise<typeof import('./valkey.js')>;
}

// ── Scenario A: HA split, coord client unavailable → fail closed ──────────────

describe('acquireLock / renewLock — HA fail-closed (COORD_IS_SEPARATE=true, coord unavailable)', () => {
    const SAVED_CACHE = process.env.CACHE_URL;
    const SAVED_TASK = process.env.TASK_CACHE_URL;

    let valkey: Awaited<ReturnType<typeof freshValkey>>;

    beforeEach(async () => {
        // CACHE_URL → a local Valkey address (may or may not be up — we won't
        // call connectValkey(), so the client stays null regardless).
        // TASK_CACHE_URL → a *different* address so COORD_IS_SEPARATE becomes true.
        // We deliberately choose an unreachable port so that if connectValkey()
        // were called, the coord client would fail to connect.
        valkey = await freshValkey({
            CACHE_URL: 'redis://localhost:6379',
            TASK_CACHE_URL: 'redis://localhost:6399', // different port → separate
        });
        // We intentionally do NOT call connectValkey() — valkeyClient stays null,
        // and coordClient also stays null. pickClient(lockKey) returns null.
    });

    afterEach(async () => {
        // Restore original env and reset module registry for the next test file.
        if (SAVED_CACHE !== undefined) process.env.CACHE_URL = SAVED_CACHE;
        else delete process.env.CACHE_URL;
        if (SAVED_TASK !== undefined) process.env.TASK_CACHE_URL = SAVED_TASK;
        else delete process.env.TASK_CACHE_URL;
        vi.resetModules();
    });

    it('acquireLock returns null (does not grant in-memory lock) when coord is unavailable', async () => {
        // lock: prefix → coordination key → routes to coordClient which is null.
        // COORD_IS_SEPARATE === true, so the module must refuse the in-memory fallback.
        const token = await valkey.acquireLock('lock:ha-test:scenario-a', 30);
        expect(token).toBeNull();
    });

    it('renewLock returns false (does not renew via in-memory store) when coord is unavailable', async () => {
        const renewed = await valkey.renewLock('lock:ha-test:renew-a', 'any-token', 30);
        expect(renewed).toBe(false);
    });

    it('acquireLock returns null even when called with an explicit lockValue', async () => {
        const token = await valkey.acquireLock('lock:ha-test:explicit-value', 30, 'my-token');
        expect(token).toBeNull();
    });
});

// ── Scenario B: single-node, no Valkey → in-memory fallback is valid ─────────

describe('acquireLock / renewLock — single-node mode (COORD_IS_SEPARATE=false), in-memory fallback', () => {
    const SAVED_CACHE = process.env.CACHE_URL;
    const SAVED_TASK = process.env.TASK_CACHE_URL;

    let valkey: Awaited<ReturnType<typeof freshValkey>>;

    beforeEach(async () => {
        // TASK_CACHE_URL absent → COORD_IS_SEPARATE === false.
        // CACHE_URL also absent so Valkey won't accidentally connect (no URL to parse).
        valkey = await freshValkey({
            CACHE_URL: '',
            TASK_CACHE_URL: '',
        });
        // No connectValkey() call — valkeyClient stays null. The in-memory fallback
        // is the only path, and it IS valid in single-node mode.
    });

    afterEach(async () => {
        if (SAVED_CACHE !== undefined) process.env.CACHE_URL = SAVED_CACHE;
        else delete process.env.CACHE_URL;
        if (SAVED_TASK !== undefined) process.env.TASK_CACHE_URL = SAVED_TASK;
        else delete process.env.TASK_CACHE_URL;
        vi.resetModules();
    });

    it('acquireLock returns a non-null token via in-memory fallback', async () => {
        const token = await valkey.acquireLock('lock:single-node:acquire', 30);
        expect(token).not.toBeNull();
        expect(typeof token).toBe('string');
    });

    it('renewLock returns true for a lock acquired in the same process', async () => {
        const token = await valkey.acquireLock('lock:single-node:renew', 30);
        expect(token).not.toBeNull();
        const renewed = await valkey.renewLock('lock:single-node:renew', token!, 30);
        expect(renewed).toBe(true);
        await valkey.releaseLock('lock:single-node:renew', token!);
    });

    it('renewLock returns false for a wrong token even in single-node mode', async () => {
        const token = await valkey.acquireLock('lock:single-node:wrong-token', 30);
        expect(token).not.toBeNull();
        const renewed = await valkey.renewLock('lock:single-node:wrong-token', 'bad-token', 30);
        expect(renewed).toBe(false);
        await valkey.releaseLock('lock:single-node:wrong-token', token!);
    });

    it('acquireLock returns null when the in-memory lock is already held', async () => {
        const token1 = await valkey.acquireLock('lock:single-node:contention', 30);
        expect(token1).not.toBeNull();
        const token2 = await valkey.acquireLock('lock:single-node:contention', 30);
        expect(token2).toBeNull();
        await valkey.releaseLock('lock:single-node:contention', token1!);
    });
});
