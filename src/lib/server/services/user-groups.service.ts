// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Canonical group-write wrapper for `users.groups`.
 *
 * Security review 5 (C4 + the Shape C root, 2026-09-23): `upsertUserGroups`
 * (`oauth-admin.queries.ts`) is a pure query — by the repo's three-tier rule
 * it must stay that way — but all four of its production callers
 * (`forward-auth.ts`'s `syncUserGroupsIfNeeded`, `oidc.service.ts`'s
 * `syncUserOnLogin`, `routes/api/oauth/authorize/+server.ts`'s device-auth
 * approval, and `user-identity.service.ts`'s `provisionUserWithIdentity`)
 * wrote the row directly and never invalidated `user-admin-cache.ts` /
 * `user-max-age-cache.ts`. Every reader of those caches (forward-auth's own
 * session path, the `/j` session and PAT paths, the play-token and Live TV
 * paths, `resolveTokenUserAccess`) therefore served up to a 10-minute-stale
 * `groups` value after an IdP group change, admin-group promotion, or
 * age-group change landed. `resolveTokenUserAccess`'s `{ freshGroups: true }`
 * flag (`pat-auth.ts`, `token-identity.ts`) papers over exactly the readers
 * that remembered to pass it; this wrapper closes the gap at the write
 * instead, per the 2026-09-16 controller's own long-term note ("thread
 * pat.service's already-fresh row into the resolver" /
 * `2026-09-16-fix-plan-3-artifacts/ledger.md:186`'s "nothing stops a future
 * always-fresh caller from forgetting it").
 *
 * `syncUserGroups` is the sanctioned way to call `upsertUserGroups` for the
 * three non-transactional writers — enforced by the `no-restricted-imports`
 * rule in `eslint.config.cjs` banning a direct import of `upsertUserGroups`
 * from `oauth-admin.queries.ts` or the `queries/index.ts` barrel everywhere
 * except this file and `user-identity.service.ts` (which writes inside a
 * transaction and must invalidate only AFTER it commits — see
 * `invalidateGroupDerivedCaches` below).
 */

import type postgres from 'postgres';
import { upsertUserGroups } from '$lib/server/database/queries/oauth-admin.queries.js';
import { invalidateUserAdminCache } from '$lib/server/cache/user-admin-cache.js';
import { invalidateUserMaxAgeCache } from '$lib/server/cache/user-max-age-cache.js';

/**
 * Drop the admin/disabled/deleted/userId/groups cache entry AND the max-age
 * cache entry for `username` after a group write. Age is group-derived for
 * an unpinned owner (`AGE_RATING_GROUP_PREFIX` groups feed
 * `buildUserPermissions`'s `maxAgeRating`), so a groups change can change the
 * effective age cap too — both caches must drop together, or a reader could
 * observe fresh groups paired with a max-age value computed from the old
 * ones until the max-age TTL separately expires.
 *
 * Exported separately (not only reachable via {@link syncUserGroups}) so the
 * one transactional caller — `user-identity.service.ts`'s
 * `provisionUserWithIdentity` — can invalidate AFTER its `withTx` commits
 * instead of inside it. It still calls `upsertUserGroups` directly (not this
 * wrapper) because the pure query must run against the transaction's client;
 * invalidating before commit would drop the cache for a row that may still
 * roll back, and (harmlessly but pointlessly) races a concurrent reader
 * against a write that is not yet visible to it.
 *
 * `invalidateUserAdminCache` / `invalidateUserMaxAgeCache` are documented as
 * taking the username verbatim under the convention that cache keys are
 * canonical lowercase — `oauth-admin.queries.ts`'s own `upsertUserGroups`
 * lowercases before writing the row. This function folds the case itself
 * rather than trusting every caller to already have.
 */
export function invalidateGroupDerivedCaches(username: string): void {
    const usernameLower = username.toLowerCase();
    invalidateUserAdminCache(usernameLower);
    invalidateUserMaxAgeCache(usernameLower);
}

/**
 * Write `users.groups` and invalidate the caches it feeds, in one call. The
 * three non-transactional writers (`forward-auth.ts`, `oidc.service.ts`,
 * `routes/api/oauth/authorize/+server.ts`) call this instead of
 * `upsertUserGroups` directly, so no future caller can repeat the C4/Shape C
 * mistake of writing the row without invalidating the caches it feeds.
 */
export async function syncUserGroups(
    sql: postgres.Sql,
    username: string,
    groups: string[],
): Promise<void> {
    await upsertUserGroups(sql, username, groups);
    invalidateGroupDerivedCaches(username);
}
