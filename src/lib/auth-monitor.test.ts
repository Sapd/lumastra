// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Admin IA redesign, spec §7 error-classification fix: network/timeout
 * failures must never be counted as auth (session-expiry) failures, so a
 * flaky network or a stalled admin fetch can never trigger the "Your session
 * has expired" banner. Genuine 401/403 session-expiry signals must still
 * work — this file proves both sides so the fix isn't a blanket disablement.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true, dev: false, version: 'test-version' }));
vi.mock('$app/paths', () => ({ base: '' }));
// auth-monitor.ts imports `url` from the sibling `./paths.js` (its own
// base-path helper, distinct from `$app/paths`). Stub it to identity so
// these tests don't need real SvelteKit path resolution.
vi.mock('./paths.js', () => ({ url: (path: string) => path }));

const { monitoredFetch, isAuthFailed, resetAuthFailure, AUTH_SUPPRESSED_HEADER } =
    await import('./auth-monitor.js');

/** Plain in-memory localStorage shim (happy-dom's is unreliable in some harness configs). */
function installLocalStorageShim(): void {
    const store = new Map<string, string>();
    const mock = {
        getItem: (key: string) => (store.has(key) ? (store.get(key) ?? null) : null),
        setItem: (key: string, value: string) => {
            store.set(key, String(value));
        },
        removeItem: (key: string) => {
            store.delete(key);
        },
        clear: () => {
            store.clear();
        },
        key: (index: number) => Array.from(store.keys())[index] ?? null,
        get length() {
            return store.size;
        },
    };
    Object.defineProperty(window, 'localStorage', {
        value: mock,
        writable: true,
        configurable: true,
    });
}

function codelessUnauthorizedResponse(): Response {
    return new Response(JSON.stringify({ error: 'nope' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
    });
}

describe('monitoredFetch — error classification', () => {
    beforeEach(() => {
        installLocalStorageShim();
        // Force handleAuthExpiration's "reload loop already detected" branch
        // so a genuine auth failure in the contrast test below shows the
        // notification instead of calling window.location.reload() (which
        // happy-dom does not implement).
        window.localStorage.setItem(
            'dashboard-reload-loop-detected',
            JSON.stringify({ timestamp: Date.now(), count: 2 }),
        );
        resetAuthFailure();
        vi.spyOn(Math, 'random').mockReturnValue(0);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        document.getElementById('auth-error-notification')?.remove();
    });

    it('retries an unavailable read with backoff and recovers without expiring the session', async () => {
        vi.useFakeTimers();
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(
                new Response('{}', {
                    status: 503,
                    headers: { 'retry-after': '5', 'X-Lumastra-Auth-Unavailable': 'true' },
                }),
            )
            .mockResolvedValueOnce(new Response('{}', { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);
        try {
            const pending = monitoredFetch('/api/admin/status');
            await vi.advanceTimersByTimeAsync(4999);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);
            expect((await pending).status).toBe(200);
            expect(isAuthFailed()).toBe(false);
            expect(document.getElementById('auth-error-notification')).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('recovers a real API read after 120 seconds, beyond its per-attempt timeout', async () => {
        vi.useFakeTimers();
        const { apiGet } = await import('$lib/api/client.js');
        const { z } = await import('zod');
        const start = Date.now();
        const fetchMock = vi.fn().mockImplementation(async () =>
            Date.now() - start < 120_000
                ? new Response('{}', {
                      status: 503,
                      headers: { 'Retry-After': '5', 'X-Lumastra-Auth-Unavailable': 'true' },
                  })
                : new Response('{"healthy":true}', {
                      headers: { 'Content-Type': 'application/json' },
                  }),
        );
        vi.stubGlobal('fetch', fetchMock);
        try {
            const pending = apiGet('/api/admin/status', z.object({ healthy: z.boolean() }), {
                timeout: 10_000,
            });
            await vi.advanceTimersByTimeAsync(160_000);
            expect(await pending).toMatchObject({
                data: { healthy: true },
                error: null,
                status: 200,
            });
            expect(fetchMock.mock.calls.length).toBeGreaterThan(3);
            expect(isAuthFailed()).toBe(false);
            expect(document.getElementById('auth-error-notification')).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('retries a player session start only when auth rejected it before the handler ran', async () => {
        vi.useFakeTimers();
        const start = Date.now();
        const fetchMock = vi.fn().mockImplementation(async () =>
            Date.now() - start < 120_000
                ? new Response('{}', {
                      status: 503,
                      headers: {
                          'Retry-After': '5',
                          'X-Lumastra-Auth-Retry': 'true',
                          'X-Lumastra-Auth-Unavailable': 'true',
                      },
                  })
                : new Response('{"session":"recovered"}', { status: 201 }),
        );
        vi.stubGlobal('fetch', fetchMock);
        try {
            const pending = monitoredFetch('/api/play-sessions', {
                method: 'POST',
                body: '{"mediaId":"m"}',
            });
            await vi.advanceTimersByTimeAsync(160_000);
            expect((await pending).status).toBe(201);
            expect(isAuthFailed()).toBe(false);
            expect(fetchMock.mock.calls.length).toBeGreaterThan(3);
        } finally {
            vi.useRealTimers();
        }
    });

    it('cancels backoff when the caller aborts and does not replay writes', async () => {
        vi.useFakeTimers();
        const fetchMock = vi
            .fn()
            .mockImplementation(
                async () =>
                    new Response('{}', {
                        status: 503,
                        headers: { 'X-Lumastra-Auth-Unavailable': 'true' },
                    }),
            );
        vi.stubGlobal('fetch', fetchMock);
        const controller = new AbortController();
        try {
            const pending = monitoredFetch('/api/admin/status', { signal: controller.signal });
            const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
            await vi.advanceTimersByTimeAsync(1);
            controller.abort();
            await rejected;
            await vi.advanceTimersByTimeAsync(60_000);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect((await monitoredFetch('/api/tasks/run', { method: 'POST' })).status).toBe(503);
            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(isAuthFailed()).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it.each(['public_api_disabled', 'shutting_down', 'upstream_down'])(
        'returns an unmarked %s 503 without retrying',
        async (code) => {
            const response = new Response(JSON.stringify({ code }), { status: 503 });
            const fetchMock = vi.fn().mockResolvedValue(response);
            vi.stubGlobal('fetch', fetchMock);
            expect(await monitoredFetch('/api/admin/status')).toBe(response);
            expect(fetchMock).toHaveBeenCalledTimes(1);
        },
    );

    it('returns the last readable 503 after a bounded total retry budget', async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn().mockImplementation(
            async () =>
                new Response('{"code":"dependency_unavailable"}', {
                    status: 503,
                    headers: { 'X-Lumastra-Auth-Unavailable': 'true', 'Retry-After': '5' },
                }),
        );
        vi.stubGlobal('fetch', fetchMock);
        try {
            let settled = false;
            const pending = monitoredFetch('/api/admin/status').then((response) => {
                settled = true;
                return response;
            });
            await vi.advanceTimersByTimeAsync(120_000);
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(180_000);
            expect(settled).toBe(true);
            expect((await pending).status).toBe(503);
            expect(await (await pending).json()).toEqual({ code: 'dependency_unavailable' });
            const calls = fetchMock.mock.calls.length;
            await vi.advanceTimersByTimeAsync(300_000);
            expect(fetchMock).toHaveBeenCalledTimes(calls);
            expect(isAuthFailed()).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not reset an existing auth-failure streak on a 503', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(codelessUnauthorizedResponse())
            .mockResolvedValueOnce(codelessUnauthorizedResponse())
            .mockResolvedValueOnce(new Response('{}', { status: 503 }))
            .mockResolvedValueOnce(codelessUnauthorizedResponse())
            .mockResolvedValue(new Response(null, { status: 404 }));
        vi.stubGlobal('fetch', fetchMock);
        for (let i = 0; i < 4; i++) await monitoredFetch('/api/admin/status');
        expect(isAuthFailed()).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it('adds jitter while respecting Retry-After', async () => {
        vi.useFakeTimers();
        vi.mocked(Math.random).mockReturnValue(0.5);
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(
                new Response('{}', {
                    status: 503,
                    headers: { 'X-Lumastra-Auth-Unavailable': 'true', 'Retry-After': '5' },
                }),
            )
            .mockResolvedValueOnce(new Response('{}'));
        vi.stubGlobal('fetch', fetchMock);
        try {
            const pending = monitoredFetch('/api/admin/status');
            await vi.advanceTimersByTimeAsync(5000);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(5000);
            expect((await pending).status).toBe(200);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not turn problem+json permission denials into session expiry', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockImplementation(
                async () =>
                    new Response(JSON.stringify({ code: 'forbidden', status: 403 }), {
                        status: 403,
                        headers: { 'Content-Type': 'application/problem+json' },
                    }),
            ),
        );
        for (let i = 0; i < 6; i++) await monitoredFetch('/api/admin/status');
        expect(isAuthFailed()).toBe(false);
        expect(document.getElementById('auth-error-notification')).toBeNull();
    });

    it('still expires a genuinely invalid problem+json session', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockImplementation(
                async () =>
                    new Response(JSON.stringify({ code: 'invalid_token', status: 401 }), {
                        status: 401,
                        headers: { 'Content-Type': 'application/problem+json' },
                    }),
            ),
        );
        for (let i = 0; i < 3; i++) await monitoredFetch('/api/auth/check');
        expect(isAuthFailed()).toBe(true);
    });

    it('repeated network failures never trip the session-expired state', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

        // Well past MAX_AUTH_FAILURES (3) — if network errors were still
        // (mis)classified as auth-related, this would already have flipped
        // isAuthFailed() to true.
        for (let i = 0; i < 6; i++) {
            await expect(monitoredFetch('/api/admin/status')).rejects.toThrow();
        }

        expect(isAuthFailed()).toBe(false);
    });

    it('repeated timeouts (AbortError) never trip the session-expired state', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockRejectedValue(new DOMException('The operation was aborted', 'AbortError')),
        );

        for (let i = 0; i < 6; i++) {
            await expect(monitoredFetch('/api/admin/status')).rejects.toThrow();
        }

        expect(isAuthFailed()).toBe(false);
    });

    it('a real network failure does not show the auth-expired notification', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

        for (let i = 0; i < 6; i++) {
            await expect(monitoredFetch('/api/admin/status')).rejects.toThrow();
        }

        expect(document.getElementById('auth-error-notification')).toBeNull();
    });

    it('contrast: three genuine codeless 401s still trip the session-expired state', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockImplementation((input: RequestInfo | URL) => {
                const href = typeof input === 'string' ? input : String(input);
                if (href.includes('_app/version.json')) {
                    return Promise.resolve(new Response(null, { status: 404 }));
                }
                return Promise.resolve(codelessUnauthorizedResponse());
            }),
        );

        for (let i = 0; i < 3; i++) {
            await monitoredFetch('/api/admin/status');
        }

        expect(isAuthFailed()).toBe(true);
        // Let handleAuthExpiration's async chain (version check + reload-loop
        // branch) settle before the test tears down, so nothing dangles.
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
});

describe('monitoredFetch — polling stops after session expiry', () => {
    /** The exact 401 the server's missing-auth branch returns for an API path. */
    const serverMissingAuth = (): Response =>
        new Response(JSON.stringify({ error: 'Authentication required', message: 'No session' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', 'X-Auth-Required': 'true' },
        });

    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        installLocalStorageShim();
        window.localStorage.setItem(
            'dashboard-reload-loop-detected',
            JSON.stringify({ timestamp: Date.now(), count: 2 }),
        );
        resetAuthFailure();
        fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
            const href = typeof input === 'string' ? input : String(input);
            if (href.includes('_app/version.json')) {
                return Promise.resolve(new Response(null, { status: 404 }));
            }
            return Promise.resolve(serverMissingAuth());
        });
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        document.getElementById('auth-error-notification')?.remove();
        resetAuthFailure();
    });

    const apiCalls = () =>
        fetchMock.mock.calls.filter((c) => !String(c[0]).includes('_app/version.json')).length;

    async function expire(): Promise<void> {
        for (let i = 0; i < 3; i++) await monitoredFetch('/api/watch-together/parties');
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    it('the real server 401 body trips expiry and shows the session-expired banner', async () => {
        await expire();
        expect(isAuthFailed()).toBe(true);
        expect(document.getElementById('auth-error-notification')).not.toBeNull();
    });

    it('sends no further GETs once expired; answers with a local 401 instead', async () => {
        await expire();
        expect(apiCalls()).toBe(3);

        const res = await monitoredFetch('/api/me/manual-runs');
        expect(res.status).toBe(401);
        expect(res.headers.get(AUTH_SUPPRESSED_HEADER)).toBe('true');
        await monitoredFetch('/api/watch-together/parties');
        expect(apiCalls()).toBe(3);
    });

    it('still lets writes and /api/auth/* through so the user can sign back in', async () => {
        await expire();
        await monitoredFetch('/api/auth/login', { method: 'POST' });
        await monitoredFetch('/api/auth/session');
        await monitoredFetch('/api/some-write', { method: 'POST' });
        expect(apiCalls()).toBe(6);
    });

    it('resumes sending after resetAuthFailure()', async () => {
        await expire();
        resetAuthFailure();
        await monitoredFetch('/api/me/manual-runs');
        expect(apiCalls()).toBe(4);
    });
});
