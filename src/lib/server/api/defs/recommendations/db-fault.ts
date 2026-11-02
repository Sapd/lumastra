// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared classifier for "is this a genuine Postgres fault?" — used by every
 * recommendation strategy catch-all (and by `runRecommender`'s own catch-all)
 * to decide whether an uncaught error should be reported as
 * `DependencyUnavailableError` (503 / dropped `/feed` section) instead of
 * silently downgraded to a status-less `{ items: [], hasMore: false }`.
 *
 * Originally introduced in `ai.strategy.ts` (94688ec18) to fix the
 * `sql.array()` type-OID race: it threw "op ANY/ALL (array) requires array on
 * right side" on a cold connection pool, the old catch-all swallowed it, and
 * `getTasteRailPage` (for-you/taste.ts) defaulted the resulting status-less
 * result to `status: 'ready'` — a hard DB failure rendered as a legitimately-
 * empty rail with no error and nothing retriable. Extracted here so every
 * strategy (and `runRecommender`'s own top-level catch, which is the last
 * line of defense for strategies that don't classify their own errors) shares
 * ONE definition of "is this a DB fault" instead of drifting copies.
 */

import postgres from 'postgres';

/**
 * Connection-level fault codes the `postgres` driver throws as a plain
 * `Error` with a `.code` (distinct from `postgres.PostgresError`, which
 * covers RESULT errors from a live connection — e.g. the `sql.array()`
 * type-OID race described above). Both shapes mean "the database interaction
 * failed", not "genuinely nothing to show" — see `isGenuineDbFault`.
 */
const POSTGRES_CONNECTION_ERROR_CODES = new Set([
    'CONNECTION_CLOSED',
    'CONNECTION_ENDED',
    'CONNECTION_DESTROYED',
    'CONNECT_TIMEOUT',
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
]);

/**
 * True for an error that originated from the Postgres client itself — a
 * query fault (`postgres.PostgresError`) or a connection fault (a
 * driver-thrown `Error` carrying one of `POSTGRES_CONNECTION_ERROR_CODES`).
 *
 * This exists so a strategy's (or `runRecommender`'s) catch-all can classify
 * a genuine database fault as dependency-down instead of silently downgrading
 * it to `{ items: [], hasMore: false }` — the exact shape that let the
 * `sql.array()` type-OID race go unnoticed in production (see module docs
 * above).
 *
 * Deliberately NARROW: this is not a general "should this be retried?"
 * classifier (see `$lib/server/utils/transient-pg.ts` for that — it also
 * covers deadlocks/serialization failures/resource exhaustion, which are
 * genuinely retryable but are not what this function is for). Here, ANY
 * `postgres.PostgresError` counts — a query fault talking to a live
 * connection is still a DB fault, not a programming bug in the strategy —
 * plus a small, explicit set of connection-lifecycle codes. Everything else
 * (TypeError, a bug in the strategy's own mapping/filtering code, etc.) is
 * NOT a DB fault and must keep degrading to an empty result — see
 * `runRecommender`'s and each strategy's catch-all for that boundary.
 */
export function isGenuineDbFault(err: unknown): boolean {
    if (err instanceof postgres.PostgresError) return true;
    return (
        err instanceof Error &&
        'code' in err &&
        typeof (err as { code?: unknown }).code === 'string' &&
        POSTGRES_CONNECTION_ERROR_CODES.has((err as { code: string }).code)
    );
}
