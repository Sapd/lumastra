// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { XtreamCredentials, XtreamUrls, XtreamValidationResult } from './xtream-client.js';

// Fix #1: Singleton mock logger so credential redaction test checks the right instance
const mockLoggerInstance = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
};

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => mockLoggerInstance,
    },
}));

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
    fetch: { value: (..._args: unknown[]): Promise<unknown> => Promise.reject(new Error('unset')) },
}));

vi.mock('node:dns', () => {
    const lookup = async (hostname: string) => {
        const address = hoisted.dns.get(hostname);
        if (!address) throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
        return [{ address, family: address.includes(':') ? 6 : 4 }];
    };
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
    fetch: (...args: unknown[]) => hoisted.fetch.value(...args),
}));

/** Route every outgoing request (undici's fetch, behind pinnedFetch) to `fn`. */
function stubFetch(fn: ReturnType<typeof vi.fn>): void {
    hoisted.fetch.value = fn as unknown as typeof hoisted.fetch.value;
}

/**
 * The address the Nth pinned connection would dial. The pinned lookup answers
 * on a later tick (like dns.lookup), so wait for its callback.
 */
function pinnedAddress(n: number): Promise<string> {
    return new Promise((resolve) => {
        hoisted.agentOpts[n].connect.lookup('ignored', { all: true }, (_e, addrs) => {
            resolve(addrs[0].address);
        });
    });
}

function resetTransport(): void {
    dispatcherRef.value = undefined;
    hoisted.agentOpts.length = 0;
    hoisted.fetch.value = () => Promise.reject(new Error('fetch not stubbed'));
    hoisted.dns.clear();
    hoisted.dns.set('provider.example.com', '93.184.216.34');
    hoisted.dns.set('other.example.net', '8.8.8.8');
}

// Mock config
vi.mock('$lib/server/config.js', () => ({
    config: {
        LIVETV_ALLOW_PRIVATE_URLS: false,
    },
}));

// Mutable ref for upstream proxy dispatcher (mirrors fetch-source.test.ts pattern)
const dispatcherRef: { value: unknown } = { value: undefined };
vi.mock('./upstream-proxy.js', () => ({
    getLiveTvUpstreamDispatcher: () => dispatcherRef.value,
}));

describe('buildXtreamUrls', () => {
    let buildXtreamUrls: (creds: XtreamCredentials) => XtreamUrls;

    beforeEach(async () => {
        vi.resetModules();
        const mod = await import('./xtream-client.js');
        buildXtreamUrls = mod.buildXtreamUrls;
    });

    it('constructs correct M3U and XMLTV URLs from standard credentials', () => {
        const creds: XtreamCredentials = {
            serverUrl: 'http://provider.example.com:8080',
            username: 'testuser',
            password: 'testpass',
        };

        const urls = buildXtreamUrls(creds);

        expect(urls.m3uUrl).toBe(
            'http://provider.example.com:8080/get.php?username=testuser&password=testpass&type=m3u_plus',
        );
        expect(urls.xmltvUrl).toBe(
            'http://provider.example.com:8080/xmltv.php?username=testuser&password=testpass',
        );
    });

    it('strips trailing slash from server URL', () => {
        const creds: XtreamCredentials = {
            serverUrl: 'http://provider.example.com:8080/',
            username: 'user',
            password: 'pass',
        };

        const urls = buildXtreamUrls(creds);

        // Should not have double slashes
        expect(urls.m3uUrl).not.toContain('//get.php');
        expect(urls.xmltvUrl).not.toContain('//xmltv.php');
        expect(urls.m3uUrl).toContain('/get.php');
        expect(urls.xmltvUrl).toContain('/xmltv.php');
    });

    it('preserves path in server URL', () => {
        const creds: XtreamCredentials = {
            serverUrl: 'http://host:8080/iptv',
            username: 'user',
            password: 'pass',
        };

        const urls = buildXtreamUrls(creds);

        expect(urls.m3uUrl).toContain('/iptv/get.php');
        expect(urls.xmltvUrl).toContain('/iptv/xmltv.php');
    });

    it('properly encodes special characters in credentials', () => {
        const creds: XtreamCredentials = {
            serverUrl: 'http://provider.example.com:8080',
            username: 'user@domain',
            password: 'p@ss&word=1 2',
        };

        const urls = buildXtreamUrls(creds);

        // URL class encodes via searchParams.set() — verify by parsing
        const m3u = new URL(urls.m3uUrl);
        expect(m3u.searchParams.get('username')).toBe('user@domain');
        expect(m3u.searchParams.get('password')).toBe('p@ss&word=1 2');
        expect(m3u.searchParams.get('type')).toBe('m3u_plus');

        const xmltv = new URL(urls.xmltvUrl);
        expect(xmltv.searchParams.get('username')).toBe('user@domain');
        expect(xmltv.searchParams.get('password')).toBe('p@ss&word=1 2');
    });

    it('handles empty password (some providers allow it)', () => {
        const creds: XtreamCredentials = {
            serverUrl: 'http://provider.example.com:8080',
            username: 'user',
            password: '',
        };

        const urls = buildXtreamUrls(creds);

        const m3u = new URL(urls.m3uUrl);
        expect(m3u.searchParams.get('username')).toBe('user');
        expect(m3u.searchParams.get('password')).toBe('');
    });
});

/** A real 200 Response carrying an active Xtream account. */
function activeAccountResponse(): Response {
    return Response.json({
        user_info: {
            status: 'Active',
            auth: 1,
            exp_date: '',
            max_connections: '1',
            active_cons: '0',
        },
    });
}

describe('validateXtreamCredentials', () => {
    let validateXtreamCredentials: (creds: XtreamCredentials) => Promise<XtreamValidationResult>;

    beforeEach(async () => {
        vi.resetModules();
        resetTransport();
        mockLoggerInstance.info.mockClear();
        mockLoggerInstance.warn.mockClear();
        mockLoggerInstance.error.mockClear();
        mockLoggerInstance.debug.mockClear();

        const mod = await import('./xtream-client.js');
        validateXtreamCredentials = mod.validateXtreamCredentials;
    });

    // Reset the transport in afterEach too so assertion failures don't leak state
    afterEach(() => {
        resetTransport();
    });

    it('returns valid result for active account', async () => {
        stubFetch(
            vi.fn().mockResolvedValue(
                Response.json({
                    user_info: {
                        username: 'testuser',
                        password: 'testpass',
                        status: 'Active',
                        exp_date: '1735689600',
                        max_connections: '2',
                        active_cons: '0',
                        auth: 1,
                    },
                    server_info: {
                        url: 'provider.example.com',
                        port: '8080',
                        server_protocol: 'http',
                    },
                }),
            ),
        );

        const result = await validateXtreamCredentials({
            serverUrl: 'http://provider.example.com:8080',
            username: 'testuser',
            password: 'testpass',
        });

        expect(result.valid).toBe(true);
        if (result.valid) {
            expect(result.serverInfo.isActive).toBe(true);
            expect(result.serverInfo.maxConnections).toBe(2);
            expect(result.serverInfo.expiresAt).toBe('1735689600');

            // Fix #5: Verify full URL structure — original hostname, correct query params
            const m3u = new URL(result.urls.m3uUrl);
            expect(m3u.hostname).toBe('provider.example.com');
            expect(m3u.port).toBe('8080');
            expect(m3u.pathname).toBe('/get.php');
            expect(m3u.searchParams.get('username')).toBe('testuser');
            expect(m3u.searchParams.get('password')).toBe('testpass');
            expect(m3u.searchParams.get('type')).toBe('m3u_plus');

            const xmltv = new URL(result.urls.xmltvUrl);
            expect(xmltv.hostname).toBe('provider.example.com');
            expect(xmltv.pathname).toBe('/xmltv.php');
            expect(xmltv.searchParams.get('username')).toBe('testuser');
            expect(xmltv.searchParams.get('password')).toBe('testpass');
        }
    });

    it('returns invalid_credentials for auth: 0 response', async () => {
        stubFetch(
            vi.fn().mockResolvedValue(
                Response.json({
                    user_info: { auth: 0 },
                }),
            ),
        );

        const result = await validateXtreamCredentials({
            serverUrl: 'http://provider.example.com:8080',
            username: 'bad',
            password: 'creds',
        });

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.errorType).toBe('invalid_credentials');
        }
    });

    it('returns invalid_credentials for HTTP 401', async () => {
        stubFetch(vi.fn().mockResolvedValue(new Response('not json', { status: 401 })));

        const result = await validateXtreamCredentials({
            serverUrl: 'http://provider.example.com:8080',
            username: 'bad',
            password: 'creds',
        });

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.errorType).toBe('invalid_credentials');
        }
    });

    it('does not echo untrusted account status text or URL credentials', async () => {
        stubFetch(
            vi
                .fn()
                .mockResolvedValue(
                    Response.json({
                        user_info: { auth: 1, status: 'http://user:secret@provider.example' },
                    }),
                ),
        );
        const result = await validateXtreamCredentials({
            serverUrl: 'http://provider.example.com:8080',
            username: 'user',
            password: 'secret',
        });
        expect(result.valid).toBe(false);
        expect(JSON.stringify(result)).not.toContain('secret');
        expect(JSON.stringify(mockLoggerInstance.info.mock.calls)).not.toContain('secret');
    });
    it('redacts provider server info before returning it to the admin test endpoint', async () => {
        stubFetch(
            vi
                .fn()
                .mockResolvedValue(
                    Response.json({
                        user_info: { auth: 1, status: 'Active' },
                        server_info: { url: 'http://user:secret@provider.example' },
                    }),
                ),
        );
        const result = await validateXtreamCredentials({
            serverUrl: 'http://provider.example.com:8080',
            username: 'user',
            password: 'pass',
        });
        expect(result.valid).toBe(true);
        if (result.valid) expect(JSON.stringify(result.serverInfo)).not.toContain('secret');
    });
    it('returns invalid_credentials for expired account', async () => {
        stubFetch(
            vi.fn().mockResolvedValue(
                Response.json({
                    user_info: {
                        status: 'Expired',
                        auth: 1,
                        exp_date: '1000000000',
                        max_connections: '1',
                        active_cons: '0',
                    },
                }),
            ),
        );

        const result = await validateXtreamCredentials({
            serverUrl: 'http://provider.example.com:8080',
            username: 'user',
            password: 'pass',
        });

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.errorType).toBe('invalid_credentials');
            expect(result.reason).toContain('Expired');
        }
    });

    it('returns invalid_credentials for disabled account', async () => {
        stubFetch(
            vi.fn().mockResolvedValue(
                Response.json({
                    user_info: {
                        status: 'Disabled',
                        auth: 1,
                    },
                }),
            ),
        );

        const result = await validateXtreamCredentials({
            serverUrl: 'http://provider.example.com:8080',
            username: 'user',
            password: 'pass',
        });

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.errorType).toBe('invalid_credentials');
            expect(result.reason).toContain('Disabled');
        }
    });

    it('returns invalid_credentials for banned account', async () => {
        stubFetch(
            vi.fn().mockResolvedValue(
                Response.json({
                    user_info: {
                        status: 'Banned',
                        auth: 1,
                    },
                }),
            ),
        );

        const result = await validateXtreamCredentials({
            serverUrl: 'http://provider.example.com:8080',
            username: 'user',
            password: 'pass',
        });

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.errorType).toBe('invalid_credentials');
            expect(result.reason).toContain('Banned');
        }
    });

    it('returns server_unreachable for network errors', async () => {
        stubFetch(vi.fn().mockRejectedValue(new TypeError('fetch failed')));

        const result = await validateXtreamCredentials({
            serverUrl: 'http://provider.example.com:8080',
            username: 'user',
            password: 'pass',
        });

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.errorType).toBe('server_unreachable');
        }
    });

    it('returns timeout for AbortError', async () => {
        const abortError = new DOMException('The operation was aborted', 'AbortError');
        stubFetch(vi.fn().mockRejectedValue(abortError));

        const result = await validateXtreamCredentials({
            serverUrl: 'http://provider.example.com:8080',
            username: 'user',
            password: 'pass',
        });

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.errorType).toBe('timeout');
        }
    });

    it('returns invalid_response for non-JSON body', async () => {
        stubFetch(vi.fn().mockResolvedValue(new Response('not json')));

        const result = await validateXtreamCredentials({
            serverUrl: 'http://provider.example.com:8080',
            username: 'user',
            password: 'pass',
        });

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.errorType).toBe('invalid_response');
        }
    });

    it('returns invalid_response for JSON without user_info', async () => {
        stubFetch(vi.fn().mockResolvedValue(Response.json({ some_other_key: 'value' })));

        const result = await validateXtreamCredentials({
            serverUrl: 'http://provider.example.com:8080',
            username: 'user',
            password: 'pass',
        });

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.errorType).toBe('invalid_response');
        }
    });

    it('returns ssrf_blocked when URL validation fails', async () => {
        const fetchMock = vi.fn();
        stubFetch(fetchMock);

        const result = await validateXtreamCredentials({
            serverUrl: 'http://192.168.1.1:8080',
            username: 'user',
            password: 'pass',
        });

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.errorType).toBe('ssrf_blocked');
            expect(result.reason).toContain('Blocked private IP');
        }

        // fetch should NOT have been called
        expect(fetchMock).not.toHaveBeenCalled();
    });

    /**
     * The 2026-10-06 TechnoBase FM bug class: pinning by putting the resolved IP
     * into the URL plus a `Host` header. fetch() drops a caller-set Host, so a
     * plain-http provider on a name-based virtual host saw `Host: <ip>`. The pin
     * now lives in the transport and the URL keeps its hostname.
     */
    it.each(['http', 'https'])(
        'direct %s: URL keeps its hostname, no Host header, connection pinned to the vetted IP',
        async (scheme) => {
            const fetchMock = vi.fn().mockResolvedValue(activeAccountResponse());
            stubFetch(fetchMock);

            const result = await validateXtreamCredentials({
                serverUrl: `${scheme}://provider.example.com:8080`,
                username: 'user',
                password: 'pass',
            });

            expect(result.valid).toBe(true);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [target, init] = fetchMock.mock.calls[0] as [unknown, Record<string, unknown>];
            const url = new URL(String(target));
            expect(url.host).toBe('provider.example.com:8080');
            expect(url.protocol).toBe(`${scheme}:`);
            expect(new Headers(init.headers as HeadersInit | undefined).get('host')).toBeNull();
            expect(init.redirect).toBe('manual');
            expect(hoisted.agentOpts).toHaveLength(1);
            expect(init.dispatcher).toBeDefined();
            expect(await pinnedAddress(0)).toBe('93.184.216.34');
        },
    );

    it.each(['http', 'https'])(
        'proxied %s: hands the hostname to the proxy dispatcher, no local pin',
        async (scheme) => {
            const sentinel = { mark: 'proxy-agent' };
            dispatcherRef.value = sentinel;
            const fetchMock = vi.fn().mockResolvedValue(activeAccountResponse());
            stubFetch(fetchMock);

            const result = await validateXtreamCredentials({
                serverUrl: `${scheme}://provider.example.com:8080`,
                username: 'user',
                password: 'pass',
            });

            expect(result.valid).toBe(true);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [target, init] = fetchMock.mock.calls[0] as [unknown, Record<string, unknown>];
            expect(new URL(String(target)).host).toBe('provider.example.com:8080');
            expect(init.dispatcher).toBe(sentinel);
            expect(hoisted.agentOpts).toHaveLength(0);
        },
    );

    it('proxied: a hostname that resolves privately is still refused before the proxy is asked', async () => {
        dispatcherRef.value = { mark: 'proxy-agent' };
        hoisted.dns.set('provider.example.com', '10.0.0.5');
        const fetchMock = vi.fn();
        stubFetch(fetchMock);

        const result = await validateXtreamCredentials({
            serverUrl: 'http://provider.example.com:8080',
            username: 'user',
            password: 'pass',
        });

        expect(result.valid).toBe(false);
        if (!result.valid) expect(result.errorType).toBe('ssrf_blocked');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    // Fix #1: Now uses singleton mockLoggerInstance — actually checks the logger the module uses
    it('does not log credentials or full URLs', async () => {
        stubFetch(
            vi.fn().mockResolvedValue(
                Response.json({
                    user_info: {
                        status: 'Active',
                        auth: 1,
                        exp_date: '',
                        max_connections: '1',
                        active_cons: '0',
                    },
                }),
            ),
        );

        await validateXtreamCredentials({
            serverUrl: 'http://provider.example.com:8080',
            username: 'secretuser',
            password: 'secretpass',
        });

        // Check all log calls don't contain credentials
        const allCalls = [
            ...mockLoggerInstance.info.mock.calls,
            ...mockLoggerInstance.warn.mock.calls,
            ...mockLoggerInstance.error.mock.calls,
        ];
        expect(allCalls.length).toBeGreaterThan(0);
        for (const call of allCalls) {
            const serialized = JSON.stringify(call);
            expect(serialized).not.toContain('secretpass');
            expect(serialized).not.toContain('password=');
            expect(serialized).not.toContain('username=');
        }
    });
});

/**
 * Security review 2026-09-12, C6. The Xtream auth URL was SSRF-validated once
 * and then fetched with redirect-following left on, so a provider could bounce
 * the credential probe at an internal address and read the outcome back out of
 * the echoed HTTP status.
 */
describe('validateXtreamCredentials redirect re-validation', () => {
    let validateXtreamCredentials: (creds: XtreamCredentials) => Promise<XtreamValidationResult>;

    const creds: XtreamCredentials = {
        serverUrl: 'http://provider.example.com:8080',
        username: 'user',
        password: 'pass',
    };

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

    function activeAccount() {
        return Response.json({
            user_info: {
                status: 'Active',
                auth: 1,
                exp_date: '',
                max_connections: '1',
                active_cons: '0',
            },
        });
    }

    beforeEach(async () => {
        vi.resetModules();
        resetTransport();
        const mod = await import('./xtream-client.js');
        validateXtreamCredentials = mod.validateXtreamCredentials;
    });

    afterEach(() => {
        resetTransport();
    });

    it('never lets fetch follow a redirect on its own', async () => {
        const fetchMock = vi.fn().mockResolvedValue(activeAccount());
        stubFetch(fetchMock);

        await validateXtreamCredentials(creds);

        expect(fetchMock.mock.calls[0][1].redirect).toBe('manual');
    });

    it('rejects a redirect to a private address without issuing the request', async () => {
        const fetchMock = vi.fn().mockResolvedValue(redirectTo('http://127.0.0.1:6379/'));
        stubFetch(fetchMock);

        const result = await validateXtreamCredentials(creds);

        expect(result.valid).toBe(false);
        if (!result.valid) expect(result.errorType).toBe('ssrf_blocked');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('follows a redirect to another public host', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(redirectTo('http://other.example.net/player_api.php'))
            .mockResolvedValueOnce(activeAccount());
        stubFetch(fetchMock);

        const result = await validateXtreamCredentials(creds);

        expect(result.valid).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        // Hop 2 is re-validated and re-pinned to ITS own resolved address,
        // with the URL still carrying the hostname.
        expect(new URL(String(fetchMock.mock.calls[1][0])).hostname).toBe('other.example.net');
        expect(await pinnedAddress(0)).toBe('93.184.216.34');
        expect(await pinnedAddress(1)).toBe('8.8.8.8');
    });

    it('rejects a sixth redirect hop', async () => {
        let n = 0;
        const fetchMock = vi
            .fn()
            .mockImplementation(async () =>
                redirectTo(`http://provider.example.com:8080/hop${++n}`),
            );
        stubFetch(fetchMock);

        const result = await validateXtreamCredentials(creds);

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.errorType).toBe('invalid_response');
            expect(result.reason).toMatch(/redirect/i);
        }
        expect(fetchMock).toHaveBeenCalledTimes(6);
    });

    it('does not echo the upstream status of a redirected hop', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(redirectTo('http://other.example.net/player_api.php'))
            .mockResolvedValueOnce({ ok: false, status: 500 } as unknown as Response);
        stubFetch(fetchMock);

        const result = await validateXtreamCredentials(creds);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(result.valid).toBe(false);
        if (!result.valid) expect(result.reason).not.toContain('500');
    });

    it('uses one deadline for the whole redirect chain', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(redirectTo('http://other.example.net/player_api.php'))
            .mockResolvedValueOnce(activeAccount());
        stubFetch(fetchMock);

        await validateXtreamCredentials(creds);

        const signal0 = (fetchMock.mock.calls[0][1] as RequestInit).signal;
        expect(signal0).toBeInstanceOf(AbortSignal);
        expect((fetchMock.mock.calls[1][1] as RequestInit).signal).toBe(signal0);
    });

    it('reports a timeout on a redirected hop as a timeout', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(redirectTo('http://other.example.net/player_api.php'))
            .mockRejectedValueOnce(new DOMException('The operation timed out', 'TimeoutError'));
        stubFetch(fetchMock);

        const result = await validateXtreamCredentials(creds);

        expect(result.valid).toBe(false);
        if (!result.valid) expect(result.errorType).toBe('timeout');
    });

    it('reports a body that stalls past the deadline as a timeout, not a bad response', async () => {
        stubFetch(
            vi.fn().mockResolvedValue(
                new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode('{"user_info":'));
                            controller.error(
                                new DOMException('The operation timed out', 'TimeoutError'),
                            );
                        },
                    }),
                ),
            ),
        );

        const result = await validateXtreamCredentials(creds);

        expect(result.valid).toBe(false);
        if (!result.valid) expect(result.errorType).toBe('timeout');
    });

    it('refuses an oversized auth response without reading it all', async () => {
        const cancel = vi.fn();
        const chunk = new Uint8Array(64 * 1024).fill(0x20);
        stubFetch(
            vi.fn().mockResolvedValue(
                new Response(
                    new ReadableStream<Uint8Array>({
                        pull(controller) {
                            controller.enqueue(chunk);
                        },
                        cancel,
                    }),
                ),
            ),
        );

        const result = await validateXtreamCredentials(creds);

        expect(result.valid).toBe(false);
        if (!result.valid) expect(result.errorType).toBe('invalid_response');
        expect(cancel).toHaveBeenCalled();
    });

    it('cancels the body of an error response, freeing the pinned connection', async () => {
        const cancel = vi.fn();
        stubFetch(
            vi
                .fn()
                .mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 500 })),
        );

        const result = await validateXtreamCredentials(creds);

        expect(result.valid).toBe(false);
        expect(cancel).toHaveBeenCalled();
    });

    it('does not echo the connect error of a redirected hop', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(redirectTo('http://other.example.net/player_api.php'))
            .mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:6379'));
        stubFetch(fetchMock);

        const result = await validateXtreamCredentials(creds);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(result.valid).toBe(false);
        if (!result.valid) expect(result.reason).not.toContain('ECONNREFUSED');
    });
});
