// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Live TV Channels Query Module
 *
 * Pure SQL queries for live TV channel management.
 * All functions take sql: postgres.Sql as first parameter, no side effects.
 *
 * Channel records span two tables with a shared UUID primary key:
 *   media_items  — title, custom_poster_url, media_type = 'tvchannel'
 *   livetv_channels — m3u_url, epg_channel_id, quality_tier, etc.
 *
 * @module queries/livetv-channels
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { runWithTrigramThreshold } from './builders/trigram-threshold.builder.js';
import { escapeLikePattern } from './builders/search-filter.builder.js';

// =============================================================================
// Types
// =============================================================================

export interface CreateChannelData {
    /** Pre-generated UUID (shared between media_items and livetv_channels) */
    id: string;
    /** Channel display name */
    name: string;
    /** Stream URL */
    streamUrl: string;
    /** Source UUID */
    sourceId: string;
    /** Logo URL */
    logoUrl?: string;
    /** Quality tier */
    qualityTier?: 'uhd' | 'fhd' | 'hd' | 'sd';
    /** EPG channel ID for matching */
    epgChannelId?: string;
    /** Category ID */
    categoryId?: string;
    /** Backup group ID */
    backupGroupId?: string;
    /** Sort order */
    sortOrder?: number;
    /** Immutable position in the source M3U (non-VOD sequence) — provider order */
    playlistIndex?: number;
    /** ISO country code (e.g., 'de', 'at', 'ch') */
    countryCode?: string;
}

export interface BulkImportData {
    channels: CreateChannelData[];
    categories: Array<{ id: string; name: string }>;
    backupGroups: Array<{
        id: string;
        name: string;
        primaryChannelId?: string;
        sourceId: string;
    }>;
}

export interface ChannelRow {
    id: string;
    name: string;
    stream_url: string;
    logo_url: string | null;
    quality_tier: string | null;
    epg_channel_id: string | null;
    sort_order: number;
    is_visible: boolean;
    category_id: string | null;
    category_name: string | null;
    backup_group_id: string | null;
    source_id: string | null;
    country_code: string | null;
    consecutive_absences: number;
    created_at: Date;
    /**
     * Admin display-name override (null when not set; when set, `name` equals it).
     * Optional because only getAllVisibleChannels selects it — used to decide whether
     * the quality/feed-tag strip should apply (admin renames are never stripped).
     */
    admin_display_name?: string | null;
}

export interface MatchedChannelUpdate {
    id: string;
    streamUrl: string | null;
    epgChannelId: string | null;
    logoUrl: string | null;
    qualityTier: string | null;
    countryCode: string | null;
    /**
     * New position in the source M3U (non-VOD sequence). Keeps the provider order
     * current for matched channels across refreshes. `null` leaves it unchanged.
     */
    playlistIndex: number | null;
}

// =============================================================================
// Queries
// =============================================================================

/**
 * Insert a single channel into media_items + livetv_channels atomically.
 * Returns the channel id.
 */
export async function createChannelWithMediaItem(
    sql: postgres.Sql,
    data: CreateChannelData,
): Promise<string> {
    // postgres.js types TransactionSql and Sql as distinct generics despite
    // being structurally compatible at runtime; cast via unknown to satisfy them.
    return sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await tx`
			INSERT INTO media_items (id, title, media_type, custom_poster_url)
			VALUES (
				${data.id},
				${data.name},
				'tvchannel',
				${data.logoUrl ?? null}
			)
		`;

        await tx`
			INSERT INTO livetv_channels (
				id,
				m3u_url,
				source_id,
				quality_tier,
				epg_channel_id,
				category_id,
				backup_group_id,
				sort_order,
				playlist_index,
				country_code
			) VALUES (
				${data.id},
				${data.streamUrl},
				${data.sourceId},
				${data.qualityTier ?? null},
				${data.epgChannelId ?? null},
				${data.categoryId ?? null},
				${data.backupGroupId ?? null},
				${data.sortOrder ?? 0},
				${data.playlistIndex ?? null},
				${data.countryCode ?? null}
			)
		`;

        return data.id;
    });
}

/**
 * Rows per multi-row INSERT. PostgreSQL caps a statement at 65534 bind
 * parameters; the widest insert here (livetv_channels) binds 10 per row, so an
 * unbatched playlist above ~6500 channels failed with MAX_PARAMETERS_EXCEEDED.
 */
const BULK_INSERT_ROWS = 2000;

function chunkRows<T>(rows: T[]): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < rows.length; i += BULK_INSERT_ROWS) {
        chunks.push(rows.slice(i, i + BULK_INSERT_ROWS));
    }
    return chunks;
}

/**
 * Batch insert channels, categories, and backup groups in a single transaction.
 * Uses ON CONFLICT DO NOTHING for categories and backup groups to support
 * idempotent re-imports.
 */
export async function bulkCreateChannels(
    sql: postgres.Sql,
    data: BulkImportData,
): Promise<{
    channelCount: number;
    categoryCount: number;
    backupGroupCount: number;
}> {
    // postgres.js: top-level Sql has .begin(), TransactionSql has .savepoint().
    // Detect which we have to support being called both standalone and nested.
    // TODO: migrate to withTx() from $lib/server/database/with-tx — also handles ReservedSql.
    type BulkResult = {
        channelCount: number;
        categoryCount: number;
        backupGroupCount: number;
    };
    type TxFn = (cb: (tx: postgres.TransactionSql) => Promise<BulkResult>) => Promise<BulkResult>;
    const beginOrSavepoint: TxFn =
        typeof sql.begin === 'function'
            ? (cb) => sql.begin(cb)
            : (cb) => (sql as unknown as { savepoint: TxFn }).savepoint(cb);
    return beginOrSavepoint(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;

        // Maps an optimistically-generated category id (passed in `data.categories`
        // / referenced by `channel.categoryId`) to the id that actually exists in
        // `livetv_categories` after the upsert. When a category NAME already
        // exists, the stored row keeps its original id and our freshly-generated
        // UUID is never inserted — so a channel referencing that UUID would hit
        // `livetv_channels_category_id_fkey`. We remap it below. (Root cause of
        // refresh-m3u permanently failing once a category name recurred.)
        const categoryIdRemap = new Map<string, string>();
        if (data.categories.length > 0) {
            // DO UPDATE (not DO NOTHING) so RETURNING yields the effective row id
            // for conflicting names too, not just newly-inserted ones.
            const upserted: { id: string; name: string }[] = [];
            for (const chunk of chunkRows(data.categories)) {
                const rows = await tx<{ id: string; name: string }[]>`
					INSERT INTO livetv_categories ${tx(chunk, 'id', 'name')}
					ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
					RETURNING id, name
				`;
                upserted.push(...rows);
            }
            const nameToRealId = new Map(upserted.map((r) => [r.name, r.id]));
            for (const c of data.categories) {
                const realId = nameToRealId.get(c.name);
                if (realId && realId !== c.id) categoryIdRemap.set(c.id, realId);
            }
        }

        // Insert backup groups WITHOUT primary_channel_id first (channels don't exist yet).
        // The FK fk_backup_groups_primary_channel requires channels to exist.
        if (data.backupGroups.length > 0) {
            const groupRows = data.backupGroups.map((g) => ({
                id: g.id,
                name: g.name,
                source_id: g.sourceId,
            }));
            for (const chunk of chunkRows(groupRows)) {
                await tx`
					INSERT INTO livetv_backup_groups ${tx(chunk, 'id', 'name', 'source_id')}
					ON CONFLICT (id) DO NOTHING
				`;
            }
        }

        if (data.channels.length > 0) {
            const mediaItemRows = data.channels.map((ch) => ({
                id: ch.id,
                title: ch.name,
                media_type: 'tvchannel',
                custom_poster_url: ch.logoUrl ?? null,
            }));
            for (const chunk of chunkRows(mediaItemRows)) {
                await tx`
					INSERT INTO media_items ${tx(chunk, 'id', 'title', 'media_type', 'custom_poster_url')}
					ON CONFLICT (id) DO UPDATE SET
						title = EXCLUDED.title,
						custom_poster_url = EXCLUDED.custom_poster_url
				`;
            }

            const channelRows = data.channels.map((ch) => ({
                id: ch.id,
                m3u_url: ch.streamUrl,
                source_id: ch.sourceId,
                quality_tier: ch.qualityTier ?? null,
                epg_channel_id: ch.epgChannelId ?? null,
                category_id: ch.categoryId
                    ? (categoryIdRemap.get(ch.categoryId) ?? ch.categoryId)
                    : null,
                backup_group_id: ch.backupGroupId ?? null,
                sort_order: ch.sortOrder ?? 0,
                playlist_index: ch.playlistIndex ?? null,
                country_code: ch.countryCode ?? null,
            }));
            for (const chunk of chunkRows(channelRows)) {
                await tx`
					INSERT INTO livetv_channels ${tx(chunk, 'id', 'm3u_url', 'source_id', 'quality_tier', 'epg_channel_id', 'category_id', 'backup_group_id', 'sort_order', 'playlist_index', 'country_code')}
					ON CONFLICT (id) DO UPDATE SET
						m3u_url = EXCLUDED.m3u_url,
						quality_tier = EXCLUDED.quality_tier,
						epg_channel_id = EXCLUDED.epg_channel_id,
						category_id = EXCLUDED.category_id,
						backup_group_id = EXCLUDED.backup_group_id,
						sort_order = EXCLUDED.sort_order,
						playlist_index = EXCLUDED.playlist_index,
						country_code = EXCLUDED.country_code
				`;
            }
        }

        // Now that channels exist, set primary_channel_id on backup groups
        // One statement per chunk, not one round-trip per group: a large
        // playlist carries thousands of backup groups.
        const primaries = data.backupGroups.filter((g) => g.primaryChannelId);
        for (const chunk of chunkRows(primaries)) {
            await tx`
				UPDATE livetv_backup_groups AS bg
				SET primary_channel_id = v.primary_channel_id::uuid
				FROM unnest(
					${chunk.map((g) => g.id)}::text[],
					${chunk.map((g) => g.primaryChannelId as string)}::text[]
				) AS v(id, primary_channel_id)
				WHERE bg.id = v.id::uuid
			`;
        }

        return {
            channelCount: data.channels.length,
            categoryCount: data.categories.length,
            backupGroupCount: data.backupGroups.length,
        };
    });
}

/**
 * List all channels belonging to a source, joined with media_items for
 * title and poster data.
 */
export async function getChannelsBySourceId(
    sql: postgres.Sql,
    sourceId: string,
): Promise<ChannelRow[]> {
    return sql<ChannelRow[]>`
		SELECT
			lc.id,
			mi.title        AS name,
			lc.m3u_url      AS stream_url,
			mi.custom_poster_url  AS logo_url,
			lc.quality_tier,
			lc.epg_channel_id,
			lc.sort_order,
			lc.is_visible,
			lc.category_id,
			lc.backup_group_id,
			lc.source_id,
			lc.country_code,
			lc.consecutive_absences,
			lc.created_at
		FROM livetv_channels lc
		JOIN media_items mi ON mi.id = lc.id
		WHERE lc.source_id = ${sourceId}
		ORDER BY lc.sort_order ASC, mi.title ASC
	`;
}

/**
 * Give every feed of a backup group a logo when another feed of the group has
 * one: the qualities of a station ("MTK HD", "MTK HD+", "MTK HDraw") are one
 * card, and the playlist or guide often names a logo for only one of them.
 * Only empty logos are filled, only from http(s) logos, and channels whose
 * guide match an admin set by hand are left alone. Returns the rows filled.
 */
export async function shareBackupGroupLogos(sql: postgres.Sql, sourceId: string): Promise<number> {
    const result = await sql`
		UPDATE media_items mi
		   SET custom_poster_url = src.logo, updated_at = NOW()
		  FROM livetv_channels lc
		  JOIN LATERAL (
		        SELECT m2.custom_poster_url AS logo
		          FROM livetv_channels l2
		          JOIN media_items m2 ON m2.id = l2.id
		         WHERE l2.backup_group_id = lc.backup_group_id
		           AND l2.id <> lc.id
		           AND m2.custom_poster_url ~* '^https?://'
		         ORDER BY l2.sort_order, l2.id
		         LIMIT 1
		       ) src ON TRUE
		 WHERE lc.id = mi.id
		   AND lc.source_id = ${sourceId}
		   AND lc.backup_group_id IS NOT NULL
		   AND lc.epg_manual_override IS NOT TRUE
		   AND (mi.custom_poster_url IS NULL OR btrim(mi.custom_poster_url) = '')
	`;
    return result.count ?? 0;
}

/**
 * Delete all channels for a source by removing their media_items rows.
 * The ON DELETE CASCADE on livetv_channels.id propagates the deletion.
 * Returns the number of rows deleted.
 */
/**
 * Delete a source's backup groups that no channel references any more. A
 * re-import deletes the source's channels and creates new groups for the new
 * rows, so without this every re-import leaves the previous set of groups
 * behind (about one row per station). Groups of other sources, and groups
 * without a source (built by hand across sources), are left alone. Run it
 * after anything that still needs the old group ids (the channel-number
 * carry-over), since channel numbers point at a group with ON DELETE SET NULL.
 */
export async function deleteUnusedBackupGroupsOfSource(
    sql: postgres.Sql,
    sourceId: string,
): Promise<number> {
    const result = await sql`
        DELETE FROM livetv_backup_groups g
        WHERE g.source_id = ${sourceId}
          AND NOT EXISTS (
              SELECT 1 FROM livetv_channels c WHERE c.backup_group_id = g.id
          )
    `;
    return result.count;
}

export async function deleteChannelsBySourceId(
    sql: postgres.Sql,
    sourceId: string,
): Promise<number> {
    const result = await sql`
		DELETE FROM media_items
		WHERE id IN (
			SELECT id FROM livetv_channels WHERE source_id = ${sourceId}
		)
	`;
    return result.count;
}

// =============================================================================
// Refresh queries (Story 2.9)
// =============================================================================

/**
 * Get channels for refresh matching — includes all identity signals needed
 * by the channel-matcher algorithm.
 */
export async function getChannelsForRefresh(
    sql: postgres.Sql,
    sourceId: string,
): Promise<ChannelRow[]> {
    return sql<ChannelRow[]>`
		SELECT
			lc.id,
			COALESCE(lc.admin_display_name, mi.title) AS name,
			lc.m3u_url      AS stream_url,
			mi.custom_poster_url  AS logo_url,
			lc.quality_tier,
			lc.epg_channel_id,
			lc.sort_order,
			lc.is_visible,
			lc.category_id,
			lcat.name       AS category_name,
			lc.backup_group_id,
			lc.source_id,
			lc.country_code,
			lc.consecutive_absences,
			lc.created_at
		FROM livetv_channels lc
		JOIN media_items mi ON mi.id = lc.id
		LEFT JOIN livetv_categories lcat ON lcat.id = lc.category_id
		WHERE lc.source_id = ${sourceId}
	`;
}

/**
 * Bulk update matched channels during refresh.
 * Only updates provider-controlled fields; admin customizations are preserved.
 * Uses unnest() pattern for performance with 1,300+ channels.
 */
export async function updateMatchedChannels(
    sql: postgres.Sql,
    updates: MatchedChannelUpdate[],
): Promise<number> {
    if (updates.length === 0) return 0;

    const ids = updates.map((u) => u.id);
    const urls = updates.map((u) => u.streamUrl);
    const epgIds = updates.map((u) => u.epgChannelId);
    const logos = updates.map((u) => u.logoUrl);
    const qualities = updates.map((u) => u.qualityTier);
    const countries = updates.map((u) => u.countryCode);
    const playlistIndices = updates.map((u) => u.playlistIndex);

    const result = await sql`
		UPDATE livetv_channels SET
			m3u_url = COALESCE(data.stream_url, livetv_channels.m3u_url),
			epg_channel_id = COALESCE(data.epg_channel_id, livetv_channels.epg_channel_id),
			quality_tier = COALESCE(data.quality_tier, livetv_channels.quality_tier),
			country_code = COALESCE(data.country_code, livetv_channels.country_code),
			playlist_index = COALESCE(data.playlist_index, livetv_channels.playlist_index),
			consecutive_absences = 0,
			updated_at = NOW()
		FROM unnest(
			${ids}::uuid[],
			${urls}::text[],
			${epgIds}::text[],
			${logos}::text[],
			${qualities}::text[],
			${countries}::text[],
			${playlistIndices}::int[]
		) AS data(id, stream_url, epg_channel_id, logo_url, quality_tier, country_code, playlist_index)
		WHERE livetv_channels.id = data.id
	`;

    // Also update logo in media_items
    if (updates.some((u) => u.logoUrl !== null)) {
        const logoIds = updates.filter((u) => u.logoUrl !== null).map((u) => u.id);
        const logoUrls = updates.filter((u) => u.logoUrl !== null).map((u) => u.logoUrl);
        await sql`
			UPDATE media_items SET
				custom_poster_url = data.logo_url
			FROM unnest(
				${logoIds}::uuid[],
				${logoUrls}::text[]
			) AS data(id, logo_url)
			WHERE media_items.id = data.id
		`;
    }

    return result.count;
}

/**
 * Bulk update consecutive absence counts for channels not found in refresh.
 */
export async function bulkUpdateChannelAbsences(
    sql: postgres.Sql,
    updates: Array<{ id: string; absences: number }>,
): Promise<number> {
    if (updates.length === 0) return 0;

    const ids = updates.map((u) => u.id);
    const absences = updates.map((u) => u.absences);

    const result = await sql`
		UPDATE livetv_channels SET
			consecutive_absences = data.absences,
			updated_at = NOW()
		FROM unnest(
			${ids}::uuid[],
			${absences}::int[]
		) AS data(id, absences)
		WHERE livetv_channels.id = data.id
	`;

    return result.count;
}

/** A refresh missed a channel this many times in a row: it is gone from the provider. */
export const VANISHED_CHANNEL_ABSENCES = 3;

/**
 * Archive stale channels (3+ consecutive absences) by hiding them.
 * Returns the number of channels archived.
 */
export async function archiveStaleChannels(sql: postgres.Sql, sourceId: string): Promise<number> {
    const result = await sql`
		UPDATE livetv_channels
		SET is_visible = false, updated_at = NOW()
		WHERE source_id = ${sourceId}
		  AND consecutive_absences >= ${VANISHED_CHANNEL_ABSENCES}
		  AND is_visible = true
	`;
    return result.count;
}

/**
 * Reset channel display order to the source M3U order for one source.
 * Copies the immutable `playlist_index` into `sort_order`, restoring the
 * provider's curated order and discarding any wizard/manual reordering.
 * Channels with no `playlist_index` (never imported/refreshed since the column
 * was added) keep their current `sort_order`. Returns the rows updated.
 */
export async function resetChannelSortToPlaylistOrder(
    sql: postgres.Sql,
    sourceId: string,
): Promise<number> {
    const result = await sql`
		UPDATE livetv_channels
		SET sort_order = playlist_index, updated_at = NOW()
		WHERE source_id = ${sourceId}
		  AND playlist_index IS NOT NULL
		  AND sort_order IS DISTINCT FROM playlist_index
	`;
    return result.count;
}

// =============================================================================
// Reorder queries (Story 4.2)
// =============================================================================

/**
 * Batch update sort_order (and optionally category_id) for multiple channels in a
 * single statement. Uses the unnest() pattern for performance.
 *
 * `categoryId` semantics per update item:
 *   - omitted (undefined) → leave the channel's category unchanged
 *   - a UUID string        → move the channel into that category
 *   - null                 → move the channel to "uncategorized" (category_id = NULL)
 *
 * A parallel `has_category` boolean flag column distinguishes "set to NULL" from
 * "leave unchanged" — COALESCE cannot express a move-to-NULL, so a CASE is used.
 */
export async function batchUpdateChannelSortOrder(
    sql: postgres.Sql,
    updates: Array<{ id: string; sortOrder: number; categoryId?: string | null }>,
): Promise<number> {
    if (updates.length === 0) return 0;

    const ids = updates.map((u) => u.id);
    const sortOrders = updates.map((u) => u.sortOrder);

    // Pass 1: sort orders for every channel in the batch.
    const result = await sql`
		UPDATE livetv_channels SET
			sort_order = data.sort_order,
			updated_at = NOW()
		FROM unnest(
			${ids}::uuid[],
			${sortOrders}::int[]
		) AS data(id, sort_order)
		WHERE livetv_channels.id = data.id
	`;

    // Pass 2: category moves — ONLY for items that explicitly provided categoryId.
    // `null` is a real value here (→ uncategorized / category_id NULL); an OMITTED
    // categoryId leaves the channel's category untouched (it isn't in this set). A
    // separate statement avoids COALESCE (which can't write NULL) and a boolean flag
    // array (which postgres.js can't bind through unnest). Callers wrap this in a
    // transaction (sql.begin) so the two writes are atomic.
    const moves = updates.filter((u) => u.categoryId !== undefined);
    if (moves.length > 0) {
        const moveIds = moves.map((u) => u.id);
        const moveCategoryIds = moves.map((u) => u.categoryId ?? null);
        await sql`
			UPDATE livetv_channels SET
				category_id = data.category_id,
				updated_at = NOW()
			FROM unnest(
				${moveIds}::uuid[],
				${moveCategoryIds}::uuid[]
			) AS data(id, category_id)
			WHERE livetv_channels.id = data.id
		`;
    }

    return result.count;
}

export interface CategoryRow {
    id: string;
    name: string;
    sort_order: number;
    is_visible: boolean;
    created_at: Date;
    updated_at: Date;
}

/**
 * List all categories ordered by sort_order.
 */
export async function listCategories(sql: postgres.Sql): Promise<CategoryRow[]> {
    return sql<CategoryRow[]>`
		SELECT id, name, sort_order, is_visible, created_at, updated_at
		FROM livetv_categories
		ORDER BY sort_order ASC, name ASC
	`;
}

/**
 * Get a single category by ID.
 */
export async function getCategoryById(
    sql: postgres.Sql,
    categoryId: string,
): Promise<CategoryRow | null> {
    const rows = await sql<CategoryRow[]>`
		SELECT id, name, sort_order, is_visible, created_at, updated_at
		FROM livetv_categories
		WHERE id = ${categoryId}
	`;
    return rows[0] ?? null;
}

/**
 * Batch update sort_order for multiple categories in a single statement.
 */
export async function batchUpdateCategorySortOrder(
    sql: postgres.Sql,
    updates: Array<{ id: string; sortOrder: number }>,
): Promise<number> {
    if (updates.length === 0) return 0;

    const ids = updates.map((u) => u.id);
    const sortOrders = updates.map((u) => u.sortOrder);

    const result = await sql`
		UPDATE livetv_categories SET
			sort_order = data.sort_order,
			updated_at = NOW()
		FROM unnest(
			${ids}::uuid[],
			${sortOrders}::int[]
		) AS data(id, sort_order)
		WHERE livetv_categories.id = data.id
	`;

    return result.count;
}

// =============================================================================
// Single + Bulk update queries (Story 4.3)
// =============================================================================

export interface UpdateChannelData {
    isVisible?: boolean;
    qualityTier?: string;
    adminDisplayName?: string;
    categoryId?: string;
}

/**
 * Partial update of a single channel's admin-editable fields.
 * Only updates fields that are provided (non-undefined).
 * Returns true if found and updated, false if not found.
 */
export async function updateChannel(
    sql: postgres.Sql,
    channelId: string,
    updates: UpdateChannelData,
): Promise<boolean> {
    const result = await sql`
		UPDATE livetv_channels
		SET
			is_visible = COALESCE(${updates.isVisible ?? null}::boolean, is_visible),
			quality_tier = COALESCE(${updates.qualityTier ?? null}, quality_tier),
			admin_display_name = COALESCE(${updates.adminDisplayName ?? null}, admin_display_name),
			category_id = COALESCE(${updates.categoryId ?? null}::uuid, category_id),
			updated_at = NOW()
		WHERE id = ${channelId}
	`;
    return result.count > 0;
}

/**
 * Bulk update channels (hide/show/setQuality/moveToCategory).
 * Uses ANY(array) pattern for membership checks.
 * Returns count of updated rows.
 */
export async function bulkUpdateChannels(
    sql: postgres.Sql,
    channelIds: string[],
    updates: { isVisible?: boolean; qualityTier?: string; categoryId?: string },
): Promise<number> {
    if (channelIds.length === 0) return 0;

    const result = await sql`
		UPDATE livetv_channels
		SET
			is_visible = COALESCE(${updates.isVisible ?? null}::boolean, is_visible),
			quality_tier = COALESCE(${updates.qualityTier ?? null}, quality_tier),
			category_id = COALESCE(${updates.categoryId ?? null}::uuid, category_id),
			updated_at = NOW()
		WHERE id = ANY(${channelIds}::uuid[])
	`;
    return result.count;
}

/**
 * Toggle visibility for an entire category and all its channels.
 * Wrapped in a transaction. Returns count of updated channels.
 */
export async function updateCategoryVisibility(
    sql: postgres.Sql,
    categoryId: string,
    isVisible: boolean,
): Promise<number> {
    return sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;

        await tx`
			UPDATE livetv_categories
			SET is_visible = ${isVisible}, updated_at = NOW()
			WHERE id = ${categoryId}
		`;

        const result = await tx`
			UPDATE livetv_channels
			SET is_visible = ${isVisible}, updated_at = NOW()
			WHERE category_id = ${categoryId}
		`;

        return result.count;
    });
}

// =============================================================================
// Admin queries (Story 4.1)
// =============================================================================

/**
 * Get all channels for admin management — includes both visible and hidden
 * channels, orphaned channels, and admin-specific fields.
 * Optional sourceId filter for source-specific views.
 */
export async function getChannelsForAdmin(
    sql: postgres.Sql,
    sourceId?: string,
): Promise<AdminChannelRow[]> {
    return sql<AdminChannelRow[]>`
		SELECT
			lc.id,
			COALESCE(lc.admin_display_name, mi.title) AS name,
			lc.m3u_url      AS stream_url,
			mi.custom_poster_url  AS logo_url,
			lc.quality_tier,
			lc.epg_channel_id,
			lc.sort_order,
			lc.is_visible,
			lc.category_id,
			lcat.name       AS category_name,
			lcat.sort_order AS category_sort_order,
			lcat.is_visible AS category_is_visible,
			lc.backup_group_id,
			-- Only a group's primary reaches viewers (see getAllVisibleChannels).
			-- Without this the admin list shows a green "visible" eye on rows the
			-- viewer never receives. NULL when the channel is ungrouped, and also
			-- when the group's primary row was deleted (FK is ON DELETE SET NULL) —
			-- which blacks out the whole group, so the caller must handle it.
			bg.primary_channel_id AS group_primary_channel_id,
			lc.source_id,
			lc.country_code,
			lc.consecutive_absences,
			lc.created_at,
			lc.admin_display_name,
			-- numeric comes back from postgres.js as a string; the API wants a number.
			lc.epg_match_confidence::float8 AS epg_match_confidence,
			lc.epg_match_signals,
			lcat.number_start AS category_number_start,
			-- The station's number: its group's, else the channel's own
			-- (channel-numbers.service.ts; ensureChannelNumbers runs first).
			num.number AS channel_number,
			num.pinned AS channel_number_pinned
		FROM livetv_channels lc
		JOIN media_items mi ON mi.id = lc.id
		LEFT JOIN livetv_categories lcat ON lcat.id = lc.category_id
		LEFT JOIN livetv_backup_groups bg ON bg.id = lc.backup_group_id
		LEFT JOIN LATERAL (
			SELECT n.number, n.pinned
			  FROM livetv_channel_numbers n
			 WHERE (lc.backup_group_id IS NOT NULL AND n.backup_group_id = lc.backup_group_id)
			    OR (n.backup_group_id IS NULL AND n.channel_id = lc.id)
			    -- A number still recorded on another feed of the group (not claimed yet).
			    OR (lc.backup_group_id IS NOT NULL AND n.backup_group_id IS NULL AND n.channel_id IN (
			        SELECT f.id FROM livetv_channels f WHERE f.backup_group_id = lc.backup_group_id
			    ))
			 ORDER BY n.pinned DESC, n.number
			 LIMIT 1
		) num ON true
		${sourceId ? sql`WHERE lc.source_id = ${sourceId}` : sql``}
		ORDER BY lcat.sort_order ASC NULLS LAST, lc.sort_order ASC, mi.title ASC
	`;
}

export interface AdminChannelRow extends ChannelRow {
    admin_display_name: string | null;
    // A name match (bare playlist, no tvg-id) sets these but not epg_channel_id.
    epg_match_confidence: number | null;
    epg_match_signals: string[] | null;
    category_sort_order: number | null;
    category_is_visible: boolean | null;
    group_primary_channel_id: string | null;
    category_number_start: number | null;
    channel_number: number | null;
    channel_number_pinned: boolean | null;
}

export interface ChannelSearchRow extends ChannelRow {
    similarity_score: number;
}

// =============================================================================
// Search queries (Story 3.8)
// =============================================================================

/**
 * Search channels by name, admin_display_name, or search_aliases using
 * three-signal matching: pg_trgm similarity, ILIKE substring, and JSONB alias matching.
 *
 * Similarity threshold 0.25 matches SEARCH_TRIGRAM_THRESHOLD from config.ts.
 */
export async function searchChannels(
    sql: postgres.Sql,
    query: string,
    limit: number = 20,
): Promise<ChannelSearchRow[]> {
    if (!query.trim()) return [];

    const trimmedQuery = query.trim();
    // Escape ILIKE wildcards (% and _) and the escape character itself so user input
    // can neither match everything nor swallow the escape of the next character.
    const escaped = escapeLikePattern(trimmedQuery);
    const pattern = `%${escaped}%`;
    const threshold = 0.25;

    return sql<ChannelSearchRow[]>`
		WITH channel_names AS (
			SELECT
				lc.id,
				COALESCE(lc.admin_display_name, mi.title) AS name,
				lc.m3u_url      AS stream_url,
				mi.custom_poster_url  AS logo_url,
				lc.quality_tier,
				lc.epg_channel_id,
				lc.sort_order,
				lc.is_visible,
				lc.category_id,
				lcat.name       AS category_name,
				lc.backup_group_id,
				lc.source_id,
				lc.country_code,
				lc.consecutive_absences,
				lc.created_at,
				lc.search_aliases
			FROM livetv_channels lc
			JOIN media_items mi ON mi.id = lc.id
			LEFT JOIN livetv_categories lcat ON lcat.id = lc.category_id
			WHERE lc.is_visible = true
			  -- The group's shown channel, as in shownGroupMember (inline: one
			  -- statement, no fragment).
			  AND (
			    lc.backup_group_id IS NULL
			    OR lc.id = (
			      SELECT m.id
			        FROM livetv_channels m
			        JOIN media_items mm ON mm.id = m.id
			        LEFT JOIN livetv_backup_groups mbg ON mbg.id = m.backup_group_id
			        LEFT JOIN livetv_categories mcat ON mcat.id = m.category_id
			       WHERE m.backup_group_id = lc.backup_group_id
			         AND m.is_visible = true
			         AND (mcat.is_visible = true OR m.category_id IS NULL)
			       ORDER BY (m.consecutive_absences >= 3) ASC,
			                (m.id = mbg.primary_channel_id) DESC,
			                (mm.title ~* ${DEGRADED_FEED_PATTERN}) ASC,
			                CASE m.quality_tier WHEN 'uhd' THEN 0 WHEN 'fhd' THEN 1 WHEN 'hd' THEN 2 WHEN 'sd' THEN 3 ELSE 4 END,
			                m.sort_order, m.id
			       LIMIT 1
			    )
			  )
		)
		SELECT
			id, name, stream_url, logo_url, quality_tier, epg_channel_id,
			sort_order, is_visible, category_id, category_name,
			backup_group_id, source_id, country_code, consecutive_absences, created_at,
			GREATEST(
				similarity(name, ${trimmedQuery}),
				COALESCE((
					SELECT MAX(similarity(alias, ${trimmedQuery}))
					FROM jsonb_array_elements_text(COALESCE(search_aliases, '[]'::jsonb)) AS alias
				), 0)
			) AS similarity_score
		FROM channel_names
		WHERE
			similarity(name, ${trimmedQuery}) >= ${threshold}
			OR name ILIKE ${pattern}
			OR EXISTS (
				SELECT 1 FROM jsonb_array_elements_text(COALESCE(search_aliases, '[]'::jsonb)) AS alias
				WHERE alias ILIKE ${pattern}
					OR similarity(alias, ${trimmedQuery}) >= ${threshold}
			)
		ORDER BY similarity_score DESC, sort_order ASC
		LIMIT ${limit}
	`;
}

/**
 * POSIX twin of auto-processor's DEGRADED_FEED_RE (plain and small-caps
 * spellings): a transcoded, mobile, backup or low-quality feed.
 */
export const DEGRADED_FEED_PATTERN =
    '[([][[:space:]]*((local|ʟᴏᴄᴀʟ)[[:space:]]+)?(transcoded|ᴛʀᴀɴsᴄᴏᴅᴇᴅ|mobile?|ᴍᴏʙɪʟ|backup|low[[:space:]]*quali[a-z]*)[[:space:]]*[])][[:space:]]*$|low[[:space:]]*quali[a-z]*[[:space:]]*$';
/**
 * The one channel viewers see for a backup group (`lc` = the outer row): the
 * group's primary when it is visible, else its best visible feed in a visible
 * category — a normal feed before a transcoded/mobile one, then quality, then
 * the lowest sort_order, then id. A feed gone from the playlist (3+ absences)
 * ranks below every present one. Before, only the primary counted, so
 * hiding the primary — by hand, or Configure Lineup keeping another quality —
 * dropped the station for viewers although a feed of it was still visible.
 */
export function shownGroupMember(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`(
		SELECT m.id
		  FROM livetv_channels m
		  JOIN media_items mm ON mm.id = m.id
		  LEFT JOIN livetv_backup_groups mbg ON mbg.id = m.backup_group_id
		  LEFT JOIN livetv_categories mcat ON mcat.id = m.category_id
		 WHERE m.backup_group_id = lc.backup_group_id
		   AND m.is_visible = true
		   AND (mcat.is_visible = true OR m.category_id IS NULL)
		 ORDER BY (m.consecutive_absences >= 3) ASC,
		          (m.id = mbg.primary_channel_id) DESC,
		          (mm.title ~* ${DEGRADED_FEED_PATTERN}) ASC,
		          CASE m.quality_tier WHEN 'uhd' THEN 0 WHEN 'fhd' THEN 1 WHEN 'hd' THEN 2 WHEN 'sd' THEN 3 ELSE 4 END,
		          m.sort_order, m.id
		 LIMIT 1
	)`;
}

/**
 * The channel the lineup lists in place of `lc` (the outer row): `lc` itself
 * when it is ungrouped, visible and outside a hidden category, else the shown
 * member of its backup group (shownGroupMember). NULL when the lineup has
 * nothing for it. Simple mode saves a feed of a station; this resolves it to
 * the feed viewers actually get.
 */
export function lineupChannelOf(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`(
		CASE WHEN lc.backup_group_id IS NULL
		  THEN (
		    SELECT lc.id
		     WHERE lc.is_visible = true
		       AND (lc.category_id IS NULL OR EXISTS (
		         SELECT 1 FROM livetv_categories c
		          WHERE c.id = lc.category_id AND c.is_visible = true
		       ))
		  )
		  ELSE ${shownGroupMember(sql)}
		END
	)`;
}

// =============================================================================
// Viewer queries (Story 3.6)
// =============================================================================

/**
 * Get all visible channels joined with media_items and categories.
 * Used by StandaloneLiveTvProvider.getChannels().
 */
export async function getAllVisibleChannels(sql: postgres.Sql): Promise<ChannelRow[]> {
    return sql<ChannelRow[]>`
		SELECT
			lc.id,
			COALESCE(lc.admin_display_name, mi.title) AS name,
			lc.m3u_url      AS stream_url,
			mi.custom_poster_url  AS logo_url,
			lc.quality_tier,
			lc.epg_channel_id,
			-- Display position is the group's playlist anchor, not the primary's own
			-- slot. Only the primary row is returned, but the primary is chosen by
			-- quality; without this the card jumps to wherever that feed happens to
			-- sit in the playlist instead of where the channel belongs.
			COALESCE(
				(
					SELECT MIN(sib.sort_order)
					FROM livetv_channels sib
					LEFT JOIN livetv_categories sibcat ON sibcat.id = sib.category_id
					WHERE sib.backup_group_id = lc.backup_group_id
					  AND sib.is_visible = true
					  AND (sibcat.is_visible = true OR sib.category_id IS NULL)
				),
				lc.sort_order
			) AS sort_order,
			lc.is_visible,
			lc.category_id,
			lcat.name       AS category_name,
			lc.backup_group_id,
			lc.source_id,
			lc.country_code,
			lc.consecutive_absences,
			lc.created_at,
			lc.admin_display_name
		FROM livetv_channels lc
		JOIN media_items mi ON mi.id = lc.id
		LEFT JOIN livetv_categories lcat ON lcat.id = lc.category_id
		WHERE lc.is_visible = true
		  -- A hidden category withholds its channels. /livetv already dropped them
		  -- (its layout filters cat.isVisible client-side) but /j did not, so the
		  -- two viewer surfaces disagreed; this makes the query the single answer.
		  AND (lcat.is_visible = true OR lc.category_id IS NULL)
		  AND (lc.backup_group_id IS NULL OR lc.id = ${shownGroupMember(sql)})
		ORDER BY sort_order ASC, mi.title ASC, lc.id ASC
	`;
}

export interface ChannelWithSourceRow extends ChannelRow {
    max_streams: number;
    source_name: string;
}

/**
 * Get a single channel joined with its source's max_streams.
 * Used by StandaloneLiveTvProvider.getStreamInfo().
 */
export async function getChannelWithSource(
    sql: postgres.Sql,
    channelId: string,
): Promise<ChannelWithSourceRow | null> {
    const rows = await sql<ChannelWithSourceRow[]>`
		SELECT
			lc.id,
			COALESCE(lc.admin_display_name, mi.title) AS name,
			lc.m3u_url      AS stream_url,
			mi.custom_poster_url  AS logo_url,
			lc.quality_tier,
			lc.epg_channel_id,
			lc.sort_order,
			lc.is_visible,
			lc.category_id,
			lcat.name       AS category_name,
			lc.backup_group_id,
			lc.source_id,
			lc.country_code,
			lc.consecutive_absences,
			lc.created_at,
			ls.max_streams,
			ls.name         AS source_name
		FROM livetv_channels lc
		JOIN media_items mi ON mi.id = lc.id
		LEFT JOIN livetv_categories lcat ON lcat.id = lc.category_id
		LEFT JOIN livetv_sources ls ON ls.id = lc.source_id
		WHERE lc.id = ${channelId}
	`;
    return rows[0] ?? null;
}

/**
 * Get backup group channel stream URLs for failover.
 * Returns the other feeds of the backup group a viewer may be switched to:
 * outside a hidden category and still in the playlist (fewer than 3 absences),
 * the same eligibility as isChannelStreamableByViewer. A feed hidden on its
 * own (is_visible = false) still counts: hiding the feeds the lineup does not
 * show is what makes them backups.
 */
export async function getBackupGroupFeeds(
    sql: postgres.Sql,
    backupGroupId: string,
    excludeChannelId: string,
): Promise<Array<{ id: string; name: string; stream_url: string }>> {
    return sql<Array<{ id: string; name: string; stream_url: string }>>`
		SELECT lc.id, COALESCE(lc.admin_display_name, mi.title, '') AS name, lc.m3u_url AS stream_url
		FROM livetv_channels lc
		LEFT JOIN media_items mi ON mi.id = lc.id
		LEFT JOIN livetv_categories lcat ON lcat.id = lc.category_id
		WHERE lc.backup_group_id = ${backupGroupId}
		  AND lc.id != ${excludeChannelId}
		  AND (lc.category_id IS NULL OR lcat.is_visible = true)
		  AND lc.consecutive_absences < 3
		ORDER BY lc.sort_order ASC
	`;
}

export async function getBackupGroupUrls(
    sql: postgres.Sql,
    backupGroupId: string,
    excludeChannelId: string,
): Promise<string[]> {
    const rows = await sql<Array<{ stream_url: string }>>`
		SELECT lc.m3u_url AS stream_url
		FROM livetv_channels lc
		LEFT JOIN livetv_categories lcat ON lcat.id = lc.category_id
		WHERE lc.backup_group_id = ${backupGroupId}
		  AND lc.id != ${excludeChannelId}
		  AND (lc.category_id IS NULL OR lcat.is_visible = true)
		  AND lc.consecutive_absences < 3
		ORDER BY lc.sort_order ASC
	`;
    return rows.map((r) => r.stream_url);
}

// =============================================================================
// Viewer feed choice
// =============================================================================

/**
 * Whether a viewer (not an admin) may stream `channelId`. Its category must be
 * visible (or none), and either the channel itself is visible or — with
 * `allowHiddenFeeds` (the feed picker is on) — it is a feed of a station
 * viewers can see: its backup group has a feed in a visible category that is
 * visible. A feed gone from the playlist (3+ absences, as archiveStaleChannels
 * counts) is not offered then. Hidden ≠ broken: an admin hides the feeds the
 * lineup does not show, and a viewer whose shown feed fails may pick one.
 */
export async function isChannelStreamableByViewer(
    sql: postgres.Sql,
    channelId: string,
    allowHiddenFeeds: boolean,
): Promise<boolean> {
    const rows = await sql<Array<{ ok: boolean }>>`
		SELECT EXISTS (
		  SELECT 1
		    FROM livetv_channels lc
		    LEFT JOIN livetv_categories lcat ON lcat.id = lc.category_id
		   WHERE lc.id = ${channelId}::uuid
		     AND (lc.category_id IS NULL OR lcat.is_visible = true)
		     AND (
		       lc.is_visible = true
		       OR (
		         ${allowHiddenFeeds}::boolean
		         AND lc.backup_group_id IS NOT NULL
		         AND lc.consecutive_absences < 3
		         AND EXISTS (
		           SELECT 1
		             FROM livetv_channels m
		             LEFT JOIN livetv_categories mcat ON mcat.id = m.category_id
		            WHERE m.backup_group_id = lc.backup_group_id
		              AND m.is_visible = true
		              AND (m.category_id IS NULL OR mcat.is_visible = true)
		         )
		       )
		     )
		) AS ok
	`;
    return rows[0]?.ok === true;
}

export interface StationFeedRow {
    id: string;
    /** Admin rename, else the playlist title. */
    name: string;
    /** The playlist title (degraded-feed detection reads it, as the viewer query does). */
    raw_name: string;
    quality_tier: string | null;
    is_visible: boolean;
    is_primary: boolean;
    /** The feed viewers get by default (shownGroupMember). */
    is_shown: boolean;
    backup_group_id: string | null;
}

/**
 * The feeds of the station `channelId` belongs to: every feed of its backup
 * group (or the channel alone when it has none) outside a hidden category and
 * still in the playlist (fewer than 3 absences — the channel itself always
 * counts). Ordered as shownGroupMember ranks them, so the default feed comes
 * first. Access to `channelId` is the caller's check (isChannelStreamableByViewer).
 */
export async function getStationFeeds(
    sql: postgres.Sql,
    channelId: string,
): Promise<StationFeedRow[]> {
    return sql<StationFeedRow[]>`
		SELECT
			m.id,
			COALESCE(m.admin_display_name, mm.title) AS name,
			mm.title AS raw_name,
			m.quality_tier,
			m.is_visible,
			COALESCE(m.id = mbg.primary_channel_id, false) AS is_primary,
			COALESCE(m.id = ${shownGroupMember(sql)}, false) AS is_shown,
			m.backup_group_id
		  FROM livetv_channels lc
		  JOIN livetv_channels m
		    ON m.id = lc.id
		    OR (lc.backup_group_id IS NOT NULL AND m.backup_group_id = lc.backup_group_id)
		  JOIN media_items mm ON mm.id = m.id
		  LEFT JOIN livetv_backup_groups mbg ON mbg.id = m.backup_group_id
		  LEFT JOIN livetv_categories mcat ON mcat.id = m.category_id
		 WHERE lc.id = ${channelId}::uuid
		   AND (m.category_id IS NULL OR mcat.is_visible = true)
		   AND (m.id = lc.id OR m.consecutive_absences < 3)
		 ORDER BY (m.consecutive_absences >= 3) ASC,
		          (m.id = mbg.primary_channel_id) DESC NULLS LAST,
		          (mm.title ~* ${DEGRADED_FEED_PATTERN}) ASC,
		          CASE m.quality_tier WHEN 'uhd' THEN 0 WHEN 'fhd' THEN 1 WHEN 'hd' THEN 2 WHEN 'sd' THEN 3 ELSE 4 END,
		          m.sort_order, m.id
	`;
}

// =============================================================================
// Backup Group Admin queries (Story 4.5)
// =============================================================================

/** Quality tier sort priority (UHD best → SD worst) */
const QUALITY_SCORE: Record<string, number> = { uhd: 4, fhd: 3, hd: 2, sd: 1 };

interface BackupGroupRow {
    group_id: string;
    group_name: string | null;
    primary_channel_id: string | null;
    channel_id: string;
    channel_name: string;
    admin_display_name: string | null;
    quality_tier: string | null;
    is_visible: boolean;
    category_id: string | null;
    category_name: string | null;
    country_code: string | null;
}

interface UngroupedChannelRow {
    id: string;
    name: string;
    admin_display_name: string | null;
    quality_tier: string | null;
    is_visible: boolean;
    category_id: string | null;
    category_name: string | null;
    country_code: string | null;
}

/**
 * Get all backup groups with their member channels, plus ungrouped channels.
 * Groups sorted by name, channels within groups by quality tier descending.
 */
/** A feed as the Backup Groups tab lists it (category + country for its filters). */
export interface BackupGroupMemberOut {
    id: string;
    name: string;
    adminDisplayName?: string;
    qualityTier?: string;
    isVisible: boolean;
    categoryId?: string;
    categoryName?: string;
    countryCode?: string;
}

function backupGroupMember(row: {
    name: string;
    admin_display_name: string | null;
    quality_tier: string | null;
    is_visible: boolean;
    category_id: string | null;
    category_name: string | null;
    country_code: string | null;
}): Omit<BackupGroupMemberOut, 'id'> {
    return {
        name: row.name,
        adminDisplayName: row.admin_display_name ?? undefined,
        qualityTier: row.quality_tier ?? undefined,
        isVisible: row.is_visible,
        categoryId: row.category_id ?? undefined,
        categoryName: row.category_name ?? undefined,
        countryCode: row.country_code ?? undefined,
    };
}

export async function getBackupGroupsForAdmin(sql: postgres.Sql): Promise<{
    groups: Array<{
        id: string;
        name: string;
        primaryChannelId?: string;
        channels: BackupGroupMemberOut[];
    }>;
    ungroupedChannels: BackupGroupMemberOut[];
}> {
    const groupRows = await sql<BackupGroupRow[]>`
		SELECT
			bg.id           AS group_id,
			bg.name         AS group_name,
			bg.primary_channel_id,
			lc.id           AS channel_id,
			COALESCE(lc.admin_display_name, mi.title) AS channel_name,
			lc.admin_display_name,
			lc.quality_tier,
			lc.is_visible,
			lc.category_id,
			lcat.name AS category_name,
			lc.country_code
		FROM livetv_backup_groups bg
		JOIN livetv_channels lc ON lc.backup_group_id = bg.id
		JOIN media_items mi ON mi.id = lc.id
		LEFT JOIN livetv_categories lcat ON lcat.id = lc.category_id
		ORDER BY bg.name ASC,
		CASE lc.quality_tier
			WHEN 'uhd' THEN 4 WHEN 'fhd' THEN 3 WHEN 'hd' THEN 2 WHEN 'sd' THEN 1 ELSE 0
		END DESC,
		mi.title ASC
	`;

    const ungroupedRows = await sql<UngroupedChannelRow[]>`
		SELECT
			lc.id,
			COALESCE(lc.admin_display_name, mi.title) AS name,
			lc.admin_display_name,
			lc.quality_tier,
			lc.is_visible,
			lc.category_id,
			lcat.name AS category_name,
			lc.country_code
		FROM livetv_channels lc
		JOIN media_items mi ON mi.id = lc.id
		LEFT JOIN livetv_categories lcat ON lcat.id = lc.category_id
		WHERE lc.backup_group_id IS NULL
		ORDER BY mi.title ASC
	`;

    // Build groups map
    const groupMap = new Map<
        string,
        {
            id: string;
            name: string;
            primaryChannelId?: string;
            channels: BackupGroupMemberOut[];
        }
    >();

    for (const row of groupRows) {
        let group = groupMap.get(row.group_id);
        if (!group) {
            group = {
                id: row.group_id,
                name: row.group_name ?? 'Unnamed Group',
                primaryChannelId: row.primary_channel_id ?? undefined,
                channels: [],
            };
            groupMap.set(row.group_id, group);
        }
        group.channels.push({
            id: row.channel_id,
            ...backupGroupMember({ ...row, name: row.channel_name }),
        });
    }

    const groups = Array.from(groupMap.values());

    const ungroupedChannels = ungroupedRows.map((row) => ({
        id: row.id,
        ...backupGroupMember(row),
    }));

    return { groups, ungroupedChannels };
}

/**
 * Remove a channel from its backup group.
 * If removed channel was primary, auto-promotes highest-quality remaining.
 * If group has 0-1 channels left, dissolves the group.
 */
export async function removeChannelFromBackupGroup(
    sql: postgres.Sql,
    groupId: string,
    channelId: string,
): Promise<void> {
    return sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;

        // Ungroup the channel
        const result = await tx`
			UPDATE livetv_channels
			SET backup_group_id = NULL, updated_at = NOW()
			WHERE id = ${channelId} AND backup_group_id = ${groupId}
		`;

        if (result.count === 0) {
            throw new Error('Channel not found in this backup group');
        }

        // Count remaining channels
        const [{ count }] = await tx<[{ count: number }]>`
			SELECT COUNT(*)::int AS count
			FROM livetv_channels
			WHERE backup_group_id = ${groupId}
		`;

        if (count <= 1) {
            // Dissolve: ungroup remaining channel(s) and delete group
            await tx`
				UPDATE livetv_channels
				SET backup_group_id = NULL, updated_at = NOW()
				WHERE backup_group_id = ${groupId}
			`;
            await tx`DELETE FROM livetv_backup_groups WHERE id = ${groupId}`;
        } else {
            // Check if removed channel was primary — promote if needed
            const [group] = await tx<[{ primary_channel_id: string | null }]>`
				SELECT primary_channel_id FROM livetv_backup_groups WHERE id = ${groupId}
			`;
            if (group.primary_channel_id === channelId) {
                await autoPromotePrimary(tx, groupId);
            }
        }
    });
}

/**
 * Take whole stations off air (every feed of each group hidden) or put them on
 * air: one feed per group visible — the primary unless it is degraded or gone
 * from the playlist, else the best feed in the viewer order — and the rest
 * hidden, so the quality pick stays clean. Only a feed outside a hidden
 * category and still in the playlist can be picked; a group with none stays as
 * it is. One statement for any number of groups. Returns how many of the groups
 * exist (off air) or went on air (on air); the caller compares with
 * groupIds.length to find groups that could not go on air.
 */
export async function setBackupGroupsOnAir(
    sql: postgres.Sql,
    groupIds: string[],
    onAir: boolean,
): Promise<number> {
    if (groupIds.length === 0) return 0;
    if (!onAir) {
        const rows = await sql<Array<{ id: string }>>`
			WITH hidden AS (
				UPDATE livetv_channels
				   SET is_visible = false, updated_at = NOW()
				 WHERE backup_group_id = ANY(${groupIds}::uuid[]) AND is_visible
			)
			SELECT id FROM livetv_backup_groups WHERE id = ANY(${groupIds}::uuid[])
		`;
        return rows.length;
    }
    const rows = await sql<Array<{ backup_group_id: string }>>`
		WITH pick AS (
			SELECT DISTINCT ON (m.backup_group_id) m.backup_group_id, m.id
			  FROM livetv_channels m
			  JOIN media_items mm ON mm.id = m.id
			  JOIN livetv_backup_groups bg ON bg.id = m.backup_group_id
			  LEFT JOIN livetv_categories mcat ON mcat.id = m.category_id
			 WHERE m.backup_group_id = ANY(${groupIds}::uuid[])
			   AND (m.category_id IS NULL OR mcat.is_visible = true)
			   AND m.consecutive_absences < 3
			 ORDER BY m.backup_group_id,
			          (mm.title ~* ${DEGRADED_FEED_PATTERN}) ASC,
			          (m.id = bg.primary_channel_id) DESC,
			          CASE m.quality_tier WHEN 'uhd' THEN 0 WHEN 'fhd' THEN 1 WHEN 'hd' THEN 2 WHEN 'sd' THEN 3 ELSE 4 END,
			          m.sort_order, m.id
		),
		updated AS (
			UPDATE livetv_channels c
			   SET is_visible = (c.id = pick.id), updated_at = NOW()
			  FROM pick
			 WHERE c.backup_group_id = pick.backup_group_id
			   AND c.is_visible IS DISTINCT FROM (c.id = pick.id)
		)
		SELECT backup_group_id FROM pick
	`;
    return rows.length;
}

/**
 * Make `channelId` the primary of backup group `groupId` — the feed viewers get
 * while it is visible. A playlist refresh keeps an existing group's primary.
 * 'not-member' when the channel is not in that group (or the group is gone).
 */
export async function setBackupGroupPrimary(
    sql: postgres.Sql,
    groupId: string,
    channelId: string,
): Promise<'ok' | 'not-member'> {
    const rows = await sql`
		UPDATE livetv_backup_groups bg
		   SET primary_channel_id = ${channelId}::uuid, updated_at = NOW()
		 WHERE bg.id = ${groupId}::uuid
		   AND EXISTS (
		     SELECT 1 FROM livetv_channels lc
		      WHERE lc.id = ${channelId}::uuid AND lc.backup_group_id = bg.id
		   )
		RETURNING bg.id
	`;
    return rows.length > 0 ? 'ok' : 'not-member';
}

/**
 * Split a backup group: move selected channels to a new group.
 * Auto-selects primaries for both groups.
 * If original group has 0-1 channels left, dissolves it.
 */
export async function splitBackupGroup(
    sql: postgres.Sql,
    originalGroupId: string,
    channelIdsForNewGroup: string[],
): Promise<{ newGroupId: string }> {
    return sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;

        // Get a representative channel name for the new group
        const [firstChannel] = await tx<[{ name: string }]>`
			SELECT COALESCE(lc.admin_display_name, mi.title) AS name
			FROM livetv_channels lc
			JOIN media_items mi ON mi.id = lc.id
			WHERE lc.id = ${channelIdsForNewGroup[0]}
		`;

        // Create new group
        const [{ id: newGroupId }] = await tx<[{ id: string }]>`
			INSERT INTO livetv_backup_groups (id, name)
			VALUES (gen_random_uuid(), ${firstChannel?.name ?? 'New Group'})
			RETURNING id
		`;

        // Move selected channels to new group
        const moveResult = await tx`
			UPDATE livetv_channels
			SET backup_group_id = ${newGroupId}, updated_at = NOW()
			WHERE id = ANY(${channelIdsForNewGroup}::uuid[])
			  AND backup_group_id = ${originalGroupId}
		`;

        if (moveResult.count === 0) {
            throw new Error('No matching channels found in the specified group');
        }

        // Auto-promote primary for new group
        await autoPromotePrimary(tx, newGroupId);

        // Check original group remaining count
        const [{ count }] = await tx<[{ count: number }]>`
			SELECT COUNT(*)::int AS count
			FROM livetv_channels
			WHERE backup_group_id = ${originalGroupId}
		`;

        if (count <= 1) {
            // Dissolve original group
            await tx`
				UPDATE livetv_channels
				SET backup_group_id = NULL, updated_at = NOW()
				WHERE backup_group_id = ${originalGroupId}
			`;
            await tx`DELETE FROM livetv_backup_groups WHERE id = ${originalGroupId}`;
        } else {
            // Re-promote primary for original group
            await autoPromotePrimary(tx, originalGroupId);
        }

        return { newGroupId };
    });
}

/**
 * Create a new backup group from ungrouped channels.
 * Auto-selects highest quality channel as primary.
 * All channels must be currently ungrouped.
 */
export async function createBackupGroup(
    sql: postgres.Sql,
    channelIds: string[],
): Promise<{ groupId: string }> {
    return sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;

        // Validate all channels are ungrouped
        const [{ count }] = await tx<[{ count: number }]>`
			SELECT COUNT(*)::int AS count
			FROM livetv_channels
			WHERE id = ANY(${channelIds}::uuid[])
			  AND backup_group_id IS NOT NULL
		`;

        if (count > 0) {
            throw new Error('Some channels are already in a backup group');
        }

        // Get name from highest-quality channel
        const [bestChannel] = await tx<[{ name: string }]>`
			SELECT COALESCE(lc.admin_display_name, mi.title) AS name
			FROM livetv_channels lc
			JOIN media_items mi ON mi.id = lc.id
			WHERE lc.id = ANY(${channelIds}::uuid[])
			ORDER BY
				CASE lc.quality_tier
					WHEN 'uhd' THEN 4 WHEN 'fhd' THEN 3 WHEN 'hd' THEN 2 WHEN 'sd' THEN 1 ELSE 0
				END DESC,
				mi.title ASC
			LIMIT 1
		`;

        // Create group
        const [{ id: groupId }] = await tx<[{ id: string }]>`
			INSERT INTO livetv_backup_groups (id, name)
			VALUES (gen_random_uuid(), ${bestChannel?.name ?? 'New Group'})
			RETURNING id
		`;

        // Assign channels to group
        await tx`
			UPDATE livetv_channels
			SET backup_group_id = ${groupId}, updated_at = NOW()
			WHERE id = ANY(${channelIds}::uuid[])
		`;

        // Set primary
        await autoPromotePrimary(tx, groupId);

        return { groupId };
    });
}

/**
 * Add an ungrouped channel to an existing backup group.
 * Re-evaluates primary if new channel is higher quality.
 * Channel must be currently ungrouped.
 */
export async function addChannelToBackupGroup(
    sql: postgres.Sql,
    groupId: string,
    channelId: string,
): Promise<void> {
    return sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;

        // Validate channel is ungrouped
        const [channel] = await tx<[{ backup_group_id: string | null } | undefined]>`
			SELECT backup_group_id FROM livetv_channels WHERE id = ${channelId}
		`;

        if (!channel) {
            throw new Error('Channel not found');
        }
        if (channel.backup_group_id !== null) {
            throw new Error('Channel is already in a backup group');
        }

        // Add to group
        await tx`
			UPDATE livetv_channels
			SET backup_group_id = ${groupId}, updated_at = NOW()
			WHERE id = ${channelId}
		`;

        // Re-evaluate primary
        await autoPromotePrimary(tx, groupId);
    });
}

/**
 * Auto-promote a backup group's primary: the highest-quality *visible* channel,
 * tie-broken by playlist position. Visibility outranks quality because only the
 * primary is returned to viewers.
 */
async function autoPromotePrimary(sql: postgres.Sql, groupId: string): Promise<void> {
    const rows = await sql<
        Array<{
            id: string;
            quality_tier: string | null;
            is_visible: boolean;
            sort_order: number;
        }>
    >`
		SELECT id, quality_tier, is_visible, sort_order
		FROM livetv_channels
		WHERE backup_group_id = ${groupId}
	`;

    if (rows.length === 0) return;

    // Visible first, then quality, then playlist position. Only the primary is
    // rendered by getAllVisibleChannels(), so promoting a hidden channel would
    // drop the entire group from /livetv even when it has visible members.
    rows.sort((a, b) => {
        const visDiff = Number(b.is_visible) - Number(a.is_visible);
        if (visDiff !== 0) return visDiff;
        const qualDiff =
            (QUALITY_SCORE[b.quality_tier ?? ''] ?? 0) - (QUALITY_SCORE[a.quality_tier ?? ''] ?? 0);
        if (qualDiff !== 0) return qualDiff;
        return a.sort_order - b.sort_order;
    });

    await sql`
		UPDATE livetv_backup_groups
		SET primary_channel_id = ${rows[0].id}, updated_at = NOW()
		WHERE id = ${groupId}
	`;
}

// =============================================================================
// Category Management queries (Story 4.7)
// =============================================================================

/**
 * Check whether a category with the given ID exists.
 * Returns true if found, false if not found.
 */
export async function categoryExists(sql: postgres.Sql, categoryId: string): Promise<boolean> {
    const [row] = await sql<[{ exists: boolean }]>`
		SELECT EXISTS(SELECT 1 FROM livetv_categories WHERE id = ${categoryId}) AS exists
	`;
    return row.exists;
}

/**
 * Rename a category. Returns true if found and updated, false if not found.
 */
export async function renameCategory(
    sql: postgres.Sql,
    categoryId: string,
    name: string,
): Promise<boolean> {
    const result = await sql`
		UPDATE livetv_categories
		SET name = ${name}, updated_at = NOW()
		WHERE id = ${categoryId}
	`;
    return result.count > 0;
}

/**
 * Create a new category with auto-generated sort_order if not provided.
 * Returns the created category.
 */
export async function createCategory(
    sql: postgres.Sql,
    name: string,
    sortOrder?: number,
): Promise<{ id: string; name: string; sortOrder: number; isVisible: boolean }> {
    const [row] = await sql<
        [{ id: string; name: string; sort_order: number; is_visible: boolean }]
    >`
		INSERT INTO livetv_categories (id, name, sort_order)
		VALUES (
			gen_random_uuid(),
			${name},
			${sortOrder ?? sql`(SELECT COALESCE(MAX(sort_order), -1) + 1 FROM livetv_categories)`}
		)
		RETURNING id, name, sort_order, is_visible
	`;
    // is_visible defaults true at the DB — return it so the create response
    // satisfies LiveTvCategorySchema (which declares isVisible required).
    return { id: row.id, name: row.name, sortOrder: row.sort_order, isVisible: row.is_visible };
}

/**
 * Merge source category into target: move all channels, then delete source.
 * Wrapped in a transaction.
 */
export async function mergeCategories(
    sql: postgres.Sql,
    sourceCategoryId: string,
    targetCategoryId: string,
): Promise<{ movedChannelCount: number }> {
    return sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        const moved = await tx`
			UPDATE livetv_channels
			SET category_id = ${targetCategoryId}, updated_at = NOW()
			WHERE category_id = ${sourceCategoryId}
		`;
        await tx`
			DELETE FROM livetv_categories WHERE id = ${sourceCategoryId}
		`;
        return { movedChannelCount: moved.count };
    });
}

/**
 * Delete a category only if it has zero channels.
 * Returns `{ deleted: true }` on success, `{ deleted: false, reason }` on failure.
 * Wrapped in a transaction to prevent race conditions.
 */
export async function deleteEmptyCategory(
    sql: postgres.Sql,
    categoryId: string,
): Promise<{ deleted: true } | { deleted: false; reason: 'has_channels' | 'not_found' }> {
    return sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        const [row] = await tx<[{ count: number }]>`
			SELECT COUNT(*)::int AS count FROM livetv_channels WHERE category_id = ${categoryId}
		`;
        if (row.count > 0) {
            return { deleted: false as const, reason: 'has_channels' as const };
        }
        const result = await tx`
			DELETE FROM livetv_categories WHERE id = ${categoryId}
		`;
        if (result.count === 0) {
            return { deleted: false as const, reason: 'not_found' as const };
        }
        return { deleted: true as const };
    });
}

/**
 * Get channel count for a category. Used by merge confirmation UI.
 */
export async function getCategoryChannelCount(
    sql: postgres.Sql,
    categoryId: string,
): Promise<number> {
    const [row] = await sql<[{ count: number }]>`
		SELECT COUNT(*)::int AS count FROM livetv_channels WHERE category_id = ${categoryId}
	`;
    return row.count;
}

// =============================================================================
// EPG Match Review queries (Story 4.6)
// =============================================================================

export interface EpgMatchReviewRow {
    id: string;
    source_id: string;
    name: string;
    admin_display_name: string | null;
    logo_url: string | null;
    epg_channel_id: string | null;
    epg_display_name: string | null;
    epg_match_confidence: number | null;
    epg_match_signals: string[] | null;
    epg_manual_override: boolean;
    category_name: string | null;
    current_program_title: string | null;
    current_program_start: Date | null;
    current_program_end: Date | null;
    epg_channel_exists: boolean;
}

/**
 * Get all channels with EPG match data for admin review.
 * Sorts: unmatched first, then low confidence, then high confidence.
 */
export async function getEpgMatchReviewData(
    sql: postgres.Sql,
    sourceId?: string,
    limit: number = 100,
    offset: number = 0,
): Promise<EpgMatchReviewRow[]> {
    return sql<EpgMatchReviewRow[]>`
		SELECT
			lc.id,
			lc.source_id,
			COALESCE(lc.admin_display_name, mi.title) AS name,
			lc.admin_display_name,
			mi.custom_poster_url AS logo_url,
			lc.epg_channel_id,
			ec.display_name AS epg_display_name,
			-- numeric(4,3): postgres.js returns a string without the cast
			lc.epg_match_confidence::float8 AS epg_match_confidence,
			lc.epg_match_signals,
			COALESCE(lc.epg_manual_override, false) AS epg_manual_override,
			lcat.name AS category_name,
			cp.title AS current_program_title,
			cp.start_time AS current_program_start,
			cp.end_time AS current_program_end,
			(ec.id IS NOT NULL) AS epg_channel_exists
		FROM livetv_channels lc
		JOIN media_items mi ON mi.id = lc.id
		LEFT JOIN livetv_categories lcat ON lcat.id = lc.category_id
		LEFT JOIN livetv_epg_channels ec
			ON ec.id = lc.epg_channel_id AND ec.source_id = lc.source_id
		LEFT JOIN LATERAL (
			SELECT title, start_time, end_time
			FROM livetv_programs
			WHERE channel_id = lc.id
			  AND start_time <= NOW()
			  AND end_time > NOW()
			ORDER BY start_time DESC
			LIMIT 1
		) cp ON true
		${sourceId ? sql`WHERE lc.source_id = ${sourceId}` : sql``}
		ORDER BY
			CASE
				WHEN lc.epg_channel_id IS NULL THEN 0
				WHEN lc.epg_match_confidence IS NULL THEN 1
				WHEN lc.epg_match_confidence < 0.5 THEN 2
				WHEN lc.epg_match_confidence < 0.8 THEN 3
				ELSE 4
			END ASC,
			mi.title ASC
		LIMIT ${limit}
		OFFSET ${offset}
	`;
}

export interface EpgChannelSearchRow {
    id: string;
    display_name: string;
    icon_url: string | null;
    similarity_score: number;
}

/**
 * Search XMLTV EPG channels by display name using trigram similarity + ILIKE.
 * Follows the same three-signal pattern as searchChannels().
 */
export async function searchEpgChannels(
    sql: postgres.Sql,
    sourceId: string,
    query: string,
    limit: number = 10,
): Promise<EpgChannelSearchRow[]> {
    if (!query.trim()) return [];

    const trimmedQuery = query.trim();
    const escaped = escapeLikePattern(trimmedQuery);
    const pattern = `%${escaped}%`;

    return runWithTrigramThreshold(sql, true, (db) => {
        return db<EpgChannelSearchRow[]>`
			SELECT
				id,
				display_name,
				icon_url,
				similarity(display_name, ${trimmedQuery}) AS similarity_score
			FROM livetv_epg_channels
			WHERE source_id = ${sourceId}
			  AND (
				display_name % ${trimmedQuery}
				OR display_name ILIKE ${pattern}
			  )
			ORDER BY similarity(display_name, ${trimmedQuery}) DESC
			LIMIT ${limit}
		`;
    });
}

/**
 * Update or remove an EPG match for a channel (admin manual override).
 * When epgChannelId is null, removes the match and clears override.
 */
export async function updateEpgMatch(
    sql: postgres.Sql,
    channelId: string,
    epgChannelId: string | null,
    isManual: boolean,
): Promise<boolean> {
    if (epgChannelId === null) {
        // Unmatch: clear all EPG fields
        const result = await sql`
			UPDATE livetv_channels
			SET
				epg_channel_id = NULL,
				epg_match_confidence = NULL,
				epg_match_signals = NULL,
				epg_manual_override = false,
				updated_at = NOW()
			WHERE id = ${channelId}
		`;
        return result.count > 0;
    }

    // Match: set manual override
    const result = await sql`
		UPDATE livetv_channels
		SET
			epg_channel_id = ${epgChannelId},
			epg_match_confidence = 1.0,
			epg_match_signals = ARRAY['manual']::text[],
			epg_manual_override = ${isManual},
			updated_at = NOW()
		WHERE id = ${channelId}
	`;
    return result.count > 0;
}

/**
 * Record that a user started watching a channel.
 * Used to power personalized "For You" suggestions.
 * Called fire-and-forget — errors are logged but never thrown.
 */
export async function recordChannelWatch(
    sql: postgres.Sql,
    userId: UserId,
    channelId: string,
): Promise<void> {
    await sql`
        INSERT INTO livetv_channel_watch_history (user_id, channel_id)
        VALUES (${userId}, ${channelId})
    `;
}

/**
 * Get personalized channel IDs for a user based on watch history.
 *
 * Returns up to 4 deduplicated channel IDs:
 * - Top 2 most-watched channels (by session count, all time)
 * - Up to 2 most recently watched distinct channels not already included
 *
 * Returns an empty array if the user has no watch history.
 */
export async function getPersonalizedChannelIds(
    sql: postgres.Sql,
    userId: UserId,
): Promise<string[]> {
    const [mostWatchedRows, recentRows] = await Promise.all([
        sql<{ channel_id: string }[]>`
            SELECT channel_id
            FROM livetv_channel_watch_history
            WHERE user_id = ${userId}
            GROUP BY channel_id
            ORDER BY COUNT(*) DESC
            LIMIT 2
        `,
        sql<{ channel_id: string }[]>`
            SELECT channel_id
            FROM (
                SELECT DISTINCT ON (channel_id) channel_id, watched_at
                FROM livetv_channel_watch_history
                WHERE user_id = ${userId}
                ORDER BY channel_id, watched_at DESC
            ) recent_channels
            ORDER BY watched_at DESC
            LIMIT 4
        `,
    ]);

    const seen = new Set<string>();
    const result: string[] = [];

    for (const row of mostWatchedRows) {
        if (!seen.has(row.channel_id)) {
            seen.add(row.channel_id);
            result.push(row.channel_id);
        }
    }

    for (const row of recentRows) {
        if (!seen.has(row.channel_id) && result.length < 4) {
            seen.add(row.channel_id);
            result.push(row.channel_id);
        }
    }

    return result;
}

/**
 * A favorite row with everything the canonical display sort needs.
 * `sort_order` is nullable: rows written by a previous release during a
 * blue/green overlap have no rank until healed.
 */
export type FavoriteOrderRow = {
    channel_id: string;
    sort_order: number | null;
    created_at: Date;
};

/**
 * Get a user's favorite channel IDs in the user's chosen display order.
 *
 * Canonical sort key, mirrored by every other read site and by the in-memory
 * comparator in defs/livetv/favorites/order.ts. `channel_id` is a required
 * final tiebreak: `created_at` defaults to now() = transaction start, and
 * concurrent adds can compute the same rank, so without it two reads with no
 * intervening write can disagree.
 */
export async function getFavoriteChannelIds(sql: postgres.Sql, userId: UserId): Promise<string[]> {
    const rows = await sql<{ channel_id: string }[]>`
        SELECT channel_id
        FROM livetv_channel_favorites
        WHERE user_id = ${userId}
        ORDER BY sort_order NULLS LAST, created_at, channel_id
    `;
    return rows.map((row) => row.channel_id);
}

/**
 * Assign concrete ranks to any NULL-sort_order rows a user has, continuing
 * after their existing ranked block.
 *
 * NULLs come from the previous release's bare INSERT during a blue/green
 * overlap. They do NOT heal passively: MAX() skips NULLs, so a later add ranks
 * against the ranked subset only and lands AHEAD of the NULLS-LAST tail
 * (verified: NULL,NULL + add => C,A,B). Because the reorder route is v1-only
 * and the web has no reorder UI, an unhealed scramble would be permanent for
 * web-only users. Call this before appending.
 *
 * No-ops (zero rows matched) in the steady state.
 */
export async function healNullFavoriteOrder(sql: postgres.Sql, userId: UserId): Promise<void> {
    await sql`
        WITH ranked AS (
            SELECT channel_id,
                   (SELECT COALESCE(MAX(sort_order), -1)
                      FROM livetv_channel_favorites WHERE user_id = ${userId})
                   + row_number() OVER (ORDER BY created_at, channel_id) AS rn
              FROM livetv_channel_favorites
             WHERE user_id = ${userId} AND sort_order IS NULL
        )
        UPDATE livetv_channel_favorites f
           SET sort_order = r.rn
          FROM ranked r
         WHERE f.user_id = ${userId} AND f.channel_id = r.channel_id
    `;
}

/**
 * Set or clear a channel favorite. Idempotent in both directions.
 * Throws on unknown channelId (FK violation, error code 23503) — callers
 * should map that to a 404.
 *
 * Callers MUST run healNullFavoriteOrder first (same transaction) or the
 * appended rank can sort ahead of unhealed NULL rows.
 */
export async function setChannelFavorite(
    sql: postgres.Sql,
    userId: UserId,
    channelId: string,
    favorite: boolean,
): Promise<void> {
    if (favorite) {
        // INSERT ... SELECT with an aggregate is load-bearing: an aggregate with
        // no GROUP BY yields exactly one row even over an empty set, so the
        // channel_id FK still fires for a user with zero favorites. A
        // non-aggregate `SELECT ... LIMIT 1` would insert nothing for that user,
        // skip the FK check, and turn the unknown-channel 404 into a silent 200.
        await sql`
            INSERT INTO livetv_channel_favorites (user_id, channel_id, sort_order)
            SELECT ${userId}, ${channelId}, COALESCE(MAX(sort_order), -1) + 1
              FROM livetv_channel_favorites WHERE user_id = ${userId}
            ON CONFLICT (user_id, channel_id) DO NOTHING
        `;
    } else {
        await sql`
            DELETE FROM livetv_channel_favorites
            WHERE user_id = ${userId} AND channel_id = ${channelId}
        `;
    }
}

/**
 * Read a user's favorites with a row lock, ordered by channel_id.
 *
 * Locking by channel_id (NOT payload order) makes concurrent reorders acquire
 * locks in the same sequence, which is what removes the 40P01 deadlock. It also
 * closes the read/write TOCTOU. The returned order is therefore NOT display
 * order — callers must re-sort by the canonical key before slicing head/tail.
 */
export async function getFavoritesForUpdate(
    sql: postgres.Sql,
    userId: UserId,
): Promise<FavoriteOrderRow[]> {
    return sql<FavoriteOrderRow[]>`
        SELECT channel_id, sort_order, created_at
        FROM livetv_channel_favorites
        WHERE user_id = ${userId}
        ORDER BY channel_id
        FOR UPDATE
    `;
}

/**
 * Rewrite sort_order to 0..n-1 across the given ids, in one set-based
 * statement. A per-row loop would take locks in payload order and deadlock
 * (40P01) when two devices reorder the same set in opposite directions.
 * Never inserts, never deletes; ids not belonging to this user are no-ops.
 */
export async function batchUpdateFavoriteSortOrder(
    sql: postgres.Sql,
    userId: UserId,
    orderedIds: string[],
): Promise<void> {
    if (orderedIds.length === 0) return;
    const orders = orderedIds.map((_, index) => index);
    await sql`
        UPDATE livetv_channel_favorites
           SET sort_order = data.sort_order
          FROM unnest(${orderedIds}::uuid[], ${orders}::int[]) AS data(id, sort_order)
         WHERE livetv_channel_favorites.user_id = ${userId}
           AND livetv_channel_favorites.channel_id = data.id
    `;
}

/**
 * Get channels filtered by category.
 */
/**
 * Hard-delete channels the provider no longer lists: missing from at least
 * `minAbsences` refreshes in a row (archived, i.e. hidden, at
 * VANISHED_CHANNEL_ABSENCES) and, with `cutoff`, last touched before it.
 *
 * Only absence counts: a channel an admin or Configure Lineup hid is still in
 * the playlist (absences 0) and must survive, however long it stays hidden.
 *
 * Deletion order respects FK constraints:
 *   1. Clear primary_channel_id on backup groups whose primary is being removed.
 *   2. DELETE media_items — cascades to livetv_channels, programmes, favourites
 *      and watch history.
 *   3. DELETE backup groups that lost all their members.
 *
 * Returns the number of channel rows deleted.
 */
export async function purgeArchivedChannels(
    sql: postgres.Sql,
    cutoff: Date | null,
    opts: { sourceId?: string; minAbsences?: number } = {},
): Promise<number> {
    const minAbsences = opts.minAbsences ?? VANISHED_CHANNEL_ABSENCES;
    const vanished = sql`
        SELECT id FROM livetv_channels
        WHERE consecutive_absences >= ${minAbsences}
          ${cutoff ? sql`AND updated_at < ${cutoff}` : sql``}
          ${opts.sourceId ? sql`AND source_id = ${opts.sourceId}` : sql``}
    `;

    await sql`
        UPDATE livetv_backup_groups
        SET primary_channel_id = NULL
        WHERE primary_channel_id IN (${vanished})
    `;

    const deleted = await sql`
        DELETE FROM media_items
        WHERE id IN (${vanished})
    `;

    await sql`
        DELETE FROM livetv_backup_groups
        WHERE id NOT IN (
            SELECT DISTINCT backup_group_id
            FROM livetv_channels
            WHERE backup_group_id IS NOT NULL
        )
    `;

    return deleted.count;
}

/**
 * Delete categories no channel uses any more (left behind when a re-import or a
 * genre-rule change moved every channel elsewhere, or a source was deleted).
 * A category touched within `minAgeMs` stays: an admin may have just created it
 * to move channels into.
 */
export async function purgeEmptyCategories(
    sql: postgres.Sql,
    minAgeMs = 24 * 60 * 60 * 1000,
): Promise<number> {
    const result = await sql`
        DELETE FROM livetv_categories cat
        WHERE NOT EXISTS (SELECT 1 FROM livetv_channels c WHERE c.category_id = cat.id)
          AND cat.updated_at < ${new Date(Date.now() - minAgeMs)}
    `;
    return result.count;
}

export async function getChannelsByCategory(
    sql: postgres.Sql,
    categoryId: string,
): Promise<ChannelRow[]> {
    return sql<ChannelRow[]>`
		SELECT
			lc.id,
			COALESCE(lc.admin_display_name, mi.title) AS name,
			lc.m3u_url      AS stream_url,
			mi.custom_poster_url  AS logo_url,
			lc.quality_tier,
			lc.epg_channel_id,
			lc.sort_order,
			lc.is_visible,
			lc.category_id,
			lcat.name       AS category_name,
			lc.backup_group_id,
			lc.source_id,
			lc.country_code,
			lc.consecutive_absences,
			lc.created_at
		FROM livetv_channels lc
		JOIN media_items mi ON mi.id = lc.id
		LEFT JOIN livetv_categories lcat ON lcat.id = lc.category_id
		WHERE lc.category_id = ${categoryId}
		  AND lc.is_visible = true
		ORDER BY lc.sort_order ASC, mi.title ASC
	`;
}

export interface ResolvedStation {
    stationId: string;
    shownFeedId: string;
    groupId: string | null;
}

/** A station id is never an arbitrary member feed id. */
export async function resolveStation(
    sql: postgres.Sql,
    stationId: string,
): Promise<ResolvedStation | null> {
    // A malformed id (empty arg from an old client) is "no such station", not a 22P02 outage.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stationId))
        return null;
    const rows = await sql<
        { station_id: string; shown_feed_id: string | null; group_id: string | null }[]
    >`
        SELECT COALESCE(lc.backup_group_id, lc.id) AS station_id,
               ${lineupChannelOf(sql)} AS shown_feed_id,
               lc.backup_group_id AS group_id
          FROM livetv_channels lc
         WHERE COALESCE(lc.backup_group_id, lc.id) = ${stationId}::uuid
         LIMIT 1
    `;
    const row = rows[0];
    return row?.shown_feed_id
        ? { stationId: row.station_id, shownFeedId: row.shown_feed_id, groupId: row.group_id }
        : null;
}

/** Storage remains feed-based. Missing feeds are omitted; caller order is retained. */
export async function feedStationMap(
    sql: postgres.Sql,
    feedIds: string[],
): Promise<Map<string, string>> {
    if (!feedIds.length) return new Map();
    const rows = await sql<{ id: string; station_id: string }[]>`
        SELECT id, COALESCE(backup_group_id, id) AS station_id
          FROM livetv_channels WHERE id = ANY(${feedIds}::uuid[])
    `;
    return new Map(rows.map((row) => [row.id, row.station_id]));
}

export async function stationIdsOfFeeds(sql: postgres.Sql, feedIds: string[]): Promise<string[]> {
    const mapping = await feedStationMap(sql, feedIds);
    return [...new Set(feedIds.flatMap((id) => mapping.get(id) ?? []))];
}

export interface SourceFavoriteSnapshotRow {
    user_id: string;
    channel_id: string;
    sort_order: number | null;
    created_at: Date;
}

/** Lock the source channels before snapshotting cascade-owned favourites. */
export async function getSourceFavoritesForImport(
    sql: postgres.Sql,
    sourceId: string,
): Promise<SourceFavoriteSnapshotRow[]> {
    await sql`SELECT id FROM livetv_channels WHERE source_id = ${sourceId} FOR UPDATE`;
    return sql<
        SourceFavoriteSnapshotRow[]
    >`SELECT f.user_id, f.channel_id, f.sort_order, f.created_at
        FROM livetv_channel_favorites f JOIN livetv_channels c ON c.id = f.channel_id
        WHERE c.source_id = ${sourceId} FOR UPDATE OF f`;
}

export async function restoreSourceFavorites(
    sql: postgres.Sql,
    rows: SourceFavoriteSnapshotRow[],
): Promise<void> {
    for (let i = 0; i < rows.length; i += 1000) {
        const chunk = rows.slice(i, i + 1000);
        await sql`INSERT INTO livetv_channel_favorites ${sql(chunk, 'user_id', 'channel_id', 'sort_order', 'created_at')}
            ON CONFLICT (user_id, channel_id) DO NOTHING`;
    }
}
