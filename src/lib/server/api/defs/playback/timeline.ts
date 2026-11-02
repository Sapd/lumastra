// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Selected-file timeline: chapters, skip markers and scrubbing variants, in milliseconds. */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getDb } from '$lib/server/database/connection.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { mediaIdResolver } from '$lib/server/services/media-id-resolver.js';
import { createMediaSegmentsService } from '$lib/server/services/media-segments.service.js';
import { resolveEffectiveChapters } from '$lib/server/services/playback-chapters.service.js';
import {
    buildTrickplayManifest,
    manifestTileParams,
    repairLocalTrickplayParams,
} from '$lib/server/services/playback-trickplay.service.js';
import { resolvePlaybackSelection } from '$lib/server/database/queries/media-file-resolution.queries.js';
import {
    getTrickplayAvailability,
    getTrickplayParams,
} from '$lib/server/database/queries/trickplay-params.queries.js';
import {
    getSegmentAnalysisStatus,
    type SegmentAnalysisStageRequirement,
} from '$lib/server/database/queries/media-segments.queries.js';
import {
    TimelineSegmentSchema,
    type TimelineChapter,
    type TimelineSegment,
} from '$lib/schemas/playback-types.js';
import { apiUrl } from '$lib/shared/api-urls.js';
import { buildTimelineHref } from '$lib/server/services/playback-timeline-hrefs.js';
import {
    computeNearestChapterTiles,
    pickBestTrickplayParams,
} from '$lib/server/utils/chapter-thumbnail.js';
import { computeChapterImageRevision } from '$lib/server/services/playback-image-revision.js';
import { TimelineResponseSchema } from '$lib/schemas/api-playback-responses.js';
import { timelineQuerySchema } from '$lib/schemas/playback.js';
import { getTaskSettings } from '$lib/server/database/queries/task-settings.queries.js';

const logger = Logger.for('PlaybackTimelineDef');

// ---------------------------------------------------------------------------
// Segment-analysis stage requirements
// ---------------------------------------------------------------------------

// Mirrors lumastra-intro-analyzer.ts's exported ANALYZER_VISUAL_STAGE_ID /
// ANALYZER_ACOUSTIC_STAGE_ID / VISUAL_PROCESSING_VERSION /
// ACOUSTIC_PROCESSING_VERSION. Deliberately duplicated rather than imported —
// that module is ~3600 lines and pulls in the task registry, ffmpeg probing,
// etc.; this def is on the hot playback-read path and must not drag that in.
// Same pattern as LUMASTRA_INTRO_ANALYZER_ID in
// admin/media/[id]/segments.ts. Keep these four values in sync with the
// analyzer if it ever bumps a processing version or renames a stage.
//
// The visual stage runs for both movies and episodes; the acoustic stage
// does not run at all. Both requirements are required TOGETHER, but only
// when both are actually going to run — see buildSegmentAnalysisRequirements
// below.
const VISUAL_STAGE_REQUIREMENT: SegmentAnalysisStageRequirement = {
    stageId: 'lumastra-intro-analyzer:visual',
    minVersion: 5,
};
const ACOUSTIC_STAGE_REQUIREMENT: SegmentAnalysisStageRequirement = {
    stageId: 'lumastra-intro-analyzer:acoustic',
    minVersion: 4,
};

// Mirrors PLUGIN_ID in lumastra-intro-analyzer.ts (:110) — hand-duplicated
// for the same reason as the stage ids above: that module pulls in the task
// registry + ffmpeg probing and must not be imported onto this hot read
// path. `getTaskSettings` is the lightweight plugin_settings reader every
// other caller of this config already uses (task-settings.queries.ts).
const INTRO_ANALYZER_PLUGIN_ID = 'lumastra-intro-analyzer';

/**
 * Build the `getSegmentAnalysisStatus` requirement list scoped to what the
 * analyzer will actually run for THIS item — its own docstring is explicit
 * that "the caller is responsible for only listing stages it expects to
 * actually run" (media-segments.queries.ts:283-284).
 *
 * The acoustic stage is season-scoped analyzer work, written ONLY for
 * episodes (lumastra-intro-analyzer.ts's season drain marks
 * `acousticEpisodeIds` — :2311-2327 / :3255-3275 — never a movie id), and
 * even for episodes it is skipped entirely when the operator has disabled
 * chromaprint fingerprinting (`chromaRan` exists specifically so a disabled
 * pass is not recorded as having run — :2308-2310). Requiring it outside
 * that intersection makes `segmentAnalysis` unsatisfiable: a movie, or an
 * episode analyzed with fingerprinting off, would report `'pending'` forever
 * and never trip the "BOTH required" guard this function preserves for the
 * case where the acoustic pass genuinely is expected.
 */
async function buildSegmentAnalysisRequirements(
    sql: postgres.Sql,
    mediaType: string | null,
): Promise<SegmentAnalysisStageRequirement[]> {
    const requirements: SegmentAnalysisStageRequirement[] = [VISUAL_STAGE_REQUIREMENT];
    if (mediaType === 'episode') {
        const settings = await getTaskSettings(sql, INTRO_ANALYZER_PLUGIN_ID);
        // Mirrors the analyzer's own default-true coercion (raw.chromaprintDetection !== false).
        if (settings.chromaprintDetection !== false) {
            requirements.push(ACOUSTIC_STAGE_REQUIREMENT);
        }
    }
    return requirements;
}

// ---------------------------------------------------------------------------
// Trickplay-availability stage requirement
// ---------------------------------------------------------------------------

// Mirrors the literal `'trickplay-generation'` stage id used across the task
// system (trickplayGenerationTask's `id`/`coversStages[0].id` in
// media-item-tasks.ts, ingest-map.queries.ts, TaskActionButton.svelte,
// FilesTab.svelte, etc.) — unlike lumastra-intro-analyzer, there is no
// exported `*_STAGE_ID` constant for it to import, so this mirrors the
// string literal by hand, same as SEGMENT_ANALYSIS_STAGES above.
// `minVersion` matches trickplayGenerationTask's `processingVersion: 1`
// (the version it stamps via `upsertCompletedRow` on completion).
const TRICKPLAY_STAGE = { stageId: 'trickplay-generation', minVersion: 1 } as const;

// Mirrors trickplayGenerationTask's `coversStages[0].appliesTo` (media-item-
// tasks.ts:777). Media types outside this set never get a
// `trickplay-generation` stage row seeded at all — `seedStageRowForBatch`
// skips non-applicable types outright (stage-state.service.ts:521-526) — so
// `getTrickplayAvailability`'s "no row" branch would otherwise report
// `'pending'` forever for e.g. a music track. That is exactly the population
// api-playback-responses.ts calls out as the canonical `'unsupported'`
// example (an item with no video stream); reporting `'pending'` instead
// traps a caching client in a poll that can never terminate.
const TRICKPLAY_APPLIES_TO = new Set<string>(['movie', 'episode']);

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

// The internal route (/api/playback/[itemId]/timeline) supplies `itemId`; the
// public v1 route lives under the SHARED /api/v1/playback/[id]/… param dir and
// therefore supplies `id`. SvelteKit forbids sibling routes with different
// param names, so the v1 leaf cannot be renamed to `[itemId]` in isolation
// (its siblings — e.g. subtitles/[index] — read `params.id` directly). Accept
// either key so this shared def resolves the media id under both mounts; the
// handler enforces non-empty itself (404 when absent). See
// defs/playback/probe-status.ts for the same fix applied earlier.
const TimelineItemIdParams = z.object({
    itemId: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
});

const TimelineQuerySchema = z.object({
    fileId: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function resolveInternalId(event: RequestEvent): Promise<string | null> {
    if (event.locals.resolvedIds?.internalId) return event.locals.resolvedIds.internalId;
    const rawId = event.params.itemId ?? event.params.id ?? '';
    if (!rawId) return null;
    try {
        const resolved = await mediaIdResolver.resolveAnyMediaId(rawId);
        return resolved.internalId ?? null;
    } catch {
        return null;
    }
}

/**
 * Resilient wrapper around {@link getSegmentAnalysisStatus} for the playback
 * read path: a query failure must degrade to `'unavailable'` rather than
 * failing the whole chapters response. `'unavailable'` carries the same
 * client contract as `'pending'` (retry later, don't trust `hasIntro`/
 * `hasOutro` as final) — see the field's `.describe()` in
 * TimelineResponseSchema.
 */
export async function resolveSegmentAnalysis(
    sql: postgres.Sql,
    mediaId: string,
    mediaType: string | null,
): Promise<'analyzed' | 'pending' | 'unavailable'> {
    try {
        const requirements = await buildSegmentAnalysisRequirements(sql, mediaType);
        return await getSegmentAnalysisStatus(sql, mediaId, requirements);
    } catch (err) {
        logger.warn(`Failed to resolve segment-analysis status for item ${mediaId}`, {
            error: err instanceof Error ? err.message : String(err),
        });
        return 'unavailable';
    }
}

/**
 * Resilient wrapper around {@link getTrickplayAvailability} for the playback
 * read path: a query failure must degrade to `'unavailable'` (with an empty
 * `widths` array) rather than failing the whole chapters response.
 * `'unavailable'` carries the same client contract as `'pending'` (retry
 * later) — see `trickplayState`'s `.describe()` in TimelineResponseSchema.
 */
export async function resolveTrickplayAvailability(
    sql: postgres.Sql,
    mediaId: string,
    mediaType: string | null,
    fileId?: string,
): Promise<{
    trickplayState: 'ready' | 'pending' | 'unsupported' | 'unavailable';
    trickplayWidths: number[];
}> {
    // `mediaType === null` means "unknown to this caller" (e.g. the item
    // lookup failed) — fall through to the stage-row-driven logic below
    // rather than guessing; a known, non-applicable media type is what
    // licenses the short-circuit.
    if (mediaType !== null && !TRICKPLAY_APPLIES_TO.has(mediaType)) {
        return { trickplayState: 'unsupported', trickplayWidths: [] };
    }
    try {
        const { state, widths, needsRepair } = await getTrickplayAvailability(
            sql,
            mediaId,
            TRICKPLAY_STAGE.stageId,
            TRICKPLAY_STAGE.minVersion,
            fileId,
        );
        if (
            needsRepair === true &&
            (await repairLocalTrickplayParams(sql, mediaId, fileId)).length
        ) {
            // Artifacts repair the cache, never override invalidation/version checks.
            const repaired = await getTrickplayAvailability(
                sql,
                mediaId,
                TRICKPLAY_STAGE.stageId,
                TRICKPLAY_STAGE.minVersion,
                fileId,
            );
            return { trickplayState: repaired.state, trickplayWidths: repaired.widths };
        }
        return { trickplayState: state, trickplayWidths: widths };
    } catch (err) {
        logger.warn(`Failed to resolve trickplay availability for item ${mediaId}`, {
            error: err instanceof Error ? err.message : String(err),
        });
        return { trickplayState: 'unavailable', trickplayWidths: [] };
    }
}

// ---------------------------------------------------------------------------
// Def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    docs: {
        GET: {
            tags: ['Playback'],
            summary: 'Get the selected file playback timeline',
            auth: 'bearer',
            // Public stability is pinned explicitly rather than inferred.
            stability: 'stable',
            query: timelineQuerySchema,
            responses: {
                200: {
                    schema: TimelineResponseSchema,
                    description:
                        'Selected file chapters, skip markers, and scrubbing variants in milliseconds',
                },
                404: 'Not found',
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },

    request: {
        params: TimelineItemIdParams,
        query: TimelineQuerySchema,
    },

    handlers: {
        GET: async (event, ctx) => {
            const internalId = await resolveInternalId(event);
            if (!internalId) return ApiProblem.notFound('Item not found');

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            // Library-access + age-rating gate.
            const accessible = await checkMediaAccess(sql, internalId, event.locals.user);
            if (!accessible) return ApiProblem.notFound('Item not found');

            const fileId = ctx.input?.query?.fileId;

            const { getMediaItemById } =
                await import('$lib/server/database/queries/catalog-operations.queries.js');
            const mediaItem = await getMediaItemById(sql, internalId);
            const selection = await resolvePlaybackSelection(sql, internalId, { fileId });
            const selectedFile = selection.files.find((file) => file.id === selection.fileId);
            if (!selectedFile) return ApiProblem.notFound('Selected version not found');

            const duration =
                (selectedFile.duration_seconds || mediaItem?.runtime_seconds || 0) * 1000;
            const durationMs = Number.isFinite(duration) ? Math.max(0, Math.round(duration)) : 0;
            const mediaType = mediaItem?.media_type ?? null;
            const { trickplayState, trickplayWidths } = await resolveTrickplayAvailability(
                sql,
                internalId,
                mediaType,
                selectedFile.id,
            );
            const params = await getTrickplayParams(sql, internalId, selectedFile.id);
            // The manifest builder is the serving predicate for both variants and images.
            // Memoize per width so chapter count never multiplies filesystem revision reads.
            const manifests = new Map<number, ReturnType<typeof buildTrickplayManifest>>();
            const manifestFor = (width: number): ReturnType<typeof buildTrickplayManifest> => {
                let pending = manifests.get(width);
                if (!pending) {
                    pending = buildTrickplayManifest(
                        sql,
                        internalId,
                        selectedFile.id,
                        width,
                        selectedFile.file_path,
                        ctx.surface,
                    );
                    manifests.set(width, pending);
                }
                return pending;
            };
            const imageManifests = (
                await Promise.all(params.map((param) => manifestFor(param.width)))
            ).filter((result) => result !== null);
            const imageParams = pickBestTrickplayParams(
                imageManifests.map((result) => manifestTileParams(result.manifest)),
            );
            const imageManifest = imageManifests.find(
                (result) => result.manifest.width === imageParams?.width,
            );
            const effectiveChapters = await resolveEffectiveChapters(sql, internalId, selectedFile);
            const clampMs = (value: number): number =>
                Math.min(
                    durationMs > 0 ? durationMs : Number.MAX_SAFE_INTEGER,
                    Math.max(0, Number.isFinite(value) ? Math.round(value) : 0),
                );
            const chapters: TimelineChapter[] = effectiveChapters.map((ch, position) => {
                const startMs = clampMs(Number(ch.start_ticks) / 10_000);
                const rawEndMs =
                    ch.end_ticks !== null
                        ? Math.round(Number(ch.end_ticks) / 10_000)
                        : effectiveChapters[position + 1]
                          ? Math.round(Number(effectiveChapters[position + 1].start_ticks) / 10_000)
                          : durationMs;
                const endMs = Math.max(startMs, clampMs(rawEndMs));
                const revision =
                    imageParams &&
                    imageManifest &&
                    computeNearestChapterTiles(Number(ch.start_ticks), imageParams).some((tile) =>
                        imageManifest.manifest.sheets.some(
                            (sheet) => sheet.index === tile.sheetIndex,
                        ),
                    )
                        ? computeChapterImageRevision(
                              selectedFile.id,
                              Number(ch.start_ticks),
                              imageParams.width,
                              imageManifest.revision,
                          )
                        : null;
                return {
                    index: ch.chapter_index,
                    name: ch.chapter_name || `Chapter ${ch.chapter_index + 1}`,
                    startMs,
                    endMs,
                    image: revision
                        ? {
                              href: buildTimelineHref(
                                  apiUrl(
                                      ctx.surface,
                                      `/playback/${internalId}/chapter-image/${ch.chapter_index}`,
                                  ),
                                  { fileId: selectedFile.id, rev: revision },
                              ),
                              revision,
                              source: 'self' as const,
                              mediaType: 'image/webp',
                          }
                        : null,
                };
            });

            const mediaSegments = await createMediaSegmentsService(sql).getSegments(
                internalId,
                selectedFile.id,
            );
            const allowedTypes = TimelineSegmentSchema.shape.type.options;
            const segments: TimelineSegment[] = mediaSegments.flatMap((segment) => {
                const type = allowedTypes.find((type) => type === segment.type.toLowerCase());
                if (!type) return [];
                const startMs = clampMs(segment.startTime * 1000);
                return [
                    { type, startMs, endMs: Math.max(startMs, clampMs(segment.endTime * 1000)) },
                ];
            });
            const hasIntro = segments.some((segment) => segment.type === 'intro');
            const hasOutro = segments.some((segment) => segment.type === 'outro');

            const segmentAnalysis = await resolveSegmentAnalysis(sql, internalId, mediaType);

            const servedWidths = (
                await Promise.all(
                    trickplayWidths.map(async (width) =>
                        (await manifestFor(width)) ? width : null,
                    ),
                )
            ).filter((width) => width !== null);
            const state =
                servedWidths.length > 0
                    ? 'ready'
                    : trickplayState === 'ready'
                      ? 'unavailable'
                      : trickplayState;

            const body = {
                fileId: selectedFile.id,
                durationMs,
                chapters,
                segments,
                segmentAnalysis,
                hasIntro,
                hasOutro,
                trickplay: {
                    state,
                    variants: servedWidths.map((width) => ({
                        width,
                        manifestHref: buildTimelineHref(
                            apiUrl(
                                ctx.surface,
                                `/playback/${internalId}/trickplay/${width}/manifest`,
                            ),
                            { fileId: selectedFile.id },
                        ),
                    })),
                },
            } satisfies z.infer<typeof TimelineResponseSchema>;
            return json(
                process.env.NODE_ENV === 'production' ? body : TimelineResponseSchema.parse(body),
            );
        },
    },
});
