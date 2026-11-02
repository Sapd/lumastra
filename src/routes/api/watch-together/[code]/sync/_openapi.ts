// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { syncStateSchema, SyncResponseSchema } from '$lib/schemas/watch-together';

export { syncStateSchema, SyncResponseSchema };

export const route: RouteMetadata = {
    POST: {
        tags: ['Watch Together'],
        summary: 'Sync playback state',
        body: syncStateSchema,
        responses: {
            200: {
                schema: SyncResponseSchema,
                description: 'Playback state synced',
            },
            404: 'Session not found',
        },
    },
};
