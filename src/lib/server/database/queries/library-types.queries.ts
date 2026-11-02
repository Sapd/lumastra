// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { NON_ENTERTAINMENT_LIBRARY_TYPES } from '$lib/server/utils/media-types.js';
import { deniesEverything, isLibraryGroupVisible } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';

export interface ActiveNonEntertainmentLibrary {
    media_type: string;
    library_group_id: string;
    display_name: string | null;
    sidebar_visible: boolean;
    icon: string | null;
    sort_order: number;
}

/**
 * Get all distinct media types that have at least one enabled library path.
 * Used to conditionally show sidebar items (Music, Audiobook, etc.).
 */
export async function getActiveLibraryTypes(sql: postgres.Sql): Promise<string[]> {
    const rows = await sql<Array<{ media_type: string }>>`
        SELECT DISTINCT media_type
        FROM library_paths
        WHERE enabled = true
    `;
    return rows.map((r) => r.media_type);
}

/**
 * Get distinct non-entertainment library types that have at least one enabled path.
 * Joins library_type_settings for display_name, sidebar_visible, icon, sort_order.
 * Used to populate sidebar entries dynamically.
 *
 * `access` is REQUIRED. The mere existence of a non-entertainment library is
 * itself information (it names an operator's "personal"/"home_video" libraries),
 * so a caller must state its boundary explicitly — {@link unrestrictedAccess} for
 * admin-scoped surfaces, a real per-user boundary otherwise. Previously this
 * function took no boundary at all and two of its three call sites shipped the
 * unfiltered list straight to the client.
 *
 * Only the LIBRARY axis is meaningful here: `library_paths` rows carry no age
 * rating, so there is nothing for the age axis to compare against. An `age`
 * scope of `denyAll` still yields an empty list (a caller that may see nothing
 * may not see library names either); `limit` and `any` are equivalent.
 *
 * The boundary is applied in JS AFTER the query, deliberately. `DISTINCT ON`
 * picks one representative path per media_type (oldest by created_at); pushing
 * the predicate into the WHERE clause would let a second, non-denied path of the
 * same media_type become the representative and so make a denied library type
 * REAPPEAR. Filtering the representatives preserves the existing behaviour
 * exactly.
 */
export async function getActiveNonEntertainmentLibraries(
    sql: postgres.Sql,
    access: MediaAccessBoundary,
): Promise<ActiveNonEntertainmentLibrary[]> {
    if (deniesEverything(access)) return [];

    const rows = await sql<ActiveNonEntertainmentLibrary[]>`
        SELECT DISTINCT ON (lp.media_type)
            lp.media_type,
            lp.library_group_id,
            lts.display_name,
            COALESCE(lts.sidebar_visible, true) AS sidebar_visible,
            lts.icon,
            COALESCE(lts.sort_order, 0) AS sort_order
        FROM library_paths lp
        LEFT JOIN library_type_settings lts ON lts.media_type = lp.media_type
        WHERE lp.enabled = true
          AND lp.media_type = ANY(${NON_ENTERTAINMENT_LIBRARY_TYPES})
        ORDER BY lp.media_type, lp.created_at ASC
    `;

    return rows.filter((row) => isLibraryGroupVisible(access, row.library_group_id ?? null));
}
