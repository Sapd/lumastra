// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * End-to-End Integration Test for Embedding Generation
 *
 * This test:
 * 1. Connects to real TMDB API
 * 2. Fetches actual movie data (including cast/crew)
 * 3. Generates real embeddings via OpenAI
 * 4. Tests database storage (with test database)
 *
 * Run with: npm run test:integration
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { config } from 'dotenv';
import { tmdbApi } from '../providers/implementations/tmdb/index.js';
import {
    generateDualEmbeddings,
    storeDualEmbedding,
    type JellyseerrMovieData,
} from './dual-embedding-generator';
import { createDiscoveryEmbeddingText as createJellyseerrEmbeddingText } from './embedding-text-formatter';
import { Database } from '../database/connection';
import { isRecord } from '$lib/utils/data-extraction';
import { EMBEDDING_SOURCE } from '../utils/embedding-source';

// Type definitions for TMDB API responses in tests
const toString = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;
const toNumber = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number.parseFloat(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
};
const getArrayField = (record: Record<string, unknown> | undefined, key: string): unknown[] => {
    if (!record) return [];
    const value = record[key];
    return Array.isArray(value) ? value : [];
};
const getStringField = (
    record: Record<string, unknown> | undefined,
    keys: string[],
): string | undefined => {
    if (!record) return undefined;
    for (const key of keys) {
        const value = toString(record[key]);
        if (value) return value;
    }
    return undefined;
};

// Load environment variables
config();

// These tests require real API keys and database
const SKIP_INTEGRATION_TESTS = !process.env.TMDB_API_KEY || !process.env.OPENAI_API_KEY;

const parseGenres = (details: Record<string, unknown>): Array<{ id: number; name: string }> =>
    getArrayField(details, 'genres')
        .filter(isRecord)
        .map((genre) => {
            const id = toNumber(genre.id);
            const name = toString(genre.name);
            if (id === undefined || !name) return null;
            return { id, name };
        })
        .filter((genre): genre is { id: number; name: string } => genre !== null);

const parseCast = (credits: Record<string, unknown>) =>
    getArrayField(credits, 'cast')
        .filter(isRecord)
        .filter((person) => !!toString(person.name))
        .slice(0, 10)
        .map((person) => ({
            id: toNumber(person.id) ?? 0,
            name: toString(person.name) || '',
            character: toString(person.character) || '',
            order: toNumber(person.order) ?? 999,
        }));

const parseCrew = (credits: Record<string, unknown>) =>
    getArrayField(credits, 'crew')
        .filter(isRecord)
        .filter(
            (person) =>
                !!toString(person.name) &&
                !!toString(person.job) &&
                ['Director', 'Producer', 'Writer'].includes(toString(person.job) || ''),
        )
        .map((person) => ({
            id: toNumber(person.id) ?? 0,
            name: toString(person.name) || '',
            job: toString(person.job) || '',
            department: toString(person.department) || '',
        }));

const parseKeywords = (details: Record<string, unknown>) => {
    const keywordsContainer = isRecord(details.keywords) ? details.keywords : undefined;
    return getArrayField(keywordsContainer, 'keywords')
        .filter(isRecord)
        .map((keyword) => {
            const id = toNumber(keyword.id);
            const name = toString(keyword.name);
            if (id === undefined || !name) return null;
            return { id, name };
        })
        .filter((keyword): keyword is { id: number; name: string } => keyword !== null);
};

const parseProductionCompanies = (details: Record<string, unknown>) =>
    getArrayField(details, 'production_companies')
        .filter(isRecord)
        .map((company) => {
            const id = toNumber(company.id);
            const name = toString(company.name);
            if (id === undefined || !name) return null;
            return { id, name };
        })
        .filter((company): company is { id: number; name: string } => company !== null);

const buildMovieData = (
    details: Record<string, unknown>,
    credits: Record<string, unknown>,
): JellyseerrMovieData => {
    const id = toNumber(details.id) ?? 0;
    const title = getStringField(details, ['title', 'name']) || 'Unknown Title';
    const overview = getStringField(details, ['overview']) || '';
    const releaseDate = getStringField(details, ['release_date', 'first_air_date']) || '';
    return {
        id,
        tmdbId: id,
        title,
        overview,
        releaseDate,
        genres: parseGenres(details),
        voteAverage: toNumber(details.vote_average) ?? 0,
        voteCount: toNumber(details.vote_count) ?? 0,
        popularity: toNumber(details.popularity) ?? 0,
        runtime: toNumber(details.runtime),
        mediaType: 'movie',
        originalLanguage: getStringField(details, ['original_language']) || 'en',
        originalTitle: getStringField(details, ['original_title']) || title,
        adult: typeof details.adult === 'boolean' ? details.adult : false,
        cast: parseCast(credits),
        crew: parseCrew(credits),
        keywords: parseKeywords(details),
        productionCompanies: parseProductionCompanies(details),
    };
};

describe.skipIf(SKIP_INTEGRATION_TESTS)('E2E Embedding Generation Integration', () => {
    let db: Database;
    let testMovieId: number = 603; // The Lantern - reliable test data
    let testMovieTitle: string = 'The Lantern';

    beforeAll(async () => {
        if (SKIP_INTEGRATION_TESTS) {
            console.log('⚠️  Skipping integration tests - missing API keys');
            return;
        }

        console.log('🔧 Setting up integration test environment...');

        // Initialize database connection
        db = new Database();

        // Check if we have a test database
        const dbUrl = process.env.DATABASE_URL;
        if (!dbUrl) {
            console.log('⚠️  No DATABASE_URL found, database tests will be skipped');
        } else {
            console.log('✅ Database connection ready');
        }

        // Optionally fetch a trending movie for more realistic testing
        try {
            console.log('🔥 Fetching a trending movie from TMDB...');
            const trendingData: unknown = await tmdbApi.getTrendingMoviesTimeWindow('week', 1);
            const trendingRecord = isRecord(trendingData) ? trendingData : {};
            const trendingResults = getArrayField(trendingRecord, 'results').filter(isRecord);
            if (trendingResults.length > 0) {
                // Pick a random movie from top 10 trending
                const randomIndex = Math.floor(
                    Math.random() * Math.min(10, trendingResults.length),
                );
                const selectedMovie = trendingResults[randomIndex];
                const selectedId = toNumber(selectedMovie.id);
                if (!selectedId) {
                    throw new Error('Selected trending movie missing ID');
                }
                testMovieId = selectedId;
                testMovieTitle = getStringField(selectedMovie, ['title', 'name']) || 'Unknown';
                console.log(
                    `  ✓ Selected trending movie: "${testMovieTitle}" (TMDB: ${testMovieId})`,
                );
            }
        } catch (error) {
            console.log(
                `  ℹ️  Using fallback movie (The Lantern): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    });

    it('should fetch movie data from TMDB API', async () => {
        console.log('\n🎬 Test 1: Fetching from TMDB API...');
        console.log(`  Using movie ID: ${testMovieId}`);

        const movieDetailsData: unknown = await tmdbApi.getMovieDetailsWithAppends(testMovieId, [
            'credits',
            'keywords',
        ]);
        const movieDetails = isRecord(movieDetailsData) ? movieDetailsData : {};

        const title = getStringField(movieDetails, ['title', 'name']) || 'Unknown';
        const overview = getStringField(movieDetails, ['overview']) || '';
        const releaseDate = getStringField(movieDetails, ['release_date']) || '';

        console.log(`  ✓ Fetched: "${title}"`);
        console.log(`  ✓ Overview: ${overview.substring(0, 100)}...`);
        console.log(`  ✓ Release Date: ${releaseDate}`);

        expect(toNumber(movieDetails.id)).toBe(testMovieId);
        expect(title).toBeDefined();
        expect(overview).toBeDefined();
    }, 15000);

    it('should fetch cast and crew from TMDB', async () => {
        console.log('\n👥 Test 2: Fetching cast and crew...');

        const creditsData: unknown = await tmdbApi.getMovieCredits(testMovieId);
        const credits = isRecord(creditsData) ? creditsData : {};
        const cast = getArrayField(credits, 'cast').filter(isRecord);
        const crew = getArrayField(credits, 'crew').filter(isRecord);

        expect(cast.length).toBeGreaterThan(0);
        expect(crew.length).toBeGreaterThan(0);

        console.log(`  ✓ Found ${cast.length} cast members`);
        console.log(
            `  ✓ Top cast: ${cast
                .slice(0, 3)
                .map((c) => toString(c.name))
                .filter((name): name is string => !!name)
                .join(', ')}`,
        );

        const directors = crew.filter((c) => toString(c.job) === 'Director');
        expect(directors.length).toBeGreaterThan(0);
        console.log(
            `  ✓ Found directors: ${directors
                .map((d) => toString(d.name))
                .filter((name): name is string => !!name)
                .join(', ')}`,
        );
    }, 15000);

    it('should transform TMDB data to JellyseerrMovieData format', async () => {
        console.log('\n🔄 Test 3: Transforming TMDB data...');

        const movieId = testMovieId; // The Lantern

        // Fetch details
        const detailsData: unknown = await tmdbApi.getMovieDetailsWithAppends(movieId, [
            'keywords',
        ]);
        const creditsData: unknown = await tmdbApi.getMovieCredits(movieId);
        const details = isRecord(detailsData) ? detailsData : {};
        const credits = isRecord(creditsData) ? creditsData : {};

        // Transform to our format
        const movieData: JellyseerrMovieData = buildMovieData(details, credits);

        console.log(`  ✓ Transformed: ${movieData.title}`);
        console.log(`  ✓ Genres: ${movieData.genres.map((g) => g.name).join(', ')}`);
        console.log(
            `  ✓ Cast: ${movieData.cast
                ?.slice(0, 3)
                .map((c) => c.name)
                .join(', ')}`,
        );

        expect(movieData.title).toBeDefined();
        expect(movieData.title.length).toBeGreaterThan(0);
        expect(movieData.genres.length).toBeGreaterThan(0);
        expect(movieData.cast).toBeDefined();
        expect(movieData.cast?.length ?? 0).toBeGreaterThan(0);
        expect(movieData.crew).toBeDefined();

        // Verify no undefined values in arrays
        const hasUndefinedInCast = movieData.cast?.some((c) => !c.name);
        const hasUndefinedInCrew = movieData.crew?.some((c) => !c.name || !c.job);

        expect(hasUndefinedInCast).toBe(false);
        expect(hasUndefinedInCrew).toBe(false);
        console.log(`  ✓ No undefined values in arrays`);
    }, 15000);

    it('should generate embedding text without undefined values', async () => {
        console.log('\n📝 Test 4: Generating embedding text...');

        const movieId = testMovieId; // The Lantern

        // Fetch and transform data
        const detailsData: unknown = await tmdbApi.getMovieDetailsWithAppends(movieId, [
            'keywords',
        ]);
        const creditsData: unknown = await tmdbApi.getMovieCredits(movieId);
        const details = isRecord(detailsData) ? detailsData : {};
        const credits = isRecord(creditsData) ? creditsData : {};

        const movieData: JellyseerrMovieData = buildMovieData(details, credits);

        // Generate embedding text
        const embeddingText = createJellyseerrEmbeddingText(movieData);

        console.log(`  ✓ Generated text (${embeddingText.length} chars)`);
        console.log(`  Preview: ${embeddingText.substring(0, 200)}...`);

        expect(embeddingText).toBeDefined();
        expect(embeddingText.length).toBeGreaterThan(0);
        expect(embeddingText).not.toContain('undefined');
        expect(embeddingText).not.toContain('null');

        // Verify movie data is in the text
        expect(embeddingText).toContain(movieData.title);

        // Verify cast is included in embedding text
        expect(embeddingText).toContain('Cast:');
        const firstCastMember = movieData.cast?.[0]?.name || '';
        expect(firstCastMember.length).toBeGreaterThan(0);
        expect(embeddingText).toContain(firstCastMember);
        console.log(`  ✓ Cast included: ${firstCastMember}`);

        // Verify crew/director is included
        const directors = movieData.crew?.filter((c: { job: string }) => c.job === 'Director');
        if (directors && directors.length > 0) {
            const hasDirectorLabel =
                embeddingText.includes('Director:') || embeddingText.includes('Directors:');
            expect(hasDirectorLabel).toBe(true);
            expect(embeddingText).toContain(directors[0].name);
            console.log(`  ✓ Director included: ${directors[0].name}`);
        }

        console.log(`  ✓ No 'undefined' or 'null' strings in text`);
        console.log(`  ✓ Cast and crew are included in embedding text`);
    }, 15000);

    it('should generate actual embeddings via OpenAI (slow test)', async () => {
        console.log('\n🤖 Test 5: Generating embeddings with OpenAI...');

        if (!process.env.OPENAI_API_KEY) {
            console.log('  ⚠️  Skipped - no OPENAI_API_KEY');
            return;
        }

        const movieId = testMovieId; // The Lantern

        // Fetch and transform data
        const detailsData: unknown = await tmdbApi.getMovieDetailsWithAppends(movieId, [
            'keywords',
        ]);
        const creditsData: unknown = await tmdbApi.getMovieCredits(movieId);
        const details = isRecord(detailsData) ? detailsData : {};
        const credits = isRecord(creditsData) ? creditsData : {};

        const movieData: JellyseerrMovieData = buildMovieData(details, credits);

        console.log('  ⏳ Calling OpenAI API (this may take 5-10 seconds)...');

        // Generate embeddings
        const embeddings = await generateDualEmbeddings(undefined, movieData);

        expect(embeddings).toBeDefined();
        expect(embeddings.discovery_embedding).toBeDefined();
        expect(Array.isArray(embeddings.discovery_embedding)).toBe(true);
        // Dimension depends on embedding provider:
        // - 1024: Voyage AI (voyage-3-lite)
        // - 1536: OpenAI text-embedding-3-small
        // - 3072: OpenAI text-embedding-3-large
        const embedding = embeddings.discovery_embedding;
        expect(Array.isArray(embedding)).toBe(true);
        if (!embedding) return;
        expect([1024, 1536, 3072]).toContain(embedding.length);

        // Verify no undefined values in embedding
        const hasUndefined = embedding.some((v) => v === undefined || v === null || isNaN(v));
        expect(hasUndefined).toBe(false);

        console.log(`  ✓ Generated embedding vector: ${embedding.length} dimensions`);
        console.log(
            `  ✓ Sample values: [${embedding
                .slice(0, 5)
                .map((v) => v.toFixed(4))
                .join(', ')}...]`,
        );
        console.log(`  ✓ No undefined/null/NaN values in embedding`);
    }, 30000);

    it('should store embeddings in database (if available)', async () => {
        console.log('\n💾 Test 6: Storing in database...');

        if (!process.env.DATABASE_URL) {
            console.log('  ⚠️  Skipped - no DATABASE_URL');
            return;
        }

        const movieId = testMovieId; // The Lantern

        // Fetch and transform data
        const detailsData: unknown = await tmdbApi.getMovieDetailsWithAppends(movieId, [
            'keywords',
        ]);
        const creditsData: unknown = await tmdbApi.getMovieCredits(movieId);
        const details = isRecord(detailsData) ? detailsData : {};
        const credits = isRecord(creditsData) ? creditsData : {};

        const movieData: JellyseerrMovieData = buildMovieData(details, credits);

        console.log('  ⏳ Generating embeddings...');
        const embeddings = await generateDualEmbeddings(undefined, movieData);

        console.log('  ⏳ Storing in database...');

        // Store in database
        await storeDualEmbedding(
            db,
            movieData.tmdbId,
            {
                discovery_embedding: embeddings.discovery_embedding,
            },
            {
                title: movieData.title,
                media_type: 'movie',
                discovery_data: movieData,
            },
        );

        console.log(`  ✓ Successfully stored embedding for "${movieData.title}"`);

        // Verify it was stored in PostgreSQL (using UUID-based tables)
        const sql = db.getSql();
        const stored = await sql<
            {
                tmdb_id: number;
                title: string | null;
                media_type: string;
                has_embedding: boolean;
                genres: number[] | null;
                keywords: string[] | null;
                popularity: number | null;
                tmdb_rating: number | null;
            }[]
        >`
			SELECT
				ei.external_id::integer as tmdb_id,
				mi.title,
				mi.media_type,
				me.embedding IS NOT NULL as has_embedding,
				(SELECT array_agg(g::integer) FROM jsonb_array_elements_text(pm.metadata->'genres') as g) as genres,
				CASE
					WHEN jsonb_typeof(pm.metadata->'keywords') = 'array'
					THEN (
						SELECT array_agg(k)
						FROM jsonb_array_elements_text(pm.metadata->'keywords') as k
					)
					ELSE NULL
				END as keywords,
				(pm.metadata->>'popularity')::numeric as popularity,
				(pm.metadata->>'vote_average')::numeric as tmdb_rating
			FROM media_items mi
			JOIN external_ids ei ON ei.media_id = mi.id AND ei.provider = 'tmdb'
			LEFT JOIN media_embeddings me ON me.media_id = mi.id AND me.source = ${EMBEDDING_SOURCE.DISCOVERY}
			LEFT JOIN provider_metadata pm ON pm.media_id = mi.id AND pm.provider = 'tmdb'
			WHERE ei.external_id = ${String(movieData.tmdbId)} AND mi.media_type = 'movie'
		`;

        expect(stored.length).toBe(1);
        expect(stored[0].has_embedding).toBe(true);
        expect(stored[0].tmdb_id).toBe(movieData.tmdbId);
        expect(stored[0].title).toBeTruthy(); // Title should exist
        expect(stored[0].media_type).toBe('movie');

        console.log(`  ✓ Stored in PostgreSQL: TMDB ${stored[0].tmdb_id} - "${stored[0].title}"`);
        console.log(`  ✓ Has embedding vector: ${stored[0].has_embedding}`);
        console.log(
            `  ✓ Movie metadata: Rating ${stored[0].tmdb_rating}, Popularity ${stored[0].popularity}`,
        );

        // Verify PostgreSQL arrays are valid (no undefined/null)
        if (stored[0].genres && stored[0].genres.length > 0) {
            expect(Array.isArray(stored[0].genres)).toBe(true);
            const hasInvalidGenres = stored[0].genres.some((g) => g === null || g === undefined);
            expect(hasInvalidGenres).toBe(false);
            console.log(
                `  ✓ Genres array valid: ${stored[0].genres.length} items - [${stored[0].genres.join(', ')}]`,
            );
        }

        if (stored[0].keywords && stored[0].keywords.length > 0) {
            expect(Array.isArray(stored[0].keywords)).toBe(true);
            const hasInvalidKeywords = stored[0].keywords.some(
                (k) => !k || k === null || k === undefined || k === '',
            );
            expect(hasInvalidKeywords).toBe(false);
            console.log(`  ✓ Keywords array valid: ${stored[0].keywords.length} items`);
        }

        console.log(`  ✓ All PostgreSQL arrays are clean (no undefined/null values)`);
        console.log(`  ✓ Successfully validated PostgreSQL storage end-to-end`);
    }, 40000);

    it('should handle "The Toxic Avenger" and other edge cases', async () => {
        console.log('\n🧪 Test 7: Testing "The Toxic Avenger" (2025) edge case...');

        const movieId = 1508266; // The Toxic Avenger (2025) - previously failing

        try {
            // Fetch data
            const detailsData: unknown = await tmdbApi.getMovieDetailsWithAppends(movieId, [
                'keywords',
            ]);
            const creditsData: unknown = await tmdbApi.getMovieCredits(movieId);
            const details = isRecord(detailsData) ? detailsData : {};
            const credits = isRecord(creditsData) ? creditsData : {};

            console.log(
                `  ✓ Fetched: "${getStringField(details, ['title', 'name'])}" (TMDB: ${movieId})`,
            );

            // Transform with all filtering
            const movieData: JellyseerrMovieData = buildMovieData(details, credits);

            // Generate embedding text
            const embeddingText = createJellyseerrEmbeddingText(movieData);

            console.log(`  ✓ Generated embedding text (${embeddingText.length} chars)`);
            console.log(`  Preview: ${embeddingText.substring(0, 150)}...`);

            // Verify no undefined values
            expect(embeddingText).not.toContain('undefined');
            expect(embeddingText).not.toContain('null');
            const detailsTitle = getStringField(details, ['title', 'name']) || '';
            expect(embeddingText).toContain(detailsTitle); // Contains actual movie title
            expect(embeddingText.length).toBeGreaterThan(50); // Has substantial content

            console.log(
                `  ✓ No undefined values - previously failing TMDB ID ${movieId} now works!`,
            );
        } catch (error) {
            console.error('  ❌ Error:', error);
            throw error;
        }
    }, 15000);
});

// Summary
console.log(`
📊 Integration Test Configuration:
- TMDB_API_KEY: ${process.env.TMDB_API_KEY ? '✓ Found' : '✗ Missing'}
- OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? '✓ Found' : '✗ Missing'}
- DATABASE_URL: ${process.env.DATABASE_URL ? '✓ Found' : '✗ Missing'}

${SKIP_INTEGRATION_TESTS ? '⚠️  Integration tests will be skipped - add API keys to .env to run them' : '✓ Ready to run integration tests'}
`);
