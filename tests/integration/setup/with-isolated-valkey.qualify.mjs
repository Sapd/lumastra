// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Opt-in Linux controls: node --test tests/integration/setup/with-isolated-valkey.qualify.mjs */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

const wrapper = fileURLToPath(new URL('./with-isolated-valkey.mjs', import.meta.url));
const binary = process.env.LUMASTRA_TEST_VALKEY_BINARY;
assert.equal(platform(), 'linux', 'Qualification requires Linux owned-process evidence');
assert(
    binary && path.isAbsolute(binary),
    'An absolute LUMASTRA_TEST_VALKEY_BINARY is required; qualification never skips',
);
assert(
    process.env.TEST_DATABASE_URL,
    'Explicit qualification requires the runner TEST_DATABASE_URL',
);
const sha256 = async (file) =>
    createHash('sha256')
        .update(await readFile(file))
        .digest('hex');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sqlHash = createHash('sha256').update(process.env.TEST_DATABASE_URL).digest('hex');
const evidence = { sourceSha256: await sha256(new URL(import.meta.url)), cases: [] };
after(async () => {
    await mkdir('build/native-validation', { recursive: true });
    await writeFile(
        'build/native-validation/isolated-valkey-controls.json',
        JSON.stringify(evidence, null, 2) + '\n',
    );
});

function groupExists(pid) {
    try {
        process.kill(-pid, 0);
        return true;
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
        throw error;
    }
}

function signalGroup(pid, signal) {
    try {
        process.kill(-pid, signal);
    } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
}

async function waitUntil(check, ms, message) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (await check()) return;
        await delay(50);
    }
    throw new Error(message);
}

const callerSource = `
import Redis from 'ioredis';
import {writeFile,access,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const options={connectTimeout:1000,commandTimeout:1000,maxRetriesPerRequest:0,retryStrategy:()=>null};
const client = new Redis(process.env.CACHE_URL, options);
const taskClient = new Redis(process.env.TASK_CACHE_URL, options);
taskClient.on('error',()=>{});
client.on('error',()=>{});
try {
 const info=await client.info('server');
 const taskInfo=await taskClient.info('server');
 const taskServerPid=Number(/^process_id:(\\d+)\\r?$/m.exec(taskInfo)?.[1]);
 const policies={cache:(await client.config('GET','maxmemory-policy'))[1],task:(await taskClient.config('GET','maxmemory-policy'))[1]};
 const state={callerPid:process.pid,serverPid:Number(/^process_id:(\\d+)\\r?$/m.exec(info)?.[1]),version:/^valkey_version:([^\\r\\n]+)\\r?$/m.exec(info)?.[1],dbsize:await client.dbsize(),dbOne:new URL(process.env.CACHE_URL).pathname==='/1',taskServerPid,policies,taskDbSize:await taskClient.dbsize(),cacheUrlsEqual:process.env.TEST_CACHE_URL===process.env.CACHE_URL,taskUrlsEqual:process.env.TEST_TASK_CACHE_URL===process.env.TASK_CACHE_URL,distinctEndpoints:new URL(process.env.CACHE_URL).port!==new URL(process.env.TASK_CACHE_URL).port,sqlPreserved:createHash('sha256').update(process.env.TEST_DATABASE_URL??'').digest('hex')===process.env.QUALIFY_EXPECTED_SQL_SHA256};
 await client.set('qualification-owned-key','1');
 if(process.env.QUALIFY_MODE==='interrupt'||process.env.QUALIFY_MODE.endsWith('server-death'))process.on('SIGTERM',()=>{});
 await writeFile(process.env.QUALIFY_CONTROL+'.tmp',JSON.stringify(state));
 await rename(process.env.QUALIFY_CONTROL+'.tmp',process.env.QUALIFY_CONTROL);
} finally {client.disconnect();taskClient.disconnect();}
const deadline=Date.now()+10000;
while(true){try{await access(process.env.QUALIFY_RELEASE);break;}catch{if(Date.now()>deadline)throw new Error('Control driver did not acknowledge readiness');await new Promise(resolve=>setTimeout(resolve,25));}}
if(process.env.QUALIFY_MODE==='interrupt'||process.env.QUALIFY_MODE.endsWith('server-death'))setInterval(()=>{},1000);
else process.exitCode=process.env.QUALIFY_MODE==='exit-seven'?7:0;
`;

for (const mode of ['normal', 'exit-seven', 'interrupt', 'server-death', 'task-server-death']) {
    test(`isolated Valkey: ${mode}`, { timeout: 45_000 }, async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'isolated-valkey-controls-'));
        const control = path.join(directory, 'control.json');
        const release = path.join(directory, 'release');
        const artifactPath = path.join(directory, 'artifact.json');
        const ownedGroups = new Set();
        const caseEvidence = { mode, status: 'failed' };
        const errors = [];
        const recordCleanupFailure = (error, fallback) => {
            errors.push(error);
            caseEvidence.status = 'failed';
            (caseEvidence.cleanupFailures ??= []).push(
                error instanceof Error ? error.message : fallback,
            );
        };
        evidence.cases.push(caseEvidence);
        let child, exited, exit, state;
        const startedAt = Date.now();
        const captureChildren = async () => {
            if (!child?.pid) return;
            try {
                const children = await readFile(
                    `/proc/${child.pid}/task/${child.pid}/children`,
                    'utf8',
                );
                for (const pid of children.trim().split(/\s+/).filter(Boolean))
                    ownedGroups.add(Number(pid));
            } catch (error) {
                if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                    throw error;
            }
        };
        try {
            child = spawn(
                process.execPath,
                [
                    wrapper,
                    '--artifact',
                    artifactPath,
                    '--',
                    process.execPath,
                    '--input-type=module',
                    '-e',
                    callerSource,
                ],
                {
                    detached: true,
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: {
                        ...process.env,
                        QUALIFY_MODE: mode,
                        QUALIFY_CONTROL: control,
                        QUALIFY_RELEASE: release,
                        QUALIFY_EXPECTED_SQL_SHA256: sqlHash,
                    },
                },
            );
            assert(child.pid);
            ownedGroups.add(child.pid);
            // Consume output, without retaining credentials from an unexpected diagnostic.
            child.stdout.resume();
            child.stderr.resume();
            exited = new Promise((resolve, reject) => {
                child.once('error', reject);
                child.once('close', (code, signal) => {
                    exit = { code, signal };
                    resolve();
                });
            });
            await waitUntil(
                async () => {
                    await captureChildren();
                    try {
                        state = JSON.parse(await readFile(control, 'utf8'));
                        return true;
                    } catch (error) {
                        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
                            return false;
                        throw error;
                    }
                },
                10_000,
                'Caller did not publish its private readiness control',
            );
            await captureChildren();
            assert(
                ownedGroups.has(state.callerPid),
                'Caller PID is not an observed direct child of the owned wrapper',
            );
            assert(
                ownedGroups.has(state.serverPid),
                'Valkey PID is not an observed direct child of the owned wrapper',
            );
            await writeFile(release, 'go');
            assert.equal(state.dbsize, 0);
            assert.equal(state.dbOne, true);
            assert.equal(state.cacheUrlsEqual, true);
            assert.equal(state.taskUrlsEqual, true);
            assert.equal(state.distinctEndpoints, true);
            assert.equal(state.taskDbSize, 0);
            assert.notEqual(state.serverPid, state.taskServerPid);
            assert(
                ownedGroups.has(state.taskServerPid),
                'Task server must be an owned direct child',
            );
            assert.deepEqual(state.policies, { cache: 'allkeys-lru', task: 'noeviction' });
            assert.equal(state.sqlPreserved, true);
            assert.match(state.version, /^\d+\.\d+\.\d+/);
            if (mode === 'interrupt') child.kill('SIGTERM');
            if (mode === 'server-death') signalGroup(state.serverPid, 'SIGKILL');
            if (mode === 'task-server-death') signalGroup(state.taskServerPid, 'SIGKILL');
            await waitUntil(
                async () => exit !== undefined,
                20_000,
                'Wrapper did not exit within its bounded cleanup interval',
            );
            await exited;
            assert.equal(exit.signal, null);
            assert.equal(
                exit.code,
                mode === 'normal' ? 0 : mode === 'exit-seven' ? 7 : mode === 'interrupt' ? 143 : 1,
            );
            assert(
                Date.now() - startedAt < 30_000,
                'Wrapper completion exceeded the control budget',
            );
            const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
            caseEvidence.wrapperArtifact = artifact;
            caseEvidence.observations = state;
            assert.equal(artifact.status, mode === 'normal' ? 'passed' : 'failed');
            assert.equal(artifact.serverStarted, true);
            assert.equal(artifact.serverStopped, true);
            assert.equal(artifact.taskServerStopped, true);
            assert.equal(artifact.cacheServerStopped, true);
            assert.equal(artifact.taskServerPid, state.taskServerPid);
            assert.equal(artifact.taskServerExit.code, mode === 'task-server-death' ? null : 0);
            assert.equal(
                artifact.taskServerExit.signal,
                mode === 'task-server-death' ? 'SIGKILL' : null,
            );
            assert.equal(artifact.callerGroupStopped, true);
            assert.equal(artifact.serverPid, state.serverPid);
            assert.equal(artifact.callerPid, state.callerPid);
            assert.equal(artifact.serverVersion, state.version);
            assert.equal(artifact.serverExit.code, mode === 'server-death' ? null : 0);
            assert.equal(artifact.serverExit.signal, mode === 'server-death' ? 'SIGKILL' : null);
            assert.equal(artifact.binarySha256, await sha256(binary));
            assert.equal(artifact.sourceSha256, await sha256(wrapper));
            assert.equal(
                artifact.commandExit.code,
                mode === 'normal' ? 0 : mode === 'exit-seven' ? 7 : null,
            );
            if (mode === 'interrupt' || mode.endsWith('server-death'))
                assert.equal(artifact.commandExit.signal, 'SIGKILL');
            for (const pid of ownedGroups)
                assert.equal(groupExists(pid), false, `Owned process group ${pid} survived`);
            caseEvidence.status = 'passed';
        } catch (error) {
            errors.push(error);
            caseEvidence.failure =
                error instanceof Error ? error.message : 'Qualification control failed';
        } finally {
            // Regression cleanup: exact observed wrapper/direct-child groups only.
            // Detached descendants that escaped those groups remain outside this control.
            try {
                await captureChildren();
                for (const pid of ownedGroups) if (groupExists(pid)) signalGroup(pid, 'SIGTERM');
                const deadline = Date.now() + 1500;
                while ([...ownedGroups].some(groupExists) && Date.now() < deadline) await delay(50);
                for (const pid of ownedGroups) if (groupExists(pid)) signalGroup(pid, 'SIGKILL');
                await waitUntil(
                    async () => [...ownedGroups].every((pid) => !groupExists(pid)),
                    5000,
                    'Control could not reap its owned groups',
                );
                if (exited)
                    await waitUntil(
                        async () => exit !== undefined,
                        1000,
                        'Wrapper close event was not reaped',
                    );
            } catch (error) {
                recordCleanupFailure(error, 'Control cleanup failed');
            }
            if (!caseEvidence.wrapperArtifact) {
                try {
                    caseEvidence.wrapperArtifact = JSON.parse(await readFile(artifactPath, 'utf8'));
                } catch (error) {
                    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
                        recordCleanupFailure(error, 'Wrapper artifact collection failed');
                }
            }
            try {
                await rm(directory, { recursive: true, force: true });
            } catch (error) {
                recordCleanupFailure(error, 'Private control directory cleanup failed');
            }
        }
        if (errors.length)
            throw new AggregateError(errors, `Isolated Valkey ${mode} control failed`);
    });
}
