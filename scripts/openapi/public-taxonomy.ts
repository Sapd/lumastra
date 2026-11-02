// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The public API reference's table of contents: every operation of
 * `docs/api/api-v1.yaml` in exactly one tag, tags in reading order inside
 * groups, and the operationId each operation gets.
 *
 * The generator applies this to the public spec (and the same operations in
 * the combined spec): `tags`, `operationId`, the top-level `tags` order and
 * `x-tagGroups` all come from here. A def's own `tags`/`operationId` only
 * apply to the internal spec. Generation fails when a public operation is
 * missing here, an entry here matches no operation, or an operationId breaks
 * the rules in `OPERATION_ID_RULE` / `OPERATION_ID_VERBS`.
 *
 * operationIds are the method names of every generated client (Swift, TS,
 * third parties). Pick them by hand: verbNoun, domain nouns, no path-param
 * names. Never rename one after 0.1 without the deprecation process
 * (docs/api/API.md, "Stability and deprecation").
 * `public-operation-ids.lock.json` pins every id; its test fails on a rename,
 * a removal or a new operation without a lock line.
 *
 * Keys are `METHOD path` with the `/api/v1` prefix removed.
 * Design: docs/superpowers/specs/2026-10-20-api-package-7-taxonomy-design.md
 */

export interface TaxonomyTag {
    name: string;
    description: string;
    /** `METHOD path` → operationId */
    operations: Record<string, string>;
}

export interface TaxonomyGroup {
    name: string;
    tags: TaxonomyTag[];
}

/** camelCase, starts with a lowercase verb, then at least one capitalised word. */
export const OPERATION_ID_RULE = /^[a-z]+[A-Z][A-Za-z0-9]*$/;

/** Leading verbs an operationId may use. */
export const OPERATION_ID_VERBS = [
    'list',
    'get',
    'create',
    'update',
    'set',
    'clear',
    'delete',
    'remove',
    'add',
    'start',
    'stop',
    'cancel',
    'renew',
    'refresh',
    'revoke',
    'keepAlive',
    'leave',
    'search',
    'report',
    'upload',
    'download',
    'stream',
    'check',
    'request',
    'exchange',
    'sign',
    'browse',
    'dismiss',
    'restore',
    'hide',
    'mark',
    'follow',
    'unfollow',
    'link',
    'unlink',
    'authorize',
    'subscribe',
    'send',
    'run',
    'retry',
    'reset',
    'replace',
    'reorder',
    'test',
    'verify',
    'rescore',
    'ingest',
    'accept',
    'respond',
    'shuffle',
    'grant',
    'recommend',
    'pin',
    'unpin',
] as const;

export const PUBLIC_TAXONOMY: TaxonomyGroup[] = [
    {
        name: 'Getting started',
        tags: [
            {
                name: 'Server',
                description:
                    'Start here: discover a server, its version, capabilities and sign-in methods, with or without a token.',
                operations: {
                    'GET /server': 'getServer',
                    'GET /server/notice': 'getServerNotice',
                },
            },
            {
                name: 'Authentication',
                description:
                    'Sign in with the OAuth device flow (RFC 8628), refresh tokens, and sign out.',
                operations: {
                    'HEAD /oauth/device': 'checkDeviceAuthorization',
                    'POST /oauth/device': 'requestDeviceAuthorization',
                    'POST /oauth/token': 'exchangeToken',
                    'POST /auth/logout': 'signOut',
                    'GET /oauth/device/approve': 'getPendingDeviceSignIn',
                    'POST /oauth/device/approve': 'authorizeDeviceSignIn',
                },
            },
            {
                name: 'Me',
                description:
                    'The signed-in user: profile, playback and language preferences, linked accounts, personal access tokens and viewing stats.',
                operations: {
                    'GET /me': 'getProfile',
                    'GET /me/playback-preferences': 'getPlaybackPreferences',
                    'PATCH /me/playback-preferences': 'setPlaybackPreferences',
                    'GET /me/links': 'listLinkedAccounts',
                    'GET /me/links/{provider}': 'getLinkedAccount',
                    'DELETE /me/links/{provider}': 'unlinkAccount',
                    'POST /me/links/{provider}/authorize': 'startAccountLink',
                    'GET /me/pats': 'listMyAccessTokens',
                    'POST /me/pats': 'createMyAccessToken',
                    'DELETE /me/pats/{id}': 'revokeMyAccessToken',
                    'GET /me/stats': 'getMyStats',
                    'GET /me/privacy': 'getMyPrivacy',
                    'PATCH /me/privacy': 'updateMyPrivacy',
                    'GET /me/resume-handoff': 'getMyResumeHandoff',
                },
            },
            {
                name: 'Live updates',
                description:
                    'One server-sent event stream per signed-in client: library, progress, notification and device changes as they happen.',
                operations: {
                    'GET /events': 'subscribeEvents',
                },
            },
        ],
    },
    {
        name: 'Library',
        tags: [
            {
                name: 'Media',
                description:
                    'Movies and series by id: list the library A–Z, read details, find similar titles.',
                operations: {
                    'GET /media': 'listMedia',
                    'POST /media/batch': 'listMediaByHandles',
                    'GET /media/{id}': 'getMediaItem',
                    'GET /media/{id}/context': 'getMediaContext',
                    'GET /media/{id}/similar': 'listSimilarMedia',
                },
            },
            {
                name: 'Browse',
                description: 'Browse by library, category, genre, tag and keyword.',
                operations: {
                    'GET /browse': 'browseMedia',
                    'GET /browse/genres': 'listGenres',
                    'GET /browse/libraries': 'listLibraries',
                    'GET /browse/tags': 'searchKeywords',
                    'GET /keywords': 'listKeywords',
                },
            },
            {
                name: 'Series',
                description:
                    'Walk a series: seasons, episodes in order, next episode, episode by number, and per-episode watch status.',
                operations: {
                    'GET /series/{id}': 'getSeries',
                    'GET /series/{id}/seasons': 'listSeasons',
                    'GET /series/{id}/seasons/{n}': 'getSeasonByNumber',
                    'GET /series/{id}/seasons/{n}/episodes/{e}': 'getEpisodeByNumber',
                    'GET /series/{id}/episodes': 'listSeriesEpisodes',
                    'GET /series/{id}/next-episode': 'getNextEpisode',
                    'GET /series/{id}/watch-marker': 'getSeriesWatchMarker',
                    'GET /series/{id}/watch-status': 'getSeriesWatchStatus',
                    'GET /seasons/{id}': 'getSeason',
                    'GET /episodes/{id}': 'getEpisode',
                },
            },
            {
                name: 'People',
                description:
                    'Actors, directors and other people, with their credits in your library.',
                operations: {
                    'GET /people/{id}': 'getPerson',
                },
            },
            {
                name: 'Search',
                description: 'Search the whole library and get typeahead suggestions.',
                operations: {
                    'GET /search': 'searchLibrary',
                    'GET /search/suggest': 'getSearchSuggestions',
                },
            },
            {
                name: 'Discovery',
                description:
                    'Home screen rows, continue watching, recommendations, trending, upcoming releases and curated lists.',
                operations: {
                    'GET /feed': 'getHomeFeed',
                    'GET /continue-watching': 'listContinueWatching',
                    'DELETE /continue-watching/{id}': 'hideContinueWatchingItem',
                    'GET /recommendations': 'listRecommendations',
                    'POST /recommendations/refresh': 'refreshRecommendations',
                    'POST /recommendations/dismiss': 'dismissRecommendation',
                    'POST /for-you/dismiss': 'dismissFeedItem',
                    'DELETE /for-you/dismiss': 'restoreFeedItem',
                    'POST /for-you/less-like-this': 'markLessLikeThis',
                    'GET /trending': 'listTrending',
                    'GET /upcoming': 'listUpcoming',
                    'POST /upcoming/refresh': 'refreshUpcoming',
                    'GET /lists': 'listCuratedLists',
                    'GET /lists/{id}': 'getCuratedList',
                },
            },
            {
                name: 'Requests',
                description:
                    'Ask for titles that are not in the library yet, and follow the request.',
                operations: {
                    'GET /requests': 'listRequests',
                    'POST /requests': 'createRequest',
                    'GET /requests/{id}': 'getRequest',
                    'GET /requests/quota': 'getRequestQuota',
                    'POST /requests/status': 'getRequestStatuses',
                    'POST /requests/seasons': 'listRequestableSeasons',
                    'POST /requests/{id}/dismissal': 'dismissRequestNotification',
                    'POST /requests/dismissals': 'dismissRequestNotificationsByTitle',
                },
            },
            {
                name: 'Library sync',
                description:
                    'Keep a local copy of the library and your state in sync: one initial load, then changes since a cursor.',
                operations: {
                    'GET /sync/library': 'getLibrarySnapshot',
                    'GET /sync/user-state': 'getUserStateSnapshot',
                    'GET /sync/changes': 'listChangesSince',
                },
            },
            {
                name: 'Images',
                description:
                    'Posters, backdrops, stills, logos and avatars for titles, people, users and libraries. Responses already carry ready URLs; these are the targets.',
                operations: {
                    'GET /media/{id}/images': 'listMediaImages',
                    'GET /media/{id}/images/{role}': 'getMediaImage',
                    'GET /media/{id}/images/{role}/{index}': 'getMediaImageAt',
                    'GET /people/{id}/images': 'listPersonImages',
                    'GET /people/{id}/images/{role}': 'getPersonImage',
                    'GET /people/{id}/images/{role}/{index}': 'getPersonImageAt',
                    'GET /users/{id}/images': 'listUserImages',
                    'GET /users/{id}/images/{role}': 'getUserImage',
                    'GET /users/{id}/images/{role}/{index}': 'getUserImageAt',
                    'PUT /users/{id}/images/{role}': 'uploadUserImage',
                    'DELETE /users/{id}/images/{role}': 'deleteUserImage',
                    'GET /libraries/{id}/images': 'listLibraryImages',
                    'GET /libraries/{id}/images/{role}': 'getLibraryImage',
                    'GET /libraries/{id}/images/{role}/{index}': 'getLibraryImageAt',
                    'GET /music/images/collage': 'getCoverCollage',
                    'GET /music/radio/stations/{id}/images/{role}': 'getRadioStationImage',
                },
            },
        ],
    },
    {
        name: 'Playback',
        tags: [
            {
                name: 'Playback sessions',
                description:
                    'Start, report and stop video, music and audiobook playback. Live TV uses station/feed sessions and POST keepalives; dedicated previews retain admission, artifact caching and trailers. All starts describe their reporting protocol. Also delivery grants and offline play records.',
                operations: {
                    'POST /media/{id}/playability': 'getMediaPlayability',
                    'GET /playback/{id}/probe-status': 'getProbeStatus',
                    'POST /play-sessions': 'startPlaybackSession',
                    'GET /play-sessions': 'listPlaybackSessions',
                    'PUT /play-sessions/{id}': 'updatePlaybackSession',
                    'POST /play-sessions/{id}/beacon': 'updatePlaybackSessionByBeacon',
                    'DELETE /play-sessions/{id}': 'cancelPlaybackSession',
                    'GET /play-sessions/{id}/events': 'listPlaybackSessionEvents',
                    'POST /play-sessions/replay': 'uploadTrackPlays',
                    'POST /offline-playback-sessions': 'uploadOfflinePlaybackRecords',
                    'POST /livetv/playback-sessions': 'startLiveTvSession',
                    'GET /livetv/playback-sessions/{playbackSessionId}': 'getLiveTvSession',
                    'POST /livetv/playback-sessions/{playbackSessionId}/keepalive':
                        'keepAliveLiveTvSession',
                    'DELETE /livetv/playback-sessions/{playbackSessionId}': 'stopLiveTvSession',
                    'POST /livetv/playback-sessions/{playbackSessionId}/leave':
                        'leaveLiveTvSessionByBeacon',
                    'GET /playback/grants/{id}': 'getPlaybackGrant',
                    'POST /playback/grants/{id}/renew': 'renewPlaybackGrant',
                    'DELETE /playback/grants/{id}': 'revokePlaybackGrant',
                    'POST /playback/previews': 'startPreview',
                    'POST /playback/previews/{id}/keepalive': 'keepAlivePreview',
                    'DELETE /playback/previews/{id}': 'stopPreview',
                },
            },
            {
                name: 'Streaming',
                description:
                    'The bytes: HLS manifests and segments, direct files, audiobook files and Live TV streams. Never build these URLs: use the ones a playback session start returns. The HLS entries document a family of opaque URLs, and the paths below a manifest are not stable.',
                operations: {
                    'GET /playback/{id}/hls': 'streamHlsManifest',
                    'GET /playback/{id}/hls/{path}': 'streamHlsSegment',
                    'GET /playback/{id}/file': 'streamMediaFile',
                    'GET /audiobooks/{mediaId}/files/{trackIndex}': 'streamAudiobookFile',
                    'GET /audiobooks/{mediaId}/remux/{trackIndex}': 'streamAudiobookFileAac',
                    'GET /audiobook/{mediaId}/hls/{token}/{sessionId}/{file}': 'streamAudiobookHls',
                    'GET /audiobook/{mediaId}/file/{ino}': 'streamRetiredAudiobookFile',
                    'GET /audiobook/{mediaId}/remux/{ino}': 'streamRetiredAudiobookRemux',
                    'GET /livetv/channels/{id}/stream/{path}': 'streamLiveTv',
                    'GET /media/{id}/topshelf-preview': 'getTopShelfPreview',
                    'GET /media/{id}/topshelf-preview/file/{variant}': 'streamTopShelfPreview',
                    'GET /music/tracks/{id}/stream': 'streamTrack',
                    'GET /music/sonic-mixes/{id}/shuffle': 'streamSonicMixShuffle',
                    'GET /music/radio/stations/{id}/stream': 'streamRadioStation',
                },
            },
            {
                name: 'Timeline',
                description:
                    'The selected file’s timeline: chapters, skip segments, trickplay thumbnails and subtitle descriptors. Subtitle delivery is under Subtitles.',
                operations: {
                    'GET /playback/{id}/timeline': 'getTimeline',
                    'GET /playback/{id}/chapter-image/{index}': 'getChapterImage',
                    'GET /playback/{id}/trickplay/{width}/manifest': 'getTrickplayManifest',
                    'GET /playback/{id}/trickplay/{width}': 'getTrickplayTile',
                },
            },
            {
                name: 'Subtitles',
                description:
                    'Select embedded and sidecar subtitles by stable id from playability/start; extract text or raw tracks and render embedded bitmap subtitles.',
                operations: {
                    'GET /playback/{id}/subtitles/{index}': 'getSubtitleTrack',
                    'GET /playback/{id}/subtitles/external/{subtitleId}': 'getExternalSubtitle',
                    'GET /playback/{id}/subtitles/{index}/rendered': 'getRenderedSubtitleManifest',
                    'GET /playback/{id}/subtitles/{index}/rendered/{image}':
                        'getRenderedSubtitleImage',
                },
            },
            {
                name: 'Downloads',
                description:
                    'Offline use: download the original file or a server-prepared rendition, and smart-download candidates.',
                operations: {
                    'GET /media/{id}/download': 'downloadOriginalFile',
                    'GET /media/{id}/renditions': 'listRenditions',
                    'POST /media/{id}/renditions': 'requestRendition',
                    'GET /renditions/{renditionId}': 'getRendition',
                    'GET /renditions/{renditionId}/file': 'downloadRendition',
                    'GET /series/downloads/candidates': 'listSeriesDownloadCandidates',
                    'POST /series/downloads/rescore': 'rescoreSeriesDownloads',
                    'GET /music/downloads/candidates': 'listMusicDownloadCandidates',
                    'POST /music/downloads/rescore': 'rescoreMusicDownloads',
                },
            },
            {
                name: 'Network',
                description: 'Measure the connection to the server to pick a starting quality.',
                operations: {
                    'GET /network/speed-test': 'downloadSpeedTestPayload',
                    'POST /network/speed-test/results': 'reportSpeedTestResult',
                },
            },
        ],
    },
    {
        name: 'Music',
        tags: [
            {
                name: 'Music library',
                description:
                    'Albums, artists and tracks: A–Z lists, details with track lists and discographies, genres, moods, lyrics and music search.',
                operations: {
                    'GET /music/albums': 'listAlbums',
                    'GET /music/albums/{id}': 'getAlbum',
                    'GET /music/artists': 'listArtists',
                    'GET /music/artists/{id}': 'getArtist',
                    'GET /music/tracks': 'listTracks',
                    'GET /music/tracks/{id}': 'getTrack',
                    'GET /music/alpha-index': 'getMusicAlphaIndex',
                    'GET /music/genres': 'listMusicGenres',
                    'GET /music/moods': 'listMoods',
                    'GET /music/tracks/{id}/lyrics': 'getLyrics',
                    'PUT /music/tracks/{id}/lyrics': 'setLyrics',
                    'GET /music/text-search': 'searchMusicByDescription',
                    'GET /music/lyrics-search': 'searchLyrics',
                },
            },
            {
                name: 'Music discovery & radio',
                description:
                    'What to play next and what else to hear: the music home, recommendations, similar music, sonic mixes, carousels and internet radio.',
                operations: {
                    'GET /music': 'getMusicHome',
                    'POST /music/recommendations': 'recommendNextTrack',
                    'GET /music/tracks/{id}/similar': 'listSimilarTracks',
                    'GET /music/albums/{id}/similar': 'listSimilarAlbums',
                    'GET /music/artists/{id}/similar': 'listSimilarArtists',
                    'GET /music/sonic-mixes': 'listSonicMixes',
                    'GET /music/sonic-mixes/index': 'listSonicMixIndex',
                    'GET /music/sonic-mixes/{id}/tracks': 'listSonicMixTracks',
                    'GET /music/mood-recommendations': 'listMoodRecommendations',
                    'POST /music/quick-picks': 'getQuickPicks',
                    'GET /music/sections/because-you-listened': 'getBecauseYouListenedSection',
                    'GET /music/sections/new-for-you': 'getNewForYouSection',
                    'GET /music/sections/smart-mixes': 'getSmartMixesSection',
                    'GET /music/sections/mood-shelf': 'getMoodShelfSection',
                    'GET /music/sections/genre/{name}': 'getGenreSection',
                    'GET /music/sonic-fingerprint': 'getSonicFingerprintSection',
                    'GET /music/path': 'getSonicPath',
                    'GET /music/radio/stations': 'listRadioStations',
                    'GET /music/radio/stations/{id}/now-playing': 'getRadioNowPlaying',
                },
            },
        ],
    },
    {
        name: 'Audiobooks',
        tags: [
            {
                name: 'Audiobooks',
                description:
                    'Audiobooks by title, author, narrator and series, and listening sharing.',
                operations: {
                    'GET /audiobooks': 'listAudiobooks',
                    'GET /audiobooks/facets': 'getAudiobookFacets',
                    'GET /audiobooks/authors': 'listAudiobookAuthors',
                    'GET /audiobooks/authors/{id}': 'getAudiobookAuthor',
                    'GET /audiobooks/authors/{id}/books': 'listAudiobookAuthorBooks',
                    'GET /audiobooks/narrators': 'listAudiobookNarrators',
                    'GET /audiobooks/narrators/{id}': 'getAudiobookNarrator',
                    'GET /audiobooks/narrators/{id}/books': 'listAudiobookNarratorBooks',
                    'GET /audiobooks/series': 'listAudiobookSeries',
                    'GET /audiobooks/series/{id}': 'getAudiobookSeries',
                    'GET /audiobooks/series/{id}/books': 'listAudiobookSeriesBooks',
                    'GET /media/{id}/listening-sharing': 'getListeningSharing',
                    'PUT /media/{id}/listening-sharing': 'setListeningSharing',
                },
            },
        ],
    },
    {
        name: 'Live TV',
        tags: [
            {
                name: 'Live TV',
                description:
                    'Stations, the guide, programme search, favourites and simple mode. Tuning a station is a playback session.',
                operations: {
                    'GET /livetv/availability': 'getLiveTvAvailability',
                    'GET /livetv/stations': 'listLiveTvStations',
                    'GET /livetv/stations/{stationId}': 'getLiveTvStation',
                    'GET /livetv/stations/{stationId}/current-program': 'getLiveTvCurrentProgram',
                    'GET /livetv/stations/{stationId}/programs': 'listLiveTvStationPrograms',
                    'GET /livetv/stations/{stationId}/feeds': 'listLiveTvStationFeeds',
                    'GET /livetv/guide': 'getLiveTvGuide',
                    'GET /livetv/programs/search': 'searchLiveTvPrograms',
                    'GET /livetv/favorites': 'listLiveTvFavorites',
                    'PUT /livetv/favorites': 'setLiveTvFavorite',
                    'PUT /livetv/favorites/order': 'reorderLiveTvFavorites',
                    'GET /livetv/simple-mode': 'getLiveTvSimpleMode',
                    'PATCH /livetv/simple-mode': 'updateLiveTvSimpleMode',
                    'POST /livetv/simple-mode/verify-pin': 'verifyLiveTvSimpleModePin',
                },
            },
        ],
    },
    {
        name: 'Your data',
        tags: [
            {
                name: 'Watch state',
                description: 'Watched flags, positions and favourites for one title.',
                operations: {
                    'GET /watch-state/{id}': 'getWatchState',
                    'PATCH /watch-state/{id}': 'updateWatchState',
                },
            },
            {
                name: 'Ratings',
                description: 'Your rating of a title: read, set, clear.',
                operations: {
                    'DELETE /media/{id}/rating': 'clearRating',
                    'GET /media/{id}/rating': 'getRating',
                    'PUT /media/{id}/rating': 'setRating',
                },
            },
            {
                name: 'Watchlist',
                description: 'Titles saved for later.',
                operations: {
                    'GET /watchlist': 'listWatchlist',
                    'POST /watchlist': 'addToWatchlist',
                    'DELETE /watchlist': 'removeFromWatchlist',
                },
            },
            {
                name: 'Your music',
                description:
                    'Your listening: recently played, top tracks and artists, taste stations, pinned genres and likes/dislikes on tracks.',
                operations: {
                    'GET /me/music/recently-played': 'listRecentlyPlayedTracks',
                    'GET /me/music/top-tracks': 'listTopTracks',
                    'GET /me/music/top-artists': 'listTopArtists',
                    'GET /me/music/taste-stations': 'listTasteStations',
                    'GET /me/music/taste-stations/{id}/tracks': 'listTasteStationTracks',
                    'GET /me/music/pinned-genres': 'listPinnedGenres',
                    'POST /me/music/pinned-genres': 'pinGenre',
                    'DELETE /me/music/pinned-genres/{genre}': 'unpinGenre',
                    'PUT /me/music/tracks/{id}/feedback': 'setTrackFeedback',
                    'DELETE /me/music/tracks/{id}/feedback': 'clearTrackFeedback',
                },
            },
            {
                name: 'Playlists',
                description:
                    'Your and shared playlists: entries, order, members and roles, collaborative progress and playback context.',
                operations: {
                    'GET /playlists': 'listPlaylists',
                    'POST /playlists': 'createPlaylist',
                    'GET /playlists/{id}': 'getPlaylist',
                    'PATCH /playlists/{id}': 'updatePlaylist',
                    'DELETE /playlists/{id}': 'deletePlaylist',
                    'GET /playlists/{id}/items': 'listPlaylistEntries',
                    'POST /playlists/{id}/items': 'addPlaylistEntry',
                    'DELETE /playlists/{id}/items/{entryId}': 'removePlaylistEntry',
                    'POST /playlists/{id}/items/bulk-delete': 'removePlaylistEntries',
                    'PUT /playlists/{id}/items/order': 'reorderPlaylistEntries',
                    'PUT /playlists/{id}/items/{entryId}/watched': 'setPlaylistEntryWatched',
                    'GET /playlists/{id}/members': 'listPlaylistMembers',
                    'POST /playlists/{id}/members': 'addPlaylistMember',
                    'PUT /playlists/{id}/members/{userId}': 'updatePlaylistMember',
                    'DELETE /playlists/{id}/members/{userId}': 'removePlaylistMember',
                    'POST /playlists/{id}/invite': 'respondToPlaylistInvite',
                    'GET /playlists/{id}/progress': 'getPlaylistProgress',
                    'GET /playlists/{id}/playback-context': 'getPlaylistPlaybackContext',
                    'GET /playlists/{id}/suggestions': 'listPlaylistSuggestions',
                    'PUT /playlists/{id}/view-state': 'setPlaylistViewState',
                },
            },
        ],
    },
    {
        name: 'Social',
        tags: [
            {
                name: 'Watch together',
                description:
                    'Watch parties: create one, look it up by join code, and send and receive the synchronised playback events.',
                operations: {
                    'GET /watch-together': 'getCurrentWatchParty',
                    'GET /watch-together/parties': 'listWatchParties',
                    'POST /watch-together/parties': 'createWatchParty',
                    'GET /watch-together/{code}': 'getWatchParty',
                    'GET /watch-together/{code}/events': 'subscribeWatchPartyEvents',
                    'POST /watch-together/{code}/events': 'sendWatchPartyEvent',
                },
            },
            {
                name: 'Community',
                description:
                    'Comments and reactions on titles, people and playlists, and who else watched a title.',
                operations: {
                    'GET /media/{id}/viewers': 'listMediaViewers',
                    'GET /media/{id}/comments': 'listMediaComments',
                    'POST /media/{id}/comments': 'createMediaComment',
                    'DELETE /media/{id}/comments/{commentId}': 'deleteMediaComment',
                    'GET /media/{id}/reactions': 'getMediaReactions',
                    'PUT /media/{id}/reactions': 'setMediaReaction',
                    'DELETE /media/{id}/reactions': 'clearMediaReaction',
                    'GET /people/{id}/comments': 'listPersonComments',
                    'POST /people/{id}/comments': 'createPersonComment',
                    'DELETE /people/{id}/comments/{commentId}': 'deletePersonComment',
                    'GET /people/{id}/reactions': 'getPersonReactions',
                    'PUT /people/{id}/reactions': 'setPersonReaction',
                    'DELETE /people/{id}/reactions': 'clearPersonReaction',
                    'GET /playlists/{id}/comments': 'listPlaylistComments',
                    'POST /playlists/{id}/comments': 'createPlaylistComment',
                    'DELETE /playlists/{id}/comments/{commentId}': 'deletePlaylistComment',
                    'GET /playlists/{id}/reactions': 'getPlaylistReactions',
                    'PUT /playlists/{id}/reactions': 'setPlaylistReaction',
                    'DELETE /playlists/{id}/reactions': 'clearPlaylistReaction',
                },
            },
            {
                name: 'Notifications',
                description:
                    'Your notification inbox, series release follows, push content, and notification forwarding.',
                operations: {
                    'GET /me/series-follows': 'listFollowedSeries',
                    'PUT /me/series-follows/{seriesId}': 'followSeries',
                    'DELETE /me/series-follows/{seriesId}': 'unfollowSeries',
                    'GET /notifications': 'listNotifications',
                    'GET /notifications/unread-count': 'getUnreadNotificationCount',
                    'GET /notifications/{id}': 'getNotification',
                    'DELETE /notifications/{id}': 'deleteNotification',
                    'POST /notifications/{id}/read': 'markNotificationRead',
                    'POST /notifications/read-all': 'markAllNotificationsRead',
                    'GET /notifications/{id}/image': 'getNotificationImage',
                    'GET /notifications/{id}/push-image': 'getPushImage',
                    'GET /notifications/{id}/push-content/{locale}': 'getPushContent',
                    'GET /me/notification-forwarding': 'getNotificationForwarding',
                    'PUT /me/notification-forwarding': 'setNotificationForwarding',
                    'GET /me/notification-webhook': 'getNotificationWebhook',
                    'POST /me/notification-webhook': 'setNotificationWebhook',
                    'DELETE /me/notification-webhook': 'clearNotificationWebhook',
                },
            },
        ],
    },
    {
        name: 'Devices',
        tags: [
            {
                name: 'Devices',
                description:
                    "Signed-in devices: list, rename, sign out, presence heartbeat and push tokens; an admin manages a user's devices.",
                operations: {
                    'GET /devices': 'listDevices',
                    'PATCH /devices/{id}': 'updateDevice',
                    'DELETE /devices/{id}': 'revokeDevice',
                    'POST /devices/revoke-all': 'revokeAllDevices',
                    'POST /devices/{id}/heartbeat': 'reportDeviceHeartbeat',
                    'PUT /devices/{id}/push-token': 'setPushToken',
                    'DELETE /devices/{id}/push-token': 'clearPushToken',
                    'GET /users/{id}/devices': 'listUserDevices',
                    'DELETE /users/{id}/devices/{deviceSessionId}': 'revokeUserDevice',
                    'POST /users/{id}/devices/revoke-all': 'revokeAllUserDevices',
                },
            },
            {
                name: 'Remote control',
                description:
                    'Control another device: send commands, read and report what it plays, and decide who may control your devices.',
                operations: {
                    'GET /devices/controllable': 'listControllableDevices',
                    'GET /devices/grants': 'listDeviceControlGrants',
                    'POST /devices/grants': 'grantDeviceControl',
                    'DELETE /devices/grants/{username}': 'revokeDeviceControl',
                    'GET /devices/{id}/commands': 'listDeviceCommands',
                    'POST /devices/{id}/commands': 'sendDeviceCommand',
                    'GET /devices/{id}/commands/{commandId}': 'getDeviceCommand',
                    'DELETE /devices/{id}/commands/{commandId}': 'cancelDeviceCommand',
                    'POST /devices/{id}/commands/{commandId}/result': 'reportDeviceCommandResult',
                    'GET /devices/{id}/state': 'getDeviceState',
                    'PUT /devices/{id}/state': 'reportDeviceState',
                },
            },
            {
                name: 'Client diagnostics',
                description:
                    'What clients report about themselves: log bundles, playback incidents and telemetry.',
                operations: {
                    'POST /diagnostics/bundles': 'uploadDiagnosticsBundle',
                    'POST /diagnostics/events': 'reportDiagnosticEvents',
                    'PATCH /diagnostics/events/resolve': 'markPlaybackRecovered',
                    'POST /playback/telemetry': 'reportPlaybackTelemetry',
                },
            },
        ],
    },
    {
        name: 'Integrations',
        tags: [
            {
                name: 'Webhooks',
                description: 'Outbound webhooks the server calls when task events happen (admin).',
                operations: {
                    'GET /webhooks': 'listWebhooks',
                    'POST /webhooks': 'createWebhook',
                    'PUT /webhooks/{id}': 'updateWebhook',
                    'DELETE /webhooks/{id}': 'deleteWebhook',
                    'POST /webhooks/{id}/test': 'testWebhook',
                    'GET /webhooks/events': 'listWebhookEventTypes',
                },
            },
            {
                name: 'Service feeds',
                description:
                    'Read-only feeds for third-party tools (dashboards, recommenders), authorised by a service token.',
                operations: {
                    'GET /integrations/homepage': 'getHomepageSummary',
                    'GET /integrations/upcoming': 'listUserUpcoming',
                    'GET /integrations/watch-history': 'listUserWatchHistory',
                },
            },
        ],
    },
    {
        name: 'Administration',
        tags: [
            {
                name: 'Users & access',
                description:
                    "Users, passwords, federated identities, access groups and everyone's personal access tokens (admin).",
                operations: {
                    'GET /users': 'listUsers',
                    'POST /users': 'createUser',
                    'GET /users/{id}': 'getUser',
                    'PATCH /users/{id}': 'updateUser',
                    'POST /users/{id}/password': 'setUserPassword',
                    'GET /users/{id}/identities': 'listUserIdentities',
                    'DELETE /users/{id}/identities': 'unlinkUserIdentity',
                    'GET /users/{id}/pats': 'listUserAccessTokens',
                    'POST /users/{id}/pats': 'createUserAccessToken',
                    'DELETE /users/{id}/pats/{tokenId}': 'revokeUserAccessToken',
                    'GET /access/groups': 'listAccessGroups',
                    'POST /access/groups': 'createAccessGroup',
                    'GET /access/groups/{id}': 'getAccessGroup',
                    'PATCH /access/groups/{id}': 'updateAccessGroup',
                    'DELETE /access/groups/{id}': 'deleteAccessGroup',
                    'GET /access/groups/{id}/members': 'listAccessGroupMembers',
                    'PUT /access/groups/{id}/members/{userId}': 'addAccessGroupMember',
                    'DELETE /access/groups/{id}/members/{userId}': 'removeAccessGroupMember',
                },
            },
            {
                name: 'Libraries & scanning',
                description:
                    'Manage library contents from outside: push file changes, delete a title (admin).',
                operations: {
                    'DELETE /media/{id}': 'deleteMediaItem',
                    'POST /libraries/ingest': 'ingestLibraryDelta',
                },
            },
            {
                name: 'Tasks & runs',
                description:
                    'Background tasks: definitions, settings, triggers, state, failures, runs and their logs (admin).',
                operations: {
                    'GET /tasks': 'listTasks',
                    'GET /tasks/{taskId}': 'getTask',
                    'POST /tasks/{taskId}/run': 'runTask',
                    'GET /tasks/{taskId}/backlog': 'getTaskBacklog',
                    'GET /tasks/{taskId}/state': 'getTaskState',
                    'PATCH /tasks/{taskId}/state': 'setTaskState',
                    'GET /tasks/{taskId}/settings': 'getTaskSettings',
                    'PUT /tasks/{taskId}/settings': 'setTaskSettings',
                    'GET /tasks/{taskId}/triggers': 'getTaskTriggers',
                    'PUT /tasks/{taskId}/triggers': 'replaceTaskTriggers',
                    'DELETE /tasks/{taskId}/triggers': 'resetTaskTriggers',
                    'GET /tasks/{taskId}/failures': 'listTaskFailures',
                    'GET /tasks/{taskId}/failures/{itemId}/history': 'getTaskFailureHistory',
                    'POST /tasks/{taskId}/failures/{itemId}/retry': 'retryTaskFailure',
                    'GET /runs': 'listRuns',
                    'GET /runs/{id}': 'getRun',
                    'POST /runs/{id}/cancel': 'cancelRun',
                    'POST /runs/cancel': 'cancelTaskRuns',
                    'GET /runs/{id}/logs': 'subscribeRunLogs',
                },
            },
            {
                name: 'Service tokens',
                description: 'Tokens for integrations and services, with typed grants (admin).',
                operations: {
                    'GET /service-tokens': 'listServiceTokens',
                    'POST /service-tokens': 'createServiceToken',
                    'GET /service-tokens/{id}': 'getServiceToken',
                    'DELETE /service-tokens/{id}': 'revokeServiceToken',
                },
            },
            {
                name: 'Debug report',
                description:
                    'One redacted report of an instance for pasting into an AI assistant or an issue, with drill-downs for a failed run, a client-diagnostic group or a cluster node. Authorised by an administrator, or a service token with the diagnostics:read grant (beta).',
                operations: {
                    'GET /admin/debug-report': 'getDebugReport',
                    'GET /admin/debug-report/health': 'getDebugReportHealth',
                    'GET /admin/debug-report/runs/{runId}': 'getDebugReportRun',
                    'GET /admin/debug-report/client-diagnostics/{fingerprint}':
                        'getDebugReportClientDiagnosticGroup',
                    'GET /admin/debug-report/cluster/nodes/{instanceId}':
                        'getDebugReportClusterNode',
                },
            },
        ],
    },
];

export interface TaxonomyEntry {
    group: string;
    tag: string;
    operationId: string;
}

/** Strip `/api/v1` so keys read like the docs: `/api/v1/media/{id}` → `/media/{id}`. */
export function taxonomyPath(specPath: string): string {
    return specPath.startsWith('/api/v1/') ? specPath.slice('/api/v1'.length) : specPath;
}

/** `METHOD path` → entry. Throws on a key listed twice. */
export function buildTaxonomyIndex(
    taxonomy: TaxonomyGroup[] = PUBLIC_TAXONOMY,
): Map<string, TaxonomyEntry> {
    const index = new Map<string, TaxonomyEntry>();
    const tagNames = new Set<string>();
    for (const group of taxonomy) {
        for (const tag of group.tags) {
            if (tagNames.has(tag.name))
                throw new Error(`public-taxonomy: tag "${tag.name}" is listed twice`);
            tagNames.add(tag.name);
            for (const [key, operationId] of Object.entries(tag.operations)) {
                if (index.has(key)) throw new Error(`public-taxonomy: ${key} is listed twice`);
                index.set(key, { group: group.name, tag: tag.name, operationId });
            }
        }
    }
    return index;
}

/**
 * Why an operationId is rejected, or null when it is fine. With `path`, the
 * id must not spell one of that path's id params (`{id}`, `{sessionId}`): the
 * tell of a path-derived id like getMediaIdImages or getLivetvSessionsSessionid.
 */
export function operationIdProblem(operationId: string, path?: string): string | null {
    if (!OPERATION_ID_RULE.test(operationId)) return 'not verbNoun camelCase';
    const verb = OPERATION_ID_VERBS.find(
        (v) => operationId.startsWith(v) && /[A-Z]/.test(operationId.charAt(v.length)),
    );
    if (!verb) return 'does not start with a known verb';
    for (const [, param] of (path ?? '').matchAll(/\{([^}]+)\}/g)) {
        const name = param.replace(/[^A-Za-z0-9]/g, '');
        // Only id params are a tell; {segment}, {genre}, {file} are domain
        // nouns a hand-picked name may well contain (streamLiveTvSegment).
        if (!/id$/i.test(name)) continue;
        const capitalised = name.charAt(0).toUpperCase() + name.slice(1);
        const lowered = capitalised.charAt(0) + capitalised.slice(1).toLowerCase();
        for (const token of new Set([capitalised, lowered])) {
            if (new RegExp(`${token}(?![a-z])`).test(operationId))
                return `contains the path-param name "${param}"`;
        }
    }
    return null;
}

const TAXONOMY_METHODS = [
    'get',
    'put',
    'post',
    'delete',
    'patch',
    'head',
    'options',
    'trace',
] as const;

export interface AppliedTaxonomy {
    /** Problems that must fail generation. */
    problems: string[];
    /** Top-level `tags`, in reading order, only tags that have operations. */
    tags: { name: string; description: string }[];
    /** `x-tagGroups` for Scalar/Redoc. */
    tagGroups: { name: string; tags: string[] }[];
}

/**
 * Set `tags` and `operationId` on every public operation from the registry.
 * Mutates the path items in place (the combined spec shares them).
 */
export function applyPublicTaxonomy(
    paths: Record<string, Record<string, unknown> | undefined>,
    taxonomy: TaxonomyGroup[] = PUBLIC_TAXONOMY,
): AppliedTaxonomy {
    const index = buildTaxonomyIndex(taxonomy);
    const problems: string[] = [];
    const seen = new Set<string>();
    const usedTags = new Set<string>();

    for (const [specPath, pathItem] of Object.entries(paths)) {
        if (!pathItem) continue;
        const path = taxonomyPath(specPath);
        for (const method of TAXONOMY_METHODS) {
            const operation = pathItem[method] as Record<string, unknown> | undefined;
            if (!operation) continue;
            const key = `${method.toUpperCase()} ${path}`;
            const entry = index.get(key);
            if (entry) {
                seen.add(key);
                if (typeof operation['x-stability'] !== 'string') {
                    problems.push(
                        `${key}: no x-stability (set an explicit stability on the operation)`,
                    );
                }
                operation.tags = [entry.tag];
                operation.operationId = entry.operationId;
                usedTags.add(entry.tag);
                continue;
            }
            problems.push(
                `${key}: not in scripts/openapi/public-taxonomy.ts — add it under the right tag with a verbNoun operationId`,
            );
        }
    }

    for (const key of index.keys()) {
        if (!seen.has(key))
            problems.push(`${key}: listed in public-taxonomy.ts but no such public operation`);
    }

    const ids = new Map<string, string>();
    for (const [key, entry] of index) {
        const problem = operationIdProblem(entry.operationId, key.slice(key.indexOf(' ') + 1));
        if (problem) problems.push(`${key}: operationId "${entry.operationId}" ${problem}`);
        const other = ids.get(entry.operationId);
        if (other) problems.push(`operationId "${entry.operationId}" used by ${other} and ${key}`);
        ids.set(entry.operationId, key);
    }

    const tags: AppliedTaxonomy['tags'] = [];
    const tagGroups: AppliedTaxonomy['tagGroups'] = [];
    for (const group of taxonomy) {
        const groupTags = group.tags.filter((t) => usedTags.has(t.name));
        if (groupTags.length === 0) continue;
        tagGroups.push({ name: group.name, tags: groupTags.map((t) => t.name) });
        for (const t of groupTags) tags.push({ name: t.name, description: t.description });
    }
    return { problems, tags, tagGroups };
}

/**
 * Operations whose responses carry translated titles/overviews (metadata
 * language negotiation) or localized display text. Each gets the shared
 * `Accept-Language` header parameter, which points to the guide.
 */
export const LOCALIZED_OPERATIONS: readonly string[] = [
    'GET /media/{id}',
    'GET /media/{id}/context',
    'POST /media/batch',
    'GET /media/{id}/similar',
    'GET /series/{id}',
    'GET /series/{id}/seasons',
    'GET /series/{id}/seasons/{n}',
    'GET /series/{id}/seasons/{n}/episodes/{e}',
    'GET /series/{id}/episodes',
    'GET /series/{id}/next-episode',
    'GET /seasons/{id}',
    'GET /episodes/{id}',
    'GET /search',
    'GET /browse',
    'GET /keywords',
    'GET /feed',
    'GET /continue-watching',
    'GET /recommendations',
    'POST /recommendations/refresh',
    'GET /trending',
    'GET /upcoming',
    'POST /upcoming/refresh',
    'GET /lists/{id}',
    'GET /watchlist',
    'GET /playlists/{id}/items',
    'GET /notifications',
    'GET /notifications/{id}',
    'GET /integrations/upcoming',
    'GET /music',
    'GET /music/sections/because-you-listened',
    'GET /music/sections/new-for-you',
    'GET /music/sections/smart-mixes',
    'POST /music/quick-picks',
];

export const ACCEPT_LANGUAGE_PARAMETER = {
    name: 'Accept-Language',
    in: 'header',
    required: false,
    description:
        'Language for translated titles, overviews and display text (RFC 9110, e.g. `de-DE, de;q=0.9, en;q=0.5`). ' +
        "A metadata language the user stored with `PATCH /me/playback-preferences` wins over this header; languages the admin did not enable fall back to the server's primary language. " +
        'See "Language negotiation" in the API guide.',
    schema: { type: 'string' },
} as const;

/**
 * Reference the shared `Accept-Language` parameter from every localized
 * operation of a generated document (the public spec only: the combined spec
 * feeds TypeScript types, where a header parameter adds nothing). Returns problems for listed operations
 * that do not exist.
 */
export function applyLocalizedParameters(document: {
    paths?: Record<string, unknown>;
    components?: Record<string, unknown>;
}): string[] {
    const problems: string[] = [];
    const wanted = new Set(LOCALIZED_OPERATIONS);
    const found = new Set<string>();
    for (const [specPath, item] of Object.entries(document.paths ?? {})) {
        for (const method of TAXONOMY_METHODS) {
            const op = (item as Record<string, Record<string, unknown> | undefined>)[method];
            const key = `${method.toUpperCase()} ${taxonomyPath(specPath)}`;
            if (!op || !wanted.has(key)) continue;
            found.add(key);
            const params =
                (op.parameters as { $ref?: string; name?: string; in?: string }[] | undefined) ??
                [];
            const present = params.some(
                (p) =>
                    p.$ref === '#/components/parameters/AcceptLanguage' ||
                    (p.in === 'header' && p.name?.toLowerCase() === 'accept-language'),
            );
            if (!present) params.push({ $ref: '#/components/parameters/AcceptLanguage' });
            op.parameters = params;
        }
    }
    for (const key of wanted) {
        if (!found.has(key))
            problems.push(`${key}: in LOCALIZED_OPERATIONS but no such public operation`);
    }
    const components = (document.components ??= {});
    components.parameters = {
        ...(components.parameters as Record<string, unknown> | undefined),
        AcceptLanguage: ACCEPT_LANGUAGE_PARAMETER,
    };
    return problems;
}
