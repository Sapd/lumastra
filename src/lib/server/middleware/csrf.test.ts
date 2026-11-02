// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the scoped CSRF origin guard.
 *
 * The guard mirrors SvelteKit's built-in algorithm (form content type + unsafe
 * method + origin mismatch) but exempts the self-authenticating cross-origin
 * surfaces (/j, /subsonic, /oauth). These tests pin both the "block" and
 * "allow" cases so a future change can't silently widen or break the hole.
 */

import { describe, it, expect, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { isCrossSiteFormSubmission, csrfHandle } from './csrf';

vi.mock('$lib/server/config.js', () => ({
    config: {
        // Default: no extra trusted origins.
        CORS_ALLOWED_ORIGINS: [] as string[],
    },
}));

import { config } from '$lib/server/config.js';

interface MockOpts {
    method?: string;
    contentType?: string | null;
    origin?: string | null;
    referer?: string | null;
    targetUrl?: string;
    authorization?: string | null;
}

function createEvent(opts: MockOpts = {}): RequestEvent {
    const {
        method = 'POST',
        contentType = 'application/x-www-form-urlencoded',
        origin = null,
        referer = null,
        targetUrl = 'https://app.example.com/some/route',
        authorization = null,
    } = opts;

    const headers = new Headers();
    if (contentType) headers.set('content-type', contentType);
    if (origin) headers.set('origin', origin);
    if (referer) headers.set('referer', referer);
    if (authorization) headers.set('authorization', authorization);

    const url = new URL(targetUrl);
    const request = new Request(url, { method, headers });

    return { url, request } as unknown as RequestEvent;
}

describe('isCrossSiteFormSubmission', () => {
    describe('plain HTTP on the LAN (adapter-node reports https://<Host> without ORIGIN)', () => {
        const login = 'https://192.168.1.10:3000/api/auth/native/login';

        it('allows the sign-in POST from http://<lan-ip>: only the host is compared', () => {
            expect(
                isCrossSiteFormSubmission(
                    createEvent({
                        targetUrl: login,
                        contentType: 'application/json',
                        origin: 'http://192.168.1.10:3000',
                    }),
                ),
            ).toBe(false);
        });

        it('blocks it when ORIGIN pins another host (ORIGIN must be the URL the browser uses)', () => {
            expect(
                isCrossSiteFormSubmission(
                    createEvent({
                        targetUrl: 'https://media.example.com/api/auth/native/login',
                        contentType: 'application/json',
                        origin: 'http://192.168.1.10:3000',
                    }),
                ),
            ).toBe(true);
        });
    });

    it('blocks a cross-origin form POST with no Origin header', () => {
        expect(isCrossSiteFormSubmission(createEvent({ origin: null }))).toBe(true);
    });

    it('blocks a cross-origin form POST from a foreign Origin', () => {
        expect(isCrossSiteFormSubmission(createEvent({ origin: 'https://evil.example.com' }))).toBe(
            true,
        );
    });

    it('allows a same-origin form POST (host matches, proto differs)', () => {
        // Browser sent https; the Node process may see http behind a TLS proxy.
        // Host match must be enough — a proto mismatch must not 403.
        expect(
            isCrossSiteFormSubmission(
                createEvent({
                    origin: 'http://app.example.com',
                    targetUrl: 'https://app.example.com/some/route',
                }),
            ),
        ).toBe(false);
    });

    it('allows a same-origin form POST (exact origin match)', () => {
        expect(isCrossSiteFormSubmission(createEvent({ origin: 'https://app.example.com' }))).toBe(
            false,
        );
    });

    it('ignores safe methods (GET/HEAD)', () => {
        expect(
            isCrossSiteFormSubmission(createEvent({ method: 'GET', origin: 'https://evil.com' })),
        ).toBe(false);
        expect(
            isCrossSiteFormSubmission(createEvent({ method: 'HEAD', origin: 'https://evil.com' })),
        ).toBe(false);
    });

    it('ignores JSON bodies (CORS-preflight protected, not a form CSRF vector)', () => {
        expect(
            isCrossSiteFormSubmission(
                createEvent({ contentType: 'application/json', origin: 'https://evil.com' }),
            ),
        ).toBe(false);
    });

    it('blocks a text/plain smuggled body cross-origin', () => {
        // text/plain is a CORS-simple type — a JSON-parsing API route could be
        // tricked unless we treat text/plain as a form content type (SvelteKit does).
        expect(
            isCrossSiteFormSubmission(
                createEvent({ contentType: 'text/plain', origin: 'https://evil.com' }),
            ),
        ).toBe(true);
    });

    it('handles content-type with parameters (multipart boundary)', () => {
        expect(
            isCrossSiteFormSubmission(
                createEvent({
                    contentType: 'multipart/form-data; boundary=abc123',
                    origin: 'https://evil.com',
                }),
            ),
        ).toBe(true);
    });

    it.each(['/j/Users/AuthenticateByName', '/subsonic/rest/ping', '/oauth/token'])(
        'exempts self-authenticating cross-origin surface %s',
        (path) => {
            expect(
                isCrossSiteFormSubmission(
                    createEvent({
                        origin: 'https://some-native-client',
                        targetUrl: `https://app.example.com${path}`,
                    }),
                ),
            ).toBe(false);
        },
    );

    it('exempts the plugin-webhook ingress surface', () => {
        // Same criterion as /j, /subsonic and /oauth: the route ignores cookies
        // entirely and authenticates with a per-integration shared secret, so an
        // origin check protects nothing a forged POST could exploit — while
        // blocking the form-encoded bodies real webhook senders post.
        expect(
            isCrossSiteFormSubmission(
                createEvent({
                    origin: 'https://sonarr.example.net',
                    targetUrl: 'https://app.example.com/api/plugin-webhooks/sonarr-relay',
                }),
            ),
        ).toBe(false);
    });

    it('does NOT exempt a plugin-webhook look-alike prefix', () => {
        expect(
            isCrossSiteFormSubmission(
                createEvent({
                    origin: 'https://evil.com',
                    targetUrl: 'https://app.example.com/api/plugin-webhooks-admin/secrets',
                }),
            ),
        ).toBe(true);
    });

    it('does NOT exempt look-alike paths that merely contain an exempt segment', () => {
        // `/api/joke` must not be exempted just because it starts with "/j".
        expect(
            isCrossSiteFormSubmission(
                createEvent({
                    origin: 'https://evil.com',
                    targetUrl: 'https://app.example.com/joker/thing',
                }),
            ),
        ).toBe(true);
    });

    describe('native-auth POST surface (origin-checked regardless of content type)', () => {
        const logout = 'https://app.example.com/api/auth/native/logout';

        it('blocks a forged cross-site logout with NO content type / NO origin', () => {
            expect(
                isCrossSiteFormSubmission(
                    createEvent({ contentType: null, origin: null, targetUrl: logout }),
                ),
            ).toBe(true);
        });

        it('blocks a cross-site logout from a foreign origin', () => {
            expect(
                isCrossSiteFormSubmission(
                    createEvent({
                        contentType: null,
                        origin: 'https://evil.example.com',
                        targetUrl: logout,
                    }),
                ),
            ).toBe(true);
        });

        it('allows a same-origin logout via Origin', () => {
            expect(
                isCrossSiteFormSubmission(
                    createEvent({
                        contentType: null,
                        origin: 'https://app.example.com',
                        targetUrl: logout,
                    }),
                ),
            ).toBe(false);
        });

        it('allows a same-origin login via Referer fallback (Origin absent)', () => {
            expect(
                isCrossSiteFormSubmission(
                    createEvent({
                        contentType: 'application/json',
                        origin: null,
                        referer: 'https://app.example.com/login',
                        targetUrl: 'https://app.example.com/api/auth/native/login',
                    }),
                ),
            ).toBe(false);
        });

        it('blocks a cross-site JSON login from a foreign origin', () => {
            expect(
                isCrossSiteFormSubmission(
                    createEvent({
                        contentType: 'application/json',
                        origin: 'https://evil.example.com',
                        targetUrl: 'https://app.example.com/api/auth/native/login',
                    }),
                ),
            ).toBe(true);
        });
    });

    it('allows a configured trusted CORS origin', () => {
        (config as { CORS_ALLOWED_ORIGINS: string[] }).CORS_ALLOWED_ORIGINS = [
            'https://companion.example.com',
        ];
        try {
            expect(
                isCrossSiteFormSubmission(createEvent({ origin: 'https://companion.example.com' })),
            ).toBe(false);
        } finally {
            (config as { CORS_ALLOWED_ORIGINS: string[] }).CORS_ALLOWED_ORIGINS = [];
        }
    });
});

describe('csrfHandle', () => {
    it('returns 403 for a forged cross-site form post', async () => {
        const resolve = vi.fn();
        const res = await csrfHandle({
            event: createEvent({ origin: 'https://evil.com' }),
            resolve,
        } as never);
        expect(res.status).toBe(403);
        expect(resolve).not.toHaveBeenCalled();
    });

    it('calls resolve for a legitimate same-origin post', async () => {
        const ok = new Response('ok', { status: 200 });
        const resolve = vi.fn().mockResolvedValue(ok);
        const res = await csrfHandle({
            event: createEvent({ origin: 'https://app.example.com' }),
            resolve,
        } as never);
        expect(resolve).toHaveBeenCalledOnce();
        expect(res).toBe(ok);
    });
});

/**
 * Security review 2026-09-12, C1: a request with NO Content-Type is a CORS
 * "simple request" — `fetch(url, { method:'POST', credentials:'include', body: new Blob([...]) })`
 * from any origin sends the cookie with no preflight. Treating an absent header
 * as "not a form, therefore safe" let a cross-site page forge every
 * cookie-authenticated JSON mutation (device-code authorize → token theft).
 * An absent Content-Type must be origin-checked exactly like a form post.
 */
describe('absent Content-Type is a simple request and must be origin-checked', () => {
    const authorize = 'https://app.example.com/api/oauth/authorize';

    it('blocks a cross-site POST with no Content-Type to a non-native path', () => {
        expect(
            isCrossSiteFormSubmission(
                createEvent({
                    contentType: null,
                    origin: 'https://evil.example.com',
                    targetUrl: authorize,
                }),
            ),
        ).toBe(true);
    });

    it('blocks a cross-site POST with no Content-Type and no Origin (Referer-only or stripped)', () => {
        expect(
            isCrossSiteFormSubmission(
                createEvent({ contentType: null, origin: null, targetUrl: authorize }),
            ),
        ).toBe(true);
    });

    it('still allows a same-origin POST with no Content-Type', () => {
        expect(
            isCrossSiteFormSubmission(
                createEvent({
                    contentType: null,
                    origin: 'https://app.example.com',
                    targetUrl: authorize,
                }),
            ),
        ).toBe(false);
    });

    it('still skips the check for a genuine JSON Content-Type (a cross-site one needs a preflight)', () => {
        expect(
            isCrossSiteFormSubmission(
                createEvent({
                    contentType: 'application/json',
                    origin: 'https://evil.example.com',
                    targetUrl: authorize,
                }),
            ),
        ).toBe(false);
    });
});

describe('isCrossSiteFormSubmission — bearer-authenticated native clients', () => {
    /**
     * iOS/tvOS POST `/api/v1/livetv/channels/{id}/keepalive` with a Bearer token
     * and no body, so no Content-Type — which `isFormContentType` deliberately
     * treats as a form (see C1). With no Origin either, every keepalive was
     * 403'd; the viewer got reaped from the channel group and Live TV span
     * forever without producing a frame, silently, because the client does not
     * surface a failed keepalive.
     *
     * The carve-out is sound rather than convenient: CSRF depends on the browser
     * attaching credentials on its own, and Authorization is not a CORS-safelisted
     * request header, so a cross-site page cannot set it without a preflight this
     * server answers.
     */
    it('allows a bodyless POST that carries a Bearer token and no Origin', () => {
        expect(
            isCrossSiteFormSubmission(
                createEvent({
                    contentType: null,
                    origin: null,
                    authorization: 'Bearer pat_deadbeef',
                    targetUrl: 'https://app.example.com/api/v1/livetv/channels/abc/keepalive',
                }),
            ),
        ).toBe(false);
    });

    it('allows a bearer POST even from a foreign Origin', () => {
        // A foreign page cannot attach this header without a preflight, so its
        // presence already proves the request was not forged by ambient auth.
        expect(
            isCrossSiteFormSubmission(
                createEvent({
                    contentType: null,
                    origin: 'https://evil.example.com',
                    authorization: 'Bearer pat_deadbeef',
                }),
            ),
        ).toBe(false);
    });

    // --- negative controls: the C1 hole must stay closed ---

    it('STILL blocks the same request with no Authorization header', () => {
        expect(isCrossSiteFormSubmission(createEvent({ contentType: null, origin: null }))).toBe(
            true,
        );
    });

    it('STILL blocks a cookie-only cross-site form POST', () => {
        expect(
            isCrossSiteFormSubmission(
                createEvent({
                    contentType: 'application/x-www-form-urlencoded',
                    origin: 'https://evil.example.com',
                }),
            ),
        ).toBe(true);
    });

    it('STILL origin-checks the native-login surface, bearer or not', () => {
        expect(
            isCrossSiteFormSubmission(
                createEvent({
                    contentType: null,
                    origin: 'https://evil.example.com',
                    authorization: 'Bearer pat_deadbeef',
                    targetUrl: 'https://app.example.com/api/auth/native/login',
                }),
            ),
        ).toBe(true);
    });
});
