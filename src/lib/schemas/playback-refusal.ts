// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { PlayMethodSchema } from './play-sessions.js';

export const PlaybackRefusalCodeSchema = z.enum([
    'stream_limit',
    'prefetch_requires_current_session',
    'transcode_not_allowed',
    'source_incompatible',
    'ip_restricted',
    'plugin_denied',
]);
export const PlaybackRefusalDetailsSchema = z.object({
    active: z.number().int().optional(),
    limit: z.number().int().optional(),
    allowedMethods: z.array(PlayMethodSchema).optional(),
    suggestion: z.string().optional(),
    requestedMethod: PlayMethodSchema.optional(),
    graceRemainingSeconds: z.number().optional(),
    reason: z.string().optional(),
    plugin: z.string().optional(),
});
export const PlaybackRefusalSchema = z.object({
    code: PlaybackRefusalCodeSchema,
    error: z.string(),
    status: z.literal(422),
    details: PlaybackRefusalDetailsSchema,
});
export type PlaybackRefusalDetails = z.infer<typeof PlaybackRefusalDetailsSchema>;
