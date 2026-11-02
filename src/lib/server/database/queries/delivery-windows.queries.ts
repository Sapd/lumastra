// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure SQL query module for the client-reported `delivery_window` rows in
 * `playback_telemetry`. No side effects, no business logic, per this codebase's
 * three-tier DB architecture.
 *
 * These rows are the only honest delivery timer we have: server-side segment
 * timing measures a write into a 16 MB socket buffer, so a 7 MB segment
 * "delivers" in 0.1 s while the viewer has nothing. The receiver times a 30 s
 * window and reports the bits it actually got — which is what an operator
 * staring at an incident needs to see next to it.
 *
 * The per-session aggregates (p10/p50/overdue) live on
 * `playback_session_quality`; this module serves the RAW windows, so a link that
 * is usually fine and periodically collapses is visible as the shape it is
 * rather than as two numbers.
 */

import type postgres from 'postgres';
import { PLAY_SESSION_ID_UUID_PATTERN } from './playback-incident-events.queries.js';

/**
 * Renders one metadata field as a guarded `double precision`, against the `w`
 * alias of the subquery below.
 *
 * `metadata` is a jsonb bag of client-supplied STRINGS (`playback.ts` types it
 * `z.record(z.string(), z.string())`), so any single row can carry
 * `bytes: 'undefined'`, `'null'`, or a comma decimal. A bare `::double
 * precision` raises 22P02, which aborts the WHOLE select — one malformed row
 * from one buggy client build would 500 the incident drawer for every incident
 * on that session. So the cast only runs where a regex has already proved the
 * text is a plain decimal; anything else reads as NULL, i.e. "unknown".
 *
 * Same guard, same reason as the per-session aggregate in
 * `playback-telemetry.service.ts`. NB: the pattern is written with a DOUBLED
 * backslash on purpose — in a JS template literal a lone `\.` collapses to a
 * bare `.`, which matches ANY character and would let '1x2' reach the cast.
 */
function guardedNumericMetadata(
    sql: postgres.Sql,
    key: string,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`CASE WHEN w.metadata->>(${key}::text) ~ '^-?[0-9]+(\\.[0-9]+)?$'
                    THEN (w.metadata->>(${key}::text))::double precision END`;
}

/**
 * One receiver-timed delivery window. Every metadata-derived number is nullable:
 * `metadata` is written by whichever client version was playing, so a field the
 * reporter did not send — or sent as something non-numeric — reads as
 * "unknown", never as 0 (see {@link guardedNumericMetadata}).
 */
export interface DeliveryWindowRow {
    /** ISO 8601 timestamp the row was recorded. */
    recordedAt: string;
    /** Achieved bits per second over the window (`playback_telemetry.value`). */
    throughputBps: number;
    bytes: number | null;
    segments: number | null;
    mediaSec: number | null;
    transferMs: number | null;
    wallMaxMs: number | null;
    ttfbMaxMs: number | null;
    /** Slowest single segment in the window, in bits per second. */
    minSegBps: number | null;
    overdue: number | null;
    stalls: number | null;
    bufferAheadSec: number | null;
    engine: string | null;
}

/** As Postgres hands it back — `recorded_at` is a timestamptz, i.e. a JS Date. */
type RawDeliveryWindowRow = Omit<DeliveryWindowRow, 'recordedAt'> & { recordedAt: Date };

/** JS form of the SQL pattern, so the two cannot disagree about what a uuid is. */
const PLAY_SESSION_ID_UUID_RE = new RegExp(PLAY_SESSION_ID_UUID_PATTERN);

/**
 * The newest `limit` delivery windows for one play session, returned
 * OLDEST → NEWEST (newest LAST) so the caller can plot them as a timeline
 * without reversing.
 *
 * That ordering is why this is a subquery: the rows to keep are the newest ones
 * (`ORDER BY recorded_at DESC LIMIT n`), while the rows to RETURN are in
 * ascending time. A single `ORDER BY recorded_at ASC LIMIT n` would silently
 * return the n OLDEST windows of a long session instead.
 *
 * The id arrives as free text from `playback_incident_events.play_session_id`
 * (sometimes UPPERCASE, sometimes empty, sometimes not a uuid at all) while the
 * column here is a real `uuid`, so it is lowercased and REJECTED IN JS before it
 * reaches the cast.
 *
 * The SQL `CASE` guard that protects the sibling incident query cannot be reused
 * here, which is subtle enough to be worth stating: there the regex tests a
 * COLUMN, so the cast genuinely runs per row only after the match. Here the
 * operand is a BOUND PARAMETER — a constant expression Postgres is free to
 * evaluate ahead of the CASE — and it does: wrapped in the identical CASE,
 * `listDeliveryWindows(sql, 'not-a-uuid')` still raised 22P02 against real
 * Postgres 15 (the integration test beside this file pins it). A 500 on the admin
 * incident drawer is exactly what the guard was written to prevent, so the check
 * moved to where it actually runs.
 */
export async function listDeliveryWindows(
    sql: postgres.Sql,
    playSessionId: string,
    limit = 20,
): Promise<DeliveryWindowRow[]> {
    const id = playSessionId.toLowerCase();
    // See the note above: a non-uuid id cannot be filtered inside the query,
    // because the cast it would have to survive is on a bound parameter.
    if (!PLAY_SESSION_ID_UUID_RE.test(id)) return [];
    const rows = await sql<RawDeliveryWindowRow[]>`
        SELECT
            w.recorded_at as "recordedAt",
            w.value as "throughputBps",
            ${guardedNumericMetadata(sql, 'bytes')} as "bytes",
            ${guardedNumericMetadata(sql, 'segments')} as "segments",
            ${guardedNumericMetadata(sql, 'mediaSec')} as "mediaSec",
            ${guardedNumericMetadata(sql, 'transferMs')} as "transferMs",
            ${guardedNumericMetadata(sql, 'wallMaxMs')} as "wallMaxMs",
            ${guardedNumericMetadata(sql, 'ttfbMaxMs')} as "ttfbMaxMs",
            ${guardedNumericMetadata(sql, 'minSegBps')} as "minSegBps",
            ${guardedNumericMetadata(sql, 'overdue')} as "overdue",
            ${guardedNumericMetadata(sql, 'stalls')} as "stalls",
            ${guardedNumericMetadata(sql, 'bufferAheadSec')} as "bufferAheadSec",
            NULLIF(w.metadata->>'engine', '') as "engine"
        FROM (
            SELECT recorded_at, value, metadata
            FROM playback_telemetry
            WHERE metric_type = 'delivery_window'
              AND play_session_id = ${id}::uuid
            ORDER BY recorded_at DESC
            LIMIT ${limit}
        ) w
        ORDER BY w.recorded_at ASC
    `;
    return rows.map((row) => ({ ...row, recordedAt: row.recordedAt.toISOString() }));
}
