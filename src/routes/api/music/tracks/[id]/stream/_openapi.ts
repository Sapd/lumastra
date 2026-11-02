// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';

const AUDIO_TYPES = [
    'audio/flac',
    'audio/mpeg',
    'audio/mp4',
    'audio/ogg',
    'audio/wav',
    'audio/aac',
    'application/octet-stream',
];

export const route: RouteMetadata = {
    GET: {
        tags: ['Music'],
        summary: 'Stream audio file',
        description:
            'Streams the audio file with full HTTP range request support for seeking. ' +
            'Supports all formats: FLAC, MP3, M4A, Opus, OGG, WAV, AAC, AIFF. ' +
            'Returns 206 Partial Content when a Range header is provided. ' +
            'When FEATURE_MUSIC_TRANSCODE is enabled, the optional format / ' +
            'maxBitrateKbps / bitrateKbps / startPositionSeconds parameters trigger server-side transcoding ' +
            'via FFmpeg and return a streamed transcoded response instead.',
        query: z.object({
            format: z
                .enum(['mp3', 'opus', 'aac', 'm4a', 'raw'])
                .optional()
                .describe(
                    'Target audio format. "raw" requires direct play and must satisfy any supplied constraints. ' +
                        'Omit all negotiation parameters for unprobed direct play.',
                ),
            maxBitrateKbps: z
                .string()
                .optional()
                .describe(
                    'Maximum bitrate in kilobits per second (0 means uncapped). Triggers transcode if source bitrate exceeds this value.',
                ),
            bitrateKbps: z
                .string()
                .optional()
                .describe(
                    'Explicit positive integer bitrate in kilobits per second; forces encoding.',
                ),
            startPositionSeconds: z
                .string()
                .optional()
                .describe('Start playback at this offset in seconds. Always triggers transcoding.'),
        }),
        responses: {
            200: { binary: AUDIO_TYPES, description: 'Full audio file' },
            206: {
                binary: AUDIO_TYPES,
                description: 'Partial audio content (range request)',
            },
            400: 'Malformed negotiation query',
            415: 'Stored file is not playable audio',
            422: 'Audio constraints cannot be satisfied',
            416: 'Range Not Satisfiable',
            404: 'Track not found',
            503: 'Transcode concurrency cap reached — retry after the indicated delay',
        },
    },
};
