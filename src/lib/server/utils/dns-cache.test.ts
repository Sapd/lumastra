// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { promisify } from 'node:util';
import { cachedLookup, dnsCacheStats } from './dns-cache.js';

// Tests run against real resolution of `localhost` (always present, instant).
// They exercise cachedLookup directly without installing the global override.

describe('dns-cache cachedLookup', () => {
    it('resolves localhost with the (err, address, family) contract', async () => {
        const { address, family } = await new Promise<{ address: string; family: number }>(
            (resolve, reject) => {
                cachedLookup('localhost', {}, (err: Error | null, addr: string, fam: number) => {
                    if (err) reject(err);
                    else resolve({ address: addr, family: fam });
                });
            },
        );
        expect(typeof address).toBe('string');
        expect(address.length).toBeGreaterThan(0);
        expect([4, 6]).toContain(family);
    });

    it('never calls back synchronously (preserves async contract)', async () => {
        let calledSync = true;
        await new Promise<void>((resolve) => {
            cachedLookup('localhost', {}, () => {
                expect(calledSync).toBe(false); // must be on a later tick
                resolve();
            });
            calledSync = false; // runs before the callback iff async
        });
    });

    it('caches a resolved host (second lookup is a hit, address stable)', async () => {
        const lookup = (h: string) =>
            new Promise<string>((resolve, reject) =>
                cachedLookup(h, { family: 4 }, (e: Error | null, a: string) =>
                    e ? reject(e) : resolve(a),
                ),
            );
        const a1 = await lookup('localhost');
        const entriesAfterFirst = dnsCacheStats().entries;
        const a2 = await lookup('localhost');
        expect(a2).toBe(a1);
        // No new entry created on the second (cached) lookup.
        expect(dnsCacheStats().entries).toBe(entriesAfterFirst);
    });

    it('delegates {all:true} to the native lookup (returns an array)', async () => {
        const addrs = await new Promise<unknown>((resolve, reject) =>
            cachedLookup('localhost', { all: true }, (e: Error | null, a: unknown) =>
                e ? reject(e) : resolve(a),
            ),
        );
        expect(Array.isArray(addrs)).toBe(true);
        expect((addrs as unknown[]).length).toBeGreaterThan(0);
    });

    it('supports util.promisify (single-result form)', async () => {
        const p = promisify(cachedLookup) as (
            h: string,
        ) => Promise<{ address: string; family: number }>;
        const res = await p('localhost');
        expect(typeof res.address).toBe('string');
        expect([4, 6]).toContain(res.family);
    });

    it('propagates resolution errors (does not cache failures)', async () => {
        const before = dnsCacheStats().entries;
        await expect(
            new Promise((resolve, reject) =>
                cachedLookup(
                    'definitely.invalid.nonexistent.localhost.test',
                    { family: 4 },
                    (e: Error | null, a: string) => (e ? reject(e) : resolve(a)),
                ),
            ),
        ).rejects.toBeTruthy();
        // A failed lookup must not add a cache entry.
        expect(dnsCacheStats().entries).toBe(before);
    });
});
