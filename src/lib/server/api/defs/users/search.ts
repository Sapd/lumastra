// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * users/search — lightweight user search, serving two different callers.
 *
 * GET /users/search?q=<query>
 *
 * Visibility: internal (SPA-only; not on /api/v1, and `/api/*` is
 * forward-auth/cookie-only by construction — no PAT, service token or device
 * JWT can reach this. See `forward-auth-internal-api-bearer.test.ts`.)
 *
 * **This endpoint has two consumers with different entitlements, and a single
 * `{kind:'user'}` gate was wrong for both.**
 *
 * - `/admin/settings/access` — the access-group member picker. An operator
 *   assembling permission groups needs the real directory.
 * - `PlaylistMemberPanel` — peer invite autocomplete. A household member
 *   should not be able to enumerate people who have hidden themselves.
 *
 * So the auth spec is `any(admin, feature:playlists → user)` and the handler
 * branches to a matching query. Two things about that shape are deliberate:
 *
 * - **Order matters.** `kind:'any'` returns the LAST failure (`mount.ts:186`),
 *   so a non-admin on a playlists-disabled instance gets the feature gate's
 *   404 rather than a 403. Feature-off should read as "does not exist".
 * - **The branch reads `locals.principal.isAdmin`, never `locals.user.isAdmin`.**
 *   `mount.ts:75-90` documents that the latter is derived from live groups
 *   alone and re-grants admin to low-scope PATs and device JWTs. The handler
 *   must use the same authority `enforce()` used, or the two disagree and the
 *   disagreement is a privilege escalation.
 *
 * Response contract: bare { items: UserSearchItem[], page } — IDENTICAL on
 * both branches, so no client knows this split exists.
 * Errors: problem+json (incl. 503 dependency_unavailable, 429 rate_limited).
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/index.js';
import {
    searchUsersForDirectory,
    searchUsersForInvite,
} from '$lib/server/database/queries/users.queries.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { Logger } from '$lib/server/utils/logger.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';

const logger = Logger.for('UserSearchDef');

/**
 * Minimum query length before the DB is touched.
 *
 * Admins keep 2 — `/admin/settings/access` enforces the same floor client-side
 * (`+page.svelte:228`), so raising it would silently break that picker.
 * Peers get 3: it is one more character of friction against sweeping the
 * directory, and it costs an autocomplete nothing.
 */
const MIN_QUERY_LEN_ADMIN = 2;
const MIN_QUERY_LEN_PEER = 3;

/**
 * Peer-branch rate limit. Dampens casual scraping; explicitly NOT a boundary —
 * see `docs/architecture/social-sharing.md`. Admins are not limited: the
 * directory is theirs by right and the picker fires per keystroke.
 */
const PEER_RATE_LIMIT_MAX = 30;
const PEER_RATE_LIMIT_WINDOW_S = 60;

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const UserSearchQuery = z.object({
    /** Search term — must be at least 2 characters to query. */
    q: z.string().max(200).optional(),
});

// ---------------------------------------------------------------------------
// Response item type (inline — simple enough not to warrant a shared schema)
// ---------------------------------------------------------------------------

// { username: string; id: string }

// ---------------------------------------------------------------------------
// Endpoint def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: {
        kind: 'any',
        specs: [{ kind: 'admin' }, { kind: 'feature', flag: 'playlists', then: { kind: 'user' } }],
    },
    visibility: 'internal',
    request: {
        query: UserSearchQuery,
    },
    handlers: {
        GET: async (event, ctx) => {
            const query = (ctx.input?.query?.q ?? '').trim();

            // See the module header: principal, never locals.user.
            const isAdmin = event.locals.principal?.isAdmin === true;

            const minLen = isAdmin ? MIN_QUERY_LEN_ADMIN : MIN_QUERY_LEN_PEER;
            if (query.length < minLen) {
                return json(paginate([], { limit: 0, offset: 0, hasMore: false }));
            }

            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const currentUsername =
                event.locals.principal?.username ?? event.locals.user?.username ?? '';

            // Rate-limit AFTER the DB check, matching `music/quick-picks.ts`:
            // a caller must not burn their budget on requests that can only 503.
            if (!isAdmin) {
                const rl = await checkRateLimit(
                    `user-search:${currentUsername}`,
                    PEER_RATE_LIMIT_MAX,
                    PEER_RATE_LIMIT_WINDOW_S,
                );
                if (!rl.allowed) {
                    return ApiProblem.rateLimited(Math.ceil(rl.resetAt - Date.now() / 1000));
                }
            }

            const rows = isAdmin
                ? await searchUsersForDirectory(db, query, currentUsername)
                : await searchUsersForInvite(db, query, currentUsername);

            // Never log the query itself on the peer branch — it is another
            // user's name, and debug logs are not a social surface.
            logger.debug(
                `User search (${isAdmin ? 'directory' : 'invite'}) returned ${rows.length} results`,
            );

            const items = rows.map((row) => ({
                id: row.id,
                username: row.username,
            }));

            return json(paginate(items, { limit: items.length, offset: 0, hasMore: false }));
        },
    },
});
