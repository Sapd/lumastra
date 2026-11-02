// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, test, expect, beforeEach, vi } from 'vitest';

// The real url-validator and ssrf-guard run; only DNS and the undici transport
// are mocked, so the assertions see what would reach the network.
type PinLookup = (
    host: string,
    opts: unknown,
    cb: (err: null, addrs: Array<{ address: string; family: number }>) => void,
) => void;
const hoisted = vi.hoisted(() => ({
    /** hostname -> address the mocked DNS answers with. */
    dns: new Map<string, string>(),
    agentOpts: [] as Array<{ connect: { lookup: PinLookup } }>,
    undiciFetch: vi.fn(),
    config: { LIVETV_ALLOW_PRIVATE_URLS: false },
}));

vi.mock('node:dns', () => {
    const lookup = vi.fn(async (hostname: string) => {
        const address = hoisted.dns.get(hostname);
        if (!address) throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
        return [{ address, family: address.includes(':') ? 6 : 4 }];
    });
    return { promises: { lookup }, default: { promises: { lookup } } };
});
vi.mock('node:dns/promises', () => ({ default: { lookup: vi.fn() } }));

vi.mock('undici', () => ({
    Agent: class {
        constructor(opts: { connect: { lookup: PinLookup } }) {
            hoisted.agentOpts.push(opts);
        }
        close(): Promise<void> {
            return Promise.resolve();
        }
        destroy(): Promise<void> {
            return Promise.resolve();
        }
    },
    fetch: (...args: unknown[]) => hoisted.undiciFetch(...args),
}));

const dispatcherRef: { value: unknown } = { value: undefined };
vi.mock('./upstream-proxy.js', () => ({
    getLiveTvUpstreamDispatcher: () => dispatcherRef.value,
}));

vi.mock('$lib/server/config.js', () => ({ config: hoisted.config }));

import { fetchSsrfValidatedText } from './fetch-source.js';

const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as Parameters<
    typeof fetchSsrfValidatedText
>[1]['logger'];

const opts = {
    sourceId: 's1',
    logger,
    contentLabel: 'M3U',
    fetchFailLogMessage: 'fail',
} as const;

/** A 3xx response. 3xx is not a null-body status, but keep the body empty. */
function redirectTo(location: string, status = 302): Response {
    return new Response(null, { status, headers: { location } });
}

/**
 * The address (and family) the Nth pinned connection would dial. The pinned
 * lookup answers on a later tick (like dns.lookup), so wait for its callback.
 */
function pinned(n: number): Promise<{ address: string; family: number }> {
    return new Promise((resolve) => {
        hoisted.agentOpts[n].connect.lookup('ignored', { all: true }, (_e, addrs) => {
            resolve(addrs[0]);
        });
    });
}
async function pinnedAddress(n: number): Promise<string> {
    return (await pinned(n)).address;
}

/** URL and Host header of the Nth outgoing request. */
function sent(n: number): { url: string; host: string | null; init: Record<string, unknown> } {
    const [target, init = {}] = hoisted.undiciFetch.mock.calls[n] as [
        unknown,
        Record<string, unknown>?,
    ];
    return {
        url: String(target),
        host: new Headers(init.headers as HeadersInit | undefined).get('host'),
        init,
    };
}

function resetTransport(): void {
    dispatcherRef.value = undefined;
    hoisted.config.LIVETV_ALLOW_PRIVATE_URLS = false;
    hoisted.agentOpts.length = 0;
    hoisted.undiciFetch.mockReset();
    hoisted.dns.clear();
    hoisted.dns.set('provider.example.com', '93.184.216.34');
    hoisted.dns.set('cdn.example.net', '8.8.8.8');
    hoisted.dns.set('event-provider.example', '93.184.216.34');
    hoisted.dns.set('iptv.example', '93.184.216.34');
}

/**
 * The 2026-10-06 TechnoBase FM bug: the direct http path pinned by putting the
 * resolved IP into the URL and sending `Host` as a header. fetch() drops a
 * caller-set Host, so a name-based virtual host saw `Host: <ip>` and answered
 * for the wrong site (or redirected to https://<ip>/, which fails TLS). The pin
 * now lives in the transport: the URL keeps its hostname.
 */
describe('fetchSsrfValidatedText connection pinning', () => {
    beforeEach(resetTransport);

    test('direct http: URL keeps its hostname, no Host header, connection pinned to the vetted IP', async () => {
        hoisted.undiciFetch.mockResolvedValue(new Response('PLAYLIST', { status: 200 }));

        await expect(
            fetchSsrfValidatedText('http://provider.example.com:8000/list.m3u', opts),
        ).resolves.toBe('PLAYLIST');

        expect(hoisted.undiciFetch).toHaveBeenCalledTimes(1);
        const req = sent(0);
        expect(req.url).toBe('http://provider.example.com:8000/list.m3u');
        expect(req.host).toBeNull();
        expect(hoisted.agentOpts).toHaveLength(1);
        expect(req.init.dispatcher).toBeDefined();
        expect(await pinnedAddress(0)).toBe('93.184.216.34');
    });

    test('direct https: pinned the same way, hostname kept for SNI', async () => {
        hoisted.undiciFetch.mockResolvedValue(new Response('PLAYLIST', { status: 200 }));

        await fetchSsrfValidatedText('https://provider.example.com/list.m3u', opts);

        expect(sent(0).url).toBe('https://provider.example.com/list.m3u');
        expect(sent(0).host).toBeNull();
        expect(await pinnedAddress(0)).toBe('93.184.216.34');
    });

    test('IPv6-only host: pinned with family 6, URL keeps its hostname', async () => {
        hoisted.dns.set('v6.example.net', '2606:4700:4700::1111');
        hoisted.undiciFetch.mockResolvedValue(new Response('PLAYLIST', { status: 200 }));

        await fetchSsrfValidatedText('http://v6.example.net/list.m3u', opts);

        expect(sent(0).url).toBe('http://v6.example.net/list.m3u');
        expect(await pinned(0)).toEqual({ address: '2606:4700:4700::1111', family: 6 });
    });

    test('LIVETV_ALLOW_PRIVATE_URLS: a LAN IP-literal URL is fetched and pinned to that IP', async () => {
        hoisted.config.LIVETV_ALLOW_PRIVATE_URLS = true;
        hoisted.undiciFetch.mockResolvedValue(new Response('PLAYLIST', { status: 200 }));

        await fetchSsrfValidatedText('http://192.168.1.10:8080/list.m3u', opts);

        expect(sent(0).url).toBe('http://192.168.1.10:8080/list.m3u');
        expect(await pinnedAddress(0)).toBe('192.168.1.10');
    });

    test('LIVETV_ALLOW_PRIVATE_URLS off: the same LAN URL is refused', async () => {
        await expect(
            fetchSsrfValidatedText('http://192.168.1.10:8080/list.m3u', opts),
        ).rejects.toThrow(/SSRF blocked/);
        expect(hoisted.undiciFetch).not.toHaveBeenCalled();
    });

    test('URL credentials go out as Basic auth, never in the request URL', async () => {
        hoisted.undiciFetch.mockResolvedValue(new Response('PLAYLIST', { status: 200 }));

        await fetchSsrfValidatedText('http://iptvuser:s3cret@provider.example.com/list.m3u', opts);

        expect(sent(0).url).toBe('http://provider.example.com/list.m3u');
        const auth = new Headers(sent(0).init.headers as HeadersInit).get('authorization');
        expect(auth).toBe(`Basic ${Buffer.from('iptvuser:s3cret').toString('base64')}`);
        expect(await pinnedAddress(0)).toBe('93.184.216.34');
    });

    test('proxied: hands the hostname to the proxy dispatcher, no local pin', async () => {
        const sentinel = { mark: 'proxy-agent' };
        dispatcherRef.value = sentinel;
        hoisted.undiciFetch.mockResolvedValue(new Response('PLAYLIST', { status: 200 }));

        const body = await fetchSsrfValidatedText('http://provider.example.com/list.m3u', opts);

        expect(body).toBe('PLAYLIST');
        expect(sent(0).url).toBe('http://provider.example.com/list.m3u');
        expect(sent(0).init.dispatcher).toBe(sentinel);
        expect(sent(0).host).toBeNull();
        expect(hoisted.agentOpts).toHaveLength(0);
    });

    test('proxied: a private target is still refused before the proxy is asked', async () => {
        dispatcherRef.value = { mark: 'proxy-agent' };
        hoisted.dns.set('provider.example.com', '10.0.0.5');

        await expect(
            fetchSsrfValidatedText('http://provider.example.com/list.m3u', opts),
        ).rejects.toThrow(/SSRF blocked/);
        expect(hoisted.undiciFetch).not.toHaveBeenCalled();
    });
});

/**
 * Security review 2026-09-12, C6. The URL was SSRF-validated once and then
 * handed to a bare `fetch`, which follows up to 20 redirects on its own. A
 * hostile or compromised provider could answer `302 Location: http://127.0.0.1/`
 * and reach anything the app container can reach — and the echoed upstream
 * status turned that into an internal port scanner, re-fired every cron tick.
 */
describe('fetchSsrfValidatedText redirect re-validation', () => {
    beforeEach(resetTransport);

    test('never lets fetch follow a redirect on its own', async () => {
        hoisted.undiciFetch.mockResolvedValue(new Response('PLAYLIST', { status: 200 }));

        await fetchSsrfValidatedText('http://provider.example.com/list.m3u', opts);

        expect(sent(0).init.redirect).toBe('manual');
    });

    test('rejects a redirect to a private address without issuing the request', async () => {
        hoisted.undiciFetch.mockResolvedValue(redirectTo('http://127.0.0.1/'));

        await expect(
            fetchSsrfValidatedText('http://provider.example.com/list.m3u', opts),
        ).rejects.toThrow(/SSRF blocked/);

        // The redirected request must never have gone out.
        expect(hoisted.undiciFetch).toHaveBeenCalledTimes(1);
        expect(sent(0).url).toBe('http://provider.example.com/list.m3u');
    });

    test('rejects a redirect to a hostname that resolves privately', async () => {
        hoisted.dns.set('internal.example.net', '192.168.1.20');
        hoisted.undiciFetch.mockResolvedValue(redirectTo('http://internal.example.net/'));

        await expect(
            fetchSsrfValidatedText('http://provider.example.com/list.m3u', opts),
        ).rejects.toThrow(/SSRF blocked/);
        expect(hoisted.undiciFetch).toHaveBeenCalledTimes(1);
    });

    test('follows a redirect to another public host, pinned to ITS address', async () => {
        hoisted.undiciFetch
            .mockResolvedValueOnce(redirectTo('http://cdn.example.net/real.m3u'))
            .mockResolvedValueOnce(new Response('PLAYLIST', { status: 200 }));

        const body = await fetchSsrfValidatedText('http://provider.example.com/list.m3u', opts);

        expect(body).toBe('PLAYLIST');
        expect(hoisted.undiciFetch).toHaveBeenCalledTimes(2);
        // Hop 2 is re-validated and re-pinned to its own resolved address.
        expect(sent(1).url).toBe('http://cdn.example.net/real.m3u');
        expect(sent(1).host).toBeNull();
        expect(await pinnedAddress(0)).toBe('93.184.216.34');
        expect(await pinnedAddress(1)).toBe('8.8.8.8');
    });

    test('allows a chain of five redirects', async () => {
        for (let i = 1; i <= 5; i++) {
            hoisted.undiciFetch.mockResolvedValueOnce(
                redirectTo(`http://provider.example.com/hop${i}.m3u`),
            );
        }
        hoisted.undiciFetch.mockResolvedValueOnce(new Response('PLAYLIST', { status: 200 }));

        await expect(
            fetchSsrfValidatedText('http://provider.example.com/list.m3u', opts),
        ).resolves.toBe('PLAYLIST');
        expect(hoisted.undiciFetch).toHaveBeenCalledTimes(6);
    });

    test('rejects a sixth redirect hop', async () => {
        let n = 0;
        hoisted.undiciFetch.mockImplementation(async () =>
            redirectTo(`http://provider.example.com/hop${++n}.m3u`),
        );

        await expect(
            fetchSsrfValidatedText('http://provider.example.com/list.m3u', opts),
        ).rejects.toThrow(/too many redirects/i);
        expect(hoisted.undiciFetch).toHaveBeenCalledTimes(6);
    });

    test('does not echo the upstream status of a redirected hop', async () => {
        hoisted.undiciFetch
            .mockResolvedValueOnce(redirectTo('http://cdn.example.net/real.m3u'))
            .mockResolvedValueOnce(new Response('nope', { status: 503 }));

        await expect(
            fetchSsrfValidatedText('http://provider.example.com/list.m3u', opts),
        ).rejects.toThrow(/^(?!.*503).*$/);
    });

    test('does not echo the connect error of a redirected hop', async () => {
        hoisted.undiciFetch
            .mockResolvedValueOnce(redirectTo('http://cdn.example.net/real.m3u'))
            .mockRejectedValueOnce(
                Object.assign(new Error('fetch failed'), {
                    cause: new Error('connect ECONNREFUSED 10.0.0.5:6379'),
                }),
            );

        await expect(
            fetchSsrfValidatedText('http://provider.example.com/list.m3u', opts),
        ).rejects.toThrow(/^(?!.*ECONNREFUSED).*$/);
    });

    test('still echoes the first-hop status (no redirect involved)', async () => {
        hoisted.undiciFetch.mockResolvedValue(new Response('nope', { status: 404 }));

        await expect(
            fetchSsrfValidatedText('http://provider.example.com/list.m3u', opts),
        ).rejects.toThrow(/HTTP 404/);
    });

    test('refuses a body over the size cap and stops reading it', async () => {
        const cancel = vi.fn();
        const chunk = new Uint8Array(64 * 1024).fill(0x41);
        const endless = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(chunk);
            },
            cancel,
        });
        hoisted.undiciFetch.mockResolvedValue(new Response(endless, { status: 200 }));

        await expect(
            fetchSsrfValidatedText('http://provider.example.com/list.m3u', {
                ...opts,
                maxBytes: 1024 * 1024,
            }),
        ).rejects.toThrow(/larger than 1 MiB/);
        expect(cancel).toHaveBeenCalled();
    });

    test('returns a body under the cap in full', async () => {
        hoisted.undiciFetch.mockResolvedValue(new Response('#EXTM3U\n', { status: 200 }));

        await expect(
            fetchSsrfValidatedText('http://provider.example.com/list.m3u', {
                ...opts,
                maxBytes: 16,
            }),
        ).resolves.toBe('#EXTM3U\n');
    });

    test('cancels the body of an error response, freeing the pinned connection', async () => {
        const cancel = vi.fn();
        const body = new ReadableStream({ cancel });
        hoisted.undiciFetch.mockResolvedValue(new Response(body, { status: 500 }));

        await expect(
            fetchSsrfValidatedText('http://provider.example.com/list.m3u', opts),
        ).rejects.toThrow(/HTTP 500/);
        expect(cancel).toHaveBeenCalled();
    });
});

describe('fetchSsrfValidatedText credential redaction', () => {
    const USER = 'subscriber7731';
    const PASS = 'Xq9vT2mLpK';
    const XTREAM_URL = `http://event-provider.example:8080/playlist/${USER}/${PASS}/m3u_plus`;

    beforeEach(() => {
        resetTransport();
        (logger.error as ReturnType<typeof vi.fn>).mockClear();
    });

    test('a failed refresh logs and throws without the Xtream credentials', async () => {
        hoisted.undiciFetch.mockRejectedValue(
            Object.assign(new Error('fetch failed'), {
                // An upstream cause that echoes the full request URL.
                cause: new Error(`request to ${XTREAM_URL} failed, reason: ETIMEDOUT`),
            }),
        );

        const err = await fetchSsrfValidatedText(XTREAM_URL, opts).then(
            () => null,
            (e: unknown) => e as Error,
        );
        expect(err).toBeInstanceOf(Error);
        expect(err!.message).toContain('event-provider.example');
        expect(err!.message).not.toContain(USER);
        expect(err!.message).not.toContain(PASS);

        expect(logger.error).toHaveBeenCalledTimes(1);
        const [, loggedError, context] = (logger.error as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(context.url).toBe('http://event-provider.example:8080/playlist/***/***/m3u_plus');
        const logged = JSON.stringify(context);
        expect(logged).not.toContain(USER);
        expect(logged).not.toContain(PASS);
        // The logged error and the chained cause are redacted copies too: the
        // logger prints the stack, and the cause travels with the thrown error.
        for (const e of [loggedError as Error, err!.cause as Error]) {
            const text = `${e.message} ${e.stack} ${(e.cause as Error | undefined)?.message}`;
            expect(text).toContain('ETIMEDOUT');
            expect(text).not.toContain(USER);
            expect(text).not.toContain(PASS);
        }
    });

    test('query-form credentials (get.php) never reach the log', async () => {
        const url = `http://iptv.example/get.php?username=${USER}&password=${PASS}&type=m3u_plus`;
        hoisted.undiciFetch.mockRejectedValue(new Error('fetch failed'));

        await expect(fetchSsrfValidatedText(url, opts)).rejects.toThrow();
        const [, , context] = (logger.error as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(context.url).toBe(
            'http://iptv.example/get.php?username=***&password=***&type=m3u_plus',
        );
    });
});

describe('setup feed sampling', () => {
    beforeEach(resetTransport);
    test('checks a large XMLTV feed without downloading it all, and cancels the body', async () => {
        const { probeLiveTvFeed } = await import('./source-probe.js');
        const cancel = vi.fn();
        let chunks = 0;
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('<tv>' + ' '.repeat(128 * 1024)));
            },
            pull(controller) {
                if (++chunks < 100) controller.enqueue(encoder.encode(' '.repeat(1024)));
                else {
                    controller.enqueue(encoder.encode('</tv>'));
                    controller.close();
                }
            },
            cancel,
        });
        hoisted.undiciFetch.mockResolvedValue(new Response(body));
        expect(
            await probeLiveTvFeed('http://provider.example.com/epg.xml', 'XMLTV'),
        ).toBeUndefined();
        expect(cancel).toHaveBeenCalled();
        expect(chunks).toBeLessThan(100);
    });
});
