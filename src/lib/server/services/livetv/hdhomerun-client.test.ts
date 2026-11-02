// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (hoisted) ───────────────────────────────────────────────

vi.mock('$lib/server/utils/url-validator.js', () => ({
    validateUrl: vi.fn(),
}));

// pinnedFetch runs for real; only undici's transport is stubbed. Its `fetch`
// forwards to the per-test `global.fetch` mock, and the Agent records the
// pinned lookup so a test can read back the address a connection would dial.
type PinLookup = (
    host: string,
    opts: unknown,
    cb: (err: null, addrs: Array<{ address: string; family: number }>) => void,
) => void;
const agentOpts = vi.hoisted(() => [] as Array<{ connect: { lookup: PinLookup } }>);
vi.mock('undici', () => ({
    Agent: class {
        constructor(opts: { connect: { lookup: PinLookup } }) {
            agentOpts.push(opts);
        }
        close(): Promise<void> {
            return Promise.resolve();
        }
        destroy(): Promise<void> {
            return Promise.resolve();
        }
    },
    fetch: (...args: Parameters<typeof fetch>) => global.fetch(...args),
}));

vi.mock('$lib/server/config.js', () => ({
    config: { LIVETV_ALLOW_PRIVATE_URLS: true },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

// ── Import after mocks ───────────────────────────────────────────────────

import {
    validateHdHomeRunDevice,
    fetchHdHomeRunLineup,
    lineupToM3u,
    buildEpgUrl,
} from './hdhomerun-client.js';
import { validateUrl } from '$lib/server/utils/url-validator.js';
import type { HdHomeRunChannel, HdHomeRunDeviceInfo } from './hdhomerun-client.js';

const mockValidateUrl = validateUrl as ReturnType<typeof vi.fn>;

// ── Fixtures ────────────────────────────────────────────────────────────

/** The device's answer: a real Response, so the body is read through the bounded reader. */
function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200 });
}

function makeDiscoverResponse() {
    return {
        FriendlyName: 'HDHomeRun FLEX 4K',
        ModelNumber: 'HDHR5-4US',
        DeviceID: '10521B34',
        TunerCount: 4,
        BaseURL: 'http://192.168.1.50:80',
        DeviceAuth: 'test-auth-token-123',
    };
}

function makeLineupResponse() {
    return [
        {
            GuideNumber: '5.1',
            GuideName: 'KVL',
            URL: 'http://192.168.1.50:5004/auto/v5.1',
            HD: 1,
        },
        {
            GuideNumber: '7.1',
            GuideName: 'WRT',
            URL: 'http://192.168.1.50:5004/auto/v7.1',
            HD: 1,
        },
        {
            GuideNumber: '99.1',
            GuideName: 'DRM Channel',
            URL: 'http://192.168.1.50:5004/auto/v99.1',
            HD: 0,
            DRM: 1,
        },
    ];
}

function makeDeviceInfo(): HdHomeRunDeviceInfo {
    return {
        friendlyName: 'HDHomeRun FLEX 4K',
        modelNumber: 'HDHR5-4US',
        deviceId: '10521B34',
        tunerCount: 4,
        baseUrl: 'http://192.168.1.50:80',
        deviceAuth: 'test-auth-token-123',
    };
}

// ── validateHdHomeRunDevice ─────────────────────────────────────────────

describe('validateHdHomeRunDevice', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockValidateUrl.mockResolvedValue({
            valid: true,
            resolvedUrl: 'http://192.168.1.50/discover.json',
            resolvedIp: '192.168.1.50',
        });
    });

    it('returns device info on successful discovery', async () => {
        global.fetch = vi.fn().mockResolvedValue(jsonResponse(makeDiscoverResponse()));

        const result = await validateHdHomeRunDevice('192.168.1.50');

        expect(result.valid).toBe(true);
        if (result.valid) {
            expect(result.deviceInfo.friendlyName).toBe('HDHomeRun FLEX 4K');
            expect(result.deviceInfo.deviceId).toBe('10521B34');
            expect(result.deviceInfo.tunerCount).toBe(4);
            expect(result.deviceInfo.deviceAuth).toBe('test-auth-token-123');
        }
    });

    it('rejects deviceIp with path injection characters', async () => {
        const result = await validateHdHomeRunDevice('evil.com/foo');

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.reason).toContain('Invalid IP');
        }
    });

    it('rejects deviceIp with port suffix', async () => {
        const result = await validateHdHomeRunDevice('192.168.1.50:8080');

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.reason).toContain('Invalid IP');
        }
    });

    it('returns error when SSRF blocks the URL', async () => {
        mockValidateUrl.mockResolvedValue({
            valid: false,
            reason: 'private IP not allowed',
        });

        const result = await validateHdHomeRunDevice('10.0.0.1');

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.errorType).toBe('ssrf_blocked');
        }
    });

    it('returns error when device is unreachable', async () => {
        global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

        const result = await validateHdHomeRunDevice('192.168.1.99');

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.errorType).toBe('unreachable');
            expect(result.reason).toContain('ECONNREFUSED');
        }
    });

    it('returns error on timeout', async () => {
        const err = new Error('timeout');
        err.name = 'TimeoutError';
        global.fetch = vi.fn().mockRejectedValue(err);

        const result = await validateHdHomeRunDevice('192.168.1.50');

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.errorType).toBe('timeout');
        }
    });

    it('returns error when response is missing DeviceID', async () => {
        global.fetch = vi.fn().mockResolvedValue(jsonResponse({ FriendlyName: 'SomeDevice' }));

        const result = await validateHdHomeRunDevice('192.168.1.50');

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.errorType).toBe('invalid_response');
            expect(result.reason).toContain('DeviceID');
        }
    });

    it('returns error on HTTP error status', async () => {
        global.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 404,
        } as Response);

        const result = await validateHdHomeRunDevice('192.168.1.50');

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.reason).toContain('404');
        }
    });

    it('defaults tunerCount to 1 when missing', async () => {
        const discover = makeDiscoverResponse();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (discover as any).TunerCount;
        global.fetch = vi.fn().mockResolvedValue(jsonResponse(discover));

        const result = await validateHdHomeRunDevice('192.168.1.50');

        expect(result.valid).toBe(true);
        if (result.valid) {
            expect(result.deviceInfo.tunerCount).toBe(1);
        }
    });
});

// ── fetchHdHomeRunLineup ────────────────────────────────────────────────

describe('fetchHdHomeRunLineup', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('parses lineup entries correctly', async () => {
        global.fetch = vi.fn().mockResolvedValue(jsonResponse(makeLineupResponse()));

        const channels = await fetchHdHomeRunLineup('192.168.1.50');

        expect(channels).toHaveLength(3);
        expect(channels[0]).toEqual({
            guideNumber: '5.1',
            guideName: 'KVL',
            url: 'http://192.168.1.50:5004/auto/v5.1',
            hd: true,
            drm: false,
        });
        expect(channels[2].drm).toBe(true);
    });

    it('skips entries with missing required fields', async () => {
        global.fetch = vi.fn().mockResolvedValue(
            jsonResponse([
                { GuideName: 'NoNumber', URL: 'http://x/a' },
                { GuideNumber: '1.1', URL: 'http://x/b' },
                {
                    GuideNumber: '2.1',
                    GuideName: 'Good',
                    URL: 'http://x/c',
                },
            ]),
        );

        const channels = await fetchHdHomeRunLineup('192.168.1.50');

        expect(channels).toHaveLength(1);
        expect(channels[0].guideName).toBe('Good');
    });

    it('throws on non-OK response', async () => {
        global.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
        } as Response);

        await expect(fetchHdHomeRunLineup('192.168.1.50')).rejects.toThrow('HTTP 500');
    });
});

// ── lineupToM3u ─────────────────────────────────────────────────────────

describe('lineupToM3u', () => {
    it('generates valid M3U content', () => {
        const channels: HdHomeRunChannel[] = [
            {
                guideNumber: '5.1',
                guideName: 'KVL',
                url: 'http://192.168.1.50:5004/auto/v5.1',
                hd: true,
                drm: false,
            },
            {
                guideNumber: '7.1',
                guideName: 'WRT',
                url: 'http://192.168.1.50:5004/auto/v7.1',
                hd: false,
                drm: false,
            },
        ];

        const m3u = lineupToM3u(channels, makeDeviceInfo());

        expect(m3u).toContain('#EXTM3U');
        expect(m3u).toContain('tvg-id="5.1"');
        expect(m3u).toContain('tvg-name="KVL"');
        expect(m3u).toContain('tvg-chno="5.1"');
        expect(m3u).toContain('tvg-quality="HD"');
        expect(m3u).toContain('group-title="HDHomeRun FLEX 4K"');
        expect(m3u).toContain('http://192.168.1.50:5004/auto/v5.1');
        // WRT is not HD — no quality attr
        expect(m3u).not.toContain('tvg-quality="HD",WRT');
    });

    it('strips quotes from channel names to prevent M3U corruption', () => {
        const channels: HdHomeRunChannel[] = [
            {
                guideNumber: '5.1',
                guideName: 'KVL "HD"',
                url: 'http://x/a',
                hd: true,
                drm: false,
            },
        ];

        const m3u = lineupToM3u(channels, makeDeviceInfo());

        expect(m3u).toContain('tvg-name="KVL HD"');
        expect(m3u).not.toContain('tvg-name="KVL "HD""');
    });

    it('skips DRM-protected channels', () => {
        const channels: HdHomeRunChannel[] = [
            {
                guideNumber: '5.1',
                guideName: 'KVL',
                url: 'http://x/a',
                hd: true,
                drm: false,
            },
            {
                guideNumber: '99.1',
                guideName: 'DRM Only',
                url: 'http://x/b',
                hd: false,
                drm: true,
            },
        ];

        const m3u = lineupToM3u(channels, makeDeviceInfo());

        expect(m3u).toContain('KVL');
        expect(m3u).not.toContain('DRM Only');
    });
});

// ── buildEpgUrl ─────────────────────────────────────────────────────────

describe('buildEpgUrl', () => {
    it('returns XMLTV URL when DeviceAuth is present', () => {
        const url = buildEpgUrl('test-auth-token');

        expect(url).toBe('http://my.hdhomerun.com/api/xmltv?DeviceAuth=test-auth-token');
    });

    it('returns undefined when DeviceAuth is absent', () => {
        expect(buildEpgUrl(undefined)).toBeUndefined();
    });

    it('URL-encodes the DeviceAuth token', () => {
        const url = buildEpgUrl('token with spaces & specials=yes');

        expect(url).toContain('DeviceAuth=token%20with%20spaces%20%26%20specials%3Dyes');
    });
});

/**
 * Security review 2026-09-12, C6. The discover/lineup URLs were SSRF-validated
 * once and then fetched with redirect-following left on, so a device (or
 * anything answering on that IP) could bounce the request at another internal
 * address and read the outcome back out of the echoed HTTP status.
 */
describe('HDHomeRun redirect re-validation', () => {
    /** A redirect shaped like what fetch returns with `redirect: 'manual'`. */
    function redirectTo(location: string) {
        return {
            ok: false,
            status: 302,
            headers: {
                get: (name: string) => (name.toLowerCase() === 'location' ? location : null),
            },
        } as unknown as Response;
    }

    beforeEach(() => {
        vi.clearAllMocks();
        mockValidateUrl.mockResolvedValue({
            valid: true,
            resolvedUrl: 'http://192.168.1.50/discover.json',
            resolvedIp: '192.168.1.50',
        });
    });

    it('pins every hop to its vetted address; a hostname hop keeps its hostname', async () => {
        agentOpts.length = 0;
        mockValidateUrl.mockImplementation(async (url: string) => ({
            valid: true,
            resolvedUrl: url,
            resolvedIp: url.includes('tuner.example.net') ? '192.168.1.60' : '192.168.1.50',
        }));
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(redirectTo('http://tuner.example.net/discover.json'))
            .mockResolvedValueOnce(jsonResponse(makeDiscoverResponse()));
        global.fetch = fetchMock;

        await validateHdHomeRunDevice('192.168.1.50');

        expect(fetchMock).toHaveBeenCalledTimes(2);
        const [target, init] = fetchMock.mock.calls[1] as [unknown, RequestInit];
        expect(new URL(String(target)).hostname).toBe('tuner.example.net');
        expect(new Headers(init.headers).get('host')).toBeNull();
        // The pinned lookup answers on a later tick, so wait for each callback.
        const dialed = await Promise.all(
            agentOpts.map(
                (o) =>
                    new Promise<string>((resolve) => {
                        o.connect.lookup('ignored', { all: true }, (_e, addrs) => {
                            resolve(addrs[0].address);
                        });
                    }),
            ),
        );
        expect(dialed).toEqual(['192.168.1.50', '192.168.1.60']);
    });

    it('never lets discover follow a redirect on its own', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(makeDiscoverResponse()));
        global.fetch = fetchMock;

        await validateHdHomeRunDevice('192.168.1.50');

        expect(fetchMock.mock.calls[0][1].redirect).toBe('manual');
    });

    it('rejects a discover redirect to a blocked address without issuing the request', async () => {
        mockValidateUrl.mockImplementation(async (url: string) =>
            url.includes('169.254.169.254')
                ? { valid: false, reason: 'Blocked private IP address: 169.254.169.254' }
                : { valid: true, resolvedIp: '192.168.1.50' },
        );
        const fetchMock = vi
            .fn()
            .mockResolvedValue(redirectTo('http://169.254.169.254/latest/meta-data/'));
        global.fetch = fetchMock;

        const result = await validateHdHomeRunDevice('192.168.1.50');

        expect(result.valid).toBe(false);
        if (!result.valid) expect(result.errorType).toBe('ssrf_blocked');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('follows a discover redirect to an allowed host', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(redirectTo('http://192.168.1.51/discover.json'))
            .mockResolvedValueOnce(jsonResponse(makeDiscoverResponse()));
        global.fetch = fetchMock;

        const result = await validateHdHomeRunDevice('192.168.1.50');

        expect(result.valid).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(mockValidateUrl).toHaveBeenCalledTimes(2);
    });

    it('rejects a sixth discover redirect hop', async () => {
        let n = 0;
        const fetchMock = vi
            .fn()
            .mockImplementation(async () => redirectTo(`http://192.168.1.50/hop${++n}.json`));
        global.fetch = fetchMock;

        const result = await validateHdHomeRunDevice('192.168.1.50');

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.errorType).toBe('invalid_response');
            expect(result.reason).toMatch(/redirect/i);
        }
        expect(fetchMock).toHaveBeenCalledTimes(6);
    });

    it('does not echo the upstream status of a redirected discover hop', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(redirectTo('http://192.168.1.51/discover.json'))
            .mockResolvedValueOnce(new Response('boom', { status: 500 }));
        global.fetch = fetchMock;

        const result = await validateHdHomeRunDevice('192.168.1.50');

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(result.valid).toBe(false);
        if (!result.valid) expect(result.reason).not.toContain('500');
    });

    it('does not echo the connect error of a redirected discover hop', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(redirectTo('http://192.168.1.51/discover.json'))
            .mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:6379'));
        global.fetch = fetchMock;

        const result = await validateHdHomeRunDevice('192.168.1.50');

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(result.valid).toBe(false);
        if (!result.valid) expect(result.reason).not.toContain('ECONNREFUSED');
    });

    it('rejects a lineup redirect to a blocked address without issuing the request', async () => {
        mockValidateUrl.mockImplementation(async (url: string) =>
            url.includes('169.254.169.254')
                ? { valid: false, reason: 'Blocked private IP address: 169.254.169.254' }
                : { valid: true, resolvedIp: '192.168.1.50' },
        );
        const fetchMock = vi
            .fn()
            .mockResolvedValue(redirectTo('http://169.254.169.254/latest/meta-data/'));
        global.fetch = fetchMock;

        await expect(fetchHdHomeRunLineup('192.168.1.50')).rejects.toThrow(/SSRF blocked/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('follows a lineup redirect to an allowed host', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(redirectTo('http://192.168.1.51/lineup.json'))
            .mockResolvedValueOnce(jsonResponse(makeLineupResponse()));
        global.fetch = fetchMock;

        const channels = await fetchHdHomeRunLineup('192.168.1.50');

        expect(channels.length).toBeGreaterThan(0);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('rejects a sixth lineup redirect hop', async () => {
        let n = 0;
        const fetchMock = vi
            .fn()
            .mockImplementation(async () => redirectTo(`http://192.168.1.50/hop${++n}.json`));
        global.fetch = fetchMock;

        await expect(fetchHdHomeRunLineup('192.168.1.50')).rejects.toThrow(/too many redirects/i);
        expect(fetchMock).toHaveBeenCalledTimes(6);
    });

    it('does not echo the upstream status of a redirected lineup hop', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(redirectTo('http://192.168.1.51/lineup.json'))
            .mockResolvedValueOnce(new Response('boom', { status: 500 }));
        global.fetch = fetchMock;

        await expect(fetchHdHomeRunLineup('192.168.1.50')).rejects.toThrow(/^(?!.*500).*$/);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
