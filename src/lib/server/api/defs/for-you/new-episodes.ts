// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { getDb } from '$lib/server/database/connection.js';
import { restrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { buildAccessContext } from '../recommendations/recommender.js';
import { overlayUpcomingItems } from '../recommendations/upcoming.js';
import { json } from '@sveltejs/kit';
import { isWidgetDisabled } from '$lib/server/utils/widget-guard.js';
import { NewEpisodesResponseSchema } from '$lib/schemas/api-for-you-responses.js';
import {
    buildNewEpisodePreviews,
    getNewReleaseGroupsForUser,
} from '$lib/server/services/new-episodes.service.js';

/**
 * GET /api/v1/for-you/new-episodes (also mounted at /api/for-you/new-episodes
 * for the web app)
 *
 * "New episodes available": newly RELEASED episodes of series the user
 * follows, one card per series. The rule (new-release-rule.ts, API.md
 * "New episodes available"): the episode has a file and is unwatched; the
 * user follows the series (2+ episodes watched, series notifications on, or
 * on the watchlist and started); it aired in the last 30 days and after the
 * user last watched the series or beyond the newest episode they have
 * watched; and it did not arrive in a bulk back-catalogue import. A
 * fulfilled request or a season pack of old episodes never shows here.
 *
 * Each item is the first new episode in watch order (an episode MediaPreview
 * with context.series / seasonNumber / episodeNumber / airDate,
 * reason.kind = 'new_release') plus `newEpisodes` { count,
 * watchedEpisodeCount, followReason }. `truncated` = more series than `limit`.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { z } from 'zod';

const QuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(10).optional().default(5),
});

export const def = defineEndpoint({
    docs: {
        // Spec/doc classification: divert to internal-api.yaml, matching the
        // def's runtime visibility — this rail serves the web app's For You
        // page and is not part of the published v1 surface.
        visibility: 'internal',
        GET: {
            tags: ['For You'],
            summary: 'Newly released episodes of the series the user follows',
            stability: 'beta',
            auth: 'bearer',
            query: QuerySchema,
            responses: {
                200: {
                    schema: NewEpisodesResponseSchema,
                    description:
                        'One card per followed series with newly released episodes, newest release first',
                },
                401: 'Authentication required',
                422: 'Validation failed',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },
    auth: { kind: 'user' },
    visibility: 'internal',
    request: { query: QuerySchema },
    handlers: {
        // Mounted on v1 and on the internal /api/for-you/new-episodes route the
        // web banner reads.
        GET: async (event, ctx) => {
            // The banner belongs to the "upcoming-episodes" home widget.
            if (isWidgetDisabled('upcoming-episodes')) return json({ items: [], truncated: false });
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            const access = await buildAccessContext(event);
            if (!access) return ApiProblem.unauthorized();
            if (access.isAgeRestricted) {
                return ApiProblem.forbidden(
                    'New episodes are not available for age-restricted profiles',
                );
            }
            const { limit } = ctx.input!.query;
            const groups = await getNewReleaseGroupsForUser(sql, access.userId, {
                access: restrictedAccess({
                    deniedGroupIds: access.deniedGroupIds ?? [],
                    maxAgeRating: access.maxAgeRating,
                    allowUnrated: access.allowUnrated,
                }),
            });
            const items = await buildNewEpisodePreviews(
                sql,
                groups.slice(0, limit),
                ctx.surface,
                access.userId,
            );
            await overlayUpcomingItems(sql, items, access.langs);
            return json({ items, truncated: groups.length > limit });
        },
    },
});
