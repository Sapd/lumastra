// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Worker-thread entry for plugin isolation. esbuild bundles this into a
 * standalone `build/sandbox-entry.js` (see `scripts/build-sandbox.ts`) that
 * `new Worker()` loads in both the web and worker containers (`node build`).
 *
 * Responsibilities (design §4–§8):
 *   1. Read `workerData`; rebuild a REAL `TaskContext` — worker-local
 *      `ctx.sql` / `ctx.http` / `ctx.catalog` / `ctx.mediaItems` /
 *      `ctx.mediaFiles` from this thread's own handles (no RPC), so sql-heavy
 *      plugins run unchanged.
 *   2. Bridge host-owned concerns back over the port: logger/progress/spend
 *      (fire-and-forget) and secrets/settings/cache/reportFailure/
 *      userCredentials (request/reply). The decryption master key never
 *      enters this thread (env scrubbed by the host), so secrets MUST be RPC.
 *   3. Resolve the task from the registry, run `execute(ctx)`, post the
 *      TaskResult or a serialized error.
 *
 * IMPORTANT — module-eval discipline: the heavy task graph (`context-primitives`,
 * `registry`, builtins) is imported DYNAMICALLY inside `main()`, never
 * statically. The app's `config.ts` uses a top-level `await import()`, which
 * esbuild propagates as async module-init across the whole graph; a STATIC
 * import here would surface as a top-level `await init_*()` in the bundle, and
 * node aborts a worker (exit 13, "unsettled top-level await") if such an await
 * is pending while the event loop is otherwise empty. Attaching the port
 * listener synchronously below keeps the loop alive, and dynamic imports keep
 * those awaits inside `main()`'s live promise chain.
 *
 * Import-safe: the bootstrap only runs off the main thread, so importing this
 * module from a test (or accidentally) is a no-op.
 */

import { isBackgroundCpuTask, withBackgroundCpu } from '../background-cpu-scope.js';

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import postgres from 'postgres';
import { primeArrayTypes } from '../../database/prime-array-types.js';
import type {
    CatalogStore,
    CostKind,
    DrainMode,
    DrainResult,
    HttpClient,
    Logger as PluginLogger,
    MediaFilesStore,
    MediaItemsStore,
    TaskContext,
    TaskDefinition,
    TaskResult,
} from '@sapd/lumastra-plugin-sdk';
import { TaskError } from '@sapd/lumastra-plugin-sdk';
import {
    serializeError,
    type MainToWorker,
    type RpcMethod,
    type SandboxWorkerData,
    type WorkerToMain,
} from './protocol.js';

/** Post a message to the host. Narrowed so only protocol messages are sent. */
function post(msg: WorkerToMain): void {
    parentPort?.postMessage(msg);
}

// ── RPC client (worker → host request/reply) ─────────────────────────────────

/**
 * Pending-request bookkeeping for the worker→host RPC (secrets/settings/
 * cache/reportFailure/userCredentials). Factored into a plain function (no
 * module-level singletons) so it is independently unit-testable — see the
 * module header's "Import-safe" note; a main-thread test can call this
 * directly without spinning a real worker thread or touching `parentPort`.
 */
export interface RpcClient {
    /** Issue an RPC. Rejects immediately (no `post`) if `isAborted()` is
     *  already true — a cancelled run must not open new host round-trips. */
    call(method: RpcMethod, ...args: unknown[]): Promise<unknown>;
    /** Route a `rpcResult` reply to its waiter, if still pending. */
    handleReply(msg: MainToWorker): void;
    /** Reject every still-pending call with `reason`. Used on `abort` (so a
     *  plugin `await`ing an RPC observes the cancellation instead of hanging
     *  forever on a promise that can now never otherwise settle) and on
     *  final shutdown. */
    rejectAll(reason: Error): void;
}

export function createRpcClient(
    post: (msg: WorkerToMain) => void,
    isAborted: () => boolean,
): RpcClient {
    let nextCid = 1;
    const pending = new Map<
        number,
        { resolve: (v: unknown) => void; reject: (e: unknown) => void }
    >();

    return {
        call(method, ...args) {
            if (isAborted()) {
                return Promise.reject(new Error('isolation RPC aborted: run cancelled'));
            }
            return new Promise((resolve, reject) => {
                const cid = nextCid++;
                pending.set(cid, { resolve, reject });
                post({ t: 'rpc', cid, method, args });
            });
        },
        handleReply(msg) {
            if (msg.t !== 'rpcResult') return;
            const waiter = pending.get(msg.cid);
            if (!waiter) return;
            pending.delete(msg.cid);
            if (msg.ok) waiter.resolve(msg.value);
            else waiter.reject(new Error(msg.error?.message ?? 'isolation RPC failed'));
        },
        rejectAll(reason) {
            for (const [, waiter] of pending) waiter.reject(reason);
            pending.clear();
        },
    };
}

// ── worker-local AbortController (host relays cancel) ────────────────────────

const abort = new AbortController();
// Soft-deadline controller — flipped by a relayed 'softAbort' (ctx.softSignal).
// Distinct from `abort`: the run is not cancelled, the handler is told to wind down.
const softAbort = new AbortController();

const rpcClient = createRpcClient(post, () => abort.signal.aborted);

function callRpc(method: RpcMethod, ...args: unknown[]): Promise<unknown> {
    return rpcClient.call(method, ...args);
}

// Set once main() builds the worker's Postgres pool. Read by the 'shutdown'
// handshake below so the last-chance pool close still happens even though
// main()'s own try/finally never gets to run when the host later hard-
// terminates this thread (see worker-host.ts `terminate()`).
let workerSql: postgres.Sql | undefined;
let shuttingDown = false;

function handleMainMessage(msg: MainToWorker): void {
    if (msg.t === 'abort') {
        try {
            abort.abort();
        } catch {
            // already aborted
        }
        // A plugin `await`ing secrets/settings/cache/reportFailure/
        // userCredentials when abort arrives could otherwise never observe
        // the cancellation — the reply may never come (host-side work was
        // itself cancelled) — and every such stall used to escalate all the
        // way to a hard terminate(). Reject them now so the plugin's own
        // abort handling (via ctx.signal) can run.
        rpcClient.rejectAll(new Error('isolation RPC aborted: run cancelled'));
        return;
    }
    if (msg.t === 'softAbort') {
        try {
            softAbort.abort();
        } catch {
            // already aborted
        }
        return;
    }
    if (msg.t === 'shutdown') {
        // Last chance before the host hard-terminate()s us. Close the pool
        // under our own control (bounded) rather than letting Node tear the
        // thread down with sockets still open, then self-exit. Idempotent —
        // a second 'shutdown' (or racing with main()'s own settle) is a
        // no-op.
        if (shuttingDown) return;
        shuttingDown = true;
        try {
            abort.abort();
        } catch {
            // already aborted
        }
        rpcClient.rejectAll(new Error('isolation worker shutting down'));
        const closePool = workerSql ? workerSql.end({ timeout: 1 }) : Promise.resolve();
        void closePool
            .catch(() => {
                // best-effort — the thread is exiting either way
            })
            .finally(() => process.exit(1));
        return;
    }
    if (msg.t === 'rpcResult') {
        rpcClient.handleReply(msg);
    }
}

// ── worker-local logger (mirrors host adaptLoggerWithBuffer over the port) ───

function makeLogger(prefix: string): PluginLogger {
    const emit = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta?: object): void => {
        post({
            t: 'log',
            level,
            msg: prefix ? `${prefix} ${msg}` : msg,
            meta: meta as Record<string, unknown> | undefined,
        });
    };
    return {
        debug: (msg, meta) => emit('debug', msg, meta),
        info: (msg, meta) => emit('info', msg, meta),
        warn: (msg, meta) => emit('warn', msg, meta),
        error: (msg, meta) => emit('error', msg, meta),
        child: (bindings) => {
            const tag = Object.entries(bindings)
                .map(([k, v]) => `${k}=${String(v)}`)
                .join(',');
            return makeLogger(prefix ? `${prefix}[${tag}]` : `[${tag}]`);
        },
    };
}

// ── worker-local postgres handle ─────────────────────────────────────────────

/**
 * Build the worker's own bounded Postgres pool from the (scrubbed) env. The
 * connection options mirror `database/connection.ts connectPool` essentials:
 * bigint→Number coercion and a 5-min `statement_timeout` so a wedged query
 * can't pin a connection for the whole stall window. Returns `null` if
 * `DATABASE_URL` is absent so the caller substitutes the throwing stub (same
 * contract as in-process).
 */
// Mirror database/connection.ts `bigintAsNumber` exactly. Declared standalone
// (not inline) so postgres.js's generic `PostgresType<T>` inference resolves
// the same way it does in connection.ts.
const bigintAsNumber = {
    to: 20,
    from: [20],
    parse: (x: string) => Number(x),
    serialize: (x: number) => x.toString(),
};

function buildWorkerSql(poolMax: number): postgres.Sql | null {
    const url = process.env.DATABASE_URL || '';
    if (!url) return null;
    const timezone = process.env.TZ || 'UTC';
    return postgres(url, {
        max: Math.max(1, poolMax),
        idle_timeout: 20,
        connect_timeout: 10,
        types: { bigint: bigintAsNumber },
        // 5-min ceiling so a wedged query can't pin a worker connection for the
        // whole stall window (parity with database/connection.ts). Numeric form
        // matches the postgres typings; the wire value is identical.
        connection: { TimeZone: timezone, statement_timeout: 300_000 },
    }) as unknown as postgres.Sql;
}

// ── ctx assembly ─────────────────────────────────────────────────────────────

/**
 * The worker-local context-primitive builders, loaded dynamically in main().
 * Signatures are declared explicitly (rather than `typeof import(...)`) so the
 * type reference stays erasable — a runtime static import of context-primitives
 * here would reintroduce the config-TLA bundle deadlock the dynamic import in
 * main() exists to avoid. Kept in sync with `../context-primitives.ts`.
 */
interface ContextPrimitives {
    buildHttpClient: (
        logger: PluginLogger,
        defaultSignal?: AbortSignal,
        rateLimit?: undefined,
        allowedDomains?: string[],
    ) => HttpClient;
    buildCatalogStore: (sql: postgres.Sql) => CatalogStore;
    buildMediaItemsStore: (sql: postgres.Sql) => MediaItemsStore;
    buildMediaFilesStore: (sql: postgres.Sql) => MediaFilesStore;
    buildUnavailableSqlStub: () => postgres.Sql;
}

function buildWorkerContext(
    data: SandboxWorkerData,
    sql: postgres.Sql,
    logger: PluginLogger,
    prim: ContextPrimitives,
): TaskContext {
    const caps = data.capabilities;
    const notInWorker = (surface: string): never => {
        throw new TaskError({
            message:
                `ctx.${surface} is not available under worker isolation. Remove ` +
                `isolation:'worker' from this task, or use a supported surface.`,
            kind: 'permanent',
        });
    };

    // Gate the Postgres handle on the declared 'database' capability. Plugins
    // that did not declare it receive the unavailable stub, which throws a clear
    // error on any access — identical to the behaviour when DATABASE_URL is
    // absent (see main()). Plugins that DO declare 'database' continue to
    // receive the live pool handle unchanged.
    const gatedSql = caps.database ? sql : prim.buildUnavailableSqlStub();

    return {
        runId: data.runId,
        parentRunId: data.parentRunId,
        attemptNumber: data.attemptNumber,
        input: data.input,
        scope: data.scope,
        mode: data.mode as TaskContext['mode'],

        sql: gatedSql,
        logger,
        signal: abort.signal,
        abortSignal: abort.signal,
        softSignal: softAbort.signal,

        http: caps.http
            ? prim.buildHttpClient(logger, abort.signal, undefined, caps.allowedDomains)
            : undefined,
        // cache crosses the port (avoids a 2nd native valkey client per worker).
        cache: caps.cache
            ? {
                  get: (key: string) => callRpc('cache.get', key) as Promise<never>,
                  set: (key: string, value: unknown, ttlMs?: number) =>
                      callRpc('cache.set', key, value, ttlMs) as Promise<void>,
                  del: (key: string) => callRpc('cache.del', key) as Promise<void>,
              }
            : undefined,

        dep: (() => notInWorker('dep()')) as unknown as TaskContext['dep'],
        settings: () => callRpc('settings') as Promise<Record<string, unknown>>,
        secrets: {
            get: (key: string) => callRpc('secrets.get', key) as Promise<string>,
            getOptional: (key: string) =>
                callRpc('secrets.getOptional', key) as Promise<string | null>,
            getUser: (userId: string, key: string) =>
                callRpc('secrets.getUser', userId, key) as Promise<string>,
        },
        userCredentials: {
            get: (userId, key) =>
                callRpc('userCredentials.get', userId, key) as Promise<string | null>,
            set: (userId, key, value, opts) =>
                callRpc('userCredentials.set', userId, key, value, opts) as Promise<void>,
            delete: (userId, key) =>
                callRpc('userCredentials.delete', userId, key) as Promise<void>,
            listKeys: (userId) => callRpc('userCredentials.listKeys', userId) as Promise<string[]>,
            listLinkedUsers: () => callRpc('userCredentials.listLinkedUsers') as Promise<string[]>,
            listUsersWithKey: (key) =>
                callRpc('userCredentials.listUsersWithKey', key) as Promise<string[]>,
        },
        catalog: prim.buildCatalogStore(gatedSql),
        mediaItems: prim.buildMediaItemsStore(gatedSql),
        mediaFiles: prim.buildMediaFilesStore(gatedSql),

        reportProgress: (processed: number, total?: number, currentItem?: string) =>
            post({ t: 'progress', processed, total, currentItem }),
        reportFailure: (itemId: string, reason: string, meta?: object) =>
            callRpc('reportFailure', itemId, reason, meta) as Promise<void>,
        reportSuccess: (itemId: string) => callRpc('reportSuccess', itemId) as Promise<void>,
        spend: (kind: CostKind, units: number) => post({ t: 'spend', kind, units }),
        drain: (_opts?: { mode?: DrainMode }): Promise<DrainResult> => notInWorker('drain()'),
    } as TaskContext;
}

// `ctx.ffmpeg` / `ctx.dataDir` are deliberately absent here, matching the
// in-process runner: both were stubs that failed on first use, so they are no
// longer part of the plugin context. A task that needs ffmpeg shells out via
// child_process, which works from a worker thread unchanged.

// ── bootstrap ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const data = workerData as SandboxWorkerData;

    // Heavy graph imported dynamically (see module header). Each resolves once
    // the async module-init chain (rooted at config.ts's top-level await)
    // settles — fast — while the port listener (attached synchronously below)
    // keeps the worker alive.
    const prim = (await import('../context-primitives.js')) as unknown as ContextPrimitives;
    const { registry } = await import('../registry.js');
    const { loadBuiltins } = await import('../builtin/index.js');

    const logger = makeLogger('');
    const realSql = buildWorkerSql(data.dbPoolMax);
    const sql = realSql ?? prim.buildUnavailableSqlStub();
    workerSql = sql;

    try {
        // Fresh pool per worker: the task's first query would otherwise be the
        // pool's first, where an untyped sql.array() is sent as text and fails
        // with 22P02 (see primeArrayTypes).
        if (realSql) await primeArrayTypes(realSql);
        // Populate the registry exactly as the orchestrator boot path does, so
        // `execute` resolves to the same definition the host enqueued.
        await loadBuiltins(registry);
        const task = registry.getTask(data.taskId) as TaskDefinition<unknown, unknown> | undefined;
        if (!task) {
            post({
                t: 'error',
                error: serializeError(
                    new TaskError({
                        message: `Unknown task in worker: ${data.taskId}`,
                        kind: 'permanent',
                    }),
                ),
            });
            return;
        }

        const { setProviderCallSink } = await import('../../utils/provider-calls.js');
        setProviderCallSink((provider, status, retry, at) => {
            post({ t: 'providerCall', provider, status, retry, at });
        });
        const ctx = buildWorkerContext(data, sql, logger, prim);
        const { withApiCallSpend } = await import('../api-call-spend.js');
        const background = isBackgroundCpuTask(task.resourceClass, task.id);
        const result = (await withApiCallSpend(ctx, () =>
            background
                ? withBackgroundCpu(
                      async () => {
                          await callRpc('backgroundCpuCheckpoint');
                      },
                      () => task.execute(ctx),
                  )
                : task.execute(ctx),
        )) as TaskResult<unknown>;

        // Guard result serialization: a plugin returning a non-clonable value
        // (function/class/Response in `result`) would otherwise throw
        // DataCloneError out of postMessage and surface as an opaque worker
        // crash. Convert to a clear permanent failure instead.
        try {
            post({ t: 'done', result });
        } catch (cloneErr) {
            post({
                t: 'error',
                error: serializeError(
                    new TaskError({
                        message: `TaskResult is not serializable across the worker boundary: ${
                            cloneErr instanceof Error ? cloneErr.message : String(cloneErr)
                        }`,
                        kind: 'permanent',
                    }),
                ),
            });
        }
    } catch (err) {
        post({ t: 'error', error: serializeError(err) });
    } finally {
        // Reject any RPCs still in flight so nothing hangs the thread, then
        // close the worker's DB pool gracefully. This runs on EVERY settle of
        // task.execute() — including a plugin that honors `ctx.signal`/
        // `ctx.abortSignal` and throws/returns promptly after `abort` — so the
        // cooperative-cancel path already closes the pool cleanly. The gap
        // this can't cover is a plugin that never settles at all (ignores
        // abort, or is wedged); that path is rescued by the 'shutdown'
        // handshake in `handleMainMessage` above, driven by worker-host.ts's
        // `terminate()` right before its hard `worker.terminate()`.
        rpcClient.rejectAll(new Error('worker shutting down'));
        // When the 'shutdown' handshake (handleMainMessage) already owns this
        // thread's pool close + exit, let it finish rather than racing a
        // second sql.end()/process.exit() in from here, which could cut its
        // bounded close short. (An `if` rather than an early return: a return
        // inside `finally` would swallow any exception propagating from the
        // try block.)
        if (!shuttingDown) {
            try {
                await sql.end({ timeout: 5 });
            } catch {
                // best-effort
            }
            // Self-exit. The terminal message was posted (and flushed during the
            // sql.end round-trip above) before we get here, so the host has it.
            // Without this, the synchronous parentPort listener keeps the thread
            // alive indefinitely and the host would have to hard-terminate() even a
            // cleanly-finished worker — cutting the graceful sql.end() short. In a
            // worker thread, process.exit() ends THIS thread only.
            process.exit(0);
        }
    }
}

if (!isMainThread && parentPort) {
    // Attach the port listener SYNCHRONOUSLY so the worker stays alive while
    // main()'s dynamic imports resolve (see module header).
    parentPort.on('message', handleMainMessage);
    void main();
}
