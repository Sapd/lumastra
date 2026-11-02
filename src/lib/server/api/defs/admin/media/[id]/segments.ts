// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/segments.ts
 *
 * GET    /api/admin/media/[id]/segments  — list segments grouped by source, plus
 *                                          the candidate evidence behind them
 * DELETE /api/admin/media/[id]/segments  — clear cached segments AND detector
 *                                          candidates; `?type=Outro` clears only Outros
 * POST   /api/admin/media/[id]/segments  — enqueue intro/outro analysis, or set a
 *                                          manual override (`scope: 'set'`)
 *
 * Auth: admin.  Surface: internal-only.
 *
 * GET response:    { totalSegments, providers: Record<string, SegmentEntry[]>, candidates: [] }
 * DELETE response: { deleted, candidatesCleared, message }
 * POST response:   { runId, message, deduped? } | { type, startTime, endTime, materialized, … }
 * 503 dependency_unavailable when DB or plugin is unavailable.
 *
 * Provenance is admin-only on purpose. `MediaSegment` on /api/v1 is
 * `additionalProperties: false` and client-validated before the player sees it
 * (plan §2 G3), so `method` / `confidence` must never reach that wire shape.
 * Here they are free, and they are the only way an operator can tell a
 * thirteen-episode chromaprint consensus from a blackframe window-edge
 * truncation — every materialized row still says `lumastra-intro-analyzer`.
 */

import { z } from 'zod';
import { AnalyzerReadinessSchema } from '$lib/schemas/admin-media-analysis.js';
import { getAnalyzerReadinessBatch } from '$lib/server/database/queries/media-segment-input.queries.js';
import { json } from '@sveltejs/kit';
import type postgres from 'postgres';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    acquireExclusiveMediaSegmentWriteGate,
    acquireMediaSegmentResolutionLocks,
} from '$lib/server/tasks/builtin/native/intro-analyzer/resolution-lock.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    withSegmentChoice,
    undoSegmentChoice,
    SegmentChoiceConflict,
} from '$lib/server/services/segment-choice.service.js';
import { latestMediaChange } from '$lib/server/database/queries/admin-media-change.queries.js';
import {
    getSegmentsByMediaId,
    getSegmentsForChildren,
    getMediaTypeById,
    deleteSegmentsByMediaIds,
} from '$lib/server/database/queries/media-segments.queries.js';
import {
    getCandidatesForMedia,
    getCandidatesForChildren,
    deleteCandidatesForMediaIds,
    type MediaSegmentCandidateRow,
} from '$lib/server/database/queries/media-segment-candidates.queries.js';
import {
    METHOD_RANK,
    isResolvableMethod,
} from '$lib/server/tasks/builtin/native/intro-analyzer/resolve.js';
import { bumpMediaSegmentAnalysisGeneration } from '$lib/server/tasks/builtin/native/intro-analyzer/resolution-lock.js';
import type { DetectionMethod } from '$lib/server/tasks/builtin/native/intro-analyzer/types.js';
import { applyManualSegmentOverride } from '$lib/server/services/media-segment-override.service.js';
import { MediaSegmentTypeSchema } from '$lib/schemas/playback-types.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { isTaskRegistryInconsistency } from '$lib/server/tasks/handle-trigger-failure.js';
import { Logger } from '$lib/server/utils/logger.js';
import { isSeries, isSeason } from '$lib/server/utils/media-types.js';

const logger = Logger.for('AdminMediaSegments');
const LUMASTRA_INTRO_ANALYZER_ID = 'lumastra-intro-analyzer';

/**
 * Clearing segments discards what the DETECTORS decided. It does not discard
 * what a human told the system — that answer outlives resets, re-scans and
 * `PROCESSING_VERSION` bumps by design (plan §4 Phase 6), and this endpoint is
 * not the place to make an exception.
 */
const PRESERVED_METHODS: readonly DetectionMethod[] = ['manual'];

/**
 * How close a candidate's times must be to a materialized row to be read as the
 * row's origin. Both columns are `real`, so a value written from a candidate
 * round-trips exactly; the slack only absorbs float32 comparison noise.
 */
const MATCH_EPSILON_SEC = 0.05;

async function getClearTargetMediaIds(
    sql: postgres.Sql,
    mediaId: string,
    mediaType: string | null,
): Promise<string[]> {
    if (isSeason(mediaType)) {
        const rows = await sql<Array<{ id: string }>>`
            SELECT id
            FROM media_items
            WHERE parent_id = ${mediaId}
              AND media_type = 'episode'
            ORDER BY id
        `;
        return rows.map((row) => row.id);
    }
    if (isSeries(mediaType)) {
        const rows = await sql<Array<{ id: string }>>`
            SELECT ep.id
            FROM media_items ep
            JOIN media_items season
              ON season.id = ep.parent_id
             AND season.media_type = 'season'
            WHERE season.parent_id = ${mediaId}
              AND ep.media_type = 'episode'
            ORDER BY ep.id
        `;
        return rows.map((row) => row.id);
    }
    return [mediaId];
}

/** Analysis never includes deleted catalog ancestry, even if file links remain. */
async function getAnalysisTargetMediaIds(
    sql: postgres.Sql,
    mediaId: string,
    mediaType: string | null,
): Promise<string[]> {
    const candidates = await getClearTargetMediaIds(sql, mediaId, mediaType);
    if (candidates.length === 0) return [];
    const rows = await sql<
        { id: string }[]
    >`SELECT mi.id FROM media_items mi WHERE mi.id=ANY(${candidates}::uuid[]) AND mi.status<>'deleted' AND NOT EXISTS(SELECT 1 FROM media_items parent LEFT JOIN media_items grandparent ON grandparent.id=parent.parent_id WHERE parent.id=mi.parent_id AND (parent.status='deleted' OR grandparent.status='deleted')) ORDER BY mi.id`;
    return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// Request / response schemas
// ---------------------------------------------------------------------------

const SegmentEntrySchema = z.object({
    fileId: z.string().uuid().optional(),
    type: z.string(),
    startMs: z.number().int(),
    endMs: z.number().int(),
    fetchedAt: z.string(),
    /** Present when listing segments under a series or season. */
    seasonNumber: z.number().int().optional(),
    /** Present when listing segments under a series or season. */
    episodeNumber: z.number().int().optional(),
    /**
     * Which detector's candidate this row was materialized from, when one still
     * matches it. Absent for rows written before the evidence model, for rows
     * from another source, and for rows whose candidate has since been cleared.
     */
    method: z.string().optional(),
    confidence: z.number().optional(),
});

const SegmentCandidateSchema = z.object({
    mediaId: z.string(),
    type: z.string(),
    method: z.string(),
    startMs: z.number().int(),
    endMs: z.number().int(),
    confidence: z.number(),
    detectorVersion: z.number().int(),
    configHash: z.string().nullable(),
    snappedToChapter: z.boolean(),
    notes: z.string().nullable(),
    /** False for methods the resolver never materializes (`stale-manual`). */
    resolvable: z.boolean(),
    /** True when this candidate is the one the materialized row came from. */
    materialized: z.boolean(),
    updatedAt: z.string(),
});

export const SegmentsGetResponseSchema = z.object({
    undoId: z.uuid().optional(),
    analysisInputs: z.array(AnalyzerReadinessSchema),
    totalSegments: z.number().int().nonnegative(),
    providers: z.record(z.string(), z.array(SegmentEntrySchema)),
    candidates: z.array(SegmentCandidateSchema),
});

export const SegmentsDeleteResponseSchema = z.object({
    undoId: z.uuid().optional(),
    deleted: z.number().int().nonnegative(),
    candidatesCleared: z.number().int().nonnegative(),
    message: z.string(),
});

export const SegmentsGenerateResponseSchema = z.object({
    analysisInputs: z.array(AnalyzerReadinessSchema),
    runId: z.string(),
    message: z.string(),
    /**
     * True when the analyzer's `exclusiveWith` identity claim collapsed this
     * click into an already-running run. Reporting it is what stops an
     * outro-only or reset click from claiming it queued work it did not.
     */
    deduped: z.boolean().optional(),
});

export const SegmentsSetResponseSchema = z.object({
    undoId: z.uuid().optional(),
    type: z.string(),
    startMs: z.number().int(),
    endMs: z.number().int(),
    durationMs: z.number().int(),
    /** False when the override was stored as evidence but is not the served row. */
    materialized: z.boolean(),
    withheldRule: z.string().optional(),
    /**
     * True when `suppressFirstEpisodeIntro` will hide this override from the
     * player anyway. Materialized and correct — just not delivered.
     */
    suppressedAtRead: z.boolean().optional(),
    segmentsResolved: z.number().int().nonnegative(),
    message: z.string(),
});

const SegmentAnalyzeBodySchema = z.object({
    scope: z.enum(['single', 'children', 'deep']).default('single'),
    /** Targeted maintenance: recompute Outro evidence without changing Intros. */
    outroOnly: z.literal(true).optional(),
});

/**
 * Manual override. Times are integer milliseconds, in the same file-absolute clock every
 * detector works in, and are validated against the item's
 * `media_files.duration_seconds` — an out-of-range value is rejected, never
 * clamped, because a silently corrected typo is indistinguishable from a
 * deliberate boundary once it is stored.
 */
const SegmentSetBodySchema = z.object({
    scope: z.literal('set'),
    type: MediaSegmentTypeSchema,
    startMs: z.number().int(),
    endMs: z.number().int(),
});

/**
 * Union rather than a discriminated union: the analyze branch's `scope` carries
 * a `.default()`, so an absent body (every existing caller's DELETE, and POST
 * `{}`) must still parse. Order is irrelevant — `'set'` is not a member of the
 * analyze enum, so exactly one branch can ever match.
 */
const SegmentPostBodySchema = z.union([
    z.object({ scope: z.literal('undo'), receiptId: z.uuid() }),
    SegmentSetBodySchema,
    SegmentAnalyzeBodySchema,
]);

export type SegmentsGetResponse = z.infer<typeof SegmentsGetResponseSchema>;
export type SegmentsDeleteResponse = z.infer<typeof SegmentsDeleteResponseSchema>;
export type SegmentsGenerateResponse = z.infer<typeof SegmentsGenerateResponseSchema>;
export type SegmentsSetResponse = z.infer<typeof SegmentsSetResponseSchema>;

// ---------------------------------------------------------------------------
// Candidate ↔ segment attribution
// ---------------------------------------------------------------------------

interface MaterializedKey {
    mediaId: string;
    type: string;
    startTime: number;
    endTime: number;
}

function matchesTimes(row: MediaSegmentCandidateRow, segment: MaterializedKey): boolean {
    return (
        row.media_id === segment.mediaId &&
        row.type === segment.type &&
        Math.abs(row.start_time - segment.startTime) <= MATCH_EPSILON_SEC &&
        Math.abs(row.end_time - segment.endTime) <= MATCH_EPSILON_SEC
    );
}

/**
 * Which candidate a materialized row came from.
 *
 * Attribution is by value, not by a stored link: `media_segments` deliberately
 * has no `method` column (the wire shape and the read path are untouched by the
 * evidence model). Several methods can agree on the same boundary — an authored
 * chapter mark and a blackframe result snapped onto it, say — so the
 * best-ranked match is the one the resolver would have picked, which makes this
 * an exact reconstruction of its decision rather than a guess.
 */
function attributeSegment(
    candidates: MediaSegmentCandidateRow[],
    segment: MaterializedKey,
): MediaSegmentCandidateRow | undefined {
    let best: MediaSegmentCandidateRow | undefined;
    for (const row of candidates) {
        if (!isResolvableMethod(row.method)) continue;
        if (!matchesTimes(row, segment)) continue;
        if (!best || METHOD_RANK[row.method] < METHOD_RANK[best.method]) best = row;
    }
    return best;
}

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: SegmentPostBodySchema,
    },
    handlers: {
        GET: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            // Resolve through the id-resolution middleware like every sibling
            // endpoint — an alias id reaches media_items under a different key.
            const id = adminMediaId(event);
            if (!id) return ApiProblem.validationFailed('Missing media ID');

            const mediaType = await getMediaTypeById(sql, id);
            const isParent = isSeries(mediaType) || isSeason(mediaType);

            const rows = isParent
                ? await getSegmentsForChildren(sql, id, mediaType as 'tv' | 'season')
                : await getSegmentsByMediaId(sql, id);

            const candidateRows = isParent
                ? await getCandidatesForChildren(sql, id, mediaType as 'tv' | 'season')
                : await getCandidatesForMedia(sql, id);

            const analysisInputs = await getAnalyzerReadinessBatch(
                sql,
                await getAnalysisTargetMediaIds(sql, id, mediaType),
            );
            const attributed = new Set<string>();
            const bySource = new Map<string, z.infer<typeof SegmentEntrySchema>[]>();
            for (const row of rows) {
                const source = row.source;
                if (!bySource.has(source)) bySource.set(source, []);
                // Only the analyzer's rows are attributed: another source's row
                // that happens to share a boundary with a candidate was not
                // produced by it, and claiming otherwise would be a fabricated
                // provenance record on the one screen an operator trusts for it.
                const origin =
                    source === LUMASTRA_INTRO_ANALYZER_ID
                        ? attributeSegment(candidateRows, {
                              mediaId: row.media_id,
                              type: row.type,
                              startTime: row.start_time,
                              endTime: row.end_time,
                          })
                        : undefined;
                if (origin) attributed.add(origin.id);
                // `rows` is a union: only the parent branch
                // (getSegmentsForChildren) carries the episode coordinates.
                const coords = row as Partial<{
                    season_number: number | null;
                    episode_number: number | null;
                }>;
                bySource.get(source)!.push({
                    ...(row.file_id ? { fileId: row.file_id } : {}),
                    type: row.type,
                    startMs: Math.round(row.start_time * 1000),
                    endMs: Math.round(row.end_time * 1000),
                    fetchedAt:
                        row.fetched_at instanceof Date
                            ? row.fetched_at.toISOString()
                            : String(row.fetched_at),
                    ...(coords.season_number !== undefined && coords.season_number !== null
                        ? { seasonNumber: coords.season_number }
                        : undefined),
                    ...(coords.episode_number !== undefined && coords.episode_number !== null
                        ? { episodeNumber: coords.episode_number }
                        : undefined),
                    ...(origin
                        ? { method: origin.method, confidence: origin.confidence }
                        : undefined),
                });
            }

            return json(
                SegmentsGetResponseSchema.parse({
                    analysisInputs,
                    undoId: await latestMediaChange(sql, id, 'segments'),
                    totalSegments: rows.length,
                    providers: Object.fromEntries(bySource),
                    candidates: candidateRows.map((row) => ({
                        mediaId: row.media_id,
                        type: row.type,
                        method: row.method,
                        startMs: Math.round(row.start_time * 1000),
                        endMs: Math.round(row.end_time * 1000),
                        confidence: row.confidence,
                        detectorVersion: row.detector_version,
                        configHash: row.config_hash,
                        snappedToChapter: row.snapped_to_chapter,
                        notes: row.notes,
                        resolvable: isResolvableMethod(row.method),
                        materialized: attributed.has(row.id),
                        updatedAt:
                            row.updated_at instanceof Date
                                ? row.updated_at.toISOString()
                                : String(row.updated_at),
                    })),
                }),
            );
        },

        DELETE: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            // Resolve through the id-resolution middleware like every sibling
            // endpoint — an alias id reaches media_items under a different key.
            const id = adminMediaId(event);
            if (!id) return ApiProblem.validationFailed('Missing media ID');

            const mediaType = await getMediaTypeById(sql, id);
            const segmentType = z.enum(['Outro']).safeParse(event.url.searchParams.get('type'));
            if (!segmentType.success && event.url.searchParams.has('type')) {
                return ApiProblem.validationFailed(
                    'Only type=Outro is supported for selective clearing',
                );
            }

            // Clearing only the materialized rows is what this endpoint used to
            // do, and it did not survive contact with the evidence model: the
            // candidates outlive the delete, so the next scheduled resolution
            // restores exactly what the operator just cleared. Both tables go.
            //
            // Both deletes are ONE transaction on purpose. Split across two
            // statements, a resolution running concurrently (background drain,
            // or a targeted retry) can read the still-present candidates in the
            // gap and re-materialize a segment that then survives the second
            // delete — the operator is told "cleared", and a row reappears with
            // no candidate backing it.
            const result = await withTx(sql, async (tx) => {
                // Hold the write gate before discovering descendants; first-time writers
                // cannot race the target snapshot. Take stable per-item locks next.
                await acquireExclusiveMediaSegmentWriteGate(tx);
                await acquireMediaSegmentResolutionLocks(tx, [id]);
                const targetMediaIds = await getClearTargetMediaIds(tx, id, mediaType);
                await acquireMediaSegmentResolutionLocks(tx, targetMediaIds);
                return withSegmentChoice(
                    tx,
                    id,
                    targetMediaIds,
                    segmentType.data,
                    event.locals.user?.username ?? 'admin',
                    async (tx) => {
                        await bumpMediaSegmentAnalysisGeneration(tx, targetMediaIds);

                        if (segmentType.data === 'Outro') {
                            // This is an explicit destructive Outro reset, so it also
                            // removes a manual Outro override. Intro evidence remains
                            // untouched, including manual Intro overrides.
                            const candidates = await tx`
                        DELETE FROM media_segment_candidates
                        WHERE media_id = ANY(${targetMediaIds}::uuid[])
                          AND type = 'Outro'
                    `;
                            const segments = await tx`
                        DELETE FROM media_segments
                        WHERE media_id = ANY(${targetMediaIds}::uuid[])
                          AND type = 'Outro'
                    `;
                            return { deleted: segments.count, candidatesCleared: candidates.count };
                        }
                        const candidates = await deleteCandidatesForMediaIds(tx, targetMediaIds, {
                            exceptMethods: PRESERVED_METHODS,
                        });
                        const segments = await deleteSegmentsByMediaIds(tx, targetMediaIds);
                        return { deleted: segments, candidatesCleared: candidates };
                    },
                );
            });
            const {
                value: { deleted, candidatesCleared },
                undoId,
            } = result;

            return json(
                SegmentsDeleteResponseSchema.parse({
                    deleted,
                    candidatesCleared,
                    undoId,
                    message:
                        segmentType.data === 'Outro'
                            ? `Cleared ${deleted} Outro segment(s) and ${candidatesCleared} Outro candidate(s); Intros kept`
                            : `Cleared ${deleted} segment(s) and ${candidatesCleared} detector candidate(s); manual overrides kept`,
                }),
            );
        },

        POST: async (event, ctx) => {
            // Resolve through the id-resolution middleware like every sibling
            // endpoint. Load-bearing here beyond the lookup: the run is tagged
            // with this id as its subject, so an alias id would give the
            // analyzer a different subjectId than its four siblings and the
            // admin page's subject-scoped query would see a split set.
            const id = adminMediaId(event);
            if (!id) return ApiProblem.validationFailed('Missing media ID');

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const body = ctx.input!.body;
            const startedBy = event.locals.user?.username ?? 'admin';

            if (body.scope === 'undo') {
                try {
                    await undoSegmentChoice(sql, id, body.receiptId);
                } catch (error) {
                    if (error instanceof SegmentChoiceConflict)
                        return ApiProblem.conflict(error.message);
                    throw error;
                }
                return json({ restored: true });
            }
            if (body.scope === 'set') {
                const { value: result, undoId } = await withSegmentChoice(
                    sql,
                    id,
                    [id],
                    undefined,
                    startedBy,
                    (tx) =>
                        applyManualSegmentOverride(tx, {
                            mediaId: id,
                            type: body.type,
                            startTime: body.startMs / 1000,
                            endTime: body.endMs / 1000,
                            setBy: startedBy,
                        }),
                );

                if (!result.ok) {
                    if (result.reason === 'media-not-found') {
                        return ApiProblem.notFound(result.detail);
                    }
                    if (result.reason === 'unknown-duration') {
                        // Not the request's fault: the item has no probed file
                        // to validate against (a re-encode nulls the duration
                        // until the probe drain catches up). Re-probe, then set.
                        return ApiProblem.conflict(
                            `${result.detail} — re-probe the file before setting a manual segment`,
                        );
                    }
                    return ApiProblem.validationFailed(result.detail);
                }

                logger.info('Manual media segment override applied', {
                    mediaId: id,
                    type: body.type,
                    startTime: body.startMs / 1000,
                    endTime: body.endMs / 1000,
                    materialized: result.materialized,
                    withheldRule: result.withheldRule,
                    by: startedBy,
                });

                return json(
                    SegmentsSetResponseSchema.parse({
                        type: body.type,
                        undoId,
                        startMs: body.startMs,
                        endMs: body.endMs,
                        durationMs: Math.round(result.durationSeconds * 1000),
                        materialized: result.materialized,
                        ...(result.withheldRule
                            ? { withheldRule: result.withheldRule }
                            : undefined),
                        ...(result.suppressedAtRead ? { suppressedAtRead: true } : undefined),
                        segmentsResolved: result.segmentsResolved,
                        message: !result.materialized
                            ? `Manual ${body.type} saved as evidence but not served: ${result.withheldDetail ?? result.withheldRule ?? 'withheld at resolution'}`
                            : result.suppressedAtRead
                              ? `Manual ${body.type} saved, but the suppressFirstEpisodeIntro setting hides Intros on episode 1 from players — turn it off for this override to take effect`
                              : `Manual ${body.type} saved and now served`,
                    }),
                );
            }

            const mediaType = await getMediaTypeById(sql, id);
            if (!mediaType) return ApiProblem.notFound('Media item not found');
            const analysisInputs = await getAnalyzerReadinessBatch(
                sql,
                await getAnalysisTargetMediaIds(sql, id, mediaType),
            );
            if (!analysisInputs.some((input) => input.state === 'ready')) {
                return ApiProblem.conflict(
                    'Awaiting a present, probed video file with a usable duration before analysis',
                );
            }
            const scope = body.scope;
            const outroOnly = body.outroOnly === true;

            try {
                if (scope === 'children' || scope === 'deep') {
                    const mediaType = await getMediaTypeById(sql, id);
                    if (!mediaType) return ApiProblem.notFound('Media item not found');

                    if (!isSeries(mediaType) && !isSeason(mediaType)) {
                        return ApiProblem.validationFailed(
                            `Scope '${scope}' only valid for series or seasons`,
                        );
                    }

                    const jobOptions: Record<string, unknown> = {
                        [isSeries(mediaType) ? 'seriesId' : 'seasonId']: id,
                    };
                    if (scope === 'deep') jobOptions.reset = true;
                    if (outroOnly) jobOptions.outroOnly = true;

                    const result = await orchestrator.startRun(
                        LUMASTRA_INTRO_ANALYZER_ID,
                        jobOptions,
                        {
                            trigger: {
                                kind: 'manual',
                                by: startedBy,
                                sourceRoute: `admin/media/${id}/segments`,
                            },
                            subject: { type: 'mediaItem', id },
                        },
                    );

                    return json(
                        SegmentsGenerateResponseSchema.parse({
                            analysisInputs,
                            runId: result.runId,
                            deduped: result.deduped,
                            message: outroOnly
                                ? 'Outro-only analysis queued — Intros will not be changed'
                                : scope === 'deep'
                                  ? 'Deep re-analysis queued — results will appear as episodes complete'
                                  : 'Bulk analysis queued — results will appear as episodes complete',
                        }),
                    );
                }

                const result = await orchestrator.startRun(
                    LUMASTRA_INTRO_ANALYZER_ID,
                    { mediaId: id, ...(outroOnly ? { outroOnly: true } : {}) },
                    {
                        trigger: {
                            kind: 'manual',
                            by: startedBy,
                            sourceRoute: `admin/media/${id}/segments`,
                        },
                        subject: { type: 'mediaItem', id },
                    },
                );

                return json(
                    SegmentsGenerateResponseSchema.parse({
                        analysisInputs,
                        runId: result.runId,
                        deduped: result.deduped,
                        message: outroOnly
                            ? 'Outro-only analysis queued — Intros will not be changed'
                            : 'Analysis queued — results will appear once the worker completes',
                    }),
                );
            } catch (err) {
                if (isTaskRegistryInconsistency(err)) {
                    logger.error(
                        'lumastra-intro-analyzer plugin not registered',
                        err instanceof Error ? err : new Error(String(err)),
                        { mediaId: id, scope, taskId: LUMASTRA_INTRO_ANALYZER_ID },
                    );
                    return ApiProblem.dependencyUnavailable(
                        'Intro/outro analyzer is not available — the plugin failed to register at startup.',
                    );
                }
                throw err;
            }
        },
    },
});
