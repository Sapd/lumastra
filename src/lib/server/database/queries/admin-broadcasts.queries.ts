// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin-broadcasts.queries.ts — pure SQL for `admin_broadcasts` (migration
 * 16.209.0).
 *
 * The PARENT row of an admin announcement. Each recipient's own copy is an
 * ordinary `user_notifications` row carrying `broadcast_id` back to here; those
 * live in `user-notifications.queries.ts` and are read through the normal inbox
 * path. Nothing in this module is user-scoped — every function here is reached
 * only from an `auth: {kind:'admin'}` endpoint.
 *
 * Same convention as the rest of `queries/`: `sql: postgres.Sql` first, no side
 * effects beyond the query.
 *
 * ## "Currently pinned" is a predicate, not a column
 *
 * A pin can carry a deadline, so pinned-ness is
 * `pinned_at IS NOT NULL AND (pin_expires_at IS NULL OR pin_expires_at > now())`
 * evaluated at read time. It is spelled out at each site rather than hidden in a
 * helper because the two readers that matter live in a DIFFERENT module
 * (`listNotifications`'s anti-join and `listPinnedBroadcastsForUser`), and a
 * cross-module SQL fragment would be harder to verify than the six words it
 * saves. If a third reader appears, promote it to a view.
 */

import type postgres from 'postgres';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/** Who a broadcast was addressed to when it was sent. */
export type BroadcastAudience = 'all' | 'users';

export interface AdminBroadcastRow {
    id: string;
    title: string;
    body: string | null;
    audience: BroadcastAudience;
    recipientCount: number;
    pushEnabled: boolean;
    /** When the pin was placed; null = never pinned or since unpinned. */
    pinnedAt: string | null;
    pinnedBy: string | null;
    /** Deadline for an active pin; null = pinned indefinitely. */
    pinExpiresAt: string | null;
    /**
     * Whether the pin is in force RIGHT NOW — `pinned_at` set and not past its
     * deadline. Derived server-side so no caller has to re-implement the
     * expiry comparison (and get the timezone wrong doing it).
     */
    isPinned: boolean;
    createdBy: string;
    createdAt: string;
}

type DbRow = {
    id: string;
    title: string;
    body: string | null;
    audience: string;
    recipient_count: number;
    push_enabled: boolean;
    pinned_at: Date | null;
    pinned_by: string | null;
    pin_expires_at: Date | null;
    is_pinned: boolean;
    created_by: string;
    created_at: Date;
};

function mapRow(r: DbRow): AdminBroadcastRow {
    return {
        id: r.id,
        title: r.title,
        body: r.body ?? null,
        // The CHECK constraint restricts this to the two legal values, so the
        // narrowing cast is backed by the schema rather than by hope.
        audience: r.audience as BroadcastAudience,
        recipientCount: Number(r.recipient_count),
        pushEnabled: r.push_enabled,
        pinnedAt: r.pinned_at ? r.pinned_at.toISOString() : null,
        pinnedBy: r.pinned_by ?? null,
        pinExpiresAt: r.pin_expires_at ? r.pin_expires_at.toISOString() : null,
        isPinned: r.is_pinned,
        createdBy: r.created_by,
        createdAt: r.created_at.toISOString(),
    };
}

/**
 * The projection every read in this module returns, `is_pinned` included.
 *
 * A fragment rather than a repeated column list because the three readers must
 * agree on the pin predicate exactly — a `listBroadcasts` that computed
 * pinned-ness differently from `getBroadcast` would show an admin one thing in
 * the table and another in the row they just clicked.
 */
function selectColumns(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`
        id, title, body, audience, recipient_count, push_enabled,
        pinned_at, pinned_by, pin_expires_at, created_by, created_at,
        (pinned_at IS NOT NULL AND (pin_expires_at IS NULL OR pin_expires_at > now()))
            AS is_pinned
    `;
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

export interface InsertBroadcastOpts {
    title: string;
    body?: string | null;
    audience: BroadcastAudience;
    recipientCount: number;
    pushEnabled: boolean;
    /** Pin it at creation time — `pinned_at` becomes `now()`. */
    pinned: boolean;
    /** Only meaningful when `pinned`; ISO string or Date. */
    pinExpiresAt?: string | Date | null;
    /** Username of the admin who sent it. */
    createdBy: string;
}

/**
 * Insert the parent announcement row.
 *
 * Called BEFORE any recipient copy is written, because each copy needs this
 * row's id in its `broadcast_id`. The recipient count is passed in rather than
 * counted afterwards: it records who the announcement was ADDRESSED to at send
 * time, which is the number an operator wants six months later — not how many
 * copies happen to survive after users deleted theirs.
 *
 * `pinned_by` is seeded from `createdBy` when the broadcast is pinned at
 * creation, so "who pinned this" is never NULL for a pin that exists.
 */
export async function insertBroadcast(
    sql: postgres.Sql,
    opts: InsertBroadcastOpts,
): Promise<AdminBroadcastRow> {
    const pinExpiresAt = opts.pinned
        ? opts.pinExpiresAt
            ? opts.pinExpiresAt instanceof Date
                ? opts.pinExpiresAt
                : new Date(opts.pinExpiresAt)
            : null
        : null;

    const rows = await sql<DbRow[]>`
        INSERT INTO admin_broadcasts (
            title, body, audience, recipient_count, push_enabled,
            pinned_at, pinned_by, pin_expires_at, created_by
        )
        VALUES (
            ${opts.title},
            ${opts.body ?? null},
            ${opts.audience},
            ${opts.recipientCount},
            ${opts.pushEnabled},
            ${opts.pinned ? sql`now()` : sql`NULL`},
            ${opts.pinned ? opts.createdBy : null},
            ${pinExpiresAt},
            ${opts.createdBy}
        )
        RETURNING ${selectColumns(sql)}
    `;
    // A plain INSERT with no ON CONFLICT either returns its row or throws.
    return mapRow(rows[0]);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** How many broadcasts the admin table view shows. */
const LIST_LIMIT = 100;

/**
 * Recent broadcasts, newest first — the admin table view.
 *
 * Unpaginated on purpose: this is an operator log of deliberate, low-frequency
 * actions (an install sends a handful a year, not a handful a minute), and a
 * bounded 100 keeps the page honest without a cursor nobody would page through.
 */
export async function listBroadcasts(sql: postgres.Sql): Promise<AdminBroadcastRow[]> {
    const rows = await sql<DbRow[]>`
        SELECT ${selectColumns(sql)}
        FROM admin_broadcasts
        ORDER BY created_at DESC
        LIMIT ${LIST_LIMIT}
    `;
    return rows.map(mapRow);
}

/** One broadcast by id, or null when it does not exist. */
export async function getBroadcast(
    sql: postgres.Sql,
    id: string,
): Promise<AdminBroadcastRow | null> {
    const rows = await sql<DbRow[]>`
        SELECT ${selectColumns(sql)}
        FROM admin_broadcasts
        WHERE id = ${id}::uuid
    `;
    return rows[0] ? mapRow(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Pin / unpin
// ---------------------------------------------------------------------------

export interface SetBroadcastPinOpts {
    pinned: boolean;
    /** Only read when `pinned` is true; ISO string, Date, or null = forever. */
    pinExpiresAt?: string | Date | null;
    /** Username of the admin performing the pin. */
    pinnedBy: string;
}

/**
 * Pin or unpin a broadcast. Returns the updated row, or null when the id does
 * not exist.
 *
 * ONE write, whatever the recipient count — that is the whole reason pin state
 * lives on the parent. Re-pinning an already-pinned broadcast deliberately
 * refreshes `pinned_at` and `pinned_by`: an admin re-pinning is asserting the
 * announcement is current again, and the pinned block is ordered by
 * `pinned_at DESC`, so a re-pin is how they move it to the top.
 *
 * Unpinning clears all THREE columns rather than just `pinned_at`. Leaving a
 * stale `pin_expires_at` behind would violate `admin_broadcasts_pin_coherent`
 * outright; leaving a stale `pinned_by` would misattribute the next pin's
 * history to whoever placed the previous one.
 */
export async function setBroadcastPin(
    sql: postgres.Sql,
    id: string,
    opts: SetBroadcastPinOpts,
): Promise<AdminBroadcastRow | null> {
    const pinExpiresAt = opts.pinExpiresAt
        ? opts.pinExpiresAt instanceof Date
            ? opts.pinExpiresAt
            : new Date(opts.pinExpiresAt)
        : null;

    const rows = await sql<DbRow[]>`
        UPDATE admin_broadcasts
        SET pinned_at      = ${opts.pinned ? sql`now()` : sql`NULL`},
            pinned_by      = ${opts.pinned ? opts.pinnedBy : null},
            pin_expires_at = ${opts.pinned ? pinExpiresAt : null}
        WHERE id = ${id}::uuid
        RETURNING ${selectColumns(sql)}
    `;
    return rows[0] ? mapRow(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Delete a broadcast, and with it every recipient's copy.
 *
 * The cascade is the point, not a side effect: a sent broadcast's TEXT is
 * immutable (there is no edit endpoint, by product decision), so deleting the
 * parent is the only retraction this feature offers. `user_notifications
 * .broadcast_id` is `ON DELETE CASCADE`, so one statement pulls the
 * announcement out of every inbox it reached.
 *
 * Returns true when a row was actually removed, so a caller can answer 404
 * rather than reporting a successful delete of nothing.
 */
export async function deleteBroadcast(sql: postgres.Sql, id: string): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
        DELETE FROM admin_broadcasts
        WHERE id = ${id}::uuid
        RETURNING id
    `;
    return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Recipient resolution
// ---------------------------------------------------------------------------

export interface BroadcastRecipient {
    id: string;
    username: string;
}

/**
 * Every account eligible to receive a broadcast: not soft-deleted, not
 * suspended.
 *
 * `deleted_at`/`disabled_at` are the real column names on `users` (both
 * `timestamptz`, NULL meaning "not deleted" / "not disabled") — there is no
 * boolean `deleted`/`disabled` column on that table, though the admin API's
 * `LocalUser` DTO projects `disabled_at IS NOT NULL` as a boolean `disabled`.
 *
 * A disabled account is excluded rather than merely skipped at push time: it
 * cannot log in by any path, so a durable inbox row for it would be unreadable
 * forever, and it would inflate `recipient_count` with deliveries that never
 * had a reader.
 */
export async function listBroadcastRecipients(sql: postgres.Sql): Promise<BroadcastRecipient[]> {
    const rows = await sql<{ id: string; username: string }[]>`
        SELECT id, username
        FROM users
        WHERE deleted_at IS NULL
          AND disabled_at IS NULL
        ORDER BY username ASC
    `;
    return rows.map((r) => ({ id: r.id, username: r.username }));
}

/**
 * The subset of `ids` that names an eligible recipient.
 *
 * Returns only the FOUND rows; the caller diffs against what it asked for and
 * rejects the request naming the unknown ids, rather than silently delivering
 * to a smaller audience than the admin selected. Silently dropping is the
 * failure mode this shape exists to prevent: an admin who picked twelve people
 * and reached nine would have no way to notice.
 *
 * An empty `ids` array short-circuits — `IN ()` is a syntax error in Postgres,
 * and `= ANY('{}')` would work but the round trip is pointless.
 */
export async function listBroadcastRecipientsByIds(
    sql: postgres.Sql,
    ids: readonly string[],
): Promise<BroadcastRecipient[]> {
    if (ids.length === 0) return [];
    const rows = await sql<{ id: string; username: string }[]>`
        SELECT id, username
        FROM users
        WHERE id = ANY(${ids as string[]}::uuid[])
          AND deleted_at IS NULL
          AND disabled_at IS NULL
        ORDER BY username ASC
    `;
    return rows.map((r) => ({ id: r.id, username: r.username }));
}
