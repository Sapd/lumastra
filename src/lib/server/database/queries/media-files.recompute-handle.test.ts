// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * recomputeHasFilesBatch must run its lock statement and its re-derive in ONE
 * transaction. Which handle it was given decides whether it opens one:
 *
 *   - bare pool                       -> opens a transaction (begin)
 *   - TransactionSql                  -> already in one, runs as is
 *   - ReservedSql inside a manual BEGIN -> already in one: a nested BEGIN/COMMIT
 *                                        would commit the caller's transaction
 *   - ReservedSql in autocommit       -> opens a manual BEGIN/COMMIT
 */
import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import { recomputeHasFilesBatch } from './media-files.queries.js';

type Kind = 'pool' | 'transaction' | 'reserved-in-begin' | 'reserved-autocommit';

function makeHandle(kind: Kind): { sql: postgres.Sql; log: string[] } {
    const log: string[] = [];

    const run = async (strings: TemplateStringsArray): Promise<unknown[]> => {
        const text = strings.join(' ');
        if (text.includes('RELEASE SAVEPOINT')) {
            log.push('PROBE_RELEASE');
            return [];
        }
        if (text.includes('SAVEPOINT')) {
            log.push('PROBE_SAVEPOINT');
            if (kind === 'reserved-autocommit') {
                // Postgres: SAVEPOINT can only be used in transaction blocks.
                throw Object.assign(new Error('no transaction block'), { code: '25P01' });
            }
            return [];
        }
        if (text.includes('FOR NO KEY UPDATE')) {
            log.push('LOCK');
            return [{ id: '00000000-0000-4000-8000-000000000001' }];
        }
        if (text.includes('UPDATE media_items')) {
            log.push('UPDATE');
            return [];
        }
        log.push(text.trim()); // BEGIN / COMMIT / ROLLBACK
        return [];
    };

    const makeTx = (): postgres.Sql => {
        const tx = vi.fn(run) as unknown as Record<string, unknown>;
        tx.savepoint = vi.fn();
        return tx as unknown as postgres.Sql;
    };

    if (kind === 'transaction') return { sql: makeTx(), log };

    const handle = vi.fn(run) as unknown as Record<string, unknown>;
    if (kind === 'pool') {
        handle.begin = async (cb: (tx: postgres.Sql) => Promise<unknown>) => {
            log.push('POOL_BEGIN');
            const result = await cb(makeTx());
            log.push('POOL_COMMIT');
            return result;
        };
    }
    return { sql: handle as unknown as postgres.Sql, log };
}

const IDS = ['00000000-0000-4000-8000-000000000002'];

describe('recomputeHasFilesBatch handle handling', () => {
    it('opens a transaction for a bare pool', async () => {
        const { sql, log } = makeHandle('pool');
        await recomputeHasFilesBatch(sql, IDS);
        expect(log).toEqual(['POOL_BEGIN', 'LOCK', 'UPDATE', 'POOL_COMMIT']);
    });

    it('runs as is inside a transaction handle', async () => {
        const { sql, log } = makeHandle('transaction');
        await recomputeHasFilesBatch(sql, IDS);
        expect(log).toEqual(['LOCK', 'UPDATE']);
    });

    it('does not nest BEGIN/COMMIT on a reserved connection already in a manual BEGIN', async () => {
        const { sql, log } = makeHandle('reserved-in-begin');
        await recomputeHasFilesBatch(sql, IDS);
        expect(log).toEqual(['PROBE_SAVEPOINT', 'PROBE_RELEASE', 'LOCK', 'UPDATE']);
    });

    it('opens a manual transaction on a reserved connection in autocommit', async () => {
        const { sql, log } = makeHandle('reserved-autocommit');
        await recomputeHasFilesBatch(sql, IDS);
        expect(log).toEqual(['PROBE_SAVEPOINT', 'BEGIN', 'LOCK', 'UPDATE', 'COMMIT']);
    });

    it('does nothing for an empty id list', async () => {
        const { sql, log } = makeHandle('pool');
        await recomputeHasFilesBatch(sql, []);
        expect(log).toEqual([]);
    });
});
