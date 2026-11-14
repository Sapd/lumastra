// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin Connect Password Reveal
 *
 * GET - Return the caller's own current client password in plaintext.
 *
 * Split off from `GET /api/jellyfin-connect/password` (which only reports
 * whether one exists) so that opening the connection settings does NOT pull the
 * secret over the wire — it is fetched only when the user explicitly clicks
 * "reveal". Rate limited on the same basis as generation.
 *
 * Returns `{ password: null }` for a row written before the encrypted display
 * copy existed (migration 16.170.0), or one whose envelope no longer opens. The
 * UI reads that as "reset to see it again"; use the sibling GET for the
 * has-a-password-at-all question.
 */

import type { RequestHandler } from './$types';
import { typedJson } from '$lib/server/utils/typed-response.js';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { withValkeyRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { features } from '$lib/server/config.js';
import {
    revealPassword,
    formatPasswordForDisplay,
} from '$lib/server/jellyfin-compat/auth.js';
import { Database } from '$lib/server/database/connection.js';
import { getUserByUsername } from '$lib/server/database/queries/users.queries.js';
import { JellyfinPasswordRevealResponseSchema } from '$lib/schemas/api-user-responses.js';

const ENDPOINT = '/api/jellyfin-connect/password/reveal';

// This body carries a live credential — keep it out of every cache tier,
// including the browser's back/forward store.
const NO_STORE = { headers: { 'Cache-Control': 'no-store, max-age=0' } } as const;

export const GET: RequestHandler = withValkeyRateLimit(
    20,
    60,
)(
    requireAuth(
        withErrorHandler(async ({ locals }) => {
            if (!features.jellyfinCompat) {
                return ApiResponses.notFound('Feature', ENDPOINT);
            }

            const db = new Database();
            const sql = db.getSql();

            const userRow = await getUserByUsername(sql, locals.user.username);
            if (!userRow) {
                return ApiResponses.notFound('User', ENDPOINT);
            }

            const password = await revealPassword(userRow.id);

            return typedJson(
                JellyfinPasswordRevealResponseSchema,
                // Grouped the same way the generate response is, so the value
                // the user sees on reveal is character-for-character the one
                // they saw when it was created.
                { password: password ? formatPasswordForDisplay(password) : null },
                NO_STORE,
            );
        }),
    ),
);
