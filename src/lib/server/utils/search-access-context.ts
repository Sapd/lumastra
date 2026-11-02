// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Search Access Context
 *
 * Bundles every access boundary a search helper needs into a single object so
 * the contract is required-by-shape rather than optional-by-convention.
 * Optional `deniedGroupIds` on each helper was the footgun: a new call site
 * could compile while omitting it. With this shape, every helper that accepts
 * a `SearchAccessContext` is guaranteed to see all four fields.
 *
 * Build it once per request via {@link buildSearchAccessContext} and pass it
 * to every search branch (DB, aggregation service, music, episodes, etc.).
 *
 * Fields:
 * - `deniedGroupIds`: library-group ids the user is denied access to. null
 *   means no library filter (admin or unrestricted user).
 * - `ageRating`: { maxAgeRating, allowUnrated } filter. null means no age
 *   filter (admin or unrestricted user).
 * - `liveTvAllowed`: whether the user has `hasLiveTvPermission`. Used to
 *   gate the Live TV aggregation branch (channel enumeration) and is part
 *   of the aggregation cache key.
 * - `username`: convenience copy of locals.user.username; used by helpers
 *   that read user-scoped state (watched flags, ratings) during search.
 */

import type { Sql } from 'postgres';
import { config, isUnavailableMediaVisible } from '$lib/server/config';
import { getLocale } from '$lib/paraglide/runtime.js';
import { type AgeRatingFilterParams } from '$lib/server/database/queries/builders/age-rating.builder';
import { restrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary';
import {
    getDeniedLibraryGroups,
    toLibraryAccessUser,
} from '$lib/server/cache/library-group-permissions-cache';
import type { UserContext } from '$lib/server/types';

export interface SearchAccessContext {
    /** Username, or null for unauthenticated callers. */
    username: string | null;
    /** Library groups the user cannot access; null when unrestricted. */
    deniedGroupIds: string[] | null;
    /** Age-rating filter; null when the user is not age-restricted. */
    ageRating: AgeRatingFilterParams | null;
    /** Whether the user may see Live TV results. */
    liveTvAllowed: boolean;
    /**
     * Global flag: when false, discovery surfaces (Trending, For You, Search)
     * must restrict results to items with has_files = true (library-only).
     * Sourced from isUnavailableMediaVisible() — the SHOW_UNAVAILABLE_MEDIA
     * toggle AND'd with a configured request path (un-requestable ghosts are
     * dead ends); read per-request, no restart.
     *
     * NOTE: /browse is NOT a discovery surface — it is always library-local
     * (has_files = true) regardless of this flag. Its keyword and A-Z sections
     * deliberately ignore showUnavailableMedia. Do not re-couple them.
     */
    showUnavailableMedia: boolean;
}

/**
 * Build a SearchAccessContext for the given user. Cheap to call: the
 * library-perms lookup is L1-cached, the rest is field reads. Safe to call
 * on every search request.
 *
 * `user` is required. The earlier signature accepted `UserContext | undefined`
 * and returned a fully permissive context for an undefined caller, which made
 * it look safe to call from routes that hadn't ensured authentication. Make
 * callers pass a UserContext explicitly. If a route lacks auth upstream,
 * either gate it with requireAuth, or construct an explicit unauthenticated
 * context via {@link unauthenticatedSearchAccessContext} so the closed-by-
 * default behaviour is visible at the call site.
 */
export async function buildSearchAccessContext(
    sql: Sql,
    user: UserContext,
): Promise<SearchAccessContext> {
    const accessUser = toLibraryAccessUser(user);
    const deniedGroupIds = accessUser ? await getDeniedLibraryGroups(sql, accessUser) : null;
    const ageRating: AgeRatingFilterParams | null =
        user.maxAgeRating != null
            ? {
                  maxAgeRating: user.maxAgeRating,
                  allowUnrated: config.UNRATED_CONTENT_VISIBLE,
              }
            : null;
    return {
        username: user.username,
        deniedGroupIds,
        ageRating,
        liveTvAllowed: user.hasLiveTvPermission,
        showUnavailableMedia: isUnavailableMediaVisible(),
    };
}

/**
 * Closed-by-default context for routes that genuinely have no user.
 * `deniedGroupIds: null` applies NO library-group filtering (buildLibraryAccessFilter
 * treats null the same as an empty list — neither denies anything); the closure comes
 * entirely from the age policy (maxAgeRating = -1, allowUnrated = false, satisfied by
 * no real row) plus liveTvAllowed = false. Any caller that relies on this context for
 * library-group isolation alone, without also applying the age filter, gets no
 * isolation — always apply both together. Use only on routes that truly serve
 * unauthenticated callers; prefer requireAuth + buildSearchAccessContext
 * everywhere else.
 */
export function unauthenticatedSearchAccessContext(): SearchAccessContext {
    return {
        username: null,
        // null → buildLibraryAccessFilter emits no library-group filter at all
        // (same as []). Closure relies on the age gate below, not on this field.
        deniedGroupIds: null,
        ageRating: { maxAgeRating: -1, allowUnrated: false },
        liveTvAllowed: false,
        // Unauthenticated callers never see file-less discovery items — closed by default.
        showUnavailableMedia: false,
    };
}

/**
 * Project a {@link SearchAccessContext} onto the required-by-shape
 * {@link MediaAccessBoundary} that migrated query modules and services take.
 *
 * Use this instead of hand-passing `ctx.deniedGroupIds` / `ctx.ageRating` as a
 * pair — that pattern is the argument-order footgun the boundary type exists to
 * remove (several functions took them in opposite orders, and both were
 * `X | null | undefined`, so a swap type-checked silently and produced
 * unfiltered rows).
 *
 * Implemented via `restrictedAccess` (constructing the boundary directly from
 * the context's real values) rather than re-deriving from the user, so the
 * mapping is byte-identical to what the context already encoded. In particular
 * `unauthenticatedSearchAccessContext()`'s `maxAgeRating: -1` keeps mapping to
 * `age: limit(-1)` and NOT to `denyAll`: promoting it would also close the
 * library axis, which would change which rows that context returns. Closing
 * that gap properly is a follow-up, not a side effect of this mapping.
 */
export function searchAccessBoundary(ctx: SearchAccessContext): MediaAccessBoundary {
    return restrictedAccess({
        deniedGroupIds: ctx.deniedGroupIds ?? [],
        maxAgeRating: ctx.ageRating?.maxAgeRating ?? null,
        allowUnrated: ctx.ageRating?.allowUnrated ?? false,
    });
}

/**
 * Build a deterministic cache-key suffix for the access context so search
 * caches (which serve user-agnostic result lists) still partition by access
 * scope. Two callers with different denied groups, age limits, or Live TV
 * permission must never share a cache entry.
 */
export function buildSearchAccessCacheKey(ctx: SearchAccessContext): string {
    const parts: string[] = [];
    if (ctx.deniedGroupIds && ctx.deniedGroupIds.length > 0) {
        parts.push(`denied:${[...ctx.deniedGroupIds].sort().join(',')}`);
    }
    if (ctx.ageRating && ctx.ageRating.maxAgeRating !== null) {
        parts.push(`age:${ctx.ageRating.maxAgeRating}:${ctx.ageRating.allowUnrated ? 'u' : 'r'}`);
    }
    if (ctx.liveTvAllowed) parts.push('livetv');
    if (!ctx.showUnavailableMedia) parts.push('lib-only');
    return parts.join('|');
}

/**
 * Build a full access-scoped cache key by prefixing the base key with the
 * standardized access-scope suffix. This is the canonical helper for every
 * user-facing cache namespace that holds media data. Replaces the hand-
 * built `:denied:X:age:Y` patterns that drifted in separator/order between
 * call sites and risked sharing entries across users with different access.
 *
 * The suffix is empty for unrestricted callers, so unrestricted users share
 * a single entry per namespace + extras. Restricted callers partition by
 * their {deniedGroupIds, ageRating, liveTvAllowed} tuple.
 *
 * @example
 *   const key = scopedCacheKey('v2:binge-worthy:user', ctx);
 *   const vkey = scopedCacheKey('mood-rec', ctx, [userId, mood]);
 */
export function scopedCacheKey(
    prefix: string,
    ctx: SearchAccessContext,
    extras?: ReadonlyArray<string | number>,
): string {
    // `|` separates the access suffix from the prefix+extras, and `:` is
    // used inside extras. Either character appearing in a caller-supplied
    // value would collapse two distinct intents to the same key, which
    // could mix data across users. Reject loudly rather than corrupt.
    assertSafeKeyComponent('prefix', prefix);
    if (extras) {
        for (const e of extras) assertSafeKeyComponent('extras', String(e));
    }
    const accessSuffix = buildSearchAccessCacheKey(ctx);
    const extrasSuffix =
        extras && extras.length > 0 ? ':' + extras.map((e) => String(e)).join(':') : '';
    // Locale dimension. Cached payloads embed already-localized text — section
    // titles are built per-request with paraglide `m.*()` and then stored whole
    // (title included) in these caches. Without locale in the key, the first
    // request to warm an entry freezes its language for users of *every* locale
    // until the TTL expires (e.g. an English-cookie request poisons the German
    // section titles). Folding the locale in here fixes every scoped cache at
    // once and never weakens access isolation: the access suffix is untouched,
    // so this only ever splits keys further, never merges two users' entries.
    // `getLocale()` reads the request's locale from paraglide's server async
    // storage; outside a request it falls back to the base locale (no throw).
    const localePrefix = `${getLocale()}:`;
    const body = `${localePrefix}${prefix}${extrasSuffix}`;
    return accessSuffix ? `${body}|${accessSuffix}` : body;
}

function assertSafeKeyComponent(field: string, value: string): void {
    if (value.includes('|')) {
        throw new Error(`scopedCacheKey: ${field} contains reserved '|' character: ${value}`);
    }
}

/**
 * Access-suffix for surfaces whose output depends ONLY on library-group and
 * age-rating access — i.e. the two filters /browse actually applies in SQL
 * (`buildLibraryAccessFilter` + `buildAgeRatingFilter`).
 *
 * Deliberately omits the `livetv` and `lib-only` (showUnavailableMedia)
 * dimensions that {@link buildSearchAccessCacheKey} carries for the
 * aggregation/search surfaces. /browse never enumerates Live TV channels and
 * is always library-local regardless of SHOW_UNAVAILABLE_MEDIA, so those
 * dimensions don't change a single browse row. Including them would:
 *   1. fragment the cache (a livetv user and a non-livetv user would get two
 *      byte-identical copies), and
 *   2. break cache warming — the warmer runs without Live TV permission, so a
 *      warmed entry keyed with the full suffix is never read by real users
 *      (who carry `|livetv`).
 *
 * Returns '' for unrestricted callers, so they all share one entry per
 * namespace and the warmer's unrestricted context produces the same key.
 */
export function browseAccessSuffix(ctx: SearchAccessContext): string {
    const parts: string[] = [];
    if (ctx.deniedGroupIds && ctx.deniedGroupIds.length > 0) {
        parts.push(`denied:${[...ctx.deniedGroupIds].sort().join(',')}`);
    }
    if (ctx.ageRating && ctx.ageRating.maxAgeRating !== null) {
        parts.push(`age:${ctx.ageRating.maxAgeRating}:${ctx.ageRating.allowUnrated ? 'u' : 'r'}`);
    }
    return parts.join('|');
}

/**
 * Browse-surface variant of {@link scopedCacheKey}: keys on library-group +
 * age access only (see {@link browseAccessSuffix}) and — unlike scopedCacheKey
 * — omits the locale prefix. Browse payloads are raw media data (titles,
 * posters, years, provider-sourced genre names); they embed no per-request
 * paraglide strings, so a German and an English user can safely share the same
 * entry. Dropping locale + livetv + lib-only collapses the unrestricted case to
 * a single bare key per namespace, which is exactly what the cache warmer can
 * (and now does) write.
 */
export function browseScopedCacheKey(
    prefix: string,
    ctx: SearchAccessContext,
    extras?: ReadonlyArray<string | number>,
): string {
    assertSafeKeyComponent('prefix', prefix);
    if (extras) {
        for (const e of extras) assertSafeKeyComponent('extras', String(e));
    }
    const accessSuffix = browseAccessSuffix(ctx);
    const extrasSuffix =
        extras && extras.length > 0 ? ':' + extras.map((e) => String(e)).join(':') : '';
    const body = `${prefix}${extrasSuffix}`;
    return accessSuffix ? `${body}|${accessSuffix}` : body;
}
