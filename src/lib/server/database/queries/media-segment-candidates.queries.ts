// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type {
    DetectedSegmentType,
    DetectionMethod,
} from '$lib/server/tasks/builtin/native/intro-analyzer/types.js';

/**
 * A row of `media_segment_candidates` (migration 16.184.0) — one detector's
 * answer for one `(media_id, type)`, kept alongside every other detector's.
 * `media_segments` stores only the resolved winner.
 */
export interface MediaSegmentCandidateRow {
    id: string;
    media_id: string;
    type: DetectedSegmentType;
    method: DetectionMethod;
    start_time: number;
    end_time: number;
    confidence: number;
    detector_version: number;
    config_hash: string | null;
    snapped_to_chapter: boolean;
    notes: string | null;
    created_at: Date;
    updated_at: Date;
}

/** Application-shaped candidate: what the resolver ranks. */
export interface MediaSegmentCandidate {
    type: DetectedSegmentType;
    method: DetectionMethod;
    startTime: number;
    endTime: number;
    confidence: number;
    detectorVersion: number;
    configHash?: string;
    snappedToChapter?: boolean;
    notes?: string;
}

/**
 * Write payload. `method` is absent because it is supplied once per call — a
 * replace is scoped to exactly one method, and letting individual rows carry a
 * different one would make the delete half of the replace unsound.
 */
export interface MediaSegmentCandidateInput {
    type: DetectedSegmentType;
    startTime: number;
    endTime: number;
    confidence?: number;
    detectorVersion?: number;
    configHash?: string | null;
    snappedToChapter?: boolean;
    notes?: string | null;
}

/**
 * Mirrors the column DEFAULTs in migration 16.184.0. They are restated here
 * rather than relied upon because a parameterised INSERT cannot pass the SQL
 * `DEFAULT` keyword — binding `null` to a NOT NULL column fails instead of
 * falling back. Keep the two in sync if the DDL ever changes.
 */
const DEFAULT_CONFIDENCE = 0.5;
const DEFAULT_DETECTOR_VERSION = 1;

/**
 * All candidates for one media item, across every method.
 *
 * Ordered so the resolver's input is stable run to run: two runs over the same
 * evidence must produce the same winner, and rank ties are broken further down
 * the pipeline by data, not by whatever order Postgres happened to return.
 */
export async function getCandidatesForMedia(
    sql: postgres.Sql,
    mediaId: string,
): Promise<MediaSegmentCandidateRow[]> {
    return sql<MediaSegmentCandidateRow[]>`
        SELECT id, media_id, type, method, start_time, end_time, confidence,
               detector_version, config_hash, snapped_to_chapter, notes,
               created_at, updated_at
        FROM media_segment_candidates
        WHERE media_id = ${mediaId}
        ORDER BY type ASC, method ASC, start_time ASC
    `;
}

/**
 * All candidates for every episode under a season.
 *
 * This is what makes the season cohort layer cheap: per-item detector results
 * are produced in an earlier phase of the drain and were previously dropped on
 * the floor. With candidates persisted they are simply re-read here, so the
 * cohort reconciler needs no restructuring of the drain loop and no second pass
 * over the files.
 */
export async function getCandidatesForSeason(
    sql: postgres.Sql,
    seasonId: string,
): Promise<MediaSegmentCandidateRow[]> {
    return sql<MediaSegmentCandidateRow[]>`
        SELECT c.id, c.media_id, c.type, c.method, c.start_time, c.end_time, c.confidence,
               c.detector_version, c.config_hash, c.snapped_to_chapter, c.notes,
               c.created_at, c.updated_at
        FROM media_segment_candidates c
        JOIN media_items ep ON ep.id = c.media_id AND ep.media_type = 'episode'
        WHERE ep.parent_id = ${seasonId}
        ORDER BY ep.episode_number NULLS LAST, c.type ASC, c.method ASC, c.start_time ASC
    `;
}

/**
 * All candidates for every episode under a series (via seasons) or a season.
 *
 * Read counterpart of {@link deleteCandidatesForChildren}, for the admin surface:
 * a season page has to be able to show the evidence for an episode that resolved
 * to NOTHING, and those items contribute no `media_segments` row to join against.
 */
export async function getCandidatesForChildren(
    sql: postgres.Sql,
    parentId: string,
    parentType: 'tv' | 'season',
): Promise<MediaSegmentCandidateRow[]> {
    if (parentType === 'season') {
        return sql<MediaSegmentCandidateRow[]>`
            SELECT c.id, c.media_id, c.type, c.method, c.start_time, c.end_time, c.confidence,
                   c.detector_version, c.config_hash, c.snapped_to_chapter, c.notes,
                   c.created_at, c.updated_at
            FROM media_segment_candidates c
            JOIN media_items ep ON ep.id = c.media_id AND ep.media_type = 'episode'
            WHERE ep.parent_id = ${parentId}
            ORDER BY ep.episode_number NULLS LAST, c.type ASC, c.method ASC, c.start_time ASC
        `;
    }
    return sql<MediaSegmentCandidateRow[]>`
        SELECT c.id, c.media_id, c.type, c.method, c.start_time, c.end_time, c.confidence,
               c.detector_version, c.config_hash, c.snapped_to_chapter, c.notes,
               c.created_at, c.updated_at
        FROM media_segment_candidates c
        JOIN media_items ep ON ep.id = c.media_id AND ep.media_type = 'episode'
        JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
        WHERE season.parent_id = ${parentId}
        ORDER BY season.season_number NULLS LAST, ep.episode_number NULLS LAST,
                 c.type ASC, c.method ASC, c.start_time ASC
    `;
}

/**
 * Replace one method's candidates for one media item.
 *
 * THE DELETE RUNS EVEN WHEN `candidates` IS EMPTY, AND THAT IS THE POINT.
 * A detector that abstains has said "I do not know", which must retract whatever
 * it claimed last time. If the delete were skipped on an empty produced set, the
 * previous run's candidate would survive, the resolver would keep ranking it, and
 * it would be re-materialized into `media_segments` forever — the abstention
 * would be invisible in the only place it matters. Every caller therefore passes
 * the methods it *owns*, not the methods it happened to produce.
 *
 * Callers that need this atomic against a concurrent targeted run for the same
 * item must pass a `TransactionSql` (a `media-<id>` run and the global drain can
 * execute concurrently — `exclusiveWith` collapses only same-identity runs).
 */
export async function replaceCandidatesForMethod(
    sql: postgres.Sql,
    mediaId: string,
    method: DetectionMethod,
    candidates: readonly MediaSegmentCandidateInput[],
): Promise<void> {
    await sql`
        DELETE FROM media_segment_candidates
        WHERE media_id = ${mediaId}
          AND method = ${method}
    `;

    for (const candidate of candidates) {
        // ON CONFLICT rather than a plain INSERT: the delete above has already
        // cleared this method, so a conflict can only come from two candidates of
        // the same type inside one produced set. Taking the last one keeps the
        // call re-entrant instead of failing the whole item's transaction over a
        // detector bug that a warning elsewhere already covers.
        await sql`
            INSERT INTO media_segment_candidates (
                media_id, type, method, start_time, end_time, confidence,
                detector_version, config_hash, snapped_to_chapter, notes
            )
            VALUES (
                ${mediaId},
                ${candidate.type},
                ${method},
                ${candidate.startTime},
                ${candidate.endTime},
                ${candidate.confidence ?? DEFAULT_CONFIDENCE},
                ${candidate.detectorVersion ?? DEFAULT_DETECTOR_VERSION},
                ${candidate.configHash ?? null},
                ${candidate.snappedToChapter ?? false},
                ${candidate.notes ?? null}
            )
            ON CONFLICT (media_id, type, method)
            DO UPDATE SET
                start_time = EXCLUDED.start_time,
                end_time = EXCLUDED.end_time,
                confidence = EXCLUDED.confidence,
                detector_version = EXCLUDED.detector_version,
                config_hash = EXCLUDED.config_hash,
                snapped_to_chapter = EXCLUDED.snapped_to_chapter,
                notes = EXCLUDED.notes,
                updated_at = NOW()
        `;
    }
}

/**
 * Bulk form of {@link replaceCandidatesForMethod}.
 *
 * `methods` and `candidatesByMethod` are separate arguments on purpose: `methods`
 * is the set the pass owns and therefore clears unconditionally, while
 * `candidatesByMethod` holds only what it actually produced. A method listed in
 * `methods` with no map entry is an explicit abstention and its stale rows are
 * removed. Collapsing the two into one map would make abstention
 * indistinguishable from "this pass did not run", which is the bug this whole
 * table exists to prevent.
 */
export async function replaceCandidatesForMethods(
    sql: postgres.Sql,
    mediaId: string,
    methods: readonly DetectionMethod[],
    candidatesByMethod: ReadonlyMap<DetectionMethod, readonly MediaSegmentCandidateInput[]>,
): Promise<void> {
    for (const method of methods) {
        await replaceCandidatesForMethod(
            sql,
            mediaId,
            method,
            candidatesByMethod.get(method) ?? [],
        );
    }
}

/**
 * Delete every candidate for a media item, optionally sparing some methods.
 *
 * `exceptMethods` is what lets the admin "clear segments" action wipe detector
 * evidence without destroying a `manual` override: the operator asked to discard
 * what the detectors decided, not to forget what a human told the system.
 */
export async function deleteCandidatesForMedia(
    sql: postgres.Sql,
    mediaId: string,
    opts: { exceptMethods?: readonly DetectionMethod[] } = {},
): Promise<number> {
    const except = opts.exceptMethods ?? [];
    if (except.length === 0) {
        const result = await sql`
            DELETE FROM media_segment_candidates
            WHERE media_id = ${mediaId}
        `;
        return result.count;
    }
    const result = await sql`
        DELETE FROM media_segment_candidates
        WHERE media_id = ${mediaId}
          AND method <> ALL(${[...except]}::text[])
    `;
    return result.count;
}

/** Delete candidates for an exact, already-locked set of media items. */
export async function deleteCandidatesForMediaIds(
    sql: postgres.Sql,
    mediaIds: readonly string[],
    opts: { exceptMethods?: readonly DetectionMethod[] } = {},
): Promise<number> {
    if (mediaIds.length === 0) return 0;
    const except = [...(opts.exceptMethods ?? [])];
    const result = await sql`
        DELETE FROM media_segment_candidates
        WHERE media_id = ANY(${[...mediaIds]}::uuid[])
          ${except.length > 0 ? sql`AND method <> ALL(${except}::text[])` : sql``}
    `;
    return result.count;
}

/**
 * Delete candidates for every episode under a series (via seasons) or a season.
 * Mirrors `deleteSegmentsForChildren` so the admin DELETE endpoint clears both
 * tables with the same scope — otherwise the next resolution silently restores
 * exactly what the operator just cleared.
 */
export async function deleteCandidatesForChildren(
    sql: postgres.Sql,
    parentId: string,
    parentType: 'tv' | 'season',
    opts: { exceptMethods?: readonly DetectionMethod[] } = {},
): Promise<number> {
    const except = [...(opts.exceptMethods ?? [])];
    if (parentType === 'season') {
        const result = await sql`
            DELETE FROM media_segment_candidates
            WHERE media_id IN (
                SELECT id FROM media_items
                WHERE parent_id = ${parentId} AND media_type = 'episode'
            )
              ${except.length > 0 ? sql`AND method <> ALL(${except}::text[])` : sql``}
        `;
        return result.count;
    }
    const result = await sql`
        DELETE FROM media_segment_candidates
        WHERE media_id IN (
            SELECT ep.id FROM media_items ep
            JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
            WHERE season.parent_id = ${parentId} AND ep.media_type = 'episode'
        )
          ${except.length > 0 ? sql`AND method <> ALL(${except}::text[])` : sql``}
    `;
    return result.count;
}

/** Convert DB rows to the application candidate shape the resolver consumes. */
export function toCandidates(rows: MediaSegmentCandidateRow[]): MediaSegmentCandidate[] {
    return rows.map((r) => ({
        type: r.type,
        method: r.method,
        startTime: r.start_time,
        endTime: r.end_time,
        confidence: r.confidence,
        detectorVersion: r.detector_version,
        configHash: r.config_hash ?? undefined,
        snappedToChapter: r.snapped_to_chapter,
        notes: r.notes ?? undefined,
    }));
}
