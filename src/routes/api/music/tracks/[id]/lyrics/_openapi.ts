// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { LyricsSchema, SyncedLyricLineSchema, LyricsUploadRequestSchema } from '$lib/schemas/music';

export { LyricsSchema, LyricsUploadRequestSchema };

const LyricsResponseSchema = z
    .object({
        success: z.boolean(),
        data: z.object({
            lyrics: LyricsSchema,
            syncedLines: z.array(SyncedLyricLineSchema).optional(),
        }),
        timestamp: z.string(),
    })
    .meta({ id: 'LyricsDetailResponse' });

const QueueActionResponseSchema = z
    .object({
        success: z.boolean(),
        data: z.object({ success: z.literal(true) }),
        timestamp: z.string(),
    })
    .meta({ id: 'LyricsUpdateActionResponse' });

export const route: RouteMetadata = {
    GET: {
        tags: ['Music'],
        summary: 'Get track lyrics',
        description:
            'Returns raw lyrics data plus server-parsed synced lyric lines when LRC-format synced lyrics are available.',
        responses: {
            200: {
                schema: LyricsResponseSchema,
                description: 'Lyrics with optional synced lines',
            },
            404: 'Track not found',
        },
    },
    PUT: {
        tags: ['Music'],
        summary: 'Upload or replace track lyrics',
        description:
            'Upload plain and/or LRC-format synced lyrics for a track. Replaces any existing lyrics.',
        body: LyricsUploadRequestSchema,
        responses: {
            200: {
                schema: QueueActionResponseSchema,
                description: 'Lyrics updated',
            },
            400: 'Invalid request',
        },
    },
};
