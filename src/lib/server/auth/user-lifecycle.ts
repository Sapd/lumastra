// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The ONE predicate for "is this `users` row still allowed to authenticate",
 * over the two lifecycle columns `disabled_at` (an admin kill-switch) and
 * `deleted_at` (soft-delete — see `users.queries.ts`'s `UserRow.deleted_at`
 * doc comment for why the column exists even though `deleteUser` is
 * currently a hard DELETE).
 *
 * Security review 2026-09-17, C17, review round 1 (Important 2): before this
 * module existed, the SAME two-column check —
 * `row.disabled_at === null && row.deleted_at === null` — was written out by
 * hand in THREE places that all resolve a token/impersonation-target row by
 * id rather than through the username-keyed `resolveTokenUserAccess()`
 * resolver (which has its own, already-shared, `TokenUserAccess.disabled`/
 * `.deleted` fields): `forward-auth.ts`'s `handleServiceTokenAuth`
 * impersonation branch, `tasks/api-auth.ts`'s `resolveServiceTokenIdentity`
 * impersonation branch, and `oauth/service-token.service.ts`'s
 * `isCreatorActive()`. A grep for a shared predicate at review time
 * (`isUserActive|isLifecycleActive|userIsActive|accountIsActive`) found
 * zero hits — three independent copies of one decision, the exact shape
 * this whole fix plan exists to close.
 *
 * Collapsing the QUERY that produces the row is a separate, harder problem
 * (id-keyed vs username-keyed lookups, different caching, a documented
 * null-groups semantic divergence — see `resolve-token-user-access.ts`'s
 * module doc and `forward-auth.ts`'s comment above `targetPinnedMaxAge`) and
 * is NOT what this module does. This is only the CHECK: a pure predicate
 * over two nullable timestamps, safe to share regardless of how the row
 * carrying them was fetched.
 */
export function isLifecycleActive(row: {
    disabled_at: Date | null;
    deleted_at: Date | null;
}): boolean {
    return row.disabled_at === null && row.deleted_at === null;
}
