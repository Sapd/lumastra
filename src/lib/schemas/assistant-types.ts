// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AI Assistant Types - Zod Schemas
 *
 * Schemas for AI assistant interface types.
 *
 * Convention:
 * - Use .optional() for optional fields (NOT .nullable())
 * - Add .meta({ description: '...' }) for OpenAPI docs
 * - Export both schema and inferred type
 */

import { z } from 'zod';
import { publicMovieSeriesSchema } from './common';
import { ExternalIdsResponseSchema } from './api-responses';

// ============================================================================
// Recommended Movie
// ============================================================================

/**
 * Recommended movie from AI assistant
 */
export const RecommendedMovieSchema = z
    .object({
        /** External IDs from various providers */
        externalIds: ExternalIdsResponseSchema.describe('External provider IDs'),
        /** Movie/show title */
        title: z.string().describe('Title'),
        /** Media type discriminator */
        mediaType: publicMovieSeriesSchema,
        /** Plot overview/synopsis */
        overview: z.string().describe('Overview/synopsis'),
        /** Genre list */
        genres: z.array(z.string()).describe('Genres'),
        /** IMDB rating (0-10) */
        imdbRating: z.number().optional().describe('IMDB rating'),
        /** Rotten Tomatoes rating (0-100) */
        rtRating: z
            .number()
            .optional()
            .describe('Rotten Tomatoes critic score (Tomatometer), 0-100'),
        rtAudienceScore: z
            .number()
            .optional()
            .describe('Rotten Tomatoes audience score (Popcornmeter), 0-100'),
        /** TMDB rating (0-10) */
        tmdbRating: z.number().optional().describe('TMDB rating'),
        /** Runtime in minutes */
        runtimeMinutes: z.number().optional().describe('Runtime in minutes'),
        /** Release date (ISO string) */
        releaseDate: z.string().optional().describe('Release date'),
        /** User's rating for this item */
        userRating: z.number().optional().describe('User rating'),
        /** Whether available in local library */
        isAvailable: z.boolean().describe('Available in library'),
        /** Whether user can request via Jellyseerr */
        canRequest: z.boolean().describe('Can be requested'),
        /** Action URL (watch/request endpoint) */
        actionUrl: z.string().describe('Action URL'),
        /** Action type */
        actionType: z.enum(['watch', 'request', 'unavailable']).describe('Action type'),
    })
    .meta({
        id: 'RecommendedMovie',
        description: 'AI assistant recommended movie',
    });

export type RecommendedMovie = z.infer<typeof RecommendedMovieSchema>;

// ============================================================================
// Recommended Music
// ============================================================================

/**
 * A music recommendation card (track, album, or artist). Music is local-only —
 * no request/availability concept. The client acts on it directly: a track
 * plays via the music player; an album/artist opens its modal. Poster comes
 * from the catalog image proxy (which walks the parent chain, so a track id
 * resolves album art).
 */
export const RecommendedMusicSchema = z
    .object({
        id: z.string().describe('Internal media UUID'),
        title: z.string().describe('Title'),
        mediaType: z.enum(['track', 'album', 'artist']).describe('Music media type'),
        artistName: z.string().optional().describe('Artist name'),
        artistId: z.string().optional().describe('Artist UUID'),
        albumTitle: z.string().optional().describe('Album title'),
        albumId: z.string().optional().describe('Album UUID'),
        posterUrl: z.string().optional().describe('Catalog poster URL'),
        bucket: z.string().optional().describe('Quick-picks recommendation bucket'),
    })
    .meta({
        id: 'RecommendedMusic',
        description: 'AI assistant recommended music item',
    });

export type RecommendedMusic = z.infer<typeof RecommendedMusicSchema>;

// ============================================================================
// Message
// ============================================================================

/**
 * AI assistant message (user or assistant)
 */
export const MessageSchema = z
    .object({
        /** Message sender role */
        role: z.enum(['user', 'assistant']).describe('Sender role'),
        /** Message text content */
        content: z.string().describe('Message content'),
        /** Model reasoning summary (assistant messages, Claude thinking) */
        thinking: z.string().optional().describe('Model reasoning summary'),
        /** Message timestamp */
        timestamp: z.date().describe('Message timestamp'),
        /** Recommended movies (assistant messages only) */
        recommendedMovies: z
            .array(RecommendedMovieSchema)
            .optional()
            .describe('Recommended movies'),
        /** Recommended music (assistant messages only) */
        recommendedMusic: z.array(RecommendedMusicSchema).optional().describe('Recommended music'),
    })
    .meta({ id: 'Message', description: 'AI assistant message' });

export type Message = z.infer<typeof MessageSchema>;

// ============================================================================
// Rate Limit
// ============================================================================

/**
 * Rate limit status for AI assistant endpoint
 */
export const RateLimitSchema = z
    .object({
        /** Remaining requests in current window */
        remaining: z.number().int().describe('Remaining requests'),
        /** Total request limit per window */
        limit: z.number().int().describe('Request limit'),
        /** Whether user is admin (exempt from limits) */
        isAdmin: z.boolean().describe('User is admin'),
    })
    .meta({ id: 'RateLimit', description: 'AI assistant rate limit status' });

export type RateLimit = z.infer<typeof RateLimitSchema>;
