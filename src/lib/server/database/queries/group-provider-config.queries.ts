// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { getMetadataProviderChain } from '../../utils/provider-config.js';
import { getFieldPriority } from './metadata-aggregation.queries.js';

/**
 * Resolve the effective provider chain for a library group.
 * Returns group chain (with 'aggregated' prepended) or global chain as fallback.
 */
export function resolveProviderChainForGroup(
    groupChain: string[] | null,
    globalChain?: string[],
): string[] {
    const fallback = globalChain ?? getMetadataProviderChain();

    if (!groupChain || groupChain.length === 0) {
        return fallback;
    }

    // Auto-prepend 'aggregated' if not present
    if (groupChain[0] !== 'aggregated') {
        return ['aggregated', ...groupChain];
    }
    return groupChain;
}

/**
 * Build a field priority resolver that merges group overrides with global defaults.
 * Returns a function: (fieldName) => provider[] | undefined
 *
 * Group overrides are sparse — only overridden fields use the group config,
 * everything else falls through to the global field priority system.
 */
export function resolveFieldPrioritiesForGroup(
    groupOverrides: Record<string, string[]> | null,
): (field: string) => readonly string[] | undefined {
    const hasOverrides = groupOverrides && Object.keys(groupOverrides).length > 0;

    return (field: string): readonly string[] | undefined => {
        // Check group override first
        if (hasOverrides && groupOverrides[field]) {
            return groupOverrides[field];
        }
        // Fall through to global (respects DB overrides, plugin-derived, then hard-coded)
        return getFieldPriority(field);
    };
}

/**
 * Get the group provider config for a media item by its library_group_id.
 * Returns null if the item has no group or the group has no custom config.
 */
export async function getGroupProviderConfig(
    sql: postgres.Sql,
    libraryGroupId: string | null,
): Promise<{
    chain: string[] | null;
    fieldOverrides: Record<string, string[]> | null;
} | null> {
    if (!libraryGroupId) return null;

    const rows = await sql<
        {
            metadata_provider_chain: string[] | null;
            field_priority_overrides: Record<string, string[]> | null;
        }[]
    >`
        SELECT metadata_provider_chain, field_priority_overrides
        FROM library_groups
        WHERE id = ${libraryGroupId}
    `;

    if (!rows[0]) return null;
    return {
        chain: rows[0].metadata_provider_chain,
        fieldOverrides: rows[0].field_priority_overrides,
    };
}

/**
 * Get media item IDs belonging to a library group.
 */
export async function getMediaIdsByGroup(
    sql: postgres.Sql,
    groupId: string,
    limit: number = 10000,
): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
        SELECT id::text
        FROM media_items
        WHERE library_group_id = ${groupId}
          AND status = 'active'
        LIMIT ${limit}
    `;
    return rows.map((r) => r.id);
}

/**
 * Get media items in a group that are missing metadata from a specific provider.
 */
export async function getGroupItemsMissingProvider(
    sql: postgres.Sql,
    groupId: string,
    provider: string,
    limit: number = 5000,
): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
        SELECT mi.id::text
        FROM media_items mi
        WHERE mi.library_group_id = ${groupId}
          AND mi.status = 'active'
          AND NOT EXISTS (
              SELECT 1 FROM provider_metadata pm
              WHERE pm.media_id = mi.id
                AND pm.provider = ${provider}
          )
        LIMIT ${limit}
    `;
    return rows.map((r) => r.id);
}

/**
 * Filter media item IDs to only those whose library group includes the given provider.
 * Items with no group or groups with no custom chain are always included (global chain applies).
 */
export async function filterItemsByGroupProvider(
    sql: postgres.Sql,
    itemIds: string[],
    provider: string,
): Promise<string[]> {
    if (itemIds.length === 0) return [];

    const itemsWithGroup = await sql<{ id: string; library_group_id: string | null }[]>`
        SELECT id::text, library_group_id::text
        FROM media_items
        WHERE id = ANY(${itemIds}::uuid[])
    `;

    const groupConfigCache = new Map<string, string[] | null>();
    const filteredIds: string[] = [];

    for (const item of itemsWithGroup) {
        if (!item.library_group_id) {
            filteredIds.push(item.id);
            continue;
        }

        if (!groupConfigCache.has(item.library_group_id)) {
            const config = await getGroupProviderConfig(sql, item.library_group_id);
            groupConfigCache.set(item.library_group_id, config?.chain ?? null);
        }

        const chain = groupConfigCache.get(item.library_group_id);
        if (!chain || chain.includes(provider)) {
            filteredIds.push(item.id);
        }
    }

    return filteredIds;
}
