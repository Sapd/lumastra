// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { z } from 'zod';
import { PlayMethodSchema } from '$lib/schemas/play-sessions';

const AdminSessionSchema = z.object({
    __id: z.string().guid().meta({ description: 'Session ID' }),
    username: z.string().meta({ description: 'Username' }),
    title: z.string().meta({ description: 'Media title' }),
    clientname: z.string().meta({ description: 'Client name' }),
    browsername: z.string().meta({
        description: 'Parsed device or browser name (e.g., "Firefox 30 on Windows")',
    }),
    user_agent_raw: z.string().optional().meta({
        description: 'Raw user-agent string (source for browsername parsing)',
    }),
    playMethod: PlayMethodSchema.optional().meta({
        description: 'Play method',
    }),
    playIsPlaying: z.boolean().optional().meta({ description: 'Whether currently playing' }),
    playCurrentTime: z.number().optional().meta({ description: 'Position in seconds' }),
    playItemDuration: z.number().optional().meta({ description: 'Duration in seconds' }),
    streamProgress: z.number().optional().meta({ description: 'Progress percentage 0-100' }),
    resolution: z.string().optional().meta({ description: 'Video resolution' }),
    bitrate_kbps: z.number().optional().meta({ description: 'Bitrate in kbps' }),
    video_codec: z.string().optional().meta({ description: 'Video codec' }),
    audio_codec: z.string().optional().meta({ description: 'Audio codec' }),
    audio_language: z.string().optional().meta({ description: 'Audio track language' }),
    subtitle_language: z.string().optional().meta({ description: 'Subtitle track language' }),
    buffer_health_sec: z
        .number()
        .optional()
        .meta({ description: 'Client buffer health in seconds' }),
    started_at: z.string().meta({ description: 'Session start time (ISO 8601)' }),
    ip_address: z.string().meta({ description: 'Client IP address' }),
    transcode: z
        .object({
            progressPercent: z.number().meta({ description: 'Transcode progress 0-100' }),
            segmentsReady: z.number().meta({ description: 'HLS segments transcoded' }),
            totalSegments: z.number().meta({ description: 'Total expected segments' }),
        })
        .optional()
        .meta({
            description: 'Transcode job progress (only for transcoding sessions)',
        }),
});

export const route: RouteMetadata = {
    GET: {
        tags: ['Admin', 'Play Sessions'],
        summary: 'List all active play sessions',
        description:
            'Returns all active play sessions across all users with track language, ' +
            'buffer health, and transcode progress. Requires admin privileges.',
        responses: {
            200: {
                schema: z.object({
                    sessions: z.array(AdminSessionSchema),
                }),
                description: 'Active sessions',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
