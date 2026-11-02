// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Differential access-boundary tests for person.service.ts.
 *
 * The person-details cache (`person-details-v2`) is deliberately user-agnostic:
 * it stores the base payload WITH internal UUIDs, and `applyLibraryAccessFilter`
 * is the ONLY thing between a cache hit and internal UUIDs for media the caller
 * may not see. That makes "the boundary arrived but was never applied" the
 * failure mode worth pinning behaviourally — no type check in this repo would
 * catch it (tsc OOMs, svelte-check is broken, `vite build` only transpiles).
 *
 * `filterAccessibleMediaIds` is stubbed with an implementation that GENUINELY
 * applies the boundary it is handed to a fixture, mirroring the SQL predicates
 * in media-access-batch.ts. A dropped argument, a permissive default, or a
 * boundary swapped for another therefore shows up as a non-subset result rather
 * than as a passing test.
 */

vi.mock('./image-descriptor/people.js', () => ({
    resolvePersonImageSet: vi.fn().mockResolvedValue({}),
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';

// ---------------------------------------------------------------------------
// Fixture: four credits spanning both axes independently.
// ---------------------------------------------------------------------------

const KIDS_GROUP = '11111111-1111-4111-8111-111111111111';
const ADULT_GROUP = '22222222-2222-4222-8222-222222222222';

const ID_KIDS_MOVIE = '00000000-0000-4000-a000-00000000000a';
const ID_ADULT_MOVIE = '00000000-0000-4000-a000-00000000000b';
const ID_KIDS_SHOW = '00000000-0000-4000-a000-00000000000c';
const ID_UNRATED_SHOW = '00000000-0000-4000-a000-00000000000d';

interface FixtureRow {
    libraryGroupId: string;
    ageRating: number | null;
}

const FIXTURE: Record<string, FixtureRow> = {
    [ID_KIDS_MOVIE]: { libraryGroupId: KIDS_GROUP, ageRating: 6 },
    [ID_ADULT_MOVIE]: { libraryGroupId: ADULT_GROUP, ageRating: 6 },
    [ID_KIDS_SHOW]: { libraryGroupId: KIDS_GROUP, ageRating: 18 },
    [ID_UNRATED_SHOW]: { libraryGroupId: KIDS_GROUP, ageRating: null },
};

/** JS mirror of the library predicate media-access-batch.ts emits. */
function libraryVisible(boundary: MediaAccessBoundary, row: FixtureRow): boolean {
    switch (boundary.library.kind) {
        case 'all':
            return true;
        case 'denyGroups':
            return !boundary.library.ids.includes(row.libraryGroupId);
        case 'denyAll':
            return false;
    }
}

/** JS mirror of the age predicate media-access-batch.ts emits. */
function ageVisible(boundary: MediaAccessBoundary, row: FixtureRow): boolean {
    switch (boundary.age.kind) {
        case 'any':
            return true;
        case 'limit':
            return row.ageRating === null
                ? boundary.age.allowUnrated
                : row.ageRating <= boundary.age.maxAgeRating;
        case 'denyAll':
            return false;
    }
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const filterAccessibleMediaIds = vi.fn(
    async (
        _sql: unknown,
        mediaIds: readonly string[],
        boundary: MediaAccessBoundary,
    ): Promise<Set<string>> => {
        const allowed = new Set<string>();
        for (const id of mediaIds) {
            const row = FIXTURE[id];
            if (!row) continue; // query doubles as an existence check
            if (libraryVisible(boundary, row) && ageVisible(boundary, row)) allowed.add(id);
        }
        return allowed;
    },
);

vi.mock('$lib/server/utils/media-access-batch.js', () => ({
    filterAccessibleMediaIds: (...args: unknown[]) =>
        (filterAccessibleMediaIds as unknown as (...a: unknown[]) => Promise<Set<string>>)(...args),
}));

const sqlStub = { __fake: true } as unknown;
const getSql = vi.fn(async (): Promise<unknown> => sqlStub);

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: {
        getSql: () => getSql(),
    },
}));

// Availability now refreshes even on an unrestricted cache hit. This suite
// isolates the independent library/age axes; every fixture title has files.
vi.mock('$lib/server/database/queries/availability.queries.js', async (original) => ({
    ...(await original<typeof import('$lib/server/database/queries/availability.queries.js')>()),
    batchGetAvailability: async (_sql: unknown, ids: string[]) =>
        new Map(ids.map((id) => [id, true])),
}));

const cacheGet = vi.fn(async (_key: string): Promise<unknown> => null);
const cacheSet = vi.fn(async (): Promise<void> => undefined);

vi.mock('$lib/server/cache/index.js', () => ({
    CACHE_NAMESPACES: { personDetails: { name: 'person-details-v2', ttl: 1 } },
    cacheManager: {
        for: () => ({ get: (k: string) => cacheGet(k), set: () => cacheSet() }),
    },
}));

const buildSearchAccessContext = vi.fn();

vi.mock('$lib/server/utils/search-access-context.js', async () => {
    const actual = await vi.importActual<typeof import('$lib/server/utils/search-access-context')>(
        '$lib/server/utils/search-access-context',
    );
    return {
        ...actual,
        buildSearchAccessContext: (...args: unknown[]) => buildSearchAccessContext(...args),
    };
});

import {
    applyLibraryAccessFilter,
    handlePersonGet,
    resolvePersonAccessBoundary,
    type PersonDetails,
} from './person.service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDetails(): PersonDetails {
    return {
        id: 42,
        name: 'Test Person',
        movieCredits: [
            {
                externalIds: { tmdb: '101', internal: ID_KIDS_MOVIE },
                mediaType: 'movie',
                title: 'Kids Movie',
                isAvailable: true,
                canRequest: false,
            },
            {
                externalIds: { tmdb: '102', internal: ID_ADULT_MOVIE },
                mediaType: 'movie',
                title: 'Adult Movie',
                isAvailable: true,
                canRequest: false,
            },
        ],
        tvCredits: [
            {
                externalIds: { tmdb: '201', internal: ID_KIDS_SHOW },
                mediaType: 'series',
                title: 'Kids Show',
                isAvailable: true,
                canRequest: false,
            },
            {
                externalIds: { tmdb: '202', internal: ID_UNRATED_SHOW },
                mediaType: 'series',
                title: 'Unrated Show',
                isAvailable: true,
                canRequest: false,
            },
        ],
    };
}

/** The set of internal UUIDs that survived the filter. */
function survivingIds(
    details: PersonDetails | import('$lib/schemas/api-person-responses.js').PersonDetailResponse,
): Set<string> {
    const ids = new Set<string>();
    for (const c of [...details.movieCredits, ...details.tvCredits]) {
        const internal = 'catalogId' in c ? c.catalogId : c.externalIds.internal;
        if (internal) ids.add(internal);
    }
    return ids;
}

const isStrictSubset = (sub: Set<string>, sup: Set<string>): boolean =>
    sub.size < sup.size && [...sub].every((v) => sup.has(v));

beforeEach(() => {
    vi.clearAllMocks();
    getSql.mockImplementation(async () => sqlStub);
    cacheGet.mockImplementation(async () => null);
});

// ---------------------------------------------------------------------------
// applyLibraryAccessFilter — differential
// ---------------------------------------------------------------------------

describe('applyLibraryAccessFilter is differential in the boundary', () => {
    it('unrestricted keeps every internal UUID (positive control)', async () => {
        const out = await applyLibraryAccessFilter(makeDetails(), unrestrictedAccess());
        expect(survivingIds(out)).toEqual(
            new Set([ID_KIDS_MOVIE, ID_ADULT_MOVIE, ID_KIDS_SHOW, ID_UNRATED_SHOW]),
        );
    });

    it('a denied library group yields a STRICT SUBSET of unrestricted', async () => {
        const unrestricted = survivingIds(
            await applyLibraryAccessFilter(makeDetails(), unrestrictedAccess()),
        );
        const restricted = survivingIds(
            await applyLibraryAccessFilter(
                makeDetails(),
                restrictedAccess({
                    deniedGroupIds: [ADULT_GROUP],
                    maxAgeRating: null,
                    allowUnrated: true,
                }),
            ),
        );
        expect(isStrictSubset(restricted, unrestricted)).toBe(true);
        expect(restricted.has(ID_ADULT_MOVIE)).toBe(false);
        expect(restricted.size).toBeGreaterThan(0);
    });

    it('an age limit yields a STRICT SUBSET of unrestricted', async () => {
        const unrestricted = survivingIds(
            await applyLibraryAccessFilter(makeDetails(), unrestrictedAccess()),
        );
        const restricted = survivingIds(
            await applyLibraryAccessFilter(
                makeDetails(),
                restrictedAccess({
                    deniedGroupIds: [],
                    maxAgeRating: 12,
                    allowUnrated: false,
                }),
            ),
        );
        expect(isStrictSubset(restricted, unrestricted)).toBe(true);
        // 18-rated and unrated both fall away; the two 6-rated survive.
        expect(restricted).toEqual(new Set([ID_KIDS_MOVIE, ID_ADULT_MOVIE]));
    });

    it('both axes together is a subset of each axis alone', async () => {
        const libOnly = survivingIds(
            await applyLibraryAccessFilter(
                makeDetails(),
                restrictedAccess({
                    deniedGroupIds: [ADULT_GROUP],
                    maxAgeRating: null,
                    allowUnrated: true,
                }),
            ),
        );
        const ageOnly = survivingIds(
            await applyLibraryAccessFilter(
                makeDetails(),
                restrictedAccess({
                    deniedGroupIds: [],
                    maxAgeRating: 12,
                    allowUnrated: false,
                }),
            ),
        );
        const both = survivingIds(
            await applyLibraryAccessFilter(
                makeDetails(),
                restrictedAccess({
                    deniedGroupIds: [ADULT_GROUP],
                    maxAgeRating: 12,
                    allowUnrated: false,
                }),
            ),
        );
        expect([...both].every((id) => libOnly.has(id))).toBe(true);
        expect([...both].every((id) => ageOnly.has(id))).toBe(true);
        expect(both).toEqual(new Set([ID_KIDS_MOVIE]));
    });

    it('denyAll strips EVERY internal UUID and never touches the database', async () => {
        const out = await applyLibraryAccessFilter(makeDetails(), denyAllAccess());
        expect(survivingIds(out)).toEqual(new Set());
        expect(filterAccessibleMediaIds).not.toHaveBeenCalled();
        expect(getSql).not.toHaveBeenCalled();
    });

    it('denyAll on the library axis alone still strips everything', async () => {
        const out = await applyLibraryAccessFilter(makeDetails(), {
            library: { kind: 'denyAll' },
            age: { kind: 'any' },
        });
        expect(survivingIds(out)).toEqual(new Set());
        expect(filterAccessibleMediaIds).not.toHaveBeenCalled();
    });

    it('denyAll on the age axis alone still strips everything', async () => {
        const out = await applyLibraryAccessFilter(makeDetails(), {
            library: { kind: 'all' },
            age: { kind: 'denyAll' },
        });
        expect(survivingIds(out)).toEqual(new Set());
        expect(filterAccessibleMediaIds).not.toHaveBeenCalled();
    });

    it('stripped credits are marked unavailable and requestable', async () => {
        const out = await applyLibraryAccessFilter(makeDetails(), denyAllAccess());
        for (const c of [...out.movieCredits, ...out.tvCredits]) {
            expect(c.isAvailable).toBe(false);
            expect(c.canRequest).toBe(true);
            expect(c.externalIds).not.toHaveProperty('internal');
            // The public provider id must survive — only `internal` is stripped.
            expect(c.externalIds.tmdb).toBeTruthy();
        }
    });

    it('an unrestricted boundary skips the access query', async () => {
        await applyLibraryAccessFilter(makeDetails(), unrestrictedAccess());
        expect(filterAccessibleMediaIds).not.toHaveBeenCalled();
    });

    it('a restricted boundary DOES reach the query', async () => {
        await applyLibraryAccessFilter(
            makeDetails(),
            restrictedAccess({
                deniedGroupIds: [ADULT_GROUP],
                maxAgeRating: null,
                allowUnrated: true,
            }),
        );
        expect(filterAccessibleMediaIds).toHaveBeenCalledTimes(1);
        const [, ids, boundary] = filterAccessibleMediaIds.mock.calls[0] as [
            unknown,
            string[],
            MediaAccessBoundary,
        ];
        expect(ids).toHaveLength(4);
        expect(boundary).toEqual({
            library: { kind: 'denyGroups', ids: [ADULT_GROUP] },
            age: { kind: 'any' },
        });
    });

    it('fails CLOSED when the database is unavailable under a restricted boundary', async () => {
        getSql.mockImplementation(async () => null);
        const out = await applyLibraryAccessFilter(
            makeDetails(),
            restrictedAccess({
                deniedGroupIds: [ADULT_GROUP],
                maxAgeRating: null,
                allowUnrated: true,
            }),
        );
        // Previously this returned the FULL payload, internal UUIDs included,
        // precisely when enforcement was impossible.
        expect(survivingIds(out)).toEqual(new Set());
    });
});

// ---------------------------------------------------------------------------
// resolvePersonAccessBoundary — fail-closed paths
// ---------------------------------------------------------------------------

describe('resolvePersonAccessBoundary fails closed', () => {
    it('denies everything when there is no user', async () => {
        expect(await resolvePersonAccessBoundary(undefined)).toEqual(denyAllAccess());
        // No user means no lookup at all.
        expect(buildSearchAccessContext).not.toHaveBeenCalled();
    });

    it('denies everything when the database is unavailable', async () => {
        getSql.mockImplementation(async () => null);
        const user = { username: 'alice' } as never;
        expect(await resolvePersonAccessBoundary(user)).toEqual(denyAllAccess());
    });

    it('denies everything when the boundary lookup throws', async () => {
        buildSearchAccessContext.mockRejectedValue(new Error('boom'));
        const user = { username: 'alice' } as never;
        expect(await resolvePersonAccessBoundary(user)).toEqual(denyAllAccess());
    });

    it('projects a real user context onto the boundary', async () => {
        buildSearchAccessContext.mockResolvedValue({
            username: 'alice',
            deniedGroupIds: [ADULT_GROUP],
            ageRating: { maxAgeRating: 12, allowUnrated: false },
            liveTvAllowed: false,
            showUnavailableMedia: false,
        });
        const user = { username: 'alice' } as never;
        expect(await resolvePersonAccessBoundary(user)).toEqual({
            library: { kind: 'denyGroups', ids: [ADULT_GROUP] },
            age: { kind: 'limit', maxAgeRating: 12, allowUnrated: false },
        });
    });
});

// ---------------------------------------------------------------------------
// handlePersonGet — the cache-hit path is the highest-risk site
// ---------------------------------------------------------------------------

function makeEvent(): RequestEvent {
    return {
        params: { personId: '42' },
        locals: {},
    } as unknown as RequestEvent;
}

async function bodyOf(
    res: Response,
): Promise<import('$lib/schemas/api-person-responses.js').PersonDetailResponse> {
    return (await res.json()) as import('$lib/schemas/api-person-responses.js').PersonDetailResponse;
}

describe('handlePersonGet threads the boundary through the cache-hit path', () => {
    beforeEach(() => {
        cacheGet.mockImplementation(async () => makeDetails());
    });

    it('returns dependency unavailable when image selection cannot read the database', async () => {
        getSql.mockImplementation(async () => null);
        const response = await handlePersonGet(makeEvent(), unrestrictedAccess());
        expect(response.status).toBe(503);
    });

    it('serves every internal UUID to an unrestricted caller (positive control)', async () => {
        const res = await handlePersonGet(makeEvent(), unrestrictedAccess());
        expect(res.status).toBe(200);
        expect(survivingIds(await bodyOf(res))).toEqual(
            new Set([ID_KIDS_MOVIE, ID_ADULT_MOVIE, ID_KIDS_SHOW, ID_UNRATED_SHOW]),
        );
    });

    it('serves a STRICT SUBSET to a restricted caller', async () => {
        const unrestricted = survivingIds(
            await bodyOf(await handlePersonGet(makeEvent(), unrestrictedAccess())),
        );
        const restricted = survivingIds(
            await bodyOf(
                await handlePersonGet(
                    makeEvent(),
                    restrictedAccess({
                        deniedGroupIds: [ADULT_GROUP],
                        maxAgeRating: 12,
                        allowUnrated: false,
                    }),
                ),
            ),
        );
        expect(isStrictSubset(restricted, unrestricted)).toBe(true);
        expect(restricted).toEqual(new Set([ID_KIDS_MOVIE]));
    });

    it('serves NO internal UUID to a denyAll caller', async () => {
        const res = await handlePersonGet(makeEvent(), denyAllAccess());
        expect(survivingIds(await bodyOf(res))).toEqual(new Set());
    });
});
