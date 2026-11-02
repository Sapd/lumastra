// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sessions API Response Zod Schemas
 *
 * SINGLE SOURCE OF TRUTH for session response types.
 * Used by GET /api/v1/sessions and related session endpoints.
 *
 * Convention:
 * - Use .optional() for optional fields (NOT .nullable())
 * - Add .describe() for OpenAPI docs
 * - Export both schema and inferred type
 */

import { z } from 'zod';

// ============================================================================
// Current Session
// ============================================================================

export const CurrentSessionSchema = z.object({
    title: z.string().describe('Media title'),
    subtitle: z.string().optional().describe('Episode info, artist name, or chapter'),
    mediaType: z.string().describe('movie, tv, episode, music, audiobook, etc.'),
    state: z.enum(['playing', 'paused']).describe('Playback state'),
    progress: z.number().describe('Progress percentage 0-100'),
    currentTime: z.number().describe('Current position in seconds'),
    duration: z.number().describe('Total duration in seconds'),
    imageUrl: z.string().optional().describe('Signed image URL, 10-min TTL'),
    year: z.number().optional().describe('Release year'),
    contentRating: z.string().optional().describe('PG-13, TV-MA, etc.'),
    sessionSource: z
        .enum(['jellyfin', 'lumastra', 'subsonic'])
        .optional()
        .describe('Origin of this session'),
    clientName: z.string().optional().describe('Client app name'),
    clientVersion: z.string().optional().describe('Client version and build (admin only)'),
    userAgent: z.string().optional().describe('Raw User-Agent (admin only)'),
});

export type CurrentSession = z.infer<typeof CurrentSessionSchema>;

// ============================================================================
// Current Sessions Response
// ============================================================================

export const CurrentSessionsResponseSchema = z.object({
    sessions: z.array(CurrentSessionSchema),
});

export type CurrentSessionsResponse = z.infer<typeof CurrentSessionsResponseSchema>;
