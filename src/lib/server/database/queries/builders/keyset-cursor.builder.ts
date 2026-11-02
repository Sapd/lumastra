// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Keyset-cursor builder — the shared, proven primitives for timestamp keyset
 * pagination over a `(timestamptz, id)` ordering.
 *
 * ## Why this module exists
 *
 * Postgres `timestamptz` carries **microsecond** precision; JS `Date` /
 * `Date#toISOString()` carries only **milliseconds**. A keyset cursor over a
 * `timestamptz` column must keep the cursor value as a raw string end-to-end —
 * any round-trip through a JS `Date` truncates the sub-millisecond digits and
 * can silently **skip** a row updated in the same millisecond as the page
 * boundary, or re-emit one.
 *
 * Two concerns need one proven implementation each:
 *
 *  1. **The bind.** Left as a bare `${x}::timestamptz`, postgres.js infers the
 *     parameter OID as `1184`/timestamptz from the cast and serializes ANY value
 *     bound to that OID via `new Date(x).toISOString()` — reintroducing ms
 *     truncation even when the value is already a lossless string.
 *     {@link pgTextTimestamp} pins the OID to `text` (25) so Postgres parses the
 *     raw string server-side, losslessly.
 *
 *  2. **The codec.** {@link encodeKeysetCursor} / {@link decodeKeysetCursor}
 *     move a `(ts, id)` pair over the wire as opaque base64 and NEVER touch
 *     `Date`. Both consumers must feed the codec a `column::text` value so the
 *     micro precision is preserved through the full round trip.
 *
 * This module lives in `builders/` next to `media-access-boundary.ts`; both are
 * pure, dependency-light SQL-adjacent helpers.
 */

import type postgres from 'postgres';

/**
 * Postgres OID for `text`. Pinning a bind param to this OID stops postgres.js
 * from inferring `timestamptz` (1184) from a `::timestamptz` cast and
 * serializing the value through `new Date(x).toISOString()` (ms truncation).
 */
export const PG_TEXT_OID = 25;

/**
 * Wire-pin a timestamp bind parameter to `text` so postgres.js ships the raw
 * string and Postgres parses it server-side, losslessly. Use ALWAYS with an
 * explicit `::timestamptz` (or `::timestamp`) cast at the call site:
 *
 *     sql`... < ${pgTextTimestamp(sql, cursor.ts)}::timestamptz`
 *
 * `value` MUST be a raw Postgres timestamp rendering — i.e. produced by a
 * `column::text` projection or another `pgTextTimestamp` round-trip — NEVER
 * `new Date(...).toISOString()`, which has already truncated to ms.
 */
export function pgTextTimestamp(sql: postgres.Sql, value: string): postgres.Parameter<string> {
    return sql.typed<string>(value, PG_TEXT_OID);
}

/**
 * A decoded keyset cursor over a `(timestamp, id)` ordering. `ts` is the raw
 * `column::text` rendering (micro precision preserved); `id` is the tiebreak.
 */
export interface KeysetCursor {
    ts: string;
    id: string;
}

/**
 * Lossless, URL-safe base64 encode of `"<ts>:<id>"`. Never parses `ts`.
 *
 * Mirrors the shape of the existing inline `encodeCursor` in `orchestrator.ts`
 * (base64 over `"<a>:<b>"`) so migrating that call site is a like-for-like swap
 * plus the precision fix. Uses `base64url` so the token is URL-safe without a
 * separate encode step.
 */
export function encodeKeysetCursor(cursor: KeysetCursor): string {
    return Buffer.from(`${cursor.ts}:${cursor.id}`, 'utf-8').toString('base64url');
}

/**
 * Inverse of {@link encodeKeysetCursor}. Splits on the LAST `:`: the encoding
 * is `"<ts>:<id>"` and the ts always contains colons (a timestamp does) while
 * the id (`task_history.id` / `playlists.id`) does not, so the greedy-first
 * split preserves the ts whole and takes the final segment as the id.
 * Returns `null` on malformed input (never throws): non-base64, empty, or a
 * payload with no separator / a leading separator (empty ts).
 */
export function decodeKeysetCursor(cursor: string): KeysetCursor | null {
    if (cursor.length === 0) return null;
    let decoded: string;
    try {
        decoded = Buffer.from(cursor, 'base64url').toString('utf-8');
    } catch {
        return null;
    }
    const idx = decoded.lastIndexOf(':');
    // idx <= 0 rejects both "no separator" (idx === -1) and "leading separator /
    // empty ts" (idx === 0). A trailing separator (empty id) is valid.
    if (idx <= 0) return null;
    return { ts: decoded.slice(0, idx), id: decoded.slice(idx + 1) };
}
