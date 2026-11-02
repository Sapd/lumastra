// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Transform flat channel rows into grouped admin channel response.
 * Used by the admin channels API endpoint.
 */

import type { AdminChannelRow } from '$lib/server/database/queries/livetv-channels.queries.js';
import type { AdminChannel, AdminChannelCategory } from '$lib/schemas/livetv.js';
import { channelImageSet } from '$lib/server/services/image-descriptor/resources.js';

export function groupChannelsByCategory(
    rows: AdminChannelRow[],
    numberOverflow: Map<string, number> = new Map(),
): {
    categories: AdminChannelCategory[];
    totalChannels: number;
    visibleChannels: number;
} {
    const categoryMap = new Map<
        string,
        {
            id: string;
            name: string;
            sortOrder: number;
            isVisible: boolean;
            numberStart?: number;
            numberOverflow?: number;
            channels: AdminChannel[];
        }
    >();

    let totalChannels = 0;
    let visibleChannels = 0;

    for (const row of rows) {
        totalChannels++;
        if (row.is_visible) visibleChannels++;

        const catId = row.category_id ?? 'uncategorized';
        let category = categoryMap.get(catId);
        if (!category) {
            category = {
                id: catId,
                name: row.category_name ?? 'Uncategorized',
                sortOrder: row.category_sort_order ?? Number.MAX_SAFE_INTEGER,
                isVisible: row.category_is_visible ?? true,
                numberStart: row.category_number_start ?? undefined,
                numberOverflow: row.category_id ? numberOverflow.get(row.category_id) : undefined,
                channels: [],
            };
            categoryMap.set(catId, category);
        }

        const images = channelImageSet('internal', row.id, row.logo_url);
        if (images.primary) {
            // Admin rows use a small logo and show a fallback tile on a fetch failure.
            images.primary.href = `${images.primary.variants?.thumb ?? images.primary.href}&fallback=none`;
        }

        category.channels.push({
            id: row.id,
            name: row.name,
            images,
            category: row.category_name ?? undefined,
            categoryId: row.category_id ?? undefined,
            sortOrder: row.sort_order,
            isVisible: row.is_visible,
            qualityTier: (row.quality_tier as AdminChannel['qualityTier']) ?? undefined,
            backupGroupId: row.backup_group_id ?? undefined,
            groupPrimaryChannelId: row.group_primary_channel_id ?? undefined,
            sourceId: row.source_id ?? undefined,
            epgChannelId: row.epg_channel_id ?? undefined,
            epgMatchConfidence: row.epg_match_confidence ?? undefined,
            epgMatchSignals: row.epg_match_signals ?? undefined,
            adminDisplayName: row.admin_display_name ?? undefined,
            channelNumber: row.channel_number ?? undefined,
            channelNumberPinned:
                row.channel_number === null ? undefined : row.channel_number_pinned === true,
        });
    }

    const categories = Array.from(categoryMap.values()).sort((a, b) => a.sortOrder - b.sortOrder);

    return { categories, totalChannels, visibleChannels };
}
