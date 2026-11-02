// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';

export const route: RouteMetadata = {
    GET: {
        tags: ['Playback'],
        summary: 'Stream the selected file directly (direct play)',
        stability: 'stable',
        auth: 'bearer-or-grant',
        query: z.object({
            fileId: z.string().min(1).describe(
                'Selected catalog file ID from the playback response; required.',
            ),
            grant: z.string().optional().describe('Playback delivery grant for header-less players.'),
        }),
        responses: {
            200: {
                binary: ['application/octet-stream'],
                description: 'Direct media file download',
            },
            206: {
                binary: ['application/octet-stream'],
                description: 'Selected file byte range',
            },
            422: 'fileId is required',
            401: 'Authentication required',
            404: 'File not found',
            500: 'Internal server error',
        },
    },
};
