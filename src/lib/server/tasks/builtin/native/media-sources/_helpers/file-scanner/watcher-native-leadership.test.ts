// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mockContext } from '@sapd/lumastra-plugin-sdk-testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '../../../../../../plugins/types/base-plugin.js';
import type { NativeWatcherOptions } from './watcher-native-host.js';
import { WatcherLeader } from './watcher.js';

const controls = vi.hoisted(() => ({
    spawn: undefined as NativeWatcherOptions['spawn'],
    verify: vi.fn(),
    shutdownMs: 10,
    acquire: vi.fn(),
    release: vi.fn(),
    renew: vi.fn(),
    cacheSet: vi.fn(),
    submit: vi.fn(),
    queued: vi.fn(),
    paths: vi.fn(),
    stopRunner: vi.fn(),
    stopOrchestrator: vi.fn(),
    leader: null as WatcherLeader | null,
    context: null as PluginContext | null,
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
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('../../../../../../database/queries/media-files.queries.js', () => ({
    deleteStaleMediaFile: vi.fn(),
    findMediaFilePathNfc: vi.fn(),
    findRangeFilesSupersededBy: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../../../../utils/walk-directory.js', () => ({ isLyricsSidecar: () => false }));
vi.mock('../../../../../../utils/safe-fs.js', () => ({ safeAccess: vi.fn() }));
vi.mock('../../../../../../utils/file-presence.js', () => ({ assessFilePresence: vi.fn() }));
vi.mock('./lyrics-sidecar.js', () => ({ clearSidecarLyricsForDeletedFile: vi.fn() }));
vi.mock('./flow-debouncer.js', () => ({ cancelWatcherFlowDebouncer: vi.fn() }));
vi.mock('./watcher-recency.js', () => ({ queueRecencyRefresh: vi.fn() }));
vi.mock('../../../../../../utils/native-watcher-policy.js', async () => {
    const { TEST_NATIVE_POLICY } = await import('./watcher-native-test-policy.js');
    return { buildNativeWatcherPolicy: vi.fn().mockResolvedValue(TEST_NATIVE_POLICY) };
});
vi.mock('./watcher-native-host.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./watcher-native-host.js')>();
    return {
        ...actual,
        verifyNativeWatcherBinary: controls.verify,
        NativeWatcherProcess: class extends actual.NativeWatcherProcess {
            constructor(options: NativeWatcherOptions) {
                super({
                    ...options,
                    spawn: controls.spawn,
                    livenessTimeoutMs: 3_600_000,
                    shutdownGraceMs: controls.shutdownMs,
                    shutdownKillMs: controls.shutdownMs,
                });
            }
        },
    };
});
vi.mock('../../../../../../database/queries/library-paths.queries.js', () => ({
    getEnabledLibraryPaths: controls.paths,
}));
vi.mock('../../../../../../tasks/orchestrator.js', () => ({
    orchestrator: {
        startRun: controls.submit,
        isRunQueued: controls.queued,
        stop: controls.stopOrchestrator,
    },
}));
vi.mock('$lib/server/config.js', () => ({ config: { WORKER_MODE: 'enabled' } }));
vi.mock('$lib/server/tasks/runner', () => ({ stopTaskRunner: controls.stopRunner }));
vi.mock('$lib/server/tasks/plugin-context.js', () => ({
    buildPluginContext: () => controls.context,
}));
vi.mock('../../file-scanner.js', () => ({
    // The runtime's external plugin adapter remains a one-line forwarding seam. Both
    // stopTaskSubsystem and the WatcherLeader/native host below execute their real code.
    fileScannerMediaSource: { stopWatching: () => controls.leader!.stop() },
}));

let fake: ReturnType<typeof stuckChild> | undefined;
type SyntheticChild = EventEmitter &
    Omit<
        ChildProcessWithoutNullStreams,
        'stdin' | 'stdout' | 'stderr' | 'exitCode' | 'signalCode'
    > & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        exitCode: number | null;
        signalCode: ChildProcessWithoutNullStreams['signalCode'];
    };
function stuckChild(): SyntheticChild {
    return Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null,
        kill: vi.fn(() => false),
        unref: vi.fn(),
    }) as unknown as SyntheticChild;
}

function reapedChild(): SyntheticChild {
    const child = stuckChild();
    child.stdin.once('finish', () => {
        void Promise.resolve().then(() => {
            child.exitCode = 0;
            child.emit('close', 0, null);
        });
    });
    child.kill = vi.fn((signal?: Parameters<ChildProcessWithoutNullStreams['kill']>[0]) => {
        void Promise.resolve().then(() => {
            child.signalCode = signal === 'SIGTERM' ? 'SIGTERM' : 'SIGKILL';
            child.emit('close', null, child.signalCode);
        });
        return true;
    });
    return child;
}

beforeEach(() => {
    vi.resetModules();
    controls.verify.mockReset().mockResolvedValue(undefined);
    controls.acquire.mockReset().mockResolvedValue('watcher-fixture-lock');
    controls.release.mockReset().mockResolvedValue(true);
    controls.renew.mockReset().mockResolvedValue(true);
    controls.cacheSet.mockReset().mockResolvedValue(undefined);
    controls.submit.mockReset().mockResolvedValue({ deduped: false });
    controls.queued.mockReset().mockResolvedValue(false);
    controls.paths.mockReset().mockResolvedValue([
        {
            id: 'watched-library-path',
            path: '/media',
            library_group_id: 'watched-library-group',
        },
    ]);
    controls.stopRunner.mockReset().mockResolvedValue(undefined);
    controls.stopOrchestrator.mockReset().mockResolvedValue(undefined);
    controls.shutdownMs = 10;
    // Use the canonical SDK test builder; the production watcher consumes the same
    // SDK-to-legacy context bridge as fileScannerMediaSource.startWatching.
    controls.context = mockContext() as unknown as PluginContext;
    controls.leader = new WatcherLeader(vi.fn());
});
afterEach(async () => {
    // Synthetic D-state cannot be produced safely with a real child. Existing real-child
    // host tests cover TERM/KILL; emit eventual reaping here to clear host quarantine.
    fake?.emit('close', 0, null);
    fake = undefined;
    controls.submit.mockResolvedValue({ deduped: false });
    if (controls.leader) await controls.leader.stop().catch(() => undefined);
    controls.leader = null;
    controls.spawn = undefined;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

describe('native watcher leadership failure propagation', () => {
    it('accepts a deduplicated scan waiting in retry backoff as final reconciliation', async () => {
        controls.spawn = () => {
            fake = reapedChild();
            return fake;
        };
        controls.submit.mockResolvedValue({ runId: 'run_retrying', deduped: true });
        controls.queued.mockResolvedValue(true);
        const leader = controls.leader!;
        await leader.start(controls.context!, ['/media']);
        fake!.stdout.write('{"type":"ready","version":2}\n');
        await leader.stop();
        expect(controls.queued).toHaveBeenCalledWith(
            'file-library-scan',
            { libraryPathId: 'watched-library-path' },
            'run_retrying',
        );
        expect(controls.submit).toHaveBeenCalledOnce();
        expect(controls.release).toHaveBeenCalledOnce();
    });

    it('keeps a root pending when its queue lookup rejects without restoring an earlier cleared root', async () => {
        vi.useFakeTimers();
        controls.paths.mockResolvedValue([
            { id: 'a', path: '/media/a', library_group_id: 'group-a' },
            { id: 'b', path: '/media/b', library_group_id: 'group-b' },
        ]);
        controls.submit.mockImplementation(
            async (_task: string, input: { libraryPathId: string }) => ({
                runId: `scan-${input.libraryPathId}`,
                deduped: input.libraryPathId === 'b',
            }),
        );
        controls.queued.mockRejectedValue(new Error('Valkey unavailable'));
        controls.spawn = () => {
            fake = reapedChild();
            return fake;
        };
        const leader = controls.leader!;
        await leader.start(controls.context!, ['/media/a', '/media/b']);
        fake!.stdout.write('{"type":"ready","version":2}\n');

        await expect(leader.stop()).rejects.toThrow('reconciliation unresolved');
        expect(controls.queued).toHaveBeenCalledExactlyOnceWith(
            'file-library-scan',
            { libraryPathId: 'b' },
            'scan-b',
        );
        const repair = leader as unknown as {
            repairRoots: { pending: Set<string> };
            rescan: { pending: boolean };
        };
        expect([...repair.repairRoots.pending]).toEqual(['b']);
        expect(repair.rescan.pending).toBe(true);
        expect(controls.release).not.toHaveBeenCalled();
        expect(controls.submit.mock.calls.map(([, input]) => input.libraryPathId)).toEqual([
            'a',
            'b',
        ]);

        // Once Valkey recovers, only B needs admission; A cleared before the rejection.
        controls.queued.mockResolvedValue(true);
        await leader.stop();
        expect(controls.submit.mock.calls.map(([, input]) => input.libraryPathId)).toEqual([
            'a',
            'b',
            'b',
        ]);
        expect(controls.queued).toHaveBeenCalledTimes(2);
        expect(controls.release).toHaveBeenCalledOnce();
    });

    it.each(['cooldown', 'stop'] as const)(
        'finishes multi-root repair when A remains active while B becomes admissible through %s',
        async (retry) => {
            vi.useFakeTimers();
            controls.paths.mockResolvedValue([
                { id: 'a', path: '/media/a', library_group_id: 'group-a' },
                { id: 'b', path: '/media/b', library_group_id: 'group-b' },
                { id: 'unwatched', path: '/elsewhere', library_group_id: 'other' },
            ]);
            const active = new Set(['b']);
            const admitted: string[] = [];
            controls.submit.mockImplementation(
                async (_task: string, input: { libraryPathId: string }) => {
                    const id = input.libraryPathId;
                    admitted.push(id);
                    if (active.has(id)) return { runId: `running-${id}`, deduped: true };
                    active.add(id);
                    return { runId: `accepted-${id}`, deduped: false };
                },
            );
            controls.spawn = () => {
                fake = reapedChild();
                return fake;
            };
            const leader = controls.leader!;
            await leader.start(controls.context!, ['/media/a', '/media/b']);
            fake!.stdout.write('{"type":"ready","version":2}\n');
            if (retry === 'stop') await expect(leader.stop()).rejects.toThrow('UNKNOWN');
            else await vi.advanceTimersByTimeAsync(1000);
            expect(admitted).toEqual(['a', 'b']);
            expect(active.has('a')).toBe(true);
            expect(controls.release).not.toHaveBeenCalled();
            // B's prior scan exits; A's newly accepted scan is STILL active.
            // Re-admitting A here would dedup it and keep alternating forever.
            active.delete('b');
            if (retry === 'stop') {
                await leader.stop();
                expect(controls.release).toHaveBeenCalledOnce();
            } else {
                await vi.advanceTimersByTimeAsync(30_000);
                const rescan = (leader as unknown as { rescan: { pending: boolean } }).rescan;
                expect(rescan.pending).toBe(false);
                await vi.advanceTimersByTimeAsync(60_000);
            }
            expect(admitted).toEqual(['a', 'b', 'b']);
            expect(active.has('a')).toBe(true);
        },
    );

    it('reconsiders every root for a new gap received while an older admission is settling', async () => {
        vi.useFakeTimers();
        controls.paths.mockResolvedValue([
            { id: 'a', path: '/media/a', library_group_id: 'group-a' },
            { id: 'b', path: '/media/b', library_group_id: 'group-b' },
        ]);
        const admitted: string[] = [];
        let finishB: ((result: { deduped: boolean }) => void) | undefined;
        controls.submit.mockImplementation(
            async (_task: string, input: { libraryPathId: string }) => {
                admitted.push(input.libraryPathId);
                if (input.libraryPathId === 'a') return { deduped: false };
                return new Promise<{ deduped: boolean }>((resolve) => {
                    finishB = resolve;
                });
            },
        );
        controls.spawn = () => {
            fake = reapedChild();
            return fake;
        };
        const leader = controls.leader!;
        await leader.start(controls.context!, ['/media/a', '/media/b']);
        fake!.stdout.write('{"type":"ready","version":2}\n');
        await vi.advanceTimersByTimeAsync(1000);
        expect(admitted).toEqual(['a', 'b']);
        // A's earlier scan may already have passed this newer filesystem gap.
        // B's older admission reply is still in flight when the gap is signaled.
        fake!.stdout.write('{"type":"rescan","reason":"new gap while admission pending"}\n');
        finishB!({ deduped: true });
        await vi.advanceTimersByTimeAsync(0);
        const rescan = (leader as unknown as { rescan: { pending: boolean } }).rescan;
        expect(rescan.pending).toBe(true);
        controls.submit.mockImplementation(
            async (_task: string, input: { libraryPathId: string }) => {
                admitted.push(input.libraryPathId);
                return { deduped: false };
            },
        );
        await vi.advanceTimersByTimeAsync(30_000);
        expect(admitted).toEqual(['a', 'b', 'a', 'b']);
        expect(rescan.pending).toBe(false);
    });

    it.each(['deduplicated', 'unavailable'])(
        'preserves interrupted-observation repair through a native restart when admission is %s',
        async (admission) => {
            // This uses the real leader, native-host protocol and coalescer. The
            // coordination/admission seams are mocked: database
            // gap ingestion and actual workers are qualified separately.
            vi.useFakeTimers();
            const spawned = vi.fn(() => {
                fake = reapedChild();
                return fake;
            });
            controls.spawn = spawned;
            if (admission === 'deduplicated')
                controls.submit.mockResolvedValueOnce({ deduped: true });
            else controls.submit.mockRejectedValueOnce(new Error('repair admission unavailable'));
            controls.submit.mockResolvedValue({ deduped: false });
            const leader = controls.leader!;
            try {
                await leader.start(controls.context!, ['/media']);
                fake!.stdout.write(
                    '{"type":"ready","version":2}\n{"type":"rescan","reason":"native watcher observation interrupted"}\n',
                );
                await expect(leader.stop()).rejects.toThrow('UNKNOWN');
                expect(fake?.exitCode).toBe(0);
                expect(leader.isActive()).toBe(false);
                expect(controls.release).not.toHaveBeenCalled();
                expect(controls.submit).toHaveBeenCalledOnce();
                // The intentional no-watcher gap still needs a full scan. A
                // restart alone cannot turn initial-tree suppression into repair.
                expect(await leader.start(controls.context!, ['/media'])).toBe(true);
                expect(spawned).toHaveBeenCalledTimes(2);
                expect(controls.acquire).toHaveBeenCalledOnce();
                expect(controls.renew).toHaveBeenCalled();
                const pendingStatus = JSON.parse(
                    controls.cacheSet.mock.calls.at(-1)![1] as string,
                ) as { lastError?: string };
                expect(pendingStatus.lastError).toContain('UNKNOWN');
                await vi.advanceTimersByTimeAsync(40_000);
                expect(controls.submit).toHaveBeenCalledTimes(2);
                expect(controls.submit).toHaveBeenLastCalledWith(
                    'file-library-scan',
                    { libraryPathId: 'watched-library-path' },
                    {
                        libraryGroupId: 'watched-library-group',
                        trigger: {
                            kind: 'in-process',
                            sourceRoute: 'file-scanner.native-watcher-reconciliation',
                        },
                    },
                );
                const acceptedStatus = JSON.parse(
                    controls.cacheSet.mock.calls.at(-1)![1] as string,
                ) as { lastError?: string };
                expect(acceptedStatus.lastError).toBeUndefined();
                expect(leader.isActive()).toBe(true);
                await leader.stop();
                expect(fake?.exitCode).toBe(0);
                expect(controls.release).toHaveBeenCalledOnce();
            } finally {
                controls.submit.mockResolvedValue({ deduped: false });
                await leader.stop().catch(() => undefined);
                vi.useRealTimers();
            }
        },
    );

    it('releases the lease on an unconfirmed native drain, reports it, and recovers when the child closes', async () => {
        vi.useFakeTimers();
        fake = stuckChild();
        controls.spawn = () => fake!;
        const leader = controls.leader!;
        await leader.start(controls.context!, ['/media']);
        fake.stdout.write('{"type":"ready","version":2}\n');
        const stopped = expect(leader.stop()).rejects.toThrow('did not exit after SIGKILL');
        await vi.advanceTimersByTimeAsync(30);
        await stopped;
        expect(leader.isActive()).toBe(false);
        // The lease is released (another worker may take over) and no longer renewed.
        expect(controls.release).toHaveBeenCalledOnce();
        expect(leader.getRuntimeState()).toMatchObject({ state: 'failed', leaseHeld: false });
        expect(leader.getRuntimeState().lastError).toContain('SIGKILL');
        await expect(leader.start(controls.context!, ['/media/new'])).rejects.toThrow('SIGKILL');
        await expect(leader.updatePaths(['/media/new'])).rejects.toThrow('SIGKILL');
        expect(controls.acquire).toHaveBeenCalledOnce();
        controls.renew.mockClear();
        await vi.advanceTimersByTimeAsync(20_000);
        expect(controls.renew).not.toHaveBeenCalled();
        // The quarantined child finally closes: the failure clears and watching can resume.
        fake.emit('close', 0, null);
        await vi.advanceTimersByTimeAsync(0);
        expect(leader.getRuntimeState().state).toBe('stopped');
        controls.spawn = () => {
            fake = reapedChild();
            return fake;
        };
        expect(await leader.start(controls.context!, ['/media'])).toBe(true);
        expect(controls.acquire).toHaveBeenCalledTimes(2);
    });

    it('retains an asynchronously encountered fatal-stop drain failure for explicit cleanup', async () => {
        vi.useFakeTimers();
        fake = stuckChild();
        controls.spawn = () => fake!;
        const leader = controls.leader!;
        await leader.start(controls.context!, ['/media']);
        fake.stdout.write('{"type":"ready","version":1}\n');
        await vi.advanceTimersByTimeAsync(50);
        expect(controls.submit).toHaveBeenCalledOnce();
        await expect(leader.stop()).rejects.toThrow('did not exit after SIGKILL');
    });

    it('keeps unaccepted repair UNKNOWN, then resumes its latch on an explicit restart under the same lease', async () => {
        vi.useFakeTimers();
        controls.spawn = vi.fn(() => {
            fake = reapedChild();
            return fake;
        });
        controls.submit
            .mockResolvedValueOnce({ deduped: true })
            .mockResolvedValue({ deduped: false });
        const leader = controls.leader!;
        await leader.start(controls.context!, ['/media']);
        fake!.stdout.write('{"type":"ready","version":2}\n{"type":"rescan","reason":"overflow"}\n');
        await expect(leader.stop()).rejects.toThrow('UNKNOWN');
        expect(controls.submit).toHaveBeenCalledOnce();
        expect(controls.release).not.toHaveBeenCalled();
        expect(leader.isActive()).toBe(false);
        expect(await leader.start(controls.context!, ['/media'])).toBe(true);
        fake!.stdout.write('{"type":"ready","version":2}\n');
        // The retained coalescer still applies its cooldown, but the real caller
        // must resume it. Deleting WatcherLeader's resume() call fails this check.
        await vi.advanceTimersByTimeAsync(30000);
        expect(controls.submit).toHaveBeenCalledTimes(2);
        expect(controls.acquire).toHaveBeenCalledOnce();
        expect(controls.spawn).toHaveBeenCalledTimes(2);
        // A real leader heartbeat must stop publishing the old UNKNOWN status
        // once the resumed repair is accepted, without requiring another stop.
        await vi.advanceTimersByTimeAsync(10000);
        const latestStatus: { lastError?: string } = JSON.parse(
            controls.cacheSet.mock.calls.at(-1)![1] as string,
        );
        expect(latestStatus.lastError).toBeUndefined();
        expect(leader.isActive()).toBe(true);
        await leader.stop();
        expect(controls.release).toHaveBeenCalledOnce();
        expect(await leader.start(controls.context!, ['/media'])).toBe(true);
        expect(controls.acquire).toHaveBeenCalledTimes(2);
    });

    it('propagates a failed final repair and permits a later accepted stop retry', async () => {
        controls.spawn = () => {
            fake = reapedChild();
            return fake;
        };
        controls.submit.mockRejectedValueOnce(new Error('database unavailable'));
        const leader = controls.leader!;
        await leader.start(controls.context!, ['/media']);
        fake!.stdout.write('{"type":"ready","version":2}\n{"type":"rescan","reason":"overflow"}\n');
        await expect(leader.stop()).rejects.toThrow('UNKNOWN');
        expect(controls.release).not.toHaveBeenCalled();
        await leader.stop();
        expect(controls.submit).toHaveBeenCalledTimes(2);
        expect(controls.release).toHaveBeenCalledOnce();
    });

    it('reports a timed-out final repair as UNKNOWN until a later submission is accepted', async () => {
        vi.useFakeTimers();
        controls.spawn = () => {
            fake = reapedChild();
            return fake;
        };
        let settle: ((result: { deduped: boolean }) => void) | undefined;
        controls.submit.mockImplementationOnce(
            () =>
                new Promise<{ deduped: boolean }>((resolve) => {
                    settle = resolve;
                }),
        );
        const leader = controls.leader!;
        await leader.start(controls.context!, ['/media']);
        fake!.stdout.write('{"type":"ready","version":2}\n{"type":"rescan","reason":"overflow"}\n');
        const rejected = expect(leader.stop()).rejects.toThrow('UNKNOWN');
        await vi.advanceTimersByTimeAsync(5000);
        await rejected;
        expect(controls.release).not.toHaveBeenCalled();
        settle?.({ deduped: true });
        await vi.advanceTimersByTimeAsync(0);
        await leader.stop();
        expect(controls.submit).toHaveBeenCalledTimes(2);
        expect(controls.release).toHaveBeenCalledOnce();
    });

    it('shares overlapping stops and blocks startup until the shared stop settles', async () => {
        controls.spawn = () => {
            fake = reapedChild();
            return fake;
        };
        let release: (() => void) | undefined;
        controls.release.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );
        const leader = controls.leader!;
        await leader.start(controls.context!, ['/media']);
        const first = leader.stop(false);
        const second = leader.stop(true);
        expect(second).toBe(first);
        await expect.poll(() => controls.release).toHaveBeenCalledOnce();
        expect(await leader.start(controls.context!, ['/media'])).toBe(false);
        expect(leader.stop()).toBe(first);
        expect(controls.acquire).toHaveBeenCalledOnce();
        release?.();
        await first;
    });

    it('does not issue an unfenced fatal-status write while stopping the old owner', async () => {
        vi.useFakeTimers();
        controls.spawn = () => {
            fake = reapedChild();
            return fake;
        };
        const leader = controls.leader!;
        await leader.start(controls.context!, ['/media']);
        controls.cacheSet.mockClear();
        fake!.stdout.write('{"type":"ready","version":1}\n');
        await vi.advanceTimersByTimeAsync(50);
        expect(controls.submit).toHaveBeenCalledOnce();
        expect(controls.cacheSet).not.toHaveBeenCalled();
        await leader.stop();
    });

    it('submits terminal reconciliation through the real host callback and leader stop before discarding context', async () => {
        controls.shutdownMs = 2000;
        controls.spawn = () =>
            spawn(
                process.execPath,
                [
                    '-e',
                    `
            process.stdin.once('data',()=>{
                process.stdout.write('{"type":"ready","version":2}\\n'+
                    '{"type":"error","message":"terminal fixture failure","fatal":true}\\n');
                setInterval(()=>{},1000);
            });
        `,
                ],
                { stdio: ['pipe', 'pipe', 'pipe'] },
            );
        const leader = controls.leader!;
        await leader.start(controls.context!, ['/media']);
        await expect
            .poll(() => controls.submit)
            .toHaveBeenCalledWith(
                'file-library-scan',
                { libraryPathId: 'watched-library-path' },
                {
                    libraryGroupId: 'watched-library-group',
                    trigger: {
                        kind: 'in-process',
                        sourceRoute: 'file-scanner.native-watcher-reconciliation',
                    },
                },
            );
        await leader.stop();
        expect(controls.submit).toHaveBeenCalledOnce();
        expect(leader.isActive()).toBe(false);
    });
});
