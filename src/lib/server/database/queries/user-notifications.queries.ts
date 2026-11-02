// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * user-notifications.queries.ts — pure SQL for `user_notifications`.
 *
 * D11-Events (plans/api-v1-adjacent-surfaces.md §D11-Events B):
 * The durable notifications inbox. SSE frames with `persist:true` write a row
 * here; reads come from GET /api/v1/notifications and GET …/unread-count.
 *
 * Each function takes `sql: postgres.Sql` as its first param and has no
 * side effects beyond the query (same convention as admin-audit.queries.ts).
 */

import type postgres from 'postgres';
import { KIND_REQUEST_AVAILABLE } from '$lib/shared/user-event-kinds.js';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface UserNotificationRow {
    id: string;
    userId: string;
    kind: string;
    payload: Record<string, unknown> | null;
    readAt: string | null;
    createdAt: string;
    expiresAt: string | null;
}

type DbRow = {
    id: string;
    user_id: string;
    kind: string;
    payload: Record<string, unknown> | null;
    read_at: Date | null;
    created_at: Date;
    expires_at: Date | null;
};

function mapRow(r: DbRow): UserNotificationRow {
    return {
        id: r.id,
        userId: r.user_id,
        kind: r.kind,
        payload: r.payload ?? null,
        readAt: r.read_at ? r.read_at.toISOString() : null,
        createdAt: r.created_at.toISOString(),
        expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
    };
}

/** A `user_notifications` row joined to its parent broadcast's pin timestamp. */
type PinnedDbRow = DbRow & { pinned_at: Date | null };

/**
 * Map a row that carries pin state — see {@link PinnedNotificationRow}.
 *
 * Shared by BOTH queries that surface a pin (`getNotificationForUser` and
 * `listPinnedBroadcastsForUser`) so the `pinned_at → pinnedAt/isPinned`
 * derivation exists exactly once. It is factored out rather than inlined
 * because the second reader is precisely where it went missing: the pinned
 * block originally selected the base columns only and returned a plain
 * `UserNotificationRow`, so every row in `GET /notifications`'s `pinned` array
 * arrived without `pinnedAt` and a client reading "pinned iff `pinnedAt` is
 * present" saw an ordinary notification.
 */
function mapPinnedRow(r: PinnedDbRow): PinnedNotificationRow {
    const pinnedAt = r.pinned_at ? r.pinned_at.toISOString() : null;
    return { ...mapRow(r), pinnedAt, isPinned: pinnedAt !== null };
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

export interface InsertNotificationOpts {
    userId: string;
    kind: string;
    payload?: Record<string, unknown> | null;
    /** ISO string or Date; NULL keeps the row indefinitely. */
    expiresAt?: string | Date | null;
    /**
     * The `admin_broadcasts` row this notification is one recipient copy of.
     *
     * A real COLUMN rather than a payload field (migration 16.209.0), because
     * the pin state it carries has to be joinable: the inbox list anti-joins on
     * it to hide a currently-pinned row from the paginated body, and a
     * `payload->>'broadcastId'` extraction could not be indexed for that without
     * making the client-facing payload shape load-bearing — the exact mistake
     * `coalesce_key` exists to avoid (see migration 16.191.0's rationale).
     *
     * NULL for every other kind.
     */
    broadcastId?: string | null;
}

/**
 * Outcome of an insert attempt.
 *
 * Discriminated rather than `Row | null` because the caller's two branches are
 * genuinely different decisions, not a presence check: `inserted: false` means
 * "the coalescing index already holds a row for this (user, kind, subject, day)
 * — somebody else is delivering it", and that is what suppresses the duplicate
 * live frame in `publishUserEvent`. A thrown error means something else
 * entirely (see the failure-vs-conflict note there) and never reaches here.
 */
export type InsertNotificationResult =
    { inserted: true; row: UserNotificationRow } | { inserted: false; row: null };

/**
 * Insert a single notification row.
 *
 * `ON CONFLICT DO NOTHING` — deliberately untargeted. Inferring
 * `user_notifications_coalesce_daily_uniq` would mean restating its expression
 * list (`… , ((created_at AT TIME ZONE 'UTC')::date)) WHERE coalesce_key IS NOT
 * NULL`) byte-exact here, which is the restatement the migration's own rationale
 * argues against; the bare form needs no inference and stays correct if the
 * index's day expression is ever revised. The only other unique constraint on
 * the table is the primary key, whose value is a server-generated uuid, so
 * nothing else can quietly land in this branch.
 *
 * This is the ARBITER of duplicate delivery, not a convenience: the emitter's
 * pre-checks are check-then-act across separate transactions and the outbox
 * dispatcher drains shards in parallel. Returning `inserted: false` here is the
 * only signal that survives that race.
 */
export async function insertNotification(
    sql: postgres.Sql,
    opts: InsertNotificationOpts,
): Promise<InsertNotificationResult> {
    const expiresAt = opts.expiresAt
        ? opts.expiresAt instanceof Date
            ? opts.expiresAt
            : new Date(opts.expiresAt)
        : null;

    const rows = await sql<DbRow[]>`
        INSERT INTO user_notifications (user_id, kind, payload, expires_at, broadcast_id)
        VALUES (
            ${opts.userId}::uuid,
            ${opts.kind},
            ${opts.payload !== undefined ? sql.json((opts.payload as Record<string, postgres.JSONValue> | null) ?? {}) : sql`NULL`},
            ${expiresAt},
            ${opts.broadcastId ?? null}
        )
        ON CONFLICT DO NOTHING
        RETURNING id, user_id, kind, payload, read_at, created_at, expires_at
    `;
    const row = rows[0];
    return row ? { inserted: true, row: mapRow(row) } : { inserted: false, row: null };
}

// ---------------------------------------------------------------------------
// Coalescing
// ---------------------------------------------------------------------------

export interface CoalescedNotificationProbe {
    userId: string;
    kind: string;
    /** `payload->>'coalesceKey'`; see the `coalesce_key` generated column. */
    coalesceKey: string;
}

/**
 * Whether a row already exists today for this `(user, kind, coalesce key)`.
 *
 * The daily uniqueness itself is enforced by
 * `user_notifications_coalesce_daily_uniq` (migration 16.191.0) — a season drop
 * cannot write ten rows even if this probe is skipped or races.
 *
 * This probe is an OPTIMISATION and nothing more. It is a check-then-act read in
 * its own transaction, so two parallel outbox shards can both pass it; what
 * actually makes delivery single is `insertNotification`'s `ON CONFLICT DO
 * NOTHING` result, which `publishUserEvent` consults before it broadcasts.
 * Deleting the probe costs a redundant INSERT attempt; deleting the INSERT guard
 * costs the user a duplicate toast.
 *
 * The predicate mirrors the index's day expression exactly (UTC day from
 * `created_at`) so this read is an index-only lookup and can never disagree
 * with what the index would reject.
 */
export async function hasCoalescedNotificationToday(
    sql: postgres.Sql,
    probe: CoalescedNotificationProbe,
): Promise<boolean> {
    const rows = await sql<{ one: number }[]>`
        SELECT 1 AS one
        FROM user_notifications
        WHERE user_id = ${probe.userId}::uuid
          AND kind = ${probe.kind}
          AND coalesce_key = ${probe.coalesceKey}
          AND (created_at AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'UTC')::date
        LIMIT 1
    `;
    return rows.length > 0;
}

// ---------------------------------------------------------------------------
// List / paginate
// ---------------------------------------------------------------------------

/** The keyset position a page resumes from. Both halves are required. */
export interface NotificationCursorPosition {
    /** ISO-8601 `created_at` of the last row of the previous page. */
    createdAt: string;
    /** `id` of that same row — the tiebreaker. */
    id: string;
}

export interface ListNotificationsOpts {
    userId: string;
    /** When true, return only unread rows. */
    unreadOnly?: boolean;
    limit?: number;
    /** Keyset cursor — return rows strictly OLDER than this position. */
    cursor?: NotificationCursorPosition;
    /** ISO instant — return rows strictly NEWER than this (reconnect delta). */
    since?: string;
}

export interface ListNotificationsPage {
    items: UserNotificationRow[];
    /** Whether a further page exists. Derived by over-fetching, never guessed. */
    hasMore: boolean;
}

/**
 * List notifications for a user, newest first.
 * Expired rows are filtered out server-side (belt-and-suspenders alongside TTL).
 *
 * ## Ordering and the tiebreaker
 *
 * `ORDER BY created_at DESC, id DESC`, and the cursor compares the ROW
 * `(created_at, id)` rather than the timestamp alone. `created_at` is not
 * unique: a season drop writes several rows for one user inside the same
 * millisecond, and a timestamp-only cursor then either skips or repeats the
 * rows sharing that instant depending on which side of the page boundary they
 * fall. The row-comparison form is a single index-ordered seek, not an OR of
 * two predicates, so it stays a range scan.
 *
 * ## hasMore
 *
 * Fetches `limit + 1` and drops the extra. The previous `items.length === limit`
 * test was wrong at exactly the boundary — a final page that happened to hold
 * `limit` rows reported `hasMore: true`, and the client fetched an empty page to
 * discover otherwise.
 *
 * ## Currently-pinned broadcasts are EXCLUDED from this list
 *
 * A pinned admin broadcast is returned by `listPinnedBroadcastsForUser` and
 * rendered in its own block above the list, so leaving it in the paginated body
 * too would show it twice. The anti-join is the only correct place to remove it:
 *
 *  - Filtering it out in the handler instead would corrupt PAGINATION. The
 *    keyset cursor names the last row this page kept, and `hasMore` comes from
 *    over-fetching by one; drop a row after the LIMIT and a page silently
 *    returns fewer than `limit` rows while `hasMore` still describes the
 *    unfiltered set. With enough pinned rows a page could come back empty with
 *    `hasMore: true`, which a client reads as "the end" or as an infinite loop
 *    depending on how it is written.
 *  - It has to be a `NOT EXISTS` rather than a `LEFT JOIN … IS NULL`, so that
 *    the row is excluded only while the pin is IN FORCE. When a pin lapses
 *    (`pin_expires_at` passes) or an admin unpins, the row reappears in the
 *    ordinary list at its original `created_at` position with no write anywhere
 *    — the pinned block and this list are two reads of one truth, not two
 *    copies that could disagree.
 *
 * Rows whose broadcast is unpinned, expired, or absent (`broadcast_id IS NULL`,
 * the overwhelming majority) are untouched: `NOT EXISTS` over a NULL FK is
 * trivially true, and the partial index on `(user_id, broadcast_id)` keeps the
 * probe off every non-broadcast row.
 */
export async function listNotifications(
    sql: postgres.Sql,
    opts: ListNotificationsOpts,
): Promise<ListNotificationsPage> {
    const limit = Math.min(opts.limit ?? 50, 100);
    const cursor = opts.cursor ?? null;
    const since = opts.since ? new Date(opts.since) : null;

    const rows = await sql<DbRow[]>`
        SELECT id, user_id, kind, payload, read_at, created_at, expires_at
        FROM user_notifications n
        WHERE user_id = ${opts.userId}::uuid
          ${opts.unreadOnly ? sql`AND read_at IS NULL` : sql``}
          ${
              cursor
                  ? sql`AND (created_at, id) < (${new Date(cursor.createdAt)}::timestamptz, ${cursor.id}::uuid)`
                  : sql``
          }
          ${since ? sql`AND created_at > ${since}::timestamptz` : sql``}
          AND (expires_at IS NULL OR expires_at > now())
          AND NOT EXISTS (
              SELECT 1 FROM admin_broadcasts b
              WHERE b.id = n.broadcast_id
                AND b.pinned_at IS NOT NULL
                AND (b.pin_expires_at IS NULL OR b.pin_expires_at > now())
          )
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit + 1}
    `;

    return { items: rows.slice(0, limit).map(mapRow), hasMore: rows.length > limit };
}

// ---------------------------------------------------------------------------
// Pinned broadcasts
// ---------------------------------------------------------------------------

/**
 * Every currently-pinned admin broadcast this user holds a copy of, newest pin
 * first.
 *
 * Unpaginated and unbounded by a cursor, because the set is bounded by how many
 * announcements an operator has chosen to pin at once — a number they control
 * directly and which is realistically zero or one. It is the exact complement of
 * the anti-join in `listNotifications` above: same predicate, opposite sign, so
 * a row is in exactly one of the two results and never in both or neither.
 *
 * Ordered by `b.pinned_at DESC` rather than the row's own `created_at`: the pin
 * is what put it here, so the most recently pinned announcement leads. Re-pinning
 * refreshes `pinned_at`, which is how an admin moves one back to the top.
 * `n.id DESC` is the tiebreaker for two pins placed inside one millisecond, for
 * the same reason the inbox cursor carries an id.
 *
 * `expires_at` on the notification itself is still honoured. A broadcast writes
 * its rows with no TTL, so this is belt-and-braces rather than load-bearing
 * today — but a row that has expired must not come back merely because someone
 * pinned its parent.
 *
 * ## It returns the PIN, not just the row
 *
 * `pinned_at` is selected and mapped through {@link mapPinnedRow}, same as the
 * by-id lookup, because `pinnedAt` is the field the wire contract defines "this
 * row is pinned" as — a client suppresses its dismiss affordance on exactly that
 * presence, and `DELETE /notifications/{id}` answers 409 for exactly these rows.
 * Returning them without it made the two disagree: the pinned block rendered
 * like an ordinary notification and only the 409 stopped a dismissal, after the
 * user had already pressed the button.
 *
 * Every row here is pinned BY CONSTRUCTION — the join and the two predicates are
 * the same test `mapPinnedRow` re-derives — so `isPinned` is invariably true and
 * `pinnedAt` invariably non-null in this result. The shared mapper is still what
 * produces them, so there is one derivation rather than one plus an assumption.
 */
export async function listPinnedBroadcastsForUser(
    sql: postgres.Sql,
    userId: string,
): Promise<PinnedNotificationRow[]> {
    const rows = await sql<PinnedDbRow[]>`
        SELECT n.id, n.user_id, n.kind, n.payload, n.read_at, n.created_at, n.expires_at,
               b.pinned_at AS pinned_at
        FROM user_notifications n
        JOIN admin_broadcasts b ON b.id = n.broadcast_id
        WHERE n.user_id = ${userId}::uuid
          AND b.pinned_at IS NOT NULL
          AND (b.pin_expires_at IS NULL OR b.pin_expires_at > now())
          AND (n.expires_at IS NULL OR n.expires_at > now())
        ORDER BY b.pinned_at DESC, n.id DESC
    `;
    return rows.map(mapPinnedRow);
}

// ---------------------------------------------------------------------------
// Unread count
// ---------------------------------------------------------------------------

/**
 * Return the count of unread (non-expired) notifications for a user.
 */
export async function countUnread(sql: postgres.Sql, userId: string): Promise<number> {
    const rows = await sql<{ n: string }[]>`
        SELECT COUNT(*) AS n
        FROM user_notifications
        WHERE user_id = ${userId}::uuid
          AND read_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
    `;
    return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Single read
// ---------------------------------------------------------------------------

/**
 * The push delivery pass's view of a notification: just enough to anchor the
 * APNs expiration to when the event happened.
 *
 * Deliberately NOT `UserNotificationRow`. That shape maps `created_at` through
 * `toISOString()`, and `pushExpirationEpochSeconds` needs the `Date` — round-
 * tripping it through a string only to re-parse it would invite a timezone bug
 * in the one place where the value is an absolute deadline sent to Apple.
 */
export interface NotificationTimingRow {
    id: string;
    kind: string;
    payload: Record<string, unknown> | null;
    created_at: Date;
}

/**
 * Fetch one notification by id, unscoped by user.
 *
 * Unscoped, and that has to be argued rather than assumed, because there are now
 * two callers with different reasons:
 *
 *  - The push delivery pass already holds an outbox row whose `notification_id`
 *    is a FK to this table and whose `user_id` came from the same insert. There
 *    is no user input on that path at all.
 *  - The two rich-notification endpoints (`push-image`, `push-content`) are
 *    unauthenticated by design — an iOS Notification Service Extension is a
 *    separate process that may hold no usable token — so there is no session to
 *    scope by. What replaces the scope is the HMAC: the id arrives inside a
 *    signed path, so a caller can only name a notification the server itself
 *    minted a URL for, and an unsigned caller is rejected before this query runs.
 *
 * Any OTHER route handler must add a `user_id` predicate.
 */
export async function getNotificationById(
    sql: postgres.Sql,
    notificationId: string,
): Promise<NotificationTimingRow | null> {
    const rows = await sql<NotificationTimingRow[]>`
        SELECT id, kind, payload, created_at
        FROM user_notifications
        WHERE id = ${notificationId}::uuid
    `;
    return rows[0] ?? null;
}

/**
 * Fetch one notification by id, SCOPED to its owner — the variant a route
 * handler may use.
 *
 * Separate from {@link getNotificationById} rather than a flag on it, because
 * that function's whole docblock is an argument for why ITS callers may skip the
 * user predicate (an outbox row's FK; an HMAC-signed path). A route handler has
 * neither of those and takes the id from the URL, so the scope has to be in the
 * SQL. Returning `null` for "owned by someone else" is what lets the handler
 * answer 404 for both cases and leak nothing about which ids exist.
 *
 * Deliberately does NOT filter on `expires_at`, unlike `listNotifications`. This
 * exists to hydrate a reference a client is already holding — a push tapped days
 * later, a live frame's `notificationId` — and for that caller an expired row is
 * still the truthful answer to "what was this notification". The list is a
 * browsing surface and hides expired rows; a direct lookup by id is not.
 *
 * Also unlike `listNotifications`, this does NOT hide a pinned row. The list
 * hides it because the pinned block already carries it; a lookup by id is
 * answering "what is this notification", and a pinned one still exists.
 *
 * Returns the pin state alongside the row so its two callers each get their
 * answer from ONE query: GET `{id}` puts `pinnedAt` on the wire, and DELETE
 * `{id}` refuses (409) while `isPinned`. Deriving it here rather than making the
 * DELETE handler run a second read is what keeps the check-then-delete window
 * as small as a single statement can make it.
 *
 * The same shape is returned by {@link listPinnedBroadcastsForUser}, so the
 * pinned block and a by-id hydrate of one of its rows agree field for field.
 */
export interface PinnedNotificationRow extends UserNotificationRow {
    /**
     * `admin_broadcasts.pinned_at` of the parent broadcast, but ONLY while the
     * pin is actually in force — a lapsed `pin_expires_at` reports null, not a
     * historical timestamp. So this field means "pinned, since", never "was
     * pinned once".
     */
    pinnedAt: string | null;
    /** Exactly `pinnedAt !== null`; named for the DELETE handler's guard. */
    isPinned: boolean;
}

export async function getNotificationForUser(
    sql: postgres.Sql,
    notificationId: string,
    userId: string,
): Promise<PinnedNotificationRow | null> {
    const rows = await sql<PinnedDbRow[]>`
        SELECT n.id, n.user_id, n.kind, n.payload, n.read_at, n.created_at, n.expires_at,
               CASE
                   WHEN b.pinned_at IS NOT NULL
                        AND (b.pin_expires_at IS NULL OR b.pin_expires_at > now())
                   THEN b.pinned_at
               END AS pinned_at
        FROM user_notifications n
        LEFT JOIN admin_broadcasts b ON b.id = n.broadcast_id
        WHERE n.id = ${notificationId}::uuid
          AND n.user_id = ${userId}::uuid
    `;
    const row = rows[0];
    return row ? mapPinnedRow(row) : null;
}

// ---------------------------------------------------------------------------
// Mark read
// ---------------------------------------------------------------------------

/**
 * Mark a single notification as read.
 * Returns the updated row, or null if not found / already read / wrong owner.
 */
export async function markRead(
    sql: postgres.Sql,
    notificationId: string,
    userId: string,
): Promise<UserNotificationRow | null> {
    const rows = await sql<DbRow[]>`
        UPDATE user_notifications
        SET read_at = now()
        WHERE id = ${notificationId}::uuid
          AND user_id = ${userId}::uuid
          AND read_at IS NULL
        RETURNING id, user_id, kind, payload, read_at, created_at, expires_at
    `;
    return rows.length > 0 ? mapRow(rows[0]) : null;
}

/**
 * Mark ALL unread notifications for a user as read.
 *
 * Returns the rows it actually flipped, not a bare count. The count is
 * `rows.length`; the rows themselves are what lets the caller run the
 * cross-surface dismissal sync (`request-dismissal-sync.service.ts`) for every
 * `request.available` row this call just retired. Re-reading them afterwards
 * would be wrong, not merely wasteful: after the UPDATE they are no longer
 * unread, so there is no predicate that selects exactly this call's rows.
 */
export async function markAllRead(
    sql: postgres.Sql,
    userId: string,
): Promise<UserNotificationRow[]> {
    const rows = await sql<DbRow[]>`
        UPDATE user_notifications
        SET read_at = now()
        WHERE user_id = ${userId}::uuid
          AND read_at IS NULL
        RETURNING id, user_id, kind, payload, read_at, created_at, expires_at
    `;
    return rows.map(mapRow);
}

/**
 * Mark every unread `request.available` row that points at `mediaId` as read.
 *
 * The reverse leg of the dismissal reconciliation: a `request_dismissed` flag
 * written by ANY surface (the For-You rail, the request popup) must also retire
 * the inbox row for the same media, or the badge keeps counting a request the
 * user has already cleared somewhere else.
 *
 * Keyed on `payload->>'mediaId'` — the `request.available` payload's UUID field
 * (see the emitter's payload contract in `docs/architecture/user-events.md`).
 * That is a JSONB text extraction, so it is a sequential scan of the user's own
 * rows; at this table's size (one row per delivered notification per user) that
 * is the right trade against carrying an index for a write-side reconcile.
 *
 * Returns the ids it flipped so the caller can log/report a no-op honestly.
 */
export async function markRequestAvailableReadByMediaId(
    sql: postgres.Sql,
    userId: string,
    mediaId: string,
): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
        UPDATE user_notifications
        SET read_at = now()
        WHERE user_id = ${userId}::uuid
          AND kind = ${KIND_REQUEST_AVAILABLE}
          AND read_at IS NULL
          AND payload->>'mediaId' = ${mediaId}
        RETURNING id
    `;
    return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Delete a single notification.
 *
 * Returns the deleted row, or `null` when nothing matched (absent, or owned by
 * someone else). It returns the ROW rather than a boolean because deleting a
 * `request.available` row is a dismissal and has to drive the cross-surface
 * sync — and after the DELETE the payload that identifies the media is gone, so
 * `RETURNING` is the only place it can still be read. Callers that only want the
 * old boolean can test the result for null.
 */
export async function deleteNotification(
    sql: postgres.Sql,
    notificationId: string,
    userId: string,
): Promise<UserNotificationRow | null> {
    const rows = await sql<DbRow[]>`
        DELETE FROM user_notifications
        WHERE id = ${notificationId}::uuid
          AND user_id = ${userId}::uuid
        RETURNING id, user_id, kind, payload, read_at, created_at, expires_at
    `;
    return rows.length > 0 ? mapRow(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Prune (admin / task)
// ---------------------------------------------------------------------------

/**
 * Delete notifications that have passed their `expires_at` TTL.
 * Called by a background maintenance task.
 * Returns the count of rows deleted.
 */
export async function pruneExpired(sql: postgres.Sql): Promise<number> {
    const rows = await sql<{ n: string }[]>`
        WITH deleted AS (
            DELETE FROM user_notifications
            WHERE expires_at IS NOT NULL
              AND expires_at <= now()
            RETURNING id
        )
        SELECT COUNT(*) AS n FROM deleted
    `;
    return Number(rows[0]?.n ?? 0);
}
