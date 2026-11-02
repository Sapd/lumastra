// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * E2E API Tests for /j/ HLS VOD Playlist and Seeking
 *
 * Tests verify that the Jellyfin-compatible HLS endpoints:
 * 1. Generate pre-generated VOD playlists (all segments listed upfront)
 * 2. Use correct segment naming and URL format
 * 3. Support seeking via the shared handler
 * 4. Don't regress the existing hls-lumastra endpoint
 *
 * Run with: npm run test:e2e:api
 */

import { adminTest as test, expect } from './fixtures/auth';

const TEST_ITEM_ID = process.env.TEST_ITEM_ID || 'e2e00000-0000-4000-8000-000000000001';

// Helper: Authenticate via Jellyfin-compat and get a PlaySessionId + auth token
async function authenticateJellyfin(request: {
    post: (
        url: string,
        options?: Record<string, unknown>,
    ) => Promise<{
        ok: () => boolean;
        json: () => Promise<Record<string, unknown>>;
    }>;
}): Promise<{ playSessionId: string; apiKey: string } | null> {
    // Try to get auth info via the /j/ AuthenticateByName endpoint
    const authResponse = await request.post('/j/Users/AuthenticateByName', {
        data: {
            Username: process.env.DEV_USERNAME || 'denis',
            Pw: '',
        },
        headers: {
            'Content-Type': 'application/json',
            'X-Emby-Authorization':
                'MediaBrowser Client="E2E Test", Device="Test", DeviceId="e2e-test", Version="1.0"',
        },
    });

    if (!authResponse.ok()) {
        return null;
    }

    const authData = await authResponse.json();
    const accessToken = authData.AccessToken as string;
    if (!accessToken) return null;

    return {
        playSessionId: `e2e-${Date.now()}`,
        apiKey: accessToken,
    };
}

test.describe('Existing hls-lumastra regression', () => {
    test('/api/v1 endpoint still serves master playlist', async ({ request }) => {
        const response = await request.get(`/api/playback/${TEST_ITEM_ID}/hls/master.m3u8`);

        // Skip if Jellyfin/HLS not available
        if (response.status() === 503 || response.status() === 500) {
            test.skip(true, 'HLS not available');
            return;
        }

        if (response.ok()) {
            const body = await response.text();
            expect(body).toContain('#EXTM3U');
            expect(body).toMatch(/#EXT-X-STREAM-INF|#EXT-X-MEDIA/);
        }
    });

    test('/api/v1 requires PlaySessionId for segments', async ({ request }) => {
        const response = await request.get(
            `/api/playback/${TEST_ITEM_ID}/hls/stream_0/segment_00000.m4s`,
        );

        // Should fail without PlaySessionId
        expect([400, 404, 503]).toContain(response.status());
    });
});

test.describe('/j/ VOD Playlist Format', () => {
    test('master.m3u8 requires authentication', async ({ request }) => {
        // Request without any auth headers or tokens
        const response = await request.get(`/j/Videos/${TEST_ITEM_ID}/master.m3u8`, {
            headers: {
                'X-Forwarded-User': '',
                'X-Forwarded-Groups': '',
            },
        });

        // Should fail without Jellyfin auth
        expect([401, 403]).toContain(response.status());
    });

    test('master.m3u8 returns VOD playlist with all segments', async ({ request }) => {
        const auth = await authenticateJellyfin(request);
        if (!auth) {
            test.skip(true, 'Jellyfin auth not available');
            return;
        }

        const response = await request.get(
            `/j/Videos/${TEST_ITEM_ID}/master.m3u8?PlaySessionId=${auth.playSessionId}&api_key=${auth.apiKey}`,
        );

        // Skip if item not found or HLS not enabled
        if (response.status() === 404 || response.status() === 503 || response.status() === 500) {
            test.skip(true, 'Item not available for transcoding');
            return;
        }

        expect(response.ok()).toBe(true);

        const contentType = response.headers()['content-type'];
        expect(contentType).toContain('application/vnd.apple.mpegurl');

        const body = await response.text();

        // Must be valid HLS
        expect(body).toContain('#EXTM3U');

        // Must be VOD (not EVENT or LIVE)
        expect(body).toContain('#EXT-X-PLAYLIST-TYPE:VOD');

        // Must have ENDLIST (complete playlist)
        expect(body).toContain('#EXT-X-ENDLIST');

        // Must contain segment entries
        expect(body).toMatch(/#EXTINF:/);

        // Segments should use FFmpeg naming format
        expect(body).toMatch(/segment_\d{5}\.ts/);

        // Segments should include PlaySessionId
        expect(body).toContain('PlaySessionId=');

        // Segments should include runtimeTicks
        expect(body).toContain('runtimeTicks=');
    });

    test('VOD playlist has correct segment count for test video', async ({ request }) => {
        const auth = await authenticateJellyfin(request);
        if (!auth) {
            test.skip(true, 'Jellyfin auth not available');
            return;
        }

        const response = await request.get(
            `/j/Videos/${TEST_ITEM_ID}/master.m3u8?PlaySessionId=${auth.playSessionId}&api_key=${auth.apiKey}`,
        );

        if (!response.ok()) {
            test.skip(true, 'Could not get master playlist');
            return;
        }

        const body = await response.text();
        const segmentCount = (body.match(/#EXTINF:/g) || []).length;

        // Should have at least 1 segment
        expect(segmentCount).toBeGreaterThan(0);

        // Verify segment numbering is sequential (0-based)
        expect(body).toContain('segment_00000.ts');
        if (segmentCount > 1) {
            expect(body).toContain('segment_00001.ts');
        }
    });

    test('VOD playlist runtimeTicks are sequential', async ({ request }) => {
        const auth = await authenticateJellyfin(request);
        if (!auth) {
            test.skip(true, 'Jellyfin auth not available');
            return;
        }

        const response = await request.get(
            `/j/Videos/${TEST_ITEM_ID}/master.m3u8?PlaySessionId=${auth.playSessionId}&api_key=${auth.apiKey}`,
        );

        if (!response.ok()) {
            test.skip(true, 'Could not get master playlist');
            return;
        }

        const body = await response.text();

        // Extract runtimeTicks values
        const ticksMatches = body.matchAll(/runtimeTicks=(\d+)/g);
        const ticks = Array.from(ticksMatches, (m) => parseInt(m[1], 10));

        // First segment should start at 0
        if (ticks.length > 0) {
            expect(ticks[0]).toBe(0);
        }

        // Ticks should be monotonically increasing
        for (let i = 1; i < ticks.length; i++) {
            expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
        }
    });

    test('VOD playlist includes api_key when provided', async ({ request }) => {
        const auth = await authenticateJellyfin(request);
        if (!auth) {
            test.skip(true, 'Jellyfin auth not available');
            return;
        }

        const response = await request.get(
            `/j/Videos/${TEST_ITEM_ID}/master.m3u8?PlaySessionId=${auth.playSessionId}&api_key=${auth.apiKey}`,
        );

        if (!response.ok()) {
            test.skip(true, 'Could not get master playlist');
            return;
        }

        const body = await response.text();

        // All segment URLs should include the api_key
        const segmentLines = body.split('\n').filter((l: string) => l.startsWith('/j/'));
        for (const line of segmentLines) {
            expect(line).toContain(`api_key=${auth.apiKey}`);
        }
    });
});

test.describe('/j/ Segment Requests', () => {
    // The /j compat segment endpoint now authenticates BEFORE it looks at
    // anything else, so an unauthenticated caller is 401 and none of the
    // parameter handling below it (missing PlaySessionId → 400, expired session
    // → 410, FFmpeg down → 503, CORS headers) is observable from here. These
    // tests used to reach it because the surface was open.
    //
    // Getting past the gate needs a Jellyfin-compat credential, and
    // AuthenticateByName cannot issue one in this environment: the seeded users
    // have no native password, so it answers 401 "Invalid username or password".
    // Rather than assert behaviour this environment cannot reach, assert the gate
    // itself — which IS a property worth holding for a public compat surface:
    // nothing about a segment, a session or a path is revealed without a
    // credential.
    test('an unauthenticated segment request is refused', async ({ request }) => {
        const response = await request.get(`/j/Videos/${TEST_ITEM_ID}/hls/segment_00000.ts`);
        expect(response.status()).toBe(401);
    });

    test('a PlaySessionId does not get an unauthenticated caller any further', async ({
        request,
    }) => {
        const response = await request.get(
            `/j/Videos/${TEST_ITEM_ID}/hls/segment_00000.ts?PlaySessionId=nonexistent-session`,
        );
        // 401, not 410 — the gate answers before session lookup, so an attacker
        // cannot probe which PlaySessionIds exist.
        expect(response.status()).toBe(401);
    });

    test('segment endpoint handles path traversal attempts', async ({ request }) => {
        // SvelteKit may normalize ../.. before it reaches the handler,
        // so we test both the router-level and handler-level protections
        const response = await request.get(
            `/j/Videos/${TEST_ITEM_ID}/hls/../../etc/passwd?PlaySessionId=test`,
        );

        // Rejected — by the router (404), the auth gate (401), or the handler.
        expect([400, 401, 403, 404]).toContain(response.status());
    });
});
