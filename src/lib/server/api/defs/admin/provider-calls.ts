// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { readProviderCalls } from '$lib/server/utils/provider-calls.js';
import {
    ProviderCallsQuerySchema,
    ProviderCallsResponseSchema,
} from '$lib/schemas/provider-calls.js';

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    request: { query: ProviderCallsQuerySchema },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin'],
            summary: 'Get hourly provider HTTP call counters',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Best-effort HTTP attempt counts across web and worker processes. Includes retries, status classes and network failures. UTC hour buckets include the current partial hour; retained eight days. New counters start empty and are flushed every second. Errors in the cost-page table are all 4xx (including 404 and 429), 5xx and network errors.',
            responses: {
                200: {
                    schema: ProviderCallsResponseSchema,
                    description: 'Per-provider totals and hourly series',
                },
                401: 'Authentication required',
                403: 'Admin access required',
                422: 'Invalid hours (expected an integer between 1 and 192)',
                503: 'Provider call counters unavailable',
            },
        },
    },
    handlers: {
        GET: async (_event, ctx) => {
            try {
                const result = await readProviderCalls(ctx.input!.query!.hours);
                return json(ProviderCallsResponseSchema.parse(result), {
                    headers: { 'Cache-Control': 'no-store' },
                });
            } catch {
                return ApiProblem.dependencyUnavailable('Provider call counters unavailable');
            }
        },
    },
});
