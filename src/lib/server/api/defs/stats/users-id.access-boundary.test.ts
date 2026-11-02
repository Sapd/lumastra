// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Differential access-boundary tests for GET /api/v1/stats/users/{id}.
 *
 * Sibling of `me.access-boundary.test.ts`, and deliberately structured the same
 * way — the two endpoints are near-identical fan-outs and the whole point of
 * pinning both is that they cannot drift apart unnoticed.
 *
 * What makes THIS endpoint different, and worth its own file:
 *
 *  1. Two users are in play. The stats belong to the TARGET, but the boundary
 *     that filters them belongs to the VIEWER. A plumbing mistake here does not
 *     look like "unfiltered" — it looks like "filtered by the wrong person".
 *  2. It declares `auth: 'bearer'` and reads identity from `locals.principal`
 *     FIRST, so a PAT/JWT caller authenticates with NO `locals.user` at all.
 *     That path cannot build a boundary, and must therefore refuse the
 *     access-sensitive metrics rather than compute them unfiltered.
 *  3. Its cache entries are scoped to the target user but partitioned by the
 *     viewer's fingerprint. Both halves matter: drop the scope and users' stats
 *     collide, drop the fingerprint and one viewer reads another's filtered
 *     result.
 *
 * As in the me.ts sibling, the stubbed `personalStatsService` genuinely APPLIES
 * the boundary it is handed to a fixed fixture, via the same
 * `isLibraryGroupVisible` helper the SQL builder mirrors. That is what keeps the
 * assertions load-bearing: an argument that arrives but is never used, or a
 * boundary silently replaced by a permissive default, shows up as a non-subset
 * result instead of as a passing test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toUserId } from '$lib/shared/user-id.js';
import type { StatsPeriod, TopTitlesStats } from '$lib/schemas/personal-stats-types.js';
import {
    denyAllAccess,
    isLibraryGroupVisible,
    unrestrictedAccess,
} from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';

const ALICE = toUserId('a1ce0000-0000-4000-a000-000000000000'); // viewer
const BOB_ID = 'b0b00000-0000-4000-a000-000000000000'; // target
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
 * JS mirror of the age predicate `filterAccessibleMediaIds` emits: a row passes
 * if it is unrated AND unrated items are allowed, or if its rating is at or
 * below the limit.
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
    features: { social: true, personalStats: true },
    config: { UNRATED_CONTENT_VISIBLE: false },
    isUnavailableMediaVisible: () => true,
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn(() => ({}) as unknown),
}));

vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserById: vi.fn(),
}));

vi.mock('$lib/server/cache/library-group-permissions-cache.js', async () => {
    const actual = await vi.importActual<
        typeof import('$lib/server/cache/library-group-permissions-cache.js')
    >('$lib/server/cache/library-group-permissions-cache.js');
    return { ...actual, getDeniedLibraryGroups: vi.fn() };
});

// The real adapter chain, with buildSearchAccessContext wrapped in a spy so a
// test can assert it is never ENTERED without a user. Both exports keep their
// real behaviour, so the SearchAccessContext -> MediaAccessBoundary adapter is
// under test too.
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

import { def } from './users-id.js';
import { getDb } from '$lib/server/database/connection.js';
import { getUserById } from '$lib/server/database/queries/users.queries.js';
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

/** The VIEWER — the user whose boundary must filter the target's stats. */
function makeViewer(spec: UserSpec = {}): Record<string, unknown> {
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

/** The TARGET — the user whose stats are being read. */
function makeTarget(hideStreams = false): Record<string, unknown> {
    return {
        id: BOB_ID,
        username: 'bob',
        display_name: 'Bob',
        hide_streams: hideStreams,
        is_admin: false,
        max_age_rating: null,
    };
}

/** Cache keys observed on this request, in call order. */
let observedKeys: string[];
/** Cache scopes (2nd arg) observed on this request, in call order. */
let observedScopes: (string | undefined)[];

function stubCache(): void {
    observedKeys = [];
    observedScopes = [];
    vi.mocked(cacheManager.for).mockReturnValue({
        get: vi.fn(async (key: string, scope?: string) => {
            observedKeys.push(key);
            observedScopes.push(scope);
            return null;
        }),
        set: vi.fn(async () => undefined),
    } as never);
}

interface RunOptions {
    viewer?: Record<string, unknown> | undefined;
    principalOnly?: boolean;
    include?: string;
    target?: Record<string, unknown> | null;
}

interface RunResult {
    status: number;
    metrics: Record<string, unknown>;
    unavailable: Array<{ metric: string; reason: string }>;
    boundary: MediaAccessBoundary | undefined;
    statsUserId: string | undefined;
    keys: string[];
    scopes: (string | undefined)[];
}

async function run(opts: RunOptions = {}): Promise<RunResult> {
    stubCache();
    // Per-run isolation: several tests run the handler twice (unrestricted
    // baseline, then restricted) and compare. Without this the captured
    // boundary would be the FIRST run's, silently turning the differential
    // assertions into a comparison of the baseline against itself.
    vi.mocked(personalStatsService.getTopTitles).mockClear();

    const viewer = opts.viewer ?? makeViewer();
    const target = opts.target === undefined ? makeTarget() : opts.target;
    vi.mocked(getUserById).mockResolvedValue(target as never);

    const url = new URL(
        `http://x/api/v1/stats/users/${BOB_ID}?include=${opts.include ?? 'topTitles'}`,
    );
    const locals = {
        // The principal-only path: locals.principal is set, locals.user is NOT.
        // This is the normal shape for a PAT/JWT caller on a `bearer` endpoint.
        user: opts.principalOnly ? undefined : viewer,
        principal: { userId: ALICE, username: 'alice', isAdmin: viewer.isAdmin },
    };

    const res = (await def.handlers!.GET!(
        { url, params: { id: BOB_ID }, locals } as never,
        {} as never,
    )) as Response;

    if (res.status !== 200) {
        return {
            status: res.status,
            metrics: {},
            unavailable: [],
            boundary: undefined,
            statsUserId: undefined,
            keys: observedKeys,
            scopes: observedScopes,
        };
    }

    const body = (await res.json()) as {
        metrics: Record<string, unknown>;
        unavailable: Array<{ metric: string; reason: string }>;
    };

    const calls = vi.mocked(personalStatsService.getTopTitles).mock.calls;
    const boundary = calls.length > 0 ? (calls[0]![2] as MediaAccessBoundary) : undefined;
    const statsUserId = calls.length > 0 ? (calls[0]![0] as string) : undefined;

    return {
        status: res.status,
        metrics: body.metrics,
        unavailable: body.unavailable,
        boundary,
        statsUserId,
        keys: observedKeys,
        scopes: observedScopes,
    };
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

describe("GET /stats/users/{id} filters the target's stats by the VIEWER's boundary", () => {
    it("reads the TARGET's stats, not the viewer's", async () => {
        vi.mocked(getDeniedLibraryGroups).mockResolvedValue(null);
        const { statsUserId } = await run();

        // Trivially true today, but this is the axis on which the two-user
        // plumbing can invert: stats subject = target, filter = viewer.
        expect(statsUserId).toBe(BOB_ID);
        expect(statsUserId).not.toBe(ALICE);
    });

    it('an unrestricted viewer gets an explicitly unrestricted boundary and every title', async () => {
        vi.mocked(getDeniedLibraryGroups).mockResolvedValue(null);
        const { boundary, metrics } = await run();

        expect(boundary).toEqual(unrestrictedAccess());
        expect(idsOf(metrics).size).toBe(FIXTURE.length);
    });

    it('a library-restricted viewer sees a STRICT SUBSET of the unrestricted result', async () => {
        vi.mocked(getDeniedLibraryGroups).mockResolvedValue(null);
        const open = idsOf((await run()).metrics);

        vi.mocked(getDeniedLibraryGroups).mockResolvedValue([ADULT_GROUP]);
        const { boundary, metrics } = await run({ viewer: makeViewer({ userGroups: ['kids'] }) });

        expect(boundary?.library).toEqual({ kind: 'denyGroups', ids: [ADULT_GROUP] });

        const restricted = idsOf(metrics);
        expect(restricted.size).toBeGreaterThan(0); // positive control: not empty by accident
        expect(restricted.size).toBeLessThan(open.size); // STRICT
        for (const id of restricted) expect(open.has(id)).toBe(true); // SUBSET
    });

    it('an age-restricted viewer sees a STRICT SUBSET on the age axis alone', async () => {
        vi.mocked(getDeniedLibraryGroups).mockResolvedValue(null);
        const open = idsOf((await run()).metrics);

        const { boundary, metrics } = await run({ viewer: makeViewer({ maxAgeRating: 12 }) });

        expect(boundary?.library).toEqual({ kind: 'all' });
        expect(boundary?.age).toEqual({ kind: 'limit', maxAgeRating: 12, allowUnrated: false });

        const restricted = idsOf(metrics);
        expect(restricted.size).toBeGreaterThan(0);
        expect(restricted.size).toBeLessThan(open.size);
        for (const id of restricted) expect(open.has(id)).toBe(true);
    });

    it('both axes together restrict at least as much as either alone', async () => {
        vi.mocked(getDeniedLibraryGroups).mockResolvedValue([ADULT_GROUP]);
        const libOnly = idsOf(
            (await run({ viewer: makeViewer({ userGroups: ['kids'] }) })).metrics,
        );

        const both = idsOf(
            (await run({ viewer: makeViewer({ userGroups: ['kids'], maxAgeRating: 12 }) })).metrics,
        );

        expect(both.size).toBeLessThan(libOnly.size);
        for (const id of both) expect(libOnly.has(id)).toBe(true);
    });

    it("an admin viewer is still filtered by the admin's own boundary", async () => {
        // Admins bypass the *social visibility* gate, not the access boundary.
        // The two bypasses are adjacent in the handler and easy to conflate.
        vi.mocked(getDeniedLibraryGroups).mockResolvedValue([ADULT_GROUP]);
        const { boundary, status } = await run({
            viewer: makeViewer({ isAdmin: true, userGroups: ['kids'] }),
            target: makeTarget(true), // hide_streams — admin sees it anyway
        });

        expect(status).toBe(200);
        expect(boundary?.library).toEqual({ kind: 'denyGroups', ids: [ADULT_GROUP] });
    });

    it('a denyAll boundary yields an EMPTY result', async () => {
        // denyAll is the handler's fallback when no boundary can be built
        // (`viewerAccessCtx ?? denyAllAccess()`). The metric gate normally
        // refuses those requests before the fallback is reachable, so pin the
        // fallback's SEMANTICS directly: were it ever reached, it must produce
        // nothing rather than everything.
        const empty = applyBoundary(denyAllAccess());
        expect(empty.movies).toHaveLength(0);
        expect(empty.shows).toHaveLength(0);
    });
});

describe('GET /stats/users/{id} fails CLOSED when the viewer boundary cannot be built', () => {
    it('reports topTitles unavailable on the principal-only path (PAT/JWT caller)', async () => {
        // The headline defect for THIS endpoint. It declares `auth: 'bearer'`
        // and resolves identity from `locals.principal` first, so a token
        // caller legitimately has no `locals.user`. The `&& locals.user` guard
        // reads like a null check but is load-bearing authorization: without
        // the fail-closed follow-up, every access-sensitive metric would run
        // unfiltered for every token caller.
        vi.mocked(getDeniedLibraryGroups).mockResolvedValue(null);
        const { unavailable, metrics } = await run({ principalOnly: true });

        expect(unavailable.map((u) => u.metric)).toContain('topTitles');
        expect(unavailable.find((u) => u.metric === 'topTitles')?.reason).toBe(
            'access_unavailable',
        );
        expect(metrics['topTitles']).toBeUndefined();
        expect(personalStatsService.getTopTitles).not.toHaveBeenCalled();
        expect(buildSearchAccessContext).not.toHaveBeenCalled();
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

    it('never substitutes an unrestricted boundary on any failure path', async () => {
        for (const setup of [
            (): void => void vi.mocked(getDeniedLibraryGroups).mockRejectedValue(new Error('down')),
            (): void => void vi.mocked(getDeniedLibraryGroups).mockRejectedValue('not-an-error'),
        ]) {
            vi.clearAllMocks();
            vi.mocked(getDb).mockReturnValue({} as never);
            vi.mocked(personalStatsService.getSessionCount).mockResolvedValue(100);
            vi.mocked(personalStatsService.getTopTitles).mockImplementation(
                async (_u: unknown, _p: StatsPeriod, access: MediaAccessBoundary) =>
                    applyBoundary(access),
            );
            setup();
            await run();
            expect(personalStatsService.getTopTitles).not.toHaveBeenCalled();
        }
    });

    it('a failed boundary does NOT write the access-sensitive metric to cache', async () => {
        // The compounding half of the original defect: an unfiltered payload
        // written under the un-fingerprinted key outlives the request and is
        // then served to other viewers for the whole TTL.
        vi.mocked(getDeniedLibraryGroups).mockRejectedValue(new Error('down'));
        const { keys } = await run();

        expect(keys).toHaveLength(0);
    });

    it('still serves NON access-sensitive metrics without a boundary', async () => {
        vi.mocked(getDeniedLibraryGroups).mockRejectedValue(new Error('down'));
        const { unavailable, metrics } = await run({ include: 'overview' });

        expect(unavailable.map((u) => u.metric)).not.toContain('overview');
        expect(metrics['overview']).toBeDefined();
    });
});

describe('GET /stats/users/{id} partitions the cache by target AND viewer boundary', () => {
    it('scopes the entry to the TARGET user', async () => {
        vi.mocked(getDeniedLibraryGroups).mockResolvedValue(null);
        const { scopes } = await run();

        expect(scopes).toHaveLength(1);
        expect(scopes[0]).toBe(BOB_ID);
    });

    it('restricted and unrestricted viewers never share a cache key', async () => {
        vi.mocked(getDeniedLibraryGroups).mockResolvedValue(null);
        const openKeys = (await run()).keys;

        vi.mocked(getDeniedLibraryGroups).mockResolvedValue([ADULT_GROUP]);
        const deniedKeys = (await run({ viewer: makeViewer({ userGroups: ['kids'] }) })).keys;

        expect(openKeys).toHaveLength(1);
        expect(deniedKeys).toHaveLength(1);
        expect(deniedKeys[0]).not.toEqual(openKeys[0]);
        expect(deniedKeys[0]).toContain(ADULT_GROUP);
    });

    it('two differently-restricted viewers never share a cache key', async () => {
        vi.mocked(getDeniedLibraryGroups).mockResolvedValue([ADULT_GROUP]);
        const a = (await run({ viewer: makeViewer({ userGroups: ['kids'] }) })).keys;

        vi.mocked(getDeniedLibraryGroups).mockResolvedValue([KIDS_GROUP]);
        const b = (await run({ viewer: makeViewer({ userGroups: ['teens'] }) })).keys;

        expect(a[0]).not.toEqual(b[0]);
    });

    it('age-limit differences partition the key too', async () => {
        vi.mocked(getDeniedLibraryGroups).mockResolvedValue(null);
        const a = (await run({ viewer: makeViewer({ maxAgeRating: 12 }) })).keys;
        const b = (await run({ viewer: makeViewer({ maxAgeRating: 16 }) })).keys;

        expect(a[0]).not.toEqual(b[0]);
    });

    it('a non access-sensitive metric keeps its boundary-free key', async () => {
        vi.mocked(getDeniedLibraryGroups).mockResolvedValue([ADULT_GROUP]);
        const { keys } = await run({
            viewer: makeViewer({ userGroups: ['kids'] }),
            include: 'overview',
        });

        expect(keys).toHaveLength(1);
        expect(keys[0]).not.toContain(ADULT_GROUP);
    });
});

describe('GET /stats/users/{id} visibility gate', () => {
    it('403s a non-admin viewer when the target hid their streams', async () => {
        vi.mocked(getDeniedLibraryGroups).mockResolvedValue(null);
        const { status } = await run({ target: makeTarget(true) });

        expect(status).toBe(403);
        expect(personalStatsService.getTopTitles).not.toHaveBeenCalled();
    });

    it('404s when the target does not exist', async () => {
        vi.mocked(getDeniedLibraryGroups).mockResolvedValue(null);
        const { status } = await run({ target: null });

        expect(status).toBe(404);
        expect(personalStatsService.getTopTitles).not.toHaveBeenCalled();
    });
});
