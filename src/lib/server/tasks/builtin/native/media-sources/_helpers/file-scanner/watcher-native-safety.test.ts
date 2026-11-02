// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeWatcherProcess } from './watcher-native-host.js';
import { TEST_NATIVE_POLICY } from './watcher-native-test-policy.js';

const children: NativeWatcherProcess[] = [];
afterEach(async () => {
    for (const child of children.splice(0)) await child.close();
});
describe('native watcher protocol safety', () => {
    it('rejects malformed UTF-8 instead of turning it into replacement-character paths', async () => {
        const onError = vi.fn();
        const onEvent = vi.fn();
        const child = new NativeWatcherProcess({
            paths: ['/media'],
            policy: TEST_NATIVE_POLICY,
            onError,
            onEvent,
            onReady: vi.fn(),
            onRescan: vi.fn(),
            maxRestarts: 0,
            spawn: () =>
                spawn(
                    process.execPath,
                    [
                        '-e',
                        `process.stdin.once('data',()=>{ process.stdout.write('{"type":"ready","version":2}\\n'); process.stdout.write(Buffer.from([0xff,10])); });`,
                    ],
                    { stdio: ['pipe', 'pipe', 'pipe'] },
                ),
        });
        children.push(child);
        child.start();
        await expect
            .poll(() => onError)
            .toHaveBeenCalledWith(expect.objectContaining({ fatal: true }));
        expect(onEvent).not.toHaveBeenCalled();
    });
    it('fails visibly when a child never reaches readiness', async () => {
        const onError = vi.fn();
        const onReady = vi.fn();
        const child = new NativeWatcherProcess({
            paths: ['/media'],
            policy: TEST_NATIVE_POLICY,
            onError,
            onEvent: vi.fn(),
            onReady,
            onRescan: vi.fn(),
            startupTimeoutMs: 100,
            spawn: () =>
                spawn(
                    process.execPath,
                    ['-e', 'process.stdin.resume(); setInterval(()=>{},1000);'],
                    { stdio: ['pipe', 'pipe', 'pipe'] },
                ),
        });
        children.push(child);
        child.start();
        await expect
            .poll(() => onError)
            .toHaveBeenCalledWith({
                message: 'Native watcher readiness deadline exceeded',
                fatal: false,
            });
        expect(onReady).not.toHaveBeenCalled();
    });
});
