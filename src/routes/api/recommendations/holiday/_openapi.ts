// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { holidayRecommendationsQuerySchema } from '$lib/schemas/ai';
import { UniversalMediaItemSchema } from '$lib/schemas/api-responses';

// Concrete shape of the active-holiday definition returned by the holiday
// plugin (`HolidayConfig` in src/lib/server/plugins/holidays/types.ts). Only
// the fields surfaced to the client are sketched here; the plugin may return
// additional internal styling/source fields.
const HolidayDefinitionSchema = z
    .object({
        id: z.string().meta({ description: "Stable identifier, e.g. 'christmas'" }),
        name: z.string().meta({ description: 'Display name (default language)' }),
        localizedNames: z
            .record(z.string(), z.string())
            .optional()
            .meta({ description: 'Localized names keyed by language code' }),
        emoji: z.string().meta({ description: 'Emoji shown in the banner' }),
        startMonth: z.number().int().meta({ description: 'Start month (1-12)' }),
        startDay: z.number().int().meta({ description: 'Start day (1-31)' }),
        endMonth: z.number().int().meta({ description: 'End month (1-12)' }),
        endDay: z.number().int().meta({ description: 'End day (1-31)' }),
        backgroundColor: z.string().meta({ description: 'Banner background CSS color' }),
        textColor: z.string().meta({ description: 'Banner text CSS color' }),
        backgroundImage: z
            .string()
            .optional()
            .meta({ description: 'Optional banner background image path' }),
        priority: z
            .number()
            .optional()
            .meta({ description: 'Tie-break priority when holidays overlap' }),
    })
    .loose()
    .meta({ description: 'Active holiday definition' });

export const route: RouteMetadata = {
    GET: {
        tags: ['Recommendations'],
        summary: 'Holiday-themed recommendations',
        stability: 'beta',
        description:
            'Returns seasonal, holiday-themed content for the current user when a holiday is active. When no holiday is active (or the feature is disabled) `active` is false, `items` is empty, and `message` explains why.',
        query: holidayRecommendationsQuerySchema,
        responses: {
            200: {
                schema: z.object({
                    active: z.boolean().meta({
                        description: 'Whether a holiday season is currently active',
                    }),
                    holiday: HolidayDefinitionSchema.optional().meta({
                        description: 'Holiday definition (present when active)',
                    }),
                    items: z.array(UniversalMediaItemSchema).meta({
                        description: 'Recommended holiday media items',
                    }),
                    cached: z.boolean().optional().meta({
                        description: 'Whether the result was served from cache',
                    }),
                    message: z.string().optional().meta({
                        description: 'Explanatory message when no holiday is active',
                    }),
                }),
                description: 'Holiday-themed recommendations',
            },
            401: 'Authentication required',
            403: 'Forbidden (age-restricted profiles cannot access holiday recommendations)',
            500: 'Internal server error',
        },
    },
};
