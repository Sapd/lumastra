// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { arch, platform, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { it } from 'vitest';
import { nativeWatcherPolicy } from '../../../src/lib/server/utils/media-file-kinds.js';
import { NativeWatcherProcess } from '../../../src/lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/watcher-native-host.js';
type Implementation = 'rust';
type ProcessSignal = NonNullable<ChildProcessWithoutNullStreams['signalCode']>;
interface ObservedEvent {
    implementation: Implementation;
    event: 'add' | 'change' | 'unlink';
    path: string;
    atMs: number;
    phase: string;
}
interface ChildEvidence {
    pid: number | null;
    spawnedAtMs: number;
    exitedAtMs?: number;
    closedAtMs?: number;
    exitCode?: number | null;
    signalCode?: ProcessSignal | null;
    killRequestedAtMs?: number;
    environmentKeys?: string[];
}
interface LifecycleArtifact {
    schemaVersion: number;
    status: 'failed' | 'passed';
    startedAt: string;
    finishedAt?: string;
    scope: string;
    limits: typeof limits;
    platform?: { node: string; kernel: string; arch: string };
    git?: { head: string; status: string };
    hashes: Record<string, string>;
    binaryVersion?: string;
    events: ObservedEvent[];
    expected: string[];
    timeline: Array<{ kind: string; atMs: number; detail?: unknown }>;
    errors: Array<{
        implementation: Implementation;
        message: string;
        fatal: boolean;
        atMs: number;
    }>;
    rescans: Array<{ reason: string; atMs: number }>;
    children: ChildEvidence[];
    gapPaths: string[];
    faultChurnPaths: string[];
    operations: Array<{ operation: string; path: string; atMs: number }>;
    logicalBytesWritten: number;
    cleanup?: { reaped: boolean; remainingGroups: number[] };
    failure?: string[];
}

const limits = {
    runMs: 270_000,
    cleanupMs: 20_000,
    startupMs: 30_000,
    eventMs: 10_000,
    rescanMs: 65_000,
    shutdownMs: 10_000,
    files: 128,
    operations: 200,
    payloadBytes: 64 * 1024,
};
const scanner = 'src/lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner';
const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Only inspect groups created by this fixture; never signal the Vitest runner's group. */
async function remainingGroups(groups: number[]): Promise<number[]> {
    const remaining = new Set<number>();
    for (const name of await readdir('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        let stat: string;
        try {
            stat = await readFile(`/proc/${name}/stat`, 'utf8');
        } catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
            throw error;
        }
        const group = Number(stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[2]);
        if (groups.includes(group)) remaining.add(group);
    }
    return [...remaining];
}

it('qualifies repeated native failure and explicit native restart', async () => {
    const output = resolve(
        process.env.LUMASTRA_WATCHER_LIFECYCLE_OUTPUT ??
            'build/native-validation/watcher-lifecycle.json',
    );
    const binary = resolve(process.env.LUMASTRA_WATCHER_BINARY ?? 'build/lumastra-watcher');
    const started = performance.now();
    const atMs = (): number => performance.now() - started;
    const artifact: LifecycleArtifact = {
        schemaVersion: 1,
        status: 'failed',
        startedAt: new Date().toISOString(),
        scope: 'Linux actual-process restart/churn and explicit restart only; repair signals are not database ingestion or durable admission proof',
        limits,
        hashes: {},
        events: [],
        expected: [],
        timeline: [],
        errors: [],
        rescans: [],
        children: [],
        gapPaths: [],
        faultChurnPaths: [],
        operations: [],
        logicalBytesWritten: 0,
    };
    const timeline = (kind: string, detail?: unknown): void => {
        artifact.timeline.push({ kind, detail, atMs: atMs() });
    };
    const children: ChildProcessWithoutNullStreams[] = [];
    const failures: unknown[] = [];
    const faultChurnPaths = new Set<string>();
    const fixtureFiles = new Set<string>();
    let base: string | undefined;
    let native: NativeWatcherProcess | undefined;
    let phase = 'setup';
    let readyCount = 0;
    let deadlineExceeded = false;
    let scenarioFinished = false;
    const signalGroups = (signal: ProcessSignal): void => {
        for (const child of children) {
            if (!child.pid) continue;
            try {
                process.kill(-child.pid, signal);
            } catch (error) {
                if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
                    failures.push(error);
            }
        }
    };
    const deadline = setTimeout(() => {
        deadlineExceeded = true;
        // close() synchronously disables native restart before any forced cleanup.
        void native?.close().catch(() => undefined);
        signalGroups('SIGKILL');
    }, limits.runMs);
    const check = (): void => {
        assert(!deadlineExceeded && atMs() < limits.runMs, 'Lifecycle run deadline exceeded');
        assert.equal(failures.length, 0, 'Asynchronous lifecycle failure');
        assert(!artifact.errors.some((error) => error.fatal), 'Unexpected fatal watcher error');
    };
    const waitFor = async (
        predicate: () => boolean,
        timeout: number,
        description: string,
    ): Promise<void> => {
        const until = atMs() + timeout;
        while (!predicate()) {
            check();
            assert(atMs() < until, `Timed out: ${description}`);
            await delay(20);
        }
        check();
    };
    const bounded = async (
        pending: Promise<unknown>,
        ms: number,
        description: string,
    ): Promise<void> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                pending,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), ms);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    };
    const write = async (path: string, content: string): Promise<void> => {
        check();
        fixtureFiles.add(path);
        artifact.logicalBytesWritten += Buffer.byteLength(content);
        artifact.operations.push({ operation: 'write', path, atMs: atMs() });
        assert(
            fixtureFiles.size <= limits.files &&
                artifact.operations.length <= limits.operations &&
                artifact.logicalBytesWritten <= limits.payloadBytes,
            'Fixture resource cap exceeded',
        );
        await writeFile(path, content);
    };
    const remove = async (path: string): Promise<void> => {
        check();
        artifact.operations.push({ operation: 'unlink', path, atMs: atMs() });
        assert(artifact.operations.length <= limits.operations, 'Fixture operation cap exceeded');
        await rm(path);
    };
    const eventCallback =
        (implementation: Implementation) =>
        (event: 'add' | 'change' | 'unlink', path: string): void => {
            if (artifact.events.length >= 1000) {
                failures.push(new Error('Watcher callback limit exceeded'));
                return;
            }
            artifact.events.push({ implementation, event, path, atMs: atMs(), phase });
        };
    const usefulSequence = async (
        implementation: Implementation,
        root: string,
        name: string,
    ): Promise<void> => {
        for (const suffix of ['mkv', 'FLAC']) {
            const path = join(root, `${name}.${suffix}`);
            for (const event of ['add', 'change', 'unlink'] as const) {
                const expected = `${implementation}:${event}:${path}`;
                artifact.expected.push(expected);
                if (event === 'unlink') await remove(path);
                else await write(path, event === 'add' ? 'new media' : 'changed media content');
                await waitFor(
                    () =>
                        artifact.events.some(
                            (observed) =>
                                `${observed.implementation}:${observed.event}:${observed.path}` ===
                                expected,
                        ),
                    limits.eventMs,
                    expected,
                );
            }
        }
    };
    const verifyEnvironment = async (): Promise<void> => {
        const child = children.at(-1)!;
        const record = artifact.children.at(-1)!;
        assert(child.pid, 'Native child has no PID');
        record.environmentKeys = (await readFile(`/proc/${child.pid}/environ`, 'utf8'))
            .split('\0')
            .filter(Boolean)
            .map((entry) => entry.split('=', 1)[0])
            .sort();
        assert.deepEqual(
            record.environmentKeys,
            ['LANG', 'PATH'],
            'Native child inherited extra environment',
        );
    };
    try {
        assert.equal(platform(), 'linux', 'Required lifecycle qualification needs Linux /proc');
        await access('/proc/self/stat', constants.R_OK);
        await access(binary, constants.X_OK);
        artifact.platform = { node: process.version, kernel: release(), arch: arch() };
        artifact.git = {
            head: execFileSync('git', ['rev-parse', 'HEAD'], {
                encoding: 'utf8',
                timeout: 5000,
            }).trim(),
            status: execFileSync('git', ['status', '--porcelain'], {
                encoding: 'utf8',
                timeout: 5000,
            }),
        };
        artifact.binaryVersion = execFileSync(binary, ['--version'], {
            encoding: 'utf8',
            timeout: 5000,
        }).trim();
        for (const file of [
            binary,
            `${scanner}/watcher-native-host.ts`,
            'src/lib/server/utils/media-file-kinds.ts',
            'tests/native-conformance/watcher/lifecycle.qualify.ts',
            'native/watcher/Cargo.lock',
            'package-lock.json',
        ])
            artifact.hashes[file] = createHash('sha256')
                .update(await readFile(file))
                .digest('hex');
        base = await mkdtemp(join(tmpdir(), 'watcher-lifecycle-'));
        const root = join(base, '@configured-root');
        await mkdir(join(root, '@eaDir'), { recursive: true });
        await mkdir(join(root, '.legitimate-title'));
        await write(join(root, 'initial.mkv'), 'initial ignored content');
        await write(join(root, '@eaDir', 'ignored.mkv'), 'vendor junk');
        const createNative = (): NativeWatcherProcess =>
            new NativeWatcherProcess({
                paths: [root],
                policy: nativeWatcherPolicy({
                    containmentRoots: [root],
                    sensitivePrefixes: ['/proc', '/sys', '/dev', '/etc'],
                }),
                binaryPath: binary,
                // Production restart delays and 500/100 ms stability remain untouched.
                spawn: (path) => {
                    assert(
                        artifact.children.every((child) => child.closedAtMs !== undefined),
                        'Native replacement overlaps an unreaped predecessor',
                    );
                    const child = spawn(path, [], {
                        detached: true,
                        stdio: ['pipe', 'pipe', 'pipe'],
                        env: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
                    });
                    children.push(child);
                    const record: ChildEvidence = { pid: child.pid ?? null, spawnedAtMs: atMs() };
                    artifact.children.push(record);
                    timeline('native-spawn', record.pid);
                    child.once('error', (error) => failures.push(error));
                    child.once('exit', (code, signal) => {
                        Object.assign(record, {
                            exitedAtMs: atMs(),
                            exitCode: code,
                            signalCode: signal,
                        });
                        timeline('native-exit', { pid: record.pid, code, signal });
                    });
                    child.once('close', () => {
                        record.closedAtMs = atMs();
                    });
                    return child;
                },
                onReady: () => {
                    readyCount++;
                    timeline('native-ready', readyCount);
                },
                onEvent: eventCallback('rust'),
                onError: (error) =>
                    artifact.errors.push({ implementation: 'rust', ...error, atMs: atMs() }),
                onRescan: (reason) => {
                    artifact.rescans.push({ reason, atMs: atMs() });
                },
            });
        native = createNative();
        phase = 'native-baseline';
        native.start();
        await waitFor(() => readyCount === 1, limits.startupMs, 'native initial ready');
        await verifyEnvironment();
        await usefulSequence('rust', root, 'baseline');
        for (let cycle = 0; cycle < 2; cycle++) {
            phase = `native-fault-${cycle}`;
            const paths = Array.from({ length: 8 }, (_, index) =>
                join(root, `fault-${cycle}-${index}.mkv`),
            );
            for (const path of paths) faultChurnPaths.add(path);
            await Promise.all(paths.map((path) => write(path, 'in-flight useful file')));
            const child = children.at(-1)!;
            const record = artifact.children.at(-1)!;
            assert(child.pid, 'Native child has no PID');
            record.killRequestedAtMs = atMs();
            timeline('native-kill', child.pid);
            assert(child.kill('SIGKILL'), 'Native SIGKILL was not delivered');
            // Churn deliberately straddles observation loss. Recovery signals, not
            // detailed callback delivery for these paths, cover the uncertain gap.
            for (let index = 0; index < paths.length; index++) {
                await write(paths[index], 'changed during interruption');
                if (index % 2 === 0) await remove(paths[index]);
                const junk = join(root, '@eaDir', `fault-${cycle}-${index}.mkv`);
                await write(junk, 'ignored junk');
                await remove(junk);
                await delay(25);
            }
            await waitFor(() => readyCount === cycle + 2, limits.startupMs, 'native restart ready');
            assert(
                record.exitedAtMs !== undefined && record.closedAtMs !== undefined,
                'Old child was not observed reaped',
            );
            assert.equal(record.signalCode, 'SIGKILL', 'Injected native death did not occur');
            await verifyEnvironment();
            phase = `native-recovered-${cycle}`;
            await usefulSequence('rust', root, `recovered-${cycle}`);
            // Recovery notifications are coalesced with a trailing 60 s deadline.
            // Observe that admission signal before closing the host cancels its timers.
            await waitFor(
                () => artifact.rescans.length === cycle + 1,
                limits.rescanMs,
                'coalesced outage recovery notification',
            );
        }
        phase = 'native-stop';
        await bounded(native.close(), limits.shutdownMs, 'native graceful close');
        assert.equal(artifact.children.length, 3, 'Unexpected native replacement count');
        assert.equal(artifact.children.at(-1)!.exitCode, 0, 'Final native child did not exit zero');
        const groups = children.flatMap((child) => (child.pid ? [child.pid] : []));
        assert.deepEqual(await remainingGroups(groups), [], 'Native group survived before restart');
        timeline('native-reaped-before-restart');
        phase = 'restart-gap';
        const gap = join(root, 'restart-gap.mkv');
        artifact.gapPaths.push(gap, join(root, 'initial.mkv'));
        await write(gap, 'created while no watcher exists');
        await write(join(root, 'initial.mkv'), 'changed while no watcher exists');
        timeline('gap-mutated', artifact.gapPaths);
        native = createNative();
        phase = 'native-restart';
        native.start();
        await waitFor(() => readyCount === 4, limits.startupMs, 'native restart ready');
        // Initial/gap files must stay suppressed. Real leader admission is tested
        // separately; this filesystem fixture cannot claim database gap repair.
        await usefulSequence('rust', root, 'after-restart');
        artifact.expected.push(`rust:change:${gap}`);
        await write(gap, 'a new live change after restart');
        await waitFor(
            () =>
                artifact.events.some(
                    (event) =>
                        event.implementation === 'rust' &&
                        event.event === 'change' &&
                        event.path === gap,
                ),
            limits.eventMs,
            'live restart gap-file change',
        );
        const junk = join(root, '._live.mkv');
        await write(junk, 'AppleDouble junk');
        await remove(junk);
        await delay(800);
        phase = 'native-restart-stop';
        await bounded(native.close(), limits.shutdownMs, 'restarted native graceful close');
        assert.equal(artifact.children.length, 4, 'Unexpected native replacement count');
        assert.equal(artifact.children.at(-1)!.exitCode, 0, 'Restarted child did not exit zero');
        scenarioFinished = true;
    } catch (error) {
        failures.push(error);
    } finally {
        clearTimeout(deadline);
        phase = 'cleanup';
        const cleanupUntil = performance.now() + limits.cleanupMs;
        for (const watcher of [native]) {
            if (!watcher) continue;
            try {
                await bounded(watcher.close(), limits.shutdownMs, 'watcher final cleanup');
            } catch (error) {
                failures.push(error);
            }
        }
        const groups = children.flatMap((child) => (child.pid ? [child.pid] : []));
        try {
            if (await remainingGroups(groups).then((remaining) => remaining.length > 0))
                signalGroups('SIGKILL');
            let remaining = await remainingGroups(groups);
            while (remaining.length > 0 && performance.now() < cleanupUntil) {
                await delay(50);
                remaining = await remainingGroups(groups);
            }
            artifact.cleanup = {
                reaped: remaining.length === 0,
                remainingGroups: remaining,
            };
            assert(artifact.cleanup.reaped, 'Owned process cleanup incomplete');
            if (scenarioFinished) {
                // All actual child pipes have finished;
                // callbacks can no longer alter the final correctness decision.
                const observed = artifact.events
                    .filter(
                        (event) =>
                            event.implementation !== 'rust' || !faultChurnPaths.has(event.path),
                    )
                    .map((event) => `${event.implementation}:${event.event}:${event.path}`);
                assert.deepEqual(
                    observed,
                    artifact.expected,
                    'Missing, duplicate, initial, junk or unexpected callback',
                );
                assert.deepEqual(
                    artifact.rescans.map((entry) => entry.reason),
                    ['native watcher restarted', 'native watcher restarted'],
                );
                assert.equal(artifact.errors.length, 2, 'Unexpected watcher error count');
                assert(
                    artifact.errors.every(
                        (error) =>
                            error.implementation === 'rust' &&
                            !error.fatal &&
                            error.message.includes('signal SIGKILL'),
                    ),
                    'Unplanned watcher error',
                );
            }
        } catch (error) {
            failures.push(error);
        }
        if (base) {
            try {
                await rm(base, { recursive: true, force: true });
            } catch (error) {
                failures.push(error);
            }
        }
        artifact.faultChurnPaths = [...faultChurnPaths];
        artifact.finishedAt = new Date().toISOString();
        artifact.status = scenarioFinished && failures.length === 0 ? 'passed' : 'failed';
        if (failures.length)
            artifact.failure = failures.map((error) =>
                error instanceof Error ? (error.stack ?? error.message) : String(error),
            );
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, JSON.stringify(artifact, null, 2) + '\n');
    }
    if (failures.length)
        throw new AggregateError(
            failures,
            `Watcher lifecycle qualification failed; artifact: ${output}`,
        );
});
