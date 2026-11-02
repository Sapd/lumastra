// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Audiobook start payload and internal upstream input types.
 * Public playback tracks/chapters use milliseconds and server-built URLs.
 * Reports use PUT /play-sessions/{playbackSessionId} (or POST .../beacon).
 * ABS shapes below are used only while normalizing the server's upstream input.
 */

import { ImageSetSchema } from './api-image-descriptor.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Raw AudiobookShelf shapes (SECONDS)
// ---------------------------------------------------------------------------

/**
 * One entry of ABS's `audioTracks[]`, projected to the fields the timeline
 * reads.
 *
 * Projected rather than passed verbatim: the live payload carries a ~40-field
 * `metadata` blob and every ID3 tag per file, which on a 228-file book is
 * hundreds of kilobytes of JSON the client never looks at.
 *
 * `duration` and `codec` are `.nullable()` and not merely optional because the
 * live server genuinely sends `null` for both — `duration` when the file could
 * not be probed, `codec` on the single synthetic HLS track (measured).
 */
export const AbsAudioTrackSchema = z
    .object({
        index: z.number().int().describe('1-based position in the file list'),
        /** ABS addresses files by inode. Absent on the synthetic HLS track. */
        ino: z.string().optional().describe('Inode the byte proxy addresses this file by'),
        startOffset: z.number().describe('Accumulated offset from the start of the book, SECONDS'),
        duration: z.number().nullable().optional().describe('File length, SECONDS'),
        mimeType: z.string().nullable().optional().describe('Container MIME type'),
        codec: z.string().nullable().optional().describe('Audio codec, e.g. mp3, aac, eac3'),
        title: z.string().nullable().optional().describe('Display name'),
        /**
         * The server's own verdict, from the PERSISTED per-file codec
         * (`custom_metadata.audiobookshelf.audioFiles[].codec`) rather than from
         * the container MIME type AudiobookShelf negotiated on.
         *
         * True means "at least one supported engine cannot decode this file, so
         * `…/remux/{ino}` exists for it". It is NOT an instruction: WebKit plays
         * E-AC-3 natively (measured `canPlayType('audio/mp4; codecs="ec-3"') ===
         * 'probably'`), so a client that CAN decode the codec ignores the flag and
         * direct-plays. A client that cannot probe (AVPlayer, a third-party
         * player) should treat it as an instruction.
         */
        needsRemux: z
            .boolean()
            .optional()
            .describe('Server verdict from the persisted codec: a Lumastra remux is available'),
    })
    .meta({ id: 'AbsAudioTrack', description: 'One AudiobookShelf audio track' });

export type AbsAudioTrack = z.infer<typeof AbsAudioTrackSchema>;

/**
 * One chapter of a book, in AudiobookShelf's units.
 *
 * **Normalised by the server, not verbatim upstream.** The spans are contiguous
 * and cover `[0, duration]`: each `end` equals the next `start` exactly, the
 * last one ends at the book's duration, and chapters describing audio the
 * library does not have are dropped. That is deliberate and load-bearing —
 * AudiobookShelf's raw list can leave a hole at the end (7 of 1060 books
 * measured, up to 18h49m), and clients resolve such a hole differently: one
 * bounds a chapter by the NEXT start, another trusts `end`. On normalised
 * spans those two strategies agree by construction, so a client cannot get it
 * wrong by picking either.
 */
export const AbsChapterSchema = z
    .object({
        id: z.number().int().optional().describe('ABS chapter id'),
        title: z.string().nullable().optional().describe('Chapter title'),
        start: z.number().describe('Chapter start, SECONDS'),
        end: z.number().nullable().optional().describe('Chapter end, SECONDS'),
        synthetic: z
            .boolean()
            .optional()
            .describe(
                'This span was invented by the server to cover audio past the end of the ' +
                    'upstream chapter list; `title` is null and the client supplies its own label',
            ),
    })
    .meta({ id: 'AbsChapter', description: 'One chapter of a book, server-normalised' });

export type AbsChapter = z.infer<typeof AbsChapterSchema>;

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

export const AudiobookPlayMethodSchema = z
    .enum(['direct', 'transcode'])
    .describe('Whether the book is served as files or as one HLS playlist');

export type AudiobookPlayMethod = z.infer<typeof AudiobookPlayMethodSchema>;

export const OpenAudiobookSessionRequestSchema = z
    .object({
        mediaId: z.string().min(1).describe('Lumastra media_items.id'),
        /**
         * Where to start, ms of book time.
         *
         * OMIT to resume where the listener left off — the server answers with
         * AudiobookShelf's own saved progress, which is the position both
         * systems already agree on.
         *
         * Supplying it does NOT write anything upstream. It only changes the
         * `startPositionMs` the client is told to start at, and the client
         * seeks its own element there. That is deliberate: ABS's progress row
         * is last-write-wins with no history, so a position that has not yet
         * survived the player's dwell gate must never be pushed to it.
         */
        positionMs: z.number().int().min(0).optional().describe('Book-time start position, ms'),
        supportedMimeTypes: z
            .array(z.string().min(1).max(64))
            .max(32)
            .optional()
            .describe("From the browser's canPlayType(); ABS negotiates direct-vs-transcode on it"),
        purpose: z
            .enum(['playback', 'download'])
            .optional()
            .describe(
                'Why the session is being opened. Defaults to `playback`, which also ENDS the ' +
                    "listener's other sessions it replaces: any session on the same book on " +
                    'another device (paused or still playing), and any session on this deviceId. ' +
                    'The displaced client gets `superseded: true` on its next report or heartbeat ' +
                    'and should stop without closing. Send `download` when you only need the ' +
                    'track list and a stream token to fetch files for offline use: nothing is ' +
                    'ended, and no later playback open ends the download either. Everything else ' +
                    'about the session is identical, stream policy included.',
            ),
        deviceId: z
            .string()
            .min(1)
            .max(128)
            .describe(
                'Stable per-device id. ABS closes any OTHER open session for the same ' +
                    '(user, deviceId), so one shared id per install kills the laptop session ' +
                    'when the phone starts a book.',
            ),
        /**
         * Force a transcode even when the MIME types negotiate to direct play.
         *
         * Needed because ABS negotiates on container MIME type only and cannot
         * see the codec inside: an E-AC-3 track (39 of 3384 files measured)
         * advertises `audio/mp4` and then throws `EncodingError` in Chromium.
         */
        requestedMethod: z
            .enum(['direct', 'audio_transcode', 'full_transcode'])
            .optional()
            .describe(
                'Upgrade delivery to HLS audio transcoding; direct never downgrades a required conversion.',
            ),
    })
    .meta({ id: 'OpenAudiobookSessionRequest', description: 'Open an audiobook playback session' });

export type OpenAudiobookSessionRequest = z.infer<typeof OpenAudiobookSessionRequestSchema>;

/** Heartbeat carries liveness only; position remains server-authoritative. */
export const AudiobookHeartbeatRequestSchema = z
    .object({
        mediaId: z.string().min(1).describe('Lumastra media_items.id'),
        status: z.enum(['ACTIVE', 'PAUSED']).describe('Whether audio is currently playing'),
    })
    .meta({ id: 'AudiobookHeartbeatRequest', description: 'Refresh audiobook session liveness' });

export type AudiobookHeartbeatRequest = z.infer<typeof AudiobookHeartbeatRequestSchema>;

export const AudiobookSessionBookSchema = z
    .object({
        title: z.string().describe('Book title'),
        author: z.string().optional().describe('Author, joined'),
        narrator: z.string().optional().describe('Narrator, joined'),
        images: ImageSetSchema.describe('Audiobook cover artwork'),
    })
    .meta({ id: 'AudiobookSessionBook', description: 'Display metadata for the open book' });

/**
 * What the server returns when it opens an AudiobookShelf playback session.
 *
 * ## The ordering constraint this payload carries
 *
 * By the time this resolves, the `play_sessions` row (source
 * `'audiobookshelf'`, the internal ABS id in `source_session_id`, status
 * `ACTIVE`) is COMMITTED. The byte proxy re-checks that row on every HLS
 * segment, because ABS serves `/hls/:sid/*` with no authentication of its own
 * and the stream token pins the media id, not the session. Resolving before the
 * write does not fail open — it fails as a hard 404 on every segment — but it
 * does fail.
 */
export const AudiobookPlaybackTrackSchema = z.object({
    index: z.number().int(),
    startMs: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative().nullable(),
    url: z.string(),
    remuxUrl: z.string().optional(),
    mimeType: z.string().nullable().optional(),
    codec: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    needsRemux: z.boolean().optional(),
});
export type AudiobookPlaybackTrack = z.infer<typeof AudiobookPlaybackTrackSchema>;
export const AudiobookPlaybackChapterSchema = z.object({
    id: z.number().int().optional(),
    title: z.string().nullable().optional(),
    startMs: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    synthetic: z.boolean().optional(),
});
export type AudiobookPlaybackChapter = z.infer<typeof AudiobookPlaybackChapterSchema>;

export const AudiobookSessionPayloadSchema = z
    .object({
        playbackSessionId: z.string().describe('Lumastra play_sessions row id'),
        mediaId: z.string().describe('Lumastra media_items.id'),
        playMethod: AudiobookPlayMethodSchema,
        streamToken: z.string().describe('The DB-backed stream_… credential the byte proxy checks'),
        tracks: z
            .array(AudiobookPlaybackTrackSchema)
            .describe('Audio files with server-built URLs, milliseconds'),
        chapters: z
            .array(AudiobookPlaybackChapterSchema)
            .describe(
                'Chapters, milliseconds, server-normalised to contiguous spans covering the ' +
                    'whole book. MAY be empty — 22 of 666 books measured are',
            ),
        startPositionMs: z.number().int().describe('Where to resume, ms of BOOK time'),
        /**
         * The book's total length, ms.
         *
         * Consulted only when the final track has no probed duration and has no
         * successor to measure against.
         */
        durationMs: z.number().int().optional().describe('Total book length, ms'),
        book: AudiobookSessionBookSchema,
    })
    .meta({ id: 'AudiobookSessionPayload', description: 'An open audiobook playback session' });

export type AudiobookSessionPayload = z.infer<typeof AudiobookSessionPayloadSchema>;

// ---------------------------------------------------------------------------
// Progress + close
// ---------------------------------------------------------------------------

export const AudiobookProgressReportSchema = z
    .object({
        mediaId: z.string().min(1).describe('Lumastra media_items.id'),
        bookPositionMs: z.number().int().min(0).describe('Position in BOOK time, ms'),
        /**
         * Audio actually heard since the last report, ms.
         *
         * NEVER a position delta: a scrub forward would otherwise inflate ABS's
         * listening statistics by the size of the jump.
         */
        listenedMs: z.number().int().min(0).describe('Audio actually heard since the last report'),
        isFinished: z.boolean().optional().describe('Mark the book finished upstream'),
    })
    .meta({ id: 'AudiobookProgressReport', description: 'An audiobook position report' });

export type AudiobookProgressReport = z.infer<typeof AudiobookProgressReportSchema>;

export const AudiobookProgressAckSchema = z
    .object({
        /**
         * False when the ABS session had already gone (its sessions are
         * in-memory and die on an ABS restart or the other-device rule).
         *
         * The client keeps playing regardless — never interrupt playback for a
         * bookkeeping failure — but a false here tells it to reopen a session
         * at the current position rather than keep syncing into a void.
         */
        synced: z.boolean().describe('Whether the upstream session accepted the report'),
        sessionLost: z
            .boolean()
            .optional()
            .describe('The upstream session no longer exists; reopen one to keep syncing'),
        /**
         * The listener started this book somewhere else and this session was
         * terminated for it.
         *
         * Distinct from `sessionLost`, and the distinction is the whole point:
         * a lost session means "reopen one and keep playing", while a superseded
         * one means "there is nothing here to keep playing" — reopening would
         * re-claim a stream slot for a deck nobody is at and re-anchor a
         * position the other device has already moved past. Clients close the
         * player instead.
         */
        superseded: z
            .boolean()
            .optional()
            .describe('This session was terminated because the book was started on another device'),
    })
    .meta({ id: 'AudiobookProgressAck', description: 'Acknowledgement of a position report' });

export type AudiobookProgressAck = z.infer<typeof AudiobookProgressAckSchema>;
