// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, afterAll, vi } from 'vitest';

// Exercise the disconnected memory-lock primitive independently of runner topology.
vi.hoisted(() => vi.stubEnv('TASK_CACHE_URL', ''));
afterAll(() => vi.unstubAllEnvs());
import { acquireLock, renewLock, releaseLock } from './valkey.js';

describe('renewLock', () => {
    const key = 'test:renew-lock:' + Date.now();

    it('renews TTL when we hold the lock', async () => {
        const value = await acquireLock(key, 30);
        expect(value).not.toBeNull();
        const renewed = await renewLock(key, value!, 30);
        expect(renewed).toBe(true);
        await releaseLock(key, value!);
    });

    it('returns false when lock is not held by us', async () => {
        // Lock held by "someone else"
        const otherValue = await acquireLock(key + ':other', 30);
        // Try to renew a different value against the same key
        const renewed = await renewLock(key + ':other', 'wrong-value', 30);
        expect(renewed).toBe(false);
        await releaseLock(key + ':other', otherValue!);
    });

    it('returns false when lock does not exist', async () => {
        const renewed = await renewLock('nonexistent:key', 'any-value', 30);
        expect(renewed).toBe(false);
    });
});
