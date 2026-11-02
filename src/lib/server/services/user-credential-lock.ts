// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { withTx } from '$lib/server/database/with-tx.js';

/**
 * Serialize password-based issuance and password replacement/revocation across
 * replicas. Keep final version checks and session writes inside this callback,
 * and use its transaction handle for PostgreSQL writes. Hashing stays outside
 * the lock so a reset can invalidate an in-flight verification or rehash.
 */
export async function withUserCredentialLock<T>(
    sql: postgres.Sql,
    userId: string,
    work: (tx: postgres.Sql) => Promise<T>,
): Promise<T> {
    return withTx(sql, async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('lumastra:user-credentials'), hashtext(${userId}))`;
        return work(tx);
    });
}
