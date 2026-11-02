// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import type postgres from 'postgres';
import {
    AudioTailAssessmentSchema,
    type AudioTailAssessment,
} from '$lib/schemas/audio-tail-assessment.js';
import { analyzerFileGenerationSql } from './media-segment-input.queries.js';
import type { FileHealthIssue } from './media-files.queries.js';

export interface HealthSourceSnapshot {
    generation: string;
    streams: string;
}
export function healthStreamSignatureSql(
    sql: postgres.Sql,
    alias = 'mf',
): postgres.PendingQuery<postgres.Row[]> {
    const file = sql(alias);
    return sql`md5(COALESCE((SELECT jsonb_agg(to_jsonb(ms) - 'id' - 'created_at' - 'updated_at' ORDER BY ms.stream_index)::text
        FROM media_streams ms WHERE ms.file_id = ${file}.id), '[]'))`;
}
/** Content/inventory only: ordinary health/audit bookkeeping must not invalidate bytes. */
export async function getHealthSourceSnapshot(
    sql: postgres.Sql,
    fileId: string,
): Promise<HealthSourceSnapshot | undefined> {
    const [row] = await sql<HealthSourceSnapshot[]>`
        SELECT ${analyzerFileGenerationSql(sql)} AS generation,
            ${healthStreamSignatureSql(sql)} AS streams
        FROM media_files mf WHERE mf.id = ${fileId}::uuid
    `;
    return row;
}
/** Caller owns health advisory lock, then file row lock, then validates physical inventory. */
export async function assertHealthSourceCurrent(
    sql: postgres.Sql,
    fileId: string,
    before: HealthSourceSnapshot,
    reviewed: FileHealthIssue[],
): Promise<void> {
    await sql`SELECT 1 FROM media_files WHERE id = ${fileId}::uuid FOR UPDATE`;
    const current = await getHealthSourceSnapshot(sql, fileId);
    const [issues] = await sql<{ current: boolean }[]>`
        SELECT COALESCE(health_issues, '[]'::jsonb) @> ${sql.json(reviewed as unknown as postgres.JSONValue)}::jsonb AS current
        FROM media_files WHERE id = ${fileId}::uuid
    `;
    if (
        !current ||
        current.generation !== before.generation ||
        current.streams !== before.streams ||
        !issues?.current
    )
        throw new Error('inconclusive: source, inventory or reviewed issues changed');
}

/** Privileged projection only. Never add this evidence to shared v1 file/run schemas. */
export async function getAdminTailAssessments(
    sql: postgres.Sql,
    fileIds: string[],
): Promise<Map<string, AudioTailAssessment>> {
    if (fileIds.length === 0) return new Map();
    const rows = await sql<{ id: string; health_tail_assessment: unknown }[]>`
        SELECT id, health_tail_assessment FROM media_files
        WHERE id = ANY(${fileIds}::uuid[]) AND health_tail_assessment IS NOT NULL
          AND octet_length(health_tail_assessment::text) <= 32768
    `;
    const result = new Map<string, AudioTailAssessment>();
    for (const row of rows) {
        const parsed = AudioTailAssessmentSchema.safeParse(row.health_tail_assessment);
        if (parsed.success) result.set(row.id, parsed.data);
    }
    return result;
}

export async function getAdminTailAssessmentsForMedia(
    sql: postgres.Sql,
    mediaId: string,
): Promise<Map<string, AudioTailAssessment>> {
    const linked = await sql<
        { file_id: string }[]
    >`SELECT file_id FROM media_file_items WHERE media_item_id = ${mediaId}::uuid`;
    return getAdminTailAssessments(
        sql,
        linked.map((row) => row.file_id),
    );
}
