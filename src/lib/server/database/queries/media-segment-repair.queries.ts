// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Queries behind the admin backlog stats of the retired one-shot `media-segment-repair`
 * pass (plan §4 Phase 5).
 *
 * These select the stored `Outro` rows that carry the blackframe detector's
 * arithmetic FINGERPRINT. Read the fingerprint carefully before changing
 * anything here: it identifies the DETECTOR, not the failure. By construction
 * every blackframe answer ends exactly at the file duration and is a whole
 * number of 4 s buckets long (`blackframe.ts` walks backward from EOF in
 * `precision`-second buckets), so a correct 46 s credit roll matches it just as
 * well as the 200 s window-edge truncation that motivated the plan. The length
 * test bolted on top is therefore a PLAUSIBILITY JUDGEMENT, not forensics —
 * which is why the predicate is scoped to episodes (a movie's credit roll is
 * legitimately five to ten minutes) and why the repair pass re-derives an
 * answer instead of trusting the deletion alone.
 */

import type postgres from 'postgres';

/**
 * `media_segments.source` the intro analyzer writes under. Restated here rather
 * than imported from the task module: a query module must not pull a task (and
 * its registry side effects) into every consumer.
 */
export const INTRO_ANALYZER_SEGMENT_SOURCE = 'lumastra-intro-analyzer';

/**
 * `blackframe.ts` quantizes its backward walk into buckets of `precision`
 * seconds (default 4), so every answer it produces is a whole number of these.
 * That quantization is half of the fingerprint.
 */
export const BLACKFRAME_BUCKET_SECONDS = 4;

/** One bar of the "how long are the fingerprinted Outros" histogram. */
export interface SuspectLengthBucket {
    /** Exact `end - start` in seconds. Always a multiple of {@link BLACKFRAME_BUCKET_SECONDS}. */
    lengthSeconds: number;
    /** How many distinct segments carry exactly this length. */
    items: number;
}

/**
 * The fingerprint, as a reusable fragment.
 *
 * `end_time = mf.duration_seconds` is an EXACT float comparison on purpose:
 * blackframe stored `endTime` straight out of that very column, so both sides
 * are bit-identical float4 and there is nothing to tolerate.
 *
 * Each operand is cast to `numeric` BEFORE the subtraction. `real - real` is
 * float4 arithmetic; it happens to be exact for a ~47-minute episode only
 * because both operands land in the same binade (2048–4096), which is not
 * guaranteed across a whole library. Casting first makes the modulo test exact
 * everywhere.
 *
 * Requires `ms` (media_segments), `mi` (media_items) and `mf` (media_files) to
 * be in scope at the call site.
 */
function fingerprintPredicate(
    sql: postgres.Sql,
    minLengthSeconds: number,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`
        ms.type = 'Outro'
        AND ms.source = ${INTRO_ANALYZER_SEGMENT_SOURCE}
        AND mi.media_type = 'episode'
        AND ms.end_time = mf.duration_seconds
        AND MOD(
                ROUND(ms.end_time::numeric - ms.start_time::numeric, 3),
                ${BLACKFRAME_BUCKET_SECONDS}::numeric
            ) = 0
        AND (ms.end_time::numeric - ms.start_time::numeric) > ${minLengthSeconds}::numeric
    `;
}

/**
 * How many fingerprinted Outros are left.
 *
 * `COUNT(DISTINCT ms.id)` rather than `COUNT(*)`: a multi-part episode joins
 * several `media_files` rows and would otherwise be counted once per part.
 */
export async function countSuspectOutros(
    sql: postgres.Sql,
    opts: { minLengthSeconds: number },
): Promise<number> {
    const rows = await sql<Array<{ total: number }>>`
        SELECT COUNT(DISTINCT ms.id)::int AS total
        FROM media_segments ms
        JOIN media_items mi ON mi.id = ms.media_id
        JOIN media_file_items mfi ON mfi.media_item_id = mi.id
        JOIN media_files mf ON mf.id = mfi.file_id
        WHERE ${fingerprintPredicate(sql, opts.minLengthSeconds)}
    `;
    return rows[0]?.total ?? 0;
}

/**
 * The length histogram over the fingerprinted population.
 *
 * This is what makes Tier A identifiable without hardcoding a window value.
 * A window-edge truncation reports the SAME length for every episode that hit
 * it — the walk ran out of window, and the window is a constant — so the
 * truncations pile into one exact bucket while genuine long credit rolls spread
 * across many. `inferWindowEdgeLengths` in the repair task turns this shape
 * into the Tier A set.
 */
export async function getSuspectLengthHistogram(
    sql: postgres.Sql,
    opts: { minLengthSeconds: number },
): Promise<SuspectLengthBucket[]> {
    return sql<SuspectLengthBucket[]>`
        SELECT length_seconds AS "lengthSeconds", COUNT(*)::int AS items
        FROM (
            SELECT DISTINCT ms.id,
                   (ms.end_time::numeric - ms.start_time::numeric)::float8 AS length_seconds
            FROM media_segments ms
            JOIN media_items mi ON mi.id = ms.media_id
            JOIN media_file_items mfi ON mfi.media_item_id = mi.id
            JOIN media_files mf ON mf.id = mfi.file_id
            WHERE ${fingerprintPredicate(sql, opts.minLengthSeconds)}
        ) lengths
        GROUP BY length_seconds
        ORDER BY length_seconds ASC
    `;
}
