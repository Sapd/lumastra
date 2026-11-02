// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { LiveTvAvailabilitySchema } from '$lib/schemas/livetv-availability.js';
import { getLiveTvProvider } from '$lib/server/services/livetv/index.js';
import { getLiveTvAvailability } from '$lib/server/services/livetv/availability.service.js';
export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Live TV'],
            stability: 'stable',
            summary: 'Check whether Live TV is available',
            responses: {
                503: 'Live TV dependency unavailable',
                200: {
                    schema: LiveTvAvailabilitySchema,
                    description: 'Sanitized availability evidence',
                },
            },
        },
    },
    auth: { kind: 'feature', flag: 'FEATURE_LIVETV', then: { kind: 'user' } },
    handlers: {
        GET: async ({ locals }) => {
            if (!locals.user?.hasLiveTvPermission) return ApiProblem.notFound();
            try {
                const provider = await getLiveTvProvider();
                return json(await getLiveTvAvailability(await provider.getChannels()), {
                    headers: { 'Cache-Control': 'private, no-store' },
                });
            } catch {
                return ApiProblem.dependencyUnavailable('Live TV availability unavailable');
            }
        },
    },
});
