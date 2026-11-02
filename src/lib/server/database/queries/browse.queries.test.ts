// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the required-by-shape access boundary on browse queries.
 *
 * These do not need a database: they assert the `denyAll` short-circuit returns
 * an empty result WITHOUT issuing any SQL. That is the behaviour the boundary
 * migration adds — before it, these functions took a permissive-by-default
 * `deniedGroupIds?`/`ageRating?` pair, could not express "deny everything", and
 * would have run the query and hit the database regardless.
 *
 * A `sql` handle that throws on any use is passed; reaching it is the failure.
 */

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import {
    getRecentlyAddedMedia,
    getFilteredRecentlyAddedMedia,
    getMediaAlphabetical,
    getAlphabeticalBucketCounts,
    getGenreList,
    getGenreFacetCounts,
    getMediaByGenre,
    getMediaByGenreCount,
    buildBrowseGenreSections,
    getMediaByTmdbKeyword,
    getMediaByKeywordSlug,
    buildBrowseKeywordSections,
    getLocalAvailableExternalIds,
    getAvailableLibraries,
} from './browse.queries.js';
import { denyAllAccess, unrestrictedAccess } from './builders/media-access-boundary.js';

/**
 * A postgres.Sql stand-in that fails the test if used at all. Any property
 * access, call, or tagged-template use throws. Reaching it means the denyAll
 * boundary was NOT honoured before touching the database.
 */
function throwingSql(): postgres.Sql {
    const guard = new Proxy(
        function () {
            throw new Error('sql must not be invoked for a denyAll boundary');
        },
        {
            get() {
                throw new Error('sql must not be accessed for a denyAll boundary');
            },
            apply() {
                throw new Error('sql must not be invoked for a denyAll boundary');
            },
        },
    );
    return guard as unknown as postgres.Sql;
}

describe('browse.queries denyAll short-circuit (no SQL issued)', () => {
    it('getRecentlyAddedMedia returns [] and never queries', async () => {
        const sql = throwingSql();
        await expect(getRecentlyAddedMedia(sql, { access: denyAllAccess() })).resolves.toEqual([]);
    });

    it('getFilteredRecentlyAddedMedia returns [] and never queries', async () => {
        const sql = throwingSql();
        await expect(
            getFilteredRecentlyAddedMedia(sql, { access: denyAllAccess(), newness: 'titles' }),
        ).resolves.toEqual([]);
    });

    it('getMediaAlphabetical returns an empty page and never queries', async () => {
        const sql = throwingSql();
        await expect(getMediaAlphabetical(sql, { access: denyAllAccess() })).resolves.toEqual({
            items: [],
            totalCount: 0,
        });
    });

    it('getAlphabeticalBucketCounts returns [] and never queries', async () => {
        const sql = throwingSql();
        await expect(
            getAlphabeticalBucketCounts(sql, { access: denyAllAccess() }),
        ).resolves.toEqual([]);
    });

    it('getGenreFacetCounts returns [] and never queries', async () => {
        const sql = throwingSql();
        await expect(getGenreFacetCounts(sql, { access: denyAllAccess() })).resolves.toEqual([]);
    });

    it('getGenreList returns [] and never queries', async () => {
        const sql = throwingSql();
        await expect(getGenreList(sql, { access: denyAllAccess() })).resolves.toEqual([]);
    });

    it('getMediaByGenre returns [] and never queries', async () => {
        const sql = throwingSql();
        await expect(getMediaByGenre(sql, 'Action', { access: denyAllAccess() })).resolves.toEqual(
            [],
        );
    });

    it('getMediaByGenreCount returns 0 and never queries', async () => {
        const sql = throwingSql();
        await expect(
            getMediaByGenreCount(sql, 'Action', { access: denyAllAccess() }),
        ).resolves.toBe(0);
    });

    it('buildBrowseGenreSections returns an empty result and never queries', async () => {
        const sql = throwingSql();
        await expect(buildBrowseGenreSections(sql, { access: denyAllAccess() })).resolves.toEqual({
            genres: [],
            totalGenres: 0,
            hasMoreGenres: false,
        });
    });

    it('getMediaByTmdbKeyword returns [] and never queries', async () => {
        const sql = throwingSql();
        await expect(getMediaByTmdbKeyword(sql, 779, { access: denyAllAccess() })).resolves.toEqual(
            [],
        );
    });

    it('getMediaByKeywordSlug returns [] and never queries', async () => {
        const sql = throwingSql();
        await expect(
            getMediaByKeywordSlug(sql, 'time travel', { access: denyAllAccess() }),
        ).resolves.toEqual([]);
    });

    it('buildBrowseKeywordSections returns no sections and never queries', async () => {
        const sql = throwingSql();
        const result = await buildBrowseKeywordSections(sql, { access: denyAllAccess() });
        expect(result.sections).toEqual([]);
    });

    it('getLocalAvailableExternalIds returns [] and never queries', async () => {
        const sql = throwingSql();
        await expect(
            getLocalAvailableExternalIds(sql, { provider: 'tmdb', access: denyAllAccess() }),
        ).resolves.toEqual([]);
    });

    it('getAvailableLibraries returns [] and never queries', async () => {
        const sql = throwingSql();
        await expect(getAvailableLibraries(sql, denyAllAccess())).resolves.toEqual([]);
    });
});

// getGenreFacetCounts is the one function here that must NOT absorb a failure:
// its result is the entire payload of /browse/genres, so `[]` is not a neutral
// degradation — it is the assertion "this catalog has no genres", which callers
// then cache and render as an empty rail. It rethrows and each caller decides
// (500 on /browse/genres, uncached empty rail on /browse/az).
describe('getGenreFacetCounts propagates query failures', () => {
    it('rejects rather than resolving to [] when the query throws', async () => {
        const sql = throwingSql();

        await expect(getGenreFacetCounts(sql, { access: unrestrictedAccess() })).rejects.toThrow();
    });

    it('contrast: getAlphabeticalBucketCounts still degrades to [] (the letter rail is optional)', async () => {
        const sql = throwingSql();

        await expect(
            getAlphabeticalBucketCounts(sql, { access: unrestrictedAccess() }),
        ).resolves.toEqual([]);
    });
});

// A second sanity check: the functions catch-and-log on error. Confirm the
// denyAll path is a genuine pre-query short-circuit rather than an exception
// swallowed by the try/catch (which would ALSO yield []). We assert the
// throwing sql's guard is never even accessed by spying on the constructor.
describe('browse.queries denyAll is a pre-query return, not a swallowed throw', () => {
    it('does not construct or touch the sql handle', async () => {
        const access = denyAllAccess();
        const proxyGet = vi.fn(() => {
            throw new Error('touched');
        });
        const sql = new Proxy(function () {}, {
            get: proxyGet,
            apply: () => {
                throw new Error('called');
            },
        }) as unknown as postgres.Sql;

        await getRecentlyAddedMedia(sql, { access });
        await getGenreList(sql, { access });

        expect(proxyGet).not.toHaveBeenCalled();
    });
});

it('propagates alphabetical query failures so the API cannot cache an empty library', async () => {
    await expect(
        getMediaAlphabetical(throwingSql(), { access: unrestrictedAccess() }),
    ).rejects.toThrow();
});
