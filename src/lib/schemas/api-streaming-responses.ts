// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

/**
 * Compact live-streaming summary for the admin Operations drawer.
 *
 * This is an AMBIENT, read-only "what's happening now" signal — deliberately NOT
 * part of the attention/alert model (no severity, no ack, never feeds the bell
 * verdict). The drawer is the glance; `/admin/users/sessions` is the console.
 */

export const StreamMethodSchema = z
    .enum(['direct', 'remux', 'transcode'])
    .describe('Coarse playback method (audio_transcode + full_transcode collapse to transcode)')
    .meta({ id: 'StreamMethod' });
export type StreamMethod = z.infer<typeof StreamMethodSchema>;

export const StreamRowSchema = z
    .object({
        user: z.string().describe('Watching user id — avatar lookup key'),
        username: z.string().describe('Watching user display name (handle, falls back to id)'),
        source: z
            .string()
            .optional()
            .describe(
                'Session origin: lumastra | jellyfin | livetv | music | subsonic | audiobookshelf',
            ),
        deviceId: z.string().optional().describe('Device id — used to detect /j compat sessions'),
        title: z.string().describe('What they are watching (series · SxxExx, or movie title)'),
        method: StreamMethodSchema,
        bitrateMbps: z.number().optional().describe('Declared stream bitrate, Mbps'),
        progress: z.number().min(0).max(1).optional().describe('Playback progress 0..1'),
        paused: z.boolean().optional().describe('Whether the session is paused'),
    })
    .meta({
        id: 'StreamRow',
        description: 'One active playback stream (compact)',
    });
export type StreamRow = z.infer<typeof StreamRowSchema>;

export const StreamingSummarySchema = z
    .object({
        streamCount: z.number().int().min(0).describe('Active streams'),
        userCount: z.number().int().min(0).describe('Distinct users currently watching'),
        transcodeCount: z.number().int().min(0).describe('How many streams are transcoding'),
        bandwidthMbps: z.number().min(0).describe('Aggregate bandwidth being served, Mbps'),
        streams: z.array(StreamRowSchema).describe('Up to N streams, newest-first (capped)'),
    })
    .meta({
        id: 'StreamingSummary',
        description: 'Ambient live-streaming summary for the ops drawer',
    });
export type StreamingSummary = z.infer<typeof StreamingSummarySchema>;
