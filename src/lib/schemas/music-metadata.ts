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

// ============================================================================
// Audio Features (Essentia Analysis)
// ============================================================================

/**
 * Audio analysis data computed by Essentia at scan time.
 * Stored in custom_metadata JSONB on the media_items row.
 */
/**
 * Upper bound for any millisecond field that lands in an `integer` column.
 *
 * `music_listen_events.duration_ms` and `track_duration_ms` are int4. A value
 * past this passes a bare `.int().min(0)` and then throws Postgres 22003 at
 * INSERT time — which is not classified as permanent, so the client resubmits
 * the same doomed event forever. Rejecting it at the edge makes it an
 * `invalid`, which is terminal and correct.
 */
export const MUSIC_MS_MAX = 2_147_483_647;

export const AudioFeaturesSchema = z
    .object({
        /** BPM detected by RhythmExtractor2013 */
        bpm: z.number().optional(),
        /** Musical key and scale (e.g. "Cm", "D#m") */
        key: z.string().optional(),
        /** Energy level from 0 (silence) to 1 (maximum) */
        energy: z.number().min(0).max(1).optional(),
        /** Danceability score (Essentia scale, typically 0–2+) */
        danceability: z.number().min(0).optional(),
        /** Integrated loudness in LUFS (EBU R128) */
        loudness_lufs: z.number().optional(),
        /** Beat timestamps in seconds (from BeatTrackerDegara) */
        beat_grid: z.array(z.number()).optional(),
        /** Downbeat timestamps in seconds */
        downbeats: z.array(z.number()).optional(),
        /** End of intro section in milliseconds */
        intro_end_ms: z.number().int().optional(),
        /** Start of outro section in milliseconds */
        outro_start_ms: z.number().int().optional(),
        /** Windowed energy curve (values 0–1 per window) */
        energy_curve: z.array(z.number()).optional(),
        /** Mood tags from Essentia mood classifiers */
        mood_tags: z.array(z.string()).optional(),
        /** Whether the track is vocal or instrumental (from Essentia highlevel) */
        vocal_instrumental: z.enum(['voice', 'instrumental']).optional(),
        /** Confidence of the voice/instrumental classification (0-1) */
        vocal_confidence: z.number().min(0).max(1).optional(),
        /** How outro_start_ms was computed. 'dj-outro' = fade point pulled
         *  forward to just after the last vocal on extended/DJ-format tracks. */
        outro_source: z.enum(['downbeat', 'percentage', 'fade', 'dj-outro']).optional(),
        /** End of DJ intro zone in milliseconds (extended mixes only).
         *  When present, crossfade should start the incoming track here
         *  instead of intro_end_ms to skip the percussive DJ intro. */
        dj_intro_end_ms: z.number().int().optional(),
        /** Start of the first detected vocal phrase in milliseconds.
         *  Absent for instrumental tracks or when the analysis engine
         *  provided no vocal-band signal. */
        first_vocal_start_ms: z.number().int().min(0).optional(),
        /** End of the last detected vocal phrase in milliseconds. The
         *  crossfade trigger delays gradual fades past this point so the
         *  outgoing track never fades out mid-phrase. */
        last_vocal_end_ms: z.number().int().min(0).optional(),
    })
    .meta({ id: 'AudioFeatures' });

export type AudioFeatures = z.infer<typeof AudioFeaturesSchema>;

// ============================================================================
// Lyrics
// ============================================================================

/**
 * Lyrics data stored in custom_metadata JSONB.
 * plain and synced are nullable because they may be explicitly absent.
 */
export const LyricsSchema = z
    .object({
        /** Full unsynced lyrics text */
        plain: z.string().nullable(),
        /** LRC-format synced lyrics with timestamps */
        synced: z.string().nullable(),
        /** Lyrics format variant */
        format: z.enum(['lrc', 'enhanced-lrc', 'lrc-plus', 'plain']).optional(),
        /** Where the lyrics were sourced from */
        source: z.enum(['embedded', 'lrclib', 'user', 'file']).nullable(),
        /** ISO 8601 timestamp when lyrics were fetched (null/omitted for embedded/file sources) */
        fetchedAt: z.string().nullable().optional(),
        // NOTE: file-sourced lyrics also persist server-internal `sidecarPath`
        // (absolute FS path) + `sidecarMtimeMs` in custom_metadata for scan-time
        // edit detection. They are deliberately NOT in this schema: it backs the
        // client-facing lyrics response contract and must never expose a server
        // filesystem path. Read them server-side via StoredLyricsState instead.
    })
    .meta({ id: 'Lyrics' });

export type Lyrics = z.infer<typeof LyricsSchema>;

// ============================================================================
// Synced Lyric Line (parsed, for API responses)
// ============================================================================

/**
 * A single parsed line from synced (LRC) lyrics.
 * Used in API responses after server-side LRC parsing.
 */
export const SyncedLyricLineSchema = z
    .object({
        /** Start time in milliseconds */
        startMs: z.number().int(),
        /** End time in milliseconds (if available) */
        endMs: z.number().int().optional(),
        /** Lyric line text */
        text: z.string(),
    })
    .meta({ id: 'SyncedLyricLine' });

export type SyncedLyricLine = z.infer<typeof SyncedLyricLineSchema>;

// ============================================================================
// Popularity
// ============================================================================

/**
 * Attribution for popularity data. Surfaced so the UI can render a tooltip
 * linking back to the provider (required by most providers' ToS).
 */
export const PopularityAttributionSchema = z
    .object({
        /** Provider identifier, e.g. 'lastfm'. */
        source: z.string(),
        /** Short human-readable attribution (e.g. "Data from Last.fm"). */
        text: z.string(),
        /** URL the tooltip/link should open. */
        url: z.string().url(),
    })
    .meta({ id: 'PopularityAttribution' });

export type PopularityAttribution = z.infer<typeof PopularityAttributionSchema>;

/**
 * Compact popularity summary attached to artist/album/track API responses.
 * Absent when no popularity data has been fetched yet (cold start) — callers
 * should treat absence as "unknown" rather than "unpopular".
 */
export const PopularitySummarySchema = z
    .object({
        /** Provider's reported listener count (null when provider omits). */
        listeners: z.number().int().nullable(),
        /** Provider's reported playcount (null when provider omits). */
        playcount: z.number().int().nullable(),
        /**
         * 1-based rank within the artist's top tracks. Only present on tracks
         * that appeared in the provider's top list for their artist.
         */
        rankInArtist: z.number().int().nullable().optional(),
        /** 0–1 normalized score. Meaning depends on score_context. */
        score: z.number().min(0).max(1),
        /** Which ranking context the score was normalised in. */
        scoreContext: z.enum(['artist_global', 'track_in_artist', 'album_global']),
        attribution: PopularityAttributionSchema,
    })
    .meta({ id: 'PopularitySummary' });

export type PopularitySummary = z.infer<typeof PopularitySummarySchema>;

// ============================================================================
// Music Chapters (mix/compilation tracklist within a single audio file)
// ============================================================================

/**
 * A chapter/tracklist entry inside a music item — e.g. a section in a mix or
 * a track within a DJ set. Stored in custom_metadata.chapters JSONB and edited
 * from the admin ChaptersTab. Times are in milliseconds from the track start.
 */
export const MusicChapterSchema = z
    .object({
        /** Chapter title */
        title: z.string(),
        /** Performing artist for this chapter (e.g. in a compilation) */
        artist: z.string().optional(),
        /** Start position in milliseconds */
        start_ms: z.number().int().min(0),
        /** End position in milliseconds (optional — derived from next start / runtime) */
        end_ms: z.number().int().min(0).optional(),
    })
    .meta({ id: 'MusicChapter' });

export type MusicChapter = z.infer<typeof MusicChapterSchema>;
