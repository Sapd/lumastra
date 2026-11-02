// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import {
    createSessionSchema,
    CreatePartyResponseSchema,
    PublicPartySchema,
} from '$lib/schemas/watch-together';

export const route: RouteMetadata = {
    POST: {
        tags: ['Watch Together'],
        stability: 'beta',
        summary: 'Create watch party',
        description:
            'visibility: "listed" is the host’s explicit choice and is not blocked by the hide-my-streams privacy switch.',
        body: createSessionSchema,
        responses: {
            201: {
                schema: CreatePartyResponseSchema,
                description: 'Watch party session created',
            },
        },
    },
    GET: {
        tags: ['Watch Together'],
        stability: 'beta',
        summary: 'List watch parties',
        description:
            'visibility: "listed" is the host’s explicit choice and is not blocked by the hide-my-streams privacy switch.',
        query: z.object({
            includePrivate: z
                .enum(['true', 'false'])
                .optional()
                .describe('Include unlisted sessions; requires an admin principal'),
        }),
        responses: {
            200: {
                schema: z.object({
                    items: z
                        .array(PublicPartySchema)
                        .describe('Active public watch-party sessions'),
                    page: z.object({
                        limit: z.number().int(),
                        offset: z.number().int(),
                        hasMore: z.boolean(),
                        total: z.number().int(),
                    }),
                }),
                description: 'Active public sessions (bare collection, §8.3)',
            },
        },
    },
};
