// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { CategoryRow } from '$lib/server/database/queries/livetv-channels.queries.js';

export interface ApiLiveTvCategory {
    id: string;
    name: string;
    sortOrder: number;
    isVisible: boolean;
    createdAt: string;
    updatedAt: string;
}

/**
 * Map a livetv_categories DB row to API response shape.
 */
export function mapCategoryToApi(row: CategoryRow): ApiLiveTvCategory {
    return {
        id: row.id,
        name: row.name,
        sortOrder: row.sort_order,
        isVisible: row.is_visible,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}
