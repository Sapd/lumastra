// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { ImageSetSchema } from './api-image-descriptor.js';
import { AudiobookKindSchema } from './api-audiobook.js';
import { PlaybackProgressSchema } from './api-playback-progress.js';

export const MediaPreviewContextSchema = z
    .object({
        series: z
            .object({
                id: z.string().min(1),
                catalogId: z.uuid().nullable(),
                title: z.string(),
            })
            .optional(),
        seasonId: z.string().min(1).optional(),
        seasonNumber: z.number().int().optional(),
        episodeNumber: z.number().int().optional(),
        /** Last episode number of a multi-episode file (S02E04-E05 => 4, end 5). */
        endEpisodeNumber: z.number().int().optional(),
        absoluteNumber: z.number().int().optional(),
        previousId: z.string().min(1).optional(),
        nextId: z.string().min(1).optional(),
        airDate: z.string().optional(),
    })
    .meta({ id: 'MediaPreviewContext' });

/** Shared catalog/discovery card. Handles are opaque; catalogId identifies library rows. */
export const MediaPreviewSchema = z
    .object({
        id: z.string().min(1),
        catalogId: z.uuid().nullable(),
        type: z.enum([
            'movie',
            'series',
            'season',
            'episode',
            'album',
            'track',
            'artist',
            'audiobook',
        ]),
        ids: z.record(z.string(), z.string()),
        title: z.string(),
        subtitle: z.string().optional(),
        year: z.number().int().optional(),
        overview: z.string().optional(),
        images: ImageSetSchema,
        originalLanguage: z
            .string()
            .optional()
            .describe(
                'Original production language of the title; episodes inherit the series language',
            ),
        audioLanguages: z
            .array(z.string())
            .optional()
            .describe('Available audio language codes for a library episode'),
        subtitleLanguages: z
            .array(z.string())
            .optional()
            .describe('Available subtitle language codes for a library episode'),
        segments: z
            .array(
                z.object({
                    episodeNumber: z.number().int(),
                    title: z.string(),
                }),
            )
            .optional()
            .describe('Individual episode titles in a combined multi-episode file'),
        progress: PlaybackProgressSchema.optional(),
        audiobook: AudiobookKindSchema.optional(),
        lastPlayedAt: z
            .string()
            .optional()
            .describe('ISO-8601 timestamp of the last playback activity'),
        availability: z
            .object({
                isAvailable: z.boolean(),
                hasFile: z.boolean().optional(),
                canRequest: z.boolean(),
            })
            .optional(),
        context: MediaPreviewContextSchema.optional(),
        rating: z.number().optional(),
        genres: z.array(z.string()).optional(),
        durationMs: z
            .number()
            .int()
            .optional()
            .describe('Duration in milliseconds; absent when unknown'),
        /** Opaque; changes whenever any client-visible field (incl. image revisions) changes. Equality only. */
        revision: z.string().optional(),
        score: z.number().optional(),
        reason: z
            .object({
                kind: z.string(),
                label: z.string().optional(),
                seed: z.string().optional(),
            })
            .optional(),
    })
    .meta({ id: 'MediaPreview' });

export type MediaPreview = z.infer<typeof MediaPreviewSchema>;
export type MediaPreviewContext = z.infer<typeof MediaPreviewContextSchema>;
