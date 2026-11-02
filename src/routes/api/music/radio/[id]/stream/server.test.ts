// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Radio stream proxy: SSRF pinning and virtual-host routing.
 *
 * This route proxies an operator/M3U-supplied stream URL and pipes the upstream
 * body straight back to the caller, so a successful DNS rebind would be a
 * READABLE SSRF. The route goes through the real `safeFetch`; only DNS and the
 * undici transport are mocked, so these tests see what actually reaches the
 * network layer.
 *
 * Regression (TechnoBase FM, 2026-10-06): the route used to swap the hostname
 * for the resolved IP (buildPinnedFetch) and send `Host:` as a header. fetch()
 * drops a caller-set Host, so the station's nginx answered for the bare IP,
 * redirected to https://<ip>/ and the TLS handshake failed: every play was a
 * 500. Pinning now happens in the dispatcher, and the URL keeps its hostname.
 *
 * Run: npx vitest run 'src/routes/api/music/radio/[id]/stream/server.test.ts'
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAuth: (handler: unknown) => handler,
}));

vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (handler: unknown) => handler,
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

const STATION_ID = '11111111-2222-4333-8444-555555555555';
const STREAM_URL = 'http://rebinding.example.com/stream.mp3';

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: {
        // The station row is the only query this route makes.
        getSql: vi.fn(async () => vi.fn(async () => [{ stream_url: STREAM_URL }])),
    },
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn(async () => true),
}));

const grantValidation = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/services/playback-grant.js', () => ({
    validatePlaybackGrant: grantValidation,
    playbackGrantUserContext: vi.fn(),
}));

const dnsLookupMock = vi.fn();
vi.mock('node:dns', () => ({
    promises: { lookup: (...args: unknown[]) => dnsLookupMock(...args) },
}));

type PinLookup = (
    host: string,
    opts: unknown,
    cb: (err: null, addrs: Array<{ address: string; family: number }>) => void,
) => void;
const agentOpts: Array<{ connect: { lookup: PinLookup } }> = [];
const undiciFetchMock = vi.fn();
vi.mock('undici', () => ({
    Agent: class {
        constructor(opts: { connect: { lookup: PinLookup } }) {
            agentOpts.push(opts);
        }
        close(): Promise<void> {
            return Promise.resolve();
        }
    },
    fetch: (...args: unknown[]) => undiciFetchMock(...args),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

type GetEvent = Parameters<typeof import('./+server.js').GET>[0];

function makeEvent(): GetEvent {
    return {
        params: { id: STATION_ID },
        locals: { user: { userId: 'u1', username: 'alice' } },
        request: new Request('http://localhost/api/music/radio/x/stream'),
        url: new URL('http://localhost/api/music/radio/x/stream'),
        getClientAddress: () => '127.0.0.1',
    } as unknown as GetEvent;
}

/**
 * The address the Nth pinned connection would dial. The pinned lookup answers
 * on a later tick (like dns.lookup), so wait for its callback.
 */
function pinnedAddress(n: number): Promise<string> {
    return new Promise((resolve) => {
        agentOpts[n].connect.lookup('ignored', { all: true }, (_e, addrs) => {
            resolve(addrs[0].address);
        });
    });
}

function audio(): Response {
    return new Response('audio-bytes', { status: 200, headers: { 'content-type': 'audio/aac' } });
}

function redirect(location: string): Response {
    return new Response(null, { status: 302, headers: { location } });
}

// Warm the route's module graph once, in a hook with its own timeout. A cold
// Vite transform of this graph costs tens of seconds; inside the default 30s
// per-TEST timeout that lands as a "Test timed out" on whichever test happens to
// run first. Paying it here keeps the tests measuring the route.
beforeAll(async () => {
    await import('./+server.js');
}, 180_000);

beforeEach(() => {
    vi.clearAllMocks();
    agentOpts.length = 0;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GET radio stream proxy — pinning and vhost routing', () => {
    it('does not contact the origin when media access is denied', async () => {
        vi.mocked(checkMediaAccess).mockResolvedValueOnce(false);
        const { GET } = await import('./+server.js');
        const response = await GET(makeEvent());
        expect(response.status).toBe(404);
        expect(undiciFetchMock).not.toHaveBeenCalled();
    });

    it('binds an open granted stream to its station/session and cancels it after stop', async () => {
        vi.useFakeTimers();
        try {
            dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
            const cancel = vi.fn();
            undiciFetchMock.mockResolvedValue(
                new Response(new ReadableStream({ cancel }), {
                    headers: { 'content-type': 'audio/aac' },
                }),
            );
            grantValidation.mockResolvedValue({ reason: 'session_ended' });
            const event = makeEvent();
            event.url.searchParams.set('grant', 'stream_scoped-test');
            event.locals.streamingSession = { playbackSessionId: 'session-radio' } as never;
            const { GET } = await import('./+server.js');
            const response = await GET(event);
            const ended = response
                .body!.getReader()
                .read()
                .catch(() => null);
            await vi.advanceTimersByTimeAsync(10_000);
            await ended;
            expect(grantValidation).toHaveBeenCalledWith('stream_scoped-test', {
                clientIp: '127.0.0.1',
                route: { mediaId: STATION_ID, playbackSessionId: 'session-radio', kind: 'music' },
            });
            expect(cancel).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps the hostname in the URL and pins the connection to the vetted IP', async () => {
        dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        undiciFetchMock.mockResolvedValue(audio());

        const { GET } = await import('./+server.js');
        const resp = await GET(makeEvent());

        expect(resp.status).toBe(200);
        expect(resp.headers.get('content-type')).toBe('audio/aac');
        expect(await resp.text()).toBe('audio-bytes');
        // The vhost name stays in the URL, so Host and SNI are right...
        expect(undiciFetchMock.mock.calls[0][0]).toBe(STREAM_URL);
        // ...while the socket goes to the address that was checked.
        expect(await pinnedAddress(0)).toBe('93.184.216.34');
    });

    it('follows a redirect to another host, re-resolving and re-pinning that hop', async () => {
        // TechnoBase shape: a load balancer 302s to a listener host on :80.
        dnsLookupMock
            .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
            .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]);
        undiciFetchMock
            .mockResolvedValueOnce(redirect('http://listener3.example.com:80/tb-hd.aac'))
            .mockResolvedValueOnce(audio());

        const { GET } = await import('./+server.js');
        const resp = await GET(makeEvent());

        expect(resp.status).toBe(200);
        expect(undiciFetchMock).toHaveBeenCalledTimes(2);
        expect(undiciFetchMock.mock.calls[1][0]).toBe('http://listener3.example.com/tb-hd.aac');
        expect(await pinnedAddress(1)).toBe('8.8.8.8');
    });

    it('never opens a connection when the address resolves private', async () => {
        dnsLookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

        const { GET } = await import('./+server.js');
        const resp = await GET(makeEvent());

        expect(resp.status).toBeGreaterThanOrEqual(400);
        expect(resp.status).toBeLessThan(500);
        expect(undiciFetchMock).not.toHaveBeenCalled();
    });

    it('refuses a redirect whose target resolves private, without connecting to it', async () => {
        dnsLookupMock
            .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
            .mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);
        undiciFetchMock.mockResolvedValueOnce(redirect('http://metadata.example.com/latest/'));

        const { GET } = await import('./+server.js');
        const resp = await GET(makeEvent());

        expect(resp.status).toBeGreaterThanOrEqual(400);
        expect(resp.status).toBeLessThan(500);
        expect(undiciFetchMock).toHaveBeenCalledTimes(1);
    });

    it('answers 502, not 500, when the upstream cannot be reached', async () => {
        dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        undiciFetchMock.mockRejectedValue(new TypeError('fetch failed'));

        const { GET } = await import('./+server.js');
        const resp = await GET(makeEvent());

        expect(resp.status).toBe(502);
    });

    it('answers 502 when the upstream returns an error status', async () => {
        dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        undiciFetchMock.mockResolvedValue(new Response('gone', { status: 404 }));

        const { GET } = await import('./+server.js');
        const resp = await GET(makeEvent());

        expect(resp.status).toBe(502);
    });
});
