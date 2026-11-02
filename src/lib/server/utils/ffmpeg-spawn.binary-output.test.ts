// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('child_process', () => ({ spawn: h.spawn }));
vi.mock('$lib/server/config.js', () => ({
    config: { FFMPEG_PATH: '/ffmpeg' },
    LUMASTRA_FFMPEG_THREADS: 1,
}));
const { spawnFFmpegSafely } = await import('./ffmpeg-spawn.js');
let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'subtitle-output-'));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

function child(): EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    stdio: PassThrough[];
    kill: ReturnType<typeof vi.fn>;
} {
    const stdio = Array.from({ length: 5 }, () => new PassThrough());
    const proc = Object.assign(new EventEmitter(), {
        stdout: stdio[1],
        stderr: stdio[2],
        stdin: stdio[0],
        stdio,
        kill: vi.fn(() => true),
    });
    h.spawn.mockReturnValue(proc);
    return proc;
}

it('stops an oversized binary pipe before writing past the cap, waits for close', async () => {
    const proc = child();
    const path = join(dir, 'track.sup');
    let settled = false;
    const run = spawnFFmpegSafely({
        args: [],
        timeout: 1000,
        binaryOutputs: [{ path, maxBytes: 32 }],
    } as Parameters<typeof spawnFFmpegSafely>[0]).finally(() => {
        settled = true;
    });
    const rejection = expect(run).rejects.toMatchObject({ sizeExceeded: true });
    proc.stdio[3].write(Buffer.alloc(16, 1));
    proc.stdio[3].write(Buffer.alloc(17, 2));
    await vi.waitFor(() => expect(proc.kill).toHaveBeenCalledWith('SIGKILL'));
    expect(settled).toBe(false);
    proc.stdio[3].end();
    proc.emit('close', null, 'SIGKILL');
    await rejection;
    expect((await stat(path)).size).toBeLessThanOrEqual(32);
});

it('keeps ordinary binary output byte-identical and waits for its disk write', async () => {
    const proc = child();
    const path = join(dir, 'track.mkv');
    const run = spawnFFmpegSafely({
        args: [],
        binaryOutputs: [{ path, maxBytes: 32 }],
    } as Parameters<typeof spawnFFmpegSafely>[0]);
    proc.stdio[3].end(Buffer.from([0, 255, 128, 0, 4]));
    proc.emit('close', 0, null);
    await run;
    expect(await readFile(path)).toEqual(Buffer.from([0, 255, 128, 0, 4]));
});
