// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

export const AlbumMergeOptionsSchema = z.object({
    keepId: z.string().guid().describe('One album in the pair; not necessarily the survivor'),
    mergeId: z.string().guid().describe('The other album in the pair'),
    survivorId: z
        .string()
        .guid()
        .optional()
        .describe('Defaults to the older album (id breaks ties)'),
    title: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .optional()
        .describe('Album mode only: resulting survivor title; does not lock metadata'),
    overrideLocks: z.boolean().optional().describe('Explicitly allow metadata-locked albums'),
    mode: z.enum(['preview', 'apply']).optional().describe('Album preview or confirmed apply'),
    previewToken: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional()
        .describe('Required for album apply; returned by preview'),
});
export type AlbumMergeOptions = z.infer<typeof AlbumMergeOptionsSchema>;

const AlbumSchema = z.object({
    id: z.string().guid(),
    title: z.string(),
    createdAt: z.string(),
    trackCount: z.number().int(),
    metadataLocked: z.boolean(),
    parentId: z.string().nullable(),
    parentTitle: z.string().nullable(),
});
const TrackSchema = z.object({
    id: z.string().guid(),
    title: z.string(),
    albumId: z.string().guid(),
    disc: z.string().nullable(),
    number: z.string().nullable(),
});
export const AlbumMergePreviewSchema = z.object({
    keepId: z.string().guid(),
    mergeId: z.string().guid(),
    survivor: AlbumSchema,
    removed: AlbumSchema,
    tracksToMove: z.array(TrackSchema),
    trackCount: z.number().int(),
    resultingTrackCount: z.number().int(),
    resultingTitle: z.string().describe('Title of the resulting survivor album'),
    duplicateCandidates: z.array(
        z.object({
            movingTrackId: z.string().guid(),
            survivorTrackId: z.string().guid(),
            title: z.string(),
        }),
    ),
    parentArtist: z.object({
        id: z.string().nullable(),
        title: z.string(),
        various: z.boolean(),
        source: z.string(),
    }),
    selectedImages: z.array(
        z.object({
            role: z.enum(['poster', 'backdrop', 'logo', 'thumb']),
            sourceUrl: z.string().nullable(),
            survivorUrl: z.string().nullable(),
            resultUrl: z.string().nullable(),
        }),
    ),
    metadataKeys: z.object({ filled: z.array(z.string()), conflicts: z.array(z.string()) }),
    albumData: z.array(
        z.object({
            table: z.string(),
            sourceCount: z.number().int(),
            survivorCount: z.number().int(),
            policy: z.enum([
                'survivor-wins',
                'move-all',
                'merge-user-state',
                'artwork-alternatives',
                'archive-enrichment',
            ]),
        }),
    ),
    locks: z.object({
        requiresOverride: z.boolean(),
        overridden: z.boolean(),
        resultingLocked: z.boolean(),
    }),
    previewToken: z.string(),
});
export type AlbumMergePreview = z.infer<typeof AlbumMergePreviewSchema>;
export const AlbumMergeResultSchema = z.object({
    preview: AlbumMergePreviewSchema,
    applied: z.boolean(),
});
export type AlbumMergeResult = z.infer<typeof AlbumMergeResultSchema>;

/** Read-only grouping evidence. There is deliberately no many-album apply contract. */
export const CompilationRepairPreviewSchema = z.object({
    groups: z.array(
        z.object({
            albums: z.array(
                z.object({ id: z.uuid(), title: z.string(), artistTitle: z.string().nullable() }),
            ),
            trackCount: z.number().int().nonnegative(),
        }),
    ),
    skipped: z.array(z.object({ albumIds: z.array(z.uuid()), reason: z.string() })),
    truncated: z.boolean(),
});
export type CompilationRepairPreview = z.infer<typeof CompilationRepairPreviewSchema>;
