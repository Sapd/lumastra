// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
    startExecutorProcess as startSupervised,
    type ExecutorProcessOptions,
} from './executor-supervisor.js';

const guardianEntry = path.resolve('build/task-executor-guardian.js');
beforeAll(async () => {
    await access(guardianEntry);
});
const startExecutorProcess = (
    options: ExecutorProcessOptions,
): ReturnType<typeof startSupervised> => startSupervised({ ...options, guardianEntry });

async function waitFor(check: () => Promise<boolean>, timeout = 4000): Promise<void> {
    const until = performance.now() + timeout;
    do {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    } while (performance.now() < until);
    throw new Error('Process condition timed out');
}
async function markerSize(marker: string): Promise<number> {
    try {
        return (await readFile(marker)).length;
    } catch {
        return 0;
    }
}
async function expectMarkerStopped(marker: string): Promise<void> {
    await waitFor(async () => {
        const before = await markerSize(marker);
        await new Promise((resolve) => setTimeout(resolve, 120));
        return before > 0 && (await markerSize(marker)) === before;
    });
}

async function fixture(source: string): Promise<{ entry: string; cleanup(): Promise<void> }> {
    const directory = await mkdtemp(path.join(tmpdir(), 'executor-fixture-'));
    const entry = path.join(directory, 'child.cjs');
    await writeFile(entry, source);
    return { entry, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
const ready = `process.on('message', m => { if(m.type==='initialize') process.send({type:'ready',socketPath:m.directory+'/executor.sock',controlSocketPath:m.directory+'/executor-control.sock'}); });`;

describe('actual executor process supervision', () => {
    it('creates private authenticated initialization and confirms normal child exit', async () => {
        const f = await fixture(`${ready}\nprocess.on('SIGTERM',()=>process.exit(0));`);
        try {
            const child = await startExecutorProcess({ entry: f.entry, env: {} });
            expect(child.secret).toMatch(/^[a-f0-9]{64}$/);
            expect(child.controlSocketPath).toBe(
                path.join(child.directory, 'executor-control.sock'),
            );
            const result = await child.stop();
            expect(result).toEqual({ stopped: true, escalated: false });
            expect(await child.stop()).toBe(result);
            await expect(readFile(child.socketPath)).rejects.toThrow();
        } finally {
            await f.cleanup();
        }
    });
    it('escalates an executor that ignores TERM and proves process exit', async () => {
        const f = await fixture(`${ready}\nprocess.on('SIGTERM',()=>{});`);
        try {
            const child = await startExecutorProcess({
                entry: f.entry,
                env: {},
                stopTimeoutMs: 50,
            });
            expect(await child.stop()).toEqual({ stopped: true, escalated: true });
            expect(() => process.kill(child.pid, 0)).toThrow();
        } finally {
            await f.cleanup();
        }
    });
    it('does not confuse parent exit with termination of an inherited descendant', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'executor-heartbeat-'));
        const marker = path.join(directory, 'heartbeat');
        // Parent deliberately leaves a child alive when TERM arrives. Group
        // supervision must reach it too; PID-only reaping would pass too early.
        const f = await fixture(`const {spawn}=require('node:child_process');
          const script = "const fs=require('node:fs');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),10);process.on('SIGTERM',()=>{});";
          const child=spawn(process.execPath,['-e',script,process.env.LUMASTRA_MARKER],{stdio:'ignore'});
          ${ready}
          process.on('SIGTERM',()=>process.exit(0));`);
        try {
            const child = await startExecutorProcess({
                entry: f.entry,
                env: { LUMASTRA_MARKER: marker },
                stopTimeoutMs: 80,
                killTimeoutMs: 500,
            });
            // The descendant's first write is the readiness boundary; process
            // launch can exceed 100ms on a loaded qualification runner.
            await waitFor(async () => (await markerSize(marker)) > 0);
            const before = (await readFile(marker)).length;
            expect(before).toBeGreaterThan(0);
            const result = await child.stop();
            expect(result.escalated).toBe(true);
            // An unreaped orphan zombie can keep killpg(0) observable. Such a
            // platform reports unconfirmed stop; it may never authorize handoff.
            const after = (await readFile(marker)).length;
            await new Promise((resolve) => setTimeout(resolve, 80));
            expect((await readFile(marker)).length).toBe(after);
            expect(typeof result.stopped).toBe('boolean');
        } finally {
            await f.cleanup();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('automatically kills inherited descendants after unexpected executor exit', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'executor-crash-'));
        const marker = path.join(directory, 'heartbeat');
        const f = await fixture(`const {spawn}=require('node:child_process');
          const script = "const fs=require('node:fs');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),10);process.on('SIGTERM',()=>{});";
          spawn(process.execPath,['-e',script,process.env.LUMASTRA_MARKER],{stdio:'ignore'});
          ${ready}
          setTimeout(()=>process.exit(1),300);`);
        let child: Awaited<ReturnType<typeof startExecutorProcess>> | undefined;
        try {
            child = await startExecutorProcess({
                entry: f.entry,
                env: { LUMASTRA_MARKER: marker },
                killTimeoutMs: 500,
            });
            await waitFor(async () => (await markerSize(marker)) > 0);
            await new Promise((resolve) => setTimeout(resolve, 400));
            // No explicit stop() precedes this assertion. The guardian must act
            // on executor exit without a controller remembering to clean up.
            await expectMarkerStopped(marker);
        } finally {
            await child?.stop();
            await f.cleanup();
            await rm(directory, { recursive: true, force: true });
        }
    });
    it('kills a CPU-blocked executor and its descendant when the controller dies', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'executor-controller-loss-'));
        const marker = path.join(directory, 'heartbeat');
        const f = await fixture(`const {spawn}=require('node:child_process');
          const script = "const fs=require('node:fs');setInterval(()=>fs.appendFileSync(process.argv[1],'x'),10);process.on('SIGTERM',()=>{});";
          spawn(process.execPath,['-e',script,process.env.LUMASTRA_MARKER],{stdio:'ignore'});
          process.on('message', m => {
            if(m.type==='initialize') process.send({type:'ready',socketPath:m.directory+'/executor.sock',controlSocketPath:m.directory+'/executor-control.sock'},()=>{while(true){}});
          });`);
        const controllerEntry = path.join(directory, 'controller.mjs');
        await writeFile(
            controllerEntry,
            `import {startExecutorProcess} from ${JSON.stringify(pathToFileURL(path.resolve('src/task-runtime/executor-supervisor.ts')).href)};
          const child=await startExecutorProcess({entry:${JSON.stringify(f.entry)},guardianEntry:${JSON.stringify(guardianEntry)},env:{LUMASTRA_MARKER:${JSON.stringify(marker)}},killTimeoutMs:500});
          process.send({pid:child.pid});`,
        );
        const controller = spawn(process.execPath, ['--import', 'tsx', controllerEntry], {
            env: {},
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
        let pid: number | undefined;
        try {
            pid = await new Promise<number>((resolve, reject) => {
                const timer = setTimeout(
                    () => reject(new Error('Nested controller never ready')),
                    8000,
                );
                controller.once('message', (value: unknown) => {
                    clearTimeout(timer);
                    if (
                        typeof value === 'object' &&
                        value !== null &&
                        'pid' in value &&
                        typeof value.pid === 'number'
                    )
                        resolve(value.pid);
                    else reject(new Error('Invalid nested controller readiness'));
                });
                controller.once('error', reject);
                controller.once('exit', () => {
                    clearTimeout(timer);
                    reject(new Error('Nested controller exited before readiness'));
                });
            });
            await waitFor(async () => (await markerSize(marker)) > 2);
            // SIGKILL prevents the controller from running any cleanup. The
            // executor is busy-looping, so its IPC-disconnect callback cannot run.
            controller.kill('SIGKILL');
            await expectMarkerStopped(marker);
            // The group may retain zombies on a host without an init reaper;
            // this cannot authorize handoff, but no member may continue work.
            await waitFor(async () => {
                try {
                    process.kill(pid!, 0);
                    return false;
                } catch {
                    return true;
                }
            });
        } finally {
            if (controller.exitCode === null && controller.signalCode === null)
                controller.kill('SIGKILL');
            await f.cleanup();
            await rm(directory, { recursive: true, force: true });
        }
    });
    it('replaces an unknown stop with later confirmed teardown without resending kills', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'executor-late-stop-'));
        const attempts = path.join(directory, 'kill-attempts');
        const guardianFixture = path.join(directory, 'guardian.mjs');
        await writeFile(
            guardianFixture,
            `import {runExecutorGuardian} from ${JSON.stringify(pathToFileURL(guardianEntry).href)};
          import fs from 'node:fs';
          let attempts=0;
          runExecutorGuardian({sendSignal:(pid,signal)=>{
            if(signal==='SIGKILL') {
              fs.appendFileSync(${JSON.stringify(attempts)},'kill\\n');
              if(++attempts<=3) throw Object.assign(new Error('injected temporary signal failure'),{code:'EPERM'});
            }
            return process.kill(pid,signal);
          }});`,
        );
        const f = await fixture(`${ready}\nprocess.on('SIGTERM',()=>{});`);
        let child: Awaited<ReturnType<typeof startSupervised>> | undefined;
        try {
            child = await startSupervised({
                entry: f.entry,
                guardianEntry: guardianFixture,
                env: {},
                stopTimeoutMs: 20,
                killTimeoutMs: 20,
            });
            expect(await child.stop()).toEqual({ stopped: false, escalated: true });
            // The controller stays connected after the unknown receipt. A
            // guardian retry must terminate the actual process, then publish
            // positive evidence and clean up without requiring parent loss.
            const executor = child;
            await waitFor(async () => (await executor.stop()).stopped);
            await waitFor(async () => {
                try {
                    await access(executor.directory);
                    return false;
                } catch {
                    return true;
                }
            });
            const count = (await readFile(attempts, 'utf8')).trim().split('\n').length;
            expect(count).toBe(4);
            expect(await child.stop()).toEqual({ stopped: true, escalated: true });
            await new Promise((resolve) => setTimeout(resolve, 150));
            expect((await readFile(attempts, 'utf8')).trim().split('\n')).toHaveLength(count);
        } finally {
            await child?.stop();
            await f.cleanup();
            await rm(directory, { recursive: true, force: true });
        }
    });
    it('rejects readiness outside its private directory and reaps startup failure', async () => {
        const f = await fixture(
            `process.on('message',()=>process.send({type:'ready',socketPath:'/tmp/foreign.sock'}));`,
        );
        try {
            await expect(
                startExecutorProcess({ entry: f.entry, env: {}, stopTimeoutMs: 100 }),
            ).rejects.toThrow('invalid socket');
        } finally {
            await f.cleanup();
        }
    });
    it('rejects a control socket outside its private directory', async () => {
        const f = await fixture(
            `process.on('message',m=>process.send({type:'ready',socketPath:m.directory+'/executor.sock',controlSocketPath:'/tmp/foreign-control.sock'}));`,
        );
        try {
            await expect(
                startExecutorProcess({ entry: f.entry, env: {}, stopTimeoutMs: 100 }),
            ).rejects.toThrow('invalid control socket');
        } finally {
            await f.cleanup();
        }
    });
    it('times out a child that never becomes ready and terminates it', async () => {
        const f = await fixture(`setInterval(()=>{},1000);process.on('SIGTERM',()=>{});`);
        try {
            await expect(
                startExecutorProcess({
                    entry: f.entry,
                    env: {},
                    startupTimeoutMs: 50,
                    stopTimeoutMs: 50,
                }),
            ).rejects.toThrow('startup timed out');
        } finally {
            await f.cleanup();
        }
    });

    it('passes only allowlisted environment variables to the executor', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'executor-env-'));
        const out = path.join(directory, 'env.json');
        const f = await fixture(`const fs=require('node:fs');
          process.on('message', m => { if(m.type==='initialize'){
            fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env));
            process.send({type:'ready',socketPath:m.directory+'/executor.sock'}); }});
          process.on('SIGTERM',()=>process.exit(0));`);
        try {
            const child = await startExecutorProcess({
                entry: f.entry,
                env: {
                    PATH: process.env.PATH,
                    DATABASE_URL: 'postgres://x',
                    SETUP_UNLOCK: 'secret-token',
                    LUMASTRA_METRICS_BEARER_TOKEN: 'metrics-secret',
                    JWT_SECRET: 'jwt-secret',
                    AUTH_OIDC_CLIENT_SECRET: 'oidc-secret',
                    INSTANCE_ID: 'instance-1',
                    FFMPEG_PATH: '/usr/bin/ffmpeg',
                    TMDB_LANGUAGE: 'de',
                    ORIGIN: 'https://example.test',
                    SOME_RANDOM_SECRET: 'nope',
                    LUMASTRA_OK: 'yes',
                },
            });
            const seen = JSON.parse(await readFile(out, 'utf8')) as Record<string, string>;
            expect(seen.DATABASE_URL).toBe('postgres://x');
            expect(seen.LUMASTRA_OK).toBe('yes');
            expect(seen.INSTANCE_ID).toBe('instance-1');
            expect(seen.FFMPEG_PATH).toBe('/usr/bin/ffmpeg');
            expect(seen.TMDB_LANGUAGE).toBe('de');
            expect(seen.LUMASTRA_METRICS_BEARER_TOKEN).toBeUndefined();
            expect(seen.JWT_SECRET).toBeUndefined();
            expect(seen.AUTH_OIDC_CLIENT_SECRET).toBeUndefined();
            expect(seen.SETUP_UNLOCK).toBeUndefined();
            expect(seen.ORIGIN).toBeUndefined();
            expect(seen.SOME_RANDOM_SECRET).toBeUndefined();
            await child.stop();
        } finally {
            await f.cleanup();
            await rm(directory, { recursive: true, force: true });
        }
    });
    it('reports exit code, signal and a bounded stderr tail on abnormal startup exit', async () => {
        const f = await fixture(
            `process.stderr.write('x'.repeat(20000) + 'BOOM-TAIL');process.on('message',()=>process.exit(3));`,
        );
        try {
            const error = await startExecutorProcess({ entry: f.entry, env: {} }).catch(
                (e: unknown) => e as Error,
            );
            expect(error).toBeInstanceOf(Error);
            const message = (error as Error).message;
            expect(message).toContain('code 3');
            expect(message).toContain('BOOM-TAIL');
            expect(message.length).toBeLessThan(9 * 1024);
        } finally {
            await f.cleanup();
        }
    });
    it('removes the socket directory when the guardian reports a late confirmed stop', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'executor-fake-guardian-'));
        const guardianFixture = path.join(directory, 'guardian.cjs');
        await writeFile(
            guardianFixture,
            `process.on('message', m => {
              if (m.type==='initialize_guardian')
                process.send({type:'ready',pid:process.pid,socketPath:m.initialization.directory+'/executor.sock'});
              if (m.type==='stop') setTimeout(()=>process.send({type:'stopped',stopped:true,escalated:false},()=>process.exit(0)),1500);
            });`,
        );
        const f = await fixture('');
        try {
            const child = await startSupervised({
                entry: f.entry,
                guardianEntry: guardianFixture,
                env: {},
                stopTimeoutMs: 10,
                killTimeoutMs: 10,
            });
            await access(child.directory);
            expect(await child.stop()).toEqual({ stopped: false, escalated: true });
            // The unknown receipt must not leak the directory once teardown is proven.
            await waitFor(async () => {
                try {
                    await access(child.directory);
                    return false;
                } catch {
                    return true;
                }
            }, 4000);
        } finally {
            await f.cleanup();
            await rm(directory, { recursive: true, force: true });
        }
    });
    it('removes the socket directory when stop is confirmed without guardian cleanup', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'executor-fake-guardian-'));
        const guardianFixture = path.join(directory, 'guardian.cjs');
        await writeFile(
            guardianFixture,
            `process.on('message', m => {
              if (m.type==='initialize_guardian')
                process.send({type:'ready',pid:process.pid,socketPath:m.initialization.directory+'/executor.sock'});
              if (m.type==='stop') process.send({type:'stopped',stopped:true,escalated:false},()=>process.exit(0));
            });`,
        );
        const f = await fixture('');
        try {
            const child = await startSupervised({
                entry: f.entry,
                guardianEntry: guardianFixture,
                env: {},
            });
            expect(await child.stop()).toEqual({ stopped: true, escalated: false });
            await expect(access(child.directory)).rejects.toThrow();
        } finally {
            await f.cleanup();
            await rm(directory, { recursive: true, force: true });
        }
    });
    it('starts and cleans up with a custom TMPDIR the guardian environment does not have', async () => {
        const base = await mkdtemp(path.join(tmpdir(), 'executor-tmpbase-'));
        const previous = process.env.TMPDIR;
        process.env.TMPDIR = base;
        const f = await fixture(`${ready}\nprocess.on('SIGTERM',()=>process.exit(0));`);
        try {
            const child = await startExecutorProcess({ entry: f.entry, env: {} });
            expect(path.dirname(child.directory)).toBe(path.resolve(base));
            expect(await child.stop()).toEqual({ stopped: true, escalated: false });
            await expect(access(child.directory)).rejects.toThrow();
        } finally {
            if (previous === undefined) delete process.env.TMPDIR;
            else process.env.TMPDIR = previous;
            await f.cleanup();
            await rm(base, { recursive: true, force: true });
        }
    });
});
