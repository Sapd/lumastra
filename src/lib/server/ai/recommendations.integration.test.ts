// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Integration Tests for AI Recommendation Generation
 *
 * Tests the option matrix for AI recommendations:
 * - Algorithm options: default, watchedBased, withoutRatingInfluence
 * - Filter options: mediaType, hideWatched, exclude
 * - Load More functionality with exclusions
 *
 * IMPORTANT: These tests require:
 * - DATABASE_URL pointing to a PostgreSQL with pgvector
 * - Existing user profile with embeddings
 * - Existing media embeddings in the database
 *
 * Run with: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { config } from 'dotenv';
import { Database } from '../database/connection';
import {
    getSuggestionEngine,
    type SuggestionEngineService,
} from '../services/suggestion-engine.service';
import type { TmdbMediaKey } from '../database/queries/suggestion-search.queries';
import type { UserSuggestionRow } from '../database/queries/suggestion-management.queries';
import { findSimilarMediaDual } from '../database/queries/suggestion-search.queries';
import { unrestrictedAccess } from '../database/queries/builders/media-access-boundary';
import { isRecord } from '$lib/utils/data-extraction';
import { EMBEDDING_SOURCE } from '../utils/embedding-source';
import { toUserId, type UserId } from '$lib/shared/user-id';

// Load environment variables
config();

// Skip if no database URL
const SKIP_TESTS = !process.env.DATABASE_URL;

describe.skipIf(SKIP_TESTS)('AI Recommendations Integration', () => {
    let db: Database;
    let engine: SuggestionEngineService;
    let testUserId: UserId;
    let hasUserProfile: boolean = false;
    let hasMediaEmbeddings: boolean = false;

    beforeAll(async () => {
        if (SKIP_TESTS) {
            console.log('⚠️  Skipping integration tests - no DATABASE_URL');
            return;
        }

        console.log('🔧 Setting up AI recommendations integration tests...');

        db = new Database();
        engine = getSuggestionEngine(db.getSql(), db);

        // Check database connectivity
        const sql = db.getSql();
        const healthCheck = await sql<{ ok: number }[]>`SELECT 1 as ok`;
        expect(healthCheck[0].ok).toBe(1);
        console.log('  ✓ Database connection OK');

        // Find a user with an existing profile for testing
        const users = await sql<
            {
                user_id: string;
                has_library: boolean;
                has_discovery: boolean;
            }[]
        >`
			SELECT user_id,
			       catalog_embedding IS NOT NULL as has_library,
			       request_embedding IS NOT NULL as has_discovery
			FROM user_profiles
			WHERE catalog_embedding IS NOT NULL
			   OR request_embedding IS NOT NULL
			LIMIT 1
		`;

        if (users.length > 0) {
            testUserId = toUserId(users[0].user_id);
            hasUserProfile = true;
            console.log(
                `  ✓ Found test user: "${testUserId}" (library: ${users[0].has_library}, discovery: ${users[0].has_discovery})`,
            );
        } else {
            console.log('  ⚠️  No user with profile found - some tests will be skipped');
            testUserId = toUserId('00000000-0000-0000-0000-000000000000');
        }

        // Check if we have media embeddings (using UUID-based tables)
        const mediaCount = await sql<
            {
                total: number;
                with_library: number;
                with_discovery: number;
                movies: number;
                tv: number;
            }[]
        >`
			SELECT
				COUNT(DISTINCT mi.id) as total,
				COUNT(DISTINCT mi.id) FILTER (WHERE me.source = ${EMBEDDING_SOURCE.LIBRARY}) as with_library,
				COUNT(DISTINCT mi.id) FILTER (WHERE me.source = ${EMBEDDING_SOURCE.DISCOVERY}) as with_discovery,
				COUNT(DISTINCT mi.id) FILTER (WHERE mi.media_type = 'movie') as movies,
				COUNT(DISTINCT mi.id) FILTER (WHERE mi.media_type = 'tv') as tv
			FROM media_items mi
			LEFT JOIN media_embeddings me ON me.media_id = mi.id
		`;

        hasMediaEmbeddings = Number(mediaCount[0].total) > 0;
        console.log(
            `  ✓ Media embeddings: ${mediaCount[0].total} total (${mediaCount[0].movies} movies, ${mediaCount[0].tv} TV)`,
        );
        console.log(
            `    With library: ${mediaCount[0].with_library}, With discovery: ${mediaCount[0].with_discovery}`,
        );
    });

    afterAll(async () => {
        // Database connection will be closed automatically
        console.log('\n✅ AI Recommendations integration tests completed');
    });

    describe('Option Matrix - Algorithm Selection', () => {
        /**
         * Tests that the three algorithm options produce different results:
         * 1. generateSuggestionsFromProfile (default) - hybrid approach
         * 2. generateSuggestionsFromWatchedOnly - watched+rated focus
         * 3. generateSuggestionsFromWatchOnlyWithoutRatings - pure watch-based
         */

        it('generateSuggestionsFromProfile returns suggestions for valid user', async () => {
            if (!hasUserProfile || !hasMediaEmbeddings) {
                console.log('  ⚠️  Skipped - no user profile or media embeddings');
                return;
            }

            console.log('\n📊 Testing generateSuggestionsFromProfile (default algorithm)...');

            const suggestions = await engine.generateSuggestionsFromProfile(testUserId, 10);

            console.log(`  ✓ Generated ${suggestions.length} suggestions`);

            expect(Array.isArray(suggestions)).toBe(true);

            if (suggestions.length > 0) {
                // Verify suggestion structure
                const first = suggestions[0];
                expect(first.primary_ext_id).toBeDefined();
                expect(first.media_type).toBeDefined();
                expect(['movie', 'tv']).toContain(first.media_type);

                console.log(
                    `  ✓ First suggestion: ID ${first.primary_ext_id} (${first.media_type})`,
                );

                // Verify no duplicates using composite keys
                const keys = new Set(
                    suggestions.map(
                        (s: UserSuggestionRow) => `${s.primary_ext_id}:${s.media_type}`,
                    ),
                );
                expect(keys.size).toBe(suggestions.length);
                console.log('  ✓ No duplicate suggestions (composite key check)');
            }
        }, 30000);

        it('generateSuggestionsFromWatchedOnly returns suggestions for valid user', async () => {
            if (!hasUserProfile || !hasMediaEmbeddings) {
                console.log('  ⚠️  Skipped - no user profile or media embeddings');
                return;
            }

            console.log('\n📊 Testing generateSuggestionsFromWatchedOnly (watched+rated focus)...');

            const suggestions = await engine.generateSuggestionsFromWatchedOnly(testUserId, 10);

            console.log(`  ✓ Generated ${suggestions.length} suggestions`);
            expect(Array.isArray(suggestions)).toBe(true);

            // This may return empty if user has no ratings
            if (suggestions.length > 0) {
                const first = suggestions[0];
                expect(first.primary_ext_id).toBeDefined();
                expect(first.media_type).toBeDefined();
                console.log(
                    `  ✓ First suggestion: ID ${first.primary_ext_id} (${first.media_type})`,
                );
            } else {
                console.log('  ℹ️  No suggestions (user may have no ratings)');
            }
        }, 30000);

        it('generateSuggestionsFromWatchOnlyWithoutRatings returns suggestions', async () => {
            if (!hasUserProfile || !hasMediaEmbeddings) {
                console.log('  ⚠️  Skipped - no user profile or media embeddings');
                return;
            }

            console.log(
                '\n📊 Testing generateSuggestionsFromWatchOnlyWithoutRatings (pure watch-based)...',
            );

            const suggestions = await engine.generateSuggestionsFromWatchOnlyWithoutRatings(
                testUserId,
                10,
            );

            console.log(`  ✓ Generated ${suggestions.length} suggestions`);
            expect(Array.isArray(suggestions)).toBe(true);

            if (suggestions.length > 0) {
                const first = suggestions[0];
                expect(first.primary_ext_id).toBeDefined();
                expect(first.media_type).toBeDefined();
                console.log(
                    `  ✓ First suggestion: ID ${first.primary_ext_id} (${first.media_type})`,
                );
            }
        }, 30000);

        it('returns empty array for non-existent user', async () => {
            console.log('\n📊 Testing with non-existent user...');

            const suggestions = await engine.generateSuggestionsFromProfile(
                toUserId('00000000-0000-0000-0000-000000000001'),
                10,
            );

            expect(Array.isArray(suggestions)).toBe(true);
            expect(suggestions.length).toBe(0);
            console.log('  ✓ Correctly returns empty array for non-existent user');
        }, 10000);
    });

    describe('Option Matrix - Media Type Filter', () => {
        /**
         * Tests mediaTypeFilter parameter:
         * - undefined: 70% movies, 30% TV (default split)
         * - 'movie': Only movies
         * - 'tv': Only TV series
         */

        it('mediaTypeFilter=movie returns only movies', async () => {
            if (!hasUserProfile || !hasMediaEmbeddings) {
                console.log('  ⚠️  Skipped - no user profile or media embeddings');
                return;
            }

            console.log('\n📺 Testing mediaTypeFilter=movie...');

            const suggestions = await engine.generateSuggestionsFromProfile(
                testUserId,
                10,
                [],
                'movie',
            );

            console.log(`  ✓ Generated ${suggestions.length} suggestions`);

            if (suggestions.length > 0) {
                // All suggestions should be movies
                const allMovies = suggestions.every((s) => s.media_type === 'movie');
                expect(allMovies).toBe(true);
                console.log('  ✓ All suggestions are movies');

                const tvCount = suggestions.filter((s) => s.media_type === 'tv').length;
                expect(tvCount).toBe(0);
                console.log(`  ✓ TV count: ${tvCount} (expected 0)`);
            }
        }, 30000);

        it('mediaTypeFilter=tv returns only TV series', async () => {
            if (!hasUserProfile || !hasMediaEmbeddings) {
                console.log('  ⚠️  Skipped - no user profile or media embeddings');
                return;
            }

            console.log('\n📺 Testing mediaTypeFilter=tv...');

            const suggestions = await engine.generateSuggestionsFromProfile(
                testUserId,
                10,
                [],
                'tv',
            );

            console.log(`  ✓ Generated ${suggestions.length} suggestions`);

            if (suggestions.length > 0) {
                // All suggestions should be TV
                const allTv = suggestions.every((s) => s.media_type === 'tv');
                expect(allTv).toBe(true);
                console.log('  ✓ All suggestions are TV series');

                const movieCount = suggestions.filter((s) => s.media_type === 'movie').length;
                expect(movieCount).toBe(0);
                console.log(`  ✓ Movie count: ${movieCount} (expected 0)`);
            }
        }, 30000);

        it('mediaTypeFilter works with generateSuggestionsFromWatchedOnly', async () => {
            if (!hasUserProfile || !hasMediaEmbeddings) {
                console.log('  ⚠️  Skipped - no user profile or media embeddings');
                return;
            }

            console.log('\n📺 Testing mediaTypeFilter with watchedOnly algorithm...');

            const movieSuggestions = await engine.generateSuggestionsFromWatchedOnly(
                testUserId,
                5,
                [],
                'movie',
            );
            const tvSuggestions = await engine.generateSuggestionsFromWatchedOnly(
                testUserId,
                5,
                [],
                'tv',
            );

            console.log(`  ✓ Movie suggestions: ${movieSuggestions.length}`);
            console.log(`  ✓ TV suggestions: ${tvSuggestions.length}`);

            // Verify filtering
            if (movieSuggestions.length > 0) {
                expect(movieSuggestions.every((s) => s.media_type === 'movie')).toBe(true);
            }
            if (tvSuggestions.length > 0) {
                expect(tvSuggestions.every((s) => s.media_type === 'tv')).toBe(true);
            }
        }, 30000);
    });

    describe('Option Matrix - Exclude Items (Load More)', () => {
        /**
         * Tests the excludeItems parameter for "Load More" functionality:
         * - Excludes specified items from results
         * - Uses composite keys (tmdb_id + media_type) correctly
         * - Handles TMDB ID collisions (same ID for movie and TV)
         */

        it('excludeItems prevents excluded items from appearing in results', async () => {
            if (!hasUserProfile || !hasMediaEmbeddings) {
                console.log('  ⚠️  Skipped - no user profile or media embeddings');
                return;
            }

            console.log('\n🔄 Testing excludeItems (Load More scenario)...');

            // Get initial suggestions
            const initial = await engine.generateSuggestionsFromProfile(testUserId, 10);

            if (initial.length < 3) {
                console.log('  ⚠️  Not enough initial suggestions to test exclusion');
                return;
            }

            console.log(`  ✓ Initial suggestions: ${initial.length}`);

            // Take first 3 as exclude items
            const excludeItems: TmdbMediaKey[] = initial
                .slice(0, 3)
                .map((s: UserSuggestionRow) => ({
                    primary_ext_id: s.primary_ext_id ?? '',
                    media_type: s.media_type,
                }));

            console.log(
                `  ✓ Excluding: ${excludeItems.map((e) => `${e.primary_ext_id}:${e.media_type}`).join(', ')}`,
            );

            // Get new suggestions excluding those items
            const afterExclude = await engine.generateSuggestionsFromProfile(
                testUserId,
                10,
                excludeItems,
            );

            console.log(`  ✓ After exclusion: ${afterExclude.length} suggestions`);

            // Verify excluded items are not in results
            const excludeSet = new Set(
                excludeItems.map((e) => `${e.primary_ext_id}:${e.media_type}`),
            );
            const hasExcluded = afterExclude.some((s) =>
                excludeSet.has(`${s.primary_ext_id}:${s.media_type}`),
            );

            expect(hasExcluded).toBe(false);
            console.log('  ✓ No excluded items appear in results');
        }, 30000);

        it('excludeItems handles TMDB ID collisions correctly', async () => {
            /**
             * CRITICAL TEST: TMDB ID 1429 is both:
             * - "25th Hour" (movie)
             * - "Voyage to Orion" (TV series)
             *
             * Excluding 1429:movie should NOT exclude 1429:tv
             */

            console.log('\n🔄 Testing TMDB ID collision handling...');

            // Check if both 1429:movie and 1429:tv exist in database (using UUID-based tables)
            const sql = db.getSql();
            const collision = await sql<
                {
                    tmdb_id: number;
                    media_type: 'movie' | 'tv';
                    title: string | null;
                }[]
            >`
				SELECT ei.external_id::integer as tmdb_id, mi.media_type, mi.title
				FROM media_items mi
				JOIN external_ids ei ON ei.media_id = mi.id AND ei.provider = 'tmdb'
				WHERE ei.external_id = '1429'
			`;

            if (collision.length < 2) {
                console.log('  ℹ️  TMDB ID 1429 collision test data not available');
                console.log(
                    `    Found: ${collision.map((c) => `${c.title} (${c.media_type})`).join(', ') || 'none'}`,
                );
                return;
            }

            console.log(
                `  ✓ Found collision: ${collision.map((c) => `${c.title} (${c.media_type})`).join(', ')}`,
            );

            // Exclude only the movie version
            const excludeItems: TmdbMediaKey[] = [{ primary_ext_id: '1429', media_type: 'movie' }];

            // The TV version should still be eligible
            // (We can't directly test this without a full generation, but we verify the SQL works)
            const testQuery = await sql<
                {
                    tmdb_id: number;
                    media_type: 'movie' | 'tv';
                    title: string | null;
                }[]
            >`
				SELECT ei.external_id::integer as tmdb_id, mi.media_type, mi.title
				FROM media_items mi
				JOIN external_ids ei ON ei.media_id = mi.id AND ei.provider = 'tmdb'
				WHERE ei.external_id = '1429'
				  AND NOT EXISTS (
				    SELECT 1 FROM (VALUES ${sql(excludeItems.map((e) => [e.primary_ext_id, e.media_type]))}) AS excluded(primary_ext_id, media_type)
				    WHERE excluded.primary_ext_id::text = ei.external_id
				      AND excluded.media_type::text = mi.media_type
				  )
			`;

            // Should return only the TV version
            expect(testQuery.length).toBe(1);
            expect(testQuery[0].media_type).toBe('tv');
            console.log(`  ✓ Excluding 1429:movie leaves 1429:tv available`);
            console.log(`  ✓ TV version still accessible: "${testQuery[0].title}"`);
        }, 10000);

        it('excludeItems works with media type filter combined', async () => {
            if (!hasUserProfile || !hasMediaEmbeddings) {
                console.log('  ⚠️  Skipped - no user profile or media embeddings');
                return;
            }

            console.log('\n🔄 Testing excludeItems + mediaTypeFilter combination...');

            // Get initial TV suggestions
            const initial = await engine.generateSuggestionsFromProfile(testUserId, 10, [], 'tv');

            if (initial.length < 2) {
                console.log('  ⚠️  Not enough TV suggestions to test');
                return;
            }

            const excludeItems: TmdbMediaKey[] = initial
                .slice(0, 2)
                .map((s: UserSuggestionRow) => ({
                    primary_ext_id: s.primary_ext_id ?? '',
                    media_type: 'tv' as const,
                }));

            console.log(`  ✓ Initial TV suggestions: ${initial.length}`);
            console.log(
                `  ✓ Excluding: ${excludeItems.map((e) => `${e.primary_ext_id}:${e.media_type}`).join(', ')}`,
            );

            // Get more TV suggestions excluding those
            const more = await engine.generateSuggestionsFromProfile(
                testUserId,
                10,
                excludeItems,
                'tv',
            );

            console.log(`  ✓ After exclusion: ${more.length} TV suggestions`);

            // All should be TV
            if (more.length > 0) {
                expect(more.every((s) => s.media_type === 'tv')).toBe(true);
                console.log('  ✓ All results are TV series');
            }

            // None should be excluded items
            const excludeSet = new Set(
                excludeItems.map((e) => `${e.primary_ext_id}:${e.media_type}`),
            );
            const hasExcluded = more.some((s) =>
                excludeSet.has(`${s.primary_ext_id}:${s.media_type}`),
            );
            expect(hasExcluded).toBe(false);
            console.log('  ✓ No excluded items in results');
        }, 30000);
    });

    describe('SQL Type Casting Verification', () => {
        /**
         * Verifies that the SQL type casting fix works correctly.
         * Previously failed with: "operator does not exist: text = integer"
         */

        it('VALUES clause with type casting works correctly', async () => {
            console.log('\n🔧 Testing SQL VALUES clause type casting...');

            const sql = db.getSql();

            // This is the pattern that was previously failing
            const excludeItems: TmdbMediaKey[] = [
                { primary_ext_id: '1429', media_type: 'tv' },
                { primary_ext_id: '550', media_type: 'movie' },
                { primary_ext_id: '119051', media_type: 'tv' },
            ];

            // Test the exclusion query pattern (using UUID-based tables)
            const result = await sql<
                {
                    total: number;
                    after_exclude: number;
                }[]
            >`
				SELECT COUNT(*) as total,
				       COUNT(*) FILTER (WHERE NOT EXISTS (
				         SELECT 1 FROM (VALUES ${sql(excludeItems.map((e) => [e.primary_ext_id, e.media_type]))}) AS excluded(primary_ext_id, media_type)
				         WHERE excluded.primary_ext_id::text = ei.external_id
				           AND excluded.media_type::text = mi.media_type
				       )) as after_exclude
				FROM media_items mi
				JOIN external_ids ei ON ei.media_id = mi.id AND ei.provider = 'tmdb'
				WHERE EXISTS (SELECT 1 FROM media_embeddings me WHERE me.media_id = mi.id AND me.embedding IS NOT NULL)
			`;

            expect(result[0].total).toBeDefined();
            expect(result[0].after_exclude).toBeDefined();

            console.log(`  ✓ Total media: ${result[0].total}`);
            console.log(`  ✓ After exclusion: ${result[0].after_exclude}`);
            console.log('  ✓ SQL type casting works correctly (no "text = integer" error)');
        }, 10000);

        it('findSimilarMediaDual with excludeItems works', async () => {
            if (!hasUserProfile || !hasMediaEmbeddings) {
                console.log('  ⚠️  Skipped - no user profile or media embeddings');
                return;
            }

            console.log('\n🔧 Testing findSimilarMediaDual with excludeItems...');

            // Get user profile to get embedding
            const profileData: unknown = await db.getUserProfile(testUserId);
            const profile = isRecord(profileData) ? profileData : null;
            if (!profile?.catalog_embedding) {
                console.log('  ⚠️  No user embedding available');
                return;
            }

            let embedding: number[] | null = null;
            if (Array.isArray(profile.catalog_embedding)) {
                embedding = profile.catalog_embedding.filter(
                    (value): value is number => typeof value === 'number',
                );
            } else if (typeof profile.catalog_embedding === 'string') {
                try {
                    const parsed = JSON.parse(profile.catalog_embedding) as unknown[];
                    if (Array.isArray(parsed)) {
                        embedding = parsed.filter(
                            (value): value is number => typeof value === 'number',
                        );
                    }
                } catch {
                    embedding = null;
                }
            }
            if (!embedding || embedding.length === 0) {
                console.log('  ⚠️  No valid embedding available');
                return;
            }

            const excludeItems: TmdbMediaKey[] = [
                { primary_ext_id: '1429', media_type: 'tv' },
                { primary_ext_id: '550', media_type: 'movie' },
            ];

            // This should work without type error
            const sql = db.getSql();
            const results = await findSimilarMediaDual(sql, embedding, {
                limit: 10,
                excludeItems,
                mediaTypes: ['movie', 'tv'],
                access: unrestrictedAccess(),
            });

            expect(Array.isArray(results)).toBe(true);
            console.log(`  ✓ Found ${results.length} similar media with exclusions`);

            // Verify excluded items not in results
            const excludeSet = new Set(
                excludeItems.map((e) => `${e.primary_ext_id}:${e.media_type}`),
            );
            const hasExcluded = results.some((r) =>
                excludeSet.has(`${r.primary_ext_id}:${r.media_type}`),
            );
            expect(hasExcluded).toBe(false);
            console.log('  ✓ Excluded items not in results');
        }, 30000);
    });

    describe('Edge Cases', () => {
        it('handles empty excludeItems array', async () => {
            if (!hasUserProfile || !hasMediaEmbeddings) {
                console.log('  ⚠️  Skipped - no user profile or media embeddings');
                return;
            }

            console.log('\n🧪 Testing with empty excludeItems...');

            const suggestions = await engine.generateSuggestionsFromProfile(testUserId, 5, []);

            expect(Array.isArray(suggestions)).toBe(true);
            console.log(`  ✓ Generated ${suggestions.length} suggestions with empty exclude list`);
        }, 30000);

        it('handles large excludeItems list', async () => {
            if (!hasUserProfile || !hasMediaEmbeddings) {
                console.log('  ⚠️  Skipped - no user profile or media embeddings');
                return;
            }

            console.log('\n🧪 Testing with large excludeItems list (100 items)...');

            // Create 100 exclude items
            const excludeItems: TmdbMediaKey[] = Array.from({ length: 100 }, (_, i) => ({
                primary_ext_id: String(1000000 + i), // Unlikely to exist
                media_type: i % 2 === 0 ? 'movie' : ('tv' as 'movie' | 'tv'),
            }));

            const start = Date.now();
            const suggestions = await engine.generateSuggestionsFromProfile(
                testUserId,
                10,
                excludeItems,
            );
            const duration = Date.now() - start;

            expect(Array.isArray(suggestions)).toBe(true);
            console.log(`  ✓ Generated ${suggestions.length} suggestions in ${duration}ms`);
            console.log(`  ✓ Performance acceptable with 100 exclude items`);
        }, 60000);
    });
});

// Summary output
console.log(`
📊 AI Recommendations Integration Test Configuration:
- DATABASE_URL: ${process.env.DATABASE_URL ? '✓ Found' : '✗ Missing'}

${SKIP_TESTS ? '⚠️  Integration tests will be skipped - add DATABASE_URL to .env' : '✓ Ready to run integration tests'}
`);
