// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin file-episodes editor: link one file to an ordered list of episodes with
 * a window each (GET/PUT/DELETE /api/admin/media/{id}/files/{fileId}/episodes).
 */

import { z } from 'zod';

export const BoundaryOriginSchema = z.enum([
    'manual',
    'chapter',
    'runtime-split',
    'even-split',
    'unknown',
]);

export const FileEpisodeLinkSchema = z.object({
    mediaItemId: z.string().guid(),
    seasonNumber: z.number().int().nullable(),
    episodeNumber: z.number().int().nullable(),
    title: z.string().nullable(),
    isDismissed: z.boolean().describe('Whether this episode is currently dismissed'),
    dismissedAt: z.string().nullable().describe('Current dismissal timestamp, when recorded'),
    isDefault: z.boolean(),
    sortOrder: z.number().int(),
    startMs: z.number().nullable(),
    endMs: z.number().nullable(),
    boundaryOrigin: BoundaryOriginSchema.nullable().optional(),
    offsetSource: z.string().nullable().describe("'manual' when an admin set the link by hand"),
});

export const FileEpisodeCandidateSchema = z.object({
    id: z.string().guid(),
    seasonNumber: z.number().int().nullable(),
    episodeNumber: z.number().int().nullable(),
    title: z.string().nullable(),
    isDismissed: z.boolean().describe('Whether this episode is currently dismissed'),
    dismissedAt: z.string().nullable().describe('Current dismissal timestamp, when recorded'),
    runtimeMs: z.number().nullable(),
});

export const FileEpisodesResponseSchema = z.object({
    undoId: z.uuid().optional().describe('Restore the preceding complete file mapping choice.'),
    revision: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .describe('Mapping review revision required for Save or reset'),
    series: z.object({ id: z.string().guid(), title: z.string().nullable() }).optional(),
    file: z.object({
        id: z.string().guid(),
        filePath: z.string(),
        durationMs: z.number().nullable(),
        manual: z.boolean(),
    }),
    links: z.array(FileEpisodeLinkSchema),
    chapters: z.array(z.object({ name: z.string().nullable(), startMs: z.number() })),
    episodes: z.array(FileEpisodeCandidateSchema),
});

export const SetFileEpisodesRequestSchema = z.object({
    undoReceiptId: z
        .uuid()
        .optional()
        .describe('Restore this guarded receipt instead of saving a new mapping.'),
    revision: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .describe('Revision returned by the reviewed GET'),
    restoreDismissedEpisodeIds: z
        .array(z.string().guid())
        .max(50)
        .optional()
        .describe('Explicit acknowledgement to restore these selected dismissed episodes'),
    /** In file order: the first entry plays first. */
    episodes: z
        .array(
            z.object({
                mediaItemId: z.string().guid(),
                boundaryOrigin: BoundaryOriginSchema.optional(),
                startMs: z.number().int().min(0).optional(),
                endMs: z.number().int().min(0).optional(),
            }),
        )
        .min(1)
        .max(50),
});

export type FileEpisodesResponse = z.infer<typeof FileEpisodesResponseSchema>;
export type FileEpisodeCandidate = z.infer<typeof FileEpisodeCandidateSchema>;
export type FileEpisodeLink = z.infer<typeof FileEpisodeLinkSchema>;
export type SetFileEpisodesRequest = z.infer<typeof SetFileEpisodesRequestSchema>;
