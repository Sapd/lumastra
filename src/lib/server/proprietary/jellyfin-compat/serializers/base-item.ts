// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { createHash } from 'node:crypto';
import type {
    JellyfinBaseItemDto,
    JellyfinChapterInfo,
    JellyfinItemType,
    JellyfinMediaStream,
    JellyfinSearchHint,
    JellyfinTrickplayInfo,
    JellyfinUserItemData,
} from '../types';
import { JELLYFIN_SERVER_ID, secondsToTicks, msToTicks } from '../constants';
import type { MediaStreamRow } from '$lib/server/database/queries/media-streams.queries';
import { isEpisode, isSeason, isSeries } from '$lib/server/utils/media-types.js';

/**
 * Build a stable Jellyfin-compatible Id from a name. Real Jellyfin generates
 * GenreItem.Id by MD5-hashing the lowercased trimmed name and formatting as a
 * UUID. We mirror that so the same genre always gets the same Id across
 * responses, which lets clients deduplicate and cache.
 */
function nameToStableId(name: string): string {
    const hash = createHash('md5').update(name.trim().toLowerCase()).digest('hex');
    return hash;
}

/**
 * Flexible input type — accepts raw DB rows or enriched query results.
 * Column names match media_items exactly; joined fields use descriptive names.
 */
export interface MediaItemForSerialization {
    // Required (media_items core)
    id: string;
    title: string;
    media_type: string;

    // Optional metadata (media_items columns)
    original_title?: string | null;
    overview?: string | null;
    year?: number | null;
    premiere_date?: string | null;
    created_at?: string | null;
    runtime_seconds?: number | null;
    sort_order?: number | null;
    parent_id?: string | null;
    season_number?: number | null;
    episode_number?: number | null;

    // Extended metadata (custom_metadata JSONB or joined provider data)
    tagline?: string | null;
    genres?: string[] | null;
    vote_average?: number | null;
    content_rating?: string | null;
    poster_path?: string | null;
    backdrop_path?: string | null;
    logo_path?: string | null;
    thumb_path?: string | null;
    sort_name?: string | null;
    /** `media_items.sort_title`: Lumastra's precomputed sort key (see {@link buildSortName}). */
    sort_title?: string | null;
    container?: string | null;
    path?: string | null;

    // Hierarchy (joined from parent rows — episodes/seasons)
    series_id?: string | null;
    series_name?: string | null;
    season_id?: string | null;
    season_name?: string | null;

    // Parent images (for episodes/seasons that inherit images from series)
    series_poster_path?: string | null;
    series_backdrop_path?: string | null;

    // Watch state (joined from watch_history / watchlist_activities)
    resume_position_ms?: number | null;
    played_percentage?: number | null;
    is_watched?: boolean | null;
    is_favorite?: boolean | null;
    /** When the user last played it (`lastPlayedAtExpression`) → UserData.LastPlayedDate. */
    last_played_at?: string | Date | null;
    unplayed_count?: number | null;
    child_count?: number | null;
    /**
     * Series / season: counted episodes under it and how many the user has
     * watched (`getFolderEpisodeCounts`). When set, the folder's UserData is
     * derived from them like Jellyfin's Folder.FillUserDataDtoValues.
     */
    recursive_item_count?: number | null;
    played_item_count?: number | null;

    // Chapters (joined from episode_chapters)
    chapters?: Array<{
        chapter_index: number;
        chapter_name: string | null;
        start_ticks: number; // bigint, parsed as number by driver
    }> | null;

    // Trickplay (joined from trickplay_params)
    trickplay_params?: Array<{
        file_id?: string;
        width: number;
        height: number;
        interval_ms: number;
        tile_width: number;
        tile_height: number;
        thumbnail_count: number;
        bandwidth: number;
    }> | null;
}

/**
 * Convert date values to ISO 8601 datetime format.
 * Jellyfin SDK (Swift) uses DateFormatter with `yyyy-MM-dd'T'HH:mm:ss.SSSZZZZZ`
 * and fails on bare dates like "2023-01-15". Must include time + timezone.
 */
function toIsoDateTime(value: string | Date | null | undefined): string | undefined {
    if (!value) return undefined;
    if (value instanceof Date) return value.toISOString();
    const str = String(value);
    // Already has time component — pass through
    if (str.includes('T')) return str;
    // Bare date "YYYY-MM-DD" → full datetime
    return `${str}T00:00:00.000Z`;
}

export function mapMediaType(lumastraType: string): JellyfinItemType {
    switch (lumastraType?.toLowerCase()) {
        case 'movie':
            return 'Movie';
        case 'tv':
        case 'series':
            return 'Series';
        case 'episode':
            return 'Episode';
        case 'season':
            return 'Season';
        case 'track':
        case 'music':
        case 'audio':
            return 'Audio';
        case 'album':
            return 'MusicAlbum';
        case 'artist':
            return 'MusicArtist';
        default:
            return 'Video';
    }
}

/** Per-item image cache tag — clients cache images by (itemId, tag). */
export function imageTagFor(id: string): string {
    return id.replace(/-/g, '').slice(0, 16);
}

function buildImageTags(item: MediaItemForSerialization): Record<string, string> {
    // Each item needs a UNIQUE image tag — clients cache images by (itemId, tag).
    // Using the same tag "0" for all items causes cache collisions.
    const tag = imageTagFor(item.id);
    const tags: Record<string, string> = {};
    // Always set Primary — the image proxy has a robust fallback chain
    // (TMDB → Jellyfin → custom URL) and will return 404 if truly missing.
    // Without Primary, Swiftfin never attempts to load the image at all.
    tags['Primary'] = tag;
    if (item.backdrop_path) {
        tags['Backdrop'] = tag;
    }
    if (item.logo_path) {
        tags['Logo'] = tag;
    }
    if (item.thumb_path) {
        tags['Thumb'] = tag;
    }
    return tags;
}

/** Jellyfin's serialized `DateTime.MinValue`. */
const CHAPTER_IMAGE_DATE_UNSET = '0001-01-01T00:00:00.0000000Z';

export function buildChapters(item: MediaItemForSerialization): JellyfinChapterInfo[] | undefined {
    if (!item.chapters?.length) return undefined;
    // Chapter thumbnails are cropped on request from the item's trickplay
    // sprite sheet. Only advertise ImageTag when trickplay exists for this
    // item — otherwise clients render a title-only marker (no broken image).
    const hasTrickplay = !!item.trickplay_params?.length;
    const tag = hasTrickplay ? imageTagFor(item.id) : undefined;
    return item.chapters.map((c, i) => ({
        StartPositionTicks: Number(c.start_ticks),
        Name: c.chapter_name ?? `Chapter ${c.chapter_index + 1 || i + 1}`,
        // Jellyfin's ChapterInfo.ImageDateModified is a non-nullable DateTime,
        // so the server always sends it (DateTime.MinValue when there is no
        // chapter image). jellyfin-sdk-kotlin declares it REQUIRED: without it
        // the whole item fails to decode and Android TV silently refuses to
        // open the details of any item that has chapters.
        ImageDateModified: CHAPTER_IMAGE_DATE_UNSET,
        ...(tag ? { ImageTag: tag } : {}),
    }));
}

export function buildTrickplay(
    item: MediaItemForSerialization,
): Record<string, Record<string, JellyfinTrickplayInfo>> | undefined {
    if (!item.trickplay_params?.length) return undefined;
    const result: Record<string, Record<string, JellyfinTrickplayInfo>> = {};
    for (const tp of item.trickplay_params) {
        const widthKey = `${tp.width}x${tp.height}`;
        const sourceKey = tp.file_id ?? item.id;
        if (!result[sourceKey]) {
            result[sourceKey] = {};
        }
        result[sourceKey][widthKey] = {
            Width: tp.width,
            Height: tp.height,
            TileWidth: tp.tile_width,
            TileHeight: tp.tile_height,
            ThumbnailCount: tp.thumbnail_count,
            Interval: tp.interval_ms,
            Bandwidth: tp.bandwidth,
        };
    }
    return result;
}

/**
 * Jellyfin `SortName`, the key Lumastra sorts by (the browse query's
 * `sortNameExpression`): episodes `SSS - EEEE - title` and seasons `NNNN` like
 * Episode/Season.CreateSortName, everything else the precomputed `sort_title`
 * (articles, diacritics and scripts normalised), else the lower-cased title —
 * never the original-language title.
 */
export function buildSortName(item: MediaItemForSerialization): string {
    if (item.sort_name) return item.sort_name;
    const pad = (n: number | null | undefined, width: number): string =>
        String(n ?? 0).padStart(width, '0');
    if (isEpisode(item.media_type)) {
        return `${pad(item.season_number, 3)} - ${pad(item.episode_number, 4)} - ${item.title.toLowerCase()}`;
    }
    if (isSeason(item.media_type)) return pad(item.season_number, 4);
    return item.sort_title || item.title.toLowerCase();
}

/** Series and seasons: watched state comes from their episodes. */
function isEpisodeFolder(mediaType: string): boolean {
    return isSeries(mediaType) || isSeason(mediaType);
}

/**
 * Jellyfin `Folder.FillUserDataDtoValues`: UnplayedItemCount = total − played,
 * PlayedPercentage = played / total, Played once every counted episode is
 * watched — and Played=true for a folder with nothing to count, as Jellyfin does.
 */
function buildFolderUserData(
    item: MediaItemForSerialization,
    total: number,
    played: number,
): JellyfinUserItemData {
    const isPlayed = total > 0 ? played >= total : true;
    return {
        PlaybackPositionTicks: 0,
        PlayedPercentage: total > 0 ? (played / total) * 100 : 0,
        Played: isPlayed,
        IsFavorite: item.is_favorite ?? false,
        UnplayedItemCount: Math.max(0, total - played),
        PlayCount: isPlayed ? 1 : 0,
        Key: item.id,
        ItemId: item.id,
    };
}

function buildUserData(item: MediaItemForSerialization): JellyfinUserItemData {
    if (isEpisodeFolder(item.media_type) && item.recursive_item_count != null) {
        return buildFolderUserData(item, item.recursive_item_count, item.played_item_count ?? 0);
    }
    // Lumastra's durable plane tracks resume_position_ms even on items where
    // is_watched=true (so /watch/[id] can resume re-watches correctly across
    // refreshes). Jellyfin's data model treats Played=true alongside any
    // in-progress signal (PlaybackPositionTicks>0 or PlayedPercentage>0) as
    // contradictory — clients show such items as both fully played AND
    // resumable, which breaks their UX. Zero ALL in-progress signals when
    // Played=true to preserve the Jellyfin contract at this serializer
    // boundary.
    //
    // PlayedPercentage is DERIVED from positionTicks + runtime when both are
    // available. The caller's `played_percentage` field is used only as a
    // fallback when runtime is unknown. This makes the (Played, Position,
    // Percentage) tuple internally consistent regardless of how callers
    // populated the input fields — preventing the class of bug where one
    // override path updates resume_position_ms but not played_percentage.
    const isPlayed = item.is_watched ?? false;
    const positionTicks =
        !isPlayed && item.resume_position_ms ? msToTicks(Number(item.resume_position_ms)) : 0;
    const runtimeTicks = item.runtime_seconds ? secondsToTicks(item.runtime_seconds) : 0;
    const playedPercentage = isPlayed
        ? 0
        : runtimeTicks > 0 && positionTicks > 0
          ? Math.min(100, (positionTicks / runtimeTicks) * 100)
          : (item.played_percentage ?? 0);
    return {
        PlaybackPositionTicks: positionTicks,
        PlayedPercentage: playedPercentage,
        Played: isPlayed,
        IsFavorite: item.is_favorite ?? false,
        UnplayedItemCount: item.unplayed_count ?? undefined,
        PlayCount: isPlayed ? 1 : 0,
        LastPlayedDate: toIsoDateTime(item.last_played_at),
        Key: item.id,
        ItemId: item.id,
    };
}

/**
 * Map a raw database row to MediaItemForSerialization.
 * Handles overview fallback (pm_overview ?? mi_overview), poster fallback
 * (poster_path ?? series_poster_path), and all nullable casts.
 *
 * Used by all /j/ browse endpoints to convert query results before serialization.
 */
export function mapRowToMediaItem(row: Record<string, unknown>): MediaItemForSerialization {
    return {
        id: row.id as string,
        title: row.title as string,
        media_type: row.media_type as string,
        original_title: row.original_title as string | null,
        sort_title: (row.sort_title as string | null) ?? null,
        overview: ((row.pm_overview ?? row.mi_overview) as string | null) ?? null,
        year: row.year as number | null,
        premiere_date: row.premiere_date as string | null,
        created_at: row.created_at as string | null,
        runtime_seconds: row.runtime_seconds as number | null,
        sort_order: (row.sort_order as number | null) ?? null,
        parent_id: row.parent_id as string | null,
        season_number: row.season_number as number | null,
        episode_number: row.episode_number as number | null,
        poster_path: ((row.poster_path ?? row.series_poster_path) as string | null) ?? null,
        backdrop_path: ((row.backdrop_path ?? row.series_backdrop_path) as string | null) ?? null,
        logo_path: (row.logo_path as string | null) ?? null,
        thumb_path: (row.thumb_path as string | null) ?? null,
        vote_average: row.vote_average as number | null,
        content_rating: row.content_rating as string | null,
        tagline: (row.tagline as string | null) ?? null,
        genres: (row.genre_names as string[] | null) ?? null,
        resume_position_ms: row.resume_position_ms as number | null,
        played_percentage: row.played_percentage as number | null,
        is_watched: row.is_watched as boolean | null,
        is_favorite: row.is_favorite as boolean | null,
        last_played_at: (row.last_played_at as string | Date | null) ?? null,
        series_id: row.series_id as string | null,
        series_name: row.series_name as string | null,
        season_id: row.season_id as string | null,
        season_name: row.season_name as string | null,
        series_poster_path: row.series_poster_path as string | null,
        series_backdrop_path: row.series_backdrop_path as string | null,
        child_count: (row.child_count as number | null) ?? null,
        unplayed_count: (row.unplayed_count as number | null) ?? null,
        container: (row.container as string | null) ?? undefined,
        path: (row.path as string | null) ?? undefined,
    };
}

export function serializeBaseItem(item: MediaItemForSerialization): JellyfinBaseItemDto {
    const type = mapMediaType(item.media_type);
    const isAudioType = type === 'Audio' || type === 'MusicAlbum' || type === 'MusicArtist';

    const isFolder =
        // eslint-disable-next-line callback-safety/no-bare-media-type-comparison -- mapMediaType returns Jellyfin's PascalCase vocabulary.
        type === 'Series' || type === 'Season' || type === 'MusicAlbum' || type === 'MusicArtist';

    // Jellyfin contract: folder-type items have MediaType='Unknown' (not 'Video').
    // Infuse uses MediaType to decide whether to render the item as playable
    // content vs a navigable folder — wrong MediaType breaks the series detail page.
    const mediaType = isFolder ? 'Unknown' : isAudioType ? 'Audio' : 'Video';

    return {
        // Identity
        Name: item.title,
        Id: item.id,
        ServerId: JELLYFIN_SERVER_ID,
        Type: type,
        Etag: item.id.replace(/-/g, ''),
        IsFolder: isFolder,
        ChannelId: null,

        // Display
        Overview: item.overview ?? undefined,
        Taglines: item.tagline ? [item.tagline] : [],
        Genres: item.genres ?? [],
        GenreItems: (item.genres ?? []).map((name) => ({
            Name: name,
            Id: nameToStableId(name),
        })),
        CommunityRating: item.vote_average ?? undefined,
        OfficialRating: item.content_rating ?? undefined,
        ProductionYear: item.year ?? undefined,
        PremiereDate: toIsoDateTime(item.premiere_date),
        DateCreated: toIsoDateTime(item.created_at),
        SortName: buildSortName(item),
        OriginalTitle: item.original_title ?? undefined,
        ExternalUrls: [],
        ProviderIds: {},

        // Images
        ImageTags: buildImageTags(item),
        BackdropImageTags: item.backdrop_path ? [item.id.replace(/-/g, '').slice(0, 16)] : [],
        ImageBlurHashes: {},
        // Episode Primary is a 16:9 still, not a 2:3 poster — matches the
        // Primary->thumb remapping in the /j Images route (see base-item.ts
        // buildImageTags callers). Wrong ratio here makes clients that trust
        // it crop/stretch the still even after the correct image loads.
        PrimaryImageAspectRatio: isAudioType ? 1.0 : isEpisode(item.media_type) ? 16 / 9 : 0.667,

        // Hierarchy
        ParentId: item.parent_id ?? undefined,
        SeriesId: item.series_id ?? undefined,
        SeriesName: item.series_name ?? undefined,
        SeasonId: item.season_id ?? undefined,
        SeasonName: item.season_name ?? undefined,
        // Jellyfin contract:
        //   Episode: IndexNumber=episode#, ParentIndexNumber=season#
        //   Season:  IndexNumber=season#,  ParentIndexNumber=undefined
        //   Other:   IndexNumber=undefined, ParentIndexNumber=undefined
        // Without IndexNumber on seasons Infuse cannot identify which season is
        // which, breaking the series detail page navigation.
        IndexNumber:
            // eslint-disable-next-line callback-safety/no-bare-media-type-comparison -- mapMediaType returns Jellyfin's PascalCase vocabulary.
            type === 'Season'
                ? (item.season_number ?? undefined)
                : (item.episode_number ?? undefined),
        // eslint-disable-next-line callback-safety/no-bare-media-type-comparison -- mapMediaType returns Jellyfin's PascalCase vocabulary.
        ParentIndexNumber: type === 'Episode' ? (item.season_number ?? undefined) : undefined,

        // Parent images — episodes/seasons inherit images from their series
        ParentPrimaryImageItemId:
            item.series_poster_path && item.series_id ? item.series_id : undefined,
        ParentPrimaryImageTag:
            item.series_poster_path && item.series_id
                ? item.series_id.replace(/-/g, '').slice(0, 16)
                : undefined,
        ParentBackdropItemId:
            item.series_backdrop_path && item.series_id ? item.series_id : undefined,
        ParentBackdropImageTags:
            item.series_backdrop_path && item.series_id
                ? [item.series_id.replace(/-/g, '').slice(0, 16)]
                : undefined,

        // Runtime
        RunTimeTicks: item.runtime_seconds ? secondsToTicks(item.runtime_seconds) : undefined,

        // Watch state
        UserData: buildUserData(item),

        // Children
        ChildCount: item.child_count ?? undefined,
        RecursiveItemCount: item.recursive_item_count ?? undefined,

        // Media info
        MediaType: mediaType,
        PlayAccess: 'Full',
        // Folder items (Series, Season, MusicAlbum) are not directly downloadable
        CanDownload: !isFolder,
        // `/j` has no DELETE /Items: nothing can be deleted from an app.
        CanDelete: false,
        LocationType: 'FileSystem',
        Container: item.container ?? undefined,
        Path: item.path ?? undefined,

        // Chapters
        Chapters: buildChapters(item),

        // Trickplay
        Trickplay: buildTrickplay(item),
    };
}

export function serializeBaseItems(items: MediaItemForSerialization[]): JellyfinBaseItemDto[] {
    return items.map(serializeBaseItem);
}

/**
 * Reduce a full BaseItemDto down to the SearchHint shape used by GET
 * /Search/Hints. Reuses the already-correct BaseItemDto serialization rather
 * than re-deriving fields from the raw row.
 */
export function mapBaseItemToSearchHint(item: JellyfinBaseItemDto): JellyfinSearchHint {
    return {
        ItemId: item.Id,
        Id: item.Id,
        Name: item.Name,
        Type: item.Type,
        MediaType: item.MediaType,
        IsFolder: item.IsFolder ?? false,
        RunTimeTicks: item.RunTimeTicks,
        ProductionYear: item.ProductionYear,
        IndexNumber: item.IndexNumber,
        ParentIndexNumber: item.ParentIndexNumber,
        Series: item.SeriesName,
        PrimaryImageTag: item.ImageTags?.Primary,
        ThumbImageTag: item.ImageTags?.Thumb,
        BackdropImageTag: item.BackdropImageTags?.[0],
        PrimaryImageAspectRatio: item.PrimaryImageAspectRatio,
        Album: item.Album,
        AlbumId: item.AlbumId,
        AlbumArtist: item.AlbumArtist,
        // Jellyfin sends [] for non-music items (SearchHint.Artists defaults to empty).
        Artists: item.Artists ?? [],
    };
}

function mapStreamType(row: MediaStreamRow): JellyfinMediaStream['Type'] {
    switch (row.stream_type) {
        case 'video':
            return 'Video';
        case 'audio':
            return 'Audio';
        case 'subtitle':
            return 'Subtitle';
        default:
            return 'Video';
    }
}

/**
 * Dolby Vision configuration of a video stream (ffprobe's DOVI record), as
 * Jellyfin's MediaStream DvProfile / DvLevel / DvBlSignalCompatibilityId.
 * Nothing for streams without one.
 */
function dolbyVision(
    isVideo: boolean,
    profile: number | null | undefined,
    level: number | null | undefined,
    blCompatibilityId: number | null | undefined,
): Pick<JellyfinMediaStream, 'DvProfile' | 'DvLevel' | 'DvBlSignalCompatibilityId'> {
    if (!isVideo || profile === null || profile === undefined) return {};
    return {
        DvProfile: profile,
        ...(level !== null && level !== undefined ? { DvLevel: level } : {}),
        ...(blCompatibilityId !== null && blCompatibilityId !== undefined
            ? { DvBlSignalCompatibilityId: blCompatibilityId }
            : {}),
    };
}

/**
 * Convert a raw media_streams row (from inline browse SQL queries) into the
 * Jellyfin-shaped MediaStream object. Used by all browse endpoints to keep
 * field parity with real Jellyfin in one place.
 *
 * Compared to streamRowToJellyfin (which expects MediaStreamRow), this helper
 * accepts the loose row shape returned by inline queries.
 */
export function mapBrowseStreamRow(row: Record<string, unknown>): JellyfinMediaStream {
    const type = row.stream_type as string;
    const isVideo = type === 'video';
    const isAudio = type === 'audio';
    const isSubtitle = type === 'subtitle';
    return {
        Index: row.stream_index as number,
        Type: isVideo ? 'Video' : isAudio ? 'Audio' : isSubtitle ? 'Subtitle' : 'Video',
        Codec: (row.codec as string) ?? undefined,
        CodecTag: (row.codec_tag as string) ?? undefined,
        Language: (row.language as string) ?? undefined,
        Title: (row.title as string) ?? undefined,
        DisplayTitle: ((row.display_title ?? row.title) as string) ?? undefined,
        IsInterlaced: false,
        IsAVC: false,
        IsDefault: (row.is_default as boolean) ?? false,
        IsForced: (row.is_forced as boolean) ?? false,
        IsHearingImpaired: (row.is_hearing_impaired as boolean | null) ?? false,
        IsOriginal: false,
        IsExternal: (row.is_external as boolean) ?? false,
        TimeBase: '1/1000',
        AudioSpatialFormat: 'None',
        VideoRange: isVideo ? ((row.video_range as string) ?? 'Unknown') : 'Unknown',
        VideoRangeType: isVideo ? ((row.video_range_type as string) ?? 'Unknown') : 'Unknown',
        Profile: (row.profile as string) ?? undefined,
        Level: isVideo ? ((row.level as number) ?? 0) : 0,
        Width: isVideo ? ((row.width as number) ?? undefined) : undefined,
        Height: isVideo ? ((row.height as number) ?? undefined) : undefined,
        AspectRatio: isVideo ? ((row.aspect_ratio as string) ?? undefined) : undefined,
        BitDepth: isVideo ? ((row.bit_depth as number) ?? undefined) : undefined,
        IsAnamorphic: isVideo ? ((row.is_anamorphic as boolean) ?? false) : undefined,
        AverageFrameRate: isVideo ? ((row.average_frame_rate as number) ?? undefined) : undefined,
        RealFrameRate: isVideo ? ((row.average_frame_rate as number) ?? undefined) : undefined,
        ReferenceFrameRate: isVideo ? ((row.average_frame_rate as number) ?? undefined) : undefined,
        PixelFormat: isVideo ? (row.pixel_format as string) || undefined : undefined,
        ...dolbyVision(
            isVideo,
            row.dv_profile as number | null | undefined,
            row.dv_level as number | null | undefined,
            row.dv_bl_signal_compatibility_id as number | null | undefined,
        ),
        RefFrames:
            isVideo && typeof row.ref_frames === 'number' && row.ref_frames > 0
                ? row.ref_frames
                : undefined,
        ColorSpace: isVideo ? (row.color_space as string) || undefined : undefined,
        ColorPrimaries: isVideo ? (row.color_primaries as string) || undefined : undefined,
        ColorTransfer: isVideo ? (row.color_transfer as string) || undefined : undefined,
        BitRate: (row.bitrate as number) ?? undefined,
        Channels: isAudio ? ((row.channels as number) ?? undefined) : undefined,
        SampleRate: isAudio ? ((row.sample_rate as number) ?? undefined) : undefined,
        ChannelLayout: isAudio ? ((row.channel_layout as string) ?? undefined) : undefined,
        IsTextSubtitleStream: isSubtitle ? ((row.is_text_subtitle as boolean) ?? false) : false,
        SupportsExternalStream: isSubtitle ? ((row.is_text_subtitle as boolean) ?? false) : false,
    };
}

export function streamRowToJellyfin(
    row: MediaStreamRow,
    itemId?: string,
    apiKey?: string,
    mediaSourceId?: string,
): JellyfinMediaStream {
    const stream: JellyfinMediaStream = {
        Index: row.stream_index,
        Type: mapStreamType(row),
        Codec: row.codec ?? undefined,
        Language: row.language ?? undefined,
        Title: row.title ?? undefined,
        DisplayTitle: row.display_title ?? row.title ?? undefined,
        IsInterlaced: false,
        IsAVC: false,
        IsDefault: row.is_default,
        IsForced: row.is_forced,
        IsHearingImpaired: row.is_hearing_impaired ?? false,
        IsOriginal: false,
        IsExternal: row.is_external ?? false,
        TimeBase: '1/1000',
        AudioSpatialFormat: 'None',
        VideoRange: row.stream_type === 'video' ? (row.video_range ?? 'Unknown') : 'Unknown',
        VideoRangeType:
            row.stream_type === 'video' ? (row.video_range_type ?? 'Unknown') : 'Unknown',
        Level: row.level ?? 0,
        IsTextSubtitleStream:
            row.stream_type === 'subtitle' ? (row.is_text_subtitle ?? false) : false,
        SupportsExternalStream:
            row.stream_type === 'subtitle' ? (row.is_text_subtitle ?? false) : false,
    };

    if (row.stream_type === 'video') {
        stream.Width = row.width ?? undefined;
        stream.Height = row.height ?? undefined;
        stream.BitRate = row.bitrate ?? undefined;
        stream.AspectRatio = row.aspect_ratio ?? undefined;
        if (row.video_range) stream.VideoRange = row.video_range;
        if (row.video_range_type) stream.VideoRangeType = row.video_range_type;
        stream.Profile = row.profile ?? undefined;
        if (row.level != null) stream.Level = row.level;
        if (row.bit_depth != null) stream.BitDepth = row.bit_depth;
        if (row.is_anamorphic != null) stream.IsAnamorphic = row.is_anamorphic;
        if (row.average_frame_rate != null) {
            stream.AverageFrameRate = row.average_frame_rate;
            stream.RealFrameRate = row.average_frame_rate;
            stream.ReferenceFrameRate = row.average_frame_rate;
        }
        if (row.codec_tag) stream.CodecTag = row.codec_tag;
        if (row.pixel_format) stream.PixelFormat = row.pixel_format;
        if (row.ref_frames != null && row.ref_frames > 0) stream.RefFrames = row.ref_frames;
        if (row.color_space) stream.ColorSpace = row.color_space;
        if (row.color_primaries) stream.ColorPrimaries = row.color_primaries;
        if (row.color_transfer) stream.ColorTransfer = row.color_transfer;
        Object.assign(
            stream,
            dolbyVision(true, row.dv_profile, row.dv_level, row.dv_bl_signal_compatibility_id),
        );
    }

    if (row.stream_type === 'audio') {
        stream.Channels = row.channels ?? undefined;
        stream.SampleRate = row.sample_rate ?? undefined;
        stream.ChannelLayout = row.channel_layout ?? undefined;
        stream.BitRate = row.bitrate ?? undefined;
    }

    if (row.stream_type === 'subtitle') {
        stream.IsTextSubtitleStream = row.is_text_subtitle ?? false;
        stream.SupportsExternalStream = row.is_text_subtitle ?? false;
        if (row.is_external) {
            // Truly external subtitle files — deliver via HTTP
            stream.DeliveryMethod = 'External';
            const sourceId = mediaSourceId ?? itemId;
            stream.DeliveryUrl = `/Videos/${itemId}/${sourceId}/Subtitles/${row.stream_index}/0/Stream.vtt?api_key=${apiKey}`;
        } else {
            // All embedded subtitles (text + bitmap) — MPV reads from container.
            // Fast: no HTTP subtitle fetch needed, no FFmpeg extraction delay.
            // Pre-play subtitle selection works via subtitleStreamIndex param.
            // In-player switching depends on Streamyfin's onTracksReady (client-side).
            stream.DeliveryMethod = 'Embed';
        }
    }

    return stream;
}
