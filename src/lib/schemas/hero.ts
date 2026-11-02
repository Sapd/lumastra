// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

/**
 * Minimal payload to SSR the hero's first slide. The full personalized
 * carousel still hydrates client-side; this is only slide 0.
 *
 * For episodes, externalIds.internal MUST be the episode's own media_id
 * (matching the client transform in hero-builder.ts) so SSR↔client
 * reconciliation keys agree and no flicker occurs. seriesId is carried
 * separately for logo/backdrop resolution.
 */
export const HeroFirstSlideSchema = z.object({
    title: z.string().describe('Display title for the slide'),
    mediaType: z.string().describe('Lowercase media type (movie, tv, episode, ...)'),
    overview: z.string().optional().describe('Synopsis text'),
    seasonCount: z.number().int().nonnegative().optional().describe('Known season count'),
    episodeCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Known total episodes, including provider metadata'),
    availableEpisodeCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Active playable episodes in permitted libraries'),
    watchedEpisodeCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Watched playable episodes for the current user'),
    unwatchedEpisodeCount: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('Unwatched playable episodes for the current user'),

    customMetadata: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Connector-owned metadata, including audiobook credits'),
    externalIds: z
        .object({
            internal: z.string().describe('Internal UUID — episode media_id for episodes'),
            tmdb: z.string().optional(),
        })
        .describe('Resolved identifiers; internal is required'),
    seriesId: z.string().optional().describe('Series id for logo/backdrop resolution (episodes)'),
    backdropBlurhash: z.string().optional().describe('Blurhash for the LQIP placeholder'),
    progress: z.number().optional().describe('Watch progress 0..1 for resume affordance'),
    runtimeMinutes: z.number().optional().describe('Total runtime in minutes, for "X min left"'),
    isPlaying: z
        .boolean()
        .optional()
        .describe(
            'A live session is actively playing this item — drives the "Playing now" hero treatment',
        ),
});

export type HeroFirstSlide = z.infer<typeof HeroFirstSlideSchema>;
