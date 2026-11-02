// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// OpenAI Integration for AI Recommendations
// Uses Voyage AI for embeddings and OpenAI for chat completions
import OpenAI from 'openai';
import { withExternalCallCounting } from '../utils/external-request-counter.js';
import { guardedDefaultFetch } from '../utils/fetch-utils.js';
import type { UserRating } from '../database/connection';
import { Logger } from '../utils/logger';
import { getAiConfig } from '../config/domains/ai.js';
import {
    generateVoyageEmbedding,
    generateVoyageQueryEmbedding,
    isVoyageAvailable,
    getEmbeddingDimension,
    testVoyageConnection,
} from './voyage';
import {
    isRecord,
    toString,
    toNumber,
    parseInteger as toNumberFromUnknown,
} from '../../utils/data-extraction';

const logger = Logger.for('OpenAI');

// Export embedding dimension for database schema (dynamically determined)
export const EMBEDDING_DIMENSION = getEmbeddingDimension();

// Cached per key+endpoint so a saved change builds a new client.
let openai: { key: string; client: OpenAI } | null = null;

/**
 * Initialize OpenAI client
 * Used only for chat completions (AI suggestions), not embeddings
 * Supports custom endpoints (e.g., local LLMs, Azure OpenAI)
 */
function getOpenAI(): OpenAI | null {
    const ai = getAiConfig();
    if (!ai.openaiChatApiKey) {
        logger.warn('OPENAI_CHAT_API_KEY not set - AI chat disabled');
        return null;
    }

    const cacheKey = `${ai.openaiChatApiKey}|${ai.openaiBaseUrl ?? ''}`;
    if (openai?.key !== cacheKey) {
        try {
            const options: { apiKey: string; baseURL?: string; fetch: typeof fetch } = {
                fetch: withExternalCallCounting(guardedDefaultFetch, 'openai'),
                apiKey: ai.openaiChatApiKey,
            };
            // Support custom OpenAI-compatible endpoints
            if (ai.openaiBaseUrl) {
                options.baseURL = ai.openaiBaseUrl;
            }
            openai = { key: cacheKey, client: new OpenAI(options) };
        } catch (error) {
            logger.warn('OpenAI initialization failed', {}, error as Error);
            return null;
        }
    }

    return openai.client;
}

/**
 * Generate embedding for media content using Voyage AI
 */
export async function generateMediaEmbedding(media: {
    title: string;
    overview?: string;
    genres?: number[];
    release_date?: string;
}): Promise<number[] | null> {
    if (!isVoyageAvailable()) {
        logger.warn('Voyage AI not available for media embedding');
        return null;
    }

    try {
        // Create a rich text representation for embedding
        const genreNames = getGenreNames(media.genres || []);
        const year = media.release_date ? new Date(media.release_date).getFullYear() : '';

        const text = [media.title, media.overview || '', genreNames.join(', '), year.toString()]
            .filter(Boolean)
            .join('\n');

        return await generateVoyageEmbedding(text);
    } catch (error) {
        logger.warn('Failed to generate media embedding', {}, error as Error);
        return null;
    }
}

/**
 * Generate embedding from raw text using Voyage AI
 * Use this when you have pre-formatted embedding text
 */
export async function generateTextEmbedding(
    text: string,
    onTokens?: (tokens: number) => void,
): Promise<number[] | null> {
    if (!isVoyageAvailable()) {
        logger.warn('Voyage AI not available for text embedding');
        return null;
    }

    try {
        return await generateVoyageEmbedding(text, onTokens);
    } catch (error) {
        logger.warn('Failed to generate text embedding', {}, error as Error);
        return null;
    }
}

/**
 * Generate embedding for search query using Voyage AI
 * Uses 'query' input type for better search performance
 */
export async function generateQueryEmbedding(query: string): Promise<number[] | null> {
    if (!isVoyageAvailable()) {
        logger.warn('Voyage AI not available for query embedding');
        return null;
    }

    try {
        return await generateVoyageQueryEmbedding(query);
    } catch (error) {
        logger.warn('Failed to generate query embedding', {}, error as Error);
        return null;
    }
}

/**
 * Generate user profile embedding from their watch history and ratings
 * Uses Voyage AI for consistent embeddings
 */
export async function generateUserProfileEmbedding(
    watchHistory: Array<{
        title: string;
        overview?: string;
        genres?: number[];
    }>,
    ratings: UserRating[],
): Promise<number[] | null> {
    if (!isVoyageAvailable()) {
        logger.warn('Voyage AI not available for user profile embedding');
        return null;
    }

    try {
        // Create a profile based on liked content (rating >= 4)
        const likedContent = ratings.filter((r) => r.rating >= 4).slice(0, 10); // Limit to recent liked content

        // Combine watch history with preferences using natural language
        const profileText = [
            'User enjoys:',
            ...watchHistory.slice(0, 20).map((item) => {
                const genres = getGenreNames(item.genres || []);
                return `${item.title} (${genres.join(', ')})`;
            }),
            'User particularly likes:',
            ...likedContent.map(
                (rating) =>
                    `Highly rated content with ID ${rating.primary_ext_id ?? rating.media_id}`,
            ),
        ].join('\n');

        return await generateVoyageEmbedding(profileText);
    } catch (error) {
        logger.warn('Failed to generate user profile embedding', {}, error as Error);
        return null;
    }
}

/**
 * Generate AI suggestions based on user profile and available content
 */
export async function generateAISuggestions(
    userProfile: {
        user_id: string;
        watchHistory: Array<{
            title: string;
            overview?: string;
            genres?: number[];
        }>;
        ratings: UserRating[];
    },
    availableContent: Array<{
        tmdb_id: number;
        title: string;
        overview?: string;
        genres: number[];
        vote_average?: number;
        is_available: boolean;
        can_request: boolean;
    }>,
    limit = 10,
): Promise<Array<{
    tmdb_id: number;
    reason: string;
    confidence: number;
}> | null> {
    const client = getOpenAI();
    if (!client) return null;

    try {
        // Prepare context for AI
        const watchedTitles = userProfile.watchHistory.slice(0, 10).map((w) => w.title);
        const likedContent = userProfile.ratings.filter((r) => r.rating >= 4).slice(0, 5);
        const dislikedContent = userProfile.ratings.filter((r) => r.rating <= 2).slice(0, 5);

        const availableMovies = availableContent
            .slice(0, 50) // Limit to avoid token limits
            .map((m) => ({
                id: m.tmdb_id,
                title: m.title,
                overview: m.overview?.slice(0, 200) || '', // Truncate overview
                genres: getGenreNames(m.genres).join(', '),
                rating: m.vote_average,
                status: m.is_available
                    ? 'Available now'
                    : m.can_request
                      ? 'Can request'
                      : 'Not available',
            }));

        const prompt = `Based on this user's viewing history and preferences, suggest ${limit} movies/shows from the available content.

USER PROFILE:
Recently watched: ${watchedTitles.join(', ')}
Liked content (rated 4-5): ${likedContent.map((l) => `ID ${l.primary_ext_id ?? l.media_id}`).join(', ')}
Disliked content (rated 1-2): ${dislikedContent.map((l) => `ID ${l.primary_ext_id ?? l.media_id}`).join(', ')}

AVAILABLE CONTENT:
${availableMovies
    .map(
        (m) =>
            `ID: ${m.id}, Title: ${m.title}, Genres: ${m.genres}, Rating: ${m.rating}, Status: ${m.status}`,
    )
    .join('\n')}

Please respond with EXACTLY this JSON format (no additional text):
{
  "suggestions": [
    {
      "tmdb_id": 123,
      "reason": "Short explanation why this matches user taste",
      "confidence": 0.85
    }
  ]
}

Focus on content that matches the user's demonstrated preferences while avoiding patterns from disliked content.`;

        const response = await client.chat.completions.create({
            model: getAiConfig().openaiChatModel,
            messages: [
                {
                    role: 'system',
                    content:
                        'You are a movie recommendation expert. Always respond with valid JSON only, no additional text.',
                },
                {
                    role: 'user',
                    content: prompt,
                },
            ],
            temperature: 0.7,
            max_tokens: 1500,
        });

        const content = response.choices[0]?.message?.content;
        if (!content) return null;

        try {
            const parsed: unknown = JSON.parse(content);
            if (!isRecord(parsed)) return null;
            const rawSuggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
            const suggestions = rawSuggestions
                .map((item) => {
                    if (!isRecord(item)) return null;
                    const tmdb_id = toNumberFromUnknown(item.tmdb_id);
                    const reason = toString(item.reason);
                    const confidence = toNumber(item.confidence);
                    if (!tmdb_id || !reason || confidence === undefined) {
                        return null;
                    }
                    return { tmdb_id, reason, confidence };
                })
                .filter(
                    (
                        item,
                    ): item is {
                        tmdb_id: number;
                        reason: string;
                        confidence: number;
                    } => item !== null,
                );
            return suggestions;
        } catch (parseError) {
            logger.warn('Failed to parse AI suggestion response', {}, parseError as Error);
            return null;
        }
    } catch (error) {
        logger.warn('Failed to generate AI suggestions', {}, error as Error);
        return null;
    }
}

/**
 * Update user profile based on rating feedback
 */
export function updateUserEmbeddingWithFeedback(
    currentEmbedding: number[],
    ratedItemEmbedding: number[],
    rating: number,
    learningRate = 0.1,
): number[] {
    if (currentEmbedding.length !== ratedItemEmbedding.length) {
        return currentEmbedding;
    }

    // Positive rating: move toward the item
    // Negative rating: move away from the item
    const direction = rating >= 4 ? 1 : rating <= 2 ? -1 : 0;
    const effectiveLearningRate = learningRate * direction;

    return currentEmbedding.map(
        (val, i) => val + effectiveLearningRate * (ratedItemEmbedding[i] - val),
    );
}

/**
 * Convert genre IDs to human-readable names
 */
function getGenreNames(genreIds: number[]): string[] {
    const genreMap: Record<number, string> = {
        12: 'Adventure',
        28: 'Action',
        16: 'Animation',
        99: 'Documentary',
        18: 'Drama',
        10751: 'Family',
        14: 'Fantasy',
        36: 'History',
        27: 'Horror',
        35: 'Comedy',
        10752: 'War',
        80: 'Crime',
        10749: 'Romance',
        10402: 'Music',
        9648: 'Mystery',
        878: 'Science Fiction',
        10770: 'TV Movie',
        53: 'Thriller',
        37: 'Western',
    };

    return genreIds.map((id) => genreMap[id] || 'Unknown').filter(Boolean);
}

/**
 * Test Voyage AI connectivity for embeddings
 */
export async function testEmbeddingConnection(): Promise<boolean> {
    try {
        return await testVoyageConnection();
    } catch (error) {
        logger.warn('Voyage AI connection test failed', {}, error as Error);
        return false;
    }
}
