// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ stat: vi.fn(), read: vi.fn() }));
vi.mock('$lib/server/config.js', () => ({
    config: { TRICKPLAY_STORAGE_PATH: '/tmp/trickplay', TRICKPLAY_STORAGE_LOCATION: 'central' },
}));
vi.mock('./metadata-storage.service.js', () => ({
    resolveReadPath: async ({ centralDir, fileName }: { centralDir: string; fileName: string }) =>
        `${centralDir}/${fileName}`,
    resolveWritePath: vi.fn(),
}));
vi.mock('$lib/server/utils/safe-fs.js', () => ({ safeStat: h.stat }));
vi.mock('$lib/server/utils/contained-fs.js', () => ({
    readContainedFile: h.read,
    ContainmentError: class extends Error {},
}));
import { getTrickplayRevision } from './trickplay-storage.service.js';
const file = '00000000-0000-4000-a000-000000000001';
beforeEach(() => {
    h.stat.mockReset().mockResolvedValue({ mtimeMs: 100, ctimeMs: 100, size: 20 });
    h.read.mockReset().mockResolvedValue(Buffer.from('manifest'));
});
describe('manifest revision LRU', () => {
    it('avoids re-reading unchanged contents and invalidates on mtime, size, width or file', async () => {
        const first = await getTrickplayRevision(file, 320);
        expect(first).toMatch(/^[a-f0-9]{64}$/);
        expect(await getTrickplayRevision(file, 320)).toBe(first);
        expect(h.read).toHaveBeenCalledTimes(1);
        h.stat.mockResolvedValue({ mtimeMs: 101, ctimeMs: 100, size: 20 });
        expect(await getTrickplayRevision(file, 320)).not.toBe(first);
        h.stat.mockResolvedValue({ mtimeMs: 101, ctimeMs: 100, size: 21 });
        await getTrickplayRevision(file, 320);
        await getTrickplayRevision(file, 640);
        await getTrickplayRevision('00000000-0000-4000-a000-000000000002', 320);
        expect(h.read).toHaveBeenCalledTimes(5);
    });
    it('keeps the cache bounded and evicts the least recently used entry', async () => {
        await getTrickplayRevision(file, 1000);
        for (let width = 1001; width <= 1064; width++) await getTrickplayRevision(file, width);
        const count = h.read.mock.calls.length;
        await getTrickplayRevision(file, 1064);
        expect(h.read).toHaveBeenCalledTimes(count);
        await getTrickplayRevision(file, 1000);
        expect(h.read).toHaveBeenCalledTimes(count + 1);
    });
    it('does not serve a cached revision when the manifest disappears', async () => {
        await getTrickplayRevision(file, 500);
        h.stat.mockRejectedValue(new Error('ENOENT'));
        expect(await getTrickplayRevision(file, 500)).toBeNull();
    });
});
