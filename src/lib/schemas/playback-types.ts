// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Playback Zod Schemas
 *
 * SINGLE SOURCE OF TRUTH for all playback-related types.
 * These schemas define the contract for video playback data.
 *
 * Usage:
 * - Server: Validate playback info responses
 * - Client: Runtime type validation
 * - OpenAPI: Auto-generate documentation
 * - TypeScript: Infer types for type safety
 *
 * Convention:
 * - Use .optional() for optional fields (NOT .nullable())
 * - Add .meta({ description: '...' }) for OpenAPI docs
 * - Export both schema and inferred type
 */

import { ImageDescriptorSchema } from './api-image-descriptor';
import { z } from 'zod';
import { coerceLegacyTvToSeries } from './common';
import { playlistContextSchema } from './playlists';

// ============================================================================
// Chapter Info
// ============================================================================

/**
 * Chapter information for video content
 */
export const ChapterInfoSchema = z
    .object({
        /** Chapter start time in ticks (1 tick = 100 nanoseconds) */
        startPositionTicks: z.number().describe('Chapter start time in ticks'),
        /** Chapter name/title */
        name: z.string().describe('Chapter name/title'),
        /** Chapter image tag for fetching thumbnail */
        imageTag: z.string().optional().describe('Chapter image tag'),
        /** Chapter index (0-based) */
        index: z.number().int().describe('Chapter index (0-based)'),
    })
    .meta({
        id: 'ChapterInfo',
        description: 'Chapter information for video content',
    });

export type ChapterInfo = z.infer<typeof ChapterInfoSchema>;

/** Chapters on the playback's absolute millisecond clock; book time for audiobooks. */
export const TimelineChapterSchema = z
    .object({
        index: z.number().int(),
        name: z.string(),
        startMs: z.number().int(),
        endMs: z.number().int(),
        image: ImageDescriptorSchema.nullable().optional(),
    })
    .meta({ id: 'TimelineChapter' });
export type TimelineChapter = z.infer<typeof TimelineChapterSchema>;

export const TimelineSegmentSchema = z
    .object({
        type: z.enum(['intro', 'outro', 'recap', 'preview', 'commercial']),
        startMs: z.number().int(),
        endMs: z.number().int(),
    })
    .meta({ id: 'TimelineSegment' });
export type TimelineSegment = z.infer<typeof TimelineSegmentSchema>;

// ============================================================================
// Media Segments
// ============================================================================

/**
 * Media segment types for intro/credits skip functionality
 */
export const MediaSegmentTypeSchema = z
    .enum(['Intro', 'Outro', 'Preview', 'Recap', 'Commercial'])
    .describe('Media segment type')
    .meta({ id: 'MediaSegmentType' });

export type MediaSegmentType = z.infer<typeof MediaSegmentTypeSchema>;

/**
 * Media segment for skip functionality (intro, outro, recap, etc.)
 */
export const MediaSegmentSchema = z
    .object({
        /** Segment type */
        type: MediaSegmentTypeSchema,
        /** Start time in seconds */
        startTime: z.number().describe('Start time in seconds'),
        /** End time in seconds */
        endTime: z.number().describe('End time in seconds'),
    })
    .meta({
        id: 'MediaSegment',
        description: 'Media segment for skip functionality',
    });

export type MediaSegment = z.infer<typeof MediaSegmentSchema>;

export const MediaSegmentRowSchema = z.object({
    id: z.string().guid(),
    media_id: z.string().guid(),
    file_id: z.string().nullable().optional(),
    type: MediaSegmentTypeSchema,
    start_time: z.number(),
    end_time: z.number(),
    source: z.string(),
    fetched_at: z.date(),
});
export type MediaSegmentRow = z.infer<typeof MediaSegmentRowSchema>;

/**
 * The slice of a physical file that one episode occupies.
 *
 * A combined file backs several episode rows (`S02E24E25.mkv` → episodes 24 and
 * 25). Playback must be bounded to the episode's own window, otherwise picking
 * episode 25 replays episode 24 from the top.
 *
 * Bounds are file-absolute milliseconds. Positions reported by the player are
 * segment-relative, so every runtime/progress/completion calculation keeps
 * working unchanged — and for an ordinary single-episode file (no segment) the
 * offset is zero, making this a no-op.
 */
export const EpisodeSegmentSchema = z
    .object({
        /** Inclusive start of the window, in ms from the start of the file. */
        startMs: z.number().describe('Window start in ms from the start of the file'),
        /** Exclusive end of the window, in ms from the start of the file. */
        endMs: z.number().describe('Window end in ms from the start of the file'),
    })
    .meta({
        id: 'EpisodeSegment',
        description: 'Playback window of one episode inside a combined multi-episode file',
    });

export type EpisodeSegment = z.infer<typeof EpisodeSegmentSchema>;

// ============================================================================
// Next Episode / Playlist Info
// ============================================================================

/**
 * Information about the next episode to play (for TV shows)
 */
export const NextEpisodeInfoSchema = z
    .object({
        /** Next episode item ID */
        itemId: z.string().describe('Next episode item ID'),
        /** Internal UUID from media_items.id — preferred for image URLs */
        internalId: z
            .string()
            .optional()
            .describe('Internal UUID for provider-agnostic image loading'),
        /** Episode title */
        title: z.string().describe('Episode title'),
        /** Episode number */
        episodeNumber: z.number().optional().describe('Episode number'),
        /** Season number */
        seasonNumber: z.number().optional().describe('Season number'),
        /** Whether this is a new season */
        isNewSeason: z.boolean().describe('Is this a new season'),
        /** Series name */
        seriesName: z.string().optional().describe('Series name'),
        /** Whether the episode has a primary image */
        hasPrimaryImage: z.boolean().describe('Has primary image'),
        /** Episode overview/description */
        overview: z.string().optional().describe('Episode overview'),
    })
    .meta({
        id: 'NextEpisodeInfo',
        description: 'Next episode information for TV shows',
    });

export type NextEpisodeInfo = z.infer<typeof NextEpisodeInfoSchema>;

/**
 * Information about the next item in a playlist
 */
export const NextPlaylistItemInfoSchema = z
    .object({
        /** Internal media item UUID (primary identifier) */
        itemId: z.string().describe('Internal media item UUID'),
        /** Internal UUID (same as itemId, kept for backward compatibility) */
        internalId: z.string().optional().describe('Internal UUID'),
        /** Playlist ID */
        playlistId: z.number().describe('Playlist ID'),
        /** Position in playlist (0-indexed) */
        position: z.number().describe('Position in playlist (0-indexed)'),
        /** Item title */
        title: z.string().describe('Item title'),
        /** Series name (for episodes) */
        seriesName: z.string().optional().describe('Series name for episodes'),
        /** Season number (for episodes) */
        seasonNumber: z.number().optional().describe('Season number for episodes'),
        /** Episode number (for episodes) */
        episodeNumber: z.number().optional().describe('Episode number for episodes'),
        /** Media type */
        mediaType: z
            .preprocess(coerceLegacyTvToSeries, z.enum(['movie', 'series', 'episode']))
            .describe('Media type'),
        /** Whether the item has a primary image for thumbnail */
        hasPrimaryImage: z.boolean().describe('Has primary image for thumbnail'),
    })
    .meta({
        id: 'NextPlaylistItemInfo',
        description: 'Next playlist item information',
    });

export type NextPlaylistItemInfo = z.infer<typeof NextPlaylistItemInfoSchema>;

/**
 * Context information when playing from a playlist
 * Re-exported from playlists.ts (single source of truth)
 */
export { playlistContextSchema, playlistContextSchema as PlaylistContextSchema } from './playlists';
export type { PlaylistContext } from './playlists';

// ============================================================================
// Trickplay (Video Thumbnails)
// ============================================================================

/**
 * Trickplay information for video scrubbing thumbnails
 */
export const TrickplayInfoSchema = z
    .object({
        /** Width of each trickplay tile in pixels */
        width: z.number().describe('Width of each tile in pixels'),
        /** Height of each trickplay tile in pixels */
        height: z.number().describe('Height of each tile in pixels'),
        /** Number of tiles per row in the sprite sheet */
        tileWidth: z.number().describe('Number of tiles per row'),
        /** Number of tiles per column in the sprite sheet */
        tileHeight: z.number().describe('Number of tiles per column'),
        /** Total number of thumbnails */
        thumbnailCount: z.number().describe('Total number of thumbnails'),
        /** Interval between thumbnails in milliseconds */
        interval: z.number().describe('Interval between thumbnails in milliseconds'),
        /** Bandwidth/quality level */
        bandwidth: z.number().describe('Bandwidth/quality level'),
    })
    .meta({
        id: 'TrickplayInfo',
        description: 'Trickplay information for video scrubbing thumbnails',
    });

export type TrickplayInfo = z.infer<typeof TrickplayInfoSchema>;

// ============================================================================
// LiveTV Program Info
// ============================================================================

/**
 * Live TV program information
 */
export const LiveTvProgramInfoSchema = z
    .object({
        /** Program name */
        name: z.string().describe('Program name'),
        /** Program overview/description */
        overview: z.string().optional().describe('Program overview/description'),
        /** Program start time (ISO date string) */
        startTime: z.string().describe('Program start time (ISO date)'),
        /** Program end time (ISO date string) */
        endTime: z.string().describe('Program end time (ISO date)'),
        /** Progress percentage (0-100) for current program */
        progressPercent: z.number().optional().describe('Progress percentage (0-100)'),
        /** Program genres */
        genres: z.array(z.string()).optional().describe('Program genres'),
        /** Content rating */
        rating: z.string().optional().describe('Content rating'),
    })
    .meta({
        id: 'LiveTvProgramInfo',
        description: 'Live TV program information',
    });

export type LiveTvProgramInfo = z.infer<typeof LiveTvProgramInfoSchema>;

// ============================================================================
// Stream Info (Video/Audio/Subtitle)
// ============================================================================

/**
 * Video stream information
 */
export const VideoStreamInfoSchema = z
    .object({
        /** Stream index */
        index: z.number().int().describe('Stream index'),
        /** Video codec (e.g., h264, hevc) */
        codec: z.string().describe('Video codec'),
        /** Codec tag */
        codecTag: z.string().optional().describe('Codec tag'),
        /** Codec profile (e.g., Main, High) */
        profile: z.string().optional().describe('Codec profile'),
        /** Codec level */
        level: z.number().optional().describe('Codec level'),
        /** Video width in pixels */
        width: z.number().describe('Video width in pixels'),
        /** Video height in pixels */
        height: z.number().describe('Video height in pixels'),
        /** Bitrate in bits per second */
        bitrate: z.number().optional().describe('Bitrate in bits per second'),
        /** Bit depth (e.g., 8, 10) */
        bitDepth: z.number().optional().describe('Bit depth'),
        /** Video range (SDR, HDR, HDR10, etc.) */
        videoRange: z.string().describe('Video range (SDR, HDR, HDR10, etc.)'),
        /** Video range type */
        videoRangeType: z.string().optional().describe('Video range type'),
        /** Color space */
        colorSpace: z.string().optional().describe('Color space'),
        /** Aspect ratio (e.g., 16:9, 2.39:1) */
        aspectRatio: z.string().optional().describe('Aspect ratio'),
        /** Average frame rate */
        averageFrameRate: z.number().optional().describe('Average frame rate'),
        /** Whether this is the default video stream */
        isDefault: z.boolean().describe('Is default video stream'),
        /** Whether the video is anamorphic */
        isAnamorphic: z.boolean().optional().describe('Is anamorphic'),
    })
    .meta({ id: 'VideoStreamInfo', description: 'Video stream information' });

export type VideoStreamInfo = z.infer<typeof VideoStreamInfoSchema>;

/**
 * Audio stream information
 */
export const AudioStreamInfoSchema = z
    .object({
        /** Stream index (0-based audio-relative; display / -map 0:a:N) */
        index: z.number().int().describe('Stream index'),
        /** Absolute ffmpeg stream index (counts video+audio+subtitle). Canonical value for selecting/reporting this track on the wire. */
        absoluteIndex: z
            .number()
            .optional()
            .describe(
                'Absolute ffmpeg stream index — the value to send when selecting this audio track',
            ),
        /** Audio codec (e.g., aac, ac3, dts) */
        codec: z.string().describe('Audio codec'),
        /** Codec tag */
        codecTag: z.string().optional().describe('Codec tag'),
        /** Language name (e.g., English, Japanese) */
        language: z.string().optional().describe('Language name'),
        /** ISO 639-2 language code (e.g., eng, jpn) */
        languageCode: z.string().optional().describe('ISO 639-2 language code'),
        /** Display title shown in player UI */
        displayTitle: z.string().describe('Display title for player UI'),
        /** Stream title from metadata */
        title: z.string().optional().describe('Stream title from metadata'),
        /** Number of audio channels */
        channels: z.number().describe('Number of audio channels'),
        /** Channel layout (e.g., 5.1, stereo) */
        channelLayout: z.string().optional().describe('Channel layout'),
        /** Bitrate in bits per second */
        bitrate: z.number().optional().describe('Bitrate in bits per second'),
        /** Sample rate in Hz */
        sampleRate: z.number().optional().describe('Sample rate in Hz'),
        /** Whether this is the default audio stream */
        isDefault: z.boolean().describe('Is default audio stream'),
        /** Whether this is a forced audio stream */
        isForced: z.boolean().optional().describe('Is forced audio stream'),
    })
    .meta({ id: 'AudioStreamInfo', description: 'Audio stream information' });

export type AudioStreamInfo = z.infer<typeof AudioStreamInfoSchema>;

/**
 * Subtitle stream information
 */
export const SubtitleStreamInfoSchema = z
    .object({
        /** Stream index */
        index: z.number().int().describe('Stream index'),
        id: z.string().optional().describe('Stable subtitle identity within the media file'),
        /** Subtitle codec (e.g., srt, ass, pgs) */
        codec: z.string().describe('Subtitle codec'),
        /** Language name (e.g., English, Japanese) */
        language: z.string().optional().describe('Language name'),
        /** ISO 639-2 language code (e.g., eng, jpn) */
        languageCode: z.string().optional().describe('ISO 639-2 language code'),
        /** Display title shown in player UI */
        displayTitle: z.string().describe('Display title for player UI'),
        /** Stream title from metadata */
        title: z.string().optional().describe('Stream title from metadata'),
        /** Whether this is the default subtitle stream */
        isDefault: z.boolean().describe('Is default subtitle stream'),
        /** Whether this is a forced subtitle stream */
        isForced: z.boolean().describe('Is forced subtitle stream'),
        /** Whether the subtitle is an external file */
        isExternal: z.boolean().describe('Is external subtitle file'),
        /** Whether the subtitle is text-based (vs image-based) */
        isTextSubtitleStream: z.boolean().describe('Is text-based subtitle'),
        /** Whether the subtitle can be served externally */
        supportsExternalStream: z.boolean().describe('Can be served externally'),
        /** How the subtitle will be delivered */
        deliveryMethod: z
            .enum(['Encode', 'Embed', 'External', 'Hls', 'Drop'])
            .optional()
            .describe('Subtitle delivery method'),
        /** Server-issued subtitle resources for the selected file. */
        hrefs: z
            .object({
                text: z.string().optional(),
                raw: z.string().optional(),
                rendered: z.string().optional(),
            })
            .optional(),
        /** URL for external subtitle delivery */
        deliveryUrl: z.string().optional().describe('URL for external subtitle delivery'),
    })
    .meta({
        id: 'SubtitleStreamInfo',
        description: 'Subtitle stream information',
    });

export type SubtitleStreamInfo = z.infer<typeof SubtitleStreamInfoSchema>;

// ============================================================================
// Media Source Info
// ============================================================================

/**
 * Media source information with stream details
 */
export const MediaSourceInfoSchema = z
    .object({
        /** Media source ID */
        id: z.string().describe('Media source ID'),
        /** Media source name */
        name: z.string().describe('Media source name'),
        /** File path on disk */
        path: z.string().optional().describe('File path on disk'),
        /** Container format (e.g., mkv, mp4) */
        container: z.string().describe('Container format'),
        /** File size in bytes */
        size: z.number().describe('File size in bytes'),
        /** Total bitrate in bits per second */
        bitrate: z.number().describe('Total bitrate in bits per second'),
        /** Whether direct play is supported */
        supportsDirectPlay: z.boolean().describe('Supports direct play'),
        /** Whether direct stream is supported */
        supportsDirectStream: z.boolean().describe('Supports direct stream'),
        /** Whether transcoding is supported */
        supportsTranscoding: z.boolean().describe('Supports transcoding'),
        /** Reasons why transcoding is required (from Jellyfin) */
        transcodeReasons: z.array(z.string()).optional().describe('Transcode reasons'),
        /** For LiveTV: direct transcoding/streaming URL from Jellyfin */
        transcodingUrl: z.string().optional().describe('LiveTV transcoding URL'),
        /** For LiveTV: live stream ID for session management */
        liveStreamId: z.string().optional().describe('LiveTV stream ID'),
        /** Whether this is a live stream (e.g., LiveTV) */
        isLive: z.boolean().optional().describe('Is live stream'),
        /** Available video streams */
        videoStreams: z.array(VideoStreamInfoSchema).describe('Video streams'),
        /** Available audio streams */
        audioStreams: z.array(AudioStreamInfoSchema).describe('Audio streams'),
        /** Available subtitle streams */
        subtitleStreams: z.array(SubtitleStreamInfoSchema).describe('Subtitle streams'),
        /** Index of default audio stream */
        defaultAudioStreamIndex: z.number().optional().describe('Default audio stream index'),
        /** Index of default subtitle stream */
        defaultSubtitleStreamIndex: z.number().optional().describe('Default subtitle stream index'),
    })
    .meta({
        id: 'MediaSourceInfo',
        description: 'Media source information with stream details',
    });

export type MediaSourceInfo = z.infer<typeof MediaSourceInfoSchema>;

// ============================================================================
// Playback Variant (version picker model — Lumastra-native, not Jellyfin-shaped)
// ============================================================================

/**
 * Lightweight representation of a playable file variant for the version picker.
 * Built directly from LumastraVersion — no adapter through MediaSourceInfo needed.
 */
export const PlaybackVariantSchema = z
    .object({
        /** File ID (media_files.id) */
        id: z.string(),
        /** Display label (edition name or filename) */
        label: z.string(),
        /** Video resolution width (pixels) */
        videoWidth: z.number().optional(),
        /** Video resolution height (pixels) */
        videoHeight: z.number().optional(),
        /** Video codec (e.g. hevc, h264, av1) */
        videoCodec: z.string().optional(),
        /** HDR format (sdr, hdr10, hlg, dovi) */
        hdr: z.string().optional(),
        /** Primary audio codec */
        audioCodec: z.string().optional(),
        /** Primary audio channel count */
        audioChannels: z.number().optional(),
        /** File size in bytes (0 if unknown) */
        fileSize: z.number().optional(),
    })
    .meta({
        id: 'PlaybackVariant',
        description: 'Lightweight file variant for version picker',
    });

export type PlaybackVariant = z.infer<typeof PlaybackVariantSchema>;

// ============================================================================
// Playback Info
// ============================================================================

/**
 * Complete playback information for a media item
 */
export const PlaybackInfoSchema = z
    .object({
        /** Media item ID */
        itemId: z.string().describe('Media item ID'),
        /** Internal UUID from media_items.id — preferred for all playback API calls */
        internalId: z.string().optional().describe('Internal UUID (media_items.id)'),
        /** Media title */
        title: z.string().describe('Media title'),
        /** Series name (for episodes) */
        seriesName: z.string().optional().describe('Series name for episodes'),
        /** Series ID (for episodes) */
        seriesId: z.string().optional().describe('Series ID for episodes'),
        /** Season ID (for episodes) */
        seasonId: z.string().optional().describe('Season ID for episodes'),
        /** Season number (for episodes) */
        seasonNumber: z.number().optional().describe('Season number for episodes'),
        /** Episode number (for episodes) */
        episodeNumber: z.number().optional().describe('Episode number for episodes'),
        /**
         * First episode number for combined multi-episode files (e.g. E05-E06).
         * Absent for plain episodes. Must be used instead of `episodeNumber` when
         * rendering the range — entering a combined file on its second half would
         * otherwise render "E21-E21".
         */
        episodeStartNumber: z
            .number()
            .optional()
            .describe('First episode number for multi-episode files'),
        /** Last episode number for combined multi-episode files (e.g. E05-E06) */
        episodeEndNumber: z
            .number()
            .optional()
            .describe('Last episode number for multi-episode files'),
        /**
         * Playback window of this episode inside a combined file (S02E24E25 → one
         * file, two episodes). Absent means the whole file is the episode.
         *
         * Deliberately NOT a `MediaSegment`: those mark regions to SKIP (intro,
         * credits), whereas this marks the only region that is VALID — modelling it
         * as a MediaSegment would make it the active skip target for the entire
         * episode.
         */
        episodeSegment: EpisodeSegmentSchema.optional().describe(
            'Playback window of this episode within a combined multi-episode file',
        ),
        /** Media type */
        mediaType: z
            .preprocess(coerceLegacyTvToSeries, z.enum(['movie', 'episode', 'series', 'tvchannel']))
            .describe('Media type'),
        /**
         * The title's original production language (TMDB `original_language`,
         * ISO 639-1). Resolved up the episode → season → series chain, since
         * only the movie/series row carries it. Drives the "prefer original
         * language" audio preference; absent when no provider knows it, which
         * the player treats as "no opinion".
         */
        originalLanguage: z
            .string()
            .optional()
            .describe('Original production language (ISO 639-1) of the title'),
        /** Runtime in ticks (0 for live streams) */
        runTimeTicks: z.number().describe('Runtime in ticks (0 for live streams)'),
        /** Whether this is a live stream (LiveTV) */
        isLive: z.boolean().optional().describe('Is live stream (LiveTV)'),
        /** For LiveTV: current program name */
        currentProgramName: z.string().optional().describe('LiveTV current program name'),
        /** For LiveTV: current program overview */
        currentProgramOverview: z.string().optional().describe('LiveTV current program overview'),
        /** For LiveTV: channel number */
        channelNumber: z.string().optional().describe('LiveTV channel number'),
        /** User playback data */
        userData: z
            .object({
                /** Current playback position in ticks */
                playbackPositionTicks: z.number().describe('Playback position in ticks'),
                /** Percentage of content played (0-100) */
                playedPercentage: z.number().describe('Played percentage (0-100)'),
                /** Whether the content has been fully played */
                played: z.boolean().describe('Content has been fully played'),
            })
            .describe('User playback data'),
        /**
         * Server-clock epoch ms; same definition as lumastraInfo.resume_anchor.
         * Max of user_media_state.last_event_at and the eligible-live-session
         * last_heartbeat_at. Null when neither source has data. Surfaced
         * synchronously so the player can compare against a localStorage
         * resume cache before lumastra-info is fetched.
         */
        resumeAnchor: z
            .number()
            .nullable()
            .describe('Resume anchor (server-clock epoch ms; null if none)'),
        /** Whether the user has marked this media as watched / completed. */
        isWatched: z
            .boolean()
            .describe('Whether the user has marked this media as watched / completed'),
        /** Available media sources */
        mediaSources: z.array(MediaSourceInfoSchema).describe('Available media sources'),
        /** Play session ID for this playback session */
        playSessionId: z.string().describe('Play session ID'),
        /** Chapter information */
        chapters: z.array(ChapterInfoSchema).optional().describe('Chapter information'),
        /** Trickplay information, keyed by media source ID then quality level */
        trickplay: z
            .record(z.string(), z.record(z.string(), TrickplayInfoSchema))
            .optional()
            .describe('Trickplay information by source and quality'),
        /** Media segments for skip functionality */
        mediaSegments: z.array(MediaSegmentSchema).optional().describe('Media segments for skip'),
        /** Next episode information (for TV shows) */
        nextEpisode: NextEpisodeInfoSchema.optional().describe('Next episode information'),
        /** Next playlist item information */
        nextPlaylistItem: NextPlaylistItemInfoSchema.optional().describe('Next playlist item'),
        /** Playlist context information */
        playlistContext: playlistContextSchema.optional().describe('Playlist context'),
        /** Whether Lumastra HLS streaming is available (any audio track count) */
        supportsMultiAudioHls: z
            .boolean()
            .optional()
            .describe('Lumastra HLS streaming is available'),
        /** For Lumastra HLS: stream start position in ticks */
        streamStartPositionTicks: z
            .number()
            .optional()
            .describe('HLS stream start position in ticks'),
        /** For multi-audio HLS: whether client should seek after loading */
        clientShouldSeek: z.boolean().optional().describe('Client should seek after loading'),
    })
    .meta({
        id: 'PlaybackInfo',
        description: 'Complete playback information for a media item',
    });

export type PlaybackInfo = z.infer<typeof PlaybackInfoSchema>;

// ============================================================================
// Stream Options
// ============================================================================

/**
 * Options for configuring a media stream
 */
export const StreamOptionsSchema = z
    .object({
        /** Selected media source ID */
        mediaSourceId: z.string().describe('Media source ID'),
        /** Selected audio stream index */
        audioStreamIndex: z.number().optional().describe('Audio stream index'),
        /** Selected subtitle stream index */
        subtitleStreamIndex: z.number().optional().describe('Subtitle stream index'),
        /** Maximum streaming bitrate in bits per second */
        maxStreamingBitrate: z.number().optional().describe('Maximum streaming bitrate'),
        /** Start time in ticks */
        startTimeTicks: z.number().optional().describe('Start time in ticks'),
        /** Play session ID */
        playSessionId: z.string().describe('Play session ID'),
        /** Client device ID */
        deviceId: z.string().optional().describe('Client device ID'),
        /** Enable direct play */
        enableDirectPlay: z.boolean().optional().describe('Enable direct play'),
        /** Enable direct stream */
        enableDirectStream: z.boolean().optional().describe('Enable direct stream'),
        /** Enable transcoding */
        enableTranscoding: z.boolean().optional().describe('Enable transcoding'),
    })
    .meta({ id: 'StreamOptions', description: 'Stream configuration options' });

export type StreamOptions = z.infer<typeof StreamOptionsSchema>;

// ============================================================================
// Playback Progress Reporting
// ============================================================================

/**
 * Playback progress report data
 */
export const PlaybackProgressReportSchema = z
    .object({
        /** Jellyfin item ID */
        itemId: z.string().describe('Jellyfin item ID'),
        /** Media source ID */
        mediaSourceId: z.string().describe('Media source ID'),
        /** Current playback position in ticks */
        positionTicks: z.number().describe('Current position in ticks'),
        /** Whether playback is paused */
        isPaused: z.boolean().describe('Is paused'),
        /** Whether audio is muted */
        isMuted: z.boolean().optional().describe('Is muted'),
        /** Volume level (0-100) */
        volumeLevel: z.number().optional().describe('Volume level (0-100)'),
        /** Playback method being used */
        playMethod: z.string().describe('Playback method (DirectPlay, DirectStream, Transcode)'),
        /** Play session ID */
        playSessionId: z.string().describe('Play session ID'),
        /** Selected audio stream index (null = none) */
        audioStreamIndex: z.number().nullish().describe('Audio stream index'),
        /** Selected subtitle stream index (null = none) */
        subtitleStreamIndex: z.number().nullish().describe('Subtitle stream index'),
        /** Maximum streaming bitrate in bits per second */
        maxStreamingBitrate: z.number().optional().describe('Maximum streaming bitrate'),
        /** Playback speed multiplier (1.0 = normal) */
        playbackRate: z.number().optional().describe('Playback speed multiplier'),
        /** Whether seeking is currently possible */
        canSeek: z.boolean().optional().describe('Can seek'),
    })
    .meta({
        id: 'PlaybackProgressReport',
        description: 'Playback progress report data',
    });

export type PlaybackProgressReport = z.infer<typeof PlaybackProgressReportSchema>;

/**
 * Request body for playback progress endpoint
 */
export const ProgressRequestBodySchema = z
    .object({
        /** Media source ID */
        mediaSourceId: z.string().describe('Media source ID'),
        /** Current playback position in ticks */
        positionTicks: z.number().describe('Current position in ticks'),
        /** Whether playback is paused */
        isPaused: z.boolean().describe('Is paused'),
        /** Whether audio is muted */
        isMuted: z.boolean().optional().describe('Is muted'),
        /** Volume level (0-100) */
        volumeLevel: z.number().optional().describe('Volume level (0-100)'),
        /** Playback method being used */
        playMethod: z.string().describe('Playback method (DirectPlay, DirectStream, Transcode)'),
        /** Play session ID */
        playSessionId: z.string().describe('Play session ID'),
        /** Selected audio stream index (null = none) */
        audioStreamIndex: z.number().nullish().describe('Audio stream index'),
        /** Selected subtitle stream index (null = none) */
        subtitleStreamIndex: z.number().nullish().describe('Subtitle stream index'),
        /** Maximum streaming bitrate in bits per second */
        maxStreamingBitrate: z.number().optional().describe('Maximum streaming bitrate'),
        /** Playback speed multiplier (1.0 = normal) */
        playbackRate: z.number().optional().describe('Playback speed multiplier'),
        /** Event type */
        eventType: z.enum(['start', 'progress', 'stop']).describe('Event type'),
        /** Client device ID for Jellyfin token management */
        deviceId: z.string().optional().describe('Client device ID'),
    })
    .meta({
        id: 'ProgressRequestBody',
        description: 'Request body for playback progress endpoint',
    });

export type ProgressRequestBody = z.infer<typeof ProgressRequestBodySchema>;

// ============================================================================
// Playback Events
// ============================================================================

/**
 * Playback event types
 */
export const PlaybackEventTypeSchema = z
    .enum([
        'TimeUpdate',
        'Pause',
        'Unpause',
        'VolumeChange',
        'RepeatModeChange',
        'AudioTrackChange',
        'SubtitleTrackChange',
        'PlaylistItemMove',
        'PlaylistItemRemove',
        'PlaylistItemAdd',
        'QualityChange',
        'Stop',
    ])
    .describe('Playback event type')
    .meta({ id: 'PlaybackEventType' });

export type PlaybackEventType = z.infer<typeof PlaybackEventTypeSchema>;

// ============================================================================
// Quality Profiles
// ============================================================================

/**
 * Quality mode for transcoding
 */
export const QualityModeSchema = z
    .enum(['original', 'auto', 'fixed', 'audio-only'])
    .describe('Quality mode (original, auto, fixed bitrate, or audio-only)')
    .meta({ id: 'QualityMode' });

export type QualityMode = z.infer<typeof QualityModeSchema>;

/**
 * Transcoding quality profile
 */
export const TranscodingProfileSchema = z
    .object({
        /** Maximum bitrate in bits per second (0 = unlimited) */
        maxBitrate: z.number().describe('Maximum bitrate (0 = unlimited)'),
        /** Target width in pixels (0 = source) */
        width: z.number().describe('Target width (0 = source)'),
        /** Target height in pixels (0 = source) */
        height: z.number().describe('Target height (0 = source)'),
        /** Display label (e.g., "1080p", "720p") */
        label: z.string().describe('Display label'),
        /** Quality mode */
        mode: QualityModeSchema.optional().describe('Quality mode'),
    })
    .meta({
        id: 'TranscodingProfile',
        description: 'Transcoding quality profile',
    });

export type TranscodingProfile = z.infer<typeof TranscodingProfileSchema>;
