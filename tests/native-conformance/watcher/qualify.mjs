// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fork, execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { arch, cpus, freemem, loadavg, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { build } from 'esbuild';

const usage =
    'Usage: node tests/native-conformance/watcher/qualify.mjs [--output path] [--title-directories 1..2000] [--steady-ms 1500..30000] [--fault-late-callback]';
const args = process.argv.slice(2);
const options = new Map();
for (let index = 0; index < args.length; index++) {
    const name = args[index];
    assert(
        ['--output', '--title-directories', '--steady-ms', '--fault-late-callback'].includes(
            name,
        ) && !options.has(name),
        usage,
    );
    if (name === '--fault-late-callback') options.set(name, true);
    else {
        const value = args[++index];
        assert(value && !value.startsWith('--'), usage);
        options.set(name, value);
    }
}
function boundedInteger(name, fallback, minimum, maximum) {
    const value = options.get(name);
    if (value === undefined) return fallback;
    assert(typeof value === 'string' && /^\d+$/.test(value), usage);
    const number = Number(value);
    assert(Number.isSafeInteger(number) && number >= minimum && number <= maximum, usage);
    return number;
}
const titleDirectories = boundedInteger('--title-directories', 200, 1, 2000);
const steadyMs = boundedInteger('--steady-ms', 1500, 1500, 30_000);
const expectedCounts = {
    files: titleDirectories * 50 + 5,
    directories: titleDirectories * 2 + 4,
    payloadBytes: (titleDirectories * 50 + 5) * Buffer.byteLength('fixture'),
    useful: titleDirectories * 10 + 4,
    junk: titleDirectories * 40 + 1,
};
const scaled = titleDirectories > 200;
const limits = {
    files: Math.max(30_000, expectedCounts.files),
    directories: Math.max(1000, expectedCounts.directories),
    payloadBytes: 32 * 1024 * 1024,
    startupMs: scaled ? 120_000 : 30_000,
    eventMs: 10_000,
    shutdownMs: 10_000,
    // Includes creation of four fresh trees; cleanup retains its separate budget.
    globalMs: scaled ? 900_000 : 480_000,
    sampleMs: 100,
    quietMs: 800,
    steadyMs,
};
const faultLateCallback = options.has('--fault-late-callback');
const output = resolve(options.get('--output') ?? 'build/watcher-qualification.json');
const binary = resolve(process.env.LUMASTRA_WATCHER_BINARY ?? 'build/lumastra-watcher');
const sourceDir = 'src/lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner';
const artifact = {
    schemaVersion: 1,
    status: 'failed',
    startedAt: new Date().toISOString(),
    limits,
    fixtureParameters: { titleDirectories, steadyMs, expectedCounts },
    faultLateCallback,
    methodology: {
        scope: 'Linux lab watcher boundary only; no database, queue, ingestion, or production soak',
        order: ['rust', 'rust', 'rust', 'rust'],
        readiness:
            'Production onReady callback after initial registration; initial events suppressed',
        timing: 'Parent performance.now receipt; includes IPC; completion-to-receipt may be negative',
        cache: 'Fresh equivalent fixture per trial; kernel caches not dropped; fixture creation warms cache',
        memory: 'Sum of simultaneous per-process RSS; Node includes worker threads once; shared pages may be double-counted. Excludes filesystem cache and kernel watch memory. Not whole-container memory.',
        pss: 'Optional smaps_rollup per-process PSS; unavailable samples remain null',
        conclusions:
            'No RAM-saving or latency threshold assertion; correctness and cleanup gate success',
    },
    trials: [],
};
let ownedTemp;
let active;
let deadlineExceeded = false;
const globalDeadline = Date.now() + limits.globalMs;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const hash = (data) => createHash('sha256').update(data).digest('hex');
async function maybeRead(path) {
    try {
        return await readFile(path, 'utf8');
    } catch {
        return null;
    }
}
async function evidence() {
    return {
        at: new Date().toISOString(),
        loadavg: loadavg(),
        freeMemoryBytes: freemem(),
        totalMemoryBytes: totalmem(),
        cpuCount: cpus().length,
        cgroup: await maybeRead('/proc/self/cgroup'),
        cgroupMemoryMax: await maybeRead('/sys/fs/cgroup/memory.max'),
        cgroupMemoryCurrent: await maybeRead('/sys/fs/cgroup/memory.current'),
        cgroupCpuMax: await maybeRead('/sys/fs/cgroup/cpu.max'),
        meminfo: await maybeRead('/proc/meminfo'),
    };
}
function checkDeadline() {
    assert(
        !deadlineExceeded && Date.now() < globalDeadline,
        `Global ${limits.globalMs / 60_000}-minute deadline exceeded`,
    );
}
async function waitFor(predicate, timeoutMs, description) {
    const end = Math.min(Date.now() + timeoutMs, globalDeadline);
    while (!predicate()) {
        checkDeadline();
        assert(Date.now() < end, `Timed out: ${description}`);
        await delay(20);
    }
}

// A detached host and every native descendant share an owned Linux process
// group. Worker threads are not separate processes and are never summed twice.
async function groupProcesses(group) {
    const result = [];
    for (const name of await readdir('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        const stat = await maybeRead(`/proc/${name}/stat`);
        if (!stat) continue; // Concurrent exits are normal.
        const fields = stat
            .slice(stat.lastIndexOf(')') + 2)
            .trim()
            .split(/\s+/);
        if (Number(fields[2]) !== group) continue;
        const status = await maybeRead(`/proc/${name}/status`);
        if (!status) continue;
        const rss = /^VmRSS:\s+(\d+) kB$/m.exec(status);
        const rollup = await maybeRead(`/proc/${name}/smaps_rollup`);
        const pss = rollup && /^Pss:\s+(\d+) kB$/m.exec(rollup);
        result.push({
            pid: Number(name),
            ppid: Number(fields[1]),
            group,
            startTicks: fields[19],
            state: fields[0],
            rssBytes: rss ? Number(rss[1]) * 1024 : null,
            pssBytes: pss ? Number(pss[1]) * 1024 : null,
        });
    }
    return result;
}
async function sample(trial, host) {
    const started = performance.now();
    const processes = await groupProcesses(host.pid);
    const living = processes.filter((entry) => entry.state !== 'Z');
    if (living.some((entry) => entry.rssBytes === null))
        trial.sampleErrors.push('Live owned process has unavailable RSS');
    trial.samples.push({
        atMs: started - trial.startedMs,
        durationMs: performance.now() - started,
        phase: trial.phase,
        processes,
        rssBytes: living.reduce((sum, entry) => sum + (entry.rssBytes ?? 0), 0),
        pssBytes: living.every((entry) => entry.pssBytes !== null)
            ? living.reduce((sum, entry) => sum + entry.pssBytes, 0)
            : null,
    });
}
function signalGroup(host, signal) {
    if (!host.pid) return;
    try {
        process.kill(-host.pid, signal);
    } catch (error) {
        if (error.code !== 'ESRCH') throw error;
    }
}
async function cleanup(host, trial) {
    // Cleanup deliberately has a separate finite budget, including after global timeout.
    if (!host.pid) {
        trial.cleanup = { reaped: true, spawnFailed: true };
        return;
    }
    if (host.exitCode === null && host.signalCode === null && host.connected) host.send('close');
    for (const [signal, budget] of [
        [null, 2000],
        ['SIGTERM', 1000],
        ['SIGKILL', 2000],
    ]) {
        if (signal) signalGroup(host, signal);
        const end = Date.now() + budget;
        while (Date.now() < end) {
            const remaining = await groupProcesses(host.pid);
            if (remaining.length === 0 && (host.exitCode !== null || host.signalCode !== null)) {
                trial.cleanup = {
                    reaped: true,
                    escalation: signal,
                    exitCode: host.exitCode,
                    signalCode: host.signalCode,
                };
                return;
            }
            await delay(50);
        }
    }
    trial.cleanup = { reaped: false, remaining: await groupProcesses(host.pid) };
    throw new Error('Owned watcher process group did not exit within cleanup deadline');
}

async function fixture(base) {
    const root = join(base, '@configured-root');
    const nested = join(root, '@eaDir', 'configured');
    const files = [];
    const directories = new Set();
    function add(path, content = 'fixture') {
        files.push([path, content]);
        let dir = dirname(path);
        while (dir.startsWith(base) && dir !== base) {
            directories.add(dir);
            dir = dirname(dir);
        }
    }
    for (let dir = 0; dir < titleDirectories; dir++) {
        for (let file = 0; file < 10; file++) add(join(root, `title-${dir}`, `media-${file}.mkv`));
        for (let file = 0; file < 20; file++) add(join(root, `title-${dir}`, `junk-${file}.bin`));
        for (let file = 0; file < 20; file++)
            add(join(root, `title-${dir}`, '@eaDir', `ignored-${file}.mkv`));
    }
    add(join(root, '.harbor Sign', 'initial.flac'));
    add(join(root, '@Artist.FLAC'));
    add(join(root, 'initial.lrc'));
    add(join(root, '._ignored.flac'));
    add(join(nested, 'initial.mkv'));
    const bytes = files.reduce((sum, [, content]) => sum + Buffer.byteLength(content), 0);
    const counts = {
        files: files.length,
        directories: directories.size,
        payloadBytes: bytes,
        useful: titleDirectories * 10 + 4,
        junk: titleDirectories * 40 + 1,
    };
    assert.deepEqual(counts, expectedCounts, 'Fixture dimensions differ from requested scale');
    assert.equal(counts.useful + counts.junk, counts.files, 'Fixture file classes differ');
    assert(
        files.length <= limits.files &&
            directories.size <= limits.directories &&
            bytes < limits.payloadBytes,
        'Fixture exceeds resource cap',
    );
    for (const dir of [...directories].sort()) {
        checkDeadline();
        await mkdir(dir, { recursive: true });
    }
    // Bounded write concurrency, outside measured Node hosts.
    for (let index = 0; index < files.length; index += 32) {
        checkDeadline();
        await Promise.all(
            files.slice(index, index + 32).map(([path, content]) => writeFile(path, content)),
        );
    }
    return {
        paths: [root, nested],
        counts,
        manifestSha256: hash(
            JSON.stringify(files.map(([path, content]) => [relative(base, path), content])),
        ),
    };
}

function summarize(trial) {
    const values = trial.samples.map((entry) => entry.rssBytes).sort((a, b) => a - b);
    const steady = trial.samples
        .filter((entry) => entry.phase === 'steady')
        .map((entry) => entry.rssBytes)
        .sort((a, b) => a - b);
    return {
        samples: values.length,
        peakTotalRssBytes: values.at(-1),
        steadyMedianTotalRssBytes: steady[Math.floor(steady.length / 2)],
        maxSampleDurationMs: Math.max(...trial.samples.map((entry) => entry.durationMs)),
        maxSampleGapMs: Math.max(
            0,
            ...trial.samples.slice(1).map((entry, index) => entry.atMs - trial.samples[index].atMs),
        ),
    };
}

async function runTrial(implementation, index, hostBundle) {
    checkDeadline();
    const base = join(ownedTemp, `trial-${index}`);
    const tree = await fixture(base);
    const trial = {
        implementation,
        index,
        fixture: tree,
        phase: 'startup',
        events: [],
        errors: [],
        rescans: [],
        samples: [],
        sampleErrors: [],
        operations: [],
        startedMs: performance.now(),
    };
    artifact.trials.push(trial);
    const host = fork(
        hostBundle,
        [
            JSON.stringify({
                implementation,
                paths: tree.paths,
                binaryPath: binary,
                faultLateCallback,
            }),
        ],
        {
            detached: true,
            execArgv: [],
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            env: {
                PATH: process.env.PATH,
                LANG: 'C.UTF-8',
                NODE_ENV: 'production',
                LOG_LEVEL: 'error',
            },
        },
    );
    active = { host, trial };
    trial.hostPid = host.pid;
    let closed = false;
    let ready = false;
    let exited = false;
    let ipcDisconnected = false;
    let processClosed = false;
    let diagnostics = '';
    host.stdout.on('data', (chunk) => {
        diagnostics = (diagnostics + chunk).slice(-16384);
    });
    host.stderr.on('data', (chunk) => {
        diagnostics = (diagnostics + chunk).slice(-16384);
    });
    host.on('error', (error) => trial.errors.push(String(error)));
    host.on('exit', () => {
        exited = true;
    });
    host.on('disconnect', () => {
        ipcDisconnected = true;
    });
    host.on('close', () => {
        processClosed = true;
    });
    host.on('message', (message) => {
        if (
            trial.events.length >= 1000 ||
            trial.errors.length >= 16 ||
            trial.rescans.length >= 16
        ) {
            signalGroup(host, 'SIGKILL');
            return;
        }
        const atMs = performance.now() - trial.startedMs;
        if (message.type === 'ready') {
            ready = true;
            trial.readyAtMs = atMs;
        } else if (message.type === 'closed') {
            closed = true;
        } else if (message.type === 'event') trial.events.push({ ...message, atMs });
        else if (message.type === 'rescan') trial.rescans.push(message);
        else trial.errors.push(message);
    });
    let sampling = true;
    const sampler = (async () => {
        while (sampling) {
            try {
                await sample(trial, host);
            } catch (error) {
                trial.sampleErrors.push(String(error));
            }
            await delay(limits.sampleMs);
        }
    })();
    try {
        await waitFor(
            () => ready || exited || trial.errors.length > 0,
            limits.startupMs,
            'watcher readiness',
        );
        assert(ready && !exited && trial.errors.length === 0, 'Watcher failed startup');
        trial.phase = 'mutations';
        // First mutation is issued as soon as ready is observed. Initial/junk
        // silence is independently checked by the exact final expected sequence.
        const useful = [
            join(tree.paths[0], 'live.mkv'),
            join(tree.paths[0], '@Live.FLAC'),
            join(tree.paths[0], '.harbor Sign', 'live.txt'),
            join(tree.paths[1], 'live.lrc'),
        ];
        const expected = [];
        for (const path of useful) {
            for (const event of ['add', 'change', 'unlink']) {
                const operation = { event, path, startedAtMs: performance.now() - trial.startedMs };
                trial.operations.push(operation);
                if (event === 'unlink') await rm(path);
                else await writeFile(path, event === 'add' ? 'live' : 'changed live payload');
                operation.completedAtMs = performance.now() - trial.startedMs;
                expected.push(`${event}:${path}`);
                await waitFor(
                    () =>
                        trial.events.some(
                            (entry) => entry.event === event && entry.path === path,
                        ) ||
                        exited ||
                        trial.errors.length > 0,
                    limits.eventMs,
                    `${event} ${path}`,
                );
                const observed = trial.events.find(
                    (entry) => entry.event === event && entry.path === path,
                );
                assert(observed, 'Required useful event missing');
                operation.receivedAtMs = observed.atMs;
                operation.latencyFromStartMs = observed.atMs - operation.startedAtMs;
                operation.latencyFromCompletionMs = observed.atMs - operation.completedAtMs;
            }
        }
        for (const path of [
            join(tree.paths[0], 'live.bin'),
            join(tree.paths[0], '._live.mkv'),
            join(tree.paths[0], 'title-0', '@eaDir', 'live.mkv'),
        ]) {
            await writeFile(path, 'junk');
            await delay(600);
            await writeFile(path, 'changed junk');
            await delay(600);
            await rm(path);
        }
        trial.phase = 'steady';
        await delay(limits.steadyMs + limits.quietMs);
        checkDeadline();
        trial.correctness = { passed: false, expected };
        trial.phase = 'shutdown';
        const shutdownStarted = performance.now();
        host.send('close');
        await waitFor(
            () => exited && ipcDisconnected && processClosed,
            limits.shutdownMs,
            'host shutdown and complete IPC drain',
        );
        trial.shutdownMs = performance.now() - shutdownStarted;
        assert(
            closed && host.exitCode === 0 && host.signalCode === null,
            'Host did not close gracefully',
        );
        // Final decision happens only after callbacks can no longer arrive.
        const observed = trial.events.map((entry) => `${entry.event}:${entry.path}`);
        trial.correctness.observed = observed;
        assert.deepEqual(
            observed,
            expected,
            'Missing, duplicate, initial, junk, late, or unexpected useful event',
        );
        assert.deepEqual(trial.errors, [], 'Watcher reported errors including shutdown callbacks');
        assert.deepEqual(
            trial.rescans,
            [],
            'Watcher requested reconciliation including shutdown callbacks',
        );
        trial.correctness = { passed: true, expected, observed, initialAndJunkSilent: true };
        assert.deepEqual(
            await groupProcesses(host.pid),
            [],
            'Descendant survived graceful shutdown',
        );
        assert(
            trial.samples.some((entry) => entry.processes.some((proc) => proc.pid === host.pid)),
            'Missing host RSS samples',
        );
        if (implementation === 'rust')
            assert(
                trial.samples.some((entry) => entry.processes.length > 1),
                'Native child never sampled',
            );
        assert.deepEqual(trial.sampleErrors, [], 'Incomplete process memory evidence');
        assert(
            trial.samples.some((entry) => entry.phase === 'steady'),
            'Missing steady-state samples',
        );
        trial.status = 'passed';
    } finally {
        sampling = false;
        await sampler;
        trial.diagnostics = diagnostics;
        trial.summary = summarize(trial);
        await cleanup(host, trial);
        active = null;
        await rm(base, { recursive: true, force: true });
    }
}

const timer = setTimeout(() => {
    deadlineExceeded = true;
    if (active) signalGroup(active.host, 'SIGKILL');
}, limits.globalMs);
function cancel() {
    deadlineExceeded = true;
    if (active) signalGroup(active.host, 'SIGKILL');
}
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
try {
    assert(platform() === 'linux', 'Qualification requires Linux /proc; no skip or fallback');
    await access('/proc/self/status', constants.R_OK);
    await access(binary, constants.X_OK);
    artifact.platform = {
        node: process.version,
        platform: platform(),
        kernel: release(),
        arch: arch(),
    };
    artifact.before = await evidence();
    artifact.binary = {
        path: binary,
        sha256: hash(await readFile(binary)),
        version: execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim(),
    };
    artifact.git = {
        head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        status: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }),
    };
    artifact.sourceHashes = {};
    for (const file of [
        ...(await readdir(sourceDir))
            .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
            .map((name) => join(sourceDir, name)),
        'src/lib/server/utils/media-file-kinds.ts',
        'tests/native-conformance/watcher/qualify.mjs',
        'tests/native-conformance/watcher/qualification-host.ts',
        'package-lock.json',
    ])
        artifact.sourceHashes[file] = hash(await readFile(file));
    ownedTemp = await mkdtemp(join(tmpdir(), 'watcher-qualification-'));
    // Keep bundle in app filesystem so external production dependencies resolve
    // from this checkout rather than an unrelated /tmp/node_modules.
    const bundleDir = await mkdtemp(resolve('tests/native-conformance/watcher/.qualification-'));
    try {
        const hostBundle = join(bundleDir, 'host.mjs');
        await build({
            entryPoints: ['tests/native-conformance/watcher/qualification-host.ts'],
            outfile: hostBundle,
            bundle: true,
            platform: 'node',
            format: 'esm',
            target: 'node22',
            packages: 'external',
            logLevel: 'warning',
        });
        artifact.hostBundleSha256 = hash(await readFile(hostBundle));
        for (const [index, implementation] of artifact.methodology.order.entries())
            await runTrial(implementation, index, hostBundle);
        assert(
            new Set(artifact.trials.map((trial) => trial.fixture.manifestSha256)).size === 1,
            'Trials used different fixture manifests',
        );
        checkDeadline();
        artifact.status = 'passed';
    } finally {
        await rm(bundleDir, { recursive: true, force: true });
    }
} catch (error) {
    artifact.failure =
        error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
    process.exitCode = 1;
} finally {
    clearTimeout(timer);
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    if (active) {
        try {
            await cleanup(active.host, active.trial);
        } catch (error) {
            artifact.cleanupFailure = String(error);
            artifact.status = 'failed';
            process.exitCode = 1;
        }
    }
    artifact.after = await evidence();
    artifact.finishedAt = new Date().toISOString();
    if (ownedTemp) {
        try {
            await rm(ownedTemp, { recursive: true, force: true });
        } catch (error) {
            artifact.fixtureCleanupFailure = String(error);
            artifact.status = 'failed';
            process.exitCode = 1;
        }
    }
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(artifact, null, 2) + '\n');
    console.log(`Watcher qualification ${artifact.status}: ${output}`);
}
