// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Run one qualification command against a fresh, owned task and cache Valkey servers. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Redis from 'ioredis';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = async (file) =>
    createHash('sha256')
        .update(await readFile(file))
        .digest('hex');
const args = process.argv.slice(2);
const separator = args.indexOf('--');
const options = args.slice(0, separator);
assert(
    separator >= 0 && args[separator + 1],
    'Usage: with-isolated-valkey.mjs [--artifact path] -- command [args]',
);
assert(
    options.length === 0 || (options.length === 2 && options[0] === '--artifact'),
    'Unknown wrapper options',
);
const artifactPath = options[1];
const artifact = {
    status: 'failed',
    startedAt: new Date().toISOString(),
    serverStarted: false,
    serverStopped: false,
    callerGroupStopped: false,
    commandExit: null,
};
let directory, server, caller, callerExit, interrupted, notifyFailure;
const servers = [];
const failureNotice = new Promise((resolve) => {
    notifyFailure = resolve;
});
let serverFailure = false;
let stopping = false;
let result = 1;

function launch(command, commandArgs, options) {
    const child = spawn(command, commandArgs, options);
    const exited = new Promise((resolve) => {
        child.once('error', () => resolve({ code: null, signal: null, spawnFailed: true }));
        child.once('close', (code, signal) => resolve({ code, signal }));
    });
    return { child, exited };
}

async function waitBounded(promise, ms) {
    let timer;
    try {
        return await Promise.race([
            promise.then(() => true),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(false), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function signalOwned(child, signal) {
    if (!child?.pid) return;
    try {
        process.kill(-child.pid, signal);
    } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
}

function groupExists(pid) {
    try {
        process.kill(-pid, 0);
        return true;
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
        throw error;
    }
}

/** Only this child's original process group; escaped detached groups are outside this wrapper. */
async function stopOwnedGroup(child, exited, label) {
    if (child.pid) {
        if (groupExists(child.pid)) signalOwned(child, 'SIGTERM');
        const deadline = Date.now() + 5000;
        while (groupExists(child.pid) && Date.now() < deadline) await delay(50);
        if (groupExists(child.pid)) signalOwned(child, 'SIGKILL');
    }
    assert(await waitBounded(exited, 5000), `${label} child was not reaped`);
    if (child.pid) {
        const deadline = Date.now() + 5000;
        while (groupExists(child.pid) && Date.now() < deadline) await delay(50);
        assert(!groupExists(child.pid), `${label} original process group survived cleanup`);
    }
}

for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
        interrupted = signal;
        notifyFailure(`Qualification interrupted by ${signal}`);
    });

try {
    const binary = process.env.LUMASTRA_TEST_VALKEY_BINARY;
    assert(
        binary && path.isAbsolute(binary),
        'LUMASTRA_TEST_VALKEY_BINARY must name an absolute Valkey server binary; no fallback is allowed',
    );
    await access(binary, constants.X_OK);
    artifact.binarySha256 = await hash(binary);
    artifact.sourceSha256 = await hash(new URL(import.meta.url));
    directory = await mkdtemp(path.join(tmpdir(), 'lumastra-valkey-qualification-'));
    async function startServer(role, evictionPolicy) {
        const serverDirectory = path.join(directory, role);
        await mkdir(serverDirectory);
        const listener = createServer();
        await new Promise((resolve, reject) => {
            listener.once('error', reject);
            listener.listen(0, '127.0.0.1', resolve);
        });
        const address = listener.address();
        assert(address && typeof address === 'object');
        const port = address.port;
        await new Promise((resolve, reject) =>
            listener.close((error) => (error ? reject(error) : resolve())),
        );
        const launched = launch(
            binary,
            [
                '--bind',
                '127.0.0.1',
                '--port',
                String(port),
                '--dir',
                serverDirectory,
                '--save',
                '',
                '--appendonly',
                'no',
                '--protected-mode',
                'yes',
                '--daemonize',
                'no',
                '--databases',
                '16',
                '--loglevel',
                'warning',
                '--maxmemory',
                '256mb',
                '--maxmemory-policy',
                evictionPolicy,
            ],
            { detached: true, stdio: 'ignore' },
        );
        const owned = { ...launched, role, port };
        servers.push(owned);
        void owned.exited.then(() => {
            if (!stopping) {
                serverFailure = true;
                notifyFailure(`Owned ${role} Valkey exited unexpectedly`);
            }
        });
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            assert(
                !serverFailure && !interrupted,
                `Owned ${role} Valkey exited or qualification interrupted before readiness`,
            );
            const probe = new Redis({
                host: '127.0.0.1',
                port,
                db: 1,
                lazyConnect: true,
                connectTimeout: 500,
                commandTimeout: 500,
                maxRetriesPerRequest: 0,
                retryStrategy: () => null,
            });
            probe.on('error', () => {});
            try {
                await probe.connect();
                assert.equal(await probe.ping(), 'PONG');
                const info = await probe.info('server');
                const version = /^valkey_version:([^\r\n]+)\r?$/m.exec(info)?.[1];
                const pid = /^process_id:(\d+)\r?$/m.exec(info)?.[1];
                assert(version, 'Explicit binary did not identify itself as Valkey');
                assert.equal(Number(pid), owned.child.pid, 'Connected to a different server');
                assert.equal(await probe.dbsize(), 0, 'Owned Valkey DB1 was not empty');
                const policy = await probe.config('GET', 'maxmemory-policy');
                assert.equal(policy[1], evictionPolicy);
                owned.version = version;
                owned.ready = true;
                return owned;
            } catch (error) {
                if (Date.now() + 100 >= deadline) throw error;
            } finally {
                probe.disconnect();
            }
            await delay(100);
        }
        throw new Error(`Owned ${role} Valkey did not become ready`);
    }
    // Both stores are private per invocation; logical DB separation alone cannot
    // qualify the application's incompatible eviction policies.
    const task = await startServer('task', 'noeviction');
    const cache = await startServer('cache', 'allkeys-lru');
    server = cache.child;
    artifact.serverVersion = cache.version;
    artifact.serverPid = server.pid;
    artifact.taskServerPid = task.child.pid;
    artifact.taskServerVersion = task.version;
    artifact.serverStarted = servers.every((owned) => owned.ready);
    assert(!interrupted && !serverFailure, 'Qualification interrupted before command startup');
    const url = `redis://127.0.0.1:${cache.port}/1`;
    const taskUrl = `redis://127.0.0.1:${task.port}/1`;
    const command = launch(args[separator + 1], args.slice(separator + 2), {
        detached: true,
        stdio: 'inherit',
        env: {
            ...process.env,
            CACHE_URL: url,
            TEST_CACHE_URL: url,
            TASK_CACHE_URL: taskUrl,
            TEST_TASK_CACHE_URL: taskUrl,
        },
    });
    caller = command.child;
    callerExit = command.exited;
    void callerExit.then((exit) => {
        artifact.commandExit = exit;
    });
    artifact.callerPid = caller.pid;
    const outcome = await Promise.race([
        callerExit.then((exit) => ({ exit })),
        failureNotice.then((reason) => ({ reason })),
    ]);
    assert(outcome.exit, outcome.reason);
    const exit = outcome.exit;
    artifact.commandExit = exit;
    result = exit.code ?? (exit.signal === 'SIGINT' ? 130 : exit.signal === 'SIGTERM' ? 143 : 1);
    assert(
        !serverFailure && !interrupted,
        'Owned Valkey exited unexpectedly or qualification was interrupted',
    );
    assert(
        !caller.pid || !groupExists(caller.pid),
        'Caller exited with surviving descendants in its original process group',
    );
    artifact.status = result === 0 ? 'passed' : 'failed';
} catch (error) {
    artifact.failure =
        error instanceof Error ? error.message : 'Isolated Valkey qualification failed';
    console.error(`[isolated-valkey] ${artifact.failure}`);
    result = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : 1;
} finally {
    stopping = true;
    // Each cleanup runs even if the previous group's cleanup failed.
    for (const [child, exited, acknowledgment, label] of [
        [caller, callerExit, 'callerGroupStopped', 'Caller'],
        ...servers.map((owned) => [
            owned.child,
            owned.exited,
            `${owned.role}ServerStopped`,
            `${owned.role} Valkey`,
        ]),
    ]) {
        if (!child) continue;
        try {
            await stopOwnedGroup(child, exited, label);
            artifact[acknowledgment] = true;
            if (child === caller) artifact.commandExit = await callerExit;
            const owned = servers.find((entry) => entry.child === child);
            if (owned) {
                const exit = await owned.exited;
                artifact[`${owned.role}ServerExit`] = exit;
                if (child === server) artifact.serverExit = exit;
                assert(
                    result !== 0 || (exit.code === 0 && exit.signal === null),
                    'Valkey did not shut down gracefully for an otherwise passing command',
                );
            }
        } catch (error) {
            (artifact.cleanupFailures ??= []).push(
                error instanceof Error ? error.message : `${label} cleanup failed`,
            );
            result = 1;
        }
    }
    artifact.serverStopped =
        servers.length === 2 && servers.every((owned) => artifact[`${owned.role}ServerStopped`]);
    try {
        if (directory) await rm(directory, { recursive: true, force: true });
    } catch (error) {
        (artifact.cleanupFailures ??= []).push(
            error instanceof Error ? error.message : 'Temporary directory cleanup failed',
        );
        result = 1;
    }
    if (result !== 0) artifact.status = 'failed';
    artifact.finishedAt = new Date().toISOString();
    if (artifactPath) {
        await mkdir(path.dirname(path.resolve(artifactPath)), { recursive: true });
        await writeFile(artifactPath, JSON.stringify(artifact, null, 2) + '\n');
    }
}
process.exitCode = result;
