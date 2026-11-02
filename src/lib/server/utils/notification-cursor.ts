// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The opaque pagination cursor for the notification inbox.
 *
 * It encodes the keyset position `(created_at, id)` of the last row of a page.
 * Opaque is a CONTRACT, not obfuscation — there is nothing secret in here, and
 * base64 is not a security measure. What opacity buys is freedom to change the
 * key later (add a column, switch the tiebreaker) without a client that learned
 * to parse `?before=<ISO>` breaking, which is exactly what the timestamp-only
 * cursor it replaces had made impossible.
 *
 * Both halves are required. `created_at` alone is not unique — a season drop
 * writes several rows for one user in the same millisecond — so a cursor without
 * the id tiebreaker silently skips or repeats rows at a page boundary.
 *
 * ## Failing closed
 *
 * `decodeNotificationCursor` returns `null` for ANYTHING it cannot fully
 * validate: bad base64, bad JSON, a missing field, a non-ISO timestamp, a
 * non-uuid id. The caller turns that into a 422. This matters because the two
 * fields are interpolated into `::timestamptz` and `::uuid` casts, where a
 * malformed value makes Postgres THROW and the API report a 500 — the caller's
 * own bad input dressed up as a server fault.
 *
 * @module server/utils/notification-cursor
 */

/** The keyset position a page resumes from. */
export interface NotificationCursor {
    /** ISO-8601 `created_at` of the last row of the previous page. */
    createdAt: string;
    /** `id` (uuid) of that same row. */
    id: string;
}

/** Wire form — short keys, because this travels in a query string. */
interface WireCursor {
    t: string;
    i: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** base64url, so the value needs no percent-encoding in a query string. */
function toBase64Url(raw: string): string {
    return Buffer.from(raw, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function fromBase64Url(encoded: string): string | null {
    // Reject anything outside the alphabet BEFORE decoding: Buffer.from is
    // famously lenient and silently drops invalid characters, so garbage would
    // otherwise decode to a plausible-looking prefix rather than failing.
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
    try {
        return Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
            'utf8',
        );
    } catch {
        return null;
    }
}

/** Mint the cursor that resumes AFTER `row`. */
export function encodeNotificationCursor(row: { createdAt: string; id: string }): string {
    const wire: WireCursor = { t: row.createdAt, i: row.id };
    return toBase64Url(JSON.stringify(wire));
}

/**
 * Parse a client-supplied cursor, or `null` when it is not one we minted.
 * Never throws — every rejection path returns null so the caller can answer 422.
 */
export function decodeNotificationCursor(encoded: string): NotificationCursor | null {
    const raw = fromBase64Url(encoded);
    if (raw === null) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;

    const { t, i } = parsed as { t?: unknown; i?: unknown };
    if (typeof t !== 'string' || typeof i !== 'string') return null;
    if (!UUID_RE.test(i)) return null;

    // `Date.parse` accepts a lot; what has to hold is that the value round-trips
    // to a real instant, since it goes on to a `::timestamptz` cast.
    const millis = Date.parse(t);
    if (Number.isNaN(millis)) return null;

    return { createdAt: new Date(millis).toISOString(), id: i };
}
