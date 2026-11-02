// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { def as mixes } from '../../sonic-mixes.js';
import {
    MusicClustersResponseSchema,
    MusicClustersIndexResponseSchema,
} from '$lib/schemas/api-music-responses.js';

export const def = defineEndpoint({
    auth: { kind: 'feature', flag: 'musicClusters', then: { kind: 'user' } },
    visibility: 'public',
    request: { query: z.object({}).strict() },
    docs: {
        GET: {
            tags: ['Music'],
            summary: 'List sonic mix names and ids',
            stability: 'beta',
            auth: 'bearer',
            description:
                'A small index of visible sonic mixes for constrained devices. IDs stay stable across re-clustering.',
            responses: {
                200: { schema: MusicClustersIndexResponseSchema, description: 'Sonic mix index' },
                401: 'Authentication required',
                404: 'musicClusters feature is not enabled',
                503: 'Database unavailable',
            },
        },
    },
    handlers: {
        GET: async (event, ctx) => {
            const response = await mixes.handlers.GET!(event, ctx);
            if (!response.ok) return response;
            const list = MusicClustersResponseSchema.parse(await response.json());
            return json({ items: list.items.map(({ id, label }) => ({ id, label })) });
        },
    },
});
