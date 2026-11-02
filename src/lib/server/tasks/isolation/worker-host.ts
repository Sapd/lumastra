// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Main-thread host for worker-thread plugin isolation.
 *
 * Spawns a `node:worker_threads` Worker that runs `execute(ctx)` (see
 * `sandbox-entry.ts`), services the narrow RPC the worker makes for
 * host-owned concerns (secrets/settings/cache/reportFailure/userCredentials),
 * relays fire-and-forget log/progress/spend into the runner's existing sinks,
 * relays cancellation, and owns `terminate()` so the runner's wall-clock /
 * stall watchdogs can hard-kill a wedged thread.
 *
 * The host is intentionally decoupled from the SDK `TaskContext` shape: the
 * caller passes an {@link IsolationHostHooks} adapter built from the ctx the
 * runner already constructed, so secrets/cost/progress/log all reuse the
 * in-process code paths (no duplicated business logic) and the module is
 * trivially unit-testable with a fake worker + fake hooks.
 */

import { ProviderCallProviderSchema } from '$lib/schemas/provider-calls.js';
import { recordProviderCall, recordProviderRetry } from '../../utils/provider-calls.js';
import { TaskError, type CostKind } from '@sapd/lumastra-plugin-sdk';
import {
    serializeError,
    type MainToWorker,
    type RpcMethod,
    type SandboxWorkerData,
    type SerializedError,
    type WorkerToMain,
} from './protocol.js';
import { ISOLATION_WORKER_ENV_MARKER } from './isolation-context.js';
import { trackThreadHeap, type ThreadHeapSource } from '../../services/memory-breakdown-log.js';

/** Minimal Worker contract — lets tests inject a fake (no real thread). */
export interface IsolationWorkerLike extends ThreadHeapSource {
    postMessage(msg: MainToWorker): void;
    terminate(): Promise<number> | void;
    on(event: 'message', cb: (msg: WorkerToMain) => void): unknown;
    on(event: 'error', cb: (err: Error) => void): unknown;
    on(event: 'exit', cb: (code: number) => void): unknown;
    off?(event: string, cb: (...args: never[]) => void): unknown;
    once(event: 'exit', cb: (code: number) => void): unknown;
}

/**
 * Factory for the worker. Production wires this to `node:worker_threads`;
 * tests inject a fake. `env` is the SCRUBBED process env (master key removed —
 * see `buildIsolationEnv`).
 */
export type SpawnIsolationWorker = (
    entryPath: string,
    workerData: SandboxWorkerData,
    env: Record<string, string | undefined>,
) => IsolationWorkerLike;

/**
 * Host-owned ctx surface the worker reaches over RPC, plus the fire-and-forget
 * sinks. Built by the runner from the in-process `ctx` so every call lands on
 * the same secrets store / cost ledger / progress tracker / log buffer.
 */
export interface IsolationHostHooks {
    backgroundCpuCheckpoint?(): Promise<void>;
    // request/reply (worker awaits)
    secretsGet(key: string): Promise<string>;
    secretsGetOptional(key: string): Promise<string | null>;
    secretsGetUser(userId: string, key: string): Promise<string>;
    settings(): Promise<Record<string, unknown>>;
    cacheGet(key: string): Promise<unknown>;
    cacheSet(key: string, value: unknown, ttlMs?: number): Promise<void>;
    cacheDel(key: string): Promise<void>;
    reportFailure(itemId: string, reason: string, meta?: object): Promise<void>;
    reportSuccess(itemId: string): Promise<void>;
    ucGet(userId: string, key: string): Promise<string | null>;
    ucSet(
        userId: string,
        key: string,
        value: string,
        opts?: { expiresAt?: Date; ifKeyExists?: string },
    ): Promise<void>;
    ucDelete(userId: string, key: string): Promise<void>;
    ucListKeys(userId: string): Promise<string[]>;
    ucListLinkedUsers(): Promise<string[]>;
    ucListUsersWithKey(key: string): Promise<string[]>;
    // fire-and-forget sinks (no reply)
    log(
        level: 'debug' | 'info' | 'warn' | 'error',
        msg: string,
        meta?: Record<string, unknown>,
    ): void;
    progress(processed: number, total?: number, currentItem?: string): void;
    spend(kind: CostKind, units: number): void;
    /** Diagnostics for host-side anomalies (RPC failures, worker errors). */
    warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface ExecuteInWorkerParams {
    entryPath: string;
    workerData: SandboxWorkerData;
    /** Scrubbed env handed to the worker (no LUMASTRA_MASTER_KEY / KDF salt). */
    env: Record<string, string | undefined>;
    hooks: IsolationHostHooks;
    /** Runner's AbortController signal — relayed to the worker as `abort`. */
    signal: AbortSignal;
    /** Runner's SOFT-deadline signal — relayed to the worker as `softAbort`
     *  (becomes ctx.softSignal there). Optional; absent → no soft signal in the
     *  worker (it runs to the hard cap, as before). */
    softSignal?: AbortSignal;
    spawn: SpawnIsolationWorker;
}

/** Handle returned to the runner so a watchdog can hard-kill the run. */
export interface IsolationRun {
    /** Resolves with the plugin's TaskResult, or rejects with a rehydrated error. */
    readonly result: Promise<unknown>;
    /**
     * Ask the worker to stop, then hard-`terminate()` after `graceMs` if it
     * hasn't exited. Idempotent. Called by `autoFailRun` on watchdog timeout /
     * stall, and best-effort on normal settle to free the thread + DB pool.
     *
     * If the worker still hasn't exited after `graceMs`, a `shutdown` message
     * is sent (last chance for the sandbox to close its DB pool) and the hard
     * `worker.terminate()` is delayed by `shutdownGraceMs` (default
     * {@link SANDBOX_SHUTDOWN_GRACE_MS}) to give it a bounded window to act.
     * The optional param exists so tests can shrink this window; production
     * callers pass only `graceMs`.
     */
    terminate(graceMs: number, shutdownGraceMs?: number): Promise<void>;
}

/**
 * Bounded window given to a wedged worker's `shutdown` message (see
 * `protocol.ts` `MsgShutdown`) to close its worker-local Postgres pool before
 * `terminate()` falls through to the hard `worker.terminate()`. Node offers
 * no pre-terminate hook, so this is the sandbox's last chance to run
 * `sql.end()` under its own control rather than having pool sockets die
 * uncontrolled when the thread is torn down.
 */
export const SANDBOX_SHUTDOWN_GRACE_MS = 1500;

/**
 * Build the scrubbed env for an isolated worker.
 *
 * SECURITY BOUNDARY (design §7): the worker must never be able to decrypt
 * `plugin_secrets` rows. It legitimately needs `DATABASE_URL` / `CACHE_URL`
 * for its worker-local `ctx.sql` / `ctx.http`, but the AES-GCM master key
 * (`LUMASTRA_MASTER_KEY`) and its KDF salt (`LUMASTRA_KDF_SALT`) are removed, so
 * the ciphertext it can read is structurally useless. Decrypted secret values
 * reach the worker only per-call, via RPC, from the main thread.
 *
 * It also sets {@link ISOLATION_WORKER_ENV_MARKER}, so code inside the worker can
 * tell it is isolated (`isIsolationWorker()`) and REFUSE to resolve a master
 * key. Removing the env key alone was not enough: `resolveMasterKey()` then fell
 * through to `<config>/master.key` — reading it (boundary defeated) or, when it
 * did not exist yet, generating a second key next to the operator's env key
 * (Windows new-user e2e 2026-09-27, B1).
 */
export function buildIsolationEnv(
    base: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = { ...base };
    delete out.LUMASTRA_MASTER_KEY;
    delete out.LUMASTRA_KDF_SALT;
    out[ISOLATION_WORKER_ENV_MARKER] = '1';
    return out;
}

/**
 * Rehydrate a {@link SerializedError} back into something the runner's
 * existing `catch` block handles identically to an in-process throw.
 *
 * - `TaskError` → reconstructed with its authoritative `kind`, preserving
 *   transient/permanent/fatal retry semantics.
 * - anything else → a plain `Error` so the runner's `classifyError(err, task)`
 *   (retry.retryOn + transient-infra patterns) runs UNCHANGED.
 */
export function rehydrateError(se: SerializedError): Error {
    if (se.isTaskError && se.kind) {
        const e = new TaskError({
            message: se.message,
            kind: se.kind,
            remediation: se.remediation,
            cause: se.causeMessage ? new Error(se.causeMessage) : undefined,
        });
        if (se.stack) e.stack = se.stack;
        return e;
    }
    const e = Object.assign(new Error(se.message), { remediation: se.remediation });
    if (se.stack) e.stack = se.stack;
    return e;
}

/**
 * Run a plugin's `execute()` inside an isolated worker thread. Returns a
 * handle whose `result` settles when the plugin finishes (or the worker is
 * terminated). The caller (runner) keeps the handle so a watchdog can
 * `terminate()` on timeout.
 */
export function executeInWorker(params: ExecuteInWorkerParams): IsolationRun {
    const { entryPath, workerData, env, hooks, signal, softSignal, spawn } = params;
    const worker = spawn(entryPath, workerData, env);
    const untrackHeap = trackThreadHeap(`isolation:${workerData.taskId}`, worker);

    let providerCallMessages = 0;
    let settled = false;
    let exited = false;
    const exitWaiters: Array<() => void> = [];
    // Handle for the deferred "exited before completing" rejection — see the
    // `exit` listener below. Tracked so a terminal message that arrives in the
    // same macrotask can cancel it (avoids a redundant no-op callback and lets
    // us `clearImmediate` rather than leave it to fire and self-guard).
    let exitRejectHandle: ReturnType<typeof setImmediate> | null = null;

    const onAbort = (): void => {
        try {
            worker.postMessage({ t: 'abort' });
        } catch {
            // worker may already be gone — terminate path will finish the job
        }
    };

    const onSoftAbort = (): void => {
        try {
            worker.postMessage({ t: 'softAbort' });
        } catch {
            // worker may already be gone — best-effort soft wind-down only
        }
    };

    const onShutdown = (): void => {
        try {
            worker.postMessage({ t: 'shutdown' });
        } catch {
            // worker may already be gone — the hard terminate() that follows
            // finishes the job regardless
        }
    };

    const dispatchRpc = async (method: RpcMethod, args: unknown[]): Promise<unknown> => {
        switch (method) {
            case 'backgroundCpuCheckpoint':
                return hooks.backgroundCpuCheckpoint?.();
            case 'secrets.get':
                return hooks.secretsGet(args[0] as string);
            case 'secrets.getOptional':
                return hooks.secretsGetOptional(args[0] as string);
            case 'secrets.getUser':
                return hooks.secretsGetUser(args[0] as string, args[1] as string);
            case 'settings':
                return hooks.settings();
            case 'cache.get':
                return hooks.cacheGet(args[0] as string);
            case 'cache.set':
                return hooks.cacheSet(args[0] as string, args[1], args[2] as number | undefined);
            case 'cache.del':
                return hooks.cacheDel(args[0] as string);
            case 'reportFailure':
                return hooks.reportFailure(
                    args[0] as string,
                    args[1] as string,
                    args[2] as object | undefined,
                );
            case 'reportSuccess':
                return hooks.reportSuccess(args[0] as string);
            case 'userCredentials.get':
                return hooks.ucGet(args[0] as string, args[1] as string);
            case 'userCredentials.set':
                return hooks.ucSet(
                    args[0] as string,
                    args[1] as string,
                    args[2] as string,
                    args[3] as { expiresAt?: Date; ifKeyExists?: string } | undefined,
                );
            case 'userCredentials.delete':
                return hooks.ucDelete(args[0] as string, args[1] as string);
            case 'userCredentials.listKeys':
                return hooks.ucListKeys(args[0] as string);
            case 'userCredentials.listLinkedUsers':
                return hooks.ucListLinkedUsers();
            case 'userCredentials.listUsersWithKey':
                return hooks.ucListUsersWithKey(args[0] as string);
            default: {
                // Exhaustiveness guard — an unknown method is a host/worker
                // version mismatch, not a plugin error.
                const never: never = method;
                throw new Error(`unknown isolation RPC method: ${String(never)}`);
            }
        }
    };

    const result = new Promise<unknown>((resolve, reject) => {
        const finish = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            if (exitRejectHandle) {
                clearImmediate(exitRejectHandle);
                exitRejectHandle = null;
            }
            fn();
        };

        worker.on('message', (msg: WorkerToMain) => {
            // Once the run is terminal, ignore any late chatter from a worker
            // that is still draining/being-terminated — the runner has already
            // finalized this run's progress tracker + cost ledger, so acting on
            // a late log/progress/spend/rpc would touch finalized state.
            if (settled) return;
            switch (msg.t) {
                case 'log':
                    hooks.log(msg.level, msg.msg, msg.meta);
                    return;
                case 'progress':
                    hooks.progress(msg.processed, msg.total, msg.currentItem);
                    return;
                case 'spend':
                    hooks.spend(msg.kind, msg.units);
                    return;
                case 'providerCall': {
                    // Count every observation, including malformed ones, against this run.
                    if (providerCallMessages >= 10_000) return;
                    providerCallMessages++;
                    const parsed = ProviderCallProviderSchema.safeParse(msg.provider);
                    if (
                        !parsed.success ||
                        typeof msg.retry !== 'boolean' ||
                        (msg.status !== null &&
                            (typeof msg.status !== 'number' ||
                                !Number.isInteger(msg.status) ||
                                msg.status < 100 ||
                                msg.status > 599))
                    )
                        return;
                    // Worker timestamps are untrusted and must never determine Valkey keys.
                    const now = Date.now();
                    if (msg.retry) recordProviderRetry(parsed.data, now);
                    else recordProviderCall(parsed.data, msg.status, now);
                    return;
                }
                case 'rpc': {
                    const cid = msg.cid;
                    void dispatchRpc(msg.method, msg.args).then(
                        (value) =>
                            safePost(worker, { t: 'rpcResult', cid, ok: true, value }, hooks),
                        (err) =>
                            safePost(
                                worker,
                                {
                                    t: 'rpcResult',
                                    cid,
                                    ok: false,
                                    error: serializeError(err),
                                },
                                hooks,
                            ),
                    );
                    return;
                }
                case 'done':
                    finish(() => resolve(msg.result));
                    return;
                case 'error':
                    finish(() => reject(rehydrateError(msg.error)));
                    return;
            }
        });

        worker.on('error', (err: Error) => {
            // An uncaught error in the worker thread itself (not a plugin throw,
            // which arrives as `MsgError`). Treat as fatal — bug in the sandbox.
            hooks.warn('isolation worker thread error', {
                message: err.message,
                // The stack is the only pointer to WHICH code in the worker threw.
                stack: err.stack,
            });
            finish(() =>
                reject(
                    new TaskError({
                        message: `isolation worker error: ${err.message}`,
                        kind: 'fatal',
                    }),
                ),
            );
        });

        worker.on('exit', (code: number) => {
            // `exited` + waking `exitWaiters` (consumed by `terminate()`'s
            // `waitForExit`) must stay SYNCHRONOUS here — the hard-terminate
            // path's latency guarantees depend on observing exit immediately,
            // not after a deferred macrotask.
            exited = true;
            untrackHeap();
            for (const w of exitWaiters.splice(0)) w();
            // Exit before a terminal message = crash or terminate() — usually.
            // But node:worker_threads does not strictly guarantee every
            // in-flight postMessage delivery is drained before `exit` fires;
            // sandbox-entry.ts posts `done`/`error` and self-exits, and in the
            // worst case (no `await` between the post and `process.exit()`)
            // that final message could still be queued when this handler
            // runs. Defer the transient-rejection verdict by one macrotask so
            // an already-delivered-but-unprocessed terminal message gets a
            // turn to call `finish()` first via the `message` handler above —
            // if it does, `settled` is already true by the time this runs and
            // `finish()` is a no-op. Harmless if the race never fires (as
            // observed across ~900 real-worker trials on current Node): this
            // only delays a genuine crash's rejection by a single event-loop
            // turn. Not `.unref()`d — it always fires on the very next tick,
            // never spans an idle wait that would keep the process alive.
            exitRejectHandle = setImmediate(() => {
                exitRejectHandle = null;
                // If a watchdog already wrote terminal state it set
                // `stallFailed`, and the runner's catch discards this
                // rejection (existing late-return guard). Otherwise this
                // surfaces as the run's failure.
                finish(() =>
                    reject(
                        new TaskError({
                            // Code 0 means something inside the worker called
                            // process.exit() before the sandbox posted its
                            // terminal message — name that, so the failure
                            // board doesn't read like a crash.
                            message:
                                code === 0
                                    ? 'isolation worker exited (code 0) before completing — something in the worker called process.exit() before the task finished'
                                    : `isolation worker exited (code ${code}) before completing`,
                            kind: 'transient',
                        }),
                    ),
                );
            });
        });
    });

    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    if (softSignal) {
        if (softSignal.aborted) onSoftAbort();
        else softSignal.addEventListener('abort', onSoftAbort, { once: true });
    }

    const waitForExit = (graceMs: number): Promise<boolean> =>
        new Promise<boolean>((resolve) => {
            if (exited) return resolve(true);
            let done = false;
            const timer = setTimeout(() => {
                if (done) return;
                done = true;
                resolve(false);
            }, graceMs);
            if (typeof (timer as { unref?: () => void }).unref === 'function') {
                (timer as { unref: () => void }).unref();
            }
            exitWaiters.push(() => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(true);
            });
        });

    let terminating: Promise<void> | null = null;
    const terminate = (
        graceMs: number,
        shutdownGraceMs: number = SANDBOX_SHUTDOWN_GRACE_MS,
    ): Promise<void> => {
        if (terminating) return terminating;
        terminating = (async () => {
            if (exited) return;
            onAbort(); // ask nicely first (cooperative plugins unwind)
            const cleanExit = await waitForExit(graceMs);
            if (cleanExit || exited) return;
            // The plugin ignored (or never got to process) the abort within
            // grace — it may still be legitimately running its own abort
            // cleanup, or fully wedged. Either way, give the sandbox one more
            // bounded window to close its worker-local DB pool before the
            // thread is torn down out from under it. A truly synchronous
            // busy-loop worker can't process this message either, in which
            // case this window just elapses and we fall through below.
            onShutdown();
            const shutdownExited = await waitForExit(shutdownGraceMs);
            if (shutdownExited || exited) return;
            try {
                await worker.terminate();
            } catch (err) {
                // best-effort cleanup
                hooks.warn('isolation worker.terminate failed', {
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        })();
        return terminating;
    };

    // Free the thread + its DB pool once the run settles normally. Best-effort
    // and idempotent with the watchdog terminate. We do NOT remove the abort
    // listener via AbortSignal API (once:true already self-removes on first
    // fire); on a clean settle without abort it lingers until GC with the
    // worker — negligible and avoids an `off` that some fakes don't implement.
    // `.catch(()=>{})` so this internal cleanup chain never surfaces as an
    // unhandled rejection — the caller owns `result` and handles its rejection.
    void result
        .finally(() => {
            if (!exited) void terminate(0);
        })
        .catch(() => {});

    return { result, terminate };
}

function safePost(worker: IsolationWorkerLike, msg: MainToWorker, hooks: IsolationHostHooks): void {
    try {
        worker.postMessage(msg);
    } catch (err) {
        // Posting an RPC reply can throw if the value isn't structured-clone
        // safe (e.g. a hook returned a non-serializable object). Surface it so
        // the worker's awaiting RPC rejects rather than hanging forever.
        hooks.warn('isolation rpcResult post failed', {
            message: err instanceof Error ? err.message : String(err),
        });
        if (msg.t === 'rpcResult' && msg.ok) {
            try {
                worker.postMessage({
                    t: 'rpcResult',
                    cid: msg.cid,
                    ok: false,
                    error: serializeError(err),
                });
            } catch {
                // give up — worker will time out / exit
            }
        }
    }
}
