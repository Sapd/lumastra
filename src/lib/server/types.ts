// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { ExternalIds } from '$lib/types/api-common';
import type { UserId } from '$lib/shared/user-id';

// Unified types for the frontend
export interface MediaItem {
    id: string;
    title: string;
    /** External IDs from various providers */
    externalIds?: ExternalIds;
    overview?: string;
    rating?: number;
    year?: number;
    genres?: string[];
    seriesName?: string;
    seriesChildCount?: number;
    seriesId?: string; // For episodes, the series ID for images/logos
    seasonNumber?: number;
    episodeNumber?: number;
    studio?: string;
    duration?: number;
    imageBackdropId?: string;
    remoteTrailers?: string[];
    mediaType:
        | 'movie'
        | 'tv'
        | 'episode'
        | 'season'
        | 'audiobook'
        | 'artist'
        | 'album'
        | 'track'
        | 'sonarr'
        | 'radarr'
        | 'anfragen'
        | 'tvchannel'
        | 'book'
        | 'manga'
        | 'comic'
        | 'podcast'
        | 'music'
        | 'home_video'
        | 'training'
        | 'educational'
        | 'personal';
    watchProgress?: number;
    playbackPositionTicks?: number;
    artists?: string[];
    author?: string;
    chapter?: string;

    // Image URL for search previews
    imageUrl?: string;

    // Watched status (from Jellyfin UserData)
    isWatched?: boolean;

    // Sonarr specific fields
    sonarrAbsoluteEpisode?: number;
    sonarrSeriesId?: number;
    sonarrNetwork?: string;
    sonarrQuality?: string;
    sonarrHasFile?: boolean;
    sonarrAirDate?: string;
    physicalRelease?: string;
    digitalRelease?: string;
    inCinemas?: string;

    // Request-specific fields (provider-agnostic)
    requestStatus?: 'unknown' | 'pending' | 'processing' | 'partially_available' | 'available';
    requestMediaType?: 'movie' | 'tv';

    // Library info (Kavita and Audiobookshelf)
    libraryId?: number | string;
    libraryName?: string;

    // Availability status
    isAvailable?: boolean;
    canRequest?: boolean;
}

/**
 * StreamSession — derived from ActiveSessionSchema (Zod single source of truth).
 * See: src/lib/schemas/api-playback-responses.ts
 */
export type { StreamSession } from '$lib/schemas/api-playback-responses';

export interface SearchResults {
    mediaItems: MediaItem[];
    totalCount: number;
}

export interface UserContext {
    /**
     * The stable users.id UUID — the canonical key for ALL user data
     * (ratings, watch-state, playlists, caches). Set by every auth populator at
     * resolution time. Use this, never `username`, for user-data queries.
     */
    userId: UserId;
    /** Mutable login/display handle. Display & Jellyfin matching only — never a data key. */
    username: string;
    groups: string;
    userGroups: string[];
    hasWatchPermission: boolean;
    hasLiveTvPermission: boolean;
    /** Can request media via Jellyseerr */
    hasRequestPermission: boolean;
    /** Can create/edit community reviews in media modals */
    hasReviewPermission?: boolean;
    /** Can view/create player community annotations: pins and chat */
    hasMediaAnnotationPermission?: boolean;
    ownerIsAdmin: boolean;
    /**
     * Media-access admin capability of the resolved credential (Principal.isAdmin).
     * Token owners can be admin while their scoped credential is not. Absent only
     * for trusted background subjects and full password sessions that use owner permissions.
     */
    mediaAccessIsAdmin?: boolean;
    /** Maximum content age rating. null = unrestricted. Derived from age-{N} OIDC groups or admin override. */
    maxAgeRating: number | null;
    /** Whether this user has any age restriction (convenience: maxAgeRating !== null) */
    isAgeRestricted: boolean;
    /** Has moderation privileges: can delete any user content regardless of author */
    isModerator: boolean;
    liveTvPriority: 'high' | 'low';
}

// ============================================
// Video Playback Types - Re-exported from shared types
// ============================================
export type {
    PlaybackInfo,
    MediaSourceInfo,
    VideoStreamInfo,
    AudioStreamInfo,
    SubtitleStreamInfo,
    StreamOptions,
    PlaybackProgressReport,
    PlaybackEventType,
    TranscodingProfile,
    TrickplayInfo,
    MediaSegment,
    MediaSegmentType,
    NextEpisodeInfo,
} from '$lib/types/playback';

export { DEFAULT_TRANSCODING_PROFILES } from '$lib/types/playback';

export type { ChapterInfo } from '$lib/schemas/playback-types';
