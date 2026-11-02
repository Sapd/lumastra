// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { transferHostSchema, TransferHostResponseSchema } from '$lib/schemas/watch-together';

export { transferHostSchema, TransferHostResponseSchema };

export const route: RouteMetadata = {
    POST: {
        tags: ['Watch Together'],
        summary: 'Transfer host role',
        body: transferHostSchema,
        responses: {
            200: {
                schema: TransferHostResponseSchema,
                description: 'Host role transferred',
            },
            404: 'Session not found',
        },
    },
};
