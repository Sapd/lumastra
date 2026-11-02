// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { RadioStreamInfoRequestSchema, RadioStreamInfoSchema } from '$lib/schemas/radio';
import { z } from 'zod';

const ResponseSchema = z
    .object({
        success: z.boolean(),
        data: RadioStreamInfoSchema,
    })
    .meta({ id: 'RadioStreamInfoResponse' });

export const route: RouteMetadata = {
    POST: {
        tags: ['Admin'],
        summary: 'Read a radio stream’s ICY name, genre and description',
        body: RadioStreamInfoRequestSchema,
        responses: {
            200: { schema: ResponseSchema },
        },
    },
};
