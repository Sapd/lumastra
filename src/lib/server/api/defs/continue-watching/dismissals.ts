// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET/POST/DELETE /api/continue-watching/dismissals
 *
 * POST    — dismiss an item (series for episodes, movie for movies)
 * DELETE  — un-dismiss an item
 * GET     — list all current dismissals with display metadata
 *
 * The dismissal itself is a row in `user_media_flags` with
 * `flag_type = 'dismissed_cw'`. The CW / Next-Up read queries already
 * filter out dismissed targets via an anti-join, so writing a row here
 * is immediately reflected on the next /continue-watching fetch.
 *
 * Auth: user (session or token). DB-down: 503 dependency_unavailable.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import {
    DismissalRequestBodySchema,
    DismissedItemsResponseSchema,
    type DismissedItem,
    type DismissalTargetType,
} from '$lib/schemas/api-dismissals-responses.js';
import { entityImageUrl } from '$lib/shared/api-urls.js';
import { isAudiobook, isMovie } from '$lib/server/utils/media-types.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('CwDismissalsDef');

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    request: {
        // POST and DELETE share the same body shape; mount() validates it for
        // both methods (body schema is declared once at the def level and
        // applied to any method that carries a body).
        body: DismissalRequestBodySchema,
    },

    handlers: {
        /**
         * POST /api/continue-watching/dismissals
         * Idempotent — a repeat dismissal of the same target is a no-op.
         */
        POST: async (event, ctx) => {
            const username = event.locals.user?.username;
            const userId = event.locals.user?.userId;
            if (!username || !userId) return ApiProblem.unauthorized();

            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const body = ctx.input?.body;
            if (!body) return ApiProblem.validationFailed([{ field: 'body', message: 'Required' }]);

            const { targetId, targetType } = body;

            // Block writing dismissal flags for media the caller cannot
            // access. Without this, a restricted UUID can be written to
            // user_media_flags and later confirmed via GET.
            const { checkMediaAccess } = await import('$lib/server/middleware/media-access.js');
            if (!(await checkMediaAccess(sql, targetId, event.locals.user))) {
                return ApiProblem.notFound('Media');
            }

            const { setFlag } =
                await import('$lib/server/database/queries/user-media-flags.queries.js');

            try {
                await setFlag.execute(sql, {
                    userId,
                    targetId,
                    targetType,
                    flagType: 'dismissed_cw',
                });

                logger.debug('Dismissed item from Continue Watching', {
                    username,
                    targetId,
                    targetType,
                });

                return json({ ok: true as const });
            } catch (err) {
                logger.error('Failed to dismiss Continue Watching item', err as Error, {
                    username,
                    targetId,
                    targetType,
                });
                return ApiProblem.internalError('Failed to dismiss item');
            }
        },

        /**
         * DELETE /api/continue-watching/dismissals
         * Symmetric with POST — same body shape so clients can reuse the same serializer.
         */
        DELETE: async (event, ctx) => {
            const username = event.locals.user?.username;
            const userId = event.locals.user?.userId;
            if (!username || !userId) return ApiProblem.unauthorized();

            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const body = ctx.input?.body;
            if (!body) return ApiProblem.validationFailed([{ field: 'body', message: 'Required' }]);

            const { targetId, targetType } = body;

            const { removeFlag } =
                await import('$lib/server/database/queries/user-media-flags.queries.js');

            try {
                await removeFlag(sql, {
                    userId,
                    targetId,
                    flagType: 'dismissed_cw',
                });

                logger.debug('Un-dismissed item', {
                    username,
                    targetId,
                    targetType,
                });

                return json({ ok: true as const });
            } catch (err) {
                logger.error('Failed to un-dismiss item', err as Error, {
                    username,
                    targetId,
                    targetType,
                });
                return ApiProblem.internalError('Failed to un-dismiss item');
            }
        },

        /**
         * GET /api/continue-watching/dismissals
         * Returns every current CW dismissal for the user, joined with
         * bare-minimum media_items data needed to render /my/hidden cards.
         */
        GET: async (event, ctx) => {
            const username = event.locals.user?.username;
            const userId = event.locals.user?.userId;
            if (!username || !userId) return ApiProblem.unauthorized();

            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            try {
                const { getUserFlags, fetchDismissalMediaInfo } =
                    await import('$lib/server/database/queries/user-media-flags.queries.js');
                const flags = await getUserFlags.all(sql, {
                    userId,
                    flagType: 'dismissed_cw',
                });

                if (flags.length === 0) {
                    return json(DismissedItemsResponseSchema.parse({ items: [] }));
                }

                const targetIds = flags.map((f) => f.target_id);

                // Batch-fetch titles — filter by current access so stale dismissals
                // from before a policy change don't leak restricted titles.
                //
                // This used to hand-inline a copy of the library and age
                // predicates. It now shares `fetchDismissalMediaInfo` with the
                // `/my/hidden` page load, which takes a REQUIRED
                // MediaAccessBoundary and splices the canonical builders — the
                // two surfaces serve the same data to the same page and can no
                // longer drift. The inline form also carried no
                // `buildLibraryAccessFilter` token, so the
                // no-unscoped-media-items lint rule could not see it.
                const { buildSearchAccessContext, searchAccessBoundary } =
                    await import('$lib/server/utils/search-access-context.js');
                const accessCtx = await buildSearchAccessContext(sql, event.locals.user);

                const mediaRows = await fetchDismissalMediaInfo(
                    sql,
                    targetIds,
                    searchAccessBoundary(accessCtx),
                );

                const mediaById = new Map<string, { title: string; media_type: string }>();
                for (const row of mediaRows) {
                    mediaById.set(row.id, { title: row.title, media_type: row.media_type });
                }

                const items: DismissedItem[] = [];
                for (const flag of flags) {
                    const info = mediaById.get(flag.target_id);
                    // Skip flags whose media has been deleted (cascade will clean up).
                    if (!info) continue;

                    // Derive targetType: prefer the flag's stored value when valid.
                    const rawType = flag.target_type;
                    const targetType: DismissalTargetType =
                        // eslint-disable-next-line callback-safety/no-inline-media-type-default -- dismissal storage is explicitly limited to these media kinds.
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
                                href: entityImageUrl(flag.target_id, 'poster', ctx.surface, {
                                    size: 'thumb',
                                }),
                            },
                        },
                        dismissedAt: flag.created_at,
                    });
                }

                return json(DismissedItemsResponseSchema.parse({ items }));
            } catch (err) {
                logger.error('Failed to list Continue Watching dismissals', err as Error, {
                    username,
                });
                return ApiProblem.internalError('Failed to list dismissals');
            }
        },
    },
});
