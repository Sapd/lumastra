// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    parseSeekSeconds,
    extractAuthParams,
    addAuthToSearchParams,
    hlsAuthQuery,
    waitForHlsPlaylist,
    addPlaybackIdentityToSearchParams,
    HLS_CORS_HEADERS,
} from './hls-request-utils.js';
import type { Stats } from 'fs';

describe('HLS diagnostic CORS contract', () => {
    it('exposes safe diagnostic headers to third-party players', () => {
        expect(HLS_CORS_HEADERS['Access-Control-Expose-Headers']).toContain(
            'X-Lumastra-Diagnostic-Code',
        );
        expect(HLS_CORS_HEADERS['Access-Control-Expose-Headers']).toContain(
            'X-Lumastra-Diagnostic-Id',
        );
    });
});

// ============================================================================
// parseSeekSeconds
// ============================================================================

describe('parseSeekSeconds', () => {
    it('returns undefined when no params present', () => {
        const params = new URLSearchParams();
        expect(parseSeekSeconds(params)).toBeUndefined();
    });

    it('returns seconds from seek param', () => {
        const params = new URLSearchParams({ seek: '42.5' });
        expect(parseSeekSeconds(params)).toBe(42.5);
    });

    it('returns seconds from StartTimeTicks param', () => {
        // 90000000 ticks = 9 seconds
        const params = new URLSearchParams({ StartTimeTicks: '90000000' });
        expect(parseSeekSeconds(params)).toBeCloseTo(9);
    });

    it('prefers seek over StartTimeTicks when both present', () => {
        const params = new URLSearchParams({
            seek: '10',
            StartTimeTicks: '900000000',
        });
        expect(parseSeekSeconds(params)).toBe(10);
    });

    it('returns undefined when seek is zero', () => {
        const params = new URLSearchParams({ seek: '0' });
        expect(parseSeekSeconds(params)).toBeUndefined();
    });

    it('returns undefined when seek is NaN', () => {
        const params = new URLSearchParams({ seek: 'notanumber' });
        expect(parseSeekSeconds(params)).toBeUndefined();
    });

    it('returns undefined when seek is negative', () => {
        const params = new URLSearchParams({ seek: '-100' });
        expect(parseSeekSeconds(params)).toBeUndefined();
    });

    it('returns undefined when StartTimeTicks is negative', () => {
        const params = new URLSearchParams({ StartTimeTicks: '-50000000' });
        expect(parseSeekSeconds(params)).toBeUndefined();
    });

    it('returns undefined when StartTimeTicks is zero', () => {
        const params = new URLSearchParams({ StartTimeTicks: '0' });
        expect(parseSeekSeconds(params)).toBeUndefined();
    });

    it('returns undefined when StartTimeTicks is NaN', () => {
        const params = new URLSearchParams({ StartTimeTicks: 'notanumber' });
        expect(parseSeekSeconds(params)).toBeUndefined();
    });
});

// ============================================================================
// waitForHlsPlaylist
// ============================================================================

const { mockAccess, mockStat } = vi.hoisted(() => ({
    mockAccess: vi.fn<() => Promise<void>>(),
    mockStat: vi.fn<() => Promise<Stats>>(),
}));

vi.mock('fs/promises', () => ({
    access: mockAccess,
    stat: mockStat,
}));

describe('waitForHlsPlaylist', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns true when file already exists with non-zero size', async () => {
        mockAccess.mockResolvedValue(undefined);
        mockStat.mockResolvedValue({ size: 1024 } as Stats);

        const result = await waitForHlsPlaylist('/output', 'master.m3u8', 5000);
        expect(result).toBe(true);
    });

    it('returns false when file never appears within timeout', async () => {
        mockStat.mockRejectedValue(new Error('ENOENT'));

        const result = await waitForHlsPlaylist('/output', 'master.m3u8', 100, 20);
        expect(result).toBe(false);
    });

    it('returns true when file appears during polling', async () => {
        let callCount = 0;
        mockStat.mockImplementation(async () => {
            callCount++;
            if (callCount < 3) throw new Error('ENOENT');
            return { size: 512 } as Stats;
        });

        const result = await waitForHlsPlaylist('/output', 'master.m3u8', 2000, 10);
        expect(result).toBe(true);
    });
});

describe('addPlaybackIdentityToSearchParams', () => {
    // The muxed master points its EXT-X-STREAM-INF back at the same endpoint with
    // hlsPlaylist=media. That follow-up request re-derives the ENTIRE playback
    // config from the URL, and the segment params it inherits carry only
    // session/auth/seek/profile. Every field dropped here makes the second request
    // compute a different config, which the existing-job check answers by tearing
    // down FFmpeg and respawning it.
    it('pins plan, codecs and burn-in so the follow-up reproduces the first config', () => {
        const params = new URLSearchParams({ PlaySessionId: 'ps-1', deviceProfile: 'apple-tv' });

        addPlaybackIdentityToSearchParams(params, {
            planId: 'plan-abc',
            videoCodec: 'h264',
            audioCodec: 'aac',
            subtitleBurnIn: { absoluteIndex: 3 },
        });

        expect(params.get('plan')).toBe('plan-abc');
        expect(params.get('videoCodec')).toBe('h264');
        expect(params.get('audioCodec')).toBe('aac');
        expect(params.get('SubtitleStreamIndex')).toBe('3');
        expect(params.get('SubtitleMethod')).toBe('Encode');
    });

    it('keeps videoCodec so burn-in cannot fall back to hardcoded hevc', () => {
        // Observed on prod before this pin: the follow-up resolved burn-in, found no
        // plan and no videoCodec, bottomed out at 'hevc', and respawned the job as
        // HEVC while the master had already advertised avc1 to the client.
        const params = new URLSearchParams();

        addPlaybackIdentityToSearchParams(params, {
            videoCodec: 'h264',
            subtitleBurnIn: { absoluteIndex: 3 },
        });

        expect(params.get('videoCodec')).toBe('h264');
    });

    it('survives the parse the follow-up request performs (index 0 included)', () => {
        const params = new URLSearchParams({ PlaySessionId: 'ps-1' });
        addPlaybackIdentityToSearchParams(params, { subtitleBurnIn: { absoluteIndex: 0 } });

        // Index 0 is a valid stream index — a truthiness check would drop it, and
        // the route parse requires subIdx >= 0 with SubtitleMethod === 'Encode'.
        const url = new URL(`https://example.test/hls?${params.toString()}`);
        const subIdx = Number.parseInt(url.searchParams.get('SubtitleStreamIndex') ?? '', 10);
        expect(Number.isNaN(subIdx)).toBe(false);
        expect(subIdx >= 0).toBe(true);
        expect(url.searchParams.get('SubtitleMethod')).toBe('Encode');
    });

    it('adds nothing for fields the first request did not have', () => {
        const params = new URLSearchParams({ PlaySessionId: 'ps-1' });

        addPlaybackIdentityToSearchParams(params, {});

        expect(params.has('plan')).toBe(false);
        expect(params.has('videoCodec')).toBe(false);
        expect(params.has('SubtitleStreamIndex')).toBe(false);
        expect(params.has('SubtitleMethod')).toBe(false);
    });
});

describe('HLS grant propagation', () => {
    it('copies only grant on API paths and encodes secrets safely', () => {
        const url = new URL(
            'http://x/api/v1/playback/m/hls?grant=a%20b%0D%0A&stream_token=old&api_key=account',
        );
        const params = new URLSearchParams();
        addAuthToSearchParams(params, extractAuthParams(url));
        expect(params.toString()).toBe('grant=a+b%0D%0A');
        expect(hlsAuthQuery(url)).toBe('?grant=a+b%0D%0A');
    });
    it('never copies account query credentials from API routes', () => {
        expect(
            hlsAuthQuery(new URL('http://x/api/playback/m/hls?api_key=account&stream_token=old')),
        ).toBe('');
    });
    it('preserves Jellyfin compatibility api_key through the shared helper', () => {
        expect(hlsAuthQuery(new URL('http://x/j/Videos/m/hls?api_key=account'))).toBe(
            '?api_key=account',
        );
    });
});

describe('HLS session binding propagation', () => {
    it('retains PlaySessionId alongside the grant for Live TV child playlists', () => {
        expect(
            hlsAuthQuery(
                new URL(
                    'http://x/api/v1/livetv/channels/feed/stream/master.m3u8?grant=secret&PlaySessionId=ps',
                ),
            ),
        ).toBe('?PlaySessionId=ps&grant=secret');
    });
});

it('keeps the server-selected PlaySessionId when adding request auth', () => {
    const target = new URLSearchParams({ PlaySessionId: 'server-session' });
    const request = new URL(
        'https://example.test/api/v1/playback/item/hls?grant=secret&PlaySessionId=request-session',
    );
    addAuthToSearchParams(target, extractAuthParams(request));
    expect(target.get('PlaySessionId')).toBe('server-session');
    expect(target.get('grant')).toBe('secret');
});
