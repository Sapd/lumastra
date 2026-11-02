// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Safe filesystem access — timeout-bounded and globally concurrency-capped.
 *
 * WHY THIS EXISTS
 * ---------------
 * Media/metadata live on network mounts (NFS/SMB). On a `hard` NFS mount a slow
 * or unreachable server makes every `fs` call block for up to the mount's `timeo`
 * (often 60s). Node has two failure surfaces when that happens:
 *
 *   1. **Synchronous fs** (`existsSync`, `readdirSync`, …) blocks the MAIN event
 *      loop — freezing leader-lock renewal, run heartbeats and timers. (Fix: stop
 *      using sync fs on worker hot paths; use the async wrappers here.)
 *   2. **Async fs** (`fs/promises`) runs on the libuv threadpool, which it SHARES
 *      with `getaddrinfo` (DNS). Enough concurrent hung reads occupy all
 *      `UV_THREADPOOL_SIZE` threads, so new Postgres/Valkey connections can't even
 *      resolve their hostname → `CONNECT_TIMEOUT` → heartbeats/reconciler fail →
 *      the whole task runner wedges.
 *
 * This module bounds (2): every guarded fs op flows through a process-global
 * semaphore sized BELOW the threadpool, permanently reserving threads for DNS and
 * DB so liveness can never be starved by file I/O. Each op also gets a timeout so
 * a caller fails fast instead of hanging on the task's own logic.
 *
 * CRITICAL: the permit is released when the UNDERLYING op settles, NOT when the
 * caller's timeout fires. A hung libuv thread keeps occupying the threadpool until
 * the kernel returns; releasing the permit early would let another op start and
 * push real threadpool usage past the cap — exactly the saturation we prevent. So
 * the timeout only unblocks the caller; the permit tracks true in-flight threads.
 */

import {
    readdir as fsReaddir,
    stat as fsStatRaw,
    statfs as fsStatfs,
    lstat as fsLstatRaw,
    readFile as fsReadFile,
    realpath as fsRealpath,
    access as fsAccess,
    writeFile as fsWriteFile,
    mkdir as fsMkdir,
    rename as fsRename,
    unlink as fsUnlink,
    rm as fsRm,
    cp as fsCp,
} from 'node:fs/promises';
import type { Dirent, Stats, StatsFs, BigIntStats } from 'node:fs';
import { AsyncSemaphore } from './async-semaphore.js';

/** Thrown when a guarded fs op exceeds its timeout (the underlying call may still be stuck). */
export class FsTimeoutError extends Error {
    constructor(
        public readonly op: string,
        public readonly path: string,
        public readonly timeoutMs: number,
    ) {
        super(`fs ${op} timed out after ${timeoutMs}ms: ${path}`);
        this.name = 'FsTimeoutError';
    }
}

// Default concurrency cap. UV_THREADPOOL_SIZE defaults to 4; the image sets it to
// 64 (see Dockerfile). We cap guarded fs well below the pool so getaddrinfo (DNS),
// Postgres/Valkey connects and crypto always have free threads even if every
// permitted fs op is stuck on a hung NFS mount. Read from env directly (this
// module must stay free of the config import cycle, like database/connection.ts).
// Clamp to a sane floor/ceiling.
function envInt(name: string, fallback: number, min: number, max: number): number {
    const raw = process.env[name];
    // Number() (not parseInt) so a typo'd value like '24abc' / '24.9' / '' becomes
    // NaN and falls back, rather than being silently coerced to a partial number.
    const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) return fallback;
    return n;
}

const CONFIGURED_FS_MAX = envInt('LUMASTRA_FS_MAX_CONCURRENCY', 24, 1, 256);
const FS_TIMEOUT_MS = envInt('LUMASTRA_FS_TIMEOUT_MS', 15_000, 100, 600_000);

// The cap MUST stay below the libuv threadpool, or stuck fs ops can occupy every
// thread and starve getaddrinfo/DB — the very wedge this module prevents. The
// image sets UV_THREADPOOL_SIZE=64 (Dockerfile), but a bare `node`/dev run leaves
// it at libuv's default of 4, which would INVERT the invariant (cap 24 over pool 4
// → 4 stuck reads alone starve DNS). Clamp the effective cap to leave a reserve of
// threads for DNS/DB/crypto, and warn loudly when we had to clamp.
const UV_POOL_SIZE = envInt('UV_THREADPOOL_SIZE', 4, 1, 1024);
// Reserve threads for DNS/DB/crypto, but never reserve more than half the pool,
// so a small pool (dev/bare node, default 4) still permits SOME fs concurrency
// instead of collapsing to 1.
const POOL_RESERVE = Math.min(8, Math.floor(UV_POOL_SIZE / 2));
const CLAMPED_FS_MAX = Math.max(1, Math.min(CONFIGURED_FS_MAX, UV_POOL_SIZE - POOL_RESERVE));
// Skip the pool-clamp under vitest: tests mock fs and some intentionally leave a
// guarded op pending (timeout-path coverage), which would exhaust a tiny clamped
// cap and hang unrelated tests. Threadpool starvation isn't a concern vs mocked fs.
const FS_MAX_CONCURRENCY = process.env.VITEST ? CONFIGURED_FS_MAX : CLAMPED_FS_MAX;
if (FS_MAX_CONCURRENCY < CONFIGURED_FS_MAX && !process.env.VITEST) {
    // One-time startup diagnostic. This module deliberately stays free of the
    // logger/config import cycle (like database/connection.ts), so use console.

    console.warn(
        `[safe-fs] fs concurrency cap clamped ${CONFIGURED_FS_MAX} -> ${FS_MAX_CONCURRENCY} ` +
            `(UV_THREADPOOL_SIZE=${UV_POOL_SIZE}); set UV_THREADPOOL_SIZE >= ${CONFIGURED_FS_MAX + POOL_RESERVE} ` +
            `to restore full fs concurrency and keep DNS/DB threads reserved.`,
    );
}
// At pool<=2 the reserve math (POOL_RESERVE = floor(pool/2)) can only yield 0 or 1
// reserved threads, and the cap collapses to 1 — no *safe* DNS/DB reserve is
// physically possible: the single guarded fs op can occupy the last free thread,
// so getaddrinfo/DB connects contend directly with file I/O. This is only ever a
// deliberate misconfiguration (prod sets UV_THREADPOOL_SIZE=64); warn explicitly
// so a bare `node`/dev run that wedges under NFS load is diagnosable.
if (UV_POOL_SIZE <= 2 && !process.env.VITEST) {
    console.warn(
        `[safe-fs] UV_THREADPOOL_SIZE=${UV_POOL_SIZE} is too small to reserve any thread for ` +
            `DNS/DB: no safe fs/DNS isolation is possible at pool<=2, so guarded fs ops will ` +
            `contend with getaddrinfo/Postgres/Valkey connects. Set UV_THREADPOOL_SIZE >= 8 ` +
            `(prod uses 64) to restore the reserve.`,
    );
}

// Process-global: ALL guarded fs ops across every task share this budget, so the
// threadpool reservation holds no matter how many tasks run concurrently.
const fsSemaphore = new AsyncSemaphore(FS_MAX_CONCURRENCY);

/** Observability: current in-flight guarded fs ops and queued waiters. */
export function fsGuardStats(): {
    maxConcurrency: number;
    configuredMax: number;
    poolSize: number;
    inFlight: number;
    waiting: number;
    saturated: boolean;
} {
    const inFlight = FS_MAX_CONCURRENCY - fsSemaphore.available;
    return {
        maxConcurrency: FS_MAX_CONCURRENCY,
        configuredMax: CONFIGURED_FS_MAX,
        poolSize: UV_POOL_SIZE,
        inFlight,
        waiting: fsSemaphore.waiting,
        // A sustained saturated guard (all permits held AND ops queueing) is the
        // early-warning signal for an unhealthy mount — surfaced to /metrics.
        saturated: fsSemaphore.available === 0 && fsSemaphore.waiting > 0,
    };
}

/**
 * Run a single fs operation under the global concurrency cap with a timeout.
 *
 * - Acquires a permit (queues in JS, NOT the threadpool, when the cap is hit — so
 *   a saturated NFS can't push more than the cap onto the threadpool).
 * - Starts the real op and releases the permit only when it truly settles.
 * - Races the caller against a timeout so task logic never hangs indefinitely.
 */
export async function withFsGuard<T>(
    factory: () => Promise<T>,
    op: string,
    path: string,
    timeoutMs: number = FS_TIMEOUT_MS,
    signal?: AbortSignal,
): Promise<T> {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', forwardAbort, { once: true });
    if (signal?.aborted) forwardAbort();
    let rejectInterrupted!: (reason: unknown) => void;
    const interrupted = new Promise<never>((_, reject) => {
        rejectInterrupted = reject;
    });
    const onInterrupted = (): void => rejectInterrupted(controller.signal.reason);
    controller.signal.addEventListener('abort', onInterrupted, { once: true });
    if (controller.signal.aborted) onInterrupted();
    const timer = setTimeout(
        () => controller.abort(new FsTimeoutError(op, path, timeoutMs)),
        timeoutMs,
    );
    const work = (async (): Promise<T> => {
        await fsSemaphore.acquire(controller.signal);
        if (controller.signal.aborted) {
            fsSemaphore.release();
            controller.signal.throwIfAborted();
        }
        let real: Promise<T>;
        try {
            real = factory();
        } catch (syncErr) {
            fsSemaphore.release();
            throw syncErr;
        }
        // Even after caller abort/timeout, an occupied libuv thread retains its permit.
        void real.then(
            () => fsSemaphore.release(),
            () => fsSemaphore.release(),
        );
        return real;
    })();
    try {
        return await Promise.race([work, interrupted]);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', forwardAbort);
        controller.signal.removeEventListener('abort', onInterrupted);
    }
}

/**
 * Guarded `readdir` — always returns `Dirent[]` (every caller needs entry types).
 * Map `.name` if you only want filenames.
 */
export function safeReaddir(path: string, timeoutMs?: number): Promise<Dirent[]> {
    return withFsGuard(() => fsReaddir(path, { withFileTypes: true }), 'readdir', path, timeoutMs);
}

export function safeStat(path: string, timeoutMs?: number): Promise<Stats> {
    return withFsGuard(() => fsStatRaw(path), 'stat', path, timeoutMs);
}

/** Precise file identity under the same global filesystem guard and caller deadline. */
export function safeStatBigInt(
    path: string,
    timeoutMs?: number,
    signal?: AbortSignal,
): Promise<BigIntStats> {
    return withFsGuard(() => fsStatRaw(path, { bigint: true }), 'stat', path, timeoutMs, signal);
}

/**
 * Guarded `statfs` — filesystem-level free/total space for the volume that
 * holds `path`. Goes through the same permit + timeout as every other fs call
 * because `statfs` on a hung NFS mount blocks a libuv thread exactly like a
 * `stat` does.
 */
export function safeStatfs(path: string, timeoutMs?: number): Promise<StatsFs> {
    return withFsGuard(() => fsStatfs(path), 'statfs', path, timeoutMs);
}

export function safeLstat(path: string, timeoutMs?: number): Promise<Stats> {
    return withFsGuard(() => fsLstatRaw(path), 'lstat', path, timeoutMs);
}

export function safeReadFile(path: string, timeoutMs?: number): Promise<Buffer> {
    return withFsGuard(() => fsReadFile(path), 'readFile', path, timeoutMs);
}

export function safeRealpath(path: string, timeoutMs?: number): Promise<string> {
    return withFsGuard(() => fsRealpath(path), 'realpath', path, timeoutMs);
}

/**
 * Async, non-throwing existence check — the safe replacement for `existsSync` on
 * worker hot paths. Returns false on a missing path OR an fs timeout (a path we
 * can't confirm is treated as absent rather than hanging the caller).
 */
export async function safeExists(path: string, timeoutMs?: number): Promise<boolean> {
    try {
        await withFsGuard(() => fsAccess(path), 'access', path, timeoutMs);
        return true;
    } catch {
        return false;
    }
}

/**
 * Guarded, THROWING `access` — for callers that must distinguish ENOENT from
 * EACCES from a timeout (`FsTimeoutError` carries no `code`, so `code`-based
 * branches naturally treat a timeout as "inconclusive"). Pass `mode`
 * (e.g. `fs.constants.W_OK`) to check specific permissions.
 */
export function safeAccess(path: string, mode?: number, timeoutMs?: number): Promise<void> {
    return withFsGuard(() => fsAccess(path, mode), 'access', path, timeoutMs);
}

// ---------------------------------------------------------------------------
// Write-side primitives. Writes/renames/removals on a hung mount occupy libuv
// threads exactly like reads do, so they need the same permit + timeout. NOTE:
// a caller timeout does NOT abort the underlying op — a "timed out" write may
// still land on disk later. Callers doing write-then-rename atomics should
// treat FsTimeoutError as "state unknown", not "definitely not written".

export function safeWriteFile(
    path: string,
    data: string | Uint8Array,
    timeoutMs?: number,
): Promise<void> {
    return withFsGuard(() => fsWriteFile(path, data), 'writeFile', path, timeoutMs);
}

export function safeMkdir(
    path: string,
    opts?: { recursive?: boolean; mode?: number },
    timeoutMs?: number,
): Promise<string | undefined> {
    return withFsGuard(() => fsMkdir(path, opts), 'mkdir', path, timeoutMs);
}

/** Guarded rename. The guard label/timeout applies to the whole rename; `oldPath` is reported. */
export function safeRename(oldPath: string, newPath: string, timeoutMs?: number): Promise<void> {
    return withFsGuard(() => fsRename(oldPath, newPath), 'rename', oldPath, timeoutMs);
}

export function safeUnlink(path: string, timeoutMs?: number): Promise<void> {
    return withFsGuard(() => fsUnlink(path), 'unlink', path, timeoutMs);
}

export function safeRm(
    path: string,
    opts?: { recursive?: boolean; force?: boolean },
    timeoutMs?: number,
): Promise<void> {
    return withFsGuard(() => fsRm(path, opts), 'rm', path, timeoutMs);
}

export function safeCp(
    src: string,
    dest: string,
    opts?: { recursive?: boolean },
    timeoutMs?: number,
): Promise<void> {
    return withFsGuard(() => fsCp(src, dest, opts), 'cp', src, timeoutMs);
}
