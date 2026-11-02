// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

/** A rung id the way the Live TV ladder names it ("720p4m"), or "original". */
const VariantIdSchema = z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,32}$/)
    .describe('Ladder id of the variant, e.g. "720p4m" (Live TV rung id) or "original"');

const ClientLadderEntrySchema = z.object({
    id: VariantIdSchema.optional(),
    height: z.number().int().positive().max(4320).optional(),
    bitrate: z
        .number()
        .int()
        .positive()
        .max(1_000_000_000)
        .optional()
        .describe('Peak bitrate the variant advertises, bits per second'),
});

/**
 * What an adaptive (ABR) player reports about its own variant selection, sent on the
 * play-session heartbeat (`PUT /play-sessions/{id}`). Everything is optional: the
 * server already infers the Live TV variant from the segments a viewer fetches, and
 * this only adds what only the player knows.
 *
 * Mapping for clients:
 * - hls.js: `variant_id` / `height` / `indicated_bitrate` from `hls.levels[hls.currentLevel]`,
 *   `measured_bandwidth` from `hls.bandwidthEstimate`.
 * - AVPlayer: `indicated_bitrate` from `AVPlayerItemAccessLogEvent.indicatedBitrate`,
 *   `measured_bandwidth` from `observedBitrate`, `height` from `presentationSize`,
 *   `switches` = access-log events whose `indicatedBitrate` differs from the previous one,
 *   `rebuffers` = the sum of `numberOfStalls`.
 */
export const SessionAdaptiveReportSchema = z.object({
    variant_id: VariantIdSchema.optional(),
    height: z.number().int().positive().max(4320).optional(),
    indicated_bitrate: z
        .number()
        .int()
        .positive()
        .max(1_000_000_000)
        .optional()
        .describe('Peak bitrate of the variant playing now, bits per second'),
    measured_bandwidth: z
        .number()
        .int()
        .positive()
        .max(100_000_000_000)
        .optional()
        .describe("The player's measured download bandwidth, bits per second"),
    switches: z
        .number()
        .int()
        .nonnegative()
        .max(1_000_000)
        .optional()
        .describe('Variant switches since the session started'),
    rebuffers: z
        .number()
        .int()
        .nonnegative()
        .max(1_000_000)
        .optional()
        .describe('Playback stalls since the session started'),
    ladder: z
        .array(ClientLadderEntrySchema)
        .max(16)
        .optional()
        .describe('Every variant the player can switch between, highest first'),
});

export type SessionAdaptiveReport = z.infer<typeof SessionAdaptiveReportSchema>;

export const AdaptiveVariantSchema = z.object({
    /** Rung id ("720p4m"), "original", or `${height}p` for a client-reported VOD level. */
    id: z.string(),
    height: z.number().int().optional(),
    /** Peak bitrate in bits per second; absent for the copied Original. */
    bitrate: z.number().int().optional(),
    original: z.boolean().optional(),
});

export type AdaptiveVariant = z.infer<typeof AdaptiveVariantSchema>;

/** Position of the playing variant in its ladder: green at the top, red at the bottom. */
export const AdaptiveTierSchema = z.enum(['top', 'high', 'low', 'bottom']);
export type AdaptiveTier = z.infer<typeof AdaptiveTierSchema>;

/**
 * Adaptive-bitrate state of one play session, as Active Streams and Admin → Sessions
 * show it. Present only for sessions that play an adaptive ladder.
 *
 * `source` says where `current` came from: `server` when it was inferred from the
 * Live TV segments the viewer fetched (works for every client), `client` when only
 * the player's own report names it (adaptive VOD, or before the first segment).
 */
export const SessionAdaptiveSchema = z
    .object({
        source: z.enum(['server', 'client']),
        current: AdaptiveVariantSchema.optional(),
        /** ISO time the viewer switched to `current` (server inference only). */
        currentSince: z.string().optional(),
        /** Every variant the viewer can switch between, highest first. */
        ladder: z.array(AdaptiveVariantSchema),
        tier: AdaptiveTierSchema.optional(),
        /** Variant switches seen so far (server count, else the client's). */
        switches: z.number().int().optional(),
        /** The latest switches, newest first (server inference only, at most 5). */
        recentSwitches: z
            .array(z.object({ from: z.string(), to: z.string(), at: z.string() }))
            .optional(),
        /** ISO time of the viewer's latest adaptive segment fetch. */
        lastSegmentAt: z.string().optional(),
        /** Client-measured download bandwidth, bits per second. */
        measuredBandwidth: z.number().int().optional(),
        /** Peak bitrate of the variant the client says it plays, bits per second. */
        indicatedBitrate: z.number().int().optional(),
        rebuffers: z.number().int().optional(),
        /** ISO time of the client's latest adaptive report. */
        clientReportedAt: z.string().optional(),
    })
    .meta({ id: 'SessionAdaptive' });

export type SessionAdaptive = z.infer<typeof SessionAdaptiveSchema>;
