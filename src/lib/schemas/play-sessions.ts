// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/schemas/play-sessions.ts
import { z } from 'zod';
import { normalizeClientFeatures } from '$lib/shared/client-features.js';

// ─── Primitives ────────────────────────────────────────────────────────────

/** Play method — unified with PlanMethodEnum so `audio_transcode` and
 *  `full_transcode` stay distinct on the wire (the server's plan_mode and
 *  the client-declared intent now share a vocabulary). */
export const PlayMethodSchema = z.enum([
    'direct',
    'remux',
    'audio_transcode',
    'full_transcode',
    'audio_only',
]);
export type PlayMethod = z.infer<typeof PlayMethodSchema>;
export const SessionStatusSchema = z.enum(['ACTIVE', 'PAUSED', 'COMPLETED', 'KILLED', 'CRASHED']);

export const ClientCapabilitiesSchema = z.object({
    video_codecs: z.array(z.string()).optional(),
    audio_codecs: z.array(z.string()).optional(),
    containers: z.array(z.string()).optional(),
    max_bitrate_kbps: z.number().int().positive().optional(),
    max_resolution: z.string().optional(),
    hdr_formats: z.array(z.string()).optional(),
});

export const RequestedFormatSchema = z.object({
    play_method: PlayMethodSchema,
    container: z.string().optional(),
    video_codec: z.string().optional(),
    audio_codec: z.string().optional(),
    bitrate_kbps: z.number().int().positive().optional(),
    resolution: z.string().optional(),
});

// ─── Request Schemas ────────────────────────────────────────────────────────

export const StartSessionRequestSchema = z.object({
    /** Pre-generated session ID — when provided, the server uses this ID
     *  instead of generating a new one. This allows the play-session-reporter
     *  and the HLS transcode path to share a single play_sessions row. */
    session_id: z.string().guid().optional(),
    media_id: z.string().guid(),
    device_id: z.string().min(1),
    /**
     * Friendly, user-facing device label (e.g. "Wohnzimmer"). Feeds the device
     * registry — it is NOT stored on the session row. Clients that only have a
     * user agent should send `user_agent` instead; sending a UA here would name
     * the user's device after their browser string.
     */
    device_name: z.string().optional(),
    /** Raw client user agent. Stored as a per-session snapshot. */
    user_agent: z.string().optional(),
    client_name: z.string().optional(),
    client_version: z.string().optional(),
    capabilities: ClientCapabilitiesSchema.optional(),
    /**
     * UI features this client can RENDER, announced so the admin surface can
     * stop offering actions the client would silently swallow — today that is
     * the per-session "Send message" toast. See `$lib/shared/client-features.ts`
     * for the token vocabulary.
     *
     * Deliberately top-level rather than a key inside `capabilities`:
     * `capabilities` is the codec/container negotiation blob the playback
     * planner reads, and its consumers treat it as codec-shaped.
     *
     * Unknown tokens are IGNORED, never rejected — a client newer than the
     * server must be able to announce a token this build has not heard of
     * without failing to start playback. Malformed and over-long entries are
     * dropped, the list is de-duplicated and capped, and an all-noise list
     * normalises to absent (which stores NULL, i.e. "announced nothing").
     */
    client_features: z
        .array(z.string())
        // `.transform().optional()` and NOT `.optional().transform()`: the
        // latter makes the KEY required in the inferred type (its value merely
        // `| undefined`), which breaks every caller that omits it. This order
        // runs the normaliser only when the field is present and leaves the key
        // optional.
        .transform((v) => normalizeClientFeatures(v))
        .optional()
        .describe(
            'UI features this client can render, e.g. ["admin_message","maintenance_notice"]. ' +
                'Lets the server hide admin actions a client would silently swallow. ' +
                'Unknown tokens are ignored, never rejected.',
        ),
    requested: RequestedFormatSchema,
    // Jellyfin correlation fields — sent for items synced from Jellyfin so the
    // server can correlate the play_sessions row with the Jellyfin item.
    jellyfin_media_source_id: z.string().optional(),
    audio_stream_index: z.number().int().nonnegative().optional(),
    subtitle_stream_index: z.number().int().nonnegative().optional(),
    audio_language: z.string().optional(),
    subtitle_language: z.string().optional(),
    // PlaybackPlan fields — sent by Lumastra web player
    plan_id: z.string().guid().optional(),
    file_id: z.string().guid().optional(),
    /**
     * The client is playing a file it ALREADY HOLDS — a download played off the
     * device, whether or not it is online. Send it so the session is visible in
     * Active Streams and reaches the right resume state; the bytes never come
     * from this server.
     *
     * Stamps `play_sessions.source = 'local'`. Clients cannot set `source`
     * directly and must not try to: a client-writable source would let any
     * caller pick its own stream-limit accounting.
     *
     * Whether such a session is EXEMPT from the concurrent-stream limit is the
     * operator's decision (`TRUST_CLIENT_LOCAL_PLAYBACK`, off by default), not
     * this flag's. The claim is unverifiable — local playback sends the server
     * no bytes, so there is nothing to corroborate it with — and an install that
     * does not trust it still labels the session "Downloaded" and still counts
     * it. Sending the flag is therefore always honest and never a way to buy a
     * slot; do not omit it hoping to look cheaper.
     */
    is_local_playback: z
        .boolean()
        .optional()
        .describe(
            'Set when the client is playing a file it already downloaded, rather than streaming ' +
                'from this server. Makes the session visible in Active Streams and badges it ' +
                '"Downloaded". Whether such a session is exempt from the concurrent-stream limit ' +
                'is an operator setting, not a property of this flag — sending it is always ' +
                'honest and never a way to buy a stream slot, so do not omit it.',
        ),
});

/**
 * Sentinel for `max_concurrent_streams` meaning "no concurrency limit".
 *
 * The column is `integer NOT NULL DEFAULT 2` with no CHECK constraint, so the
 * sentinel needs no migration. It sits alongside the pre-existing magic value
 * `0`, which means "block all streams" — do NOT conflate the two:
 *
 *   -1   → unlimited
 *    0   → blocks every stream
 *   1-20 → hard limit
 *
 * Every consumer that compares an active count against the limit MUST short-
 * circuit on this sentinel first; a raw `count >= -1` / `count <= -1` comparison
 * inverts the intent and blocks (or mass-kicks) everything. Guarded at both
 * enforcement sites: `enforceStreamPolicy` (admission) and
 * `reconcileStreamLimit` (steady-state kicking).
 */
export const UNLIMITED_CONCURRENT_STREAMS = -1;

/**
 * True when a stored `max_concurrent_streams` means "unlimited".
 *
 * Deliberately accepts ANY negative value, not just -1. The schema clamps
 * writes to >= -1, but the column has no CHECK constraint and rows can also be
 * written by hand (operators do `UPDATE user_stream_policies ...` in the
 * runbooks), so a stray -2 must fail open to unlimited rather than silently
 * inverting into a total block.
 */
export function isUnlimitedStreams(maxConcurrentStreams: number): boolean {
    return maxConcurrentStreams < 0;
}

export const UpdatePolicyRequestSchema = z.object({
    max_concurrent_streams: z
        .number()
        .int()
        .min(UNLIMITED_CONCURRENT_STREAMS)
        .max(20)
        .optional()
        .describe(
            'Max parallel streams. -1 = unlimited, 0 = block all streams, 1-20 = hard limit.',
        ),
    require_single_ip: z.boolean().optional(),
    ip_grace_period_seconds: z.number().int().min(0).max(3600).optional(),
    max_bitrate_kbps: z.number().int().positive().max(2_147_483_647).nullable().optional(),
    allowed_play_methods: z.array(PlayMethodSchema).nullable().optional(),
});

// ─── Response Schemas ────────────────────────────────────────────────────────

// `PlaySessionSourceSchema` / `PlaySessionSchema` / `PlaySession` were removed
// on 2026-07-29. They had zero importers and had drifted from the table on both
// axes: the enum was missing 'subsonic' AND 'audiobookshelf' (migration
// 16.178.0), and the object was missing plan_id/file_id/transcode_job_id and the
// rest of the transcode-plan columns. Reviving either would have rejected valid
// rows in a way that reads as a data bug rather than a schema bug — the reason
// this is a deletion and not an update.
//
// The live definitions are `PlaySessionSource` and `SessionRow` in
// `$lib/server/database/queries/play-sessions.queries.ts`, which is what every
// caller already used.

export const StreamPolicySchema = z.object({
    user_id: z.string(),
    max_concurrent_streams: z.number(),
    require_single_ip: z.boolean(),
    ip_grace_period_seconds: z.number(),
    max_bitrate_kbps: z.number().nullable(),
    allowed_play_methods: z.array(z.string()).nullable(),
    updated_at: z.string(),
    updated_by: z.string().nullable(),
});

// ─── TypeScript types ────────────────────────────────────────────────────────

export type StartSessionRequest = z.infer<typeof StartSessionRequestSchema>;
export type StreamPolicy = z.infer<typeof StreamPolicySchema>;
export type UpdatePolicyRequest = z.infer<typeof UpdatePolicyRequestSchema>;
