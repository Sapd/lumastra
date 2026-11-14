// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the process-level `unhandledRejection`/`uncaughtException`
 * suppression handlers in hooks.server.ts (H20).
 *
 * The handler bodies are extracted into small exported pure functions
 * (`handleUnhandledRejection`, `handleUncaughtException`) so their
 * log-and-continue behavior can be verified without relying on real
 * `process.emit(...)` events. `$app/environment`'s `building` flag is
 * mocked `true` so the heavy startup block (DB/cache/scheduler bootstrap)
 * is skipped on import — only module-level declarations and the signal/
 * error-handler registrations run.
 *
 * Run: npx vitest run src/hooks.server.test.ts
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { LoggerInstance } from '$lib/server/utils/logger.js';

// ── Module mocks — keep hooks.server.ts's import graph inert on load ───────────

vi.mock('$app/environment', () => ({
    building: true,
    dev: false,
    browser: false,
    version: 'test',
}));

vi.mock('$app/paths', () => ({
    base: '',
    assets: '',
}));

vi.mock('$lib/server/config.js', () => ({
    config: {
        CORS_ALLOWED_ORIGINS: [],
        APP_LOGO_SMALL: '',
        APP_LOGO_FULL: '',
        APP_NAME: 'Lumastra',
        APP_THEME_COLOR: '#000000',
    },
    features: {},
    CACHE_WARMING_ENABLED: false,
    CACHE_WARM_TRENDING: false,
    CACHE_WARM_METADATA: false,
    CACHE_WARM_HERO: false,
    CACHE_WARM_BROWSE: false,
    CACHE_WARM_USERS_LIMIT: 0,
    CACHE_WARM_METADATA_LIMIT: 0,
    CACHE_WARM_ACTIVE_DAYS: 0,
    CACHE_WARM_NIGHTLY_HOUR: 0,
}));

// documentCsp() reads the embed link lists from here. Partial mock over the
// real module so every other export hooks.server.ts touches stays intact.
const configValues: Record<string, unknown> = {};
let configReady = true;
vi.mock('$lib/server/config/config.service.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    get: (key: string) => {
        if (!configReady) throw new Error('[ConfigService] Not initialized.');
        return configValues[key];
    },
}));

vi.mock('$lib/server/services/sessions-cache.service.js', () => ({
    sessionsCacheService: {},
}));

vi.mock('$lib/server/services/connection-status.service.js', () => ({
    connectionStatus: {},
}));

vi.mock('$lib/server/cache/warming.js', () => ({
    startCacheWarming: vi.fn(),
    startNightlyScheduler: vi.fn(),
    stopNightlyScheduler: vi.fn(),
}));

vi.mock('$lib/server/jellyfin/auth.service.js', () => ({
    jellyfinAuthService: {},
}));

vi.mock('$lib/paraglide/server.js', () => ({
    paraglideMiddleware: vi.fn(),
}));

vi.mock('$lib/server/runtime-optimizations.js', () => ({
    applyRuntimeOptimizations: vi.fn(),
    cleanupUndiciAgent: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/operation-mode.js', () => ({
    operationMode: {},
}));

vi.mock('$lib/server/middleware/forward-auth.js', () => ({
    resolveAuth: vi.fn(),
}));

vi.mock('$lib/server/middleware/csrf.js', () => ({
    csrfHandle: vi.fn(),
}));

vi.mock('$lib/server/utils/client-ip.js', () => ({
    warnIfProxyTrustImplicit: vi.fn(),
}));

vi.mock('$lib/server/tasks/metrics.js', async () => ({
    httpRequestDurationSeconds: {
        observe: vi.fn(),
        startTimer: vi.fn(() => vi.fn()),
    },
    // route-policy/shadow.ts registers its counters here.
    tasksRegistry: new (await import('prom-client')).Registry(),
}));

// ── Fake logger ──────────────────────────────────────────────────────────────

function makeFakeLogger(): { logger: LoggerInstance; error: ReturnType<typeof vi.fn> } {
    const error = vi.fn();
    const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error,
        debug: vi.fn(),
    } as unknown as LoggerInstance;
    return { logger, error };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('hooks.server unhandled error suppression (H20)', () => {
    let handleUnhandledRejection: typeof import('./hooks.server.js').handleUnhandledRejection;
    let handleUncaughtException: typeof import('./hooks.server.js').handleUncaughtException;

    beforeAll(async () => {
        const mod = await import('./hooks.server.js');
        handleUnhandledRejection = mod.handleUnhandledRejection;
        handleUncaughtException = mod.handleUncaughtException;
    });

    it('exports both handlers as functions', () => {
        expect(typeof handleUnhandledRejection).toBe('function');
        expect(typeof handleUncaughtException).toBe('function');
    });

    it('handleUncaughtException logs the error and does not throw or exit', () => {
        const { logger, error } = makeFakeLogger();
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
            throw new Error('process.exit should not be called');
        });
        const err = new Error('boom');

        expect(() => handleUncaughtException(err, logger)).not.toThrow();

        expect(error).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith(expect.stringMatching(/uncaught exception/i), err);
        expect(exitSpy).not.toHaveBeenCalled();
        exitSpy.mockRestore();
    });

    it('handleUnhandledRejection logs the reason and does not throw or exit', () => {
        const { logger, error } = makeFakeLogger();
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
            throw new Error('process.exit should not be called');
        });
        const reason = new Error('rejected');

        expect(() => handleUnhandledRejection(reason, logger)).not.toThrow();

        expect(error).toHaveBeenCalledTimes(1);
        expect(error).toHaveBeenCalledWith(
            expect.stringMatching(/unhandled promise rejection/i),
            reason,
        );
        expect(exitSpy).not.toHaveBeenCalled();
        exitSpy.mockRestore();
    });

    it('handleUnhandledRejection wraps a non-Error reason in an Error before logging', () => {
        const { logger, error } = makeFakeLogger();

        expect(() => handleUnhandledRejection('plain string reason', logger)).not.toThrow();

        expect(error).toHaveBeenCalledTimes(1);
        const loggedError = error.mock.calls[0]?.[1] as unknown;
        expect(loggedError).toBeInstanceOf(Error);
        expect((loggedError as Error).message).toBe('plain string reason');
    });
});

// ── The /api/v1 app-layer backstop ───────────────────────────────────────────
//
// The second gate in front of every /api/v1 route: even once forward-auth
// steps aside, an identity-less request is 401'd here unless the path is a
// recognized credential-in-URL bypass. A signed push URL that clears
// forward-auth but not this one is still a dead endpoint, so the push pair
// needs an entry in BOTH — that is why the predicate is shared.

describe('isApiV1RequestAuthorized — integration endpoints', () => {
    // GET /api/v1/integrations/* answers 401 to a request carrying no credential at
    // all: no bypass entry may ever open these admin-token endpoints.
    it.each(['/api/v1/integrations/watch-history?user=testguest', '/api/v1/integrations/homepage'])(
        'rejects an anonymous %s',
        async (path) => {
            const { isApiV1RequestAuthorized } = await import('./hooks.server.js');
            const url = new URL('http://localhost' + path);
            const event = {
                url,
                request: new Request(url, { method: 'GET' }),
                locals: {},
            } as unknown as Parameters<typeof isApiV1RequestAuthorized>[0];
            expect(isApiV1RequestAuthorized(event)).toBe(false);
        },
    );
});

describe('isApiV1RequestAuthorized — user images need a credential', () => {
    const UUID = '8f2b1c34-5d6e-4a7b-8c9d-0e1f2a3b4c5d';
    async function anonymous(path: string): Promise<boolean> {
        const { isApiV1RequestAuthorized } = await import('./hooks.server.js');
        const url = new URL('http://localhost' + path);
        return isApiV1RequestAuthorized({
            url,
            request: new Request(url, { method: 'GET' }),
            locals: {},
        } as unknown as Parameters<typeof isApiV1RequestAuthorized>[0]);
    }

    it.each([
        `/api/v1/users/${UUID}/images`,
        `/api/v1/users/${UUID}/images/avatar`,
        `/api/v1/users/${UUID}/images/avatar?fallback=initials`,
        `/api/v1/users/${UUID}/images/avatar/0`,
        `/api/v1/users/${UUID}/images/avatar?sig=x&expires=9999999999&purpose=image`,
    ])('rejects an anonymous %s', async (path) => {
        expect(await anonymous(path)).toBe(false);
    });

    it('still lets anonymous artwork requests through to their defs', async () => {
        expect(await anonymous(`/api/v1/media/${UUID}/images/poster`)).toBe(true);
    });
});

describe('isApiV1RequestAuthorized — media URL credentials', () => {
    it.each(['stream_token', 'api_key', 'grant'])(
        'does not let an unvalidated %s query bypass the auth backstop',
        async (param) => {
            const { isApiV1RequestAuthorized } = await import('./hooks.server.js');
            const url = new URL(
                `https://example.test/api/v1/playback/grants/private?${param}=secret`,
            );
            const event = {
                url,
                locals: {},
                request: new Request(url),
            } as unknown as Parameters<typeof isApiV1RequestAuthorized>[0];
            expect(isApiV1RequestAuthorized(event)).toBe(false);
        },
    );
});

describe('isApiV1RequestAuthorized — push rich-notification bypass', () => {
    let isApiV1RequestAuthorized: typeof import('./hooks.server.js').isApiV1RequestAuthorized;

    beforeAll(async () => {
        isApiV1RequestAuthorized = (await import('./hooks.server.js')).isApiV1RequestAuthorized;
    });

    const UUID = '8f2b1c34-5d6e-4a7b-8c9d-0e1f2a3b4c5d';

    function anonymousEvent(path: string): Parameters<typeof isApiV1RequestAuthorized>[0] {
        const url = new URL('http://localhost' + path);
        return {
            url,
            request: new Request(url, { method: 'GET' }),
            locals: {},
        } as unknown as Parameters<typeof isApiV1RequestAuthorized>[0];
    }

    it('allows the two signed push routes without any credential in headers', () => {
        expect(
            isApiV1RequestAuthorized(anonymousEvent(`/api/v1/notifications/${UUID}/push-image`)),
        ).toBe(true);
        expect(
            isApiV1RequestAuthorized(
                anonymousEvent(`/api/v1/notifications/${UUID}/push-content/en`),
            ),
        ).toBe(true);
        expect(
            isApiV1RequestAuthorized(
                anonymousEvent(`/api/v1/notifications/${UUID}/push-content/de`),
            ),
        ).toBe(true);
    });

    it('judges a localized or percent-encoded spelling by the route it reaches', () => {
        // `/de/api/v1/…` and `/api/%76%31/…` run the /api/v1 routes, so the
        // allowlist must see the same path the router does (2026-10-07 review).
        for (const prefix of ['/de/api/v1', '/api/%76%31']) {
            expect(
                isApiV1RequestAuthorized(
                    anonymousEvent(`${prefix}/notifications/${UUID}/push-image`),
                ),
            ).toBe(true);
            expect(isApiV1RequestAuthorized(anonymousEvent(`${prefix}/notifications`))).toBe(false);
        }
    });

    it('still rejects near-miss notification paths (no bare-prefix exemption)', () => {
        expect(isApiV1RequestAuthorized(anonymousEvent('/api/v1/notifications'))).toBe(false);
        expect(isApiV1RequestAuthorized(anonymousEvent(`/api/v1/notifications/${UUID}`))).toBe(
            false,
        );
        expect(isApiV1RequestAuthorized(anonymousEvent(`/api/v1/notifications/${UUID}/read`))).toBe(
            false,
        );
        expect(isApiV1RequestAuthorized(anonymousEvent('/api/v1/notifications/push-image'))).toBe(
            false,
        );
        expect(
            isApiV1RequestAuthorized(anonymousEvent('/api/v1/notifications/me/push-image')),
        ).toBe(false);
        expect(
            isApiV1RequestAuthorized(
                anonymousEvent(`/api/v1/notifications/${UUID}/push-content/fr`),
            ),
        ).toBe(false);
    });

    it('leaves unrelated /api/v1 paths gated', () => {
        expect(isApiV1RequestAuthorized(anonymousEvent('/api/v1/music/albums'))).toBe(false);
        expect(isApiV1RequestAuthorized(anonymousEvent('/api/v1/media'))).toBe(false);
    });
});

// ── Content-Security-Policy (security review 2026-09-13, C18) ───────────────
//
// `connect-src … wss:` had zero consumers: no `new WebSocket(` anywhere in
// src/ or static/, and /j/socket never upgrades — it was a dead grant.
// `frame-src *` let ANY origin be framed by this app; the only real embeds
// are YouTube trailers (host: 'https://www.youtube-nocookie.com' in
// video-player-utils.ts, plus the raw <iframe> tags in RequestModal.svelte /
// ModalTrailerOverlay.svelte) — tightened to an explicit host list.

function findDirective(csp: string, name: string): string | undefined {
    return csp
        .split(';')
        .map((d) => d.trim())
        .find((d) => d === name || d.startsWith(`${name} `));
}

describe('Content-Security-Policy directives (security review 2026-09-13, C18)', () => {
    let CSP_DIRECTIVES: typeof import('./hooks.server.js').CSP_DIRECTIVES;
    let mergeRouteCsp: typeof import('./hooks.server.js').mergeRouteCsp;

    beforeAll(async () => {
        const mod = await import('./hooks.server.js');
        CSP_DIRECTIVES = mod.CSP_DIRECTIVES;
        mergeRouteCsp = mod.mergeRouteCsp;
    });

    it('connect-src has no bare ws: or wss: scheme token', () => {
        const connectSrc = findDirective(CSP_DIRECTIVES, 'connect-src');
        expect(connectSrc).toBeDefined();
        expect(connectSrc).not.toMatch(/\b(ws|wss):(\s|;|$)/);
    });

    it('frame-src is an explicit host list, not a wildcard', () => {
        const frameSrc = findDirective(CSP_DIRECTIVES, 'frame-src');
        expect(frameSrc).toBeDefined();
        expect(frameSrc).not.toContain('*');
        expect(frameSrc).toContain('https://www.youtube.com');
        expect(frameSrc).toContain('https://www.youtube-nocookie.com');
    });

    it('every other directive is untouched (frame-ancestors handling stays as-is)', () => {
        expect(findDirective(CSP_DIRECTIVES, 'frame-ancestors')).toBe("frame-ancestors 'self'");
        expect(findDirective(CSP_DIRECTIVES, 'default-src')).toBe("default-src 'self'");
    });

    describe('mergeRouteCsp — per-route frame-ancestors/frame-src overrides', () => {
        it('applies the base CSP unchanged when the route set no CSP', () => {
            expect(mergeRouteCsp(null, CSP_DIRECTIVES)).toBe(CSP_DIRECTIVES);
        });

        it('merges a frame-ancestors-only route CSP into the full base CSP (showcase embed)', () => {
            const routeCsp = 'frame-ancestors https://acme.example.com';
            const merged = mergeRouteCsp(routeCsp, CSP_DIRECTIVES);

            expect(findDirective(merged, 'frame-ancestors')).toBe(
                'frame-ancestors https://acme.example.com',
            );
            // The rest of the hardened base CSP survives the merge.
            expect(findDirective(merged, 'object-src')).toBe("object-src 'none'");
            expect(findDirective(merged, 'script-src')).toContain("'self'");
        });

        it('merges a frame-src-only route CSP into the full base CSP', () => {
            const routeCsp = 'frame-src https://intranet.example.com';
            const merged = mergeRouteCsp(routeCsp, CSP_DIRECTIVES);

            expect(findDirective(merged, 'frame-src')).toBe(
                'frame-src https://intranet.example.com',
            );
            expect(findDirective(merged, 'object-src')).toBe("object-src 'none'");
            expect(findDirective(merged, 'frame-ancestors')).toBe("frame-ancestors 'self'");
        });

        it('merges BOTH frame-ancestors and frame-src when a route sets both', () => {
            const routeCsp =
                'frame-ancestors https://acme.example.com; frame-src https://intranet.example.com';
            const merged = mergeRouteCsp(routeCsp, CSP_DIRECTIVES);

            expect(findDirective(merged, 'frame-ancestors')).toBe(
                'frame-ancestors https://acme.example.com',
            );
            expect(findDirective(merged, 'frame-src')).toBe(
                'frame-src https://intranet.example.com',
            );
        });

        it('preserves a full route-owned CSP verbatim (any other directive present)', () => {
            const routeCsp = "default-src 'none'; script-src 'self'";
            expect(mergeRouteCsp(routeCsp, CSP_DIRECTIVES)).toBe(routeCsp);
        });
    });

    // The /app/[url] embed is reached by a client-side goto() from the dock,
    // which fetches only __data.json — the document keeps the CSP it loaded
    // with. A route-scoped frame-src therefore never applied on the first
    // click (frame blocked until reload). The configured embed origins must be
    // in the policy of EVERY document.
    describe('embed origins in the document-wide frame-src', () => {
        let withEmbedFrameOrigins: typeof import('./hooks.server.js').withEmbedFrameOrigins;
        let documentCsp: typeof import('./hooks.server.js').documentCsp;

        beforeAll(async () => {
            const mod = await import('./hooks.server.js');
            withEmbedFrameOrigins = mod.withEmbedFrameOrigins;
            documentCsp = mod.documentCsp;
        });

        beforeEach(() => {
            configReady = true;
            for (const key of Object.keys(configValues)) delete configValues[key];
        });

        it('appends origins to frame-src and leaves every other directive alone', () => {
            const csp = withEmbedFrameOrigins(CSP_DIRECTIVES, [
                'https://b.example.com',
                'https://a.example.com',
            ]);
            expect(findDirective(csp, 'frame-src')).toBe(
                'frame-src https://www.youtube.com https://www.youtube-nocookie.com https://a.example.com https://b.example.com',
            );
            expect(csp.replace(findDirective(csp, 'frame-src')!, '')).toBe(
                CSP_DIRECTIVES.replace(findDirective(CSP_DIRECTIVES, 'frame-src')!, ''),
            );
        });

        it('drops an origin that could inject another directive', () => {
            const csp = withEmbedFrameOrigins(CSP_DIRECTIVES, [
                "https://x.example.com; script-src 'unsafe-eval'",
                'https://ok.example.com',
            ]);
            expect(findDirective(csp, 'frame-src')).toBe(
                'frame-src https://www.youtube.com https://www.youtube-nocookie.com https://ok.example.com',
            );
            expect(csp).not.toContain("'unsafe-eval'");
        });

        it('documentCsp() carries every configured external link origin', () => {
            configValues.SIDEBAR_LINKS = [
                { url: 'https://arr.example.com/radarr', external: true },
                { url: '/music', external: false },
            ];
            configValues.USER_MENU_LINKS = [{ url: 'https://wiki.example.com/x', external: true }];
            configValues.FOOTER_LINKS = undefined;

            expect(findDirective(documentCsp(), 'frame-src')).toBe(
                'frame-src https://www.youtube.com https://www.youtube-nocookie.com https://arr.example.com https://wiki.example.com',
            );
        });

        it('documentCsp() picks up an admin edit to the links', () => {
            configValues.SIDEBAR_LINKS = [{ url: 'https://old.example.com', external: true }];
            expect(documentCsp()).toContain('https://old.example.com');

            configValues.SIDEBAR_LINKS = [{ url: 'https://new.example.com', external: true }];
            const csp = documentCsp();
            expect(csp).toContain('https://new.example.com');
            expect(csp).not.toContain('https://old.example.com');
        });

        it('documentCsp() falls back to the base policy before config is initialised', () => {
            configReady = false;
            expect(documentCsp()).toBe(CSP_DIRECTIVES);
        });
    });
});

describe('stripPagePreloadLinkHeader — keep response headers under proxy buffers', () => {
    let strip: typeof import('./hooks.server.js').stripPagePreloadLinkHeader;

    beforeAll(async () => {
        strip = (await import('./hooks.server.js')).stripPagePreloadLinkHeader;
    });

    const preloadLink = '<./_app/immutable/entry/start.js>; rel="modulepreload"; nopush';

    it('removes the Link header from a SvelteKit page render', () => {
        const res = new Response('<html></html>', {
            headers: { link: preloadLink, 'x-sveltekit-page': 'true', 'content-type': 'text/html' },
        });
        const out = strip(res);
        expect(out.headers.has('link')).toBe(false);
        expect(out.headers.get('content-type')).toBe('text/html');
    });

    it('keeps a Link header an endpoint set itself (not a page render)', () => {
        const pagination = '</api/v1/items?page=2>; rel="next"';
        const res = new Response('[]', { headers: { link: pagination } });
        expect(strip(res).headers.get('link')).toBe(pagination);
    });

    it('copies a response whose headers are immutable instead of throwing', async () => {
        const res = new Response('body', {
            status: 200,
            headers: { link: preloadLink, 'x-sveltekit-page': 'true' },
        });
        const deleteSpy = vi.spyOn(res.headers, 'delete').mockImplementation(() => {
            throw new TypeError('immutable');
        });
        const out = strip(res);
        expect(deleteSpy).toHaveBeenCalled();
        expect(out).not.toBe(res);
        expect(out.headers.has('link')).toBe(false);
        expect(out.status).toBe(200);
        expect(await out.text()).toBe('body');
    });
});

describe('isImagePath', () => {
    it('treats /j Images only at a real Images route segment', async () => {
        const { isImagePath } = await import('./hooks.server.js');
        const img = '/(modules)/j/Items/[itemId]/Images/[imageType]';
        expect(isImagePath('/j/Items/x/Images/Primary', img)).toBe(true);
        expect(isImagePath('/j/items/x/images/primary', img)).toBe(true);
        expect(isImagePath('/j/web/images/x', '/(modules)/j/web/[...path]')).toBe(false);
        expect(isImagePath('/j/web/Images/x', '/(modules)/j/web/[...path]')).toBe(false);
        expect(isImagePath('/j/web/images/x', null)).toBe(false);
    });

    it('keeps the non-/j image routes unchanged', async () => {
        const { isImagePath } = await import('./hooks.server.js');
        expect(isImagePath('/api/image/abc')).toBe(true);
        expect(isImagePath('/api/v1/media/1/images/poster')).toBe(true);
        expect(isImagePath('/api/v1/media/1')).toBe(false);
    });
});

describe('request-log callback URL redaction', () => {
    it('scrubs device approval codes including case variants', async () => {
        const { logSafePathWithQuery } = await import('./hooks.server.js');
        const url = new URL(
            'https://example.test/api/v1/oauth/device/approve?user_code=ABCD-1234&USER_CODE=WXYZ-6789',
        );
        const logged = logSafePathWithQuery(url);
        expect(logged).not.toContain('ABCD');
        expect(logged).not.toContain('WXYZ');
        expect(url.searchParams.get('user_code')).toBe('ABCD-1234');
    });
    let logSafePathWithQuery: typeof import('./hooks.server.js').logSafePathWithQuery;

    beforeAll(async () => {
        ({ logSafePathWithQuery } = await import('./hooks.server.js'));
    });

    it.each(['/oauth/links/mal/callback', '/auth/oidc/callback'])(
        'redacts OAuth credentials on %s without changing the request URL',
        (path) => {
            const url = new URL(
                `https://example.test${path}?code=private-code&state=private-state&id_token=private-id&access_token=private-access&refresh_token=private-refresh&client_secret=private-secret&error=access_denied`,
            );
            const logged = new URL(logSafePathWithQuery(url), url.origin);
            for (const key of [
                'code',
                'state',
                'id_token',
                'access_token',
                'refresh_token',
                'client_secret',
            ]) {
                expect(logged.searchParams.get(key), key).toBe('[REDACTED]');
            }
            expect(logged.pathname).toBe(path);
            expect(decodeURIComponent(logged.href)).toContain('code=[REDACTED]');
            expect(logged.searchParams.get('error')).toBe('access_denied');
            expect(url.searchParams.get('code')).toBe('private-code');
            expect(logged.href).not.toContain('private-');
        },
    );

    it('redacts grants case-insensitively without altering their request URL', () => {
        const url = new URL(
            'https://example.test/api/v1/playback/media/file?grant=private-grant&GRANT=private-other&quality=high',
        );
        const logged = new URL(logSafePathWithQuery(url), url.origin);
        expect(logged.searchParams.get('grant')).toBe('[REDACTED]');
        expect(logged.searchParams.get('GRANT')).toBe('[REDACTED]');
        expect(logged.searchParams.get('quality')).toBe('high');
        expect(logged.href).not.toContain('private-');
        expect(url.searchParams.get('grant')).toBe('private-grant');
    });

    it('redacts repeated credentials and preserves existing stream-token redaction', () => {
        const url = new URL(
            'https://example.test/j/stream_private-token?code=first&code=second&api_key=private-key&sig=private-sig&limit=20',
        );
        const logged = new URL(logSafePathWithQuery(url), url.origin);
        expect(logged.searchParams.getAll('code')).toEqual(['[REDACTED]']);
        expect(logged.searchParams.get('api_key')).toBe('[REDACTED]');
        expect(logged.searchParams.get('sig')).toBe('[REDACTED]');
        expect(logged.searchParams.get('limit')).toBe('20');
        expect(logged.href).not.toMatch(/private-|first|second/);
    });

    it('redacts credentials whatever the parameter case', () => {
        const url = new URL(
            'https://example.test/j/Items?Api_Key=private-a&APIKEY=private-b&Code=private-c&STATE=private-d&X-Emby-Token=private-e&x-mediabrowser-token=private-f&Limit=5',
        );
        const logged = logSafePathWithQuery(url);
        expect(logged).not.toContain('private-');
        expect(logged).toContain('Limit=5');
    });
});

describe('isApiV1RequestAuthorized — public server discovery', () => {
    it.each(['/api/v1/server', '/api/v1/server/', '/api/%76%31/server'])(
        'allows GET routed to discovery at %s',
        async (path) => {
            const { isApiV1RequestAuthorized } = await import('./hooks.server.js');
            const url = new URL('http://localhost' + path);
            const event = {
                url,
                route: { id: '/api/v1/server' },
                request: new Request(url),
                locals: {},
            } as unknown as Parameters<typeof isApiV1RequestAuthorized>[0];
            expect(isApiV1RequestAuthorized(event)).toBe(true);
        },
    );

    it.each([
        ['POST', '/api/v1/server'],
        ['GET', '/api/v1/server/notice'],
        ['GET', null],
    ] as const)('keeps %s with route %s behind the existing gate', async (method, routeId) => {
        const { isApiV1RequestAuthorized } = await import('./hooks.server.js');
        const url = new URL('http://localhost/api/v1/server');
        const event = {
            url,
            route: { id: routeId },
            request: new Request(url, { method }),
            locals: {},
        } as unknown as Parameters<typeof isApiV1RequestAuthorized>[0];
        expect(isApiV1RequestAuthorized(event)).toBe(false);
    });
});

describe('server discovery method, routed-id and CORS boundaries', () => {
    it.each([
        ['/api/v1/server', '/api/v1/server', true],
        ['/api/v1/server/', '/api/v1/server', true],
        ['/api/v1/%73erver', '/api/v1/server', true],
        ['/api/v1//server', '/api/v1/server', true],
        ['/api/v1/server//', null, false],
        ['/api/v1/%73erver', null, false],
        ['/api/v1/server/notice', '/api/v1/server/notice', false],
    ] as const)('%s uses only its routed identity %s', async (path, routeId, expected) => {
        const { isApiV1RequestAuthorized } = await import('./hooks.server.js');
        for (const method of ['GET', 'HEAD']) {
            const url = new URL(`http://localhost${path}`);
            const event = {
                url,
                route: { id: routeId },
                request: new Request(url, { method }),
                locals: {},
            };
            expect(isApiV1RequestAuthorized(event as never)).toBe(expected);
        }
    });
    it('grants CORS methods to v1 including HEAD, and none to the cookie mirror', async () => {
        const { corsAllowedMethods } = await import('./hooks.server.js');
        expect(corsAllowedMethods('/api/v1/server')?.split(', ')).toContain('HEAD');
        expect(corsAllowedMethods('/api/server')).toBeNull();
        expect(corsAllowedMethods('/api/server/')).toBeNull();
    });
});

describe('isApiV1RequestAuthorized — retired singular audiobook byte paths', () => {
    const BOOK = '2b1f8e0e-0000-0000-0000-000000000001';
    async function anonymous(method: string, path: string): Promise<boolean> {
        const { isApiV1RequestAuthorized } = await import('./hooks.server.js');
        const url = new URL('http://localhost' + path);
        return isApiV1RequestAuthorized({
            url,
            request: new Request(url, { method }),
            locals: {},
        } as unknown as Parameters<typeof isApiV1RequestAuthorized>[0]);
    }

    it.each(['GET', 'HEAD'])('lets an anonymous %s reach the 410 answer', async (method) => {
        expect(await anonymous(method, `/api/v1/audiobook/${BOOK}/file/5193`)).toBe(true);
        expect(await anonymous(method, `/api/v1/audiobook/${BOOK}/remux/5193`)).toBe(true);
    });

    it('keeps other methods on the old paths behind a credential', async () => {
        expect(await anonymous('POST', `/api/v1/audiobook/${BOOK}/file/5193`)).toBe(false);
    });
});
