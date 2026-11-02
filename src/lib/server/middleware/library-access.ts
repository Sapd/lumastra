// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Library Access Middleware
 *
 * Enforces library group permissions on media item routes.
 * Checks whether the authenticated user has access to the resolved media item
 * based on their Authentik groups and the library group's allowed_groups.
 *
 * Must be composed after `withIdResolution` (needs `locals.resolvedIds.internalId`).
 *
 * ## Composition Patterns
 *
 * Three valid patterns are used across routes. `withLibraryAccess` always
 * wraps directly inside `withIdResolution` (it depends on `resolvedIds`):
 *
 * **Pattern A — Auth-gated (playback routes):**
 * ```
 * requireAuth(withIdResolution(withLibraryAccess(withErrorHandler(handler))))
 * ```
 *
 * **Pattern B — Public with ID resolution (detail/info routes):**
 * ```
 * withIdResolution(withLibraryAccess(withErrorHandler(handler)))
 * ```
 *
 * **Pattern C — Error handler outermost (routes needing error catch on ID resolution):**
 * ```
 * withErrorHandler(withIdResolution(withLibraryAccess(handler)))
 * ```
 *
 * The invariant: `withIdResolution` → `withLibraryAccess` → handler (in that nesting order).
 * `requireAuth` and `withErrorHandler` placement varies by route needs.
 */

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { getDb } from '$lib/server/database/index.js';
import {
    isMediaAccessible,
    toLibraryAccessUser,
} from '$lib/server/cache/library-group-permissions-cache.js';

/**
 * Middleware that rejects requests where ID resolution did not produce an
 * internal media UUID. Use after `withIdResolution` on routes that MUST
 * operate on a known media item (playback, sessions, access-gated data).
 *
 * Composition:
 * ```
 * withIdResolution(requireResolvedId(withLibraryAccess(handler)))
 * ```
 */
export function requireResolvedId(handler: RequestHandler): RequestHandler {
    return async (event: RequestEvent): Promise<Response> => {
        const { internalId } = event.locals.resolvedIds ?? {};
        if (!internalId?.trim()) {
            return ApiResponses.notFound('Media item not found');
        }
        return handler(event);
    };
}

/**
 * Middleware that blocks playback if the user lacks access to the media item's
 * library group. Admins always pass. Fails closed when DB is unavailable.
 */
export function withLibraryAccess(handler: RequestHandler): RequestHandler {
    return async (event: RequestEvent): Promise<Response> => {
        const { internalId } = event.locals.resolvedIds ?? {};
        const user = event.locals.user;

        if (user && internalId) {
            const sql = getDb();
            if (sql) {
                const accessible = await isMediaAccessible(
                    sql,
                    internalId,
                    toLibraryAccessUser(user)!,
                );
                if (!accessible) {
                    // 404 (not 403): a library-restricted user must not be able to
                    // distinguish "exists but you can't see it" from "doesn't exist"
                    // by probing UUIDs. Matches the age-gate + resolveAndGate
                    // convention (no cross-library existence leak).
                    return ApiResponses.notFound('Content not available');
                }
            } else if (!toLibraryAccessUser(user)?.isAdmin) {
                return ApiResponses.error('Unable to verify content access');
            }
        }

        return handler(event);
    };
}
