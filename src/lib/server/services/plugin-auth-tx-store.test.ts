// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The redirect-flow transaction store.
 *
 * State lives server-side and is consumed exactly once. The properties tested
 * here are the ones that stop a redirect login being replayed or steered:
 * single use, provider binding, and refusing to interpret anything malformed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let ready = true;
const store = new Map<string, string>();
vi.mock('$lib/server/cache/valkey.js', () => ({
    isCoordinationValkeyReady: () => ready,
    cacheSet: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
        return true;
    }),
    // GETDEL semantics — the atomicity that makes the transaction single-use.
    getDel: vi.fn(async (key: string) => {
        const v = store.get(key) ?? null;
        store.delete(key);
        return v;
    }),
}));

import { storePluginAuthTx, consumePluginAuthTx } from './plugin-auth-tx-store.js';

const tx = { pluginId: 'discord-login', returnTo: '/music', txData: 'opaque' };

beforeEach(() => {
    ready = true;
    store.clear();
});

describe('single use', () => {
    it('round-trips a transaction', async () => {
        await storePluginAuthTx('state-1', tx);
        expect(await consumePluginAuthTx('state-1', 'discord-login')).toEqual(tx);
    });

    it('a REPLAYED callback finds nothing', async () => {
        await storePluginAuthTx('state-1', tx);
        await consumePluginAuthTx('state-1', 'discord-login');
        expect(await consumePluginAuthTx('state-1', 'discord-login')).toBeNull();
    });

    it('an unknown state is null, not a guess', async () => {
        expect(await consumePluginAuthTx('never-issued', 'discord-login')).toBeNull();
    });

    it('an empty state never reaches the store', async () => {
        expect(await consumePluginAuthTx('', 'discord-login')).toBeNull();
    });
});

describe('provider binding', () => {
    it('refuses a transaction minted for a DIFFERENT provider', async () => {
        await storePluginAuthTx('state-1', tx);
        // The state cookie is scoped to the whole /api/auth/plugin prefix, so
        // without this check a state issued by one provider could be presented
        // at another provider's callback.
        expect(await consumePluginAuthTx('state-1', 'other-login')).toBeNull();
    });

    it('still CONSUMES a mismatched transaction rather than leaving it replayable', async () => {
        await storePluginAuthTx('state-1', tx);
        await consumePluginAuthTx('state-1', 'other-login');
        expect(await consumePluginAuthTx('state-1', 'discord-login')).toBeNull();
    });
});

describe('degradation', () => {
    it('reports failure rather than starting a flow that cannot be completed', async () => {
        ready = false;
        expect(await storePluginAuthTx('state-1', tx)).toBe(false);
    });

    it('consumes nothing when the cache is down', async () => {
        ready = false;
        expect(await consumePluginAuthTx('state-1', 'discord-login')).toBeNull();
    });

    it('discards a malformed record instead of half-trusting it', async () => {
        store.set('plugin-auth:tx:v1:state-1', '{"pluginId":123}');
        expect(await consumePluginAuthTx('state-1', 'discord-login')).toBeNull();
    });

    it('discards unparseable JSON', async () => {
        store.set('plugin-auth:tx:v1:state-1', 'not json');
        expect(await consumePluginAuthTx('state-1', 'discord-login')).toBeNull();
    });
});
