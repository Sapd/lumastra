// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Queries backing the download-pool embedding projection feature — the
 * fit-once `music_embedding_projection_basis` table and the
 * `media_audio_embeddings.projection_version` / `.projected_vector` columns
 * it stamps. See migration 16.224.0 and
 * `.superpowers/embedding-quantization-eval.md` for the measurements.
 */

import type postgres from 'postgres';
import type { ProjectionBasis } from '$lib/server/services/music-embedding-projection/types.js';
import { bufferToBasis } from '$lib/server/services/music-embedding-projection/fit.js';

/**
 * Version stamp for the projection basis this codebase's fit/apply code
 * expects. Mirrors the `ROTATION_SCORE_VERSION` precedent
 * (`music-downloads.queries.ts`) — pinned by a test for the same reason:
 * bumping this without a corresponding new basis row + backfill would leave
 * `/candidates` silently emitting a version that no `music_embedding_projection_basis`
 * row (and therefore no `projected_vector`) actually matches, which
 * `getActiveProjectionBasis` below turns into "treat as absent" rather than
 * serving a mismatched basis.
 *
 * A version bump is a FULL client cache invalidation, unlike
 * `ROTATION_SCORE_VERSION` (stale ranks are just mildly wrong order): a stale
 * projection is measured at 16.4-39.4% recall, worse than the Essentia
 * fallback it replaced. See the wire schema's description on
 * `embeddingProjectionVersion`.
 */
export const EMBEDDING_PROJECTION_VERSION = 1;

interface ProjectionBasisRow {
    model_id: string;
    version: number;
    input_dim: number;
    output_dim: number;
    matrix: Buffer;
    corpus_size: number;
    fitted_at: Date;
}

/**
 * Load the basis this codebase's `EMBEDDING_PROJECTION_VERSION` expects, or
 * `null` if the fit task has not produced it yet (fresh install / corpus too
 * small / basis row lost — see migration 16.224.0's docstring). Deliberately
 * does NOT fall back to an older version's row: a vector encoded under a
 * different version is exactly the mixed-basis comparison the eval doc
 * measured as catastrophic, so "no current basis" must behave identically to
 * callers as "no basis at all", not "use whatever we have".
 */
export async function getActiveProjectionBasis(
    sql: postgres.Sql,
    modelId: string,
): Promise<ProjectionBasis | null> {
    const rows = await sql<ProjectionBasisRow[]>`
        SELECT model_id, version, input_dim, output_dim, matrix, corpus_size, fitted_at
        FROM music_embedding_projection_basis
        WHERE model_id = ${modelId} AND version = ${EMBEDDING_PROJECTION_VERSION}
    `;
    const row = rows[0];
    if (!row) return null;
    return bufferToBasis(row.matrix, {
        version: row.version,
        modelId: row.model_id,
        inputDim: row.input_dim,
        outputDim: row.output_dim,
    });
}

/** Whether a basis row already exists for `(modelId, version)` — the fit task's overwrite guard. */
export async function projectionBasisExists(
    sql: postgres.Sql,
    modelId: string,
    version: number,
): Promise<boolean> {
    const rows = await sql<{ exists: boolean }[]>`
        SELECT EXISTS(
            SELECT 1 FROM music_embedding_projection_basis
            WHERE model_id = ${modelId} AND version = ${version}
        ) AS exists
    `;
    return rows[0]?.exists ?? false;
}

/**
 * Persist a freshly fit basis. `ON CONFLICT DO NOTHING` — this NEVER
 * overwrites an existing `(model_id, version)` row (see migration 16.224.0
 * and fit.ts for why an overwrite would be catastrophic). Returns whether the
 * row was actually inserted, so the caller (the fit task) can tell "wrote a
 * new basis" apart from "one already existed, this fit was discarded" and
 * log accordingly rather than silently believing it just rotated the basis.
 */
export async function insertProjectionBasisIfAbsent(
    sql: postgres.Sql,
    params: {
        modelId: string;
        version: number;
        inputDim: number;
        outputDim: number;
        matrix: Buffer;
        corpusSize: number;
    },
): Promise<boolean> {
    const result = await sql`
        INSERT INTO music_embedding_projection_basis
            (model_id, version, input_dim, output_dim, matrix, corpus_size)
        VALUES (
            ${params.modelId}, ${params.version}, ${params.inputDim},
            ${params.outputDim}, ${params.matrix}, ${params.corpusSize}
        )
        ON CONFLICT (model_id, version) DO NOTHING
    `;
    return result.count > 0;
}

export interface PendingProjectionRow {
    media_id: string;
    embedding: string;
}

/**
 * Embeddings for `modelId` that do not yet carry a `projected_vector` for
 * `currentVersion` — the backfill task's drain query. Catches both "never
 * projected" (`projection_version IS NULL`) and "projected under a stale
 * version" (a version bump whose backfill has not reached this row yet).
 */
export async function fetchPendingProjectionRows(
    sql: postgres.Sql,
    modelId: string,
    currentVersion: number,
    limit: number,
): Promise<PendingProjectionRow[]> {
    return sql<PendingProjectionRow[]>`
        SELECT media_id::text AS media_id, embedding::text AS embedding
        FROM media_audio_embeddings
        WHERE model_id = ${modelId}
          AND (projection_version IS NULL OR projection_version <> ${currentVersion})
        LIMIT ${limit}
    `;
}

/**
 * Count of `(modelId, version)` embedding rows already stamped with `version`
 * — the fit task's basis-loss guard. If this is nonzero while
 * `projectionBasisExists` is false for the same `(modelId, version)`, the
 * basis row that produced those stamps is gone (e.g. a targeted DELETE or a
 * partial restore) but the rows it produced survive: fitting a fresh matrix
 * now would insert it under the SAME version number the surviving rows were
 * encoded against, permanently and silently mixing two incompatible bases
 * under one indistinguishable stamp. See migration 16.224.0 and the fit
 * task's module docstring.
 */
export async function countEmbeddingsStampedForVersion(
    sql: postgres.Sql,
    modelId: string,
    version: number,
): Promise<number> {
    const rows = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM media_audio_embeddings
        WHERE model_id = ${modelId} AND projection_version = ${version}
    `;
    return rows[0]?.count ?? 0;
}

/** Count of embeddings still pending a current-version projection — backlog reporting. */
export async function countPendingProjectionRows(
    sql: postgres.Sql,
    modelId: string,
    currentVersion: number,
): Promise<number> {
    const rows = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM media_audio_embeddings
        WHERE model_id = ${modelId}
          AND (projection_version IS NULL OR projection_version <> ${currentVersion})
    `;
    return rows[0]?.count ?? 0;
}

/** Stamp the quantized projection onto an existing embedding row. */
export async function updateEmbeddingProjection(
    sql: postgres.Sql,
    mediaId: string,
    modelId: string,
    version: number,
    projectedVector: Buffer,
): Promise<void> {
    await sql`
        UPDATE media_audio_embeddings
        SET projection_version = ${version},
            projected_vector = ${projectedVector}
        WHERE media_id = ${mediaId}::uuid AND model_id = ${modelId}
    `;
}
