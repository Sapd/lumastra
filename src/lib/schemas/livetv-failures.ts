// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { LIVETV_FAILURE_REASONS } from '../../shared/livetv-failure-reason.js';

/**
 * Typed Live TV failure schemas. Design:
 * docs/superpowers/specs/2026-10-20-livetv-failure-taxonomy-design.md
 */

export const LiveTvFailureCodeSchema = z.enum(LIVETV_FAILURE_REASONS).meta({
    id: 'LiveTvFailureCode',
    description:
        'Why a Live TV channel will not play. channel_offline: upstream 404/410, empty playlist or no data before the first segment. ' +
        'provider_auth_failed: upstream 401/403 (account expired, wrong credentials). ' +
        'provider_connection_limit: the provider refuses for its own maximum connections. ' +
        'provider_unreachable: DNS, connect, TLS, timeout, provider 5xx or a blocked URL. ' +
        'geo_blocked: upstream 451 or a geo-restricted 403. ' +
        'no_video: neither video nor audio found, or no compatible decoder. ' +
        'encoder_failed: the server transcode or egress failed. ' +
        'all_feeds_failed: every feed of the station failed. ' +
        'upstream_stalled: the source stopped after it had delivered segments.',
});

export const LiveTvFeedTriedSchema = z
    .object({
        feedId: z.string().optional().describe('Feed (channel) UUID of the attempt'),
        feedName: z.string().optional().describe('Display name of the feed'),
        reason: LiveTvFailureCodeSchema.describe('Why this feed failed'),
        upstreamStatus: z
            .number()
            .int()
            .optional()
            .describe('HTTP status the provider answered, when the failure came from one'),
    })
    .meta({
        id: 'LiveTvFeedTried',
        description: 'One feed of a station that was tried and failed. Never contains URLs.',
    });

export const LiveTvFailureExtensionSchema = z
    .object({
        retryable: z
            .boolean()
            .describe('false means do not retry automatically; offer another channel instead'),
        feedsTried: z
            .array(LiveTvFeedTriedSchema)
            .optional()
            .describe('How each feed failed. Present for administrators only.'),
    })
    .meta({
        id: 'LiveTvFailureExtension',
        description: 'The `failure` member of a Live TV problem',
    });

export const LiveTvFailureProblemSchema = z
    .object({
        code: LiveTvFailureCodeSchema.describe('Switch on this value'),
        error: z.string().describe('Human-readable text; display only'),
        status: z.number().int().describe('Mirrors the HTTP status'),
        retryAfter: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('Suggested wait before a retry, in seconds (also the Retry-After header)'),
        failure: LiveTvFailureExtensionSchema,
        requestId: z.string().optional(),
    })
    .meta({
        id: 'LiveTvFailureProblem',
        description: 'application/problem+json for a Live TV channel that will not play',
    });

/**
 * 503 on a start: the provider's own connection limit, our stream limit, an unreachable
 * dependency or an unsatisfiable bitrate cap. All carry `failure.retryable` and `retryAfter`.
 */
export const LiveTvStartUnavailableProblemSchema = LiveTvFailureProblemSchema.omit({
    code: true,
})
    .extend({
        code: z
            .enum([
                'provider_connection_limit',
                'stream_limit',
                'dependency_unavailable',
                'cap_unavailable',
            ])
            .describe('Switch on this value'),
        failure: LiveTvFailureExtensionSchema.optional().describe(
            'Absent on cap_unavailable, which is not a retry decision',
        ),
        reason: z
            .string()
            .optional()
            .describe('Detail for stream_limit / cap_unavailable (the cap refusal)'),
        details: z
            .string()
            .optional()
            .describe('stream_limit: JSON text with limit and active streams'),
    })
    .meta({
        id: 'LiveTvStartUnavailableProblem',
        description: 'application/problem+json for a Live TV start that is unavailable right now',
    });

export const LiveTvChannelHealthSchema = z
    .object({
        state: z
            .enum(['ok', 'failing', 'offline'])
            .describe(
                'ok: no failure since the last success; failing: 1-2 in a row; offline: 3 or more in a row',
            ),
        consecutiveFailures: z.number().int().nonnegative(),
        lastReason: z.string().optional().describe('Last failure code (see LiveTvFailureCode)'),
        lastFailureAt: z.string().optional().describe('ISO 8601'),
        lastSuccessAt: z.string().optional().describe('ISO 8601'),
    })
    .meta({
        id: 'LiveTvChannelHealth',
        description: 'Playback health of one Live TV feed (admin view)',
    });

export const LiveTvSessionFailureSchema = z
    .object({
        code: LiveTvFailureCodeSchema,
        retryable: z.boolean(),
        retryAfterMs: z.number().int().nonnegative().optional(),
        at: z.string().describe('When the failure was detected (ISO 8601)'),
    })
    .meta({
        id: 'LiveTvSessionFailure',
        description: 'Why a playback session ended with endReason "failed"',
    });

export type LiveTvFailureCode = z.infer<typeof LiveTvFailureCodeSchema>;
export type LiveTvFeedTried = z.infer<typeof LiveTvFeedTriedSchema>;
export type LiveTvFailureProblem = z.infer<typeof LiveTvFailureProblemSchema>;
export type LiveTvStartUnavailableProblem = z.infer<typeof LiveTvStartUnavailableProblemSchema>;
export type LiveTvChannelHealth = z.infer<typeof LiveTvChannelHealthSchema>;
export type LiveTvSessionFailure = z.infer<typeof LiveTvSessionFailureSchema>;
