// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Exercise the production hook sequence with real forward-auth and CSRF gates.
// Skip process startup; no account or media dependency should be consulted.

import { describe, it, expect, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

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

vi.mock('$lib/server/config.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/config.js')>()),
    config: {
        CORS_ALLOWED_ORIGINS: [],
        APP_LOGO_SMALL: '',
        APP_LOGO_FULL: '',
        APP_NAME: 'Lumastra',
        APP_THEME_COLOR: '#000000',
    },
    features: { deviceAuth: true },
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
    paraglideMiddleware: (
        request: Request,
        next: (value: { request: Request; locale: string }) => unknown,
    ) => next({ request, locale: 'en' }),
}));

vi.mock('$lib/server/runtime-optimizations.js', () => ({
    applyRuntimeOptimizations: vi.fn(),
    cleanupUndiciAgent: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/operation-mode.js', () => ({
    operationMode: {},
}));

vi.mock('$lib/server/tasks/metrics.js', async () => ({
    httpRequestDurationSeconds: {
        observe: vi.fn(),
        startTimer: vi.fn(() => vi.fn()),
    },
    // route-policy/shadow.ts registers its counters here.
    tasksRegistry: new (await import('prom-client')).Registry(),
}));

import { handle } from './hooks.server.js';
import * as fileRoute from './routes/api/v1/audiobook/[mediaId]/file/[ino]/+server.js';
import * as remuxRoute from './routes/api/v1/audiobook/[mediaId]/remux/[ino]/+server.js';

async function throughHooks(method: string, path: string): Promise<Response> {
    const url = new URL(path, 'https://test.invalid');
    const event = {
        url,
        request: new Request(url, {
            method,
            headers: { origin: url.origin, 'content-type': 'application/json' },
        }),
        locals: {},
        params: { mediaId: 'unknown', ino: '1' },
        route: {
            id:
                '/api/v1/audiobook/[mediaId]/' +
                (path.includes('/remux/') ? 'remux' : 'file') +
                '/[ino]',
        },
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: vi.fn(),
            delete: vi.fn(),
            serialize: vi.fn(),
        },
        getClientAddress: () => '127.0.0.1',
        setHeaders: vi.fn(),
        isDataRequest: false,
        isSubRequest: false,
    } as unknown as RequestEvent;
    // sequence() expects the request context normally installed by SvelteKit.
    // This internal runtime helper has no published TypeScript declaration.
    const { with_request_store } = await vi.importActual<{
        with_request_store: (store: unknown, run: () => Promise<Response>) => Promise<Response>;
    }>('@sveltejs/kit/internal/server');
    return with_request_store(
        {
            event,
            state: {
                tracing: {
                    record_span: ({ fn }: { fn: () => Promise<Response> }) => fn(),
                },
            },
        },
        async () =>
            handle({
                event,
                resolve: async (resolved) => {
                    const route = path.includes('/remux/') ? remuxRoute : fileRoute;
                    if (method !== 'GET' && method !== 'HEAD')
                        throw new Error('Unauthenticated method reached route');
                    return route[method](resolved);
                },
            }),
    );
}

describe('retired audiobook routes through real hooks and forward-auth', () => {
    it.each(['file', 'remux'])(
        'GET and HEAD /%s return the retirement response without credentials',
        async (route) => {
            const path = `/api/v1/audiobook/unknown/${route}/1`;
            const get = await throughHooks('GET', path);
            expect(get.status).toBe(410);
            expect(await get.json()).toMatchObject({ code: 'route_retired' });
            const head = await throughHooks('HEAD', path);
            expect(head.status).toBe(410);
            expect(await head.text()).toBe('');
        },
    );
    it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])(
        '%s still requires credentials',
        async (method) => {
            expect((await throughHooks(method, '/api/v1/audiobook/unknown/file/1')).status).toBe(
                401,
            );
        },
    );
    it.each([
        '/api/v1/audiobook/unknown/file/1/extra',
        '/api/v1/audiobook/unknown/remux/1/extra',
        '/api/v1/audiobook/file/bookmarks',
        '/api/v1/audiobook/unknown',
    ])('%s stays bearer-gated', async (path) => {
        expect((await throughHooks('GET', path)).status).toBe(401);
    });
});
