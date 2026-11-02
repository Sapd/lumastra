// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

/**
 * Library growth for the admin home library card: a downsampled size curve and,
 * per filesystem the libraries live on, when that disk fills at the current pace.
 *
 * The curve before the first daily snapshot is reconstructed from the files the
 * library holds TODAY, dated by when each arrived (`approximate: true`). Deleted
 * files are missing from that part, so it understates the past. The estimate
 * learns its pace from real free-space measurements only; the reconstruction
 * may at most shape the band and seasons (`approximatePrior`).
 */

export const LibraryGrowthPointSchema = z
    .object({
        date: z.string().describe('Calendar day, YYYY-MM-DD'),
        bytes: z.number().describe('Total library bytes on that day'),
        approximate: z
            .boolean()
            .describe('True when reconstructed from current files rather than measured'),
    })
    .meta({ id: 'LibraryGrowthPoint' });
export type LibraryGrowthPoint = z.infer<typeof LibraryGrowthPointSchema>;

export const StorageEstimateSchema = z
    .discriminatedUnion('state', [
        z.object({
            state: z.literal('insufficient_data'),
            snapshotDays: z
                .number()
                .int()
                .describe('Days with a free-space measurement in the fit window'),
        }),
        z.object({
            state: z.literal('not_filling'),
            basisDays: z
                .number()
                .int()
                .optional()
                .describe('Days with a real measurement the verdict rests on'),
            ignoredDeletions: z
                .number()
                .int()
                .optional()
                .describe('One-off large deletions left out of the pace (present only when > 0)'),
        }),
        z.object({
            state: z.literal('filling'),
            daysUntilFull: z
                .number()
                .int()
                .describe('Central estimate (median), days from the last measurement'),
            daysUntilFullLow: z
                .number()
                .int()
                .describe('Soonest end of the band (see bandLevel, ~90 %)'),
            daysUntilFullHigh: z
                .number()
                .int()
                .optional()
                .describe('Latest end of the band; absent when the slow end does not fill at all'),
            bytesPerDay: z
                .number()
                .describe('Average growth in bytes per day the forecast assumes'),
            confidence: z
                .enum(['low', 'medium', 'high'])
                .optional()
                .describe(
                    'Coarse precision label from data length, band width and how much of the growth came in a few bursts',
                ),
            model: z
                .enum(['trend', 'bursty', 'seasonal'])
                .optional()
                .describe(
                    'Growth pattern used: steady trend, bursts (big steps between quiet weeks) or month-dependent seasons',
                ),
            basisDays: z
                .number()
                .int()
                .optional()
                .describe('Days with a real measurement the pace was learned from'),
            bandLevel: z
                .number()
                .optional()
                .describe(
                    'Share of simulated futures between daysUntilFullLow and daysUntilFullHigh (0.9)',
                ),
            approximatePrior: z
                .boolean()
                .optional()
                .describe(
                    'True when the approximate arrival history (not measurements) shaped the band or the seasons',
                ),
            ignoredDeletions: z
                .number()
                .int()
                .optional()
                .describe('One-off large deletions left out of the pace (present only when > 0)'),
        }),
    ])
    .meta({ id: 'StorageEstimate' });
export type StorageEstimate = z.infer<typeof StorageEstimateSchema>;

export const LibraryVolumeGrowthSchema = z
    .object({
        id: z.string().describe('Opaque key of this filesystem within the response'),
        libraries: z.array(z.string()).describe('Names of the libraries stored on this filesystem'),
        freeBytes: z.number().describe('Free bytes at the last measurement'),
        totalBytes: z.number().describe('Filesystem size at the last measurement'),
        measuredOn: z.string().describe('Day of the last measurement, YYYY-MM-DD'),
        estimate: StorageEstimateSchema,
    })
    .meta({ id: 'LibraryVolumeGrowth' });
export type LibraryVolumeGrowth = z.infer<typeof LibraryVolumeGrowthSchema>;

export const LibraryStorageGrowthSchema = z
    .object({
        generatedAt: z.string().describe('ISO timestamp the answer was computed'),
        series: z
            .array(LibraryGrowthPointSchema)
            .describe('Library size over up to two years, at most 120 points, oldest first'),
        firstSnapshotDate: z
            .string()
            .optional()
            .describe('First measured day; points before it are approximate'),
        byMediaType: z
            .array(
                z.object({
                    mediaType: z.string(),
                    bytes: z.number(),
                    fileCount: z.number().int(),
                }),
            )
            .describe('Latest snapshot split by library media type, largest first'),
        volumes: z
            .array(LibraryVolumeGrowthSchema)
            .describe(
                'Filesystems holding libraries, soonest to fill first; empty when none could be measured',
            ),
    })
    .meta({ id: 'LibraryStorageGrowth' });
export type LibraryStorageGrowth = z.infer<typeof LibraryStorageGrowthSchema>;
