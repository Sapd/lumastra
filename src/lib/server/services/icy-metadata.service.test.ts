// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { _resetSsrfDnsCacheForTests } from '$lib/server/utils/ssrf-guard.js';
import {
    parseStreamTitle,
    clearIcyCache,
    getNowPlaying,
    getStreamInfo,
} from './icy-metadata.service';

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

// The real ssrf-guard runs; only DNS and the undici transport are mocked, so
// the assertions see what would reach the network.
const dnsLookupMock = vi.fn();
vi.mock('node:dns/promises', () => ({
    default: { lookup: (...args: unknown[]) => dnsLookupMock(...args) },
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
        destroy(): Promise<void> {
            return Promise.resolve();
        }
    },
    fetch: (...args: unknown[]) => undiciFetchMock(...args),
}));

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

/** An ICY stream: 16 audio bytes, then one metadata block. */
function icyStream(title: string): Response {
    const meta = new TextEncoder().encode(`StreamTitle='${title}';`);
    const blocks = Math.ceil(meta.length / 16);
    const body = new Uint8Array(16 + 1 + blocks * 16);
    body.fill(0x41, 0, 16);
    body[16] = blocks;
    body.set(meta, 17);
    return new Response(body, { status: 200, headers: { 'icy-metaint': '16' } });
}

describe('icy-metadata', () => {
    describe('parseStreamTitle', () => {
        it('extracts artist and title from standard ICY format', () => {
            expect(parseStreamTitle("StreamTitle='Artist - Track Title';")).toBe(
                'Artist - Track Title',
            );
        });

        it('returns null for empty StreamTitle', () => {
            expect(parseStreamTitle("StreamTitle='';")).toBeNull();
        });

        it('returns null for whitespace-only StreamTitle', () => {
            expect(parseStreamTitle("StreamTitle='   ';")).toBeNull();
        });

        it('returns null when StreamTitle key is missing', () => {
            expect(parseStreamTitle('StreamUrl=http://example.com;')).toBeNull();
        });

        it('returns null for empty metadata string', () => {
            expect(parseStreamTitle('')).toBeNull();
        });

        it('handles metadata with multiple key-value pairs', () => {
            expect(parseStreamTitle("StreamTitle='Jazz FM';StreamUrl='http://jazz.fm';")).toBe(
                'Jazz FM',
            );
        });

        it('handles titles with special characters', () => {
            expect(parseStreamTitle("StreamTitle='Bélora - Crazy In Love (feat. Jay-L)';")).toBe(
                'Bélora - Crazy In Love (feat. Jay-L)',
            );
        });

        it('trims whitespace from extracted title', () => {
            expect(parseStreamTitle("StreamTitle='  Some Title  ';")).toBe('Some Title');
        });
    });

    describe('clearIcyCache', () => {
        it('does not throw when clearing empty cache', () => {
            expect(() => clearIcyCache()).not.toThrow();
        });

        it('does not throw when clearing a specific URL', () => {
            expect(() => clearIcyCache('http://example.com/stream')).not.toThrow();
        });
    });

    describe('getNowPlaying', () => {
        beforeEach(() => {
            vi.clearAllMocks();
            agentOpts.length = 0;
            clearIcyCache();
            _resetSsrfDnsCacheForTests();
        });

        // A name-based vhost (TechnoBase FM, 2026-10-06) only answers for its
        // own name: the request must carry the hostname, not the IP.
        it('connects to the vetted IP but keeps the hostname in the URL', async () => {
            dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
            undiciFetchMock.mockResolvedValue(icyStream('Artist - Title'));

            const title = await getNowPlaying('http://radio.example.com:8000/live');

            expect(title).toBe('Artist - Title');
            expect(undiciFetchMock).toHaveBeenCalledTimes(1);
            const [url, init] = undiciFetchMock.mock.calls[0] as [URL, RequestInit];
            expect(String(url)).toBe('http://radio.example.com:8000/live');
            const headers = new Headers(init.headers);
            expect(headers.get('icy-metadata')).toBe('1');
            expect(headers.has('host')).toBe(false);
            expect(init.redirect).toBe('manual');
            expect(await pinnedAddress(0)).toBe('93.184.216.34');
        });

        it('never fetches a host that resolves to a private address', async () => {
            dnsLookupMock.mockResolvedValue([
                { address: '8.8.8.8', family: 4 },
                { address: '10.0.0.7', family: 4 },
            ]);

            expect(await getNowPlaying('http://rebind.example.com/live')).toBeNull();
            expect(undiciFetchMock).not.toHaveBeenCalled();
        });

        // A station that announces a huge metaint and keeps the socket open held
        // one reader per poll until the upstream closed it.
        it('refuses an absurd icy-metaint without reading the body', async () => {
            dnsLookupMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
            let pulled = 0;
            const stream = new ReadableStream<Uint8Array>({
                pull(controller) {
                    pulled += 1;
                    controller.enqueue(new Uint8Array(1024));
                    if (pulled > 100_000) controller.close();
                },
            });
            undiciFetchMock.mockResolvedValue(
                new Response(stream, { status: 200, headers: { 'icy-metaint': '9999999999' } }),
            );

            expect(await getNowPlaying('http://huge.example.com/live')).toBeNull();
            expect(pulled).toBeLessThan(10);
        });

        it('gives up on a stream that stalls after the headers', async () => {
            vi.useFakeTimers();
            try {
                dnsLookupMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
                const stream = new ReadableStream<Uint8Array>({
                    pull: () => new Promise<void>(() => {}),
                });
                undiciFetchMock.mockResolvedValue(
                    new Response(stream, { status: 200, headers: { 'icy-metaint': '16' } }),
                );

                const pending = getNowPlaying('http://stall.example.com/live');
                let settled = false;
                void pending.then(() => {
                    settled = true;
                });
                await vi.advanceTimersByTimeAsync(6000);
                expect(settled).toBe(true);
                expect(await pending).toBeNull();
            } finally {
                vi.useRealTimers();
            }
        });

        it('does not follow a redirect', async () => {
            dnsLookupMock.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
            undiciFetchMock.mockResolvedValue(
                new Response(null, { status: 302, headers: { location: 'http://10.0.0.7/' } }),
            );

            expect(await getNowPlaying('http://hop.example.com/live')).toBeNull();
            expect(undiciFetchMock).toHaveBeenCalledTimes(1);
        });
    });
    describe('getStreamInfo', () => {
        beforeEach(() => {
            vi.clearAllMocks();
            agentOpts.length = 0;
            _resetSsrfDnsCacheForTests();
            dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        });

        /** UTF-8 bytes as one char per byte, the way header values arrive. */
        function asHeaderBytes(text: string): string {
            return String.fromCharCode(...new TextEncoder().encode(text));
        }

        it('reads icy-* headers and re-decodes UTF-8 values', async () => {
            undiciFetchMock.mockResolvedValue(
                new Response('audio', {
                    status: 200,
                    headers: {
                        'icy-name': asHeaderBytes('Radio Köln'),
                        'icy-genre': 'Techno',
                        'icy-url': 'https://radio.example.com',
                        'content-type': 'audio/aacp',
                    },
                }),
            );

            expect(await getStreamInfo('http://radio.example.com/live')).toEqual({
                name: 'Radio Köln',
                genre: 'Techno',
                websiteUrl: 'https://radio.example.com',
                contentType: 'audio/aacp',
            });
            const [, init] = undiciFetchMock.mock.calls[0] as [URL, RequestInit];
            expect(new Headers(init.headers).get('icy-metadata')).toBe('1');
            expect(init.redirect).toBe('manual');
        });

        it('keeps a latin-1 value that is not valid UTF-8', async () => {
            undiciFetchMock.mockResolvedValue(
                new Response('', { status: 200, headers: { 'icy-name': 'Caf\u00e9 FM' } }),
            );
            expect((await getStreamInfo('http://radio.example.com/live'))?.name).toBe('Café FM');
        });

        it('follows a redirect and re-checks the target', async () => {
            undiciFetchMock
                .mockResolvedValueOnce(
                    new Response(null, {
                        status: 302,
                        headers: { location: 'http://lb.example.com/live' },
                    }),
                )
                .mockResolvedValueOnce(
                    new Response(null, { status: 200, headers: { 'icy-name': 'Station' } }),
                );

            expect(await getStreamInfo('http://radio.example.com/live')).toEqual({
                name: 'Station',
            });
            expect(String((undiciFetchMock.mock.calls[1] as [URL])[0])).toBe(
                'http://lb.example.com/live',
            );
            expect(dnsLookupMock).toHaveBeenCalledTimes(2);
        });

        it('refuses a redirect to a private address', async () => {
            dnsLookupMock.mockImplementation((host: string) =>
                Promise.resolve(
                    host === 'internal.example.com'
                        ? [{ address: '10.0.0.5', family: 4 }]
                        : [{ address: '93.184.216.34', family: 4 }],
                ),
            );
            undiciFetchMock.mockResolvedValueOnce(
                new Response(null, {
                    status: 302,
                    headers: { location: 'http://internal.example.com/' },
                }),
            );

            expect(await getStreamInfo('http://radio.example.com/live')).toBeNull();
            expect(undiciFetchMock).toHaveBeenCalledTimes(1);
        });

        it('returns null for an upstream error', async () => {
            undiciFetchMock.mockResolvedValue(new Response('', { status: 404 }));
            expect(await getStreamInfo('http://radio.example.com/live')).toBeNull();
        });

        it('gives up after three redirects', async () => {
            undiciFetchMock.mockImplementation(() =>
                Promise.resolve(
                    new Response(null, {
                        status: 302,
                        headers: { location: 'http://radio.example.com/next' },
                    }),
                ),
            );
            expect(await getStreamInfo('http://radio.example.com/live')).toBeNull();
            expect(undiciFetchMock).toHaveBeenCalledTimes(4);
        });

        it('returns null for a redirect without a Location or to a non-http scheme', async () => {
            undiciFetchMock.mockResolvedValueOnce(new Response(null, { status: 302 }));
            expect(await getStreamInfo('http://radio.example.com/live')).toBeNull();

            undiciFetchMock.mockResolvedValueOnce(
                new Response(null, {
                    status: 302,
                    headers: { location: 'ftp://radio.example.com/' },
                }),
            );
            expect(await getStreamInfo('http://radio.example.com/live')).toBeNull();
            expect(undiciFetchMock).toHaveBeenCalledTimes(2);
        });

        it('caps values at the create-form limits and drops a non-http icy-url', async () => {
            undiciFetchMock.mockResolvedValue(
                new Response(null, {
                    status: 200,
                    headers: {
                        'icy-name': 'N'.repeat(500),
                        'icy-genre': 'G'.repeat(500),
                        'icy-url': 'javascript:alert(1)',
                    },
                }),
            );
            const info = await getStreamInfo('http://radio.example.com/live');
            expect(info?.name).toHaveLength(200);
            expect(info?.genre).toHaveLength(100);
            expect(info?.websiteUrl).toBeUndefined();
        });

        it('returns null when the fetch fails', async () => {
            undiciFetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));
            expect(await getStreamInfo('http://radio.example.com/live')).toBeNull();
        });
    });
});
