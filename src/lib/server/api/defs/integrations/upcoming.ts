// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/integrations/upcoming — one user's upcoming episodes for an
 * integration (a chat bot answering "what's new for me").
 *
 * The list is `getUpcomingEpisodesForUser`, the same function behind
 * `GET /api/v1/upcoming?view=episodes`, so the bot sees exactly what the app
 * shows that user. The user's boundary comes from `resolveTokenUserAccess`, the
 * canonical composition the notification emitter also uses (pins, in-app
 * cohort, effective groups) — not from raw `users` columns.
 *
 * Credential: a service token with the `integrations:read` grant, like
 * `integrations/watch-history`; every other credential gets 403.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { integrationTokenDenial } from '$lib/server/auth/integration-token.js';
import { resolveTokenUserAccess } from '$lib/server/auth/resolve-token-user-access.js';
import { getDeniedLibraryGroups } from '$lib/server/cache/library-group-permissions-cache.js';
import { config } from '$lib/server/config.js';
import { getAdminDb } from '$lib/server/database/connection.js';
import { findWatchHistoryUser } from '$lib/server/database/queries/integration-watch-history.queries.js';
import { getUpcomingEpisodesForUser } from '$lib/server/api/defs/recommendations/upcoming.js';
import {
    UpcomingIntegrationQuerySchema,
    UpcomingIntegrationResponseSchema,
} from '$lib/schemas/api-upcoming-integration-responses.js';
import { toUserId } from '$lib/shared/user-id.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('IntegrationUpcoming');

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['integrations:read'] },
    request: { query: UpcomingIntegrationQuerySchema },
    docs: {
        visibility: 'public',
        GET: {
            tags: ['Integrations'],
            summary: "A user's upcoming episodes",
            description:
                'Upcoming, unwatched episodes of the series ONE user watches or explicitly follows ' +
                '(`?user=<username or UUID>`), airing within `days` (default 7). The same list ' +
                '`GET /api/v1/upcoming?view=episodes` returns to that user, behind that user’s ' +
                'library and age boundary; age-restricted profiles get 403 there and here. ' +
                'Built from the Sonarr/Radarr calendar, cached per user. Credential: a service ' +
                'token with the `integrations:read` grant, minted by an administrator whose ' +
                'account is still admin; every other credential gets 403. A username matching two accounts ' +
                'case-insensitively (none exactly) answers 409.',
            stability: 'beta',
            auth: 'bearer',
            query: UpcomingIntegrationQuerySchema,
            responses: {
                200: {
                    schema: UpcomingIntegrationResponseSchema,
                    description: 'Upcoming episodes',
                },
                401: 'Authentication required',
                403: 'Not an integrations:read service token, or an age-restricted user',
                404: 'Unknown, disabled or deleted user',
                409: 'Username matches two accounts case-insensitively; pass the user UUID',
                422: 'Validation failed (missing user, bad days/limit)',
                503: 'Database, Sonarr and Radarr unavailable',
            },
        },
    },
    handlers: {
        GET: async (event, ctx) => {
            const denial = integrationTokenDenial(event.locals.principal);
            if (denial) return denial;

            const q = ctx.input!.query;
            const sql = getAdminDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const lookup = await findWatchHistoryUser(sql, q.user);
            if (lookup.kind === 'ambiguous') {
                return ApiProblem.conflict(
                    'Username matches more than one account; pass the user UUID',
                );
            }
            if (lookup.kind === 'not_found') return ApiProblem.notFound('Unknown user');
            const user = lookup.user;

            const access = await resolveTokenUserAccess(user.username);
            if (!access || access.disabled || access.deleted) {
                return ApiProblem.notFound('Unknown user');
            }
            const maxAgeRating = access.permissions.maxAgeRating ?? null;
            if (maxAgeRating !== null) {
                return ApiProblem.forbidden(
                    'Upcoming content is not available for age-restricted profiles',
                );
            }
            const deniedGroupIds = await getDeniedLibraryGroups(sql, {
                isAdmin: access.permissions.ownerIsAdmin,
                userGroups: access.userGroups,
            });

            const result = await getUpcomingEpisodesForUser(
                sql,
                {
                    userId: toUserId(user.id),
                    username: user.username,
                    deniedGroupIds,
                    maxAgeRating,
                    allowUnrated: config.UNRATED_CONTENT_VISIBLE,
                },
                { limit: q.limit, refresh: false, days: q.days },
            );
            if (!result.ok) return ApiProblem.dependencyUnavailable('Upcoming data unavailable');

            logger.info('upcoming read', {
                tokenId: event.locals.principal?.credentialId,
                targetUserId: user.id,
                days: q.days,
            });
            return json(
                UpcomingIntegrationResponseSchema.parse({
                    items: result.items,
                    truncated: result.truncated,
                }),
                { headers: { 'Cache-Control': 'private, no-store' } },
            );
        },
    },
});
