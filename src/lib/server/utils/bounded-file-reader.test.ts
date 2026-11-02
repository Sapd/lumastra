// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { readBoundedFile } from './bounded-file-reader.js';

it('reads and allocates at most cap+1 bytes even if a file grows and reads are short', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'subtitle-bounded-read-'));
    try {
        const path = join(dir, 'track.sup');
        await writeFile(path, Buffer.alloc(8, 1));
        const handle = await open(path, 'r');
        let bytes = 0;
        const buffers = new Set<Buffer>();
        const read = vi.fn(
            async (buffer: Buffer, offset: number, length: number, position: number) => {
                buffers.add(buffer);
                await writeFile(path, Buffer.alloc(1000, 2));
                const result = await handle.read(buffer, offset, Math.min(length, 3), position);
                bytes += result.bytesRead;
                return result;
            },
        );
        expect(await readBoundedFile({ read }, 16)).toBeNull();
        expect(bytes).toBe(17);
        expect([...buffers].reduce((sum, b) => sum + b.length, 0)).toBe(17);
        expect(
            read.mock.calls.every(([buffer, offset, length]) => offset + length <= buffer.length),
        ).toBe(true);
        await handle.close();
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
it('retains a small file at its actual size and accepts exactly cap bytes', async () => {
    const read = vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
        const data = Buffer.from('abc');
        const bytesRead = Math.max(0, Math.min(length, data.length - position));
        data.copy(buffer, offset, position, position + bytesRead);
        return { bytesRead };
    });
    const small = await readBoundedFile({ read }, 50 * 1024 * 1024);
    expect(small?.toString()).toBe('abc');
    expect(small!.buffer.byteLength).toBeLessThan(64 * 1024);
    expect((await readBoundedFile({ read }, 3))?.toString()).toBe('abc');
});
