// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Server cookies keep Secure unless the request shows plain HTTP.
//
// Runs against SvelteKit's real cookie jar (get_cookies), because its default
// `secure: true` for every non-localhost URL is what broke plain-HTTP LAN
// sign-in. client-ip.ts reads TRUSTED_PROXY_IPS at module load, so each case
// re-imports the module under test after setting the environment.

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cookies, RequestEvent } from '@sveltejs/kit';
// Not in @sveltejs/kit's exports map; imported by path to test the real defaults.
// @ts-expect-error -- untyped internal module, typed by the cast below
import { get_cookies as getCookiesUntyped } from '../../../../node_modules/@sveltejs/kit/src/runtime/server/cookie.js';

const get_cookies = getCookiesUntyped as (request: Request, url: URL) => unknown;

interface JarCookie {
    name: string;
    value: string;
    options: { secure?: boolean; httpOnly?: boolean; sameSite?: string; maxAge?: number };
}

interface Case {
    /** The URL SvelteKit sees. adapter-node without ORIGIN/PROTOCOL_HEADER always reports https. */
    url?: string;
    /** Defaults to POST (sign-in). */
    method?: string;
    peer?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
}

const ENV_KEYS = ['ORIGIN', 'PROTOCOL_HEADER', 'TRUSTED_PROXY_IPS', 'LUMASTRA_TRUST_ANY_PROXY'];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
});

async function run(c: Case, act: (cookies: Cookies) => void): Promise<Map<string, JarCookie>> {
    for (const [k, v] of Object.entries(c.env ?? {})) process.env[k] = v;
    vi.resetModules();
    const { applyCookieTransportDefaults } = await import('./cookie-transport.js');

    const url = new URL(c.url ?? 'https://192.168.1.10:3000/api/auth/native/login');
    const request = new Request(url, { method: c.method ?? 'POST', headers: c.headers ?? {} });
    const jar = get_cookies(request, url) as unknown as {
        cookies: Cookies;
        new_cookies: Map<string, JarCookie>;
        set_trailing_slash: (t: 'never') => void;
    };
    // SvelteKit calls this once the route is known; cookies are queued until then.
    jar.set_trailing_slash('never');
    const event = {
        request,
        url,
        cookies: jar.cookies,
        getClientAddress: () => c.peer ?? '192.168.1.50',
    } as unknown as RequestEvent;

    applyCookieTransportDefaults(event);
    act(event.cookies);
    return jar.new_cookies;
}

async function sessionCookie(c: Case): Promise<JarCookie> {
    const jar = await run(c, (cookies) =>
        cookies.set('lumastra_session', 'tok', {
            path: '/',
            httpOnly: true,
            sameSite: 'lax',
            maxAge: 60,
        }),
    );
    const cookie = [...jar.values()].find((x) => x.name === 'lumastra_session');
    if (!cookie) throw new Error('session cookie not set');
    return cookie;
}

const LAN = 'http://192.168.1.10:3000';

describe('cookie Secure flag: dropped only when the request shows plain HTTP', () => {
    it('sign-in POST from http://<lan-ip>: not Secure, although adapter-node reports https', async () => {
        const cookie = await sessionCookie({ headers: { origin: LAN } });
        expect(cookie.options.secure).toBe(false);
        expect(cookie.options.httpOnly).toBe(true);
        expect(cookie.options.sameSite).toBe('lax');
    });

    it('baseline: without the wrapper SvelteKit marks the same cookie Secure', () => {
        const url = new URL('https://192.168.1.10:3000/api/auth/native/login');
        const jar = get_cookies(new Request(url, { headers: { origin: LAN } }), url) as unknown as {
            cookies: Cookies;
            new_cookies: Map<string, JarCookie>;
            set_trailing_slash: (t: 'never') => void;
        };
        jar.set_trailing_slash('never');
        jar.cookies.set('lumastra_session', 'tok', { path: '/' });
        expect([...jar.new_cookies.values()][0].options.secure).toBe(true);
    });

    it('Referer never counts, nor Origin on a GET (OIDC redirect chain from a fake http page)', async () => {
        const referer = await sessionCookie({
            url: 'https://media.example.com/auth/oidc/callback',
            method: 'GET',
            headers: { referer: 'http://media.example.com/' },
        });
        expect(referer.options.secure).toBe(true);
        const getOrigin = await sessionCookie({
            method: 'GET',
            headers: { origin: LAN },
        });
        expect(getOrigin.options.secure).toBe(true);
    });

    it('logout over plain HTTP clears the cookie without Secure', async () => {
        const jar = await run({ headers: { origin: LAN } }, (cookies) =>
            cookies.delete('lumastra_session', { path: '/' }),
        );
        const cookie = [...jar.values()][0];
        expect(cookie.options.maxAge).toBe(0);
        expect(cookie.options.secure).toBe(false);
    });

    it('no evidence at all (e.g. OIDC callback behind a proxy that sends no protocol): Secure', async () => {
        const cookie = await sessionCookie({ url: 'https://media.example.com/auth/oidc/callback' });
        expect(cookie.options.secure).toBe(true);
    });

    it('ORIGIN https: always Secure, even when the browser is on http', async () => {
        const cookie = await sessionCookie({
            env: { ORIGIN: 'https://media.example.com' },
            headers: { origin: LAN },
        });
        expect(cookie.options.secure).toBe(true);
    });

    it('ORIGIN http (the LAN URL): not Secure, even on a GET with no other evidence', async () => {
        const cookie = await sessionCookie({
            url: `${LAN}/auth/oidc/callback`,
            env: { ORIGIN: LAN },
        });
        expect(cookie.options.secure).toBe(false);
    });

    it('an invalid ORIGIN keeps Secure', async () => {
        const cookie = await sessionCookie({
            env: { ORIGIN: 'not a url' },
            headers: { origin: LAN },
        });
        expect(cookie.options.secure).toBe(true);
    });

    it('trusted proxy with X-Forwarded-Proto: https → Secure', async () => {
        const cookie = await sessionCookie({
            env: { TRUSTED_PROXY_IPS: '10.0.0.5' },
            peer: '10.0.0.5',
            headers: { 'x-forwarded-proto': 'https' },
        });
        expect(cookie.options.secure).toBe(true);
    });

    it('trusted proxy given as a CIDR range, IPv6-mapped peer, reporting http → not Secure', async () => {
        const cookie = await sessionCookie({
            env: { TRUSTED_PROXY_IPS: '172.16.0.0/12' },
            peer: '::ffff:172.18.0.2',
            headers: { 'x-forwarded-proto': 'http' },
        });
        expect(cookie.options.secure).toBe(false);
    });

    it('trusted proxy reporting http while the browser says https → Secure (https wins)', async () => {
        const cookie = await sessionCookie({
            url: 'https://media.example.com/api/auth/native/login',
            env: { TRUSTED_PROXY_IPS: '10.0.0.5' },
            peer: '10.0.0.5',
            headers: { 'x-forwarded-proto': 'http', origin: 'https://media.example.com' },
        });
        expect(cookie.options.secure).toBe(true);
    });

    it('chained proxies: any https element of X-Forwarded-Proto counts', async () => {
        const cookie = await sessionCookie({
            env: { TRUSTED_PROXY_IPS: '10.0.0.5' },
            peer: '10.0.0.5',
            headers: { 'x-forwarded-proto': 'http, https' },
        });
        expect(cookie.options.secure).toBe(true);
    });

    it('forged X-Forwarded-Proto: http from a peer outside TRUSTED_PROXY_IPS cannot drop Secure', async () => {
        const cookie = await sessionCookie({
            url: 'https://media.example.com/auth/oidc/callback',
            env: { TRUSTED_PROXY_IPS: '10.0.0.5' },
            peer: '192.168.1.50',
            headers: { 'x-forwarded-proto': 'http', forwarded: 'proto=http' },
        });
        expect(cookie.options.secure).toBe(true);
    });

    it('forged X-Forwarded-Proto: https from an untrusted peer is ignored; the browser decides', async () => {
        const cookie = await sessionCookie({
            env: { TRUSTED_PROXY_IPS: '10.0.0.5' },
            peer: '192.168.1.50',
            headers: { 'x-forwarded-proto': 'https', origin: LAN },
        });
        expect(cookie.options.secure).toBe(false);
    });

    it('PROTOCOL_HEADER from a proxy outside TRUSTED_PROXY_IPS: no evidence, stays Secure', async () => {
        const cookie = await sessionCookie({
            url: 'https://media.example.com/auth/oidc/callback',
            env: { TRUSTED_PROXY_IPS: '10.0.0.5', PROTOCOL_HEADER: 'x-forwarded-proto' },
            peer: '172.18.0.9',
            headers: { 'x-forwarded-proto': 'https' },
        });
        expect(cookie.options.secure).toBe(true);
    });

    it('TRUSTED_PROXY_IPS empty: the immediate peer is the proxy, its http is believed', async () => {
        const cookie = await sessionCookie({
            peer: '172.18.0.1',
            headers: { 'x-forwarded-proto': 'http' },
        });
        expect(cookie.options.secure).toBe(false);
    });

    it('RFC 7239 Forwarded with several elements: proto=https in any of them → Secure', async () => {
        const cookie = await sessionCookie({
            env: { TRUSTED_PROXY_IPS: '10.0.0.5' },
            peer: '10.0.0.5',
            headers: {
                forwarded:
                    'for=192.0.2.60;proto=http, for=198.51.100.17;proto="https";by=203.0.113.43',
                origin: LAN,
            },
        });
        expect(cookie.options.secure).toBe(true);
    });

    it('custom PROTOCOL_HEADER from a trusted proxy reporting http → not Secure', async () => {
        const cookie = await sessionCookie({
            env: { TRUSTED_PROXY_IPS: '10.0.0.5', PROTOCOL_HEADER: 'X-Scheme' },
            peer: '10.0.0.5',
            headers: { 'x-scheme': 'http' },
        });
        expect(cookie.options.secure).toBe(false);
    });

    it('an http Origin or Referer for another host is not evidence', async () => {
        const cookie = await sessionCookie({
            headers: { origin: 'http://evil.example', referer: 'http://evil.example/x' },
        });
        expect(cookie.options.secure).toBe(true);
    });

    it('proxy chain: a trusted inner proxy reporting http does not strip Secure on a GET (OIDC callback)', async () => {
        const cookie = await sessionCookie({
            url: 'https://media.example.com/auth/oidc/callback',
            method: 'GET',
            env: { TRUSTED_PROXY_IPS: '10.0.0.5' },
            peer: '10.0.0.5',
            headers: { 'x-forwarded-proto': 'http' },
        });
        expect(cookie.options.secure).toBe(true);
    });

    it('Vite dev server on http://localhost: the real URL counts, also on a GET', async () => {
        const cookie = await sessionCookie({
            url: 'http://localhost:5173/auth/oidc/login',
            method: 'GET',
        });
        expect(cookie.options.secure).toBe(false);
    });

    it('an http URL is not evidence once PROTOCOL_HEADER can rewrite it', async () => {
        const cookie = await sessionCookie({
            url: 'http://media.example.com/auth/oidc/callback',
            method: 'GET',
            env: { PROTOCOL_HEADER: 'x-forwarded-proto' },
            peer: '203.0.113.9',
        });
        expect(cookie.options.secure).toBe(true);
    });

    it('an Origin on the same host but another port is not evidence', async () => {
        const cookie = await sessionCookie({ headers: { origin: 'http://192.168.1.10:3001' } });
        expect(cookie.options.secure).toBe(true);
    });

    it('hasForwardingHeaders: only a request that went through a proxy has them', async () => {
        vi.resetModules();
        const { hasForwardingHeaders } = await import('./cookie-transport.js');
        expect(hasForwardingHeaders(new Headers())).toBe(false);
        expect(hasForwardingHeaders(new Headers({ 'x-forwarded-for': '192.168.1.50' }))).toBe(true);
        expect(hasForwardingHeaders(new Headers({ 'x-forwarded-proto': 'https' }))).toBe(true);
        expect(hasForwardingHeaders(new Headers({ forwarded: 'for=192.0.2.60' }))).toBe(true);
    });

    it('an explicit secure from the caller wins', async () => {
        const jar = await run({ headers: { origin: LAN } }, (cookies) =>
            cookies.set('x', 'y', { path: '/', secure: true }),
        );
        expect([...jar.values()][0].options.secure).toBe(true);
    });

    it('serialize uses the same default', async () => {
        let header = '';
        await run({ headers: { origin: LAN } }, (cookies) => {
            header = cookies.serialize('x', 'y', { path: '/', domain: 'other.example' });
        });
        expect(header.toLowerCase()).not.toContain('secure');
    });

    it('cookieTransportHandle wraps the cookies before resolve runs', async () => {
        vi.resetModules();
        const { cookieTransportHandle } = await import('./cookie-transport.js');
        const url = new URL('https://192.168.1.10:3000/api/auth/native/login');
        const request = new Request(url, { method: 'POST', headers: { origin: LAN } });
        const jar = get_cookies(request, url) as unknown as {
            cookies: Cookies;
            new_cookies: Map<string, JarCookie>;
            set_trailing_slash: (t: 'never') => void;
        };
        jar.set_trailing_slash('never');
        const event = {
            request,
            url,
            cookies: jar.cookies,
            getClientAddress: () => '192.168.1.50',
        } as unknown as RequestEvent;
        await cookieTransportHandle({
            event,
            resolve: (e) => {
                e.cookies.set('lumastra_session', 'tok', { path: '/' });
                return new Response('ok');
            },
        });
        expect([...jar.new_cookies.values()][0].options.secure).toBe(false);
    });

    it('hooks.server.ts runs cookieTransportHandle before every cookie-setting handle', () => {
        const source = readFileSync(new URL('../../../hooks.server.ts', import.meta.url), 'utf8');
        const chain = source.slice(source.indexOf('export const handle = sequence('));
        const names = [...chain.slice(0, chain.indexOf(');')).matchAll(/^\s*(\w+),$/gm)].map(
            (m) => m[1],
        );
        // Only these may run first: none sets a cookie. The shutdown gate must
        // count/refuse requests before auth runs, and only decorates response headers.
        const before = names.slice(0, names.indexOf('cookieTransportHandle'));
        expect(names).toContain('cookieTransportHandle');
        expect(
            before.every((n) =>
                ['requestBodyDrainHandle', 'shutdownGateHandle', 'preloadLinkHeaderHandle'].includes(
                    n,
                ),
            ),
        ).toBe(true);
    });
});
