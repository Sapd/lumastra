// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for url-safety.ts — SSRF guard.
 *
 * Run with: npx vitest run src/lib/server/tasks/url-safety.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    assertPublicHttpUrl,
    assertWebhookTargetUrl,
    isAllowlistedPrivateHost,
    safeFetch,
    UrlSafetyError,
    orderAddressesIPv4First,
} from './url-safety.js';

import { withExternalRequestCount } from '../utils/external-request-counter.js';

function passes(url: string): void {
    expect(() => assertPublicHttpUrl(url)).not.toThrow();
}

function blocks(url: string): void {
    expect(() => assertPublicHttpUrl(url)).toThrow(UrlSafetyError);
}

describe('assertPublicHttpUrl — scheme gating', () => {
    it('allows http://', () => passes('http://example.com/hook'));
    it('allows https://', () => passes('https://example.com/hook'));
    it('blocks file://', () => blocks('file:///etc/passwd'));
    it('blocks ftp://', () => blocks('ftp://example.com/file'));
    it('blocks javascript:', () => blocks('javascript:alert(1)'));
    it('blocks gopher://', () => blocks('gopher://evil.example'));
    it('blocks data:', () => blocks('data:text/html,<h1>hi</h1>'));
});

describe('assertPublicHttpUrl — RFC1918 / loopback / link-local', () => {
    it('blocks 10.0.0.1', () => blocks('http://10.0.0.1/'));
    it('blocks 10.255.255.255', () => blocks('http://10.255.255.255/'));
    it('blocks 172.16.0.1', () => blocks('http://172.16.0.1/'));
    it('blocks 172.31.255.255', () => blocks('http://172.31.255.255/'));
    it('allows 172.32.0.1 (not in 172.16/12)', () => passes('http://172.32.0.1/'));
    it('blocks 192.168.1.1', () => blocks('http://192.168.1.1/'));
    it('blocks 127.0.0.1', () => blocks('http://127.0.0.1/'));
    it('blocks 127.0.0.2', () => blocks('http://127.0.0.2/'));
    it('blocks 0.0.0.0', () => blocks('http://0.0.0.0/'));
    it('blocks 169.254.0.1 (link-local)', () => blocks('http://169.254.0.1/'));
    it('blocks localhost', () => blocks('http://localhost/'));
    it('blocks localhost.localdomain', () => blocks('http://localhost.localdomain/'));
    it('blocks *.local mDNS', () => blocks('http://myhost.local/'));
});

describe('assertPublicHttpUrl — CGNAT / Tailscale 100.64/10', () => {
    it('blocks 100.64.0.1', () => blocks('http://100.64.0.1/'));
    it('blocks 100.100.0.1', () => blocks('http://100.100.0.1/'));
    it('blocks 100.127.0.1', () => blocks('http://100.127.0.1/'));
    it('allows 100.128.0.1 (outside CGNAT range)', () => passes('http://100.128.0.1/'));
    it('allows 100.63.0.1 (outside CGNAT range)', () => passes('http://100.63.0.1/'));
});

describe('assertPublicHttpUrl — benchmarking 198.18/15', () => {
    it('blocks 198.18.0.1', () => blocks('http://198.18.0.1/'));
    it('blocks 198.19.255.1', () => blocks('http://198.19.255.1/'));
    it('allows 198.20.0.1 (outside range)', () => passes('http://198.20.0.1/'));
    it('allows 198.17.0.1 (outside range)', () => passes('http://198.17.0.1/'));
});

describe('assertPublicHttpUrl — reserved 240/4', () => {
    it('blocks 240.0.0.1', () => blocks('http://240.0.0.1/'));
    it('blocks 255.255.255.255', () => blocks('http://255.255.255.255/'));
    it('allows 239.255.255.255 (multicast boundary, not reserved)', () =>
        // 239.x is still multicast so it must also be blocked
        blocks('http://239.255.255.255/'));
});

describe('assertPublicHttpUrl — IETF protocol assignments 192.0.0/24', () => {
    it('blocks 192.0.0.1', () => blocks('http://192.0.0.1/'));
    it('blocks 192.0.0.255', () => blocks('http://192.0.0.255/'));
    it('allows 192.0.1.1 (outside range)', () => passes('http://192.0.1.1/'));
});

describe('assertPublicHttpUrl — TEST-NET-1/2/3', () => {
    it('blocks 192.0.2.1 (TEST-NET-1)', () => blocks('http://192.0.2.1/'));
    it('blocks 192.0.2.255', () => blocks('http://192.0.2.255/'));
    it('blocks 198.51.100.1 (TEST-NET-2)', () => blocks('http://198.51.100.1/'));
    it('blocks 198.51.100.255', () => blocks('http://198.51.100.255/'));
    it('blocks 203.0.113.1 (TEST-NET-3)', () => blocks('http://203.0.113.1/'));
    it('blocks 203.0.113.255', () => blocks('http://203.0.113.255/'));
    it('allows 203.0.114.1 (outside range)', () => passes('http://203.0.114.1/'));
});

describe('assertPublicHttpUrl — multicast 224/4', () => {
    it('blocks 224.0.0.1', () => blocks('http://224.0.0.1/'));
    it('blocks 239.0.0.1', () => blocks('http://239.0.0.1/'));
    it('allows 223.255.255.255 (below multicast)', () => passes('http://223.255.255.255/'));
});

describe('assertPublicHttpUrl — IPv6', () => {
    it('blocks ::1 (loopback)', () => blocks('http://[::1]/'));
    it('blocks fc00:: (ULA)', () => blocks('http://[fc00::1]/'));
    it('blocks fd00:: (ULA)', () => blocks('http://[fd00::1]/'));
    it('blocks fe80:: (link-local)', () => blocks('http://[fe80::1]/'));
    it('blocks ::ffff:10.0.0.1 (IPv4-mapped private)', () => blocks('http://[::ffff:10.0.0.1]/'));
    it('blocks ::ffff:0a00:0001 (IPv4-mapped hex private)', () =>
        blocks('http://[::ffff:0a00:1]/'));
    it('allows public IPv6', () => passes('http://[2001:db8::1]/'));
});

describe('assertPublicHttpUrl — IPv4-compatible IPv6 (deprecated ::/96 form)', () => {
    // Node's URL parser normalizes the deprecated IPv4-compatible form
    // (`::a.b.c.d`) to hex-compressed groups — `::127.0.0.1` becomes
    // `::7f00:1`. Unlike IPv4-MAPPED (`::ffff:a.b.c.d`), there's no `ffff`
    // marker group; the low 32 bits sit directly after `::`.
    it('blocks ::7f00:1 (hex-compressed compat form of 127.0.0.1)', () =>
        blocks('http://[::7f00:1]/'));
    it('blocks ::127.0.0.1 (dotted-quad input — Node normalizes to ::7f00:1)', () =>
        blocks('http://[::127.0.0.1]/'));
    it('blocks ::a00:1 (hex-compressed compat form of 10.0.0.1)', () =>
        blocks('http://[::a00:1]/'));
    it('blocks ::ffff:ffff (hex-compressed compat form of 255.255.255.255, reserved)', () =>
        blocks('http://[::ffff:ffff]/'));
    it('allows ::808:808 (hex-compressed compat form of 8.8.8.8, public)', () =>
        passes('http://[::808:808]/'));
});

describe('assertPublicHttpUrl — public addresses', () => {
    it('allows 8.8.8.8', () => passes('http://8.8.8.8/'));
    it('allows 1.1.1.1', () => passes('http://1.1.1.1/'));
    it('allows example.com', () => passes('https://example.com/path?q=1'));
    it('returns the parsed URL on success', () => {
        const url = assertPublicHttpUrl('https://example.com/path');
        expect(url).toBeInstanceOf(URL);
        expect(url.hostname).toBe('example.com');
    });
});

// ── safeFetch (DNS-rebinding + redirect-pivot defense) ──────────────────────
//
// safeFetch is the only production path that closes the DNS-rebinding hole
// (assertPublicHttpUrl is syntactic only). These tests pin its behavior:
//   1. a hostname resolving to a private address is rejected (rebind blocked),
//   2. the resolved address is pinned into the undici dispatcher (no second
//      attacker-controlled lookup between check and connect),
//   3. redirects are re-validated at every hop — a 3xx to a private host /
//      literal is rejected even though the first hop was public.
//
// node:dns is mocked because safeFetch resolves real hostnames; undici is
// mocked so the pinned-address branch never opens a socket.

const dnsLookupMock = vi.fn();
vi.mock('node:dns', () => ({
    promises: {
        lookup: (...args: unknown[]) => dnsLookupMock(...args),
    },
}));

const undiciFetchMock = vi.fn();
const AgentMock = vi.fn();
vi.mock('undici', () => ({
    Agent: class {
        constructor(opts: unknown) {
            AgentMock(opts);
        }
        // Real undici Agent exposes close(): Promise<void>; safeFetch closes the
        // agent of a failed fallback attempt to avoid leaking connection pools.
        close(): Promise<void> {
            return Promise.resolve();
        }
    },
    fetch: (...args: unknown[]) => undiciFetchMock(...args),
}));

function mkResponse(status: number, location?: string): Response {
    const headers = new Headers();
    if (location) headers.set('location', location);
    return new Response(null, { status, headers });
}

describe('safeFetch — DNS-rebinding defense', () => {
    const realFetch = globalThis.fetch;

    beforeEach(() => {
        dnsLookupMock.mockReset();
        undiciFetchMock.mockReset();
        AgentMock.mockReset();
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    it('rejects when a hostname resolves to a private IPv4 (rebind blocked)', async () => {
        dnsLookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
        await expect(safeFetch('http://rebind.example/')).rejects.toThrow(UrlSafetyError);
        // No socket should ever be opened.
        expect(undiciFetchMock).not.toHaveBeenCalled();
    });

    it('rejects when a hostname resolves to a private IPv6 (rebind blocked)', async () => {
        dnsLookupMock.mockResolvedValue([{ address: 'fd00::1', family: 6 }]);
        await expect(safeFetch('http://rebind6.example/')).rejects.toThrow(UrlSafetyError);
        expect(undiciFetchMock).not.toHaveBeenCalled();
    });

    it('rejects when ANY of several DNS answers is private (multi-answer bypass)', async () => {
        dnsLookupMock.mockResolvedValue([
            { address: '93.184.216.34', family: 4 },
            { address: '127.0.0.1', family: 4 },
        ]);
        await expect(safeFetch('http://mixed.example/')).rejects.toThrow(UrlSafetyError);
        expect(undiciFetchMock).not.toHaveBeenCalled();
    });

    it('pins the resolved public address into the undici dispatcher', async () => {
        dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        undiciFetchMock.mockResolvedValue(mkResponse(200));
        const res = await safeFetch('http://good.example/path');
        expect(res.status).toBe(200);
        expect(undiciFetchMock).toHaveBeenCalledTimes(1);
        // A custom Agent (dispatcher) must be supplied to pin the connection.
        const [, init] = undiciFetchMock.mock.calls[0] as [string, { dispatcher?: unknown }];
        expect(init.dispatcher).toBeDefined();
        expect(AgentMock).toHaveBeenCalledTimes(1);
        // The Agent must pin to the validated address via a custom lookup.
        const agentOpts = AgentMock.mock.calls[0][0] as {
            connect?: { lookup?: unknown };
        };
        expect(typeof agentOpts.connect?.lookup).toBe('function');
    });

    // Returns the addresses the Nth-constructed Agent pins to, by invoking its
    // custom lookup. undici@7 requires the callback to receive an ARRAY of
    // {address, family} (the scalar form throws ERR_INVALID_IP_ADDRESS at connect),
    // so the helper asserts + reads that shape — pinning the contract that broke.
    // The lookup answers asynchronously (see pinned-lookup.ts), so this is a Promise.
    async function pinnedAddresses(
        callIndex: number,
    ): Promise<Array<{ address: string; family: number }>> {
        const opts = AgentMock.mock.calls[callIndex][0] as {
            connect: {
                lookup: (
                    h: string,
                    o: unknown,
                    cb: (e: null, addrs: Array<{ address: string; family: number }>) => void,
                ) => void;
            };
        };
        const captured = await new Promise<Array<{ address: string; family: number }>>(
            (resolve) => {
                opts.connect.lookup('host', { all: true }, (_e, addrs) => resolve(addrs));
            },
        );
        expect(Array.isArray(captured)).toBe(true);
        return captured;
    }
    const pinnedAddress = async (callIndex: number): Promise<string> =>
        (await pinnedAddresses(callIndex))[0]?.address ?? '';

    it('prefers IPv4 even when an IPv6 answer comes first (broken-v6 hosts)', async () => {
        // Resolver returns the AAAA record first; a broken IPv6 egress would
        // make pinning to it fail. We must pin IPv4 instead.
        dnsLookupMock.mockResolvedValue([
            { address: '2001:4860:4860::8888', family: 6 },
            { address: '93.184.216.34', family: 4 },
        ]);
        undiciFetchMock.mockResolvedValue(mkResponse(200));
        const res = await safeFetch('http://dual.example/');
        expect(res.status).toBe(200);
        expect(undiciFetchMock).toHaveBeenCalledTimes(1);
        expect(await pinnedAddress(0)).toBe('93.184.216.34');
    });

    it('falls back to the next validated address on a connection failure', async () => {
        dnsLookupMock.mockResolvedValue([
            { address: '93.184.216.34', family: 4 },
            { address: '93.184.216.35', family: 4 },
        ]);
        undiciFetchMock
            .mockRejectedValueOnce(new TypeError('fetch failed'))
            .mockResolvedValueOnce(mkResponse(200));
        const res = await safeFetch('http://cdn.example/');
        expect(res.status).toBe(200);
        expect(undiciFetchMock).toHaveBeenCalledTimes(2);
        expect(await pinnedAddress(0)).toBe('93.184.216.34');
        expect(await pinnedAddress(1)).toBe('93.184.216.35');
    });

    it('throws after exhausting every validated address', async () => {
        dnsLookupMock.mockResolvedValue([
            { address: '93.184.216.34', family: 4 },
            { address: '93.184.216.35', family: 4 },
        ]);
        undiciFetchMock.mockRejectedValue(new TypeError('fetch failed'));
        await expect(safeFetch('http://down.example/')).rejects.toThrow(UrlSafetyError);
        expect(undiciFetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not burn remaining addresses once the caller aborts', async () => {
        dnsLookupMock.mockResolvedValue([
            { address: '93.184.216.34', family: 4 },
            { address: '93.184.216.35', family: 4 },
        ]);
        const ac = new AbortController();
        ac.abort();
        undiciFetchMock.mockRejectedValue(
            Object.assign(new Error('aborted'), { name: 'AbortError' }),
        );
        await expect(safeFetch('http://slow.example/', { signal: ac.signal })).rejects.toThrow();
        // Only the first address is attempted — the abort short-circuits the rest.
        expect(undiciFetchMock).toHaveBeenCalledTimes(1);
    });

    it('rejects non-http(s) URLs before any lookup', async () => {
        await expect(safeFetch('file:///etc/passwd')).rejects.toThrow(UrlSafetyError);
        expect(dnsLookupMock).not.toHaveBeenCalled();
    });

    it('rejects a syntactically private literal without a DNS lookup', async () => {
        await expect(safeFetch('http://127.0.0.1/')).rejects.toThrow(UrlSafetyError);
        expect(dnsLookupMock).not.toHaveBeenCalled();
    });
});

describe('safeFetch — redirect re-validation', () => {
    const realFetch = globalThis.fetch;

    beforeEach(() => {
        dnsLookupMock.mockReset();
        undiciFetchMock.mockReset();
        AgentMock.mockReset();
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    it('blocks a redirect to a private IP literal (pivot blocked)', async () => {
        // First hop is a public IP literal → global fetch (no DNS, no undici).
        const globalFetchMock = vi.fn().mockResolvedValue(mkResponse(302, 'http://10.0.0.1/'));
        globalThis.fetch = globalFetchMock as unknown as typeof fetch;
        await expect(safeFetch('http://93.184.216.34/')).rejects.toThrow(UrlSafetyError);
        // The first hop was issued, the redirect target rejected before a 2nd.
        expect(globalFetchMock).toHaveBeenCalledTimes(1);
    });

    it('blocks a redirect to a hostname that resolves private (rebind on hop 2)', async () => {
        const globalFetchMock = vi
            .fn()
            .mockResolvedValue(mkResponse(302, 'http://rebind.example/'));
        globalThis.fetch = globalFetchMock as unknown as typeof fetch;
        dnsLookupMock.mockResolvedValue([{ address: '192.168.1.1', family: 4 }]);
        await expect(safeFetch('http://93.184.216.34/')).rejects.toThrow(UrlSafetyError);
    });

    it('follows a redirect to another public host and returns the final response', async () => {
        const globalFetchMock = vi
            .fn()
            .mockResolvedValueOnce(mkResponse(302, 'http://1.1.1.1/final'))
            .mockResolvedValueOnce(mkResponse(204));
        globalThis.fetch = globalFetchMock as unknown as typeof fetch;
        const res = await safeFetch('http://8.8.8.8/');
        expect(res.status).toBe(204);
        expect(globalFetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws when the redirect limit is exceeded', async () => {
        const globalFetchMock = vi.fn().mockResolvedValue(mkResponse(302, 'http://8.8.8.8/loop'));
        globalThis.fetch = globalFetchMock as unknown as typeof fetch;
        await expect(safeFetch('http://8.8.8.8/', {}, { maxRedirects: 2 })).rejects.toThrow(
            /redirect limit/,
        );
    });
});

describe('safeFetch — opts.validateHop (per-plugin allowlist / origin pinning)', () => {
    const realFetch = globalThis.fetch;

    beforeEach(() => {
        dnsLookupMock.mockReset();
        undiciFetchMock.mockReset();
        AgentMock.mockReset();
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    it('invokes validateHop on the FIRST hop, not just redirects', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(mkResponse(200)) as unknown as typeof fetch;
        const validateHop = vi.fn();
        await safeFetch('http://8.8.8.8/', {}, { validateHop });
        expect(validateHop).toHaveBeenCalledTimes(1);
        expect((validateHop.mock.calls[0][0] as URL).hostname).toBe('8.8.8.8');
    });

    // IP literals throughout (rather than hostnames) so these tests exercise
    // the global-fetch branch directly and never depend on the DNS-lookup
    // mock being pre-armed by an unrelated test in this describe block
    // (assertResolvedAddrsArePublic skips DNS entirely for IP literals).

    it('rejects a same-host request when validateHop throws (allowlist boundary)', async () => {
        globalThis.fetch = vi.fn() as unknown as typeof fetch;
        const validateHop = vi.fn(() => {
            throw new Error("domain '93.184.216.34' is not in the declared allowedDomains list");
        });
        await expect(safeFetch('http://93.184.216.34/', {}, { validateHop })).rejects.toThrow(
            /not in the declared allowedDomains/,
        );
    });

    it('re-runs validateHop on a redirect hop and blocks a pivot to a disallowed host', async () => {
        // Hop 0 (93.184.216.34, allowlisted) redirects to 1.2.3.4 (public,
        // but NOT allowlisted) — the exact SSRF-adjacent "allowlisted host
        // 3xx's you elsewhere" scenario this option exists to close.
        const globalFetchMock = vi.fn().mockResolvedValue(mkResponse(302, 'http://1.2.3.4/'));
        globalThis.fetch = globalFetchMock as unknown as typeof fetch;
        const allowedHosts = new Set(['93.184.216.34']);
        const validateHop = vi.fn((url: URL) => {
            if (!allowedHosts.has(url.hostname)) {
                throw new Error(
                    `domain '${url.hostname}' is not in the declared allowedDomains list`,
                );
            }
        });
        await expect(safeFetch('http://93.184.216.34/', {}, { validateHop })).rejects.toThrow(
            /1\.2\.3\.4/,
        );
        // Hop 0 (93.184.216.34) passed; hop 1 (1.2.3.4) failed validation —
        // no second network call was ever attempted.
        expect(validateHop).toHaveBeenCalledTimes(2);
        expect(globalFetchMock).toHaveBeenCalledTimes(1);
    });

    it('allows a redirect that stays within validateHop-approved hosts', async () => {
        const globalFetchMock = vi
            .fn()
            .mockResolvedValueOnce(mkResponse(302, 'http://93.184.216.34/other-path'))
            .mockResolvedValueOnce(mkResponse(200));
        globalThis.fetch = globalFetchMock as unknown as typeof fetch;
        const validateHop = vi.fn((url: URL) => {
            if (url.hostname !== '93.184.216.34') {
                throw new Error(`domain '${url.hostname}' not allowed`);
            }
        });
        const res = await safeFetch('http://93.184.216.34/', {}, { validateHop });
        expect(res.status).toBe(200);
        expect(validateHop).toHaveBeenCalledTimes(2);
    });

    it('enforces same-origin redirect policy via validateHop (webhook-style)', async () => {
        // Mirrors webhook-outbox's redirect policy: reject any hop whose
        // origin differs from the originally registered URL's origin.
        const registeredOrigin = new URL('https://93.184.216.34/webhook').origin;
        const globalFetchMock = vi
            .fn()
            .mockResolvedValue(mkResponse(307, 'https://1.2.3.4/webhook'));
        globalThis.fetch = globalFetchMock as unknown as typeof fetch;
        const validateHop = vi.fn((url: URL) => {
            if (url.origin !== registeredOrigin) {
                throw new Error(`cross-origin redirect to ${url.origin} rejected`);
            }
        });
        await expect(
            safeFetch('https://93.184.216.34/webhook', { method: 'POST' }, { validateHop }),
        ).rejects.toThrow(/cross-origin/);
    });

    it('same-origin policy allows a path-only redirect on the same host', async () => {
        const registeredOrigin = new URL('https://93.184.216.34/webhook').origin;
        const globalFetchMock = vi
            .fn()
            .mockResolvedValueOnce(mkResponse(307, 'https://93.184.216.34/webhook/v2'))
            .mockResolvedValueOnce(mkResponse(200));
        globalThis.fetch = globalFetchMock as unknown as typeof fetch;
        const validateHop = vi.fn((url: URL) => {
            if (url.origin !== registeredOrigin) {
                throw new Error(`cross-origin redirect to ${url.origin} rejected`);
            }
        });
        const res = await safeFetch(
            'https://93.184.216.34/webhook',
            { method: 'POST' },
            { validateHop },
        );
        expect(res.status).toBe(200);
        expect(globalFetchMock).toHaveBeenCalledTimes(2);
    });
});

describe('isAllowlistedPrivateHost', () => {
    const list = ['mediabot-notify.arr.svc.cluster.local', '.lan', '10.0.0.7', '[fd00::1]'];

    it('matches an exact hostname, case-insensitively', () => {
        expect(isAllowlistedPrivateHost('MediaBot-Notify.arr.svc.cluster.local', list)).toBe(true);
    });
    it('matches a leading-dot suffix but not the bare suffix', () => {
        expect(isAllowlistedPrivateHost('ha.lan', list)).toBe(true);
        expect(isAllowlistedPrivateHost('lan', list)).toBe(false);
    });
    it('does not treat an exact entry as a suffix', () => {
        expect(isAllowlistedPrivateHost('evil.mediabot-notify.arr.svc.cluster.local', list)).toBe(
            false,
        );
    });
    it('matches IPv4 and bracketed IPv6 literals', () => {
        expect(isAllowlistedPrivateHost('10.0.0.7', list)).toBe(true);
        expect(isAllowlistedPrivateHost('10.0.0.8', list)).toBe(false);
        expect(isAllowlistedPrivateHost('[fd00::1]', list)).toBe(true);
    });
    it('an empty list or a lone dot matches nothing', () => {
        expect(isAllowlistedPrivateHost('anything.lan', [])).toBe(false);
        expect(isAllowlistedPrivateHost('anything.lan', ['.', ' '])).toBe(false);
    });
});

describe('assertWebhookTargetUrl', () => {
    const list = ['bot.arr.svc.cluster.local'];

    it('accepts an allowlisted private host', () => {
        expect(assertWebhookTargetUrl('http://bot.arr.svc.cluster.local:8080/x', list).host).toBe(
            'bot.arr.svc.cluster.local:8080',
        );
    });
    it('still rejects a non-allowlisted private host', () => {
        expect(() => assertWebhookTargetUrl('http://localhost/x', list)).toThrow(UrlSafetyError);
        expect(() => assertWebhookTargetUrl('http://10.0.0.1/x', list)).toThrow(UrlSafetyError);
    });
    it('keeps scheme and userinfo rules for an allowlisted host', () => {
        expect(() => assertWebhookTargetUrl('ftp://bot.arr.svc.cluster.local/', list)).toThrow(
            UrlSafetyError,
        );
        expect(() => assertWebhookTargetUrl('http://u:p@bot.arr.svc.cluster.local/', list)).toThrow(
            UrlSafetyError,
        );
    });
    it('rejects an unparseable URL with UrlSafetyError', () => {
        expect(() => assertWebhookTargetUrl('not a url', list)).toThrow(UrlSafetyError);
    });
});

describe('safeFetch — opts.allowPrivateHosts', () => {
    const realFetch = globalThis.fetch;

    beforeEach(() => {
        dnsLookupMock.mockReset();
        undiciFetchMock.mockReset();
        AgentMock.mockReset();
    });

    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    it('delivers to an allowlisted private host without resolving or pinning it', async () => {
        const globalFetchMock = vi.fn().mockResolvedValue(mkResponse(204));
        globalThis.fetch = globalFetchMock as unknown as typeof fetch;
        const res = await safeFetch(
            'http://bot.arr.svc.cluster.local/hook',
            { method: 'POST' },
            { allowPrivateHosts: ['.svc.cluster.local'] },
        );
        expect(res.status).toBe(204);
        expect(dnsLookupMock).not.toHaveBeenCalled();
        expect(undiciFetchMock).not.toHaveBeenCalled();
    });

    it('without the option the same private host is rejected by DNS resolution', async () => {
        dnsLookupMock.mockResolvedValue([{ address: '10.43.0.12', family: 4 }]);
        await expect(safeFetch('http://bot.arr.svc.cluster.local/hook')).rejects.toThrow(
            UrlSafetyError,
        );
    });

    it('a redirect from an allowlisted host to another private host is still blocked', async () => {
        const globalFetchMock = vi.fn().mockResolvedValue(mkResponse(302, 'http://10.0.0.1/'));
        globalThis.fetch = globalFetchMock as unknown as typeof fetch;
        await expect(
            safeFetch(
                'http://bot.arr.svc.cluster.local/hook',
                {},
                { allowPrivateHosts: ['bot.arr.svc.cluster.local'] },
            ),
        ).rejects.toThrow(UrlSafetyError);
        expect(globalFetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('orderAddressesIPv4First', () => {
    it('moves IPv4 ahead of IPv6 regardless of resolver order', () => {
        const ordered = orderAddressesIPv4First([
            { address: '2606:50c0::1', family: 6 },
            { address: '1.1.1.1', family: 4 },
            { address: '2606:50c0::2', family: 6 },
            { address: '8.8.8.8', family: 4 },
        ]);
        expect(ordered.map((a) => a.family)).toEqual([4, 4, 6, 6]);
    });

    it('preserves round-robin order within each family (stable sort)', () => {
        const ordered = orderAddressesIPv4First([
            { address: '1.1.1.1', family: 4 },
            { address: '2.2.2.2', family: 4 },
            { address: '3.3.3.3', family: 4 },
        ]);
        expect(ordered.map((a) => a.address)).toEqual(['1.1.1.1', '2.2.2.2', '3.3.3.3']);
    });

    it('leaves an IPv6-only list intact', () => {
        const ordered = orderAddressesIPv4First([{ address: '2606:50c0::1', family: 6 }]);
        expect(ordered).toEqual([{ address: '2606:50c0::1', family: 6 }]);
    });

    it('does not mutate the input array', () => {
        const input = [
            { address: '2606:50c0::1', family: 6 },
            { address: '1.1.1.1', family: 4 },
        ];
        orderAddressesIPv4First(input);
        expect(input[0].family).toBe(6);
    });
});

describe('webhook validation guidance and redaction', () => {
    it.each(['https://user:secret@[bad/?key=token', 'not a url?key=token'])(
        'never echoes invalid input',
        (input) => {
            for (const validate of [
                assertPublicHttpUrl,
                (url: string) => assertWebhookTargetUrl(url, []),
            ]) {
                try {
                    validate(input);
                    throw new Error('accepted');
                } catch (error) {
                    expect(error).toBeInstanceOf(UrlSafetyError);
                    expect(String(error)).not.toMatch(/secret|token|user:/);
                }
            }
        },
    );
    it.each([
        'http://localhost/hook',
        'http://host.local/hook',
        'http://10.0.0.2/hook',
        'http://[::1]/hook',
    ])('explains the operator allowlist for %s', (input) => {
        expect(() => assertWebhookTargetUrl(input, [])).toThrow(
            /WEBHOOK_PRIVATE_HOST_ALLOWLIST.*environment/,
        );
        expect(() => assertWebhookTargetUrl(input, [new URL(input).hostname])).not.toThrow();
        expect(() => assertPublicHttpUrl(input)).toThrow(UrlSafetyError);
    });
});

describe('safeFetch counts requests sent', () => {
    beforeEach(() => {
        dnsLookupMock.mockReset();
        undiciFetchMock.mockReset();
        dnsLookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    });

    it('counts each redirect at its destination host', async () => {
        undiciFetchMock
            .mockResolvedValueOnce(mkResponse(302, 'https://image.tmdb.org/b'))
            .mockResolvedValueOnce(mkResponse(404));
        const counts = await withExternalRequestCount(() =>
            safeFetch('https://api.themoviedb.org/a'),
        );
        expect(counts.total).toBe(2);
        expect(counts.byHost.get('api.themoviedb.org')).toBe(1);
        expect(counts.byHost.get('image.tmdb.org')).toBe(1);
        expect(counts.errorsByHost.size).toBe(0);
    });

    it('counts every address attempt, including failed fallbacks', async () => {
        dnsLookupMock.mockResolvedValue([
            { address: '93.184.216.34', family: 4 },
            { address: '93.184.216.35', family: 4 },
        ]);
        undiciFetchMock
            .mockRejectedValueOnce(new Error('connect failed'))
            .mockResolvedValueOnce(mkResponse(200));
        const counts = await withExternalRequestCount(() => safeFetch('https://lrclib.net/a'));
        expect(counts.total).toBe(2);
        expect(counts.errorsByHost.get('lrclib.net')).toBe(1);
    });

    it('counts a redirect rejected by validateHop as one error on the sending host', async () => {
        undiciFetchMock.mockResolvedValueOnce(mkResponse(302, 'https://evil.example/b'));
        const counts = await withExternalRequestCount(async () => {
            await expect(
                safeFetch(
                    'https://lrclib.net/a',
                    {},
                    {
                        validateHop(url) {
                            if (url.hostname !== 'lrclib.net') throw new Error('redirect rejected');
                        },
                    },
                ),
            ).rejects.toThrow('redirect rejected');
        });
        expect(undiciFetchMock).toHaveBeenCalledTimes(1);
        expect(counts.total).toBe(1);
        expect(counts.errorsByHost.get('lrclib.net')).toBe(1);
        expect(counts.byHost.has('evil.example')).toBe(false);
    });
});

it.each(['http://[64:ff9b::a9fe:a9fe]/', 'http://[2002:7f00:1::]/', 'http://192.0.0.192/'])(
    'D-L1: rejects translated/private target %s',
    (url) => {
        expect(() => assertPublicHttpUrl(url)).toThrow(/private|loopback/);
    },
);

it.each(['http://[64:ff9b::808:808]/', 'http://[2002:808:808::]/'])(
    'D-L1: keeps a translated public destination %s usable',
    (url) => {
        expect(() => assertPublicHttpUrl(url)).not.toThrow();
    },
);
