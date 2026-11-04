// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The `Secure` flag on every cookie the server sets (session, OIDC and plugin
 * sign-in state, the Live TV device cookie) is dropped only when the request
 * shows that the browser is on plain HTTP.
 *
 * SvelteKit marks cookies `Secure` unless `event.url` is `http://localhost`.
 * Behind adapter-node `event.url` is not the real protocol: without `ORIGIN`
 * or `PROTOCOL_HEADER` it is always `https://<Host>`. So a browser that opened
 * `http://192.168.1.10:3000` received a `Secure` session cookie, dropped it,
 * and the sign-in failed without an error. Only localhost worked over HTTP.
 *
 * Evidence about the protocol the browser used:
 *   - `ORIGIN`: https makes every cookie `Secure`; http counts as plain HTTP.
 *   - The request URL, when nothing rewrote it (no `ORIGIN`, no
 *     `PROTOCOL_HEADER`): only the Vite dev server reports `http:` then.
 *   - The forwarded protocol (`X-Forwarded-Proto`, `Forwarded: proto=`, or the
 *     header named by `PROTOCOL_HEADER`), only from a peer allowed to annotate
 *     the request: a `TRUSTED_PROXY_IPS` entry, or any peer while that list is
 *     empty, the same rule as the forwarded client IP.
 *   - The browser's own `Origin` header, when it names this host.
 *
 * Any https evidence wins. Without any evidence the cookie stays `Secure`, as
 * before. Header evidence of plain HTTP (forwarded protocol, `Origin`) counts
 * only on POST/PUT/PATCH/DELETE. Built-in sign-in, setup and logout are POSTs,
 * and browsers send `Origin` on every POST. GET sign-in steps (OIDC and plugin
 * login and callback) keep `Secure`: an inner proxy that reports `http` behind
 * an outer TLS proxy must not strip it there, and `Referer` never counts,
 * because a network attacker can start such a redirect chain from a fake
 * `http://<host>/` page that the browser then sends as the callback's Referer.
 * OIDC over plain HTTP therefore needs `ORIGIN=http://...`.
 *
 * Header evidence comes from the browser itself or a proxy it went through. An
 * attacker who serves a fake `http://<host>/` page can make the browser POST
 * here with `Origin: http://<host>`, but the POSTs that set a session need the
 * user's password or an existing session, which the SameSite=Lax cookie does
 * not carry cross-scheme. `ORIGIN=https://...` or HSTS rules this out.
 * `HttpOnly`, `SameSite` and `Path` are untouched.
 */

import type { Cookies, Handle, RequestEvent } from '@sveltejs/kit';
import { isForwardedHeaderPeerTrusted } from '$lib/server/utils/client-ip.js';

type TransportEvent = Pick<RequestEvent, 'request' | 'url' | 'getClientAddress'>;
type Scheme = 'https' | 'http';

function asScheme(value: string): Scheme | null {
    const v = value.trim().replace(/^"|"$/g, '').toLowerCase();
    return v === 'https' || v === 'http' ? v : null;
}

function originEnvScheme(): Scheme | null {
    const raw = (process.env.ORIGIN ?? '').trim();
    if (!raw) return null;
    try {
        return asScheme(new URL(raw).protocol.slice(0, -1));
    } catch {
        // adapter-node refuses to start on an invalid ORIGIN; keep Secure if one slips through.
        return 'https';
    }
}

/** Every protocol value a forwarding proxy put on the request (all list elements). */
function forwardedSchemes(headers: Headers): Scheme[] {
    const values: string[] = [];
    values.push(...(headers.get('x-forwarded-proto') ?? '').split(','));
    for (const element of (headers.get('forwarded') ?? '').split(',')) {
        for (const pair of element.split(';')) {
            const eq = pair.indexOf('=');
            if (eq > 0 && pair.slice(0, eq).trim().toLowerCase() === 'proto') {
                values.push(pair.slice(eq + 1));
            }
        }
    }
    const protocolHeader = (process.env.PROTOCOL_HEADER ?? '').trim().toLowerCase();
    if (protocolHeader) values.push(...(headers.get(protocolHeader) ?? '').split(','));
    return values.map(asScheme).filter((s): s is Scheme => s !== null);
}

/** Scheme of the page that sent the request, from its `Origin`, when that names this host. */
function browserScheme(event: TransportEvent): Scheme | null {
    const origin = event.request.headers.get('origin');
    if (!origin || origin === 'null') return null;
    try {
        const parsed = new URL(origin);
        if (parsed.host.toLowerCase() !== event.url.host.toLowerCase()) return null;
        return asScheme(parsed.protocol.slice(0, -1));
    } catch {
        return null;
    }
}

/**
 * The protocol the browser used, or null when the request carries no evidence
 * either way (see the module comment).
 */
export function requestScheme(event: TransportEvent): Scheme | null {
    const fromOrigin = originEnvScheme();
    if (fromOrigin === 'https') return 'https';
    const fromConfig: Scheme[] = [];
    if (fromOrigin) fromConfig.push(fromOrigin);
    else if (!process.env.PROTOCOL_HEADER?.trim() && event.url.protocol === 'http:') {
        fromConfig.push('http');
    }
    const fromHeaders: Scheme[] = [];
    const forwarded = forwardedSchemes(event.request.headers);
    if (
        forwarded.length > 0 &&
        isForwardedHeaderPeerTrusted(event.getClientAddress, event.request)
    ) {
        fromHeaders.push(...forwarded);
    }
    const fromBrowser = browserScheme(event);
    if (fromBrowser) fromHeaders.push(fromBrowser);

    if (fromHeaders.includes('https')) return 'https';
    if (fromConfig.includes('http')) return 'http';
    const method = event.request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && fromHeaders.includes('http')) return 'http';
    return null;
}

/**
 * Whether the request came through something that annotated it (a forwarded
 * protocol or client address). adapter-node never terminates TLS itself, so a
 * request without any of these most likely came straight from a browser over
 * plain HTTP. Only good enough for a setup-wizard hint, never for cookies.
 */
export function hasForwardingHeaders(headers: Headers): boolean {
    if (forwardedSchemes(headers).length > 0) return true;
    return ['x-forwarded-for', 'x-real-ip', 'forwarded'].some((h) => headers.has(h));
}

/** Whether cookies set for this request get `Secure`: unless it is shown to be plain HTTP. */
export function isHttpsRequest(event: TransportEvent): boolean {
    return requestScheme(event) !== 'http';
}

/**
 * Make `event.cookies.set` (and `delete`, which goes through `set`, and
 * `serialize`) default `secure` to {@link isHttpsRequest}. An explicit
 * `secure` from the caller still wins.
 */
export function applyCookieTransportDefaults(event: TransportEvent & { cookies: Cookies }): void {
    let secure: boolean | undefined;
    const isSecure = (): boolean => (secure ??= isHttpsRequest(event));
    const cookies = event.cookies;
    const set = cookies.set.bind(cookies);
    const serialize = cookies.serialize.bind(cookies);
    cookies.set = (name, value, options) =>
        set(name, value, { ...options, secure: options.secure ?? isSecure() });
    cookies.serialize = (name, value, options) =>
        serialize(name, value, { ...options, secure: options.secure ?? isSecure() });
}

/** Hook handle; must run before every handle and route that can set or clear a cookie. */
export const cookieTransportHandle: Handle = ({ event, resolve }) => {
    applyCookieTransportDefaults(event);
    return resolve(event);
};
