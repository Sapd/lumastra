// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AI API Response Zod Schemas
 *
 * SINGLE SOURCE OF TRUTH for AI/recommendation API response types.
 * These schemas define the contract for /api/ai/*, /api/recommendations, /api/assistant endpoints.
 *
 * Usage:
 * - Server: Validate responses before sending
 * - Client: Runtime type validation
 * - OpenAPI: Auto-generate documentation
 * - TypeScript: Infer types for type safety
 *
 * Convention:
 * - Use .optional() for optional fields (NOT .nullable())
 * - Add .meta({ description: '...' }) for OpenAPI docs
 * - Export both schema and inferred type
 */

import { z } from 'zod';
import { publicMovieSeriesSchema } from './common';
import { ExternalIdsResponseSchema } from './api-responses';
import { MediaRatingsSchema } from './api-media-responses';
import { RecommendedMovieSchema, RecommendedMusicSchema } from './assistant-types';
import { BullMQTaskStatusSchema } from './bullmq-task-types';
import { EmbeddingSampleSchema, EmbeddingLookupResultSchema } from './admin-types';
import { PageBlockSchema } from './api-for-you-responses';

// ============================================================================
// AI Recommendation Item
// ============================================================================

/**
 * AI recommendation item (used across multiple endpoints)
 */
export const AIRecommendationItemSchema = MediaRatingsSchema.extend({
    /** External provider IDs */
    externalIds: ExternalIdsResponseSchema.describe('External provider IDs'),
    /** Media type */
    mediaType: publicMovieSeriesSchema,
    /** Display title */
    title: z.string().optional().describe('Display title'),
    /** Release year (null when unknown) */
    year: z.number().nullish().describe('Release year'),
    /** Overview/description */
    overview: z.string().optional().describe('Overview'),
    /** Genre IDs or names */
    genres: z
        .union([z.array(z.number()), z.array(z.string())])
        .optional()
        .describe('Genres'),
    /** Best available rating (0-10 scale) */
    rating: z.number().optional().describe('Best available rating (0-10)'),
    /** Source of primary rating */
    ratingSource: z.string().optional().describe('Rating source'),
    /** Whether this is an AI-generated suggestion */
    aiSuggestion: z.boolean().optional().describe('AI suggestion'),
    /** AI-generated reason for recommendation */
    aiReason: z.string().optional().describe('AI reason'),
    /** AI similarity score (formatted string) */
    aiSimilarity: z.string().optional().describe('AI similarity'),
    /** Whether item can be requested */
    canRequest: z.boolean().optional().describe('Can request'),
    /** Whether available in library */
    isAvailable: z.boolean().optional().describe('Is available'),
    /** Availability source */
    availabilitySource: z.string().optional().describe('Availability source'),
    /** TMDB rating (0-10) */
    tmdbRating: z.number().nullish().describe('TMDB rating (0-10)'),
    /** Whether user has saved this movie */
    isSaved: z.boolean().optional().describe('Is saved'),
    /** User's rating for this item (null when unrated) */
    userRating: z.number().nullish().describe('User rating'),
    /** When user rated this */
    ratedAt: z.string().optional().describe('Rated timestamp'),
    /** Poster path */
    posterPath: z.string().optional().describe('Poster path'),
    /** Combined score */
    combinedScore: z.number().optional().describe('Combined score'),
    /** Recommendation source */
    source: z.string().optional().describe('Source'),
    /** Last played timestamp */
    lastPlayed: z.string().optional().describe('Last played'),
    /** Completion percentage */
    completionPercentage: z.number().optional().describe('Completion percentage'),
    /** Play count */
    playCount: z.number().optional().describe('Play count'),
    /** Whether user has watched this */
    isWatched: z.boolean().optional().describe('Is watched'),
}).meta({ id: 'AIRecommendationItem', description: 'AI recommendation item' });

export type AIRecommendationItem = z.infer<typeof AIRecommendationItemSchema>;

// ============================================================================
// Rating Candidate (shared item shape — used by /api/rate/queue)
// ============================================================================

/**
 * Rating candidate movie (rate-mode).
 *
 * All fields the server emits are declared so no .passthrough() is needed.
 */
export const RatingCandidateSchema = z
    .object({
        /** External provider IDs */
        externalIds: ExternalIdsResponseSchema.describe('External IDs'),
        /** Media type */
        mediaType: publicMovieSeriesSchema,
        /** Display title */
        title: z.string().describe('Display title'),
        /** Poster path */
        posterPath: z.string().optional().describe('Poster path'),
        /** Release year */
        year: z.number().optional().describe('Year'),
        /** Overview */
        overview: z.string().optional().describe('Overview'),
        /** Genre names */
        genres: z.array(z.string()).optional().describe('Genres'),
        /** Community / composite rating (0–10) */
        communityRating: z.number().optional().describe('Community rating'),
        /** Critic / RT rating (0–100) */
        criticRating: z.number().optional().describe('Critic rating'),
        /** Runtime in Jellyfin ticks */
        runtimeTicks: z.number().optional().describe('Runtime ticks'),
        /** Play count for the authenticated user */
        playCount: z.number().optional().describe('Play count'),
        /** ISO-8601 last-played timestamp */
        lastPlayed: z.string().optional().describe('Last played timestamp'),
        /** Completion percentage (0–100) */
        completionPercentage: z.number().optional().describe('Completion percentage'),
        /** Whether a catalog embedding is available */
        hasEmbedding: z.boolean().optional().describe('Has embedding'),
        /** Content source: watched history, TMDB discovery, or popular catalog */
        source: z.enum(['watched', 'tmdb', 'popular']).optional().describe('Content source'),
        /** Legacy per-user rating (0–10); absent when not yet rated */
        userRating: z.number().optional().describe('User rating'),
    })
    .meta({ id: 'RatingCandidate', description: 'Rating candidate' });

export type RatingCandidate = z.infer<typeof RatingCandidateSchema>;

// ============================================================================
// Rate Queue Response (/api/rate/queue)
// ============================================================================

/**
 * Watched-first rating-trainer queue page.
 *
 * `status: 'exhausted'` means no more candidates remain for the requested
 * filter within this served-set session; `items` is empty in that case.
 * `nextCursor` is the opaque session token to pass back on the next request
 * to keep excluding items already served this session.
 */
export const RateQueueResponseSchema = z
    .object({
        status: z.enum(['ready', 'exhausted']).describe('Whether the queue has more candidates'),
        items: z.array(RatingCandidateSchema).describe('Queue page items'),
        page: z.object({ limit: z.number().int(), hasMore: z.boolean(), nextCursor: z.string() }),
    })
    .meta({ id: 'RateQueueResponse', description: 'Rating trainer queue page' });

export type RateQueueResponse = z.infer<typeof RateQueueResponseSchema>;

// ============================================================================
// Rate Skip Body (/api/rate/skip)
// ============================================================================

/**
 * Body for the durable skip beacon. `mediaIds` are internal UUIDs (the same
 * `externalIds.internal` a `RatingCandidate` carries); clamped to 100 items
 * and empties are dropped by the endpoint handler.
 */
export const RateSkipBodySchema = z
    .object({
        mediaIds: z
            .array(z.string().guid())
            .max(100)
            .describe('Internal UUIDs of skipped items (empty array is a no-op)'),
    })
    .meta({ id: 'RateSkipBody', description: 'Durable skip beacon request body' });

export type RateSkipBody = z.infer<typeof RateSkipBodySchema>;

/**
 * Response for the durable skip beacon — best-effort, fire-and-forget.
 */
export const RateSkipResponseSchema = z
    .object({
        ok: z.literal(true).describe('Skip(s) recorded'),
    })
    .meta({ id: 'RateSkipResponse', description: 'Durable skip beacon response' });

export type RateSkipResponse = z.infer<typeof RateSkipResponseSchema>;

// ============================================================================
// User Stats Response (/api/ai/user-stats)
// ============================================================================

/**
 * User stats response
 */
export const UserStatsResponseSchema = z
    .object({
        /** Stats object */
        stats: z
            .object({
                /** Total number of ratings */
                totalRatings: z.number().describe('Total ratings'),
                /** Ratings today */
                todayRatings: z.number().describe('Today ratings'),
                /** AI confidence score */
                aiConfidence: z.number().optional().describe('AI confidence score'),
            })
            .optional()
            .describe('Stats'),
        /** Whether served from cache */
        cached: z.boolean().optional().describe('Whether served from cache'),
    })
    .meta({ id: 'UserStatsResponse', description: 'User stats response' });

export type UserStatsResponse = z.infer<typeof UserStatsResponseSchema>;

// ============================================================================
// Genre Response (/api/ai/available-genres)
// ============================================================================

/**
 * Genre item
 */
export const GenreItemSchema = z
    .object({
        /** Genre ID */
        id: z.string().describe('Genre ID'),
        /** Genre name */
        name: z.string().optional().describe('Genre name'),
        /** Total count */
        count: z.number().int().optional().describe('Total count'),
        /** Library count */
        library_count: z.number().optional().describe('Library count'),
        /** TMDB count */
        tmdb_count: z.number().optional().describe('TMDB count'),
    })
    .meta({ id: 'GenreItem', description: 'Genre item' });

export type GenreItem = z.infer<typeof GenreItemSchema>;

/**
 * Available genres response — bare object (no success wrapper).
 * Server returns { media_type, genres }.
 */
export const GenreResponseSchema = z
    .object({
        /** Media type filter */
        media_type: z.string().describe('Media type filter'),
        /** Available genres */
        genres: z.array(GenreItemSchema).describe('Genres'),
    })
    .meta({ id: 'GenreResponse', description: 'Available genres response' });

export type GenreResponse = z.infer<typeof GenreResponseSchema>;

// ============================================================================
// Rate Response (/api/ai/rate)
// ============================================================================

/**
 * Rate media response
 */
export const RateResponseSchema = z
    .object({
        /** Success message */
        message: z.string().optional().describe('Message'),
        /** Saved rating object — typed representation of the persisted UserRating row */
        rating: z
            .object({
                id: z.number().describe('Rating ID'),
                user_id: z.string().describe('User ID'),
                media_id: z.string().describe('Media ID'),
                rating: z.number().describe('Rating value'),
                suggestion_context: z.string().nullable().describe('Suggestion context'),
                skipped: z.boolean().describe('Whether skipped'),
                created_at: z.union([z.string(), z.date()]).describe('Created at'),
            })
            .optional()
            .describe('Rating object'),
        /** Whether rating was skipped */
        skipped: z.boolean().optional().describe('Whether rating was skipped'),
        /** Whether an existing rating was cleared/removed */
        cleared: z.boolean().optional().describe('Whether an existing rating was cleared'),
        /** Total rating count */
        ratingCount: z.number().optional().describe('Rating count'),
        /** Next recommended action */
        nextAction: z.string().optional().describe('Next recommended action'),
        /** Whether learning was applied */
        learningApplied: z.boolean().optional().describe('Whether learning was applied'),
        /** Whether profile was updated */
        profileUpdated: z.boolean().optional().describe('Whether profile was updated'),
        /** Whether recommendations are ready */
        recommendationsReady: z.boolean().optional().describe('Whether recommendations are ready'),
        /** Whether a milestone was reached */
        milestoneReached: z.boolean().optional().describe('Whether a milestone was reached'),
        /** Total lifetime ratings for this user after this submit (server-authoritative) */
        totalRatings: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe('Total lifetime ratings for this user after this submit'),
        /** Milestone crossed by this rating (5/25/50/100/250/500), if any */
        milestone: z
            .number()
            .int()
            .optional()
            .describe('Milestone crossed by this rating (5/25/50/100/250/500), if any'),
        /** AI taste-profile state after this rating */
        profileStatus: z
            .enum(['none', 'building', 'ready'])
            .optional()
            .describe('AI taste-profile state after this rating'),
        /** Rating progress */
        progress: z
            .object({
                /** Ratings needed */
                ratingsNeeded: z.number().describe('Ratings needed'),
                /** Ratings completed */
                ratingsComplete: z.number().describe('Ratings completed'),
                /** Completion percentage */
                percentage: z.number().describe('Completion percentage'),
            })
            .optional()
            .describe('Rating progress'),
        /** Error message */
        error: z.string().optional().describe('Error'),
    })
    .meta({ id: 'RateResponse', description: 'Rate response' });

export type RateResponse = z.infer<typeof RateResponseSchema>;

// ============================================================================
// Save Movie Response (/api/ai/save-movie)
// ============================================================================

/**
 * Save movie response
 */
export const SaveMovieResponseSchema = z
    .object({
        /** Success message */
        message: z.string().optional().describe('Message'),
        /** Whether movie was saved (POST) */
        saved: z.boolean().optional().describe('Was saved'),
        /** Whether movie was removed (DELETE) */
        removed: z.boolean().optional().describe('Was removed'),
        /** External IDs */
        externalIds: ExternalIdsResponseSchema.optional().describe('External IDs'),
        /** Additional note */
        note: z.string().optional().describe('Additional note'),
        /** Error message */
        error: z.string().optional().describe('Error'),
    })
    .meta({ id: 'SaveMovieResponse', description: 'Save movie response' });

export type SaveMovieResponse = z.infer<typeof SaveMovieResponseSchema>;

// ============================================================================
// Reset Profile Response (/api/ai/reset-profile)
// ============================================================================

/**
 * Reset profile response — bare object, no success wrapper.
 * Errors are delivered as problem+json.
 */
export const ResetProfileResponseSchema = z
    .object({
        /** Status message */
        message: z.string().describe('Status message'),
        /** The username whose profile was reset */
        user_id: z.string().describe('User ID'),
    })
    .meta({
        id: 'ResetProfileResponse',
        description: 'Reset profile response',
    });

export type ResetProfileResponse = z.infer<typeof ResetProfileResponseSchema>;

// ============================================================================
// User Ratings Response (/api/ai/user-ratings)
// ============================================================================

/**
 * User rating item
 */
export const UserRatingItemSchema = z
    .object({
        /** Primary external provider ID (string, provider-agnostic) */
        primaryExtId: z.string().optional().describe('Primary external ID'),
        /** External provider IDs (present when enriched) */
        externalIds: ExternalIdsResponseSchema.optional().describe('External IDs'),
        /** Media type */
        mediaType: z.string().describe('Media type'),
        /** Display title */
        title: z.string().optional().describe('Display title'),
        /** User rating (1-10) */
        rating: z.number().describe('Rating'),
        /** When rated */
        createdAt: z.union([z.string(), z.date()]).optional().describe('Created timestamp'),
        /** Overview */
        overview: z.string().nullish().describe('Overview'),
        /** IMDB rating */
        imdbRating: z.number().nullish().describe('IMDB rating'),
        /** Rotten Tomatoes rating */
        rtRating: z.number().nullish().describe('RT rating'),
        /** Whether available in library */
        isAvailable: z.boolean().optional().describe('Is available'),
        /** Whether item can be requested */
        canRequest: z.boolean().optional().describe('Can request'),
        /** How the rating was entered — 'quick' (semantic button/swipe) or 'stars' (precise) */
        ratingStyle: z.enum(['quick', 'stars']).optional().describe('How the rating was entered'),
    })
    .meta({ id: 'UserRatingItem', description: 'User rating item' });

export type UserRatingItem = z.infer<typeof UserRatingItemSchema>;

/**
 * User ratings response — paginated { items, page } envelope.
 * Server calls paginate(items, { limit, offset, hasMore }).
 */
export const UserRatingsResponseSchema = z
    .object({
        items: z.array(UserRatingItemSchema).describe('User ratings'),
        page: PageBlockSchema.describe('Pagination info'),
    })
    .meta({ id: 'UserRatingsResponse', description: 'User ratings paginated response' });

export type UserRatingsResponse = z.infer<typeof UserRatingsResponseSchema>;

// ============================================================================
// Assistant Responses (/api/assistant)
// ============================================================================

// RecommendedMovieSchema is imported from chat-types.ts

/**
 * Chat rate limit info
 */
export const ChatRateLimitSchema = z
    .object({
        /** Remaining requests */
        remaining: z.number().describe('Remaining requests'),
        /** Total limit */
        limit: z.number().int().describe('Request limit'),
        /** Whether user is admin (unlimited) */
        isAdmin: z.boolean().describe('Is admin'),
    })
    .meta({ id: 'ChatRateLimit', description: 'Chat rate limit info' });

export type ChatRateLimit = z.infer<typeof ChatRateLimitSchema>;

/**
 * Chat GET response (rate limit status)
 */
export const ChatRateLimitResponseSchema = z
    .object({
        /** User ID */
        userId: z.string().optional().describe('User ID'),
        /** Whether user is admin */
        isAdmin: z.boolean().describe('Is admin'),
        /** Request limit */
        limit: z.number().int().describe('Request limit'),
        /** Requests used */
        used: z.number().optional().describe('Requests used'),
        /** Remaining requests */
        remaining: z.number().describe('Remaining requests'),
        /** Reset timestamp */
        resetsAt: z.string().optional().describe('Reset timestamp'),
    })
    .meta({
        id: 'ChatRateLimitResponse',
        description: 'Chat rate limit response',
    });

export type ChatRateLimitResponse = z.infer<typeof ChatRateLimitResponseSchema>;

/**
 * Chat POST response (message + recommendations)
 */
export const ChatMessageResponseSchema = z
    .object({
        /** AI response text */
        response: z.string().describe('AI response'),
        /** Model reasoning summary (Claude adaptive thinking); omitted otherwise */
        thinking: z.string().optional().describe('Model reasoning summary'),
        /** Recommended movies */
        recommendedMovies: z.array(RecommendedMovieSchema).describe('Recommended movies'),
        /** Recommended music (tracks/albums/artists) */
        recommendedMusic: z.array(RecommendedMusicSchema).optional().describe('Recommended music'),
        /** Token usage */
        usage: z
            .object({
                /** Tokens used */
                tokens: z.number().describe('Tokens used'),
                /** Cost in USD */
                costUsd: z.number().describe('Cost in USD'),
                /** Response time in ms */
                responseTimeMs: z.number().describe('Response time in ms'),
            })
            .optional()
            .describe('Token usage'),
        /** Rate limit info */
        rateLimit: ChatRateLimitSchema.describe('Rate limit info'),
        /** User context */
        context: z
            .object({
                /** Movies used in context */
                moviesUsed: z.number().describe('Movies used'),
                /** User ratings count */
                userRatings: z.number().describe('User ratings'),
            })
            .optional()
            .describe('User context'),
    })
    .meta({ id: 'ChatMessageResponse', description: 'Chat message response' });

export type ChatMessageResponse = z.infer<typeof ChatMessageResponseSchema>;

/**
 * Assistant conversation history item — a single persisted chat turn.
 * Text-only: recommendation cards attached to an assistant reply are not
 * persisted, so a rehydrated transcript shows text but not cards.
 */
export const AssistantHistoryMessageSchema = z
    .object({
        /** Who sent this message */
        role: z.enum(['user', 'assistant']).describe('Message role'),
        /** Message text */
        content: z.string().describe('Message content'),
        /** ISO-8601 timestamp when the message was persisted */
        createdAt: z.string().describe('Created timestamp'),
    })
    .meta({ id: 'AssistantHistoryMessage', description: 'Assistant history message' });

export type AssistantHistoryMessage = z.infer<typeof AssistantHistoryMessageSchema>;

/**
 * Assistant history response (/api/assistant/history) — bare object, no
 * success wrapper. Used by the chat UI to hydrate the conversation after a
 * page reload.
 */
export const AssistantHistoryResponseSchema = z
    .object({
        /** Chronological (oldest → newest) window of recent messages */
        messages: z.array(AssistantHistoryMessageSchema).describe('Recent messages'),
    })
    .meta({ id: 'AssistantHistoryResponse', description: 'Assistant history response' });

export type AssistantHistoryResponse = z.infer<typeof AssistantHistoryResponseSchema>;

// ============================================================================
// AI Admin Responses (/api/ai/*)
// ============================================================================

/**
 * AI user item schema — a single row in the users admin list.
 */
export const AiUserItemSchema = z
    .object({
        /** User ID */
        userId: z.string().describe('User ID'),
        /** Whether has profile */
        hasProfile: z.boolean().describe('Has profile'),
        /** Total ratings */
        totalRatings: z.union([z.number(), z.string()]).describe('Total ratings'),
        /** Current ratings count */
        currentRatings: z.union([z.number(), z.string()]).describe('Current ratings'),
        /** Active suggestions */
        activeSuggestions: z.union([z.number(), z.string()]).describe('Active suggestions'),
        /** Last activity timestamp */
        lastActivity: z.string().nullable().describe('Last activity'),
        /** Whether to hide streams */
        hideStreams: z.boolean().describe('Hide streams'),
        /** User groups */
        groups: z.array(z.string()).nullable().describe('User groups'),
        /** When groups were last updated */
        groupsUpdatedAt: z.string().nullable().describe('Groups updated at'),
    })
    .meta({ id: 'AiUserItem', description: 'AI user item' });

export type AiUserItem = z.infer<typeof AiUserItemSchema>;

/**
 * AI users list response — paginated { items, page } envelope.
 * Server calls paginate(items, { limit, offset, hasMore, total }).
 */
export const AiUsersResponseSchema = z
    .object({
        items: z.array(AiUserItemSchema).describe('AI user rows'),
        page: PageBlockSchema.describe('Pagination info'),
    })
    .meta({ id: 'AiUsersResponse', description: 'AI users paginated response' });

export type AiUsersResponse = z.infer<typeof AiUsersResponseSchema>;

/**
 * Clear user AI data response — bare object, no success wrapper.
 * Server returns { message, deleted: {...}, remaining: {...} }.
 */
export const ClearUserAiDataResponseSchema = z
    .object({
        /** Status message */
        message: z.string().describe('Status message'),
        /** Counts of items deleted */
        deleted: z
            .object({
                profiles: z.number(),
                ratings: z.number(),
                suggestions: z.number(),
                savedMovies: z.number(),
            })
            .describe('Deleted counts'),
        /** Counts of items remaining after deletion */
        remaining: z
            .object({
                profiles: z.number(),
                ratings: z.number(),
                suggestions: z.number(),
                savedMovies: z.number(),
            })
            .describe('Remaining counts'),
    })
    .meta({
        id: 'ClearUserAiDataResponse',
        description: 'Clear user AI data response',
    });

export type ClearUserAiDataResponse = z.infer<typeof ClearUserAiDataResponseSchema>;

/**
 * Embedding search result — re-uses the canonical EmbeddingSampleSchema from
 * admin-types so the `id` field and genre type (number[]) are consistent with
 * what the server actually sends.
 */
export { EmbeddingSampleSchema as EmbeddingSearchResultSchema };
export type EmbeddingSearchResult = z.infer<typeof EmbeddingSampleSchema>;

/**
 * Embedding search response
 */
export const EmbeddingSearchResponseSchema = z
    .object({
        /** Query used */
        query: z.string().describe('Query'),
        /** Media type filter */
        mediaType: z.string().nullable().describe('Media type'),
        /** Search results */
        results: z.array(EmbeddingSampleSchema).describe('Results'),
        /** Result count */
        count: z.number().int().describe('Count'),
    })
    .meta({
        id: 'EmbeddingSearchResponse',
        description: 'Embedding search response',
    });

export type EmbeddingSearchResponse = z.infer<typeof EmbeddingSearchResponseSchema>;

/**
 * MDBList status response
 */
export const MdblistStatusResponseSchema = z
    .object({
        /** Whether tags are synced */
        synced: z.boolean().describe('Synced'),
        /** Total items */
        total: z.number().int().describe('Total items'),
        /** Items with tags */
        withTags: z.number().describe('Items with tags'),
        /** Items without tags */
        withoutTags: z.number().describe('Items without tags'),
        /** Minimum required tagged items */
        minRequired: z.number().describe('Minimum required'),
        /** Coverage percentage */
        percentage: z.number().describe('Coverage percentage'),
        /** Status message */
        message: z.string().describe('Status message'),
    })
    .meta({
        id: 'MdblistStatusResponse',
        description: 'MDBList status response',
    });

export type MdblistStatusResponse = z.infer<typeof MdblistStatusResponseSchema>;

/**
 * Watch history count response
 * Bare object: no success wrapper.
 */
export const WatchHistoryCountResponseSchema = z
    .object({
        /** Watch history / ratings count */
        count: z.number().int().describe('Count'),
        /** Users with at least one rating */
        users: z.number().optional().describe('Users with ratings'),
        /** Data source label */
        source: z.string().optional().describe('Data source'),
    })
    .meta({
        id: 'WatchHistoryCountResponse',
        description: 'Watch history count response',
    });

export type WatchHistoryCountResponse = z.infer<typeof WatchHistoryCountResponseSchema>;

/**
 * New items scan response
 * Extends BullMQ task status with scan-specific fields.
 */
export const NewItemsScanResponseSchema = BullMQTaskStatusSchema.omit({
    jobState: true,
})
    .extend({
        /** Legacy status field (mapped from jobState) */
        status: z.enum(['idle', 'active']).describe('Task status'),
        /** Last scan time (legacy field) */
        lastScanTime: z.string().nullable().describe('Last scan time'),
        /** Last scan result object (null when no scan has run yet) */
        lastScanResult: z
            .object({
                newItems: z.number().optional().describe('New items found'),
                itemsFound: z.number().optional().describe('Items found'),
                skippedItems: z.number().optional().describe('Skipped items'),
                errors: z.number().optional().describe('Error count'),
            })
            .nullable()
            .describe('Last scan result'),
        /** Scan interval (minutes) */
        intervalMinutes: z.number().describe('Scan interval (minutes)'),
        /** Next scan time */
        nextScanTime: z.string().nullable().describe('Next scan time'),
        /** Cache size */
        cacheSize: z.number().describe('Cache size'),
    })
    .meta({
        id: 'NewItemsScanResponse',
        description: 'New items scan response',
    });

export type NewItemsScanResponse = z.infer<typeof NewItemsScanResponseSchema>;

// ============================================================================
// Check Embeddings Response (/api/ai/check-embeddings)
// ============================================================================

// ============================================================================
// Embedding Preview Response (/api/ai/embedding-preview)
// ============================================================================

/**
 * Embedding text preview response
 */
export const EmbeddingPreviewResponseSchema = z
    .object({
        /** Sample embedding text previews */
        previews: z
            .array(
                z.object({
                    /** Source system */
                    source: z.string().describe('Source system'),
                    /** Media title */
                    title: z.string().describe('Title'),
                    /** Media type */
                    mediaType: z.string().describe('Media type'),
                    /** TMDB ID if available */
                    tmdbId: z.number().optional().describe('TMDB ID'),
                    /** Generated embedding text */
                    embeddingText: z.string().describe('Embedding text'),
                    /** Raw source data */
                    rawData: z.record(z.string(), z.unknown()).describe('Raw data'),
                }),
            )
            .describe('Embedding previews'),
        /** Connection status info */
        info: z
            .object({
                /** Jellyfin connection status */
                jellyfinConnected: z.boolean().describe('Jellyfin connected'),
                /** Jellyseerr connection status */
                jellyseerrConnected: z.boolean().describe('Jellyseerr connected'),
                /** Info note */
                note: z.string().describe('Note'),
                /** Timestamp */
                timestamp: z.string().describe('Timestamp'),
            })
            .describe('Connection info'),
    })
    .meta({
        id: 'EmbeddingPreviewResponse',
        description: 'Embedding preview response',
    });

export type EmbeddingPreviewResponse = z.infer<typeof EmbeddingPreviewResponseSchema>;

// ============================================================================
// Lookup Embedding Response (/api/ai/lookup-embedding)
// ============================================================================

/**
 * Embedding lookup response — matches the actual server shape:
 *   { key, result, count }
 * where `result` is a single EmbeddingLookupResult (or null when not found).
 */
export const LookupEmbeddingResponseSchema = z
    .object({
        /** Lookup key that was queried (UUID or composite) */
        key: z.string().describe('Lookup key (UUID or composite provider:id:type)'),
        /** Matching embedding entry, or null when not found */
        result: EmbeddingLookupResultSchema.nullable().describe('Matched embedding entry'),
        /** Number of DB rows matched (normally 0 or 1) */
        count: z.number().int().describe('Row count'),
    })
    .meta({
        id: 'LookupEmbeddingResponse',
        description: 'Embedding lookup response',
    });

export type LookupEmbeddingResponse = z.infer<typeof LookupEmbeddingResponseSchema>;

// ============================================================================
// Sync MDBList Response (/api/ai/sync-mdblist)
// ============================================================================
