// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';

const file = vi.hoisted(() => ({
    stat: vi.fn(),
    read: vi.fn(),
    close: vi.fn(async () => {}),
}));
vi.mock('node:fs/promises', () => ({ open: vi.fn(async () => file) }));
import { tailFile } from './progressive.js';

afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const paths = { partialPath: '/partial', finalPath: '/final' };

describe('growing MP3 read races', () => {
    it('retries a zero-byte read when normalization completed during the read', async () => {
        const completion = deferred();
        file.stat.mockResolvedValue({ size: 1 });
        file.read
            .mockImplementationOnce(async () => {
                // The OS read saw EOF before zero-extension; completion becomes
                // visible while the caller is awaiting that old read result.
                completion.resolve();
                await Promise.resolve();
                return { bytesRead: 0 };
            })
            .mockImplementationOnce(async (buffer: Buffer) => {
                buffer[0] = 0;
                return { bytesRead: 1 };
            });
        const body = tailFile({
            ...paths,
            start: 2,
            end: 2,
            expectedSize: 4,
            completion: completion.promise,
        });
        expect(new Uint8Array(await new Response(body).arrayBuffer())).toEqual(new Uint8Array([0]));
        expect(file.read).toHaveBeenCalledTimes(2);
    });

    it('does not time out a distant range while earlier bytes keep growing', async () => {
        const completion = deferred();
        let now = 0;
        let size = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        file.stat.mockImplementation(async () => {
            now += 60_000;
            size += 100;
            return { size };
        });
        file.read.mockImplementation(async (buffer: Buffer) => {
            if (size < 400) return { bytesRead: 0 };
            buffer[0] = 122;
            completion.resolve();
            return { bytesRead: 1 };
        });
        const body = tailFile({
            ...paths,
            start: 399,
            end: 399,
            expectedSize: 500,
            completion: completion.promise,
            pollMs: 1,
        });
        expect(await new Response(body).text()).toBe('z');
        expect(now).toBeGreaterThan(120_000);
    });

    it('errors only this reader after 120 seconds with no file growth', async () => {
        let now = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        file.stat.mockImplementation(async () => {
            now += 60_000;
            return { size: 0 };
        });
        file.read.mockResolvedValue({ bytesRead: 0 });
        const controller = new AbortController();
        const closed = vi.fn();
        const body = tailFile({
            ...paths,
            start: 900,
            end: 999,
            expectedSize: 1000,
            completion: new Promise<void>(() => {}),
            signal: controller.signal,
            onClose: closed,
            pollMs: 1,
        });
        await expect(new Response(body).text()).rejects.toThrow('Timed out');
        expect(controller.signal.aborted).toBe(false);
        await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    });
});
