// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * "Am I running inside a plugin-isolation worker thread?"
 *
 * The isolation worker is a SECURITY BOUNDARY (design §7): it must never be able
 * to decrypt `plugin_secrets` rows or sealed settings.json values. The host
 * (`worker-host.ts` `buildIsolationEnv()`) scrubs `LUMASTRA_MASTER_KEY` from the
 * worker's env — but scrubbing alone is not enough: code in the worker that
 * calls `resolveMasterKey()` would then fall through to `<config>/master.key`,
 * READ it (defeating the boundary on installs that never set the env key) or,
 * when the file does not exist yet, GENERATE a new random key into it. That
 * second case split one deployment across two master keys (Windows new-user e2e
 * 2026-09-27, B1). Key-touching code therefore asks this module and refuses.
 *
 * Detection needs BOTH signals:
 *   - `!isMainThread` — the main thread of a process is never an isolation
 *     worker, whatever its env says. The dedicated worker CONTAINER
 *     (`start-worker.sh`, WORKER_MODE=enabled) is a separate process whose code
 *     runs on its main thread, so it keeps its legitimate key access.
 *   - the explicit env marker set by `buildIsolationEnv()` — other worker
 *     threads in the app (file watcher, radio regex runner) are not isolation
 *     workers. Threads spawned from inside an isolation worker inherit its env,
 *     marker included, and are treated as isolated too.
 *
 * Dependency-free on purpose: imported by `crypto/master-key.ts` and
 * `config/config.service.ts`, which must stay free of import cycles.
 */

import { isMainThread } from 'node:worker_threads';

/** Env var `buildIsolationEnv()` sets to `'1'` in every isolation worker. */
export const ISOLATION_WORKER_ENV_MARKER = 'LUMASTRA_ISOLATION_WORKER';

/**
 * True when the calling code runs inside a plugin-isolation worker thread.
 * Parameters exist for tests; production callers pass nothing.
 */
export function isIsolationWorker(
    env: Record<string, string | undefined> = process.env,
    mainThread: boolean = isMainThread,
): boolean {
    return !mainThread && env[ISOLATION_WORKER_ENV_MARKER] === '1';
}

/**
 * Thrown when code inside an isolation worker tries to resolve the master key
 * or seal/open a config secret. Decrypted secret values reach the worker only
 * per call, via RPC from the main thread (`ctx.secrets`, `ctx.userCredentials`).
 */
export class IsolationWorkerKeyAccessError extends Error {
    constructor(what: string) {
        const caller = callerFrames(new Error().stack);
        super(
            `${what} is not available inside a plugin-isolation worker: the master key never ` +
                'enters this thread (security boundary). Read secrets through ctx.secrets / ' +
                'ctx.userCredentials (RPC to the main thread), or run this code on the main thread.' +
                (caller ? ` [called from: ${caller}]` : ''),
        );
        this.name = 'IsolationWorkerKeyAccessError';
    }
}

/**
 * The first few stack frames of whoever triggered the error, as one line.
 *
 * Put INTO the message on purpose: when this escapes the worker as an uncaught
 * error, the host's 'error' event only carries a message into task_history and
 * the log, so without it "which code asked for the key?" was undiagnosable
 * (B1 follow-up: every isolated task failed with no stack anywhere).
 */
export function callerFrames(stack: string | undefined, max = 5): string {
    if (!stack) return '';
    return stack
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('at ') && !line.includes('IsolationWorkerKeyAccessError'))
        .slice(0, max)
        .map((line) => line.slice(3))
        .join(' <- ');
}
