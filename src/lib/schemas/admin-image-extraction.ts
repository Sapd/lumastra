// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

export const ExtractBodySchema = z.object({
    artworkType: z.enum(['poster', 'backdrop', 'thumb']).default('poster'),
    force: z
        .boolean()
        .default(true)
        .describe(
            'Compatibility field; explicit admin extraction always creates and selects a new frame.',
        ),
});

export const ExtractResponseSchema = z.object({
    extracted: z.boolean(),
    filePath: z.string().optional(),
    reason: z.string().optional(),
});

export type ExtractResponse = z.infer<typeof ExtractResponseSchema>;

export const RegenerateBodySchema = z.object({
    mode: z.enum(['execute', 'plan']).default('execute'),
    scope: z.enum(['series', 'season', 'episode']).optional(),
    /** Optional page observation; rejected if the source or artwork has changed since review. */
    reviewToken: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
    force: z
        .boolean()
        .default(false)
        .describe(
            'Compatibility field; parent scopes repair only missing or wrongly owned automatic pictures. An explicit single-episode choice always selects a new frame.',
        ),
});

export const RegenerateResponseSchema = z.object({
    runId: z.string(),
    message: z.string(),
    /** True when this click collapsed into an already-running run. */
    deduped: z.boolean().optional(),
});

export type RegenerateResponse = z.infer<typeof RegenerateResponseSchema>;

export const SharedEpisodeThumbReviewRowSchema = z.object({
    episodeId: z.string().uuid(),
    episodeTitle: z.string(),
    seasonNumber: z.number().nullable(),
    episodeNumber: z.number().nullable(),
    selectedCandidateId: z.string().uuid(),
    artworkPath: z.string(),
    sharedCount: z.number().int(),
    candidateCount: z.number().int(),
    chosenBy: z.string(),
    locked: z.boolean(),
    provider: z.string(),
    suppressed: z.boolean(),
    sourceFileId: z.string().uuid().nullable(),
    sourcePath: z.string().nullable(),
    sourceMissing: z.boolean().nullable(),
    sourceDurationSeconds: z.coerce.number().nullable(),
    sourceSharedCount: z.number().int(),
    startOffsetMs: z.string().nullable(),
    endOffsetMs: z.string().nullable(),
    reviewToken: z.string().nullable(),
});

export const SharedEpisodeThumbReviewSchema = z.object({
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
    rows: z.array(SharedEpisodeThumbReviewRowSchema),
});
export type SharedEpisodeThumbReview = z.infer<typeof SharedEpisodeThumbReviewSchema>;
