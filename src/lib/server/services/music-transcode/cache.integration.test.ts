// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createMusicTranscodeCache } from './cache.js';
import { cachePathFor, partialPathFor } from './cache-key.js';

let dir: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'music-cache-test-'));
});
afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('MusicTranscodeCache', () => {
    it('returns null when key is not cached', async () => {
        const cache = createMusicTranscodeCache({ cacheDir: dir });
        expect(await cache.getCachedFinalPath('keyA', 'mp3')).toBeNull();
    });

    it('reports the final path after promote', async () => {
        const cache = createMusicTranscodeCache({ cacheDir: dir });
        const final = cachePathFor(dir, 'keyA', 'mp3');
        const partial = partialPathFor(final);
        // Simulate: writer creates dir, writes partial, then promotes.
        const writer = await cache.beginWrite('keyA', 'mp3');
        writeFileSync(writer.partialPath, Buffer.from('hello'));
        await writer.promote();
        expect(await cache.getCachedFinalPath('keyA', 'mp3')).toBe(final);
        expect(existsSync(partial)).toBe(false);
    });

    it('cleans up partial on abort', async () => {
        const cache = createMusicTranscodeCache({ cacheDir: dir });
        const writer = await cache.beginWrite('keyA', 'mp3');
        writeFileSync(writer.partialPath, Buffer.from('partial'));
        await writer.abort();
        expect(existsSync(writer.partialPath)).toBe(false);
    });

    it('dedupes concurrent writers — second returns the in-flight promise', async () => {
        const cache = createMusicTranscodeCache({ cacheDir: dir });
        const a = cache.beginWrite('keyA', 'mp3');
        const b = cache.beginWrite('keyA', 'mp3');
        const writerA = await a;
        const writerB = await b;
        expect(writerB.isPrimary).toBe(false);
        // The follower waits on the primary; finish the primary
        writeFileSync(writerA.partialPath, Buffer.from('x'));
        await writerA.promote();
        await writerB.waitForPrimary();
        expect(existsSync(cachePathFor(dir, 'keyA', 'mp3'))).toBe(true);
    });

    it('reapToCap evicts oldest by atime when over capacity', async () => {
        const cache = createMusicTranscodeCache({ cacheDir: dir });
        // Write two files manually
        const path1 = cachePathFor(dir, 'aaaa', 'mp3');
        const path2 = cachePathFor(dir, 'bbbb', 'mp3');
        const dir1 = path1.replace(/\/[^/]+$/, '');
        const dir2 = path2.replace(/\/[^/]+$/, '');
        const fs = await import('node:fs/promises');
        await fs.mkdir(dir1, { recursive: true });
        await fs.mkdir(dir2, { recursive: true });
        writeFileSync(path1, Buffer.alloc(2 * 1024 * 1024)); // 2 MB
        await sleep(20);
        writeFileSync(path2, Buffer.alloc(2 * 1024 * 1024));
        // Force atime separation
        await fs.utimes(
            path1,
            new Date(Date.now() / 1000 - 100),
            new Date(Date.now() / 1000 - 100),
        );
        await fs.utimes(path2, new Date(), new Date());
        // Reap to 3 MB cap — must evict the older
        await cache.reapToCap(3 * 1024 * 1024);
        expect(existsSync(path1)).toBe(false);
        expect(existsSync(path2)).toBe(true);
    });

    it('reapToCap sweeps stale .partial files', async () => {
        const cache = createMusicTranscodeCache({ cacheDir: dir });
        const fs = await import('node:fs/promises');
        const staleDir = join(dir, 'aa');
        await fs.mkdir(staleDir, { recursive: true });
        const stalePath = join(staleDir, 'aaaa.mp3.partial');
        writeFileSync(stalePath, Buffer.from('stale'));
        // Backdate mtime to 2 hours ago
        const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
        await fs.utimes(stalePath, old, old);
        // Budget is high so LRU eviction won't run — sweep must still remove it
        await cache.reapToCap(100 * 1024 * 1024);
        expect(existsSync(stalePath)).toBe(false);
    });

    it('follower observes rejection when primary aborts', async () => {
        const cache = createMusicTranscodeCache({ cacheDir: dir });
        const writerA = await cache.beginWrite('keyZ', 'mp3');
        const writerB = await cache.beginWrite('keyZ', 'mp3');
        expect(writerB.isPrimary).toBe(false);
        await writerA.abort();
        await expect(writerB.waitForPrimary()).rejects.toThrow();
    });

    it('peekInFlight is false when no primary writer exists', async () => {
        const cache = createMusicTranscodeCache({ cacheDir: dir });
        expect(cache.peekInFlight('keyP', 'mp3')).toBe(false);
    });

    it('peekInFlight is true while a primary is writing, false after promote', async () => {
        const cache = createMusicTranscodeCache({ cacheDir: dir });
        const writer = await cache.beginWrite('keyP', 'mp3');
        expect(cache.peekInFlight('keyP', 'mp3')).toBe(true);
        // Same key, different codec → still no in-flight under that codec.
        expect(cache.peekInFlight('keyP', 'opus')).toBe(false);
        writeFileSync(writer.partialPath, Buffer.from('x'));
        await writer.promote();
        expect(cache.peekInFlight('keyP', 'mp3')).toBe(false);
    });

    it('peekInFlight clears after primary aborts', async () => {
        const cache = createMusicTranscodeCache({ cacheDir: dir });
        const writer = await cache.beginWrite('keyP', 'mp3');
        expect(cache.peekInFlight('keyP', 'mp3')).toBe(true);
        await writer.abort();
        expect(cache.peekInFlight('keyP', 'mp3')).toBe(false);
    });

    it('waitForKey resolves when the primary promotes', async () => {
        const cache = createMusicTranscodeCache({ cacheDir: dir });
        const writer = await cache.beginWrite('keyW', 'mp3');
        const waiter = cache.waitForKey('keyW', 'mp3');
        writeFileSync(writer.partialPath, Buffer.from('x'));
        await writer.promote();
        await expect(waiter).resolves.toBeUndefined();
    });

    it('waitForKey rejects when the primary aborts', async () => {
        const cache = createMusicTranscodeCache({ cacheDir: dir });
        const writer = await cache.beginWrite('keyW', 'mp3');
        const waiter = cache.waitForKey('keyW', 'mp3');
        await writer.abort();
        await expect(waiter).rejects.toThrow();
    });

    it('waitForKey returns immediately when no primary is in flight', async () => {
        const cache = createMusicTranscodeCache({ cacheDir: dir });
        // No beginWrite has been called — should resolve right away.
        await expect(cache.waitForKey('keyMissing', 'mp3')).resolves.toBeUndefined();
    });
});

describe('partial reaper safety', () => {
    it('keeps an unowned partial younger than one hour despite the streaming timeout', async () => {
        const cache = createMusicTranscodeCache({ cacheDir: dir });
        const fs = await import('node:fs/promises');
        const path = join(dir, 'unowned.mp3.partial');
        writeFileSync(path, 'partial');
        const old = new Date(Date.now() - 30 * 60 * 1000);
        await fs.utimes(path, old, old);
        await cache.reapToCap(0);
        expect(existsSync(path)).toBe(true);
    });

    it('keeps an in-flight partial even when its mtime is over one hour old', async () => {
        const cache = createMusicTranscodeCache({ cacheDir: dir });
        const writer = await cache.beginWrite('live', 'mp3');
        const fs = await import('node:fs/promises');
        writeFileSync(writer.partialPath, 'partial');
        const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
        await fs.utimes(writer.partialPath, old, old);
        await cache.reapToCap(0);
        expect(existsSync(writer.partialPath)).toBe(true);
        await writer.promote();
        expect(existsSync(writer.finalPath)).toBe(true);
    });
});
