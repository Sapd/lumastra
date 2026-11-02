// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sonic Embeddings Admin Query Module
 *
 * Queries for the Sonic Embeddings admin dashboard, including:
 * - Coverage statistics (done vs eligible tracks)
 * - Per-status counts
 * - Recent processing activity
 *
 * @module queries/sonic-embeddings-admin
 */

import type postgres from 'postgres';
import { MSCLAP_MODEL_ID } from './sonic-constants.js';

export interface SonicEmbeddingsStats {
    eligibleTracks: number;
    completedTracks: number;
    pendingTracks: number;
    processingTracks: number;
    failedTracks: number;
    coveragePercent: number;
}

const MODEL_ID = MSCLAP_MODEL_ID;

/**
 * Get Sonic Embeddings coverage and status statistics.
 * Returns counts of eligible tracks (music type with file paths) and their embedding status.
 */
export async function getSonicEmbeddingsStats(sql: postgres.Sql): Promise<SonicEmbeddingsStats> {
    // Count total eligible tracks (media_type='track' with at least one non-missing file).
    // Admin-only query — access decisions are enforced at the route level, not here.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const eligibleResult = await sql<{ count: bigint }[]>`
		SELECT COUNT(DISTINCT mfi.media_item_id) as count
		FROM media_file_items mfi
		JOIN media_files mf ON mf.id = mfi.file_id
		JOIN media_items mi ON mi.id = mfi.media_item_id
		WHERE mi.media_type = 'track'
		  AND NOT mf.is_missing
	`;

    const eligible = Number(eligibleResult[0]?.count ?? 0);

    // Count tracks with 'done' status
    const doneResult = await sql<{ count: bigint }[]>`
		SELECT COUNT(DISTINCT media_id) as count
		FROM media_audio_embedding_state
		WHERE model_id = ${MODEL_ID}
		  AND status = 'done'
	`;

    const done = Number(doneResult[0]?.count ?? 0);

    // Get all status counts
    const statusCounts = await sql<{ status: string; count: bigint }[]>`
		SELECT status, COUNT(DISTINCT media_id) as count
		FROM media_audio_embedding_state
		WHERE model_id = ${MODEL_ID}
		GROUP BY status
	`;

    const statusMap = new Map(statusCounts.map((row) => [row.status, Number(row.count)]));

    return {
        eligibleTracks: eligible,
        completedTracks: done,
        pendingTracks: statusMap.get('pending') ?? 0,
        processingTracks: statusMap.get('processing') ?? 0,
        failedTracks: statusMap.get('failed') ?? 0,
        coveragePercent: eligible > 0 ? Math.round((done / eligible) * 100) : 0,
    };
}

/**
 * Make every failed track eligible for the sonic backfill again by zeroing its consecutive-
 * failure counter. Backs "Retry all failed items" on the task page: the backfill keeps its
 * give-up state here, not in `media_item_stage_state`, so the generic stage reset never
 * reached it. Rows stay `failed` until the next run embeds them. Returns rows reset.
 */
export async function resetFailedSonicEmbeddingAttempts(sql: postgres.Sql): Promise<number> {
    const result = await sql`
        UPDATE media_audio_embedding_state
           SET attempts = 0, updated_at = now()
         WHERE model_id = ${MODEL_ID}
           AND status = 'failed'
           AND attempts > 0
    `;
    return result.count ?? 0;
}
