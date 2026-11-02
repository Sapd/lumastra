// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import {
    AuthorityError,
    AuthorityStore,
    TASK_AUTHORITY_PARTITION,
    type AuthorityToken,
} from './store.js';

/**
 * Fence an existing task SQL writer using the authority captured by its caller.
 * Every query must use the supplied handle and finish before the callback returns.
 * Never resolve a missing token from the current owner: deferred writes belong to
 * their original generation. Tokenless compatibility ends once tasks are managed.
 */
export async function withExistingTaskWrite<T>(
    sql: postgres.Sql,
    authority: AuthorityToken | undefined,
    mutate: (tx: postgres.Sql | postgres.TransactionSql) => Promise<T>,
): Promise<T> {
    const store = new AuthorityStore(sql);
    if (authority === undefined) return store.withUnmanagedWrite(mutate);
    if (!authority || authority.partition !== TASK_AUTHORITY_PARTITION)
        throw new AuthorityError('invalid');
    return store.withExistingWrite(authority, mutate, { allowDraining: true });
}
