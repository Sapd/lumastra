// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { SEARCH_RESULT_TYPES } from '$lib/schemas/api-search-responses.js';
import { MediaPreviewSchema } from '$lib/schemas/api-media-preview.js';
import { PageBlockSchema } from '$lib/schemas/pagination.js';

// Search includes auxiliary sources beyond the catalog spine, with the same preview core.
export const SearchResultItemSchema = MediaPreviewSchema.extend({
    type: z.enum(SEARCH_RESULT_TYPES),
    matchedTitle: z
        .string()
        .optional()
        .describe(
            'Stored alternative title that matched the query, when different from the displayed title',
        ),
    artistId: z.string().optional(),
    artist: z.string().optional(),
    albumId: z.string().optional(),
    album: z.string().optional(),
    artists: z.array(MediaPreviewSchema).optional(),
    remixerArtists: z
        .array(MediaPreviewSchema)
        .optional()
        .describe('Resolved remix/version credits, separate from performing artists.'),
    requestMediaType: z.string().optional(),
    libraryId: z.number().optional(),
    author: z.string().optional(),
});

export const SearchResponseSchema = z.object({
    items: z.array(SearchResultItemSchema),
    page: PageBlockSchema,
});

export const SuggestResponseSchema = z.object({
    items: z.array(MediaPreviewSchema),
    truncated: z.boolean(),
});
