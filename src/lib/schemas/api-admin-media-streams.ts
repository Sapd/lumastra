// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin media streams response schema
 * (`GET /api/admin/media/[id]/streams`).
 *
 * Split out of `$lib/schemas/api-admin-responses` (2026-09-25, fix round 1)
 * so `$lib/api/media-streams`'s `getMediaStreams()` — reached from every rail
 * page (`/`, `/browse`, ...) via `StandardSection.svelte` →
 * `MediaFileInfoModal.svelte` — doesn't have to import that whole, much
 * heavier schema file just for this one response shape. Re-exported from
 * `api-admin-responses.ts` so existing importers are unaffected.
 */

import { z } from 'zod';

const StreamRowSchema = z.object({
    id: z.string(),
    file_id: z.string(),
    stream_type: z.enum(['audio', 'video', 'subtitle']),
    stream_index: z.number(),
    codec: z.string(),
    language: z.string().nullable(),
    display_title: z.string().nullable(),
    title: z.string().nullable(),
    channels: z.number().nullable(),
    width: z.number().nullable(),
    height: z.number().nullable(),
    bit_depth: z.number().nullable(),
    video_range: z.string().nullable(),
    bitrate: z.number().nullable(),
    is_default: z.boolean(),
    is_forced: z.boolean(),
});

export const StreamsResponseSchema = z.object({
    streams: z.array(StreamRowSchema),
});

export type StreamsResponse = z.infer<typeof StreamsResponseSchema>;
