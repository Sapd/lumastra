// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Bounded process and bundling plumbing shared by actual playback qualifications. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { glob, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import path from 'node:path';
import type { env as processEnvironment } from 'node:process';
import { build, transform, type Plugin } from 'esbuild';
import { compileModule } from 'svelte/compiler';
import type postgres from 'postgres';
export const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));
export interface ManagedChild {
    child: ChildProcess;
    logs: () => string;
    label: string;
    cleaned: boolean;
}

export async function availablePort(): Promise<number> {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address === 'object');
    await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
    );
    return address.port;
}

/** Only this detached child's exact process group is inspected or signalled. */
export async function groupMembers(group: number): Promise<number[]> {
    const members: number[] = [];
    for (const name of await readdir('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        let stat: string;
        try {
            stat = await readFile(`/proc/${name}/stat`, 'utf8');
        } catch {
            continue;
        }
        const fields = stat
            .slice(stat.lastIndexOf(')') + 2)
            .trim()
            .split(/\s+/);
        if (Number(fields[2]) === group) members.push(Number(name));
    }
    return members;
}

export function track(child: ChildProcess, label: string): ManagedChild {
    let output = '';
    for (const stream of [child.stdout, child.stderr])
        stream?.on('data', (chunk: Buffer) => {
            output = (output + chunk.toString()).slice(-32_768);
        });
    child.on('error', (error) => {
        output = (output + error.message).slice(-32_768);
    });
    const managed = { child, logs: () => output, label, cleaned: false };
    child.on('message', (message: unknown) => {
        if (
            message &&
            typeof message === 'object' &&
            'type' in message &&
            message.type === 'cleaned'
        )
            managed.cleaned = true;
    });
    return managed;
}

export async function waitUntil(
    check: () => Promise<boolean>,
    timeoutMs: number,
    description: string,
    guard: () => void = () => {},
): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        guard();
        if (await check()) return;
        await delay(100);
    }
    throw new Error(`Timed out: ${description}`);
}

export async function awaitExit(
    managed: ManagedChild,
    timeoutMs: number,
    guard: () => void = () => {},
): Promise<void> {
    await waitUntil(
        async () => managed.child.exitCode !== null || managed.child.signalCode !== null,
        timeoutMs,
        `${managed.label} exit`,
        guard,
    );
    assert.equal(managed.child.exitCode, 0, `${managed.label} failed: ${managed.logs()}`);
    assert.equal(managed.child.signalCode, null, `${managed.label} was killed`);
    assert(managed.child.pid);
    await waitUntil(
        async () => (await groupMembers(managed.child.pid!)).length === 0,
        5000,
        `${managed.label} descendants reaped`,
        guard,
    );
}

/** Exceptional teardown has finite TERM/KILL escalation and fails qualification. */
export async function cleanupChild(managed: ManagedChild, fixture: boolean): Promise<void> {
    const { child } = managed;
    if (child.exitCode === null && child.signalCode === null) {
        if (fixture && child.connected) child.send({ operation: 'close' });
        else child.kill('SIGTERM');
    }
    try {
        await awaitExit(managed, 20_000);
        if (fixture) assert(managed.cleaned, 'Playback host omitted cleanup acknowledgement');
    } catch (error) {
        if (child.pid && (await groupMembers(child.pid)).length) {
            try {
                process.kill(-child.pid, 'SIGTERM');
            } catch (failure) {
                if (!(failure instanceof Error && 'code' in failure && failure.code === 'ESRCH'))
                    throw failure;
            }
            await delay(1000);
            if ((await groupMembers(child.pid)).length) {
                try {
                    process.kill(-child.pid, 'SIGKILL');
                } catch (failure) {
                    if (!(
                        failure instanceof Error &&
                        'code' in failure &&
                        failure.code === 'ESRCH'
                    ))
                        throw failure;
                }
            }
            await waitUntil(
                async () => (await groupMembers(child.pid!)).length === 0,
                5000,
                'forced owned-group cleanup',
            );
        }
        throw error;
    }
}

/** Same framework virtual modules/raw Lua handling as the standalone build.
 * The only source rewrite is its existing config startup logger/TLA workaround;
 * it changes no config getters, authentication, handlers or media behavior.
 */
export async function bundleHttpHost(
    outfile: string,
    entryPoint = 'src/task-runtime/__fixtures__/playback-http-host.ts',
): Promise<void> {
    const plumbing: Plugin = {
        name: 'playback-fixture-framework-plumbing',
        setup(builder) {
            builder.onResolve({ filter: /\?raw$/ }, (args) => ({
                path: path.resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
                namespace: 'raw-text',
            }));
            builder.onLoad({ filter: /.*/, namespace: 'raw-text' }, async (args) => ({
                contents: await readFile(args.path, 'utf8'),
                loader: 'text',
            }));
            builder.onLoad({ filter: /[/\\]server[/\\]config\.ts$/ }, async (args) => {
                const source = await readFile(args.path, 'utf8');
                const needle = "const { Logger } = await import('./utils/logger.js');";
                assert(
                    source.includes(needle),
                    'Standalone config TLA workaround changed; requalify fixture bundling',
                );
                return {
                    contents: source.replace(
                        needle,
                        'const Logger = { for: () => ({ warn: (message) => console.warn(message) }) };',
                    ),
                    loader: 'ts',
                };
            });
            // Native HLS imports shared capability helpers implemented in rune
            // modules. Compile them for the server exactly as SvelteKit does;
            // plain esbuild TS stripping would leave an undefined `$state`.
            builder.onLoad({ filter: /\.svelte\.[cm]?[jt]s$/ }, async (args) => {
                const source = await readFile(args.path, 'utf8');
                const javascript = args.path.endsWith('.ts')
                    ? (await transform(source, { loader: 'ts', format: 'esm', target: 'esnext' }))
                          .code
                    : source;
                const compiled = compileModule(javascript, {
                    filename: args.path,
                    generate: 'server',
                    dev: false,
                });
                return { contents: compiled.js.code, loader: 'js' };
            });
            // Preserve optional registry loading exactly as the standalone build;
            // leaving import.meta.glob unresolved would silently under-test auth.
            builder.onLoad({ filter: /\.[cm]?[jt]s$/ }, async (args) => {
                let source = await readFile(args.path, 'utf8');
                if (!/import\.meta\.glob\s*\(/.test(source)) return undefined;
                for (const match of [
                    ...source.matchAll(/import\.meta\.glob\(\s*(['"])([^'"]+)\1\s*\)/g),
                ]) {
                    const pattern = match[2];
                    const files: string[] = [];
                    for await (const file of glob(
                        pattern.startsWith('/')
                            ? path.join(process.cwd(), pattern.slice(1))
                            : path.resolve(path.dirname(args.path), pattern),
                    ))
                        files.push(file);
                    const entries = files.sort().map((file) => {
                        const relative = path.relative(process.cwd(), file);
                        assert(
                            !relative.startsWith('..') && !path.isAbsolute(relative),
                            'Fixture glob escapes app',
                        );
                        const key = pattern.startsWith('/')
                            ? '/' + relative.split(path.sep).join('/')
                            : './' +
                              path
                                  .relative(path.dirname(args.path), file)
                                  .split(path.sep)
                                  .join('/');
                        return `${JSON.stringify(key)}: () => import(${JSON.stringify(file)})`;
                    });
                    source = source.replace(match[0], `({${entries.join(',')}})`);
                }
                assert(
                    !/import\.meta\.glob\s*\(/.test(source),
                    'Unsupported fixture registry glob',
                );
                return { contents: source, loader: args.path.endsWith('.ts') ? 'ts' : 'js' };
            });
            builder.onResolve({ filter: /^[^./$]/ }, (args) =>
                args.path.startsWith('@sapd/') ? undefined : { path: args.path, external: true },
            );
        },
    };
    await build({
        entryPoints: [entryPoint],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node24',
        logLevel: 'warning',
        alias: {
            $lib: path.resolve('src/lib'),
            '$app/environment': path.resolve('scripts/task-runtime-stubs/app-environment.js'),
            '$app/paths': path.resolve('scripts/task-runtime-stubs/app-paths.js'),
            '$env/dynamic/private': path.resolve('scripts/task-runtime-stubs/env-private.js'),
            '$env/dynamic/public': path.resolve('scripts/task-runtime-stubs/env-public.js'),
        },
        define: {
            __SANDBOX_APP_BASE__: "''",
            __API_CONTRACT_STRICT__: 'false',
        },
        plugins: [plumbing],
    });
}

/**
 * Workers from `startSdkWorker` also run the real built-in schedule (startup
 * tasks such as fribb-anime-sync or pause-reconcile) against the shared test
 * database. Their accepted jobs can stay queued, so unfinished rows are fenced
 * as cancelled instead of deleted; finished rows are removed so later files
 * (cost ledger totals, handover drain checks) never see these runs.
 */
export async function settleSdkWorkerHistory(sql: postgres.Sql, id: string): Promise<void> {
    const owners = `continuity-${id}-worker-%`;
    await sql`DELETE FROM task_history
        WHERE owner_instance_id LIKE ${owners}
          AND state IN ('completed', 'failed', 'cancelled')`;
    await sql`UPDATE task_history
        SET state = 'cancelled', completed_at = COALESCE(completed_at, clock_timestamp())
        WHERE owner_instance_id LIKE ${owners}
          AND state NOT IN ('completed', 'failed', 'cancelled')`;
}

export async function startSdkWorker(input: {
    boot: number;
    id: string;
    directory: string;
    environment: typeof processEnvironment;
    sql: postgres.Sql;
    guard: () => void;
    taskIds: string[];
    register: (managed: ManagedChild) => void;
}): Promise<{ managed: ManagedChild; port: number }> {
    const { boot, id, directory, environment, sql, guard: hostGuard, taskIds, register } = input;
    hostGuard();
    const taskId = `continuity-${id}-${boot}`;
    const instanceId = `continuity-${id}-worker-${boot}`;
    taskIds.push(taskId);
    const pluginDirectory = path.join(directory, `plugins-${boot}`, taskId);
    await mkdir(pluginDirectory, { recursive: true });
    await writeFile(path.join(pluginDirectory, 'package.json'), JSON.stringify({ type: 'module' }));
    await build({
        stdin: {
            resolveDir: process.cwd(),
            sourcefile: 'continuity-plugin.ts',
            loader: 'ts',
            contents: `import {defineTask} from '@sapd/lumastra-plugin-sdk';import {z} from 'zod';export default defineTask({id:'${taskId}',name:'Continuity SDK fixture',version:'1.0.0',processingVersion:1,minAppVersion:'0.1.0',resourceClass:'io',capabilities:{database:true,cache:true},inputSchema:z.object({}),identityFor:()=> 'global',schedule:{every:'1h',runOnStartup:true},async execute(ctx){await ctx.sql\`SELECT 1\`;if(!ctx.catalog||!ctx.mediaItems||!ctx.mediaFiles||!ctx.userCredentials||!ctx.signal)throw new Error('Missing SDK context');await ctx.cache.set('continuity',{ok:true},60000);if(!(await ctx.cache.get('continuity'))?.ok)throw new Error('Missing SDK cache');ctx.reportProgress(1,1);return {success:true,itemsProcessed:1};}});`,
        },
        outfile: path.join(pluginDirectory, 'index.js'),
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node24',
        logLevel: 'warning',
    });
    const workerPort = await availablePort();
    hostGuard();
    const managed = track(
        spawn(process.execPath, ['build/task-runtime.js'], {
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...environment,
                WORKER_MODE: 'enabled',
                DEDICATED_WORKER: 'true',
                INSTANCE_ID: instanceId,
                HOST: '127.0.0.1',
                PORT: String(workerPort),
                CONFIG_PATH: path.join(directory, `worker-${boot}/settings.json`),
                PLUGINS_EXTERNAL_DIR: path.dirname(pluginDirectory),
            },
        }),
        `task worker ${boot}`,
    );
    register(managed);
    await waitUntil(
        async () => {
            assert(
                managed.child.exitCode === null && managed.child.signalCode === null,
                `Worker boot failed: ${managed.logs()}`,
            );
            const healthy = await fetch(`http://127.0.0.1:${workerPort}/api/health/ready`, {
                signal: AbortSignal.timeout(2000),
            })
                .then((response) => response.status === 200)
                .catch(() => false);
            const rows = await sql<
                {
                    state: string;
                    result: { success?: boolean; itemsProcessed?: number } | null;
                }[]
            >`SELECT state, result FROM task_history WHERE task_id = ${taskId} ORDER BY started_at DESC LIMIT 1`;
            assert(rows[0]?.state !== 'failed', `Actual SDK fixture failed: ${managed.logs()}`);
            return (
                healthy &&
                rows[0]?.state === 'completed' &&
                rows[0]?.result?.success === true &&
                rows[0]?.result?.itemsProcessed === 1
            );
        },
        90_000,
        `worker ${boot} ready with actual SDK result`,
        hostGuard,
    );
    return { managed, port: workerPort };
}
