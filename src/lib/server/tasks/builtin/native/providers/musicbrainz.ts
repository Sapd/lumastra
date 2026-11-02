// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MusicBrainz metadata provider.
 *
 * MusicBrainz provides music metadata via its open web service API
 * (no API key required) and Cover Art Archive. Handles artist, album, and
 * recording lookups for the music enrichment pipeline. The AcoustID key
 * declared in `settings` is read by the `acoustid-fingerprint` task.
 *
 * Helpers (api-client, acoustid, cover-art, lrclib) live at
 * `src/lib/server/providers/implementations/musicbrainz/`. Field-authority defaults are
 * declared in `metadata` below.
 *
 * MusicBrainz rate limit: 1 rps (per MusicBrainz API usage policy).
 * User-Agent header is mandatory per MusicBrainz API terms.
 */

import { defineProvider } from '@sapd/lumastra-plugin-sdk';
import type { PluginContext } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../../registry.js';
// Result shapes + pure transforms are shared (transport-agnostic) with the
// direct-fetch enrichment client. This provider supplies its own ctx.http
// transport; only the JSON shapes and pure helpers are reused.
import {
    extractGenres,
    primaryArtistName,
    releaseYear,
} from '$lib/server/providers/implementations/musicbrainz/music-shapes.js';
import type {
    MusicAlbumCandidate,
    MusicAlbumDetail,
    MusicTrackStub,
    MusicArtistDetail,
} from '$lib/server/providers/implementations/musicbrainz/music-shapes.js';
import { encodePathSegment } from '$lib/server/utils/upstream-path';
import { readBoundedResponseJson } from '$lib/server/utils/bounded-response.js';

/** A MusicBrainz search/lookup answer is well under 1 MiB. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MB_BASE_URL = 'https://musicbrainz.org/ws/2';
const MB_USER_AGENT = 'Lumastra/1.0 (https://github.com/lumastra)';
const CAA_BASE_URL = 'https://coverartarchive.org';

// ---------------------------------------------------------------------------
// MusicBrainz API response interfaces
// ---------------------------------------------------------------------------

interface MBTag {
    name: string;
    count: number;
}

interface MBArtistCredit {
    name: string;
    artist: {
        id: string;
        name: string;
        'sort-name': string;
    };
    joinphrase?: string;
}

interface MBRecordingResult {
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
    genres?: Array<{ name: string }>;
}

interface MBTrack {
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

interface MBMedium {
    position: number;
    format?: string;
    'track-count': number;
    tracks?: MBTrack[];
}

interface MBRelease {
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
        genres?: Array<{ name: string }>;
    };
    media?: MBMedium[];
    tags?: MBTag[];
    genres?: Array<{ name: string }>;
    'label-info'?: Array<{
        label?: { id: string; name: string };
        'catalog-number'?: string;
    }>;
}

interface MBArtist {
    id: string;
    name: string;
    'sort-name': string;
    type?: string;
    country?: string;
    disambiguation?: string;
    'life-span'?: {
        begin?: string;
        end?: string;
        ended?: boolean;
    };
    tags?: MBTag[];
    genres?: Array<{ name: string }>;
    'release-groups'?: Array<{
        id: string;
        title: string;
        'primary-type'?: string;
        'first-release-date'?: string;
    }>;
}

interface MBSearchResponse<T> {
    count: number;
    offset: number;
    recordings?: T[];
    releases?: T[];
    artists?: T[];
}

// ---------------------------------------------------------------------------
// Param / result shapes
// ---------------------------------------------------------------------------

export interface MusicBrainzSearchParams {
    type: 'artist' | 'album' | 'recording';
    query: string;
    artist?: string;
}

export interface MusicArtistCandidate {
    mbid: string;
    name: string;
    sortName: string;
    type?: string;
    country?: string;
    score: number;
}

export interface MusicRecordingCandidate {
    mbid: string;
    title: string;
    artistName: string;
    durationMs?: number;
    score: number;
    releaseMbid?: string;
    releaseTitle?: string;
}

export type MusicBrainzItem =
    | MusicArtistCandidate
    | MusicArtistDetail
    | MusicAlbumCandidate
    | MusicAlbumDetail
    | MusicRecordingCandidate
    | MusicTrackStub;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function coverArtUrl(releaseMbid: string): string {
    return `${CAA_BASE_URL}/release/${encodePathSegment(releaseMbid)}/front`;
}

// ---------------------------------------------------------------------------
// MusicBrainz HTTP helpers using ctx.http
// ---------------------------------------------------------------------------

async function mbGet<T>(
    ctx: PluginContext,
    endpoint: string,
    params: Record<string, string> = {},
): Promise<T | null> {
    if (!ctx.http) throw new Error('musicbrainz: http capability required');

    const qs = new URLSearchParams({ fmt: 'json', ...params }).toString();
    const url = `${MB_BASE_URL}/${endpoint}?${qs}`;

    // Network/abort failures are NOT caught here — `ctx.http.get()`
    // rejecting (network error, DNS failure, cancellation) propagates as a
    // throw straight out of mbGet, through mbSearchRecording/mbSearchArtist/
    // mbGetRelease/mbGetArtist (none of which wrap this call in a catch),
    // and out of search()/detail()/childList() to the caller.
    const response = await ctx.http.get(url, {
        headers: {
            'User-Agent': MB_USER_AGENT,
            Accept: 'application/json',
        },
    });

    // 404 is MusicBrainz's "no such entity" response for by-id lookups
    // (release/{mbid}, artist/{mbid}) — genuinely no data, not an outage.
    // Keep returning null ONLY for this case.
    if (response.status === 404) return null;

    // Every OTHER non-ok status (429, 5xx, other 4xx) means the request
    // did not get an authoritative answer. Previously this returned null
    // the same as a genuine miss, so search() silently returned `[]` for a
    // total MusicBrainz outage — indistinguishable from "no matches", which
    // auto-match flows then recorded as a confident negative. Throw instead
    // so the outage surfaces to the caller.
    if (!response.ok) {
        ctx.logger.warn('MusicBrainz request failed', {
            url,
            status: response.status,
        });
        throw new Error(
            `MusicBrainz request failed: ${response.status} ${response.statusText} — ${url}`,
        );
    }

    return (await readBoundedResponseJson(response, MAX_RESPONSE_BYTES)) as T;
}

async function mbSearchRecording(
    ctx: PluginContext,
    title: string,
    artist: string,
): Promise<MBRecordingResult[]> {
    const query = artist ? `recording:"${title}" AND artist:"${artist}"` : `recording:"${title}"`;

    const result = await mbGet<MBSearchResponse<MBRecordingResult>>(ctx, 'recording', {
        query,
        limit: '10',
        inc: 'releases+artist-credits+tags',
    });

    return result?.recordings ?? [];
}

// MusicBrainz MBIDs are standard UUIDs. Cheap shape check before building a
// URL from caller-supplied input — rejects garbage without a network round
// trip, same intent as mdblist.ts's numeric-tmdbId validation.
const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidMbid(mbid: string): boolean {
    return MBID_PATTERN.test(mbid);
}

async function mbGetRelease(ctx: PluginContext, mbid: string): Promise<MBRelease | null> {
    if (!isValidMbid(mbid)) {
        ctx.logger.warn('musicbrainz: malformed release mbid, skipping request', { mbid });
        return null;
    }
    // encodeURIComponent mirrors jellyfin.ts/mdblist.ts — mbid is
    // caller-supplied and must not be interpolated into the path raw.
    return mbGet<MBRelease>(ctx, `release/${encodeURIComponent(mbid)}`, {
        inc: 'artist-credits+labels+recordings+release-groups+tags+genres',
    });
}

async function mbGetArtist(ctx: PluginContext, mbid: string): Promise<MBArtist | null> {
    if (!isValidMbid(mbid)) {
        ctx.logger.warn('musicbrainz: malformed artist mbid, skipping request', { mbid });
        return null;
    }
    return mbGet<MBArtist>(ctx, `artist/${encodeURIComponent(mbid)}`, {
        inc: 'release-groups+tags+genres+url-rels+artist-rels',
    });
}

async function mbSearchArtist(ctx: PluginContext, query: string): Promise<MusicArtistCandidate[]> {
    const result = await mbGet<MBSearchResponse<MBArtist & { score?: number }>>(ctx, 'artist', {
        query: `artist:"${query}"`,
        limit: '10',
    });

    return (result?.artists ?? []).map((a) => ({
        mbid: a.id,
        name: a.name,
        sortName: a['sort-name'],
        type: a.type,
        country: a.country,
        score: (a.score ?? 50) / 100,
    }));
}

// ---------------------------------------------------------------------------
// Public search helpers (inlined from legacy index.ts)
// ---------------------------------------------------------------------------

async function searchAlbum(
    ctx: PluginContext,
    title: string,
    artist?: string,
): Promise<MusicAlbumCandidate[]> {
    const recordings = await mbSearchRecording(ctx, title, artist ?? '');

    const seen = new Set<string>();
    const candidates: MusicAlbumCandidate[] = [];

    for (const rec of recordings) {
        for (const release of rec.releases ?? []) {
            if (seen.has(release.id)) continue;
            seen.add(release.id);

            candidates.push({
                mbid: release.id,
                title: release.title,
                artistName: primaryArtistName(rec['artist-credit']),
                year: releaseYear(release.date),
                releaseGroupMbid: release['release-group']?.id,
                primaryType: release['release-group']?.['primary-type'],
                confidence: (rec.score ?? 50) / 100,
                coverArtUrl: coverArtUrl(release.id),
            });
        }
    }

    return candidates.sort((a, b) => b.confidence - a.confidence);
}

async function searchRecordings(
    ctx: PluginContext,
    title: string,
    artist?: string,
): Promise<MusicRecordingCandidate[]> {
    const recordings = await mbSearchRecording(ctx, title, artist ?? '');

    return recordings.map((rec) => ({
        mbid: rec.id,
        title: rec.title,
        artistName: primaryArtistName(rec['artist-credit']),
        durationMs: rec.length,
        score: (rec.score ?? 50) / 100,
        releaseMbid: rec.releases?.[0]?.id,
        releaseTitle: rec.releases?.[0]?.title,
    }));
}

// ---------------------------------------------------------------------------
// Detail helpers
// ---------------------------------------------------------------------------

async function getAlbumDetail(ctx: PluginContext, mbid: string): Promise<MusicAlbumDetail | null> {
    const release = await mbGetRelease(ctx, mbid);
    if (!release) return null;

    const rg = release['release-group'];
    const rgGenres = extractGenres(rg);
    const releaseGenres = extractGenres(release);
    const allGenres = [...new Set([...rgGenres, ...releaseGenres])];

    const artistCredit = release['artist-credit']?.[0];
    const tracks: MusicTrackStub[] = [];

    for (const medium of release.media ?? []) {
        for (const track of medium.tracks ?? []) {
            tracks.push({
                position: track.position,
                title: track.title,
                durationMs: track.length ?? track.recording?.length,
                recordingMbid: track.recording?.id,
            });
        }
    }

    const labelInfo = release['label-info']?.[0];

    return {
        mbid: release.id,
        title: release.title,
        artistName: artistCredit?.artist?.name ?? 'Unknown Artist',
        artistMbid: artistCredit?.artist?.id,
        year: releaseYear(release.date),
        label: labelInfo?.label?.name,
        catalogNumber: labelInfo?.['catalog-number'],
        primaryType: rg?.['primary-type'],
        genres: allGenres,
        tags: allGenres,
        tracks,
        coverArtUrl: coverArtUrl(mbid),
        releaseGroupMbid: rg?.id,
    };
}

async function getArtistDetail(
    ctx: PluginContext,
    mbid: string,
): Promise<MusicArtistDetail | null> {
    const artist = await mbGetArtist(ctx, mbid);
    if (!artist) return null;

    const genres = extractGenres(artist);

    const releaseGroups = (artist['release-groups'] ?? []).map((rg) => ({
        mbid: rg.id,
        title: rg.title,
        primaryType: rg['primary-type'],
        year: releaseYear(rg['first-release-date']),
    }));

    return {
        mbid: artist.id,
        name: artist.name,
        sortName: artist['sort-name'],
        type: artist.type,
        country: artist.country,
        beginDate: artist['life-span']?.begin,
        endDate: artist['life-span']?.end,
        genres,
        tags: genres,
        releaseGroups,
    };
}

// ---------------------------------------------------------------------------
// Provider definition
// ---------------------------------------------------------------------------

export const musicbrainzProvider = defineProvider<MusicBrainzSearchParams, MusicBrainzItem>({
    id: 'musicbrainz-metadata-provider',
    name: 'MusicBrainz',
    version: '1.0.0',

    capabilities: { http: true, cache: true },

    rateLimit: { rps: 1 },

    metadata: {
        priority: 70,
        cacheTtlHours: 48,
        fieldAuthorities: {
            genres: 10,
            keywords: 10,
            release_date: 8,
            title: 5,
        },
    },

    settings: {
        fields: [
            {
                key: 'ACOUSTID_API_KEY',
                type: 'secret',
                label: 'AcoustID API Key',
                description:
                    'Free key from acoustid.org. Lets the background fingerprint task identify tracks that have no MusicBrainz tags by their sound. Optional.',
                default: '',
            },
        ],
    },

    async isConfigured(_ctx): Promise<boolean> {
        // MusicBrainz is open — no API key required.
        return true;
    },

    async search(ctx, params): Promise<MusicBrainzItem[]> {
        switch (params.type) {
            case 'artist':
                return searchArtist(ctx, params.query);
            case 'album':
                return searchAlbum(ctx, params.query, params.artist);
            case 'recording':
                return searchRecordings(ctx, params.query, params.artist);
        }
    },

    async detail(ctx, id): Promise<MusicBrainzItem> {
        const colonIdx = id.indexOf(':');
        if (colonIdx === -1) {
            throw new Error(`musicbrainz detail: invalid id format "${id}", expected "type:mbid"`);
        }

        const type = id.slice(0, colonIdx);
        const mbid = id.slice(colonIdx + 1);

        switch (type) {
            case 'artist': {
                const detail = await getArtistDetail(ctx, mbid);
                if (!detail) throw new Error(`musicbrainz: artist ${mbid} not found`);
                return detail;
            }
            case 'release': {
                const detail = await getAlbumDetail(ctx, mbid);
                if (!detail) throw new Error(`musicbrainz: release ${mbid} not found`);
                return detail;
            }
            case 'recording': {
                const recordings = await mbSearchRecording(ctx, mbid, '');
                const rec = recordings[0];
                if (!rec) throw new Error(`musicbrainz: recording ${mbid} not found`);
                return {
                    mbid: rec.id,
                    title: rec.title,
                    artistName: primaryArtistName(rec['artist-credit']),
                    durationMs: rec.length,
                    score: (rec.score ?? 50) / 100,
                    releaseMbid: rec.releases?.[0]?.id,
                    releaseTitle: rec.releases?.[0]?.title,
                } satisfies MusicRecordingCandidate;
            }
            default:
                throw new Error(`musicbrainz detail: unknown type "${type}"`);
        }
    },

    async childList(ctx, parentId): Promise<MusicBrainzItem[]> {
        const colonIdx = parentId.indexOf(':');
        if (colonIdx === -1) {
            throw new Error(
                `musicbrainz childList: invalid parentId format "${parentId}", expected "type:mbid"`,
            );
        }

        const type = parentId.slice(0, colonIdx);
        const mbid = parentId.slice(colonIdx + 1);

        switch (type) {
            case 'artist': {
                // Returns artist's release-group stubs (albums, singles, EPs).
                const artist = await mbGetArtist(ctx, mbid);
                if (!artist) return [];
                return (artist['release-groups'] ?? []).map((rg) => ({
                    mbid: rg.id,
                    title: rg.title,
                    artistName: artist.name,
                    primaryType: rg['primary-type'],
                    year: releaseYear(rg['first-release-date']),
                    confidence: 1,
                    coverArtUrl: undefined,
                })) satisfies MusicAlbumCandidate[];
            }
            case 'release': {
                // Returns track stubs for a release.
                const release = await mbGetRelease(ctx, mbid);
                if (!release) return [];
                const tracks: MusicTrackStub[] = [];
                for (const medium of release.media ?? []) {
                    for (const track of medium.tracks ?? []) {
                        tracks.push({
                            position: track.position,
                            title: track.title,
                            durationMs: track.length ?? track.recording?.length,
                            recordingMbid: track.recording?.id,
                        });
                    }
                }
                return tracks;
            }
            default:
                throw new Error(`musicbrainz childList: unsupported parent type "${type}"`);
        }
    },
});

// Self-register so loadBuiltins() import is sufficient.
registry.registerProvider(musicbrainzProvider);

// ---------------------------------------------------------------------------
// searchArtist — local helper (not exported separately; available via search)
// ---------------------------------------------------------------------------

async function searchArtist(ctx: PluginContext, query: string): Promise<MusicArtistCandidate[]> {
    return mbSearchArtist(ctx, query);
}
