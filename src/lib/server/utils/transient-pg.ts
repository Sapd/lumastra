// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared classifier for "is this Postgres error transient enough to retry?"
 *
 * Two callers consume this:
 *   - src/lib/server/tasks/pending-write-drain.ts (orchestrator drain path)
 *   - src/lib/server/queue/audit-listener.ts      (BullMQ audit retry)
 *
 * Both previously held near-identical copies; consolidating here keeps the
 * SQLSTATE set in one place so a missing code can't drift between paths.
 *
 * Transient SQLSTATE classes covered:
 *  - 08xxx — Connection errors (lost connection, sqlclient cannot establish)
 *  - 40001 / 40P01 — Serialization failure / deadlock (retry should succeed)
 *  - 53xxx — Resource exhaustion (too many connections, out of memory, etc.)
 *  - 55xxx — Object not in prerequisite state (object_in_use / lock_not_available
 *            / cant_change_runtime_param). Temporary contention — the object is
 *            busy or a runtime param is momentarily locked; retrying clears it.
 *  - 57014 — query_canceled (statement_timeout fired — transient under load)
 *  - 57P01 — admin_shutdown (preprod redeploy kicks connections)
 *  - 57P02 — crash_shutdown (server crash/restart)
 *  - 57P03 — cannot_connect_now (server still in startup)
 *  - F0xxx — Configuration file error (config_file_error / lock_file_exists).
 *            Raised while the backend is reloading config or contending on the
 *            postmaster lock file during startup/restart — clears on retry.
 *
 * Anything else — constraint violations (23xxx), syntax errors (42xxx), data
 * type errors (22xxx) — is permanent and must NOT be drained/retried; the
 * caller has to surface it (e.g. unique-violation drives idempotency dedup).
 *
 * Message heuristic: postgres.js surfaces some connection issues without a
 * SQLSTATE (CONNECTION_ENDED / write EPIPE / ECONNRESET / write ENOTCONN /
 * EHOSTUNREACH — typical during replica failover and node draining). The
 * fallback matches a small set of substrings to catch those uncoded shapes.
 */

const TRANSIENT_PG_CODES = new Set<string>([
    // 08xxx — connection errors
    '08000',
    '08001',
    '08003',
    '08004',
    '08006',
    '08007',
    '08P01',
    // serialization failure / deadlock
    '40001',
    '40P01',
    // resource exhaustion
    '53000',
    '53100',
    '53200',
    '53300',
    '53400',
    // 55xxx — object not in prerequisite state (busy object / locked runtime
    // param). All transient: the object is temporarily in use or a runtime
    // param is momentarily locked, so retrying after a drain interval clears it.
    '55000', // object_not_in_prerequisite_state
    '55006', // object_in_use
    '55P02', // cant_change_runtime_param
    '55P03', // lock_not_available (statement_timeout / NOWAIT lock attempt)
    // operator intervention
    '57014', // query_canceled (statement_timeout)
    '57P01', // admin_shutdown
    '57P02', // crash_shutdown
    '57P03', // cannot_connect_now
    // F0xxx — configuration file error. Surfaced while the backend reloads
    // config or contends on the postmaster lock file during startup/restart;
    // clears on retry once the reload/startup settles.
    'F0000', // config_file_error
    'F0001', // lock_file_exists
]);

/**
 * postgres.js connection-lifecycle error `code`s — NOT SQLSTATE. The driver
 * raises these (with a matching message) when a connection can't be established
 * or is torn down: transient infra blips, never a permanent query error.
 */
const PG_JS_TRANSIENT_CODES = new Set<string>([
    'CONNECT_TIMEOUT', // could not establish a connection within connect_timeout
    'CONNECTION_ENDED',
    'CONNECTION_CLOSED',
    'CONNECTION_DESTROYED',
]);

/**
 * Classify a thrown Postgres error as transient (retry / drain) vs permanent
 * (re-throw). Falls back to a message heuristic for uncoded network errors
 * that postgres.js surfaces without a SQLSTATE.
 */
export function isTransientPgError(err: unknown): boolean {
    if (err && typeof err === 'object') {
        const e = err as { code?: string; message?: string };
        if (typeof e.code === 'string' && TRANSIENT_PG_CODES.has(e.code)) {
            return true;
        }
        // postgres.js connection-lifecycle errors carry a NON-SQLSTATE `code`
        // (e.g. CONNECT_TIMEOUT, CONNECTION_ENDED/CLOSED/DESTROYED) — all
        // transient infra blips (pool saturation, DB restart, draining).
        if (typeof e.code === 'string' && PG_JS_TRANSIENT_CODES.has(e.code)) {
            return true;
        }
        // postgres.js surfaces some connection issues without a SQLSTATE
        // (CONNECTION_ENDED, CONNECTION_DESTROYED, write EPIPE) — fall back
        // to the message.
        const msg = typeof e.message === 'string' ? e.message.toLowerCase() : '';
        if (
            msg.includes('connection') &&
            (msg.includes('lost') ||
                msg.includes('closed') ||
                msg.includes('terminated') ||
                msg.includes('reset') ||
                msg.includes('ended') ||
                msg.includes('refused'))
        ) {
            return true;
        }
        if (
            msg.includes('econnrefused') ||
            msg.includes('econnreset') ||
            msg.includes('etimedout') ||
            // F1 — additional socket-layer codes that postgres.js raises
            // without a SQLSTATE during replica failover / node draining /
            // network partition:
            //   - EPIPE: write to closed socket (replica restart mid-query)
            //   - ENOTCONN: socket not connected (rare, but happens after
            //     a half-open connection is recycled into the pool)
            //   - EHOSTUNREACH: routing failure (k8s NodePort drains)
            msg.includes('epipe') ||
            msg.includes('enotconn') ||
            msg.includes('ehostunreach') ||
            // postgres.js raises `write CONNECT_TIMEOUT <host>:<port>` (code
            // 'CONNECT_TIMEOUT', no SQLSTATE) when it cannot establish a
            // connection within connect_timeout — a transient infra blip (pool
            // saturation, DB briefly busy/restarting), NOT a permanent error.
            // Without this it was classified permanent and dead-lettered the
            // item (observed: a trickplay item failed_permanent at attempt 0 on
            // 'write CONNECT_TIMEOUT ai-postgres:5432').
            msg.includes('connect_timeout')
        ) {
            return true;
        }
    }
    return false;
}
