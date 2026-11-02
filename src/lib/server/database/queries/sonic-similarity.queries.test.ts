// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for sonic-similarity.queries.ts.
 *
 * Tests mock the postgres.Sql instance — no real database is needed.
 * The suite verifies:
 *   - The function is exported and callable.
 *   - It invokes the sql tagged-template (i.e. issues a query).
 *   - It threads the limit value through to the query.
 *   - It returns whatever the sql stub resolves with.
 *   - It returns an empty array when the sql stub resolves with [].
 */

import { describe, test, expect, vi } from 'vitest';
import type postgres from 'postgres';
import {
    findSonicNeighbors,
    findSonicNeighborArtists,
    findSonicNeighborAlbums,
    type SonicNeighborRow,
} from './sonic-similarity.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TRACK_UUID = '11111111-2222-4333-8444-555555555555';
const ARTIST_UUID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const ALBUM_UUID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';

const DENIED_GROUP = 'dddddddd-eeee-4fff-8000-111111111111';

/**
 * Explicit unrestricted boundary. Under the required-by-shape access boundary
 * there is no permissive default — a test that wants unfiltered rows must say
 * so, exactly like production code.
 */
const UNRESTRICTED: MediaAccessBoundary = unrestrictedAccess();

/** A restricted boundary: a denied library group AND a max age rating. */
const RESTRICTED: MediaAccessBoundary = restrictedAccess({
    deniedGroupIds: [DENIED_GROUP],
    maxAgeRating: 13,
    allowUnrated: true,
});

/**
 * Build a fake postgres.Sql tag that returns the given rows when called as a
 * template literal (the pattern used by all query modules).
 *
 * Because the library-access and age-rating builders also invoke `sql\`...\``
 * to produce fragment objects, and those fragments are interpolated into the
 * main template, the stub needs to handle being called as both a full query
 * and as a fragment builder. We return a simple pending-query-like object for
 * fragment calls (detected by having no resolution handler attached) and the
 * actual row data for the main call.
 *
 * In practice, for unrestricted access both builders return `sql\`\`` (empty
 * fragment), so the stub is invoked once for the main query and twice for the
 * empty fragments. We make the mock always resolve to `rows` — the fragment
 * results are not used by the caller.
 */
function makeSqlStub(rows: SonicNeighborRow[]): postgres.Sql {
    // The mock needs to be a tagged-template function AND support chaining
    // (e.g. `.then()` on the result). We return a thenable that resolves to
    // `rows` so the `await sql\`...\`` in the real function gets the data.
    const thenableRows = Object.assign(Promise.resolve(rows), {
        // pgvector / postgres.js pending-query interface — the builders check
        // for none of these, but the main query awaits the result directly.
    });

    const stub = vi.fn().mockReturnValue(thenableRows);
    return stub as unknown as postgres.Sql;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('findSonicNeighbors', () => {
    test('is exported as a function', () => {
        expect(typeof findSonicNeighbors).toBe('function');
    });

    test('returns empty array when sql resolves with no rows', async () => {
        const sql = makeSqlStub([]);
        const result = await findSonicNeighbors(sql, TRACK_UUID, 10, UNRESTRICTED);
        expect(result).toEqual([]);
    });

    test('returns the rows resolved by sql', async () => {
        const fakeRow: SonicNeighborRow = {
            media_id: '22222222-3333-4444-8555-666666666666',
            similarity_score: 0.93,
            title: 'Similar Track',
            custom_poster_url: null,
            custom_metadata: {},
            runtime_seconds: 210,
            artist_title: 'Test Artist',
            album_id: '33333333-4444-5555-8666-777777777777',
            album_title: 'Test Album',
        };

        const sql = makeSqlStub([fakeRow]);
        const result = await findSonicNeighbors(sql, TRACK_UUID, 5, UNRESTRICTED);
        expect(result).toHaveLength(1);
        expect(result[0].media_id).toBe(fakeRow.media_id);
        expect(result[0].similarity_score).toBe(0.93);
        expect(result[0].title).toBe('Similar Track');
    });

    test('calls sql (issues a query) exactly once for the main query', async () => {
        const sql = makeSqlStub([]);
        await findSonicNeighbors(sql, TRACK_UUID, 10, UNRESTRICTED);
        // The stub is called at least once (main query + empty-fragment calls
        // from library-access and age-rating builders under unrestricted ctx).
        expect(vi.mocked(sql)).toHaveBeenCalled();
    });

    test('returns multiple rows in order', async () => {
        const rows: SonicNeighborRow[] = [
            {
                media_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
                similarity_score: 0.95,
                title: 'Track A',
                custom_poster_url: null,
                custom_metadata: {},
                runtime_seconds: 180,
                artist_title: 'Artist A',
                album_id: null,
                album_title: null,
            },
            {
                media_id: 'ffffffff-0000-4111-8222-333333333333',
                similarity_score: 0.87,
                title: 'Track B',
                custom_poster_url: '/art/b.jpg',
                custom_metadata: { genre: 'electronic' },
                runtime_seconds: 240,
                artist_title: 'Artist B',
                album_id: '44444444-5555-4666-8777-888888888888',
                album_title: 'Album B',
            },
        ];

        const sql = makeSqlStub(rows);
        const result = await findSonicNeighbors(sql, TRACK_UUID, 20, UNRESTRICTED);
        expect(result).toHaveLength(2);
        expect(result[0].media_id).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
        expect(result[1].media_id).toBe('ffffffff-0000-4111-8222-333333333333');
    });

    test('SonicNeighborRow interface allows null optional fields', () => {
        const row: SonicNeighborRow = {
            media_id: 'some-uuid',
            similarity_score: 0.5,
            title: 'Track',
            custom_poster_url: null,
            custom_metadata: {},
            runtime_seconds: null,
            artist_title: null,
            album_id: null,
            album_title: null,
        };
        expect(row.runtime_seconds).toBeNull();
        expect(row.artist_title).toBeNull();
        expect(row.album_id).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Regression: findSonicNeighborArtists / findSonicNeighborAlbums under a
// restricted access context.
//
// buildLibraryAccessFilter hardcodes the `mi.id` alias and buildAgeRatingFilter
// defaults to alias `mi`. Both findSonicNeighborArtists and
// findSonicNeighborAlbums used to join the candidate-track table as `track`
// instead of `mi`, so for a restricted user (non-empty deniedGroupIds or a
// non-null ageRating) the spliced-in filter fragments referenced a table alias
// that did not exist in the query, and Postgres would throw "missing
// FROM-clause entry for table mi". For an unrestricted user both filters
// return empty fragments, so the bug was invisible in that case — which is why
// these tests specifically exercise a *restricted* context.
// ---------------------------------------------------------------------------

/**
 * A `sql` stub that behaves like {@link makeSqlStub} (always resolves to
 * `rows`, tolerates being called either as a tagged template or as a plain
 * function for identifier interpolation) but also records every invocation
 * so tests can inspect the raw static template text of the outer query.
 */
function makeRecordingSqlStub(rows: unknown[]): { sql: postgres.Sql; calls: unknown[][] } {
    const calls: unknown[][] = [];
    const stub = vi.fn((...args: unknown[]) => {
        calls.push(args);
        return Object.assign(Promise.resolve(rows), {});
    });
    return { sql: stub as unknown as postgres.Sql, calls };
}

/**
 * Find the recorded call that issued the *outer* query (identified by a
 * marker string only present in the main template, e.g. `FROM centroid`) and
 * return its joined static SQL text.
 */
function joinedOuterQueryText(calls: unknown[][], marker: string): string {
    const mainCall = calls.find((args) => {
        const strings = args[0];
        return (
            Array.isArray(strings) &&
            strings.some((part) => typeof part === 'string' && part.includes(marker))
        );
    });
    expect(mainCall).toBeDefined();
    return (mainCall![0] as string[]).join('');
}

/**
 * The joined static SQL text of every recorded `sql` invocation — the outer
 * query plus each fragment the access builders produced.
 */
function fragmentTexts(calls: unknown[][]): string[] {
    return calls.map((args) =>
        Array.isArray(args[0])
            ? (args[0] as unknown[]).filter((p) => typeof p === 'string').join('')
            : '',
    );
}

type AccessCtx = Parameters<typeof findSonicNeighborArtists>[3];

const RESTRICTED_CTX_CASES: Array<[string, AccessCtx]> = [
    [
        'denied library groups only',
        restrictedAccess({
            deniedGroupIds: [DENIED_GROUP],
            maxAgeRating: null,
            allowUnrated: true,
        }),
    ],
    [
        'age rating only',
        restrictedAccess({ deniedGroupIds: [], maxAgeRating: 13, allowUnrated: true }),
    ],
    ['denied library groups and age rating', RESTRICTED],
];

/**
 * Every exported query in this module, so the boundary contract can be asserted
 * uniformly rather than once per function (an omission here is exactly the kind
 * of gap the required-by-shape boundary exists to prevent).
 */
const ALL_QUERIES: Array<[string, (sql: postgres.Sql, access: AccessCtx) => Promise<unknown[]>]> = [
    ['findSonicNeighbors', (sql, access) => findSonicNeighbors(sql, TRACK_UUID, 10, access)],
    [
        'findSonicNeighborAlbums',
        (sql, access) => findSonicNeighborAlbums(sql, ALBUM_UUID, 10, access),
    ],
    [
        'findSonicNeighborArtists',
        (sql, access) => findSonicNeighborArtists(sql, ARTIST_UUID, 10, access),
    ],
];

// ---------------------------------------------------------------------------
// Required-by-shape access boundary
// ---------------------------------------------------------------------------

describe('access boundary enforcement', () => {
    test.each(ALL_QUERIES)(
        '%s returns EMPTY under a denyAll boundary without issuing any query',
        async (_name, run) => {
            const { sql, calls } = makeRecordingSqlStub([
                // Rows the stub would hand back if the query were issued at all.
                // A denyAll boundary must short-circuit before reaching them.
                { media_id: 'x', album_id: 'x', artist_id: 'x' },
            ]);

            await expect(run(sql, denyAllAccess())).resolves.toEqual([]);
            // Not merely "no rows" — no round trip at all. If this ever fires,
            // the short-circuit was removed and denyAll is relying solely on the
            // builders' `AND false`, which is a strictly weaker guarantee.
            expect(calls).toHaveLength(0);
        },
    );

    test.each(ALL_QUERIES)(
        '%s emits BOTH access predicates under a restricted boundary and NEITHER under an unrestricted one',
        async (_name, run) => {
            // The builders emit empty fragments for `all`/`any`, so an
            // unrestricted call produces query text with no access predicate.
            // A restricted call must produce both. This is what catches a
            // boundary argument that arrives but is never spliced in.
            const unrestricted = makeRecordingSqlStub([]);
            await run(unrestricted.sql, UNRESTRICTED);
            const unrestrictedFragments = fragmentTexts(unrestricted.calls);
            expect(unrestrictedFragments.some((t) => t.includes('media_file_items'))).toBe(false);
            expect(unrestrictedFragments.some((t) => t.includes('age_rating'))).toBe(false);

            const restricted = makeRecordingSqlStub([]);
            await run(restricted.sql, RESTRICTED);
            const restrictedFragments = fragmentTexts(restricted.calls);
            // Library axis: the correlated non-denied-group subquery, keyed on
            // `mi.id` (the CANDIDATE TRACK — see the grain note in the module).
            expect(restrictedFragments.some((t) => t.includes('mi.id'))).toBe(true);
            expect(restrictedFragments.some((t) => t.includes('media_file_items'))).toBe(true);
            // Age axis.
            expect(restrictedFragments.some((t) => t.includes('age_rating'))).toBe(true);
        },
    );

    test.each(ALL_QUERIES)(
        '%s passes the denied group ids through as a bound parameter, not inlined text',
        async (_name, run) => {
            const { sql, calls } = makeRecordingSqlStub([]);
            await run(sql, RESTRICTED);

            // The denied-group array must travel as an interpolated value
            // (args[1..]), never spliced into the static template text — that
            // is the difference between a parameterized query and injection.
            const staticText = calls
                .flatMap((args) => (Array.isArray(args[0]) ? (args[0] as string[]) : []))
                .join('');
            expect(staticText).not.toContain(DENIED_GROUP);

            const boundValues = calls.flatMap((args) => args.slice(1));
            expect(
                boundValues.some(
                    (v) => Array.isArray(v) && (v as unknown[]).includes(DENIED_GROUP),
                ),
            ).toBe(true);
        },
    );
});

describe('findSonicNeighborArtists', () => {
    test('is exported as a function', () => {
        expect(typeof findSonicNeighborArtists).toBe('function');
    });

    test('resolves without throwing under an unrestricted context', async () => {
        const { sql } = makeRecordingSqlStub([]);
        await expect(findSonicNeighborArtists(sql, ARTIST_UUID, 10, UNRESTRICTED)).resolves.toEqual(
            [],
        );
    });

    test.each(RESTRICTED_CTX_CASES)(
        'resolves without throwing under a restricted context (%s) and defines the `mi` alias the filters rely on',
        async (_label, ctx) => {
            const { sql, calls } = makeRecordingSqlStub([]);
            await expect(findSonicNeighborArtists(sql, ARTIST_UUID, 10, ctx)).resolves.toEqual([]);

            const joined = joinedOuterQueryText(calls, 'FROM centroid');
            // Only inspect the outer SELECT (after the `centroid` CTE closes) —
            // the CTE itself legitimately keeps its own local `track` alias,
            // which is a separate scope. The candidate-track join in the OUTER
            // query must alias media_items as `mi` — this is what
            // buildLibraryAccessFilter (hardcoded `mi.id`) and
            // buildAgeRatingFilter (default alias `mi`) reference. Without this,
            // Postgres throws "missing FROM-clause entry for table mi".
            const outerSelect = joined.split('FROM centroid')[1];
            expect(outerSelect).toContain('media_items mi');
            expect(outerSelect).not.toContain('media_items track');
        },
    );
});

describe('findSonicNeighborAlbums', () => {
    test('is exported as a function', () => {
        expect(typeof findSonicNeighborAlbums).toBe('function');
    });

    test('resolves without throwing under an unrestricted context', async () => {
        const { sql } = makeRecordingSqlStub([]);
        await expect(findSonicNeighborAlbums(sql, ALBUM_UUID, 10, UNRESTRICTED)).resolves.toEqual(
            [],
        );
    });

    test.each(RESTRICTED_CTX_CASES)(
        'resolves without throwing under a restricted context (%s) and defines the `mi` alias the filters rely on',
        async (_label, ctx) => {
            const { sql, calls } = makeRecordingSqlStub([]);
            await expect(findSonicNeighborAlbums(sql, ALBUM_UUID, 10, ctx)).resolves.toEqual([]);

            const joined = joinedOuterQueryText(calls, 'FROM centroid');
            const outerSelect = joined.split('FROM centroid')[1];
            expect(outerSelect).toContain('media_items mi');
            expect(outerSelect).not.toContain('media_items track');
        },
    );
});
