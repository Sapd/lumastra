// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media External Groupings Query Module
 *
 * Manages two tables that map individual media items (episodes, movies) to entries
 * in external list providers such as MyAnimeList (MAL):
 *
 *   media_external_groupings — many-to-one: N episodes → one external entry
 *     (e.g., a multi-cour anime where cours 1+2 share one MAL entry).
 *     Multiple sources (plugins, admin overrides) may write conflicting rows for
 *     the same (media_id, provider). Precedence is:
 *       source='admin-override'  >  any other source  >  most-recent created_at
 *
 *   series_grouping_state — tracks enrichment progress per (series, provider, source)
 *     so plugins can skip unchanged series and detect episode-count drift.
 *
 * The admin-override precedence rule lives exclusively in SQL (effectiveMappingFragment).
 * No caller should re-implement it in JavaScript.
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';

// =============================================================================
// Types
// =============================================================================

export interface GroupingRow {
    mediaId: string;
    provider: string;
    groupExternalId: string;
    source: string;
}

export interface SeriesGroupingState {
    seriesId: string;
    provider: string;
    source: string;
    lastEnrichedAt: Date;
    chainSignature: string;
    flattenedEpisodeCount: number;
    enrichedEpisodeCount: number;
}

export interface EnrichmentCandidate {
    seriesId: string;
    seriesMalId: string;
}

export interface EnrichmentBacklog {
    /** Series that have a current state row (have been enriched at least once). */
    analyzed: number;
    /** Series that are candidates for (re-)enrichment per the staleness rules. */
    remaining: number;
    /** Anime series that have no stored MAL ID — enrichment cannot proceed. */
    ineligible: number;
}

// =============================================================================
// Effective mapping fragment
// =============================================================================

/**
 * Returns a postgres.js fragment that produces a subquery table expression
 * yielding (media_id, group_external_id, source) with admin-override precedence
 * applied. The fragment is designed to be embedded directly inside a FROM clause
 * using postgres.js template interpolation:
 *
 *   const rows = await sql`
 *       SELECT em.media_id, em.group_external_id
 *       FROM (${effectiveMappingFragment(sql, 'mal')}) em
 *       WHERE em.media_id = ${mediaId}::uuid
 *   `;
 *
 * A fragment (not a CTE) is used so callers can incorporate it into larger
 * statements without WITH-clause juggling — postgres.js inlines the fragment
 * at the call-site.
 *
 * Precedence: source='admin-override' wins over anything else; ties broken by
 * created_at DESC. This is the single source of truth for the override rule.
 */
export function effectiveMappingFragment(
    sql: postgres.Sql,
    provider: string,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`
        SELECT DISTINCT ON (media_id)
            media_id,
            group_external_id,
            source
        FROM media_external_groupings
        WHERE provider = ${provider}
        ORDER BY
            media_id,
            CASE source WHEN 'admin-override' THEN 0 ELSE 1 END,
            created_at DESC
    `;
}

// =============================================================================
// Single-item lookup
// =============================================================================

/**
 * Resolve the effective group_external_id for a single media item.
 * Returns null when no mapping exists.
 */
export async function getEffectiveMapping(
    sql: postgres.Sql,
    mediaId: string,
    provider: string,
): Promise<string | null> {
    const rows = await sql<[{ group_external_id: string }?]>`
        SELECT em.group_external_id
        FROM (${effectiveMappingFragment(sql, provider)}) em
        WHERE em.media_id = ${mediaId}::uuid
    `;
    return rows[0]?.group_external_id ?? null;
}

// =============================================================================
// Watch-count aggregation
// =============================================================================

/**
 * Count episodes the user has watched that map to a given external grouping entry.
 * Used by MAL push to report the correct episode count when the provider entry
 * covers multiple cours (each mapping to the same group_external_id).
 */
export async function countWatchedByGrouping(
    sql: postgres.Sql,
    userId: UserId,
    provider: string,
    groupExternalId: string,
): Promise<number> {
    const rows = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text AS count
        FROM (${effectiveMappingFragment(sql, provider)}) em
        JOIN user_media_state ums
            ON ums.media_id = em.media_id
           AND ums.user_id   = ${userId}
        WHERE em.group_external_id = ${groupExternalId}
          AND ums.is_watched = true
    `;
    return parseInt(rows[0]?.count ?? '0', 10);
}

// =============================================================================
// Bulk write
// =============================================================================

/**
 * Upsert a batch of grouping rows.
 * Conflict key: (media_id, provider, source).
 * On conflict the group_external_id is overwritten and created_at is refreshed
 * so that the precedence ORDER BY created_at DESC always reflects the latest
 * write from this source.
 *
 * Returns immediately when the rows array is empty (no-op, no round-trip).
 */
export async function upsertGroupings(sql: postgres.Sql, rows: GroupingRow[]): Promise<void> {
    if (rows.length === 0) return;

    // Per-row loop. The bulk SELECT-from-VALUES pattern via `sql(values) AS v (...)`
    // throws "str.replace is not a function" in postgres.js v3 when the alias
    // form is combined with ON CONFLICT. A series produces at most a few hundred
    // mappings — loop overhead is negligible.
    for (const r of rows) {
        await sql`
            INSERT INTO media_external_groupings
                (media_id, provider, group_external_id, source)
            VALUES (
                ${r.mediaId}::uuid,
                ${r.provider},
                ${r.groupExternalId},
                ${r.source}
            )
            ON CONFLICT (media_id, provider, source) DO UPDATE
                SET group_external_id = EXCLUDED.group_external_id,
                    created_at        = NOW()
        `;
    }
}

// =============================================================================
// Stale cleanup
// =============================================================================

/**
 * After an enrichment pass writes the current chain's mappings, prior rows for
 * episodes in this series that are no longer in the chain must be removed.
 * This handles MAL chain shrinking: if a season's episode list shortens (e.g.,
 * a re-import with fewer resolved episodes), stale groupings would cause
 * incorrect watch-count aggregation.
 *
 * Only deletes rows whose source matches the caller — admin-override rows are
 * never touched.
 *
 * Returns the number of rows deleted.
 */
export async function deleteStaleGroupings(
    sql: postgres.Sql,
    seriesId: string,
    provider: string,
    source: string,
    keepMediaIds: string[],
): Promise<number> {
    // Refuse to mass-delete on empty keepMediaIds. Callers that want a true
    // wipe must use wipeEnrichmentRows() (provider+source level) or write
    // an explicit per-series wipe helper. An empty list here is always a
    // defect — it would wipe prior good state.
    if (keepMediaIds.length === 0) return 0;

    const result = await sql<[{ count: string }]>`
        WITH deleted AS (
            DELETE FROM media_external_groupings meg
            WHERE meg.provider = ${provider}
              AND meg.source    = ${source}
              AND meg.media_id IN (
                  SELECT mi.id
                  FROM media_items mi
                  WHERE mi.parent_id = ${seriesId}::uuid
                     OR mi.parent_id IN (
                         SELECT id FROM media_items WHERE parent_id = ${seriesId}::uuid
                     )
              )
              AND meg.media_id <> ALL(${keepMediaIds}::uuid[])
            RETURNING 1
        )
        SELECT COUNT(*)::text AS count FROM deleted
    `;
    return parseInt(result[0]?.count ?? '0', 10);
}

// =============================================================================
// Series grouping state
// =============================================================================

interface SeriesGroupingStateRow {
    series_id: string;
    provider: string;
    source: string;
    last_enriched_at: Date;
    chain_signature: string;
    flattened_episode_count: number;
    enriched_episode_count: number;
}

function rowToState(row: SeriesGroupingStateRow): SeriesGroupingState {
    return {
        seriesId: row.series_id,
        provider: row.provider,
        source: row.source,
        lastEnrichedAt: row.last_enriched_at,
        chainSignature: row.chain_signature,
        flattenedEpisodeCount: row.flattened_episode_count,
        enrichedEpisodeCount: row.enriched_episode_count,
    };
}

export async function getSeriesGroupingState(
    sql: postgres.Sql,
    seriesId: string,
    provider: string,
    source: string,
): Promise<SeriesGroupingState | null> {
    const rows = await sql<SeriesGroupingStateRow[]>`
        SELECT
            series_id,
            provider,
            source,
            last_enriched_at,
            chain_signature,
            flattened_episode_count,
            enriched_episode_count
        FROM series_grouping_state
        WHERE series_id = ${seriesId}::uuid
          AND provider  = ${provider}
          AND source    = ${source}
    `;
    return rows[0] ? rowToState(rows[0]) : null;
}

/**
 * Persist enrichment progress for a series.
 * On conflict the state is fully overwritten and last_enriched_at is set to NOW()
 * so the staleness check (last_enriched_at < NOW() - INTERVAL '30 days') resets.
 */
export async function upsertSeriesGroupingState(
    sql: postgres.Sql,
    state: SeriesGroupingState,
): Promise<void> {
    await sql`
        INSERT INTO series_grouping_state
            (series_id, provider, source, last_enriched_at, chain_signature,
             flattened_episode_count, enriched_episode_count)
        VALUES (
            ${state.seriesId}::uuid,
            ${state.provider},
            ${state.source},
            NOW(),
            ${state.chainSignature},
            ${state.flattenedEpisodeCount},
            ${state.enrichedEpisodeCount}
        )
        ON CONFLICT (series_id, provider, source) DO UPDATE
            SET last_enriched_at       = NOW(),
                chain_signature        = EXCLUDED.chain_signature,
                flattened_episode_count = EXCLUDED.flattened_episode_count,
                enriched_episode_count  = EXCLUDED.enriched_episode_count
    `;
}

// =============================================================================
// Enrichment candidate queries
// =============================================================================

/**
 * Return series that need (re-)enrichment. A series is a candidate when any of:
 *   1. No state row exists (never enriched).
 *   2. Episode count has drifted (flattened_episode_count differs from the
 *      current count of direct child episodes in media_items).
 *   3. last_enriched_at is older than 30 days.
 *
 * Chain-signature drift (detecting changed MAL chain structure) is intentionally
 * excluded here: it requires API calls to compute, so it is checked per-series
 * during the processing loop, not in the database.
 *
 * Eligibility requirements (all must hold):
 *   - media_type IN ('tv', 'series') and status = 'active'
 *   - Has a provider_metadata row with a non-empty anime_genres array
 *     (uses CASE guard to avoid jsonb_array_length throwing on scalar nulls)
 *   - Has an external_ids row with provider = 'mal' (the series-level MAL ID
 *     written by Fribb sync)
 *
 * Results are ordered by series UUID ascending. Pass `afterId` for keyset paging.
 */
export async function getEnrichmentCandidates(
    sql: postgres.Sql,
    provider: string,
    source: string,
    limit: number,
    afterId?: string,
): Promise<EnrichmentCandidate[]> {
    const afterClause = afterId ? sql`AND mi.id > ${afterId}::uuid` : sql``;

    const rows = await sql<{ series_id: string; series_mal_id: string }[]>`
        SELECT
            mi.id          AS series_id,
            ei.external_id AS series_mal_id
        FROM media_items mi
        JOIN external_ids ei
            ON ei.media_id = mi.id
           AND ei.provider = ${provider}
        JOIN provider_metadata pm
            ON pm.media_id = mi.id
        WHERE mi.media_type IN ('tv', 'series')
          AND mi.status = 'active'
          AND CASE
              WHEN jsonb_typeof(pm.metadata->'anime_genres') = 'array'
                  THEN jsonb_array_length(pm.metadata->'anime_genres')
              ELSE 0
          END > 0
          ${afterClause}
          AND (
              -- 1. Never enriched
              NOT EXISTS (
                  SELECT 1 FROM series_grouping_state sgs
                  WHERE sgs.series_id = mi.id
                    AND sgs.provider  = ${provider}
                    AND sgs.source    = ${source}
              )
              OR EXISTS (
                  SELECT 1 FROM series_grouping_state sgs
                  WHERE sgs.series_id = mi.id
                    AND sgs.provider  = ${provider}
                    AND sgs.source    = ${source}
                    AND (
                        -- 2. Episode count drift — must match flattenSeriesEpisodesRaw exactly:
                        --    canonical episodes (season_number > 0), under series OR under seasons.
                        sgs.flattened_episode_count <> (
                            SELECT COUNT(*)
                            FROM media_items ep
                            WHERE ep.media_type = 'episode'
                              AND ep.season_number IS NOT NULL
                              AND ep.season_number > 0
                              -- = ANY(ARRAY(...)) is an index condition on idx_media_items_episode_order;
                              -- the old "parent_id = x OR parent_id IN (subquery)" scanned the whole
                              -- index per series (25M buffer hits, 64 s on prod). Same rows counted.
                              AND ep.parent_id = ANY(ARRAY(
                                  SELECT mi.id
                                  UNION ALL
                                  SELECT s.id FROM media_items s
                                  WHERE s.parent_id = mi.id AND s.media_type = 'season'
                              ))
                        )
                        -- 3. Stale (30-day TTL)
                        OR sgs.last_enriched_at < NOW() - INTERVAL '30 days'
                    )
              )
          )
        ORDER BY mi.id ASC
        LIMIT ${limit}
    `;

    return rows.map((r) => ({
        seriesId: r.series_id,
        seriesMalId: r.series_mal_id,
    }));
}

// =============================================================================
// Backlog count
// =============================================================================

/**
 * Counts for the plugin's getBacklogStatus display. Three buckets:
 *   analyzed  — series with a current state row (enriched at least once)
 *   remaining — series matching candidate criteria (need enrichment now)
 *   ineligible — anime series (have anime_genres) but missing a MAL external ID
 */
export async function countEnrichmentBacklog(
    sql: postgres.Sql,
    provider: string,
    source: string,
): Promise<EnrichmentBacklog> {
    const rows = await sql<
        [
            {
                analyzed: string;
                remaining: string;
                ineligible: string;
            },
        ]
    >`
        WITH eligible_series AS (
            SELECT mi.id
            FROM media_items mi
            JOIN provider_metadata pm ON pm.media_id = mi.id
            WHERE mi.media_type IN ('tv', 'series')
              AND mi.status = 'active'
              AND CASE
                  WHEN jsonb_typeof(pm.metadata->'anime_genres') = 'array'
                      THEN jsonb_array_length(pm.metadata->'anime_genres')
                  ELSE 0
              END > 0
        ),
        with_mal_id AS (
            SELECT es.id
            FROM eligible_series es
            JOIN external_ids ei
                ON ei.media_id = es.id
               AND ei.provider = ${provider}
        ),
        analyzed AS (
            SELECT es.id
            FROM with_mal_id es
            JOIN series_grouping_state sgs
                ON sgs.series_id = es.id
               AND sgs.provider  = ${provider}
               AND sgs.source    = ${source}
        ),
        remaining AS (
            SELECT es.id
            FROM with_mal_id es
            WHERE NOT EXISTS (
                SELECT 1 FROM series_grouping_state sgs
                WHERE sgs.series_id = es.id
                  AND sgs.provider  = ${provider}
                  AND sgs.source    = ${source}
            )
            OR EXISTS (
                SELECT 1 FROM series_grouping_state sgs
                WHERE sgs.series_id = es.id
                  AND sgs.provider  = ${provider}
                  AND sgs.source    = ${source}
                  AND (
                      sgs.flattened_episode_count <> (
                          SELECT COUNT(*)
                          FROM media_items ep
                          WHERE ep.media_type = 'episode'
                            AND ep.season_number IS NOT NULL
                            AND ep.season_number > 0
                            -- = ANY(ARRAY(...)) is an index condition on idx_media_items_episode_order;
                            -- the old "parent_id = x OR parent_id IN (subquery)" scanned the whole
                            -- index per series (25M buffer hits, 64 s on prod). Same rows counted.
                            AND ep.parent_id = ANY(ARRAY(
                                SELECT es.id
                                UNION ALL
                                SELECT s.id FROM media_items s
                                WHERE s.parent_id = es.id AND s.media_type = 'season'
                            ))
                      )
                      OR sgs.last_enriched_at < NOW() - INTERVAL '30 days'
                  )
            )
        )
        SELECT
            (SELECT COUNT(*)::text FROM analyzed)   AS analyzed,
            (SELECT COUNT(*)::text FROM remaining)  AS remaining,
            (
                SELECT COUNT(*)::text
                FROM eligible_series es2
                WHERE NOT EXISTS (
                    SELECT 1 FROM external_ids ei2
                    WHERE ei2.media_id = es2.id
                      AND ei2.provider = ${provider}
                )
            )                                        AS ineligible
    `;

    const row = rows[0];
    return {
        analyzed: parseInt(row?.analyzed ?? '0', 10),
        remaining: parseInt(row?.remaining ?? '0', 10),
        ineligible: parseInt(row?.ineligible ?? '0', 10),
    };
}

// =============================================================================
// Coverage-table backlog
// =============================================================================

/**
 * Coverage-table backlog for mal-anime-id-enrichment.
 *
 * Returns series that have a retriable stage state row and still have a MAL
 * external ID available (required for enrichment).  Result shape is identical
 * to `getEnrichmentCandidates` so callers can swap the fetch without changing
 * the process-slice logic.
 */
export async function findCoverageTableBacklog(
    sql: postgres.Sql,
    stageId: string,
    provider: string,
    limit: number,
): Promise<EnrichmentCandidate[]> {
    const rows = await sql<{ series_id: string; series_mal_id: string }[]>`
        SELECT mi.id AS series_id, ei.external_id AS series_mal_id
        FROM media_item_stage_state miss
        JOIN media_items mi ON mi.id = miss.media_item_id
        JOIN external_ids ei
            ON ei.media_id = mi.id
           AND ei.provider = ${provider}
        WHERE miss.stage_id = ${stageId}
          AND miss.status IN ('pending', 'failed_transient', 'obsolete', 'skipped_transient')
          AND (miss.next_eligible_at IS NULL OR miss.next_eligible_at <= now())
        ORDER BY miss.next_eligible_at ASC NULLS FIRST, miss.updated_at ASC, mi.id ASC
        LIMIT ${limit}
    `;
    return rows.map((r) => ({
        seriesId: r.series_id,
        seriesMalId: r.series_mal_id,
    }));
}

// =============================================================================
// Force-mode wipe
// =============================================================================

/**
 * Delete all rows written by a specific source for a provider.
 * Used by force-mode to clear stale enrichment data before a full re-run.
 * Admin-override rows (source='admin-override') are never touched.
 *
 * Deletes from both tables in source order:
 *   1. media_external_groupings — the per-episode mappings
 *   2. series_grouping_state    — the enrichment progress markers
 */
export async function wipeEnrichmentRows(
    sql: postgres.Sql,
    provider: string,
    source: string,
): Promise<void> {
    await sql`
        DELETE FROM media_external_groupings
        WHERE provider = ${provider}
          AND source   = ${source}
    `;
    await sql`
        DELETE FROM series_grouping_state
        WHERE provider = ${provider}
          AND source   = ${source}
    `;
}
