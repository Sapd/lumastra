// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

export const FeedAvailabilitySchema = z.object({
    state: z.enum(['unknown', 'healthy', 'failed']).describe('Fresh observed feed state'),
    observedAt: z.string().optional().describe('Independent feed observation time'),
});
export const SourceAvailabilitySchema = z.object({
    sourceId: z.string().describe('Visible source UUID'),
    channelFeed: FeedAvailabilitySchema,
    guideFeed: FeedAvailabilitySchema,
    playback: z
        .enum(['unknown', 'healthy', 'partial', 'upstream', 'service'])
        .describe('Observed playback state'),
    playbackObservedAt: z.string().optional().describe('Latest genuine playback evidence'),
    failedChannelIds: z.array(z.string()).describe('Recently failed visible channels'),
});
export const LiveTvAvailabilitySchema = z
    .object({
        observedAt: z.string().describe('Summary evaluation time'),
        evidenceUnavailable: z.boolean().describe('Evidence could not be read within the deadline'),
        sources: z.array(SourceAvailabilitySchema),
        channels: z.record(z.string(), z.enum(['unknown', 'healthy', 'upstream', 'service'])),
        suppressedChannelIds: z
            .array(z.string())
            .describe('Homepage promotional exclusions; never a playback gate'),
    })
    .meta({ id: 'LiveTvAvailability', description: 'Sanitized observed Live TV availability' });
export type LiveTvAvailability = z.infer<typeof LiveTvAvailabilitySchema>;
export type SourceAvailability = z.infer<typeof SourceAvailabilitySchema>;
