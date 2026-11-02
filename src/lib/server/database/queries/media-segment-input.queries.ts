// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import {
    analyzerConfigGenerationSql,
    type EffectiveConfig,
    ANALYZER_VISUAL_VERSION,
    ANALYZER_ACOUSTIC_VERSION,
} from '$lib/server/tasks/builtin/native/intro-analyzer/settings.js';

export interface AnalyzerInputSnapshot {
    mediaType: string;
    parentId: string | null;
    durationSeconds: number | null;
    fileId: string;
    filePath: string;
    fileGeneration: string;
    mediaGeneration: string;
    globalGeneration: string | null;
    configGeneration: string;
    inputIdentity: string;
    runId?: string;
    isDefault: boolean;
    startOffsetMs: number | null;
    endOffsetMs: number | null;
    /** A local stat witness, carried only by the invocation that read the bytes. */
    physicalIdentity?: string;
}

/** Eligibility and ordering are shared by the operator readiness and the executor. */
export function analyzableVideoFileSql(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`mf.file_path IS NOT NULL AND NOT mf.is_missing AND mf.duration_seconds > 60
        AND EXISTS (SELECT 1 FROM media_streams ms
                    WHERE ms.file_id = mf.id AND ms.stream_type = 'video')`;
}

/** Content fields only. A chapter/probe/health update must not invent new bytes. */
export function analyzerFileGenerationSql(
    sql: postgres.Sql,
    alias = 'mf',
): postgres.PendingQuery<postgres.Row[]> {
    const mf = sql(alias);
    return sql`md5(jsonb_build_array(${mf}.id, ${mf}.file_path, ${mf}.file_hash_head,
        ${mf}.file_size_bytes, ${mf}.file_mtime, ${mf}.duration_seconds)::text)`;
}

/** An episode's logical identity includes its place and its selected file window. */
export function analyzerMediaGenerationSql(
    sql: postgres.Sql,
    alias = 'mi',
): postgres.PendingQuery<postgres.Row[]> {
    const mi = sql(alias);
    return sql`md5(jsonb_build_array(${mi}.media_type, ${mi}.parent_id,
        ${mi}.season_number, ${mi}.episode_number, ${mi}.media_segment_generation,
        mfi.start_offset_ms, mfi.end_offset_ms)::text)`;
}

export async function getAnalyzerInputSnapshots(
    sql: postgres.Sql,
    mediaIds: readonly string[],
    effectiveConfig?: EffectiveConfig,
): Promise<Map<string, AnalyzerInputSnapshot>> {
    if (mediaIds.length === 0) return new Map();
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- Privileged analyzer execution and admin-only readiness; this returns no user-facing library metadata.
    const rows = await sql<(AnalyzerInputSnapshot & { mediaId: string })[]>`
        SELECT DISTINCT ON (mi.id) mi.id AS "mediaId",
               mi.media_type AS "mediaType", mi.parent_id AS "parentId",
               mf.duration_seconds AS "durationSeconds", mf.id AS "fileId",
               mf.file_path AS "filePath", ${analyzerFileGenerationSql(sql)} AS "fileGeneration",
               ${analyzerMediaGenerationSql(sql)} AS "mediaGeneration",
               (SELECT value #>> '{}' FROM plugin_settings
                WHERE plugin_id = 'lumastra-intro-analyzer'
                  AND key = '__media_segment_generation') AS "globalGeneration",
               ${analyzerConfigGenerationSql(sql, effectiveConfig)} AS "configGeneration",
               mfi.is_default AS "isDefault", mfi.start_offset_ms AS "startOffsetMs",
               mfi.end_offset_ms AS "endOffsetMs"
          FROM media_items mi
          JOIN media_file_items mfi ON mfi.media_item_id = mi.id
          JOIN media_files mf ON mf.id = mfi.file_id
         WHERE mi.id = ANY(${[...mediaIds]}::uuid[]) AND ${analyzerLiveAncestrySql(sql)}
           AND ${analyzableVideoFileSql(sql)}
         ORDER BY mi.id, mfi.is_default DESC, mf.part_number NULLS FIRST, mf.id
    `;
    return new Map(
        rows
            .filter((row) => typeof row.mediaType === 'string')
            .map((row) => [
                row.mediaId,
                {
                    ...row,
                    inputIdentity: `${row.fileId}:${row.fileGeneration}:${row.mediaGeneration}:${row.globalGeneration ?? ''}:${row.configGeneration}`,
                },
            ]),
    );
}

export async function getAnalyzerInputSnapshot(
    sql: postgres.Sql,
    mediaId: string,
    effectiveConfig?: EffectiveConfig,
): Promise<AnalyzerInputSnapshot | null> {
    return (await getAnalyzerInputSnapshots(sql, [mediaId], effectiveConfig)).get(mediaId) ?? null;
}

export interface AnalyzerReadiness {
    state: 'ready' | 'awaiting-input';
    inputIdentity: string | null;
    fileId: string | null;
    filePath: string | null;
    alternate: boolean;
    proof: {
        runId: string | null;
        inputIdentity: string;
        stageId: string;
        segmentTypes: string[];
        segmentsCount: number;
        processingVersion: number;
        coverageComplete: boolean;
        completedAt: string;
    } | null;
}

/** Two queries for any batch size, with exactly the same selection as execution. */
export async function getAnalyzerReadinessBatch(
    sql: postgres.Sql,
    mediaIds: readonly string[],
): Promise<(AnalyzerReadiness & { mediaId: string })[]> {
    const inputs = await getAnalyzerInputSnapshots(sql, mediaIds);
    const entries = [...inputs.entries()];
    const passes = entries.length
        ? await sql<
              {
                  media_id: string;
                  run_id: string | null;
                  input_identity: string;
                  stage_id: string;
                  segment_types: string[];
                  segments_count: number;
                  completed_at: Date;
                  processing_version: number;
                  coverage_complete: boolean;
              }[]
          >`
        SELECT DISTINCT ON (pass.media_id) pass.*
          FROM media_segment_analysis_passes pass
          JOIN unnest(${entries.map(([id]) => id)}::uuid[], ${entries.map(([, input]) => input.inputIdentity)}::text[])
               AS requested(media_id, input_identity)
            ON pass.media_id = requested.media_id AND pass.input_identity = requested.input_identity
         WHERE (pass.stage_id='lumastra-intro-analyzer:visual' AND pass.processing_version=${ANALYZER_VISUAL_VERSION})
            OR (pass.stage_id='lumastra-intro-analyzer:acoustic' AND pass.processing_version=${ANALYZER_ACOUSTIC_VERSION})
         ORDER BY pass.media_id, pass.completed_at DESC, pass.id DESC
    `
        : [];
    const byMedia = new Map(passes.map((pass) => [pass.media_id, pass]));
    return [...new Set(mediaIds)].map((mediaId) => {
        const input = inputs.get(mediaId);
        if (!input)
            return {
                mediaId,
                state: 'awaiting-input',
                inputIdentity: null,
                fileId: null,
                filePath: null,
                alternate: false,
                proof: null,
            };
        const pass = byMedia.get(mediaId);
        return {
            mediaId,
            state: 'ready',
            inputIdentity: input.inputIdentity,
            fileId: input.fileId,
            filePath: input.filePath,
            alternate: !input.isDefault,
            proof: pass
                ? {
                      runId: pass.run_id,
                      inputIdentity: pass.input_identity,
                      stageId: pass.stage_id,
                      segmentTypes: pass.segment_types,
                      segmentsCount: pass.segments_count,
                      processingVersion: pass.processing_version,
                      coverageComplete: pass.coverage_complete,
                      completedAt: pass.completed_at.toISOString(),
                  }
                : null,
        };
    });
}

export async function getAnalyzerReadiness(
    sql: postgres.Sql,
    mediaId: string,
): Promise<AnalyzerReadiness> {
    return (await getAnalyzerReadinessBatch(sql, [mediaId]))[0];
}

/** Selected canonical input identity, usable inside a correlated provenance predicate. */
export function currentAnalyzerInputIdentitySql(
    sql: postgres.Sql,
    subject: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- Privileged provenance/eligibility only, matching the admin/task snapshot selection.
    return sql`(SELECT mf.id::text || ':' || ${analyzerFileGenerationSql(sql)} || ':' ||
                   ${analyzerMediaGenerationSql(sql, 'analyzer_item')} || ':' || COALESCE((
                       SELECT value #>> '{}' FROM plugin_settings
                       WHERE plugin_id = 'lumastra-intro-analyzer'
                         AND key = '__media_segment_generation'), '') || ':' || ${analyzerConfigGenerationSql(sql)}
              FROM media_items analyzer_item
              JOIN media_file_items mfi ON mfi.media_item_id = analyzer_item.id
              JOIN media_files mf ON mf.id = mfi.file_id
             WHERE analyzer_item.id = ${subject} AND ${analyzerLiveAncestrySql(sql, 'analyzer_item')}
               AND ${analyzableVideoFileSql(sql)}
             ORDER BY mfi.is_default DESC, mf.part_number NULLS FIRST, mf.id LIMIT 1)`;
}

/** Failures lacking lineage remain forensic history, never current-source evidence. */
export function currentAnalyzerFailurePredicate(
    sql: postgres.Sql,
    alias: string,
): postgres.PendingQuery<postgres.Row[]> {
    const f = sql(alias);
    const subject = sql`(CASE WHEN ${f}.item_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN ${f}.item_id::uuid END)`;
    return sql`AND (${f}.plugin_id <> 'lumastra-intro-analyzer' OR (
        ${analyzerFailureVersionSql(sql, alias)} AND ${f}.input_identity IS NOT NULL AND ${f}.input_identity = ${currentAnalyzerInputIdentitySql(sql, subject)}
    ))`;
}

/** A status row alone cannot resolve a replacement's backlog. Alias is `miss`. */
export function analyzerStageEvidenceSql(
    sql: postgres.Sql,
    alias = 'miss',
    // A caller that evaluates this predicate for several stages of the same item can
    // compute the (expensive, six-table) identity once per item and pass it here.
    // It must equal currentAnalyzerInputIdentitySql for `<alias>.media_item_id`.
    identityOverride?: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    const state = sql(alias);
    const identity =
        identityOverride ?? currentAnalyzerInputIdentitySql(sql, sql`${state}.media_item_id`);
    return sql`(
        (${state}.status = 'completed' AND EXISTS (
            SELECT 1 FROM media_segment_analysis_passes pass
             WHERE pass.media_id = ${state}.media_item_id AND pass.stage_id = ${state}.stage_id
               AND pass.input_identity = ${identity} AND pass.coverage_complete = true
               AND pass.processing_version >= ${state}.processing_version
               AND pass.processing_version = CASE WHEN ${state}.stage_id='lumastra-intro-analyzer:acoustic' THEN ${ANALYZER_ACOUSTIC_VERSION}::int ELSE ${ANALYZER_VISUAL_VERSION}::int END
        )) OR
        (${state}.status = 'skipped_permanent' AND (
            ${state}.skipped_reason LIKE 'operator-%' OR ${analyzerPolicySkipSql(sql, alias)} OR EXISTS (
                SELECT 1 FROM plugin_failure_events fe
                 WHERE fe.plugin_id = 'lumastra-intro-analyzer' AND fe.item_id = ${state}.media_item_id::text
                   AND fe.stage_id = ${state}.stage_id AND ${analyzerFailureVersionSql(sql, 'fe')} AND fe.input_identity = ${identity}
            )
        )) OR
        (${state}.status NOT IN ('completed', 'skipped_permanent') AND (
            ${state}.skipped_reason = 'season-scan-not-yet-stable' OR EXISTS (
                SELECT 1 FROM plugin_failure_events fe
                 WHERE fe.plugin_id = 'lumastra-intro-analyzer' AND fe.item_id = ${state}.media_item_id::text
                   AND COALESCE(fe.analysis_stage_id,fe.stage_id) = ${state}.stage_id AND ${analyzerFailureVersionSql(sql, 'fe')} AND fe.input_identity = ${identity}
            )
        ))
    )`;
}

/** Policy skips remain terminal only while the same current policy applies. */
export function analyzerPolicySkipSql(
    sql: postgres.Sql,
    alias = 'miss',
): postgres.PendingQuery<postgres.Row[]> {
    const state = sql(alias);
    const disabled = sql`(SELECT count(*) FROM plugin_settings WHERE plugin_id='lumastra-intro-analyzer' AND key IN ('chapterDetection','blackframeDetection') AND value='false'::jsonb)=2`;
    // eslint-disable-next-line callback-safety/no-unscoped-media-items, callback-safety/require-has-files-with-active-status -- Privileged analyzer disposition revalidation for one canonical item; this returns a policy predicate, never user-facing library cards.
    return sql`(${state}.status='skipped_permanent' AND ${disabled} AND EXISTS(
        SELECT 1 FROM media_items subject WHERE subject.id=${state}.media_item_id AND subject.status<>'deleted' AND (
            (${state}.skipped_reason='movie-visual-detection-disabled' AND subject.media_type='movie') OR
            (${state}.skipped_reason='single-episode-detection-disabled' AND subject.media_type='episode' AND
                (SELECT COUNT(DISTINCT ep.id) FROM media_items ep JOIN media_file_items mfi ON mfi.media_item_id=ep.id JOIN media_files mf ON mf.id=mfi.file_id WHERE ep.parent_id=subject.parent_id AND ep.status<>'deleted' AND ep.media_type='episode' AND ${analyzableVideoFileSql(sql)})=1 AND
                COALESCE((SELECT MAX(GREATEST(mf.created_at,mf.updated_at,COALESCE(mf.file_mtime,mf.created_at))) FROM media_items ep JOIN media_file_items mfi ON mfi.media_item_id=ep.id JOIN media_files mf ON mf.id=mfi.file_id WHERE ep.parent_id=subject.parent_id AND ep.status<>'deleted' AND ep.media_type='episode'),'epoch'::timestamptz)<now()-interval '30 minutes')
        )
    ))`;
}
export async function getAnalyzerPolicySkippedStages(
    sql: postgres.Sql,
    mediaId: string,
): Promise<Set<string>> {
    const rows = await sql<
        { stage_id: string }[]
    >`SELECT miss.stage_id FROM media_item_stage_state miss WHERE miss.media_item_id=${mediaId}::uuid AND ${analyzerPolicySkipSql(sql)}`;
    return new Set(rows.map((row) => row.stage_id));
}

/** A child cannot remain analyzable after its canonical season/series is deleted. */
export function analyzerLiveAncestrySql(
    sql: postgres.Sql,
    alias = 'mi',
): postgres.PendingQuery<postgres.Row[]> {
    const item = sql(alias);
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- Privileged canonical ancestry eligibility, returns only a predicate.
    return sql`${item}.status<>'deleted' AND NOT EXISTS(SELECT 1 FROM media_items parent LEFT JOIN media_items grandparent ON grandparent.id=parent.parent_id WHERE parent.id=${item}.parent_id AND (parent.status='deleted' OR grandparent.status='deleted'))`;
}
/** Exclude only the exact scoped inputs already inspected by this invocation. */
export function analyzerUninspectedInputSql(
    sql: postgres.Sql,
    subject: postgres.PendingQuery<postgres.Row[]>,
    inspected: ReadonlyMap<string, string>,
): postgres.PendingQuery<postgres.Row[]> {
    if (inspected.size === 0) return sql`TRUE`;
    return sql`NOT EXISTS(SELECT 1 FROM unnest(${[...inspected.keys()]}::uuid[],${[...inspected.values()]}::text[]) AS seen(media_id,input_identity) WHERE seen.media_id=${subject} AND seen.input_identity=${currentAnalyzerInputIdentitySql(sql, subject)})`;
}
/** An unattributed detector version is historical evidence, never a current strike. */
export function analyzerFailureVersionSql(
    sql: postgres.Sql,
    alias: string,
): postgres.PendingQuery<postgres.Row[]> {
    const failure = sql(alias);
    return sql`((COALESCE(${failure}.analysis_stage_id,${failure}.stage_id)='lumastra-intro-analyzer:visual' AND ${failure}.processing_version=${ANALYZER_VISUAL_VERSION}::int) OR (COALESCE(${failure}.analysis_stage_id,${failure}.stage_id)='lumastra-intro-analyzer:acoustic' AND ${failure}.processing_version=${ANALYZER_ACOUSTIC_VERSION}::int))`;
}
