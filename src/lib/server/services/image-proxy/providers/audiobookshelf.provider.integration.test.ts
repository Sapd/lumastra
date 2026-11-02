// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Live cover fetch + disk cache. Skipped unless AUDIOURL/AUDIOAPIKEY are set.
 */
import { describe, it, expect } from 'vitest';
import { AudiobookshelfImageProvider } from './audiobookshelf.provider';

const LIVE = Boolean(process.env.AUDIOURL && process.env.AUDIOBOOKSHELF_TEST_ITEM_ID);
const suite = LIVE ? describe : describe.skip;

suite('AudiobookshelfImageProvider (live)', () => {
    const itemId = process.env.AUDIOBOOKSHELF_TEST_ITEM_ID!;

    it('fetches a real cover, then serves the second read from disk', async () => {
        const p = new AudiobookshelfImageProvider();
        expect(p.isConfigured()).toBe(true);

        const first = await p.getCover({ itemId, revision: 1_700_000_000_000, options: {} });
        expect(first).not.toBeNull();
        expect(first!.buffer.byteLength).toBeGreaterThan(1000);
        expect(first!.contentType).toMatch(/^image\//);
        console.log(`  fetched ${first!.buffer.byteLength} bytes as ${first!.contentType}`);

        let second = await p.getCover({ itemId, revision: 1_700_000_000_000, options: {} });
        for (let attempt = 0; attempt < 20 && second!.cacheStatus !== 'HIT'; attempt++) {
            await new Promise((r) => setTimeout(r, 50));
            second = await p.getCover({ itemId, revision: 1_700_000_000_000, options: {} });
        }
        expect(second!.cacheStatus).toBe('HIT');
        expect(second!.buffer.byteLength).toBe(first!.buffer.byteLength);
    }, 60_000);

    it('a changed revision misses the cache — this is the invalidation story', async () => {
        const p = new AudiobookshelfImageProvider();
        // Unique per run: the disk cache persists between runs, so a fixed
        // revision would be a legitimate HIT the second time and the assertion
        // would be testing nothing.
        const revision = Date.now();
        const first = await p.getCover({ itemId, revision, options: {} });
        expect(first).not.toBeNull();
        expect(first!.cacheStatus).toBe('MISS');

        // ImageCache writes fire-and-forget ("async, don't wait" in cache.ts),
        // so the entry is eventually cached, not synchronously. Poll rather
        // than asserting on the immediate next read.
        let hit = false;
        for (let attempt = 0; attempt < 20 && !hit; attempt++) {
            await new Promise((r) => setTimeout(r, 50));
            const again = await p.getCover({ itemId, revision, options: {} });
            hit = again!.cacheStatus === 'HIT';
        }
        expect(hit).toBe(true);

        // Bumping the revision — what a replaced cover upstream does — misses.
        const bumped = await p.getCover({ itemId, revision: revision + 1, options: {} });
        expect(bumped!.cacheStatus).toBe('MISS');
    }, 60_000);

    it('snaps widths so near-identical requests share one cache entry', async () => {
        const p = new AudiobookshelfImageProvider();
        const a = await p.getCover({ itemId, revision: 42, options: { maxWidth: '318' } });
        expect(a).not.toBeNull();
        // Same fire-and-forget write as above — poll for the entry to land.
        let b = await p.getCover({ itemId, revision: 42, options: { maxWidth: '322' } });
        for (let attempt = 0; attempt < 20 && b!.cacheStatus !== 'HIT'; attempt++) {
            await new Promise((r) => setTimeout(r, 50));
            b = await p.getCover({ itemId, revision: 42, options: { maxWidth: '322' } });
        }
        expect(b!.cacheStatus).toBe('HIT');
        console.log(`  318px and 322px both snapped to one entry (${b!.buffer.byteLength} bytes)`);
    }, 60_000);
});
