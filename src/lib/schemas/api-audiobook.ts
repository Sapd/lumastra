// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { paginatedEnvelope } from './pagination.js';
import { ImageSetSchema } from './api-image-descriptor.js';

export const AudiobookPersonRefSchema = z.object({ id: z.string().uuid(), name: z.string() });
export const AudiobookSeriesRefSchema = z.object({
    id: z
        .string()
        .uuid()
        .describe('Stable series id; GET /audiobooks/series/{id}/books lists its books.'),
    name: z.string(),
    position: z.number().nullable(),
    bookCount: z.number().int().optional(),
});
export const AudiobookKindSchema = z.object({
    authors: z.array(AudiobookPersonRefSchema),
    narrators: z.array(AudiobookPersonRefSchema),
    series: AudiobookSeriesRefSchema.nullable(),
});
export const AudiobookChapterSchema = z.object({
    index: z.number().int(),
    name: z.string(),
    startMs: z.number().int(),
    endMs: z.number().int(),
    synthetic: z.literal(true).optional(),
});
export const AudiobookSummarySchema = z.object({
    id: z.string().uuid(),
    title: z.string(),
    ...AudiobookKindSchema.shape,
    durationMs: z.number().int().nullable(),
    images: ImageSetSchema,
    chapters: z.array(AudiobookChapterSchema),
});
export const ContributorSchema = z.object({
    id: z.string().uuid(),
    name: z.string(),
    bookCount: z.number().int(),
});
export const ContributorDetailSchema = ContributorSchema.extend({ durationMs: z.number().int() });
export const SeriesItemSchema = ContributorDetailSchema.extend({ images: ImageSetSchema });
export const ContributorPageSchema = paginatedEnvelope(ContributorSchema);
export const SeriesPageSchema = paginatedEnvelope(SeriesItemSchema);
export type AudiobookPersonRef = z.infer<typeof AudiobookPersonRefSchema>;
export type AudiobookSeriesRef = z.infer<typeof AudiobookSeriesRefSchema>;
export type AudiobookKind = z.infer<typeof AudiobookKindSchema>;
export type AudiobookChapter = z.infer<typeof AudiobookChapterSchema>;
export type AudiobookSummary = z.infer<typeof AudiobookSummarySchema>;
export type Contributor = z.infer<typeof ContributorSchema>;
export type SeriesItem = z.infer<typeof SeriesItemSchema>;
