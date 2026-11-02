// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Monitoring queries over `media_segment_candidates` (plan §4 Phase 5.4).
 *
 * The 26 % Outro anomaly sat in production for months because nothing could be
 * asked of the data: every detector wrote the same anonymous `media_segments`
 * row, so "which detector produces the long ones" had no answer and the
 * distribution was never looked at. The evidence table makes both questions
 * queryable, and these are the two queries worth putting on an operator screen:
 *
 *   1. Outro duration distribution BUCKETED BY METHOD. A blackframe column
 *      whose p90 sits at the search-window length is the bug, visible at a
 *      glance; a chapter-title column with the same p90 is a library of long
 *      credit rolls and is fine.
 *   2. A `config_hash` breakdown. Candidates carry the hash of the detector
 *      settings they were produced under, so "these rows predate the plausible
 *      /search split" stops being an archaeology exercise.
 *
 * Read-only and analytical: no index is added for them, and they are expected
 * to be called from an admin screen, not a hot path.
 */

import type postgres from 'postgres';
import type {
    DetectedSegmentType,
    DetectionMethod,
} from '$lib/server/tasks/builtin/native/intro-analyzer/types.js';

/** Default histogram bar width. 15 s reads well from 0 to a few hundred seconds. */
export const DEFAULT_SEGMENT_HISTOGRAM_BUCKET_SECONDS = 15;

/** One bar: how many candidates of `method` fall in `[bucketStart, bucketStart + bucketSeconds)`. */
export interface SegmentDurationBucket {
    method: DetectionMethod;
    /** Inclusive lower edge, in seconds. */
    bucketStart: number;
    items: number;
}

/** Per-method shape of the duration distribution, for a compact table next to the bars. */
export interface SegmentDurationSummary {
    method: DetectionMethod;
    items: number;
    p50: number;
    p90: number;
    p99: number;
    maxSeconds: number;
    /** How many of this method's candidates were snapped onto an authored chapter mark. */
    snappedToChapter: number;
}

/** One detector-configuration cohort. */
export interface CandidateConfigCohort {
    /** Null for rows written before config provenance existed. */
    configHash: string | null;
    detectorVersion: number;
    items: number;
    /** Distinct methods that wrote under this configuration. */
    methods: number;
    oldest: Date;
    newest: Date;
}

/**
 * Outro-duration histogram, one series per detection method.
 *
 * Durations are computed in `numeric` before the subtraction for the same
 * reason the repair predicate does it: `real - real` is float4 arithmetic and
 * is only incidentally exact. The result is cast to float8 so it arrives as a
 * JS number rather than postgres.js's string form for `numeric`.
 */
export async function getSegmentDurationHistogramByMethod(
    sql: postgres.Sql,
    opts: { type?: DetectedSegmentType; bucketSeconds?: number } = {},
): Promise<SegmentDurationBucket[]> {
    const type = opts.type ?? 'Outro';
    const bucket = Math.max(
        1,
        Math.floor(opts.bucketSeconds ?? DEFAULT_SEGMENT_HISTOGRAM_BUCKET_SECONDS),
    );
    return sql<SegmentDurationBucket[]>`
        SELECT method,
               (FLOOR(
                    (end_time::numeric - start_time::numeric) / ${bucket}::numeric
                ) * ${bucket}::numeric)::float8 AS "bucketStart",
               COUNT(*)::int AS items
        FROM media_segment_candidates
        WHERE type = ${type}
        GROUP BY method, "bucketStart"
        ORDER BY method ASC, "bucketStart" ASC
    `;
}

/** Percentile + max summary of the same distribution, per method. */
export async function getSegmentDurationSummaryByMethod(
    sql: postgres.Sql,
    opts: { type?: DetectedSegmentType } = {},
): Promise<SegmentDurationSummary[]> {
    const type = opts.type ?? 'Outro';
    return sql<SegmentDurationSummary[]>`
        SELECT method,
               COUNT(*)::int AS items,
               PERCENTILE_CONT(0.5) WITHIN GROUP (
                   ORDER BY (end_time::numeric - start_time::numeric)::float8
               ) AS p50,
               PERCENTILE_CONT(0.9) WITHIN GROUP (
                   ORDER BY (end_time::numeric - start_time::numeric)::float8
               ) AS p90,
               PERCENTILE_CONT(0.99) WITHIN GROUP (
                   ORDER BY (end_time::numeric - start_time::numeric)::float8
               ) AS p99,
               MAX(end_time::numeric - start_time::numeric)::float8 AS "maxSeconds",
               (COUNT(*) FILTER (WHERE snapped_to_chapter))::int AS "snappedToChapter"
        FROM media_segment_candidates
        WHERE type = ${type}
        GROUP BY method
        ORDER BY items DESC, method ASC
    `;
}

/**
 * Which detector configurations the stored evidence was produced under.
 *
 * Ordered newest-activity first so the cohort an operator is currently
 * producing is the top row and the stragglers from an older configuration sit
 * below it — the shape that answers "has the re-analysis actually rolled over
 * yet".
 */
export async function getCandidateConfigCohorts(
    sql: postgres.Sql,
): Promise<CandidateConfigCohort[]> {
    return sql<CandidateConfigCohort[]>`
        SELECT config_hash AS "configHash",
               detector_version AS "detectorVersion",
               COUNT(*)::int AS items,
               COUNT(DISTINCT method)::int AS methods,
               MIN(created_at) AS oldest,
               MAX(updated_at) AS newest
        FROM media_segment_candidates
        GROUP BY config_hash, detector_version
        ORDER BY newest DESC
    `;
}
