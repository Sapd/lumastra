// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, access, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const io = vi.hoisted(() => ({
    failWrite: false,
    events: [] as string[],
    destination: '',
    expectMissing: true,
}));
vi.mock('node:fs/promises', async (original) => {
    const actual = await original<typeof import('node:fs/promises')>();
    return {
        ...actual,
        // Also inject the old direct-write path, so the regression fails there.
        writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
            if (io.failWrite) {
                await actual.writeFile(args[0], 'partial', args[2]);
                throw Object.assign(new Error('No space left'), { code: 'ENOSPC' });
            }
            return actual.writeFile(...args);
        },
        open: async (...args: Parameters<typeof actual.open>) => {
            const handle = await actual.open(...args);
            const write = handle.writeFile.bind(handle);
            vi.spyOn(handle, 'writeFile').mockImplementation(async (data, options) => {
                if (io.expectMissing) await expect(actual.access(io.destination)).rejects.toThrow();
                if (io.failWrite) {
                    await write('partial');
                    throw Object.assign(new Error('No space left'), { code: 'ENOSPC' });
                }
                await write(data, options);
                io.events.push('written');
            });
            const sync = handle.sync.bind(handle);
            vi.spyOn(handle, 'sync').mockImplementation(async () => {
                await sync();
                io.events.push('synced');
            });
            return handle;
        },
        link: async (...args: Parameters<typeof actual.link>) => {
            expect(io.events).toEqual(['written', 'synced']);
            await actual.link(...args);
            io.events.push('linked');
        },
    };
});
vi.mock('../database/connection.js', () => ({ getDb: () => null }));
import { publishSidecar } from './uploaded-chapters.service.js';

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sidecar-atomic-'));
    io.destination = join(dir, 'The Glass Estuary.en.srt');
    io.failWrite = false;
    io.expectMissing = true;
    io.events = [];
});
afterEach(async () => {
    io.failWrite = false;
    await rm(dir, { recursive: true, force: true });
});
it('cleans an ENOSPC partial write and permits a complete atomic retry', async () => {
    io.failWrite = true;
    await expect(
        publishSidecar(io.destination, Buffer.from('complete subtitle'), async () => 1),
    ).rejects.toThrow('No space left');
    await expect(access(io.destination)).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
    io.failWrite = false;
    expect(
        await publishSidecar(io.destination, Buffer.from('complete subtitle'), async () => 2),
    ).toBe(2);
    expect(await readFile(io.destination, 'utf8')).toBe('complete subtitle');
    expect(io.events).toEqual(['written', 'synced', 'linked']);
    expect(await readdir(dir)).toEqual(['The Glass Estuary.en.srt']);
});
it('refuses a symlink destination and leaves its target untouched', async () => {
    const target = join(dir, 'original.srt');
    await writeFile(target, 'original');
    await symlink(target, io.destination);
    io.expectMissing = false;
    await expect(
        publishSidecar(io.destination, Buffer.from('replacement'), async () => undefined),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await readFile(target, 'utf8')).toBe('original');
    expect((await readdir(dir)).sort()).toEqual(['The Glass Estuary.en.srt', 'original.srt']);
});
