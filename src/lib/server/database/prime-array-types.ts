// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Prime a NEW postgres.js pool so `sql.array(...)` is serialized correctly.
 *
 * postgres.js (3.4.x) fetches the array type OIDs when a pool opens its first
 * connection, but runs that connection's first queued query before it has stored
 * them. If that first query passes an untyped `sql.array(strings)`, the array goes
 * out as the text `a,b,c` and Postgres rejects it with 22P02 "malformed array
 * literal". The map is shared by the pool, so only that one query is at risk.
 *
 * Await this once after `postgres(...)` in a pool whose first query you do not
 * control (the task worker pool runs task/plugin code). The pools in
 * connection.ts send a timezone check first, which has the same effect.
 *
 * Kept free of other imports: the worker sandbox entry loads it statically.
 */
import type postgres from 'postgres';

export async function primeArrayTypes(sql: postgres.Sql): Promise<void> {
    await sql`SELECT 1`;
}
