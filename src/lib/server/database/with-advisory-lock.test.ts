// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for `withAdvisoryLock`.
 *
 * The helper's only job is to run a `pg_try_advisory_xact_lock` inside a
 * `sql.begin` transaction and dispatch to the caller's `fn` based on the
 * boolean result. We mock `sql.begin` directly — no real DB needed.
 */

import { describe, it, expect, vi } from 'vitest';
import { withAdvisoryLock } from './with-advisory-lock.js';
import type postgres from 'postgres';

type AnySql = postgres.Sql<Record<string, never>>;

/**
 * Build a fake `Sql` whose `.begin(cb)` invokes `cb` with a fake `tx` whose
 * template-tag invocation returns the rows produced by `lockResultRows`.
 * Records every template-tagged call against `tx` in `txCalls` so tests can
 * assert what SQL the helper executed.
 */
function makeFakeSql(opts: { lockResultRows: Array<{ acquired: boolean }>; fnCalls?: string[] }) {
    const txCalls: string[] = [];
    let lockCallNumber = 0;

    const tx = vi.fn((strings: TemplateStringsArray) => {
        const stmt = strings.join('?');
        txCalls.push(stmt);
        if (stmt.includes('pg_try_advisory_xact_lock')) {
            lockCallNumber += 1;
            return Promise.resolve([opts.lockResultRows[lockCallNumber - 1]]);
        }
        opts.fnCalls?.push(stmt);
        return Promise.resolve([]);
    }) as unknown as postgres.Sql;

    const begin = vi.fn(async <T>(cb: (tx: postgres.Sql) => Promise<T>): Promise<T> => cb(tx));

    const sql = { begin } as unknown as AnySql;
    return { sql, tx, txCalls, begin };
}

describe('withAdvisoryLock', () => {
    it('runs fn and returns { acquired: true, value } on success', async () => {
        const { sql, begin } = makeFakeSql({
            lockResultRows: [{ acquired: true }],
        });

        const fn = vi.fn(async () => 'work-result');
        const result = await withAdvisoryLock(sql, 'my-key', fn);

        expect(begin).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ acquired: true, value: 'work-result' });
    });

    it('issues SELECT pg_try_advisory_xact_lock(hashtext(<key>)) under the tx', async () => {
        const { sql, txCalls } = makeFakeSql({
            lockResultRows: [{ acquired: true }],
        });

        await withAdvisoryLock(sql, 'critical-section', async () => undefined);

        // First call inside the tx is the lock acquisition statement.
        expect(txCalls[0]).toContain('pg_try_advisory_xact_lock');
        expect(txCalls[0]).toContain('hashtext');
    });

    it('returns { acquired: false } without running fn on contention', async () => {
        const { sql } = makeFakeSql({
            lockResultRows: [{ acquired: false }],
        });

        const fn = vi.fn(async () => 'should-not-run');
        const result = await withAdvisoryLock(sql, 'busy-key', fn);

        expect(fn).not.toHaveBeenCalled();
        expect(result).toEqual({ acquired: false });
    });

    it('propagates exceptions from fn (transaction rolls back)', async () => {
        // sql.begin() with a throwing callback rejects with the same error,
        // which is the postgres-js rollback contract. We model that here.
        const begin = vi.fn(async <T>(cb: (tx: postgres.Sql) => Promise<T>): Promise<T> => {
            const fakeTx = ((strings: TemplateStringsArray) => {
                if (strings.join('?').includes('pg_try_advisory_xact_lock')) {
                    return Promise.resolve([{ acquired: true }]);
                }
                return Promise.resolve([]);
            }) as unknown as postgres.Sql;
            return cb(fakeTx);
        });
        const sql = { begin } as unknown as AnySql;

        const boom = new Error('inner work blew up');
        await expect(
            withAdvisoryLock(sql, 'key', async () => {
                throw boom;
            }),
        ).rejects.toBe(boom);
    });

    it('propagates errors thrown by sql.begin itself', async () => {
        const beginErr = new Error('begin failed');
        const begin = vi.fn(async () => {
            throw beginErr;
        });
        const sql = { begin } as unknown as AnySql;

        const fn = vi.fn(async () => 'never');
        await expect(withAdvisoryLock(sql, 'key', fn)).rejects.toBe(beginErr);
        expect(fn).not.toHaveBeenCalled();
    });

    it('throws a clear precondition error if sql has no .begin (TransactionSql / ReservedSql)', async () => {
        // Top-level Sql has .begin; TransactionSql has .savepoint instead;
        // ReservedSql has neither. Passing either should fail loudly rather
        // than throw a cryptic TypeError from inside the helper.
        const noBeginSql = { savepoint: () => undefined } as unknown as AnySql;

        const fn = vi.fn(async () => 'never');
        await expect(withAdvisoryLock(noBeginSql, 'k', fn)).rejects.toThrow(
            /requires a top-level postgres\.Sql handle/,
        );
        expect(fn).not.toHaveBeenCalled();
    });

    it('passes the tx handle to fn so its statements observe the lock', async () => {
        const fnCalls: string[] = [];
        const { sql, tx } = makeFakeSql({
            lockResultRows: [{ acquired: true }],
            fnCalls,
        });

        await withAdvisoryLock(sql, 'key', async (txHandle) => {
            // The fn receives the SAME transaction handle the helper used
            // for the lock acquisition; running statements against it keeps
            // them inside the same transaction.
            expect(txHandle).toBe(tx);
            await (txHandle as unknown as postgres.Sql)`UPDATE foo SET x = 1`;
        });

        expect(fnCalls).toEqual(['UPDATE foo SET x = 1']);
    });
});
