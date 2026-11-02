// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Modal Props Schema
 *
 * SINGLE SOURCE OF TRUTH for ModalMovie component props.
 * Unifies ModalMovie.Props (78 fields), modal-data.ModalMediaData (40 fields),
 * and modal-utils.MediaItem (40 fields) into one canonical schema.
 *
 * All field names use camelCase. openMediaModal() normalizes snake_case inputs
 * at the boundary before passing to ModalMovie.
 *
 * Convention:
 * - Use .optional() for optional fields (NOT .nullable())
 * - Add .describe() for documentation
 * - Export both schema and inferred type
 */

import { z } from 'zod';
import { ExternalIdsResponseSchema } from './api-responses';

export const RatingBundleSchema = z.object({
    rtCritic: z.number().optional().describe('Rotten Tomatoes critic score (0–100)'),
    rtAudience: z.number().optional().describe('Rotten Tomatoes audience score (0–100)'),
    letterboxdRating: z.number().optional().describe('Letterboxd average rating (0–5)'),
    letterboxdVotes: z.number().optional().describe('Letterboxd number of ratings'),
    traktScore: z.number().optional().describe('Trakt rating (0–100)'),
    metacriticScore: z.number().optional().describe('Metacritic score (0–100)'),
    mdblistScore: z.number().optional().describe('MDBList aggregated score (0–100)'),
});

export type RatingBundle = z.infer<typeof RatingBundleSchema>;

/**
 * Canonical shape for all modal props.
 * Self-healing pattern preserved: callers pass minimal data, modal auto-fetches missing fields.
 */
export const ModalPropsSchema = z
    .object({
        // Core identity (required except modalId which is injected by modal system)
        title: z.string().describe('Media title'),
        image: z.string().describe('Poster image URL'),
        mediaType: z.string().describe('Media type (movie, tv, episode, etc.)'),
        modalId: z.string().describe('Modal instance ID (injected by modal system)'),

        // External identifiers
        externalIds: ExternalIdsResponseSchema.optional().describe(
            'External IDs (tmdb, imdb, tvdb, etc.)',
        ),

        // Internal IDs
        seriesInternalId: z.string().optional().describe('Internal UUID of the parent series'),
        sonarrSeriesId: z.number().optional().describe('Sonarr series ID'),

        // Metadata
        year: z.union([z.string(), z.number()]).optional().describe('Release year'),
        rating: z.number().optional().describe('Primary rating (0-10)'),
        criticRating: z.number().optional().describe('Critic rating'),
        genres: z.array(z.string()).optional().describe('Genre names'),
        duration: z.number().optional().describe('Duration in seconds'),
        studio: z.string().optional().describe('Production studio'),
        author: z.string().optional().describe('Author (for books/audiobooks)'),
        overview: z.string().optional().describe('Full overview/description'),

        // Series/Episode context
        seriesName: z.string().optional().describe('Series name (for episodes)'),
        seasonNumber: z.number().optional().describe('Season number'),
        episodeNumber: z.number().optional().describe('Episode number'),
        initialSeason: z
            .number()
            .optional()
            .describe('Initial season to display (for series modal)'),
        initialEpisode: z
            .number()
            .optional()
            .describe('Initial episode to display (for series modal)'),
        seriesChildCount: z.number().optional().describe('Number of children (seasons/episodes)'),

        // Aggregated third-party ratings
        ratings: RatingBundleSchema.optional().describe('Aggregated third-party ratings'),

        // Sonarr info
        sonarrNetwork: z.string().optional().describe('Network (for Sonarr series)'),
        sonarrQuality: z.string().optional().describe('Quality profile'),
        sonarrHasFile: z.boolean().optional().describe('Whether file exists'),
        sonarrAirDate: z.string().optional().describe('Air date'),
        sonarrAbsoluteEpisode: z.number().optional().describe('Absolute episode number'),

        // Availability
        isAvailable: z.boolean().optional().describe('Available in library'),
        canRequest: z.boolean().optional().describe('Can be requested'),
        availabilitySource: z.string().optional().describe('Source of availability data'),

        // Media (union type for remoteTrailers supports both string and string[])
        remoteTrailers: z
            .union([z.string(), z.array(z.string())])
            .optional()
            .describe('Trailer URL or URLs'),
        imageBackdropId: z.string().optional().describe('Backdrop image ID'),

        // Cast and crew
        actors: z
            .array(
                z.union([
                    z.string(),
                    z.object({
                        name: z.string(),
                        character: z.string().optional(),
                    }),
                ]),
            )
            .optional()
            .describe('Actor list (string names or objects with character)'),
        directors: z.array(z.string()).optional().describe('Director names'),
    })
    .meta({
        id: 'ModalProps',
        description: 'Canonical modal props schema (unified from 3 overlapping types)',
    });

/**
 * Canonical modal props type (DL-003).
 *
 * Inferred from ModalPropsSchema.
 *
 * Use this type in all modal-related code.
 */
export type ModalProps = z.infer<typeof ModalPropsSchema>;
