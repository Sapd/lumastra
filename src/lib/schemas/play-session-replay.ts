// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { EndReasonSchema } from './session-update.js';
import { MusicPlayEndBatchResponseSchema } from './music-play-events.js';

export const ReplayItemSchema = z
    .object({
        eventId: z.string().uuid(),
        kind: z.literal('music'),
        mediaId: z.string().uuid(),
        startedAt: z.string().datetime({ offset: true }),
        endedAt: z.string().datetime({ offset: true }).optional(),
        positionMs: z.number().int().nonnegative(),
        listenedMs: z.number().int().nonnegative().max(604_800_000),
        durationMs: z.number().int().positive().optional(),
        endReason: EndReasonSchema,
        playContext: z.string().max(255).optional(),
        playbackSessionId: z
            .string()
            .uuid()
            .optional()
            .describe(
                'Server playback session id of the live session this listen belonged to. When present, the play counts at most once across live reports and this replay',
            ),
        startReported: z
            .boolean()
            .default(false)
            .describe(
                'Advisory: true after a positive live heard report was acknowledged. The server deduplicates counts using eventId regardless of this hint',
            ),
    })
    .refine((item) => !item.endedAt || Date.parse(item.endedAt) >= Date.parse(item.startedAt), {
        message: 'endedAt must not precede startedAt',
        path: ['endedAt'],
    });

// Validate each item separately so one invalid entry cannot reject the entire queue.
export const ReplayRequestSchema = z.object({ items: z.array(z.unknown()).min(1).max(100) });
export const ReplayDocumentedRequestSchema = z.object({
    items: z.array(ReplayItemSchema).min(1).max(100),
});
export const ReplayResponseSchema = MusicPlayEndBatchResponseSchema;
