// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Undo records for the reconciliation services (`episode_reconciliation_moves`).
 *
 * Apply writes one row per changed episode, including released holders, in the
 * same transaction. Connected identity changes share group_id and are undone
 * together; independent moves have no group. `undone_at` is set by the undo
 * transaction (episode-reconciliation-undo.service.ts).
 */

import type postgres from 'postgres';

export type ReconciliationMoveService =
    'absolute-numbering' | 'season-structure' | 'filename-title';

/**
 * `sync_quarantine.provider` per service. Holds that service's proposals and the
 * resolved `dismissed` rows that block a pair (an undone move, a rejected
 * proposal). Distinct from the backfill's 'lumastra-reconcile', whose
 * self-draining pass re-evaluates every unresolved row of that provider.
 */
export const RECONCILIATION_QUARANTINE_PROVIDER: Record<ReconciliationMoveService, string> = {
    'filename-title': 'lumastra-reconcile-filename-title',
    'absolute-numbering': 'lumastra-reconcile-absolute',
    'season-structure': 'lumastra-reconcile-season-structure',
};

/** Every provider whose dismissed rows block a reconciliation pair. */
export const RECONCILIATION_BLOCK_PROVIDERS: string[] = Object.values(
    RECONCILIATION_QUARANTINE_PROVIDER,
);

/**
 * `sync_quarantine.external_id` of a proposal or block marker: ONE row per
 * (episode, TMDB episode) pair. Keyed by the episode alone, a later proposal or
 * undo for another target of the same episode overwrote an earlier dismissal and
 * let the dismissed pair come back.
 */
export function reconciliationPairKey(episodeId: string, tmdbEpisodeId: string): string {
    return `${episodeId}:${tmdbEpisodeId}`;
}

/**
 * Pairs of these episodes an admin dismissed or undid, as
 * {@link reconciliationPairKey} keys. Rows written before the key held the
 * target (external_id = the episode id alone, the target only in the payload)
 * count as well. A marker of either reconciliation service blocks the pair for
 * both: an admin who undid an absolute-numbering move does not want the
 * season-structure pass to bind the same pair again, and vice versa.
 */
export async function loadBlockedPairKeys(
    sql: postgres.Sql,
    episodeIds: string[],
): Promise<Set<string>> {
    if (episodeIds.length === 0) return new Set();
    const rows = await sql<{ pair_key: string }[]>`
        SELECT CASE WHEN position(':' IN external_id) > 0
                    THEN external_id
                    ELSE external_id || ':' || COALESCE(payload->>'tmdbEpisodeId', '')
               END AS pair_key
        FROM sync_quarantine
        WHERE provider = ANY(${RECONCILIATION_BLOCK_PROVIDERS}::text[])
          AND media_type = 'episode'
          AND resolved_at IS NOT NULL
          AND resolution = 'dismissed'
          AND split_part(external_id, ':', 1) = ANY(${episodeIds}::text[])
    `;
    return new Set(rows.map((r) => r.pair_key));
}

export interface ReconciliationMoveInsert {
    seriesId: string;
    episodeId: string;
    service: ReconciliationMoveService;
    evidence: string | null;
    ghostId: string | null;
    tmdbEpisodeId: string;
    prevTmdbEpisodeId?: string | null;
    /** Connected identity changes must be undone in the same transaction. */
    groupId?: string | null;
    /** This row records releasing a holder, with no replacement identity. */
    identityReleased?: boolean;
    fromParentId: string | null;
    fromSeason: number;
    fromEpisode: number;
    toParentId: string | null;
    toSeason: number;
    toEpisode: number;
    prevTitleBinding: string | null;
    prevTitle: string | null;
    prevOverview: string | null;
    /** still_path before the move, restored by undo (null clears it) */
    prevStillPath: string | null;
    mergeStats: Record<string, number> | null;
}

export interface ReconciliationMove {
    id: string;
    seriesId: string;
    seriesTitle: string | null;
    /** Null once the episode was deleted: the record stays, the undo has nothing to move */
    episodeId: string | null;
    service: ReconciliationMoveService;
    evidence: string | null;
    ghostId: string | null;
    tmdbEpisodeId: string;
    prevTmdbEpisodeId?: string | null;
    /** Connected identity changes must be undone in the same transaction. */
    groupId?: string | null;
    /** This row records releasing a holder, with no replacement identity. */
    identityReleased?: boolean;
    fromParentId: string | null;
    fromSeason: number;
    fromEpisode: number;
    toParentId: string | null;
    toSeason: number;
    toEpisode: number;
    prevTitleBinding: string | null;
    prevTitle: string | null;
    prevOverview: string | null;
    prevStillPath: string | null;
    mergeStats: Record<string, number> | null;
    appliedAt: Date;
    undoneAt: Date | null;
    undoneBy: string | null;
    /** Current title of the episode row, when it still exists */
    episodeTitle: string | null;
}

interface MoveRow {
    id: string;
    series_id: string;
    series_title: string | null;
    episode_id: string | null;
    service: ReconciliationMoveService;
    evidence: string | null;
    ghost_id: string | null;
    tmdb_episode_id: string;
    prev_tmdb_episode_id: string | null;
    group_id: string | null;
    identity_released: boolean;
    from_parent_id: string | null;
    from_season: number;
    from_episode: number;
    to_parent_id: string | null;
    to_season: number;
    to_episode: number;
    prev_title_binding: string | null;
    prev_title: string | null;
    prev_overview: string | null;
    prev_still_path: string | null;
    merge_stats: Record<string, number> | null;
    applied_at: Date;
    undone_at: Date | null;
    undone_by: string | null;
    episode_title: string | null;
}

const MAX_LIMIT = 200;

function rowToMove(r: MoveRow): ReconciliationMove {
    return {
        id: r.id,
        seriesId: r.series_id,
        seriesTitle: r.series_title,
        episodeId: r.episode_id,
        service: r.service,
        evidence: r.evidence,
        ghostId: r.ghost_id,
        tmdbEpisodeId: r.tmdb_episode_id,
        prevTmdbEpisodeId: r.prev_tmdb_episode_id,
        groupId: r.group_id,
        identityReleased: r.identity_released,
        fromParentId: r.from_parent_id,
        fromSeason: r.from_season,
        fromEpisode: r.from_episode,
        toParentId: r.to_parent_id,
        toSeason: r.to_season,
        toEpisode: r.to_episode,
        prevTitleBinding: r.prev_title_binding,
        prevTitle: r.prev_title,
        prevOverview: r.prev_overview,
        prevStillPath: r.prev_still_path,
        mergeStats: r.merge_stats,
        appliedAt: r.applied_at,
        undoneAt: r.undone_at,
        undoneBy: r.undone_by,
        episodeTitle: r.episode_title,
    };
}

/** Insert the undo record of an applied pair. Call it on the pair's transaction handle. */
export async function insertReconciliationMove(
    sql: postgres.Sql,
    m: ReconciliationMoveInsert,
): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO episode_reconciliation_moves (
            series_id, episode_id, service, evidence, ghost_id, tmdb_episode_id,
            from_parent_id, from_season, from_episode,
            to_parent_id, to_season, to_episode,
            prev_title_binding, prev_title, prev_overview, prev_still_path, merge_stats, prev_tmdb_episode_id, group_id, identity_released
        )
        VALUES (
            ${m.seriesId}, ${m.episodeId}, ${m.service}, ${m.evidence}, ${m.ghostId},
            ${m.tmdbEpisodeId},
            ${m.fromParentId}, ${m.fromSeason}, ${m.fromEpisode},
            ${m.toParentId}, ${m.toSeason}, ${m.toEpisode},
            ${m.prevTitleBinding}, ${m.prevTitle}, ${m.prevOverview}, ${m.prevStillPath},
            ${m.mergeStats ? sql.json(m.mergeStats) : null}, ${m.prevTmdbEpisodeId ?? null},
            ${m.groupId ?? null}, ${m.identityReleased ?? false}
        )
        RETURNING id
    `;
    if (!row) throw new Error('insertReconciliationMove: insert returned no row');
    return row.id;
}

/**
 * Recent moves, newest first, optionally for one series. `limit` is clamped to
 * `[1, MAX_LIMIT]`.
 */
export async function listReconciliationMoves(
    sql: postgres.Sql,
    opts: { seriesId?: string; limit?: number } = {},
): Promise<ReconciliationMove[]> {
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(opts.limit ?? 50)));
    const seriesFilter = opts.seriesId
        ? sql`WHERE m.series_id = ${opts.seriesId}`
        : sql`WHERE TRUE`;
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only reconciliation audit list: the operator sees every series regardless of library/age visibility
    const rows = await sql<MoveRow[]>`
        SELECT m.*, series.title AS series_title, ep.title AS episode_title
        FROM episode_reconciliation_moves m
        LEFT JOIN media_items series ON series.id = m.series_id
        LEFT JOIN media_items ep ON ep.id = m.episode_id
        ${seriesFilter}
        ORDER BY m.applied_at DESC, m.id DESC
        LIMIT ${limit}
    `;
    return rows.map(rowToMove);
}

/** One move, locked FOR UPDATE when called inside a transaction. */
export async function getReconciliationMoveForUpdate(
    sql: postgres.Sql,
    id: string,
): Promise<ReconciliationMove | null> {
    // Locks only the move row; the media_items joins of the list query are not needed here.
    const rows = await sql<MoveRow[]>`
        SELECT m.*, NULL::text AS series_title, NULL::text AS episode_title
        FROM episode_reconciliation_moves m
        WHERE m.id = ${id}
        FOR UPDATE OF m
    `;
    return rows[0] ? rowToMove(rows[0]) : null;
}

/** Lock every member, including undone rows so partial groups fail closed. */
export async function getReconciliationMoveGroupForUpdate(
    sql: postgres.Sql,
    move: ReconciliationMove,
): Promise<ReconciliationMove[]> {
    if (!move.groupId) return [move];
    const rows = await sql<MoveRow[]>`
        SELECT m.*, NULL::text AS series_title, NULL::text AS episode_title
        FROM episode_reconciliation_moves m
        WHERE m.group_id = ${move.groupId} AND m.series_id = ${move.seriesId}
        ORDER BY m.id
        FOR UPDATE OF m
    `;
    return rows.map(rowToMove);
}

export async function markReconciliationMoveUndone(
    sql: postgres.Sql,
    id: string,
    undoneBy: string,
): Promise<void> {
    await sql`
        UPDATE episode_reconciliation_moves
        SET undone_at = NOW(), undone_by = ${undoneBy}
        WHERE id = ${id}
    `;
}
