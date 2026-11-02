// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Lumastra Playback Modes — Fixture Tests
 *
 * Proves that the synthetic fixture file (tests/fixtures/test-video.mp4)
 * can be served through all three lumastra playback modes:
 *   - Direct play   (/api/playback/{id}/file)
 *   - HLS remux     (/api/playback/{id}/hls?videoCodec=copy)
 *   - HLS transcode (/api/playback/{id}/hls?videoCodec=h264)
 *
 * Requires: FFMPEG_PATH and SESSION_MODE=lumastra in server env.
 *
 * Run with: npm run test:e2e:api
 */

import { adminTest as test, expect } from './fixtures/auth';
import type { APIRequestContext } from '@playwright/test';
import { TEST_MEDIA_ITEM_ID } from './global-setup';
import { playSessionTracker } from './helpers/play-sessions';

const DIRECT_PLAY_URL = `/api/playback/${TEST_MEDIA_ITEM_ID}/file`;

/**
 * Direct play needs an explicit `fileId`: a media item can have several files
 * (versions/editions), so `/file` refuses to guess and answers 422
 * `fileId is required` without one. Probe playability first to select the file.
 */
async function activeFileId(request: APIRequestContext): Promise<string | null> {
    const probe = await request.post(`/api/media/${TEST_MEDIA_ITEM_ID}/playability`, { data: {} });
    if (probe.status() !== 200) return null;
    const body = (await probe.json()) as { activeFileId?: string | null };
    return body.activeFileId ?? null;
}
type LumastraVideoCodec = 'copy' | 'h264' | 'hevc' | 'av1';
// Every master request starts a play session; end them all, or they hold the
// test user's stream slots for the rest of the run (see the helper).
const sessions = playSessionTracker();
test.afterAll(async ({ request, baseURL }) => {
    await sessions.endAll(request, baseURL);
});
const hlsMaster = (codec: LumastraVideoCodec): string =>
    sessions.url(`/api/playback/${TEST_MEDIA_ITEM_ID}/hls?videoCodec=${codec}`);

/**
 * Fetch master manifest then follow the first variant URI.
 * Handles absolute paths (/api/...), full URLs (http...) and relative names.
 */
async function fetchVariantPlaylist(
    request: APIRequestContext,
    masterUrl: string,
): Promise<{
    masterStatus: number;
    playlistStatus: number;
    playlistBody: string;
}> {
    const masterResponse = await request.get(masterUrl);
    const masterStatus = masterResponse.status();
    if (masterStatus !== 200) {
        return { masterStatus, playlistStatus: -1, playlistBody: '' };
    }
    const masterBody = await masterResponse.text();
    const variantUri = masterBody.split('\n').find((line) => line.trim() && !line.startsWith('#'));
    if (!variantUri) {
        return { masterStatus, playlistStatus: -1, playlistBody: '' };
    }
    const trimmed = variantUri.trim();
    const baseSegmentPath = masterUrl.split('?')[0];
    const playlistUrl =
        trimmed.startsWith('http') || trimmed.startsWith('/')
            ? trimmed
            : `${baseSegmentPath}/${trimmed}`;
    const playlistResponse = await request.get(playlistUrl);
    return {
        masterStatus,
        playlistStatus: playlistResponse.status(),
        playlistBody: await playlistResponse.text(),
    };
}

// ── Direct play ───────────────────────────────────────────────────────────────

test.describe('Direct play — fixture file', () => {
    test('full file is served', async ({ request }) => {
        const fileId = await activeFileId(request);
        expect(fileId).toBeTruthy();
        const response = await request.get(`${DIRECT_PLAY_URL}?fileId=${fileId}`);
        expect(response.status()).toBe(200);
        expect(response.headers()['content-type']).toMatch(/video\/mp4/);
        const contentLength = parseInt(response.headers()['content-length'] ?? '0', 10);
        expect(contentLength).toBeGreaterThan(0);
    });

    test('range request returns partial content', async ({ request }) => {
        const fileId = await activeFileId(request);
        expect(fileId).toBeTruthy();
        const response = await request.get(`${DIRECT_PLAY_URL}?fileId=${fileId}`, {
            headers: { Range: 'bytes=0-1023' },
        });
        expect(response.status()).toBe(206);
        // Content-Range: bytes 0-1023/<total>
        expect(response.headers()['content-range']).toMatch(/^bytes 0-1023\//);
    });

    // The INTERNAL `/api/*` surface has no unauthenticated state: forward-auth
    // treats "no identity headers" as the dev fallback and resolves the request
    // to DEFAULT_USER with ADMIN_GROUPS (forward-auth.ts — `isDev` is simply
    // `!rawUserHeader && !rawGroupHeader`, not an environment check), so blanking
    // the headers yields an authorised request, not a 401. The `DEV_USERNAME`
    // guard that used to sit here never fired: nothing in src/ reads that name.
    // `/api/v1/*` is the surface that validates credentials, so assert there.
    test('requires a credential on the v1 surface', async ({ request }) => {
        const fileId = await activeFileId(request);
        const response = await request.get(
            `/api/v1/playback/${TEST_MEDIA_ITEM_ID}/file?fileId=${fileId ?? 'unknown'}`,
            { headers: { 'X-Forwarded-User': '', 'X-Forwarded-Groups': '' } },
        );
        expect(response.status()).toBe(401);
    });
});

// ── HLS remux (videoCodec=copy) ───────────────────────────────────────────────

test.describe('HLS remux (videoCodec=copy) — fixture file', () => {
    test('master manifest is served', async ({ request }) => {
        const response = await request.get(hlsMaster('copy'));
        // 200 → lumastra found the file and built a manifest
        // 404 → SESSION_MODE != lumastra, or seeding failed
        // 503 → FFMPEG_PATH not set
        expect(response.status()).toBe(200);
        const body = await response.text();
        expect(body).toContain('#EXTM3U');
        expect(body).toContain('#EXT-X-STREAM-INF');
    });

    test('response has HLS content-type header', async ({ request }) => {
        const response = await request.get(hlsMaster('copy'));
        expect(response.status()).toBe(200);
        expect(response.headers()['content-type']).toMatch(
            /application\/vnd\.apple\.mpegurl|application\/x-mpegURL/,
        );
    });

    test('variant playlist is served', async ({ request }) => {
        const { masterStatus, playlistStatus, playlistBody } = await fetchVariantPlaylist(
            request,
            hlsMaster('copy'),
        );
        expect(masterStatus).toBe(200);
        expect(playlistStatus).toBe(200);
        expect(playlistBody).toContain('#EXTM3U');
        expect(playlistBody).toContain('#EXT-X-TARGETDURATION');
    });

    // The INTERNAL `/api/*` surface has no unauthenticated state: forward-auth
    // treats "no identity headers" as the dev fallback and resolves the request
    // to DEFAULT_USER with ADMIN_GROUPS (forward-auth.ts — `isDev` is simply
    // `!rawUserHeader && !rawGroupHeader`, not an environment check), so blanking
    // the headers yields an authorised request, not a 401. The `DEV_USERNAME`
    // guard that used to sit here never fired: nothing in src/ reads that name.
    // `/api/v1/*` is the surface that validates credentials, so assert there.
    test('requires a credential on the v1 surface', async ({ request }) => {
        const response = await request.get(
            `/api/v1/playback/${TEST_MEDIA_ITEM_ID}/hls?videoCodec=copy`,
            { headers: { 'X-Forwarded-User': '', 'X-Forwarded-Groups': '' } },
        );
        expect(response.status()).toBe(401);
    });
});

// ── HLS transcode (videoCodec=h264) ──────────────────────────────────────────

test.describe('HLS transcode (videoCodec=h264) — fixture file', () => {
    test('master manifest is served', async ({ request }) => {
        const response = await request.get(hlsMaster('h264'));
        // 200 → FFmpeg re-encoded the fixture and produced a manifest
        // 503 → transcode timed out (30s limit) — unlikely for a 5s clip
        expect(response.status()).toBe(200);
        const body = await response.text();
        expect(body).toContain('#EXTM3U');
        expect(body).toContain('#EXT-X-STREAM-INF');
    });

    test('response has HLS content-type header', async ({ request }) => {
        const response = await request.get(hlsMaster('h264'));
        expect(response.status()).toBe(200);
        expect(response.headers()['content-type']).toMatch(
            /application\/vnd\.apple\.mpegurl|application\/x-mpegURL/,
        );
    });

    test('variant playlist is served', async ({ request }) => {
        const { masterStatus, playlistStatus, playlistBody } = await fetchVariantPlaylist(
            request,
            hlsMaster('h264'),
        );
        expect(masterStatus).toBe(200);
        expect(playlistStatus).toBe(200);
        expect(playlistBody).toContain('#EXTM3U');
        expect(playlistBody).toContain('#EXT-X-TARGETDURATION');
    });

    // The INTERNAL `/api/*` surface has no unauthenticated state: forward-auth
    // treats "no identity headers" as the dev fallback and resolves the request
    // to DEFAULT_USER with ADMIN_GROUPS (forward-auth.ts — `isDev` is simply
    // `!rawUserHeader && !rawGroupHeader`, not an environment check), so blanking
    // the headers yields an authorised request, not a 401. The `DEV_USERNAME`
    // guard that used to sit here never fired: nothing in src/ reads that name.
    // `/api/v1/*` is the surface that validates credentials, so assert there.
    test('requires a credential on the v1 surface', async ({ request }) => {
        const response = await request.get(
            `/api/v1/playback/${TEST_MEDIA_ITEM_ID}/hls?videoCodec=h264`,
            { headers: { 'X-Forwarded-User': '', 'X-Forwarded-Groups': '' } },
        );
        expect(response.status()).toBe(401);
    });
});
