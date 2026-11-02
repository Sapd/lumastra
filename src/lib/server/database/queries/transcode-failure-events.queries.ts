// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { Logger } from '../../utils/logger.js';
import { stripSecrets, stripSecretsFromArgv } from '$lib/shared/transcode-failure-report.js';

const logger = Logger.for('TranscodeFailureEvents');

/** Bound the stored stderr. process-runner already caps its capture at 12KB. */
const MAX_STDERR_CHARS = 16_000;

/** Bound each argv ELEMENT. A real element is a flag, path, or filter string —
 *  a few KB is generous — but a pathological filter chain has no upper bound of
 *  its own, and `stderr_tail`'s cap does nothing to protect this column. */
const MAX_ARGV_ELEMENT_CHARS = 4_000;

export type TranscodeFailureOutcome =
    'retried' | 'bridged' | 'learned' | 'failed' | 'killed' | 'spawn_failed';

/** Terminal-failure outcomes — an attempt the retry ladder gave up on. */
export const FAILED_OUTCOMES: TranscodeFailureOutcome[] = ['failed', 'killed', 'spawn_failed'];
/** Recovered outcomes — an attempt the retry ladder retried/bridged/learned its way past. */
export const RECOVERED_OUTCOMES: TranscodeFailureOutcome[] = ['retried', 'bridged', 'learned'];

export interface TranscodeFailureEventInput {
    jobId: string;
    playSessionId: string;
    attempt: number;
    outcome: TranscodeFailureOutcome;
    exitCode: number | null;
    signal: string | null;
    category: string;
    summary: string | null;
    argv: string[];
    stderrTail: string | null;
    encoder: string | null;
    hwaccel: string | null;
    mediaId: string | null;
    fileId: string | null;
    source: Record<string, unknown> | null;
    decision: Record<string, unknown> | null;
    env: Record<string, unknown> | null;
    transcodeSpeed: number | null;
}

export interface FailureEventRow {
    id: string;
    job_id: string;
    play_session_id: string;
    attempt: number;
    occurred_at: Date;
    outcome: TranscodeFailureOutcome;
    exit_code: number | null;
    signal: string | null;
    category: string;
    summary: string | null;
    argv: string[];
    stderr_tail: string | null;
    encoder: string | null;
    hwaccel: string | null;
    media_id: string | null;
    file_id: string | null;
    source: Record<string, unknown> | null;
    decision: Record<string, unknown> | null;
    env: Record<string, unknown> | null;
    transcode_speed: number | null;
    probe_dump: string | null;
    probed_at: Date | null;
}

export interface IncidentRow {
    category: string;
    encoder: string | null;
    occurrences: string;
    distinct_files: string;
    distinct_sessions: string;
    first_seen: Date;
    /** Exact UTC cutoff: a JS Date would discard PostgreSQL's microseconds. */
    last_seen: string;
}

export interface IncidentSessionRow {
    play_session_id: string;
    media_id: string | null;
    file_id: string | null;
    media_title: string | null;
    attempt_count: string;
    first_seen: Date;
    last_seen: Date;
    /** Outcome of the session's LAST attempt overall, or null when that last
     *  attempt is a non-terminal `retried` (nothing recorded after it). */
    terminal_outcome: TranscodeFailureOutcome | null;
}

/**
 * Append a failure event. **Non-throwing by contract** — the caller is the FFmpeg
 * exit path, and a database hiccup must never unwind a transcode. Mirrors
 * `publishProbeError`'s fire-and-forget discipline.
 *
 * Secrets are stripped HERE, before the row exists, so the database never holds a
 * stream token even for the retention window. FFmpeg echoes the input URL in its
 * own banner, so stderr needs the same pass as argv.
 */
export async function recordTranscodeFailureEvent(
    sql: postgres.Sql,
    event: TranscodeFailureEventInput,
): Promise<void> {
    try {
        const argv = stripSecretsFromArgv(event.argv).map((a) =>
            a.slice(0, MAX_ARGV_ELEMENT_CHARS),
        );
        const stderr = event.stderrTail
            ? stripSecrets(event.stderrTail).slice(0, MAX_STDERR_CHARS)
            : null;

        await sql`
            INSERT INTO transcode_failure_events (
                job_id, play_session_id, attempt, outcome, exit_code, signal,
                category, summary, argv, stderr_tail, encoder, hwaccel,
                media_id, file_id, source, decision, env, transcode_speed
            ) VALUES (
                ${event.jobId}, ${event.playSessionId}, ${event.attempt},
                ${event.outcome}, ${event.exitCode}, ${event.signal},
                ${event.category}, ${event.summary},
                ${sql.json(argv)}, ${stderr}, ${event.encoder}, ${event.hwaccel},
                ${event.mediaId}, ${event.fileId},
                ${event.source ? sql.json(event.source as unknown as Record<string, never>) : null},
                ${event.decision ? sql.json(event.decision as unknown as Record<string, never>) : null},
                ${event.env ? sql.json(event.env as unknown as Record<string, never>) : null},
                ${event.transcodeSpeed}
            )
        `;
    } catch (err) {
        logger.error('Failed to record transcode failure event', err as Error, {
            jobId: event.jobId,
            outcome: event.outcome,
        });
    }
}

/**
 * Incident list, grouped by (category, encoder).
 *
 * `distinct_files` is the load-bearing column: one file failing repeatedly is a bad
 * file, two hundred files failing the same way is a bad system, and a flat row count
 * makes those indistinguishable.
 */
export async function listFailureIncidents(
    sql: postgres.Sql,
    opts: {
        outcomes: TranscodeFailureOutcome[];
        limit: number;
        /**
         * Only this encoder's groups (`null` = software, i.e. NULL encoder);
         * `undefined` = every encoder. Filtered here, not in the browser, so a
         * deep link to one encoder sees all its groups, not just the ones that
         * made the newest-`limit` cut.
         */
        encoder?: string | null;
    },
): Promise<{ rows: IncidentRow[]; totalGroups: number }> {
    const anyEncoder = opts.encoder === undefined;
    const encoder = opts.encoder ?? null;
    // Count and rows must share one statement snapshot: otherwise a group
    // inserted between the queries can make a limited list look complete,
    // enabling the page's bulk clear over a group the operator never saw.
    const rows = await sql<(IncidentRow & { total_groups: number })[]>`
            SELECT category,
                   encoder,
                   COUNT(*)::TEXT                        AS occurrences,
                   COUNT(DISTINCT file_id)::TEXT         AS distinct_files,
                   COUNT(DISTINCT play_session_id)::TEXT AS distinct_sessions,
                   (COUNT(*) OVER())::INT               AS total_groups,
                   MIN(occurred_at)                      AS first_seen,
                   to_char(MAX(occurred_at) AT TIME ZONE 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_seen
              FROM transcode_failure_events
             WHERE outcome = ANY(${opts.outcomes})
               AND (${anyEncoder} OR encoder IS NOT DISTINCT FROM ${encoder})
             GROUP BY category, encoder
             ORDER BY MAX(occurred_at) DESC
             LIMIT ${opts.limit}
        `;
    return { rows, totalGroups: rows[0]?.total_groups ?? 0 };
}

/**
 * Clear recorded failures — the admin page's per-incident and clear-all
 * buttons. Scoped by `outcomes` so clearing from the Failed tab never silently
 * discards the Recovered rows the operator is not looking at.
 *
 * With `category` omitted this clears every row in those outcomes; with it set,
 * only that one incident group. `encoder` uses `IS NOT DISTINCT FROM` for the
 * same reason `listIncidentSessions` does: a software incident's encoder is
 * NULL, and `NULL = NULL` is never true, so plain equality would delete nothing
 * for exactly the rows the operator clicked.
 *
 * The two shapes are written as two whole queries rather than one query plus a
 * conditional fragment: postgres.js concatenates adjacent fragments with no
 * separator, so a value-ending fragment glued to the next one yields `$3AND`
 * and fails at runtime only.
 */
export async function deleteFailureIncidents(
    sql: postgres.Sql,
    opts: {
        outcomes: TranscodeFailureOutcome[];
        category?: string;
        encoder?: string | null;
        /**
         * Delete only rows that occurred at or before this instant — the newest
         * event the operator's screen showed — events with later timestamps
         * stay. This is a time bound, not snapshot membership: a delayed
         * transaction can commit an older timestamp after the list loaded.
         * `undefined` = no bound.
         */
        before?: string;
    },
): Promise<number> {
    // Bind as TEXT before casting: a timestamptz-typed parameter makes
    // postgres.js serialize even a string through Date, losing microseconds.
    // One parameter, no optional fragment: postgres.js fragment gluing (see above).
    const before = opts.before ?? null;
    const result =
        opts.category === undefined
            ? await sql`
                  DELETE FROM transcode_failure_events
                   WHERE outcome = ANY(${opts.outcomes})
                     AND occurred_at <= COALESCE(${before}::text::timestamptz, 'infinity')
              `
            : await sql`
                  DELETE FROM transcode_failure_events
                   WHERE outcome = ANY(${opts.outcomes})
                     AND category = ${opts.category}
                     AND encoder IS NOT DISTINCT FROM ${opts.encoder ?? null}
                     AND occurred_at <= COALESCE(${before}::text::timestamptz, 'infinity')
              `;
    return result.count;
}

/**
 * Per-session breakdown of ONE incident group (category, encoder) — the
 * level-2 drill-down `listFailureIncidents`'s aggregate rows cannot provide
 * on their own (no session/file identifiers survive the GROUP BY there).
 *
 * `encoder` is matched with `IS NOT DISTINCT FROM` rather than `=`: a
 * software incident's `encoder` is NULL, and `NULL = NULL` is never true in
 * SQL, so a plain equality would silently return zero rows for every
 * software-encoder incident.
 *
 * `terminal_outcome` reflects the LAST row of the session's FULL chain
 * (unscoped by this incident's own category/encoder/outcome filter) — it
 * previews what `listSessionChain` will actually show when the caller drills
 * in, not just this incident's slice of it. It is `retried` → `NULL` here so
 * callers can render "no terminal outcome yet" without special-casing the
 * string.
 *
 * `file_id` is left NULL rather than filtered out for preview/cache jobs
 * that never touched a real file — those are still real failures.
 */
export async function listIncidentSessions(
    sql: postgres.Sql,
    opts: {
        category: string;
        encoder: string | null;
        outcomes: TranscodeFailureOutcome[];
        limit: number;
    },
): Promise<IncidentSessionRow[]> {
    // Admin-only diagnostics query (the caller def is `auth: { kind: 'admin' }`) —
    // the media_items join is purely to resolve a display title, not to serve a
    // user's own library/age-scoped view, so the row-level access gate this rule
    // otherwise requires doesn't apply here; the real gate is the admin check.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    return sql<IncidentSessionRow[]>`
        WITH last_per_session AS (
            SELECT DISTINCT ON (play_session_id)
                   play_session_id,
                   outcome  AS last_outcome,
                   file_id  AS last_file_id,
                   media_id AS last_media_id
              FROM transcode_failure_events
             -- Only the sessions in this incident: without this the DISTINCT ON
             -- sorted the whole table on every row expand.
             WHERE play_session_id IN (
                     SELECT play_session_id
                       FROM transcode_failure_events
                      WHERE category = ${opts.category}
                        AND encoder IS NOT DISTINCT FROM ${opts.encoder}
                        AND outcome = ANY(${opts.outcomes})
                   )
             ORDER BY play_session_id, occurred_at DESC, id DESC
        )
        SELECT
            e.play_session_id,
            lps.last_media_id AS media_id,
            lps.last_file_id AS file_id,
            mi.title AS media_title,
            COUNT(*)::TEXT AS attempt_count,
            MIN(e.occurred_at) AS first_seen,
            MAX(e.occurred_at) AS last_seen,
            CASE WHEN lps.last_outcome = 'retried' THEN NULL ELSE lps.last_outcome END AS terminal_outcome
          FROM transcode_failure_events e
          JOIN last_per_session lps ON lps.play_session_id = e.play_session_id
          LEFT JOIN media_items mi ON mi.id = lps.last_media_id
         WHERE e.category = ${opts.category}
           AND e.encoder IS NOT DISTINCT FROM ${opts.encoder}
           AND e.outcome = ANY(${opts.outcomes})
         GROUP BY e.play_session_id, lps.last_media_id, lps.last_file_id, mi.title, lps.last_outcome
         ORDER BY MAX(e.occurred_at) DESC
         LIMIT ${opts.limit}
    `;
}

/**
 * The full attempt chain for one play session, oldest first.
 *
 * Chained on play_session_id rather than job_id on purpose: a seek creates a new job
 * object and resets the ladder's flags, so a job-keyed chain silently omits the
 * pre-seek failures that usually explain the incident.
 *
 * The last row may be NON-terminal (a `retried` with nothing after it) — the seek and
 * supersede exclusions guarantee such chains exist. Callers must not assume a
 * terminal row.
 */
export async function listSessionChain(
    sql: postgres.Sql,
    playSessionId: string,
): Promise<FailureEventRow[]> {
    return sql<FailureEventRow[]>`
        SELECT * FROM transcode_failure_events
         WHERE play_session_id = ${playSessionId}
         ORDER BY occurred_at ASC, id ASC
    `;
}

/** Load a single failure event row by id — used by the lazy probe endpoint to check
 *  the cache (`probed_at`) and resolve `file_id` before spawning `ffmpeg -i`. */
export async function getFailureEventById(
    sql: postgres.Sql,
    id: string,
): Promise<FailureEventRow | null> {
    const rows = await sql<FailureEventRow[]>`
        SELECT * FROM transcode_failure_events WHERE id = ${id}
    `;
    return rows[0] ?? null;
}

/** Raw `media_files.file_path` (the PROVIDER path) for a failure row's linked file.
 *  Callers must still resolve it through `resolveMediaPath` for container path
 *  mapping and accessibility before touching the filesystem. */
export async function getFailureEventFilePath(
    sql: postgres.Sql,
    fileId: string,
): Promise<string | null> {
    const rows = await sql<{ file_path: string | null }[]>`
        SELECT file_path FROM media_files WHERE id = ${fileId}
    `;
    return rows[0]?.file_path ?? null;
}

/**
 * Same secret-strip + length bound `stderr_tail` gets on write. Exported (not just
 * applied inside `saveProbeDump`) so a caller returning a freshly-probed dump over
 * the wire can sanitize with the EXACT same transform that gets persisted — a
 * caller must never observe a probe dump before this redaction, on the first probe
 * or any later cached one.
 */
export function sanitizeProbeDump(dump: string): string {
    return stripSecrets(dump).slice(0, MAX_STDERR_CHARS);
}

/**
 * Cache the lazily-captured `ffmpeg -i` dump. Secrets stripped here too — FFmpeg
 * prints the input URL, tokens and all, in its own banner.
 *
 * `dump` may be `null` — a probe that produced nothing (deleted file, unmounted
 * volume, timeout) must still set `probed_at`, or that null result is never
 * cached and every later detail view re-spawns ffmpeg for the same row.
 */
export async function saveProbeDump(
    sql: postgres.Sql,
    id: string,
    dump: string | null,
): Promise<void> {
    const sanitized = dump !== null ? sanitizeProbeDump(dump) : null;
    await sql`
        UPDATE transcode_failure_events
           SET probe_dump = ${sanitized},
               probed_at  = NOW()
         WHERE id = ${id}
    `;
}

/**
 * Distinct sessions with a terminal failure in the last 24h. Backs the invariant.
 *
 * Uses `FAILED_OUTCOMES` (not a bare `outcome = 'failed'`) so a `spawn_failed`
 * (e.g. a stale FFMPEG_PATH after an upgrade) or `killed` (kernel OOM) session
 * counts here exactly as it does in `listFailureIncidents` — otherwise the
 * health invariant can stay green while the admin page's Failed tab already
 * shows the incident.
 */
export async function countFailedSessions24h(sql: postgres.Sql): Promise<number> {
    const rows = await sql<[{ count: string }]>`
        SELECT COUNT(DISTINCT play_session_id)::TEXT AS count
          FROM transcode_failure_events
         WHERE outcome = ANY(${FAILED_OUTCOMES})
           AND occurred_at > NOW() - INTERVAL '24 hours'
    `;
    return parseInt(rows[0]?.count ?? '0', 10);
}

/**
 * Top encoders by failed-session count in the last 24h. Backs the invariant
 * details. See {@link countFailedSessions24h} for why `FAILED_OUTCOMES` (not a
 * bare `outcome = 'failed'`) is required here too.
 */
export async function topFailingEncoders24h(
    sql: postgres.Sql,
    limit: number,
): Promise<{ encoder: string; count: string }[]> {
    return sql<{ encoder: string; count: string }[]>`
        SELECT COALESCE(encoder, 'software')          AS encoder,
               COUNT(DISTINCT play_session_id)::TEXT  AS count
          FROM transcode_failure_events
         WHERE outcome = ANY(${FAILED_OUTCOMES})
           AND occurred_at > NOW() - INTERVAL '24 hours'
         GROUP BY COALESCE(encoder, 'software')
         ORDER BY COUNT(DISTINCT play_session_id) DESC
         LIMIT ${limit}
    `;
}

/** One terminal failure, trimmed to what a diagnostics bundle needs. */
export interface RecentFailureRow {
    occurred_at: Date;
    category: string;
    summary: string | null;
    encoder: string | null;
}

/**
 * The most recent terminal failures, newest first — the transcode leg of the
 * instance diagnostics bundle.
 *
 * Deliberately NOT `listFailureIncidents`: that one is a GROUP BY aggregate with
 * no `summary`, and the bundle needs the human-readable one-liner per event.
 * Only the light columns are selected — `argv`, `stderr_tail` and `probe_dump`
 * make these rows 10-25KB each, and none of them belong in a merged overview.
 *
 * `FAILED_OUTCOMES` (not `outcome = 'failed'`) for the same reason as
 * {@link countFailedSessions24h}: a `spawn_failed`/`killed` is a real failure.
 */
export async function listRecentFailures(
    sql: postgres.Sql,
    limit: number,
): Promise<RecentFailureRow[]> {
    return sql<RecentFailureRow[]>`
        SELECT occurred_at, category, summary, encoder
          FROM transcode_failure_events
         WHERE outcome = ANY(${FAILED_OUTCOMES})
         ORDER BY occurred_at DESC
         LIMIT ${limit}
    `;
}

/**
 * LIMIT-batched delete, driven by `pruneUntilDrained`. Rows here are ~10-25KB, so an
 * unbounded single-pass DELETE could hold a long write lock after a busy period.
 */
export async function pruneTranscodeFailureEvents(
    sql: postgres.Sql,
    cutoff: Date,
    limit = 50_000,
): Promise<number> {
    const result = await sql`
        DELETE FROM transcode_failure_events
        WHERE id IN (
            SELECT id FROM transcode_failure_events
            WHERE occurred_at < ${cutoff}
            LIMIT ${limit}
        )
    `;
    return result.count;
}
