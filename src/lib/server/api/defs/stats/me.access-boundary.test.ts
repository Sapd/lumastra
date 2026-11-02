// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Differential access-boundary tests for GET /api/v1/me/stats.
 *
 * me.ts issues no SQL of its own. Everything it can get wrong is *plumbing*:
 * which boundary it constructs, whether that boundary actually reaches
 * `computeOneStat`, and whether the cache key partitions by it. Those are
 * exactly the failure modes a type check cannot catch (and this repo has no
 * working typecheck gate), so they are pinned behaviourally here.
 *
 * The harness runs the real handler against a stubbed `personalStatsService`
 * whose `getTopTitles` genuinely APPLIES the boundary it is handed to a fixed
 * fixture, via the same `isLibraryGroupVisible` helper the SQL builder mirrors.
 * That is what makes the assertions load-bearing: an argument that arrives but
 * is never used, or a boundary silently replaced by a permissive default, both
 * show up as a non-subset result rather than as a passing test.
 *
 * `buildSearchAccessContext` / `searchAccessBoundary` are the REAL ones — only
 * the library-group permissions lookup underneath them is stubbed — so the
 * SearchAccessContext -> MediaAccessBoundary adapter is under test too.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toUserId } from '$lib/shared/user-id.js';
import type { StatsPeriod, TopTitlesStats } from '$lib/schemas/personal-stats-types.js';
import {
    isLibraryGroupVisible,
    unrestrictedAccess,
} from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';

const ALICE = toUserId('a1ce0000-0000-4000-a000-000000000000');
const KIDS_GROUP = '11111111-1111-4111-8111-111111111111';
const ADULT_GROUP = '22222222-2222-4222-8222-222222222222';

// ---------------------------------------------------------------------------
// Fixture: four titles spanning both axes independently.
// ---------------------------------------------------------------------------

interface FixtureTitle {
    internalId: string;
    title: string;
    mediaType: 'movie' | 'tv';
    watchCount: number;
    totalWatchSeconds: number;
    libraryGroupId: string;
    ageRating: number | null;
}

const FIXTURE: FixtureTitle[] = [
    {
        internalId: '00000000-0000-4000-a000-00000000000a',
        title: 'Kids Movie',
        mediaType: 'movie',
        watchCount: 5,
        totalWatchSeconds: 100,
        libraryGroupId: KIDS_GROUP,
        ageRating: 6,
    },
    {
        internalId: '00000000-0000-4000-a000-00000000000b',
        title: 'Adult Movie',
        mediaType: 'movie',
        watchCount: 4,
        totalWatchSeconds: 200,
        libraryGroupId: ADULT_GROUP,
        ageRating: 6,
    },
    {
        internalId: '00000000-0000-4000-a000-00000000000c',
        title: 'Kids Show',
        mediaType: 'tv',
        watchCount: 3,
        totalWatchSeconds: 300,
        libraryGroupId: KIDS_GROUP,
        ageRating: 18,
    },
    {
        internalId: '00000000-0000-4000-a000-00000000000d',
        title: 'Unrated Show',
        mediaType: 'tv',
        watchCount: 2,
        totalWatchSeconds: 400,
        libraryGroupId: KIDS_GROUP,
        ageRating: null,
    },
];

/**
 * JS mirror of the age predicate `filterAccessibleMediaIds` emits:
 * a row passes if it is unrated AND unrated items are allowed, or if its
 * rating is at or below the limit.
 */
function ageVisible(boundary: MediaAccessBoundary, ageRating: number | null): boolean {
    switch (boundary.age.kind) {
        case 'any':
            return true;
        case 'denyAll':
            return false;
        case 'limit':
            return ageRating === null
                ? boundary.age.allowUnrated
                : ageRating <= boundary.age.maxAgeRating;
    }
}

function applyBoundary(boundary: MediaAccessBoundary): TopTitlesStats {
    const visible = FIXTURE.filter(
        (t) =>
            isLibraryGroupVisible(boundary, t.libraryGroupId) && ageVisible(boundary, t.ageRating),
    );
    const toItem = (t: FixtureTitle) => ({
        internalId: t.internalId,
        title: t.title,
        mediaType: t.mediaType === 'tv' ? ('series' as const) : ('movie' as const),
        watchCount: t.watchCount,
        totalWatchSeconds: t.totalWatchSeconds,
    });
    return {
        movies: visible.filter((t) => t.mediaType === 'movie').map(toItem),
        shows: visible.filter((t) => t.mediaType === 'tv').map(toItem),
    };
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('$lib/server/config.js', () => ({
    features: { personalStats: true },
    config: { UNRATED_CONTENT_VISIBLE: false },
    isUnavailableMediaVisible: () => true,
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn(() => ({}) as unknown),
}));

vi.mock('$lib/server/cache/library-group-permissions-cache.js', async () => {
    const actual = await vi.importActual<
        typeof import('$lib/server/cache/library-group-permissions-cache.js')
    >('$lib/server/cache/library-group-permissions-cache.js');
    return { ...actual, getDeniedLibraryGroups: vi.fn() };
});

// The real adapter chain, with buildSearchAccessContext wrapped in a spy so a
// test can assert it is never ENTERED without a user. Both exports keep their
// real behaviour.
vi.mock('$lib/server/utils/search-access-context.js', async () => {
    const actual = await vi.importActual<
        typeof import('$lib/server/utils/search-access-context.js')
    >('$lib/server/utils/search-access-context.js');
    return { ...actual, buildSearchAccessContext: vi.fn(actual.buildSearchAccessContext) };
});

vi.mock('$lib/server/cache/index.js', () => ({
    CACHE_NAMESPACES: { personalStats: 'personalStats' },
    cacheManager: { for: vi.fn() },
    buildVersionedCacheKey: (version: string, ...parts: (string | number)[]): string =>
        `${version}:${parts.join(':')}`,
}));

vi.mock('$lib/server/services/personal-stats.service.js', async () => {
    const actual = await vi.importActual<
        typeof import('$lib/server/services/personal-stats.service.js')
    >('$lib/server/services/personal-stats.service.js');
    return {
        // accessFingerprint is the REAL one — the cache-partitioning assertions
        // are worthless against a stub of the very function under scrutiny.
        accessFingerprint: actual.accessFingerprint,
        personalStatsService: {
            getSessionCount: vi.fn(async () => 100),
            getTopTitles: vi.fn(),
            getCompletionStats: vi.fn(async () => ({})),
            getFunRecords: vi.fn(async () => ({})),
            getOverviewStats: vi.fn(async () => ({
                totalWatchTimeSeconds: 90,
                totalWatchTimeFormatted: '1m',
                totalSessions: 1,
                uniqueContent: 1,
                completedCount: 1,
                abandonedCount: 0,
                avgCompletionPercentage: 100,
                moviesWatched: 1,
                episodesWatched: 0,
            })),
        },
    };
});

import { def } from './me.js';
import { getDb } from '$lib/server/database/connection.js';
import { getDeniedLibraryGroups } from '$lib/server/cache/library-group-permissions-cache.js';
import { buildSearchAccessContext } from '$lib/server/utils/search-access-context.js';
import { cacheManager } from '$lib/server/cache/index.js';
import { personalStatsService } from '$lib/server/services/personal-stats.service.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface UserSpec {
    isAdmin?: boolean;
    maxAgeRating?: number | null;
    userGroups?: string[];
}

function makeUser(spec: UserSpec = {}): Record<string, unknown> {
    return {
        userId: ALICE,
        username: 'alice',
        groups: '',
        userGroups: spec.userGroups ?? [],
        hasWatchPermission: true,
        hasLiveTvPermission: true,
        hasRequestPermission: false,
        isAdmin: spec.isAdmin ?? false,
        maxAgeRating: spec.maxAgeRating ?? null,
    };
}

/** Cache keys observed on this request, in call order. */
let observedKeys: string[];

function stubCache(): void {
    observedKeys = [];
    vi.mocked(cacheManager.for).mockReturnValue({
        get: vi.fn(async (key: string) => {
            observedKeys.push(key);
            return null;
        }),
        set: vi.fn(async () => undefined),
    } as never);
}

interface RunOptions {
    user?: Record<string, unknown> | undefined;
    principalOnly?: boolean;
    include?: string;
}

interface RunResult {
    metrics: Record<string, unknown>;
    unavailable: Array<{ metric: string; reason: string }>;
    boundary: MediaAccessBoundary | undefined;
    keys: string[];
}

async function run(opts: RunOptions = {}): Promise<RunResult> {
    stubCache();
    // Per-run isolation: several tests run the handler twice (unrestricted
    // baseline, then restricted) and compare. Without this the captured
    // boundary would be the FIRST run's, silently turning the differential
    // assertions into a comparison of the baseline against itself.
    vi.mocked(personalStatsService.getTopTitles).mockClear();
    const user = opts.user ?? makeUser();
    const url = new URL(`http://x/api/v1/me/stats?include=${opts.include ?? 'topTitles'}`);
    const locals = {
        // The principal-only path: locals.principal is set, locals.user is NOT.
        user: opts.principalOnly ? undefined : user,
        principal: { userId: ALICE, username: 'alice', isAdmin: user.isAdmin },
    };

    const res = await def.handlers!.GET!({ url, locals } as never, {} as never);
    const body = (await (res as Response).json()) as {
        metrics: Record<string, unknown>;
        unavailable: Array<{ metric: string; reason: string }>;
    };

    const calls = vi.mocked(personalStatsService.getTopTitles).mock.calls;
    const boundary = calls.length > 0 ? (calls[0]![2] as MediaAccessBoundary) : undefined;

    return { metrics: body.metrics, unavailable: body.unavailable, boundary, keys: observedKeys };
}

/** Extract the flat set of title ids from the transformed topTitles payload. */
function idsOf(metrics: Record<string, unknown>): Set<string> {
    const tt = metrics['topTitles'] as { items?: Array<{ id: string }> } | undefined;
    return new Set((tt?.items ?? []).map((i) => i.id));
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDb).mockReturnValue({} as never);
    vi.mocked(personalStatsService.getSessionCount).mockResolvedValue(100);
    vi.mocked(personalStatsService.getTopTitles).mockImplementation(
        async (_userId: unknown, _period: StatsPeriod, access: MediaAccessBoundary) =>
            applyBoundary(access),
    );
});

// ---------------------------------------------------------------------------

describe('GET /me/stats threads a real access boundary into access-sensitive metrics', () => {
    it('an unrestricted user gets an explicitly unrestricted boundary and every title', async () => {
        vi.mocked(getDeniedLibraryGroups).mockResolvedValue(null);
        const { boundary, metrics } = await run({ user: makeUser() });

        expect(boundary).toEqual(unrestrictedAccess());
        expect(idsOf(metrics).size).toBe(FIXTURE.length);
    });

    it('a library-restricted user sees a STRICT SUBSET of the unrestricted result', async () => {
        vi.mocked(getDeniedLibraryGroups).mockResolvedValue(null);
        const open = idsOf((await run({ user: makeUser() })).metrics);

        vi.mocked(getDeniedLibraryGroups).mockResolvedValue([ADULT_GROUP]);
        const { boundary, metrics } = await run({ user: makeUser({ userGroups: ['kids'] }) });

        expect(boundary?.library).toEqual({ kind: 'denyGroups', ids: [ADULT_GROUP] });

        const restricted = idsOf(metrics);
        expect(restricted.size).toBeGreaterThan(0); // positive control: not empty by accident
        expect(restricted.size).toBeLessThan(open.size); // STRICT
        for (const id of restricted) expect(open.has(id)).toBe(true); // SUBSET
    });

    it('an age-restricted user sees a STRICT SUBSET on the age axis alone', async () => {
        vi.mocked(getDeniedLibraryGroups).mockResolvedValue(null);
        const open = idsOf((await run({ user: makeUser() })).metrics);

        const { boundary, metrics } = await run({ user: makeUser({ maxAgeRating: 12 }) });

        expect(boundary?.library).toEqual({ kind: 'all' });
        expect(boundary?.age).toEqual({ kind: 'limit', maxAgeRating: 12, allowUnrated: false });

        const restricted = idsOf(metrics);
        expect(restricted.size).toBeGreaterThan(0);
        expect(restricted.size).toBeLessThan(open.size);
        for (const id of restricted) expect(open.has(id)).toBe(true);
    });

    it('both axes together restrict at least as much as either alone', async () => {
        vi.mocked(getDeniedLibraryGroups).mockResolvedValue([ADULT_GROUP]);
        const libOnly = idsOf((await run({ user: makeUser({ userGroups: ['kids'] }) })).metrics);

        const both = idsOf(
            (await run({ user: makeUser({ userGroups: ['kids'], maxAgeRating: 12 }) })).metrics,
        );

        expect(both.size).toBeLessThan(libOnly.size);
        for (const id of both) expect(libOnly.has(id)).toBe(true);
    });
});

describe('GET /me/stats fails CLOSED when the boundary cannot be built', () => {
    /**
     * Each of these used to leave `accessCtx` undefined, which the service read
     * as "no filtering" — the unfiltered payload was then written to the shared
     * un-fingerprinted cache entry. The metric must be reported unavailable and
     * the service must not be called at all.
     */
    it('reports topTitles unavailable when there is no database handle', async () => {
        vi.mocked(getDb).mockReturnValue(null as never);
        const { unavailable, metrics } = await run();

        expect(unavailable.map((u) => u.metric)).toContain('topTitles');
        expect(unavailable.find((u) => u.metric === 'topTitles')?.reason).toBe(
            'access_unavailable',
        );
        expect(metrics['topTitles']).toBeUndefined();
        expect(personalStatsService.getTopTitles).not.toHaveBeenCalled();
    });

    it('reports topTitles unavailable when building the boundary rejects', async () => {
        vi.mocked(getDeniedLibraryGroups).mockRejectedValue(new Error('perms lookup down'));
        const { unavailable } = await run();

        expect(unavailable.map((u) => u.metric)).toContain('topTitles');
        expect(unavailable.find((u) => u.metric === 'topTitles')?.reason).toBe(
            'access_unavailable',
        );
        expect(personalStatsService.getTopTitles).not.toHaveBeenCalled();
    });

    it('reports topTitles unavailable on the principal-only path (no locals.user)', async () => {
        // me.ts:281 explicitly contemplates a principal with no locals.user. The
        // call used to pass `locals.user` (AppUserInfo | undefined) straight into
        // buildSearchAccessContext, whose param is non-optional — a type error
        // that ships silently. At runtime `user.maxAgeRating` throws, the .catch
        // swallows it, and the request proceeds boundary-less.
        vi.mocked(getDeniedLibraryGroups).mockResolvedValue(null);
        const { unavailable } = await run({ principalOnly: true });

        expect(unavailable.map((u) => u.metric)).toContain('topTitles');
        expect(unavailable.find((u) => u.metric === 'topTitles')?.reason).toBe(
            'access_unavailable',
        );
        expect(personalStatsService.getTopTitles).not.toHaveBeenCalled();
        // buildSearchAccessContext must not be ENTERED at all. Without the
        // `locals.user` guard the outcome above is still reached — but only by
        // way of a TypeError on `user.maxAgeRating` swallowed by the `.catch`,
        // i.e. by accident, and only because no `if` currently sits between the
        // two. Pin the guard itself, not the crash that lands in the same place.
        expect(buildSearchAccessContext).not.toHaveBeenCalled();
    });

    it('never substitutes an unrestricted boundary on any failure path', async () => {
        for (const setup of [
            (): void => void vi.mocked(getDb).mockReturnValue(null as never),
            (): void => void vi.mocked(getDeniedLibraryGroups).mockRejectedValue(new Error('down')),
        ]) {
            vi.clearAllMocks();
            vi.mocked(getDb).mockReturnValue({} as never);
            vi.mocked(personalStatsService.getSessionCount).mockResolvedValue(100);
            setup();
            await run();
            expect(personalStatsService.getTopTitles).not.toHaveBeenCalled();
        }
    });

    it('still serves NON access-sensitive metrics without a boundary', async () => {
        vi.mocked(getDb).mockReturnValue(null as never);
        const { unavailable, metrics } = await run({ include: 'overview' });

        expect(unavailable.map((u) => u.metric)).not.toContain('overview');
        expect(metrics['overview']).toBeDefined();
    });
});

describe('GET /me/stats partitions the cache by boundary', () => {
    it('restricted and unrestricted callers never share a cache key', async () => {
        vi.mocked(getDeniedLibraryGroups).mockResolvedValue(null);
        const openKeys = (await run({ user: makeUser() })).keys;

        vi.mocked(getDeniedLibraryGroups).mockResolvedValue([ADULT_GROUP]);
        const deniedKeys = (await run({ user: makeUser({ userGroups: ['kids'] }) })).keys;

        expect(openKeys).toHaveLength(1);
        expect(deniedKeys).toHaveLength(1);
        expect(deniedKeys[0]).not.toEqual(openKeys[0]);
        expect(deniedKeys[0]).toContain(ADULT_GROUP);
    });

    it('two differently-restricted callers never share a cache key', async () => {
        vi.mocked(getDeniedLibraryGroups).mockResolvedValue([ADULT_GROUP]);
        const a = (await run({ user: makeUser({ userGroups: ['kids'] }) })).keys;

        vi.mocked(getDeniedLibraryGroups).mockResolvedValue([KIDS_GROUP]);
        const b = (await run({ user: makeUser({ userGroups: ['teens'] }) })).keys;

        expect(a[0]).not.toEqual(b[0]);
    });

    it('age-limit differences partition the key too', async () => {
        vi.mocked(getDeniedLibraryGroups).mockResolvedValue(null);
        const a = (await run({ user: makeUser({ maxAgeRating: 12 }) })).keys;
        const b = (await run({ user: makeUser({ maxAgeRating: 16 }) })).keys;

        expect(a[0]).not.toEqual(b[0]);
    });

    it('a non access-sensitive metric keeps its boundary-free key', async () => {
        vi.mocked(getDeniedLibraryGroups).mockResolvedValue([ADULT_GROUP]);
        const { keys } = await run({
            user: makeUser({ userGroups: ['kids'] }),
            include: 'overview',
        });

        expect(keys).toHaveLength(1);
        expect(keys[0]).not.toContain(ADULT_GROUP);
    });
});
