// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { boundedListEnvelope } from './pagination.js';
import { UpcomingEpisodeItemSchema } from './api-recommender-responses.js';

/**
 * Wire shape of GET /api/v1/integrations/upcoming — one user's upcoming episodes for
 * an external integration (a chat bot answering "what's new for me"). The items are
 * exactly what `GET /api/v1/upcoming?view=episodes` returns to that user.
 */

export const UpcomingIntegrationQuerySchema = z.object({
    user: z
        .string()
        .trim()
        .min(1)
        .max(255)
        .refine((v) => !v.includes('\u0000'), 'Must not contain NUL')
        .describe('Lumastra username (case-insensitive) or user UUID'),
    days: z.coerce
        .number()
        .int()
        .min(1)
        .max(30)
        .default(7)
        .describe('Only episodes airing within this many days from now (1-30, default 7)'),
    limit: z.coerce
        .number()
        .int()
        .min(1)
        .max(30)
        .default(20)
        .describe('Maximum number of episodes (1-30, default 20)'),
});

export type UpcomingIntegrationQuery = z.infer<typeof UpcomingIntegrationQuerySchema>;

export const UpcomingIntegrationResponseSchema = boundedListEnvelope(
    UpcomingEpisodeItemSchema,
).meta({
    id: 'UpcomingIntegrationResponse',
    description:
        'Bounded upcoming episode previews with typed context; truncated indicates more candidates.',
});

export type UpcomingIntegrationResponse = z.infer<typeof UpcomingIntegrationResponseSchema>;
