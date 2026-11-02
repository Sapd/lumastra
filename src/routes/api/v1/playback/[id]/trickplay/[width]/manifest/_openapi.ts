// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { trickplayQuerySchema } from '$lib/schemas/playback';
import { TrickplayManifestResponseSchema } from '$lib/schemas/playback-trickplay';

export const route: RouteMetadata = {
    GET: {
        tags: ['Playback'],
        auth: 'bearer',
        stability: 'stable',
        summary: 'Get selected-file trickplay manifest',
        description: 'Returns JSON geometry and ready sprite-sheet hrefs on the selected file clock in milliseconds. Optional fileId resolves to the default file when omitted. Unknown widths return 404; choose a width advertised by the timeline. Hrefs carry the resolved file selection. Authentication uses bearer credentials or a playback grant.',
        params: z.object({ width: z.coerce.number().int().positive() }),
        query: trickplayQuerySchema,
        responses: {
            200: { schema: TrickplayManifestResponseSchema, description: 'Selected-file trickplay manifest.' },
            404: 'Trickplay unavailable for this file or width',
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
