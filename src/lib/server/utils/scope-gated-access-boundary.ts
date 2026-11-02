// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Resolve a `MediaAccessBoundary` for a Bearer-scope-gated (`auth:
 * {kind:'scope'}`) `/api/v1` endpoint handler.
 *
 * Shared by the two title-resolution joins C2 and C4 flagged (2026-09-18
 * fix-plan-4, Task 2): `getFailureItemTitles`
 * (database/queries/plugin-failure-events.queries.ts, called from
 * defs/tasks/[taskId]/failures.ts) and `resolveRunMediaItems`
 * (defs/runs/index.ts). Both grafted a media title onto their response with
 * no library/age predicate at all.
 *
 * This helper shares only the BOUNDARY-DERIVATION decision (how to turn a
 * request's `locals.user` into a `MediaAccessBoundary`) — it does NOT share
 * the predicate application. Each of the three queries that consume the
 * boundary (`plugin-failure-events.queries.ts`'s `direct` and `viaFile`
 * queries, and `defs/runs/index.ts`'s `resolveRunMediaItems` query) still
 * calls `buildLibraryAccessFilter`/`buildAgeRatingFilter` at its own SQL
 * site, with no divergence test tying the three together. That is
 * acceptable because all three call the same canonical builders rather than
 * a hand-copied predicate, but a future edit to one call site's WHERE clause
 * could still diverge from the other two without this file noticing. If a
 * future caller's needs genuinely differ, add a divergence test rather than
 * hand-inlining a second copy here.
 *
 * ## Fail-closed rationale (mirrors `defs/stats/me.ts`)
 *
 * `event.locals.user` (a full `UserContext`, carrying `maxAgeRating`) is set
 * by every credential path in `middleware/forward-auth.ts` — forward_auth,
 * session, PAT, service_token, and bearer/device-JWT all assign
 * `locals.user` before `mount.ts`'s `{kind:'scope'}` branch runs, so it is
 * present on the request path these two `/api/v1`-mounted defs actually see.
 * `event.locals.principal` with no `.user` is reserved for a narrow fallback
 * `mount.ts` documents for `/api/admin/*` Bearer callers that bypass
 * `forward-auth.ts` entirely (`tasks/api-auth.ts`'s `authenticate()`) — a
 * shape neither of these two defs is reachable through. Handling it anyway
 * costs nothing and keeps this helper honest for any future caller: a
 * `user`-less request gets `denyAllAccess()` rather than a silently
 * unfiltered boundary, exactly as `stats/me.ts` reasons for the same seam.
 */

import type postgres from 'postgres';
import type { UserContext } from '$lib/server/types.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { denyAllAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';

export async function resolveScopeGatedAccessBoundary(
    sql: postgres.Sql,
    user: UserContext | undefined,
): Promise<MediaAccessBoundary> {
    if (!user) return denyAllAccess();
    try {
        return searchAccessBoundary(await buildSearchAccessContext(sql, user));
    } catch {
        return denyAllAccess();
    }
}
