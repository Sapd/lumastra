// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { MethodMetadata } from '$lib/server/openapi.js';
import { AlbumMergeOptionsSchema, AlbumMergeResultSchema } from '$lib/schemas/album-merge.js';

export const MergeMediaRequestSchema = AlbumMergeOptionsSchema.refine(
    (input) => input.title === undefined || input.mode !== undefined,
    { path: ['title'], message: 'title is only supported in album preview/apply mode' },
);

export const MergeMediaResponseSchema = z.object({
    keepId: z.string().guid(),
    mergeId: z.string().guid(),
    // Fields from MediaDeletionService.MergeResult
    seasonsReparented: z.number().int().nonnegative(),
    itemsDeleted: z.number().int().nonnegative(),
});

export type MergeMediaRequest = z.infer<typeof MergeMediaRequestSchema>;
export const MergeEndpointResponseSchema = z.union([
    AlbumMergeResultSchema,
    MergeMediaResponseSchema,
]);

export const mediaMergeDocs = {
    tags: ['Admin'],
    summary: 'Preview or apply a media merge',
    description:
        'For albums, mode=preview is read-only and defaults to the older survivor. Apply requires the previewToken and identical options; stale previews or metadata locks without overrideLocks return 409. The optional title sets the resultingTitle without locking metadata and must match between preview and apply. Old titles remain scan aliases. Matching tracks keep both ids and all files. Other media retain the existing file-less duplicate merge behavior. Applying any merge removes a catalog entry and may combine user state. Files remaining on disk and metadata archives are not complete Undo. Routine auto-identify never performs these merges.',
    body: MergeMediaRequestSchema,
    responses: {
        404: 'Album or media item not found',
        409: 'Stale preview, metadata lock, active scan, or unsafe merge',
        422: 'Invalid pair or survivor',
        503: 'Database unavailable',
        200: {
            description: 'Merge preview, applied album merge, or legacy media merge',
            schema: MergeEndpointResponseSchema,
        },
    },
} satisfies MethodMetadata;
