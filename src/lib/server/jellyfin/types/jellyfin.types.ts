// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Type definitions for Jellyfin API
 * Extracted from the monolithic jellyfin.ts for better organization
 */
import type { Api } from '@jellyfin/sdk';

/**
 * Jellyfin item (movie, series, episode, etc.)
 * Represents the core media item structure from Jellyfin API
 */
export interface JellyfinItem {
    Id: string;
    Name: string;
    Overview?: string;
    Type: string;
    ProductionYear?: number;
    PremiereDate?: string;
    CommunityRating?: number;
    CriticRating?: number;
    OfficialRating?: string;
    Genres?: string[];
    GenreItems?: Array<{ Name: string; Id: string }>;
    People?: unknown[];
    SeriesName?: string;
    SeriesId?: string;
    SeasonId?: string;
    ParentId?: string;
    ChildCount?: number;
    ParentIndexNumber?: number;
    IndexNumber?: number;
    SeriesStudio?: string;
    RunTimeTicks?: number;
    ParentBackdropItemId?: string;
    AlbumArtists?: string[];
    AlbumArtist?: string;
    Album?: string;
    PrimaryImageItemId?: string;
    ImageTags?: {
        Primary?: string;
        Banner?: string;
        Thumb?: string;
        Backdrop?: string;
    };
    ProviderIds?: {
        [key: string]: string | undefined;
        Tmdb?: string;
        Imdb?: string;
    };
    SeriesProviderIds?: {
        [key: string]: string | undefined;
        Tmdb?: string;
        Imdb?: string;
    };
    RemoteTrailers?: Array<{ Url: string }>;
    MediaType?: string;
    Container?: string; // Original file container (mkv, mp4, avi, etc.)
    Artists?: string[];
    Studios?: Array<{ Name: string; Id: string }>;
    BackdropImageTags?: string[];
    UserData?: {
        PlaybackPositionTicks?: number;
        PlayedPercentage?: number;
        Played?: boolean;
        IsFavorite?: boolean;
        PlayCount?: number;
        LastPlayedDate?: string;
        UnplayedItemCount?: number;
    };
    RecursiveItemCount?: number;
    MediaStreams?: Array<{
        Type: string;
        BitRate?: number;
        Codec?: string;
        Width?: number;
        Height?: number;
        VideoRange?: string;
        Language?: string;
        DisplayTitle?: string;
        Title?: string;
        Channels?: number;
        Index: number;
        IsDefault?: boolean;
    }>;
}

/**
 * Active streaming session in Jellyfin
 * Includes playback state and transcoding information
 */
export interface JellyfinSession {
    Id: string;
    UserName: string;
    Client: string;
    ApplicationVersion: string;
    DeviceName: string;
    DeviceId: string;
    PlayState: {
        PositionTicks?: number;
        IsPaused: boolean;
        PlayMethod: string;
        PlaySessionId?: string;
        SubtitleStreamIndex?: number;
        AudioStreamIndex?: number;
    };
    UserId?: string;
    NowPlayingItem: JellyfinItem;
    TranscodingInfo?: {
        IsVideoDirect?: boolean;
        IsAudioDirect?: boolean;
        VideoCodec?: string;
        AudioCodec?: string;
        Container?: string; // Transcoding target container (ts, mp4, etc.)
        Width?: number;
        Height?: number;
        Bitrate?: number;
        AudioBitrate?: number;
        TranscodeReasons?: string[];
        VideoRange?: string; // For HDR detection
        HardwareAccelerationType?: string;
    };
}

/**
 * Episode data returned by getSeasonEpisodes() - MAPPED format (camelCase)
 * See "Jellyfin Client Method Return Formats" in CLAUDE.md
 */
export interface SeasonEpisode {
    id: string;
    name: string;
    episodeNumber: number;
    seasonNumber: number;
    overview?: string;
    runTimeTicks: number;
    premiereDate?: string;
    imageTag?: string;
    playedPercentage: number;
    played: boolean;
    playbackPositionTicks: number;
}

/**
 * Session info for playback reporting (computed on demand, not cached)
 * Internal type used by playback services
 */
export interface UserSession {
    api: Api;
    sessionId: string;
    token: string;
    userId: string;
    username: string;
}
