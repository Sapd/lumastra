// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ spawn: vi.fn(), read: vi.fn() }));
vi.mock('$lib/server/config.js', () => ({
    config: { FFMPEG_PATH: '/ffmpeg', FFPROBE_PATH: '/ffprobe' },
}));
vi.mock('./ffmpeg-spawn.js', async (original) => ({
    ...(await original<typeof import('./ffmpeg-spawn.js')>()),
    spawnFFmpegSafely: (...args: unknown[]) => h.spawn(...args),
}));
vi.mock('./bounded-file-reader.js', async (original) => {
    const real = await original<typeof import('./bounded-file-reader.js')>();
    return {
        readBoundedFile: async (file: Awaited<ReturnType<typeof open>>, cap: number) => {
            const data = await real.readBoundedFile(file, cap);
            h.read(data, cap);
            return data;
        },
    };
});
const { extractSubtitleStreamsBinary, pendingSubtitleExtractions } =
    await import('./ffmpeg-subtitle-extractor.js');
const { FFmpegSizeError } = await import('./ffmpeg-spawn.js');
interface SpawnOptions {
    binaryOutputs: Array<{ path: string; maxBytes: number }>;
}
let dir: string;
let input: string;
beforeEach(async () => {
    h.spawn.mockReset();
    h.read.mockReset();
    dir = await mkdtemp(join(tmpdir(), 'subtitle-limit-'));
    input = join(dir, 'input.srt');
    await writeFile(input, '1\n00:00:00,000 --> 00:00:01,000\nhello\n');
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

it('rejects a grown output using at most cap+1 bytes and removes it', async () => {
    let output = '';
    const cap = 50 * 1024 * 1024;
    h.spawn.mockImplementation(async (options: SpawnOptions) => {
        output = options.binaryOutputs[0].path;
        const file = await open(output, 'w');
        await file.truncate(cap + 4096);
        await file.close();
    });
    expect((await extractSubtitleStreamsBinary(input, [0], 'sub')).get(0)).toBeNull();
    expect(h.read).toHaveBeenCalledWith(null, cap);
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('cleans all batch outputs on a size failure and drains queued extraction slots', async () => {
    const paths: string[] = [];
    let active = 0;
    let peak = 0;
    h.spawn.mockImplementation(async (options: SpawnOptions) => {
        active++;
        peak = Math.max(active, peak);
        for (const output of options.binaryOutputs) {
            paths.push(output.path);
            expect(output.maxBytes).toBe(50 * 1024 * 1024);
            await writeFile(output.path, 'partial');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        throw new FFmpegSizeError('binary output', 50 * 1024 * 1024, '');
    });
    const results = await Promise.all(
        Array.from({ length: 8 }, () => extractSubtitleStreamsBinary(input, [0, 1], 'sub')),
    );
    expect(results.every((result) => result.get(0) === null && result.get(1) === null)).toBe(true);
    expect(peak).toBeLessThanOrEqual(3);
    expect(pendingSubtitleExtractions()).toBe(0);
    expect(h.read).not.toHaveBeenCalled();
    for (const path of paths) await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
});
