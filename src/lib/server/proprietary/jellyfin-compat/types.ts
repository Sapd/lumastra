// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// TypeScript interfaces for Jellyfin API response serialization.
// These are output-only types — do NOT use Zod here.
// Cross-referenced against Swiftfin (iOS) and Jellyfin Android TV source code.

// Server identity
export interface JellyfinPublicSystemInfo {
    LocalAddress: string;
    ServerName: string;
    Version: string;
    Id: string;
    StartupWizardCompleted: boolean;
    OperatingSystem: string;
    ProductName: string;
}

// GET /System/Info (authenticated). The non-optional fields are the ones
// jellyfin-sdk-kotlin (1.6.3 - 1.9.2) declares non-null without a default: a
// response missing any of them fails the whole decode.
export interface JellyfinSystemInfo extends JellyfinPublicSystemInfo {
    SupportsLibraryMonitor: boolean;
    CanSelfRestart: boolean;
    CanLaunchWebBrowser: boolean;
    HasPendingRestart: boolean;
    IsShuttingDown: boolean;
    WebSocketPortNumber: number;
    OperatingSystemDisplayName?: string;
    SystemArchitecture?: string;
    HasUpdateAvailable?: boolean;
    CastReceiverApplications?: { Id: string; Name: string }[];
}

// User
export interface JellyfinUserPolicy {
    IsAdministrator: boolean;
    IsHidden: boolean;
    IsDisabled: boolean;
    EnableCollectionManagement: boolean;
    EnableSubtitleManagement: boolean;
    EnableLyricManagement: boolean;
    EnableUserPreferenceAccess: boolean;
    EnableRemoteControlOfOtherUsers: boolean;
    EnableSharedDeviceControl: boolean;
    EnableRemoteAccess: boolean;
    EnableLiveTvManagement: boolean;
    EnableLiveTvAccess: boolean;
    EnableMediaPlayback: boolean;
    EnableAudioPlaybackTranscoding: boolean;
    EnableVideoPlaybackTranscoding: boolean;
    EnablePlaybackRemuxing: boolean;
    ForceRemoteSourceTranscoding: boolean;
    EnableContentDeletion: boolean;
    EnableContentDownloading: boolean;
    EnableSyncTranscoding: boolean;
    EnableMediaConversion: boolean;
    EnablePublicSharing: boolean;
    EnableAllFolders: boolean;
    EnableAllDevices: boolean;
    EnableAllChannels: boolean;
    InvalidLoginAttemptCount: number;
    LoginAttemptsBeforeLockout: number;
    MaxActiveSessions: number;
    RemoteClientBitrateLimit: number;
    BlockedTags: string[];
    AllowedTags: string[];
    AccessSchedules: unknown[];
    BlockUnratedItems: string[];
    /** Age limit of an age-restricted profile (Jellyfin rating score). */
    MaxParentalRating?: number;
    EnableContentDeletionFromFolders: string[];
    EnabledDevices: string[];
    EnabledChannels: string[];
    EnabledFolders: string[];
    BlockedMediaFolders: string[];
    BlockedChannels: string[];
    AuthenticationProviderId: string;
    PasswordResetProviderId: string;
    SyncPlayAccess: string;
}

export interface JellyfinUserConfiguration {
    /** ISO 639-2 (Jellyfin's culture codes), absent when the user has none. */
    AudioLanguagePreference?: string;
    PlayDefaultAudioTrack: boolean;
    SubtitleLanguagePreference: string;
    DisplayMissingEpisodes: boolean;
    SubtitleMode: string;
    DisplayCollectionsView: boolean;
    EnableLocalPassword: boolean;
    GroupedFolders: string[];
    OrderedViews: string[];
    LatestItemsExcludes: string[];
    MyMediaExcludes: string[];
    HidePlayedInLatest: boolean;
    RememberAudioSelections: boolean;
    RememberSubtitleSelections: boolean;
    EnableNextEpisodeAutoPlay: boolean;
}

export interface JellyfinUserDto {
    Name: string;
    ServerId: string;
    Id: string;
    HasPassword: boolean;
    HasConfiguredPassword: boolean;
    HasConfiguredEasyPassword: boolean;
    EnableAutoLogin: boolean;
    PrimaryImageTag?: string;
    LastLoginDate?: string;
    LastActivityDate?: string;
    Policy: JellyfinUserPolicy;
    Configuration: JellyfinUserConfiguration;
}

export interface JellyfinSessionInfo {
    UserId: string;
    UserName: string;
    ServerId: string;
    DeviceId: string;
    DeviceName: string;
    Client: string;
    Id: string;
    ApplicationVersion: string;
    PlayState: {
        PositionTicks?: number;
        IsPaused: boolean;
        IsMuted: boolean;
        RepeatMode: string;
        PlaybackOrder: string;
        CanSeek: boolean;
        PlayMethod?: 'DirectPlay' | 'DirectStream' | 'Transcode';
        /** Native Lumastra devices report their selected tracks (-1 = subtitles off). */
        AudioStreamIndex?: number;
        SubtitleStreamIndex?: number;
    };
    IsActive: boolean;
    SupportsRemoteControl: boolean;
    SupportsMediaControl: boolean;
    HasCustomDeviceName: boolean;
    PlayableMediaTypes: string[];
    SupportedCommands: string[];
    AdditionalUsers: unknown[];
    NowPlayingQueue: unknown[];
    NowPlayingQueueFullItems: unknown[];
    NowPlayingItem?: JellyfinBaseItemDto;
    LastActivityDate: string;
    LastPlaybackCheckIn: string;
}

export interface JellyfinAuthResponse {
    AccessToken: string;
    ServerId: string;
    User: JellyfinUserDto;
    SessionInfo: JellyfinSessionInfo;
}

// User data (watch state per item)
export interface JellyfinUserItemData {
    PlaybackPositionTicks: number;
    PlayedPercentage: number;
    Played: boolean;
    IsFavorite: boolean;
    UnplayedItemCount?: number;
    PlayCount?: number;
    LastPlayedDate?: string;
    Key?: string;
    ItemId?: string;
    /** The user's own rating, 0–10. Nullable in the spec. */
    Rating?: number | null;
    /** Thumbs up (true) / down (false); null when the user gave neither. */
    Likes?: boolean | null;
}

// Media item (BaseItemDto)
export type JellyfinItemType =
    | 'Movie'
    | 'Series'
    | 'Season'
    | 'Episode'
    | 'Audio'
    | 'MusicAlbum'
    | 'MusicArtist'
    | 'MusicGenre'
    | 'Genre'
    | 'Person'
    | 'Studio'
    | 'CollectionFolder'
    | 'UserRootFolder'
    | 'BoxSet'
    | 'Playlist'
    | 'Video'
    | 'Trailer'
    | 'Channel'
    | 'TvChannel'
    | 'Program'
    | 'Person'
    | 'Studio';

export interface JellyfinBaseItemDto {
    // Identity
    Name: string;
    Id: string;
    ServerId: string;
    Type: JellyfinItemType;
    IsFolder?: boolean;
    Etag?: string;
    ChannelId?: string | null;
    HasSubtitles?: boolean;
    VideoType?: string;

    // Display
    Overview?: string;
    Taglines?: string[];
    Genres?: string[];
    GenreItems?: JellyfinNameIdPair[];
    ProviderIds?: Record<string, string>;
    RecursiveItemCount?: number;
    LocalTrailerCount?: number;
    SpecialFeatureCount?: number;
    /** Remote (YouTube) trailers; Jellyfin clients show a Trailer button for these. */
    RemoteTrailers?: JellyfinMediaUrl[];
    /** Set on local extras (trailers, featurettes, …); see related-media.ts. */
    ExtraType?: JellyfinExtraType;
    CommunityRating?: number;
    OfficialRating?: string;
    ProductionYear?: number;
    PremiereDate?: string;
    DateCreated?: string;
    SortName?: string;
    ForcedSortName?: string;

    // Images
    ImageTags?: Record<string, string>;
    BackdropImageTags?: string[];
    ImageBlurHashes?: Record<string, Record<string, string>>;
    PrimaryImageAspectRatio?: number;

    // Hierarchy
    ParentId?: string;
    SeriesId?: string;
    SeriesName?: string;
    SeasonId?: string;
    SeasonName?: string;
    IndexNumber?: number;
    ParentIndexNumber?: number;

    // Runtime
    RunTimeTicks?: number;
    /** Parts of a stacked movie incl. part 1; set only when > 1 (see multi-part.ts). */
    PartCount?: number;

    // Watch state
    UserData?: JellyfinUserItemData;

    /** Playlist entry id; set only by GET /Playlists/{id}/Items (see playlist-id.ts). */
    PlaylistItemId?: string;

    // Collection info
    CollectionType?: string;
    ChildCount?: number;
    SongCount?: number;
    AlbumCount?: number;
    /**
     * Item counts of a by-name item (Genre, MusicGenre, Person, Studio…), Jellyfin
     * `ItemCounts`; for persons and studios only titles the caller can see (people-studios.ts).
     */
    MovieCount?: number;
    SeriesCount?: number;
    EpisodeCount?: number;
    ArtistCount?: number;

    // Media info
    MediaSources?: JellyfinMediaSourceInfo[];
    MediaType?: string;
    PlayAccess?: string;
    CanDownload?: boolean;
    LocationType?: string;

    // Container/path (also at top level matching Jellyfin browse response)
    Container?: string;
    Path?: string;

    // People
    People?: JellyfinPersonInfo[];
    Studios?: JellyfinNameIdPair[];
    /** TMDB keywords (Jellyfin's TMDB provider stores them as tags). */
    Tags?: string[];
    /** Person items: deathday (PremiereDate is the birthday). */
    EndDate?: string;
    /** Person items: place of birth. */
    ProductionLocations?: string[];

    // For episodes with parent images
    ParentPrimaryImageItemId?: string;
    ParentPrimaryImageTag?: string;
    ParentBackdropItemId?: string;
    ParentBackdropImageTags?: string[];
    ParentLogoItemId?: string;
    ParentLogoImageTag?: string;
    ParentThumbItemId?: string;
    ParentThumbImageTag?: string;
    SeriesPrimaryImageTag?: string;
    AlbumPrimaryImageTag?: string;

    // Chapters
    Chapters?: JellyfinChapterInfo[];

    // Trickplay
    Trickplay?: Record<string, Record<string, JellyfinTrickplayInfo>>;

    // Music / metadata (used by jellyfin-rpc and jellyfin-rpc2)
    OriginalTitle?: string;
    Artists?: string[];
    ArtistItems?: JellyfinNameIdPair[];
    AlbumId?: string;
    Album?: string;
    AlbumArtist?: string;
    AlbumArtists?: JellyfinNameIdPair[];
    ExternalUrls?: Array<{ Name: string; Url: string }>;

    // Cloud-parity brief 09 (DtoService fields; see dto-options.ts for which
    // ones `Fields=` gates)
    /** Video streams of the default source, top level (`Fields=MediaStreams`). */
    MediaStreams?: JellyfinMediaStream[];
    CanDelete?: boolean;
    /** Critic score 0–100 (Rotten Tomatoes). */
    CriticRating?: number;
    CustomRating?: string;
    /** Series: Jellyfin SeriesStatus (`Continuing` / `Ended` / `Unreleased`). */
    Status?: string;
    AirDays?: string[];
    AirTime?: string;
    /** Series: episode display order (Jellyfin `DisplayOrder`, e.g. `dvd`, `absolute`). */
    DisplayOrder?: string;
    Width?: number;
    Height?: number;
    IsHD?: boolean;
    Video3DFormat?: string;
    /** Number of versions when it is not 1. */
    MediaSourceCount?: number;
    /** Last episode number of a multi-episode file. */
    IndexNumberEnd?: number;
    /** Live TV channel number. */
    ChannelNumber?: string;
    HasLyrics?: boolean;
    /** ReplayGain track gain in dB. */
    NormalizationGain?: number;
    SeriesThumbImageTag?: string;
}

export interface JellyfinPersonInfo {
    Name: string;
    Id: string;
    Role?: string;
    Type: string;
    PrimaryImageTag?: string;
}

export interface JellyfinNameIdPair {
    Name: string;
    Id?: string;
}

export interface JellyfinChapterInfo {
    StartPositionTicks: number;
    Name?: string;
    /** Required by jellyfin-sdk-kotlin (non-nullable DateTime in Jellyfin). */
    ImageDateModified: string;
    ImageTag?: string;
}

export interface JellyfinTrickplayInfo {
    Width: number;
    Height: number;
    TileWidth: number;
    TileHeight: number;
    ThumbnailCount: number;
    Interval: number;
    Bandwidth: number;
}

// Media source for playback
export interface JellyfinMediaSourceInfo {
    Id: string;
    Container: string;
    Protocol: string;
    Type: string;
    Name?: string;
    Path?: string;
    ETag?: string;
    Size?: number;
    Bitrate?: number;
    RunTimeTicks?: number;
    IsRemote: boolean;
    ReadAtNativeFramerate: boolean;
    IgnoreDts: boolean;
    IgnoreIndex: boolean;
    GenPtsInput: boolean;
    IsInfiniteStream: boolean;
    RequiresOpening: boolean;
    RequiresClosing: boolean;
    SupportsProbing: boolean;
    RequiresLooping: boolean;
    HasSegments: boolean;
    VideoType?: string;
    IsLiveTv?: boolean;
    SupportsDirectPlay: boolean;
    SupportsDirectStream: boolean;
    SupportsTranscoding: boolean;
    UseMostCompatibleTranscodingProfile?: boolean;
    DirectStreamUrl?: string;
    TranscodingUrl?: string;
    TranscodingContainer?: string;
    TranscodingSubProtocol?: string;
    MediaStreams?: JellyfinMediaStream[];
    DefaultAudioStreamIndex?: number;
    DefaultSubtitleStreamIndex?: number;
    LiveStreamId?: string;
    MediaAttachments?: unknown[];
    Formats?: string[];
    RequiredHttpHeaders?: Record<string, string>;
}

export interface JellyfinMediaStream {
    Index: number;
    Type: 'Video' | 'Audio' | 'Subtitle' | 'EmbeddedImage';
    Codec?: string;
    CodecTag?: string;
    Language?: string;
    Title?: string;
    DisplayTitle?: string;
    IsDefault: boolean;
    IsForced: boolean;
    IsExternal: boolean;
    // Video-specific
    Width?: number;
    Height?: number;
    BitRate?: number;
    AspectRatio?: string;
    // REQUIRED by jellyfin-sdk-kotlin 1.6.3 (spec 10.10.3: non-null enums without a
    // default) on EVERY stream, not only video — Jellyfin sends 'Unknown' for audio
    // and subtitle streams. jellyfin-androidtv 0.18 fails the whole decode without them.
    VideoRange: string;
    VideoRangeType: string;
    Profile?: string;
    Level?: number;
    BitDepth?: number;
    IsAnamorphic?: boolean;
    AverageFrameRate?: number;
    RealFrameRate?: number;
    ReferenceFrameRate?: number;
    PixelFormat?: string;
    RefFrames?: number;
    ColorSpace?: string;
    ColorPrimaries?: string;
    ColorTransfer?: string;
    // Audio-specific
    Channels?: number;
    SampleRate?: number;
    ChannelLayout?: string;
    // Common flags (always present in Jellyfin responses for all stream types).
    // The four booleans are REQUIRED: jellyfin-sdk-kotlin (1.7.x, used by
    // jellyfin-androidtv 0.19) declares them non-null without a default, so one
    // stream missing any of them fails the whole PlaybackInfo decode — and the
    // app swallows that error and just never starts playback.
    IsInterlaced: boolean;
    IsAVC?: boolean;
    IsHearingImpaired: boolean;
    /** Dolby Vision configuration (video streams that carry one). */
    DvProfile?: number;
    DvLevel?: number;
    DvBlSignalCompatibilityId?: number;
    // REQUIRED from jellyfin-sdk-kotlin 1.9 (spec 12.2) on, same failure mode as
    // above. Jellyfin sets it from the ffprobe `original` disposition; we store no
    // dispositions, so it is false — what Jellyfin reports for an unflagged track.
    IsOriginal: boolean;
    TimeBase?: string;
    AudioSpatialFormat?: string;
    IsTextSubtitleStream: boolean;
    SupportsExternalStream: boolean;
    // Subtitle-specific
    DeliveryMethod?: string;
    DeliveryUrl?: string;
}

// Playback info response
export interface JellyfinPlaybackInfoResponse {
    PlaySessionId: string;
    MediaSources: JellyfinMediaSourceInfo[];
    ErrorCode?: string;
}

// GET /Audio/{itemId}/Lyrics — LyricDto. Metadata and Lyrics are required by
// the SDK (non-nullable, no default); every Metadata member is nullable.
export interface JellyfinLyricMetadata {
    Artist?: string | null;
    Album?: string | null;
    Title?: string | null;
    Author?: string | null;
    Length?: number | null;
    By?: string | null;
    Offset?: number | null;
    Creator?: string | null;
    Version?: string | null;
    IsSynced?: boolean | null;
}

export interface JellyfinLyricLine {
    Text: string;
    /** Ticks; absent/null for unsynced lyrics. */
    Start?: number | null;
}

export interface JellyfinLyricDto {
    Metadata: JellyfinLyricMetadata;
    Lyrics: JellyfinLyricLine[];
}

// Items response wrapper
export interface JellyfinItemsResponse {
    Items: JellyfinBaseItemDto[];
    TotalRecordCount: number;
    StartIndex: number;
}

/** MediaUrl (BaseItemDto.RemoteTrailers entry). */
export interface JellyfinMediaUrl {
    Url: string;
    Name?: string | null;
}

/** ExtraType enum (Jellyfin.Data). */
export type JellyfinExtraType =
    | 'Unknown'
    | 'Clip'
    | 'Trailer'
    | 'BehindTheScenes'
    | 'DeletedScene'
    | 'Interview'
    | 'Scene'
    | 'Sample'
    | 'ThemeSong'
    | 'ThemeVideo'
    | 'Featurette'
    | 'Short';

/** ThemeMediaResult — Items, TotalRecordCount, StartIndex and OwnerId are all non-nullable. */
export interface JellyfinThemeMediaResult {
    Items: JellyfinBaseItemDto[];
    TotalRecordCount: number;
    StartIndex: number;
    OwnerId: string;
}

/** GET /Movies/Recommendations entry. RecommendationType and CategoryId are required. */
export interface JellyfinRecommendationDto {
    Items: JellyfinBaseItemDto[];
    RecommendationType:
        | 'SimilarToRecentlyPlayed'
        | 'SimilarToLikedItem'
        | 'HasDirectorFromRecentlyPlayed'
        | 'HasActorFromRecentlyPlayed'
        | 'HasLikedDirector'
        | 'HasLikedActor';
    BaselineItemName: string | null;
    CategoryId: string;
}

// GET /Search/Hints — SearchApi.getSearchHints result. Distinct from
// JellyfinBaseItemDto: jellyfin-androidtv-family clients (Moonfin) call this
// endpoint (not /Items?searchTerm=) for their native search screen.
export interface JellyfinSearchHint {
    ItemId: string;
    Id: string;
    Name: string;
    Type: JellyfinItemType;
    MediaType?: string;
    IsFolder: boolean;
    RunTimeTicks?: number;
    ProductionYear?: number;
    IndexNumber?: number;
    ParentIndexNumber?: number;
    Series?: string;
    PrimaryImageTag?: string;
    ThumbImageTag?: string;
    BackdropImageTag?: string;
    PrimaryImageAspectRatio?: number;
    Album?: string;
    AlbumId?: string;
    AlbumArtist?: string;
    /** Non-null without a default in jellyfin-sdk-kotlin 1.6.3–1.9.2: an absent
     *  key throws MissingFieldException and the client shows no results. */
    Artists: string[];
    /** Live TV channel hits. */
    ChannelId?: string;
    ChannelName?: string;
}

// GET /Items/Filters — QueryFiltersLegacy (every member nullable in the SDK).
export interface JellyfinQueryFiltersLegacy {
    Genres: string[];
    Tags: string[];
    OfficialRatings: string[];
    Years: number[];
}

export interface JellyfinNameGuidPair {
    Name: string;
    /** Required (non-null) in the SDK. */
    Id: string;
}

// GET /Items/Filters2 — QueryFilters.
export interface JellyfinQueryFilters {
    Genres: JellyfinNameGuidPair[];
    Tags: string[];
}

export interface JellyfinSearchHintResult {
    SearchHints: JellyfinSearchHint[];
    TotalRecordCount: number;
}

// Branding
export interface JellyfinBrandingOptions {
    LoginDisclaimer: string;
    CustomCss: string;
    SplashscreenEnabled?: boolean;
}

// Quick Connect
export interface JellyfinQuickConnectResult {
    Secret: string;
    Code: string;
    DateAdded: string;
    Authenticated: boolean;
    DeviceId: string;
    DeviceName: string;
    AppName: string;
    AppVersion: string;
}

// Playback progress reporting (input types)
export interface JellyfinPlaybackStartInfo {
    ItemId: string;
    MediaSourceId?: string;
    PositionTicks?: number;
    PlaySessionId?: string;
    AudioStreamIndex?: number;
    SubtitleStreamIndex?: number;
    IsPaused?: boolean;
    PlayMethod?: 'DirectPlay' | 'DirectStream' | 'Transcode';
    CanSeek?: boolean;
    IsMuted?: boolean;
    VolumeLevel?: number;
    RepeatMode?: string;
}

export interface JellyfinPlaybackProgressInfo extends JellyfinPlaybackStartInfo {
    IsPaused: boolean;
}

export interface JellyfinPlaybackStopInfo {
    ItemId: string;
    MediaSourceId?: string;
    PositionTicks?: number;
    PlaySessionId?: string;
    LiveStreamId?: string;
    Failed?: boolean;
}

// Image types
export type JellyfinImageType =
    | 'Primary'
    | 'Backdrop'
    | 'Banner'
    | 'Logo'
    | 'Thumb'
    | 'Art'
    | 'Screenshot'
    | 'Chapter'
    | 'Disc'
    | 'Box'
    | 'BoxRear';

// Time sync (/GetUtcTime)
export interface JellyfinUtcTimeResponse {
    RequestReceptionTime: string;
    ResponseTransmissionTime: string;
}

// Localization (/Localization/*)
export interface JellyfinCultureDto {
    Name: string;
    DisplayName: string;
    TwoLetterISOLanguageName: string;
    ThreeLetterISOLanguageName: string | null;
    ThreeLetterISOLanguageNames: string[];
}

export interface JellyfinCountryInfo {
    Name: string | null;
    DisplayName: string | null;
    TwoLetterISORegionName: string | null;
    ThreeLetterISORegionName: string | null;
}

/** Property names are camelCase in the Jellyfin spec (`score`, `subScore`). */
export interface JellyfinParentalRatingScore {
    score: number;
    subScore: number | null;
}

export interface JellyfinParentalRating {
    Name: string | null;
    Value: number | null;
    RatingScore: JellyfinParentalRatingScore | null;
}

export interface JellyfinLocalizationOption {
    Name: string | null;
    Value: string | null;
}

// /Items/{itemId}/Images
export interface JellyfinImageInfo {
    ImageType: JellyfinImageType;
    ImageIndex: number | null;
    ImageTag: string | null;
    BlurHash?: string | null;
    Height?: number | null;
    Width?: number | null;
    Size: number;
}

// /FallbackFont/Fonts
export interface JellyfinFontFile {
    Name: string | null;
    Size: number;
    DateCreated: string;
    DateModified: string;
}

// ── Playlists (PlaylistsController) ─────────────────────────────────────────

/** `PlaylistCreationResult` — Jellyfin returns the new playlist's id. */
export interface JellyfinPlaylistCreationResult {
    Id: string;
}

/** `PlaylistUserPermissions` — one share of a playlist. */
export interface JellyfinPlaylistUserPermissions {
    UserId: string;
    CanEdit: boolean;
}

/** `PlaylistDto` — `Shares` and `ItemIds` are required by the SDK. */
export interface JellyfinPlaylistDto {
    OpenAccess: boolean;
    Shares: JellyfinPlaylistUserPermissions[];
    ItemIds: string[];
}
