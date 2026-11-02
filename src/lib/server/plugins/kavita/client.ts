// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Kavita API Client
 *
 * Handles authentication and API requests to Kavita server
 */

import { config } from '$lib/server/config.js';
import { fetchWithTimeout, TIMEOUTS } from '$lib/server/utils/fetch-utils.js';
import { Logger } from '$lib/server/utils/logger.js';
import type {
    KavitaAuthResponse,
    SearchResultGroupDto,
    KavitaSearchOptions,
    SeriesDto,
    LibraryDto,
} from './types.js';

const logger = Logger.for('KavitaClient');

// Cache the JWT token (API key auth returns a JWT for subsequent requests)
let cachedToken: string | null = null;
let tokenExpiry: number = 0;

/**
 * Get base URL without trailing slash
 */
function getBaseUrl(): string {
    return config.KAVITAURL.replace(/\/$/, '');
}

/**
 * Authenticate with Kavita using API key and get JWT token
 */
async function authenticate(): Promise<string> {
    // Check if we have a valid cached token (refresh 5 minutes before expiry)
    const now = Date.now();
    if (cachedToken && tokenExpiry > now + 5 * 60 * 1000) {
        return cachedToken;
    }

    const baseUrl = getBaseUrl();
    const apiKey = config.KAVITAAPIKEY;

    if (!baseUrl || !apiKey) {
        throw new Error('Kavita URL or API key not configured');
    }

    logger.debug('Authenticating with Kavita', { baseUrl });

    try {
        const response = await fetchWithTimeout(
            `${baseUrl}/api/Plugin/authenticate?apiKey=${apiKey}&pluginName=Lumastra`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
            },
            TIMEOUTS.DEFAULT,
        );

        if (!response.ok) {
            const errorText = await response.text();
            logger.error('Kavita authentication failed', new Error(errorText), {
                status: response.status,
            });
            throw new Error(`Kavita authentication failed: ${response.status} ${errorText}`);
        }

        const data = (await response.json()) as KavitaAuthResponse;

        if (!data.token) {
            throw new Error('No token received from Kavita');
        }

        cachedToken = data.token;
        // JWT tokens typically expire in 7 days, but we'll refresh more frequently
        tokenExpiry = now + 6 * 60 * 60 * 1000; // 6 hours

        logger.info('Successfully authenticated with Kavita');
        return cachedToken;
    } catch (error) {
        logger.error('Failed to authenticate with Kavita', error as Error);
        throw error;
    }
}

/**
 * Make an authenticated request to Kavita API
 */
async function apiRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const token = await authenticate();
    const baseUrl = getBaseUrl();

    const response = await fetchWithTimeout(
        `${baseUrl}${endpoint}`,
        {
            ...options,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                ...options.headers,
            },
        },
        TIMEOUTS.DEFAULT,
    );

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Kavita API error: ${response.status} ${errorText}`);
    }

    return response.json() as Promise<T>;
}

/**
 * Search across all Kavita content
 */
export async function search(options: KavitaSearchOptions): Promise<SearchResultGroupDto> {
    const { query, includeChapterAndFiles = false } = options;

    logger.debug('Searching Kavita', { query, includeChapterAndFiles });

    const params = new URLSearchParams({
        queryString: query,
        includeChapterAndFiles: String(includeChapterAndFiles),
    });

    // Kavita uses GET for search endpoint
    const results = await apiRequest<SearchResultGroupDto>(`/api/Search/search?${params}`, {
        method: 'GET',
    });

    logger.debug('Kavita search results', {
        query,
        seriesCount: results.series?.length ?? 0,
        collectionsCount: results.collections?.length ?? 0,
        personsCount: results.persons?.length ?? 0,
    });

    return results;
}

/**
 * Get series details by ID
 */
export async function getSeriesById(seriesId: number): Promise<SeriesDto> {
    return apiRequest<SeriesDto>(`/api/Series/${seriesId}`);
}

/**
 * Series metadata response type
 */
export interface SeriesMetadataDto {
    id: number;
    seriesId: number;
    summary?: string;
    genres?: Array<{ id: number; title: string }>;
    writers?: Array<{ id: number; name: string }>;
    publishers?: Array<{ id: number; name: string }>;
    releaseYear?: number;
    language?: string;
    ageRating?: number;
}

/**
 * Get series metadata (includes summary)
 */
export async function getSeriesMetadata(seriesId: number): Promise<SeriesMetadataDto> {
    return apiRequest<SeriesMetadataDto>(`/api/Series/metadata?seriesId=${seriesId}`);
}

/**
 * Get metadata for multiple series in parallel
 */
export async function getSeriesMetadataBatch(
    seriesIds: number[],
): Promise<Map<number, SeriesMetadataDto>> {
    const results = new Map<number, SeriesMetadataDto>();

    // Fetch in parallel with a reasonable batch size
    const batchSize = 10;
    for (let i = 0; i < seriesIds.length; i += batchSize) {
        const batch = seriesIds.slice(i, i + batchSize);
        const promises = batch.map(async (id) => {
            try {
                const metadata = await getSeriesMetadata(id);
                return { id, metadata };
            } catch (e) {
                logger.debug('Failed to fetch Kavita series metadata', {
                    id,
                    error: e,
                });
                return { id, metadata: null };
            }
        });

        const batchResults = await Promise.all(promises);
        for (const { id, metadata } of batchResults) {
            if (metadata) {
                results.set(id, metadata);
            }
        }
    }

    return results;
}

/**
 * Get all libraries
 */
export async function getLibraries(): Promise<LibraryDto[]> {
    return apiRequest<LibraryDto[]>('/api/Library/libraries');
}

/**
 * Get cover image URL for a series
 * Note: This returns a URL that can be fetched with API key auth
 */
export function getSeriesCoverUrl(seriesId: number): string {
    const baseUrl = getBaseUrl();
    const apiKey = config.KAVITAAPIKEY;
    return `${baseUrl}/api/Image/series-cover?seriesId=${seriesId}&apiKey=${apiKey}`;
}

/**
 * Get cover image URL for a volume
 */
export function getVolumeCoverUrl(volumeId: number): string {
    const baseUrl = getBaseUrl();
    const apiKey = config.KAVITAAPIKEY;
    return `${baseUrl}/api/Image/volume-cover?volumeId=${volumeId}&apiKey=${apiKey}`;
}

/**
 * Get cover image URL for a chapter
 */
export function getChapterCoverUrl(chapterId: number): string {
    const baseUrl = getBaseUrl();
    const apiKey = config.KAVITAAPIKEY;
    return `${baseUrl}/api/Image/chapter-cover?chapterId=${chapterId}&apiKey=${apiKey}`;
}

/**
 * Get cover image URL for a collection
 */
export function getCollectionCoverUrl(collectionId: number): string {
    const baseUrl = getBaseUrl();
    const apiKey = config.KAVITAAPIKEY;
    return `${baseUrl}/api/Image/collection-cover?collectionTagId=${collectionId}&apiKey=${apiKey}`;
}

/**
 * Get cover image URL for a reading list
 */
export function getReadingListCoverUrl(readingListId: number): string {
    const baseUrl = getBaseUrl();
    const apiKey = config.KAVITAAPIKEY;
    return `${baseUrl}/api/Image/readinglist-cover?readingListId=${readingListId}&apiKey=${apiKey}`;
}

/**
 * Get cover image URL for a person (author/artist)
 */
export function getPersonCoverUrl(personId: number): string {
    const baseUrl = getBaseUrl();
    const apiKey = config.KAVITAAPIKEY;
    return `${baseUrl}/api/Image/person-cover?personId=${personId}&apiKey=${apiKey}`;
}

/**
 * Test connection to Kavita server
 */
export async function testConnection(): Promise<boolean> {
    try {
        await authenticate();
        const libraries = await getLibraries();
        logger.info('Kavita connection test successful', {
            libraryCount: libraries.length,
        });
        return true;
    } catch (error) {
        logger.error('Kavita connection test failed', error as Error);
        return false;
    }
}

/**
 * Clear cached authentication token
 */
export function clearAuthCache(): void {
    cachedToken = null;
    tokenExpiry = 0;
}
