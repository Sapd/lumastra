// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Discogs API Client
 *
 * Authenticated client for artist image/metadata lookups.
 * Rate limit: 60 req/min (authenticated).
 * Requires a personal access token.
 *
 * Two-step lookup: search by name → fetch artist details for full images.
 *
 * Error contract: `searchArtistDiscogs` and `searchReleaseDiscogs` return
 * `null` only when Discogs answered and has no exact match (or, for a release,
 * no token is set), and throw `EnrichmentSourceUnavailableError` when a request
 * fails (network, non-2xx, parse error), so the enrichment chains retry instead
 * of tombstoning the item. The other public helpers return `null` on any
 * failure.
 *
 * @see https://www.discogs.com/developers
 */

import { fetchWithTimeout } from '$lib/server/utils/fetch-utils.js';
import { isVariousArtistsName } from '$lib/shared/various-artists.js';
import type { AlbumReleaseIdentifiers } from '$lib/server/database/queries/album-local-art.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import { sleepOrReject } from '$lib/server/utils/abortable-sleep.js';
import { awaitSharedToken } from '$lib/server/tasks/shared-rate-bucket.js';
import { trackExternalCall } from '$lib/server/utils/external-request-counter.js';
import { discogsCatalogueUrl } from '$lib/shared/music-provenance.js';
import { encodePathSegment } from '$lib/server/utils/upstream-path.js';
import { describeConnectionTestError } from '$lib/server/utils/fetch-error-cause.js';
import type { MusicFieldSource } from '$lib/shared/music-provenance.js';
import { artistNamesMatch, artistSearchQueries } from './artist-name-match.js';
import { albumTitlesMatch, albumSearchQueries } from './album-title-match.js';
import { EnrichmentSourceUnavailableError } from './artist-enrichment.types.js';
import type { ArtistEnrichmentResult } from './artist-enrichment.types.js';

const logger = Logger.for('DiscogsAPI');

const BASE_URL = 'https://api.discogs.com';
const USER_AGENT = 'Lumastra/1.0';
const RATE_LIMIT_MS = 1100; // ~55 req/min (stay under 60)
const REQUEST_TIMEOUT_MS = 10000;

// Cross-replica cap. `lastRequestTime` below is process-local — album- and
// artist-enrichment are separate task ids and can run concurrently on
// different replicas, each independently pacing itself to ~55 req/min and
// so multiplying the *actual* outbound rate to Discogs by the replica
// count. This bucket caps the fleet-wide aggregate near the documented
// 55 req/min budget via Valkey; when Valkey is unreachable
// `awaitSharedToken` fails open (grants immediately) and the local
// `RATE_LIMIT_MS` pacing below is the sole enforcement, same as today.
const SHARED_BUCKET_KEY = 'svc:discogs';
const SHARED_RPS = 55 / 60;

// =============================================================================
// Types
// =============================================================================

interface DiscogsSearchResult {
    id: number;
    type: string;
    title: string;
    thumb: string;
    cover_image: string;
    resource_url: string;
    year?: string | number;
    barcode?: string[];
}

interface DiscogsArtistDetail {
    id: number;
    name: string;
    profile: string;
    images?: Array<{
        type: 'primary' | 'secondary';
        uri: string;
        uri150: string;
        width: number;
        height: number;
    }>;
    urls?: string[];
}

// =============================================================================
// Rate Limiting
// =============================================================================

let lastRequestTime = 0;

async function rateLimitedFetch(
    url: string,
    token: string,
    signal?: AbortSignal,
): Promise<Response> {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < RATE_LIMIT_MS) {
        // Abortable sleep — lets the sync drain exit cleanly instead of
        // waiting a full 1.1s per pending artist after an abort fires.
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
                        Authorization: `Discogs token=${token}`,
                        Accept: 'application/vnd.discogs.v2.plaintext+json',
                    },
                    ...(signal ? { signal } : {}),
                },
                REQUEST_TIMEOUT_MS,
            ),
        signal,
    );
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Validate a Discogs personal access token by calling the authenticated
 * identity endpoint. Unlike the enrichment search helpers (which swallow errors
 * and return `null`), this backs the admin "Test token" action and returns a
 * discriminated result so the UI can show a precise message.
 *
 * `GET /oauth/identity` → 200 + `{ username }` when the token is valid, 401 when
 * invalid. No search quota is consumed. A single manual admin call, so it
 * bypasses the enrichment rate-limit bucket.
 */
export async function verifyDiscogsToken(
    token: string,
    signal?: AbortSignal,
): Promise<{ ok: boolean; username?: string; error?: string }> {
    const trimmed = token.trim();
    if (!trimmed) return { ok: false, error: 'No token provided' };
    try {
        const res = await fetchWithTimeout(
            `${BASE_URL}/oauth/identity`,
            {
                headers: {
                    'User-Agent': USER_AGENT,
                    Authorization: `Discogs token=${trimmed}`,
                    Accept: 'application/json',
                },
                ...(signal ? { signal } : {}),
            },
            REQUEST_TIMEOUT_MS,
        );
        if (res.status === 401) return { ok: false, error: 'Invalid token' };
        if (!res.ok) return { ok: false, error: `Discogs returned HTTP ${res.status}` };
        const body = (await res.json().catch(() => null)) as { username?: string } | null;
        return { ok: true, username: body?.username };
    } catch (err) {
        // The token rides in the Authorization header; the message never echoes it.
        return {
            ok: false,
            error: describeConnectionTestError(err, `${BASE_URL}/oauth/identity`, [trimmed]),
        };
    }
}

/**
 * Search for an artist by name on Discogs and return image URLs + metadata.
 * Requires a personal access token.
 *
 * `options.signal` — composes an abort into both the cooldown sleep and
 * the HTTP fetches so a stopped drain doesn't keep firing the second
 * (detail) request after the abort.
 */
export async function searchArtistDiscogs(
    artistName: string,
    token: string,
    options: { signal?: AbortSignal } = {},
): Promise<ArtistEnrichmentResult | null> {
    if (!token) {
        logger.debug('No Discogs token configured, skipping');
        return null;
    }

    const queries = artistSearchQueries(artistName);
    if (!queries.length) return null;

    try {
        // Retry a miss once with a broader query, but compare every candidate
        // against the ORIGINAL name, never the relaxed search terms.
        let match: DiscogsSearchResult | undefined;
        for (const query of queries) {
            if (options.signal?.aborted) return null;
            const searchUrl = `${BASE_URL}/database/search?q=${encodeURIComponent(query)}&type=artist&per_page=5`;
            const searchResp = await rateLimitedFetch(searchUrl, token, options.signal);
            if (!searchResp.ok) {
                logger.warn('Discogs search failed', { status: searchResp.status, artistName });
                throw new EnrichmentSourceUnavailableError('discogs', `HTTP ${searchResp.status}`);
            }
            const searchData = (await searchResp.json()) as {
                results?: DiscogsSearchResult[];
            } | null;
            if (!Array.isArray(searchData?.results)) {
                throw new EnrichmentSourceUnavailableError('discogs', 'unexpected response body');
            }
            match = searchData.results.find(
                (r) => r?.title && artistNamesMatch(artistName, r.title),
            );
            if (match) break;
        }
        if (!match) {
            logger.debug('No exact match on Discogs', { artistName });
            return null;
        }

        // Between-step abort check — avoids firing the detail request
        // when the drain was stopped while we were parsing the search
        // response.
        if (options.signal?.aborted) return null;

        const catalogueUrl = discogsCatalogueUrl('artist', match.id);
        if (!catalogueUrl) return null;
        const source: MusicFieldSource = { provider: 'discogs', url: catalogueUrl };

        // Step 2: Fetch full artist details for images + profile
        const detailResp = await rateLimitedFetch(
            `${BASE_URL}/artists/${encodePathSegment(match.id)}`,
            token,
            options.signal,
        ).catch(() => null);
        if (options.signal?.aborted) return null;
        if (!detailResp?.ok) {
            const fallbackThumb = match.cover_image || match.thumb || null;
            // The match is real but its images are only in the detail we
            // failed to fetch: that is a failure, not an artist without one.
            if (!fallbackThumb) {
                throw new EnrichmentSourceUnavailableError(
                    'discogs',
                    `artist detail ${detailResp ? `HTTP ${detailResp.status}` : 'request failed'}`,
                );
            }
            // Fall back to search result thumbnail
            return {
                provenance: { thumbUrl: source },
                thumbUrl: fallbackThumb,
                fanartUrl: null,
                bannerUrl: null,
                musicBrainzId: null,
                biography: null,
                genre: null,
                countryCode: null,
            };
        }

        const detail = (await detailResp.json().catch(() => null)) as DiscogsArtistDetail | null;
        const primaryImage = detail?.images?.find((img) => img.type === 'primary');
        const secondaryImage = detail?.images?.find((img) => img.type === 'secondary');

        return {
            provenance: { thumbUrl: source, fanartUrl: source, biography: source },
            thumbUrl: primaryImage?.uri ?? match.cover_image ?? match.thumb ?? null,
            fanartUrl: secondaryImage?.uri ?? null,
            bannerUrl: null,
            musicBrainzId: null, // Discogs doesn't provide MBID directly
            biography: detail?.profile || null,
            genre: null, // Genre is on releases, not artists
            countryCode: null,
        };
    } catch (error) {
        if (error instanceof EnrichmentSourceUnavailableError) throw error;
        // An abort is the caller stopping, not Discogs failing.
        if (options.signal?.aborted) throw error;
        logger.warn('Discogs request error', { artistName }, error as Error);
        throw new EnrichmentSourceUnavailableError(
            'discogs',
            error instanceof Error ? error.message : String(error),
        );
    }
}

// =============================================================================
// Album Release Search
// =============================================================================

interface DiscogsReleaseDetail {
    id: number;
    title: string;
    images?: Array<{
        type: 'primary' | 'secondary';
        uri: string;
        uri150: string;
        width: number;
        height: number;
    }>;
}

export interface AlbumReleaseResult {
    provenance?: Partial<Record<'posterUrl' | 'backdropUrl', MusicFieldSource>>;
    posterUrl: string | null;
    backdropUrl: string | null;
    releaseId: string | null;
}

function normalizeBarcode(value: string): string {
    return value.replace(/[\s-]+/gu, '');
}

function matchesRelease(
    result: DiscogsSearchResult,
    artistName: string,
    albumTitle: string,
    options: AlbumReleaseIdentifiers,
): boolean {
    if (result.type !== 'release' || !discogsCatalogueUrl('release', result.id)) return false;
    const separator = result.title.indexOf(' - ');
    if (separator === -1) return false;
    const artist = result.title.slice(0, separator).trim();
    const title = result.title.slice(separator + 3).trim();
    if (!albumTitlesMatch(title, albumTitle)) return false;
    const compilation = isVariousArtistsName(artistName);
    if (compilation) {
        // Generic compilation names recur with unrelated tracklists. A fuzzy
        // identifier search is not evidence that this is the same release.
        const yearMatches =
            typeof options.year === 'number' &&
            Number.isInteger(options.year) &&
            options.year > 0 &&
            Number(result.year) === options.year;
        const barcode = options.barcode ? normalizeBarcode(options.barcode) : '';
        const barcodeMatches =
            !!barcode &&
            Array.isArray(result.barcode) &&
            result.barcode.some(
                (value) => typeof value === 'string' && normalizeBarcode(value) === barcode,
            );
        if (!yearMatches && !barcodeMatches) return false;
        return isVariousArtistsName(artist);
    }
    // Identifiers narrow retrieval; they never override the artist identity.
    return artistNamesMatch(artist, artistName);
}

/**
 * Search for a release by artist name and album title on Discogs and return
 * image URLs + the Discogs release ID.
 *
 * Two-step lookup: search → release detail. Shares the module-level rate-limit
 * pool with `searchArtistDiscogs`.
 *
 * `options.signal` — composes an abort into both the cooldown sleep and the
 * HTTP fetches so a stopped drain doesn't keep firing the detail request
 * after the abort.
 */
export async function searchReleaseDiscogs(
    artistName: string,
    albumTitle: string,
    token: string,
    options: AlbumReleaseIdentifiers & { signal?: AbortSignal } = {},
): Promise<AlbumReleaseResult | null> {
    if (!token) {
        logger.debug('No Discogs token configured, skipping');
        return null;
    }

    const encodedArtist = encodeURIComponent(
        isVariousArtistsName(artistName) ? 'Various' : artistName.trim(),
    );

    try {
        // Identifier searches narrow candidates; release identity must still agree.
        // Every request uses the same local + fleet-wide rate limit as title searches.
        const searches: { url: string }[] = [];
        if (options.barcode?.trim())
            searches.push({
                url: `${BASE_URL}/database/search?type=release&barcode=${encodeURIComponent(options.barcode.trim())}&per_page=5`,
            });
        if (options.catalogueNumber?.trim())
            searches.push({
                url: `${BASE_URL}/database/search?type=release&catno=${encodeURIComponent(options.catalogueNumber.trim())}&per_page=5`,
            });
        for (const title of albumSearchQueries(albumTitle)) {
            searches.push({
                url: `${BASE_URL}/database/search?type=release&artist=${encodedArtist}&release_title=${encodeURIComponent(title)}&per_page=5`,
            });
        }
        let match: DiscogsSearchResult | undefined;
        for (const search of searches) {
            // The first request propagates abort errors as before; between searches stop quietly.
            if (options.signal?.aborted && search !== searches[0]) return null;
            const searchResp = await rateLimitedFetch(search.url, token, options.signal);
            if (!searchResp.ok)
                throw new EnrichmentSourceUnavailableError('discogs', `HTTP ${searchResp.status}`);
            const searchData = (await searchResp.json()) as {
                results?: DiscogsSearchResult[];
            } | null;
            if (!Array.isArray(searchData?.results))
                throw new EnrichmentSourceUnavailableError('discogs', 'unexpected response body');
            match = searchData.results.find((result) =>
                matchesRelease(result, artistName, albumTitle, options),
            );
            if (match) break;
        }

        if (!match) {
            logger.debug('No exact release match on Discogs', {
                artistName,
                albumTitle,
            });
            return null;
        }

        // Between-step abort check — avoids firing the detail request
        // when the drain was stopped while we were parsing the search
        // response.
        if (options.signal?.aborted) return null;

        const catalogueUrl = discogsCatalogueUrl('release', match.id);
        if (!catalogueUrl) return null;
        const source: MusicFieldSource = { provider: 'discogs', url: catalogueUrl };

        // Step 2: Fetch full release details for images
        const detailResp = await rateLimitedFetch(
            `${BASE_URL}/releases/${encodePathSegment(match.id)}`,
            token,
            options.signal,
        ).catch(() => null);
        if (options.signal?.aborted) return null;
        if (!detailResp?.ok) {
            const fallbackPoster = match.cover_image || match.thumb || null;
            // The match is real but its images are only in the detail we
            // failed to fetch: that is a failure, not a release without one.
            if (!fallbackPoster) {
                throw new EnrichmentSourceUnavailableError(
                    'discogs',
                    `release detail ${detailResp ? `HTTP ${detailResp.status}` : 'request failed'}`,
                );
            }
            // Fall back to search result thumbnail
            return {
                provenance: { posterUrl: source },
                posterUrl: fallbackPoster,
                backdropUrl: null,
                releaseId: match.id != null ? String(match.id) : null,
            };
        }

        const detail = (await detailResp.json().catch(() => null)) as DiscogsReleaseDetail | null;
        const primaryImage = detail?.images?.find((img) => img.type === 'primary');
        const secondaryImage = detail?.images?.find((img) => img.type === 'secondary');

        const detailUrl = discogsCatalogueUrl('release', detail?.id) ?? catalogueUrl;
        const detailSource: MusicFieldSource = { provider: 'discogs', url: detailUrl };
        return {
            provenance: { posterUrl: detailSource, backdropUrl: detailSource },
            posterUrl: primaryImage?.uri ?? match.cover_image ?? match.thumb ?? null,
            backdropUrl: secondaryImage?.uri ?? null,
            releaseId: detailUrl.split('/').at(-1) ?? null,
        };
    } catch (error) {
        if (error instanceof EnrichmentSourceUnavailableError) throw error;
        // An abort is the caller stopping, not Discogs failing.
        if (options.signal?.aborted) throw error;
        logger.warn('Discogs release request error', { artistName, albumTitle }, error as Error);
        throw new EnrichmentSourceUnavailableError(
            'discogs',
            error instanceof Error ? error.message : String(error),
        );
    }
}
