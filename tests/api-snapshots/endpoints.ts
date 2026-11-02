// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import type { paths } from '../api-recipes/generated/api-v1';
export type Ids = Partial<
    Record<
        | 'movie'
        | 'series'
        | 'season'
        | 'episode'
        | 'person'
        | 'album'
        | 'artist'
        | 'track'
        | 'audiobook'
        | 'audiobookAuthor'
        | 'audiobookSeries'
        | 'channel',
        string
    >
>;
type GetPath = { [K in keyof paths]: paths[K] extends { get: unknown } ? K : never }[keyof paths];
export interface Endpoint {
    key: string;
    template: GetPath;
    query?: string;
    id?: keyof Ids;
}
const fixed = [
    ['me', '/api/v1/me'],
    ['server', '/api/v1/server'],
    ['notice', '/api/v1/server/notice'],
    ['feed', '/api/v1/feed'],
    ['continue-watching', '/api/v1/continue-watching'],
    ['trending', '/api/v1/trending'],
    ['upcoming', '/api/v1/upcoming'],
    ['search', '/api/v1/search'],
    ['browse', '/api/v1/browse'],
    ['browse-libraries', '/api/v1/browse/libraries'],
    ['genres', '/api/v1/browse/genres'],
    ['play-sessions', '/api/v1/play-sessions'],
    ['music-home', '/api/v1/music'],
    ['music-albums', '/api/v1/music/albums'],
    ['music-artists', '/api/v1/music/artists'],
    ['music-tracks', '/api/v1/music/tracks'],
    ['music-genres', '/api/v1/music/genres'],
    ['music-recent', '/api/v1/me/music/recently-played'],
    ['music-top-artists', '/api/v1/me/music/top-artists'],
    ['music-taste-stations', '/api/v1/me/music/taste-stations'],
    ['music-clusters', '/api/v1/music/sonic-mixes'],
    ['audiobooks', '/api/v1/audiobooks'],
    ['audiobook-authors', '/api/v1/audiobooks/authors'],
    ['audiobook-narrators', '/api/v1/audiobooks/narrators'],
    ['audiobook-series-list', '/api/v1/audiobooks/series'],
    ['livetv-stations', '/api/v1/livetv/stations'],
    ['livetv-guide', '/api/v1/livetv/guide'],
    ['livetv-favorites', '/api/v1/livetv/favorites'],
    ['livetv-availability', '/api/v1/livetv/availability'],
    ['sync-changes', '/api/v1/sync/changes'],
    ['sync-library', '/api/v1/sync/library'],
    ['sync-user-state', '/api/v1/sync/user-state'],
    ['watchlist', '/api/v1/watchlist'],
    ['playlists', '/api/v1/playlists'],
    ['lists', '/api/v1/lists'],
    ['watch-together', '/api/v1/watch-together/parties'],
    ['devices', '/api/v1/devices'],
    ['notifications', '/api/v1/notifications'],
    ['requests', '/api/v1/requests'],
    ['users', '/api/v1/users'],
    ['tasks', '/api/v1/tasks'],
    ['runs', '/api/v1/runs'],
    ['service-tokens', '/api/v1/service-tokens'],
] as const satisfies readonly (readonly [string, GetPath])[];
export const endpoints: Endpoint[] = [
    ...fixed.map(([key, template]) => ({
        key,
        template,
        ...(key === 'search' ? { query: '?q=a' } : {}),
        ...(key === 'sync-library' ? { query: '?kind=movie&limit=5' } : {}),
        ...(key === 'sync-user-state' ? { query: '?kind=watch_state&limit=5' } : {}),
    })),
    { key: 'movie', template: '/api/v1/media/{id}', id: 'movie' },
    { key: 'series', template: '/api/v1/series/{id}', id: 'series' },
    { key: 'seasons', template: '/api/v1/series/{id}/seasons', id: 'series' },
    { key: 'episodes', template: '/api/v1/series/{id}/episodes', id: 'series' },
    { key: 'season', template: '/api/v1/seasons/{id}', id: 'season' },
    { key: 'episode', template: '/api/v1/episodes/{id}', id: 'episode' },
    { key: 'person', template: '/api/v1/people/{id}', id: 'person' },
    { key: 'images', template: '/api/v1/media/{id}/images', id: 'movie' },
    { key: 'rating', template: '/api/v1/media/{id}/rating', id: 'movie' },
    { key: 'watch-state', template: '/api/v1/watch-state/{id}', id: 'episode' },
    { key: 'probe', template: '/api/v1/playback/{id}/probe-status', id: 'movie' },
    { key: 'timeline', template: '/api/v1/playback/{id}/timeline', id: 'movie' },
    { key: 'trickplay', template: '/api/v1/playback/{id}/trickplay/{width}/manifest', id: 'movie' },
    { key: 'album', template: '/api/v1/music/albums/{id}', id: 'album' },
    { key: 'artist', template: '/api/v1/music/artists/{id}', id: 'artist' },
    { key: 'track', template: '/api/v1/music/tracks/{id}', id: 'track' },
    { key: 'track-similar', template: '/api/v1/music/tracks/{id}/similar', id: 'track' },
    { key: 'audiobook', template: '/api/v1/media/{id}', id: 'audiobook' },
    { key: 'audiobook-author', template: '/api/v1/audiobooks/authors/{id}', id: 'audiobookAuthor' },
    {
        key: 'audiobook-author-books',
        template: '/api/v1/audiobooks/authors/{id}/books',
        id: 'audiobookAuthor',
    },
    { key: 'audiobook-series', template: '/api/v1/audiobooks/series/{id}', id: 'audiobookSeries' },
    {
        key: 'audiobook-series-books',
        template: '/api/v1/audiobooks/series/{id}/books',
        id: 'audiobookSeries',
    },
    { key: 'channel', template: '/api/v1/livetv/stations/{stationId}', id: 'channel' },
];
// No non-spec requests: expose these gaps until the public spec publishes GET operations.
export const missingPublicOperations = ['system-health', 'client-diagnostics', 'api-conformance'];
export function endpointPath(endpoint: Endpoint, ids: Ids): string | undefined {
    if (endpoint.id && !ids[endpoint.id]) return;
    const query =
        endpoint.key === 'livetv-guide'
            ? `?from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 3600000).toISOString())}`
            : (endpoint.query ?? '');
    return (
        endpoint.template
            .replace('{id}', encodeURIComponent(endpoint.id ? ids[endpoint.id]! : ''))
            .replace('{stationId}', encodeURIComponent(endpoint.id ? ids[endpoint.id]! : ''))
            .replace('{width}', '320') + query
    );
}
