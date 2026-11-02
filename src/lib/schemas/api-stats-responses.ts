// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * All-Stats API Response Schemas
 *
 * Zod schemas for the composite /my-stats/all and /stats/[username]/all endpoints.
 */

import { z } from 'zod';
import {
    PersonalStatsTypeSchema,
    StatsPeriodSchema,
    OverviewStatsSchema,
    WatchTimeStatsSchema,
    PeakHoursStatsSchema,
    CompletionStatsSchema,
    GenreStatsSchema,
    KeywordStatsSchema,
    DeviceStatsSchema,
    QualityStatsSchema,
    RatingStatsSchema,
    TasteProfileStatsSchema,
    FunRecordsSchema,
    TopTitlesStatsSchema,
} from './personal-stats-types';

/** Union of all concrete stat-type payloads — used to type the `stats` field in the envelope. */
const AnyStatsPayloadSchema = z.union([
    OverviewStatsSchema,
    WatchTimeStatsSchema,
    PeakHoursStatsSchema,
    CompletionStatsSchema,
    GenreStatsSchema,
    KeywordStatsSchema,
    DeviceStatsSchema,
    QualityStatsSchema,
    RatingStatsSchema,
    TasteProfileStatsSchema,
    FunRecordsSchema,
    TopTitlesStatsSchema,
]);

/**
 * Combined stats object — each type is optional (omitted if failed or insufficient data)
 */
export const AllStatsMapSchema = z
    .object({
        overview: OverviewStatsSchema.optional(),
        watchTime: WatchTimeStatsSchema.optional(),
        peakHours: PeakHoursStatsSchema.optional(),
        completion: CompletionStatsSchema.optional(),
        genres: GenreStatsSchema.optional(),
        keywords: KeywordStatsSchema.optional(),
        devices: DeviceStatsSchema.optional(),
        quality: QualityStatsSchema.optional(),
        ratings: RatingStatsSchema.optional(),
        tasteProfile: TasteProfileStatsSchema.optional(),
        records: FunRecordsSchema.optional(),
        topTitles: TopTitlesStatsSchema.optional(),
    })
    .meta({ id: 'AllStatsMap', description: 'All stat types keyed by name' });

export type AllStatsMap = z.infer<typeof AllStatsMapSchema>;

/**
 * Response from GET /api/my-stats/all and GET /api/stats/[username]/all
 */
export const AllStatsResponseSchema = z
    .object({
        period: StatsPeriodSchema,
        insufficientData: z.boolean().optional(),
        // Always provided by getAllStats (even on insufficient data / degraded paths).
        sessionCount: z.number(),
        stats: AllStatsMapSchema,
    })
    .meta({
        id: 'AllStatsResponse',
        description: 'Composite response with all stat types',
    });

export type AllStatsResponse = z.infer<typeof AllStatsResponseSchema>;

/**
 * Response envelope for the single-type GET /api/my-stats and
 * GET /api/stats/[username] endpoints.
 *
 * Used by BOTH the freshly-computed path and the cache-hit path so dev-mode
 * validation catches drift consistently. `stats` is typed as a concrete union
 * of all stat-type payloads rather than `z.unknown()` so the schema actually
 * validates the inner shape.  Insufficient-data responses omit `stats` and
 * carry `insufficientData/sessionCount/minRequired/message` instead.
 */
export const PersonalStatsEnvelopeSchema = z
    .object({
        type: PersonalStatsTypeSchema,
        period: StatsPeriodSchema.optional(),
        // insufficient-data responses carry these instead of `stats`.
        insufficientData: z.boolean().optional(),
        sessionCount: z.number().optional(),
        minRequired: z.number().optional(),
        message: z.string().optional(),
        stats: AnyStatsPayloadSchema.optional(),
    })
    .meta({
        id: 'PersonalStatsEnvelope',
        description: 'Envelope for a single personal-stats type response',
    });

export type PersonalStatsEnvelope = z.infer<typeof PersonalStatsEnvelopeSchema>;
