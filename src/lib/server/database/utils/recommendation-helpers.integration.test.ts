// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests: recommendation-helpers saveSuggestionsToDatabase
 *
 * Focus: the persistence clear is scoped to the media types present in the
 * batch, so a single-type generation cannot wipe the other type's stored
 * suggestions (the delete-all bug that let a movie-only watched-based request
 * repopulate the pool movies-only).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
    getTestDb,
    closeTestDb,
    truncateTestTables,
} from '../../../../../tests/integration/setup/test-database.js';
import {
    createAndInsertTestMovie,
    createAndInsertTestTvShow,
} from '../../../../../tests/integration/fixtures/media.fixtures.js';
import {
    ensureTestUser,
    generateTestUserId,
} from '../../../../../tests/integration/fixtures/user.fixtures.js';
import { saveSuggestionsToDatabase, type UserSuggestionInput } from './recommendation-helpers.js';
import type { Sql } from 'postgres';

function input(primaryExtId: string, mediaType: 'movie' | 'tv'): UserSuggestionInput {
    return {
        user_id: '', // set by caller path; unused by saveSuggestionsToDatabase
        primary_ext_id: primaryExtId,
        media_type: mediaType,
        combined_score: 0.9,
        library_similarity_score: 0.8,
        discovery_similarity_score: null,
        is_available: true,
        can_request: false,
    };
}

async function countByType(sql: Sql, userId: string): Promise<{ movie: number; tv: number }> {
    const rows = await sql<{ media_type: string; n: number }[]>`
        SELECT mi.media_type, COUNT(*)::int AS n
        FROM user_suggestions us
        JOIN media_items mi ON mi.id = us.media_id
        WHERE us.user_id = ${userId}
        GROUP BY mi.media_type
    `;
    const out = { movie: 0, tv: 0 };
    for (const r of rows) {
        if (r.media_type === 'movie') out.movie = r.n;
        if (r.media_type === 'tv') out.tv = r.n;
    }
    return out;
}

describe('saveSuggestionsToDatabase (integration)', () => {
    let sql: Sql;
    const userId = generateTestUserId();
    let movieExt: string;
    let tvExt: string;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTestTables(sql, [
            'user_suggestions',
            'external_ids',
            'media_items',
            'user_profiles',
        ]);
        await ensureTestUser(sql, userId);
        const movie = await createAndInsertTestMovie(sql, { title: 'M', tmdbId: 111111 });
        const tv = await createAndInsertTestTvShow(sql, { title: 'T', tmdbId: 222222 });
        movieExt = String(movie.tmdbId);
        tvExt = String(tv.tmdbId);
    });

    it('a single-type (movie) batch leaves the other type (tv) suggestions intact', async () => {
        // Seed a TV suggestion pool first.
        await saveSuggestionsToDatabase(sql, userId, [input(tvExt, 'tv')], 2);
        expect(await countByType(sql, userId)).toEqual({ movie: 0, tv: 1 });

        // A movie-only generation must NOT wipe the TV row.
        await saveSuggestionsToDatabase(sql, userId, [input(movieExt, 'movie')], 2);
        expect(await countByType(sql, userId)).toEqual({ movie: 1, tv: 1 });
    });

    it('a single-type (movie) batch replaces only its own type', async () => {
        await saveSuggestionsToDatabase(sql, userId, [input(movieExt, 'movie')], 2);
        // Re-run the movie batch — still exactly one movie row (replaced, not duplicated).
        await saveSuggestionsToDatabase(sql, userId, [input(movieExt, 'movie')], 2);
        expect(await countByType(sql, userId)).toEqual({ movie: 1, tv: 0 });
    });

    it('a mixed batch still clears and rewrites both types', async () => {
        await saveSuggestionsToDatabase(sql, userId, [input(tvExt, 'tv')], 2);
        // Mixed batch (movie+tv): batchMediaTypes = ['movie','tv'] → clears both,
        // writes both. The prior standalone TV row is replaced, not accumulated.
        await saveSuggestionsToDatabase(
            sql,
            userId,
            [input(movieExt, 'movie'), input(tvExt, 'tv')],
            2,
        );
        expect(await countByType(sql, userId)).toEqual({ movie: 1, tv: 1 });
    });
});
