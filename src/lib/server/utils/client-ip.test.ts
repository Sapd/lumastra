// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for client IP extraction.
//
// The matcher is built at module load from process.env.TRUSTED_PROXY_IPS,
// so tests use vi.resetModules() + dynamic import to inject different env
// values per case. Each test re-imports the module so the env value is
// what's in effect for that run.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

interface EventOpts {
    peer?: string;
    peerThrows?: boolean;
    xff?: string;
    xRealIp?: string;
}

function makeEvent(opts: EventOpts): RequestEvent {
    const headers = new Headers();
    if (opts.xff) headers.set('x-forwarded-for', opts.xff);
    if (opts.xRealIp) headers.set('x-real-ip', opts.xRealIp);
    const getClientAddress = opts.peerThrows
        ? (): string => {
              throw new Error('no peer');
          }
        : (): string => opts.peer ?? '0.0.0.0';
    return {
        request: { headers } as Request,
        getClientAddress,
    } as unknown as RequestEvent;
}

async function importClientIp(
    envValue: string | undefined,
    trustAny?: string | undefined,
    clientIpProxies?: string | undefined,
) {
    if (clientIpProxies === undefined) {
        delete process.env.CLIENT_IP_PROXY_IPS;
    } else {
        process.env.CLIENT_IP_PROXY_IPS = clientIpProxies;
    }
    if (envValue === undefined) {
        delete process.env.TRUSTED_PROXY_IPS;
    } else {
        process.env.TRUSTED_PROXY_IPS = envValue;
    }
    if (trustAny === undefined) {
        delete process.env.LUMASTRA_TRUST_ANY_PROXY;
    } else {
        process.env.LUMASTRA_TRUST_ANY_PROXY = trustAny;
    }
    vi.resetModules();
    return import('./client-ip');
}

describe('client-ip', () => {
    let savedEnv: string | undefined;
    let savedTrustAny: string | undefined;
    let savedClientIpProxies: string | undefined;

    beforeEach(() => {
        savedClientIpProxies = process.env.CLIENT_IP_PROXY_IPS;
        savedEnv = process.env.TRUSTED_PROXY_IPS;
        savedTrustAny = process.env.LUMASTRA_TRUST_ANY_PROXY;
    });
    afterEach(() => {
        if (savedClientIpProxies === undefined) delete process.env.CLIENT_IP_PROXY_IPS;
        else process.env.CLIENT_IP_PROXY_IPS = savedClientIpProxies;
        if (savedEnv === undefined) delete process.env.TRUSTED_PROXY_IPS;
        else process.env.TRUSTED_PROXY_IPS = savedEnv;
        if (savedTrustAny === undefined) delete process.env.LUMASTRA_TRUST_ANY_PROXY;
        else process.env.LUMASTRA_TRUST_ANY_PROXY = savedTrustAny;
    });

    // F32: When TRUSTED_PROXY_IPS is unset, Lumastra is assumed to run behind a
    // reverse proxy, so the immediate TCP peer is implicitly trusted and
    // X-Forwarded-For / X-Real-IP is honored. This keeps IP-bound features
    // (stream-token binding, rate limits) effective by default instead of
    // collapsing every client to the proxy's single IP. Identity trust (F1)
    // does NOT inherit this implicit trust — see isPeerExplicitlyTrustedProxy.
    describe('default (no TRUSTED_PROXY_IPS configured → implicit proxy trust)', () => {
        it('honors XFF from the immediate peer (implicit proxy trust)', async () => {
            const { getClientIp } = await importClientIp(undefined);
            const ip = getClientIp(makeEvent({ peer: '10.0.0.5', xff: '1.2.3.4' }));
            expect(ip).toBe('1.2.3.4');
        });

        it('returns the TCP peer when no forwarded headers are present', async () => {
            const { getClientIp } = await importClientIp(undefined);
            expect(getClientIp(makeEvent({ peer: '10.0.0.5' }))).toBe('10.0.0.5');
        });

        it('honors X-Real-IP from the immediate peer (implicit proxy trust)', async () => {
            const { getClientIp } = await importClientIp(undefined);
            const ip = getClientIp(makeEvent({ peer: '10.0.0.5', xRealIp: '1.2.3.4' }));
            expect(ip).toBe('1.2.3.4');
        });

        it('falls back to 0.0.0.0 when getClientAddress throws', async () => {
            const { getClientIp } = await importClientIp(undefined);
            expect(getClientIp(makeEvent({ peerThrows: true }))).toBe('0.0.0.0');
        });

        it('treats empty TRUSTED_PROXY_IPS as implicit proxy trust (honors XFF)', async () => {
            const { getClientIp } = await importClientIp('');
            const ip = getClientIp(makeEvent({ peer: '10.0.0.5', xff: '1.2.3.4' }));
            expect(ip).toBe('1.2.3.4');
        });
    });

    // isForwardAuthPeerTrusted gates identity-header trust (F1). It fail-CLOSES
    // against peers outside an explicit allowlist AND, when no allowlist is set,
    // fail-CLOSES by default (rejecting forged identity headers) unless the
    // operator opts in via LUMASTRA_TRUST_ANY_PROXY=true. (This is stricter than
    // the low-stakes client-IP path, which keeps implicit trust — see above.)
    describe('isForwardAuthPeerTrusted (identity-header trust gate)', () => {
        it('fail-closes (false) for any peer when TRUSTED_PROXY_IPS is unset and no opt-in', async () => {
            const { isForwardAuthPeerTrusted } = await importClientIp(undefined);
            expect(isForwardAuthPeerTrusted('10.0.0.5')).toBe(false);
            expect(isForwardAuthPeerTrusted('203.0.113.9')).toBe(false);
        });

        it('fail-closes (false) when TRUSTED_PROXY_IPS is empty string and no opt-in', async () => {
            const { isForwardAuthPeerTrusted } = await importClientIp('');
            expect(isForwardAuthPeerTrusted('10.0.0.5')).toBe(false);
        });

        it('trusts any peer when LUMASTRA_TRUST_ANY_PROXY=true and no allowlist (single-host opt-in)', async () => {
            const { isForwardAuthPeerTrusted, forwardAuthTrustPosture } = await importClientIp(
                undefined,
                'true',
            );
            expect(isForwardAuthPeerTrusted('203.0.113.9')).toBe(true);
            expect(forwardAuthTrustPosture()).toBe('trust-any');
        });

        it('reports fail-closed / allowlist posture correctly', async () => {
            const failClosed = await importClientIp(undefined);
            expect(failClosed.forwardAuthTrustPosture()).toBe('fail-closed');
            const allowlist = await importClientIp('10.0.0.5');
            expect(allowlist.forwardAuthTrustPosture()).toBe('allowlist');
        });

        it('rejects an unavailable peer even under the trust-any opt-in', async () => {
            const { isForwardAuthPeerTrusted } = await importClientIp(undefined, 'true');
            expect(isForwardAuthPeerTrusted('')).toBe(false);
        });

        it('trusts only listed peers and rejects others once an allowlist is set', async () => {
            const { isForwardAuthPeerTrusted } = await importClientIp('10.0.0.5');
            expect(isForwardAuthPeerTrusted('10.0.0.5')).toBe(true);
            // Attacker who reached the app directly from another IP: rejected.
            expect(isForwardAuthPeerTrusted('203.0.113.9')).toBe(false);
            expect(isForwardAuthPeerTrusted('10.0.0.6')).toBe(false);
        });

        it('matches an explicitly listed CIDR range', async () => {
            const { isForwardAuthPeerTrusted } = await importClientIp('10.0.0.0/24');
            expect(isForwardAuthPeerTrusted('10.0.0.42')).toBe(true);
            expect(isForwardAuthPeerTrusted('10.0.1.1')).toBe(false);
        });

        it('matches IPv6-mapped IPv4 peers against the allowlist', async () => {
            const { isForwardAuthPeerTrusted } = await importClientIp('10.0.0.5');
            expect(isForwardAuthPeerTrusted('::ffff:10.0.0.5')).toBe(true);
        });
    });

    // C7 (security review 5): isConfiguredTrustedProxy is allowlist-ONLY — used
    // by forward-auth.ts's isOperatorProximate to say "this peer is a known
    // reverse proxy, not the operator", where isForwardAuthPeerTrusted would be
    // wrong (it also returns true for every peer under LUMASTRA_TRUST_ANY_PROXY).
    describe('isConfiguredTrustedProxy (allowlist-only proxy check)', () => {
        it('is false for any peer when no allowlist is set, even with LUMASTRA_TRUST_ANY_PROXY=true', async () => {
            const { isConfiguredTrustedProxy } = await importClientIp(undefined, 'true');
            expect(isConfiguredTrustedProxy('203.0.113.9')).toBe(false);
            expect(isConfiguredTrustedProxy('127.0.0.1')).toBe(false);
        });

        it('is true for an IPv6-mapped IPv4 peer matching a pinned exact IP', async () => {
            const { isConfiguredTrustedProxy } = await importClientIp('10.0.0.5');
            expect(isConfiguredTrustedProxy('::ffff:10.0.0.5')).toBe(true);
        });

        it('is true for a peer inside a pinned CIDR range', async () => {
            const { isConfiguredTrustedProxy } = await importClientIp('10.0.0.0/24');
            expect(isConfiguredTrustedProxy('10.0.0.42')).toBe(true);
        });

        it('is false for a private peer that is not in the allowlist', async () => {
            const { isConfiguredTrustedProxy } = await importClientIp('10.0.0.5');
            expect(isConfiguredTrustedProxy('192.168.1.50')).toBe(false);
        });
    });

    describe('with exact-IP TRUSTED_PROXY_IPS', () => {
        it('honors leftmost XFF entry when peer is trusted', async () => {
            const { getClientIp } = await importClientIp('10.0.0.5');
            const ip = getClientIp(makeEvent({ peer: '10.0.0.5', xff: '1.2.3.4, 10.0.0.5' }));
            expect(ip).toBe('1.2.3.4');
        });

        it('falls back to X-Real-IP when no XFF and peer is trusted', async () => {
            const { getClientIp } = await importClientIp('10.0.0.5');
            const ip = getClientIp(makeEvent({ peer: '10.0.0.5', xRealIp: '1.2.3.4' }));
            expect(ip).toBe('1.2.3.4');
        });

        it('returns peer when trusted but no forwarded headers present', async () => {
            const { getClientIp } = await importClientIp('10.0.0.5');
            expect(getClientIp(makeEvent({ peer: '10.0.0.5' }))).toBe('10.0.0.5');
        });

        it('returns peer (NOT XFF) when peer is not in trust list', async () => {
            const { getClientIp } = await importClientIp('10.0.0.5');
            const ip = getClientIp(makeEvent({ peer: '10.0.0.99', xff: '1.2.3.4' }));
            expect(ip).toBe('10.0.0.99');
        });

        it('matches IPv6-mapped IPv4 peer (::ffff: lowercase) against IPv4 allowlist entry', async () => {
            const { getClientIp } = await importClientIp('10.0.0.5');
            const ip = getClientIp(makeEvent({ peer: '::ffff:10.0.0.5', xff: '1.2.3.4' }));
            expect(ip).toBe('1.2.3.4');
        });

        it('matches IPv6-mapped IPv4 peer (::FFFF: uppercase) against IPv4 allowlist entry', async () => {
            const { getClientIp } = await importClientIp('10.0.0.5');
            const ip = getClientIp(makeEvent({ peer: '::FFFF:10.0.0.5', xff: '1.2.3.4' }));
            expect(ip).toBe('1.2.3.4');
        });

        it('matches an IPv4 peer when allowlist entry is in IPv6-mapped form', async () => {
            const { getClientIp } = await importClientIp('::ffff:10.0.0.5');
            const ip = getClientIp(makeEvent({ peer: '10.0.0.5', xff: '1.2.3.4' }));
            expect(ip).toBe('1.2.3.4');
        });

        it('honors a comma-separated list of trusted exact IPs', async () => {
            const { getClientIp } = await importClientIp(' 10.0.0.5 , 10.0.0.6 ');
            expect(getClientIp(makeEvent({ peer: '10.0.0.6', xff: '1.2.3.4' }))).toBe('1.2.3.4');
        });

        it('skips empty entries in the comma list without breaking the matcher', async () => {
            const { getClientIp } = await importClientIp(',,10.0.0.5,,');
            expect(getClientIp(makeEvent({ peer: '10.0.0.5', xff: '1.2.3.4' }))).toBe('1.2.3.4');
        });
    });

    describe('with CIDR TRUSTED_PROXY_IPS', () => {
        it('matches an IP inside an IPv4 /24 range', async () => {
            const { getClientIp } = await importClientIp('10.0.0.0/24');
            expect(getClientIp(makeEvent({ peer: '10.0.0.42', xff: '1.2.3.4' }))).toBe('1.2.3.4');
        });

        it('rejects an IP outside an IPv4 /24 range (returns peer)', async () => {
            const { getClientIp } = await importClientIp('10.0.0.0/24');
            expect(getClientIp(makeEvent({ peer: '10.0.1.1', xff: '1.2.3.4' }))).toBe('10.0.1.1');
        });

        it('matches the network address of a /24 range', async () => {
            const { getClientIp } = await importClientIp('10.0.0.0/24');
            expect(getClientIp(makeEvent({ peer: '10.0.0.0', xff: '1.2.3.4' }))).toBe('1.2.3.4');
        });

        it('matches the broadcast address of a /24 range', async () => {
            const { getClientIp } = await importClientIp('10.0.0.0/24');
            expect(getClientIp(makeEvent({ peer: '10.0.0.255', xff: '1.2.3.4' }))).toBe('1.2.3.4');
        });

        it('treats /0 as "all IPv4 trusted"', async () => {
            const { getClientIp } = await importClientIp('0.0.0.0/0');
            expect(getClientIp(makeEvent({ peer: '203.0.113.7', xff: '1.2.3.4' }))).toBe('1.2.3.4');
        });

        it('matches a /32 only against the exact host', async () => {
            const { getClientIp } = await importClientIp('10.0.0.5/32');
            expect(getClientIp(makeEvent({ peer: '10.0.0.5', xff: '1.2.3.4' }))).toBe('1.2.3.4');
            expect(getClientIp(makeEvent({ peer: '10.0.0.6', xff: '1.2.3.4' }))).toBe('10.0.0.6');
        });

        it('matches IPv6-mapped IPv4 against an IPv4 CIDR', async () => {
            const { getClientIp } = await importClientIp('10.0.0.0/24');
            expect(getClientIp(makeEvent({ peer: '::ffff:10.0.0.42', xff: '1.2.3.4' }))).toBe(
                '1.2.3.4',
            );
        });

        it('mixes exact IPs and CIDR ranges in the same env value', async () => {
            const { getClientIp } = await importClientIp('127.0.0.1, 10.0.0.0/24');
            expect(getClientIp(makeEvent({ peer: '10.0.0.7', xff: '1.2.3.4' }))).toBe('1.2.3.4');
            expect(getClientIp(makeEvent({ peer: '127.0.0.1', xff: '1.2.3.4' }))).toBe('1.2.3.4');
            expect(getClientIp(makeEvent({ peer: '192.168.1.1', xff: '1.2.3.4' }))).toBe(
                '192.168.1.1',
            );
        });

        it('falls back to exact-match for malformed CIDR (out-of-range bits)', async () => {
            // /33 is invalid for IPv4 → matcher falls back to treating
            // "10.0.0.0/33" as an exact-match string. No real IP equals
            // that string, so the trust check fails and XFF is ignored.
            const { getClientIp } = await importClientIp('10.0.0.0/33');
            expect(getClientIp(makeEvent({ peer: '10.0.0.5', xff: '1.2.3.4' }))).toBe('10.0.0.5');
        });

        it('falls back to exact-match for malformed CIDR (NaN bits)', async () => {
            const { getClientIp } = await importClientIp('10.0.0.0/abc');
            expect(getClientIp(makeEvent({ peer: '10.0.0.5', xff: '1.2.3.4' }))).toBe('10.0.0.5');
        });

        it('rejects a malformed IPv4 in CIDR network portion', async () => {
            const { getClientIp } = await importClientIp('999.0.0.0/24');
            expect(getClientIp(makeEvent({ peer: '999.0.0.5', xff: '1.2.3.4' }))).toBe('999.0.0.5');
        });
    });

    describe('XFF parsing edge cases when peer IS trusted', () => {
        it('trims whitespace around XFF entries', async () => {
            const { getClientIp } = await importClientIp('10.0.0.5');
            const ip = getClientIp(
                makeEvent({
                    peer: '10.0.0.5',
                    xff: '   1.2.3.4   ,   10.0.0.5  ',
                }),
            );
            expect(ip).toBe('1.2.3.4');
        });

        it('falls through to X-Real-IP when every XFF entry is empty', async () => {
            const { getClientIp } = await importClientIp('10.0.0.5');
            const ip = getClientIp(
                makeEvent({
                    peer: '10.0.0.5',
                    xff: '   ,   ',
                    xRealIp: '9.9.9.9',
                }),
            );
            expect(ip).toBe('9.9.9.9');
        });

        it('falls through to peer when every XFF entry is empty and X-Real-IP missing', async () => {
            const { getClientIp } = await importClientIp('10.0.0.5');
            const ip = getClientIp(makeEvent({ peer: '10.0.0.5', xff: '   ,   ' }));
            expect(ip).toBe('10.0.0.5');
        });

        it('trims whitespace around X-Real-IP', async () => {
            const { getClientIp } = await importClientIp('10.0.0.5');
            const ip = getClientIp(makeEvent({ peer: '10.0.0.5', xRealIp: '  1.2.3.4  ' }));
            expect(ip).toBe('1.2.3.4');
        });
    });

    // A proxy that APPENDS to X-Forwarded-For (nginx's $proxy_add_x_forwarded_for,
    // Nginx Proxy Manager) passes a client-supplied header through: the client
    // sends "X-Forwarded-For: 6.6.6.6" and the app receives "6.6.6.6, <real ip>".
    // Only the entries the trusted proxies appended can be believed, so the client
    // is the rightmost entry that is not itself a trusted proxy.
    describe('X-Forwarded-For chain with TRUSTED_PROXY_IPS configured', () => {
        it('ignores a client-supplied entry in front of the one the proxy appended', async () => {
            const { getClientIp, getClientIpStrict } = await importClientIp('10.0.0.5');
            const event = makeEvent({ peer: '10.0.0.5', xff: '6.6.6.6, 1.2.3.4' });
            expect(getClientIp(event)).toBe('1.2.3.4');
            expect(getClientIpStrict(event)).toBe('1.2.3.4');
        });

        it('skips trusted proxies in a chain of proxies', async () => {
            const { getClientIpStrict } = await importClientIp('10.0.0.5,10.0.0.6');
            const event = makeEvent({ peer: '10.0.0.5', xff: '6.6.6.6, 1.2.3.4, 10.0.0.6' });
            expect(getClientIpStrict(event)).toBe('1.2.3.4');
        });

        it('skips proxies inside a trusted CIDR range', async () => {
            const { getClientIpStrict } = await importClientIp('10.0.0.0/24');
            const event = makeEvent({ peer: '10.0.0.42', xff: '6.6.6.6, 1.2.3.4, 10.0.0.9' });
            expect(getClientIpStrict(event)).toBe('1.2.3.4');
        });

        it('returns the entry the peer appended when every entry is a trusted proxy', async () => {
            const { getClientIpStrict } = await importClientIp('10.0.0.5,10.0.0.6,10.0.0.7');
            const event = makeEvent({ peer: '10.0.0.5', xff: '10.0.0.7, 10.0.0.6' });
            expect(getClientIpStrict(event)).toBe('10.0.0.6');
        });

        it('returns an unlisted outer proxy as the client (every hop must be listed)', async () => {
            const { getClientIpStrict } = await importClientIp('10.0.0.5');
            const event = makeEvent({ peer: '10.0.0.5', xff: '1.2.3.4, 198.51.100.7' });
            expect(getClientIpStrict(event)).toBe('198.51.100.7');
        });

        it('applies the same rule to the raw-Request variant', async () => {
            const { getClientIpStrictFromRequest } = await importClientIp('10.0.0.5');
            const headers = new Headers({ 'x-forwarded-for': '6.6.6.6, 1.2.3.4' });
            expect(getClientIpStrictFromRequest({ headers } as Request, () => '10.0.0.5')).toBe(
                '1.2.3.4',
            );
        });
    });

    describe('getClientIpFromRequest', () => {
        it('mirrors getClientIp behavior with no trust list configured (implicit proxy trust honors XFF)', async () => {
            const { getClientIpFromRequest } = await importClientIp(undefined);
            const headers = new Headers();
            headers.set('x-forwarded-for', '1.2.3.4');
            const ip = getClientIpFromRequest({ headers } as Request, () => '10.0.0.5');
            expect(ip).toBe('1.2.3.4');
        });

        it('honors XFF when getClientAddress callback returns a trusted peer', async () => {
            const { getClientIpFromRequest } = await importClientIp('10.0.0.5');
            const headers = new Headers();
            headers.set('x-forwarded-for', '1.2.3.4');
            const ip = getClientIpFromRequest({ headers } as Request, () => '10.0.0.5');
            expect(ip).toBe('1.2.3.4');
        });

        it('falls back to 0.0.0.0 when callback throws', async () => {
            const { getClientIpFromRequest } = await importClientIp(undefined);
            const ip = getClientIpFromRequest({ headers: new Headers() } as Request, () => {
                throw new Error('boom');
            });
            expect(ip).toBe('0.0.0.0');
        });
    });

    // getClientIpStrict: used by security-sensitive paths (showcase HLS rate-limit).
    // Unlike getClientIp, it does NOT honor XFF when TRUSTED_PROXY_IPS is unset —
    // a client-supplied XFF header cannot forge the rate-limit bucket.
    describe('getClientIpStrict', () => {
        it('returns TCP peer (ignores XFF) when TRUSTED_PROXY_IPS is unset', async () => {
            const { getClientIpStrict } = await importClientIp(undefined);
            const ip = getClientIpStrict(makeEvent({ peer: '10.0.0.5', xff: '1.2.3.4' }));
            expect(ip).toBe('10.0.0.5');
        });

        it('returns TCP peer when TRUSTED_PROXY_IPS is empty string', async () => {
            const { getClientIpStrict } = await importClientIp('');
            const ip = getClientIpStrict(makeEvent({ peer: '10.0.0.5', xff: '1.2.3.4' }));
            expect(ip).toBe('10.0.0.5');
        });

        it('returns TCP peer (no headers) when TRUSTED_PROXY_IPS is unset', async () => {
            const { getClientIpStrict } = await importClientIp(undefined);
            expect(getClientIpStrict(makeEvent({ peer: '10.0.0.5' }))).toBe('10.0.0.5');
        });

        it('honors XFF when TRUSTED_PROXY_IPS is set and peer is trusted', async () => {
            const { getClientIpStrict } = await importClientIp('10.0.0.5');
            const ip = getClientIpStrict(makeEvent({ peer: '10.0.0.5', xff: '1.2.3.4' }));
            expect(ip).toBe('1.2.3.4');
        });

        it('returns peer (NOT XFF) when TRUSTED_PROXY_IPS is set but peer is not trusted', async () => {
            const { getClientIpStrict } = await importClientIp('10.0.0.5');
            const ip = getClientIpStrict(makeEvent({ peer: '10.0.0.99', xff: '1.2.3.4' }));
            expect(ip).toBe('10.0.0.99');
        });

        it('honors XFF with CIDR range when peer is in range', async () => {
            const { getClientIpStrict } = await importClientIp('10.0.0.0/24');
            const ip = getClientIpStrict(makeEvent({ peer: '10.0.0.42', xff: '1.2.3.4' }));
            expect(ip).toBe('1.2.3.4');
        });

        it('falls back to 0.0.0.0 when getClientAddress throws (TRUSTED_PROXY_IPS set)', async () => {
            const { getClientIpStrict } = await importClientIp('10.0.0.5');
            const ip = getClientIpStrict(makeEvent({ peerThrows: true, xff: '1.2.3.4' }));
            // peer is 0.0.0.0 (not in allowlist) → cannot honor XFF → returns 0.0.0.0
            expect(ip).toBe('0.0.0.0');
        });
    });

    // getClientIpStrictFromRequest: the getClientIpStrict counterpart for
    // contexts with only a raw Request + getClientAddress (security review
    // P2 — stream-token mint/refresh/validate must all resolve the IP the
    // same, strict way; this is what a def handler that only destructures
    // `request`/`getClientAddress` from the event calls instead of building
    // a full getClientIpStrict(event) call).
    describe('getClientIpStrictFromRequest', () => {
        it('returns TCP peer (ignores XFF) when TRUSTED_PROXY_IPS is unset', async () => {
            const { getClientIpStrictFromRequest } = await importClientIp(undefined);
            const headers = new Headers();
            headers.set('x-forwarded-for', '1.2.3.4');
            const ip = getClientIpStrictFromRequest({ headers } as Request, () => '10.0.0.5');
            expect(ip).toBe('10.0.0.5');
        });

        it('honors XFF when TRUSTED_PROXY_IPS is set and the callback returns a trusted peer', async () => {
            const { getClientIpStrictFromRequest } = await importClientIp('10.0.0.5');
            const headers = new Headers();
            headers.set('x-forwarded-for', '1.2.3.4');
            const ip = getClientIpStrictFromRequest({ headers } as Request, () => '10.0.0.5');
            expect(ip).toBe('1.2.3.4');
        });

        it('returns the peer (NOT XFF) when TRUSTED_PROXY_IPS is set but the peer is not trusted', async () => {
            const { getClientIpStrictFromRequest } = await importClientIp('10.0.0.5');
            const headers = new Headers();
            headers.set('x-forwarded-for', '1.2.3.4');
            const ip = getClientIpStrictFromRequest({ headers } as Request, () => '10.0.0.99');
            expect(ip).toBe('10.0.0.99');
        });

        it('falls back to 0.0.0.0 when the callback throws', async () => {
            const { getClientIpStrictFromRequest } = await importClientIp(undefined);
            const ip = getClientIpStrictFromRequest({ headers: new Headers() } as Request, () => {
                throw new Error('boom');
            });
            expect(ip).toBe('0.0.0.0');
        });
    });

    // Gate for operator-only diagnostics: a caller on loopback / RFC1918 /
    // link-local / IPv6 ULA is plausibly the operator setting the box up, so
    // they may see verbose setup guidance. Everyone else gets a generic
    // envelope. The `0.0.0.0` sentinel that `peerOf()` returns when the peer is
    // unknowable MUST be treated as public so the gate fails closed.
    describe('isPrivateClientIp (operator-proximity gate)', () => {
        const PRIVATE = [
            '127.0.0.1',
            '127.1.2.3',
            '::1',
            '::ffff:127.0.0.1',
            '::ffff:10.0.0.5',
            '10.0.0.5',
            '172.16.0.1',
            '172.31.255.255',
            '192.168.1.10',
            '169.254.10.1',
            'fd00::1',
            'FD12:3456::1',
            'fe80::1',
        ];
        const PUBLIC = [
            '0.0.0.0',
            '8.8.8.8',
            '203.0.113.7',
            '172.15.0.1',
            '172.32.0.1',
            '100.64.0.1',
            '2606:4700::1111',
            '',
            'not-an-ip',
        ];

        it.each(PRIVATE)('treats %s as operator-proximate', async (ip) => {
            const { isPrivateClientIp } = await importClientIp(undefined);
            expect(isPrivateClientIp(ip)).toBe(true);
        });

        it.each(PUBLIC)('treats %s as public', async (ip) => {
            const { isPrivateClientIp } = await importClientIp(undefined);
            expect(isPrivateClientIp(ip)).toBe(false);
        });
    });

    // A request that carries X-Forwarded-For / X-Real-IP passed through a proxy,
    // so its private TCP peer is the PROXY, not the caller. The diagnostics gate
    // uses this to avoid mistaking a proxied internet visitor for the operator.
    describe('hasForwardedClientIpHeader', () => {
        it('is true when X-Forwarded-For is present', async () => {
            const { hasForwardedClientIpHeader } = await importClientIp(undefined);
            const h = new Headers({ 'x-forwarded-for': '203.0.113.7' });
            expect(hasForwardedClientIpHeader(h)).toBe(true);
        });

        it('is true when only X-Real-IP is present', async () => {
            const { hasForwardedClientIpHeader } = await importClientIp(undefined);
            const h = new Headers({ 'x-real-ip': '203.0.113.7' });
            expect(hasForwardedClientIpHeader(h)).toBe(true);
        });

        it('is false when neither header is present', async () => {
            const { hasForwardedClientIpHeader } = await importClientIp(undefined);
            expect(hasForwardedClientIpHeader(new Headers())).toBe(false);
        });

        it('is false for a blank header value', async () => {
            const { hasForwardedClientIpHeader } = await importClientIp(undefined);
            expect(hasForwardedClientIpHeader(new Headers({ 'x-forwarded-for': '   ' }))).toBe(
                false,
            );
        });
    });

    // CLIENT_IP_PROXY_IPS (Helm chart router pods): trusted for the forwarded client IP and
    // protocol ONLY. Every identity decision must stay exactly as if it were unset.
    describe('CLIENT_IP_PROXY_IPS (client IP only, never identity)', () => {
        const POD_NET = '10.0.0.0/8';

        it('getClientIpStrict honors XFF from a listed peer (two router pods, one client)', async () => {
            const { getClientIpStrict } = await importClientIp(undefined, undefined, POD_NET);
            const a = getClientIpStrict(makeEvent({ peer: '10.42.0.11', xff: '203.0.113.9' }));
            const b = getClientIpStrict(makeEvent({ peer: '10.42.1.27', xff: '203.0.113.9' }));
            expect(a).toBe('203.0.113.9');
            expect(b).toBe('203.0.113.9');
        });

        it('getClientIpStrictFromRequest honors XFF from a listed peer', async () => {
            const { getClientIpStrictFromRequest } = await importClientIp(
                undefined,
                undefined,
                POD_NET,
            );
            const request = new Request('http://x/', {
                headers: { 'x-forwarded-for': '203.0.113.9' },
            });
            expect(getClientIpStrictFromRequest(request, () => '10.42.0.11')).toBe('203.0.113.9');
        });

        it('getClientIpStrict ignores XFF from a peer outside the list', async () => {
            const { getClientIpStrict } = await importClientIp(undefined, undefined, POD_NET);
            const ip = getClientIpStrict(makeEvent({ peer: '203.0.113.50', xff: '1.2.3.4' }));
            expect(ip).toBe('203.0.113.50');
        });

        it('does not grant forward-auth identity trust', async () => {
            const { isForwardAuthPeerTrusted, isConfiguredTrustedProxy, forwardAuthTrustPosture } =
                await importClientIp(undefined, undefined, POD_NET);
            expect(isForwardAuthPeerTrusted('10.42.0.11')).toBe(false);
            expect(isConfiguredTrustedProxy('10.42.0.11')).toBe(false);
            expect(forwardAuthTrustPosture()).toBe('fail-closed');
        });

        it('does not widen TRUSTED_PROXY_IPS identity trust when both are set', async () => {
            const { isForwardAuthPeerTrusted, forwardAuthTrustPosture } = await importClientIp(
                '10.42.0.5',
                undefined,
                POD_NET,
            );
            expect(isForwardAuthPeerTrusted('10.42.0.5')).toBe(true);
            expect(isForwardAuthPeerTrusted('10.42.0.11')).toBe(false);
            expect(forwardAuthTrustPosture()).toBe('allowlist');
        });

        it('does not combine with LUMASTRA_TRUST_ANY_PROXY into a narrower identity posture', async () => {
            const { isForwardAuthPeerTrusted, forwardAuthTrustPosture } = await importClientIp(
                undefined,
                'true',
                POD_NET,
            );
            expect(forwardAuthTrustPosture()).toBe('trust-any');
            expect(isForwardAuthPeerTrusted('10.42.0.11')).toBe(true);
        });

        it('a listed peer is skipped as a hop in a chain, an unlisted one is the client', async () => {
            const { getClientIpStrict } = await importClientIp(undefined, undefined, POD_NET);
            const ip = getClientIpStrict(
                makeEvent({ peer: '10.42.0.11', xff: '1.2.3.4, 10.9.9.9' }),
            );
            expect(ip).toBe('1.2.3.4');
        });

        it('getClientIp (non-strict) stops trusting XFF from peers outside the list', async () => {
            const { getClientIp } = await importClientIp(undefined, undefined, POD_NET);
            expect(getClientIp(makeEvent({ peer: '203.0.113.50', xff: '1.2.3.4' }))).toBe(
                '203.0.113.50',
            );
            expect(getClientIp(makeEvent({ peer: '10.42.0.11', xff: '1.2.3.4' }))).toBe('1.2.3.4');
        });

        it('isForwardedHeaderPeerTrusted follows the list', async () => {
            const { isForwardedHeaderPeerTrusted } = await importClientIp(
                undefined,
                undefined,
                POD_NET,
            );
            expect(isForwardedHeaderPeerTrusted(() => '10.42.0.11')).toBe(true);
            expect(isForwardedHeaderPeerTrusted(() => '203.0.113.50')).toBe(false);
        });

        it('clientIpProxiesPinned: a wide unauthenticated list is NOT pinned, a narrow one is', async () => {
            const wide = await importClientIp(undefined, undefined, POD_NET);
            expect(wide.clientIpProxiesPinned()).toBe(false);
            const narrow = await importClientIp(undefined, undefined, '10.42.0.11,10.42.1.0/24');
            expect(narrow.clientIpProxiesPinned()).toBe(true);
        });

        it('malformed CIDR entries fall back to an exact match and match no real peer', async () => {
            const { getClientIpStrict } = await importClientIp(
                undefined,
                undefined,
                '10.0.0.0/33,10.0.0.0/x,300.1.1.1/8',
            );
            expect(getClientIpStrict(makeEvent({ peer: '10.0.0.7', xff: '1.2.3.4' }))).toBe(
                '10.0.0.7',
            );
        });

        it('IPv6 range entries match nothing; exact IPv6 and ::ffff: IPv4-mapped peers work', async () => {
            const range = await importClientIp(undefined, undefined, 'fd00::/8');
            expect(range.getClientIpStrict(makeEvent({ peer: 'fd00::5', xff: '1.2.3.4' }))).toBe(
                'fd00::5',
            );
            const exact = await importClientIp(undefined, undefined, 'fd00::5,10.9.0.0/16');
            expect(exact.getClientIpStrict(makeEvent({ peer: 'fd00::5', xff: '1.2.3.4' }))).toBe(
                '1.2.3.4',
            );
            expect(
                exact.getClientIpStrict(makeEvent({ peer: '::ffff:10.9.1.1', xff: '1.2.3.4' })),
            ).toBe('1.2.3.4');
        });

        it('clientIpProxiesPinned is false with neither variable set', async () => {
            const { clientIpProxiesPinned } = await importClientIp(undefined);
            expect(clientIpProxiesPinned()).toBe(false);
        });
    });

    // Router hop (Helm chart): the router's request carries HMAC(master key); no list involved.
    describe('router hop secret', () => {
        const KEY = 'a'.repeat(64);

        async function importWithKey(key: string | undefined, trusted?: string) {
            if (key === undefined) delete process.env.LUMASTRA_MASTER_KEY;
            else process.env.LUMASTRA_MASTER_KEY = key;
            const mod = await importClientIp(trusted);
            const hop = await import('./router-hop');
            return { ...mod, hop };
        }

        function hopEvent(opts: EventOpts & { hop?: string }): RequestEvent {
            const ev = makeEvent(opts);
            if (opts.hop !== undefined) ev.request.headers.set('x-lumastra-router-hop', opts.hop);
            return ev;
        }

        let savedKey: string | undefined;
        beforeEach(() => {
            savedKey = process.env.LUMASTRA_MASTER_KEY;
        });
        afterEach(() => {
            if (savedKey === undefined) delete process.env.LUMASTRA_MASTER_KEY;
            else process.env.LUMASTRA_MASTER_KEY = savedKey;
        });

        it('matching secret: strict IP is the forwarded client, from any peer address (two router pods)', async () => {
            const { getClientIpStrict, hop } = await importWithKey(KEY);
            const secret = hop.deriveRouterHopSecret(KEY);
            for (const peer of ['10.42.0.11', '10.42.1.27', 'fd00::7']) {
                expect(getClientIpStrict(hopEvent({ peer, xff: '203.0.113.9', hop: secret }))).toBe(
                    '203.0.113.9',
                );
            }
        });

        it('wrong, missing or empty secret: strict IP stays the raw peer', async () => {
            const { getClientIpStrict } = await importWithKey(KEY);
            for (const hopValue of ['wrong', '', undefined]) {
                expect(
                    getClientIpStrict(
                        hopEvent({ peer: '10.42.0.11', xff: '6.6.6.6', hop: hopValue }),
                    ),
                ).toBe('10.42.0.11');
            }
        });

        it('no master key in the env: the hop never authenticates, even a header computed from an empty key', async () => {
            const { getClientIpStrict, hop } = await importWithKey(undefined);
            expect(hop.deriveRouterHopSecret('')).toBe('');
            expect(
                getClientIpStrict(hopEvent({ peer: '10.42.0.11', xff: '6.6.6.6', hop: '' })),
            ).toBe('10.42.0.11');
        });

        it('the secret of another master key is rejected', async () => {
            const { getClientIpStrict, hop } = await importWithKey(KEY);
            const other = hop.deriveRouterHopSecret('b'.repeat(64));
            expect(
                getClientIpStrict(hopEvent({ peer: '10.42.0.11', xff: '6.6.6.6', hop: other })),
            ).toBe('10.42.0.11');
        });

        it('a hop request grants no identity trust', async () => {
            const { isForwardAuthPeerTrusted, forwardAuthTrustPosture } = await importWithKey(KEY);
            expect(isForwardAuthPeerTrusted('10.42.0.11')).toBe(false);
            expect(forwardAuthTrustPosture()).toBe('fail-closed');
        });

        it('non-strict getClientIp and isForwardedHeaderPeerTrusted follow the hop too, with a list set', async () => {
            const { getClientIp, isForwardedHeaderPeerTrusted, hop } = await importWithKey(
                KEY,
                '10.9.9.9',
            );
            const secret = hop.deriveRouterHopSecret(KEY);
            const ev = hopEvent({ peer: '10.42.0.11', xff: '203.0.113.9', hop: secret });
            expect(getClientIp(ev)).toBe('203.0.113.9');
            expect(isForwardedHeaderPeerTrusted(() => '10.42.0.11', ev.request)).toBe(true);
            expect(isForwardedHeaderPeerTrusted(() => '10.42.0.11')).toBe(false);
        });

        it('acceptAndStripRouterHop removes the header, and the verdict survives the strip', async () => {
            const { getClientIpStrict, hop } = await importWithKey(KEY);
            const secret = hop.deriveRouterHopSecret(KEY);
            const ev = hopEvent({ peer: '10.42.0.11', xff: '203.0.113.9', hop: secret });
            expect(hop.routerHopSeen()).toBe(false);
            expect(hop.acceptAndStripRouterHop(ev.request)).toBe(true);
            expect(ev.request.headers.get('x-lumastra-router-hop')).toBeNull();
            expect(getClientIpStrict(ev)).toBe('203.0.113.9');
            expect(hop.routerHopSeen()).toBe(true);
        });

        it('acceptAndStripRouterHop strips a forged header and does not authenticate it', async () => {
            const { getClientIpStrict, hop } = await importWithKey(KEY);
            const ev = hopEvent({ peer: '10.42.0.11', xff: '6.6.6.6', hop: 'forged' });
            expect(hop.acceptAndStripRouterHop(ev.request)).toBe(false);
            expect(ev.request.headers.get('x-lumastra-router-hop')).toBeNull();
            expect(getClientIpStrict(ev)).toBe('10.42.0.11');
            expect(hop.routerHopSeen()).toBe(false);
        });

        it('pin state: a served hop is a caveat (router trust unknown), never pinned on its own', async () => {
            delete process.env.LUMASTRA_ROUTER_REALIP_WIDE;
            const { clientIpPinState, clientIpProxiesPinned, hop } = await importWithKey(KEY);
            expect(clientIpPinState()).toBe('none');
            const ev = hopEvent({
                peer: '10.42.0.11',
                xff: '1.1.1.1',
                hop: hop.deriveRouterHopSecret(KEY),
            });
            hop.acceptAndStripRouterHop(ev.request);
            expect(clientIpPinState()).toBe('caveat');
            expect(clientIpProxiesPinned()).toBe(false);
        });

        it('pin state follows LUMASTRA_ROUTER_REALIP_WIDE from the chart, with no request needed', async () => {
            process.env.LUMASTRA_ROUTER_REALIP_WIDE = 'true';
            const wide = await importWithKey(KEY);
            expect(wide.clientIpPinState()).toBe('caveat');
            process.env.LUMASTRA_ROUTER_REALIP_WIDE = 'false';
            const narrow = await importWithKey(KEY);
            expect(narrow.clientIpPinState()).toBe('pinned');
            expect(narrow.clientIpProxiesPinned()).toBe(true);
            // Narrow router but no env master key: the hop cannot work, so it is not pinned.
            const noKey = await importWithKey(undefined);
            expect(noKey.clientIpPinState()).toBe('none');
            delete process.env.LUMASTRA_ROUTER_REALIP_WIDE;
        });

        it('a wide router caveat outranks a narrow CLIENT_IP_PROXY_IPS list', async () => {
            process.env.LUMASTRA_ROUTER_REALIP_WIDE = 'true';
            delete process.env.TRUSTED_PROXY_IPS;
            process.env.CLIENT_IP_PROXY_IPS = '10.42.0.11';
            vi.resetModules();
            const { clientIpPinState } = await import('./client-ip');
            expect(clientIpPinState()).toBe('caveat');
            delete process.env.LUMASTRA_ROUTER_REALIP_WIDE;
        });

        it('downstream code never sees the secret: after the strip the header reads null', async () => {
            const { hop } = await importWithKey(KEY);
            const ev = hopEvent({
                peer: '10.42.0.11',
                xff: '1.1.1.1',
                hop: hop.deriveRouterHopSecret(KEY),
            });
            expect(ev.request.headers.get('x-lumastra-router-hop')).not.toBeNull();
            hop.acceptAndStripRouterHop(ev.request);
            expect(ev.request.headers.get('x-lumastra-router-hop')).toBeNull();
            expect([...ev.request.headers.keys()]).not.toContain('x-lumastra-router-hop');
            // Idempotent, and a second pass keeps the verdict.
            expect(hop.acceptAndStripRouterHop(ev.request)).toBe(true);
            expect(hop.isRouterHopAuthenticated(ev.request)).toBe(true);
        });

        it('the derivation is HMAC-SHA256(key, "lumastra-router-hop-v1") over the trimmed key, hex', async () => {
            const { hop } = await importWithKey(KEY);
            const { createHmac } = await import('node:crypto');
            const want = createHmac('sha256', Buffer.from(KEY))
                .update('lumastra-router-hop-v1')
                .digest('hex');
            expect(hop.deriveRouterHopSecret(KEY)).toBe(want);
            expect(hop.deriveRouterHopSecret(`  ${KEY}\n`)).toBe(want);
        });
    });
});
