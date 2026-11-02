// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media Context Composite Response Schema
 *
 * Zod schema for the composite GET /api/media/[id]/context endpoint.
 * Aggregates multiple independent data sections into one response
 * to reduce client-side waterfall requests when opening media modals.
 *
 * Every section is optional — the server omits sections that fail,
 * aren't requested, or don't apply (e.g., nextEpisode for movies).
 *
 * Contract alignment (new): all sections use the new API contract —
 * `type` (not `mediaType`), `ids` (not `externalIds`), `images{}` hrefs.
 */

import { z } from 'zod';
import { MediaDetailSchema } from './media-detail';
import { SocialActivityItemSchema } from './api-media-responses';

// ============================================================================
// Shared image schema for context sections
// ============================================================================

const ContextImageRoleSchema = z.object({
    href: z.string(),
    thumb: z.string().optional(),
    card: z.string().optional(),
    wide: z.string().optional(),
    full: z.string().optional(),
});

const ContextImagesSchema = z.object({
    poster: ContextImageRoleSchema.optional(),
    backdrop: ContextImageRoleSchema.optional(),
    still: ContextImageRoleSchema.optional(),
});

/** The context endpoint emits canonical title/duration fields, not the standalone legacy next-episode response. */
export const ContextNextEpisodeSchema = z.object({
    id: z.string(),
    title: z.string().nullable(),
    seasonNumber: z.number().int().nullable(),
    episodeNumber: z.number().int().nullable(),
    overview: z.string().optional(),
    durationMs: z
        .number()
        .int()
        .nullable()
        .describe(
            'Duration in milliseconds; null when neither metadata nor a probed file gives one (e.g. an episode that has not aired yet)',
        ),
    premiereDate: z.string().optional(),
    images: ContextImagesSchema.optional(),
});

// ============================================================================
// Similar item shape — new contract: type + ids + images{}
// ============================================================================

const ContextSimilarItemSchema = z.object({
    id: z.string(),
    type: z.enum(['movie', 'series']),
    ids: z.record(z.string(), z.string()),
    title: z.string(),
    year: z.number().int().optional(),
    overview: z.string().optional(),
    images: ContextImagesSchema.optional(),
    similarity: z.number().optional(),
    userRating: z.number().int().optional(),
    isAvailable: z.boolean().optional(),
    canRequest: z.boolean().optional(),
});

export type ContextSimilarItem = z.infer<typeof ContextSimilarItemSchema>;

// ============================================================================
// Media Context Response
// ============================================================================

export const MediaContextResponseSchema = z
    .object({
        included: z
            .array(z.string())
            .describe('Requested sections that succeeded; absent sections were unavailable'),
        /**
         * Full media details — minimal canonical shape from GET /api/media/{id}.
         * Fields: id, type, ids, title, year?, overview?, images?
         * Plus extended optional fields when available (genres, actors, etc.)
         */
        details: MediaDetailSchema.optional().describe('Full media details'),

        /** Similar content with AI similarity scores — new contract (type+ids+images) */
        similar: z
            .object({
                sourceMedia: z
                    .object({
                        id: z.string(),
                        ids: z.record(z.string(), z.string()).optional(),
                        title: z.string(),
                        type: z.enum(['movie', 'series']),
                    })
                    .optional(),
                similar: z.array(ContextSimilarItemSchema),
                count: z.number().int().optional(),
            })
            .optional()
            .describe('Similar content (new contract: type+ids+images)'),

        /** Friend watch activity */
        social: z
            .object({
                activities: z.array(SocialActivityItemSchema),
            })
            .optional()
            .describe('Social watch activity'),

        /** User rating for this content */
        rating: z
            .object({
                rating: z.number().optional(),
                canRate: z.boolean().optional(),
                message: z.string().optional(),
            })
            .optional()
            .describe('User rating'),

        /** Next unwatched episode (series only) */
        nextEpisode: ContextNextEpisodeSchema.optional().describe('Next unwatched episode'),

        /** Watched status */
        watched: z
            .object({
                watched: z.boolean(),
            })
            .optional()
            .describe('Watched status'),
    })
    .meta({
        id: 'MediaContextResponse',
        description: 'Composite media context response aggregating multiple data sections',
    });

export type MediaContextResponse = z.infer<typeof MediaContextResponseSchema>;
