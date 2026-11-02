// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';

const RequestSchema = z
    .object({
        url: z.string().url(),
        format: z.enum(['json', 'regex']),
        timeoutMs: z.number().optional(),
        userAgent: z.string().optional(),
    })
    .meta({ id: 'RadioMetadataDetectRequest' });

const ResponseSchema = z
    .object({
        success: z.boolean(),
        data: z.union([
            z.object({
                format: z.literal('json'),
                contentType: z.string(),
                rawResponse: z.unknown(),
                proposedPaths: z.record(z.string(), z.string()),
                detectionConfidence: z.record(z.string(), z.number()),
                allLeafPaths: z.array(z.string()),
            }),
            z.object({
                format: z.literal('regex'),
                contentType: z.string(),
                rawResponse: z.string(),
            }),
        ]),
    })
    .meta({ id: 'RadioMetadataDetectResponse' });

export const route: RouteMetadata = {
    POST: {
        tags: ['Admin'],
        summary: 'Detect radio metadata fields',
        description:
            'Fetches the admin-provided URL and runs the heuristic field detector for JSON responses, or returns the raw text for regex responses.',
        body: RequestSchema,
        responses: {
            200: { schema: ResponseSchema, description: 'Detection result' },
            400: 'Fetch or parse error',
        },
    },
};
