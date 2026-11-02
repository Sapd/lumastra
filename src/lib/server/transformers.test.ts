// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for transformer functions
 *
 * These functions transform data from various sources (Jellyfin, Audiobookshelf, Sonarr, etc.)
 * into unified MediaItem and StreamSession formats.
 */

import { describe, it, expect } from 'vitest';
import {
    transformJellyfinToMediaItem,
    transformAudiobookToMediaItem,
    transformSonarrToMediaItem,
    transformSearchResultToMediaItem,
    transformJellyfinSessionToStreamSession,
    transformJellyseerrToMediaItem,
} from './transformers';
import type { JellyfinItem, JellyfinSession } from './jellyfin.js';
import type { AudiobookItem } from './audiobookshelf.js';
import type { SonarrCalendarEntry, SearchResult } from './sonarr.js';
import type { JellyseerrSearchResult } from './jellyseerr.js';

const makeJellyfinItem = (overrides: Partial<JellyfinItem>): JellyfinItem => ({
    Id: 'item-1',
    Name: 'Item',
    Type: 'Movie',
    ...overrides,
});

const makeJellyfinSession = (
    overrides: Partial<
        Omit<JellyfinSession, 'PlayState'> & {
            PlayState?: Partial<JellyfinSession['PlayState']>;
        }
    >,
): JellyfinSession => {
    const base: JellyfinSession = {
        Id: 'session-1',
        UserName: 'User',
        Client: 'Jellyfin Web',
        ApplicationVersion: '1.0.0',
        DeviceName: 'Browser',
        DeviceId: 'device-1',
        PlayState: {
            IsPaused: false,
            PlayMethod: 'DirectPlay',
        },
        NowPlayingItem: makeJellyfinItem({}),
    };

    return {
        ...base,
        ...overrides,
        PlayState: {
            ...base.PlayState,
            ...overrides.PlayState,
        },
        NowPlayingItem: overrides.NowPlayingItem ?? base.NowPlayingItem,
    };
};

const makeAudiobookItem = (overrides: Partial<AudiobookItem>): AudiobookItem => {
    const base: AudiobookItem = {
        id: 'audiobook-1',
        media: {
            metadata: {
                title: 'Audiobook',
            },
            duration: 0,
        },
    };

    return {
        ...base,
        ...overrides,
        media: {
            ...base.media,
            ...overrides.media,
            metadata: {
                ...base.media.metadata,
                ...overrides.media?.metadata,
            },
        },
    };
};

describe('transformJellyfinToMediaItem', () => {
    it('transforms basic movie data', () => {
        const items: JellyfinItem[] = [
            makeJellyfinItem({
                Id: 'movie-123',
                Name: 'Test Movie',
                Overview: 'A test movie description',
                CommunityRating: 8.5,
                ProductionYear: 2024,
                Genres: ['Action', 'Comedy'],
                RunTimeTicks: 72000000000, // 2 hours in ticks
            }),
        ];

        const result = transformJellyfinToMediaItem(items);

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('movie-123');
        expect(result[0].title).toBe('Test Movie');
        expect(result[0].overview).toBe('A test movie description');
        expect(result[0].rating).toBe(8.5);
        expect(result[0].year).toBe(2024);
        expect(result[0].mediaType).toBe('movie');
    });

    it('transforms TV series data', () => {
        const items: JellyfinItem[] = [
            makeJellyfinItem({
                Id: 'series-456',
                Name: 'Test Series',
                Type: 'Series',
                ChildCount: 3,
            }),
        ];

        const result = transformJellyfinToMediaItem(items);

        expect(result[0].mediaType).toBe('tv');
        expect(result[0].seriesChildCount).toBe(3);
    });

    it('transforms episode data with series info', () => {
        const items: JellyfinItem[] = [
            makeJellyfinItem({
                Id: 'episode-789',
                Name: 'Pilot',
                Type: 'Episode',
                SeriesName: 'Test Series',
                SeriesId: 'series-456',
                ParentIndexNumber: 1,
                IndexNumber: 1,
            }),
        ];

        const result = transformJellyfinToMediaItem(items);

        expect(result[0].mediaType).toBe('episode');
        expect(result[0].seriesName).toBe('Test Series');
        expect(result[0].seriesId).toBe('series-456');
        expect(result[0].seasonNumber).toBe(1);
        expect(result[0].episodeNumber).toBe(1);
    });

    it('handles missing optional fields', () => {
        const items: JellyfinItem[] = [
            makeJellyfinItem({
                Id: 'minimal-item',
                Name: 'Minimal',
                Type: 'Movie',
            }),
        ];

        const result = transformJellyfinToMediaItem(items);

        expect(result[0].id).toBe('minimal-item');
        expect(result[0].title).toBe('Minimal');
        expect(result[0].overview).toBeUndefined();
        expect(result[0].rating).toBeUndefined();
        expect(result[0].year).toBeUndefined();
    });

    it('extracts TMDB ID from provider IDs', () => {
        const items: JellyfinItem[] = [
            makeJellyfinItem({
                Id: 'movie-with-tmdb',
                Name: 'Movie',
                Type: 'Movie',
                ProviderIds: {
                    Tmdb: '12345',
                    Imdb: 'tt1234567',
                },
            }),
        ];

        const result = transformJellyfinToMediaItem(items);

        expect(result[0].externalIds?.tmdb).toBe('12345');
    });

    it('handles user data for watch progress', () => {
        const items: JellyfinItem[] = [
            makeJellyfinItem({
                Id: 'in-progress',
                Name: 'Movie In Progress',
                Type: 'Movie',
                UserData: {
                    PlayedPercentage: 45.5,
                    PlaybackPositionTicks: 32400000000,
                },
            }),
        ];

        const result = transformJellyfinToMediaItem(items);

        expect(result[0].watchProgress).toBe(45.5);
        expect(result[0].playbackPositionTicks).toBe(32400000000);
    });

    it('handles remote trailers', () => {
        const items: JellyfinItem[] = [
            makeJellyfinItem({
                Id: 'movie-trailers',
                Name: 'Movie With Trailers',
                Type: 'Movie',
                RemoteTrailers: [
                    { Url: 'https://youtube.com/watch?v=abc123' },
                    { Url: 'https://youtube.com/watch?v=def456' },
                ],
            }),
        ];

        const result = transformJellyfinToMediaItem(items);

        expect(result[0].remoteTrailers).toHaveLength(2);
        expect(result[0].remoteTrailers).toContain('https://youtube.com/watch?v=abc123');
    });

    it('transforms empty array', () => {
        const result = transformJellyfinToMediaItem([]);
        expect(result).toEqual([]);
    });
});

describe('transformAudiobookToMediaItem', () => {
    it('transforms audiobook data', () => {
        const items: AudiobookItem[] = [
            makeAudiobookItem({
                id: 'audiobook-123',
                media: {
                    metadata: {
                        title: 'Test Audiobook',
                        authorName: 'Test Author',
                        description: 'An audiobook description',
                        publishedYear: '2023',
                    },
                    duration: 36000, // 10 hours in seconds
                },
            }),
        ];

        const result = transformAudiobookToMediaItem(items);

        expect(result).toHaveLength(1);
        expect(result[0].mediaType).toBe('audiobook');
        expect(result[0].id).toBe('audiobook-123');
        expect(result[0].title).toBe('Test Audiobook');
        expect(result[0].author).toBe('Test Author');
        expect(result[0].duration).toBe(36000);
        expect(result[0].year).toBe(2023);
    });

    it('handles missing metadata fields', () => {
        const items: AudiobookItem[] = [
            makeAudiobookItem({
                id: 'minimal-audiobook',
                media: {
                    metadata: {
                        title: 'Minimal Audiobook',
                    },
                    duration: 0,
                },
            }),
        ];

        const result = transformAudiobookToMediaItem(items);

        expect(result[0].title).toBe('Minimal Audiobook');
        // safeString returns empty string for undefined values
        expect(result[0].author).toBe('');
        expect(result[0].overview).toBeUndefined();
    });

    it('generates correct image URL', () => {
        const items: AudiobookItem[] = [
            makeAudiobookItem({
                id: 'audiobook-456',
                media: {
                    metadata: { title: 'Test' },
                    duration: 0,
                },
            }),
        ];

        const result = transformAudiobookToMediaItem(items);

        // Uses 'audiobook' as service name in URL
        expect(result[0].imageUrl).toBe('/api/image/audiobook/audiobook-456');
    });
});

describe('transformSonarrToMediaItem', () => {
    it('transforms TV episode from Sonarr', () => {
        const items: SonarrCalendarEntry[] = [
            {
                id: 123,
                title: 'Episode Title',
                overview: 'Episode description',
                seasonNumber: 2,
                episodeNumber: 5,
                absoluteEpisodeNumber: 25,
                hasFile: true,
                airDateUtc: '2024-03-15T20:00:00Z',
                series: {
                    id: 456,
                    title: 'Series Title',
                    network: 'Lanternbox',
                },
                episodeFile: {
                    quality: { quality: { name: '1080p' } },
                    mediaInfo: {
                        audioLanguages: ['English'],
                        subtitles: ['English'],
                    },
                },
            },
        ];

        const result = transformSonarrToMediaItem(items);

        expect(result).toHaveLength(1);
        expect(result[0].mediaType).toBe('sonarr');
        expect(result[0].id).toBe('123');
        expect(result[0].title).toBe('Episode Title');
        expect(result[0].seriesName).toBe('Series Title');
        expect(result[0].seasonNumber).toBe(2);
        expect(result[0].episodeNumber).toBe(5);
        expect(result[0].sonarrAbsoluteEpisode).toBe(25);
        expect(result[0].sonarrSeriesId).toBe(456);
        expect(result[0].sonarrNetwork).toBe('Lanternbox');
        expect(result[0].sonarrQuality).toBe('1080p');
        expect(result[0].sonarrHasFile).toBe(true);
        expect(result[0].isAvailable).toBe(false);
        expect(result[0].canRequest).toBe(false); // hasFile is true
    });

    it('keeps sonarrSeriesId a genuine NUMERIC Sonarr id on this producer', () => {
        // The other producer of a field called `sonarrSeriesId` — the DB-backed
        // /api/calendar def — emits a `media_items` UUID string under that name
        // (now also, honestly, as `seriesMediaId`). This one is the real Sonarr
        // id, and must stay numeric: `/api/image/sonarr/{id}` and the
        // `sonarr:<id>:series` composite key both depend on it.
        const items: SonarrCalendarEntry[] = [
            {
                id: 123,
                title: 'Episode Title',
                seasonNumber: 2,
                episodeNumber: 5,
                hasFile: false,
                airDateUtc: '2024-03-15T20:00:00Z',
                series: { id: 456, title: 'Series Title' },
            },
        ];

        const result = transformSonarrToMediaItem(items);

        expect(typeof result[0].sonarrSeriesId).toBe('number');
        expect(result[0].sonarrSeriesId).toBe(456);
    });

    it('transforms movie from Radarr', () => {
        const items: SonarrCalendarEntry[] = [
            {
                id: 789,
                title: 'Movie Title',
                overview: 'Movie description',
                year: 2024,
                hasFile: false,
                inCinemas: '2024-01-15',
                physicalRelease: '2024-04-15',
                digitalRelease: '2024-04-01',
            },
        ];

        const result = transformSonarrToMediaItem(items);

        expect(result[0].mediaType).toBe('movie');
        expect(result[0].year).toBe(2024);
        expect(result[0].inCinemas).toBe('2024-01-15');
        expect(result[0].physicalRelease).toBe('2024-04-15');
        expect(result[0].digitalRelease).toBe('2024-04-01');
        expect(result[0].canRequest).toBe(true); // hasFile is false
    });

    it('extracts year from release dates when year not provided', () => {
        const items: SonarrCalendarEntry[] = [
            {
                id: 101,
                title: 'Movie Without Year',
                hasFile: false,
                inCinemas: '2023-06-15',
            },
        ];

        const result = transformSonarrToMediaItem(items);

        expect(result[0].year).toBe(2023);
    });

    it('prefers year field over extracted dates', () => {
        const items: SonarrCalendarEntry[] = [
            {
                id: 102,
                title: 'Movie With Both',
                year: 2024,
                hasFile: false,
                inCinemas: '2023-12-15', // Different year
            },
        ];

        const result = transformSonarrToMediaItem(items);

        expect(result[0].year).toBe(2024);
    });

    it('handles missing release dates', () => {
        const items: SonarrCalendarEntry[] = [
            {
                id: 103,
                title: 'Movie No Dates',
                hasFile: false,
            },
        ];

        const result = transformSonarrToMediaItem(items);

        expect(result[0].year).toBeUndefined();
    });
});

describe('transformSearchResultToMediaItem', () => {
    it('transforms movie search result', () => {
        const items: SearchResult[] = [
            {
                id: 123,
                tmdbId: 456,
                title: 'Search Result Movie',
                overview: 'Found movie',
                year: 2024,
                genres: ['Action', 'Thriller'],
                movieFile: { id: 1 },
                ratings: {
                    tmdb: { value: 7.5 },
                    imdb: { value: 7.8 },
                },
            },
        ];

        const result = transformSearchResultToMediaItem(items);

        expect(result[0].mediaType).toBe('movie');
        expect(result[0].id).toBe('123'); // Internal Radarr ID
        expect(result[0].externalIds).toEqual({ tmdb: '456' }); // External IDs
        expect(result[0].title).toBe('Search Result Movie');
        expect(result[0].year).toBe(2024);
        expect(result[0].genres).toEqual(['Action', 'Thriller']);
        // IMDB now takes precedence over TMDB (no vote_count available on this
        // Radarr/Sonarr shape to gate the TMDB fallback — see transformers.ts).
        expect(result[0].rating).toBe(7.8);
    });

    it('transforms TV series search result', () => {
        const items: SearchResult[] = [
            {
                id: 789,
                tvdbId: 101112,
                title: 'Search Result Series',
                overview: 'Found series',
                year: 2023,
            },
        ];

        const result = transformSearchResultToMediaItem(items);

        expect(result[0].mediaType).toBe('tv');
        expect(result[0].id).toBe('789'); // Internal Sonarr ID
        expect(result[0].externalIds).toEqual({ tvdb: '101112' }); // External IDs
    });

    it('falls back to IMDB rating when TMDB unavailable', () => {
        const items: SearchResult[] = [
            {
                id: 123,
                title: 'Movie',
                movieFile: { id: 1 },
                ratings: {
                    imdb: { value: 8.0 },
                },
            },
        ];

        const result = transformSearchResultToMediaItem(items);

        expect(result[0].rating).toBe(8.0);
    });

    it('handles missing IDs gracefully', () => {
        const items: SearchResult[] = [
            {
                id: 999,
                title: 'No External IDs',
                movieFile: { id: 1 },
            },
        ];

        const result = transformSearchResultToMediaItem(items);

        expect(result[0].id).toBe('999');
    });
});

describe('transformJellyfinSessionToStreamSession', () => {
    it('transforms active streaming session', () => {
        const sessions: JellyfinSession[] = [
            makeJellyfinSession({
                Id: 'session-123',
                UserName: 'TestUser',
                Client: 'Jellyfin Web',
                ApplicationVersion: '10.8.0',
                DeviceName: 'Chrome',
                NowPlayingItem: makeJellyfinItem({
                    Id: 'movie-456',
                    Name: 'Streaming Movie',
                    Overview: 'Currently watching',
                    Type: 'Movie',
                    ProductionYear: 2024,
                    RunTimeTicks: 72000000000,
                    MediaStreams: [
                        {
                            Type: 'Video',
                            Codec: 'hevc',
                            BitRate: 15000000,
                            Width: 1920,
                            Height: 1080,
                            Index: 0,
                        },
                        {
                            Type: 'Audio',
                            Codec: 'aac',
                            BitRate: 256000,
                            IsDefault: true,
                            Index: 1,
                        },
                    ],
                }),
                PlayState: {
                    PositionTicks: 18000000000, // 30 minutes
                },
            }),
        ];

        const result = transformJellyfinSessionToStreamSession(sessions);

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('session-123');
        expect(result[0].jellyfinId).toBe('movie-456');
        expect(result[0].title).toBe('Streaming Movie');
        expect(result[0].mediaType).toBe('movie');
        expect(result[0].username).toBe('TestUser');
        expect(result[0].clientname).toBe('Jellyfin Web 10.8.0');
        expect(result[0].browsername).toBe('Chrome');
        expect(result[0].playMethod).toBe('direct');
        expect(result[0].playIsPlaying).toBe(true);
        expect(result[0].playOriginalCodec).toBe('hevc');
        expect(result[0].playOriginalAudioCodec).toBe('aac');
    });

    it('calculates stream progress correctly', () => {
        const sessions: JellyfinSession[] = [
            makeJellyfinSession({
                Id: 'session-progress',
                UserName: 'User',
                NowPlayingItem: makeJellyfinItem({
                    Id: 'movie',
                    Name: 'Movie',
                    Type: 'Movie',
                    RunTimeTicks: 72000000000, // 2 hours
                }),
                PlayState: {
                    PositionTicks: 36000000000, // 1 hour = 50%
                },
            }),
        ];

        const result = transformJellyfinSessionToStreamSession(sessions);

        expect(result[0].streamProgress).toBeCloseTo(50, 1);
    });

    it('includes transcoding information', () => {
        const sessions: JellyfinSession[] = [
            makeJellyfinSession({
                Id: 'session-transcode',
                UserName: 'User',
                NowPlayingItem: makeJellyfinItem({
                    Id: 'movie',
                    Name: 'Movie',
                    Type: 'Movie',
                }),
                TranscodingInfo: {
                    VideoCodec: 'h264',
                    AudioCodec: 'aac',
                    Bitrate: 8000000,
                    IsVideoDirect: false,
                    IsAudioDirect: true,
                    Width: 1280,
                    Height: 720,
                    VideoRange: 'SDR',
                    TranscodeReasons: ['VideoCodecNotSupported'],
                },
            }),
        ];

        const result = transformJellyfinSessionToStreamSession(sessions);

        expect(result[0].playIsTranscoding).toBe(true);
        expect(result[0].playTranscodeCodec).toBe('h264');
        expect(result[0].playTranscodeBitrate).toBe(8000000);
        expect(result[0].playTranscodeReasons).toContain('VideoCodecNotSupported');
    });

    it('filters out sessions without NowPlayingItem', () => {
        const sessions: JellyfinSession[] = [
            makeJellyfinSession({
                Id: 'session-idle',
                UserName: 'IdleUser',
                NowPlayingItem: makeJellyfinItem({
                    Id: '',
                    Name: '',
                }),
            }),
            makeJellyfinSession({
                Id: 'session-active',
                UserName: 'ActiveUser',
                NowPlayingItem: makeJellyfinItem({
                    Id: 'movie',
                    Name: 'Movie',
                    Type: 'Movie',
                }),
            }),
        ];

        const result = transformJellyfinSessionToStreamSession(sessions);

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('session-active');
    });

    it('filters out sessions without username', () => {
        const sessions: JellyfinSession[] = [
            makeJellyfinSession({
                Id: 'session-no-user',
                UserName: '',
                NowPlayingItem: makeJellyfinItem({
                    Id: 'movie',
                    Name: 'Movie',
                    Type: 'Movie',
                }),
            }),
        ];

        const result = transformJellyfinSessionToStreamSession(sessions);

        expect(result).toHaveLength(0);
    });

    it('handles episode with series info', () => {
        const sessions: JellyfinSession[] = [
            makeJellyfinSession({
                Id: 'session-episode',
                UserName: 'User',
                NowPlayingItem: makeJellyfinItem({
                    Id: 'episode-123',
                    Name: 'Episode Name',
                    Type: 'Episode',
                    SeriesName: 'Series Name',
                    SeriesId: 'series-456',
                    ParentIndexNumber: 2,
                    IndexNumber: 5,
                }),
            }),
        ];

        const result = transformJellyfinSessionToStreamSession(sessions);

        expect(result[0].mediaType).toBe('episode');
        expect(result[0].seriesName).toBe('Series Name');
        expect(result[0].seriesId).toBe('series-456');
        expect(result[0].seasonNumber).toBe(2);
        expect(result[0].episodeNumber).toBe(5);
    });
});

describe('transformJellyseerrToMediaItem', () => {
    it('transforms movie request', () => {
        const items: JellyseerrSearchResult[] = [
            {
                id: 12345,
                title: 'Requested Movie',
                overview: 'A movie to request',
                releaseDate: '2024-06-15',
                posterPath: '/abc123.jpg',
                status: 3, // Pending status
                mediaType: 'movie',
            },
        ];

        const result = transformJellyseerrToMediaItem(items);

        expect(result).toHaveLength(1);
        expect(result[0].mediaType).toBe('anfragen');
        expect(result[0].id).toBe('12345');
        expect(result[0].title).toBe('Requested Movie');
        expect(result[0].year).toBe(2024);
        expect(result[0].requestStatus).toBe('processing');
        expect(result[0].requestMediaType).toBe('movie');
        expect(result[0].imageUrl).toBe('/api/image/tmdb:12345:movie/poster');
        expect(result[0].externalIds?.tmdb).toBe('12345');
    });

    it('transforms TV series request', () => {
        const items: JellyseerrSearchResult[] = [
            {
                id: 67890,
                name: 'Requested Series',
                overview: 'A series to request',
                firstAirDate: '2023-01-10',
                posterPath: '/xyz789.jpg',
                status: 5, // Available status
                mediaType: 'tv',
            },
        ];

        const result = transformJellyseerrToMediaItem(items);

        expect(result[0].title).toBe('Requested Series');
        expect(result[0].year).toBe(2023);
        expect(result[0].requestMediaType).toBe('tv');
    });

    it('handles missing poster path', () => {
        const items: JellyseerrSearchResult[] = [
            {
                id: 111,
                title: 'No Poster',
                mediaType: 'movie',
            },
        ];

        const result = transformJellyseerrToMediaItem(items);

        expect(result[0].imageUrl).toBeUndefined();
    });

    it('handles missing title gracefully', () => {
        const items: JellyseerrSearchResult[] = [
            {
                id: 222,
                mediaType: 'movie',
            },
        ];

        const result = transformJellyseerrToMediaItem(items);

        expect(result[0].title).toBe('Unknown Title');
    });

    it('transforms genre IDs when available', () => {
        const items: JellyseerrSearchResult[] = [
            {
                id: 333,
                title: 'Movie With Genres',
                mediaType: 'movie',
                genre_ids: [28, 12, 878], // Action, Adventure, Sci-Fi
            },
        ];

        const result = transformJellyseerrToMediaItem(items);

        expect(result[0].genres).toBeDefined();
        expect(result[0].genres).toContain('Action');
        expect(result[0].genres).toContain('Adventure');
        expect(result[0].genres).toContain('Science Fiction');
    });

    it('uses title over name when both present', () => {
        const items: JellyseerrSearchResult[] = [
            {
                id: 444,
                title: 'Primary Title',
                name: 'Secondary Name',
                mediaType: 'movie',
            },
        ];

        const result = transformJellyseerrToMediaItem(items);

        expect(result[0].title).toBe('Primary Title');
    });
});
