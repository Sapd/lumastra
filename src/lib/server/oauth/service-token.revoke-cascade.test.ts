// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `ServiceTokenService.revoke()` revokes the tokens minted THROUGH the revoked
 * token (`created_via_token_id`), transitively, and broadcasts each of them
 * (admin/users review 2026-10-07, item 1). Before this, revoking a leaked
 * minting token left every child it had minted working until expiry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSql = vi.fn();
vi.mock('../database/connection.js', () => ({
    Database: class {
        getSql() {
            return mockSql;
        }
    },
}));
vi.mock('../utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));
vi.mock('$lib/server/cache/auth-cache-bus.js', () => ({
    publishAuthCacheInvalidation: vi.fn(),
    onRemoteTokenNarrowedInvalidate: () => {},
    onAuthCacheBusResync: () => {},
}));
const mockCacheSet = vi.fn();
vi.mock('$lib/server/cache/valkey.js', () => ({
    cacheSet: (...a: unknown[]) => mockCacheSet(...a),
    cacheGet: vi.fn().mockResolvedValue(null),
    isCoordinationValkeyReady: () => true,
    connectValkey: vi.fn(),
}));

import { ServiceTokenService } from './service-token.service.js';

// SQL behaviour (the recursive walk, cycles, already-revoked rows, the mint
// lock) is pinned against a real database in
// service-token.service.integration.test.ts. This file pins what happens
// around it: markers for every revoked hash, and local LRU eviction.

function fakeSql(opts: {
    rootHashes: string[];
    descendants: { id: number; token_hash: string }[];
}): void {
    const tag = vi.fn(async (strings: TemplateStringsArray) => {
        const text = strings.join('?');
        if (text.includes('WITH RECURSIVE minted')) return opts.descendants;
        if (text.includes('UPDATE service_tokens')) {
            return opts.rootHashes.map((token_hash) => ({ token_hash }));
        }
        return [];
    });
    mockSql.mockImplementation(tag);
    Object.assign(mockSql, { begin: async (fn: (tx: unknown) => unknown) => fn(tag) });
}

describe('ServiceTokenService.revoke — cascade to tokens minted through it', () => {
    beforeEach(() => {
        mockSql.mockReset();
        mockCacheSet.mockReset();
    });

    it('broadcasts and locally evicts the root and every descendant', async () => {
        fakeSql({
            rootHashes: ['root-hash'],
            descendants: [
                { id: 8, token_hash: 'child-hash' },
                { id: 9, token_hash: 'grandchild-hash' },
            ],
        });
        const svc = new ServiceTokenService();
        const cache = (svc as unknown as { tokenCache: Map<string, unknown> })
            .tokenCache as unknown as {
            set: (k: string, v: unknown) => void;
            get: (k: string) => unknown;
        };
        for (const h of ['root-hash', 'child-hash', 'grandchild-hash']) cache.set(h, { id: 1 });

        expect(await svc.revoke(7)).toBe(true);

        const markers = mockCacheSet.mock.calls.map((c) => c[0] as string).sort();
        expect(markers).toEqual([
            'svc-token-revoked:child-hash',
            'svc-token-revoked:grandchild-hash',
            'svc-token-revoked:root-hash',
        ]);
        for (const h of ['root-hash', 'child-hash', 'grandchild-hash']) {
            expect(cache.get(h)).toBeNull();
        }
    });

    it('still revokes live children when the root was already revoked (repair after a failed cascade)', async () => {
        fakeSql({ rootHashes: [], descendants: [{ id: 8, token_hash: 'child-hash' }] });
        const svc = new ServiceTokenService();

        expect(await svc.revoke(7)).toBe(false);
        expect(mockCacheSet.mock.calls.map((c) => c[0])).toEqual(['svc-token-revoked:child-hash']);
    });
});
