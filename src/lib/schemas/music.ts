// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music Feature Zod Schemas
 *
 * SINGLE SOURCE OF TRUTH for all music-related types.
 * These schemas define the contract for the music feature.
 *
 * Usage:
 * - Server: Validate music data structures
 * - Client: Runtime type validation
 * - OpenAPI: Auto-generate documentation
 * - TypeScript: Infer types for type safety
 *
 * Convention:
 * - Use .optional() for optional fields (NOT .nullable())
 * - Use .nullable() only when null genuinely occurs (lyrics fields)
 * - Add .meta({ id: '...' }) on all schemas
 * - Export both schema and inferred type
 */

import { z } from 'zod';
import { LyricsSchema, SyncedLyricLineSchema, MUSIC_MS_MAX } from './music-metadata';
export * from './music-metadata';
import { TrackSchema as MusicTrackSchema } from './api-music-dto';
export {
    TrackSchema as MusicTrackSchema,
    AlbumSchema as MusicAlbumSchema,
    ArtistSchema as MusicArtistSchema,
} from './api-music-dto';
export type {
    Track as MusicTrack,
    Album as MusicAlbum,
    Artist as MusicArtist,
} from './api-music-dto';

export const QueueItemSchema = z
    .object({
        track: MusicTrackSchema,
        source: z.enum(['smart', 'user']),
        id: z.string(),
        sessionId: z.string().optional(),
    })
    .meta({ id: 'QueueItem' });

export type QueueItem = z.infer<typeof QueueItemSchema>;

// ============================================================================
// Internet Radio
// ============================================================================

/**
 * An internet radio station entry.
 *
 * The upstream stream URL is intentionally omitted — all clients play via
 * the `/api/music/radio/{id}/stream` proxy so nothing connects direct to
 * the Icecast/Shoutcast origin. Admins see the raw URL through the admin
 * API, not here.
 */
export const InternetRadioStationSchema = z
    .object({
        /** Station identifier */
        id: z.string(),
        /** Display name */
        name: z.string(),
        /** Primary genre */
        genre: z.string().optional(),
        /** Station logo image URL */
        logoUrl: z.string().optional(),
        /** Currently playing track/program title */
        nowPlaying: z.string().optional(),
    })
    .meta({ id: 'InternetRadioStation' });

export type InternetRadioStation = z.infer<typeof InternetRadioStationSchema>;

// ============================================================================
// Lyrics Response
// ============================================================================

/**
 * Combined lyrics response: raw data plus parsed synced lines.
 */
export const LyricsResponseSchema = z
    .object({
        /** Raw lyrics data; null when the track exists but has no lyrics */
        lyrics: LyricsSchema.nullable(),
        /** Parsed synced lyric lines (present when synced lyrics are available) */
        syncedLines: z.array(SyncedLyricLineSchema).optional(),
    })
    .meta({ id: 'LyricsResponse' });

export type LyricsResponse = z.infer<typeof LyricsResponseSchema>;

// ============================================================================
// Request Schemas
// ============================================================================

/**
 * Request body for uploading/replacing lyrics on a track.
 */
export const LyricsUploadRequestSchema = z
    .object({
        /** Plain unsynced lyrics text */
        plain: z.string().optional(),
        /** LRC-format synced lyrics */
        synced: z.string().optional(),
        /** Lyrics format variant */
        format: z.enum(['lrc', 'enhanced-lrc', 'lrc-plus']).optional(),
        /** Source identifier for provenance tracking */
        source: z.enum(['embedded', 'lrclib', 'user']).optional(),
    })
    .meta({ id: 'LyricsUploadRequest' });

export type LyricsUploadRequest = z.infer<typeof LyricsUploadRequestSchema>;

/**
 * Report a skipped track to influence the smart queue algorithm.
 */
export const QueueSkipRequestSchema = z
    .object({
        /** UUID of the skipped track */
        trackId: z.string(),
        /** Optional reason for skip (e.g. "too fast", "wrong mood") */
        reason: z.string().optional(),
    })
    .meta({ id: 'QueueSkipRequest' });

export type QueueSkipRequest = z.infer<typeof QueueSkipRequestSchema>;

/**
 * Report a liked track to provide positive steering to the smart queue.
 */
export const QueueLikeRequestSchema = z
    .object({
        /** UUID of the liked track */
        trackId: z.string(),
    })
    .meta({ id: 'QueueLikeRequest' });

export type QueueLikeRequest = z.infer<typeof QueueLikeRequestSchema>;

/**
 * Report a disliked track to penalize it in the smart queue.
 */
export const QueueDislikeRequestSchema = z
    .object({
        /** UUID of the disliked track */
        trackId: z.string(),
    })
    .meta({ id: 'QueueDislikeRequest' });

export type QueueDislikeRequest = z.infer<typeof QueueDislikeRequestSchema>;

/**
 * Report a completed track listen (played through without skipping).
 */
export const QueueCompleteRequestSchema = z
    .object({
        /** UUID of the completed track */
        trackId: z.string(),
    })
    .meta({ id: 'QueueCompleteRequest' });

export type QueueCompleteRequest = z.infer<typeof QueueCompleteRequestSchema>;

/**
 * Report playback progress for a music track.
 */
export const MusicProgressRequestSchema = z
    .object({
        /** UUID of the track being played */
        trackId: z.string(),
        /** Current playback position in milliseconds */
        positionMs: z.number().int().min(0),
        /** Total track duration in milliseconds */
        durationMs: z.number().int().min(0).max(MUSIC_MS_MAX).optional(),
    })
    .meta({ id: 'MusicProgressRequest' });

export type MusicProgressRequest = z.infer<typeof MusicProgressRequestSchema>;

export const MusicPlayStartRequestSchema = z
    .object({
        trackId: z.string(),
        playContext: z.enum(['album', 'playlist', 'radio', 'search', 'queue', 'artist']).optional(),
    })
    .meta({ id: 'MusicPlayStartRequest' });

export const MusicPlayEndRequestSchema = z
    .object({
        trackId: z.string(),
        listenedMs: z.number().int().min(0).max(MUSIC_MS_MAX),
        startedAt: z.string().datetime(), // ISO 8601 — captured at play-start, not approximated
        durationMs: z.number().int().min(0).max(MUSIC_MS_MAX).optional(),
        wasSkipped: z.boolean(),
        playContext: z.enum(['album', 'playlist', 'radio', 'search', 'queue', 'artist']).optional(),
        startReported: z
            .boolean()
            .optional()
            .describe(
                'Whether POST /music/progress/start was accepted for THIS play. `start` is what ' +
                    'increments play_count, so when it never landed — offline, or a failed ' +
                    'request — this end report is the only record the play happened, and the ' +
                    'server counts it here instead. Omit if your client cannot tell; the server ' +
                    'then assumes the start landed, which under-counts rather than inflating.',
            ),
        /**
         * Client-generated idempotency key. OPTIONAL for backwards
         * compatibility — every already-shipped client omits it and keeps the
         * historical at-least-once behaviour.
         *
         * When supplied, the play-end is recorded exactly once per
         * (user, eventId): a resend of the same id is acknowledged as a
         * success WITHOUT double-counting the play, so a client that cannot
         * distinguish a lost request from a lost response can safely retry.
         * Mint it once when the play ends and reuse that same value for every
         * retry of that play — minting a fresh id per attempt defeats the
         * entire mechanism.
         */
        eventId: z.string().uuid().optional(),
    })
    .meta({ id: 'MusicPlayEndRequest' });
