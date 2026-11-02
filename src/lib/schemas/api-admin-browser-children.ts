// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/media/{id}/browser-children — the media browser's series
 * drill-down (triage spec §4). Shared by the def (server-side `.parse()`) and
 * the client (`getBrowserChildren` in `$lib/api/admin`).
 */

import { z } from 'zod';

export const MediaIssueSchema = z.object({
    kind: z.enum([
        'files_lost',
        'file_problem',
        'no_tmdb',
        'no_poster',
        'no_overview',
        'duplicate',
        'not_in_jellyfin',
    ]),
    severity: z.enum(['error', 'warn', 'info']),
    subtype: z.string().optional().describe('Health issue type, "integrity" or "episodes"'),
    detail: z.string().optional().describe('Recorded reason, for the hover'),
    count: z.number().int().optional().describe('Episode count for a rolled-up series problem'),
});

export const BrowserChildRowSchema = z.object({
    id: z.string(),
    title: z.string(),
    mediaType: z.string().describe('Storage vocabulary: "season" or "episode"'),
    seasonNumber: z.number().int().optional(),
    episodeNumber: z.number().int().optional(),
    hasFiles: z.boolean(),
    issues: z.array(MediaIssueSchema),
});

export const BrowserSeasonGroupSchema = z.object({
    season: BrowserChildRowSchema.optional().describe(
        'Absent for episodes parented directly to the series',
    ),
    seasonNumber: z.number().int(),
    episodes: z.array(BrowserChildRowSchema),
    withFiles: z.number().int().describe('Episodes in this group that have files'),
});

export const BrowserChildrenResponseSchema = z.object({
    seasons: z.array(BrowserSeasonGroupSchema),
    truncated: z
        .boolean()
        .describe(
            'More seasons/episodes exist than the drill-down returns; the detail page lists all',
        ),
});

export type BrowserChildrenResponse = z.infer<typeof BrowserChildrenResponseSchema>;
export type BrowserSeasonGroupDto = z.infer<typeof BrowserSeasonGroupSchema>;
export type BrowserChildRowDto = z.infer<typeof BrowserChildRowSchema>;
