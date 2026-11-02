// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Shared request-budget guards for the three `/j/DisplayPreferences/*` POST
 * routes (`[id]`, `usersettings`, `livetv`) — C6 of the 2026-09-13 fix plan.
 *
 * `withJellyfinAuth` throttles FAILED auth only (jellyfin-compat/middleware.ts);
 * nothing previously bounded body size, id/client length, or per-user row
 * cardinality on the authenticated write path itself. These three routes each
 * call the same handful of checks rather than each hand-rolling its own.
 *
 * Body size is enforced in two layers: `checkDisplayPreferencesBodySize` is a
 * cheap pre-write early exit, and `upsertDisplayPreferencesOrTooLarge` is the
 * actual guarantee, converting the DB's own CHECK violation into the same
 * 413. Both exist because the early exit's raw-byte cap cannot exactly track
 * what the DB CHECK measures — see `MAX_DISPLAY_PREFS_BODY_BYTES`'s doc
 * comment.
 */

import { ApiResponses } from '$lib/server/utils/api-responses.js';
import {
    countDisplayPreferencesRowsForUser,
    displayPreferencesRowExists,
    upsertDisplayPreferences,
} from '$lib/server/database/queries/jellyfin-display-preferences.queries.js';
import type postgres from 'postgres';

/**
 * Headroom proxy for the DB CHECK in migration 16.250.0
 * (`pg_column_size(data) < 65536`) — NOT a byte-for-byte match of it.
 *
 * `pg_column_size` measures the in-memory jsonb datum, which is consistently
 * LARGER than the raw JSON text: every object/array element carries a 4-byte
 * JEntry, so overhead is shape-dependent, not a fixed fraction of byte count.
 * Measured against a real PG instance: a ~29.8KB body of 2,000 small
 * `CustomPrefs`-style keys stores at pg_column_size ~33.8KB (+13.4%); a
 * ~53.9KB array of 5,000 small strings stores at ~58.9KB (+9.3%). Real
 * DisplayPreferences DTOs are under 4KB, so this 48KB cap costs no
 * legitimate client anything while leaving >25% headroom over both measured
 * shapes before the DB's 64KB(-ish) limit.
 *
 * This is a cheap early exit, not a guarantee: a pathological shape (e.g.
 * many tiny numeric array elements) can carry far more jsonb overhead than
 * either measured shape above and still trip the DB CHECK from under this
 * cap. `upsertDisplayPreferencesOrTooLarge` below is what actually closes
 * that gap, by converting the DB's own CHECK violation into the same 413.
 */
export const MAX_DISPLAY_PREFS_BODY_BYTES = 48 * 1024;

/** Matches the DB CHECKs in migration 16.250.0 for display_prefs_id / client. */
export const MAX_DISPLAY_PREFS_ID_LENGTH = 128;
export const MAX_DISPLAY_PREFS_CLIENT_LENGTH = 128;

/** Distinct (display_prefs_id, client) rows a single user may hold. */
export const MAX_DISPLAY_PREFS_ROWS_PER_USER = 200;

/**
 * Reject a body whose declared `Content-Length` exceeds the cap, or whose
 * PARSED representation re-serializes over the cap (catches a missing/lying
 * Content-Length).
 *
 * This is a cheap early exit, not a guarantee that the write below will
 * succeed: `MAX_DISPLAY_PREFS_BODY_BYTES` is a raw-byte proxy for what the DB
 * CHECK measures (`pg_column_size` of the stored jsonb, which runs BEFORE
 * TOAST compression and carries shape-dependent overhead — see that
 * constant's doc comment), not an exact match for it. A body that passes
 * this check can still be rejected by the DB itself;
 * `upsertDisplayPreferencesOrTooLarge` is what turns that into the same 413
 * rather than a 500.
 *
 * All three call sites run this AFTER `request.json()` has already read and
 * parsed the full body, so it is not a request-level size limit and does not
 * stop an oversized body from being buffered into memory — it's a backstop
 * before the DB write.
 *
 * Returns a 413 problem+json Response, or `null` when the body is within
 * budget.
 */
export function checkDisplayPreferencesBodySize(
    request: Request,
    parsedBody: unknown,
): Response | null {
    const declared = Number(request.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > MAX_DISPLAY_PREFS_BODY_BYTES) {
        return ApiResponses.payloadTooLarge('DisplayPreferences body is too large');
    }
    // Re-serialize the PARSED body: an absent/lying Content-Length (chunked
    // transfer, or a client that mis-declares) must not bypass the cap, and
    // this is close to what sql.json() will actually store. Measured in
    // UTF-8 BYTES (not `.length`, which counts UTF-16 code units) — the DB
    // CHECK bounds `pg_column_size`, a byte count, and multi-byte text
    // (CJK, emoji) makes those two diverge.
    const serializedByteLength = Buffer.byteLength(JSON.stringify(parsedBody), 'utf8');
    if (serializedByteLength > MAX_DISPLAY_PREFS_BODY_BYTES) {
        return ApiResponses.payloadTooLarge('DisplayPreferences body is too large');
    }
    return null;
}

/**
 * Bound the `displayPrefsId` (route param) and `client` (query param) so
 * neither can grow the `jellyfin_display_preferences` table's key columns
 * without limit. This app-level check exists so an over-length value gets a
 * clean 422 rather than surfacing as a DB CHECK-constraint 500.
 *
 * Deliberately NOT restricted to a GUID-or-known-keys allowlist: real
 * Jellyfin clients save custom/non-standard view ids here (e.g.
 * `customview-abc123`), so the only safe, behavior-preserving control at this
 * layer is a length bound — the DB CHECK is the hard backstop either way.
 */
export function validateDisplayPreferencesIdentity(
    displayPrefsId: string,
    client: string,
): Response | null {
    if (displayPrefsId.length === 0 || displayPrefsId.length > MAX_DISPLAY_PREFS_ID_LENGTH) {
        return ApiResponses.badRequest(
            `DisplayPreferences id must be 1-${MAX_DISPLAY_PREFS_ID_LENGTH} characters`,
        );
    }
    if (client.length > MAX_DISPLAY_PREFS_CLIENT_LENGTH) {
        return ApiResponses.badRequest(
            `client must be at most ${MAX_DISPLAY_PREFS_CLIENT_LENGTH} characters`,
        );
    }
    return null;
}

/**
 * Enforce the per-user row cap (C6): every fresh `(displayPrefsId, client)`
 * pair is a new row, and nothing cleans this table up. An UPDATE to an
 * existing pair is always allowed (it doesn't grow the row count); a genuine
 * new row is refused once the user already holds
 * {@link MAX_DISPLAY_PREFS_ROWS_PER_USER}.
 *
 * Returns a 409 conflict problem+json Response when the cap would be
 * exceeded, or `null` when the write may proceed.
 */
export async function enforceDisplayPreferencesRowCap(
    sql: postgres.Sql,
    userId: string,
    displayPrefsId: string,
    client: string,
): Promise<Response | null> {
    const existing = await displayPreferencesRowExists(sql, userId, displayPrefsId, client);
    if (existing) return null; // update, not a new row — never capped

    const count = await countDisplayPreferencesRowsForUser(sql, userId);
    if (count >= MAX_DISPLAY_PREFS_ROWS_PER_USER) {
        return ApiResponses.conflict(
            `DisplayPreferences row limit reached (${MAX_DISPLAY_PREFS_ROWS_PER_USER} per user)`,
        );
    }
    return null;
}

/** The CHECK migration 16.250.0 added to bound `pg_column_size(data)`. */
const DATA_SIZE_CHECK_CONSTRAINT = 'jellyfin_display_preferences_data_size_check';

/**
 * True iff `err` is a Postgres check_violation (SQLSTATE 23514) on the
 * `jellyfin_display_preferences` data-size CHECK specifically. Matched by
 * SQLSTATE + exact constraint name, not by message-string regex — the
 * message format varies by pg locale/version and a regex could
 * false-positive against an unrelated error whose text happens to mention
 * the column. Same pattern as `run-wrapper.ts`'s
 * `isMediaItemDeletedRace`/`integrity-violations.queries.ts`.
 */
function isDisplayPreferencesDataSizeViolation(err: unknown): boolean {
    const e = (err ?? {}) as { code?: unknown; constraint_name?: unknown };
    return e.code === '23514' && e.constraint_name === DATA_SIZE_CHECK_CONSTRAINT;
}

/**
 * Upsert a DisplayPreferences DTO, converting the DB's data-size CHECK
 * violation into the same 413 `checkDisplayPreferencesBodySize` returns.
 *
 * `checkDisplayPreferencesBodySize`'s raw-byte cap is a proxy with headroom,
 * not a guarantee (see its doc comment) — jsonb storage overhead is
 * shape-dependent and a pathological body can pass that early exit and
 * still violate the DB CHECK. This is what actually closes the gap: any
 * body Postgres itself rejects for size comes back to the client as 413,
 * never an unhandled 500. Any other error (a different CHECK, a connection
 * failure, …) is rethrown unchanged.
 *
 * Returns `null` on a successful write, or a 413 problem+json Response.
 */
export async function upsertDisplayPreferencesOrTooLarge(
    sql: postgres.Sql,
    userId: string,
    displayPrefsId: string,
    client: string,
    data: Record<string, unknown>,
): Promise<Response | null> {
    try {
        await upsertDisplayPreferences(sql, userId, displayPrefsId, client, data);
        return null;
    } catch (err) {
        if (isDisplayPreferencesDataSizeViolation(err)) {
            return ApiResponses.payloadTooLarge('DisplayPreferences body is too large');
        }
        throw err;
    }
}
