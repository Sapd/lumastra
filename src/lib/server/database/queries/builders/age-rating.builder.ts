// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Age Rating Filter Builder
 *
 * Produces a SQL fragment that filters media items by age rating.
 * When maxAgeRating is null (unrestricted user), returns an empty fragment (zero overhead).
 *
 * Logic: an item is visible if:
 * (a) the user has no age restriction (maxAgeRating is NULL), OR
 * (b) the item's age_rating is <= maxAgeRating, OR
 * (c) the item has no age_rating AND allowUnrated is true
 *
 * The table alias used in the fragment defaults to `mi` and can be overridden
 * via the third parameter for queries that join media_items under a different alias.
 */

import type postgres from 'postgres';
import type { AgeScope } from './media-access-boundary.js';

export type { AgeRatingFilterParams } from './media-access-boundary.js';
import type { AgeRatingFilterParams } from './media-access-boundary.js';

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

/**
 * Build a WHERE clause fragment that filters media items by age rating.
 *
 * Accepts either an {@link AgeScope} (preferred) or the legacy
 * `AgeRatingFilterParams | null | undefined`.
 *
 * Scope behaviour:
 * - `any`     -> empty fragment
 * - `limit`   -> the existing predicate (identical SQL to the legacy path)
 * - `denyAll` -> `AND false`
 *
 * @param sql - postgres.Sql instance for parameterized queries
 * @param params - age scope, or legacy age rating filter parameters / null for no filter
 * @param alias - Table alias for media_items in the surrounding query (default: 'mi')
 * @returns SQL fragment to append after existing WHERE conditions (includes leading AND)
 */
export function buildAgeRatingFilter(
    sql: postgres.Sql,
    params: AgeScope | AgeRatingFilterParams | null | undefined,
    alias = 'mi',
): postgres.PendingQuery<postgres.Row[]> {
    const resolved = resolveAgeParams(params);
    if (resolved === 'denyAll') return sql`AND false`;
    if (!resolved || resolved.maxAgeRating === null) return sql``;

    if (!SAFE_IDENTIFIER.test(alias)) {
        throw new Error(`buildAgeRatingFilter: invalid alias "${alias}"`);
    }

    const { maxAgeRating, allowUnrated } = resolved;

    return sql`
        AND (
            (${effectiveAgeRatingExpression(sql, alias)} IS NULL AND ${allowUnrated}::boolean)
            OR ${effectiveAgeRatingExpression(sql, alias)} <= ${maxAgeRating}
        )
    `;
}

/**
 * ABS books have no file rows: their declared library supplies a rating floor.
 * Deliberately, this also supplies a rating when the book itself is unrated:
 * an unrated book in a group rated 12 has effective rating 12, so a 12-year-old
 * can see it even with "hide unrated" enabled. A higher book rating still wins;
 * a lower book rating cannot weaken the group's floor. Only when BOTH are NULL
 * does allowUnrated decide visibility.
 */
export function effectiveAgeRatingExpression(
    sql: postgres.Sql,
    alias = 'mi',
): postgres.PendingQuery<postgres.Row[]> {
    if (!SAFE_IDENTIFIER.test(alias)) {
        throw new Error(`effectiveAgeRatingExpression: invalid alias "${alias}"`);
    }
    const a = sql(alias);
    return sql`(CASE WHEN ${a}.media_type = 'audiobook' THEN GREATEST(
        ${a}.age_rating,
        (SELECT _age_library.max_age_rating FROM library_groups _age_library
         WHERE _age_library.id = ${a}.library_group_id)
    ) ELSE ${a}.age_rating END)`;
}

/**
 * {@link buildAgeRatingFilter} for a scope whose rows may be seasons or
 * episodes: those are judged by their SERIES' `age_rating`, every other row by
 * its own (including an audiobook's library floor). A season or
 * episode's own column is always NULL and the plain filter hides them from any
 * profile with `allowUnrated=false` (the same rule as
 * `series-episode-counts.queries.ts` and `episode-search.queries.ts`).
 *
 * The rating is evaluated once: `COALESCE(rating <= max, allowUnrated)` is
 * NULL-rating → allowUnrated, else the comparison.
 */
export function buildSeriesOwnedAgeRatingFilter(
    sql: postgres.Sql,
    params: AgeScope | AgeRatingFilterParams | null | undefined,
    alias = 'mi',
): postgres.PendingQuery<postgres.Row[]> {
    const resolved = resolveAgeParams(params);
    if (resolved === 'denyAll') return sql`AND false`;
    if (!resolved || resolved.maxAgeRating === null) return sql``;

    if (!SAFE_IDENTIFIER.test(alias)) {
        throw new Error(`buildSeriesOwnedAgeRatingFilter: invalid alias "${alias}"`);
    }

    const { maxAgeRating, allowUnrated } = resolved;

    return sql`
        AND COALESCE(
            ${seriesOwnedAgeRatingExpression(sql, alias)} <= ${maxAgeRating},
            ${allowUnrated}::boolean
        )
    `;
}

/**
 * The `age_rating` that applies to a row: a season or episode's series'
 * rating, every other row's own (NULL = unrated). The expression behind
 * {@link buildSeriesOwnedAgeRatingFilter}.
 */
export function seriesOwnedAgeRatingExpression(
    sql: postgres.Sql,
    alias = 'mi',
): postgres.PendingQuery<postgres.Row[]> {
    if (!SAFE_IDENTIFIER.test(alias)) {
        throw new Error(`seriesOwnedAgeRatingExpression: invalid alias "${alias}"`);
    }
    const a = sql(alias);
    return sql`(CASE ${a}.media_type
                WHEN 'episode' THEN (
                    -- Usually episode -> season -> series; an episode filed
                    -- directly under its series takes the parent's rating.
                    SELECT CASE WHEN _ar_parent.media_type IN ('tv', 'series') THEN _ar_parent.age_rating
                                ELSE _ar_series.age_rating END
                    FROM media_items _ar_parent
                    LEFT JOIN media_items _ar_series ON _ar_series.id = _ar_parent.parent_id
                    WHERE _ar_parent.id = ${a}.parent_id
                )
                WHEN 'season' THEN (
                    SELECT _ar_series.age_rating FROM media_items _ar_series
                    WHERE _ar_series.id = ${a}.parent_id
                )
                ELSE ${effectiveAgeRatingExpression(sql, alias)}
            END)`;
}

/**
 * Collapse either accepted input to the legacy params the predicate needs,
 * or the sentinel `'denyAll'`.
 */
function resolveAgeParams(
    params: AgeScope | AgeRatingFilterParams | null | undefined,
): AgeRatingFilterParams | null | undefined | 'denyAll' {
    if (params === null || params === undefined) return params;
    if (!('kind' in params)) return params;
    switch (params.kind) {
        case 'any':
            return null;
        case 'limit':
            return { maxAgeRating: params.maxAgeRating, allowUnrated: params.allowUnrated };
        case 'denyAll':
            return 'denyAll';
    }
}
