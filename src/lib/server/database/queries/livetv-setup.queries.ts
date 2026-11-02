// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Live TV Guided Setup Query Module
 *
 * Pure SQL queries for the guided setup wizard.
 * All functions take sql: postgres.Sql as first parameter, no side effects.
 *
 * @module queries/livetv-setup
 */

import type postgres from 'postgres';

// =============================================================================
// Types
// =============================================================================

export interface SetupChannelRow {
    id: string;
    title: string;
    quality_tier: string | null;
    is_visible: boolean;
    sort_order: number;
    playlist_index: number | null;
    country_code: string | null;
    category_name: string | null;
    backup_group_id: string | null;
    epg_channel_id: string | null;
    /** The channel is its backup group's primary (the feed viewers see first). */
    is_primary: boolean;
}

export interface SetupSummaryRow {
    total_channels: number;
    visible_channels: number;
    quality_uhd: number;
    quality_fhd: number;
    quality_hd: number;
    quality_sd: number;
    quality_unknown: number;
    regional_variant_count: number;
    untagged_channels: number;
}

export interface CategoryCountRow {
    name: string;
    channel_count: number;
}

export interface CategoryOrderRow {
    id: string;
    name: string | null;
    sort_order: number;
}

export interface RegionCountRow {
    code: string;
    channel_count: number;
}

export interface SetupSummaryResult {
    summary: SetupSummaryRow;
    categories: CategoryCountRow[];
    detectedRegions: string[];
    regions: RegionCountRow[];
    /** The source's stored Configure Lineup choices, or null. */
    lineupFilter: unknown;
}

// =============================================================================
// Queries
// =============================================================================

/**
 * Load all channels for a source with category and setup-relevant fields.
 */
export async function getChannelsForSetup(
    sql: postgres.Sql,
    sourceId: string,
): Promise<SetupChannelRow[]> {
    return sql<SetupChannelRow[]>`
		SELECT
			lc.id,
			mi.title,
			lc.quality_tier,
			lc.is_visible,
			lc.sort_order,
			lc.playlist_index,
			lc.country_code,
			cat.name         AS category_name,
			lc.backup_group_id,
			lc.epg_channel_id,
			COALESCE(bg.primary_channel_id = lc.id, false) AS is_primary
		FROM livetv_channels lc
		JOIN media_items mi ON mi.id = lc.id
		LEFT JOIN livetv_categories cat ON cat.id = lc.category_id
		LEFT JOIN livetv_backup_groups bg ON bg.id = lc.backup_group_id
		WHERE lc.source_id = ${sourceId}
		ORDER BY lc.sort_order ASC, mi.title ASC
	`;
}

/**
 * Bulk update channel visibility using unnest() for performance with large channel sets.
 */
export async function bulkUpdateChannelVisibility(
    sql: postgres.Sql,
    updates: Array<{ id: string; isVisible: boolean }>,
): Promise<void> {
    if (updates.length === 0) return;

    const ids = updates.map((u) => u.id);
    const visibles = updates.map((u) => u.isVisible);

    await sql`
		UPDATE livetv_channels
		SET is_visible = data.visible
		FROM unnest(
			${sql.array(ids)}::uuid[],
			${sql.array(visibles)}::boolean[]
		) AS data(id, visible)
		WHERE livetv_channels.id = data.id
	`;
}

/**
 * Bulk update channel sort order using unnest() for performance with large channel sets.
 */
export async function bulkUpdateChannelSortOrder(
    sql: postgres.Sql,
    updates: Array<{ id: string; sortOrder: number }>,
): Promise<void> {
    if (updates.length === 0) return;

    const ids = updates.map((u) => u.id);
    const orders = updates.map((u) => u.sortOrder);

    await sql`
		UPDATE livetv_channels
		SET sort_order = data.sort_order
		FROM unnest(
			${sql.array(ids)}::uuid[],
			${sql.array(orders)}::int[]
		) AS data(id, sort_order)
		WHERE livetv_channels.id = data.id
	`;
}

/**
 * Load all categories (id, name, current sort_order) for ordering.
 * Categories are global (not source-scoped); ordered by current sort_order so
 * callers can preserve the existing relative order of categories the preset
 * does not recognize.
 */
export async function getCategoriesForOrdering(sql: postgres.Sql): Promise<CategoryOrderRow[]> {
    return sql<CategoryOrderRow[]>`
		SELECT id, name, sort_order
		FROM livetv_categories
		ORDER BY sort_order ASC, name ASC
	`;
}

/**
 * Bulk update category sort order using unnest().
 */
export async function bulkUpdateCategorySortOrder(
    sql: postgres.Sql,
    updates: Array<{ id: string; sortOrder: number }>,
): Promise<void> {
    if (updates.length === 0) return;

    const ids = updates.map((u) => u.id);
    const orders = updates.map((u) => u.sortOrder);

    await sql`
		UPDATE livetv_categories
		SET sort_order = data.sort_order
		FROM unnest(
			${sql.array(ids)}::uuid[],
			${sql.array(orders)}::int[]
		) AS data(id, sort_order)
		WHERE livetv_categories.id = data.id
	`;
}

/**
 * Get setup summary: aggregate quality counts, category breakdown, and detected regions.
 */
export async function getSetupSummary(
    sql: postgres.Sql,
    sourceId: string,
): Promise<SetupSummaryResult> {
    const [summaryRows, categories, regionRows, filterRows] = await Promise.all([
        sql<SetupSummaryRow[]>`
			SELECT
				COUNT(*)                                                          AS total_channels,
				COUNT(*) FILTER (WHERE lc.is_visible)                            AS visible_channels,
				COUNT(*) FILTER (WHERE lc.quality_tier = 'uhd')                  AS quality_uhd,
				COUNT(*) FILTER (WHERE lc.quality_tier = 'fhd')                  AS quality_fhd,
				COUNT(*) FILTER (WHERE lc.quality_tier = 'hd')                   AS quality_hd,
				COUNT(*) FILTER (WHERE lc.quality_tier = 'sd')                   AS quality_sd,
				COUNT(*) FILTER (WHERE lc.quality_tier IS NULL)                  AS quality_unknown,
				COUNT(*) FILTER (WHERE lc.country_code IS NULL)                  AS untagged_channels,
				(
				    -- Channels whose exact title exists under several country codes
				    -- (the setup's regional-variant rule), in one grouped pass: the old
				    -- per-row LIKE self-join took minutes once 10k channels had a country.
				    SELECT COALESCE(SUM(n), 0)
				      FROM (
				        SELECT COUNT(*) AS n
				          FROM livetv_channels v
				          JOIN media_items vm ON vm.id = v.id
				         WHERE v.source_id = ${sourceId}
				           AND v.country_code IS NOT NULL
				         GROUP BY lower(btrim(vm.title))
				        HAVING COUNT(DISTINCT v.country_code) > 1
				      ) variants
				)::int                                                            AS regional_variant_count
			FROM livetv_channels lc
			WHERE lc.source_id = ${sourceId}
		`,
        sql<CategoryCountRow[]>`
			SELECT
				COALESCE(cat.name, 'Uncategorized') AS name,
				COUNT(lc.id)::int                    AS channel_count
			FROM livetv_channels lc
			LEFT JOIN livetv_categories cat ON cat.id = lc.category_id
			WHERE lc.source_id = ${sourceId}
			GROUP BY cat.name
			ORDER BY channel_count DESC
		`,
        sql<RegionCountRow[]>`
			SELECT country_code AS code, COUNT(*)::int AS channel_count
			FROM livetv_channels
			WHERE source_id = ${sourceId}
			  AND country_code IS NOT NULL
			GROUP BY country_code
			ORDER BY channel_count DESC, country_code
		`,
        sql<Array<{ lineup_filter: unknown }>>`
			SELECT lineup_filter FROM livetv_sources WHERE id = ${sourceId}
		`,
    ]);

    const summary = summaryRows[0] ?? {
        total_channels: 0,
        visible_channels: 0,
        quality_uhd: 0,
        quality_fhd: 0,
        quality_hd: 0,
        quality_sd: 0,
        quality_unknown: 0,
        regional_variant_count: 0,
        untagged_channels: 0,
    };

    return {
        summary,
        categories,
        detectedRegions: regionRows.map((r) => r.code).sort(),
        regions: regionRows,
        lineupFilter: filterRows[0]?.lineup_filter ?? null,
    };
}

/** Store a source's Configure Lineup choices (see migration 16.304.0). */
export async function saveSourceLineupFilter(
    sql: postgres.Sql,
    sourceId: string,
    filter: object,
): Promise<void> {
    await sql`
		UPDATE livetv_sources
		SET lineup_filter = ${sql.json(filter as postgres.JSONValue)}
		WHERE id = ${sourceId}
	`;
}

/** A source's stored Configure Lineup choices, or null when never configured. */
export async function getSourceLineupFilter(sql: postgres.Sql, sourceId: string): Promise<unknown> {
    const rows = await sql<Array<{ lineup_filter: unknown }>>`
		SELECT lineup_filter FROM livetv_sources WHERE id = ${sourceId}
	`;
    return rows[0]?.lineup_filter ?? null;
}
