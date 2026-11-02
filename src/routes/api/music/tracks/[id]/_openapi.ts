// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { MusicTrackSchema } from '$lib/schemas/music';
import { MusicTrackUserContextSchema } from '$lib/schemas/api-music-responses';

const TrackDetailResponseSchema = z
    .object({
        track: MusicTrackSchema,
        userContext: MusicTrackUserContextSchema,
    })
    .meta({ id: 'TrackDetailResponse' });

export const route: RouteMetadata = {
    GET: {
        tags: ['Music'],
        summary: 'Get track detail',
        description:
            'Returns full track metadata including audio features (BPM, key, energy, beat grid, intro/outro boundaries) computed by Essentia at scan time, plus per-user context such as explicit feedback (like/dislike).',
        responses: {
            200: {
                schema: TrackDetailResponseSchema,
                description: 'Track detail with audio features and user context',
            },
            404: 'Track not found',
        },
    },
};
