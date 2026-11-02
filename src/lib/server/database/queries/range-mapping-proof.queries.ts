// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import type postgres from 'postgres';
import {
    RangeMappingProofSchema,
    type AdminRangeMapping,
} from '$lib/schemas/range-mapping-proof.js';

/** Reuse in SQL classification before filters/counts/pagination (B3). */
export function currentRangeMappingProofSql(
    sql: postgres.Sql,
    fileId: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`current_range_mapping_proof(${fileId})`;
}
/** Mixed issues remain actionable, even when the mapping itself is current. */
export function informationalRangeFileSql(
    sql: postgres.Sql,
    fileId: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`(${currentRangeMappingProofSql(sql, fileId)} AND EXISTS (
        SELECT 1 FROM media_files classified WHERE classified.id = ${fileId}
        AND CASE WHEN jsonb_typeof(classified.health_issues) = 'array'
            THEN CASE WHEN jsonb_array_length(classified.health_issues) = 1
                THEN classified.health_issues->0->>'type' = 'range_superseded'
                ELSE false END
            ELSE false END))`;
}
export interface RangeMappingGraph {
    seasonId: string;
    seasonNumber: number;
    seriesId: string;
    root: { id: string; path: string };
    files: Array<{ id: string; path: string; size: string; mtimeMs: string; generation: string }>;
    claims: Array<{ number: number; episodeId: string; fileId: string }>;
}
export async function getRangeMappingGraph(
    sql: postgres.Sql,
    args: {
        fileId: string;
        seasonId: string;
        first: number;
        last: number;
        dedicatedIds: string[];
    },
): Promise<RangeMappingGraph | null> {
    const [row] = await sql<{ graph: RangeMappingGraph | null }[]>`SELECT range_mapping_graph(
        ${args.fileId}::uuid, ${args.seasonId}::uuid, ${args.first}, ${args.last}, ${args.dedicatedIds}::uuid[]) AS graph`;
    return row.graph;
}
/** Only authenticated admin projections call this; never add to public file/run schemas. */
export async function getAdminRangeMappings(
    sql: postgres.Sql,
    fileIds: string[],
): Promise<Map<string, AdminRangeMapping>> {
    if (fileIds.length === 0) return new Map();
    const rows = await sql<{ file_id: string; current: boolean; proof: unknown }[]>`
        WITH observations AS MATERIALIZED (
            SELECT file_id, current_range_mapping_proof(file_id) AS current,
                CASE WHEN octet_length(proof::text) <= 65536 THEN proof END AS proof
            FROM file_range_mapping_proofs WHERE file_id = ANY(${fileIds}::uuid[])
        )
        SELECT file_id, current, CASE WHEN current THEN proof ELSE NULL END AS proof
        FROM observations`;
    return new Map<string, AdminRangeMapping>(
        rows.map((row) => {
            const parsed = row.current ? RangeMappingProofSchema.safeParse(row.proof) : undefined;
            return [
                row.file_id,
                parsed?.success ? { state: 'current', proof: parsed.data } : { state: 'unproven' },
            ];
        }),
    );
}
