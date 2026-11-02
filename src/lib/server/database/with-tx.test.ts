// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the shared withTx helper.
 *
 * Verifies the three runtime dispatch paths:
 *   - top-level Sql        → uses .begin()
 *   - TransactionSql       → uses .savepoint()
 *   - ReservedSql          → uses manual BEGIN/COMMIT/ROLLBACK
 *
 * No real DB needed — we mock the three Sql variants directly.
 */

import { describe, it, expect, vi } from 'vitest';
import { inSavepoint, isTransactionLostError, withTx } from './with-tx.js';
import type postgres from 'postgres';

type AnySql = postgres.Sql<Record<string, never>>;

describe('withTx', () => {
    describe('top-level Sql variant', () => {
        it('dispatches to sql.begin()', async () => {
            const inner = { tag: 'tx-handle' };
            const begin = vi.fn(
                async (cb: (tx: typeof inner) => Promise<unknown>) => await cb(inner),
            );
            const fakeSql = { begin } as unknown as AnySql;

            const cb = vi.fn(async () => 'result');
            const result = await withTx(fakeSql, cb);

            expect(begin).toHaveBeenCalledTimes(1);
            expect(cb).toHaveBeenCalledWith(inner);
            expect(result).toBe('result');
        });

        it('returns whatever the callback returns', async () => {
            const begin = vi.fn(
                async (cb: (tx: unknown) => Promise<unknown>) => await cb({ tag: 'tx' }),
            );
            const fakeSql = { begin } as unknown as AnySql;

            const result = await withTx(fakeSql, async () => 42);
            expect(result).toBe(42);
        });
    });

    describe('TransactionSql variant', () => {
        it('prefers savepoint over begin when both are present', async () => {
            // postgres-js TransactionSql may inherit a non-callable `begin`
            // shape from typings, but at runtime we should always pick
            // savepoint when it is callable.
            const inner = { tag: 'savepoint-handle' };
            const savepoint = vi.fn(
                async (cb: (tx: typeof inner) => Promise<unknown>) => await cb(inner),
            );
            const begin = vi.fn();
            const fakeSql = { savepoint, begin } as unknown as AnySql;

            const cb = vi.fn(async () => 'savepoint-result');
            const result = await withTx(fakeSql, cb);

            expect(savepoint).toHaveBeenCalledTimes(1);
            expect(begin).not.toHaveBeenCalled();
            expect(cb).toHaveBeenCalledWith(inner);
            expect(result).toBe('savepoint-result');
        });

        it('uses savepoint when begin is missing', async () => {
            const savepoint = vi.fn(
                async (cb: (tx: unknown) => Promise<unknown>) => await cb({ tag: 'sp' }),
            );
            const fakeSql = { savepoint } as unknown as AnySql;

            const result = await withTx(fakeSql, async () => 'ok');
            expect(savepoint).toHaveBeenCalledTimes(1);
            expect(result).toBe('ok');
        });
    });

    describe('ReservedSql variant (no begin, no savepoint)', () => {
        /**
         * Build a tagged-template-style mock for a ReservedSql. The mock
         * records every SQL string passed to it so we can assert on the
         * BEGIN/COMMIT/ROLLBACK sequence.
         */
        function makeReservedSql(): {
            sql: AnySql;
            calls: string[];
            rollbackError?: Error;
        } {
            const calls: string[] = [];
            // The tagged-template call is `sql\`BEGIN\`` which lands here.
            const taggedTemplate = (strings: TemplateStringsArray): Promise<unknown> => {
                const text = strings.join('');
                calls.push(text);
                return Promise.resolve([]);
            };

            return {
                sql: taggedTemplate as unknown as AnySql,
                calls,
            };
        }

        it('issues BEGIN, runs the callback, then COMMIT on success', async () => {
            const { sql, calls } = makeReservedSql();

            const cb = vi.fn(async () => 'reserved-result');
            const result = await withTx(sql, cb);

            expect(cb).toHaveBeenCalledTimes(1);
            expect(cb).toHaveBeenCalledWith(sql);
            expect(calls).toEqual(['BEGIN', 'COMMIT']);
            expect(result).toBe('reserved-result');
        });

        it('issues BEGIN, then ROLLBACK if the callback throws, and re-throws the ORIGINAL error', async () => {
            const { sql, calls } = makeReservedSql();

            const original = new Error('callback exploded');
            const cb = vi.fn(async () => {
                throw original;
            });

            await expect(withTx(sql, cb)).rejects.toBe(original);

            expect(calls).toEqual(['BEGIN', 'ROLLBACK']);
        });

        it('surfaces the ORIGINAL error even if ROLLBACK itself fails', async () => {
            const calls: string[] = [];
            const rollbackErr = new Error('rollback also failed');
            const taggedTemplate = (strings: TemplateStringsArray): Promise<unknown> => {
                const text = strings.join('');
                calls.push(text);
                if (text === 'ROLLBACK') {
                    return Promise.reject(rollbackErr);
                }
                return Promise.resolve([]);
            };
            const sql = taggedTemplate as unknown as AnySql;

            const original = new Error('callback exploded');
            const cb = vi.fn(async () => {
                throw original;
            });

            // We must see the ORIGINAL error, not the rollback error.
            await expect(withTx(sql, cb)).rejects.toBe(original);

            expect(calls).toEqual(['BEGIN', 'ROLLBACK']);
        });

        it('nests with a savepoint, not a second BEGIN, so the outer COMMIT stays the only one', async () => {
            const { sql, calls } = makeReservedSql();

            const result = await withTx(sql, async (outer) => {
                await withTx(outer, async () => 'inner');
                return 'outer';
            });

            expect(result).toBe('outer');
            expect(calls).toEqual([
                'BEGIN',
                'SAVEPOINT lumastra_nested_tx',
                'RELEASE SAVEPOINT lumastra_nested_tx',
                'COMMIT',
            ]);
        });

        it('rolls a failed nested call back to its savepoint and leaves the outer transaction open', async () => {
            const { sql, calls } = makeReservedSql();

            const inner = new Error('inner failed');
            await withTx(sql, async (outer) => {
                await expect(
                    withTx(outer, async () => {
                        throw inner;
                    }),
                ).rejects.toBe(inner);
            });

            expect(calls).toEqual([
                'BEGIN',
                'SAVEPOINT lumastra_nested_tx',
                'ROLLBACK TO SAVEPOINT lumastra_nested_tx',
                'RELEASE SAVEPOINT lumastra_nested_tx',
                'COMMIT',
            ]);
        });

        it('opens a fresh BEGIN again once the outer transaction has ended', async () => {
            const { sql, calls } = makeReservedSql();

            await withTx(sql, async () => 1);
            await withTx(sql, async () => 2);

            expect(calls).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
        });

        it('returns the callback result when COMMIT succeeds', async () => {
            const { sql } = makeReservedSql();

            const result = await withTx(sql, async () => ({ id: 'abc' }));
            expect(result).toEqual({ id: 'abc' });
        });

        it('returns undefined when the callback returns undefined', async () => {
            const { sql } = makeReservedSql();

            const result = await withTx(sql, async () => undefined);
            expect(result).toBeUndefined();
        });
    });
});

describe('inSavepoint', () => {
    function reserved(): AnySql {
        const taggedTemplate = (): Promise<unknown> => Promise.resolve([]);
        return taggedTemplate as unknown as AnySql;
    }

    it('returns the value of a unit that succeeds', async () => {
        const out = await withTx(reserved(), (tx) => inSavepoint(tx, async () => 7));
        expect(out).toEqual({ ok: true, value: 7 });
    });

    it('returns an ordinary failure as a value so the caller can skip the unit', async () => {
        const boom = new Error('target slot is occupied');
        const out = await withTx(reserved(), (tx) =>
            inSavepoint(tx, async () => {
                throw boom;
            }),
        );
        expect(out).toEqual({ ok: false, error: boom });
    });

    it('keeps a constraint violation (23505) a per-unit failure', async () => {
        const dup = Object.assign(new Error('duplicate key'), { code: '23505' });
        const out = await withTx(reserved(), (tx) =>
            inSavepoint(tx, async () => {
                throw dup;
            }),
        );
        expect(out).toEqual({ ok: false, error: dup });
    });

    it.each(['25P02', 'CONNECTION_CLOSED', 'CONNECTION_DESTROYED', '08006', '57P01', 'ECONNRESET'])(
        'rethrows %s instead of reporting a failed unit',
        async (code) => {
            const lost = Object.assign(new Error('gone'), { code });
            await expect(
                withTx(reserved(), (tx) =>
                    inSavepoint(tx, async () => {
                        throw lost;
                    }),
                ),
            ).rejects.toBe(lost);
        },
    );

    it('classifies errors without a code as not lost', () => {
        expect(isTransactionLostError(new Error('x'))).toBe(false);
        expect(isTransactionLostError(null)).toBe(false);
        expect(isTransactionLostError({ code: 42 })).toBe(false);
    });
});
