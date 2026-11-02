import { LiveTvStationSchema } from './livetv.js';
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Playback API Response Zod Schemas
 *
 * SINGLE SOURCE OF TRUTH for playback API response types.
 * These schemas define the contract for /api/playback/*, /api/sessions, /api/livetv/* endpoints.
 *
 * Usage:
 * - Server: Validate responses before sending
 * - Client: Runtime type validation
 * - OpenAPI: Auto-generate documentation
 * - TypeScript: Infer types for type safety
 *
 * Convention:
 * - Use .optional() for optional fields (NOT .nullable())
 * - Add .meta({ description: '...' }) for OpenAPI docs
 * - Export both schema and inferred type
 */

import { keepaliveReportingSchema } from './play-reporting.js';
import { timelineSubtitleDescriptorSchema } from './playback.js';
import { ImageSetSchema } from './api-image-descriptor.js';
import { z } from 'zod';
import { publicAuthorSchema } from './public-author';
import { LiveTvAvailabilitySchema } from './livetv-availability.js';
import {
    TrickplayInfoSchema,
    TimelineChapterSchema,
    TimelineSegmentSchema,
} from './playback-types';
import { ExternalIdsResponseSchema } from './api-responses';
import { TranscodeReasonSchema, SubtitleMethodEnum } from './playback-plan';
import { paginatedEnvelope } from './pagination';
import { SessionAdaptiveSchema } from './session-adaptive.js';

// ============================================================================
// Progress Response (/api/playback/[itemId]/progress)
// ============================================================================

/**
 * Progress report response
 */
export const ProgressResponseSchema = z
    .object({
        /** Success flag */
        success: z.boolean().describe('Success'),
        /** Event type processed */
        eventType: z.string().optional().describe('Event type processed'),
        /** Warning when per-user token fetch failed */
        _warning: z.string().optional().describe('Present when per-user token fetch failed'),
        /** Detailed warning message */
        _warning_detail: z
            .string()
            .optional()
            .describe('Detailed warning message when token fetch failed'),
    })
    .meta({ id: 'ProgressResponse', description: 'Progress report response' });

export type ProgressResponse = z.infer<typeof ProgressResponseSchema>;

// ============================================================================
// LiveTV Channels Response (/api/livetv/channels)
// ============================================================================

/**
 * LiveTV stations response — standard {items, page} collection envelope.
 * Server: defs/livetv/stations/index.ts returns paginate(stations, …).
 */
export const LiveTvStationsResponseSchema = z
    .object({
        /** Channel items */
        items: z.array(LiveTvStationSchema).describe('Stations'),
        availability: LiveTvAvailabilitySchema.optional().describe('Observed availability'),
        /** Pagination metadata */
        page: z
            .object({
                limit: z.number().int(),
                offset: z.number().int().optional(),
                hasMore: z.boolean(),
                total: z.number().int().optional(),
            })
            .describe('Pagination metadata'),
    })
    .meta({
        id: 'LiveTvStationsResponse',
        description: 'LiveTV stations response',
    });

export type LiveTvStationsResponse = z.infer<typeof LiveTvStationsResponseSchema>;

// ============================================================================
// Telemetry Response (/api/playback/telemetry)
// ============================================================================

/**
 * Telemetry flush response.
 * Server returns 204 No Content (empty events) or 204 (processed).
 * The client wraps this in `.nullable()` to accept 204 without a body.
 */
export const TelemetryResponseSchema = z
    .object({
        /** Events processed count — present only when server emits a body */
        eventsProcessed: z.number().optional().describe('Events processed'),
    })
    .meta({ id: 'TelemetryResponse', description: 'Telemetry response' });

export type TelemetryResponse = z.infer<typeof TelemetryResponseSchema>;

// ============================================================================
// Stream Session Schema (SINGLE SOURCE OF TRUTH)
//
// Composable sub-schemas that merge into ActiveSessionSchema.
// StreamSession type in server/types.ts is derived from this schema.
// ============================================================================

/**
 * Media type enum for stream sessions — PUBLIC vocabulary.
 *
 * The values mirror the lowercase storage vocabulary from migration 6.0.0 with
 * ONE deliberate exception: the series discriminator is emitted as `series`,
 * never the internal `tv`, matching every other public surface. Sessions used
 * to be the odd one out — the same show came back as `series` from
 * `/media/{id}` and `tv` from `/sessions`. The projection lives at the response
 * boundary in defs/sessions/index.ts; the internal `StreamSession` type in
 * server/types.ts deliberately keeps `tv` (it mirrors `play_sessions.media_type`).
 */
export const StreamSessionMediaTypeSchema = z
    .enum([
        'movie',
        'series',
        'episode',
        'season',
        'audiobook',
        'audio',
        'tvchannel',
        'book',
        'manga',
        'comic',
        'podcast',
        'music',
        'track',
        'radio',
    ])
    .meta({ id: 'StreamSessionMediaType' });

export type StreamSessionMediaType = z.infer<typeof StreamSessionMediaTypeSchema>;

/**
 * Identity — what is being played and where it comes from.
 */
const SessionIdentitySchema = z.object({
    /** Internal compound ID (session key) */
    __id: z.string().describe('Internal compound ID'),
    /** Internal media item UUID (primary identifier) */
    id: z.string().describe('Internal media item UUID'),
    /** Jellyfin item ID (optional — only present when Jellyfin sync is active) */
    jellyfinId: z.string().optional().describe('Jellyfin item ID (optional)'),
    /** Internal media item UUID (Lumastra identifier) */
    mediaItemId: z.string().describe('Internal media item UUID'),
    /** Media title */
    title: z.string().describe('Title'),
    /** Overview/description */
    overview: z.string().optional().describe('Overview'),
    /** Media type */
    mediaType: StreamSessionMediaTypeSchema.describe('Media type'),
    /** Release year */
    year: z.number().optional().describe('Year'),
    /** Duration in seconds */
    duration: z.number().optional().describe('Duration'),
});

/**
 * Episode/series context — for episodes and audiobook chapters.
 */
const SessionEpisodeSchema = z.object({
    /** Season number */
    seasonNumber: z.number().optional().describe('Season number'),
    /** Episode number */
    episodeNumber: z.number().optional().describe('Episode number'),
    /** Series name (for episodes) */
    seriesName: z.string().optional().describe('Series name'),
    /** Author (audiobooks) */
    author: z.string().optional().describe('Author'),
    /** Chapter (audiobooks) */
    chapter: z.string().optional().describe('Chapter'),
});

/**
 * Image references — IDs used to construct image proxy URLs.
 */
const SessionImageSchema = z.object({
    images: ImageSetSchema.optional().describe('Audiobook cover artwork'),
    /** Image ID for fetching images */
    imageId: z.string().optional().describe('Image ID'),
    /** Series ID for episode images (fallback chain), or album ID for music tracks */
    seriesId: z.string().optional().describe('Series ID'),
    /** Artist ID for music tracks (grandparent in track → album → artist hierarchy) */
    artistId: z.string().optional().describe('Artist ID'),
    /** External provider IDs (TMDB, IMDB, etc.) */
    externalIds: ExternalIdsResponseSchema.optional().describe('External IDs'),
    /**
     * Fully-qualified PUBLIC artwork URL, when one can be derived.
     *
     * Present only when the item has a TMDB poster path (or an already-absolute
     * https artwork URL). Consumers that need an image Discord's servers can
     * fetch must use this rather than building a proxy URL from `imageId` —
     * the image proxy is only reachable if the deployment is public.
     */
    artworkPublicUrl: z.string().optional().describe('Public CDN artwork URL, when derivable'),
});

/**
 * Ratings — community and critic ratings.
 */
const SessionRatingsSchema = z.object({
    /** Community rating (e.g., 7.5) */
    rating: z.number().optional().describe('Rating'),
    /** Critic rating */
    criticRating: z.number().optional().describe('Critic rating'),
    /** Content rating (PG, PG-13, R, etc.) */
    officialRating: z.string().optional().describe('Official rating'),
});

/**
 * Playback state — current codec, method, and position.
 */
const SessionPlaybackSchema = z.object({
    /** Play method (DirectPlay, DirectStream, Transcode) */
    playMethod: z.string().optional().describe('Play method'),
    /** Active video codec */
    playCodec: z.string().optional().describe('Play codec'),
    /** Codec info string */
    playCodecInfo: z.string().optional().describe('Play codec info'),
    /** Raw transcode info object from Jellyfin */
    playTranscodeInfo: z.unknown().optional().describe('Transcode info'),
    /** Active transcode video codec */
    playTranscodeCodec: z.string().optional().describe('Transcode codec'),
    /** Active bitrate */
    playBitrate: z.number().optional().describe('Bitrate'),
    /** Whether currently playing (not paused) */
    playIsPlaying: z.boolean().optional().describe('Is playing'),
    /** Current playback position in seconds */
    playCurrentTime: z.number().optional().describe('Current time'),
    /** Total item duration in seconds */
    playItemDuration: z.number().optional().describe('Item duration'),
    /** Stream progress percentage (0-100) */
    streamProgress: z.number().optional().describe('Stream progress'),
});

/**
 * Transcoding details — original vs transcode quality comparison.
 */
const SessionTranscodingSchema = z.object({
    /** Original video codec */
    playOriginalCodec: z.string().optional().describe('Original codec'),
    /** Original video bitrate */
    playOriginalBitrate: z.number().optional().describe('Original bitrate'),
    /** Transcode video bitrate */
    playTranscodeBitrate: z.number().optional().describe('Transcode bitrate'),
    /** Whether the stream is being transcoded */
    playIsTranscoding: z.boolean().optional().describe('Is transcoding'),
    /** Reasons for transcoding */
    playTranscodeReasons: z.array(z.string()).optional().describe('Transcode reasons'),
    /** Hardware acceleration type (nvenc, qsv, vaapi, amf, videotoolbox) */
    playHardwareAcceleration: z.string().optional().describe('HW acceleration'),
});

/**
 * Video details — resolution and HDR info.
 */
const SessionVideoSchema = z.object({
    /** Output video width (transcode or original) */
    playVideoWidth: z.number().optional().describe('Video width'),
    /** Output video height */
    playVideoHeight: z.number().optional().describe('Video height'),
    /** Original source video width */
    playOriginalVideoWidth: z.number().optional().describe('Original video width'),
    /** Original source video height */
    playOriginalVideoHeight: z.number().optional().describe('Original video height'),
    /** Output video range (HDR, SDR) */
    playVideoRange: z.string().optional().describe('Video range'),
    /** Original video range */
    playOriginalVideoRange: z.string().optional().describe('Original video range'),
});

/**
 * Audio details — codec and bitrate for audio track.
 */
const SessionAudioSchema = z.object({
    /** Original audio codec */
    playOriginalAudioCodec: z.string().optional().describe('Original audio codec'),
    /** Transcode audio codec */
    playTranscodeAudioCodec: z.string().optional().describe('Transcode audio codec'),
    /** Original audio bitrate */
    playOriginalAudioBitrate: z.number().optional().describe('Original audio bitrate'),
    /** Transcode audio bitrate */
    playTranscodeAudioBitrate: z.number().optional().describe('Transcode audio bitrate'),
});

/**
 * Container info — file format before and after transcoding.
 */
const SessionContainerSchema = z.object({
    /** Original file container (mkv, mp4, avi, etc.) */
    playOriginalContainer: z.string().optional().describe('Original container'),
    /** Container after transcoding (ts, mp4, etc.) */
    playTranscodeContainer: z.string().optional().describe('Transcode container'),
});

/**
 * Active subtitle and audio track info.
 */
const SessionTrackSchema = z.object({
    /** Subtitle language code (eng, ger, etc.) */
    playSubtitleLanguage: z.string().optional().describe('Subtitle language'),
    /** Subtitle display title */
    playSubtitleTitle: z.string().optional().describe('Subtitle title'),
    /** Subtitle codec (srt, ass, etc.) */
    playSubtitleCodec: z.string().optional().describe('Subtitle codec'),
    /** How subtitles are delivered (none, external_vtt, burn_in, client_render) */
    playSubtitleMethod: SubtitleMethodEnum.optional().describe('Subtitle delivery method'),
    /** Audio language code */
    playAudioLanguage: z.string().optional().describe('Audio language'),
    /** Audio display title */
    playAudioTitle: z.string().optional().describe('Audio title'),
    /** Audio channel count (2, 6=5.1, 8=7.1) */
    playAudioChannels: z.number().optional().describe('Audio channels'),
    /** Audio sample rate in Hz (44100, 48000, 96000) — marks hi-res music */
    playAudioSampleRate: z.number().optional().describe('Audio sample rate in Hz'),
});

/**
 * User and client info — who is watching and on what device.
 */
const SessionUserSchema = z.object({
    /** Username */
    username: z.string().describe('Username'),
    /**
     * Client application name.
     *
     * Optional because the field is REDACTED, not merely unknown: when the
     * viewer may not see device info (neither `sessionsDeviceInfoPublic`, nor
     * watch permission, nor admin), active-sessions-view.service.ts drops
     * `clientname`/`browsername`/`formFactor` from every row it returns. Every
     * producer sets a non-empty value (media-aggregation falls back to
     * 'Lumastra', audiobookshelf to 'AudiobookShelf'), so an ABSENT value means
     * "you are not permitted to see this" and nothing else — a default like
     * 'Unknown' would state a falsehood about the session.
     *
     * `formFactor` below is dropped by that same destructure and has always
     * been optional; these two were the outliers, and the mismatch surfaced as
     * a live RESPONSE CONFORMANCE error on GET /api/sessions.
     */
    isCarPlay: z
        .boolean()
        .optional()
        .describe(
            'Client reports a connected CarPlay display. Informational; redacted with device info.',
        ),
    clientname: z.string().optional().describe('Client name'),
    clientVersion: z.string().optional().describe('Client version and build (admin only)'),
    userAgent: z.string().optional().describe('Raw User-Agent (admin only)'),
    /** Browser or device name. Redacted alongside `clientname` — see above. */
    browsername: z.string().optional().describe('Browser name'),
    /** Jellyfin PlaySessionId (for client info matching) */
    playSessionId: z.string().optional().describe('Play session ID'),
    /** Jellyfin DeviceId (for fallback matching) */
    deviceId: z.string().optional().describe('Device ID'),
    /** Client app name from /api/v1 clients (tvOS, iOS, Android) */
    clientApp: z.string().optional().describe('Client app'),
    /** Client player name from /api/v1 clients (AVPlayer, MPV, VLC) */
    clientPlayerName: z.string().optional().describe('Client player name'),
    /**
     * UI features the client announced it can render when it started this
     * session (`admin_message`, `maintenance_notice`, …). See
     * `$lib/shared/client-features.ts` for the vocabulary.
     *
     * Absent means "announced nothing", which is also what an empty list
     * means — every client build from before the field existed, and every
     * mirrored session (`/j`, Subsonic, direct Audiobookshelf) that has no
     * client to ask. Treat the two identically: do not offer an action the
     * target may silently swallow.
     *
     * Redacted alongside `clientname` / `browsername` / `formFactor` for a
     * viewer who may not see device info — it describes someone else's client.
     */
    clientFeatures: z
        .array(z.string())
        .optional()
        .describe('UI features the client announced it can render'),
    /** Coarse device class inferred from the client user agent. */
    formFactor: z
        .enum(['desktop', 'mobile', 'tablet', 'tv', 'unknown'])
        .optional()
        .describe('Client device class'),
    /** Cached user ID for avatars */
    userId: z.string().optional().describe('User ID'),
});

/**
 * LiveTV enrichment — program info for live TV sessions.
 */
const SessionLiveTvSchema = z.object({
    /** Current LiveTV program name */
    liveTvProgramName: z.string().optional().describe('LiveTV program name'),
    /** Current LiveTV program description */
    liveTvProgramDescription: z.string().optional().describe('LiveTV program description'),
    /** When current program starts */
    liveTvProgramStartTime: z.string().optional().describe('LiveTV program start time'),
    /** When current program ends */
    liveTvProgramEndTime: z.string().optional().describe('LiveTV program end time'),
    /** Current program progress percentage */
    liveTvProgramProgressPercent: z.number().optional().describe('LiveTV progress'),
    /** Next program name */
    liveTvNextProgramName: z.string().optional().describe('LiveTV next program'),
    /** When next program starts */
    liveTvNextProgramStartTime: z.string().optional().describe('LiveTV next program start'),
    /** Adaptive-bitrate state: the variant playing now and the ladder (Live TV and adaptive VOD). */
    adaptive: SessionAdaptiveSchema.optional().describe(
        'Adaptive-bitrate state: the variant playing now, the ladder and recent switches',
    ),
});

/**
 * Music track metadata — populated when mediaType is 'track' or 'audio'.
 */
const SessionMusicSchema = z.object({
    /** Artist name for music tracks */
    artistName: z.string().optional().describe('Artist name'),
    /** Album name for music tracks */
    albumName: z.string().optional().describe('Album name'),
    /** Album UUID — doubles as seriesId for image routing */
    albumId: z.string().optional().describe('Album ID'),
    /** Next track in the queue — present only when a next track is known. */
    nextTrack: z
        .object({
            mediaId: z.string().describe('Track UUID'),
            title: z.string().describe('Track title'),
            artistName: z.string().optional().describe('Artist name'),
            albumName: z.string().optional().describe('Album name'),
        })
        .optional()
        .describe('Next queued track'),
    /** Crossfade in progress — present only while the client reports one. */
    crossfade: z
        .object({
            role: z
                .enum(['incoming', 'outgoing'])
                .describe("Which side of the fade this session's own track is on"),
            otherTrack: z
                .object({
                    mediaId: z.string().describe('Track UUID'),
                    title: z.string().describe('Track title'),
                    artistName: z.string().optional().describe('Artist name'),
                    albumName: z.string().optional().describe('Album name'),
                })
                .describe('Track on the other side of the fade'),
            remainingMs: z
                .number()
                .int()
                .describe('Fade time left when the server built this response (ms)'),
            durationMs: z.number().int().describe('Total fade length (ms)'),
        })
        .optional()
        .describe('Crossfade in progress'),
});

/**
 * Radio / live-stream metadata — populated when mediaType is 'radio'.
 */
const SessionRadioSchema = z.object({
    /** Current radio program / show name */
    radioProgram: z.string().optional().describe('Radio program name'),
    /** On-air DJ name */
    radioDj: z.string().optional().describe('Radio DJ name'),
    /** Now-playing track title (broadcast ICY/API metadata) */
    nowPlayingTrack: z.string().optional().describe('Now-playing track title'),
    /** Now-playing artist (broadcast ICY/API metadata) */
    nowPlayingArtist: z.string().optional().describe('Now-playing artist'),
});

/**
 * Watch-party tag on a stream row — see watch-party-stream-overlay.ts.
 */
const WatchPartyStreamSchema = z
    .object({
        groupId: z.string().describe('Opaque party key; rows with the same value are one party'),
        code: z
            .string()
            .optional()
            .describe('Join code — only when the viewer may join/open the party'),
        visibility: z.enum(['unlisted', 'listed']).describe('Whether the party is publicly listed'),
        isHost: z.boolean().describe('Whether this stream is the host'),
        host: publicAuthorSchema,
        participantCount: z.number().int().min(0).describe('Participants in the party'),
        viewerIsParticipant: z.boolean().describe('Whether the viewer is in this party'),
        syncState: z
            .enum(['synced', 'drifting', 'buffering', 'paused', 'unknown'])
            .describe('Party-wide sync reading'),
        driftSeconds: z
            .number()
            .optional()
            .describe('Signed offset from the host in seconds (guests only, when measurable)'),
        isStalled: z.boolean().optional().describe('This participant is currently buffering'),
    })
    .meta({ id: 'WatchPartyStream' });

/**
 * Route-enriched fields — added by the /api/sessions handler.
 */
const SessionEnrichmentSchema = z.object({
    /** Whether session is from a privacy-enabled user (admin view only) */
    isPrivate: z.boolean().optional().describe('Is private session'),
    /** Whether session is a hover preview (admin view only) */
    isPreview: z.boolean().optional().describe('Is a hover preview session'),
    /** Origin of this session data */
    sessionSource: z
        .enum(['jellyfin', 'lumastra', 'subsonic', 'audiobookshelf', 'local'])
        .optional()
        .describe('Origin of this session data'),
    /**
     * True when the row describes playback happening in ANOTHER server's client
     * that Lumastra merely observes — a direct AudiobookShelf app listener, not
     * a stream we serve. Lumastra has no way to stop such a session, so the UI
     * must not offer a Stop control for it (the request would be a silent
     * no-op, and the next poll would resurrect the row anyway).
     *
     * Note this is NOT implied by `sessionSource === 'audiobookshelf'`: a book
     * streamed THROUGH Lumastra carries that same source and IS stoppable. Only
     * the merged upstream rows set this flag.
     */
    isReadOnly: z
        .boolean()
        .optional()
        .describe('Observed in an external app — Lumastra cannot stop it'),
    /** True if this session was recovered from DB after a server restart */
    recovered: z.boolean().optional().describe('Recovered after restart'),
    /**
     * True when the session was created but no heartbeat has reported a real
     * position yet (client is still buffering before the resume seek lands).
     * Display-only — no business logic should depend on this field.
     */
    isBuffering: z.boolean().optional().describe('Buffering before first real position heartbeat'),
    /**
     * Set when this stream is one participant's playback in a watch party the
     * viewer may see as a party (public, or the viewer is a participant/admin).
     * Rows sharing a `groupId` are the same party. Display-only.
     */
    watchParty: WatchPartyStreamSchema.optional().describe(
        'Watch party this stream belongs to (absent when not in a visible party)',
    ),
});

// ============================================================================
// Composed ActiveSessionSchema
// ============================================================================

/**
 * Active stream session — SINGLE SOURCE OF TRUTH.
 *
 * Composed from domain-specific sub-schemas for maintainability.
 * The StreamSession type in server/types.ts is derived from this schema.
 *
 * Sub-schemas:
 * - SessionIdentitySchema:    __id, id, mediaItemId, jellyfinId?, title, mediaType, ...
 * - SessionEpisodeSchema:     seasonNumber, episodeNumber, seriesName, ...
 * - SessionImageSchema:       imageId, seriesId, externalIds
 * - SessionRatingsSchema:     rating, criticRating, officialRating
 * - SessionPlaybackSchema:    playMethod, playCodec, playCurrentTime, ...
 * - SessionTranscodingSchema: playOriginalCodec, playIsTranscoding, ...
 * - SessionVideoSchema:       playVideoWidth/Height, playVideoRange, ...
 * - SessionAudioSchema:       playOriginalAudioCodec/Bitrate, ...
 * - SessionContainerSchema:   playOriginalContainer, playTranscodeContainer
 * - SessionTrackSchema:       playSubtitleLanguage, playAudioChannels, ...
 * - SessionUserSchema:        username, clientname, deviceId, clientApp, ...
 * - SessionLiveTvSchema:      liveTvProgramName, liveTvProgramEndTime, ...
 * - SessionEnrichmentSchema:  isPrivate, sessionSource (added by route handler)
 */
export const ActiveSessionSchema = SessionIdentitySchema.merge(SessionEpisodeSchema)
    .merge(SessionImageSchema)
    .merge(SessionRatingsSchema)
    .merge(SessionPlaybackSchema)
    .merge(SessionTranscodingSchema)
    .merge(SessionVideoSchema)
    .merge(SessionAudioSchema)
    .merge(SessionContainerSchema)
    .merge(SessionTrackSchema)
    .merge(SessionUserSchema)
    .merge(SessionLiveTvSchema)
    .merge(SessionMusicSchema)
    .merge(SessionRadioSchema)
    .merge(SessionEnrichmentSchema)
    .meta({ id: 'ActiveSession', description: 'Active stream session' });

export type ActiveSession = z.infer<typeof ActiveSessionSchema>;

/**
 * StreamSession — alias for ActiveSession.
 * This is the canonical type used by server code (transformers, services, cache).
 * Derived from ActiveSessionSchema (Zod single source of truth).
 */
export type StreamSession = z.infer<typeof ActiveSessionSchema>;

/**
 * Sessions response
 */
export const SessionsResponseSchema = z
    .object({
        /** Active sessions */
        sessions: z.array(ActiveSessionSchema).describe('Sessions'),
        /** Cache timestamp for compensating cache age in time display */
        cacheTimestamp: z.number().optional().describe('Cache timestamp'),
    })
    .meta({ id: 'SessionsResponse', description: 'Sessions response' });

export type SessionsResponse = z.infer<typeof SessionsResponseSchema>;

/**
 * Paged sessions response — contract returned by the v2 GET /api/sessions handler.
 *
 * Replaces SessionsResponseSchema (which used `{ sessions, cacheTimestamp }`) with
 * the canonical `{ items, page }` paginated envelope.  The legacy schema is retained
 * for backward-compat validation of the old SSR path until all consumers migrate.
 */
export const PlaybackSessionListItemSchema = z.object({
    playbackSessionId: z.string(),
    mediaId: z.string(),
    kind: z.enum(['video', 'music', 'audiobook', 'live']),
    status: z.enum(['ACTIVE', 'PAUSED']),
    positionMs: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative().nullable(),
    title: z.string().describe('Episode title for episodes; the item title otherwise'),
    seriesTitle: z
        .string()
        .nullable()
        .describe('Series title; set for episodes only, null otherwise'),
    seasonNumber: z.number().int().nullable().describe('Season number; set for episodes only'),
    episodeNumber: z.number().int().nullable().describe('Episode number; set for episodes only'),
    mediaType: z.string().nullable(),
    device: z.object({
        id: z.string(),
        name: z
            .string()
            .nullable()
            .describe(
                'Device display name the client registered; falls back to the client application name when unnamed',
            ),
        client: z.string().nullable(),
    }),
    isCarPlay: z
        .boolean()
        .optional()
        .describe('Client reports a connected CarPlay display; informational only.'),
    clientName: z.string().nullable().describe('Client application name, e.g. the Apple app'),
    clientVersion: z
        .string()
        .nullable()
        .describe(
            'Client version and build, e.g. "1.0.1 (2610140823)"; informational, never used for auth',
        ),
    userAgent: z
        .string()
        .nullable()
        .describe('User-Agent the session was started with; informational, never used for auth'),
    user: publicAuthorSchema.optional(),
    watchParty: WatchPartyStreamSchema.optional().describe(
        'Watch party this session belongs to (absent when not in a visible party)',
    ),
});
export const PagedSessionsResponseSchema = paginatedEnvelope(PlaybackSessionListItemSchema);

export type PagedSessionsResponse = z.infer<typeof PagedSessionsResponseSchema>;

// ============================================================================
// Episode Lookup Response (/api/jellyfin/episode)
// ============================================================================

/**
 * Episode lookup response — returns internal UUID from the Lumastra catalog
 */
export const JellyfinEpisodeResponseSchema = z
    .object({
        /** Internal episode UUID, null if not found in catalog */
        episodeId: z.string().nullable().describe('Internal episode UUID, null if not found'),
    })
    .meta({
        id: 'JellyfinEpisodeResponse',
        description: 'Jellyfin episode response',
    });

export type JellyfinEpisodeResponse = z.infer<typeof JellyfinEpisodeResponseSchema>;

// ============================================================================
// Timeline Response (GET /playback/{id}/timeline)
// ============================================================================

export const TimelineResponseSchema = z
    .object({
        fileId: z.string(),
        durationMs: z.number().int(),
        chapters: z.array(TimelineChapterSchema),
        segments: z.array(TimelineSegmentSchema),
        segmentAnalysis: z
            .string()
            .describe(
                'Analysis coverage: analyzed, pending, or unavailable. Retry while not analyzed; false skip flags are not final then.',
            ),
        hasIntro: z.boolean(),
        hasOutro: z.boolean(),
        trickplay: z.object({
            state: z
                .string()
                .describe(
                    'ready, pending, unavailable, or unsupported. Retry pending/unavailable; never retry unsupported.',
                ),
            variants: z.array(z.object({ width: z.number().int(), manifestHref: z.string() })),
        }),
    })
    .meta({
        id: 'TimelineResponse',
        description: 'Selected-file playback timeline; all times are absolute milliseconds.',
    });
export type TimelineResponse = z.infer<typeof TimelineResponseSchema>;

// ============================================================================
// Trailer absence is a successful, allocation-free preview result.
export const PreviewSessionNoTrailerSchema = z
    .object({
        /** trailerRequired probe result: the item has no local trailer */
        mode: z.literal('none').describe('No local trailer exists for this item'),
    })
    .meta({ id: 'PreviewSessionNoTrailer', description: 'Trailer probe: no local trailer' });

// ============================================================================
// Stream Session Create Response (/api/v1/playback/{itemId}/session)
// ============================================================================

/**
 * Stream session creation response
 */
export const StreamSessionCreateResponseSchema = z
    .object({
        /** Success flag */
        success: z.literal(true).describe('Success'),
        /** Stream token */
        streamToken: z.string().describe('Stream token'),
        /** Session ID */
        sessionId: z.string().describe('Session ID'),
        /** Item ID */
        itemId: z.string().describe('Item ID'),
        /** Expiration timestamp */
        expiresAt: z.string().describe('Expires at'),
        /** Max duration in minutes */
        maxDuration: z.number().describe('Max duration minutes'),
    })
    .meta({
        id: 'StreamSessionCreateResponse',
        description: 'Stream session create response',
    });

export type StreamSessionCreateResponse = z.infer<typeof StreamSessionCreateResponseSchema>;

// ============================================================================
// Stream Session Status Response (/api/v1/playback/stream-session GET)
// ============================================================================

/**
 * Valid stream session status
 */
export const StreamSessionValidResponseSchema = z
    .object({
        /** Session is valid */
        valid: z.literal(true).describe('Valid'),
        /** Item ID */
        itemId: z.string().optional().describe('Item ID'),
        /** Expiration timestamp */
        expiresAt: z.string().optional().describe('Expires at'),
        /** Last used timestamp */
        lastUsedAt: z.string().optional().describe('Last used at'),
        /** Seconds until expiry */
        secondsUntilExpiry: z.number().optional().describe('Seconds until expiry'),
        /** Seconds until inactivity timeout */
        secondsUntilInactivity: z.number().optional().describe('Seconds until inactivity timeout'),
    })
    .meta({
        id: 'StreamSessionValidResponse',
        description: 'Valid stream session status',
    });

export type StreamSessionValidResponse = z.infer<typeof StreamSessionValidResponseSchema>;

/**
 * Invalid stream session status
 */
export const StreamSessionInvalidResponseSchema = z
    .object({
        /** Session is invalid */
        valid: z.literal(false).describe('Invalid'),
        /** Reason for invalidity */
        reason: z.string().describe('Reason'),
        /** Human-readable message */
        message: z.string().describe('Message'),
        /** Item ID (if available) */
        itemId: z.string().optional().describe('Item ID'),
        /** Expiration timestamp (if available) */
        expiresAt: z.string().optional().describe('Expires at'),
        /** Last used timestamp (if available) */
        lastUsedAt: z.string().optional().describe('Last used at'),
    })
    .meta({
        id: 'StreamSessionInvalidResponse',
        description: 'Invalid stream session status',
    });

export type StreamSessionInvalidResponse = z.infer<typeof StreamSessionInvalidResponseSchema>;

// ============================================================================
// Stream Session End Response (/api/v1/playback/stream-session DELETE)
// ============================================================================

/**
 * Stream session end response
 */
export const StreamSessionEndResponseSchema = z
    .object({
        /** Success flag */
        success: z.boolean().describe('Success'),
        /** Message */
        message: z.string().describe('Message'),
    })
    .meta({
        id: 'StreamSessionEndResponse',
        description: 'Stream session end response',
    });

export type StreamSessionEndResponse = z.infer<typeof StreamSessionEndResponseSchema>;

// ============================================================================
// Stream Session Refresh Response (/api/v1/playback/stream-session/refresh)
// ============================================================================

/**
 * Stream session refresh response
 */
export const StreamSessionRefreshResponseSchema = z
    .object({
        /** New stream token */
        streamToken: z.string().describe('Stream token'),
        /** Session ID */
        sessionId: z.string().describe('Session ID'),
        /** New expiration timestamp */
        expiresAt: z.string().describe('Expires at'),
        /** Grace period for old token */
        oldTokenValidUntil: z.string().describe('Old token valid until'),
    })
    .meta({
        id: 'StreamSessionRefreshResponse',
        description: 'Stream session refresh response',
    });

export type StreamSessionRefreshResponse = z.infer<typeof StreamSessionRefreshResponseSchema>;

// ============================================================================
// Playback Session Debug Response (/api/playback/session GET)
// ============================================================================

/**
 * Active playback session debug info
 */
export const PlaybackSessionDebugResponseSchema = z
    .object({
        /** Whether session was found */
        found: z.boolean().describe('Session found'),
        /** Play method (DirectPlay, DirectStream, Transcode) */
        playMethod: z.string().optional().describe('Play method'),
        /** Whether paused */
        isPaused: z.boolean().optional().describe('Is paused'),
        /** Position in ticks */
        positionTicks: z.number().optional().describe('Position ticks'),
        /** Whether transcoding */
        isTranscoding: z.boolean().optional().describe('Is transcoding'),
        /** Whether video is direct */
        isVideoDirect: z.boolean().optional().describe('Is video direct'),
        /** Whether audio is direct */
        isAudioDirect: z.boolean().optional().describe('Is audio direct'),
        /** Video codec */
        videoCodec: z.string().optional().describe('Video codec'),
        /** Audio codec */
        audioCodec: z.string().optional().describe('Audio codec'),
        /** Transcode reasons */
        transcodeReasons: z.array(z.string()).optional().describe('Transcode reasons'),
        /** Video width */
        width: z.number().optional().describe('Width'),
        /** Video height */
        height: z.number().optional().describe('Height'),
        /** Bitrate */
        bitrate: z.number().optional().describe('Bitrate'),
        /** Item ID */
        itemId: z.string().optional().describe('Item ID'),
        /** Item name */
        itemName: z.string().optional().describe('Item name'),
        /** Container format */
        container: z.string().optional().describe('Container'),
        /** Raw transcode info */
        transcodeInfo: z.record(z.string(), z.unknown()).optional().describe('Transcode info'),
        /** Not found message */
        message: z.string().optional().describe('Message'),
        /** What we were looking for */
        lookingFor: z
            .object({
                itemId: z.string().describe('Item ID'),
                username: z.string().describe('Username'),
            })
            .optional()
            .describe('Looking for'),
        /** Available sessions */
        availableSessions: z
            .array(
                z.object({
                    itemId: z.string().optional().describe('Item ID'),
                    itemName: z.string().optional().describe('Item name'),
                    username: z.string().optional().describe('Username'),
                    playMethod: z.string().optional().describe('Play method'),
                }),
            )
            .optional()
            .describe('Available sessions'),
    })
    .meta({
        id: 'PlaybackSessionDebugResponse',
        description: 'Playback session debug response',
    });

export type PlaybackSessionDebugResponse = z.infer<typeof PlaybackSessionDebugResponseSchema>;

// ============================================================================
// Lumastra Playback Schemas
// ============================================================================

export const LumastraPlayMethodSchema = z
    .enum(['direct', 'remux', 'audio_transcode', 'full_transcode', 'audio_only'])
    .meta({ id: 'LumastraPlayMethod', description: 'Lumastra play method' });

export const LumastraPlaybackBranchSchema = z
    .enum([
        'direct',
        'remux_api',
        'web_hls_single_audio',
        'native_hls_multi_audio',
        'full_transcode',
    ])
    .meta({
        id: 'LumastraPlaybackBranch',
        description: 'Stable playback branch contract selected by the server planner',
    });

export const LumastraHlsAudioModeSchema = z.enum(['muxed', 'demux']).meta({
    id: 'LumastraHlsAudioMode',
    description: 'HLS audio layout selected by the server planner',
});

/** Subtitle track in lumastra-info (shared between version and top-level schemas) */
const LumastraSubtitleTrackSchema = z.object({
    index: z.number().int(),
    codec: z.string().optional(),
    language: z.string().nullable(),
    title: z.string().nullable(),
    default: z.boolean(),
    forced: z.boolean(),
    method: z
        .enum(['external_vtt', 'burn_in', 'client_render'])
        .optional()
        .describe('Server-recommended subtitle delivery method for this track'),
});

/** Mirrors `AudioSelectionReason` in `$lib/shared/track-selection`. */
export const AudioSelectionReasonSchema = z
    .enum([
        'original-language',
        'original-language-untagged',
        'explicit-default',
        'explicit-default-untagged',
        'learned',
        'file-default',
        'no-match-file-default',
    ])
    .meta({
        id: 'AudioSelectionReason',
        description: 'Why the server picked this audio track as the recommendation',
    });

/** Mirrors `SubtitleSelectionReason` in `$lib/shared/track-selection`. */
export const SubtitleSelectionReasonSchema = z
    .enum([
        'off',
        'hint-exact',
        'hint-role',
        'saved-language',
        'forced-for-audio',
        'none-available',
    ])
    .meta({
        id: 'SubtitleSelectionReason',
        description: 'Why the server picked (or omitted) this subtitle track as the recommendation',
    });

/**
 * Server-resolved starting tracks, shared by web/tvOS/iOS via `resolveTracks`.
 *
 * `subtitle_track_index` is deliberately `.optional()` with no `.nullable()`
 * counterpart. A `.nullable().optional()` field collapses to a single Swift
 * `Optional` under swift-openapi-generator, so `null` ("resolved: no
 * subtitles") and absent ("no opinion") would decode to the same `nil` and be
 * indistinguishable to iOS/tvOS. Presence of `recommended_tracks` itself is
 * the "did the server resolve" signal; when it resolved to "no subtitles",
 * both subtitle fields are omitted and `reason.subtitle` explains why
 * (typically `'off'`). External tracks use stable `subtitle_id`; embedded
 * tracks retain `subtitle_track_index` for compatibility.
 */
const RecommendationSchema = z.object({
    audio_track_index: z
        .number()
        .int()
        .describe('Audio track to start on, as tracks.audio[].index (audio-relative).'),
    subtitle_track_index: z
        .number()
        .int()
        .optional()
        .describe(
            'Embedded subtitle track to start on, as tracks.subtitles[].index. For a sidecar use subtitle_id. When both are absent, no subtitle track is selected — check reason.subtitle.',
        ),
    subtitle_id: z
        .string()
        .optional()
        .describe(
            'Stable external subtitle descriptor ID to start on, as subtitles[].id. Embedded recommendations retain subtitle_track_index.',
        ),
    reason: z
        .object({
            audio: AudioSelectionReasonSchema,
            subtitle: SubtitleSelectionReasonSchema,
        })
        .describe('Why each pick was made; clients render this in the track picker.'),
});

/**
 * Per-version info in lumastra-info response
 */
export const LumastraVersionSchema = z
    .object({
        id: z.string().describe('Version identifier (UUID or fallback like "legacy")'),
        plan_id: z.string().guid().optional().describe('PlaybackPlan ID for this version'),
        delivery_path: z
            .enum(['direct_file', 'native_hls', 'mse_hls'])
            .optional()
            .describe('Recommended delivery path'),
        playback_branch: LumastraPlaybackBranchSchema.optional().describe(
            'Stable playback branch contract for this version',
        ),
        hls_audio_mode: LumastraHlsAudioModeSchema.optional().describe(
            'HLS audio layout required for this version',
        ),
        label: z.string().nullable().describe('Display label (e.g. "4K Director\'s Cut")'),
        is_default: z.boolean().describe('Whether this is the default version'),
        playable: z.boolean().meta({
            description:
                'Whether the recommended play method (or a fallback) is actually available. ' +
                'When false, the client should show an error instead of attempting playback.',
        }),
        recommended: LumastraPlayMethodSchema,
        output_hdr: z
            .enum(['hdr10', 'hdr10plus', 'hlg', 'dovi', 'dovi_hdr10', 'sdr'])
            .describe("HDR format of the output when using this version's recommended play method"),
        transcode_reasons: z
            .array(z.string())
            .optional()
            .default([])
            .describe(
                'Legacy English reason strings for the recommended play method. Clients should prefer transcode_reason_codes for i18n.',
            ),
        transcode_reason_codes: z
            .array(TranscodeReasonSchema)
            .optional()
            .default([])
            .describe('Structured, i18n-friendly reasons for the recommended play method'),
        transcode_codec: z
            .enum(['h264', 'hevc', 'av1'])
            .nullable()
            .describe('Server-selected output codec for transcoding (null if direct play)'),
        duration_ms: z.number().nullable(),
        size_bytes: z
            .number()
            .int()
            .optional()
            .describe(
                'On-disk size of this version\'s source file, in bytes. Lets a client show "Download (4.2 GB)" ' +
                    'before committing to a transfer. Absent when the file has not been scanned yet (or is ' +
                    'currently missing) — treat absence as "size unknown", not as zero.',
            ),
        tracks: z.object({
            video: z
                .object({
                    codec: z.string(),
                    width: z.number(),
                    height: z.number(),
                    bitrate: z
                        .number()
                        .optional()
                        .describe('Video bitrate in bits/sec from ffprobe'),
                    fps: z.number().optional().describe('Average frame rate from ffprobe'),
                    hdr: z.enum(['hdr10', 'hdr10plus', 'hlg', 'dovi', 'dovi_hdr10', 'sdr']),
                    dv_profile: z
                        .number()
                        .int()
                        .optional()
                        .describe(
                            'Dolby Vision profile (5, 7, 8, 10) from the DOVI configuration record. Absent for non-DV video.',
                        ),
                    dv_bl_compat_id: z
                        .number()
                        .int()
                        .optional()
                        .describe(
                            'Dolby Vision base-layer signal compatibility id: 0 none, 1 HDR10, 2 SDR, 4 HLG. Absent for non-DV video.',
                        ),
                    container: z
                        .string()
                        .optional()
                        .describe('File container format (e.g. mp4, mkv, webm)'),
                })
                .nullable(),
            audio: z.array(
                z.object({
                    index: z
                        .number()
                        .describe(
                            '0-based audio-relative index (display / -map 0:a:N). NOT the wire selection value — use absoluteIndex for that.',
                        ),
                    absoluteIndex: z
                        .number()
                        .describe(
                            'Absolute ffmpeg stream index (counts video+audio+subtitle). The canonical value to send back when selecting this audio track.',
                        ),
                    codec: z.string(),
                    channels: z.number(),
                    language: z.string().nullable(),
                    title: z.string().nullable(),
                    default: z.boolean(),
                }),
            ),
            subtitles: z.array(LumastraSubtitleTrackSchema),
        }),
        play_methods: z.object({
            direct: z.object({ available: z.boolean() }),
            remux: z.object({ available: z.boolean() }),
            audio_transcode: z.object({
                available: z.boolean(),
            }),
            full_transcode: z.object({
                available: z.boolean(),
            }),
            // OPTIONAL on purpose. `audio_only` was added to play_methods after
            // the first v1 clients shipped, and this is self-hosted software with
            // no version negotiation — a client generated from the current schema
            // must still decode a response from an instance that predates the
            // emitter. A required field added to a response is just as breaking
            // for a generated client as a removed one. Our own server always
            // emits it; the optionality is for older servers, not for us.
            audio_only: z
                .object({ available: z.boolean() })
                .optional()
                .describe('Audio-only HLS variant. Absent on servers older than 16.190.0.'),
        }),
    })
    .meta({
        id: 'LumastraVersion',
        description: 'Per-version Lumastra playback info',
    });

export type LumastraVersion = z.infer<typeof LumastraVersionSchema>;

/**
 * Parsed client capabilities echoed back for debugging.
 * Shows what the server actually used to make its play-method recommendation.
 */
export const CapsUsedSchema = z
    .object({
        video_codecs: z.array(z.string()),
        audio_codecs: z.array(z.string()),
        hls_audio_codecs: z.array(z.string()).optional(),
        containers: z.array(z.string()),
        hdr_formats: z.array(z.string()).optional(),
        can_switch_audio: z.boolean(),
        codec_constraints: z
            .record(
                z.string(),
                z.object({
                    maxLevel: z.number().optional(),
                    maxProfile: z.string().optional(),
                }),
            )
            .optional()
            .meta({
                description: 'Per-codec video level/profile constraints keyed by codec name',
            }),
        source: z.enum(['caps_param', 'device_profile', 'default_browser', 'default_native']),
    })
    .meta({
        id: 'CapsUsed',
        description: 'Parsed client capabilities used for play-method decision',
    });

export type CapsUsed = z.infer<typeof CapsUsedSchema>;

export const LumastraInfoResponseSchema = z
    .object({
        playable: z.boolean().meta({
            description:
                'Whether the recommended play method (or a fallback) is actually available. ' +
                'When false, the client should show an error instead of attempting playback.',
        }),
        recommended: LumastraPlayMethodSchema,
        output_hdr: z.enum(['hdr10', 'hdr10plus', 'hlg', 'dovi', 'dovi_hdr10', 'sdr']).meta({
            description:
                'HDR format of the output when using the recommended play method. ' +
                'For direct/remux/audio_transcode this matches source. ' +
                'For full_transcode, "sdr" means server will tonemap; ' +
                '"hdr10"/"hlg" means HDR is preserved via HEVC Main 10 re-encode.',
        }),
        transcode_reasons: z
            .array(z.string())
            .optional()
            .default([])
            .describe(
                'Legacy English reason strings for the recommended play method. Clients should prefer transcode_reason_codes for i18n.',
            ),
        transcode_reason_codes: z
            .array(TranscodeReasonSchema)
            .optional()
            .default([])
            .describe('Structured, i18n-friendly reasons for the recommended play method'),
        transcode_codec: z
            .enum(['h264', 'hevc', 'av1'])
            .nullable()
            .describe('Server-selected output codec for transcoding (null if direct play)'),
        resume_position_ms: z.number(),
        resume_anchor: z
            .number()
            .nullable()
            .describe(
                'Epoch ms; max of user_media_state.last_event_at and the eligible-live-session last_heartbeat_at. ' +
                    'Null if neither exists. Same eligibility filter as resolveEffectiveResume.',
            ),
        is_watched: z
            .boolean()
            .describe('Whether the user has marked this media as watched / completed.'),
        stream_start_position_ms: z
            .number()
            .default(0)
            .describe(
                'Start offset of THIS episode inside its media file. A combined file ' +
                    '(S02E20E21, S01E01-02-03, ...) holds several episodes back to back and ' +
                    'streams as ONE video, so the requested episode may begin part-way in. ' +
                    '0 for a normal single-episode file.',
            ),
        client_should_seek: z
            .boolean()
            .default(false)
            .describe(
                'Whether the client should seek to stream_start_position_ms on a fresh play. ' +
                    'A genuine resume wins when it is further in, so the effective start is ' +
                    'max(resume_position_ms, stream_start_position_ms). The window is an ENTRY ' +
                    'POINT, not a fence: the timeline still spans the whole file and scrubbing ' +
                    'past the episode boundary is expected to work.',
            ),
        episodeNumberStart: z
            .number()
            .optional()
            .describe(
                'First episode number on the file, when it holds several. Render the range ' +
                    'from this, NOT from the requested episode — otherwise opening the last ' +
                    'part shows "E21-E21".',
            ),
        episodeNumberEnd: z
            .number()
            .optional()
            .describe(
                'Last episode number on the file, when it holds several (e.g. 21 of E20-E21)',
            ),
        duration_ms: z.number().nullable(),
        active_file_id: z.string().describe('Canonical ID of the currently active Lumastra file'),
        plan_id: z.string().guid().optional().describe('PlaybackPlan ID for the active version'),
        delivery_path: z
            .enum(['direct_file', 'native_hls', 'mse_hls'])
            .optional()
            .describe('Recommended delivery path for active version'),
        playback_branch: LumastraPlaybackBranchSchema.optional().describe(
            'Stable playback branch contract for active version',
        ),
        hls_audio_mode: LumastraHlsAudioModeSchema.optional().describe(
            'HLS audio layout required for active version',
        ),
        tracks: z.object({
            video: z
                .object({
                    codec: z.string(),
                    width: z.number(),
                    height: z.number(),
                    bitrate: z
                        .number()
                        .optional()
                        .describe('Video bitrate in bits/sec from ffprobe'),
                    fps: z.number().optional().describe('Average frame rate from ffprobe'),
                    hdr: z.enum(['hdr10', 'hdr10plus', 'hlg', 'dovi', 'dovi_hdr10', 'sdr']),
                    dv_profile: z
                        .number()
                        .int()
                        .optional()
                        .describe(
                            'Dolby Vision profile (5, 7, 8, 10) from the DOVI configuration record. Absent for non-DV video.',
                        ),
                    dv_bl_compat_id: z
                        .number()
                        .int()
                        .optional()
                        .describe(
                            'Dolby Vision base-layer signal compatibility id: 0 none, 1 HDR10, 2 SDR, 4 HLG. Absent for non-DV video.',
                        ),
                    container: z
                        .string()
                        .optional()
                        .describe('File container format (e.g. mp4, mkv, webm)'),
                })
                .nullable(),
            audio: z.array(
                z.object({
                    index: z
                        .number()
                        .describe(
                            '0-based audio-relative index (display / -map 0:a:N). NOT the wire selection value — use absoluteIndex for that.',
                        ),
                    absoluteIndex: z
                        .number()
                        .describe(
                            'Absolute ffmpeg stream index (counts video+audio+subtitle). The canonical value to send back when selecting this audio track.',
                        ),
                    codec: z.string(),
                    channels: z.number(),
                    language: z.string().nullable(),
                    title: z.string().nullable(),
                    default: z.boolean(),
                }),
            ),
            subtitles: z.array(LumastraSubtitleTrackSchema),
        }),
        recommended_tracks: RecommendationSchema.optional().describe(
            'The server-resolved starting tracks. Absent means the server expressed no opinion (it could not load preferences) and the client should resolve locally.',
        ),
        play_methods: z.object({
            direct: z.object({ available: z.boolean() }),
            remux: z.object({ available: z.boolean() }),
            audio_transcode: z.object({
                available: z.boolean(),
            }),
            full_transcode: z.object({
                available: z.boolean(),
            }),
            // OPTIONAL on purpose. `audio_only` was added to play_methods after
            // the first v1 clients shipped, and this is self-hosted software with
            // no version negotiation — a client generated from the current schema
            // must still decode a response from an instance that predates the
            // emitter. A required field added to a response is just as breaking
            // for a generated client as a removed one. Our own server always
            // emits it; the optionality is for older servers, not for us.
            audio_only: z
                .object({ available: z.boolean() })
                .optional()
                .describe('Audio-only HLS variant. Absent on servers older than 16.190.0.'),
        }),
        // All available file versions
        versions: z.array(LumastraVersionSchema),
        // External subtitle files from DB (not embedded in the media file)
        subtitles: z
            .array(timelineSubtitleDescriptorSchema)
            .describe('Ready subtitle descriptors for the selected file'),
        externalSubtitles: z
            .array(
                z.object({
                    id: z.string(),
                    language: z.string().nullable(),
                    format: z.string(),
                    isForced: z.boolean(),
                    isSdh: z.boolean(),
                }),
            )
            .optional(),
        // Trickplay scrubbing thumbnail parameters
        trickplay: TrickplayInfoSchema.optional(),
        // Echo of parsed client capabilities used for the play-method decision
        caps_used: CapsUsedSchema.optional(),
    })
    .meta({
        id: 'LumastraInfoResponse',
        description: 'Lumastra playback info',
    });

export type LumastraInfoResponse = z.infer<typeof LumastraInfoResponseSchema>;
export type LumastraPlayMethod = z.infer<typeof LumastraPlayMethodSchema>;

/**
 * Request body for lumastra progress reporting
 */
export const LumastraProgressRequestSchema = z
    .object({
        position_ms: z.number().int().nonnegative().describe('Current position in ms'),
        event_type: z.enum(['start', 'progress', 'stop']).describe('Event type'),
        is_completed: z.boolean().optional().describe('Whether playback completed'),
        play_session_id: z
            .string()
            .guid()
            .optional()
            .describe('Play session ID for watch history tracking'),
    })
    .meta({
        id: 'LumastraProgressRequest',
        description: 'Lumastra progress report',
    });

export type LumastraProgressRequest = z.infer<typeof LumastraProgressRequestSchema>;

/**
 * Response body for session heartbeat (PUT /api/play-sessions/{id}).
 *
 * Always includes `resumeAnchorAt` (server-clock instant as ISO 8601; same instant as
 * `LumastraInfoResponse.resume_anchor`, epoch ms) and `progressSaved` (whether this
 * specific heartbeat advanced `user_media_state`). Optional `action`/`reason`,
 * `superseded`, and `transcode` fields are preserved for kill / superseded /
 * transcode-progress branches the client already handles.
 */
/** Typed transcode progress payload embedded in heartbeat ack responses */
export const TranscodeProgressPayloadSchema = z.object({
    progressPercent: z
        .number()
        .describe(
            'Share of the file this session has transcoded, across seeks (coverage — not the encoder position). 100 only when the whole file is done.',
        ),
    segmentsReady: z.number().int(),
    totalSegments: z.number().int(),
    elapsedSeconds: z.number().int(),
    fps: z.number().optional(),
    speed: z.number().optional(),
    throttled: z
        .boolean()
        .optional()
        .describe(
            'FFmpeg is paused because it is far enough ahead of the player; it resumes as the player catches up.',
        ),
    bufferAheadSeconds: z
        .number()
        .int()
        .optional()
        .describe(
            'Seconds of media transcoded ahead of the newest segment the player requested. Absent until a segment was requested.',
        ),
    coveredRanges: z
        .array(
            z.object({
                start: z.number().describe('Start of the range, % of the file.'),
                end: z.number().describe('End of the range, % of the file.'),
            }),
        )
        .optional()
        .describe('Transcoded parts of the file, sorted and non-overlapping.'),
    encoderPercent: z
        .number()
        .optional()
        .describe('Where the encoder currently is, % of the file.'),
    etaSeconds: z
        .number()
        .int()
        .optional()
        .describe(
            'Wall-clock seconds until the transcode reaches the end of the file at its current speed. Absent without a speed reading.',
        ),
    transcodeType: z
        .enum(['remux', 'audio-only', 'audio-drop', 'full', 'tonemapping', 'unknown'])
        .optional(),
    videoAction: z.enum(['copy', 'transcode']).optional(),
    audioAction: z.enum(['copy', 'transcode']).optional(),
    isHardwareAccelerated: z.boolean().optional(),
    gpuEncoder: z.string().optional(),
    gpuDecoder: z.string().optional(),
    hdrTonemapMode: z.enum(['hardware', 'software', 'n/a']).optional(),
    slowReason: z
        .enum(['gpu_busy', 'cpu_slow'])
        .optional()
        .describe(
            'The encode has run below real time for a while, so playback may pause to buffer. gpu_busy: the GPU encoder is shared with another app (game streaming, screen recording, instant replay). cpu_slow: the CPU cannot keep up with a software encode. Absent when it keeps up.',
        ),
    softwareFallbackFrom: z
        .string()
        .optional()
        .describe(
            'GPU encoder (e.g. hevc_nvenc) this transcode gave up on because it could not open an encode session; it now encodes in software.',
        ),
});

export type TranscodeProgressPayload = z.infer<typeof TranscodeProgressPayloadSchema>;

export const SessionHeartbeatResponseSchema = z
    .object({
        resumeAnchorAt: z
            .string()
            .datetime()
            .nullable()
            .describe(
                'ISO 8601 server-clock instant; same instant as the info endpoint resume_anchor (epoch ms). Null if neither durable nor eligible-live-session timestamps exist.',
            ),
        progressSaved: z
            .boolean()
            .describe(
                'True if this heartbeat advanced user_media_state (engagement gate is open and this is a video media type).',
            ),
        action: z.enum(['kill', 'superseded']).optional(),
        reason: z.string().optional(),
        superseded: z.boolean().optional(),
        deviceName: z
            .string()
            .optional()
            .describe('With action superseded: the device that now plays this item, when known'),
        sessionLost: z
            .boolean()
            .optional()
            .describe('Audiobook upstream session was lost; reopen at the current position'),
        transcode: TranscodeProgressPayloadSchema.optional(),
    })
    .meta({
        id: 'SessionHeartbeatResponse',
        description: 'Heartbeat acknowledgement returned by PUT /api/play-sessions/{id}',
    });

export type SessionHeartbeatResponse = z.infer<typeof SessionHeartbeatResponseSchema>;

/** Response body for GET /api/play-sessions/{id}/transcode-progress. */
export const TranscodeProgressResponseSchema = z
    .object({
        transcode: TranscodeProgressPayloadSchema.nullable().describe(
            'Progress of the transcode serving this session, or null when none is running.',
        ),
    })
    .meta({
        id: 'TranscodeProgressResponse',
        description: 'Live transcode progress for one play session',
    });

export type TranscodeProgressResponse = z.infer<typeof TranscodeProgressResponseSchema>;

// ============================================================================
// Create Preview Response (POST /api/v1/playback/previews)
// ============================================================================

/**
 * Response for creating a hover-preview session.
 * Handler returns 201 with Location header.
 * Fields: { id, mediaId, streamUrl, playMethod, transcodeMode, hlsStartPosition }.
 */
export const CreatedPreviewResponseSchema = z
    .object({
        /** Server-side play session ID */
        id: z.string().describe('Preview session ID'),
        /** Canonical item ID used by the session */
        mediaId: z.string().describe('Media item ID'),
        /** HLS playlist URL to hand to the player */
        streamUrl: z.string().describe('HLS stream URL'),
        /** Play method selected by the server */
        playMethod: z.string().describe('Server play method'),
        /** Whether the server uses local or direct transcode */
        transcodeMode: z.string().optional().describe('Transcode mode'),
        /** Playlist-relative start position in seconds */
        hlsStartPosition: z.number().describe('HLS start position (seconds)'),
        mode: z.enum(['trailer', 'preview']),
        reporting: keepaliveReportingSchema,
    })
    .meta({ id: 'CreatePreviewResponse', description: 'Create preview session response' });

export const CreatePreviewResponseSchema = z.union([
    CreatedPreviewResponseSchema,
    PreviewSessionNoTrailerSchema,
]);

export type CreatePreviewResponse = z.infer<typeof CreatePreviewResponseSchema>;

// ============================================================================
// Probe Status Response (GET /api/v1/playback/{id}/probe-status)
// ============================================================================

/**
 * Keyframe-probe status response.
 * Three variants depending on probe state:
 *   { probing: false }
 *   { probing: false, error: { code, message, at } }
 *   { probing: true, phase, startedAt, currentSeconds, totalSeconds?, progress? }
 */
export const ProbeStatusResponseSchema = z
    .object({
        /** Whether a keyframe probe is currently in flight */
        probing: z.boolean().describe('Probe in flight'),
        /** Probe phase (present when probing is true) */
        phase: z.enum(['probing', 'starting']).optional().describe('Probe phase'),
        /** Epoch ms when the probe started (present when probing is true) */
        startedAt: z.number().optional().describe('Probe start time (epoch ms)'),
        /** How far the probe has analysed (seconds into the file) */
        currentSeconds: z.number().optional().describe('Current probe position (seconds)'),
        /** Total file duration being probed */
        totalSeconds: z.number().optional().describe('Total probe duration (seconds)'),
        /** Probe progress fraction 0–1 */
        progress: z.number().optional().describe('Probe progress (0–1)'),
        /** Error detail (present when probing is false and an error occurred) */
        error: z
            .object({
                code: z.string().describe('Error code'),
                message: z.string().describe('Error message'),
                at: z.number().describe('Epoch ms when error occurred'),
            })
            .optional()
            .describe('Probe error detail'),
        encoder: z
            .object({
                slowReason: z.enum(['gpu_busy', 'cpu_slow']).optional(),
                softwareFallbackFrom: z.string().optional(),
            })
            .optional()
            .describe(
                "Only with ?session=<playSessionId> and only for the caller's own transcode: the encoder cannot keep up (slowReason) or switched to software (softwareFallbackFrom). Same meaning as in the transcode progress payload.",
            ),
    })
    .meta({ id: 'ProbeStatusResponse', description: 'Keyframe probe status response' });

export type ProbeStatusResponse = z.infer<typeof ProbeStatusResponseSchema>;

// ============================================================================
// Watch State Response (GET|PATCH /api/v1/watch-state/{id})
// ============================================================================

/**
 * Unified watch-state response — returned by both GET and PATCH.
 * Fields: { mediaId, watched, positionMs, resumeAnchor, watchCount,
 *           lastWatchedAt, favorite, rating }.
 */
export const WatchStateResponseSchema = z
    .object({
        /** Internal media item UUID */
        mediaId: z.string().describe('Media item ID'),
        /** Whether the user has marked this item as watched */
        watched: z.boolean().describe('Watched'),
        /** Resume position in milliseconds */
        positionMs: z.number().int().describe('Resume position (ms)'),
        /** Resume fraction 0–1 (positionMs / runtimeMs), null when runtime unknown */
        resumeAnchor: z.number().nullable().describe('Resume anchor (0–1 fraction)'),
        /** Total number of times the user has watched this item */
        watchCount: z.number().int().describe('Watch count'),
        /** ISO-8601 timestamp of the last watch event, null if never watched */
        lastWatchedAt: z
            .string()
            .nullable()
            .describe(
                'When the item was last completed/marked watched (ISO-8601). Commonly null ' +
                    'for an in-progress item — this is NOT a signal that the server has no ' +
                    'record of playback. Do not use this for cross-device conflict resolution; ' +
                    'use `lastEventAt` instead.',
            ),
        /** ISO-8601 timestamp of the last playback activity of any kind, null if never recorded */
        lastEventAt: z
            .string()
            .nullable()
            .describe(
                'When the server last recorded ANY playback activity for this item ' +
                    '(ISO-8601), including in-progress position updates — not just ' +
                    'completions. This is the field to compare against a local record when ' +
                    'resolving cross-device conflicts.',
            ),
        /** Whether the item is in the user\'s favorites */
        favorite: z.boolean().describe('Favorite'),
        /** User rating (1–10 Lumastra scale), null if not rated */
        rating: z.number().int().nullable().describe('User rating (1–10)'),
    })
    .meta({ id: 'WatchStateResponse', description: 'Unified watch state response' });

export type WatchStateResponse = z.infer<typeof WatchStateResponseSchema>;

/**
 * PATCH /api/v1/watch-state/{id} request body — presence-preserving partial update.
 * Omitted fields are left unchanged. `position` is read-only here (set via
 * playback-session beacons, not this endpoint).
 */
export const WatchStateUpdateSchema = z
    .object({
        /** true = mark watched, false = mark unwatched. Omit to leave unchanged. */
        watched: z
            .boolean()
            .optional()
            .describe('Mark watched (true) / unwatched (false); omit to leave unchanged'),
        /** true = add to favorites, false/null = remove. Omit to leave unchanged. */
        favorite: z
            .boolean()
            .nullable()
            .optional()
            .describe('Add/remove favorite (false or null removes); omit to leave unchanged'),
    })
    .meta({
        id: 'WatchStateUpdate',
        description: 'Partial watch-state update (presence-preserving)',
    });

export type WatchStateUpdate = z.infer<typeof WatchStateUpdateSchema>;
