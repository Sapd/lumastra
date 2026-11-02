// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mockContext } from '@sapd/lumastra-plugin-sdk-testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '../../../../../../plugins/types/base-plugin.js';
import { TEST_NATIVE_POLICY } from './watcher-native-test-policy.js';
import { parseNetworkReconcileSecs, WatcherLeader } from './watcher.js';
import { watcherReadinessReasons } from '../../../../../../../../task-runtime/runtime-state.js';

const controls = vi.hoisted(() => ({
    spawn: undefined as (() => unknown) | undefined,
    verify: vi.fn(),
    warn: vi.fn(),
    acquire: vi.fn(),
    release: vi.fn(),
    renew: vi.fn(),
    cacheSet: vi.fn(),
    submit: vi.fn(),
    paths: vi.fn(),
}));
vi.mock('../../../../../../cache/valkey.js', () => ({
    acquireLock: controls.acquire,
    releaseLock: controls.release,
    renewLock: controls.renew,
    cacheSet: controls.cacheSet,
    cacheDel: vi.fn().mockResolvedValue(undefined),
    cacheGet: vi.fn().mockResolvedValue(null),
    cacheExists: vi.fn().mockResolvedValue(false),
}));
vi.mock('../../../../../../utils/logger.js', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: controls.warn, error: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('../../../../../../database/queries/media-files.queries.js', () => ({
    deleteStaleMediaFile: vi.fn(),
    findMediaFilePathNfc: vi.fn(),
    findRangeFilesSupersededBy: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../../../../utils/walk-directory.js', () => ({ isLyricsSidecar: () => false }));
vi.mock('../../../../../../utils/safe-fs.js', () => ({ safeAccess: vi.fn() }));
vi.mock('../../../../../../utils/file-presence.js', () => ({ assessFilePresence: vi.fn() }));
vi.mock('../../../../../../utils/native-watcher-policy.js', () => ({
    buildNativeWatcherPolicy: vi.fn().mockResolvedValue(TEST_NATIVE_POLICY),
}));
vi.mock('./lyrics-sidecar.js', () => ({ clearSidecarLyricsForDeletedFile: vi.fn() }));
vi.mock('./flow-debouncer.js', () => ({ cancelWatcherFlowDebouncer: vi.fn() }));
vi.mock('./watcher-recency.js', () => ({ queueRecencyRefresh: vi.fn() }));
vi.mock('./watcher-native-host.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./watcher-native-host.js')>();
    return {
        ...actual,
        verifyNativeWatcherBinary: controls.verify,
        NativeWatcherProcess: class extends actual.NativeWatcherProcess {
            constructor(options: ConstructorParameters<typeof actual.NativeWatcherProcess>[0]) {
                super({
                    ...options,
                    spawn: controls.spawn as never,
                    livenessTimeoutMs: 3_600_000,
                    shutdownGraceMs: 10,
                    shutdownKillMs: 10,
                });
            }
        },
    };
});
vi.mock('../../../../../../database/queries/library-paths.queries.js', () => ({
    getEnabledLibraryPaths: controls.paths,
}));
vi.mock('../../../../../../tasks/orchestrator.js', () => ({
    orchestrator: { startRun: controls.submit, stop: vi.fn() },
}));

type Fake = EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: string | null;
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
};
let fake: Fake | undefined;
function reapedChild(): Fake {
    const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null,
        kill: vi.fn(),
        unref: vi.fn(),
    }) as Fake;
    child.stdin.once('finish', () => {
        void Promise.resolve().then(() => {
            child.exitCode = 0;
            child.emit('close', 0, null);
        });
    });
    child.kill.mockImplementation(() => {
        void Promise.resolve().then(() => {
            child.signalCode = 'SIGKILL';
            child.emit('close', null, 'SIGKILL');
        });
        return true;
    });
    return child;
}

let context: PluginContext;
let leader: WatcherLeader;
const processFile = vi.fn();
const READY = '{"type":"ready","version":2}\n';

beforeEach(() => {
    controls.warn.mockClear();
    controls.verify.mockReset().mockResolvedValue(undefined);
    controls.acquire.mockReset().mockResolvedValue('lock');
    controls.release.mockReset().mockResolvedValue(true);
    controls.renew.mockReset().mockResolvedValue(true);
    controls.cacheSet.mockReset().mockResolvedValue(undefined);
    controls.submit.mockReset().mockResolvedValue({ deduped: false });
    controls.paths
        .mockReset()
        .mockResolvedValue([{ id: 'p', path: '/media', library_group_id: 'g' }]);
    processFile.mockReset().mockResolvedValue(undefined);
    controls.spawn = () => {
        fake = reapedChild();
        return fake as unknown as ChildProcessWithoutNullStreams;
    };
    context = mockContext() as unknown as PluginContext;
    leader = new WatcherLeader(processFile);
});
afterEach(async () => {
    await leader.stop().catch(() => undefined);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

function lastHeartbeat(): Record<string, unknown> {
    return JSON.parse(controls.cacheSet.mock.calls.at(-1)![1] as string) as Record<string, unknown>;
}

describe('WatcherLeader.getRuntimeState', () => {
    it('reports a stopped native leader before anything starts', () => {
        expect(new WatcherLeader(vi.fn()).getRuntimeState()).toEqual({
            implementation: 'rust',
            state: 'stopped',
            limitations: [],
            restarts: 0,
            leaseHeld: false,
        });
    });

    it('walks starting -> ready -> degraded (partial) -> ready and carries limitations', async () => {
        vi.useFakeTimers();
        await leader.start(context, ['/media']);
        expect(leader.getRuntimeState()).toMatchObject({
            implementation: 'rust',
            state: 'starting',
            leaseHeld: true,
        });
        fake!.stdout.write(READY);
        await vi.advanceTimersByTimeAsync(0);
        expect(leader.getRuntimeState()).toMatchObject({
            state: 'ready',
            coverage: 'full',
            limitations: [],
            restarts: 0,
        });
        fake!.stdout.write(
            '{"type":"status","coverage":"partial","watchedDirs":5,"failedDirs":2,"failedSample":["/media/x"],"watchLimit":true,"nonUtf8Skipped":0,"refusedSymlinks":0,"networkRoots":["/media"]}\n',
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(leader.getRuntimeState()).toMatchObject({
            state: 'degraded',
            coverage: 'partial',
            limitations: ['watch_limit', 'network_shares', 'unreadable_dirs'],
        });
        // The same facts reach the heartbeat key the admin UI reads on other replicas.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(lastHeartbeat()).toMatchObject({
            coverage: 'partial',
            limitations: ['watch_limit', 'network_shares', 'unreadable_dirs'],
        });
        fake!.stdout.write(
            '{"type":"status","coverage":"full","watchedDirs":9,"failedDirs":0,"failedSample":[],"watchLimit":false,"nonUtf8Skipped":0,"refusedSymlinks":0,"networkRoots":[]}\n',
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(leader.getRuntimeState().coverage).toBe('full');
    });

    it('surfaces the watch-limit message as lastError without reporting healthy', async () => {
        vi.useFakeTimers();
        await leader.start(context, ['/media']);
        fake!.stdout.write(
            READY +
                '{"type":"error","message":"inotify limit: 10/20 dirs watched (fs.inotify.max_user_watches)","fatal":false,"code":"watch_limit"}\n',
        );
        await vi.advanceTimersByTimeAsync(10_000);
        const state = leader.getRuntimeState();
        expect(state.state).toBe('degraded');
        expect(state.lastError).toContain('fs.inotify.max_user_watches');
        expect(lastHeartbeat()).toMatchObject({ coverage: 'partial' });
        expect(String(lastHeartbeat().lastError)).toContain('max_user_watches');
        expect(leader.getStatus()).toMatchObject({ coverage: 'partial' });
    });

    it('is failed with the operator message when the --version preflight fails', async () => {
        controls.verify.mockRejectedValue(new Error('binary does not speak protocol 2'));
        await expect(leader.start(context, ['/media'])).rejects.toThrow('protocol 2');
        expect(controls.acquire).not.toHaveBeenCalled();
        expect(leader.getRuntimeState()).toMatchObject({
            state: 'failed',
            lastError: 'binary does not speak protocol 2',
            leaseHeld: false,
        });
        expect(leader.isActive()).toBe(false);
    });

    it('maps stalled probes, stalled roots and unwatched dirs to limitations with partial coverage', async () => {
        vi.useFakeTimers();
        await leader.start(context, ['/media']);
        fake!.stdout.write(
            READY +
                '{"type":"status","coverage":"partial","watchedDirs":5,"failedDirs":0,"failedSample":[],"watchLimit":false,"nonUtf8Skipped":0,"refusedSymlinks":0,"networkRoots":[],"stalledProbes":true,"unwatchedDirs":3,"stalledRoots":["/media"]}\n',
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(leader.getRuntimeState()).toMatchObject({
            state: 'degraded',
            coverage: 'partial',
            limitations: ['stalled_probes', 'stalled_roots', 'unwatched_dirs'],
        });
        // Fields default to false / 0 when the child omits them.
        fake!.stdout.write(
            '{"type":"status","coverage":"full","watchedDirs":9,"failedDirs":0,"failedSample":[],"watchLimit":false,"nonUtf8Skipped":0,"refusedSymlinks":0,"networkRoots":[]}\n',
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(leader.getRuntimeState()).toMatchObject({ state: 'ready', limitations: [] });
    });

    it('reports network_unreconciled and partial coverage when the reconcile is disabled', async () => {
        vi.stubEnv('LUMASTRA_WATCH_NETWORK_RECONCILE_SECS', '0');
        vi.useFakeTimers();
        await leader.start(context, ['/media']);
        fake!.stdout.write(
            READY +
                '{"type":"status","coverage":"full","watchedDirs":5,"failedDirs":0,"failedSample":[],"watchLimit":false,"nonUtf8Skipped":0,"refusedSymlinks":0,"networkRoots":["/media"]}\n',
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(leader.getRuntimeState()).toMatchObject({
            state: 'degraded',
            coverage: 'partial',
            limitations: ['network_shares', 'network_unreconciled'],
            networkReconcileSecs: 0,
        });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(lastHeartbeat()).toMatchObject({
            coverage: 'partial',
            networkReconcileSecs: 0,
        });
    });

    it('keeps network_shares as full coverage while the reconcile runs', async () => {
        vi.stubEnv('LUMASTRA_WATCH_NETWORK_RECONCILE_SECS', '120');
        vi.useFakeTimers();
        await leader.start(context, ['/media']);
        fake!.stdout.write(
            READY +
                '{"type":"status","coverage":"full","watchedDirs":5,"failedDirs":0,"failedSample":[],"watchLimit":false,"nonUtf8Skipped":0,"refusedSymlinks":0,"networkRoots":["/media"]}\n',
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(leader.getRuntimeState()).toMatchObject({
            state: 'ready',
            coverage: 'full',
            limitations: ['network_shares'],
            networkReconcileSecs: 120,
        });
    });

    it('counts child restarts', async () => {
        vi.useFakeTimers();
        await leader.start(context, ['/media']);
        fake!.stdout.write(READY);
        await vi.advanceTimersByTimeAsync(0);
        const first = fake!;
        first.exitCode = 1;
        first.emit('close', 1, null);
        await vi.advanceTimersByTimeAsync(1000);
        const state = leader.getRuntimeState();
        expect(state.restarts).toBe(1);
        expect(state.lastRestartAt).toBeDefined();
        expect(fake).not.toBe(first);
    });

    it('fails after start: a fatal child error is state failed and readiness reports watcher_failed', async () => {
        vi.useFakeTimers();
        await leader.start(context, ['/media']);
        fake!.stdout.write(READY);
        await vi.advanceTimersByTimeAsync(0);
        expect(leader.getRuntimeState().state).toBe('ready');
        expect(watcherReadinessReasons(leader.getRuntimeState())).toEqual([]);

        fake!.stdout.write('{"type":"error","message":"watcher backend died","fatal":true}\n');
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(100);
        const state = leader.getRuntimeState();
        expect(state.state).toBe('failed');
        expect(state.lastError).toBe('watcher backend died');
        expect(watcherReadinessReasons(state)).toEqual(['watcher_failed']);
    });

    it('restarting within backoff is starting, not failed', async () => {
        vi.useFakeTimers();
        await leader.start(context, ['/media']);
        fake!.stdout.write(READY);
        await vi.advanceTimersByTimeAsync(0);
        expect(leader.getRuntimeState().state).toBe('ready');

        // Unexpected crash: the host schedules a restart after a 1 s backoff, which has not elapsed yet.
        const crashed = fake!;
        crashed.exitCode = 1;
        crashed.emit('close', 1, null);
        await vi.advanceTimersByTimeAsync(0);
        const state = leader.getRuntimeState();
        expect(state.state).toBe('starting');
        expect(state.restarts).toBe(1);
        expect(watcherReadinessReasons(state)).toEqual(['watcher_starting']);
        expect(watcherReadinessReasons(state)).not.toContain('watcher_failed');
    });

    it('a never-started (disabled) watcher adds no readiness reason', () => {
        expect(watcherReadinessReasons(new WatcherLeader(vi.fn()).getRuntimeState())).toEqual([]);
    });
});

describe('init frame from the leader', () => {
    it('sends policy, network reconcile interval from the environment and roots', async () => {
        vi.stubEnv('LUMASTRA_WATCH_NETWORK_RECONCILE_SECS', '0');
        const chunks: string[] = [];
        controls.spawn = () => {
            fake = reapedChild();
            fake.stdin.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
            return fake as unknown as ChildProcessWithoutNullStreams;
        };
        await leader.start(context, ['/media']);
        const init = JSON.parse(chunks.join('').split('\n')[0]) as Record<string, unknown>;
        expect(init).toMatchObject({
            type: 'init',
            version: 2,
            paths: ['/media'],
            networkReconcileSecs: 0,
            policy: TEST_NATIVE_POLICY,
            aliveMs: 10_000,
        });
        expect(Array.isArray(init.networkPaths)).toBe(true);
    });

    it('validates LUMASTRA_WATCH_NETWORK_RECONCILE_SECS', () => {
        expect(parseNetworkReconcileSecs(undefined)).toBe(900);
        expect(parseNetworkReconcileSecs('')).toBe(900);
        expect(parseNetworkReconcileSecs('0')).toBe(0);
        expect(parseNetworkReconcileSecs('120')).toBe(120);
        expect(parseNetworkReconcileSecs('5')).toBe(60);
        expect(parseNetworkReconcileSecs('9999999')).toBe(86_400);
        expect(parseNetworkReconcileSecs('abc')).toBe(900);
        expect(parseNetworkReconcileSecs('-3')).toBe(900);
        expect(parseNetworkReconcileSecs('1.5')).toBe(900);
    });
});

describe('lease fencing', () => {
    it('stops dispatching on the first failed renewal and resumes with a reconciliation', async () => {
        vi.useFakeTimers();
        await leader.start(context, ['/media']);
        fake!.stdout.write(READY);
        await vi.advanceTimersByTimeAsync(2000);
        const submitsAfterReady = controls.submit.mock.calls.length;

        controls.renew.mockResolvedValue(false);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(leader.getRuntimeState()).toMatchObject({ state: 'degraded', leaseHeld: false });
        fake!.stdout.write('{"type":"event","event":"add","path":"/media/fenced.mkv"}\n');
        await vi.advanceTimersByTimeAsync(2000);
        expect(processFile).not.toHaveBeenCalled();

        controls.renew.mockResolvedValue(true);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(leader.getRuntimeState()).toMatchObject({ state: 'ready', leaseHeld: true });
        await vi.advanceTimersByTimeAsync(40_000);
        expect(controls.submit.mock.calls.length).toBeGreaterThan(submitsAfterReady);

        fake!.stdout.write('{"type":"event","event":"add","path":"/media/live.mkv"}\n');
        await vi.advanceTimersByTimeAsync(2000);
        expect(processFile).toHaveBeenCalledOnce();
        expect(processFile.mock.calls[0][1]).toBe('/media/live.mkv');
    });

    it('does not process a file whose debounce fires after the lease was lost', async () => {
        vi.useFakeTimers();
        await leader.start(context, ['/media']);
        fake!.stdout.write(READY);
        await vi.advanceTimersByTimeAsync(9700);
        controls.renew.mockResolvedValue(false);
        fake!.stdout.write('{"type":"event","event":"add","path":"/media/a.mkv"}\n');
        // The renewal fails at 10 s, before the 500 ms debounce of this event fires.
        await vi.advanceTimersByTimeAsync(2000);
        expect(processFile).not.toHaveBeenCalled();
    });

    it('fences on lease age alone when a renewal hangs past the validity window', async () => {
        vi.useFakeTimers();
        await leader.start(context, ['/media']);
        fake!.stdout.write(READY);
        await vi.advanceTimersByTimeAsync(0);
        controls.renew.mockImplementation(() => new Promise<boolean>(() => undefined));
        await vi.advanceTimersByTimeAsync(20_000);
        expect(leader.getRuntimeState().leaseHeld).toBe(true);
        // 30 s TTL minus the 5 s margin: after 25 s without a successful renewal.
        await vi.advanceTimersByTimeAsync(6000);
        expect(leader.getRuntimeState()).toMatchObject({ state: 'degraded', leaseHeld: false });
        fake!.stdout.write('{"type":"event","event":"add","path":"/media/late.mkv"}\n');
        await vi.advanceTimersByTimeAsync(2000);
        expect(processFile).not.toHaveBeenCalled();
    });

    it('counts a thrown renewal as a failure and stops after the third', async () => {
        vi.useFakeTimers();
        await leader.start(context, ['/media']);
        fake!.stdout.write(READY);
        await vi.advanceTimersByTimeAsync(0);
        controls.renew.mockRejectedValue(new Error('valkey down'));
        await vi.advanceTimersByTimeAsync(10_000);
        expect(leader.getRuntimeState().leaseHeld).toBe(false);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(leader.isActive()).toBe(false);
        // An ungraceful stop lets the lease expire instead of releasing a lock we may not own.
        expect(controls.release).not.toHaveBeenCalled();
    });
});

describe('obsolete watcher environment settings', () => {
    it.each([
        { implementation: '', network: undefined, interval: undefined, seconds: 900 },
        { implementation: 'rust', network: undefined, interval: '120', seconds: 120 },
        { implementation: 'chokidar', network: 'false', interval: '1', seconds: 60 },
        { implementation: undefined, network: 'FALSE', interval: '0', seconds: 0 },
    ])('warns once and continues with native watching: %j', async (settings) => {
        vi.resetModules();
        const { WatcherLeader: FreshLeader } = await import('./watcher.js');
        vi.stubEnv('LUMASTRA_WATCHER_IMPLEMENTATION', settings.implementation);
        vi.stubEnv('LUMASTRA_WATCH_NETWORK_FS', settings.network);
        vi.stubEnv('LUMASTRA_WATCH_NETWORK_RECONCILE_SECS', settings.interval);
        leader = new FreshLeader(processFile);
        expect(await leader.start(context, ['/media'])).toBe(true);
        const init = JSON.parse(String(fake!.stdin.read())) as { networkReconcileSecs: number };
        expect(init.networkReconcileSecs).toBe(settings.seconds);
        const warnings = controls.warn.mock.calls.filter(([message]) =>
            String(message).includes('no longer supported'),
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0]![0]).toContain('the native watcher is always used');
        expect(warnings[0]![0]).toContain(
            settings.seconds === 0
                ? 'network mounts are watched; periodic network reconciliation is disabled (0 s)'
                : `network mounts are watched and reconciled every ${settings.seconds} s`,
        );
        expect(leader.getRuntimeState().implementation).toBe('rust');
        await leader.stop();
        leader = new FreshLeader(processFile);
        expect(await leader.start(context, ['/media'])).toBe(true);
        expect(
            controls.warn.mock.calls.filter(([message]) =>
                String(message).includes('no longer supported'),
            ),
        ).toHaveLength(1);
    });

    it('does not warn for supported settings', async () => {
        vi.resetModules();
        const { WatcherLeader: FreshLeader } = await import('./watcher.js');
        vi.stubEnv('LUMASTRA_WATCHER_IMPLEMENTATION', undefined);
        vi.stubEnv('LUMASTRA_WATCH_NETWORK_FS', 'true');
        vi.stubEnv('LUMASTRA_WATCH_NETWORK_RECONCILE_SECS', '120');
        leader = new FreshLeader(processFile);
        expect(await leader.start(context, ['/media'])).toBe(true);
        expect(controls.warn).not.toHaveBeenCalled();
    });
});
