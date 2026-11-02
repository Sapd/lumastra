// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { versionChangeSchema } from '$lib/schemas/watch-together';
import { SuccessTrueResponseSchema } from '$lib/schemas/common';

export { versionChangeSchema, SuccessTrueResponseSchema };

export const route: RouteMetadata = {
    POST: {
        tags: ['Watch Together'],
        summary: 'Change media version/source',
        body: versionChangeSchema,
        responses: {
            200: {
                schema: SuccessTrueResponseSchema,
                description: 'Media version changed',
            },
            404: 'Session not found',
        },
    },
};
