// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

export const ImageUploadUrlSchema = z.object({
    artworkType: z.enum(['poster', 'backdrop', 'logo', 'thumb']),
    url: z.string().url(),
});
export type ImageUploadUrl = z.infer<typeof ImageUploadUrlSchema>;

export const ImageUploadResponseSchema = z.object({
    success: z.boolean(),
    filePath: z.string(),
    serveUrl: z.string(),
    undoId: z.uuid().optional().describe('Receipt restoring the preceding artwork selection.'),
});
export type ImageUploadResponse = z.infer<typeof ImageUploadResponseSchema>;

export const ImageDeleteResponseSchema = z.object({
    success: z.boolean(),
    deleted: z.boolean(),
});
export type ImageDeleteResponse = z.infer<typeof ImageDeleteResponseSchema>;

export const MetadataUpdateResponseSchema = z.object({
    locked: z.boolean(),
});
export type MetadataUpdateResponse = z.infer<typeof MetadataUpdateResponseSchema>;

const BrowseImageSchema = z.object({
    filePath: z.string(),
    thumbUrl: z.string(),
    fullUrl: z.string(),
    width: z.number(),
    height: z.number(),
    language: z.string().nullable(),
    voteAverage: z.number(),
});

export const ImageBrowseResponseSchema = z.object({
    posters: z.array(BrowseImageSchema),
    backdrops: z.array(BrowseImageSchema),
    logos: z.array(BrowseImageSchema),
});
export type ImageBrowseResponse = z.infer<typeof ImageBrowseResponseSchema>;
export type BrowseImage = z.infer<typeof BrowseImageSchema>;

export const MetadataStatusResponseSchema = z.object({
    locked: z.boolean(),
    lockedBy: z.string().nullable(),
    lockedAt: z.string().nullable(),
});
export type MetadataStatusResponse = z.infer<typeof MetadataStatusResponseSchema>;

export const ArtworkItemSchema = z.object({
    id: z.string(),
    artworkType: z.enum(['poster', 'backdrop', 'logo', 'thumb']),
    url: z.string(),
    source: z.enum(['self', 'season', 'series', 'album', 'artist']),
    sourceId: z.string(),
    sourceName: z.string(),
    discogsUrl: z
        .string()
        .url()
        .optional()
        .describe(
            'Exact Discogs artist/release page for this artwork, including inherited images. ' +
                'Display Data provided by Discogs beside the image, linking without nofollow.',
        ),
});
export type ArtworkItem = z.infer<typeof ArtworkItemSchema>;

export const MediaImagesResponseSchema = z.array(ArtworkItemSchema);
export type MediaImagesResponse = z.infer<typeof MediaImagesResponseSchema>;
