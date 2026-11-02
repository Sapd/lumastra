// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, expect, it, vi } from 'vitest';
import type { Handle, RequestEvent } from '@sveltejs/kit';
const h = vi.hoisted(() => ({ enabled: true, origins: ['*'] as string[] }));
vi.mock('$lib/server/config', () => ({
    config: {
        get JELLYFIN_COMPAT_CORS_ORIGINS() {
            return h.origins;
        },
        get FEATURE_JELLYFIN_COMPAT() {
            return h.enabled;
        },
    },
}));
// Before implementation the app has no /j CORS handle, so requests pass through.
const modules = import.meta.glob<{ jellyfinCorsHandle: Handle }>('./jellyfin-cors.ts');
const handle: Handle = modules['./jellyfin-cors.ts']
    ? (await modules['./jellyfin-cors.ts']()).jellyfinCorsHandle
    : ({ event, resolve }) => resolve(event);
function event(path: string, method = 'GET'): RequestEvent {
    const url = new URL(path, 'https://media.example');
    return {
        url,
        request: new Request(url, {
            method,
            headers: {
                Origin: 'https://web.example',
                ...(method === 'OPTIONS'
                    ? {
                          'Access-Control-Request-Method': 'POST',
                          'Access-Control-Request-Headers': 'content-type,x-emby-authorization',
                      }
                    : {}),
            },
        }),
        locals: {},
    } as RequestEvent;
}
beforeEach(() => {
    h.enabled = true;
    h.origins = ['*'];
});
it('answers the captured login preflight before auth or routing', async () => {
    const resolve = vi.fn(async () => new Response('method not allowed', { status: 405 }));
    const r = await handle({ event: event('/j/Users/AuthenticateByName', 'OPTIONS'), resolve });
    expect(r.status).toBe(204);
    expect(await r.text()).toBe('');
    expect(resolve).not.toHaveBeenCalled();
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(r.headers.has('access-control-allow-credentials')).toBe(false);
    const allowed = r.headers.get('access-control-allow-headers')!.toLowerCase().split(/,\s*/);
    for (const header of [
        'authorization',
        'x-emby-authorization',
        'x-emby-token',
        'x-mediabrowser-token',
        'content-type',
        'range',
    ])
        expect(allowed).toContain(header);
    const methods = r.headers.get('access-control-allow-methods')!.split(/,\s*/);
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
        expect(methods).toContain(method);
});
for (const status of [200, 204, 401, 403, 404, 429, 500]) {
    it(`exposes a ${status} /j response without a cookie credential grant`, async () => {
        const resolve = async () =>
            new Response(null, {
                status,
                headers: {
                    'Access-Control-Allow-Credentials': 'true',
                    'Content-Range': 'bytes 0-999/2000',
                },
            });
        const r = await handle({ event: event('/j/System/Info/Public'), resolve });
        expect(r.status).toBe(status);
        expect(r.headers.get('access-control-allow-origin')).toBe('*');
        expect(r.headers.has('access-control-allow-credentials')).toBe(false);
        expect(r.headers.get('access-control-expose-headers')).toContain('Content-Range');
    });
}
for (const path of ['/j', '/j/Items/item', '/de/j/Items/item', '/%6a/Items/item']) {
    it(`covers the routed Jellyfin surface ${path}`, async () => {
        const r = await handle({ event: event(path), resolve: async () => new Response('ok') });
        expect(r.headers.get('access-control-allow-origin')).toBe('*');
    });
}
for (const path of [
    '/api/v1/me',
    '/api/auth/native/logout',
    '/subsonic/ping',
    '/j-other',
    '/browse',
]) {
    it(`leaves ${path} outside the Jellyfin grant`, async () => {
        const response = new Response(null, { status: 401 });
        const resolve = vi.fn(async () => response);
        const r = await handle({ event: event(path, 'OPTIONS'), resolve });
        expect(r).toBe(response);
        expect(r.headers.has('access-control-allow-origin')).toBe(false);
        expect(resolve).toHaveBeenCalled();
    });
}
it('preserves the compat kill switch for preflights', async () => {
    h.enabled = false;
    const resolve = vi.fn(async () => new Response(null, { status: 404 }));
    const r = await handle({ event: event('/j/Users/AuthenticateByName', 'OPTIONS'), resolve });
    expect(r.status).toBe(404);
    expect(resolve).not.toHaveBeenCalled();
});

for (const method of ['GET', 'POST', 'OPTIONS']) {
    it(`${method}: empty origin list keeps the previous same-origin-only behavior`, async () => {
        h.origins = [];
        const resolve = vi.fn(
            async () => new Response(null, { status: method === 'OPTIONS' ? 405 : 200 }),
        );
        const response = await handle({
            event: event('/j/Users/AuthenticateByName', method),
            resolve,
        });
        expect(response.status).toBe(method === 'OPTIONS' ? 405 : 200);
        expect(resolve).toHaveBeenCalled();
        expect(response.headers.has('access-control-allow-origin')).toBe(false);
    });
}
for (const origin of [
    'https://web.example',
    'https://web.example.evil',
    'http://web.example',
    'https://web.example:8443',
    'null',
]) {
    it(`exact-origin allowlist: ${origin}`, async () => {
        h.origins = ['https://web.example'];
        const e = event('/j/Users/AuthenticateByName', 'OPTIONS');
        e.request.headers.set('Origin', origin);
        const resolve = vi.fn(async () => new Response(null, { status: 405 }));
        const response = await handle({ event: e, resolve });
        const allowed = origin === 'https://web.example';
        expect(response.status).toBe(allowed ? 204 : 405);
        expect(response.headers.get('access-control-allow-origin')).toBe(allowed ? origin : null);
        expect(response.headers.has('access-control-allow-credentials')).toBe(false);
        expect(response.headers.get('vary')).toContain('Origin');
    });
}
it('an absent Origin header does not receive a grant even with wildcard configured', async () => {
    const e = event('/j/System/Info/Public');
    e.request.headers.delete('origin');
    const response = await handle({ event: e, resolve: async () => new Response('ok') });
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
});

it('denied origins cannot inherit a downstream grant', async () => {
    h.origins = [];
    const response = await handle({
        event: event('/j/System/Info/Public'),
        resolve: async () =>
            new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Credentials': 'true',
                    'Access-Control-Expose-Headers': '*',
                    Vary: 'Accept-Encoding',
                },
            }),
    });
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
    expect(response.headers.has('access-control-allow-credentials')).toBe(false);
    expect(response.headers.has('access-control-expose-headers')).toBe(false);
    expect(response.headers.get('vary')).toBe('Accept-Encoding, Origin');
});
it('the feature switch also returns 404 for ordinary requests without a CORS grant', async () => {
    h.enabled = false;
    const resolve = vi.fn(async () => new Response('ok'));
    const response = await handle({ event: event('/j/System/Info/Public'), resolve });
    expect(response.status).toBe(404);
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
});
