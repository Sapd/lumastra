// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/database/connection.js';
import {
    listItemsByLibraryType,
    getDistinctMetadataValues,
    countItemsByGroup,
} from '$lib/server/database/queries/non-entertainment-browse.queries.js';
import { getLibraryTypeTemplate } from '$lib/shared/library-type-templates.js';
import { config } from '$lib/server/config.js';
import {
    getDeniedLibraryGroups,
    toLibraryAccessUser,
} from '$lib/server/cache/library-group-permissions-cache.js';
import { restrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { parsePagination } from '$lib/server/utils/pagination.js';

type QuerySort = 'chronological' | 'alphabetical' | 'added' | 'department' | 'oldest';

function resolveSort(templateSort: string): QuerySort {
    if (
        templateSort === 'chronological' ||
        templateSort === 'added' ||
        templateSort === 'department' ||
        templateSort === 'oldest'
    )
        return templateSort as QuerySort;
    return 'alphabetical';
}

export const load: PageServerLoad = async ({ url, params, locals }) => {
    const { libraryType } = params;
    const template = getLibraryTypeTemplate(libraryType);
    if (!template) error(404, 'Unknown library type');

    const sql = getDb();
    if (!sql)
        return {
            items: [],
            total: 0,
            filters: {} as Record<string, string[]>,
            groups: [],
            libraryType,
            activeFilter: null,
            limit: 50,
            offset: 0,
            defaultSort: template.browseConfig.defaultSort,
            progressMeaning: template.cardConfig.progressMeaning,
        };

    const { limit, offset } = parsePagination(url, { defaultLimit: 50, maxLimit: 200 });
    const search = url.searchParams.get('q') ?? undefined;

    // URL param overrides template default (user-facing sort control)
    const sortParam = url.searchParams.get('sort') ?? undefined;
    const sort = resolveSort(sortParam ?? template.browseConfig.defaultSort);

    // One boundary, built from this user's real permissions, shared by all three
    // queries below so the item list, the group counts and the filter dropdowns
    // can never disagree about what this user may see.
    const deniedGroupIds = await getDeniedLibraryGroups(sql, toLibraryAccessUser(locals.user));
    const access: MediaAccessBoundary = restrictedAccess({
        // null = admin / no group restriction, which collapses to `{ kind: 'all' }`.
        deniedGroupIds: deniedGroupIds ?? [],
        maxAgeRating: locals.user?.maxAgeRating ?? null,
        allowUnrated: config.UNRATED_CONTENT_VISIBLE,
    });

    // Parse active metadata filter (at most one filter key active at a time — the primary groupBy key)
    const activeFilterKey = template.browseConfig.groupBy[0] ?? '';
    const activeFilterValue = activeFilterKey
        ? (url.searchParams.get(`filter[${activeFilterKey}]`) ?? undefined)
        : undefined;
    const activeFilters: Record<string, string> | undefined = activeFilterValue
        ? { [activeFilterKey]: activeFilterValue }
        : undefined;

    const userId = locals.user?.userId;
    const { items, total } = await listItemsByLibraryType(sql, {
        mediaType: libraryType,
        search,
        sort,
        limit,
        offset,
        filters: activeFilters,
        access,
        userId,
    });

    // Group counts are independent of pagination — always full-scope for the current filter/search
    const groupKey = template.browseConfig.groupBy[0] ?? '';
    const groups = groupKey
        ? await countItemsByGroup(sql, {
              mediaType: libraryType,
              groupKey,
              search,
              filters: activeFilters,
              access,
          })
        : [];

    // Fetch distinct values for each filter key defined in the template,
    // scoped by the same library + age access used for the items list so
    // the filter dropdowns can't leak categories from restricted items.
    const filterEntries = await Promise.all(
        template.browseConfig.filters.map(async (key) => {
            const values = await getDistinctMetadataValues(sql, libraryType, key, {
                access,
            });
            return [key, values] as const;
        }),
    );

    return {
        items,
        total,
        filters: Object.fromEntries(filterEntries) as Record<string, string[]>,
        groups,
        libraryType,
        activeFilter: activeFilterValue ?? null,
        limit,
        offset,
        defaultSort: template.browseConfig.defaultSort,
        progressMeaning: template.cardConfig.progressMeaning,
    };
};
