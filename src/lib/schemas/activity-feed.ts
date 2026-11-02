// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { publicAuthorSchema } from './public-author';

export const ActivityTypeSchema = z.enum([
    'started',
    'finished',
    'abandoned',
    'watchlist_add',
    'watchlist_remove',
    'rating',
]);

export const ActivityFeedEntrySchema = z.object({
    id: z.number().int(),
    author: publicAuthorSchema,
    activityType: ActivityTypeSchema,
    mediaId: z.string().nullable(),
    mediaType: z.string().nullable(),
    ratingValue: z.number().nullable(),
    externalIds: z.record(z.string(), z.union([z.string(), z.number()]).nullable()),
    title: z.string(),
    year: z.number().int().nullable(),
    seriesName: z.string().nullable(),
    seasonNumber: z.number().int().nullable(),
    episodeNumber: z.number().int().nullable(),
    completionPercentage: z.number().nullable(),
    watchTimeSeconds: z.number().nullable(),
    sourceService: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    bitrate: z.number().nullable(),
    deviceId: z.string().nullable(),
    deviceName: z.string().nullable(),
    userAgent: z.string().nullable(),
    clientName: z.string().nullable(),
    clientVersion: z.string().nullable(),
    ipAddress: z.string().nullable(),
    playMethod: z.string().nullable(),
    transcodeMode: z.string().nullable(),
    resolutionWidth: z.number().int().nullable(),
    resolution: z.string().nullable(),
    videoCodec: z.string().nullable(),
    audioCodec: z.string().nullable(),
    container: z.string().nullable(),
    stopReason: z.string().nullable(),
    sourcePlaySessionId: z.string().nullable(),
    sourceSessionId: z.string().nullable(),
    planMode: z.string().nullable(),
    planReasons: z.array(z.string()).nullable(),
    subtitleMethod: z.string().nullable(),
    transcodeCodec: z.string().nullable(),
    deliveryPath: z.string().nullable(),
    totalDurationSeconds: z.number().nullable(),
    currentPositionSeconds: z.number().nullable(),
    currentProgressPercentage: z.number().nullable(),
    isPaused: z.boolean(),
    isActive: z.boolean(),
    lastUpdateTime: z.string().nullable(),
    activityTime: z.string(),
    createdAt: z.string(),
    occurrenceCount: z.number().int().optional(),
});

export const ActivityFeedResponseSchema = z.object({
    items: z.array(ActivityFeedEntrySchema),
    page: z.object({
        limit: z.number().int(),
        offset: z.number().int().optional(),
        hasMore: z.boolean(),
    }),
});

export type ActivityType = z.infer<typeof ActivityTypeSchema>;
export type ActivityFeedEntry = z.infer<typeof ActivityFeedEntrySchema>;
export type ActivityFeedResponse = z.infer<typeof ActivityFeedResponseSchema>;
