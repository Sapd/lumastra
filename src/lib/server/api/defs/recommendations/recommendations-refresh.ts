// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { refreshRateLimit } from './_refresh-rate-limit.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import {
    def as readDef,
    RecommendationsQuerySchemaFromDocs,
    handleRecommendations,
} from './recommendations.js';

const RefreshBodyFromDocs = RecommendationsQuerySchemaFromDocs.omit({ offset: true }).extend({
    hideWatched: z.boolean().optional().meta({ description: 'Exclude already-watched items.' }),
    availableOnly: z
        .boolean()
        .optional()
        .meta({ description: 'Restrict results to library-available items.' }),
    watched: z
        .array(z.number().int().positive())
        .optional()
        .meta({ description: 'TMDB ids the client has already seen.' }),
    watchedIds: z
        .array(z.string().guid())
        .optional()
        .meta({ description: 'Internal media UUIDs the client has already seen.' }),
});
const RefreshBody = RefreshBodyFromDocs;

const refreshDocs = { ...readDef.docs!.GET! };
delete refreshDocs.query;

export const def = defineEndpoint({
    auth: readDef.auth,
    rateLimit: refreshRateLimit,
    docs: {
        POST: {
            ...refreshDocs,
            responses: {
                ...refreshDocs.responses,
                422: 'Invalid refresh filters',
                429: 'Refresh budget exhausted (30/minute per user)',
            },
            summary: 'Refresh recommendations',
            description:
                'Explicit synchronous refresh of the existing result. ' +
                'Uses the same filters and authorization as GET; always the first page.',
            body: RefreshBodyFromDocs,
        },
    },
    request: { body: RefreshBody },
    handlers: {
        POST: (event, ctx) => {
            const body = ctx.input!.body!;
            return handleRecommendations(
                event,
                ctx,
                {
                    ...body,
                    hideWatched: body.hideWatched?.toString(),
                    availableOnly: body.availableOnly?.toString(),
                    watched: body.watched?.join(','),
                    watchedIds: body.watchedIds?.join(','),
                },
                true,
            );
        },
    },
});
