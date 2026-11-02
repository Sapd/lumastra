// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import type { ApiSurface } from '$lib/shared/api-urls.js';
import { libraryImageSet } from '$lib/server/services/image-descriptor/resources.js';
import { getLibraryBackdropHash } from '$lib/server/services/library-backdrop.service.js';
import type { LibraryGroupRow } from '$lib/server/database/queries/library-groups.queries.js';

export interface ApiLibraryGroup {
    id: string;
    images?: ImageSet;
    name: string;
    displayName?: string;
    description?: string;
    icon?: string;
    sortOrder: number;
    maxAgeRating?: number;
    metadataProviderChain?: string[];
    fieldPriorityOverrides?: Record<string, string[]>;
    createdAt: string;
    updatedAt: string;
    itemCount?: number;
}

/**
 * `itemCount` is optional and comes from `getLibraryGroupsWithCounts` — pass
 * it only where that query already ran (the admin library-groups list, for
 * the Libraries overview page). Every other caller of this mapper omits it.
 */
export function mapLibraryGroupToApi(row: LibraryGroupRow, itemCount?: number): ApiLibraryGroup {
    return {
        id: row.id,
        name: row.name,
        displayName: row.display_name ?? undefined,
        description: row.description ?? undefined,
        icon: row.icon ?? undefined,
        sortOrder: row.sort_order,
        maxAgeRating: row.max_age_rating ?? undefined,
        metadataProviderChain: row.metadata_provider_chain ?? undefined,
        fieldPriorityOverrides: row.field_priority_overrides ?? undefined,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        itemCount,
    };
}

export async function libraryGroupWithImages(
    sql: postgres.Sql,
    surface: ApiSurface,
    row: LibraryGroupRow,
    itemCount?: number,
): Promise<ApiLibraryGroup> {
    return {
        ...mapLibraryGroupToApi(row, itemCount),
        images: libraryImageSet(surface, row.id, await getLibraryBackdropHash(sql, row.id)),
    };
}
