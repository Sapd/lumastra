// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { InternetRadioStationSchema } from '$lib/schemas/music';

const RadioStationsResponseSchema = z
    .object({
        success: z.boolean(),
        data: z.object({
            stations: z.array(InternetRadioStationSchema),
        }),
        timestamp: z.string(),
    })
    .meta({ id: 'RadioStationsResponse' });

export const route: RouteMetadata = {
    GET: {
        tags: ['Music'],
        summary: 'List internet radio stations',
        description: 'Returns all configured internet radio stations with their stream URLs.',
        responses: {
            200: {
                schema: RadioStationsResponseSchema,
                description: 'List of internet radio stations',
            },
        },
    },
};
