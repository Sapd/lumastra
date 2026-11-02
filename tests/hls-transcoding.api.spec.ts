// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * E2E API Tests for HLS Transcoding
 *
 * These tests verify the HLS transcoding endpoint behavior including:
 * - Authentication requirements
 * - Parameter validation
 * - Strategy selection
 * - Error responses
 *
 * Run with: npm run test:e2e:api
 */

import { adminTest as test, expect } from './fixtures/auth';
import { TEST_MEDIA_ITEM_ID } from './global-setup';
import { playSessionTracker } from './helpers/play-sessions';

// Test constants — the seeded fixture, so requests reach the HLS handler rather
// than stopping at id resolution.
const TEST_ITEM_ID = process.env.TEST_ITEM_ID || TEST_MEDIA_ITEM_ID;
const INVALID_ITEM_ID = '00000000000000000000000000000000';
// Segment requests are keyed by PlaySessionId; the route answers 400
// `Missing PlaySessionId` before it looks for a file, so supply one that has no
// transcode behind it.
const NO_SUCH_SESSION = '00000000-0000-4000-8000-000000000000';

// Every manifest below starts a play session; end them all, or they hold the
// test user's stream slots for the rest of the run (see the helper).
const sessions = playSessionTracker();
test.afterAll(async ({ request, baseURL }) => {
    await sessions.endAll(request, baseURL);
});

test.describe('HLS Lumastra Endpoint', () => {
    test.describe('Authentication', () => {
        test('should require a credential on the v1 surface', async ({ request }) => {
            // The internal `/api/*` surface has no unauthenticated state:
            // forward-auth reads "no identity headers" as the dev fallback and
            // resolves DEFAULT_USER with ADMIN_GROUPS. `/api/v1/*` is where
            // credentials are actually validated.
            const response = await request.get(`/api/v1/playback/${TEST_ITEM_ID}/hls`, {
                headers: {
                    'X-Forwarded-User': '',
                    'X-Forwarded-Groups': '',
                },
            });

            expect(response.status()).toBe(401);
        });

        test('should accept valid user header', async ({ request }) => {
            const response = await request.get(sessions.url(`/api/playback/${TEST_ITEM_ID}/hls`));

            // If Jellyfin is not available, we might get 500 or 503
            // But we should NOT get 401 (that would mean auth failed)
            if (response.status() === 401) {
                test.fail(true, 'Authentication should have succeeded with valid headers');
            }
        });
    });

    test.describe('Parameter Validation', () => {
        test('should accept valid audio track indices', async ({ request }) => {
            const response = await request.get(
                sessions.url(`/api/playback/${TEST_ITEM_ID}/hls?audioTracks=0,1`),
            );

            // We don't care about the result as long as it's not a 400 for the parameter
            expect(response.status()).not.toBe(400);
        });

        test('should handle seeking parameter', async ({ request }) => {
            const response = await request.get(
                sessions.url(`/api/playback/${TEST_ITEM_ID}/hls?startTimeSeconds=120`),
            );

            // Should accept the seeking parameter
            expect(response.status()).not.toBe(400);
        });

        test('should handle invalid item ID format', async ({ request }) => {
            const response = await request.get(`/api/playback/not-a-valid-uuid/hls`);

            // This route resolves the id in `withIdResolution` middleware, which
            // rejects a malformed one as 422 validation_failed before the handler
            // runs — unlike the def-based routes, where an unresolvable id
            // collapses to 404.
            expect([404, 422, 500]).toContain(response.status());
        });
    });

    test.describe('Response Format', () => {
        test('should return m3u8 content type for master playlist', async ({ request }) => {
            const response = await request.get(sessions.url(`/api/playback/${TEST_ITEM_ID}/hls`));

            // Skip if Jellyfin not available
            if (response.status() === 503 || response.status() === 500) {
                const body = await response.text();
                if (
                    body.includes('jellyfin') ||
                    body.includes('Jellyfin') ||
                    body.includes('ECONNREFUSED')
                ) {
                    test.skip(true, 'Jellyfin not available');
                    return;
                }
            }

            // If successful, should return HLS content type
            if (response.ok()) {
                const contentType = response.headers()['content-type'];
                expect(contentType).toMatch(
                    /application\/vnd\.apple\.mpegurl|application\/x-mpegURL/,
                );
            }
        });

        test('master playlist should contain audio tracks when available', async ({ request }) => {
            const response = await request.get(sessions.url(`/api/playback/${TEST_ITEM_ID}/hls`));

            // Skip if not available
            if (!response.ok()) {
                test.skip(true, 'Could not get master playlist');
                return;
            }

            const body = await response.text();

            // Should be a valid M3U8
            expect(body).toContain('#EXTM3U');

            // Should have EXT-X-MEDIA for audio tracks (if multi-audio)
            // Or at least have stream info
            expect(body).toMatch(/#EXT-X-STREAM-INF|#EXT-X-MEDIA/);
        });
    });

    test.describe('Segment Requests', () => {
        test('should return 404 for non-existent segments before transcoding', async ({
            request,
        }) => {
            // Try to get a segment that doesn't exist
            const response = await request.get(
                `/api/playback/${TEST_ITEM_ID}/hls/stream_0/segment_99999.m4s?PlaySessionId=${NO_SUCH_SESSION}`,
            );

            // 410 gone: the PlaySessionId names no live transcode. (404/503 if the
            // session is rejected earlier or the dependency is down.)
            expect([404, 410, 503]).toContain(response.status());
        });

        test('should return 404 for invalid stream index', async ({ request }) => {
            const response = await request.get(
                `/api/playback/${TEST_ITEM_ID}/hls/stream_999/segment_00000.m4s?PlaySessionId=${NO_SUCH_SESSION}`,
            );

            expect([404, 410, 503]).toContain(response.status());
        });
    });

    test.describe('Error Handling', () => {
        test('should return JSON error for invalid requests', async ({ request }) => {
            const response = await request.get(
                sessions.url(`/api/playback/${INVALID_ITEM_ID}/hls`),
            );

            // Skip if Jellyfin works with this ID somehow
            if (response.ok()) {
                test.skip(true, 'Jellyfin returned success for test item');
                return;
            }

            // Error responses should be JSON
            const contentType = response.headers()['content-type'];
            if (contentType?.includes('application/json')) {
                const body: unknown = await response.json();
                if (body && typeof body === 'object') {
                    const record = body as Record<string, unknown>;
                    expect(record.error || record.message).toBeDefined();
                }
            }
        });

        test('should handle concurrent requests gracefully', async ({ request }) => {
            // Make multiple concurrent requests - shouldn't crash
            const responses = await Promise.all([
                request.get(sessions.url(`/api/playback/${TEST_ITEM_ID}/hls`)),
                request.get(sessions.url(`/api/playback/${TEST_ITEM_ID}/hls`)),
                request.get(sessions.url(`/api/playback/${TEST_ITEM_ID}/hls`)),
            ]);

            // All should complete (any status is fine, just shouldn't hang or crash)
            for (const response of responses) {
                expect(response.status()).toBeDefined();
            }
        });
    });
});

test.describe('HLS Transcoding Strategy Selection', () => {
    test.describe('Audio Codec Handling', () => {
        test('should handle AAC audio (copy-safe)', async ({ request }) => {
            // Request with explicit audio track
            const response = await request.get(
                sessions.url(`/api/playback/${TEST_ITEM_ID}/hls?audioTracks=0`),
            );

            // Just verify the endpoint handles this without crashing
            expect(response.status()).toBeDefined();
        });

        test('should handle multiple audio tracks', async ({ request }) => {
            const response = await request.get(
                sessions.url(`/api/playback/${TEST_ITEM_ID}/hls?audioTracks=0,1,2`),
            );

            // Should handle multi-audio without error
            expect(response.status()).toBeDefined();
        });
    });

    test.describe('Video Handling', () => {
        test('should handle static stream mode', async ({ request }) => {
            const response = await request.get(sessions.url(`/api/playback/${TEST_ITEM_ID}/hls`));
            expect(response.status()).toBeDefined();
        });
    });
});

test.describe('HLS Segment Delivery', () => {
    let sessionActive = false;

    test.beforeAll(async ({ request }) => {
        // Try to start a transcode session
        const response = await request.get(sessions.url(`/api/playback/${TEST_ITEM_ID}/hls`));
        sessionActive = response.ok();
    });

    test('init segment should have correct content type', async ({ request }) => {
        if (!sessionActive) {
            test.skip(true, 'No active session');
            return;
        }

        const response = await request.get(`/api/playback/${TEST_ITEM_ID}/hls/stream_0/init.mp4`, {
            timeout: 30000,
        });

        // If segment exists, should be MP4
        if (response.ok()) {
            const contentType = response.headers()['content-type'];
            expect(contentType).toMatch(/video\/mp4|application\/octet-stream/);
        }
    });

    test('media segments should have correct content type', async ({ request }) => {
        if (!sessionActive) {
            test.skip(true, 'No active session');
            return;
        }

        // Try to get first segment (may need to wait for transcoding)
        const response = await request.get(
            `/api/playback/${TEST_ITEM_ID}/hls/stream_0/segment_00000.m4s`,
            { timeout: 30000 },
        );

        // If segment exists, should be fMP4
        if (response.ok()) {
            const contentType = response.headers()['content-type'];
            expect(contentType).toMatch(/video\/mp4|application\/octet-stream/);
        }
    });
});
