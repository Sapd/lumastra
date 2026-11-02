// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { MediaPreviewSchema } from './api-media-preview.js';
import { AudiobookKindSchema, SeriesItemSchema } from './api-audiobook.js';
import { paginatedEnvelope } from './pagination.js';

/** Library audiobook specialization of the shared discovery item. */
export const AudiobookPreviewSchema = MediaPreviewSchema.extend({
    catalogId: z.uuid(),
    type: z.literal('audiobook'),
    audiobook: AudiobookKindSchema,
});
export const AudiobookPageSchema = paginatedEnvelope(AudiobookPreviewSchema);
export const SeriesDetailSchema = SeriesItemSchema.extend({
    progress: z.object({ finishedCount: z.number().int(), bookCount: z.number().int() }),
    nextUp: AudiobookPreviewSchema.nullable(),
});
export type AudiobookPreview = z.infer<typeof AudiobookPreviewSchema>;
