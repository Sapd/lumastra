// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Zod schemas for AI/recommendation API routes
 *
 * These schemas handle validation for:
 * - Rating content (rate endpoint)
 * - Recommendations (GET/refresh/dismiss)
 * - Chat messages
 * - Sync operations
 * - Admin embedding operations
 */

import { z } from 'zod';
import {
    externalIdsSchema,
    mediaTypeSchema,
    ratingSchema,
    coerceBooleanSchema,
    nonEmptyStringSchema,
} from './common';

// ============================================================================
// Rate Content Schemas
// ============================================================================

/**
 * Schema for rating content endpoint (POST /api/ai/rate)
 *
 * Accepts a rating (1-10), a skip flag, OR a clear flag (removes the user's
 * existing rating — used when re-tapping an already-active quick-rating button).
 * External IDs and media type are always required.
 */
export const rateContentBodySchema = z
    .object({
        externalIds: externalIdsSchema,
        mediaType: mediaTypeSchema.optional(),
        media_type: mediaTypeSchema.optional(), // Support snake_case variant
        rating: ratingSchema.optional(),
        skip: coerceBooleanSchema.optional(),
        clear: coerceBooleanSchema.optional(),
        context: z.string().optional(),
        tags: z.array(z.string()).optional(),
        notes: z.string().optional(),
        title: z.string().optional(),
        ratingStyle: z
            .enum(['quick', 'stars'])
            .optional()
            .describe(
                "How the rating was entered: 'quick' = semantic button/swipe, 'stars' = precise star input",
            ),
    })
    .refine((data) => (data.mediaType ?? data.media_type) !== undefined, {
        message: 'mediaType is required',
    })
    .refine((data) => data.rating !== undefined || data.skip === true || data.clear === true, {
        message: 'One of rating, skip, or clear must be provided',
    })
    .transform((data) => ({
        ...data,
        // Normalize media_type to mediaType (guaranteed non-undefined by refine above)
        mediaType: (data.mediaType ?? data.media_type) as 'movie' | 'tv',
    }));

export type RateContentBody = z.infer<typeof rateContentBodySchema>;

// ============================================================================
// User Ratings Schemas
// ============================================================================

/**
 * Path params for user ratings endpoint (GET /api/ai/user-ratings/[user_id])
 */
export const userRatingsParamsSchema = z.object({
    user_id: z.string().min(1, 'User ID is required'),
});

export type UserRatingsParams = z.infer<typeof userRatingsParamsSchema>;

/**
 * Query params for user ratings
 */
export const userRatingsQuerySchema = z.object({
    rating_min: z.coerce.number().int().min(1).max(10).default(1),
    limit: z.coerce.number().int().min(1).max(1000).default(20),
    offset: z.coerce.number().int().min(0).default(0),
});

export type UserRatingsQuery = z.infer<typeof userRatingsQuerySchema>;

// ============================================================================
// Generate Suggestions Schemas
// ============================================================================

/**
 * Path params for generate suggestions endpoint (POST /api/ai/generate-suggestions/[userId])
 */
export const generateSuggestionsParamsSchema = z.object({
    userId: z.string().min(1, 'User ID is required'),
});

export type GenerateSuggestionsParams = z.infer<typeof generateSuggestionsParamsSchema>;

// ============================================================================
// Recommendations Schemas
// ============================================================================

/**
 * Query params for recommendations endpoint (GET /api/recommendations)
 *
 * The `ai` type (and its ai-only params: watchedBased, withoutRatingInfluence,
 * hideWatched, exclude, mediaType) was retired with the legacy AI widget. The taste rail replaces it at
 * `GET /api/for-you/taste`.
 */
export const recommendationsQuerySchema = z.object({
    type: z.enum(['nextup', 'continue', 'watching', 'movies', 'series']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(10),
    validate: coerceBooleanSchema.optional(),
});

export type RecommendationsQuery = z.infer<typeof recommendationsQuerySchema>;

/**
 * Query params for holiday recommendations
 */
export const holidayRecommendationsQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type HolidayRecommendationsQuery = z.infer<typeof holidayRecommendationsQuerySchema>;

// ============================================================================
// Dismiss Schemas
// ============================================================================

/**
 * Media key schema - validates composite key format
 * Format: provider:id:mediaType (e.g., "tmdb:550:movie") OR UUID
 */
const mediaKeySchema = z.string().refine(
    (key) => {
        const keyPattern = /^[a-z]+:[^:]+:(movie|tv)$/;
        const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        return keyPattern.test(key) || uuidPattern.test(key);
    },
    {
        message: 'Invalid media key format. Expected provider:id:mediaType or UUID',
    },
);

/**
 * Body schema for dismiss endpoint (POST /api/recommendations/dismiss)
 */
export const dismissBodySchema = z.object({
    sourceMediaKey: mediaKeySchema,
    dismissedMediaKey: mediaKeySchema,
});

export type DismissBody = z.infer<typeof dismissBodySchema>;

/**
 * Query params for dismiss endpoint (GET/DELETE /api/recommendations/dismiss)
 */
export const dismissQuerySchema = z.object({
    source: mediaKeySchema,
});

export type DismissQuery = z.infer<typeof dismissQuerySchema>;

// ============================================================================
// Chat Schemas
// ============================================================================

/**
 * Body schema for assistant endpoint (POST /api/assistant)
 */
/** One prior turn of the conversation, sent by the client for context. */
export const chatHistoryTurnSchema = z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(6000),
});
export type ChatHistoryTurn = z.infer<typeof chatHistoryTurnSchema>;

export const chatMessageBodySchema = z.object({
    message: nonEmptyStringSchema.pipe(z.string().max(5000, 'Message too long')),
    /** Recent prior turns (most recent last) so the assistant has context. */
    history: z.array(chatHistoryTurnSchema).max(20).optional(),
    /**
     * Request an SSE (text/event-stream) response instead of a single JSON blob.
     * The server also switches to streaming when the Accept header prefers
     * text/event-stream. Ignored (JSON returned) when false/omitted.
     */
    stream: z
        .boolean()
        .optional()
        .describe('Stream the reply as Server-Sent Events instead of one JSON response'),
});

export type ChatMessageBody = z.infer<typeof chatMessageBodySchema>;

// ============================================================================
// Sync Operation Schemas
// ============================================================================

/**
 * Common sync operation body with optional force flag
 */
export const syncOperationBodySchema = z.object({
    force: coerceBooleanSchema.optional().default(false),
});

export type SyncOperationBody = z.infer<typeof syncOperationBodySchema>;

// ============================================================================
// Admin Embedding Generation Schemas
// ============================================================================

/**
 * Embedding generation targets
 */
export const embeddingTargetSchema = z.enum(['jellyfin', 'jellyseerr']);
export type EmbeddingTarget = z.infer<typeof embeddingTargetSchema>;

/**
 * Admin embedding generation actions
 */
export const embeddingActionSchema = z.enum(['start', 'status', 'abort']);
export type EmbeddingAction = z.infer<typeof embeddingActionSchema>;

/**
 * Body schema for embedding generation from DB (POST /api/ai/generate-embeddings-from-db)
 */
export const generateEmbeddingsBodySchema = z.object({
    action: embeddingActionSchema.default('start'),
    target: embeddingTargetSchema.default('jellyfin'),
    missingOnly: coerceBooleanSchema.optional().default(true),
    force: coerceBooleanSchema.optional().default(false),
    requireMdblistTags: coerceBooleanSchema.optional().default(false),
    batchSize: z.coerce.number().int().min(1).max(100).optional().default(10),
});

export type GenerateEmbeddingsBody = z.infer<typeof generateEmbeddingsBodySchema>;

/**
 * Metadata sync options
 */
const metadataSyncFieldSchema = z.enum([
    'imdb_id',
    'actors',
    'directors',
    'producers',
    'writers',
    'keywords',
    'networks',
]);

export const metadataSyncBodySchema = z.object({
    action: embeddingActionSchema.default('start'),
    batchSize: z.coerce.number().int().min(1).max(500).optional().default(100),
    missingFields: z
        .array(metadataSyncFieldSchema)
        .optional()
        .default(['imdb_id', 'actors', 'directors']),
    updateEmbeddings: coerceBooleanSchema.optional().default(false),
});

export type MetadataSyncBody = z.infer<typeof metadataSyncBodySchema>;

// ============================================================================
// New Items Scan Schemas
// ============================================================================

/**
 * New items scan action
 */
export const newItemsScanActionSchema = z.enum(['start', 'status', 'abort']);

/**
 * Body schema for new items scan (POST /api/ai/new-items-scan)
 */
export const newItemsScanBodySchema = z.object({
    action: newItemsScanActionSchema.default('start'),
});

export type NewItemsScanBody = z.infer<typeof newItemsScanBodySchema>;

// ============================================================================
// Clear User Schemas
// ============================================================================

/**
 * Path params for clear user endpoint (DELETE /api/ai/clear-user/[userId])
 */
export const clearUserParamsSchema = z.object({
    userId: z.string().min(1, 'User ID is required'),
});

export type ClearUserParams = z.infer<typeof clearUserParamsSchema>;

// ============================================================================
// User ID Path Parameter Schema (reusable)
// ============================================================================

/**
 * Generic user ID path parameter
 */
export const userIdParamsSchema = z.object({
    userId: z.string().min(1, 'User ID is required'),
});

export type UserIdParams = z.infer<typeof userIdParamsSchema>;

// ============================================================================
// Save/Unsave Movie Schema
// ============================================================================

/**
 * Body schema for save movie (POST /api/ai/save-movie)
 */
export const saveMovieBodySchema = z
    .object({
        externalIds: externalIdsSchema,
        mediaType: mediaTypeSchema.optional(),
        media_type: mediaTypeSchema.optional(),
        title: z.string().min(1, 'Title is required'),
    })
    .refine((data) => (data.mediaType ?? data.media_type) !== undefined, {
        message: 'mediaType is required',
    })
    .transform((data) => ({
        ...data,
        mediaType: (data.mediaType ?? data.media_type) as 'movie' | 'tv',
    }));

export type SaveMovieBody = z.infer<typeof saveMovieBodySchema>;

/**
 * Body schema for unsave movie (DELETE /api/ai/save-movie)
 */
export const unsaveMovieBodySchema = z
    .object({
        externalIds: externalIdsSchema,
        mediaType: mediaTypeSchema.optional(),
        media_type: mediaTypeSchema.optional(),
    })
    .refine((data) => (data.mediaType ?? data.media_type) !== undefined, {
        message: 'mediaType is required',
    })
    .transform((data) => ({
        ...data,
        mediaType: (data.mediaType ?? data.media_type) as 'movie' | 'tv',
    }));

export type UnsaveMovieBody = z.infer<typeof unsaveMovieBodySchema>;

// ============================================================================
// Reset Embeddings Schema
// ============================================================================

/**
 * Body schema for reset embeddings (POST /api/ai/reset-embeddings)
 */
export const resetEmbeddingsBodySchema = z.object({
    // 'tmdb' here is an embedding source name (TMDB provider metadata), not a provider config
    type: z.enum(['library', 'discovery', 'tmdb', 'all']),
});

export type ResetEmbeddingsBody = z.infer<typeof resetEmbeddingsBodySchema>;

// ============================================================================
// Generate Enhanced Profile Schema
// ============================================================================

/**
 * Watch history item schema for enhanced profile generation
 */
const watchHistoryItemSchema = z.object({
    primary_id: z.string().optional(), // provider-agnostic; string not number
    title: z.string().optional().default('Unknown'),
    genres: z.array(z.string()).optional(),
    overview: z.string().optional(),
    playCount: z.number().optional(),
    playbackPositionTicks: z.number().optional(),
    runtimeTicks: z.number().optional(),
    mediaType: mediaTypeSchema.optional(),
    episodesWatched: z.number().optional(),
    totalEpisodes: z.number().optional(),
});

/**
 * Body schema for generate enhanced profile (POST /api/ai/generate-enhanced-profile/[userId])
 */
export const generateEnhancedProfileBodySchema = z.object({
    watchHistory: z.array(watchHistoryItemSchema).optional().default([]),
});

export type GenerateEnhancedProfileBody = z.infer<typeof generateEnhancedProfileBodySchema>;

// ============================================================================
// Batch Embeddings Schema
// ============================================================================

/**
 * Body schema for batch embeddings POST (POST /api/ai/batch-embeddings)
 */
export const batchEmbeddingsBodySchema = z.object({
    action: z.enum(['cancel']),
    batchId: z.string().min(1, 'Batch ID is required'),
});

export type BatchEmbeddingsBody = z.infer<typeof batchEmbeddingsBodySchema>;

// ============================================================================
// MDBList Embeddings Schema
// ============================================================================

/**
 * Body schema for MDBList embeddings (POST /api/ai/generate-mdblist-embeddings)
 */
export const generateMdblistEmbeddingsBodySchema = z.object({
    action: z.enum(['preview', 'generate']).optional(),
    listId: z.string().optional(),
    lists: z.array(z.string()).max(50).optional(),
    itemsPerList: z.coerce.number().int().min(1).max(500).optional(),
    skipExisting: coerceBooleanSchema.optional(),
    externalProviderDelayMs: z.coerce.number().int().min(0).optional(),
});

export type GenerateMdblistEmbeddingsBody = z.infer<typeof generateMdblistEmbeddingsBodySchema>;
