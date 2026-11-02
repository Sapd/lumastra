// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Last.fm API Client
 *
 * Pure HTTP client for the Last.fm REST API.
 * Rate limit: ~5 req/s observed safe threshold (200ms gap).
 * All requests are unauthenticated GET calls requiring only an API key.
 *
 * Endpoints used:
 *   artist.getinfo       — artist metadata, tags, bio, similar artists
 *   artist.gettoptracks  — ranked track list with listener/playcount data
 *
 * Error contract: public helpers return `null` on any failure (network,
 * non-2xx, parse error). Callers treat music-metadata enrichment as
 * best-effort — a missing Last.fm hit is not a sync-failure, just a row
 * that stays in the "no-match" bucket for the next run. Do NOT lift these
 * errors into `throw` without updating every caller.
 *
 * @see https://www.last.fm/api/show/artist.getInfo
 * @see https://www.last.fm/api/show/artist.getTopTracks
 */

import { fetchWithTimeout } from '$lib/server/utils/fetch-utils.js';
import { Logger } from '$lib/server/utils/logger.js';
import { sleepOrReject } from '$lib/server/utils/abortable-sleep.js';
import { trackExternalCall } from '$lib/server/utils/external-request-counter.js';

const logger = Logger.for('LastFmAPI');

const BASE_URL = 'https://ws.audioscrobbler.com/2.0/';
const USER_AGENT = 'Lumastra/1.0';
const RATE_LIMIT_MS = 200;
const REQUEST_TIMEOUT_MS = 10000;

// =============================================================================
// Exported Types
// =============================================================================

export interface LastFmArtistInfo {
    name: string;
    mbid: string | null;
    url: string;
    listeners: number;
    playcount: number;
    tags: string[];
    similar: string[];
    bioSummary: string | null;
}

export interface LastFmTopTrack {
    name: string;
    rank: number;
    listeners: number;
    playcount: number;
    mbid: string | null;
    url: string;
}

// =============================================================================
// Internal Response Interfaces
// =============================================================================

interface LastFmTagItem {
    name: string;
    url: string;
}

interface LastFmSimilarArtistItem {
    name: string;
    url: string;
    image: unknown[];
}

interface LastFmArtistResponse {
    name: string;
    mbid?: string;
    url: string;
    stats?: {
        listeners?: string;
        playcount?: string;
    };
    tags?: {
        tag?: LastFmTagItem[];
    };
    similar?: {
        artist?: LastFmSimilarArtistItem[];
    };
    bio?: {
        summary?: string;
    };
}

interface LastFmGetInfoResponse {
    artist?: LastFmArtistResponse;
    error?: number;
    message?: string;
}

interface LastFmTrackItem {
    name: string;
    url: string;
    mbid?: string;
    listeners?: string;
    playcount?: string;
    '@attr'?: {
        rank?: string;
    };
    artist?: {
        name: string;
        url: string;
    };
}

interface LastFmGetTopTracksResponse {
    toptracks?: {
        track?: LastFmTrackItem[];
    };
    error?: number;
    message?: string;
}

// =============================================================================
// Rate Limiting
// =============================================================================

let lastRequestTime = 0;

async function rateLimitedFetch(url: string, signal?: AbortSignal): Promise<Response> {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < RATE_LIMIT_MS) {
        // Abortable wait — the sync drain's soft-budget signal propagates
        // through here so a stopped run exits in milliseconds instead of
        // holding onto the last 200ms-ish rate-limit window. Reject-on-abort
        // so the about-to-run fetchWithTimeout doesn't see a stale signal.
        await sleepOrReject(RATE_LIMIT_MS - elapsed, signal);
    }
    lastRequestTime = Date.now();
    return trackExternalCall(
        url,
        () =>
            fetchWithTimeout(
                url,
                {
                    headers: { 'User-Agent': USER_AGENT },
                    ...(signal ? { signal } : {}),
                },
                REQUEST_TIMEOUT_MS,
            ),
        signal,
    );
}

// =============================================================================
// Helpers
// =============================================================================

function buildUrl(params: Record<string, string>): string {
    const query = new URLSearchParams({ ...params, format: 'json' });
    return `${BASE_URL}?${query.toString()}`;
}

function stripHtml(text: string): string {
    return text.replace(/<[^>]*>/g, '').trim();
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Fetch artist metadata from Last.fm including stats, tags, similar artists,
 * and biography. Prefers mbid lookup; falls back to name.
 */
export async function getArtistInfo(params: {
    mbid?: string;
    name?: string;
    apiKey: string;
    signal?: AbortSignal;
}): Promise<LastFmArtistInfo | null> {
    const { mbid, name, apiKey, signal } = params;

    if (!apiKey) {
        logger.debug('no api key configured');
        return null;
    }

    const identifier = mbid ?? name;
    if (!identifier) {
        logger.warn('getArtistInfo called with neither mbid nor name');
        return null;
    }

    const queryParams: Record<string, string> = {
        method: 'artist.getinfo',
        autocorrect: '1',
        api_key: apiKey,
    };
    if (mbid) {
        queryParams['mbid'] = mbid;
    } else if (name) {
        queryParams['artist'] = name;
    }

    const url = buildUrl(queryParams);

    try {
        const response = await rateLimitedFetch(url, signal);
        if (!response.ok) {
            logger.warn('Last.fm artist.getinfo failed', {
                status: response.status,
                identifier,
            });
            return null;
        }

        const data = (await response.json()) as LastFmGetInfoResponse;

        if (data.error !== undefined || !data.artist) {
            logger.warn('Last.fm artist.getinfo error in response', {
                error: data.error,
                message: data.message,
                identifier,
            });
            return null;
        }

        const artist = data.artist;
        const rawBio = artist.bio?.summary ?? null;

        return {
            name: artist.name,
            mbid: artist.mbid || null,
            url: artist.url,
            listeners: parseInt(artist.stats?.listeners ?? '0', 10),
            playcount: parseInt(artist.stats?.playcount ?? '0', 10),
            tags: (artist.tags?.tag ?? []).slice(0, 10).map((t) => t.name),
            similar: (artist.similar?.artist ?? []).slice(0, 10).map((a) => a.name),
            bioSummary: rawBio ? stripHtml(rawBio) || null : null,
        };
    } catch (error) {
        logger.warn('Last.fm getArtistInfo request error', { identifier }, error as Error);
        return null;
    }
}

/**
 * Fetch top tracks for an artist from Last.fm, ranked by listener count.
 * Prefers mbid lookup; falls back to name.
 */
export async function getArtistTopTracks(params: {
    mbid?: string;
    name?: string;
    apiKey: string;
    limit?: number;
    signal?: AbortSignal;
}): Promise<LastFmTopTrack[] | null> {
    const { mbid, name, apiKey, limit = 30, signal } = params;

    if (!apiKey) {
        logger.debug('no api key configured');
        return null;
    }

    const identifier = mbid ?? name;
    if (!identifier) {
        logger.warn('getArtistTopTracks called with neither mbid nor name');
        return null;
    }

    const queryParams: Record<string, string> = {
        method: 'artist.gettoptracks',
        autocorrect: '1',
        limit: String(limit),
        api_key: apiKey,
    };
    if (mbid) {
        queryParams['mbid'] = mbid;
    } else if (name) {
        queryParams['artist'] = name;
    }

    const url = buildUrl(queryParams);

    try {
        const response = await rateLimitedFetch(url, signal);
        if (!response.ok) {
            logger.warn('Last.fm artist.gettoptracks failed', {
                status: response.status,
                identifier,
            });
            return null;
        }

        const data = (await response.json()) as LastFmGetTopTracksResponse;

        if (data.error !== undefined || !data.toptracks) {
            logger.warn('Last.fm artist.gettoptracks error in response', {
                error: data.error,
                message: data.message,
                identifier,
            });
            return null;
        }

        const tracks = data.toptracks.track ?? [];

        return tracks.map((t) => ({
            name: t.name,
            rank: parseInt(t['@attr']?.rank ?? '0', 10),
            listeners: parseInt(t.listeners ?? '0', 10),
            playcount: parseInt(t.playcount ?? '0', 10),
            mbid: t.mbid || null,
            url: t.url,
        }));
    } catch (error) {
        logger.warn('Last.fm getArtistTopTracks request error', { identifier }, error as Error);
        return null;
    }
}
