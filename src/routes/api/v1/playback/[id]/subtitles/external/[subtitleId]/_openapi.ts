// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';

export const route: RouteMetadata = {
    GET: {
        tags: ['Playback'],
        summary: 'Get an external subtitle file',
        stability: 'stable',
        auth: 'bearer-or-grant',
        query: z.object({
            fileId: z
                .string()
                .uuid()
                .optional()
                .describe('If supplied, subtitle must belong to this selected file.'),
            format: z
                .enum(['vtt', 'srt', 'ass', 'ssa'])
                .optional()
                .describe('Default vtt; raw format must match the sidecar.'),
        }),
        description:
            'Select by the stable sidecar id from playability/start. Supports WebVTT conversion or the original supported text format.',
        responses: {
            200: {
                binary: ['text/vtt', 'application/x-subrip', 'text/plain'],
                description: 'External subtitle file (WebVTT or SRT)',
            },
            401: 'Authentication required',
            404: 'Subtitle not found',
            500: 'Internal server error',
        },
    },
};
