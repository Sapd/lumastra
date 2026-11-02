// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Helper for `pg_try_advisory_xact_lock` callers.
 *
 * postgres-js does NOT auto-wrap statements in a transaction. Calling
 * `pg_try_advisory_xact_lock(...)` as a bare `SELECT` acquires the lock and
 * then releases it the instant that statement completes — so two callers
 * both observe `acquired = true` and proceed in parallel, defeating the
 * point of the lock.
 *
 * The fix is to hold the lock inside an explicit transaction so it stays
 * acquired for the full critical section. This helper does that:
 *
 *   - Opens a `sql.begin(...)` block (transaction-scoped).
 *   - Runs `pg_try_advisory_xact_lock(hashtext(<key>))` inside the tx.
 *   - On success, runs `fn(tx)` with the transaction handle so the caller's
 *     reads/writes are observed under the lock and committed atomically.
 *   - On contention (`acquired = false`), returns `{ acquired: false }`
 *     without running `fn` — the transaction commits empty.
 *   - Exceptions inside `fn` propagate, rolling back the transaction.
 *
 * Use this for any new advisory-lock site. Code already inside a `sql.begin`
 * can call `pg_try_advisory_xact_lock` directly on its `tx` handle — the
 * lock is bound to the wrapping transaction in both cases.
 */

import type postgres from 'postgres';

export type AdvisoryLockResult<T> = { acquired: true; value: T } | { acquired: false };

interface LockRow {
    acquired: boolean;
}

/**
 * Acquire a transaction-scoped advisory lock keyed on `hashtext(key)` and
 * run `fn` under it. Returns `{ acquired: false }` if another transaction
 * already holds the lock; never blocks.
 *
 * The `fn` callback receives the transaction handle as `postgres.Sql` —
 * postgres-js's `TransactionSql` type omits the call signature from its
 * declaration even though template-tag invocation works at runtime, so
 * existing call sites in this repo cast via `Sql`. We expose the same
 * shape here so callers can use template literals directly.
 *
 * @param sql - top-level postgres.js `Sql` handle (must support `.begin`)
 * @param key - string identifying the critical section; hashed to a 32-bit
 *              integer via `hashtext()` server-side
 * @param fn  - work to perform while holding the lock; receives the
 *              transaction handle so its statements observe the lock
 */
export async function withAdvisoryLock<T>(
    sql: postgres.Sql,
    key: string,
    fn: (tx: postgres.Sql) => Promise<T>,
): Promise<AdvisoryLockResult<T>> {
    // Precondition: helper opens a fresh transaction via `sql.begin`, so the
    // caller MUST pass a top-level Sql handle. postgres-js's TransactionSql
    // and ReservedSql don't expose `.begin` — passing them would throw
    // `TypeError: sql.begin is not a function` from inside the helper with
    // no context. Surface a clear error here instead.
    if (typeof (sql as unknown as { begin?: unknown }).begin !== 'function') {
        throw new Error(
            'withAdvisoryLock requires a top-level postgres.Sql handle ' +
                '(TransactionSql / ReservedSql do not support .begin). ' +
                'Call pg_try_advisory_xact_lock directly on the existing tx instead.',
        );
    }
    return sql.begin<AdvisoryLockResult<T>>(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        const rows = await tx<LockRow[]>`
            SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS acquired
        `;
        if (!rows[0]?.acquired) {
            return { acquired: false } as const;
        }
        const value = await fn(tx);
        return { acquired: true, value } as const;
    });
}
