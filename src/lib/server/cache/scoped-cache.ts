// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ScopedCache — a cache view bound to one namespace AND one access scope.
 *
 * ## Why this exists
 *
 * A cache that stores **user-agnostic result lists** (trending, recommendations,
 * browse sections, search results, music shelves) must partition its keys by the
 * caller's access scope. If it does not, an entry warmed by a more-privileged
 * caller is served verbatim to a less-privileged one — a cross-user data leak
 * (exactly the trending cache-poisoning bug that forced the `trending-v19` bump).
 *
 * Today that coupling is enforced only by convention: the developer must remember
 * to compute an access token with one of four helpers (`scopedCacheKey`,
 * `browseScopedCacheKey`, `boundaryCacheKey`, `buildSearchAccessCacheKey`) and
 * feed it into a separate `.get()`/`.set()` call. Nothing links the two in the
 * type system — `cacheManager.for(ns).set('bare-key', list)` compiles and leaks.
 *
 * `ScopedCache` captures the access scope at construction and folds it into every
 * key internally. It deliberately exposes **no method that accepts a pre-formed
 * key** — a call site physically cannot store a list under a bare, unscoped key.
 *
 * ## Semantics-preserving
 *
 * The computed key string is byte-identical to what the raw helpers produce today
 * (this module delegates to `scopedCacheKey` / `browseScopedCacheKey` /
 * `boundaryCacheKey`). No key format changes, so migrating a call site requires
 * no cache-version bump and opens no leak window. TTLs, L1/L2 behaviour,
 * invalidation and the `CacheValue` contract are all inherited unchanged from the
 * underlying {@link UnifiedCache}.
 */

import { CacheManager, type UnifiedCache } from './unified-cache';
import { getOrComputeSingleFlight } from './single-flight';
import type { RegisteredCacheConfig } from './namespaces';
import {
    scopedCacheKey,
    browseScopedCacheKey,
    type SearchAccessContext,
} from '$lib/server/utils/search-access-context';
import {
    boundaryCacheKey,
    type MediaAccessBoundary,
} from '$lib/server/database/queries/builders/media-access-boundary';

/**
 * Mirror of the private `CacheValue` union in {@link UnifiedCache}. Kept in sync
 * structurally so `set` accepts exactly what the underlying cache stores.
 */
type CacheValue = string | number | boolean | object | null;

/**
 * The access scope a {@link ScopedCache} is bound to. Exactly one keying scheme.
 *
 * - `boundary` — surfaces keyed purely on a {@link MediaAccessBoundary}
 *   (library-scope + age-scope, with a token for every variant incl.
 *   `all`/`any`/`denyAll`).
 * - `search` — search/aggregation surfaces keyed on the full
 *   {@link SearchAccessContext} (locale + denied-groups + age + livetv +
 *   lib-only). An optional appended `boundary` covers the combined case where a
 *   surface needs *both* the search-context dimensions (locale/livetv/lib-only,
 *   which a boundary drops) *and* the boundary's `denyAll` distinction (which the
 *   context cannot express) — see `recently-added.strategy.ts`.
 * - `browse` — browse surfaces keyed on denied-groups + age only (no
 *   locale/livetv/lib-only).
 */
export type AccessScope =
    | { readonly kind: 'boundary'; readonly boundary: MediaAccessBoundary }
    | {
          readonly kind: 'search';
          readonly ctx: SearchAccessContext;
          readonly boundary?: MediaAccessBoundary;
      }
    | { readonly kind: 'browse'; readonly ctx: SearchAccessContext };

/** Optional overrides for {@link ScopedCache.getOrComputeSingleFlight}. */
export interface SingleFlightOverrides {
    /** TTL for the freshly computed value, in seconds. Defaults to the namespace L2 TTL. */
    ttlSeconds?: number;
}

/**
 * A cache view bound to one namespace AND one access scope. The scope is captured
 * at construction; every read/write folds it into the key. There is deliberately
 * NO method that accepts an already-formed key.
 *
 * Construct via the {@link boundedCache} / {@link searchScopedCache} /
 * {@link searchScopedCacheWithBoundary} / {@link browseScopedCache} factories —
 * they make the scope choice greppable and keep call sites terse.
 */
export class ScopedCache {
    /**
     * @param userId Optional user-scoping token. When present it is threaded to
     *   the underlying {@link UnifiedCache} on EVERY read/write (get/set/has/
     *   delete) and folded into the single-flight raw L2 key, mirroring
     *   `UnifiedCache.buildL2Key`'s `${namespace}:${userId}:${key}` layout. This
     *   models the `userId` param that surfaces like `new-episodes` rely on to
     *   partition per-user entries; without it a migrated call site collapses all
     *   users onto one shared physical key — the exact cross-user leak this
     *   module exists to prevent.
     */
    constructor(
        private readonly cache: UnifiedCache,
        private readonly ns: RegisteredCacheConfig,
        private readonly scope: AccessScope,
        private readonly userId?: string,
    ) {}

    /**
     * Full key for `(base, extras)` under the bound scope. Delegates to the raw
     * key helpers so the result is byte-identical to the pre-wrapper expression.
     */
    private keyFor(base: string, extras?: ReadonlyArray<string | number>): string {
        switch (this.scope.kind) {
            case 'search': {
                const searchKey = scopedCacheKey(base, this.scope.ctx, extras);
                // Combined case: append the boundary token for the `denyAll`
                // distinction the search context cannot express. Byte-identical
                // to `${scopedCacheKey(...)}|${boundaryCacheKey(...)}`.
                return this.scope.boundary
                    ? `${searchKey}|${boundaryCacheKey(this.scope.boundary)}`
                    : searchKey;
            }
            case 'browse':
                return browseScopedCacheKey(base, this.scope.ctx, extras);
            case 'boundary': {
                const extrasSuffix =
                    extras && extras.length > 0 ? ':' + extras.map((e) => String(e)).join(':') : '';
                // The two live pure-boundary call sites (new-episodes, rate/queue)
                // join the boundary token with a `:`, not a `|`:
                //   `new-episodes:v2:${boundaryCacheKey(access)}`
                //   `v2:${userId}:${sessionId}:${boundaryCacheKey(access)}`
                // Use `:` here so a migration is byte-identical (no version bump,
                // no cold-miss leak window). `boundaryCacheKey` itself still emits
                // its internal `|` (`all|any`), so keys stay unambiguous.
                return `${base}${extrasSuffix}:${boundaryCacheKey(this.scope.boundary)}`;
            }
        }
    }

    /** Read the access-scoped entry for `(base, extras)`. */
    async get<T = CacheValue>(
        base: string,
        extras?: ReadonlyArray<string | number>,
    ): Promise<T | null> {
        return this.cache.get<T>(this.keyFor(base, extras), this.userId);
    }

    /** Write `value` under the access-scoped key for `(base, extras)`. */
    async set(
        base: string,
        value: CacheValue,
        extras?: ReadonlyArray<string | number>,
    ): Promise<void> {
        await this.cache.set(this.keyFor(base, extras), value, undefined, this.userId);
    }

    /** Whether an access-scoped entry exists for `(base, extras)`. */
    async has(base: string, extras?: ReadonlyArray<string | number>): Promise<boolean> {
        return this.cache.has(this.keyFor(base, extras), this.userId);
    }

    /** Delete the access-scoped entry for `(base, extras)`. */
    async delete(base: string, extras?: ReadonlyArray<string | number>): Promise<void> {
        await this.cache.delete(this.keyFor(base, extras), this.userId);
    }

    /**
     * Single-flight compute: return the cached value, or compute-and-cache it
     * under a stampede-protecting lock so concurrent cold-cache misses run the
     * expensive `compute` once.
     *
     * Absorbs the raw-L2-key duplication that call sites hand-roll today
     * (`${ns.name}:${scopedKey}` — see `music/genres.ts`), because `buildL2Key`
     * is private on {@link UnifiedCache}. The value is serialized to a JSON
     * string for the single-flight substrate and parsed back on return; the
     * result is also promoted into L1 via the underlying cache so subsequent
     * in-process reads skip Valkey.
     */
    async getOrComputeSingleFlight<T>(
        base: string,
        extras: ReadonlyArray<string | number> | undefined,
        compute: () => Promise<T>,
        opts?: SingleFlightOverrides,
    ): Promise<T> {
        const key = this.keyFor(base, extras);

        const cached = await this.cache.get<T>(key, this.userId);
        if (cached !== null) return cached;

        // Mirror UnifiedCache.buildL2Key(key, userId): `${ns.name}:${userId}:${key}`
        // when user-scoped, else `${ns.name}:${key}`. Restated here because
        // buildL2Key is private. Dropping the userId segment would let two users
        // share one single-flight slot AND collide on the raw L2 key.
        const rawKey = this.userId
            ? `${this.ns.name}:${this.userId}:${key}`
            : `${this.ns.name}:${key}`;
        const ttlSeconds = opts?.ttlSeconds ?? Math.floor(this.ns.l2TTL / 1000);

        const jsonStr = await getOrComputeSingleFlight({
            cacheKey: rawKey,
            ttlSeconds,
            compute: async () => JSON.stringify(await compute()),
        });

        const value = JSON.parse(jsonStr) as T;
        // Populate L1 so subsequent in-process reads skip Valkey.
        void this.cache.set(key, value as CacheValue, undefined, this.userId);
        return value;
    }
}

/**
 * Construct a {@link ScopedCache} bound to a {@link MediaAccessBoundary}.
 *
 * Pass `userId` for surfaces whose entries are ALSO partitioned per user (e.g.
 * `new-episodes`, which called `cache.get(key, userId)` before migration). The
 * token is folded into every physical key exactly as {@link UnifiedCache} does,
 * so migrating such a site keeps its per-user partition instead of collapsing
 * all users onto one shared entry.
 */
export function boundedCache(
    ns: RegisteredCacheConfig,
    boundary: MediaAccessBoundary,
    userId?: string,
): ScopedCache {
    return new ScopedCache(
        CacheManager.getInstance().for(ns),
        ns,
        {
            kind: 'boundary',
            boundary,
        },
        userId,
    );
}

/** Construct a {@link ScopedCache} bound to a {@link SearchAccessContext}. */
export function searchScopedCache(
    ns: RegisteredCacheConfig,
    ctx: SearchAccessContext,
): ScopedCache {
    return new ScopedCache(CacheManager.getInstance().for(ns), ns, { kind: 'search', ctx });
}

/**
 * Construct a {@link ScopedCache} bound to a {@link SearchAccessContext} whose
 * key ALSO folds in a {@link MediaAccessBoundary}. Use for the combined case
 * where a surface needs both the search-context dimensions (locale/livetv/
 * lib-only) and the boundary's `denyAll` distinction.
 *
 * Pass `userId` for surfaces whose entries are ALSO partitioned per user (e.g.
 * `short-movies`, which called `cache.get(key, userId)` before migration). The
 * token is threaded into every physical key exactly as {@link UnifiedCache}
 * does, so migrating such a site keeps its per-user partition byte-identical
 * instead of collapsing all users onto one shared physical entry.
 */
export function searchScopedCacheWithBoundary(
    ns: RegisteredCacheConfig,
    ctx: SearchAccessContext,
    boundary: MediaAccessBoundary,
    userId?: string,
): ScopedCache {
    return new ScopedCache(
        CacheManager.getInstance().for(ns),
        ns,
        {
            kind: 'search',
            ctx,
            boundary,
        },
        userId,
    );
}

/** Construct a {@link ScopedCache} bound to a browse-surface access context. */
export function browseScopedCache(
    ns: RegisteredCacheConfig,
    ctx: SearchAccessContext,
): ScopedCache {
    return new ScopedCache(CacheManager.getInstance().for(ns), ns, { kind: 'browse', ctx });
}
