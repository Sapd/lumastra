// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Series Health Service
 *
 * Identity-based ordering health (DB-only): checkOrderingHealth checks the
 * episode_orderings link ratio of a series' active non-standard ordering.
 *
 * The provider-count half (episodes held vs. listed) is a live catalog count:
 * `getSeriesEpisodeCoverage` in series-health.queries. The TMDB-comparing
 * `analyzeSeriesHealth` that used to snapshot it into `series_health_reports`
 * lost its only caller in March (dd4d90561) and was deleted with its table's
 * readers.
 */

import type postgres from 'postgres';
import type { HealthStatus } from '$lib/server/database/queries/series-health.queries.js';
import { getSeriesOrdering } from '$lib/server/database/queries/episode-orderings.queries.js';

// ============================================================================
// Identity-based health check (DB-only, no external API calls)
// ============================================================================

export interface UnlinkedEpisode {
    orderSeasonNumber: number | null;
    orderEpisodeNumber: number;
    episodeTitle: string | null;
}

export interface IdentityHealthReport {
    status: HealthStatus;
    orderingType: string;
    orderingGroupId: string | null;
    total: number;
    linked: number;
    unlinked: number;
    linkRatio: number;
    unlinkedEpisodes: UnlinkedEpisode[];
}

/**
 * Determine health status from a link ratio.
 * ≥95% = healthy, 70–94% = warning, <70% (with episodes) = mismatch, 0 total = unknown
 */
export function determineStatusFromLinkRatio(linked: number, total: number): HealthStatus {
    if (total === 0) return 'unknown';
    const ratio = linked / total;
    if (ratio >= 0.95) return 'healthy';
    if (ratio >= 0.7) return 'warning';
    return 'mismatch';
}

/**
 * Check ordering health using only local database data.
 *
 * Queries episode_orderings for the active non-standard ordering and returns
 * link counts, link ratio, status, and the list of unlinked episodes.
 *
 * Returns null when no non-standard ordering is active for this series.
 */
export async function checkOrderingHealth(
    sql: postgres.Sql,
    seriesId: string,
): Promise<IdentityHealthReport | null> {
    const orderingRow = await getSeriesOrdering(sql, seriesId);
    if (!orderingRow || orderingRow.ordering_type === 'standard') {
        return null;
    }

    const { ordering_type, ordering_group_id } = orderingRow;

    const rows = await sql<
        {
            order_season_number: number | null;
            order_episode_number: number;
            is_linked: boolean;
            episode_title: string | null;
        }[]
    >`
        SELECT
            eo.order_season_number,
            eo.order_episode_number,
            eo.episode_media_id IS NOT NULL AS is_linked,
            mi.title AS episode_title
        FROM episode_orderings eo
        LEFT JOIN media_items mi ON mi.id = eo.episode_media_id
        WHERE eo.series_media_id = ${seriesId}
          AND eo.ordering_type = ${ordering_type}
          ${ordering_group_id ? sql`AND eo.ordering_group_id = ${ordering_group_id}` : sql``}
        ORDER BY eo.order_season_number, eo.order_episode_number
    `;

    const total = rows.length;
    const linked = rows.filter((r) => r.is_linked).length;
    const unlinked = total - linked;
    const linkRatio = total > 0 ? linked / total : 0;
    const status = determineStatusFromLinkRatio(linked, total);

    const unlinkedEpisodes: UnlinkedEpisode[] = rows
        .filter((r) => !r.is_linked)
        .map((r) => ({
            orderSeasonNumber: r.order_season_number,
            orderEpisodeNumber: r.order_episode_number,
            episodeTitle: r.episode_title,
        }));

    return {
        status,
        orderingType: ordering_type,
        orderingGroupId: ordering_group_id,
        total,
        linked,
        unlinked,
        linkRatio,
        unlinkedEpisodes,
    };
}
