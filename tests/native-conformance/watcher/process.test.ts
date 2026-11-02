// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { accessSync, constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NativeWatcherProcess } from '../../../src/lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/watcher-native-host.js';
import { parseNativeWatcherMessage } from '../../../src/lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/watcher-native-protocol.js';
import { buildNativeWatcherPolicy } from '../../../src/lib/server/utils/native-watcher-policy.js';

const binary = process.env.LUMASTRA_WATCHER_BINARY ?? resolve('build/lumastra-watcher');
const cleanups: Array<() => Promise<void>> = [];
beforeAll(() => {
    accessSync(binary, constants.X_OK);
}); // Explicit native jobs fail when missing.
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'native-watcher-bridge-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
}
async function watcher(
    paths: string[],
): Promise<{ events: string[]; errors: unknown[]; rescans: string[] }> {
    const events: string[] = [];
    const errors: unknown[] = [];
    const rescans: string[] = [];
    const onReady = vi.fn();
    const child = new NativeWatcherProcess({
        paths,
        policy: await buildNativeWatcherPolicy(paths),
        binaryPath: binary,
        onReady,
        onEvent: (event, path) => {
            events.push(`${event}:${path}`);
        },
        onError: (error) => {
            errors.push(error);
        },
        onRescan: (reason) => {
            rescans.push(reason);
        },
    });
    cleanups.push(() => child.close());
    child.start();
    await expect.poll(() => onReady, { timeout: 10_000 }).toHaveBeenCalledOnce();
    return { events, errors, rescans };
}

describe('actual Rust watcher through the Node bridge', () => {
    it('uses golden protocol v2 records', async () => {
        const golden = JSON.parse(
            await readFile('native/watcher/tests/fixtures/protocol.json', 'utf8'),
        ) as Record<string, Record<string, unknown>>;
        expect(golden.init.version).toBe(2);
        for (const key of ['ready', 'event', 'error', 'rescan', 'status', 'alive'])
            if (golden[key])
                expect(parseNativeWatcherMessage(JSON.stringify(golden[key]))).toEqual(golden[key]);
    });

    it('reports --version as protocol 2', async () => {
        const { execFileSync } = await import('node:child_process');
        expect(execFileSync(binary, ['--version'], { encoding: 'utf8' })).toMatch(/protocol 2\b/);
    });

    it('detects live media, lyrics and populated directory moves under a vendor-named root', async () => {
        const temp = await fixture();
        const root = join(temp, '@configured-root');
        await mkdir(root);
        await writeFile(join(root, 'existing.mkv'), 'initial');
        const observed = await watcher([root]);
        expect(observed.events).toEqual([]);
        const file = join(root, '@Artist.FLAC');
        await writeFile(file, 'audio');
        await expect.poll(() => observed.events).toContain(`add:${file}`);
        await writeFile(file, 'changed audio');
        await expect.poll(() => observed.events).toContain(`change:${file}`);
        const lyric = join(root, 'song.txt');
        await writeFile(lyric, 'words');
        await expect.poll(() => observed.events).toContain(`add:${lyric}`);
        await rm(lyric);
        await expect.poll(() => observed.events).toContain(`unlink:${lyric}`);
        const incoming = join(temp, 'incoming');
        await mkdir(incoming);
        await writeFile(join(incoming, 'episode.mkv'), 'video');
        const moved = join(root, '.harbor Sign');
        await rename(incoming, moved);
        await expect.poll(() => observed.events).toContain(`add:${join(moved, 'episode.mkv')}`);
        await rename(moved, join(temp, 'outgoing'));
        await expect.poll(() => observed.events).toContain(`unlink:${join(moved, 'episode.mkv')}`);
        expect(observed.errors).toEqual([]);
    });

    it('follows directory/file aliases and resumes after root replacement', async () => {
        const temp = await fixture();
        const target = join(temp, 'target');
        await mkdir(target);
        const root = join(temp, 'root');
        await symlink(target, root);
        await symlink(target, join(target, 'loop'));
        const physical = join(temp, 'physical.bin');
        await writeFile(physical, 'old');
        const alias = join(root, 'linked.mkv');
        await symlink(physical, alias);
        const observed = await watcher([root]);
        await writeFile(physical, 'changed');
        await expect.poll(() => observed.events).toContain(`change:${alias}`);
        const newTarget = join(temp, 'replacement');
        await mkdir(newTarget);
        const replacement = join(temp, 'next-link');
        await symlink(newTarget, replacement);
        await rename(replacement, root);
        const file = join(root, 'new.mkv');
        await writeFile(file, 'new');
        await expect.poll(() => observed.events).toContain(`add:${file}`);
        expect(observed.errors).toEqual([]);
    });
});

it('recovers actual native child death without overlapping replacements', async () => {
    const { spawn } = await import('node:child_process');
    const root = await fixture();
    const spawned: import('node:child_process').ChildProcessWithoutNullStreams[] = [];
    const onReady = vi.fn();
    const onRescan = vi.fn();
    const onEvent = vi.fn();
    const bridge = new NativeWatcherProcess({
        paths: [root],
        policy: await buildNativeWatcherPolicy([root]),
        binaryPath: binary,
        onReady,
        onRescan,
        onEvent,
        onError: vi.fn(),
        restartInitialDelayMs: 20,
        spawn: (path) => {
            expect(
                spawned.every((child) => child.exitCode !== null || child.signalCode !== null),
            ).toBe(true);
            const child = spawn(path, [], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
            });
            spawned.push(child);
            return child;
        },
    });
    cleanups.push(() => bridge.close());
    bridge.start();
    await expect.poll(() => onReady).toHaveBeenCalledOnce();
    spawned[0].kill('SIGKILL');
    await expect.poll(() => onReady).toHaveBeenCalledTimes(2);
    expect(onRescan).toHaveBeenCalledWith('native watcher restarted');
    const file = join(root, 'after-restart.mkv');
    await writeFile(file, 'new');
    await expect.poll(() => onEvent).toHaveBeenCalledWith('add', file);
    await bridge.close();
    expect(spawned).toHaveLength(2);
    expect(spawned[1].exitCode).toBe(0);
});

it('retains a rescan signal across actual output backpressure', async () => {
    const { spawn } = await import('node:child_process');
    const root = await fixture();
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    cleanups.push(async () => {
        child.stdin.end('{"type":"close"}\n');
        if (child.exitCode === null && child.signalCode === null)
            await new Promise<void>((resolveClose) => {
                const timer = setTimeout(() => {
                    child.kill('SIGKILL');
                }, 3000);
                child.once('close', () => {
                    clearTimeout(timer);
                    resolveClose();
                });
            });
    });
    const ready = new Promise<void>((resolveReady) =>
        child.stdout.once('data', (chunk: Buffer) => {
            expect(chunk.toString()).toContain('"ready"');
            child.stdout.pause();
            resolveReady();
        }),
    );
    child.stdin.write(
        JSON.stringify({
            type: 'init',
            version: 2,
            paths: [root],
            networkPaths: [],
            networkReconcileSecs: 0,
            policy: await buildNativeWatcherPolicy([root]),
            stabilityMs: 500,
            pollMs: 100,
            aliveMs: 10_000,
        }) + '\n',
    );
    await ready;
    // More events than the 4096-record output queue plus the pipe buffer can hold.
    for (let batch = 0; batch < 60; batch++)
        await Promise.all(
            Array.from({ length: 100 }, (_, i) =>
                writeFile(join(root, `${batch}-${i}-${'x'.repeat(180)}.mkv`), 'media'),
            ),
        );
    // Delivery waits for write stability and is paced by the stat budget (about 2000
    // files/s): give the child time to produce every event while the reader is paused.
    await new Promise((resolveWait) => setTimeout(resolveWait, 6000));
    const messages: Array<{ type: string }> = [];
    let buffer = '';
    child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
            messages.push(JSON.parse(buffer.slice(0, newline)) as { type: string });
            buffer = buffer.slice(newline + 1);
        }
    });
    child.stdout.resume();
    await expect
        .poll(() => messages.some((message) => message.type === 'rescan'), { timeout: 10_000 })
        .toBe(true);
});
