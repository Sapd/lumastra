// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MusicBrainz API Client
 *
 * Rate-limited client for the MusicBrainz web service (1 req/sec).
 * User-Agent header is required by MusicBrainz policy.
 */

import { fetchWithTimeout } from '$lib/server/utils/fetch-utils.js';
import { Logger } from '$lib/server/utils/logger.js';
import { trackExternalCall } from '$lib/server/utils/external-request-counter.js';

const logger = Logger.for('MusicBrainzApiClient');

const MB_BASE_URL = 'https://musicbrainz.org/ws/2';
const MB_USER_AGENT = 'Lumastra/1.0 (https://github.com/lumastra)';
const RATE_LIMIT_MS = 1100;
const REQUEST_TIMEOUT_MS = 15000;

// =============================================================================
// MusicBrainz API Response Interfaces
// =============================================================================

export interface MBTag {
    name: string;
    count: number;
}

export interface MBArtistCredit {
    name: string;
    artist: {
        id: string;
        name: string;
        'sort-name': string;
    };
    joinphrase?: string;
}

export interface MBRecordingResult {
    id: string;
    title: string;
    length?: number;
    score?: number;
    'artist-credit'?: MBArtistCredit[];
    releases?: Array<{
        id: string;
        title: string;
        date?: string;
        'release-group'?: {
            id: string;
            'primary-type'?: string;
        };
    }>;
    tags?: MBTag[];
}

export interface MBTrack {
    id: string;
    number: string;
    title: string;
    length?: number;
    position: number;
    recording?: {
        id: string;
        title: string;
        length?: number;
    };
}

export interface MBMedium {
    position: number;
    format?: string;
    'track-count': number;
    tracks?: MBTrack[];
}

export interface MBRelease {
    id: string;
    title: string;
    date?: string;
    country?: string;
    status?: string;
    'artist-credit'?: MBArtistCredit[];
    'release-group'?: {
        id: string;
        title: string;
        'primary-type'?: string;
        'secondary-types'?: string[];
        tags?: MBTag[];
    };
    media?: MBMedium[];
    tags?: MBTag[];
    genres?: MBTag[];
    'label-info'?: Array<{
        label?: { id: string; name: string };
        'catalog-number'?: string;
    }>;
}

export interface MBRelationship {
    type: string;
    'target-type': string;
    direction: string;
    artist?: {
        id: string;
        name: string;
        'sort-name': string;
    };
    url?: {
        id: string;
        resource: string;
    };
    attributes?: string[];
}

export interface MBArtist {
    id: string;
    name: string;
    'sort-name': string;
    type?: string;
    country?: string;
    area?: { name: string };
    disambiguation?: string;
    'life-span'?: {
        begin?: string;
        end?: string;
        ended?: boolean;
    };
    tags?: MBTag[];
    genres?: MBTag[];
    relations?: MBRelationship[];
    'release-groups'?: MBReleaseGroup[];
}

export interface MBReleaseGroup {
    id: string;
    title: string;
    'primary-type'?: string;
    'secondary-types'?: string[];
    'first-release-date'?: string;
    'artist-credit'?: MBArtistCredit[];
    tags?: MBTag[];
    genres?: MBTag[];
    releases?: Array<{
        id: string;
        title: string;
        date?: string;
        status?: string;
    }>;
}

interface MBSearchResponse<T> {
    count: number;
    offset: number;
    recordings?: T[];
    releases?: T[];
    artists?: T[];
    'release-groups'?: T[];
}

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
    return trackExternalCall(url, () =>
        fetchWithTimeout(
            url,
            {
                headers: {
                    'User-Agent': MB_USER_AGENT,
                    Accept: 'application/json',
                },
            },
            REQUEST_TIMEOUT_MS,
        ),
    );
}

async function mbGet<T>(endpoint: string, params: Record<string, string> = {}): Promise<T | null> {
    const qs = new URLSearchParams({ fmt: 'json', ...params }).toString();
    const url = `${MB_BASE_URL}/${endpoint}?${qs}`;

    // Network/abort failures are NOT caught here — a rejection from
    // rateLimitedFetch (network error, DNS failure, timeout) propagates as a
    // throw straight out of mbGet, through searchRecording/getRelease/
    // getArtist/getReleaseGroup (none of which wrap this call in a catch),
    // and out to the caller.
    const response = await rateLimitedFetch(url);

    // 404 is MusicBrainz's "no such entity" response for by-id lookups
    // (release/{mbid}, artist/{mbid}, release-group/{mbid}) — genuinely no
    // data, not an outage. Keep returning null ONLY for this case.
    if (response.status === 404) return null;

    // Every OTHER non-ok status (429, 5xx, other 4xx) means the request did
    // not get an authoritative answer. Previously this returned null the
    // same as a genuine miss, so searchRecording()/getRelease()/etc. silently
    // returned `[]`/`null` for a total MusicBrainz outage — indistinguishable
    // from "no matches"/"not found", which enrichment/matching flows then
    // recorded as a confident negative. Throw instead so the outage surfaces
    // to the caller.
    if (!response.ok) {
        logger.warn('MusicBrainz request failed', {
            url,
            status: response.status,
        });
        throw new Error(
            `MusicBrainz request failed: ${response.status} ${response.statusText} — ${url}`,
        );
    }

    return (await response.json()) as T;
}

// MusicBrainz MBIDs are standard UUIDs. Cheap shape check before building a
// URL from caller-supplied input — rejects garbage without a network round
// trip.
const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidMbid(mbid: string): boolean {
    return MBID_PATTERN.test(mbid);
}

// =============================================================================
// Public API Functions
// =============================================================================

/**
 * Search for recordings (tracks) by title and optional artist.
 */
export async function searchRecording(title: string, artist: string): Promise<MBRecordingResult[]> {
    const query = artist ? `recording:"${title}" AND artist:"${artist}"` : `recording:"${title}"`;

    const result = await mbGet<MBSearchResponse<MBRecordingResult>>('recording', {
        query,
        limit: '10',
        inc: 'releases+artist-credits+tags',
    });

    return result?.recordings ?? [];
}

/**
 * Fetch full release (album) metadata by MusicBrainz release ID.
 */
export async function getRelease(mbid: string): Promise<MBRelease | null> {
    if (!isValidMbid(mbid)) {
        logger.warn('musicbrainz: malformed release mbid, skipping request', { mbid });
        return null;
    }
    // encodeURIComponent guards against caller-supplied input being
    // interpolated into the path raw (path/query injection).
    return mbGet<MBRelease>(`release/${encodeURIComponent(mbid)}`, {
        inc: 'artist-credits+labels+recordings+release-groups+tags+genres',
    });
}

/**
 * Fetch artist metadata by MusicBrainz artist ID.
 */
export async function getArtist(mbid: string): Promise<MBArtist | null> {
    if (!isValidMbid(mbid)) {
        logger.warn('musicbrainz: malformed artist mbid, skipping request', { mbid });
        return null;
    }
    return mbGet<MBArtist>(`artist/${encodeURIComponent(mbid)}`, {
        inc: 'release-groups+tags+genres+url-rels+artist-rels',
    });
}

/**
 * Fetch release group metadata by MusicBrainz release group ID.
 */
export async function getReleaseGroup(mbid: string): Promise<MBReleaseGroup | null> {
    if (!isValidMbid(mbid)) {
        logger.warn('musicbrainz: malformed release-group mbid, skipping request', { mbid });
        return null;
    }
    return mbGet<MBReleaseGroup>(`release-group/${encodeURIComponent(mbid)}`, {
        inc: 'artist-credits+releases+tags+genres',
    });
}
