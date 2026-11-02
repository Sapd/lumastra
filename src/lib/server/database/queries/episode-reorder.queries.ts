// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Episode Reorder Queries
 *
 * Queries for verifying and updating episode ordering within a series.
 */

import type postgres from 'postgres';

/**
 * Verify that all given episode IDs belong to the specified series
 * (either as direct children or children of the series' seasons).
 * Returns the set of IDs that are valid.
 */
export async function verifyEpisodesBelongToSeries(
    sql: postgres.Sql,
    seriesId: string,
    episodeIds: string[],
): Promise<Set<string>> {
    const rows = await sql<{ id: string }[]>`
        SELECT id FROM media_items
        WHERE id = ANY(${episodeIds})
          AND media_type = 'episode'
          AND (
              parent_id = ${seriesId}
              OR parent_id IN (
                  SELECT s.id FROM media_items s
                  WHERE s.parent_id = ${seriesId} AND s.media_type = 'season'
              )
          )
    `;
    return new Set(rows.map((r) => r.id));
}

/**
 * Atomically update episode_number for a batch of episodes.
 * Runs all updates in a single transaction.
 */
export async function reorderEpisodes(
    sql: postgres.Sql,
    items: Array<{ id: string; episodeNumber: number }>,
): Promise<void> {
    if (items.length === 0) return;

    await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        const ids = items.map((i) => i.id);

        // Step 1: Clear episode_numbers to NULL so rows drop out of the
        // partial unique index (uq_media_items_episode). This avoids
        // unique-constraint violations during the reorder.
        await tx`
            UPDATE media_items
            SET episode_number = NULL
            WHERE id = ANY(${ids}::uuid[])
        `;

        // Step 2: Assign final episode numbers.
        for (const item of items) {
            await tx`
                UPDATE media_items
                SET episode_number = ${item.episodeNumber},
                    updated_at = NOW()
                WHERE id = ${item.id}
            `;
        }
    });
}
