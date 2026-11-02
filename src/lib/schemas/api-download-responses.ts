// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Offline-download rendition schemas.
 *
 * A "rendition" is a server-produced progressive MP4 of one title at one quality
 * with one audio track, cached and re-served to every client that asks for the
 * same combination. Distinct from `/media/{id}/download`, which streams the
 * untouched original.
 */

import { z } from 'zod';

export const RenditionStatusSchema = z
    .enum(['absent', 'queued', 'encoding', 'ready', 'failed'])
    .describe(
        'Lifecycle of one rendition. `absent` means nothing has been built for this rung yet — ' +
            'it is the only state that is not backed by a row, and POSTing is what leaves it.',
    );

export const DownloadRungSchema = z
    .object({
        id: z
            .string()
            .describe('Rung id to send back when requesting this rendition (e.g. "720p")'),
        label: z.string().describe('Display label for a picker row'),
        height: z
            .number()
            .int()
            .describe('Target height in pixels; width follows the source aspect'),
        videoBitrate: z.number().int().describe('Target video bitrate, bits/sec'),
        audioBitrate: z
            .number()
            .int()
            .describe(
                'Target audio bitrate, bits/sec (stereo AAC). Reported as 0 when the source has ' +
                    'no audio stream and the rendition is encoded video-only.',
            ),
        estimatedSizeBytes: z
            .number()
            .int()
            .nullable()
            .describe(
                'Approximate finished size, from target bitrate x duration (+ container overhead). ' +
                    'Within roughly +/-10% of the real file — intended for "720p - ~1.4 GB" in a picker, ' +
                    'never presented as exact. Null when the source duration is unknown.',
            ),
        status: RenditionStatusSchema,
        renditionId: z
            .string()
            .optional()
            .describe('Present once a rendition exists for this rung; poll /renditions/{id}'),
        progressPct: z
            .number()
            .optional()
            .describe('Encode progress, 0-99 while encoding, 100 when ready'),
        sizeBytes: z
            .number()
            .int()
            .optional()
            .describe('Actual size of the finished artifact. Present only when status is ready.'),
    })
    .meta({ id: 'DownloadRung', description: 'One selectable download quality' });

export const RenditionListResponseSchema = z
    .object({
        fileId: z.string().describe('The version these rungs describe'),
        durationMs: z.number().nullable(),
        sourceHeight: z
            .number()
            .int()
            .nullable()
            .describe('Source height, for context in a picker'),
        audioIndex: z
            .number()
            .int()
            .nullable()
            .describe(
                'The audio track these per-rung statuses were resolved against, or null when the ' +
                    'source has no audio stream at all and the rungs describe a video-only encode. ' +
                    'Renditions are keyed on (file, rung, audio track), so a different track has ' +
                    'its own independent status.',
            ),
        rungs: z
            .array(DownloadRungSchema)
            .describe(
                'Offered qualities, highest first. Never includes a rung above the source height — ' +
                    'upscaling costs bytes and adds no detail.',
            ),
    })
    .meta({
        id: 'RenditionList',
        description: 'Selectable offline-download qualities for one version',
    });

export const RenditionSchema = z
    .object({
        id: z.string(),
        status: RenditionStatusSchema,
        progressPct: z.number(),
        sizeBytes: z.number().int().optional(),
        rungId: z.string(),
        audioIndex: z
            .number()
            .int()
            .nullable()
            .describe('Encoded audio track, or null for a video-only artifact.'),
        url: z
            .string()
            .optional()
            .describe(
                'Download URL. Present only when status is ready. Supports Range, carries a strong ' +
                    'ETag/Last-Modified, and is stable and re-requestable — safe to resume against and ' +
                    'safe to retry with a freshly minted token.',
            ),
        errorCode: z
            .string()
            .optional()
            .describe('Present when status is failed. POST the rendition again to retry.'),
    })
    .meta({ id: 'Rendition', description: 'State of one offline-download rendition' });

export type Rendition = z.infer<typeof RenditionSchema>;
export type RenditionList = z.infer<typeof RenditionListResponseSchema>;
