// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

/** Global physical-file totals, independent of the admin's current media context. */
export async function getFileAssociationCounts(
    sql: postgres.Sql,
    fileIds: string[],
): Promise<Map<string, number>> {
    const ids = [...new Set(fileIds)];
    if (ids.length === 0) return new Map();
    const rows = await sql<{ file_id: string; linked_media_count: number }[]>`
        SELECT file_id, COUNT(*)::int AS linked_media_count
        FROM media_file_items WHERE file_id = ANY(${ids}::uuid[])
        GROUP BY file_id
    `;
    return new Map(rows.map((row) => [row.file_id, row.linked_media_count]));
}
