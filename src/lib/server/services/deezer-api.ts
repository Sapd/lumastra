// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Deezer API Client (artist images and album covers)
 *
 * Public search endpoint, no key and no signup. Documented limit is 50
 * requests / 5 s per IP; we pace well under that.
 *
 * WHY THIS SOURCE EXISTS. TheAudioDB and Discogs between them leave a large
 * hole in the long tail — in the reference production library 2,093 of 4,916
 * artists (42.6%) had no image at all, every one of them having already
 * exhausted both sources. Probing 60 of those names against Deezer resolved
 * 40 (67%) to an exact-name match with a real photo. Deezer's catalogue is
 * simply much deeper on obscure electronic/dance acts, which is what a long
 * tail mostly is.
 *
 * Returns null only for an answered miss; failures throw
 * EnrichmentSourceUnavailableError so enrichment remains retryable.
 *
 * @see https://developers.deezer.com/api/search
 */

import { fetchWithTimeout } from '$lib/server/utils/fetch-utils.js';
import { Logger } from '$lib/server/utils/logger.js';
import { sleepOrReject } from '$lib/server/utils/abortable-sleep.js';
import { awaitSharedToken } from '$lib/server/tasks/shared-rate-bucket.js';
import { trackExternalCall } from '$lib/server/utils/external-request-counter.js';
import { artistNamesMatch, artistSearchQueries } from './artist-name-match.js';
import { EnrichmentSourceUnavailableError } from './artist-enrichment.types.js';
import type { ArtistEnrichmentResult } from './artist-enrichment.types.js';
import type { AlbumEnrichmentResult } from './album-enrichment.types.js';
import { albumTitlesMatch, albumSearchQueries } from './album-title-match.js';

const logger = Logger.for('Deezer');

const BASE_URL = 'https://api.deezer.com';
const USER_AGENT = 'Lumastra/1.0';
/** Documented allowance is 50 req / 5 s; 200 ms local pacing = 5 req/s. */
const RATE_LIMIT_MS = 200;
const REQUEST_TIMEOUT_MS = 10000;

// Cross-replica cap, same rationale as TheAudioDB's: `lastRequestTime` is
// process-local, so N replicas each pacing themselves to 5 rps would emit
// 5N rps at Deezer. Fails open when Valkey is unreachable, leaving the local
// pacing as sole enforcement.
const SHARED_BUCKET_KEY = 'svc:deezer';
const SHARED_RPS = 5;

/**
 * How many search results to examine for an exact name match.
 *
 * Not 1: Deezer ranks by popularity, so a more famous fuzzy neighbour
 * routinely outranks the exact match we want ("DJ Auzern" returns the real
 * DJ Auzern at rank 1 but "Dj Auler" at rank 3; other queries invert that).
 * Not large either: past a handful, anything still matching exactly is more
 * likely a name collision than our artist.
 */
const MAX_CANDIDATES = 5;

interface DeezerArtist {
    id: number;
    name: string;
    picture_medium?: string | null;
    picture_big?: string | null;
    picture_xl?: string | null;
}

interface DeezerSearchResponse<T> {
    data?: T[];
    error?: { type?: string; message?: string; code?: number };
}

let lastRequestTime = 0;

/**
 * Serialises the pacing above. `lastRequestTime` alone is a check-then-set:
 * two callers in one process both read it before either writes, both sleep the
 * same amount, and both fire at once — the scheduled drain is sequential, but
 * an admin per-item retry takes a lock keyed on the ITEM, so a retry can run
 * alongside the drain or alongside another retry. Chaining every caller onto
 * one promise makes the reservation atomic without a lock.
 */
let pacingChain: Promise<void> = Promise.resolve();

/** Reserve the next slot, resolving when this caller may issue its request. */
function reserveSlot(signal?: AbortSignal): Promise<void> {
    const wait = pacingChain.then(async () => {
        const elapsed = Date.now() - lastRequestTime;
        if (elapsed < RATE_LIMIT_MS) {
            await sleepOrReject(RATE_LIMIT_MS - elapsed, signal);
        }
        lastRequestTime = Date.now();
    });
    // Keep the chain alive even when this caller's wait rejects (abort), so one
    // aborted request cannot wedge every later one.
    pacingChain = wait.then(
        () => undefined,
        () => undefined,
    );
    return wait;
}

async function rateLimitedFetch(url: string, signal?: AbortSignal): Promise<Response> {
    await reserveSlot(signal);
    await awaitSharedToken(SHARED_BUCKET_KEY, SHARED_RPS, signal);
    return trackExternalCall(
        url,
        () =>
            fetchWithTimeout(
                url,
                {
                    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
                    ...(signal ? { signal } : {}),
                },
                REQUEST_TIMEOUT_MS,
            ),
        signal,
    );
}

/**
 * Deezer serves a shared placeholder for artists it has no photo for. The
 * URL carries an EMPTY md5 segment — `/images/artist//1000x1000-...jpg` — so
 * it is always a well-formed, 200-OK image of nothing.
 *
 * Storing one would be worse than storing nothing: `custom_poster_url` is a
 * pointer the UI trusts, and a non-null pointer PREEMPTS the catalog
 * fallback chain, permanently pinning the artist to a blank grey square.
 */
function isPlaceholderPicture(url: string | null | undefined): boolean {
    if (!url) return true;
    return /\/artist\/\/|\/images\/artist\/?$/.test(url);
}

function pickPicture(artist: DeezerArtist): string | null {
    for (const candidate of [artist.picture_xl, artist.picture_big, artist.picture_medium]) {
        if (!isPlaceholderPicture(candidate)) return candidate as string;
    }
    return null;
}

/**
 * Search Deezer for an artist by name and return its picture.
 *
 * Only an EXACT normalised-name match is accepted — see artist-name-match.ts
 * for why anything looser actively corrupts the library.
 *
 * Deezer exposes no biography, MBID, genre or country on the artist object,
 * so this source fills the image fields only; the chain merges it with
 * whatever TheAudioDB/Discogs supplied for the rest.
 *
 * Returns `null` only when Deezer answered and has no usable match. Any
 * failure (network, non-2xx, error payload, bad body) throws
 * `EnrichmentSourceUnavailableError` so the artist is retried later rather
 * than marked no-match.
 */
export async function searchArtistDeezer(
    artistName: string,
    options: { signal?: AbortSignal } = {},
): Promise<ArtistEnrichmentResult | null> {
    for (const query of artistSearchQueries(artistName)) {
        const result = await searchArtistQuery(artistName, query, options);
        if (result) return result;
        if (options.signal?.aborted) break;
    }
    return null;
}

async function searchArtistQuery(
    artistName: string,
    query: string,
    options: { signal?: AbortSignal },
): Promise<ArtistEnrichmentResult | null> {
    const url = `${BASE_URL}/search/artist?limit=${MAX_CANDIDATES}&q=${encodeURIComponent(query)}`;

    const candidates = await fetchSearchData<DeezerArtist>(url, artistName, options.signal);
    if (!candidates) return null;
    const match = candidates.find((a) => a?.name && artistNamesMatch(artistName, a.name));
    if (!match) {
        logger.debug('Deezer: no exact name match', {
            query: artistName,
            considered: candidates.map((a) => a?.name).filter(Boolean),
        });
        return null;
    }

    const picture = pickPicture(match);
    if (!picture) {
        // Matched the right artist, but Deezer holds only the placeholder.
        logger.debug('Deezer: exact match has no real picture', { artistName });
        return null;
    }

    return {
        thumbUrl: picture,
        fanartUrl: null,
        bannerUrl: null,
        musicBrainzId: null,
        biography: null,
        genre: null,
        countryCode: null,
    };
}

/** Both endpoints share pacing, the fleet bucket, accounting and failure semantics. */
async function fetchSearchData<T>(
    url: string,
    query: string,
    signal?: AbortSignal,
): Promise<T[] | null> {
    let body: DeezerSearchResponse<T> | null;
    try {
        const response = await rateLimitedFetch(url, signal);
        if (!response.ok) {
            logger.warn('Deezer request failed', { status: response.status, query });
            throw new EnrichmentSourceUnavailableError('deezer', `HTTP ${response.status}`);
        }
        body = (await response.json()) as DeezerSearchResponse<T> | null;
    } catch (error) {
        if (error instanceof EnrichmentSourceUnavailableError) throw error;
        // An abort is the caller stopping, not Deezer failing.
        if (signal?.aborted) throw error;
        logger.warn('Deezer request error', { query }, error as Error);
        throw new EnrichmentSourceUnavailableError(
            'deezer',
            error instanceof Error ? error.message : String(error),
        );
    }

    // Deezer signals quota and other faults with HTTP 200 + an `error`
    // object, so a non-ok check alone is not enough. Code 800
    // (DataException "no data") is an answer, not a fault.
    if (Number(body?.error?.code) === 800) return null;
    if (body?.error) {
        logger.warn('Deezer returned an error payload', {
            query,
            type: body.error.type,
            message: body.error.message,
        });
        throw new EnrichmentSourceUnavailableError(
            'deezer',
            `${body.error.type ?? 'error'}: ${body.error.message ?? ''}`.trim(),
        );
    }

    // A real answer always carries a `data` array (empty for a miss). Anything
    // else is a broken response, not proof the artist doesn't exist.
    if (!Array.isArray(body?.data)) {
        throw new EnrichmentSourceUnavailableError('deezer', 'unexpected response body');
    }
    return body.data;
}

interface DeezerAlbum {
    title: string;
    artist?: { name?: string };
    cover_xl?: string | null;
    cover_big?: string | null;
}

/** Strict artist + base-title identity, even when Deezer ranks fuzzy neighbours first. */
export async function searchAlbumDeezer(
    artistName: string,
    albumTitle: string,
    options: { signal?: AbortSignal } = {},
): Promise<AlbumEnrichmentResult | null> {
    // Quotes/backslashes supplied by tags must not become search operators.
    const quote = (value: string): string => `"${value.replace(/["\\]/g, ' ')}"`;
    for (const title of albumSearchQueries(albumTitle)) {
        const query = `artist:${quote(artistName)} album:${quote(title)}`;
        const url = `${BASE_URL}/search/album?limit=${MAX_CANDIDATES}&q=${encodeURIComponent(query)}`;
        const candidates = await fetchSearchData<DeezerAlbum>(url, query, options.signal);
        for (const candidate of candidates ?? []) {
            if (
                !candidate?.title ||
                !candidate.artist?.name ||
                !artistNamesMatch(artistName, candidate.artist.name) ||
                !albumTitlesMatch(albumTitle, candidate.title)
            )
                continue;
            const posterUrl = [candidate.cover_xl, candidate.cover_big].find(
                (url) => url && !/\/cover\/\/|\/images\/cover\/?$/.test(url),
            );
            if (!posterUrl) continue;
            return {
                posterUrl,
                backdropUrl: null,
                releaseMbid: null,
                releaseGroupMbid: null,
            };
        }
        if (options.signal?.aborted) break;
    }
    return null;
}
