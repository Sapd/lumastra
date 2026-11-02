// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { GetPartyResponseSchema } from '$lib/schemas/watch-together';

export const route: RouteMetadata = {
    GET: {
        tags: ['Watch Together'],
        stability: 'beta',
        summary: 'Get your active watch party',
        responses: {
            200: {
                schema: GetPartyResponseSchema,
                description: "User's active watch party session or null",
            },
        },
    },
};
