// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LRCLIB Lyrics Integration
 *
 * Fetches plain and synced (LRC) lyrics from lrclib.net.
 * No API key required. Rate limit: ~5 req/sec.
 */

import { fetchWithTimeout } from '$lib/server/utils/fetch-utils.js';
import { Logger } from '$lib/server/utils/logger.js';
import { trackExternalCall } from '$lib/server/utils/external-request-counter.js';

const logger = Logger.for('LrcLib');

const LRCLIB_API_URL = 'https://lrclib.net/api';
const REQUEST_TIMEOUT_MS = 10000;
const RATE_LIMIT_MS = 250; // 4/sec to stay safely under ~5/sec
// LRCLIB rejects `duration` outside 1..3600 with a 400 ValidationError.
const MAX_DURATION_SECONDS = 3600;

// =============================================================================
// Rate Limiting
// =============================================================================

let lastRequestTime = 0;

async function rateLimitedFetch(url: string): Promise<Response> {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < RATE_LIMIT_MS) {
        await new Promise<void>((resolve) => setTimeout(resolve, RATE_LIMIT_MS - elapsed));
    }
    lastRequestTime = Date.now();
    return trackExternalCall(url, () => fetchWithTimeout(url, {}, REQUEST_TIMEOUT_MS));
}

// =============================================================================
// Interfaces
// =============================================================================

export interface LrcLibResult {
    plainLyrics: string | null;
    syncedLyrics: string | null;
}

interface LrcLibApiResponse {
    id?: number;
    trackName?: string;
    artistName?: string;
    albumName?: string;
    duration?: number;
    instrumental?: boolean;
    plainLyrics?: string | null;
    syncedLyrics?: string | null;
}

/** Provider fault with the server's retry hint retained for persistent per-track backoff. */
export class LrcLibRequestError extends Error {
    constructor(
        public readonly status: number,
        statusText: string,
        url: string,
        public readonly retryAfterMs?: number,
    ) {
        super(`LRCLIB request failed: ${status} ${statusText} — ${url}`);
    }
}

function retryAfterMs(value: string | null): number | undefined {
    if (!value?.trim()) return undefined;
    const seconds = Number(value);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
    return Number.isFinite(delay) && delay >= 0 ? delay : undefined;
}

// =============================================================================
// Internal Helpers
// =============================================================================

function parseLrcLibResponse(data: LrcLibApiResponse): LrcLibResult {
    return {
        plainLyrics: data.plainLyrics ?? null,
        syncedLyrics: data.syncedLyrics ?? null,
    };
}

async function lrcGet(
    endpoint: string,
    params: Record<string, string>,
): Promise<LrcLibApiResponse | null> {
    const qs = new URLSearchParams(params).toString();
    const url = `${LRCLIB_API_URL}/${endpoint}?${qs}`;

    // Network/abort failures are NOT caught here — they propagate as a throw
    // straight out of lrcGet, same as mbGet.
    const response = await rateLimitedFetch(url);

    // 404 is LRCLIB's "no lyrics for this track" response — genuinely no
    // data, not an outage. Keep returning null ONLY for this case.
    if (response.status === 404) return null;

    // 400 is LRCLIB's ValidationError for this exact query (e.g. duration out
    // of range). Retrying can never succeed, so it is a definitive miss, not
    // an outage — unlike 429/5xx below.
    if (response.status === 400) {
        logger.warn('LRCLIB rejected the query as invalid', { url, status: response.status });
        return null;
    }

    // Every OTHER non-ok status (429, 5xx, other 4xx) means the request did
    // not get an authoritative answer. Previously this returned null the
    // same as a genuine miss, making an LRCLIB outage indistinguishable from
    // "no lyrics available" — getLyrics()/getLyricsByMusicBrainzId() would
    // silently swallow the outage forever. Throw instead so it surfaces to
    // the caller (mirrors the mbGet fix).
    if (!response.ok) {
        logger.warn('LRCLIB request failed', {
            url,
            status: response.status,
        });
        throw new LrcLibRequestError(
            response.status,
            response.statusText,
            url,
            retryAfterMs(response.headers?.get('Retry-After') ?? null),
        );
    }

    return (await response.json()) as LrcLibApiResponse;
}

// =============================================================================
// Public Functions
// =============================================================================

/**
 * Look up lyrics by track metadata.
 * Returns null for a definitive miss; provider and network failures throw.
 */
export async function getLyrics(params: {
    artistName: string;
    trackTitle: string;
    albumName?: string;
    duration?: number;
}): Promise<LrcLibResult | null> {
    // Over-limit durations (DJ mixes, audiobooks) can never be looked up:
    // LRCLIB answers 400. Skip the request and report a miss.
    if (params.duration !== undefined && params.duration > MAX_DURATION_SECONDS) return null;

    const queryParams: Record<string, string> = {
        artist_name: params.artistName,
        track_name: params.trackTitle,
    };

    if (params.albumName) {
        queryParams.album_name = params.albumName;
    }
    if (params.duration !== undefined) {
        queryParams.duration = String(params.duration);
    }

    const data = await lrcGet('get', queryParams);
    if (!data) return null;

    const result = parseLrcLibResponse(data);

    if (!result.plainLyrics && !result.syncedLyrics) return null;

    return result;
}

/**
 * Look up lyrics by MusicBrainz recording ID.
 * This is the preferred lookup path when a recording ID is available.
 * Returns null for a definitive miss; provider and network failures throw.
 */
export async function getLyricsByMusicBrainzId(recordingId: string): Promise<LrcLibResult | null> {
    const data = await lrcGet(`get/${recordingId}`, {});
    if (!data) return null;

    const result = parseLrcLibResponse(data);

    if (!result.plainLyrics && !result.syncedLyrics) return null;

    return result;
}
