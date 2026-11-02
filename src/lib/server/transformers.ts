// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { MediaItem, StreamSession } from './types.js';
import type { ExternalIds } from '$lib/types/api-common';
import type { JellyfinItem, JellyfinSession } from './jellyfin.js';
import type { AudiobookItem } from './audiobookshelf.js';
import type { SonarrCalendarEntry, SearchResult } from './sonarr.js';
import type { JellyseerrSearchResult } from './jellyseerr.js';
import { DataNormalizationService } from './services/data-normalization.service.js';
import { generateImageUrl } from '$lib/server/utils/provider-image-url.js';
import { isMovie, isSeries } from '$lib/server/utils/media-types';
import { toTmdbMediaType as toTmdbType } from '$lib/shared/media-type-domain';
import { GenreService } from './services/genre.service.js';
import { CastCrewService, type JellyfinDataInput } from './services/cast-crew.service.js';
import { createExternalIds } from '$lib/utils/external-ids.js';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';

export function transformJellyfinToMediaItem(
    items: JellyfinItem[],
    options: { includeMetadata?: boolean } = {},
): MediaItem[] {
    const { includeMetadata = true } = options;
    return items.flatMap((item) => {
        // Jellyfin reports container types alongside media (Person, Folder,
        // CollectionFolder, BoxSet) and library kinds MediaItem has no member
        // for. `normalizeMediaType` returns null for those now; it used to
        // return 'movie', so a Jellyfin folder came back as a movie MediaItem.
        // flatMap + [] drops them.
        const mediaType = DataNormalizationService.normalizeMediaType(item.Type);
        if (mediaType === null) return [];
        // Extract TMDB ID and create externalIds object
        // For episodes, use SeriesProviderIds if ProviderIds doesn't have TMDB
        let tmdbId = DataNormalizationService.extractTmdbId(item.ProviderIds);
        if (!tmdbId && item.SeriesProviderIds) {
            tmdbId = DataNormalizationService.extractTmdbId(item.SeriesProviderIds);
        }
        const externalIds: ExternalIds | undefined = tmdbId
            ? createExternalIds({ [getPrimaryExternalIdProvider()]: tmdbId })
            : undefined;

        // Use DataNormalizationService for consistent data handling
        const normalizedData = {
            id: item.Id,
            title: DataNormalizationService.safeString(item.Name),
            externalIds,
            overview: DataNormalizationService.normalizeOverview(item.Overview),
            rating: DataNormalizationService.normalizeRating(item.CommunityRating, '10'),
            year: DataNormalizationService.normalizeYear(item.ProductionYear),
            // Genre vocabularies are TMDB-scoped, so a row with no TMDB
            // namespace (music, audiobook, channel) gets `undefined` — which
            // normalizeGenres already accepts — rather than being looked up
            // against the movie genre list because `toTmdbType` said 'movie'.
            genres: GenreService.normalizeGenres(
                item.Genres,
                toTmdbType(item.Type) ?? undefined,
            ).map((g) => g.name),
            seriesName: item.SeriesName,
            seriesChildCount: item.ChildCount,
            seriesId: item.SeriesId, // For episodes, the series ID for logos
            seasonNumber: item.ParentIndexNumber,
            episodeNumber: item.IndexNumber,
            studio: item.SeriesStudio,
            duration: DataNormalizationService.normalizeJellyfinDuration(item.RunTimeTicks),
            imageBackdropId:
                item.SeriesName || item.MediaType?.toLowerCase() === 'tvchannel'
                    ? item.ParentBackdropItemId
                    : item.Id,
            remoteTrailers: item.RemoteTrailers?.map((trailer) => trailer.Url),
            mediaType,
            artists: item.Artists,
            imageUrl: generateImageUrl('jellyfin', item.Id, 'poster'),
            watchProgress: item.UserData?.PlayedPercentage,
            playbackPositionTicks: item.UserData?.PlaybackPositionTicks,
            // Note: TMDB ID is available in externalIds.tmdb if needed
        };

        // Extract cast and crew if available
        if (includeMetadata && item.People) {
            const castCrew = CastCrewService.extractCastAndCrew(
                item as JellyfinDataInput,
                'jellyfin',
            );
            (normalizedData as { cast?: unknown }).cast = castCrew.cast;
            (normalizedData as { crew?: unknown }).crew = castCrew.crew;
        }

        return normalizedData;
    });
}

export function transformAudiobookToMediaItem(items: AudiobookItem[]): MediaItem[] {
    return items.map((item) => ({
        mediaType: 'audiobook',
        id: item.id,
        title: DataNormalizationService.safeString(item.media.metadata.title),
        author: DataNormalizationService.safeString(item.media.metadata.authorName),
        overview: DataNormalizationService.normalizeOverview(item.media.metadata.description),
        duration: DataNormalizationService.safeNumber(item.media.duration),
        year: DataNormalizationService.normalizeYear(item.media.metadata.publishedYear),
        imageUrl: generateImageUrl('audiobookshelf', item.id),
    }));
}

export function transformSonarrToMediaItem(items: SonarrCalendarEntry[]): MediaItem[] {
    return items.map((item) => {
        // Determine media type: items with series info are TV episodes, otherwise movies
        const isEpisode = !!item.series?.title || !!item.seasonNumber;
        const mediaType = isEpisode ? 'sonarr' : 'movie';

        // Extract year from available date fields (for movies)
        const yearFromDate = (dateStr?: string): number | undefined => {
            if (!dateStr) return undefined;
            const date = new Date(dateStr);
            return Number.isNaN(date.getTime()) ? undefined : date.getFullYear();
        };
        const mediaYear =
            item.year ||
            yearFromDate(item.inCinemas) ||
            yearFromDate(item.physicalRelease) ||
            yearFromDate(item.digitalRelease);

        // Build series-level external IDs. For TV episodes the IDs come from
        // item.series (Sonarr returns the series object when includeSeries=true).
        // For movies the IDs are at the top level (Radarr).
        // Treat 0 / empty string as missing — Sonarr/Radarr occasionally
        // return placeholder values for unset IDs.
        const sanitizeNum = (v: number | undefined): number | undefined =>
            v && v > 0 ? v : undefined;
        const sanitizeStr = (v: string | undefined): string | undefined => {
            const trimmed = v?.trim();
            return trimmed ? trimmed : undefined;
        };
        const providerIds = isEpisode
            ? {
                  tvdb: sanitizeNum(item.series?.tvdbId),
                  tmdb: sanitizeNum(item.series?.tmdbId),
                  imdb: sanitizeStr(item.series?.imdbId),
              }
            : {
                  tmdb: sanitizeNum(item.tmdbId),
                  tvdb: sanitizeNum(item.tvdbId),
              };
        const ids = createExternalIds(providerIds);
        const externalIds = Object.keys(ids).length > 0 ? ids : undefined;

        return {
            id: item.id.toString(),
            title: item.title,
            overview: item.overview,
            seriesName: item.series?.title,
            seasonNumber: item.seasonNumber,
            episodeNumber: item.episodeNumber,
            mediaType,
            year: mediaYear,
            externalIds,
            sonarrAbsoluteEpisode: item.absoluteEpisodeNumber,
            sonarrSeriesId: item.series?.id,
            sonarrNetwork: item.series?.network,
            sonarrQuality: item.episodeFile?.quality?.quality?.name,
            sonarrHasFile: item.hasFile,
            sonarrAirDate: item.airDateUtc,
            physicalRelease: item.physicalRelease,
            digitalRelease: item.digitalRelease,
            inCinemas: item.inCinemas,
            // Calendar items are from Sonarr/Radarr, not Jellyfin - mark as not available
            // Availability will be updated when Jellyfin ID is resolved
            isAvailable: false,
            canRequest: !item.hasFile,
        };
    });
}

export function transformSearchResultToMediaItem(items: SearchResult[]): MediaItem[] {
    return items.map((item) => {
        // Build externalIds from available provider IDs using provider-agnostic helper
        const externalIds = createExternalIds({
            ...(item.tmdbId && { tmdb: item.tmdbId }),
            ...(item.tvdbId && { tvdb: item.tvdbId }),
        });

        // Use Radarr/Sonarr internal ID for mediaId
        // External IDs are in externalIds object
        const internalId = item.id?.toString() || '';

        return {
            mediaType: item.movieFile ? 'movie' : 'tv',
            id: internalId,
            externalIds: Object.keys(externalIds).length > 0 ? externalIds : undefined,
            title: item.title,
            overview: item.overview,
            year: item.year,
            genres: item.genres,
            // TODO: this shape (Radarr/Sonarr SearchResult) carries no vote_count,
            // so we can't gate the tmdb fallback the way pickDisplayRating does
            // elsewhere (rating-utils.ts) — prefer imdb first instead.
            rating: item.ratings?.imdb?.value || item.ratings?.tmdb?.value,
            imageUrl: item.movieFile
                ? `/api/image/radarr/${item.id}/poster`
                : `/api/image/sonarr/${item.id}/poster`,
        };
    });
}

type InternalPlayMethod = 'direct' | 'remux' | 'audio_transcode' | 'full_transcode';

function normalizeJellyfinPlayMethod(
    method: string | undefined,
    transcoding: { IsVideoDirect?: boolean } | null | undefined,
): InternalPlayMethod | undefined {
    switch (method) {
        case 'DirectPlay':
            return 'direct';
        case 'DirectStream':
            return 'remux';
        case 'Transcode':
            return transcoding?.IsVideoDirect === true ? 'audio_transcode' : 'full_transcode';
        default:
            return undefined;
    }
}

export function transformJellyfinSessionToStreamSession(
    sessions: JellyfinSession[],
): StreamSession[] {
    return sessions
        .filter(
            (item) =>
                item.NowPlayingItem &&
                item.NowPlayingItem.Id &&
                item.NowPlayingItem.Name &&
                item.UserName,
        )
        .map((item) => {
            const videoStream = DataNormalizationService.extractVideoStreamInfo(
                item.NowPlayingItem.MediaStreams,
            );
            const audioStream = DataNormalizationService.extractAudioStreamInfo(
                item.NowPlayingItem.MediaStreams,
            );
            const clientInfo = DataNormalizationService.normalizeClientInfo(
                item.Client,
                item.ApplicationVersion,
                item.DeviceName,
            );

            // null (a Jellyfin container/unknown type) is simply "not audio" —
            // the comparison below is the only consumer, so no substitute is
            // needed and inventing one would be the bug this refactor removes.
            const itemType = DataNormalizationService.normalizeMediaType(item.NowPlayingItem.Type);
            const isAudio = itemType === 'track';
            const artistNames =
                item.NowPlayingItem.Artists || item.NowPlayingItem.AlbumArtists || [];
            const artist =
                artistNames.length > 0 ? artistNames.join(', ') : item.NowPlayingItem.AlbumArtist;
            const album = item.NowPlayingItem.Album;

            const subtitleStreamIndex = item.PlayState?.SubtitleStreamIndex;
            const audioStreamIndex = item.PlayState?.AudioStreamIndex;

            const activeSubtitle =
                subtitleStreamIndex !== undefined && item.NowPlayingItem.MediaStreams
                    ? item.NowPlayingItem.MediaStreams.find(
                          (s) => s.Type === 'Subtitle' && s.Index === subtitleStreamIndex,
                      )
                    : null;

            const activeAudio =
                audioStreamIndex !== undefined && item.NowPlayingItem.MediaStreams
                    ? item.NowPlayingItem.MediaStreams.find(
                          (s) => s.Type === 'Audio' && s.Index === audioStreamIndex,
                      )
                    : null;

            return {
                __id: item.Id,
                id: item.Id,
                jellyfinId: item.NowPlayingItem.Id,
                mediaItemId: item.NowPlayingItem.Id,
                title: item.NowPlayingItem.Name,
                overview: item.NowPlayingItem.Overview,
                mediaType: itemType as StreamSession['mediaType'],
                year: DataNormalizationService.normalizeYear(
                    item.NowPlayingItem.ProductionYear || item.NowPlayingItem.PremiereDate,
                ),
                duration: DataNormalizationService.normalizeJellyfinDuration(
                    item.NowPlayingItem.RunTimeTicks,
                ),
                seasonNumber: item.NowPlayingItem.ParentIndexNumber,
                episodeNumber: item.NowPlayingItem.IndexNumber,
                seriesName: isAudio ? album : item.NowPlayingItem.SeriesName,
                author: isAudio ? artist : undefined,

                imageId: item.NowPlayingItem.Id,
                seriesId: item.NowPlayingItem.SeriesId || item.NowPlayingItem.ParentId,

                externalIds: DataNormalizationService.providerIdsToExternalIds(
                    item.NowPlayingItem.ProviderIds,
                ),

                rating: item.NowPlayingItem.CommunityRating,
                criticRating: item.NowPlayingItem.CriticRating,
                officialRating: item.NowPlayingItem.OfficialRating,

                playMethod: normalizeJellyfinPlayMethod(
                    item.PlayState?.PlayMethod,
                    item.TranscodingInfo,
                ),
                playIsPlaying: !item.PlayState?.IsPaused,
                playCurrentTime: DataNormalizationService.ticksToSeconds(
                    item.PlayState?.PositionTicks,
                ),
                playItemDuration: DataNormalizationService.ticksToSeconds(
                    item.NowPlayingItem.RunTimeTicks,
                ),
                streamProgress: DataNormalizationService.calculateProgress(
                    item.PlayState?.PositionTicks,
                    item.NowPlayingItem.RunTimeTicks,
                ),

                playOriginalCodec: videoStream.codec,
                playOriginalBitrate: videoStream.bitRate,
                playOriginalAudioCodec: audioStream.codec,
                playOriginalAudioBitrate: audioStream.bitRate,

                playTranscodeCodec: item.TranscodingInfo?.VideoCodec,
                playTranscodeBitrate: item.TranscodingInfo?.Bitrate,
                playTranscodeAudioCodec: item.TranscodingInfo?.AudioCodec,
                playTranscodeAudioBitrate: item.TranscodingInfo?.AudioBitrate,
                playIsTranscoding: item.TranscodingInfo
                    ? !item.TranscodingInfo.IsVideoDirect || !item.TranscodingInfo.IsAudioDirect
                    : false,
                playTranscodeReasons: item.TranscodingInfo?.TranscodeReasons,
                playHardwareAcceleration: item.TranscodingInfo?.HardwareAccelerationType,

                playVideoWidth: item.TranscodingInfo?.Width || videoStream.width,
                playVideoHeight: item.TranscodingInfo?.Height || videoStream.height,
                playOriginalVideoWidth: videoStream.width,
                playOriginalVideoHeight: videoStream.height,
                playVideoRange: item.TranscodingInfo?.VideoRange,
                playOriginalVideoRange: videoStream.videoRange,

                playOriginalContainer: item.NowPlayingItem.Container,
                playTranscodeContainer: item.TranscodingInfo?.Container,

                playBitrate: item.TranscodingInfo?.Bitrate || videoStream.bitRate,
                playCodec: item.TranscodingInfo?.VideoCodec || videoStream.codec,
                playTranscodeInfo: item.TranscodingInfo,

                playSubtitleLanguage: activeSubtitle?.Language,
                playSubtitleTitle: DataNormalizationService.normalizeTrackDisplayTitle(
                    activeSubtitle?.DisplayTitle || activeSubtitle?.Title,
                ),
                playSubtitleCodec: activeSubtitle?.Codec,
                // Jellyfin's MediaStream type does not expose DeliveryMethod,
                // so we heuristic burn-in from TranscodeReasons. When the reason
                // list contains 'SubtitleCodecNotSupported', Jellyfin is burning
                // the selected sub into the video stream.
                playSubtitleMethod:
                    activeSubtitle &&
                    item.TranscodingInfo?.TranscodeReasons?.some(
                        (r) => r.toLowerCase() === 'subtitlecodecnotsupported',
                    )
                        ? ('burn_in' as const)
                        : undefined,
                playAudioLanguage: activeAudio?.Language,
                playAudioTitle: DataNormalizationService.normalizeTrackDisplayTitle(
                    activeAudio?.DisplayTitle || activeAudio?.Title,
                ),
                playAudioChannels: activeAudio?.Channels,

                username: DataNormalizationService.normalizeUserInfo(item.UserName),
                userId: item.UserId,
                clientname: clientInfo.clientname,
                browsername: clientInfo.browsername,

                playSessionId: item.PlayState?.PlaySessionId,
                deviceId: item.DeviceId,

                sessionSource: 'jellyfin' as const,
            };
        });
}

const JELLYSEERR_STATUS_MAP: Record<number, MediaItem['requestStatus']> = {
    1: 'unknown',
    2: 'pending',
    3: 'processing',
    4: 'partially_available',
    5: 'available',
};

function mapJellyseerrStatus(status: number | undefined): MediaItem['requestStatus'] {
    if (status === undefined) return undefined;
    return JELLYSEERR_STATUS_MAP[status] ?? 'unknown';
}

export function transformJellyseerrToMediaItem(items: JellyseerrSearchResult[]): MediaItem[] {
    return items
        .filter((item) => isMovie(item.mediaType) || isSeries(item.mediaType))
        .map((item) => {
            // The .filter() above already restricted this to movie/series, which
            // is exactly TMDB's vocabulary, so this cannot be null in practice.
            // Kept as a checked value rather than an assertion so a change to the
            // filter degrades to "no image / no genres" instead of building a
            // `:movie/poster` path for something that is not a movie.
            const jellyseerrTmdbType = toTmdbType(item.mediaType);
            const externalIds = createExternalIds({
                [getPrimaryExternalIdProvider()]: item.id,
            });
            const normalizedData: MediaItem = {
                mediaType: 'anfragen' as const,
                id: DataNormalizationService.safeString(item.id),
                title: DataNormalizationService.safeString(
                    item.title || item.name || 'Unknown Title',
                ),
                externalIds,
                overview: DataNormalizationService.normalizeOverview(item.overview),
                year: DataNormalizationService.normalizeYear(item.releaseDate || item.firstAirDate),
                requestStatus: mapJellyseerrStatus(item.status),
                requestMediaType: item.mediaType,
                // Route through proxy for WebP conversion (provider-agnostic)
                // Jellyseerr only ever requests movies and series, so its
                // `mediaType` is already TMDB's binary vocabulary — the narrowing
                // cannot fail here. Guard on the result rather than asserting it,
                // and omit the image if it ever does.
                imageUrl:
                    item.posterPath && item.id && jellyseerrTmdbType
                        ? `/api/image/${getPrimaryExternalIdProvider()}:${item.id}:${jellyseerrTmdbType}/poster`
                        : undefined,
            };

            // Add genres if available
            if (item.genre_ids && item.genre_ids.length > 0) {
                const genreList = GenreService.convertGenreIds(
                    item.genre_ids,
                    jellyseerrTmdbType ?? undefined,
                );
                normalizedData.genres = genreList.map((g) => g.name);
            }

            return normalizedData;
        });
}
