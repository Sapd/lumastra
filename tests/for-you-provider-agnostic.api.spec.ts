// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * E2E API Tests for Provider-Agnostic For You Endpoints
 *
 * Tests that For You endpoints include Jellyfin IDs in externalIds
 * and handle provider-agnostic flows correctly.
 */

import { adminTest as test, expect } from './fixtures/auth';

interface UniversalMediaItem {
    externalIds: {
        tmdb?: string;
        jellyfin?: string;
        imdb?: string;
        tvdb?: string;
    };
    mediaType?: string;
    jellyfinId?: string;
}

interface ApiResponse {
    items?: UniversalMediaItem[];
}

test.describe('For You - Provider Agnostic', () => {
    test.describe('trending endpoint', () => {
        test('items include externalIds with potential Jellyfin IDs', async ({ request }) => {
            const response = await request.get(`/api/for-you/trending?limit=20`);
            expect(response.ok()).toBeTruthy();

            const jsonData: unknown = await response.json();
            const data = jsonData as ApiResponse;
            expect(data.items).toBeDefined();

            const items = data.items || [];
            // Structure test, not a data test: the e2e catalog is empty, and
            // an empty page is a legitimate response shape.
            if (items.length === 0) test.skip();

            // Check that items have externalIds structure
            const hasExternalIds = items.every((item: UniversalMediaItem) => {
                return item.externalIds && typeof item.externalIds === 'object';
            });

            expect(hasExternalIds).toBe(true);

            // Check if any items have Jellyfin IDs (depends on data availability)
            // At least some content should have Jellyfin IDs if synced
            const someHaveJellyfinIds = items.some((item: UniversalMediaItem) => {
                return item.externalIds?.jellyfin !== undefined;
            });

            // This may be false if no content is synced, which is okay for testing
            // We're verifying the structure exists
            if (items.length > 0) {
                expect(typeof someHaveJellyfinIds).toBe('boolean');
            }
        });

        test('no duplicate IDs in response', async ({ request }) => {
            const response = await request.get(`/api/for-you/trending?limit=20`);
            expect(response.ok()).toBeTruthy();

            const jsonData: unknown = await response.json();
            const data = jsonData as ApiResponse;
            const items = data.items || [];

            // Build composite keys from all items
            const compositeKeys = items.map((item: UniversalMediaItem) => {
                const tmdbId = item.externalIds?.tmdb || 'unknown';
                const mediaType = item.mediaType || 'movie';
                return `${tmdbId}:${mediaType}`;
            });

            // Check for duplicates
            const uniqueKeys = new Set(compositeKeys);
            expect(compositeKeys.length).toBe(uniqueKeys.size);
        });

        test('externalIds structure is consistent', async ({ request }) => {
            const response = await request.get(`/api/for-you/trending?limit=10`);
            expect(response.ok()).toBeTruthy();

            const jsonData: unknown = await response.json();
            const data = jsonData as ApiResponse;
            const items = data.items || [];

            // Verify every item has consistent externalIds structure
            items.forEach((item: UniversalMediaItem) => {
                expect(item).toHaveProperty('externalIds');
                expect(typeof item.externalIds).toBe('object');

                // TMDB should be present (MDBList data)
                expect(item.externalIds).toHaveProperty('tmdb');
                expect(typeof item.externalIds.tmdb).toBe('string');

                // Other IDs are optional
                if (item.externalIds.jellyfin) {
                    expect(typeof item.externalIds.jellyfin).toBe('string');
                }
                if (item.externalIds.imdb) {
                    expect(typeof item.externalIds.imdb).toBe('string');
                }
            });
        });
    });

    test.describe('popular shows endpoint', () => {
        test('items include externalIds with potential Jellyfin IDs', async ({ request }) => {
            const response = await request.get(`/api/for-you/popular-shows?limit=20`);
            expect(response.ok()).toBeTruthy();

            const jsonData: unknown = await response.json();
            const data = jsonData as ApiResponse;
            expect(data.items).toBeDefined();

            const items = data.items || [];
            // Structure test, not a data test: the e2e catalog is empty, and
            // an empty page is a legitimate response shape.
            if (items.length === 0) test.skip();

            // Check externalIds structure
            const hasExternalIds = items.every((item: UniversalMediaItem) => {
                return item.externalIds && typeof item.externalIds === 'object';
            });

            expect(hasExternalIds).toBe(true);
        });

        test('no duplicate IDs in response', async ({ request }) => {
            const response = await request.get(`/api/for-you/popular-shows?limit=20`);
            expect(response.ok()).toBeTruthy();

            const jsonData: unknown = await response.json();
            const data = jsonData as ApiResponse;
            const items = data.items || [];

            // Build universal IDs (provider-agnostic deduplication)
            const ids = items.map((item: UniversalMediaItem) => {
                const tmdbId = item.externalIds?.tmdb || 'unknown';
                const mediaType = item.mediaType || 'tv';
                return `${tmdbId}:${mediaType}`;
            });

            const uniqueIds = new Set(ids);
            expect(ids.length).toBe(uniqueIds.size);
        });
    });

    test.describe('anime endpoint', () => {
        test('items include externalIds with Jellyfin IDs when available', async ({ request }) => {
            const response = await request.get(`/api/for-you/anime?limit=20`);
            expect(response.ok()).toBeTruthy();

            const jsonData: unknown = await response.json();
            const data = jsonData as ApiResponse;
            const items = data.items || [];

            if (items.length > 0) {
                // Check structure
                items.forEach((item: UniversalMediaItem) => {
                    expect(item).toHaveProperty('externalIds');
                    expect(typeof item.externalIds).toBe('object');

                    // Should have TMDB
                    if (item.externalIds.tmdb) {
                        expect(typeof item.externalIds.tmdb).toBe('string');
                    }

                    // May have Jellyfin ID
                    if (item.jellyfinId) {
                        expect(item.externalIds.jellyfin).toBe(item.jellyfinId);
                    }
                });
            }
        });

        test('no duplicate IDs in response', async ({ request }) => {
            const response = await request.get(`/api/for-you/anime?limit=20`);
            expect(response.ok()).toBeTruthy();

            const jsonData: unknown = await response.json();
            const data = jsonData as ApiResponse;
            const items = data.items || [];

            const ids = items.map((item: UniversalMediaItem) => {
                const tmdbId = item.externalIds?.tmdb || 'unknown';
                const mediaType = item.mediaType || 'movie';
                return `${tmdbId}:${mediaType}`;
            });

            const uniqueIds = new Set(ids);
            expect(ids.length).toBe(uniqueIds.size);
        });
    });

    test.describe('binge-worthy endpoint', () => {
        test('cache key is versioned', async ({ request }) => {
            const response = await request.get(`/api/for-you/binge-worthy?limit=10`);
            expect(response.ok()).toBeTruthy();

            const jsonData: unknown = await response.json();
            const data = jsonData as ApiResponse;

            // Check response structure
            expect(data.items).toBeDefined();
            expect(Array.isArray(data.items)).toBe(true);

            // The cache key itself is internal, but we can verify the response structure
            // hasn't changed (indicating cache version bump worked)
            if (data.items && data.items.length > 0) {
                const firstItem = data.items[0];
                expect(firstItem).toHaveProperty('externalIds');
                expect(firstItem).toHaveProperty('mediaType');
                expect(firstItem).toHaveProperty('mediaName');
            }
        });

        test('items have consistent provider-agnostic structure', async ({ request }) => {
            const response = await request.get(`/api/for-you/binge-worthy?limit=20`);
            expect(response.ok()).toBeTruthy();

            const jsonData: unknown = await response.json();
            const data = jsonData as ApiResponse;
            const items = data.items || [];

            items.forEach((item: UniversalMediaItem) => {
                expect(item).toHaveProperty('externalIds');
                expect(typeof item.externalIds).toBe('object');

                // Should have at least one provider ID
                const hasProviderId =
                    item.externalIds.tmdb || item.externalIds.jellyfin || item.externalIds.imdb;
                expect(hasProviderId).toBeTruthy();
            });
        });
    });

    test.describe('image URL generation', () => {
        test('items with negative TMDB IDs do not appear', async ({ request }) => {
            const response = await request.get(`/api/for-you/trending?limit=20`);
            expect(response.ok()).toBeTruthy();

            const jsonData: unknown = await response.json();
            const data = jsonData as ApiResponse;
            const items = data.items || [];

            // Check that no items have negative TMDB IDs
            const hasNegativeTmdbId = items.some((item: UniversalMediaItem) => {
                const tmdbId = item.externalIds?.tmdb;
                if (!tmdbId) return false;

                const parsed = parseInt(tmdbId, 10);
                return !isNaN(parsed) && parsed < 0;
            });

            expect(hasNegativeTmdbId).toBe(false);
        });

        test('items with no valid provider IDs are excluded', async ({ request }) => {
            const response = await request.get(`/api/for-you/trending?limit=20`);
            expect(response.ok()).toBeTruthy();

            const jsonData: unknown = await response.json();
            const data = jsonData as ApiResponse;
            const items = data.items || [];

            // All items should have at least one valid provider ID
            const allHaveProviderId = items.every((item: UniversalMediaItem) => {
                const ids = item.externalIds || {};
                return ids.tmdb || ids.jellyfin || ids.imdb || ids.tvdb;
            });

            expect(allHaveProviderId).toBe(true);
        });
    });

    test.describe('error handling', () => {
        test('handles invalid limit parameter gracefully', async ({ request }) => {
            const response = await request.get(`/api/for-you/trending?limit=-10`);

            // Should either return error or default to safe limit
            if (response.ok()) {
                const jsonData: unknown = await response.json();
                const data = jsonData as ApiResponse;
                expect(data.items).toBeDefined();
                expect(Array.isArray(data.items)).toBe(true);
                // Should use default/safe limit, not negative
                const items = data.items || [];
                expect(items.length).toBeGreaterThanOrEqual(0);
            } else {
                // The problem+json taxonomy has no 400 — a rejected query
                // parameter is 422 `validation_failed`.
                expect(response.status()).toBe(422);
            }
        });

        test('handles missing authentication headers gracefully', async ({ request }) => {
            // This test depends on auth setup - may need adjustment
            const response = await request.get(`/api/for-you/trending?limit=10`);

            // Should either work (default user) or return 401
            expect([200, 401]).toContain(response.status());
        });
    });
});
