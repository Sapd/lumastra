// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    NativeWatcherProcess,
    nativeWatcherQuarantined,
    verifyNativeWatcherBinary,
    waitForNativeWatcherQuarantineRelease,
    type NativeWatcherOptions,
} from './watcher-native-host.js';
import { TEST_NATIVE_POLICY } from './watcher-native-test-policy.js';
import {
    parseNativeWatcherMessage,
    NATIVE_WATCHER_MAX_LINE_BYTES,
} from './watcher-native-protocol.js';

const log = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../../../../../utils/logger.js', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: log.warn, error: vi.fn(), debug: vi.fn() }) },
}));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const run of cleanup.splice(0).reverse()) await run();
    vi.unstubAllEnvs();
    log.warn.mockClear();
});
function callbacks(): Pick<NativeWatcherOptions, 'onEvent' | 'onReady' | 'onError' | 'onRescan'> {
    return { onEvent: vi.fn(), onReady: vi.fn(), onError: vi.fn(), onRescan: vi.fn() };
}
function fixtureSpawn(script: string): () => ChildProcessWithoutNullStreams {
    return () =>
        spawn(process.execPath, ['-e', `process.stdin.once('data', () => { ${script} });`], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
}
type MakeOptions = Omit<NativeWatcherOptions, 'policy'> & {
    policy?: NativeWatcherOptions['policy'];
};
function make(options: MakeOptions): NativeWatcherProcess {
    const watcher = new NativeWatcherProcess({ policy: TEST_NATIVE_POLICY, ...options });
    cleanup.push(() => watcher.close());
    watcher.start();
    return watcher;
}

describe('native watcher protocol and lifecycle', () => {
    it('accepts the versioned records and rejects incompatible or malformed records', () => {
        for (const value of [
            { type: 'ready', version: 2 },
            { type: 'event', event: 'unlink', path: '/media/a.mkv' },
            { type: 'error', message: 'temporary', fatal: false },
            { type: 'error', message: 'limit', fatal: false, code: 'watch_limit' },
            { type: 'rescan', reason: 'overflow' },
            { type: 'alive', seq: 3 },
            {
                type: 'status',
                coverage: 'partial',
                watchedDirs: 10,
                failedDirs: 1,
                failedSample: ['/media/x'],
                watchLimit: true,
                nonUtf8Skipped: 0,
                refusedSymlinks: 2,
                networkRoots: [],
                stalledProbes: true,
                unwatchedDirs: 4,
                stalledRoots: ['/media/nfs'],
            },
        ]) {
            expect(parseNativeWatcherMessage(JSON.stringify(value))).toEqual(value);
        }
        for (const value of [
            null,
            [],
            { type: 'ready', version: 1 },
            { type: 'error', message: 'x', fatal: false, code: 'bogus' },
            { type: 'alive', seq: -1 },
            { type: 'status', coverage: 'full' },
            { type: 'event', event: 'delete', path: '/media/a' },
            { type: 'event', event: 'add', path: '\0' },
            { type: 'error', message: 'x', fatal: 'yes' },
        ]) {
            expect(() => parseNativeWatcherMessage(JSON.stringify(value))).toThrow();
        }
        expect(() => parseNativeWatcherMessage('broken')).toThrow();
    });

    it('defaults the optional status fields', () => {
        const status = parseNativeWatcherMessage(
            JSON.stringify({
                type: 'status',
                coverage: 'full',
                watchedDirs: 1,
                failedDirs: 0,
                failedSample: [],
                watchLimit: false,
                nonUtf8Skipped: 0,
                refusedSymlinks: 0,
                networkRoots: [],
            }),
        );
        expect(status).toMatchObject({ stalledProbes: false, unwatchedDirs: 0, stalledRoots: [] });
        expect(() =>
            parseNativeWatcherMessage(JSON.stringify({ ...status, stalledProbes: 'yes' })),
        ).toThrow();
        expect(() =>
            parseNativeWatcherMessage(JSON.stringify({ ...status, stalledRoots: [1] })),
        ).toThrow();
    });

    it('routes ready/file events and closes idempotently', async () => {
        const cb = callbacks();
        const watcher = make({
            paths: ['/media'],
            ...cb,
            spawn: fixtureSpawn(
                `process.stdout.write(JSON.stringify({type:'ready',version:2})+'\\n'+JSON.stringify({type:'event',event:'add',path:'/media/song.flac'})+'\\n'); process.stdin.on('data',()=>process.exit(0));`,
            ),
        });
        await expect.poll(() => cb.onEvent).toHaveBeenCalledWith('add', '/media/song.flac');
        expect(cb.onReady).toHaveBeenCalledOnce();
        const first = watcher.close();
        expect(watcher.close()).toBe(first);
        await first;
        expect(cb.onError).not.toHaveBeenCalled();
    });

    it('reports missing binary without falling back or retrying', async () => {
        const cb = callbacks();
        make({ paths: ['/media'], ...cb, binaryPath: '/definitely/missing/lumastra-watcher' });
        await expect
            .poll(() => cb.onError)
            .toHaveBeenCalledWith(expect.objectContaining({ fatal: true }));
        expect(cb.onReady).not.toHaveBeenCalled();
        expect(cb.onError).toHaveBeenCalledOnce();
    });

    it('restarts with bounded attempts and requests reconciliation', async () => {
        const cb = callbacks();
        const spawnChild = vi.fn(
            fixtureSpawn(
                `process.stdout.write('{"type":"ready","version":2}\\n'); setTimeout(()=>process.exit(7),20);`,
            ),
        );
        make({
            paths: ['/media'],
            ...cb,
            spawn: spawnChild,
            restartInitialDelayMs: 10,
            restartMaxDelayMs: 10,
            maxRestarts: 2,
        });
        await expect
            .poll(() => vi.mocked(cb.onError).mock.calls.some(([info]) => info.fatal))
            .toBe(true);
        expect(spawnChild).toHaveBeenCalledTimes(3);
        expect(cb.onRescan).toHaveBeenCalledWith('native watcher restarted');
        expect(cb.onRescan).toHaveBeenCalledWith('native watcher observation interrupted');
    });

    it('does not restart after close during backoff', async () => {
        const cb = callbacks();
        const spawnChild = vi.fn(fixtureSpawn('process.exit(7);'));
        const watcher = make({
            paths: ['/media'],
            ...cb,
            spawn: spawnChild,
            restartInitialDelayMs: 100,
            maxRestarts: 1,
        });
        await expect.poll(() => cb.onError).toHaveBeenCalled();
        await watcher.close();
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(spawnChild).toHaveBeenCalledOnce();
    });

    it('rejects oversized output, incompatible ready and out-of-root events', async () => {
        for (const script of [
            `process.stdout.write(Buffer.alloc(${NATIVE_WATCHER_MAX_LINE_BYTES + 1},120));`,
            `process.stdout.write('{"type":"ready","version":1}\\n');`,
            `process.stdout.write('{"type":"ready","version":2}\\n{"type":"event","event":"unlink","path":"/outside/file.mkv"}\\n');`,
        ]) {
            const cb = callbacks();
            const watcher = make({
                paths: ['/media'],
                ...cb,
                spawn: fixtureSpawn(script),
                maxRestarts: 0,
            });
            await expect
                .poll(() => cb.onError)
                .toHaveBeenCalledWith(expect.objectContaining({ fatal: true }));
            expect(cb.onEvent).not.toHaveBeenCalled();
            expect(cb.onRescan).toHaveBeenCalledWith('native watcher observation interrupted');
            await watcher.close();
        }
    });

    it('escalates shutdown for an unresponsive child', async () => {
        const cb = callbacks();
        let child: ChildProcessWithoutNullStreams | undefined;
        const watcher = make({
            paths: ['/media'],
            ...cb,
            shutdownGraceMs: 20,
            shutdownKillMs: 20,
            spawn: () => {
                child = fixtureSpawn(
                    `process.on('SIGTERM',()=>{}); process.stdout.write('{"type":"ready","version":2}\\n'); setInterval(()=>{},1000);`,
                )();
                return child;
            },
        });
        await expect.poll(() => cb.onReady).toHaveBeenCalled();
        await watcher.close();
        expect(child?.signalCode).toBe('SIGKILL');
    });

    it('bounds readiness failure and reaps the child without restarting', async () => {
        const cb = callbacks();
        let child: ChildProcessWithoutNullStreams | undefined;
        const spawnChild = vi.fn(() => {
            child = fixtureSpawn('setInterval(()=>{},1000);')();
            return child;
        });
        const watcher = make({
            paths: ['/media'],
            ...cb,
            spawn: spawnChild,
            startupTimeoutMs: 100,
            shutdownKillMs: 1000,
        });
        await expect
            .poll(() => cb.onError)
            .toHaveBeenCalledWith({
                message: 'Native watcher readiness deadline exceeded',
                fatal: false,
            });
        await watcher.close();
        expect(child?.signalCode).toBe('SIGKILL');
        // Retryable: a restart was scheduled (default 1 s backoff), but close() won the race.
        expect(spawnChild).toHaveBeenCalledOnce();
        // Nothing was observed yet, so there is no outage to rescan.
        expect(cb.onRescan).not.toHaveBeenCalled();
    });

    it('bounds a trickling incomplete output frame after ready', async () => {
        const cb = callbacks();
        let child: ChildProcessWithoutNullStreams | undefined;
        const watcher = make({
            paths: ['/media'],
            ...cb,
            outputFrameTimeoutMs: 50,
            spawn: () => {
                child = fixtureSpawn(`
                    process.stdout.write('{"type":"ready","version":2}\\n{');
                    setInterval(()=>process.stdout.write(' '),10);
                `)();
                return child;
            },
        });
        await expect
            .poll(() => cb.onError)
            .toHaveBeenCalledWith({
                message: 'Native watcher output frame deadline exceeded',
                fatal: true,
            });
        expect(cb.onReady).toHaveBeenCalledOnce();
        expect(cb.onRescan).toHaveBeenCalledOnce();
        await watcher.close();
        expect(child?.signalCode).toBe('SIGKILL');
    });

    it('treats closed stdout on a live child as bounded observation loss', async () => {
        const cb = callbacks();
        const watcher = make({
            paths: ['/media'],
            ...cb,
            outputFrameTimeoutMs: 50,
            spawn: fixtureSpawn(`
                process.stdout.end('{"type":"ready","version":2}\\n');
                setInterval(()=>{},1000);
            `),
        });
        await expect
            .poll(() => cb.onError)
            .toHaveBeenCalledWith({
                message: 'Native watcher stdout ended without process exit',
                fatal: true,
            });
        expect(cb.onRescan).toHaveBeenCalledOnce();
        await watcher.close();
    });

    it('accepts fragmented UTF-8 frames and clears the frame deadline after completion', async () => {
        const cb = callbacks();
        const watcher = make({
            paths: ['/media'],
            ...cb,
            outputFrameTimeoutMs: 200,
            spawn: fixtureSpawn(`
                const bytes = Buffer.from('{"type":"ready","version":2}\\n{"type":"event","event":"add","path":"/media/é.flac"}\\n');
                const split = bytes.indexOf(0xc3)+1;
                process.stdout.write(bytes.subarray(0,split));
                setTimeout(()=>process.stdout.write(bytes.subarray(split)),20);
                process.stdin.on('data',()=>process.exit(0));
            `),
        });
        await expect.poll(() => cb.onEvent).toHaveBeenCalledWith('add', '/media/é.flac');
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(cb.onError).not.toHaveBeenCalled();
        await watcher.close();
    });

    it('stops delivery immediately when an event callback closes during a chunk', async () => {
        const cb = callbacks();
        let watcher: NativeWatcherProcess;
        let closing: Promise<void> | undefined;
        cb.onEvent = vi.fn(() => {
            closing = watcher.close();
        });
        watcher = make({
            paths: ['/media'],
            ...cb,
            spawn: fixtureSpawn(`
                process.stdout.write('{"type":"ready","version":2}\\n'+
                    '{"type":"event","event":"add","path":"/media/one.flac"}\\n'+
                    '{"type":"event","event":"add","path":"/media/two.flac"}\\n');
                process.stdin.on('data',()=>process.exit(0));
            `),
        });
        await expect.poll(() => cb.onEvent).toHaveBeenCalled();
        await closing;
        expect(cb.onEvent).toHaveBeenCalledOnce();
        expect(cb.onError).not.toHaveBeenCalled();
    });

    it('bounds inherited pipes after the watched child has exited', async () => {
        const cb = callbacks();
        // This descendant models inherited pipes only; it has a finite lifetime and no watches.
        const watcher = make({
            paths: ['/media'],
            ...cb,
            shutdownKillMs: 30,
            spawn: fixtureSpawn(`
                require('node:child_process').spawn(process.execPath,
                    ['-e','setTimeout(()=>{},500)'], {stdio:['ignore',1,2]});
                process.stdout.write('{"type":"ready","version":2}\\n',()=>process.exit(7));
            `),
        });
        await expect
            .poll(() => cb.onError)
            .toHaveBeenCalledWith({
                message: 'Native watcher output pipes remained open after exit',
                fatal: true,
            });
        expect(cb.onRescan).toHaveBeenCalledOnce();
        await watcher.close();
    });

    it('does not pass application credentials into its filesystem child', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'watcher-env-'));
        cleanup.push(() => rm(dir, { recursive: true, force: true }));
        const binary = join(dir, 'fake-native');
        await writeFile(
            binary,
            `#!${process.execPath}\nprocess.stdin.once('data',()=>{process.stdout.write(JSON.stringify({type:'ready',version:2})+'\\n'+JSON.stringify({type:'error',message:JSON.stringify(Object.keys(process.env)),fatal:false})+'\\n');});`,
            { mode: 0o700 },
        );
        vi.stubEnv('NATIVE_TEST_SECRET', 'must-not-reach-child');
        vi.stubEnv('DATABASE_URL', 'postgres://secret');
        vi.stubEnv('VALKEY_URL', 'redis://secret');
        vi.stubEnv('NODE_OPTIONS', '--no-warnings');
        const cb = callbacks();
        make({ paths: ['/media'], ...cb, binaryPath: binary });
        await expect.poll(() => cb.onError).toHaveBeenCalled();
        const keys: unknown = JSON.parse(vi.mocked(cb.onError).mock.calls[0][0].message);
        expect(keys).toEqual(expect.arrayContaining(['PATH', 'LANG']));
        expect(keys).not.toContain('NATIVE_TEST_SECRET');
        expect(keys).not.toContain('DATABASE_URL');
        expect(keys).not.toContain('VALKEY_URL');
        expect(keys).not.toContain('NODE_OPTIONS');
    });
});

it('quarantines an unkillable child so later leaders cannot accumulate overlapping processes', async () => {
    const { EventEmitter } = await import('node:events');
    const { PassThrough } = await import('node:stream');
    const fake = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null,
        kill: vi.fn(() => false),
        unref: vi.fn(),
    });
    const stuck = new NativeWatcherProcess({
        policy: TEST_NATIVE_POLICY,
        paths: ['/media'],
        ...callbacks(),
        spawn: () => fake as unknown as ChildProcessWithoutNullStreams,
        shutdownGraceMs: 10,
        shutdownKillMs: 10,
    });
    try {
        stuck.start();
        fake.stdout.write('{"type":"ready","version":2}\n');
        await expect(stuck.close()).rejects.toThrow('did not exit after SIGKILL');
        expect(fake.kill).toHaveBeenCalledWith('SIGKILL');
        const cb = callbacks();
        const spawnAgain = vi.fn(
            fixtureSpawn(`process.stdout.write('{"type":"ready","version":2}\\n');`),
        );
        const replacement = make({ paths: ['/media'], ...cb, spawn: spawnAgain });
        expect(spawnAgain).not.toHaveBeenCalled();
        expect(cb.onError).toHaveBeenCalledWith(
            expect.objectContaining({
                fatal: true,
                message: expect.stringContaining('refusing an overlapping child'),
            }),
        );
        await replacement.close();
    } finally {
        fake.emit('close', 0, null);
        await expect(stuck.close()).rejects.toThrow('did not exit after SIGKILL');
    }
});

function spawnScript(script: string): () => ChildProcessWithoutNullStreams {
    return () => spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
}
const READY = `{"type":"ready","version":2}`;

describe('native watcher protocol v2 bridge behaviour', () => {
    it('sends init v2 with network paths, reconcile interval, policy and alive period', async () => {
        const cb = callbacks();
        make({
            paths: ['/media/a', '/media/b'],
            networkPaths: ['/media/b', '/not/a/root'],
            networkReconcileSecs: 120,
            ...cb,
            spawn: spawnScript(`process.stdin.once('data',(d)=>{
                process.stdout.write(${JSON.stringify(READY)}+'\\n'+JSON.stringify({type:'error',message:d.toString(),fatal:false})+'\\n');
                setInterval(()=>{},1000);
            });`),
        });
        await expect.poll(() => cb.onError).toHaveBeenCalled();
        const init = JSON.parse(vi.mocked(cb.onError).mock.calls[0][0].message) as Record<
            string,
            unknown
        >;
        expect(init).toEqual({
            type: 'init',
            version: 2,
            paths: ['/media/a', '/media/b'],
            networkPaths: ['/media/b'],
            networkReconcileSecs: 120,
            policy: TEST_NATIVE_POLICY,
            stabilityMs: 500,
            pollMs: 100,
            aliveMs: 10_000,
        });
    });

    it('forwards status and watch_limit without restarting the child', async () => {
        const cb = callbacks();
        const spawnChild = vi.fn(
            spawnScript(`process.stdin.once('data',()=>{
                process.stdout.write(${JSON.stringify(READY)}+'\\n'+
                  '{"type":"error","message":"inotify full: 100/200 dirs watched","fatal":true,"code":"watch_limit"}\\n'+
                  '{"type":"status","coverage":"partial","watchedDirs":100,"failedDirs":100,"failedSample":["/m/x"],"watchLimit":true,"nonUtf8Skipped":0,"refusedSymlinks":0,"networkRoots":[]}\\n');
                setInterval(()=>{},1000);
            });`),
        );
        const onStatus = vi.fn();
        make({ paths: ['/media'], ...cb, onStatus, spawn: spawnChild, restartInitialDelayMs: 10 });
        await expect.poll(() => onStatus).toHaveBeenCalled();
        expect(onStatus.mock.calls[0][0]).toMatchObject({ coverage: 'partial', watchLimit: true });
        // fatal:true on a watch_limit frame is still partial coverage, never a stop.
        expect(cb.onError).toHaveBeenCalledWith({
            message: 'inotify full: 100/200 dirs watched',
            fatal: false,
            code: 'watch_limit',
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(spawnChild).toHaveBeenCalledOnce();
    });

    it('does not restart-loop when the child exits after reporting watch_limit', async () => {
        const cb = callbacks();
        const spawnChild = vi.fn(
            spawnScript(`process.stdin.once('data',()=>{
                process.stdout.write(${JSON.stringify(READY)}+'\\n'+
                  '{"type":"error","message":"limit","fatal":false,"code":"watch_limit"}\\n',()=>setTimeout(()=>process.exit(3),20));
            });`),
        );
        make({ paths: ['/media'], ...cb, spawn: spawnChild, restartInitialDelayMs: 10 });
        await expect
            .poll(() => vi.mocked(cb.onError).mock.calls.some(([info]) => info.fatal))
            .toBe(true);
        expect(vi.mocked(cb.onError).mock.calls.at(-1)![0].message).toContain(
            'fs.inotify.max_user_watches',
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(spawnChild).toHaveBeenCalledOnce();
    });

    it('logs handler exceptions and keeps delivering instead of treating them as corruption', async () => {
        const cb = callbacks();
        cb.onEvent = vi
            .fn()
            .mockImplementationOnce(() => {
                throw new Error('handler bug');
            })
            .mockImplementation(() => undefined);
        cb.onRescan = vi.fn(() => {
            throw new Error('rescan handler bug');
        });
        make({
            paths: ['/media'],
            ...cb,
            spawn: spawnScript(`process.stdin.once('data',()=>{
                process.stdout.write(${JSON.stringify(READY)}+'\\n'+
                 '{"type":"event","event":"add","path":"/media/one.flac"}\\n'+
                 '{"type":"rescan","reason":"x"}\\n'+
                 '{"type":"event","event":"add","path":"/media/two.flac"}\\n');
                setInterval(()=>{},1000);
            });`),
        });
        await expect.poll(() => cb.onEvent).toHaveBeenCalledTimes(2);
        expect(cb.onError).not.toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalledWith(
            expect.stringContaining('handler threw'),
            {},
            expect.any(Error),
        );
    });

    it('treats silence for 3 x aliveMs after ready as a wedged child and restarts it', async () => {
        const cb = callbacks();
        const spawnChild = vi.fn(
            spawnScript(`process.stdin.once('data',()=>{
                process.stdout.write(${JSON.stringify(READY)}+'\\n'); setInterval(()=>{},1000);
            });`),
        );
        make({
            paths: ['/media'],
            ...cb,
            aliveMs: 20,
            spawn: spawnChild,
            restartInitialDelayMs: 10,
            shutdownKillMs: 500,
        });
        await expect
            .poll(() =>
                vi
                    .mocked(cb.onError)
                    .mock.calls.some(([info]) => !info.fatal && info.message.includes('wedged')),
            )
            .toBe(true);
        await expect.poll(() => spawnChild).toHaveBeenCalledTimes(2);
    });

    it('keeps a child that sends alive frames', async () => {
        const cb = callbacks();
        const spawnChild = vi.fn(
            spawnScript(`process.stdin.once('data',()=>{
                process.stdout.write(${JSON.stringify(READY)}+'\\n');
                let seq=0; setInterval(()=>process.stdout.write(JSON.stringify({type:'alive',seq:seq++})+'\\n'),20);
            });`),
        );
        make({ paths: ['/media'], ...cb, aliveMs: 40, spawn: spawnChild });
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(cb.onError).not.toHaveBeenCalled();
        expect(spawnChild).toHaveBeenCalledOnce();
    });

    it('streams stderr line by line, rate limited, with one suppressed note', async () => {
        const cb = callbacks();
        make({
            paths: ['/media'],
            ...cb,
            restartInitialDelayMs: 10_000,
            spawn: spawnScript(`process.stdin.once('data',()=>{
                let out=''; for(let i=0;i<35;i++) out+='line '+i+'\\n';
                process.stderr.write(out,()=>process.exit(1));
            });`),
        });
        await expect.poll(() => cb.onError).toHaveBeenCalled();
        const lines = log.warn.mock.calls.filter(([m]) => m === 'Native watcher stderr');
        expect(lines).toHaveLength(20);
        expect(lines[0][1]).toEqual({ line: 'line 0' });
        const suppressed = log.warn.mock.calls.filter(([m]) =>
            String(m).includes('suppressed 15 lines'),
        );
        expect(suppressed).toHaveLength(1);
        // The exit message carries the retained tail.
        expect(vi.mocked(cb.onError).mock.calls[0][0].message).toContain('line 34');
    });

    it('backs off exponentially to the cap and debounces rescans per episode', async () => {
        const cb = callbacks();
        const launches: number[] = [];
        make({
            paths: ['/media'],
            ...cb,
            restartInitialDelayMs: 30,
            restartMaxDelayMs: 100,
            maxRestarts: 4,
            spawn: () => {
                launches.push(Date.now());
                return fixtureSpawn('process.exit(7);')();
            },
        });
        await expect
            .poll(() => vi.mocked(cb.onError).mock.calls.some(([info]) => info.fatal), {
                timeout: 10_000,
            })
            .toBe(true);
        expect(launches).toHaveLength(5);
        const gaps = launches.slice(1).map((time, i) => time - launches[i]);
        // delays are 30, 60, 100 (capped), 100; spawn time only adds to each gap
        expect(gaps[0]).toBeGreaterThanOrEqual(28);
        expect(gaps[1]).toBeGreaterThanOrEqual(58);
        expect(gaps[2]).toBeGreaterThanOrEqual(98);
        expect(gaps[3]).toBeGreaterThanOrEqual(98);
        const interrupted = vi
            .mocked(cb.onRescan)
            .mock.calls.filter(([reason]) => reason === 'native watcher observation interrupted');
        expect(interrupted).toHaveLength(1);
    });

    it('treats a non-executable binary as a non-retryable operator error', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'watcher-eacces-'));
        cleanup.push(() => rm(dir, { recursive: true, force: true }));
        const binary = join(dir, 'lumastra-watcher');
        await writeFile(binary, '#!/bin/sh\n', { mode: 0o600 });
        const cb = callbacks();
        make({ paths: ['/media'], ...cb, binaryPath: binary, restartInitialDelayMs: 10 });
        await expect
            .poll(() => cb.onError)
            .toHaveBeenCalledWith(
                expect.objectContaining({
                    fatal: true,
                    message: expect.stringContaining('EACCES'),
                }),
            );
        expect(cb.onError).toHaveBeenCalledOnce();
    });

    it('close() cannot hang after a corruption-triggered termination is already running', async () => {
        const cb = callbacks();
        const watcher = make({
            paths: ['/media'],
            ...cb,
            shutdownKillMs: 500,
            spawn: spawnScript(`process.stdin.once('data',()=>{
                process.stdout.write(${JSON.stringify(READY)}+'\\nnot json\\n'); setInterval(()=>{},1000);
            });`),
        });
        await expect.poll(() => cb.onReady).toHaveBeenCalled();
        const closed = watcher.close();
        const outcome = await Promise.race([
            closed.then(() => 'closed'),
            new Promise((resolve) => setTimeout(() => resolve('hung'), 5000)),
        ]);
        expect(outcome).toBe('closed');
    });

    it('exposes the restart count', async () => {
        const cb = callbacks();
        const onRestart = vi.fn();
        const watcher = make({
            paths: ['/media'],
            ...cb,
            onRestart,
            restartInitialDelayMs: 10,
            maxRestarts: 1,
            spawn: fixtureSpawn('process.exit(7);'),
        });
        await expect
            .poll(() => vi.mocked(cb.onError).mock.calls.some(([info]) => info.fatal))
            .toBe(true);
        expect(onRestart).toHaveBeenCalledOnce();
        expect(watcher.restartCount).toBe(1);
    });
});

describe('review round: watch limit, rescans, pre-ready liveness, quarantine set', () => {
    it('a later status without watchLimit clears the limit, so a child exit is retried', async () => {
        const cb = callbacks();
        const spawnChild = vi.fn(
            spawnScript(`process.stdin.once('data',()=>{
                const st=(w)=>JSON.stringify({type:'status',coverage:w?'partial':'full',watchedDirs:1,failedDirs:0,failedSample:[],watchLimit:w,nonUtf8Skipped:0,refusedSymlinks:0,networkRoots:[]})+'\\n';
                process.stdout.write(${JSON.stringify(READY)}+'\\n'+st(true)+st(false),()=>setTimeout(()=>process.exit(3),20));
            });`),
        );
        make({ paths: ['/media'], ...cb, spawn: spawnChild, restartInitialDelayMs: 10 });
        await expect.poll(() => spawnChild).toHaveBeenCalledTimes(2);
        expect(vi.mocked(cb.onError).mock.calls.every(([info]) => !info.fatal)).toBe(true);
    });

    it('keeps normal backoff when a child dies by signal or is killed for silence after watch_limit', async () => {
        for (const script of [
            `process.stdout.write(${JSON.stringify(READY)}+'\\n{"type":"error","message":"limit","fatal":false,"code":"watch_limit"}\\n',()=>setTimeout(()=>process.kill(process.pid,'SIGKILL'),20));`,
            `process.stdout.write(${JSON.stringify(READY)}+'\\n{"type":"error","message":"limit","fatal":false,"code":"watch_limit"}\\n'); setInterval(()=>{},1000);`,
        ]) {
            const cb = callbacks();
            const spawnChild = vi.fn(spawnScript(`process.stdin.once('data',()=>{ ${script} });`));
            const watcher = make({
                paths: ['/media'],
                ...cb,
                aliveMs: 30,
                spawn: spawnChild,
                restartInitialDelayMs: 10,
                shutdownKillMs: 500,
            });
            await expect.poll(() => spawnChild).toHaveBeenCalledTimes(2);
            expect(vi.mocked(cb.onError).mock.calls.some(([info]) => info.fatal)).toBe(false);
            await watcher.close();
        }
    });

    it('requests a rescan on the ready after every outage, spaced by the minimum interval', async () => {
        const cb = callbacks();
        make({
            paths: ['/media'],
            ...cb,
            restartInitialDelayMs: 10,
            restartMaxDelayMs: 10,
            maxRestarts: 2,
            rescanMinIntervalMs: 150,
            spawn: spawnScript(`process.stdin.once('data',()=>{
                process.stdout.write(${JSON.stringify(READY)}+'\\n',()=>setTimeout(()=>process.exit(7),20));
            });`),
        });
        // Outage 1 -> ready 2 rescans at once; outage 2 -> ready 3 rescans on the trailing edge.
        await expect
            .poll(
                () =>
                    vi
                        .mocked(cb.onRescan)
                        .mock.calls.filter(([reason]) => reason === 'native watcher restarted')
                        .length,
                { timeout: 5000 },
            )
            .toBe(2);
    });

    it('does not request a rescan for spawn failures that never observed anything', async () => {
        const cb = callbacks();
        make({
            paths: ['/media'],
            ...cb,
            binaryPath: '/definitely/missing/lumastra-watcher',
        });
        await expect.poll(() => cb.onError).toHaveBeenCalled();
        expect(cb.onRescan).not.toHaveBeenCalled();
    });

    it('kills a child that stays silent before ready, but not one sending alive during the walk', async () => {
        const silent = callbacks();
        const silentSpawn = vi.fn(
            spawnScript(`process.stdin.once('data',()=>{ setInterval(()=>{},1000); });`),
        );
        make({
            paths: ['/media'],
            ...silent,
            aliveMs: 20,
            spawn: silentSpawn,
            restartInitialDelayMs: 10,
            shutdownKillMs: 500,
        });
        await expect
            .poll(() =>
                vi
                    .mocked(silent.onError)
                    .mock.calls.some(
                        ([info]) => !info.fatal && info.message.includes('before ready'),
                    ),
            )
            .toBe(true);

        const walking = callbacks();
        const walkSpawn = vi.fn(
            spawnScript(`process.stdin.once('data',()=>{
                let seq=0;
                const t=setInterval(()=>process.stdout.write(JSON.stringify({type:'alive',seq:seq++})+'\\n'),20);
                setTimeout(()=>{clearInterval(t);process.stdout.write(${JSON.stringify(READY)}+'\\n');setInterval(()=>{},1000)},400);
            });`),
        );
        make({ paths: ['/media'], ...walking, aliveMs: 40, spawn: walkSpawn });
        await expect.poll(() => walking.onReady, { timeout: 3000 }).toHaveBeenCalled();
        expect(walking.onError).not.toHaveBeenCalled();
        expect(walkSpawn).toHaveBeenCalledOnce();
    });

    it('treats EPERM on a quarantined pid as pid reuse once the handle has an exit state', async () => {
        const { EventEmitter } = await import('node:events');
        const { PassThrough } = await import('node:stream');
        const fake = Object.assign(new EventEmitter(), {
            pid: 900003,
            stdin: new PassThrough(),
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            exitCode: null as number | null,
            signalCode: null,
            kill: vi.fn(() => false),
            unref: vi.fn(),
        });
        const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => {
            throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
        }) as typeof process.kill);
        try {
            const stuck = new NativeWatcherProcess({
                paths: ['/media'],
                policy: TEST_NATIVE_POLICY,
                ...callbacks(),
                spawn: () => fake as unknown as ChildProcessWithoutNullStreams,
                shutdownGraceMs: 10,
                shutdownKillMs: 10,
            });
            stuck.start();
            fake.stdout.write(READY + '\n');
            await expect(stuck.close()).rejects.toThrow('did not exit after SIGKILL');
            expect(nativeWatcherQuarantined()).toBe(true);
            fake.exitCode = 1;
            expect(nativeWatcherQuarantined()).toBe(false);
        } finally {
            killSpy.mockRestore();
            fake.emit('close', 0, null);
        }
    });
});

describe('quarantine expiry and binary preflight', () => {
    it('expires the quarantine once the stuck pid is gone', async () => {
        const { EventEmitter } = await import('node:events');
        const { PassThrough } = await import('node:stream');
        const fake = Object.assign(new EventEmitter(), {
            pid: 424242,
            stdin: new PassThrough(),
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            exitCode: null,
            signalCode: null,
            kill: vi.fn(() => false),
            unref: vi.fn(),
        });
        let alive = true;
        const realKill = process.kill.bind(process);
        const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
            pid: number,
            signal?: number | string,
        ) => {
            if (pid !== 424242) return realKill(pid, signal as number);
            if (alive) return true;
            throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
        }) as typeof process.kill);
        try {
            const stuck = new NativeWatcherProcess({
                paths: ['/media'],
                policy: TEST_NATIVE_POLICY,
                ...callbacks(),
                spawn: () => fake as unknown as ChildProcessWithoutNullStreams,
                shutdownGraceMs: 10,
                shutdownKillMs: 10,
            });
            stuck.start();
            fake.stdout.write(READY + '\n');
            await expect(stuck.close()).rejects.toThrow('did not exit after SIGKILL');
            expect(nativeWatcherQuarantined()).toBe(true);
            const released = waitForNativeWatcherQuarantineRelease(10);
            alive = false;
            await released;
            expect(nativeWatcherQuarantined()).toBe(false);
            // A new launch is no longer refused.
            const cb = callbacks();
            const spawnAgain = vi.fn(
                spawnScript(
                    `process.stdin.once('data',()=>{process.stdout.write(${JSON.stringify(READY)}+'\\n');setInterval(()=>{},1000)})`,
                ),
            );
            make({ paths: ['/media'], ...cb, spawn: spawnAgain });
            await expect.poll(() => cb.onReady).toHaveBeenCalled();
            expect(spawnAgain).toHaveBeenCalledOnce();
        } finally {
            killSpy.mockRestore();
            fake.emit('close', 0, null);
        }
    });

    async function fakeBinary(output: string): Promise<string> {
        const dir = await mkdtemp(join(tmpdir(), 'watcher-version-'));
        cleanup.push(() => rm(dir, { recursive: true, force: true }));
        const binary = join(dir, 'lumastra-watcher');
        await writeFile(binary, `#!/bin/sh\necho "${output}"\n`, { mode: 0o700 });
        return binary;
    }

    it('accepts a binary whose --version names protocol 2', async () => {
        await expect(
            verifyNativeWatcherBinary(await fakeBinary('lumastra-watcher 0.3.0 protocol 2')),
        ).resolves.toBeUndefined();
    });

    it('rejects a binary with another protocol version or none at all', async () => {
        await expect(
            verifyNativeWatcherBinary(await fakeBinary('lumastra-watcher 0.1.0 protocol 1')),
        ).rejects.toThrow('does not speak protocol 2');
        await expect(verifyNativeWatcherBinary(await fakeBinary('something else'))).rejects.toThrow(
            'does not speak protocol 2',
        );
        await expect(
            verifyNativeWatcherBinary('/definitely/missing/lumastra-watcher'),
        ).rejects.toThrow('ENOENT');
    });
});

describe('golden protocol fixture', () => {
    it('is protocol v2 and parses through the bridge', async () => {
        const { readFile } = await import('node:fs/promises');
        const golden = JSON.parse(
            await readFile(
                join(process.cwd(), 'native/watcher/tests/fixtures/protocol.json'),
                'utf8',
            ),
        ) as Record<string, Record<string, unknown>>;
        if (golden.init?.version !== 2 || golden.ready?.version !== 2)
            throw new Error(
                'native/watcher/tests/fixtures/protocol.json is not protocol v2; the Rust side must regenerate it',
            );
        for (const key of ['ready', 'event', 'error', 'rescan', 'status', 'alive'])
            if (golden[key])
                expect(parseNativeWatcherMessage(JSON.stringify(golden[key]))).toEqual(golden[key]);
        expect(golden.init).toMatchObject({
            type: 'init',
            version: 2,
            stabilityMs: 500,
            pollMs: 100,
        });
        expect(Array.isArray(golden.init.networkPaths)).toBe(true);
    });
});
