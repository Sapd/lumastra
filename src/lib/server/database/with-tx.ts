// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared transaction helper for postgres-js Sql variants.
 *
 * postgres-js attaches different APIs at runtime to each Sql variant despite
 * the TypeScript types claiming inheritance:
 *
 *   - top-level `Sql` (from `postgres(url)`)        → has `begin`, no `savepoint`
 *   - `TransactionSql` (inside `sql.begin(fn)`)     → has `savepoint`, no `begin`
 *   - `ReservedSql` (from `sql.reserve()`)          → has NEITHER (only `release`)
 *
 * The reserved case is load-bearing: callers like `withSeriesSyncLock` reserve
 * a connection so `pg_advisory_lock` stays bound to the same session, then
 * pass that reserved sql into services. Calling `sql.begin(fn)` on a reserved
 * connection throws `TypeError: sql.begin is not a function`. Historically
 * the calling code's `catch{}` masked this as a misleading "external ID
 * conflict" warning — see commit `de3943d8d`. A second occurrence of the same
 * bug surfaced in the media-probe plugin (~12,452 unprobed files preprod-wide
 * with 0% probe success) which motivated hoisting this helper.
 *
 * Fallback for ReservedSql: issue `BEGIN/COMMIT/ROLLBACK` by hand. Reserved
 * connections are pinned to one physical connection so a manual transaction
 * is safe — no risk of statements landing on different connections. On
 * rollback failure we surface the ORIGINAL error so the underlying cause is
 * not masked.
 *
 * Detection is purely runtime: we check for `.savepoint`/`.begin` on the
 * provided handle rather than relying on TypeScript types, because the types
 * lie about which methods are actually present at runtime.
 */

import type postgres from 'postgres';

// postgres.js types claim inheritance between Sql / TransactionSql / ReservedSql,
// but at runtime only one of `.begin` / `.savepoint` / neither is actually
// callable. We accept any Sql variant and dispatch by feature detection.
//
// `TxSql` is the transaction-scoped handle the callback receives. Whichever
// primitive we dispatch to (`begin` / `savepoint` / manual BEGIN), the callback
// is handed a `postgres.Sql` it can run queries on. We type it as the base
// `Sql` so callers get a real, query-capable handle instead of `any` — the
// `any` previously leaked into every `withTx` callsite (catalog.service etc.)
// and silently disabled type-checking inside those transaction bodies.
type TxSql = postgres.Sql;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySql = postgres.Sql<any>;

type TxFn<T> = (tx: TxSql) => Promise<T>;

// Reserved handles currently inside a manual BEGIN opened by `withTx`.
const manualTransactions = new WeakSet<object>();

/**
 * Run `cb` inside a transaction or savepoint, picking the right primitive for
 * the given Sql handle. Works for top-level Sql, TransactionSql, and
 * ReservedSql. See file header for full rationale.
 *
 * @param sql - any postgres.js Sql variant
 * @param cb  - callback that receives a transaction-scoped sql handle
 * @returns whatever `cb` returns
 */
export async function withTx<T>(sql: AnySql, cb: TxFn<T>): Promise<T> {
    type TxOpener = (cb: TxFn<T>) => Promise<T>;
    const handle = sql as unknown as {
        begin?: TxOpener;
        savepoint?: TxOpener;
    };

    // Prefer savepoint when nested (TransactionSql), fall back to begin
    // (top-level Sql). ReservedSql has neither — drop into the manual path.
    const opener =
        typeof handle.savepoint === 'function'
            ? handle.savepoint
            : typeof handle.begin === 'function'
              ? handle.begin
              : null;

    if (opener) {
        return opener.call(sql, cb);
    }

    // ReservedSql path — manual transaction. The reserved handle is pinned to
    // a single physical connection so BEGIN/COMMIT/ROLLBACK are guaranteed to
    // run on the same session as the callback's queries.
    //
    // Already inside a manual transaction that this helper opened on the same
    // handle: a second BEGIN would only warn, and its COMMIT would end the
    // OUTER transaction early, so everything the outer caller meant to commit
    // atomically would be committed in pieces. Nest with a savepoint instead,
    // exactly as the TransactionSql path does.
    if (manualTransactions.has(sql)) {
        await sql`SAVEPOINT lumastra_nested_tx`;
        try {
            const result = await cb(sql);
            await sql`RELEASE SAVEPOINT lumastra_nested_tx`;
            return result;
        } catch (err) {
            try {
                await sql`ROLLBACK TO SAVEPOINT lumastra_nested_tx`;
                await sql`RELEASE SAVEPOINT lumastra_nested_tx`;
            } catch {
                // Same as the outer path: surface the original error.
            }
            throw err;
        }
    }

    await sql`BEGIN`;
    manualTransactions.add(sql);
    try {
        const result = await cb(sql);
        await sql`COMMIT`;
        return result;
    } catch (err) {
        try {
            await sql`ROLLBACK`;
        } catch {
            // Nested rollback failure — surface the original error so the
            // underlying cause is not masked. The connection will be reset
            // on release.
        }
        throw err;
    } finally {
        manualTransactions.delete(sql);
    }
}

/**
 * Whether `sql` is currently inside an open transaction block, so a caller
 * that needs several statements to share locks/snapshot knows if it must open
 * one first.
 *
 *   - `TransactionSql` (has `savepoint`): always inside one.
 *   - top-level `Sql` (has `begin`): never; each statement autocommits.
 *   - `ReservedSql` (neither): depends. The caller may have issued a manual
 *     BEGIN (withTx's reserved path, or by hand) or may be in autocommit (e.g.
 *     the code after a merge's own transaction committed). Asked of the server
 *     by trying a SAVEPOINT: it works only inside a transaction block (and is
 *     released straight away) and fails with 25P01 outside one. A timestamp
 *     comparison does not work: under the extended protocol the implicit
 *     transaction starts at Parse and the statement clock restarts at Execute,
 *     so they differ in autocommit too.
 */
export async function isInOpenTransaction(sql: AnySql): Promise<boolean> {
    const handle = sql as unknown as { begin?: unknown; savepoint?: unknown };
    if (typeof handle.savepoint === 'function') return true;
    if (typeof handle.begin === 'function') return false;
    try {
        await sql`SAVEPOINT lumastra_in_tx_probe`;
        await sql`RELEASE SAVEPOINT lumastra_in_tx_probe`;
        return true;
    } catch (err) {
        if ((err as { code?: string }).code === '25P01') return false;
        throw err;
    }
}

const CONNECTION_ERROR_CODES = new Set([
    'CONNECTION_CLOSED',
    'CONNECTION_DESTROYED',
    'CONNECTION_ENDED',
    'CONNECTION_CONNECT_TIMEOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'EPIPE',
    'ETIMEDOUT',
    // The server went away on purpose: admin shutdown, crash shutdown, cannot connect now.
    '57P01',
    '57P02',
    '57P03',
]);

/**
 * An error after which the surrounding transaction cannot be trusted to still
 * exist: the connection is gone (postgres.js `CONNECTION_*`, socket errors, a
 * SQLSTATE class 08 connection exception, a server shutdown) or the transaction
 * was already aborted before this unit started (25P02, in_failed_sql_transaction).
 * Continuing with the next unit of work on such a handle only produces more
 * errors that look like per-unit failures.
 */
export function isTransactionLostError(error: unknown): boolean {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code !== 'string') return false;
    return code === '25P02' || code.startsWith('08') || CONNECTION_ERROR_CODES.has(code);
}

export type SavepointResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Run `cb` as a nested unit of work on a handle that is already inside a
 * transaction (a TransactionSql, or a ReservedSql `withTx` put in a manual
 * BEGIN). When `cb` throws, only its own writes are rolled back and the error
 * comes back as a value, so a caller looping over independent units of work
 * can skip the failed one and keep the rest.
 *
 * A broken connection or an already aborted transaction ({@link
 * isTransactionLostError}) is not a failure of the unit: it is rethrown, so the
 * caller's transaction fails as a whole instead of every remaining unit being
 * skipped one by one.
 *
 * `cb` must run its queries on the handle it is given, not on `tx`. postgres.js
 * remembers any query error raised on a transaction's own handle and fails the
 * whole transaction at its end, even when the code caught that error; only the
 * savepoint scope's handle reports its errors to the savepoint instead.
 */
export async function inSavepoint<T>(
    tx: AnySql,
    cb: (savepointTx: TxSql) => Promise<T>,
): Promise<SavepointResult<T>> {
    try {
        return { ok: true, value: await withTx(tx, cb) };
    } catch (error) {
        if (isTransactionLostError(error)) throw error;
        return { ok: false, error };
    }
}
