// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/** Shared by the real-DB guard and its route-inventory completeness check.
 * Tokens are resolved from the same seeded catalog for every protocol.
 * `positive` is mandatory: a 200 with no media must never prove the invariant.
 */
export interface Surface {
    route: string;
    method?: 'GET' | 'POST';
    body?: Record<string, unknown>;
    query?: Record<string, string>;
    positive: string[];
    positiveOneOf?: string[];
    emptyReason?: string;
}
const surface = (
    route: string,
    positive: string[],
    query?: Record<string, string>,
    emptyReason?: string,
): Surface => ({ route, positive, query, emptyReason });

export const surfaces: Surface[] = [
    surface('api/v1/search', ['movie', 'tv', 'track', 'album', 'audiobook'], {
        q: 'Availguard',
        limit: '100',
    }),
    surface('api/v1/search/suggest', ['movie'], { q: 'Availguard', limit: '20' }),
    surface('api/search/episodes', ['episode'], { q: 'Availguard' }),
    surface('api/series/search', ['tv'], { name: 'Availguard available tv' }),
    surface('api/v1/media', ['movie', 'tv']),
    surface('api/v1/browse', ['movie', 'tv']),
    surface('api/keyword-movies', ['movie', 'tv'], { keyword: 'friendship' }),
    surface('api/browse/recent', ['movie', 'tv']),
    surface('api/browse/az', ['movie', 'tv'], { letter: 'A' }),
    surface('api/v1/music/artists', ['artist']),
    surface('api/v1/music/albums', ['album']),
    surface('api/v1/music/tracks', ['track']),
    surface('api/v1/music/artists/[id]', ['album', 'track'], { $id: 'artist' }),
    surface('api/v1/music/albums/[id]', ['track'], { $id: 'album' }),
    surface('api/music/albums/[id]/series', ['album'], { $id: 'album' }),
    surface('api/v1/music', ['album']),
    ...['movie', 'series', 'episode', 'album', 'artist', 'track', 'audiobook'].map((type) =>
        surface('api/v1/search', [type === 'series' ? 'tv' : type], {
            q: 'Availguard',
            types: type,
            limit: '100',
        }),
    ),
    {
        route: 'api/v1/music/sonic-mixes',
        positive: ['cluster'],
    },
    surface('api/v1/music/sonic-mixes/[id]/tracks', ['track'], { $id: '1' }),
    surface('api/music/map', ['track']),
    {
        route: 'api/music/alchemy/brew',
        method: 'POST',
        body: { seedIds: ['$track'], limit: 50 },
        positive: [],
        positiveOneOf: ['neighborTrack', 'extraTrack1', 'extraTrack2', 'extraTrack3'],
    },
    {
        route: 'api/v1/music/path',
        positive: [],
        positiveOneOf: ['extraTrack1', 'extraTrack2', 'extraTrack3', 'volumeTrack'],
        query: {
            from: '$track',
            to: '$neighborTrack',
            steps: '2',
        },
    },
    surface('api/v1/music/sonic-fingerprint', ['neighborTrack']),

    surface('api/v1/music/text-search', ['track'], { q: 'Availguard' }),
    surface('api/v1/music/lyrics-search', ['track'], { q: 'Availguard' }),
    {
        route: 'api/v1/music/quick-picks',
        method: 'POST',
        body: { limit: 48 },
        positive: ['neighborTrack'],
    },
    {
        route: 'api/v1/music/recommendations',
        method: 'POST',
        body: { context: { currentTrackId: '$track' } },
        positive: [],
        positiveOneOf: ['neighborTrack', 'extraTrack1', 'extraTrack2', 'extraTrack3'],
    },

    surface('api/v1/audiobooks', ['audiobook']),
    surface('api/v1/lists/[id]', ['movie'], { $id: 'trending-movies' }),
    surface('api/lists/[list_id]', ['movie'], { $list_id: 'trending-movies' }),
    surface('api/me/series-follows', ['tv']),
    surface('api/user/series', ['tv']),
    surface('api/v1/music/downloads/candidates', ['track'], { lane: 'rotation', want: '50' }),
    surface('api/v1/series/downloads/candidates', ['nextEpisode'], {
        lane: 'series-next-up',
        budgetBytes: '8589934592',
        rung: '720p',
    }),
    surface('api/v1/trending', ['movie']),
    surface('api/upcoming', ['futureEpisode']),
    surface('api/calendar', ['calendarMovie']),
    surface('api/recommendations/holiday', ['movie']),
    surface('api/mood-recommendations', ['tv'], { mood: 'relaxing' }),
    {
        route: 'api/for-you/similar',
        query: { key: '$movie' },
        positive: [],
        positiveOneOf: ['extraMovie1', 'extraMovie2', 'extraMovie3'],
    },
    surface('api/v1/me/music/taste-stations/[id]/tracks', ['neighborTrack'], {
        $id: 'abcdef123456.0',
    }),
    surface('api/v1/watchlist', ['movie', 'tv', 'audiobook']),
    surface('api/v1/playlists/[id]/items', ['track'], { $id: 'playlist' }),
    surface('api/v1/playlists/[id]/suggestions', ['volumeTrack'], { $id: 'playlist' }),
    surface('api/playlists/[id]/playback-context', ['track'], {
        $id: 'playlist',
        mediaId: '$track',
    }),
    {
        route: 'api/v1/media/[id]/similar',
        query: { $id: 'movie', minSimilarity: '0' },
        positive: [],
        positiveOneOf: ['extraMovie1', 'extraMovie2', 'extraMovie3'],
    },

    ...['authors', 'narrators', 'series'].flatMap((resource) => [
        surface('api/v1/audiobooks/' + resource, [resource]),
        surface('api/v1/audiobooks/' + resource + '/[id]', [resource], { $id: resource }),
        surface('api/v1/audiobooks/' + resource + '/[id]/books', ['audiobook'], { $id: resource }),
    ]),
    surface('api/v1/people/[id]', ['movie', 'tv'], { $id: '9700999' }),
    surface('api/person/[personId]', ['movie', 'tv'], { $personId: '9700999' }),
    surface('api/movie/search', ['movie'], { name: 'Availguard available movie' }),
    surface('api/v1/music/artists/[id]/similar', ['neighborArtist'], { $id: 'artist' }),
    surface('api/v1/music/albums/[id]/similar', ['neighborAlbum'], { $id: 'album' }),
    surface('api/v1/music/tracks/[id]/similar', ['neighborTrack'], { $id: 'track' }),
    surface('api/music/artists/[id]/summary', ['artist'], { $id: 'artist' }),
    surface('api/music/albums/[id]/summary', ['album'], { $id: 'album' }),
    surface('api/v1/music/sections/mood-shelf', ['track'], { mood: 'chill' }),
    surface('api/music/sections/mood-recommendations', ['track'], { mood: 'chill' }),
    surface('api/recommendations', ['movie'], { type: 'movies' }),
    surface('api/for-you/watching/sources', ['extraMovie3']),

    surface('api/browse/genre/[name]', ['movie'], { $name: 'Drama' }),
    surface('api/browse/keywords', ['movie'], { limit: '20' }),
    surface('api/for-you/keywords', ['movie']),
    surface('api/for-you/explore-keywords', ['keyword']),
    {
        route: 'api/for-you/featured-pick',
        positive: [],
        // Selection may rotate across every seeded available movie or series.
        positiveOneOf: [
            'movie',
            'tv',
            'neighborTv',
            'extraMovie1',
            'extraMovie2',
            'extraMovie3',
            'extraMovie4',
            'extraMovie5',
        ],
    },
    ...[
        'anime',
        'binge-worthy',
        'fresh-releases',
        'fulfilled-requests',
        'popular-shows',
        'short-movies',
        'taste',
        'trending',
        'music-because',
        'music-quick-picks',
        'new-episodes',
    ].map((rail) =>
        ['music-because', 'music-quick-picks'].includes(rail)
            ? {
                  route: 'api/for-you/' + rail,
                  positive: [],
                  positiveOneOf: [
                      'track',
                      'neighborTrack',
                      'extraTrack1',
                      'extraTrack2',
                      'extraTrack3',
                      'extraTrack4',
                      'extraTrack5',
                      'volumeTrack',
                  ],
              }
            : surface(
                  'api/for-you/' + rail,
                  [
                      (
                          {
                              anime: 'extraMovie1',
                              'binge-worthy': 'neighborTv',
                              'popular-shows': 'neighborTv',
                              'music-because': 'extraTrack1',
                              'music-quick-picks': 'track',
                              'new-episodes': 'tv',
                          } as Record<string, string>
                      )[rail] ?? 'movie',
                  ],
                  {},
              ),
    ),
    surface('api/v1/series/[id]/episodes', ['episode'], { $id: 'tv' }),
    surface('api/v1/series/[id]/seasons', ['season'], { $id: 'tv' }),
    surface('api/v1/series/[id]/next-episode', ['nextEpisode'], { $id: 'tv' }),
    surface('api/v1/music/sections/genre/[name]', ['track'], { $name: 'Drama' }),
    surface('api/v1/music/sections/new-for-you', ['neighborTrack']),
    surface('api/v1/music/sections/because-you-listened', ['neighborTrack']),
    surface('api/v1/music/sections/smart-mixes', ['track']),
    surface('api/v1/me/music/recently-played', ['track']),
    surface('api/v1/me/music/top-tracks', ['track']),
    surface('api/v1/me/music/top-artists', ['artist']),

    surface('api/v1/continue-watching', ['movie']),
    surface('api/for-you/watching', ['movie']),
    surface('api/for-you/recently-added', ['movie']),
    surface('api/for-you/random-picks', ['movie']),
    surface('api/v1/feed', ['movie'], { sections: 'recently-added,watching,random-picks' }),
    ...[
        'recently-added',
        'random-picks',
        'short-movies',
        'popular-shows',
        'fresh-releases',
        'binge-worthy',
        'anime',
        'for-you',
        'ai',
        'trending',
        'editorial',
        'because-you-watched',
        'fulfilled-requests',
        'mood',
        'from-your-ratings',
    ].map((type) =>
        surface(
            'api/v1/recommendations',
            [
                (
                    {
                        anime: 'extraMovie1',
                        'binge-worthy': 'neighborTv',
                        'popular-shows': 'neighborTv',
                        'because-you-watched': 'extraMovie1',
                        mood: 'tv',
                    } as Record<string, string>
                )[type] ?? 'movie',
            ],
            { type, limit: '50', ...(type === 'mood' ? { mood: 'relaxing' } : {}) },
        ),
    ),
    surface('(proprietary)/j/Items', ['track', 'album'], {
        Recursive: 'true',
        IncludeItemTypes: 'Audio,MusicAlbum',
        Limit: '100',
    }),
    surface('(proprietary)/j/Items', ['movie', 'tv'], {
        Recursive: 'true',
        IncludeItemTypes: 'Movie,Series',
        Limit: '100',
    }),
    surface('(proprietary)/j/Items', ['movie'], {
        SearchTerm: 'Availguard',
        Recursive: 'true',
        IncludeItemTypes: 'Movie',
        Limit: '100',
    }),
    surface('(proprietary)/j/Search/Hints', ['movie'], { SearchTerm: 'Availguard', Limit: '100' }),
    surface('(proprietary)/j/Items/Latest', ['movie'], { IncludeItemTypes: 'Movie', Limit: '100' }),
    surface('(proprietary)/j/UserItems/Resume', ['movie'], {
        IncludeItemTypes: 'Movie',
        Limit: '100',
    }),
    surface('(proprietary)/j/Shows/NextUp', ['nextEpisode']),
    surface('(proprietary)/j/Users/[userId]/Items', ['movie'], {
        $userId: 'userId',
        Recursive: 'true',
        IncludeItemTypes: 'Movie',
        Limit: '100',
    }),
    surface('(proprietary)/j/Users/[userId]/Items/Latest', ['movie'], {
        $userId: 'userId',
        IncludeItemTypes: 'Movie',
    }),
    surface('(proprietary)/j/Users/[userId]/Items/Resume', ['movie'], {
        $userId: 'userId',
        IncludeItemTypes: 'Movie',
    }),
    surface('(proprietary)/j/Shows/[seriesId]/Episodes', ['episode'], { $seriesId: 'tv' }),
    surface('(proprietary)/j/Shows/[seriesId]/Seasons', ['season'], { $seriesId: 'tv' }),
    surface('(proprietary)/j/Items/Suggestions', ['movie']),
    surface('(proprietary)/j/Users/[userId]/Suggestions', ['movie'], { $userId: 'userId' }),
    {
        route: '(proprietary)/j/Movies/Recommendations',
        positive: [],
        positiveOneOf: ['movie', 'extraMovie1', 'extraMovie2'],
    },
    surface('(proprietary)/j/Artists', ['artist']),
    surface('(proprietary)/j/Artists/InstantMix', ['neighborTrack'], { Id: '$artist' }),
    surface('(proprietary)/j/Artists/[name]/InstantMix', ['neighborTrack'], { $name: 'artist' }),
    surface('(proprietary)/j/MusicGenres/InstantMix', ['neighborTrack'], { Id: '$track' }),
    surface('(proprietary)/j/MusicGenres/[name]/InstantMix', ['track'], { $name: 'Drama' }),
    surface('(proprietary)/j/Playlists/[playlistId]/InstantMix', ['track'], {
        $playlistId: 'playlistJellyfin',
    }),
    surface('(proprietary)/j/Playlists/[playlistId]/Items', ['track'], {
        $playlistId: 'playlistJellyfin',
    }),
    surface('(proprietary)/j/Artists/AlbumArtists', ['artist']),
    {
        route: '(proprietary)/j/Items/[itemId]/Similar',
        query: { $itemId: 'movie' },
        positive: [],
        positiveOneOf: ['extraMovie1', 'extraMovie2', 'extraMovie3'],
    },
    {
        route: '(proprietary)/j/Movies/[itemId]/Similar',
        query: { $itemId: 'movie' },
        positive: [],
        positiveOneOf: ['extraMovie1', 'extraMovie2', 'extraMovie3'],
    },
    surface('(proprietary)/j/Shows/[seriesId]/Similar', ['neighborTv'], { $seriesId: 'tv' }),
    surface('(proprietary)/j/Albums/[itemId]/Similar', ['neighborAlbum'], { $itemId: 'album' }),
    surface('(proprietary)/j/Artists/[name]/Similar', ['neighborArtist'], { $name: 'artist' }),
    ...['Items/[itemId]', 'Songs/[itemId]', 'Albums/[itemId]'].map((prefix) =>
        surface('(proprietary)/j/' + prefix + '/InstantMix', ['neighborTrack'], {
            $itemId: prefix.startsWith('Albums') ? 'album' : 'track',
        }),
    ),
];

export const subsonicSurfaces: Surface[] = [
    surface('search3', ['album', 'track'], {
        query: 'Availguard',
        songCount: '100',
        albumCount: '100',
    }),
    surface('search3', ['album', 'track'], { query: '', songCount: '100', albumCount: '100' }),
    surface('search2', ['album', 'track'], { query: 'Availguard' }),
    surface('getAlbumList2', ['album'], { type: 'newest', size: '100' }),
    ...[
        'alphabeticalByName',
        'alphabeticalByArtist',
        'byGenre',
        'recent',
        'frequent',
        'random',
        'starred',
    ].map((type) => surface('getAlbumList2', ['album'], { type, size: '100', genre: 'Drama' })),

    surface('getAlbumList', ['album'], { type: 'newest', size: '100' }),
    surface('getRandomSongs', ['track'], { size: '100' }),
    surface('getArtist', ['album'], { id: '$artist' }),
    surface('getAlbum', ['track'], { id: '$album' }),
    surface('getMusicDirectory', ['album'], { id: '$artist' }),
    surface('getArtists', ['artist']),
    surface('getIndexes', ['artist']),
    surface('getSongsByGenre', ['track'], { genre: 'Drama', count: '100' }),
    surface('getTopSongs', ['track'], { artist: 'Availguard available artist', count: '100' }),
    surface(
        'search',
        [],
        { query: 'Availguard' },
        'Deprecated search is an explicitly empty protocol stub.',
    ),
    surface('getStarred2', ['album', 'track']),
    surface('getStarred', ['album', 'track']),
    surface('getPlaylist', ['track'], { id: '$playlistSubsonic' }),
    surface(
        'getArtistInfo2',
        [],
        { id: '$artist' },
        'Artist info returns biography with an explicitly empty similarArtist protocol stub.',
    ),
    surface('getArtistInfo', [], { id: '$artist' }, 'Legacy alias of artist info.'),
    surface('getBookmarks', ['track']),
    surface('getPlayQueue', ['track']),
    surface('getPlayQueueByIndex', ['track']),
    surface('getSonicSimilarTracks', ['neighborTrack'], { id: '$track', count: '100' }),
    {
        route: 'findSonicPath',
        query: { startSongId: '$track', endSongId: '$neighborTrack', count: '100' },
        positive: [],
        positiveOneOf: ['extraTrack1', 'extraTrack2', 'extraTrack3', 'volumeTrack'],
    },
    surface('getSimilarSongs2', ['neighborTrack'], { id: '$track', count: '100' }),
    surface('getSimilarSongs', ['neighborTrack'], { id: '$track', count: '100' }),
];
