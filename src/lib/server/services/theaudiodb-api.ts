// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TheAudioDB API Client
 *
 * Free-tier client for artist image lookups.
 * Rate limit: 30 req/min (free tier with key "123").
 * No signup required.
 *
 * The free key used to be "2". TheAudioDB retired it: an unknown key now gets
 * HTTP 404 `{"Message":"Not found"}` for EVERY request, while a valid key
 * answers a miss with HTTP 200 `{"artists":null}`. So a non-2xx is never
 * "no such artist".
 *
 * Error contract: `searchArtist` and `searchAlbum` return `null` only when
 * TheAudioDB answered and has no match, and throw
 * `EnrichmentSourceUnavailableError` on any failure (network, non-2xx, parse
 * error), so the enrichment chains retry instead of tombstoning the item.
 *
 * @see https://www.theaudiodb.com/free_music_api
 */

import { fetchWithTimeout } from '$lib/server/utils/fetch-utils.js';
import { Logger } from '$lib/server/utils/logger.js';
import { sleepOrReject } from '$lib/server/utils/abortable-sleep.js';
import { awaitSharedToken } from '$lib/server/tasks/shared-rate-bucket.js';
import { trackExternalCall } from '$lib/server/utils/external-request-counter.js';
import { EnrichmentSourceUnavailableError } from './artist-enrichment.types.js';

import { artistNamesMatch } from './artist-name-match.js';
import { albumTitlesMatch, albumSearchQueries } from './album-title-match.js';

const logger = Logger.for('TheAudioDB');

const BASE_URL = 'https://www.theaudiodb.com/api/v1/json/123';
const USER_AGENT = 'Lumastra/1.0';
const RATE_LIMIT_MS = 2100; // ~30 req/min → one every 2s
const REQUEST_TIMEOUT_MS = 10000;

// Cross-replica cap. `lastRequestTime` below is process-local — album- and
// artist-enrichment are separate task ids and can run concurrently on
// different replicas, each independently pacing itself to ~30 req/min and
// so multiplying the *actual* outbound rate to TheAudioDB by the replica
// count. This bucket caps the fleet-wide aggregate near the documented
// 30 req/min limit (small safety margin: 28/min) via Valkey; when Valkey is
// unreachable `awaitSharedToken` fails open (grants immediately) and the
// local `RATE_LIMIT_MS` pacing below is the sole enforcement, same as today.
const SHARED_BUCKET_KEY = 'svc:theaudiodb';
const SHARED_RPS = 28 / 60;

// =============================================================================
// Types
// =============================================================================

export interface AudioDBArtist {
    idArtist: string;
    strArtist: string;
    strArtistThumb: string | null;
    strArtistFanart: string | null;
    strArtistBanner: string | null;
    strArtistLogo: string | null;
    strArtistWideThumb: string | null;
    strBiography: string | null;
    strBiographyDE: string | null;
    strGenre: string | null;
    strStyle: string | null;
    strMood: string | null;
    strCountryCode: string | null;
    strMusicBrainzID: string | null;
}

export interface ArtistImageResult {
    thumbUrl: string | null;
    fanartUrl: string | null;
    bannerUrl: string | null;
    musicBrainzId: string | null;
    biography: string | null;
    genre: string | null;
    countryCode: string | null;
}

// =============================================================================
// Rate Limiting
// =============================================================================

let lastRequestTime = 0;

async function rateLimitedFetch(url: string, signal?: AbortSignal): Promise<Response> {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < RATE_LIMIT_MS) {
        // Abortable sleep — the soft-budget drain can otherwise hang for a
        // full 2 seconds here even after the admin clicked "stop".
        await sleepOrReject(RATE_LIMIT_MS - elapsed, signal);
    }
    lastRequestTime = Date.now();
    // Cross-replica gate on top of the local pacing above. Waits (bounded,
    // abort-aware, internally retried on window rollover) rather than
    // failing the request outright — same shape as `ctx.dep()` /
    // `acquireHttpToken` in the task system's rate limiters.
    await awaitSharedToken(SHARED_BUCKET_KEY, SHARED_RPS, signal);
    return trackExternalCall(
        url,
        () =>
            fetchWithTimeout(
                url,
                {
                    headers: {
                        'User-Agent': USER_AGENT,
                        Accept: 'application/json',
                    },
                    ...(signal ? { signal } : {}),
                },
                REQUEST_TIMEOUT_MS,
            ),
        signal,
    );
}

// =============================================================================
// Album Types
// =============================================================================

interface AudioDBAlbum {
    idAlbum: string;
    strAlbum: string;
    strArtist: string;
    strAlbumThumb: string | null;
    strMusicBrainzID: string | null;
}

export interface AlbumImageResult {
    posterUrl: string | null;
    backdropUrl: string | null;
    releaseGroupMbid: string | null;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Search for an artist by name and return image URLs + metadata.
 * Free tier returns max 1 result per search.
 *
 * `options.signal` — when supplied, aborts both the inter-request cooldown
 * and the HTTP fetch. The sync drain composes its soft-budget deadline
 * into this signal so a stop click doesn't wait for the next 2 s tick.
 */
export async function searchArtist(
    artistName: string,
    options: { signal?: AbortSignal } = {},
): Promise<ArtistImageResult | null> {
    const encoded = encodeURIComponent(artistName.trim());
    const url = `${BASE_URL}/search.php?s=${encoded}`;

    let data: { artists?: AudioDBArtist[] | null } | null;
    try {
        const response = await rateLimitedFetch(url, options.signal);
        if (!response.ok) {
            logger.warn('TheAudioDB request failed', {
                url,
                status: response.status,
            });
            throw new EnrichmentSourceUnavailableError('theaudiodb', `HTTP ${response.status}`);
        }
        data = (await response.json()) as { artists?: AudioDBArtist[] | null } | null;
    } catch (error) {
        if (error instanceof EnrichmentSourceUnavailableError) throw error;
        // An abort is the caller stopping, not TheAudioDB failing.
        if (options.signal?.aborted) throw error;
        logger.warn('TheAudioDB request error', { artistName }, error as Error);
        throw new EnrichmentSourceUnavailableError(
            'theaudiodb',
            error instanceof Error ? error.message : String(error),
        );
    }

    // A real answer always has the `artists` key (null for a miss); a body
    // without it (e.g. `{"Message": ...}`) is an error response.
    if (!data || typeof data !== 'object' || !('artists' in data)) {
        throw new EnrichmentSourceUnavailableError('theaudiodb', 'unexpected response body');
    }
    const artist = data.artists?.[0];
    if (!artist?.strArtist) return null;

    // Verify the name is a reasonable match (case-insensitive)
    const queryNorm = artistName.trim().toLowerCase();
    const resultNorm = artist.strArtist.trim().toLowerCase();
    if (queryNorm !== resultNorm) {
        logger.debug('TheAudioDB name mismatch, skipping', {
            query: artistName,
            result: artist.strArtist,
        });
        return null;
    }

    return {
        thumbUrl: artist.strArtistThumb ?? null,
        fanartUrl: artist.strArtistFanart ?? null,
        bannerUrl: artist.strArtistBanner ?? null,
        musicBrainzId: artist.strMusicBrainzID ?? null,
        biography: artist.strBiography ?? artist.strBiographyDE ?? null,
        genre: artist.strGenre ?? null,
        countryCode: artist.strCountryCode ?? null,
    };
}

/**
 * Search for an album by artist and album name, returning cover image URL and
 * MusicBrainz release-group MBID.
 *
 * TheAudioDB's `strMusicBrainzID` on album records is the release-GROUP MBID
 * (not a release MBID), which is the correct input for Cover Art Archive's
 * `release-group/{mbid}` endpoint.
 *
 * `options.signal` — aborts both the inter-request cooldown and the HTTP fetch.
 * Shares the module-level `lastRequestTime` with `searchArtist` so all
 * TheAudioDB requests share the same rate-limit pool.
 */
export async function searchAlbum(
    artistName: string,
    albumName: string,
    options: { signal?: AbortSignal } = {},
): Promise<AlbumImageResult | null> {
    for (const query of albumSearchQueries(albumName)) {
        const result = await searchAlbumQuery(artistName, albumName, query, options);
        if (result) return result;
        if (options.signal?.aborted) break;
    }
    return null;
}

async function searchAlbumQuery(
    artistName: string,
    albumName: string,
    query: string,
    options: { signal?: AbortSignal },
): Promise<AlbumImageResult | null> {
    const encodedArtist = encodeURIComponent(artistName.trim());
    const encodedAlbum = encodeURIComponent(query);
    const url = `${BASE_URL}/searchalbum.php?s=${encodedArtist}&a=${encodedAlbum}`;

    let data: { album?: AudioDBAlbum[] | null } | null;
    try {
        const response = await rateLimitedFetch(url, options.signal);
        if (!response.ok) {
            logger.warn('TheAudioDB album request failed', {
                url,
                status: response.status,
            });
            throw new EnrichmentSourceUnavailableError('theaudiodb', `HTTP ${response.status}`);
        }
        data = (await response.json()) as { album?: AudioDBAlbum[] | null } | null;
    } catch (error) {
        if (error instanceof EnrichmentSourceUnavailableError) throw error;
        // An abort is the caller stopping, not TheAudioDB failing.
        if (options.signal?.aborted) throw error;
        logger.warn('TheAudioDB album request error', { artistName, albumName }, error as Error);
        throw new EnrichmentSourceUnavailableError(
            'theaudiodb',
            error instanceof Error ? error.message : String(error),
        );
    }

    // A real answer always has the `album` key (null for a miss); a body
    // without it (e.g. `{"Message": ...}`) is an error response.
    if (!data || typeof data !== 'object' || !('album' in data)) {
        throw new EnrichmentSourceUnavailableError('theaudiodb', 'unexpected response body');
    }
    const album = data.album?.find(
        (candidate) =>
            candidate?.strAlbum &&
            candidate.strArtist &&
            artistNamesMatch(artistName, candidate.strArtist) &&
            albumTitlesMatch(albumName, candidate.strAlbum),
    );
    if (!album) return null;

    return {
        posterUrl: album.strAlbumThumb ?? null,
        backdropUrl: null,
        releaseGroupMbid: album.strMusicBrainzID ?? null,
    };
}
