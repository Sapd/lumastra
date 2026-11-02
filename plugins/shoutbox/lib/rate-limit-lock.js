// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Per-user serialisation for the shoutbox's two rate limiters.
 *
 * ── Why a lock at all ────────────────────────────────────────────────────────
 *
 * Both limiters used to be a single statement of the shape
 *
 *     INSERT INTO t (...) SELECT ...
 *      WHERE (SELECT count(*) FROM t WHERE user_id = $1 AND created_at > ...) < $2
 *
 * and were documented as closing the check-then-act race because the count was
 * re-evaluated "inside the same statement". It is — but *a statement is one
 * snapshot*. Under READ COMMITTED (the default, and what postgres.js uses) the
 * snapshot is taken once at statement start and every part of the statement,
 * the counting subquery included, reads it. Rows another transaction commits
 * after that instant are invisible for the whole statement. So N reserves
 * arriving on N separate connections each count the same pre-insert state and
 * all N insert.
 *
 * Measured on PostgreSQL 18, 12 dedicated connections, cap of 3: the
 * conditional INSERT granted 12/12 — identical to a naive `SELECT count(*)`
 * then `INSERT`. The statement bought nothing over the check-then-act it
 * replaced.
 *
 * ── Why THIS lock ────────────────────────────────────────────────────────────
 *
 * A transaction-scoped advisory lock keyed on the user is the cheapest fix that
 * changes no observable behaviour:
 *
 *   - It keeps the window ROLLING. A uniqueness constraint the INSERT could
 *     conflict against (a generated per-window bucket column + `ON CONFLICT DO
 *     NOTHING`) is lock-free, but it quantises the window into fixed buckets,
 *     which lets a user spend a full cap either side of a boundary — 2x the
 *     intended burst — and it changes the table shape.
 *   - It needs no retry loop. SERIALIZABLE would also hold, but every caller
 *     then has to handle 40001 and re-drive, and it cannot set an isolation
 *     level when it is nested inside somebody else's transaction.
 *   - It serialises per USER, not globally: two people posting at once never
 *     wait on each other, because the lock key carries the user id.
 *
 * The lock is acquired in its OWN statement before the INSERT, and that is
 * load-bearing. Folding `pg_advisory_xact_lock(...)` into the INSERT as a CTE
 * would not work at any CTE position: the whole statement still shares the one
 * snapshot taken before the lock was ever held, so the count would read
 * pre-lock state exactly as it does today. Only a *subsequent* statement gets a
 * fresh snapshot — and by then the previous holder has committed, because an
 * xact-scoped lock is released at commit.
 *
 * ── Blocking, not `try` ──────────────────────────────────────────────────────
 *
 * `pg_advisory_xact_lock`, not `pg_try_advisory_xact_lock`. Contention and
 * "over your limit" are different answers and must not be conflated: a `try`
 * that gave up on contention would refuse callers who are well under their cap,
 * capping a busy user at 1 rather than `limit` and reading as "safe" while
 * quietly costing everyone their budget. The critical section is a single
 * INSERT, so waiters queue for microseconds; the queue is per user, so a user
 * hammering the endpoint delays only themselves.
 */

/**
 * Advisory-lock namespaces. The two-argument `pg_advisory_xact_lock(int, int)`
 * key space is shared process-wide, so each lock site needs a namespace nobody
 * else uses — `migration-system.ts` holds 4242. The two limiters take separate
 * namespaces so an AI reservation never queues behind the same user's post.
 */
const POST_LOCK_NS = 823_417_001;
const AI_LOCK_NS = 823_417_002;

export const RATE_LIMIT_LOCK_NAMESPACES = Object.freeze({
    post: POST_LOCK_NS,
    ai: AI_LOCK_NS,
});

/**
 * Run `fn` holding the per-user advisory lock for `namespace`, inside a
 * transaction, and hand `fn` the transaction handle so its statements are the
 * ones the lock actually covers.
 *
 * When `sql` is already a transaction handle (postgres.js exposes `savepoint`
 * but not `begin` on those) the work runs directly on it: an xact-scoped lock
 * taken there binds to the caller's transaction, which is still correct — it is
 * simply held until their commit rather than ours.
 *
 * @template T
 * @param {import('postgres').Sql} sql
 * @param {number} namespace one of {@link RATE_LIMIT_LOCK_NAMESPACES}
 * @param {string} userId
 * @param {(tx: import('postgres').Sql) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withUserRateLimitLock(sql, namespace, userId, fn) {
    const locked = async (/** @type {import('postgres').Sql} */ tx) => {
        // hashtext() maps the uuid text to the int4 the two-arg form wants.
        // A hash collision between two user ids costs those two users a shared
        // queue for a few microseconds and nothing else — the cap itself is
        // still counted on the real user_id inside the INSERT.
        await tx`SELECT pg_advisory_xact_lock(${namespace}::int, hashtext(${userId})::int)`;
        return fn(tx);
    };
    if (typeof (/** @type {{begin?:unknown}} */ (sql).begin) !== 'function') {
        return locked(sql);
    }
    // postgres.js types the transaction handle as `TransactionSql`, which omits
    // the call signature and the `.begin` that `Sql` carries even though
    // template-tag invocation works on it at runtime; `withAdvisoryLock` in the
    // host tree casts the same way. `UnwrapPromiseArray` on the return is a
    // no-op for us — it only unwraps when the callback resolves to an array OF
    // promises, and ours resolves to a postgres.js result array.
    return /** @type {Promise<T>} */ (
        sql.begin((tx) =>
            locked(/** @type {import('postgres').Sql} */ (/** @type {unknown} */ (tx))),
        )
    );
}
