// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

/** Discovery endpoints share opaque handles, ImageSet and PlaybackProgress. */
import { MediaPreviewSchema } from './api-media-preview.js';
import { PlaybackProgressSchema } from './api-playback-progress.js';
import { paginatedEnvelope } from './pagination.js';
export const ContinueWatchingRecommendationItemSchema = MediaPreviewSchema.omit({ score: true })
    .extend({ progress: PlaybackProgressSchema })
    .meta({ id: 'ContinueWatchingRecommendationItem' });
export const RecommendationItemSchema = MediaPreviewSchema;
export const TrendingItemSchema = MediaPreviewSchema;
export const UpcomingEpisodeItemSchema = MediaPreviewSchema;
export const UpcomingCalendarItemSchema = MediaPreviewSchema.extend({
    monitored: z.boolean(),
    hasFile: z.boolean(),
});
export const UpcomingItemSchema = MediaPreviewSchema;
export const ContinueWatchingResponseSchema = paginatedEnvelope(
    ContinueWatchingRecommendationItemSchema,
).meta({
    id: 'ContinueWatchingResponse',
    description:
        'Resumable media; progress uses milliseconds and score is never playback progress.',
});
export const RecommendationsResponseSchema = paginatedEnvelope(MediaPreviewSchema).meta({
    id: 'RecommendationsResponse',
});
export const TrendingResponseSchema = paginatedEnvelope(MediaPreviewSchema).meta({
    id: 'TrendingResponse',
});
export const UpcomingResponseSchema = z
    .object({
        items: z.array(
            MediaPreviewSchema.extend({
                monitored: z.boolean().optional(),
                hasFile: z.boolean().optional(),
            }),
        ),
        page: z.object({
            limit: z.number().int(),
            offset: z.number().int(),
            hasMore: z
                .boolean()
                .optional()
                .describe('Present only for view=calendar, which supports offset pagination'),
            truncated: z
                .boolean()
                .optional()
                .describe('Present only for episodes/alerts: more results exist than limit'),
            total: z.number().int().optional(),
        }),
    })
    .meta({
        id: 'UpcomingResponse',
        description:
            'Episode previews with typed context. Only calendar (which also includes movies, monitored and hasFile) supports offset pagination; episodes/alerts report truncation.',
    });

