// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import sharp from 'sharp';

const getImageByCatalogId = vi.fn();
vi.mock('$lib/server/services/image-proxy/index.js', () => ({
    getImageProxyService: () => ({ getImageByCatalogId }),
}));

// In-memory disk cache so tests never write under process.cwd().
const files = new Map<string, { buf: Buffer; mtimeMs: number }>();
vi.mock('node:fs/promises', () => ({
    stat: vi.fn(async (p: string) => {
        const f = files.get(p);
        if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { mtimeMs: f.mtimeMs };
    }),
    readFile: vi.fn(async (p: string) => {
        const f = files.get(p);
        if (!f) throw new Error('ENOENT');
        return f.buf;
    }),
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async (p: string, buf: Buffer) => {
        files.set(p, { buf, mtimeMs: Date.now() });
    }),
    rename: vi.fn(async (from: string, to: string) => {
        const f = files.get(from);
        if (f) files.set(to, f);
        files.delete(from);
    }),
    unlink: vi.fn(async (p: string) => {
        files.delete(p);
    }),
}));

const { composeCollage, getCoverCollage } = await import('./cover-collage.service.js');

async function solid(r: number, g: number, b: number): Promise<Buffer> {
    return sharp({ create: { width: 64, height: 96, channels: 3, background: { r, g, b } } })
        .png()
        .toBuffer();
}

async function pixel(buf: Buffer, x: number, y: number): Promise<[number, number, number]> {
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
}

function near(actual: [number, number, number], expected: [number, number, number]): boolean {
    return actual.every((v, i) => Math.abs(v - expected[i]) < 16);
}

const RED: [number, number, number] = [220, 20, 20];
const GREEN: [number, number, number] = [20, 200, 20];
const BLUE: [number, number, number] = [20, 20, 220];
const YELLOW: [number, number, number] = [230, 220, 20];

describe('composeCollage', () => {
    it('renders four covers as a square 2x2 in order', async () => {
        const covers = await Promise.all([RED, GREEN, BLUE, YELLOW].map((c) => solid(...c)));
        const out = await composeCollage(covers, 200);
        expect(out).not.toBeNull();
        const meta = await sharp(out!).metadata();
        expect([meta.format, meta.width, meta.height]).toEqual(['webp', 200, 200]);
        expect(near(await pixel(out!, 50, 50), RED)).toBe(true);
        expect(near(await pixel(out!, 150, 50), GREEN)).toBe(true);
        expect(near(await pixel(out!, 50, 150), BLUE)).toBe(true);
        expect(near(await pixel(out!, 150, 150), YELLOW)).toBe(true);
    });

    it('renders the first cover full-bleed when fewer than four exist', async () => {
        const out = await composeCollage([await solid(...BLUE), await solid(...RED)], 120);
        expect(near(await pixel(out!, 10, 10), BLUE)).toBe(true);
        expect(near(await pixel(out!, 110, 110), BLUE)).toBe(true);
    });

    it('skips an undecodable cover instead of failing the grid', async () => {
        const good = await Promise.all([RED, GREEN, BLUE, YELLOW].map((c) => solid(...c)));
        const out = await composeCollage([Buffer.from('not an image'), ...good], 200);
        expect(near(await pixel(out!, 50, 50), RED)).toBe(true);
        expect(near(await pixel(out!, 150, 150), YELLOW)).toBe(true);
    });

    it('returns null when nothing decodes', async () => {
        expect(await composeCollage([Buffer.from('x')], 100)).toBeNull();
    });
});

describe('getCoverCollage', () => {
    beforeEach(() => {
        files.clear();
        getImageByCatalogId.mockReset();
    });

    it('collapses byte-identical covers (tracks of one album) before picking tiles', async () => {
        const red = await solid(...RED);
        const green = await solid(...GREEN);
        const covers: Record<string, Buffer> = { t1: red, t2: red, t3: red, t4: green };
        getImageByCatalogId.mockImplementation(async (id: string) =>
            covers[id] ? { buffer: covers[id] } : null,
        );

        const res = await getCoverCollage(['t1', 't2', 't3', 't4'], 'thumb');
        // Two distinct covers → single-cover mode, first cover wins.
        const meta = await sharp(res!.buffer).metadata();
        expect([meta.width, meta.height]).toEqual([256, 256]);
        expect(near(await pixel(res!.buffer, 200, 200), RED)).toBe(true);
    });

    it('returns null when no id resolves to artwork', async () => {
        getImageByCatalogId.mockResolvedValue(null);
        expect(await getCoverCollage(['a', 'b'], 'card')).toBeNull();
    });

    it('serves a repeat request from the disk cache without refetching', async () => {
        getImageByCatalogId.mockResolvedValue({ buffer: await solid(...BLUE) });
        const first = await getCoverCollage(['a'], 'thumb');
        const calls = getImageByCatalogId.mock.calls.length;
        const second = await getCoverCollage(['a'], 'thumb');
        expect(getImageByCatalogId.mock.calls.length).toBe(calls);
        expect(second!.buffer.equals(first!.buffer)).toBe(true);
        expect(second!.etag).toBe(first!.etag);
    });

    it('refetches changed artwork when the URL revision changes', async () => {
        getImageByCatalogId.mockResolvedValue({ buffer: await solid(...BLUE) });
        const first = await getCoverCollage(['a'], 'thumb', 'before');
        getImageByCatalogId.mockResolvedValue({ buffer: await solid(...RED) });
        const second = await getCoverCollage(['a'], 'thumb', 'after');
        expect(getImageByCatalogId).toHaveBeenCalledTimes(2);
        expect(second!.etag).not.toBe(first!.etag);
        expect(near(await pixel(second!.buffer, 100, 100), RED)).toBe(true);
        await getCoverCollage(['a'], 'thumb', 'after');
        expect(getImageByCatalogId).toHaveBeenCalledTimes(2);
    });

    it('keys the cache on size and id order', async () => {
        getImageByCatalogId.mockResolvedValue({ buffer: await solid(...BLUE) });
        const a = await getCoverCollage(['a', 'b'], 'thumb');
        const b = await getCoverCollage(['b', 'a'], 'thumb');
        const c = await getCoverCollage(['a', 'b'], 'card');
        expect(new Set([a!.etag, b!.etag, c!.etag]).size).toBe(3);
    });

    it('fetches each tile at the preset for the requested size', async () => {
        getImageByCatalogId.mockResolvedValue({ buffer: await solid(...BLUE) });
        await getCoverCollage(['x'], 'full');
        expect(getImageByCatalogId).toHaveBeenCalledWith('x', 'poster', { size: 'hd' });
    });
});
