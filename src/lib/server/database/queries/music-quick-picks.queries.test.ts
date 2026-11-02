// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for music-quick-picks.queries.ts — getSonicTracksNearCentroid.
 *
 * Tests verify guard behaviour (empty / non-finite centroid, empty excludeIds)
 * and that the query uses the correct embedding table + model_id column.
 *
 * No real database connection is used.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { UserId } from '$lib/shared/user-id.js';

// ---------------------------------------------------------------------------
// Builder mocks — return empty fragments so tagged-template calls compile.
// ---------------------------------------------------------------------------

vi.mock('./builders/library-access.builder.js', () => ({
    buildLibraryAccessFilter: () => ({ strings: [], values: [] }),
}));

vi.mock('./builders/age-rating.builder.js', () => ({
    buildAgeRatingFilter: () => ({ strings: [], values: [] }),
}));

// Fragment mocks — return an object that acts as a postgres fragment.
// Explicit factory, so every export this module actually imports must be
// listed here — omitting one is an IMPORT-TIME throw, which vitest reports as
// the file having no tests rather than as a failing assertion. That is how
// `trackArtistIdSql` landing in 91aa562d9 took this file out.
vi.mock('./fragments/music-artist.fragments.js', () => ({
    trackDisplayArtistSql: () => ({ strings: [], values: [] }),
    trackArtistIdSql: () => ({ strings: [], values: [] }),
}));

vi.mock('./fragments/music-file-path.fragments.js', () => ({
    trackFilePathJoin: () => ({ strings: [], values: [] }),
}));

// ---------------------------------------------------------------------------
// Fake sql helper
// ---------------------------------------------------------------------------

type SqlCall = { strings: string[]; values: unknown[] };

function makeFakeSql(): { sql: ReturnType<typeof vi.fn>; calls: SqlCall[] } {
    const calls: SqlCall[] = [];
    const sql = vi.fn((...args: unknown[]): unknown => {
        if (Array.isArray(args[0]) && 'raw' in (args[0] as object)) {
            const strings = args[0] as string[];
            const values = args.slice(1);
            calls.push({ strings: [...strings], values });
            return Promise.resolve([]);
        }
        return Promise.resolve([]);
    });
    // The HNSW ef_search fix wraps the centroid queries in `sql.begin(...)` so
    // `SET LOCAL hnsw.ef_search` scopes to the query's own transaction. The
    // callback is invoked with `sql` itself (not a separate mock) so calls
    // made via `tx\`...\`` inside the callback are still recorded above.
    (sql as unknown as Record<string, unknown>).begin = vi.fn(
        async (callback: (tx: unknown) => Promise<unknown>) => callback(sql),
    );
    return { sql, calls };
}

// ---------------------------------------------------------------------------
// getSonicTracksNearCentroid tests
// ---------------------------------------------------------------------------

describe('getSonicTracksNearCentroid', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    test('returns [] immediately when centroid is empty', async () => {
        const { sql } = makeFakeSql();
        const { getSonicTracksNearCentroid } = await import('./music-quick-picks.queries.js');

        const result = await getSonicTracksNearCentroid(
            sql as unknown as Parameters<typeof getSonicTracksNearCentroid>[0],
            'user1' as UserId,
            [],
            [],
        );

        expect(result).toEqual([]);
        expect(sql).not.toHaveBeenCalled();
    });

    test('returns [] immediately when centroid contains non-finite values', async () => {
        const { sql } = makeFakeSql();
        const { getSonicTracksNearCentroid } = await import('./music-quick-picks.queries.js');

        const result = await getSonicTracksNearCentroid(
            sql as unknown as Parameters<typeof getSonicTracksNearCentroid>[0],
            'user1' as UserId,
            [0.5, NaN, 0.1],
            [],
        );

        expect(result).toEqual([]);
        expect(sql).not.toHaveBeenCalled();
    });

    test('issues a query for a valid centroid', async () => {
        const { sql } = makeFakeSql();
        const { getSonicTracksNearCentroid } = await import('./music-quick-picks.queries.js');

        await getSonicTracksNearCentroid(
            sql as unknown as Parameters<typeof getSonicTracksNearCentroid>[0],
            'user1' as UserId,
            [0.5, 0.5],
            [],
        );

        expect(sql).toHaveBeenCalled();
    });

    test('query text references media_audio_embeddings, not media_embeddings', async () => {
        const { sql, calls } = makeFakeSql();
        const { getSonicTracksNearCentroid } = await import('./music-quick-picks.queries.js');

        await getSonicTracksNearCentroid(
            sql as unknown as Parameters<typeof getSonicTracksNearCentroid>[0],
            'user1' as UserId,
            [0.1, 0.2, 0.3],
            [],
        );

        const allText = calls.flatMap((c) => c.strings).join(' ');
        expect(allText).toContain('media_audio_embeddings');
        expect(allText).not.toContain('media_embeddings me');
    });

    test('query text does NOT reference source = music (that is the metadata path)', async () => {
        const { sql, calls } = makeFakeSql();
        const { getSonicTracksNearCentroid } = await import('./music-quick-picks.queries.js');

        await getSonicTracksNearCentroid(
            sql as unknown as Parameters<typeof getSonicTracksNearCentroid>[0],
            'user1' as UserId,
            [0.1, 0.2],
            [],
        );

        const allText = calls.flatMap((c) => c.strings).join(' ');
        expect(allText).not.toContain("source = 'music'");
    });

    test('substitutes a sentinel UUID array when excludeIds is empty', async () => {
        const { sql, calls } = makeFakeSql();
        const { getSonicTracksNearCentroid } = await import('./music-quick-picks.queries.js');

        await getSonicTracksNearCentroid(
            sql as unknown as Parameters<typeof getSonicTracksNearCentroid>[0],
            'user1' as UserId,
            [0.5],
            [],
        );

        // safeExclude is interpolated as a JS array param (postgres.js passes
        // it through as-is), so allValues contains the array itself.
        const allValues = calls.flatMap((c) => c.values);
        const sentinelFound = allValues.some(
            (v) =>
                Array.isArray(v) &&
                v.length === 1 &&
                v[0] === '00000000-0000-0000-0000-000000000000',
        );
        expect(sentinelFound).toBe(true);
    });

    test('passes provided excludeIds through to the query', async () => {
        const { sql, calls } = makeFakeSql();
        const { getSonicTracksNearCentroid } = await import('./music-quick-picks.queries.js');

        const excludeIds = ['id-aaa', 'id-bbb'];
        await getSonicTracksNearCentroid(
            sql as unknown as Parameters<typeof getSonicTracksNearCentroid>[0],
            'user1' as UserId,
            [0.5],
            excludeIds,
        );

        const allValues = calls.flatMap((c) => c.values);
        expect(allValues).toContain(excludeIds);
    });
});

// =============================================================================
// getPopularHitTracks — sentinel UUID substitution (mirrors the pattern used
// for the centroid queries above)
// =============================================================================

describe('getPopularHitTracks', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    test('substitutes a sentinel UUID array when excludeIds is empty', async () => {
        const { sql, calls } = makeFakeSql();
        const { getPopularHitTracks } = await import('./music-quick-picks.queries.js');

        await getPopularHitTracks(
            sql as unknown as Parameters<typeof getPopularHitTracks>[0],
            'user1' as UserId,
            [],
        );

        const allValues = calls.flatMap((c) => c.values);
        const sentinelFound = allValues.some(
            (v) =>
                Array.isArray(v) &&
                v.length === 1 &&
                v[0] === '00000000-0000-0000-0000-000000000000',
        );
        expect(sentinelFound).toBe(true);
    });

    test('passes provided excludeIds through to the query', async () => {
        const { sql, calls } = makeFakeSql();
        const { getPopularHitTracks } = await import('./music-quick-picks.queries.js');

        const excludeIds = ['id-aaa', 'id-bbb'];
        await getPopularHitTracks(
            sql as unknown as Parameters<typeof getPopularHitTracks>[0],
            'user1' as UserId,
            excludeIds,
        );

        const allValues = calls.flatMap((c) => c.values);
        expect(allValues).toContain(excludeIds);
    });

    test('reads the precomputed ranking instead of recomputing the score', async () => {
        const { sql, calls } = makeFakeSql();
        const { getPopularHitTracks } = await import('./music-quick-picks.queries.js');

        await getPopularHitTracks(
            sql as unknown as Parameters<typeof getPopularHitTracks>[0],
            'user1' as UserId,
            [],
        );

        const allText = calls.flatMap((c) => c.strings).join(' ');
        expect(allText).toContain('music_popularity_rank');
        // The score is precomputed by music_popularity_rank_rebuild (migration
        // 16.238.0). Recomputing it here would restore the cross-row product
        // that no index can serve -- 27,838 rows walked and top-N heapsorted
        // per request.
        expect(allText).not.toContain('normalized_score');
        expect(allText).not.toContain('track_in_artist');
    });

    test('orders by the projection columns, in the index order, so the walk can stop early', async () => {
        const { sql, calls } = makeFakeSql();
        const { getPopularHitTracks } = await import('./music-quick-picks.queries.js');

        await getPopularHitTracks(
            sql as unknown as Parameters<typeof getPopularHitTracks>[0],
            'user1' as UserId,
            [],
        );

        const allText = calls
            .flatMap((c) => c.strings)
            .join(' ')
            .replace(/\s+/g, ' ');
        // Must match idx_music_popularity_rank_order's columns AND directions
        // exactly. Any divergence silently reintroduces a sort over the whole
        // ranked set -- same rows returned, so only the plan would show it.
        expect(allText).toContain(
            'ORDER BY mpr.effective_score DESC, mpr.raw_playcount DESC NULLS LAST',
        );
    });

    test('excludes played tracks via NOT EXISTS, not a LEFT JOIN .. IS NULL', async () => {
        const { sql, calls } = makeFakeSql();
        const { getPopularHitTracks } = await import('./music-quick-picks.queries.js');

        await getPopularHitTracks(
            sql as unknown as Parameters<typeof getPopularHitTracks>[0],
            'user1' as UserId,
            [],
        );

        // Strip `--` comments before asserting: the rule is about the SQL,
        // and the code comment above this predicate necessarily NAMES the
        // spelling it forbids. Asserting over the raw text would fail on the
        // documentation explaining why the assertion exists.
        const sqlOnly = calls
            .flatMap((c) => c.strings)
            .join(' ')
            .replace(/--[^\n]*/g, ' ')
            .replace(/\s+/g, ' ');
        // The two spellings return identical rows, so no row-level assertion
        // can tell them apart -- but the LEFT JOIN form mis-estimates by four
        // orders of magnitude (2 vs 13,243), which makes the planner abandon
        // the ordered index walk and sort the library instead. Measured on
        // prod: 47ms for the LEFT JOIN spelling, 0.8ms for this one.
        expect(sqlOnly).toContain('NOT EXISTS');
        expect(sqlOnly).not.toContain('LEFT JOIN user_music_state');
    });
});

// =============================================================================
// getNeverPlayedSonicTracksNearCentroid — guard behaviour mirrors getSonicTracksNearCentroid
// =============================================================================

describe('getNeverPlayedSonicTracksNearCentroid', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    test('returns empty array for empty centroid', async () => {
        const { sql } = makeFakeSql();
        const { getNeverPlayedSonicTracksNearCentroid } =
            await import('./music-quick-picks.queries.js');
        const result = await getNeverPlayedSonicTracksNearCentroid(
            sql as unknown as Parameters<typeof getNeverPlayedSonicTracksNearCentroid>[0],
            'user1' as UserId,
            [],
            [],
        );
        expect(result).toEqual([]);
    });

    test('returns empty array when centroid contains non-finite values', async () => {
        const { sql } = makeFakeSql();
        const { getNeverPlayedSonicTracksNearCentroid } =
            await import('./music-quick-picks.queries.js');
        const result = await getNeverPlayedSonicTracksNearCentroid(
            sql as unknown as Parameters<typeof getNeverPlayedSonicTracksNearCentroid>[0],
            'user1' as UserId,
            [NaN, 0.5],
            [],
        );
        expect(result).toEqual([]);
    });

    test('substitutes sentinel UUID when excludeIds is empty', async () => {
        const { sql, calls } = makeFakeSql();
        const { getNeverPlayedSonicTracksNearCentroid } =
            await import('./music-quick-picks.queries.js');
        await getNeverPlayedSonicTracksNearCentroid(
            sql as unknown as Parameters<typeof getNeverPlayedSonicTracksNearCentroid>[0],
            'user1' as UserId,
            [0.5],
            [],
        );
        const allValues = calls.flatMap((c) => c.values);
        const sentinelFound = allValues.some(
            (v) =>
                Array.isArray(v) &&
                v.length === 1 &&
                v[0] === '00000000-0000-0000-0000-000000000000',
        );
        expect(sentinelFound).toBe(true);
    });

    test('issues a SQL query when given a valid centroid', async () => {
        const { sql, calls } = makeFakeSql();
        const { getNeverPlayedSonicTracksNearCentroid } =
            await import('./music-quick-picks.queries.js');
        await getNeverPlayedSonicTracksNearCentroid(
            sql as unknown as Parameters<typeof getNeverPlayedSonicTracksNearCentroid>[0],
            'user1' as UserId,
            [0.1, 0.2, 0.3],
            ['exclude-uuid'],
        );
        expect(calls.length).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// quickPickQualityFilter — candidate-quality gate
// ---------------------------------------------------------------------------

/**
 * The shared makeFakeSql() resolves to rows; a FRAGMENT builder needs the raw
 * template parts back instead, so these tests use their own tagged-template
 * capture.
 */
function fragmentSql(): never {
    // postgres.js MERGES a nested fragment into its parent's SQL. A fake that
    // stores it as an opaque value would hide the nested text, so a test
    // asserting on composed fragments would pass while seeing nothing. Flatten
    // nested {strings,values} the way the driver does.
    const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
        const out: string[] = [strings[0]];
        const flatValues: unknown[] = [];
        for (let i = 0; i < values.length; i++) {
            const v = values[i];
            if (
                v &&
                typeof v === 'object' &&
                Array.isArray((v as { strings?: string[] }).strings)
            ) {
                const nested = v as { strings: string[]; values: unknown[] };
                out[out.length - 1] += nested.strings.join(' ');
                flatValues.push(...nested.values);
                out[out.length - 1] += strings[i + 1];
            } else {
                flatValues.push(v);
                out.push(strings[i + 1]);
            }
        }
        return { strings: out, values: flatValues };
    };
    return tag as unknown as never;
}

describe('quickPickQualityFilter', () => {
    test('emits both halves of the gate: title patterns and genre presence', async () => {
        const { quickPickQualityFilter } = await import('./music-quick-picks.queries.js');
        const frag = quickPickQualityFilter(fragmentSql());
        const text = (frag as unknown as { strings: string[] }).strings.join(' ');

        // Visible symptom: the three file-naming residue shapes measured on prod.
        // POSIX classes, not backslash escapes — a template literal eats \. and
        // \s and the regex silently degenerates. This assertion is the guard.
        expect(text).toContain("!~ '^[0-9]+[.][[:space:]]'");
        expect(text).toContain("!~ '[[:space:]]-[[:space:]][0-9]{2}[[:space:]]-[[:space:]]'");
        // A trailing "(YYYY)" is NOT residue — "Dear Mama (1995)" is a real
        // title. Shipped briefly, reverted; this asserts it stays out.
        expect(text).not.toContain('[12][0-9]{3}');
        expect(text).not.toContain(".s'");
        // Cause: a genre-less track's metadata vector is built from almost
        // nothing and matches every centroid.
        expect(text).toContain("jsonb_typeof(track.custom_metadata->'genre') = 'array'");
        expect(text).toContain("jsonb_array_length(track.custom_metadata->'genre') > 0");
    });

    test('honours the mi alias', async () => {
        const { quickPickQualityFilter } = await import('./music-quick-picks.queries.js');
        const frag = quickPickQualityFilter(fragmentSql(), 'mi');
        const text = (frag as unknown as { strings: string[] }).strings.join(' ');
        expect(text).toContain('mi.title');
        expect(text).not.toContain('track.title');
    });

    test('carries no bound values, so it cannot glue onto an adjacent fragment', async () => {
        // postgres.js concatenates `${a}${b}` with NO separator: a fragment
        // ending in a placeholder followed by one starting with a keyword
        // renders as "$3AND", which only fails at runtime. This fragment is
        // pure text, so it is safe in any position.
        const { quickPickQualityFilter } = await import('./music-quick-picks.queries.js');
        const frag = quickPickQualityFilter(fragmentSql());
        expect((frag as unknown as { values: unknown[] }).values).toHaveLength(0);
    });

    test('starts on its own line so it never abuts the preceding predicate', async () => {
        const { quickPickQualityFilter } = await import('./music-quick-picks.queries.js');
        const frag = quickPickQualityFilter(fragmentSql());
        const first = (frag as unknown as { strings: string[] }).strings[0];
        expect(first.startsWith('\n')).toBe(true);
    });
});

describe('quickPickTitleFilter', () => {
    test('carries the residue patterns without the genre requirement', async () => {
        const { quickPickTitleFilter } = await import('./music-quick-picks.queries.js');
        const text = (
            quickPickTitleFilter(fragmentSql()) as unknown as { strings: string[] }
        ).strings.join(' ');
        expect(text).toContain("!~ '^[0-9]+[.][[:space:]]'");
        expect(text).toContain("!~ '[[:space:]]-[[:space:]][0-9]{2}[[:space:]]-[[:space:]]'");
        // co-album selects by album membership, not by an embedding, so a
        // missing genre says nothing about candidate quality there.
        expect(text).not.toContain('genre');
    });
});
