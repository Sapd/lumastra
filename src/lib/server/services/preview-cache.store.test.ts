// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PreviewCacheStore } from './preview-cache.store';

let root: string;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pcache-'));
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

function newStore(maxBytes = 1000): PreviewCacheStore {
    return new PreviewCacheStore({ rootDir: root, maxBytes });
}
// startWarm only STARTS the job (writes a placeholder segment, resolves void).
// Size + ready are applied separately via markReady, mirroring the FFmpeg onExit.
const startWarm = (dir: string): Promise<void> => {
    writeFileSync(join(dir, 'seg.m4s'), Buffer.alloc(0));
    return Promise.resolve();
};

describe('PreviewCacheStore.acquire', () => {
    it('miss → starts warm once; second acquire is a hit (no second start)', async () => {
        const store = newStore();
        let starts = 0;
        const warm = (dir: string): Promise<void> => {
            starts++;
            writeFileSync(join(dir, 's'), Buffer.alloc(0));
            return Promise.resolve();
        };
        const a = await store.acquire('k1', warm);
        const b = await store.acquire('k1', warm);
        expect(starts).toBe(1);
        expect(a.dir).toBe(b.dir);
        expect(a.state).toBe('warming'); // ready only after markReady
        expect(store.stats().hits).toBe(1);
        expect(store.stats().misses).toBe(1);
    });

    it('concurrent misses for one key start exactly once (single-flight)', async () => {
        const store = newStore();
        let starts = 0;
        const warm = async (dir: string): Promise<void> => {
            starts++;
            await new Promise((r) => setTimeout(r, 20));
            writeFileSync(join(dir, 's'), Buffer.alloc(0));
        };
        await Promise.all([
            store.acquire('kk', warm),
            store.acquire('kk', warm),
            store.acquire('kk', warm),
        ]);
        expect(starts).toBe(1);
    });

    it('markReady flips warming → ready and sets size', async () => {
        const store = newStore();
        await store.acquire('kk', startWarm);
        store.markReady('kk', 42);
        expect(store.lookup('kk')?.state).toBe('ready');
        expect(store.lookup('kk')?.sizeBytes).toBe(42);
    });

    it('a failed start removes the entry and rethrows (no poisoned dir)', async () => {
        const store = newStore();
        await expect(
            store.acquire('bad', async () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');
        expect(store.lookup('bad')).toBeUndefined();
    });

    it('markFailed removes a warming entry (job errored)', async () => {
        const store = newStore();
        await store.acquire('kk', startWarm);
        store.markFailed('kk');
        expect(store.lookup('kk')).toBeUndefined();
    });

    it('a re-acquire of a just-failed key survives the stale delete (no clobber)', async () => {
        const store = newStore();
        await store.acquire('kk', startWarm);
        store.markFailed('kk'); // schedules async delete of dir
        await store.acquire('kk', async (dir) => {
            writeFileSync(join(dir, 'fresh'), Buffer.alloc(5));
        });
        await new Promise((r) => setTimeout(r, 40)); // let any pending delete settle
        expect(existsSync(join(store.dirFor('kk'), 'fresh'))).toBe(true);
        expect(store.lookup('kk')).toBeDefined();
    });
});

describe('PreviewCacheStore eviction', () => {
    // Production flow is acquire → attach → (much later) markReady, since markReady fires from the
    // FFmpeg onExit hook long after the session attached. In-use entries therefore attach BEFORE
    // their markReady so they are already refcounted when the synchronous evictToBudget() inside a
    // *later* markReady evaluates the idle set.
    it('evicts the LRU idle entry when over budget; never an in-use one', async () => {
        const store = newStore(25); // fits 2×10-byte entries, not 3
        await store.acquire('aa', startWarm);
        store.markReady('aa', 10); // idle (refcount 0), ready
        await store.acquire('bb', startWarm);
        store.attach('bb'); // in-use BEFORE markReady
        store.markReady('bb', 10);
        await store.acquire('cc', startWarm);
        store.markReady('cc', 10); // markReady(cc) → evictToBudget: idle = {aa, cc}, LRU = aa → evict aa
        expect(store.lookup('aa')).toBeUndefined(); // oldest idle → evicted
        expect(store.lookup('bb')).toBeDefined(); // in-use, never evicted
        expect(store.stats().evictions).toBe(1);
    });

    it('does not evict when everything over budget is in-use (degrade, not corrupt)', async () => {
        const store = newStore(15);
        await store.acquire('aa', startWarm);
        store.attach('aa'); // in-use before markReady
        store.markReady('aa', 10);
        await store.acquire('bb', startWarm);
        store.attach('bb'); // in-use before markReady
        store.markReady('bb', 10); // markReady(bb) → evictToBudget: no idle candidates → nothing evicted
        expect(store.lookup('aa')).toBeDefined();
        expect(store.lookup('bb')).toBeDefined();
    });
});

describe('PreviewCacheStore.acquire estimatedBytes', () => {
    it('counts the estimate in totalBytes while warming; markReady replaces it; markFailed drops it', async () => {
        const store = newStore();
        await store.acquire('kk', startWarm, 1000);
        expect(store.stats().totalBytes).toBe(1000);

        store.markReady('kk', 50);
        expect(store.stats().totalBytes).toBe(50);

        await store.acquire('mm', startWarm, 1000);
        expect(store.stats().totalBytes).toBe(1050);
        store.markFailed('mm');
        expect(store.stats().totalBytes).toBe(50);
    });
});

describe('PreviewCacheStore.setOnDrop', () => {
    it('fires with the key when evictToBudget drops an idle entry', async () => {
        const store = newStore(15); // fits 1×10-byte entry, not 2
        const dropped: string[] = [];
        store.setOnDrop((key) => dropped.push(key));

        await store.acquire('aa', startWarm);
        store.markReady('aa', 10); // idle, ready
        await store.acquire('bb', startWarm);
        store.markReady('bb', 10); // over budget → evicts 'aa'

        expect(dropped).toEqual(['aa']);
    });

    it('fires with the key when markFailed drops a warming entry', async () => {
        const store = newStore();
        const dropped: string[] = [];
        store.setOnDrop((key) => dropped.push(key));

        await store.acquire('kk', startWarm);
        store.markFailed('kk');

        expect(dropped).toEqual(['kk']);
    });

    it('does not fire on markReady/attach (no drop)', async () => {
        const store = newStore();
        const dropped: string[] = [];
        store.setOnDrop((key) => dropped.push(key));

        await store.acquire('kk', startWarm);
        store.attach('kk');
        store.markReady('kk', 10);

        expect(dropped).toEqual([]);
    });
});

describe('PreviewCacheStore.dirFor', () => {
    it('throws on a key shorter than the shard prefix instead of collapsing to the cache root', () => {
        const store = newStore();
        expect(() => store.dirFor('')).toThrow('preview cache key too short');
        expect(() => store.dirFor('a')).toThrow('preview cache key too short');
    });
});

describe('PreviewCacheStore.scanOnStartup', () => {
    it('indexes ready dirs (with .ready) and deletes partial ones', async () => {
        const store = newStore();
        const readyDir = store.dirFor('aaaa');
        const partialDir = store.dirFor('bbbb');
        const { mkdirSync } = await import('node:fs');
        mkdirSync(readyDir, { recursive: true });
        writeFileSync(join(readyDir, 'seg'), Buffer.alloc(10));
        writeFileSync(join(readyDir, '.ready'), '');
        mkdirSync(partialDir, { recursive: true });
        writeFileSync(join(partialDir, 'seg'), Buffer.alloc(10));
        await store.scanOnStartup();
        expect(store.lookup('aaaa')?.state).toBe('ready');
        expect(existsSync(partialDir)).toBe(false); // partial removed
    });
});
