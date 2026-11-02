// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch-together session access boundary.
 *
 * Two handlers list watch-together sessions — the SPA-internal
 * `defs/watch-together/parties.ts` and the v1-native
 * `routes/api/v1/watch-together/parties/+server.ts`. The v1 surface is an
 * allowlisted native duplicate (see tests/api-v1-parity.test.ts), so the parity
 * tests will NOT flag the two copies drifting apart. They previously carried a
 * hand-copied access-filtering block each; this module is the single
 * implementation both now call so a fix to one is a fix to both.
 *
 * Two rules encoded here:
 *
 * 1. The boundary is REQUIRED and resolved fail-CLOSED. Neither a missing
 *    database handle nor a throw inside `buildSearchAccessContext` may degrade
 *    to "no filtering" — both yield {@link denyAllAccess}, which is a real,
 *    expressible boundary under the required-by-shape model (it was not
 *    expressible under the legacy `deniedGroupIds/ageRating` pair).
 *
 * 2. A session with no `itemId` is only exempt from the media filter, never
 *    from the boundary itself. `itemId` is typed non-optional but sessions are
 *    `JSON.parse`d out of Valkey, so a blank one is reachable at runtime; the
 *    old `!s.itemId || allowed.has(s.itemId)` predicate made such a session
 *    unconditionally visible and leaked its title and host username. Under a
 *    denyAll boundary nothing is visible, itemId or not.
 *
 * Boundaries other than denyAll behave exactly as before: which sessions a
 * genuinely restricted (denyGroups / age-limit) user sees is unchanged.
 */

import type { Sql } from 'postgres';
import {
    denyAllAccess,
    filterAccessibleMediaIds,
    type MediaAccessBoundary,
} from '$lib/server/utils/media-access-batch.js';
import { deniesEverything } from '$lib/server/database/queries/builders/media-access-boundary.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import type { UserContext } from '$lib/server/types.js';

/** Minimal shape the access filter needs from a watch-together session. */
export interface AccessFilterableSession {
    itemId?: string | null;
}

/**
 * Resolve the media-access boundary for a sessions listing.
 *
 * Fails CLOSED on both degraded paths — no database handle, or a throw while
 * building the access context (library-perms cache miss, DB blip). Both used to
 * skip filtering entirely and list every session's title and host.
 */
export async function resolveWatchTogetherBoundary(
    sql: Sql | null,
    user: UserContext,
): Promise<MediaAccessBoundary> {
    if (!sql) return denyAllAccess();
    try {
        return searchAccessBoundary(await buildSearchAccessContext(sql, user));
    } catch {
        return denyAllAccess();
    }
}

/**
 * Drop every session the boundary does not permit.
 *
 * @param sql   Database handle; may be null, in which case only a non-denying
 *              boundary would need it and none can exist (see
 *              {@link resolveWatchTogetherBoundary}) — so the result is empty.
 * @param sessions Raw sessions from `getAllSessions`.
 * @param boundary REQUIRED. There is no permissive default: a caller that
 *              genuinely wants no filtering must pass `unrestrictedAccess()`.
 */
export async function filterSessionsByAccess<T extends AccessFilterableSession>(
    sql: Sql | null,
    sessions: readonly T[],
    boundary: MediaAccessBoundary,
): Promise<T[]> {
    // denyAll first: it must beat both the empty-input and the no-sql paths,
    // and it must drop itemId-less sessions too (their title/host is the leak).
    if (deniesEverything(boundary)) return [];
    if (sessions.length === 0) return [];
    if (!sql) return [];

    const itemIds = sessions.map((s) => s.itemId).filter((id): id is string => Boolean(id));
    const allowedIds = await filterAccessibleMediaIds(sql, itemIds, boundary);
    // A session with no itemId has no media to check, so the media filter cannot
    // speak to it. It survives only because the boundary is not denyAll.
    return sessions.filter((s) => !s.itemId || allowedIds.has(s.itemId));
}
