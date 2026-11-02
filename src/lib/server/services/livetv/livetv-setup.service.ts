// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LiveTV Guided Setup Service
 *
 * Applies region filtering, quality preferences, and channel ordering
 * based on admin-configured setup preferences.
 *
 * @module services/livetv/livetv-setup
 */

import type postgres from 'postgres';
import { withTx } from '$lib/server/database/with-tx.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    getChannelsForSetup,
    getCategoriesForOrdering,
    bulkUpdateChannelVisibility,
    bulkUpdateChannelSortOrder,
    bulkUpdateCategorySortOrder,
    saveSourceLineupFilter,
} from '$lib/server/database/queries/livetv-setup.queries.js';
import type {
    SetupChannelRow,
    CategoryOrderRow,
} from '$lib/server/database/queries/livetv-setup.queries.js';
import { isDegradedFeed } from './auto-processor.js';
import { isChannelKept, type LineupFilter } from './lineup-filter.js';
import { classifyLineup, countNoise, noiseKindsOf, type NoiseKind } from './lineup-noise.js';

const logger = Logger.for('LiveTvSetup');

// =============================================================================
// Types
// =============================================================================

export interface SetupPreferences {
    sourceId: string;
    /** Legacy single region; `countries` wins when present. */
    region?: 'de' | 'at' | 'ch' | 'generic';
    countries?: string[];
    includeUntagged?: boolean;
    hideLoopChannels?: boolean;
    hideInfoChannels?: boolean;
    hideEventSlots?: boolean;
    hideLocalStations?: boolean;
    hideRadio?: boolean;
    hiddenCategories?: string[];
    channelOrder: 'traditional' | 'sports-first';
    preferHighQuality: boolean;
}

/** What `livetv_sources.lineup_filter` stores: the filter plus how to order and dedupe. */
export interface StoredLineupSetup extends LineupFilter {
    channelOrder: 'traditional' | 'sports-first';
    preferHighQuality: boolean;
}

/** The noise switches added after the first stored filters. */
export const NOISE_SWITCH_KEYS = [
    'hideInfoChannels',
    'hideEventSlots',
    'hideLocalStations',
    'hideRadio',
] as const;

export function toLineupFilter(preferences: Omit<SetupPreferences, 'sourceId'>): LineupFilter {
    const legacy =
        preferences.region && preferences.region !== 'generic' ? [preferences.region] : [];
    return {
        countries: [...new Set(preferences.countries ?? legacy)],
        includeUntagged: preferences.includeUntagged ?? true,
        hideLoopChannels: preferences.hideLoopChannels ?? false,
        hideInfoChannels: preferences.hideInfoChannels ?? false,
        hideEventSlots: preferences.hideEventSlots ?? false,
        hideLocalStations: preferences.hideLocalStations ?? false,
        hideRadio: preferences.hideRadio ?? false,
        hiddenCategories: [...new Set(preferences.hiddenCategories ?? [])],
    };
}

export interface SetupResult {
    success: boolean;
    visibleChannels: number;
    hiddenChannels: number;
    categories: number;
    message: string;
}

// =============================================================================
// Constants
// =============================================================================

// Genre categories from channel-genre.ts; opt-in and niche ones go last.
const TRADITIONAL_ORDER = [
    'news',
    'general',
    'free tv',
    'entertainment',
    'movies',
    'series',
    'documentary',
    'sports',
    'live events',
    'kids',
    'music',
    'regional',
    'other',
    'radio',
    'shopping',
    '24/7',
    'religious',
    'adult',
];

const SPORTS_FIRST_ORDER = [
    'sports',
    'live events',
    'news',
    'general',
    'free tv',
    'entertainment',
    'movies',
    'series',
    'documentary',
    'kids',
    'music',
    'regional',
    'other',
    'radio',
    'shopping',
    '24/7',
    'religious',
    'adult',
];

const QUALITY_RANK: Record<string, number> = {
    uhd: 1,
    fhd: 2,
    hd: 3,
    sd: 4,
};

// =============================================================================
// Helpers
// =============================================================================

function getCategoryWeight(
    categoryName: string | null,
    order: 'traditional' | 'sports-first',
): number {
    const preset = order === 'sports-first' ? SPORTS_FIRST_ORDER : TRADITIONAL_ORDER;
    const normalized = (categoryName ?? 'other').toLowerCase();
    const index = preset.indexOf(normalized);
    // Provider bouquets ("Orb", "Tukan Prime") sit where "other" does,
    // ahead of the opt-in genres at the end.
    return index === -1 ? preset.indexOf('other') : index;
}

function applyQualityPreference(
    channels: SetupChannelRow[],
    visibilityMap: Map<string, boolean>,
    preferHighQuality: boolean,
): void {
    if (!preferHighQuality) return;

    // Group visible channels by backup_group_id.
    const groups = new Map<string, SetupChannelRow[]>();
    for (const ch of channels) {
        if (!ch.backup_group_id) continue;
        if (!visibilityMap.get(ch.id)) continue;
        const existing = groups.get(ch.backup_group_id);
        if (existing) {
            existing.push(ch);
        } else {
            groups.set(ch.backup_group_id, [ch]);
        }
    }

    // Within each group, keep only the highest quality channel visible.
    for (const [, members] of groups) {
        if (members.length <= 1) continue;

        // The group's primary stays: the backup detector already chose it as the
        // best feed (quality, then clean over marked, never a transcoded or
        // mobile one while another exists), and viewers see a group through its
        // primary first. Keeping a different feed of the same tier ("FHD+" over
        // "FHD") hid the primary and the station vanished for viewers.
        // Without a kept primary: a transcoded or mobile feed only stays when
        // nothing else is left, then the best quality.
        const sorted = [...members].sort((a, b) => {
            // A transcoded/mobile primary (from an import before that rule)
            // still yields to a normal feed.
            const degraded = Number(isDegradedFeed(a.title)) - Number(isDegradedFeed(b.title));
            if (degraded !== 0) return degraded;
            const primary = Number(b.is_primary) - Number(a.is_primary);
            if (primary !== 0) return primary;
            const ra = QUALITY_RANK[a.quality_tier ?? ''] ?? 99;
            const rb = QUALITY_RANK[b.quality_tier ?? ''] ?? 99;
            return ra - rb;
        });

        // Hide all but the first (highest quality).
        for (let i = 1; i < sorted.length; i++) {
            visibilityMap.set(sorted[i].id, false);
        }
    }
}

function computeSortOrders(
    channels: SetupChannelRow[],
    channelOrder: 'traditional' | 'sports-first',
): Map<string, number> {
    // Within each category bucket, sort alphabetically and assign index.
    const categoryBuckets = new Map<number, SetupChannelRow[]>();

    for (const ch of channels) {
        const weight = getCategoryWeight(ch.category_name, channelOrder);
        const existing = categoryBuckets.get(weight);
        if (existing) {
            existing.push(ch);
        } else {
            categoryBuckets.set(weight, [ch]);
        }
    }

    const sortMap = new Map<string, number>();

    // Sort category buckets by weight so ordering is deterministic
    const sortedBuckets = [...categoryBuckets.entries()].sort(([a], [b]) => a - b);

    let globalCounter = 0;
    for (const [, bucket] of sortedBuckets) {
        // Preserve the source playlist order within each category bucket.
        // playlist_index is the immutable M3U position; fall back to the legacy
        // sort_order for rows imported before that column existed. Either way the
        // provider's curated order wins over alphabetical.
        const orderKey = (ch: SetupChannelRow): number => ch.playlist_index ?? ch.sort_order;
        // Explicit tiebreaks keep the result deterministic on its own rather than
        // relying on the caller's ORDER BY + JS stable sort: fall back to sort_order,
        // then title, when two channels share a playlist_index.
        const sorted = [...bucket].sort(
            (a, b) =>
                orderKey(a) - orderKey(b) ||
                a.sort_order - b.sort_order ||
                a.title.localeCompare(b.title),
        );
        for (const ch of sorted) {
            sortMap.set(ch.id, globalCounter++);
        }
    }

    return sortMap;
}

/**
 * Compute new sort_order values for category groups.
 *
 * Categories whose (lowercased) name matches the chosen preset are ordered by
 * it (e.g. "sports-first" puts Sports first). Categories the preset does not
 * recognize — provider bouquets like "Orb", "EIS2" — take the preset's "other"
 * slot and keep their existing relative order, so a hand-built ordering of
 * those groups is preserved.
 */
function computeCategorySortOrders(
    categories: CategoryOrderRow[],
    channelOrder: 'traditional' | 'sports-first',
): Array<{ id: string; sortOrder: number }> {
    const preset = channelOrder === 'sports-first' ? SPORTS_FIRST_ORDER : TRADITIONAL_ORDER;
    const presetIndex = (name: string | null): number =>
        preset.indexOf((name ?? 'other').toLowerCase());

    // Unrecognized categories take the "other" slot (after the main genres,
    // before Radio/Shopping/24/7/Religious/Adult) and keep their relative order.
    const otherIndex = preset.indexOf('other');
    const weight = (name: string | null): number => {
        const index = presetIndex(name);
        return index === -1 ? otherIndex : index;
    };
    return [...categories]
        .sort((a, b) => weight(a.name) - weight(b.name) || a.sort_order - b.sort_order)
        .map((c, index) => ({ id: c.id, sortOrder: index }));
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Apply guided setup preferences to all channels of a source.
 * Performs:
 *   1. Region-based visibility filtering
 *   2. Quality preference within backup groups
 *   3. Category-ordered sort assignment
 * Returns a summary of the resulting configuration.
 *
 * `sql` may be an open transaction: the reads then see its uncommitted channels
 * and the writes nest as a savepoint (a re-import applies the stored lineup to
 * the channels it just inserted, in the same transaction).
 */
export async function applySetupPreferences(
    sql: postgres.Sql,
    preferences: SetupPreferences,
): Promise<SetupResult> {
    const { sourceId, channelOrder, preferHighQuality } = preferences;
    const filter = toLineupFilter(preferences);
    const stored: Partial<StoredLineupSetup> = { ...filter, channelOrder, preferHighQuality };
    // A switch nobody chose stays unstored (a re-import of a filter saved
    // before it existed), so Configure Lineup still offers its default.
    for (const key of NOISE_SWITCH_KEYS) {
        if (preferences[key] === undefined) delete stored[key];
    }

    logger.info(
        `Applying setup preferences for source ${sourceId}: countries=${filter.countries.join(',') || 'all'}, untagged=${filter.includeUntagged}, hide24/7=${filter.hideLoopChannels}, hideInfo=${filter.hideInfoChannels}, hideEventSlots=${filter.hideEventSlots}, hideLocalStations=${filter.hideLocalStations}, hideRadio=${filter.hideRadio}, hiddenCategories=${filter.hiddenCategories.length}, order=${channelOrder}, preferHighQuality=${preferHighQuality}`,
    );

    const [channels, categoryRows] = await Promise.all([
        getChannelsForSetup(sql, sourceId),
        getCategoriesForOrdering(sql),
    ]);

    if (channels.length === 0) {
        logger.warn(`No channels found for source ${sourceId}`);
        return {
            success: true,
            visibleChannels: 0,
            hiddenChannels: 0,
            categories: 0,
            message: 'No channels found for this source.',
        };
    }

    // Step 1: Country, 24/7, noise and category filtering.
    const noise = classifyLineup(channels);
    const visibilityMap = new Map<string, boolean>();
    for (const ch of channels) {
        visibilityMap.set(ch.id, isChannelKept(ch, filter, noiseKindsOf(noise, ch.id)));
    }
    // A backup-group member the filter drops stays hidden even when another member
    // of its group is kept: widening the group re-showed a filtered primary, and the
    // quality step then kept it over the kept feed.

    // Step 2: Quality preference within backup groups.
    applyQualityPreference(channels, visibilityMap, preferHighQuality);

    // Step 3: Compute sort orders.
    const sortMap = computeSortOrders(channels, channelOrder);

    // Step 4: Apply bulk updates atomically.
    const visibilityUpdates = channels.map((ch) => ({
        id: ch.id,
        isVisible: visibilityMap.get(ch.id) ?? false,
    }));

    const sortUpdates = channels.map((ch) => ({
        id: ch.id,
        sortOrder: sortMap.get(ch.id) ?? ch.sort_order,
    }));

    // Reorder the category groups themselves — the live-TV page renders groups by
    // livetv_categories.sort_order, so without this the channel-level reshuffle above
    // never moves a category header (e.g. "sports-first" left Free TV on top).
    const categorySortUpdates = computeCategorySortOrders(categoryRows, channelOrder);

    await withTx(sql, async (tx) => {
        const txSql = tx as unknown as postgres.Sql;
        await bulkUpdateChannelVisibility(txSql, visibilityUpdates);
        await bulkUpdateChannelSortOrder(txSql, sortUpdates);
        await bulkUpdateCategorySortOrder(txSql, categorySortUpdates);
        // Kept so a re-import and a refresh apply the same choices again.
        await saveSourceLineupFilter(txSql, sourceId, stored);
    });

    const visibleCount = visibilityUpdates.filter((u) => u.isVisible).length;
    const hiddenCount = visibilityUpdates.length - visibleCount;

    const categorySet = new Set(channels.map((ch) => ch.category_name ?? 'Uncategorized'));

    logger.info(
        `Setup complete: ${visibleCount} visible, ${hiddenCount} hidden, ${categorySet.size} categories`,
    );

    return {
        success: true,
        visibleChannels: visibleCount,
        hiddenChannels: hiddenCount,
        categories: categorySet.size,
        message: `Setup applied: ${visibleCount} channels visible, ${hiddenCount} hidden across ${categorySet.size} categories.`,
    };
}

/** How many of a source's channels each Configure Lineup noise switch would hide. */
export async function getLineupNoiseCounts(
    sql: postgres.Sql,
    sourceId: string,
): Promise<Record<NoiseKind, number>> {
    return countNoise(classifyLineup(await getChannelsForSetup(sql, sourceId)));
}
