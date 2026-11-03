// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileSystemCacheStorage, ImageCache } from './cache';

const TTL = 60_000;

describe('ImageCache staleIfError', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-cache-stale-'));
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    });

    async function seedExpired(key: string, body: string): Promise<void> {
        const file = path.join(dir, key);
        await fs.writeFile(file, body);
        const old = new Date(Date.now() - 2 * TTL);
        await fs.utimes(file, old, old);
    }

    const failing = () => Promise.reject(new Error('HTTP 403'));

    it('serves the expired entry when the refetch fails', async () => {
        const cache = new ImageCache({ directory: dir, ttl: TTL, staleIfError: true });
        await seedExpired('k', 'old-poster');

        const result = await cache.getCachedOrFetch('k', failing);

        expect(result).toEqual({ buffer: Buffer.from('old-poster'), wasHit: true, stale: true });
        // Still on disk for the next failure, and still expired so the next request retries.
        await expect(fs.readFile(path.join(dir, 'k'), 'utf8')).resolves.toBe('old-poster');
    });

    it('replaces the expired entry when the refetch succeeds', async () => {
        const cache = new ImageCache({ directory: dir, ttl: TTL, staleIfError: true });
        await seedExpired('k', 'old-poster');

        const result = await cache.getCachedOrFetch('k', async () => Buffer.from('new-poster'));

        expect(result).toEqual({ buffer: Buffer.from('new-poster'), wasHit: false });
        await expect.poll(() => fs.readFile(path.join(dir, 'k'), 'utf8')).toBe('new-poster');
    });

    it('a predicate can refuse the stale copy for some errors', async () => {
        const cache = new ImageCache({
            directory: dir,
            ttl: TTL,
            staleIfError: (err) => !(err instanceof Error && err.message === 'gone'),
        });
        await seedExpired('k', 'old-poster');

        await expect(
            cache.getCachedOrFetch('k', () => Promise.reject(new Error('gone'))),
        ).rejects.toThrow('gone');
        await expect(cache.getCachedOrFetch('k', failing)).resolves.toMatchObject({
            stale: true,
        });
    });

    it('rethrows when there is nothing stale to serve', async () => {
        const cache = new ImageCache({ directory: dir, ttl: TTL, staleIfError: true });
        await expect(cache.getCachedOrFetch('missing', failing)).rejects.toThrow('HTTP 403');
    });

    it('without the option still deletes the expired entry and rethrows', async () => {
        const cache = new ImageCache({ directory: dir, ttl: TTL });
        await seedExpired('k', 'old-poster');

        await expect(cache.getCachedOrFetch('k', failing)).rejects.toThrow('HTTP 403');
        await expect(fs.access(path.join(dir, 'k'))).rejects.toThrow();
    });

    it('treats a zero-byte fresh entry as a miss', async () => {
        const cache = new ImageCache({ directory: dir, ttl: TTL, staleIfError: true });
        await fs.writeFile(path.join(dir, 'k'), '');

        const result = await cache.getCachedOrFetch('k', async () => Buffer.from('poster'));

        expect(result).toEqual({ buffer: Buffer.from('poster'), wasHit: false });
    });
});

describe('FileSystemCacheStorage writes', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-cache-write-'));
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    });

    it('leaves only the final file behind', async () => {
        const storage = new FileSystemCacheStorage(dir);
        await storage.write('k', Buffer.from('a'));
        await storage.write('k', Buffer.from('b'));

        expect(await fs.readdir(dir)).toEqual(['k']);
        expect(await fs.readFile(path.join(dir, 'k'), 'utf8')).toBe('b');
    });

    it('removes its temp file when the write fails', async () => {
        const storage = new FileSystemCacheStorage(dir);
        // A non-empty directory in the way makes the rename fail.
        await fs.mkdir(path.join(dir, 'k'));
        await fs.writeFile(path.join(dir, 'k', 'x'), 'x');

        await expect(storage.write('k', Buffer.from('a'))).rejects.toThrow();
        expect(await fs.readdir(dir)).toEqual(['k']);
    });

    it('deleteByPrefix leaves in-flight temp files alone', async () => {
        const storage = new FileSystemCacheStorage(dir);
        await fs.writeFile(path.join(dir, 'user-1-a'), 'a');
        await fs.writeFile(path.join(dir, 'user-1-b.1.abc.tmp'), 'b');

        expect(await storage.deleteByPrefix('user-1-')).toBe(1);
        expect(await fs.readdir(dir)).toEqual(['user-1-b.1.abc.tmp']);
    });
});
