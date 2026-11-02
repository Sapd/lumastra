// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for sonic-path.queries.ts.
 *
 * The public API has two exported functions, BOTH of which now take a REQUIRED
 * MediaAccessBoundary (no permissive default — see the boundary contract in
 * sonic-path.queries.ts):
 *   - fetchSeedEmbedding(sql, mediaId, access) → number[] | null
 *   - buildSonicPath(sql, fromId, toId, steps, access)
 *     → { steps: SonicPathStep[], missingEmbedding: 'from'|'to'|null }
 *
 * SQL stubs route by main-query text. Fragment construction can change without
 * changing which seed, title metadata, or nearest-candidate fixture is returned.
 * Access fragments and exclusion parameters remain observable independently.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';

import {
    fetchSeedEmbedding,
    buildSonicPath,
    SONIC_PATH_DEFAULT_STEPS,
    SONIC_PATH_MIN_STEPS,
    SONIC_PATH_MAX_STEPS,
} from './sonic-path.queries.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FROM_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const TO_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const TRACK_ID_1 = 'cccccccc-3333-4333-8333-333333333333';
const TRACK_ID_2 = 'dddddddd-4444-4444-8444-444444444444';

/** Explicit unrestricted boundary — no permissive default exists any more. */
const UNRESTRICTED_CTX = unrestrictedAccess();

/** A boundary that closes both axes. */
const DENY_ALL = denyAllAccess();

/** A real restricted user: one denied library group plus an age ceiling. */
const RESTRICTED = restrictedAccess({
    deniedGroupIds: ['dddddddd-eeee-4fff-8000-111111111111'],
    maxAgeRating: 13,
    allowUnrated: true,
});

/** A minimal 4-dim embedding (real embeddings are 1024-dim; small is fine for tests). */
const FROM_EMBED = [1.0, 0.0, 0.0, 0.0];
const TO_EMBED = [0.0, 1.0, 0.0, 0.0];

/**
 * Build a sql stub that always resolves to the given rows.
 *
 * Because the library-access and age-rating builders call `sql\`\`` to produce
 * empty fragments (for the unrestricted case), the main query and fragments all
 * go through the same stub. The stub always resolves to `rows`, so fragment
 * calls get `rows` too — but only the main query result is awaited by the
 * calling code; the fragment results are template-interpolated, not awaited.
 */
function makeSqlAlwaysReturns(rows: unknown[]): postgres.Sql {
    const thenableRows = Object.assign(Promise.resolve(rows), {});
    const stub = vi.fn().mockReturnValue(thenableRows);
    return stub as unknown as postgres.Sql;
}

function makeEmbeddingRow(mediaId: string, embedding: number[]): Record<string, unknown> {
    return {
        media_id: mediaId,
        embedding: `[${embedding.join(',')}]`,
    };
}

function makeCandidateRow(
    mediaId: string,
    artistId = 'artist-1',
    title = `Track ${mediaId.slice(0, 4)}`,
): Record<string, unknown> {
    return {
        media_id: mediaId,
        similarity_score: 0.8,
        title,
        custom_poster_url: null,
        custom_metadata: {},
        runtime_seconds: 200,
        artist_title: 'Test Artist',
        artist_id: artistId,
        album_id: null,
        album_title: null,
    };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('sonic-path constants', () => {
    test('SONIC_PATH_DEFAULT_STEPS is 8', () => {
        expect(SONIC_PATH_DEFAULT_STEPS).toBe(8);
    });

    test('SONIC_PATH_MIN_STEPS is 1', () => {
        expect(SONIC_PATH_MIN_STEPS).toBe(1);
    });

    test('SONIC_PATH_MAX_STEPS is 20', () => {
        expect(SONIC_PATH_MAX_STEPS).toBe(20);
    });
});

// ---------------------------------------------------------------------------
// fetchSeedEmbedding
// ---------------------------------------------------------------------------

describe('fetchSeedEmbedding', () => {
    test('returns null when the track has no embedding row', async () => {
        const sql = makeSqlAlwaysReturns([]);
        const result = await fetchSeedEmbedding(sql, FROM_ID, UNRESTRICTED_CTX);
        expect(result).toBeNull();
    });

    test('returns parsed embedding array when row exists', async () => {
        const sql = makeSqlAlwaysReturns([makeEmbeddingRow(FROM_ID, FROM_EMBED)]);
        const result = await fetchSeedEmbedding(sql, FROM_ID, UNRESTRICTED_CTX);
        expect(result).toEqual(FROM_EMBED);
    });

    test('parses vector string format [v1,v2,...] correctly', async () => {
        const embed = [0.1, 0.2, 0.3];
        const sql = makeSqlAlwaysReturns([makeEmbeddingRow(FROM_ID, embed)]);
        const result = await fetchSeedEmbedding(sql, FROM_ID, UNRESTRICTED_CTX);
        expect(result).toHaveLength(3);
        expect(result?.[0]).toBeCloseTo(0.1);
        expect(result?.[1]).toBeCloseTo(0.2);
        expect(result?.[2]).toBeCloseTo(0.3);
    });

    test('issues one seed embedding query and no waypoint query', async () => {
        const { sql, knnCount } = makeSmartStub();
        await fetchSeedEmbedding(sql, FROM_ID, UNRESTRICTED_CTX);
        expect(
            allTemplateTexts(sql).filter((text) =>
                text.includes('FROM media_audio_embeddings mae'),
            ),
        ).toHaveLength(1);
        expect(knnCount()).toBe(0);
    });

    test('returns null under a denyAll boundary WITHOUT touching the database', async () => {
        // Guards the short-circuit: a caller that may see nothing must not be
        // able to read a seed embedding, and must not pay a round trip to
        // learn that.
        const sql = makeSqlAlwaysReturns([makeEmbeddingRow(FROM_ID, FROM_EMBED)]);
        const result = await fetchSeedEmbedding(sql, FROM_ID, DENY_ALL);
        expect(result).toBeNull();
        expect(vi.mocked(sql)).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// buildSonicPath — missing embeddings
// ---------------------------------------------------------------------------

describe('buildSonicPath — missing embeddings', () => {
    test('returns missingEmbedding=from when from track has no embedding', async () => {
        // sql always returns [] → both fetchSeedEmbedding calls get null.
        // The function checks `from` first and returns early.
        const sql = makeSqlAlwaysReturns([]);
        const result = await buildSonicPath(sql, FROM_ID, TO_ID, 3, UNRESTRICTED_CTX);
        expect(result.missingEmbedding).toBe('from');
        expect(result.steps).toHaveLength(0);
    });

    test('returns missingEmbedding=to when to track has no embedding but from has one', async () => {
        const { sql } = makeSmartStub({ embeddings: { [FROM_ID]: FROM_EMBED } });
        const result = await buildSonicPath(sql, FROM_ID, TO_ID, 3, UNRESTRICTED_CTX);
        expect(result.missingEmbedding).toBe('to');
        expect(result.steps).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// buildSonicPath — bridge building
// ---------------------------------------------------------------------------

describe('buildSonicPath — bridge building', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('returns no steps when no candidate rows are returned for any waypoint', async () => {
        const { sql, knnCount } = makeSmartStub({ embeddings: BOTH_SEEDS });
        const result = await buildSonicPath(sql, FROM_ID, TO_ID, 2, UNRESTRICTED_CTX);
        expect(result.missingEmbedding).toBeNull();
        expect(result.steps).toHaveLength(0);
        expect(knnCount()).toBe(2);
    });

    test('returns bridge steps when candidates are found', async () => {
        const { sql } = makeSmartStub({
            embeddings: BOTH_SEEDS,
            candidateFor: (index) => [makeCandidateRow(index === 0 ? TRACK_ID_1 : TRACK_ID_2)],
        });
        const result = await buildSonicPath(sql, FROM_ID, TO_ID, 2, UNRESTRICTED_CTX);
        expect(result.missingEmbedding).toBeNull();
        expect(result.steps).toHaveLength(2);
        expect(result.steps[0].step).toBe(0);
        expect(result.steps[0].media_id).toBe(TRACK_ID_1);
        expect(result.steps[1].step).toBe(1);
        expect(result.steps[1].media_id).toBe(TRACK_ID_2);
    });

    test('rounds similarity_score to 4 decimal places', async () => {
        const { sql } = makeSmartStub({
            embeddings: BOTH_SEEDS,
            candidateFor: () => [{ ...makeCandidateRow(TRACK_ID_1), similarity_score: 0.876543 }],
        });
        const result = await buildSonicPath(sql, FROM_ID, TO_ID, 1, UNRESTRICTED_CTX);
        expect(result.steps).toHaveLength(1);
        expect(result.steps[0].similarity_score).toBe(0.8765);
    });

    test('clamps steps to SONIC_PATH_MAX_STEPS (20)', async () => {
        const { sql, knnCount } = makeSmartStub({
            embeddings: BOTH_SEEDS,
            candidateFor: (index) => {
                const id = '00000000-0000-4000-8000-' + String(index).padStart(12, '0');
                return [makeCandidateRow(id, 'artist-' + index, 'Track ' + index)];
            },
        });
        const result = await buildSonicPath(sql, FROM_ID, TO_ID, 99, UNRESTRICTED_CTX);
        expect(result.steps).toHaveLength(SONIC_PATH_MAX_STEPS);
        expect(knnCount()).toBe(SONIC_PATH_MAX_STEPS);
    });

    test('deduplicate: selected tracks are excluded from subsequent steps', async () => {
        const { sql } = makeSmartStub({
            embeddings: BOTH_SEEDS,
            candidateFor: (index, _filtered, excludedIds) => {
                expect(excludedIds).toContain(FROM_ID);
                expect(excludedIds).toContain(TO_ID);
                if (index === 0) return [makeCandidateRow(TRACK_ID_1)];
                expect(excludedIds).toContain(TRACK_ID_1);
                return [];
            },
        });
        const result = await buildSonicPath(sql, FROM_ID, TO_ID, 2, UNRESTRICTED_CTX);
        expect(result.steps).toHaveLength(1);
        expect(result.steps[0].media_id).toBe(TRACK_ID_1);
    });

    test('title-dedup: a duplicate copy of the seed track is skipped as a bridge hop', async () => {
        const { sql, knnCount } = makeSmartStub({
            embeddings: BOTH_SEEDS,
            seedTitles: [{ media_id: FROM_ID, title: 'Mira Lane', artist_title: 'Micah Vale' }],
            candidateFor: (index, _filtered, excludedIds) => {
                if (index === 0)
                    return [
                        {
                            ...makeCandidateRow(TRACK_ID_1),
                            title: 'Mira Lane (2008 Remastered)',
                            artist_title: 'Micah Vale',
                        },
                    ];
                expect(excludedIds).toContain(TRACK_ID_1);
                return [
                    {
                        ...makeCandidateRow(TRACK_ID_2),
                        title: 'Silent Traveler',
                        artist_title: 'Micah Vale',
                    },
                ];
            },
        });
        const result = await buildSonicPath(sql, FROM_ID, TO_ID, 1, UNRESTRICTED_CTX);
        expect(result.steps).toHaveLength(1);
        expect(result.steps[0].media_id).toBe(TRACK_ID_2);
        expect(knnCount()).toBe(2);
    });

    test('title-dedup: bridge hops are not title-duplicates of each other', async () => {
        const duplicateId = 'eeeeeeee-5555-4555-8555-555555555555';
        const candidates = [
            makeCandidateRow(TRACK_ID_1, 'artist-1', 'Song A'),
            makeCandidateRow(duplicateId, 'artist-1', 'Song A'),
            makeCandidateRow(TRACK_ID_2, 'artist-2', 'Song B'),
        ];
        const { sql, knnCount } = makeSmartStub({
            embeddings: BOTH_SEEDS,
            candidateFor: (index, _filtered, excludedIds) => {
                if (index > 0) expect(excludedIds).toContain(TRACK_ID_1);
                if (index > 1) expect(excludedIds).toContain(duplicateId);
                return candidates[index] ? [candidates[index]] : [];
            },
        });
        const result = await buildSonicPath(sql, FROM_ID, TO_ID, 2, UNRESTRICTED_CTX);
        expect(result.steps).toHaveLength(2);
        expect(result.steps[0].media_id).toBe(TRACK_ID_1);
        expect(result.steps[1].media_id).toBe(TRACK_ID_2);
        expect(knnCount()).toBe(3);
    });
});

// ---------------------------------------------------------------------------
// Access boundary
// ---------------------------------------------------------------------------

/**
 * Recover the literal SQL text of a tagged-template call, with `?` standing in
 * for each interpolation. Lets us assert on what a fragment actually emitted.
 */
function templateTextOf(call: readonly unknown[]): string {
    const strings = call[0];
    return Array.isArray(strings) ? (strings as readonly string[]).join('?') : '';
}

/** All tagged-template texts a mocked sql tag was invoked with, in order. */
function allTemplateTexts(sql: postgres.Sql): string[] {
    // `vi.mocked(postgres.Sql)` instantiates the tagged-template overloads and
    // blows TypeScript's instantiation depth. Only `.mock.calls` is needed here,
    // so read it through a minimal structural view of the mock.
    const mock = sql as unknown as { mock: { calls: readonly unknown[][] } };
    return mock.mock.calls.map((c) => templateTextOf(c));
}

/**
 * A stub that routes by the SQL TEXT of each call rather than by call index.
 *
 * Seed and waypoint fixtures are independent of how many templates each
 * projection or access builder constructs. Access predicate observation still
 * drives differential tests, so dropping a boundary remains observable.
 */
interface SmartStubOptions {
    /** Embedding per seed media id. A missing id resolves to "no embedding". */
    embeddings?: Record<string, number[]>;
    /** Rows returned by the seed title-meta query. */
    seedTitles?: unknown[];
    /**
     * Candidate row(s) for the nth kNN query (0-based), or [] for none.
     *
     * `filtered` reports whether the access predicates were ACTUALLY spliced
     * into that kNN query — the stub sees the builder fragments go by
     * immediately before the main call and reports what it saw. Driving the
     * differential test off this (rather than off a flag the test sets itself)
     * is what makes it fail if the boundary argument is accepted and then
     * dropped: an ignored boundary emits no predicate, `filtered` stays false,
     * and the "restricted" run returns the unrestricted rows.
     */
    candidateFor?: (
        knnIndex: number,
        filtered: boolean,
        excludedIds: readonly string[],
    ) => unknown[];
}

interface SmartStub {
    sql: postgres.Sql;
    /** How many kNN (main ORDER BY) queries were issued. */
    knnCount: () => number;
}

function makeSmartStub(opts: SmartStubOptions = {}): SmartStub {
    let knn = 0;
    // Set when an access-filter fragment goes by; consumed by the next main
    // query, since a query's fragments are always evaluated immediately before
    // the tag call they are spliced into.
    let pendingAccessPredicate = false;
    let pendingExcludedIds: string[] = [];
    const stub = vi.fn().mockImplementation((...args: unknown[]) => {
        const text = templateTextOf(args);
        let rows: unknown[] = [];

        if (text.includes('AND mae.media_id != ALL(')) {
            const ids = args[1];
            pendingExcludedIds = Array.isArray(ids)
                ? ids.filter((id): id is string => typeof id === 'string')
                : [];
        }

        if (text.includes('mf.library_group_id') || text.includes('.age_rating')) {
            pendingAccessPredicate = true;
            return Object.assign(Promise.resolve([]), {});
        }

        if (text.includes('ORDER BY mae.embedding')) {
            // kNN main query.
            const filtered = pendingAccessPredicate;
            pendingAccessPredicate = false;
            rows = opts.candidateFor ? opts.candidateFor(knn, filtered, pendingExcludedIds) : [];
            pendingExcludedIds = [];
            knn++;
        } else if (text.includes('FROM media_audio_embeddings mae')) {
            // Seed embedding main query — first interpolation is the media id.
            pendingAccessPredicate = false;
            const mediaId = args[1];
            const embed = typeof mediaId === 'string' ? opts.embeddings?.[mediaId] : undefined;
            rows = embed ? [makeEmbeddingRow(mediaId as string, embed)] : [];
        } else if (text.includes('LEFT JOIN media_items album')) {
            // Seed title-meta main query.
            rows = opts.seedTitles ?? [];
        }
        // Anything else is an interpolated fragment; its result is never awaited.

        return Object.assign(Promise.resolve(rows), {});
    });
    return { sql: stub as unknown as postgres.Sql, knnCount: () => knn };
}

/** Both seeds embedded — the common starting point for boundary tests. */
const BOTH_SEEDS: Record<string, number[]> = {
    [FROM_ID]: FROM_EMBED,
    [TO_ID]: TO_EMBED,
};

describe('buildSonicPath — access boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('a denyAll boundary returns an EMPTY bridge without issuing a single query', async () => {
        // The short-circuit is not a nicety: a full run issues up to
        // 20 steps x 10 retry attempts x ~5 sql invocations, every one of which
        // would be a guaranteed-empty round trip under `AND false`.
        const { sql } = makeSmartStub({
            embeddings: BOTH_SEEDS,
            candidateFor: () => [makeCandidateRow(TRACK_ID_1)],
        });
        const result = await buildSonicPath(sql, FROM_ID, TO_ID, 20, DENY_ALL);

        expect(result).toEqual({ steps: [], missingEmbedding: null });
        expect(vi.mocked(sql)).not.toHaveBeenCalled();
    });

    test('a denyAll boundary reports no bridge rather than a missing embedding', async () => {
        // Nothing is known about the seeds' embeddings when we never looked, so
        // the def must not tell the user to go generate sonic embeddings.
        const { sql } = makeSmartStub({ embeddings: BOTH_SEEDS });
        const { missingEmbedding } = await buildSonicPath(sql, FROM_ID, TO_ID, 3, DENY_ALL);
        expect(missingEmbedding).toBeNull();
    });

    test('an unrestricted boundary emits LITERALLY EMPTY access fragments', async () => {
        // HNSW hazard: the kNN is `ORDER BY mae.embedding <=> waypoint LIMIT 1`
        // against a vector_cosine_ops index. Today's unrestricted path splices
        // nothing at all into the WHERE. If a reshape ever emitted a tautology
        // (AND true / AND 1=1) the planner can fall off the index — this repo has
        // a documented ef_search starvation incident. Assert byte-emptiness.
        const { sql } = makeSmartStub({
            embeddings: BOTH_SEEDS,
            candidateFor: () => [makeCandidateRow(TRACK_ID_1)],
        });
        await buildSonicPath(sql, FROM_ID, TO_ID, 1, UNRESTRICTED_CTX);

        const texts = allTemplateTexts(sql);
        // 2 per fetchSeedEmbedding (x2 seeds) + 2 per kNN step = 6 empty fragments.
        expect(texts.filter((t) => t === '')).toHaveLength(6);
        // And nothing anywhere resembles an always-true predicate.
        for (const t of texts) {
            expect(t).not.toMatch(/AND\s+(true|1\s*=\s*1)/i);
        }
    });

    test('an unrestricted boundary emits no access predicate text at all', async () => {
        const { sql } = makeSmartStub({
            embeddings: BOTH_SEEDS,
            candidateFor: () => [makeCandidateRow(TRACK_ID_1)],
        });
        await buildSonicPath(sql, FROM_ID, TO_ID, 1, UNRESTRICTED_CTX);

        const joined = allTemplateTexts(sql).join('\n');
        expect(joined).not.toContain('library_group_id');
        expect(joined).not.toContain('age_rating');
    });

    test('the kNN query resolves artist_id via trackArtistIdSql, not the bare album-artist join', async () => {
        // Regression guard for the album-artist tap-through bug: findNearestToWaypoint
        // used to select `artist.id AS artist_id` — the ALBUM-artist join — right
        // next to a NAME sourced from trackDisplayArtistSql (the per-track tag).
        // A compilation track could then ship `artist_title: "The Harborfolk"`
        // paired with the "Various Artists" album's id, so "Go to Artist" landed
        // on the wrong artist page. trackArtistIdSql is the id counterpart of
        // trackDisplayArtistSql — same tag, same priority — so the two can no
        // longer disagree. Without the fix this test fails on both assertions:
        // the old query never referenced additional_artist_ids, and its literal
        // SELECT text was exactly the bare-join string checked for below.
        const { sql } = makeSmartStub({
            embeddings: BOTH_SEEDS,
            candidateFor: () => [makeCandidateRow(TRACK_ID_1)],
        });
        await buildSonicPath(sql, FROM_ID, TO_ID, 1, UNRESTRICTED_CTX);

        const texts = allTemplateTexts(sql);
        // trackArtistIdSql reads additional_artist_ids — a marker the plain
        // album-artist join never touched.
        expect(texts.some((t) => t.includes('additional_artist_ids'))).toBe(true);
        // The kNN SELECT no longer emits the bare album-parent join as artist_id.
        const knnMain = texts.find((t) => t.includes('ORDER BY mae.embedding'));
        expect(knnMain).toBeDefined();
        expect(knnMain).not.toContain(
            'artist.id::text                                                AS artist_id',
        );
    });

    test('a restricted boundary DOES emit both access predicates, against alias mi', async () => {
        // The mirror of the test above: proves the argument is not merely
        // accepted and dropped. `mi` is the alias contract — buildLibraryAccessFilter
        // hardcodes `mi.id` and buildAgeRatingFilter defaults to `mi`, and both
        // queries alias the candidate media_items row as `mi`.
        const { sql } = makeSmartStub({
            embeddings: BOTH_SEEDS,
            candidateFor: () => [makeCandidateRow(TRACK_ID_1)],
        });
        await buildSonicPath(sql, FROM_ID, TO_ID, 1, RESTRICTED);

        const texts = allTemplateTexts(sql);
        expect(texts.some((t) => t.includes('mf.library_group_id'))).toBe(true);
        expect(texts.some((t) => t.includes('.age_rating'))).toBe(true);
        // Both filters correlate on the candidate row's `mi` alias. The alias
        // reaches the template as an `sql('mi')` Identifier, so the raw
        // template text carries a gap where it is spliced — assert around it.
        expect(texts.some((t) => t.includes('mfi.media_item_id = '))).toBe(true);
        // ...and the queries they are spliced into really do alias it that way.
        expect(texts.some((t) => t.includes('JOIN media_items mi'))).toBe(true);
    });

    test('a restricted boundary carries the real denied ids and age ceiling as parameters', async () => {
        const { sql } = makeSmartStub({
            embeddings: BOTH_SEEDS,
            candidateFor: () => [makeCandidateRow(TRACK_ID_1)],
        });
        await buildSonicPath(sql, FROM_ID, TO_ID, 1, RESTRICTED);

        // Same reason as allTemplateTexts(): vi.mocked() over postgres.Sql blows
        // TypeScript's instantiation depth on the tagged-template overloads.
        const params = (
            sql as unknown as { mock: { calls: readonly unknown[][] } }
        ).mock.calls.flatMap((c) => c.slice(1));
        expect(params).toContainEqual(['dddddddd-eeee-4fff-8000-111111111111']);
        expect(params).toContain(13);
    });

    test('the restricted bridge is a STRICT SUBSET of the unrestricted one', async () => {
        // Differential check. The same fixture is walked twice; the restricted
        // run has one candidate withheld (as a real access predicate would), so
        // its result must be a proper subset of the unrestricted run's. This is
        // what catches a boundary that arrives but is never applied: an ignored
        // argument makes the two runs identical and fails the strictness assert.
        const idForStep = (i: number): string =>
            `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

        const options: SmartStubOptions = {
            embeddings: BOTH_SEEDS,
            // Distinct artist + title per step so neither the artist cap nor the
            // title-dedup window triggers a retry. The ONLY difference between
            // the two runs is `filtered` — which is true only when the boundary
            // really reached the kNN query as a spliced predicate.
            candidateFor: (i, filtered) =>
                filtered && i === 0
                    ? []
                    : [makeCandidateRow(idForStep(i), `artist-${i}`, `Track ${i}`)],
        };

        const open = await buildSonicPath(
            makeSmartStub(options).sql,
            FROM_ID,
            TO_ID,
            3,
            UNRESTRICTED_CTX,
        );
        const openIds = open.steps.map((s) => s.media_id);
        expect(openIds).toHaveLength(3);

        // Same fixture, restricted boundary — the first candidate is withheld.
        const closed = await buildSonicPath(
            makeSmartStub(options).sql,
            FROM_ID,
            TO_ID,
            3,
            RESTRICTED,
        );
        const closedIds = closed.steps.map((s) => s.media_id);

        // Subset...
        for (const id of closedIds) expect(openIds).toContain(id);
        // ...and STRICTLY so.
        expect(closedIds.length).toBeLessThan(openIds.length);
        expect(closedIds).not.toContain(openIds[0]);
    });

    test('a closed boundary degrades to an empty bridge — the retry loop terminates', async () => {
        // findNearestToWaypoint returning null breaks the per-step retry loop
        // immediately, so a boundary that filters out every candidate can never
        // spin the 10-attempt loop forever. Exercised with a restricted (not
        // denyAll) boundary so the short-circuit above is NOT what saves us: the
        // queries really do run and really do come back empty.
        const { sql, knnCount } = makeSmartStub({
            embeddings: BOTH_SEEDS,
            candidateFor: () => [], // every candidate filtered out by the boundary
        });

        const result = await buildSonicPath(sql, FROM_ID, TO_ID, 20, RESTRICTED);
        expect(result.steps).toHaveLength(0);
        expect(result.missingEmbedding).toBeNull();
        // Exactly ONE kNN attempt per step. A loop that kept retrying on a null
        // candidate would issue up to 10 per step (200 total).
        expect(knnCount()).toBe(20);
    });

    test('a restricted boundary cannot bootstrap a bridge from a seed it may not read', async () => {
        // Seed reads are inside the boundary: fetchSeedEmbedding applies the same
        // filters, so a caller that skipped a route-level checkMediaAccess still
        // cannot use an inaccessible track as a bridge endpoint.
        const { sql, knnCount } = makeSmartStub({
            // The `from` seed is filtered out by the boundary; `to` is visible.
            embeddings: { [TO_ID]: TO_EMBED },
            candidateFor: () => [makeCandidateRow(TRACK_ID_1)],
        });
        const result = await buildSonicPath(sql, FROM_ID, TO_ID, 3, RESTRICTED);
        expect(result.missingEmbedding).toBe('from');
        expect(result.steps).toHaveLength(0);
        // No bridge was walked at all.
        expect(knnCount()).toBe(0);
    });
});
