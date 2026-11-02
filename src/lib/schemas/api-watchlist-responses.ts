// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { MediaPreviewSchema } from './api-media-preview.js';
import { PageBlockSchema } from './pagination.js';

/** Additional provider scores retained on watchlist previews. */
export const AggregateRatingsSchema = z.object({
    letterboxd: z.number().nullable().optional().describe('Letterboxd score, 0-5'),
    letterboxdVotes: z.number().nullable().optional().describe('Letterboxd vote count'),
    rtAudience: z.number().nullable().optional().describe('Rotten Tomatoes audience score, 0-100'),
    mdblist: z.number().nullable().optional().describe('MDBList aggregate score'),
    trakt: z.number().nullable().optional().describe('Trakt score'),
    mal: z.number().nullable().optional().describe('MyAnimeList score'),
});

export type AggregateRatings = z.infer<typeof AggregateRatingsSchema>;

/** Canonical media ref plus the watchlist-only aggregate score block. */
export const WatchlistMediaRefSchema = MediaPreviewSchema.extend({
    ratings: AggregateRatingsSchema.optional().describe(
        'Aggregate provider scores beyond the canonical rating/criticRating pair.',
    ),
}).meta({
    id: 'WatchlistMediaRef',
    description: 'Canonical media ref with watchlist aggregate ratings.',
});

export type WatchlistMediaRef = z.infer<typeof WatchlistMediaRefSchema>;

/**
 * Series episode progress. Present only for series — a client renders "4/10"
 * from it, or falls back to the `watched` boolean when it is absent (movies).
 */
export const WatchlistEpisodeProgressSchema = z
    .object({
        watched: z.number().int().nonnegative().describe('Episodes the caller has watched'),
        total: z.number().int().nonnegative().describe('Active episodes currently ingested'),
    })
    .meta({ id: 'WatchlistEpisodeProgress' });
export type WatchlistEpisodeProgress = z.infer<typeof WatchlistEpisodeProgressSchema>;

export const WatchlistItemSchema = WatchlistMediaRefSchema.extend({
    isSaved: z.literal(true),
    savedAt: z.string().optional(),
    watched: z.boolean().describe(
        'Whether the caller has finished this item. Series: the explicit series watch flag ' +
            'or every episode watched; episodeProgress counts remain separate.',
    ),
    episodeProgress: WatchlistEpisodeProgressSchema.optional(),
    criticRating: z.number().optional(),
    certification: z.string().optional(),
    resolutionTier: z.string().optional(),
    hdrTier: z.string().optional(),
    hasAtmos: z.boolean().optional(),
    hasCc: z.boolean().optional(),
    hasSdh: z.boolean().optional(),
    hasAd: z.boolean().optional(),
}).meta({
    id: 'WatchlistItem',
    description: 'MediaPreview with saved state and separate episode counts.',
});

export type WatchlistItem = z.infer<typeof WatchlistItemSchema>;

export const WatchlistListResponseSchema = z
    .object({
        items: z.array(WatchlistItemSchema).describe('Watchlist entries'),
        page: PageBlockSchema.describe('Pagination info'),
    })
    .meta({ id: 'WatchlistListResponse', description: 'Paginated watchlist response' });

export type WatchlistListResponse = z.infer<typeof WatchlistListResponseSchema>;
