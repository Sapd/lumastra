// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

const SubjectSchema = z.object({
    id: z.uuid(),
    title: z.string(),
    seasonNumber: z.number().int().nullable(),
    episodeNumber: z.number().int().nullable(),
    tmdbId: z.string(),
});

export const EpisodeTmdbExchangePreviewSchema = z.object({
    series: z.object({ id: z.uuid(), title: z.string() }),
    first: SubjectSchema,
    second: SubjectSchema,
    snapshot: z.string().regex(/^[0-9a-f]{64}$/),
    undoId: z
        .uuid()
        .optional()
        .describe('Guarded recovery of the complete preceding online assignments.'),
});

export const EpisodeTmdbExchangeConfirmSchema = z.object({
    otherId: z.uuid(),
    snapshot: z.string().regex(/^[0-9a-f]{64}$/),
    undoReceiptId: z
        .uuid()
        .optional()
        .describe('Restore the guarded preceding pair assignment instead of swapping again.'),
});

export type EpisodeTmdbExchangePreview = z.infer<typeof EpisodeTmdbExchangePreviewSchema>;
