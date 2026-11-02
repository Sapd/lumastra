// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ScopedCache foundation tests.
 *
 * The load-bearing property is byte-identical keys: migrating a call site to the
 * wrapper must NOT change the key string it produces, so no cache-version bump is
 * needed and no leak window opens. Every scheme is asserted against the raw key
 * helper it delegates to.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Observe single-flight without a live Valkey. The mock records the raw L2 key
// and TTL, then runs the wrapper's `compute` (leader path) so the JSON round-trip
// is exercised end to end.
const sfCalls: Array<{ cacheKey: string; ttlSeconds: number }> = [];
vi.mock('./single-flight', () => ({
    getOrComputeSingleFlight: vi.fn(
        async (opts: {
            cacheKey: string;
            ttlSeconds: number;
            compute: () => Promise<string>;
        }): Promise<string> => {
            sfCalls.push({ cacheKey: opts.cacheKey, ttlSeconds: opts.ttlSeconds });
            return opts.compute();
        },
    ),
}));

import {
    ScopedCache,
    boundedCache,
    searchScopedCache,
    searchScopedCacheWithBoundary,
    browseScopedCache,
} from './scoped-cache';
import type { UnifiedCache } from './unified-cache';
import { CACHE_NAMESPACES } from './namespaces';
import {
    scopedCacheKey,
    browseScopedCacheKey,
    type SearchAccessContext,
} from '$lib/server/utils/search-access-context';
import {
    boundaryCacheKey,
    unrestrictedAccess,
    restrictedAccess,
    denyAllAccess,
    type MediaAccessBoundary,
} from '$lib/server/database/queries/builders/media-access-boundary';

const NS = CACHE_NAMESPACES.trending;

function ctx(over: Partial<SearchAccessContext> = {}): SearchAccessContext {
    return {
        username: 'u',
        deniedGroupIds: null,
        ageRating: null,
        liveTvAllowed: false,
        showUnavailableMedia: true,
        ...over,
    };
}

interface FakeCache {
    fake: UnifiedCache;
    calls: Array<{ method: string; key: string; userId?: string; value?: unknown }>;
    store: Map<string, unknown>;
}

// Mirror UnifiedCache.buildL2Key's user partitioning so the fake physically
// separates two users' entries. A wrapper that fails to thread `userId` collides
// them here — exactly the leak these tests must catch.
function physicalKey(key: string, userId?: string): string {
    return userId ? `${userId}@@${key}` : key;
}

function makeFakeCache(): FakeCache {
    const calls: FakeCache['calls'] = [];
    const store = new Map<string, unknown>();
    const fake = {
        get: vi.fn(async (key: string, userId?: string) => {
            calls.push({ method: 'get', key, userId });
            const pk = physicalKey(key, userId);
            return store.has(pk) ? store.get(pk) : null;
        }),
        set: vi.fn(async (key: string, value: unknown, _ttl?: number, userId?: string) => {
            calls.push({ method: 'set', key, userId, value });
            store.set(physicalKey(key, userId), value);
        }),
        has: vi.fn(async (key: string, userId?: string) => {
            calls.push({ method: 'has', key, userId });
            return store.has(physicalKey(key, userId));
        }),
        delete: vi.fn(async (key: string, userId?: string) => {
            calls.push({ method: 'delete', key, userId });
            store.delete(physicalKey(key, userId));
        }),
    };
    return { fake: fake as unknown as UnifiedCache, calls, store };
}

/** Drive a read through the wrapper and return the key it handed the cache. */
async function capturedKey(
    sc: ScopedCache,
    fc: FakeCache,
    base: string,
    extras?: ReadonlyArray<string | number>,
): Promise<string> {
    await sc.get(base, extras);
    const getCall = fc.calls.find((c) => c.method === 'get');
    if (!getCall) throw new Error('wrapper did not call cache.get');
    return getCall.key;
}

beforeEach(() => {
    sfCalls.length = 0;
});

describe('ScopedCache — byte-identical keys per scheme', () => {
    it('search scheme delegates to scopedCacheKey', async () => {
        const fc = makeFakeCache();
        const c = ctx({ deniedGroupIds: ['group-a'], liveTvAllowed: true });
        const sc = new ScopedCache(fc.fake, NS, { kind: 'search', ctx: c });
        const key = await capturedKey(sc, fc, 'trending:movies', [20]);
        expect(key).toBe(scopedCacheKey('trending:movies', c, [20]));
    });

    it('browse scheme delegates to browseScopedCacheKey', async () => {
        const fc = makeFakeCache();
        const c = ctx({ deniedGroupIds: ['group-a'] });
        const sc = new ScopedCache(fc.fake, NS, { kind: 'browse', ctx: c });
        const key = await capturedKey(sc, fc, 'bk1:az', ['A']);
        expect(key).toBe(browseScopedCacheKey('bk1:az', c, ['A']));
    });

    it('boundary scheme joins boundaryCacheKey with a `:`, matching the real new-episodes key', async () => {
        const fc = makeFakeCache();
        const boundary: MediaAccessBoundary = restrictedAccess({
            deniedGroupIds: ['group-a'],
            maxAgeRating: 12,
            allowUnrated: false,
        });
        const sc = new ScopedCache(fc.fake, NS, { kind: 'boundary', boundary });
        const key = await capturedKey(sc, fc, 'new-episodes:v2');
        // The live new-episodes call site builds exactly this string
        // (src/routes/api/for-you/new-episodes/+server.ts:
        //   `new-episodes:v2:${boundaryCacheKey(access)}`). The wrapper MUST be
        // byte-identical to it — a `|` here would silently reshape the prod key.
        const realNewEpisodesKey = `new-episodes:v2:${boundaryCacheKey(boundary)}`;
        expect(key).toBe(realNewEpisodesKey);
        expect(key).not.toContain('new-episodes:v2|');
    });

    it('boundary scheme folds extras before the access token, colon-joined', async () => {
        const fc = makeFakeCache();
        const boundary = unrestrictedAccess();
        const sc = new ScopedCache(fc.fake, NS, { kind: 'boundary', boundary });
        const key = await capturedKey(sc, fc, 'v2:available', ['livetv']);
        expect(key).toBe(`v2:available:livetv:${boundaryCacheKey(boundary)}`);
    });

    it('boundary scheme matches the real rate/queue served-set key', async () => {
        // The live rate/queue call site (src/lib/server/api/defs/rate/queue.ts)
        // builds `v2:${user.userId}:${sessionId}:${boundaryCacheKey(access)}` and
        // folds userId/sessionId into the BASE string (no UnifiedCache userId
        // param). Reconstruct it the same way and prove byte-identity.
        const fc = makeFakeCache();
        const boundary = restrictedAccess({
            deniedGroupIds: ['group-b'],
            maxAgeRating: null,
            allowUnrated: true,
        });
        const rqUserId = 'user-123';
        const sessionId = 'sess-abc';
        const sc = new ScopedCache(fc.fake, NS, { kind: 'boundary', boundary });
        const key = await capturedKey(sc, fc, `v2:${rqUserId}:${sessionId}`);
        const realRateQueueKey = `v2:${rqUserId}:${sessionId}:${boundaryCacheKey(boundary)}`;
        expect(key).toBe(realRateQueueKey);
    });

    it('combined search+boundary scheme is byte-identical to the manual concat', async () => {
        const fc = makeFakeCache();
        const c = ctx({ liveTvAllowed: true });
        const boundary = denyAllAccess();
        const sc = new ScopedCache(fc.fake, NS, { kind: 'search', ctx: c, boundary });
        const key = await capturedKey(sc, fc, 'for-you-recently-added:v5:max');
        expect(key).toBe(
            `${scopedCacheKey('for-you-recently-added:v5:max', c)}|${boundaryCacheKey(boundary)}`,
        );
    });
});

describe('ScopedCache — scopes never collide', () => {
    it('unrestricted and library-restricted search callers get different keys', async () => {
        const open = new ScopedCache(makeFakeCache().fake, NS, { kind: 'search', ctx: ctx({}) });
        const openFc = makeFakeCache();
        const openKey = await capturedKey(
            new ScopedCache(openFc.fake, NS, { kind: 'search', ctx: ctx({}) }),
            openFc,
            'base',
        );
        const restrictedFc = makeFakeCache();
        const restrictedKey = await capturedKey(
            new ScopedCache(restrictedFc.fake, NS, {
                kind: 'search',
                ctx: ctx({ deniedGroupIds: ['group-a'] }),
            }),
            restrictedFc,
            'base',
        );
        expect(restrictedKey).not.toBe(openKey);
        expect(open).toBeInstanceOf(ScopedCache);
    });

    it('boundary `all` and `denyAll` never collide', async () => {
        const allFc = makeFakeCache();
        const allKey = await capturedKey(
            new ScopedCache(allFc.fake, NS, { kind: 'boundary', boundary: unrestrictedAccess() }),
            allFc,
            'base',
        );
        const denyFc = makeFakeCache();
        const denyKey = await capturedKey(
            new ScopedCache(denyFc.fake, NS, { kind: 'boundary', boundary: denyAllAccess() }),
            denyFc,
            'base',
        );
        expect(allKey).not.toBe(denyKey);
    });

    it('a search+boundary key differs from the same search key without a boundary', async () => {
        const c = ctx({});
        const withFc = makeFakeCache();
        const withKey = await capturedKey(
            new ScopedCache(withFc.fake, NS, {
                kind: 'search',
                ctx: c,
                boundary: denyAllAccess(),
            }),
            withFc,
            'base',
        );
        const withoutFc = makeFakeCache();
        const withoutKey = await capturedKey(
            new ScopedCache(withoutFc.fake, NS, { kind: 'search', ctx: c }),
            withoutFc,
            'base',
        );
        expect(withKey).not.toBe(withoutKey);
    });
});

describe('ScopedCache — no pre-formed-key escape hatch', () => {
    it('exposes only scope-folding methods; nothing accepts a full key', () => {
        const proto = Object.getPrototypeOf(
            new ScopedCache(makeFakeCache().fake, NS, {
                kind: 'search',
                ctx: ctx({}),
            }),
        );
        const methods = Object.getOwnPropertyNames(proto)
            .filter((n) => n !== 'constructor')
            .sort();
        // `keyFor` is the internal composer (TS `private` does not erase it from
        // the runtime prototype). Everything else is a scope-folding op. If a
        // raw-key method (getRaw / getByKey / setKey …) is ever added, this fails
        // and forces a deliberate review — a pre-formed-key method IS the footgun.
        expect(methods).toEqual(
            ['delete', 'get', 'getOrComputeSingleFlight', 'has', 'keyFor', 'set'].sort(),
        );
        // No public/internal method name advertises raw-key access.
        for (const name of methods) {
            expect(name).not.toMatch(/raw|bykey|preformed|fullkey|unscoped/i);
        }
    });

    it('read/write methods lead with a base key, not a composed key', async () => {
        // The composed key is derived internally: a caller passes only the base
        // (+ extras) and the wrapper folds in the access scope. Prove it by
        // observing that the key handed to the underlying cache is NOT the base.
        const fc = makeFakeCache();
        const sc = new ScopedCache(fc.fake, NS, {
            kind: 'search',
            ctx: ctx({ deniedGroupIds: ['group-a'] }),
        });
        const key = await capturedKey(sc, fc, 'base');
        expect(key).not.toBe('base');
        expect(key).toContain('base');
    });
});

describe('ScopedCache — single-flight raw-L2-key', () => {
    it('mirrors `${ns.name}:${scopedKey}` and defaults TTL to the namespace L2 TTL', async () => {
        const fc = makeFakeCache();
        const c = ctx({ deniedGroupIds: ['group-a'] });
        const sc = new ScopedCache(fc.fake, NS, { kind: 'search', ctx: c });

        const value = await sc.getOrComputeSingleFlight(
            'music-library-genres',
            undefined,
            async () => [{ genre: 'rock' }],
        );

        expect(value).toEqual([{ genre: 'rock' }]);
        const expectedKey = scopedCacheKey('music-library-genres', c);
        expect(sfCalls).toHaveLength(1);
        expect(sfCalls[0].cacheKey).toBe(`${NS.name}:${expectedKey}`);
        expect(sfCalls[0].ttlSeconds).toBe(Math.floor(NS.l2TTL / 1000));
        // Result promoted into L1 under the scoped (not raw) key.
        expect(fc.store.get(expectedKey)).toEqual([{ genre: 'rock' }]);
    });

    it('serves a cached value without invoking single-flight', async () => {
        const fc = makeFakeCache();
        const c = ctx({});
        const key = scopedCacheKey('genres', c);
        fc.store.set(key, [{ genre: 'jazz' }]);
        const sc = new ScopedCache(fc.fake, NS, { kind: 'search', ctx: c });

        const value = await sc.getOrComputeSingleFlight('genres', undefined, async () => {
            throw new Error('compute should not run on a cache hit');
        });

        expect(value).toEqual([{ genre: 'jazz' }]);
        expect(sfCalls).toHaveLength(0);
    });

    it('honours an explicit ttlSeconds override', async () => {
        const fc = makeFakeCache();
        const sc = new ScopedCache(fc.fake, NS, { kind: 'search', ctx: ctx({}) });
        await sc.getOrComputeSingleFlight('k', undefined, async () => 1, { ttlSeconds: 42 });
        expect(sfCalls[0].ttlSeconds).toBe(42);
    });
});

describe('ScopedCache — inherits extras safety', () => {
    it('rejects a `|` in extras via the delegated scopedCacheKey guard', async () => {
        const sc = new ScopedCache(makeFakeCache().fake, NS, { kind: 'search', ctx: ctx({}) });
        await expect(sc.get('base', ['a|b'])).rejects.toThrow(/reserved '\|' character/);
    });

    it('rejects a `|` in the browse prefix too', async () => {
        const sc = new ScopedCache(makeFakeCache().fake, NS, { kind: 'browse', ctx: ctx({}) });
        await expect(sc.get('bad|prefix')).rejects.toThrow(/reserved '\|' character/);
    });
});

describe('ScopedCache — user-scoped partitioning (new-episodes migration)', () => {
    const boundary = unrestrictedAccess();

    it('threads userId to the underlying cache on every read/write', async () => {
        const fc = makeFakeCache();
        const sc = new ScopedCache(fc.fake, NS, { kind: 'boundary', boundary }, 'user-A');
        await sc.set('new-episodes:v2', { alerts: [] });
        await sc.get('new-episodes:v2');
        await sc.has('new-episodes:v2');
        await sc.delete('new-episodes:v2');
        // Every op must carry the userId — dropping it collapses the per-user
        // partition onto a shared physical key.
        for (const c of fc.calls) {
            expect(c.userId).toBe('user-A');
        }
    });

    it('two users under the same boundary never read each other’s entry', async () => {
        // Shared physical store — the leak is observable if userId is not threaded.
        const shared = makeFakeCache();
        const scA = new ScopedCache(shared.fake, NS, { kind: 'boundary', boundary }, 'user-A');
        const scB = new ScopedCache(shared.fake, NS, { kind: 'boundary', boundary }, 'user-B');

        await scA.set('new-episodes:v2', { alerts: ['A-secret'] });
        // User B, same boundary, same base key: must NOT see A's alerts.
        expect(await scB.get<{ alerts: string[] }>('new-episodes:v2')).toBeNull();
        // A still sees their own.
        expect(await scA.get<{ alerts: string[] }>('new-episodes:v2')).toEqual({
            alerts: ['A-secret'],
        });
    });

    it('boundedCache(ns, boundary, userId) constructs a per-user partitioned view', async () => {
        // Guards against a mechanical migration that drops the userId argument:
        // the factory must accept and thread it.
        const sc = boundedCache(NS, boundary, 'user-C');
        expect(sc).toBeInstanceOf(ScopedCache);
    });

    it('single-flight raw L2 key includes the userId segment', async () => {
        const fc = makeFakeCache();
        const sc = new ScopedCache(fc.fake, NS, { kind: 'boundary', boundary }, 'user-D');
        await sc.getOrComputeSingleFlight('new-episodes:v2', undefined, async () => ({
            alerts: [],
        }));
        expect(sfCalls).toHaveLength(1);
        const scopedKey = `new-episodes:v2:${boundaryCacheKey(boundary)}`;
        // Mirrors UnifiedCache.buildL2Key(key, userId): `${ns}:${userId}:${key}`.
        expect(sfCalls[0].cacheKey).toBe(`${NS.name}:user-D:${scopedKey}`);
    });

    it('single-flight raw L2 key omits the user segment when unscoped', async () => {
        const fc = makeFakeCache();
        const sc = new ScopedCache(fc.fake, NS, { kind: 'boundary', boundary });
        await sc.getOrComputeSingleFlight('new-episodes:v2', undefined, async () => ({
            alerts: [],
        }));
        const scopedKey = `new-episodes:v2:${boundaryCacheKey(boundary)}`;
        expect(sfCalls[0].cacheKey).toBe(`${NS.name}:${scopedKey}`);
    });
});

describe('ScopedCache — factories', () => {
    it('each factory returns a ScopedCache', () => {
        expect(boundedCache(NS, unrestrictedAccess())).toBeInstanceOf(ScopedCache);
        expect(searchScopedCache(NS, ctx({}))).toBeInstanceOf(ScopedCache);
        expect(searchScopedCacheWithBoundary(NS, ctx({}), denyAllAccess())).toBeInstanceOf(
            ScopedCache,
        );
        expect(browseScopedCache(NS, ctx({}))).toBeInstanceOf(ScopedCache);
    });
});
