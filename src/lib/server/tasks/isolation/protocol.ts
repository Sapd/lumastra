// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Wire protocol for worker-thread plugin isolation.
 *
 * Shared by both sides of the boundary:
 *   - main thread  → `worker-host.ts` (spawns the Worker, services RPC)
 *   - worker thread → `sandbox-entry.ts` (runs `execute(ctx)`)
 *
 * MUST stay dependency-free (types + tiny pure helpers only). It is bundled
 * into the worker entry AND imported by the runner; any heavy import here would
 * be paid on both paths. No `@sapd/lumastra-plugin-sdk`, no `$lib` imports.
 */

import type { CostKind, TaskErrorKind } from '@sapd/lumastra-plugin-sdk';

/** Data cloned once into the worker at spawn (structured-clone safe). */
export interface SandboxWorkerData {
    runId: string;
    taskId: string;
    parentRunId?: string;
    attemptNumber: number;
    /** Plugin input — structured-clone safe (job input is already JSON). */
    input: unknown;
    scope: { libraryGroupId?: string; userId?: string };
    mode: string;
    /** Resolved capability gates so the worker builds the same ctx surface. */
    capabilities: {
        http?: boolean;
        cache?: boolean;
        ffmpeg?: boolean;
        dataDir?: boolean;
        database?: boolean;
        allowedDomains?: string[];
    };
    /** Worker-local Postgres pool size (LUMASTRA_ISOLATION_DB_POOL_MAX). */
    dbPoolMax: number;
}

/** A thrown error flattened for the structured-clone boundary. */
export interface SerializedError {
    /** True when the original was an SDK `TaskError` (kind is authoritative). */
    isTaskError: boolean;
    message: string;
    /** Present iff `isTaskError`; otherwise the host re-classifies. */
    kind?: TaskErrorKind;
    stack?: string;
    causeMessage?: string;
    remediation?: 'identity' | 'operational';
}

// ── worker → main ───────────────────────────────────────────────────────────

/** Fire-and-forget log line (no reply). */
export interface MsgLog {
    t: 'log';
    level: 'debug' | 'info' | 'warn' | 'error';
    msg: string;
    meta?: Record<string, unknown>;
}

/** Fire-and-forget progress tick (no reply). */
export interface MsgProgress {
    t: 'progress';
    processed: number;
    total?: number;
    currentItem?: string;
}

/** Fire-and-forget cost accrual (no reply). */
export interface MsgSpend {
    t: 'spend';
    kind: CostKind;
    units: number;
}

/**
 * Request/reply for a host-owned ctx method (secrets, settings, cache,
 * reportFailure, userCredentials). `cid` correlates the reply.
 */
export interface MsgRpc {
    t: 'rpc';
    cid: number;
    method: RpcMethod;
    args: unknown[];
}

/** Terminal: plugin returned a (serializable) TaskResult. */
export interface MsgDone {
    t: 'done';
    result: unknown;
}

/** Terminal: plugin threw, or the worker failed to serialize the result. */
export interface MsgError {
    t: 'error';
    error: SerializedError;
}

/** Provider observations use the host's shared Valkey; no worker-local client. */
export interface MsgProviderCall {
    t: 'providerCall';
    provider: string;
    status: number | null;
    retry: boolean;
    at: number;
}

export type WorkerToMain =
    MsgLog | MsgProgress | MsgSpend | MsgProviderCall | MsgRpc | MsgDone | MsgError;

// ── main → worker ───────────────────────────────────────────────────────────

/** Reply to a prior `MsgRpc`. */
export interface MsgRpcResult {
    t: 'rpcResult';
    cid: number;
    ok: boolean;
    /** Present when `ok`. Structured-clone safe. */
    value?: unknown;
    /** Present when `!ok`. */
    error?: SerializedError;
}

/** Relayed cancel — the worker flips its local AbortController. */
export interface MsgAbort {
    t: 'abort';
}

/** Relayed soft-deadline — the worker flips its local SOFT AbortController
 *  (ctx.softSignal). Distinct from cancel: the run is not cancelled, the handler
 *  is just told to wind down before the hard cap. */
export interface MsgSoftAbort {
    t: 'softAbort';
}

/**
 * Last-chance message sent by `worker-host.ts` `terminate()` right before it
 * falls through to the hard `worker.terminate()` — i.e. the worker ignored
 * (or never got to process) `abort` within its grace window. On receipt,
 * `sandbox-entry.ts` attempts a bounded close of its worker-local Postgres
 * pool and self-exits, so pool sockets close under the sandbox's own control
 * instead of dying uncontrolled when Node tears the thread down. A worker
 * stuck in a synchronous busy-loop cannot process this either — for that case
 * there is no rescue except the hard terminate() that follows.
 */
export interface MsgShutdown {
    t: 'shutdown';
}

export type MainToWorker = MsgRpcResult | MsgAbort | MsgSoftAbort | MsgShutdown;

/**
 * Host-owned ctx methods the worker reaches via RPC. Everything NOT in this
 * union (sql, http, catalog, mediaItems, mediaFiles) is rebuilt worker-local
 * and never crosses the port. `dep().fetch` is intentionally absent — it is
 * unsupported under isolation (the targets don't use it).
 */
export type RpcMethod =
    | 'backgroundCpuCheckpoint'
    | 'secrets.get'
    | 'secrets.getOptional'
    | 'secrets.getUser'
    | 'settings'
    | 'cache.get'
    | 'cache.set'
    | 'cache.del'
    | 'reportFailure'
    | 'reportSuccess'
    | 'userCredentials.get'
    | 'userCredentials.set'
    | 'userCredentials.delete'
    | 'userCredentials.listKeys'
    | 'userCredentials.listLinkedUsers'
    | 'userCredentials.listUsersWithKey';

/** Flatten any thrown value into a clone-safe envelope. */
export function serializeError(err: unknown): SerializedError {
    if (err instanceof Error) {
        // TaskError carries `kind` as an own property; a plain Error does not.
        const kind = (err as { kind?: unknown }).kind;
        const isTaskError =
            err.name === 'TaskError' &&
            (kind === 'transient' || kind === 'permanent' || kind === 'fatal');
        const cause = (err as { cause?: unknown }).cause;
        return {
            isTaskError,
            remediation:
                (err as { remediation?: unknown }).remediation === 'identity'
                    ? 'identity'
                    : (err as { remediation?: unknown }).remediation === 'operational'
                      ? 'operational'
                      : undefined,
            message: err.message,
            kind: isTaskError ? (kind as TaskErrorKind) : undefined,
            stack: err.stack,
            causeMessage:
                cause instanceof Error ? cause.message : cause != null ? String(cause) : undefined,
        };
    }
    return { isTaskError: false, message: String(err) };
}
