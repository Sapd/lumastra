// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Wire contract for "why did this transcode instead of direct playing?".
 *
 * ## Every input to the decision was already stored
 *
 * `play_sessions` persists `play_method`, `plan_reasons` (the planner's own
 * reason strings), the source and delivered codecs, the container, the client
 * name and version, and the device capabilities it advertised. The answer to the
 * most common performance complaint on the product was already in the database
 * per session; nothing showed it next to the question.
 *
 * ## Sessions, not a verdict
 *
 * Unlike the other diagnostics this reports a LIST rather than a single verdict,
 * because the honest answer is per-playback: the same file direct-plays to one
 * client and full-transcodes to another, and which client is the whole point.
 * Collapsing that to one answer would hide the variable that matters.
 */

import { z } from 'zod';

export const PlaybackDecisionSessionSchema = z.object({
    sessionId: z.string(),
    startedAt: z.string(),
    username: z.string().nullable(),
    clientName: z.string().nullable(),
    clientVersion: z.string().nullable(),

    /** direct / remux / audio_transcode / full_transcode / audio_only. */
    playMethod: z.string(),
    /**
     * The planner's own reasons for that method, as recorded at decision time.
     * Empty for a direct play, which needs no justification.
     */
    planReasons: z.array(z.string()),
    /**
     * False when the planner left no record for this session (plan_reasons
     * null): the client did not use the planner, so `playMethod` is what the
     * client reported, not a recorded decision.
     */
    planRecorded: z.boolean(),

    /**
     * The SOURCE file's codecs, container and bitrate, as recorded at session
     * start — not what reached the client. For a transcode, the target is
     * `transcodeCodec`.
     */
    videoCodec: z.string().nullable(),
    audioCodec: z.string().nullable(),
    container: z.string().nullable(),
    resolution: z.string().nullable(),
    bitrateKbps: z.number().nullable(),
    /** The codec transcoding targeted, when it ran. */
    transcodeCodec: z.string().nullable(),
    subtitleMethod: z.string().nullable(),
    deliveryPath: z.string().nullable(),
});
export type PlaybackDecisionSession = z.infer<typeof PlaybackDecisionSessionSchema>;

export const PlaybackDecisionSchema = z.object({
    generatedAt: z.string(),
    mediaId: z.string(),
    mediaTitle: z.string(),

    /**
     * Every stream the file contains, so the session's source summary can be
     * read against the full track list.
     */
    sourceStreams: z.array(
        z.object({
            kind: z.string(),
            codec: z.string().nullable(),
            profile: z.string().nullable(),
            channels: z.number().nullable(),
            language: z.string().nullable(),
        }),
    ),

    /** Recent sessions for this item, newest first. Empty is a real answer. */
    sessions: z.array(PlaybackDecisionSessionSchema),
});
export type PlaybackDecision = z.infer<typeof PlaybackDecisionSchema>;
