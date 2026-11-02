// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

const VIDEO_TYPES = ['movie', 'tv', 'series', 'episode', 'season'] as const;

/**
 * Require concrete file links for playable video rows. Series and seasons derive
 * availability from active, file-backed episodes instead of stale roll-up flags.
 *
 * @param mediaTypes - When the caller already restricts the query to a known,
 *   non-empty set of media types (typically via a separate
 *   `AND mi.media_type = ANY(mediaTypes)` clause elsewhere in the same query),
 *   pass that same set here so branches that can never match get OMITTED from
 *   the emitted SQL rather than left for Postgres to prove dead at plan time.
 *
 *   This isn't just tidiness: Postgres's BitmapOr cost estimator can't see that
 *   e.g. `mi.media_type = 'season' AND mi.media_type = ANY('{movie}')` is a
 *   contradiction before costing the plan (it DOES skip the branch at
 *   execution — just not early enough to affect the estimate). With all 4
 *   branches always present, the inflated cost estimate crosses Postgres's
 *   JIT threshold on this table's size, and JIT compilation of the query
 *   ends up costing MORE than running it — measured 4-19x overhead on
 *   production for single-media-type browse queries. Omit the impossible
 *   branches and the estimate (and the JIT decision) reflects reality.
 *
 *   Leave empty (the default) when the caller has no type restriction, or
 *   restricts via something this function can't see (e.g. only through
 *   `idList`) — all 4 branches are emitted, identical to previous behavior.
 */
export function buildFileBackedVideoItemFilter(
    sql: postgres.Sql,
    requireNonVideoFiles = false,
    mediaTypes: readonly string[] = [],
): postgres.PendingQuery<postgres.Row[]> {
    const restricted = mediaTypes.length > 0;
    const wants = (types: readonly string[]) =>
        !restricted || mediaTypes.some((t) => types.includes(t));
    const wantsNonVideoType = () =>
        !restricted ||
        mediaTypes.some((t) => !VIDEO_TYPES.includes(t as (typeof VIDEO_TYPES)[number]));

    const branches: postgres.PendingQuery<postgres.Row[]>[] = [];

    if (wantsNonVideoType()) {
        branches.push(sql`
            (
                mi.media_type NOT IN ('movie', 'tv', 'series', 'episode', 'season')
                ${requireNonVideoFiles ? sql`AND mi.has_files = true` : sql``}
            )
        `);
    }

    if (wants(['movie', 'episode'])) {
        branches.push(sql`
            (
                mi.media_type IN ('movie', 'episode')
                AND mi.has_files = true
                AND EXISTS (
                    SELECT 1
                    FROM media_file_items mfi
                    WHERE mfi.media_item_id = mi.id
                )
            )
        `);
    }

    if (wants(['season'])) {
        // eslint-disable-next-line callback-safety/no-unscoped-media-items -- access-gated by the caller's WHERE (see this builder's own callers)
        branches.push(sql`
            (
                mi.media_type = 'season'
                AND EXISTS (
                    SELECT 1
                    FROM media_items ep
                    JOIN media_file_items mfi ON mfi.media_item_id = ep.id
                    WHERE ep.parent_id = mi.id
                      AND ep.media_type = 'episode'
                      AND ep.status = 'active'
                      AND ep.has_files = true
                )
            )
        `);
    }

    if (wants(['tv', 'series'])) {
        // eslint-disable-next-line callback-safety/no-unscoped-media-items -- access-gated by the caller's WHERE (see this builder's own callers)
        branches.push(sql`
            (
                mi.media_type IN ('tv', 'series')
                AND EXISTS (
                    SELECT 1
                    FROM media_items season
                    JOIN media_items ep ON ep.parent_id = season.id
                    JOIN media_file_items mfi ON mfi.media_item_id = ep.id
                    WHERE season.parent_id = mi.id
                      AND season.media_type = 'season'
                      AND season.status = 'active'
                      AND ep.media_type = 'episode'
                      AND ep.status = 'active'
                      AND ep.has_files = true
                )
            )
        `);
    }

    // Defensive only: mediaTypes should always overlap at least one branch in
    // practice (it's a caller-controlled, internally-validated set). If it
    // somehow doesn't, correctness matters more than the optimization —
    // `AND false` matches zero rows, same as an always-false OR chain would.
    if (branches.length === 0) {
        return sql`AND false`;
    }

    const body = branches.reduce((acc, branch) => sql`${acc} OR ${branch}`);

    // Access predicates are composed by each calling query after this availability fragment.
    return sql`AND (${body})`;
}
