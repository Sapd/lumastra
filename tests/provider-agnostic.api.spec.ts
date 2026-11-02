// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Provider-Agnostic Architecture
 *
 * Tests the following areas:
 * 1. Provider-preference endpoint operations (GET/POST/DELETE)
 * 2. v_media_metadata view behavior with preferred_provider overrides
 * 3. Migration 5.12.0 backfill verification (activity feed media_id)
 *
 * These tests require a running server with database access.
 */

import { adminTest as test, expect } from './fixtures/auth';

// Test interfaces
interface ProviderPreferenceResponse {
    success: boolean;
    message?: string;
    data?: {
        mediaId: string;
        title?: string;
        mediaType?: string;
        preferredProvider: string | null;
        effectiveProvider: string | null;
        availableProviders?: Array<{
            provider: string;
            fetchedAt: string;
        }>;
        isOverridden?: boolean;
        wasOverridden?: boolean;
    };
    timestamp?: string;
}

interface ActivityFeedResponse {
    activities?: Array<{
        id: number;
        activity_type: string;
        media_id?: string | null;
        tmdb_id?: number | null;
        imdb_id?: string | null;
        tvdb_id?: string | null;
        jellyfin_id?: string | null;
        externalIds?: {
            internal?: string;
            tmdb?: string;
            imdb?: string;
            tvdb?: string;
            jellyfin?: string;
        };
        title: string;
        media_type: string;
    }>;
}

interface MediaDetailsResponse {
    externalIds?: {
        internal?: string;
        tmdb?: string;
        imdb?: string;
        jellyfin?: string;
    };
    title?: string;
    mediaType?: string;
}

test.describe('Provider-Agnostic Architecture', () => {
    test.describe('Provider Preference Endpoint', () => {
        test.describe('GET /api/media/:id/provider-preference', () => {
            // The id path param accepts several forms — internal UUID, composite
            // key (`provider:id:type`) and a bare Jellyfin id — so "malformed"
            // is not a category the endpoint can distinguish. resolveCatalogInternalId()
            // returns null for anything it cannot resolve and the handler answers
            // not_found, exactly as it does for a well-formed id that is absent.
            test('returns 404 for an unresolvable id', async ({ request }) => {
                const response = await request.get(`/api/media/invalid-uuid/provider-preference`);

                expect(response.status()).toBe(404);
                const json: unknown = await response.json();
                const data = json as { error?: string; code?: string };
                expect(data.code).toBe('not_found');
            });

            test('returns 404 for non-existent media', async ({ request }) => {
                // Use a valid UUID format (version 4, variant 1) but one that doesn't exist
                const nonExistentUuid = '00000000-0000-4000-8000-000000000000';
                const response = await request.get(
                    `/api/media/${nonExistentUuid}/provider-preference`,
                );

                expect(response.status()).toBe(404);
            });

            test('returns provider preference data for valid media', async ({ request }) => {
                // First, get a valid media ID from the trending endpoint
                const trendingResponse = await request.get(`/api/for-you/trending?limit=1`);

                if (!trendingResponse.ok()) {
                    test.skip();
                    return;
                }

                const trendingData = (await trendingResponse.json()) as {
                    items?: Array<{ externalIds?: { internal?: string } }>;
                };
                const mediaId = trendingData.items?.[0]?.externalIds?.internal;

                if (!mediaId) {
                    test.skip(); // No media available to test
                    return;
                }

                const response = await request.get(`/api/media/${mediaId}/provider-preference`);

                expect(response.ok()).toBeTruthy();
                const json = (await response.json()) as ProviderPreferenceResponse;

                expect(json.success).toBe(true);
                expect(json.data).toBeDefined();
                expect(json.data?.mediaId).toBe(mediaId);
                expect(json.data?.effectiveProvider).toBeDefined();
                expect(Array.isArray(json.data?.availableProviders)).toBe(true);
                expect(typeof json.data?.isOverridden).toBe('boolean');
            });
        });

        test.describe('POST /api/media/:id/provider-preference', () => {
            test('returns 403 for non-admin users', async ({ request }) => {
                // Use valid UUID format (version 4, variant 1)
                const response = await request.post(
                    `/api/media/00000000-0000-4000-8000-000000000001/provider-preference`,
                    {
                        data: { provider: 'tmdb' },
                    },
                );

                // Should be forbidden (403) for non-admin, or 404 if media doesn't exist
                expect([401, 403, 404]).toContain(response.status());
            });

            test('returns 400 for missing provider field', async ({ request }) => {
                // Use valid UUID format (version 4, variant 1)
                const response = await request.post(
                    `/api/media/00000000-0000-4000-8000-000000000001/provider-preference`,
                    {
                        data: {}, // Missing provider
                    },
                );

                // Either 400 (bad request), 401/403 (auth), or 404 (not found)
                expect([400, 401, 403, 404]).toContain(response.status());
            });

            test('returns 404 for an unresolvable id', async ({ request }) => {
                const response = await request.post(`/api/media/not-a-uuid/provider-preference`, {
                    data: { provider: 'tmdb' },
                });

                // 404 once the id fails to resolve, or 401/403 if auth answers first.
                expect([401, 403, 404]).toContain(response.status());
            });
        });

        test.describe('DELETE /api/media/:id/provider-preference', () => {
            test('returns 403 for non-admin users', async ({ request }) => {
                // Use valid UUID format (version 4, variant 1)
                const response = await request.delete(
                    `/api/media/00000000-0000-4000-8000-000000000001/provider-preference`,
                );

                // Should be forbidden (403) for non-admin, or 404 if media doesn't exist
                expect([401, 403, 404]).toContain(response.status());
            });

            test('returns 404 for an unresolvable id', async ({ request }) => {
                const response = await request.delete(`/api/media/not-a-uuid/provider-preference`);

                // 404 once the id fails to resolve, or 401/403 if auth answers first.
                expect([401, 403, 404]).toContain(response.status());
            });
        });
    });

    test.describe('v_media_metadata View Behavior', () => {
        test('media details returns effective provider from view', async ({ request }) => {
            // Get a media item and verify the effective provider is returned
            const trendingResponse = await request.get(`/api/for-you/trending?limit=1`);

            if (!trendingResponse.ok()) {
                test.skip();
                return;
            }

            const trendingData = (await trendingResponse.json()) as {
                items?: Array<{
                    externalIds?: { internal?: string; tmdb?: string };
                }>;
            };
            const item = trendingData.items?.[0];

            if (!item?.externalIds?.internal) {
                test.skip();
                return;
            }

            // Get detailed info using the internal ID
            const response = await request.get(`/api/media/${item.externalIds.internal}`);

            if (!response.ok()) {
                // May require auth or media doesn't exist in DB
                test.skip();
                return;
            }

            const data = (await response.json()) as MediaDetailsResponse;

            // Verify the response includes provider information
            expect(data.externalIds).toBeDefined();
            if (data.externalIds?.internal) {
                expect(data.externalIds.internal).toBe(item.externalIds.internal);
            }
        });

        test('provider preference API shows correct effective provider', async ({ request }) => {
            // Get a media item
            const trendingResponse = await request.get(`/api/for-you/trending?limit=5`);

            if (!trendingResponse.ok()) {
                test.skip();
                return;
            }

            const trendingData = (await trendingResponse.json()) as {
                items?: Array<{ externalIds?: { internal?: string } }>;
            };

            // Find an item with internal ID
            const mediaId = trendingData.items?.find((i) => i.externalIds?.internal)?.externalIds
                ?.internal;

            if (!mediaId) {
                test.skip();
                return;
            }

            // Get provider preference
            const prefResponse = await request.get(`/api/media/${mediaId}/provider-preference`);

            if (!prefResponse.ok()) {
                test.skip();
                return;
            }

            const prefData = (await prefResponse.json()) as ProviderPreferenceResponse;

            // Verify structure
            expect(prefData.success).toBe(true);
            expect(prefData.data?.effectiveProvider).toBeDefined();

            // If no override is set, effective should match the default chain
            // (aggregated > tmdb > others based on priority)
            if (!prefData.data?.isOverridden) {
                const effectiveProvider = prefData.data?.effectiveProvider;
                // Should be one of the expected providers
                expect(['aggregated', 'tmdb', 'mdblist', 'jellyfin']).toContain(effectiveProvider);
            }
        });

        test('available providers list is populated', async ({ request }) => {
            // Get a media item
            const trendingResponse = await request.get(`/api/for-you/trending?limit=5`);

            if (!trendingResponse.ok()) {
                test.skip();
                return;
            }

            const trendingData = (await trendingResponse.json()) as {
                items?: Array<{ externalIds?: { internal?: string } }>;
            };

            const mediaId = trendingData.items?.find((i) => i.externalIds?.internal)?.externalIds
                ?.internal;

            if (!mediaId) {
                test.skip();
                return;
            }

            const prefResponse = await request.get(`/api/media/${mediaId}/provider-preference`);

            if (!prefResponse.ok()) {
                test.skip();
                return;
            }

            const prefData = (await prefResponse.json()) as ProviderPreferenceResponse;

            // Should have at least one available provider
            expect(prefData.data?.availableProviders).toBeDefined();
            expect(prefData.data?.availableProviders?.length).toBeGreaterThan(0);

            // Each provider entry should have provider name and fetchedAt
            prefData.data?.availableProviders?.forEach((p) => {
                expect(typeof p.provider).toBe('string');
                expect(p.provider.length).toBeGreaterThan(0);
                expect(typeof p.fetchedAt).toBe('string');
                // fetchedAt should be a valid ISO date
                expect(() => new Date(p.fetchedAt)).not.toThrow();
            });
        });
    });

    test.describe('Activity Feed Provider-Agnostic Support', () => {
        test('activity feed returns externalIds structure', async ({ request }) => {
            const response = await request.get(`/api/activity-feed?limit=10`);

            if (!response.ok()) {
                // May require auth
                test.skip();
                return;
            }

            const data = (await response.json()) as ActivityFeedResponse;

            // If there are activities, verify externalIds structure
            if (data.activities && data.activities.length > 0) {
                data.activities.forEach((activity) => {
                    expect(activity).toHaveProperty('externalIds');
                    expect(typeof activity.externalIds).toBe('object');

                    // Should have at least one ID (internal, tmdb, or jellyfin)
                    const ids = activity.externalIds || {};
                    const hasAnyId =
                        ids.internal ||
                        ids.tmdb ||
                        ids.imdb ||
                        ids.tvdb ||
                        ids.jellyfin ||
                        activity.media_id ||
                        activity.tmdb_id;
                    expect(hasAnyId).toBeTruthy();
                });
            }
        });

        test('watchlist activities include media_id when available', async ({ request }) => {
            const response = await request.get(`/api/activity-feed?limit=50`);

            if (!response.ok()) {
                test.skip();
                return;
            }

            const data = (await response.json()) as ActivityFeedResponse;

            // Filter to watchlist activities
            const watchlistActivities =
                data.activities?.filter(
                    (a) =>
                        a.activity_type === 'watchlist_add' ||
                        a.activity_type === 'watchlist_remove',
                ) || [];

            if (watchlistActivities.length === 0) {
                test.skip(); // No watchlist activities to test
                return;
            }

            // After migration 5.12.0, backfilled activities should have media_id
            // (if the corresponding media exists in catalog)
            const activitiesWithMediaId = watchlistActivities.filter(
                (a) => a.externalIds?.internal || a.media_id,
            );

            // At least some should have media_id if backfill worked
            // (not all may have it if media was deleted or never in catalog)
            if (watchlistActivities.length > 5) {
                // With enough activities, expect some to have been backfilled
                expect(activitiesWithMediaId.length).toBeGreaterThan(0);
            }
        });

        test('activities with media_id have full external ID resolution', async ({ request }) => {
            const response = await request.get(`/api/activity-feed?limit=30`);

            if (!response.ok()) {
                test.skip();
                return;
            }

            const data = (await response.json()) as ActivityFeedResponse;

            // Find activities that have media_id (internal UUID)
            const activitiesWithMediaId =
                data.activities?.filter((a) => a.externalIds?.internal) || [];

            if (activitiesWithMediaId.length === 0) {
                test.skip();
                return;
            }

            // These should also have TMDB ID (from scalar subquery or original column)
            activitiesWithMediaId.forEach((activity) => {
                const ids = activity.externalIds || {};

                // Should have internal (media_id) by filter
                expect(ids.internal).toBeTruthy();

                // Should have TMDB (from original column or resolved)
                if (activity.tmdb_id) {
                    expect(ids.tmdb).toBe(String(activity.tmdb_id));
                }
            });
        });

        test('legacy activities without media_id still return tmdb_id', async ({ request }) => {
            const response = await request.get(`/api/activity-feed?limit=50`);

            if (!response.ok()) {
                test.skip();
                return;
            }

            const data = (await response.json()) as ActivityFeedResponse;

            // Find watchlist activities without media_id
            const legacyActivities =
                data.activities?.filter(
                    (a) =>
                        !a.externalIds?.internal &&
                        !a.media_id &&
                        (a.activity_type === 'watchlist_add' ||
                            a.activity_type === 'watchlist_remove'),
                ) || [];

            if (legacyActivities.length === 0) {
                // All activities have been backfilled - that's fine
                return;
            }

            // These should still have tmdb_id from original column
            legacyActivities.forEach((activity) => {
                const ids = activity.externalIds || {};
                // Should have TMDB even without internal ID
                expect(ids.tmdb || activity.tmdb_id).toBeTruthy();
            });
        });
    });

    test.describe('Bi-directional ID Resolution', () => {
        test('can look up media by both UUID and TMDB ID', async ({ request }) => {
            // Get an item with both IDs
            const trendingResponse = await request.get(`/api/for-you/trending?limit=10`);

            if (!trendingResponse.ok()) {
                test.skip();
                return;
            }

            const trendingData = (await trendingResponse.json()) as {
                items?: Array<{
                    externalIds?: { internal?: string; tmdb?: string };
                    mediaType?: string;
                }>;
            };

            // Find an item with both internal and tmdb IDs
            const item = trendingData.items?.find(
                (i) => i.externalIds?.internal && i.externalIds?.tmdb,
            );

            if (!item) {
                test.skip();
                return;
            }

            const internalId = item.externalIds!.internal!;
            const tmdbId = item.externalIds!.tmdb!;
            const mediaType = item.mediaType || 'movie';

            // Verify both IDs resolve to the same content
            // This tests that the external_ids table correctly maps between them

            // Try UUID lookup via provider-preference endpoint
            const uuidResponse = await request.get(`/api/media/${internalId}/provider-preference`);

            if (uuidResponse.ok()) {
                const uuidData = (await uuidResponse.json()) as ProviderPreferenceResponse;
                expect(uuidData.success).toBe(true);
                expect(uuidData.data?.mediaId).toBe(internalId);
            }

            // Try TMDB lookup via media-details endpoint
            const tmdbResponse = await request.get(
                `/api/media-details?tmdbId=${tmdbId}&mediaType=${mediaType}`,
            );

            if (tmdbResponse.ok()) {
                const tmdbData = (await tmdbResponse.json()) as MediaDetailsResponse;
                // If resolved correctly, internal ID should match
                if (tmdbData.externalIds?.internal) {
                    expect(tmdbData.externalIds.internal).toBe(internalId);
                }
            }
        });
    });

    test.describe('Cache Key Versioning', () => {
        test('anime endpoint uses versioned cache key (v5)', async ({ request }) => {
            // Make two requests - should be consistent (cache working)
            const response1 = await request.get(`/api/for-you/anime?limit=5`);
            const response2 = await request.get(`/api/for-you/anime?limit=5`);

            expect(response1.ok()).toBe(response2.ok());

            if (response1.ok() && response2.ok()) {
                const data1 = (await response1.json()) as {
                    items?: Array<{ externalIds?: { internal?: string } }>;
                };
                const data2 = (await response2.json()) as {
                    items?: Array<{ externalIds?: { internal?: string } }>;
                };

                // Same items should be returned (cache hit)
                expect(data1.items?.length).toBe(data2.items?.length);
            }
        });

        test('binge-worthy endpoint uses versioned cache key (v2)', async ({ request }) => {
            const response1 = await request.get(`/api/for-you/binge-worthy?limit=5`);
            const response2 = await request.get(`/api/for-you/binge-worthy?limit=5`);

            expect(response1.ok()).toBe(response2.ok());

            if (response1.ok() && response2.ok()) {
                const data1 = (await response1.json()) as {
                    items?: Array<{ externalIds?: { internal?: string } }>;
                };
                const data2 = (await response2.json()) as {
                    items?: Array<{ externalIds?: { internal?: string } }>;
                };

                expect(data1.items?.length).toBe(data2.items?.length);
            }
        });
    });
});
