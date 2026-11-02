// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `parseM3uAsync` applies Live TV's SSRF policy to each channel's stream URL.
 *
 * Regression cover for a bug where this step hard-coded a public-only guard:
 * `LIVETV_ALLOW_PRIVATE_URLS=true` let the playlist itself be fetched, then
 * every channel in it was dropped here, and the import surfaced the misleading
 * "M3U parsing produced zero channels". Playback already honoured the flag, so
 * a LAN source could be streamed but never imported.
 *
 * Lives in its own file because the flag has to be flipped per test, and the
 * sibling `m3u-parser.test.ts` deliberately runs the sync parser unmocked.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const configRef = { LIVETV_ALLOW_PRIVATE_URLS: false };
vi.mock('$lib/server/config.js', () => ({
    get config() {
        return configRef;
    },
}));

const resolveSafePublicUrl = vi.fn(async (url: URL) => {
    if (url.hostname.endsWith('.internal')) {
        throw new Error('URL resolves to a private IP address');
    }
    return { url, resolvedIp: '203.0.113.10' };
});
vi.mock('$lib/server/utils/ssrf-guard.js', () => ({
    resolveSafePublicUrl: (url: URL) => resolveSafePublicUrl(url),
}));

import { parseM3uAsync } from './m3u-parser.js';

function playlist(...entries: Array<[string, string]>): string {
    const lines = ['#EXTM3U'];
    for (const [name, url] of entries) {
        lines.push(`#EXTINF:-1 tvg-id="${name}" group-title="Demo",${name}`);
        lines.push(url);
    }
    return lines.join('\n');
}

const PUBLIC_URL = 'http://cdn.example.com/a.m3u8';
const PRIVATE_URL = 'http://livetv.internal/streams/b.mp4';

describe('parseM3uAsync stream-URL policy', () => {
    beforeEach(() => {
        configRef.LIVETV_ALLOW_PRIVATE_URLS = false;
        resolveSafePublicUrl.mockClear();
    });

    describe('LIVETV_ALLOW_PRIVATE_URLS = false (default)', () => {
        it('keeps public channels and drops private ones', async () => {
            const result = await parseM3uAsync(
                playlist(['Public', PUBLIC_URL], ['Private', PRIVATE_URL]),
            );

            expect(result.channels).toHaveLength(1);
            expect(result.channels[0].streamUrl).toBe(PUBLIC_URL);
        });

        it('accounts for the dropped channel in skipped/imported', async () => {
            const result = await parseM3uAsync(
                playlist(['Public', PUBLIC_URL], ['Private', PRIVATE_URL]),
            );

            expect(result.skipped).toBe(1);
            expect(result.imported).toBe(1);
        });

        it('still consults the strict public-only guard', async () => {
            await parseM3uAsync(playlist(['Public', PUBLIC_URL]));
            expect(resolveSafePublicUrl).toHaveBeenCalledTimes(1);
        });
    });

    describe('LIVETV_ALLOW_PRIVATE_URLS = true (operator opted in)', () => {
        beforeEach(() => {
            configRef.LIVETV_ALLOW_PRIVATE_URLS = true;
        });

        it('keeps channels whose stream URL resolves to a private address', async () => {
            const result = await parseM3uAsync(
                playlist(['Public', PUBLIC_URL], ['Private', PRIVATE_URL]),
            );

            expect(result.channels.map((c) => c.streamUrl)).toEqual([PUBLIC_URL, PRIVATE_URL]);
            expect(result.skipped).toBe(0);
        });

        it('does not call the public-only guard at all', async () => {
            await parseM3uAsync(playlist(['Private', PRIVATE_URL]));
            expect(resolveSafePublicUrl).not.toHaveBeenCalled();
        });

        it('preserves rtsp:// and rtmp:// sources', async () => {
            // url-validator allows only http/https; routing this branch through
            // it would silently delete every RTSP/RTMP channel.
            const result = await parseM3uAsync(
                playlist(
                    ['Rtsp', 'rtsp://camera.internal:554/stream'],
                    ['Rtmp', 'rtmp://relay.internal/live/key'],
                ),
            );

            expect(result.channels).toHaveLength(2);
        });

        it('still drops a malformed stream URL', async () => {
            const result = await parseM3uAsync(playlist(['Public', PUBLIC_URL]));
            expect(result.channels).toHaveLength(1);

            // parseM3u rejects unparseable URLs before this stage, so the
            // opted-in branch should never be the thing that lets one through.
            const malformed = await parseM3uAsync(playlist(['Bad', 'not a url']));
            expect(malformed.channels).toHaveLength(0);
        });
    });
});
