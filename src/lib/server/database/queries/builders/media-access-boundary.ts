// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media access boundary — the required-by-shape replacement for the old
 * permissive `{ deniedGroupIds: string[] | null; ageRating: ... | null }` pair.
 *
 * The old shape was permissive by default on both axes: `null` meant "filter
 * nothing", so *omitting* an access argument silently returned unfiltered rows,
 * and there was no way at all to express "this caller may see nothing" (the
 * unauthenticated context faked it with `maxAgeRating: -1`, which closes the
 * age axis and leaves the library axis wide open).
 *
 * Under the new shape both axes are required and every state is a named,
 * greppable variant — including the previously inexpressible `denyAll`.
 *
 * ## Why this module lives in `builders/`
 *
 * Both `builders/age-rating.builder.ts` / `builders/library-access.builder.ts`
 * and `utils/media-access-batch.ts` need these types. `utils/media-access-batch.ts`
 * already imports *from* `builders/`, so `builders/` is the lower layer. Defining
 * the boundary here keeps that single dependency direction; defining it next to
 * `media-access-batch.ts` would invert it and create an import cycle between the
 * boundary types and `AgeRatingFilterParams`. For the same reason
 * `AgeRatingFilterParams` is now defined here and re-exported from
 * `age-rating.builder.ts` for backwards compatibility.
 */

/**
 * Legacy age-filter parameters. Defined here (rather than in
 * `age-rating.builder.ts`) so the boundary types and the builders share one
 * dependency direction. Re-exported from `age-rating.builder.ts`.
 */
export interface AgeRatingFilterParams {
    maxAgeRating: number | null;
    allowUnrated: boolean;
}

/**
 * Library-group axis of an access boundary.
 *
 * - `all`        — caller may see every library group. Emits no SQL predicate.
 * - `denyGroups` — caller may not see the listed library groups. Emits the
 *                  existing correlated-subquery predicate.
 * - `denyAll`    — caller may see nothing. Emits `AND false`; callers that can
 *                  short-circuit should return an empty result before querying.
 */
export type LibraryScope =
    { kind: 'all' } | { kind: 'denyGroups'; ids: string[] } | { kind: 'denyAll' };

/**
 * Age-rating axis of an access boundary.
 *
 * - `any`     — no age restriction. Emits no SQL predicate.
 * - `limit`   — caller may see items at or below `maxAgeRating`, plus unrated
 *               items when `allowUnrated`. Emits the existing predicate.
 * - `denyAll` — caller may see nothing. Emits `AND false`.
 */
export type AgeScope =
    | { kind: 'any' }
    | { kind: 'limit'; maxAgeRating: number; allowUnrated: boolean }
    | { kind: 'denyAll' };

/**
 * A complete media access boundary. Both axes are REQUIRED — there is no
 * permissive default. A caller that genuinely wants unrestricted access must
 * say so explicitly via {@link unrestrictedAccess}, which makes every such
 * decision greppable.
 */
export interface MediaAccessBoundary {
    library: LibraryScope;
    age: AgeScope;
}

/**
 * Explicit unrestricted access — the caller may see everything on both axes.
 *
 * Prefer this over an implicit omission so that "this query is deliberately
 * unfiltered" is greppable rather than invisible.
 */
export function unrestrictedAccess(): MediaAccessBoundary {
    return { library: { kind: 'all' }, age: { kind: 'any' } };
}

/**
 * Explicit deny-everything access — the caller may see nothing on either axis.
 *
 * This state was inexpressible under the legacy shape. Consumers should
 * short-circuit to an empty result rather than relying on the `AND false`
 * predicate, both to skip the round trip and because several queries build
 * MATERIALIZED CTEs before the boundary predicate is applied.
 */
export function denyAllAccess(): MediaAccessBoundary {
    return { library: { kind: 'denyAll' }, age: { kind: 'denyAll' } };
}

/** Real per-user values used to build a restricted boundary. */
export interface RestrictedAccessInput {
    /** Library groups this user may not see. Empty means no library restriction. */
    deniedGroupIds: readonly string[];
    /** Highest age rating this user may see, or null for no age restriction. */
    maxAgeRating: number | null;
    /** Whether items with no age rating are visible under an age limit. */
    allowUnrated: boolean;
}

/**
 * Build a boundary from a restricted user's real values.
 *
 * An empty `deniedGroupIds` collapses to `{ kind: 'all' }` and a null
 * `maxAgeRating` collapses to `{ kind: 'any' }` — matching the legacy builders,
 * which emitted no predicate in exactly those cases.
 */
export function restrictedAccess(input: RestrictedAccessInput): MediaAccessBoundary {
    return {
        library:
            input.deniedGroupIds.length > 0
                ? { kind: 'denyGroups', ids: [...input.deniedGroupIds] }
                : { kind: 'all' },
        age:
            input.maxAgeRating === null
                ? { kind: 'any' }
                : {
                      kind: 'limit',
                      maxAgeRating: input.maxAgeRating,
                      allowUnrated: input.allowUnrated,
                  },
    };
}

/**
 * Whether a boundary denies everything on either axis. Consumers should
 * short-circuit to an empty result when this is true rather than issuing a
 * query whose predicate is `AND false`.
 */
export function deniesEverything(boundary: MediaAccessBoundary): boolean {
    return boundary.library.kind === 'denyAll' || boundary.age.kind === 'denyAll';
}

/**
 * Whether a boundary imposes no restriction at all on either axis — i.e. the
 * query can skip both predicates entirely. This is the scope-aware replacement
 * for the old `!deniedGroupIds && !ageRating` fast-path guard.
 */
export function isUnrestricted(boundary: MediaAccessBoundary): boolean {
    return boundary.library.kind === 'all' && boundary.age.kind === 'any';
}

/**
 * JS-side counterpart to {@link buildLibraryAccessFilter}'s library-group
 * predicate, for the handful of call sites that filter already-fetched rows in
 * TypeScript rather than in SQL.
 *
 * It exists so the two enforcement languages cannot drift: any surface that
 * decides library visibility in JS must route through here rather than
 * hand-rolling `new Set(deniedGroupIds).has(id)`, which is exactly the pattern
 * that silently became a no-op whenever the denied list arrived as null.
 *
 * Semantics deliberately mirror the SQL builder:
 * - `all`        -> visible
 * - `denyGroups` -> visible unless the row's group is in the denied list; a row
 *                   with NO library group is visible (matches the SQL builder's
 *                   `library_group_id IS NULL` branch)
 * - `denyAll` on EITHER axis -> never visible
 */
export function isLibraryGroupVisible(
    boundary: MediaAccessBoundary,
    libraryGroupId: string | null,
): boolean {
    if (deniesEverything(boundary)) return false;
    switch (boundary.library.kind) {
        case 'all':
            return true;
        case 'denyGroups':
            return libraryGroupId === null || !boundary.library.ids.includes(libraryGroupId);
        case 'denyAll':
            return false;
    }
}

/**
 * Deterministic cache-key component for a boundary.
 *
 * EVERY variant contributes a non-empty token — including `all` / `any`. That is
 * the point: the legacy `buildSearchAccessCacheKey` pushed nothing for an
 * unrestricted caller, so an unrestricted user's entry lived under a bare key,
 * which any degraded/unscoped code path could also write to. With a token per
 * variant, `denyAll`, `all` and `denyGroups` can never collide.
 *
 * Uses `|` and `:` as separators; callers must not embed the result inside
 * `scopedCacheKey`, which reserves `|`.
 */
export function boundaryCacheKey(boundary: MediaAccessBoundary): string {
    const library =
        boundary.library.kind === 'denyGroups'
            ? `deny:${[...boundary.library.ids].sort().join(',')}`
            : boundary.library.kind;
    const age =
        boundary.age.kind === 'limit'
            ? `age:${boundary.age.maxAgeRating}:${boundary.age.allowUnrated ? 'u' : 'r'}`
            : boundary.age.kind;
    return `${library}|${age}`;
}
