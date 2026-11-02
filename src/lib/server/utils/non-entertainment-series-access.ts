// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { UserContext } from '$lib/server/types';
import {
    getSeriesWithEpisodes,
    type NonEntertainmentBrowseItem,
    type NonEntertainmentEpisode,
} from '$lib/server/database/queries/non-entertainment-browse.queries.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { filterAccessibleMediaIds } from '$lib/server/utils/media-access-batch.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';

/**
 * `getSeriesWithEpisodes` for a viewer: the series only when the viewer may see
 * it (library group + age, `checkMediaAccess`), and only the episodes they may
 * see. A series the viewer may not see comes back exactly like a missing one.
 *
 * The raw query filters on the id alone. The /library/[type]/[seriesId] page
 * and /watch's `?col=`/`?event=` shells called it directly, so any signed-in
 * user who knew a series id saw its titles, overviews and episode list (and,
 * before the query stopped selecting it, every episode's server file path).
 * Found in the 2026-10-07 entry-point review.
 */
export async function getAccessibleSeriesWithEpisodes(
    sql: postgres.Sql,
    seriesId: string,
    user: UserContext | undefined,
    opts?: { mediaType?: string },
): Promise<{ series: NonEntertainmentBrowseItem | null; episodes: NonEntertainmentEpisode[] }> {
    const none = { series: null, episodes: [] };
    // Fail closed: checkMediaAccess treats a missing user as "auth middleware's
    // problem" and answers true.
    if (!user) return none;
    const { series, episodes } = await getSeriesWithEpisodes(sql, seriesId, opts);
    if (!series) return none;
    if (!(await checkMediaAccess(sql, series.id, user))) return none;
    if (episodes.length === 0) return { series, episodes };

    const boundary = searchAccessBoundary(await buildSearchAccessContext(sql, user));
    const visible = await filterAccessibleMediaIds(
        sql,
        episodes.map((e) => e.id),
        boundary,
    );
    // The series row has no files of its own, so checkMediaAccess passes it even
    // when every episode sits in a denied library group. Its episodes decide: a
    // series none of whose episodes the viewer may see is not visible either.
    if (visible.size === 0) return none;
    return { series, episodes: episodes.filter((e) => visible.has(e.id)) };
}
