// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Zod schemas for holiday plugin API routes
 *
 * Covers holiday CRUD operations and reordering
 */

import { z } from 'zod';
import { nonEmptyStringSchema } from './common';

// ============================================================================
// Shared Holiday Schemas
// ============================================================================

/**
 * Hex color code validation (#RRGGBB)
 */
const hexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Invalid color format (use #RRGGBB)');

/**
 * Content source type discriminated union
 */
const tmdbContentSourceSchema = z.object({
    type: z.literal('tmdb'),
    keywordIds: z.array(z.number()).optional(),
    keywords: z.array(z.string()).optional(),
    collectionIds: z.array(z.number()).optional(),
    genreIds: z.array(z.number()).optional(),
    featuredMovieIds: z.array(z.number()).optional(),
    featuredTvIds: z.array(z.number()).optional(),
    includeNewReleases: z.boolean().optional(),
    minVoteCount: z.number().optional(),
    minVoteAverage: z.number().optional(),
});

const mdblistContentSourceSchema = z.object({
    type: z.literal('mdblist'),
    listPath: z.string(),
    limit: z.number().int().optional(),
    boostFactor: z.number().optional(),
});

const customContentSourceSchema = z.object({
    type: z.literal('custom'),
    movieIds: z.array(z.number()).optional(),
    tvIds: z.array(z.number()).optional(),
    boostFactor: z.number().optional(),
});

const contentSourceSchema = z.discriminatedUnion('type', [
    tmdbContentSourceSchema,
    mdblistContentSourceSchema,
    customContentSourceSchema,
]);

/**
 * Pre-holiday configuration
 */
const preHolidaySchema = z.object({
    name: z.string(),
    localizedNames: z.record(z.string(), z.string()).optional(),
    emoji: z.string(),
    startMonth: z.number().int().min(1).max(12),
    startDay: z.number().int().min(1).max(31),
    endMonth: z.number().int().min(1).max(12),
    endDay: z.number().int().min(1).max(31),
});

/**
 * Holiday validation configuration
 */
const holidayValidationSchema = z.object({
    requiredTerms: z.array(z.string()).optional(),
    excludeTerms: z.array(z.string()).optional(),
    skipForFeatured: z.boolean().optional(),
});

// ============================================================================
// Holiday CRUD Schemas
// ============================================================================

/**
 * Body for creating a new holiday
 */
export const holidayCreateBodySchema = z.object({
    id: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9-]+$/, 'Must be lowercase alphanumeric with hyphens only'),
    name: z.string().min(1).max(100),
    localizedNames: z.record(z.string(), z.string()).optional(),
    emoji: z.string().max(8).optional(),
    startMonth: z.number().int().min(1).max(12),
    startDay: z.number().int().min(1).max(31),
    endMonth: z.number().int().min(1).max(12),
    endDay: z.number().int().min(1).max(31),
    sources: z.array(contentSourceSchema).min(1).max(50),
    backgroundColor: hexColorSchema.optional(),
    textColor: hexColorSchema.optional(),
    backgroundImage: z.string().optional(),
    preHoliday: preHolidaySchema.optional(),
    validation: holidayValidationSchema.optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().optional(),
});

export type HolidayCreateBody = z.infer<typeof holidayCreateBodySchema>;

/**
 * Body for updating an existing holiday (all fields optional)
 */
export const holidayUpdateBodySchema = z.object({
    name: z.string().min(1).max(100).optional(),
    localizedNames: z.record(z.string(), z.string()).optional(),
    emoji: z.string().max(8).optional(),
    startMonth: z.number().int().min(1).max(12).optional(),
    startDay: z.number().int().min(1).max(31).optional(),
    endMonth: z.number().int().min(1).max(12).optional(),
    endDay: z.number().int().min(1).max(31).optional(),
    sources: z.array(contentSourceSchema).max(50).optional(),
    backgroundColor: hexColorSchema.optional(),
    textColor: hexColorSchema.optional(),
    backgroundImage: z.string().optional(),
    preHoliday: preHolidaySchema.nullish(),
    validation: holidayValidationSchema.nullish(),
    enabled: z.boolean().optional(),
    priority: z.number().int().optional(),
});

export type HolidayUpdateBody = z.infer<typeof holidayUpdateBodySchema>;

/**
 * Body for reordering holidays
 */
export const holidayReorderBodySchema = z.object({
    order: z.array(nonEmptyStringSchema),
});

export type HolidayReorderBody = z.infer<typeof holidayReorderBodySchema>;

/**
 * Path params for single holiday endpoints
 */
export const holidayIdParamsSchema = z.object({
    id: nonEmptyStringSchema,
});

export type HolidayIdParams = z.infer<typeof holidayIdParamsSchema>;
