// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/integrations/watch-history.ts — GET /api/v1/integrations/watch-history
 *
 * One user's watch history (recently watched, continue watching, top genres, counts)
 * for an external recommender such as a chat bot. Read-only.
 *
 * Auth: a service token with the `integrations:read` grant only.
 *   1. The /api/v1 gate (hooks.server.ts) 401s a request without any credential.
 *   2. mount's `{kind:'scope', anyOf:['integrations:read']}` gate (`admin` also
 *      passes it, so step 3 is what decides).
 *   3. `integrationTokenDenial()` ($lib/server/auth/integration-token.ts): 403 for
 *      anything that is not an `integrations:read` service token whose owner is
 *      still an administrator — admin sessions, admin PATs and `admin` service
 *      tokens included. The payload is another person's viewing history, so only
 *      a credential minted for this purpose may read it: revocable on its own,
 *      useless anywhere else if it leaks. A user reading their OWN history has
 *      the regular user endpoints (continue-watching, …).
 *   A token whose stored path prefixes do not cover this path never gets here:
 *   `tokenEnvelopeDenial()` answers 403 "Token not permitted on this endpoint".
 *
 * v1-only: HAND-MOUNTED from src/routes/api/v1/integrations/watch-history/+server.ts.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { integrationTokenDenial } from '$lib/server/auth/integration-token.js';
import { getAdminDb } from '$lib/server/database/connection.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    getIntegrationWatchHistory,
    InvalidWatchHistoryCursorError,
} from '$lib/server/services/integration-watch-history.service.js';
import {
    WatchHistoryQuerySchema,
    WatchHistoryResponseSchema,
} from '$lib/schemas/api-watch-history-integration-responses.js';

const logger = Logger.for('IntegrationWatchHistory');

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['integrations:read'] },
    request: { query: WatchHistoryQuerySchema },
    docs: {
        visibility: 'public',
        GET: {
            tags: ['Integrations'],
            summary: "A user's watch history for recommenders",
            description:
                "Recently watched movies, episodes and audiobooks (newest first, cursor-paginated), the Continue Watching row, top genres over the last `days` days and counts, for ONE user given as `?user=<username or UUID>`. The username is the Lumastra username: the forward-auth (Authentik) username lowercased, or the OIDC `preferred_username` normalized. Only titles that user may still open are listed. Timestamps the 2026-03-31 Jellyfin bulk import wrote are reported as `lastWatchedAt: null` (unknown) and sort last. No file paths, IPs, devices or other users' data. Cached for 60 s per user (and page). Credential: a service token with the `integrations:read` grant, minted by an administrator whose account is still admin; every other credential, admin sessions, PATs and `admin` service tokens included, gets 403. A username matching two accounts case-insensitively (none exactly) answers 409.",
            stability: 'beta',
            auth: 'bearer',
            query: WatchHistoryQuerySchema,
            responses: {
                200: { schema: WatchHistoryResponseSchema, description: 'Watch history' },
                401: 'Authentication required',
                403: 'Not an integrations:read service token',
                404: 'Unknown user',
                409: 'Username matches two accounts case-insensitively; pass the user UUID',
                422: 'Validation failed (missing user, bad limit/days, malformed cursor)',
                503: 'Database unavailable',
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

            try {
                const result = await getIntegrationWatchHistory(sql, q.user, {
                    limit: q.limit,
                    cursor: q.cursor,
                    days: q.days,
                });
                if (!result.ok) {
                    return result.reason === 'user_ambiguous'
                        ? ApiProblem.conflict(
                              'Username matches more than one account; pass the user UUID',
                          )
                        : ApiProblem.notFound('Unknown user');
                }
                // Audit trail: which integration token read whose history.
                logger.info('watch history read', {
                    tokenId: event.locals.principal?.credentialId,
                    targetUserId: result.value.user.id,
                    cursor: q.cursor ? 'yes' : 'no',
                });
                return json(WatchHistoryResponseSchema.parse(result.value), {
                    headers: { 'Cache-Control': 'private, no-store' },
                });
            } catch (err) {
                if (err instanceof InvalidWatchHistoryCursorError) {
                    return ApiProblem.validationFailed([
                        { field: 'cursor', message: 'Malformed cursor' },
                    ]);
                }
                throw err;
            }
        },
    },
});
