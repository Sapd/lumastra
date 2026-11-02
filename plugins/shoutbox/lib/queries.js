// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { RATE_LIMIT_LOCK_NAMESPACES, withUserRateLimitLock } from './rate-limit-lock.js';

/**
 * `userId` is optional here and required in {@link insertUserMessageRateLimited}
 * on purpose: this is the path the AI author uses, and `author_kind = 'ai'` rows
 * have no owning user. A human message must never take this path.
 *
 * @param {import('postgres').Sql} sql
 * @param {{userId?:string|null,username:string,userGroup:string|null,body:string,authorKind:'user'|'ai',replyTo:string|null}} m
 */
export function insertMessage(sql, m) {
    return sql`
        INSERT INTO shoutbox_messages (user_id, username, user_group, author_kind, reply_to, body)
        VALUES (${m.userId ?? null}, ${m.username}, ${m.userGroup}, ${m.authorKind}, ${m.replyTo}, ${m.body})
        RETURNING id, user_id, username, user_group, author_kind, reply_to, body, created_at
    `;
}

/**
 * Insert a user message only if the author is still under their per-window post
 * limit. Returns the inserted row, or `null` when the limit was already reached.
 *
 * The cap holds under concurrency because the whole check-and-insert runs
 * inside a transaction holding a per-user advisory lock — see
 * {@link withUserRateLimitLock}, which carries the full argument. The
 * conditional INSERT alone does NOT hold: everything in one statement reads one
 * READ COMMITTED snapshot, taken before any concurrent inserter has committed,
 * so N posts on N connections all counted the same pre-insert state and all N
 * landed (measured: 12/12 against a cap of 3). The statement stays conditional
 * anyway — under the lock it is what actually does the counting.
 *
 * The window is counted on `user_id`, not `username`. Counting by name meant a
 * rename reset someone's budget mid-window, and — worse — two accounts whose
 * handles fold to the same string shared one budget.
 *
 * @param {import('postgres').Sql} sql
 * @param {{userId:string,username:string,userGroup:string|null,body:string,replyTo:string|null,limit:number,windowSeconds:number}} m
 */
export async function insertUserMessageRateLimited(sql, m) {
    const limit = Math.max(0, Math.trunc(Number(m.limit) || 0));
    const windowSeconds = Math.max(1, Math.trunc(Number(m.windowSeconds) || 0));
    const rows = await withUserRateLimitLock(
        sql,
        RATE_LIMIT_LOCK_NAMESPACES.post,
        m.userId,
        (tx) => tx`
            INSERT INTO shoutbox_messages (user_id, username, user_group, author_kind, reply_to, body)
            SELECT ${m.userId}, ${m.username}, ${m.userGroup}, 'user', ${m.replyTo}, ${m.body}
            WHERE (
                SELECT count(*) FROM shoutbox_messages
                WHERE user_id = ${m.userId} AND author_kind = 'user'
                  AND created_at > now() - make_interval(secs => ${windowSeconds})
            ) < ${limit}
            RETURNING id, user_id, username, user_group, author_kind, reply_to, body, created_at
        `,
    );
    return rows?.[0] ?? null;
}

/**
 * How long an invocation row may live past the window it was written for.
 *
 * The table answers exactly one question — "how many times did this user
 * invoke the AI inside the last `windowSeconds`" — so a row older than that
 * window is already unreadable by every query that exists. Keeping it anyway
 * turned a rate-limit counter into a permanent, exactly-timestamped record of
 * when a named person talked to the bot, growing for the life of the account.
 *
 * Two hours, against the one hour `ai.js` actually asks for: the margin costs
 * a handful of rows and buys tolerance for clock skew between replicas and for
 * a caller whose window is a little longer than the bot's. **This must stay
 * >= the largest `windowSeconds` any caller passes** — {@link retentionFor}
 * enforces that per call, and the floor below guards the standalone prune,
 * which has no caller window to consult.
 */
export const AI_INVOCATION_RETENTION_SECONDS = 7200;

/**
 * Retention for a caller working to `windowSeconds`: never shorter than the
 * floor, and never shorter than the caller's own window, so pruning cannot
 * reach a row the cap still has to count.
 *
 * @param {number} windowSeconds
 */
function retentionFor(windowSeconds) {
    return Math.max(AI_INVOCATION_RETENTION_SECONDS, windowSeconds * 2);
}

/**
 * Reserve one AI-invocation slot for a user within the current rolling window.
 * Returns `true` when a slot was reserved — the caller may proceed to spend an
 * AI call — or `false` when the asker is already at `aiRateLimitPerHour` for
 * the window, in which case the caller MUST NOT call the AI backend.
 *
 * Serialised per user by the same advisory lock {@link insertUserMessageRateLimited}
 * uses, for the same reason: the conditional INSERT alone reads one snapshot
 * for the whole statement, so two concurrent bot mentions from one user both
 * counted zero and both reserved. See {@link withUserRateLimitLock}.
 *
 * security review 2026-09-13, C25: the shoutbox plugin declared
 * `aiRateLimitPerHour` but nothing ever enforced it — the host's daily TOKEN
 * budget (assistant-service.ts) was the only ceiling, so one user mentioning
 * the bot in a tight loop could burn through it before anyone else got a
 * turn. This table exists solely to make that cap real.
 *
 * Also prunes rows past {@link AI_INVOCATION_RETENTION_SECONDS} on the way
 * past — a data-modifying CTE in the same statement as the INSERT, so the lock
 * costs one round trip rather than two on a path that is about to spend an AI
 * call (and the AI call dwarfs both), and the delete runs
 * even when the reservation is refused (Postgres runs a data-modifying WITH
 * clause to completion regardless of whether the primary query reads its
 * output). The caller's verdict is untouched: the prune only removes rows
 * OUTSIDE the window and the cap only counts rows INSIDE it, so a pruned row
 * could never have been counted. {@link pruneAiInvocations} is the standalone
 * form, for installs where this path stops running.
 *
 * @param {import('postgres').Sql} sql
 * @param {{userId:string, limit:number, windowSeconds:number}} m
 * @returns {Promise<boolean>}
 */
export async function reserveAiInvocation(sql, m) {
    const limit = Math.max(0, Math.trunc(Number(m.limit) || 0));
    const windowSeconds = Math.max(1, Math.trunc(Number(m.windowSeconds) || 0));
    const retentionSeconds = retentionFor(windowSeconds);
    const rows = await withUserRateLimitLock(
        sql,
        RATE_LIMIT_LOCK_NAMESPACES.ai,
        m.userId,
        (tx) => tx`
            WITH pruned AS (
                DELETE FROM shoutbox_ai_invocations
                 WHERE created_at < now() - make_interval(secs => ${retentionSeconds})
            )
            INSERT INTO shoutbox_ai_invocations (user_id)
            SELECT ${m.userId}
            WHERE (
                SELECT count(*) FROM shoutbox_ai_invocations
                WHERE user_id = ${m.userId}
                  AND created_at > now() - make_interval(secs => ${windowSeconds})
            ) < ${limit}
            RETURNING id
        `,
    );
    return (rows?.length ?? 0) > 0;
}

/**
 * Delete invocation rows past retention, globally. Returns how many went.
 *
 * {@link reserveAiInvocation} already prunes as it reserves — in the same
 * statement, as a data-modifying CTE, so a path that is about to spend an AI
 * call pays no extra round trip — which bounds the table on any install where
 * the bot is still used. This standalone form covers the case that path cannot:
 * an install where the AI was switched off, or nobody mentions the bot any
 * more, and the last rows written would otherwise sit there indefinitely. The
 * plugin calls it from `onStartup`, so every restart collects them.
 *
 * `retentionSeconds` is clamped UP to {@link AI_INVOCATION_RETENTION_SECONDS}:
 * a caller asking for a shorter retention would be asking to delete rows a
 * live rate-limit window still counts, which is the one thing pruning must
 * never do.
 *
 * @param {import('postgres').Sql} sql
 * @param {number} [retentionSeconds]
 * @returns {Promise<number>} rows deleted
 */
export async function pruneAiInvocations(sql, retentionSeconds) {
    const secs = Math.max(
        AI_INVOCATION_RETENTION_SECONDS,
        Math.trunc(Number(retentionSeconds) || 0),
    );
    // No RETURNING: `count` comes from the command tag, so the first prune on
    // an install that already accumulated rows does not ship every id back.
    const res = await sql`
        DELETE FROM shoutbox_ai_invocations
         WHERE created_at < now() - make_interval(secs => ${secs})
    `;
    return res?.count ?? 0;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Shape a stored row for the wire.
 *
 * **Drops `user_id` and replaces it with `mine`.** Every reader of the room
 * receives every message, so spreading the raw row would hand each of them the
 * stable account id of everyone who has ever posted — a fresh identifier the
 * chat never needed to expose. The client only has to know which rows IT may
 * delete, and that is one boolean the server can answer.
 *
 * @param {Record<string, unknown>} row
 * @param {string|null|undefined} viewerId
 */
export function toWireMessage(row, viewerId) {
    const { user_id: ownerId, ...rest } = row;
    return {
        ...rest,
        // NULL owner (legacy unattributable row, or an AI post) is nobody's,
        // so it is never `mine` — matching softDeleteOwn, which cannot match
        // it either.
        mine: Boolean(viewerId) && ownerId === viewerId,
    };
}

/** @param {import('postgres').Sql} sql @param {number} limit */
export async function listRecent(sql, limit) {
    // Clamp before the query: undefined/null binds as `LIMIT NULL` (= no limit,
    // unbounded scan) and a negative value raises "LIMIT must not be negative".
    // Coerce both into a bounded, positive page size.
    const safe =
        Number.isFinite(limit) && limit > 0
            ? Math.min(Math.trunc(limit), MAX_LIMIT)
            : DEFAULT_LIMIT;
    const rows = await sql`
        SELECT id, user_id, username, user_group, author_kind, reply_to, body, created_at
        FROM shoutbox_messages
        WHERE deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT ${safe}
    `;
    return rows.reverse(); // newest-last for chat display
}

/** @param {import('postgres').Sql} sql @param {string} id */
export async function getById(sql, id) {
    const [row] = await sql`
        SELECT id, user_id, username, user_group, author_kind, reply_to, body, created_at
        FROM shoutbox_messages WHERE id = ${id} AND deleted_at IS NULL
    `;
    return row ?? null;
}

/** @param {import('postgres').Sql} sql @param {string} id */
export function softDelete(sql, id) {
    return sql`UPDATE shoutbox_messages SET deleted_at = now() WHERE id = ${id} AND deleted_at IS NULL`;
}

/**
 * Author-scoped soft delete — the self-service half of moderation.
 *
 * Ownership is enforced inside the UPDATE rather than by a read-then-write, so
 * there is no window between checking who owns a message and deleting it.
 *
 * **Ownership is `user_id`, never `username`.** The earlier version matched on
 * the handle, which meant a freed and reassigned name — account deleted and
 * recreated, or an IdP rename releasing the old handle — handed the new holder
 * delete rights over the previous holder's messages. `user_id` is stable for
 * the life of the account and is what the FK cascades on.
 *
 * `author_kind = 'user'` is still required: it stops a user deleting an AI or
 * system row, which have no owning `user_id` but do carry a display name.
 *
 * A NULL `user_id` — a historical row whose username no longer resolved during
 * backfill, or one that was ambiguous — can never match, because SQL equality
 * against NULL is never true. That is the intended outcome: an unattributable
 * message is removable by moderators only, never claimable.
 *
 * @returns {Promise<boolean>} true if a row was deleted. False means "not
 *   yours, does not exist, or already deleted" — the caller must not
 *   distinguish those, since telling a user which of the three it was leaks the
 *   existence of other people's messages by id.
 *
 * @param {import('postgres').Sql} sql
 * @param {string} id
 * @param {string} userId
 */
export async function softDeleteOwn(sql, id, userId) {
    if (!userId) return false;
    const rows = await sql`
        UPDATE shoutbox_messages
           SET deleted_at = now()
         WHERE id = ${id}
           AND user_id = ${userId}
           AND author_kind = 'user'
           AND deleted_at IS NULL
        RETURNING id
    `;
    return rows.length > 0;
}

/** Count a user's posts in the last `seconds` (rate limiting). */
export async function countRecentByUser(sql, userId, seconds) {
    // `make_interval(secs => ...)` takes a numeric argument directly. The prior
    // `(${seconds} || ' seconds')::interval` bound `seconds` as an int4 param and
    // `integer || unknown` has no operator overload -> runtime error on every call.
    // Floor at 1s so a 0/negative window can't silently disable the rate limiter.
    //
    // Keyed on user_id to match insertUserMessageRateLimited, which is what the
    // POST route actually enforces with. Leaving one counter on username beside
    // a limiter on user_id is precisely how the two drift apart later.
    const s = Math.max(1, Math.trunc(Number(seconds) || 0));
    const [{ n }] = await sql`
        SELECT count(*)::int AS n FROM shoutbox_messages
        WHERE user_id = ${userId} AND author_kind = 'user'
          AND created_at > now() - make_interval(secs => ${s})
    `;
    return n;
}
