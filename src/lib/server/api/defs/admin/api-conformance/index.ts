// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { readConformance, CONFORMANCE_MAX_DAYS } from '$lib/server/api/conformance-counter.js';
import { ConformanceResponseSchema } from '$lib/schemas/api-conformance.js';

const QuerySchema = z.object({
    days: z.coerce
        .number()
        .int()
        .min(1)
        .max(CONFORMANCE_MAX_DAYS)
        .optional()
        .describe('UTC daily buckets to read; defaults to 1, or enough days to reach `since`'),
    since: z
        .string()
        .datetime()
        .optional()
        .describe(
            'ISO timestamp, e.g. the deploy time. Only items with a hit at or after it are returned, so an empty list means no new hits.',
        ),
});

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    request: { query: QuerySchema },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin'],
            summary: 'API response contract drift by route',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Counts across UTC daily buckets: today plus the previous days minus one, up to eight days. Buffered writes may take ten seconds to appear.',
            responses: {
                200: {
                    schema: ConformanceResponseSchema,
                    description: 'Response conformance totals and samples',
                },
                401: 'Authentication required',
                403: 'Admin access required',
            },
        },
    },
    handlers: {
        GET: async (_event, ctx) => {
            const query = ctx.input!.query!;
            const since = query.since ? new Date(query.since) : undefined;
            // With `since` and no explicit days, read back far enough to cover it.
            const days =
                query.days ??
                (since
                    ? Math.min(
                          CONFORMANCE_MAX_DAYS,
                          Math.max(1, Math.ceil((Date.now() - since.getTime()) / 86_400_000) + 1),
                      )
                    : 1);
            const items = await readConformance(days, new Date(), since);
            const totals = { stripped: 0, mismatch: 0 };
            for (const item of items) totals[item.kind] += item.count;
            return json(
                ConformanceResponseSchema.parse({ days, since: query.since, totals, items }),
            );
        },
    },
});
