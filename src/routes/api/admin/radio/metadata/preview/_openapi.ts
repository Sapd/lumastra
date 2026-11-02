// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { RadioMetadataPreviewRequestSchema, RadioNowPlayingSchema } from '$lib/schemas/radio';
import { z } from 'zod';

const ResponseSchema = z
    .object({
        success: z.boolean(),
        data: RadioNowPlayingSchema,
    })
    .meta({ id: 'RadioMetadataPreviewResponse' });

export const route: RouteMetadata = {
    POST: {
        tags: ['Admin'],
        summary: 'Preview parsed now-playing for a candidate mapping',
        body: RadioMetadataPreviewRequestSchema,
        responses: {
            200: { schema: ResponseSchema },
            400: 'Invalid mapping or fetch failure',
        },
    },
};
