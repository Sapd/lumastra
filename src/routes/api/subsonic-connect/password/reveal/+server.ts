// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Subsonic Connect Token Reveal
 *
 * GET - Return the caller's own current Subsonic token in plaintext.
 *
 * Split off from `GET /api/subsonic-connect/password` (which only reports
 * whether one exists) so that opening the connection settings does NOT pull the
 * secret over the wire — it is fetched only when the user explicitly clicks
 * "reveal".
 *
 * Unlike the Jellyfin equivalent this needs no decryption: the Subsonic
 * protocol has the server verify `MD5(token + salt)`, so the token is
 * necessarily stored in the clear and is always revealable when present.
 */

import type { RequestHandler } from './$types';
import { typedJson } from '$lib/server/utils/typed-response.js';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { withValkeyRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { features } from '$lib/server/config.js';
import { revealToken, formatTokenForDisplay } from '$lib/server/subsonic-compat/auth.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getUserByUsername } from '$lib/server/database/queries/users.queries.js';
import { SubsonicTokenRevealResponseSchema } from '$lib/schemas/api-user-responses.js';

const ENDPOINT = '/api/subsonic-connect/password/reveal';

// This body carries a live credential — keep it out of every cache tier,
// including the browser's back/forward store.
const NO_STORE = { headers: { 'Cache-Control': 'no-store, max-age=0' } } as const;

export const GET: RequestHandler = withValkeyRateLimit(
    20,
    60,
)(
    requireAuth(
        withErrorHandler(async ({ locals }) => {
            if (!features.subsonicCompat) {
                return ApiResponses.notFound('Feature', ENDPOINT);
            }

            const sql = await aiDbService.getSql();
            if (!sql) return ApiResponses.error('Database unavailable');

            const userRow = await getUserByUsername(sql, locals.user.username);
            if (!userRow) {
                return ApiResponses.notFound('User', ENDPOINT);
            }

            const token = await revealToken(userRow.id);

            return typedJson(
                SubsonicTokenRevealResponseSchema,
                // Grouped the same way the generate response is, so the value
                // the user sees on reveal is character-for-character the one
                // they saw when it was created.
                { token: token ? formatTokenForDisplay(token) : null },
                NO_STORE,
            );
        }),
    ),
);
