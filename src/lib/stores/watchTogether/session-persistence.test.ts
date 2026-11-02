// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for Watch-Together session persistence — specifically the
 * tab-unique clientId claim (duplicated tabs inherit sessionStorage and would
 * otherwise share a clientId, breaking echo suppression and host detection).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { claimClientId, CLIENT_ID_KEY } from './session-persistence';

vi.mock('$app/environment', () => ({
    browser: true,
}));

function stubSessionStorage(initial: Record<string, string> = {}) {
    const store = new Map<string, string>(Object.entries(initial));
    vi.stubGlobal('sessionStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
    });
    return store;
}

/** Fake Web Locks API where a configurable set of lock names is already held. */
function stubLocks(heldLocks: Set<string>) {
    vi.stubGlobal('navigator', {
        locks: {
            request: (
                name: string,
                _opts: { ifAvailable: boolean },
                cb: (lock: unknown) => unknown,
            ): Promise<unknown> => {
                if (heldLocks.has(name)) {
                    // Lock unavailable → callback runs with null
                    return Promise.resolve(cb(null));
                }
                heldLocks.add(name);
                // Lock granted; the callback's returned promise intentionally
                // never resolves (page-lifetime hold) — do NOT await it.
                cb({ name });
                return new Promise(() => {});
            },
        },
    });
}

describe('claimClientId', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('keeps the stored clientId when its lock is free', async () => {
        const store = stubSessionStorage({ [CLIENT_ID_KEY]: 'client_1_original' });
        stubLocks(new Set());

        const id = await claimClientId();

        expect(id).toBe('client_1_original');
        expect(store.get(CLIENT_ID_KEY)).toBe('client_1_original');
    });

    it('mints a fresh clientId when another tab already holds the lock (duplicated tab)', async () => {
        const store = stubSessionStorage({ [CLIENT_ID_KEY]: 'client_1_original' });
        stubLocks(new Set(['wt-client-client_1_original']));

        const id = await claimClientId();

        expect(id).not.toBe('client_1_original');
        expect(id).toMatch(/^client_/);
        // The fresh id must be persisted so reloads of THIS tab keep it
        expect(store.get(CLIENT_ID_KEY)).toBe(id);
    });

    it('falls back to the stored clientId when Web Locks is unavailable', async () => {
        stubSessionStorage({ [CLIENT_ID_KEY]: 'client_1_original' });
        vi.stubGlobal('navigator', {});

        const id = await claimClientId();

        expect(id).toBe('client_1_original');
    });

    it('generates and claims a new clientId when none is stored', async () => {
        const store = stubSessionStorage();
        stubLocks(new Set());

        const id = await claimClientId();

        expect(id).toMatch(/^client_/);
        expect(store.get(CLIENT_ID_KEY)).toBe(id);
    });
});
