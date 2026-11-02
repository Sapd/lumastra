// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /my/hidden — server load
 *
 * Returns every Continue-Watching dismissal for the current user plus
 * enough media metadata (title, poster URL) to render a restore card
 * without a follow-up round trip. Uses the same query module the
 * `/api/continue-watching/dismissals` GET endpoint does, so behaviour
 * stays consistent across the two entry points.
 *
 * Access: the metadata fetch is filtered by the caller's REQUIRED
 * {@link MediaAccessBoundary}, built from the signed-in user via
 * `searchAccessBoundary(buildSearchAccessContext(...))`. Both entry points call
 * the same `fetchDismissalMediaInfo` query, which splices the shared library and
 * age builders — previously this route used the builders while the API twin
 * hand-inlined a copy of the identical predicate, so the two could drift.
 *
 * Fail-closed: the catch below swallows errors and renders an empty list. Keep
 * the query inside the try — a boundary that makes a builder throw must show the
 * user an empty page, never unfiltered rows.
 */

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/database/connection.js';
import {
    getUserFlags,
    fetchDismissalMediaInfo,
} from '$lib/server/database/queries/user-media-flags.queries.js';
import { getCatalogImageUrl } from '$lib/utils/image-utils.js';
import { Logger } from '$lib/server/utils/logger.js';
import type { DismissedItem, DismissalTargetType } from '$lib/schemas/api-dismissals-responses.js';
import { isAudiobook, isMovie } from '$lib/server/utils/media-types.js';
import { appPath } from '$lib/shared/api-urls.js';

const logger = Logger.for('MyHiddenPage');

export const load: PageServerLoad = async ({ locals, depends }) => {
    depends('app:hidden-items');
    // Auth-gate. A signed-out user lands on `/` same as every other
    // user-scoped page — we don't want an error screen for the simple
    // case of "your session timed out".
    const username = locals.user?.username;
    const userId = locals.user?.userId;
    if (!username || !userId) {
        throw redirect(302, appPath('/'));
    }

    const sql = getDb();
    if (!sql) {
        // Degrade gracefully: render the page with an empty list so
        // the user still gets the message instead of a 500.
        logger.warn('Database unavailable for /my/hidden load', {
            username,
        });
        return { items: [] as DismissedItem[] };
    }

    try {
        const flags = await getUserFlags.all(sql, {
            userId,
            flagType: 'dismissed_cw',
        });

        if (flags.length === 0) {
            return { items: [] as DismissedItem[] };
        }

        const targetIds = flags.map((f) => f.target_id);

        // Build the access boundary for this real user. Never a permissive
        // default: `searchAccessBoundary` projects the user's actual denied
        // library groups and age policy onto the required-by-shape boundary.
        const { buildSearchAccessContext, searchAccessBoundary } =
            await import('$lib/server/utils/search-access-context.js');
        const accessCtx = await buildSearchAccessContext(sql, locals.user);

        const mediaRows = await fetchDismissalMediaInfo(
            sql,
            targetIds,
            searchAccessBoundary(accessCtx),
        );

        const mediaById = new Map<string, { title: string; media_type: string }>();
        for (const row of mediaRows) {
            mediaById.set(row.id, {
                title: row.title,
                media_type: row.media_type,
            });
        }

        const items: DismissedItem[] = [];
        for (const flag of flags) {
            const info = mediaById.get(flag.target_id);
            if (!info) continue;
            const rawType = flag.target_type;
            const targetType: DismissalTargetType =
                // eslint-disable-next-line callback-safety/no-inline-media-type-default -- hidden-item storage is explicitly limited to these media kinds.
                rawType === 'series' || rawType === 'movie' || rawType === 'audiobook'
                    ? rawType
                    : isAudiobook(info.media_type)
                      ? 'audiobook'
                      : isMovie(info.media_type)
                        ? 'movie'
                        : 'series';

            items.push({
                targetId: flag.target_id,
                targetType,
                title: info.title,
                images: {
                    poster: {
                        href: getCatalogImageUrl(flag.target_id, 'poster', { size: 'thumb' }),
                    },
                },
                dismissedAt: flag.created_at,
            });
        }

        return { items };
    } catch (err) {
        logger.error('Failed to load hidden items', err as Error, { username });
        return { items: [] as DismissedItem[] };
    }
};
