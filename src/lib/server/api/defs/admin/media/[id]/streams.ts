// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/streams.ts
 *
 * GET /api/admin/media/[id]/streams[?fileId=uuid]
 *
 * Returns media stream metadata (video, audio, subtitle tracks).
 * With ?fileId=: returns streams for a specific file only.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: { streams: MediaStreamRow[] }
 * 503 dependency_unavailable when DB is down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getStreamsForMediaItem,
    getStreamsForFile,
} from '$lib/server/database/queries/media-streams.queries.js';

// ---------------------------------------------------------------------------
// Response schema (typed from MediaStreamRow)
// ---------------------------------------------------------------------------

const MediaStreamRowSchema = z.object({
    id: z.string(),
    file_id: z.string(),
    stream_type: z.enum(['audio', 'video', 'subtitle']),
    stream_index: z.number().int(),
    codec: z.string(),
    codec_tag: z.string().nullable(),
    profile: z.string().nullable(),
    level: z.number().nullable(),
    language: z.string().nullable(),
    display_title: z.string().nullable(),
    title: z.string().nullable(),
    channels: z.number().nullable(),
    channel_layout: z.string().nullable(),
    sample_rate: z.number().nullable(),
    width: z.number().nullable(),
    height: z.number().nullable(),
    bit_depth: z.number().nullable(),
    video_range: z.string().nullable(),
    video_range_type: z.string().nullable(),
    color_space: z.string().nullable(),
    aspect_ratio: z.string().nullable(),
    average_frame_rate: z.number().nullable(),
    is_anamorphic: z.boolean().nullable(),
    is_external: z.boolean().nullable(),
    is_text_subtitle: z.boolean().nullable(),
    bitrate: z.number().nullable(),
    is_default: z.boolean(),
    is_forced: z.boolean(),
    dv_profile: z.number().nullable(),
    dv_level: z.number().nullable(),
    dv_bl_signal_compatibility_id: z.number().nullable(),
    master_display: z.string().nullable(),
    max_cll: z.string().nullable(),
    pixel_format: z.string().nullable(),
    ref_frames: z.number().nullable(),
    color_primaries: z.string().nullable(),
    color_transfer: z.string().nullable(),
    created_at: z.union([z.string(), z.date()]),
});

export const StreamsResponseSchema = z.object({
    streams: z.array(MediaStreamRowSchema),
});

export type StreamsResponse = z.infer<typeof StreamsResponseSchema>;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        query: z.object({
            fileId: z.string().guid().optional(),
        }),
    },
    handlers: {
        GET: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            const fileId = ctx.input?.query?.fileId;

            const streams = fileId
                ? await getStreamsForFile(sql, fileId, internalId)
                : await getStreamsForMediaItem(sql, internalId);

            return json(StreamsResponseSchema.parse({ streams }));
        },
    },
});
