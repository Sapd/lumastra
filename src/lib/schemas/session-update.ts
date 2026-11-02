// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { ClientSubtitleMethodEnum } from './playback-plan.js';
import { PlayMethodSchema } from './play-sessions.js';
import { SessionAdaptiveReportSchema } from './session-adaptive.js';

export const EndReasonSchema = z.enum([
    'user', // user pressed stop / navigated intentionally
    'completion', // reached end of media
    'unload', // tab closed / page unloaded
    'error', // playback error
    'skip', // user skipped a music track
    'switch', // switched to a new source/quality/episode
]);

export const SessionUpdateSchema = z.object({
    car_play: z.boolean().optional(),
    finished: z.boolean().optional().describe('Audiobook finished flag'),
    listened_ms: z
        .number()
        .int()
        .nonnegative()
        .max(604_800_000)
        .optional()
        .describe(
            'Heard audio in ms. Music: cumulative total; omitted uses session_elapsed_ms. Audiobook: audio heard since the previous report; omitted uses the growth of session_elapsed_ms since then',
        ),
    next_media_id: z
        .string()
        .uuid()
        .optional()
        .describe('Next music track; set-only, omitted keeps the current value'),
    crossfade: z
        .object({
            otherTrackId: z.string().uuid(),
            role: z.enum(['incoming', 'outgoing']),
            remainingMs: z.number().int().min(0).max(60_000),
            durationMs: z.number().int().min(1).max(60_000),
        })
        .nullable()
        .optional()
        .describe(
            'Omitted leaves unchanged, null clears, object sets. PAUSED with a fade clears it; COMPLETED clears fade and next track.',
        ),
    position_ms: z.number().int().nonnegative(),
    status: z.enum(['ACTIVE', 'PAUSED', 'COMPLETED']),
    event_seq: z
        .number()
        .int()
        .nonnegative()
        .describe(
            'Monotonic counter per session; server rejects non-increasing values within the same session',
        ),
    end_reason: EndReasonSchema.optional().describe(
        'Only meaningful when status=COMPLETED (i.e. terminal write)',
    ),
    stop_reason: z.string().optional(), // legacy free-form; keep for one pass then drop in cleanup
    audio_stream_index: z.number().int().nonnegative().optional(),
    subtitle_stream_index: z.number().int().nonnegative().optional(),
    bitrate_kbps: z.number().int().positive().optional(),
    resolution: z.string().optional(),
    play_method: PlayMethodSchema.optional(),
    audio_language: z.string().optional(),
    subtitle_language: z.string().optional(),
    subtitle_method: ClientSubtitleMethodEnum.optional().describe(
        "Client-reported subtitle delivery (external_vtt | client_render | none). Schema excludes 'burn_in' because that is a server-side FFmpeg decision owned by the HLS planner and must not originate from heartbeats.",
    ),
    buffer_health_sec: z.number().nonnegative().optional(),
    // `.catch`: a malformed display-only block must never cost the heartbeat (a
    // rejected heartbeat can end the session) — it is dropped instead.
    adaptive: SessionAdaptiveReportSchema.optional()
        .catch(undefined)
        .describe(
            'Adaptive (ABR) players: the variant playing now, measured bandwidth, switches and stalls. Shown in Active Streams and Admin → Sessions; never affects playback.',
        ),
    session_elapsed_ms: z
        .number()
        .int()
        .nonnegative()
        // 7 days = 604_800_000 ms. PG INTEGER caps at ~24.8 days, so this
        // is well under the column ceiling. Bigger values are either a
        // buggy/hostile client (worth rejecting) or a degenerate session
        // that has been "playing" for a week — also worth rejecting since
        // the engagement signal would be saturated and meaningless.
        .max(7 * 24 * 60 * 60 * 1000)
        .describe(
            'Required cumulative ms the player was actually playing in this session (excluding pauses, seeks, buffering). Zero means no verified active playback yet; positive values drive the engagement-based Continue Watching gate.',
        ),
});

export type SessionUpdate = z.infer<typeof SessionUpdateSchema>;

/**
 * Public wire body of PUT /play-sessions/{id} and its beacon (camelCase).
 *
 * The service keeps the snake_case `SessionUpdate`; convert with
 * `playbackReportToSessionUpdate` before calling it.
 */
export const PlaybackReportSchema = z
    .object({
        clientInfo: z
            .object({ carPlay: z.boolean().optional() })
            .strip()
            .optional()
            .catch(undefined)
            .describe(
                'Client-reported current CarPlay connection context. Omitted preserves; false clears. Display only; never changes identity or authorization.',
            ),
        finished: z.boolean().optional().describe('Audiobook finished flag'),
        listenedTotalMs: z
            .number()
            .int()
            .nonnegative()
            .max(604_800_000)
            .optional()
            .describe(
                'Music only: cumulative heard audio in this session, excluding seeks, pauses and buffering. Omitted uses sessionElapsedMs. The first positive total counts the play once.',
            ),
        listenedDeltaMs: z
            .number()
            .int()
            .nonnegative()
            .max(604_800_000)
            .optional()
            .describe(
                'Audiobook only: heard audio since the previous accepted report. Omitted uses growth of cumulative sessionElapsedMs; every accepted report advances that baseline.',
            ),
        listenedMs: z
            .number()
            .int()
            .nonnegative()
            .max(604_800_000)
            .optional()
            .describe(
                'Deprecated, still accepted for shipped clients: ignored for video; music maps it to listenedTotalMs and audiobooks to listenedDeltaMs when the new field is absent.',
            ),
        nextMediaId: z
            .string()
            .uuid()
            .optional()
            .describe('Next music track; set-only, omitted keeps the current value'),
        crossfade: z
            .object({
                otherTrackId: z.string().uuid(),
                role: z.enum(['incoming', 'outgoing']),
                remainingMs: z.number().int().min(0).max(60_000),
                durationMs: z.number().int().min(1).max(60_000),
            })
            .nullable()
            .optional()
            .describe(
                'Omitted leaves unchanged, null clears, object sets. PAUSED with a fade clears it; COMPLETED clears fade and next track.',
            ),
        positionMs: z.number().int().nonnegative(),
        status: z.enum(['ACTIVE', 'PAUSED', 'COMPLETED']),
        eventSeq: z
            .number()
            .int()
            .nonnegative()
            .describe(
                'Monotonic counter per session; server rejects non-increasing values within the same session',
            ),
        endReason: EndReasonSchema.optional().describe(
            'Only meaningful when status=COMPLETED (i.e. terminal write)',
        ),
        audioStreamIndex: z.number().int().nonnegative().optional(),
        subtitleStreamIndex: z.number().int().nonnegative().optional(),
        bitrateBps: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Active bitrate in bits per second'),
        resolution: z.string().optional(),
        playMethod: PlayMethodSchema.optional(),
        audioLanguage: z.string().optional(),
        subtitleLanguage: z.string().optional(),
        subtitleMethod: ClientSubtitleMethodEnum.optional().describe(
            "Client-reported subtitle delivery (external_vtt | client_render | none). Schema excludes 'burn_in' because that is a server-side FFmpeg decision owned by the HLS planner and must not originate from heartbeats.",
        ),
        bufferHealthMs: z.number().int().nonnegative().optional().describe('Buffer health in ms'),
        // `.catch`: a malformed display-only block must never cost the heartbeat (a
        // rejected heartbeat can end the session) — it is dropped instead.
        adaptive: SessionAdaptiveReportSchema.optional()
            .catch(undefined)
            .describe(
                'Adaptive (ABR) players: the variant playing now, measured bandwidth, switches and stalls. Shown in Active Streams and Admin → Sessions; never affects playback.',
            ),
        sessionElapsedMs: z
            .number()
            .int()
            .nonnegative()
            // 7 days = 604_800_000 ms. PG INTEGER caps at ~24.8 days, so this
            // is well under the column ceiling. Bigger values are either a
            // buggy/hostile client (worth rejecting) or a degenerate session
            // that has been "playing" for a week — also worth rejecting since
            // the engagement signal would be saturated and meaningless.
            .max(7 * 24 * 60 * 60 * 1000)
            .describe(
                'Required cumulative ms the player was actually playing in this session (excluding pauses, seeks, buffering). Zero means no verified active playback yet; positive values drive the engagement-based Continue Watching gate.',
            ),
    })
    .strip();

export type PlaybackReport = z.infer<typeof PlaybackReportSchema>;

/**
 * Maps the camelCase wire body onto the internal snake_case `SessionUpdate`.
 * `bitrateBps` is stored as kbps (at least 1 for any positive value).
 */
export function playbackReportToSessionUpdate(
    report: PlaybackReport,
    mediaType?: string,
): SessionUpdate {
    // Native clients may share one report DTO across media kinds. Ignore valid
    // fields that do not apply here; malformed known values still fail parsing.
    const acceptsAudio = mediaType === undefined || ['track', 'audiobook'].includes(mediaType);
    const acceptsMusic = mediaType === undefined || mediaType === 'track';
    const acceptsBook = mediaType === undefined || mediaType === 'audiobook';
    const bitrateKbps =
        report.bitrateBps === undefined ? 0 : Math.max(1, Math.round(report.bitrateBps / 1000));
    return {
        car_play: report.clientInfo?.carPlay,
        finished: acceptsBook ? report.finished : undefined,
        listened_ms: acceptsAudio
            ? mediaType === 'audiobook'
                ? (report.listenedDeltaMs ?? report.listenedMs)
                : (report.listenedTotalMs ?? report.listenedMs)
            : undefined,
        next_media_id: acceptsMusic ? report.nextMediaId : undefined,
        crossfade: acceptsMusic ? report.crossfade : undefined,
        position_ms: report.positionMs,
        status: report.status,
        event_seq: report.eventSeq,
        end_reason: report.endReason,
        audio_stream_index: report.audioStreamIndex,
        subtitle_stream_index: report.subtitleStreamIndex,
        bitrate_kbps: bitrateKbps > 0 ? bitrateKbps : undefined,
        resolution: report.resolution,
        play_method: report.playMethod,
        audio_language: report.audioLanguage,
        subtitle_language: report.subtitleLanguage,
        subtitle_method: report.subtitleMethod,
        buffer_health_sec:
            report.bufferHealthMs === undefined ? undefined : report.bufferHealthMs / 1000,
        adaptive: report.adaptive,
        session_elapsed_ms: report.sessionElapsedMs,
    };
}

/**
 * Payload type for `PlaySessionLifecycleService.update()`.
 *
 * The HTTP contract above requires `session_elapsed_ms`: a Lumastra player owns
 * a play-time accumulator and must always report it, otherwise the engagement
 * gate can never open and the series never reaches Continue Watching.
 *
 * Two in-process callers legitimately have no accumulator, and the service has
 * documented handling for both — so they must NOT be forced to fabricate one:
 *   - `/j` Jellyfin-compat routes: Jellyfin's protocol has no elapsed concept.
 *     The service synthesizes it from the playhead for compat sessions, and on
 *     the stop path that synthesis uses the crash-recovery-adjusted position
 *     (a client reporting 0 after a crash falls back to the session's last
 *     known position). Passing a literal value at those call sites would
 *     bypass the `??` and permanently gate every Jellyfin client out of
 *     Continue Watching.
 *   - the stale-session reaper, which finalizes server-side.
 */
export type SessionUpdateInternal = Omit<SessionUpdate, 'session_elapsed_ms'> & {
    session_elapsed_ms?: number;
};

export type EndReason = z.infer<typeof EndReasonSchema>;
