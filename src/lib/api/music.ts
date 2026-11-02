// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music API domain module
 *
 * Typed functions for music endpoints including albums, artists, tracks,
 * smart queue, lyrics, progress reporting, and internet radio.
 */

import { startPlaySession } from './playback.js';
import type { ApiResult } from './types.js';
import { apiGet, apiPost, apiPut, apiDelete } from './client.js';
import {
    MusicAlbumsResponseSchema,
    MusicAlbumDetailResponseSchema,
    MusicArtistsResponseSchema,
    MusicArtistDetailResponseSchema,
    MusicTrackDetailResponseSchema,
    MusicRecommendationsResponseSchema,
    RadioStationsResponseSchema,
    RadioNowPlayingResponseSchema,
    LyricsApiResponseSchema,
    MusicHomeSectionsResponseSchema,
    MusicSmartMixSectionsSchema,
    MusicGenresResponseSchema,
    PinGenreResponseSchema,
    SimilarTracksResponseSchema,
    SimilarAlbumsResponseSchema,
    SimilarArtistsResponseSchema,
    SonicPathResponseSchema,
    AlbumSeriesResponseSchema,
    MusicClustersResponseSchema,
    MusicClusterTracksResponseSchema,
    MusicMapResponseSchema,
    MusicQuickPicksResponseSchema,
    MusicStationTracksResponseSchema,
    MusicTextSearchResponseSchema,
} from '$lib/schemas/api-music-responses';
import { NoContentSchema } from '$lib/schemas/common';
import type { AutoplaySeed } from '$lib/schemas/autoplay-seed';
import type {
    MusicRecommendationSeed,
    MusicRecommendationsRequest,
} from '$lib/schemas/api-music-responses';
import { BrewResponseSchema } from '$lib/schemas/music-alchemy';
import { SessionHeartbeatResponseSchema } from '$lib/schemas/api-playback-responses';
import type { PlaybackReport } from '$lib/schemas/session-update';
import { ReplayResponseSchema, type ReplayItemSchema } from '$lib/schemas/play-session-replay';
import type { z } from 'zod';
import { apiUrl } from '$lib/shared/api-urls.js';

// =========================================================================
// Music Home
// =========================================================================

export function getMusicHome() {
    return apiGet('/api/music', MusicHomeSectionsResponseSchema);
}

// =========================================================================
// Albums
// =========================================================================

export function getAlbums(params?: {
    genre?: string;
    artist?: string;
    sort?: string;
    limit?: number;
    offset?: number;
}) {
    return apiGet('/api/music/albums', MusicAlbumsResponseSchema, { params });
}

export function getAlbum(id: string) {
    return apiGet(`/api/music/albums/${id}`, MusicAlbumDetailResponseSchema);
}

// =========================================================================
// Artists
// =========================================================================

export function getArtists(
    params?: {
        genre?: string;
        sort?: string;
        limit?: number;
        offset?: number;
    },
    signal?: AbortSignal,
) {
    return apiGet('/api/music/artists', MusicArtistsResponseSchema, {
        params,
        ...(signal ? { signal } : {}),
    });
}

export function getArtist(id: string) {
    return apiGet(`/api/music/artists/${id}`, MusicArtistDetailResponseSchema);
}

// =========================================================================
// Tracks
// =========================================================================

export function getTrack(id: string) {
    return apiGet(`/api/music/tracks/${id}`, MusicTrackDetailResponseSchema);
}

// =========================================================================
// Lyrics
// =========================================================================

export function getTrackLyrics(trackId: string, signal?: AbortSignal) {
    return apiGet(
        `/api/music/tracks/${trackId}/lyrics`,
        LyricsApiResponseSchema,
        signal ? { signal } : undefined,
    );
}

export function uploadTrackLyrics(
    trackId: string,
    body: { plain?: string; synced?: string; source?: string },
) {
    return apiPut(`/api/music/tracks/${trackId}/lyrics`, NoContentSchema, body);
}

// =========================================================================
// Recommendations (smart queue / radio)
// =========================================================================

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RECOMMENDATION_IDS = 200;

/** Valid, bounded id list for a recommendations context field; undefined when empty. */
function recommendationIds(ids: string[] | undefined): string[] | undefined {
    const valid = (ids ?? []).filter((id) => GUID_RE.test(id)).slice(0, MAX_RECOMMENDATION_IDS);
    return valid.length > 0 ? valid : undefined;
}

/** The wire seed for a client-side autoplay seed (drops the display-only fields). */
export function toRecommendationSeed(seed: AutoplaySeed): MusicRecommendationSeed {
    switch (seed.type) {
        case 'mood':
            return { type: 'mood', mood: seed.mood };
        case 'genre':
            return { type: 'genre', genre: seed.genre };
        case 'artist':
            return { type: 'artist', id: seed.artistId };
        case 'album':
            return { type: 'album', id: seed.albumId };
    }
}

/** Client autoplay seeds carry display fields (label/artistId/albumId); wire seeds do not. */
function isAutoplaySeed(seed: AutoplaySeed | MusicRecommendationSeed): seed is AutoplaySeed {
    return 'label' in seed || 'artistId' in seed || 'albumId' in seed;
}

export interface RecommendationArgs {
    /** Required unless the seed is a mood seed (cold start). */
    currentTrackId?: string;
    exclude?: string[];
    /** Newest first. */
    history?: string[];
    skipped?: string[];
    /** Tracks shaping the taste centroid after the current one. */
    upcoming?: string[];
    seed?: AutoplaySeed | MusicRecommendationSeed;
    crossfade?: boolean;
    startedBy?: 'user' | 'autoplay';
}

/** POST /music/recommendations: the next track plus alternatives (or a mood radio's first track). */
export function getRecommendations(args: RecommendationArgs) {
    const seed =
        args.seed && isAutoplaySeed(args.seed)
            ? toRecommendationSeed(args.seed)
            : (args.seed as MusicRecommendationSeed | undefined);
    const context: NonNullable<MusicRecommendationsRequest['context']> = {};
    if (args.currentTrackId) context.currentTrackId = args.currentTrackId;
    const history = recommendationIds(args.history);
    if (history) context.history = history;
    const skipped = recommendationIds(args.skipped);
    if (skipped) context.skipped = skipped;
    const exclude = recommendationIds(args.exclude);
    if (exclude) context.exclude = exclude;
    const upcoming = recommendationIds(args.upcoming);
    if (upcoming) context.upcoming = upcoming;
    if (typeof args.crossfade === 'boolean') context.crossfade = args.crossfade;
    if (args.startedBy) context.startedBy = args.startedBy;
    const body: MusicRecommendationsRequest = {
        ...(seed ? { seed } : {}),
        ...(Object.keys(context).length > 0 ? { context } : {}),
    };
    return apiPost('/api/music/recommendations', MusicRecommendationsResponseSchema, body);
}

export function setTrackFeedback(trackId: string, feedback: 'liked' | 'disliked') {
    return apiPut(`/api/me/music/tracks/${encodeURIComponent(trackId)}/feedback`, NoContentSchema, {
        feedback,
    });
}

export function clearTrackFeedback(trackId: string) {
    return apiDelete(
        `/api/me/music/tracks/${encodeURIComponent(trackId)}/feedback`,
        NoContentSchema,
    );
}

export type MusicReplayItem = z.input<typeof ReplayItemSchema>;

export function replayMusicPlays(items: MusicReplayItem[]) {
    return apiPost('/api/play-sessions/replay', ReplayResponseSchema, { items });
}

// =========================================================================
// Radio
// =========================================================================

export function getRadioStations() {
    return apiGet('/api/music/radio', RadioStationsResponseSchema);
}

export function getRadioNowPlaying(stationId: string) {
    return apiGet(`/api/music/radio/${stationId}/now-playing`, RadioNowPlayingResponseSchema);
}

// =========================================================================
// AirPlay / Stream Token
// =========================================================================

// =========================================================================
// Genres
// =========================================================================

export function getMusicGenres(query?: string) {
    return apiGet('/api/music/genres', MusicGenresResponseSchema, {
        params: query ? { q: query } : undefined,
    });
}

export function pinMusicGenre(genre: string) {
    return apiPost('/api/me/music/pinned-genres', PinGenreResponseSchema, {
        genre,
    });
}

export function unpinMusicGenre(genre: string) {
    return apiDelete('/api/me/music/pinned-genres', PinGenreResponseSchema, {
        genre,
    });
}

// =========================================================================
// Similar Tracks
// =========================================================================

/**
 * Tracks similar to `trackId`. `basis`: `metadata` (text embedding + audio
 * features), `sonic` (audio embeddings; 422 without sonic embeddings) or `auto`
 * (default: sonic when available, else metadata; `source` says which).
 */
export function getSimilarTracks(
    trackId: string,
    options: { basis?: 'auto' | 'metadata' | 'sonic'; limit?: number } = {},
) {
    return apiGet(`/api/music/tracks/${trackId}/similar`, SimilarTracksResponseSchema, {
        params: { basis: options.basis ?? 'auto', limit: options.limit ?? 20 },
    });
}

// =========================================================================
// Semantic Search — Text-to-Sound and Lyrics
// =========================================================================

/**
 * A cold (cache-miss) query can queue behind an in-progress audio-embedding
 * backfill batch on the shared sonic-embedder sidecar — the server allows up
 * to 45s for this (see TEXT_EMBED_HTTP_TIMEOUT_MS in sonic-embedding.service.ts).
 * The client timeout must exceed that ceiling, or apiFetch's own AbortController
 * fires first and the request never gets to see the server's (successful) answer.
 */
const SEMANTIC_SEARCH_TIMEOUT_MS = 50_000;

/**
 * Text-to-sound semantic search via MSCLAP CLAP embeddings.
 * Returns `{ items, page }` where each item is a self-describing track handle
 * with `images{}` hrefs and a `similarityScore`.
 * The endpoint returns 404 when `features.textToSound` is disabled.
 */
export function searchMusicByText(query: string, limit = 30, signal?: AbortSignal) {
    return apiGet('/api/music/text-search', MusicTextSearchResponseSchema, {
        params: { q: query, limit },
        timeout: SEMANTIC_SEARCH_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
    });
}

/**
 * Semantic lyrics search via Voyage text embeddings.
 * Returns `{ items, page }` where each item is a self-describing track handle
 * with `images{}` hrefs and a `similarityScore`.
 * The endpoint returns 404 when `features.lyricsSearch` is disabled.
 */
export function searchMusicByLyrics(query: string, limit = 30, signal?: AbortSignal) {
    return apiGet('/api/music/lyrics-search', MusicTextSearchResponseSchema, {
        params: { q: query, limit },
        timeout: SEMANTIC_SEARCH_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
    });
}

// =========================================================================
// Similar Albums (/api/music/albums/[id]/similar)
// =========================================================================

/**
 * Fetch albums that are acoustically similar to `albumId` using MSCLAP cosine
 * distance computed via the centroid of the album's track embeddings.
 *
 * The endpoint returns 404 when `features.sonicEmbeddings` is off — callers
 * must gate on the feature before calling this function.
 */
export function getSimilarAlbums(albumId: string, limit = 10) {
    return apiGet(`/api/music/albums/${albumId}/similar`, SimilarAlbumsResponseSchema, {
        params: { limit },
    });
}

// =========================================================================
// Album Series (/api/music/albums/[id]/series)
// =========================================================================

/**
 * The series `albumId` belongs to ("Future Trance Vol. 61 … 70"), detected
 * from album titles under the same album artist. Empty `albums` when none.
 */
export function getAlbumSeries(albumId: string) {
    return apiGet(`/api/music/albums/${albumId}/series`, AlbumSeriesResponseSchema);
}

// =========================================================================
// Similar Artists (/api/music/artists/[id]/similar)
// =========================================================================

/**
 * Fetch artists that are acoustically similar to `artistId` using MSCLAP
 * cosine distance computed via the centroid of all the artist's track
 * embeddings.
 *
 * The endpoint returns 404 when `features.sonicEmbeddings` is off — callers
 * must gate on the feature before calling this function.
 */
export function getSimilarArtists(artistId: string, limit = 10) {
    return apiGet(`/api/music/artists/${artistId}/similar`, SimilarArtistsResponseSchema, {
        params: { limit },
    });
}

// =========================================================================
// Sonic Path (/api/music/path)
// =========================================================================

/**
 * Fetch a sonic bridge between two seed tracks.
 *
 * Interpolates `steps` waypoints through the MSCLAP audio-embedding space
 * between `fromId` and `toId` and returns the nearest track at each step.
 *
 * The endpoint returns 404 when `features.sonicEmbeddings` is off, or 400
 * when either seed lacks an embedding (message indicates which).
 */
export function getSonicPath(fromId: string, toId: string, steps = 8, signal?: AbortSignal) {
    return apiGet('/api/music/path', SonicPathResponseSchema, {
        params: { from: fromId, to: toId, steps },
        ...(signal ? { signal } : {}),
    });
}

// =========================================================================
// Sonic Collections (Clusters)
// =========================================================================

/** Personalized, playable genre selections shared with the native clients. */
export function getMusicSmartMixes() {
    return apiGet('/api/music/sections/smart-mixes', MusicSmartMixSectionsSchema);
}

/** List all cluster summaries. */
export function getMusicClusters() {
    return apiGet('/api/music/sonic-mixes', MusicClustersResponseSchema);
}

/** Fetch member tracks for a single cluster. */
export function getMusicClusterMembers(clusterId: number, limit = 200, offset = 0) {
    return apiGet(`/api/music/sonic-mixes/${clusterId}/tracks`, MusicClusterTracksResponseSchema, {
        params: { limit, offset },
    });
}

// =========================================================================
// Music Map
// =========================================================================

export function getMusicMap() {
    return apiGet('/api/music/map', MusicMapResponseSchema);
}

// =========================================================================

// =========================================================================
// Quick Picks (load more)
// =========================================================================

export function loadMoreQuickPicks(body: { limit: number; excludeIds: string[] }) {
    return apiPost('/api/music/quick-picks', MusicQuickPicksResponseSchema, body);
}

// =========================================================================
// Taste Station Tracks
// =========================================================================

export function getStationTracks(stationId: string, limit = 50) {
    return apiGet(
        `/api/me/music/taste-stations/${encodeURIComponent(stationId)}/tracks`,
        MusicStationTracksResponseSchema,
        { params: { limit } },
    );
}

// =========================================================================
// Music Play Session
// =========================================================================

export function startMusicPlaySession(body: {
    trackId: string;
    deviceId: string;
    castTarget?: boolean;
}) {
    return startPlaySession({
        mediaId: body.trackId,
        castTarget: body.castTarget,
        deviceId: body.deviceId,
        capabilities: {
            containers: ['mp3', 'mp4', 'flac', 'ogg', 'wav'],
            videoCodecs: [],
            audioCodecs: ['mp3', 'aac', 'flac', 'opus', 'vorbis'],
            subtitleFormats: [],
            hdr: [],
        },
    });
}

export type MusicPlaybackReport = Pick<
    PlaybackReport,
    | 'positionMs'
    | 'status'
    | 'eventSeq'
    | 'sessionElapsedMs'
    | 'listenedTotalMs'
    | 'endReason'
    | 'crossfade'
    | 'nextMediaId'
>;

/** Release a discarded preload without recording listening progress. */
export function cancelMusicPlayback(sessionId: string): Promise<ApiResult<null>> {
    return apiDelete(`/api/play-sessions/${encodeURIComponent(sessionId)}`, NoContentSchema);
}

export function reportMusicPlayback(sessionId: string, body: MusicPlaybackReport) {
    return apiPut(
        `/api/play-sessions/${encodeURIComponent(sessionId)}`,
        SessionHeartbeatResponseSchema.nullable(),
        body,
    );
}

export function reportMusicPlaybackBeacon(sessionId: string, body: MusicPlaybackReport): boolean {
    return navigator.sendBeacon(
        apiUrl('internal', `/play-sessions/${encodeURIComponent(sessionId)}/beacon`),
        new Blob([JSON.stringify(body)], { type: 'application/json' }),
    );
}

// =========================================================================
// Music Alchemy Brew
// =========================================================================

export function brewAlchemy(body: {
    seedIds: string[];
    avoidIds: string[];
    energy: number;
    tempo: number;
    obscurity: number;
    limit: number;
}) {
    return apiPost('/api/music/alchemy/brew', BrewResponseSchema, body);
}
