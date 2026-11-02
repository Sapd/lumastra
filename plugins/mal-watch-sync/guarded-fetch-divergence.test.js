// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Global fix-plan constraint #1's escape clause: "Where collapsing is
 * genuinely unsafe, say why in the task report and add a test that fails if
 * the copies diverge." mal-watch-sync/index.js keeps its OWN minimal
 * `guardedFetch` (exported only for this test) for the one call `ctx.http`
 * cannot express (PATCH) — it cannot import the shared
 * `$lib/server/utils/fetch-utils.js` implementation at RUNTIME (a plugin
 * loads via a standalone `import()` from `$PLUGINS_*_DIR`, isolated module
 * resolution), so the two are hand-copied twins by necessity. This TEST,
 * however, runs under vitest's ordinary module resolution and can import
 * both — so it runs the identical scenario table against each and fails the
 * moment they disagree.
 *
 * C22 fix round 1 review caught the first version of this local copy
 * diverging from fetch-utils.ts on day one: no `stripBodyHeaders()` on a
 * 301/302/303 method downgrade, no 307/308 unresendable-stream refusal, no
 * timeout, and a plain `Error` instead of a distinguishable type. Every one
 * of those is covered below.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { guardedFetch as malGuardedFetch, MalRedirectError } from './index.js';
import { fetchWithTimeout, FetchRedirectError } from '$lib/server/utils/fetch-utils.js';

/** Normalises an outcome from either implementation for comparison. */
async function classify(promise) {
    try {
        const res = await promise;
        return { ok: true, status: res.status, body: await res.text() };
    } catch (err) {
        if (err instanceof MalRedirectError || err instanceof FetchRedirectError) {
            return { ok: false, kind: err.reason };
        }
        return {
            ok: false,
            kind: 'other',
            message: err instanceof Error ? err.message : String(err),
        };
    }
}

function redirectResponse(location, status = 302) {
    return new Response(null, { status, headers: { location } });
}

describe('MAL guardedFetch vs fetch-utils.ts fetchWithTimeout — divergence guard', () => {
    let mockFetch;

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    async function runBoth(scenario) {
        mockFetch = vi.fn(scenario);
        vi.stubGlobal('fetch', mockFetch);
        const malOutcome = await classify(
            malGuardedFetch('https://mal.example.com/api', { method: 'PATCH' }),
        );

        mockFetch = vi.fn(scenario);
        vi.stubGlobal('fetch', mockFetch);
        const sharedOutcome = await classify(
            fetchWithTimeout('https://mal.example.com/api', { method: 'PATCH' }),
        );

        return { malOutcome, sharedOutcome };
    }

    it('cross-host redirect: both refuse with reason "cross-origin"', async () => {
        const { malOutcome, sharedOutcome } = await runBoth(() =>
            Promise.resolve(redirectResponse('http://evil.example.com/other')),
        );
        expect(malOutcome).toEqual({ ok: false, kind: 'cross-origin' });
        expect(sharedOutcome).toEqual({ ok: false, kind: 'cross-origin' });
    });

    it('same-host scheme downgrade (https -> http): both refuse with reason "cross-origin"', async () => {
        const { malOutcome, sharedOutcome } = await runBoth(() =>
            Promise.resolve(redirectResponse('http://mal.example.com/other')),
        );
        expect(malOutcome).toEqual({ ok: false, kind: 'cross-origin' });
        expect(sharedOutcome).toEqual({ ok: false, kind: 'cross-origin' });
    });

    it('same-host scheme upgrade (http -> https): both follow and return the final body', async () => {
        let call = 0;
        const { malOutcome, sharedOutcome } = await runBoth(() => {
            call += 1;
            return Promise.resolve(
                call === 1
                    ? redirectResponse('https://mal.example.com/other')
                    : new Response('final', { status: 200 }),
            );
        });
        expect(malOutcome).toEqual({ ok: true, status: 200, body: 'final' });
        expect(sharedOutcome).toEqual({ ok: true, status: 200, body: 'final' });
    });

    it('hop limit exceeded: both refuse with reason "redirect-limit-exceeded"', async () => {
        const { malOutcome, sharedOutcome } = await runBoth(() =>
            Promise.resolve(redirectResponse('https://mal.example.com/loop')),
        );
        expect(malOutcome).toEqual({ ok: false, kind: 'redirect-limit-exceeded' });
        expect(sharedOutcome).toEqual({ ok: false, kind: 'redirect-limit-exceeded' });
    });

    it('301 downgrades a non-GET method to GET and STRIPS content-type/content-length', async () => {
        const seenHeaders = { mal: null, shared: null };

        mockFetch = vi.fn((url, opts) => {
            if (mockFetch.mock.calls.length === 2) seenHeaders.mal = new Headers(opts.headers);
            return Promise.resolve(
                mockFetch.mock.calls.length === 1
                    ? redirectResponse('https://mal.example.com/other', 301)
                    : new Response('final', { status: 200 }),
            );
        });
        vi.stubGlobal('fetch', mockFetch);
        await malGuardedFetch('https://mal.example.com/api', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Keep': '1' },
            body: 'status=completed',
        });

        mockFetch = vi.fn((url, opts) => {
            if (mockFetch.mock.calls.length === 2) seenHeaders.shared = new Headers(opts.headers);
            return Promise.resolve(
                mockFetch.mock.calls.length === 1
                    ? redirectResponse('https://mal.example.com/other', 301)
                    : new Response('final', { status: 200 }),
            );
        });
        vi.stubGlobal('fetch', mockFetch);
        await fetchWithTimeout('https://mal.example.com/api', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Keep': '1' },
            body: 'status=completed',
        });

        for (const h of [seenHeaders.mal, seenHeaders.shared]) {
            expect(h.has('content-type')).toBe(false);
            expect(h.has('content-length')).toBe(false);
            expect(h.get('x-keep')).toBe('1');
        }
    });

    it('307 with a ReadableStream body: both refuse with reason "unresendable-body"', async () => {
        const stream = new ReadableStream();
        mockFetch = vi
            .fn()
            .mockResolvedValueOnce(redirectResponse('https://mal.example.com/other', 307));
        vi.stubGlobal('fetch', mockFetch);
        const malOutcome = await classify(
            malGuardedFetch('https://mal.example.com/api', {
                method: 'PATCH',
                body: stream,
            }),
        );

        mockFetch = vi
            .fn()
            .mockResolvedValueOnce(redirectResponse('https://mal.example.com/other', 307));
        vi.stubGlobal('fetch', mockFetch);
        const sharedOutcome = await classify(
            fetchWithTimeout('https://mal.example.com/api', {
                method: 'PATCH',
                body: stream,
                // @ts-expect-error duplex is required by undici for a stream body
                duplex: 'half',
            }),
        );

        expect(malOutcome).toEqual({ ok: false, kind: 'unresendable-body' });
        expect(sharedOutcome).toEqual({ ok: false, kind: 'unresendable-body' });
    });

    it('timeout: both throw a timeout-shaped error (not a plain redirect error) on an unresponsive host', async () => {
        vi.useFakeTimers();
        mockFetch = vi.fn(
            (_url, opts) =>
                new Promise((_resolve, reject) => {
                    opts.signal?.addEventListener('abort', () => {
                        const err = new Error('The operation was aborted');
                        err.name = 'AbortError';
                        reject(err);
                    });
                }),
        );
        vi.stubGlobal('fetch', mockFetch);

        const malPromise = classify(
            malGuardedFetch('https://mal.example.com/api', { method: 'PATCH' }),
        );
        await vi.advanceTimersByTimeAsync(30_000);
        const malOutcome = await malPromise;

        mockFetch = vi.fn(
            (_url, opts) =>
                new Promise((_resolve, reject) => {
                    opts.signal?.addEventListener('abort', () => {
                        const err = new Error('The operation was aborted');
                        err.name = 'AbortError';
                        reject(err);
                    });
                }),
        );
        vi.stubGlobal('fetch', mockFetch);
        const sharedPromise = classify(
            fetchWithTimeout('https://mal.example.com/api', { method: 'PATCH' }, 30_000),
        );
        await vi.advanceTimersByTimeAsync(30_000);
        const sharedOutcome = await sharedPromise;

        vi.useRealTimers();

        // Neither classifies as a FetchRedirectError/MalRedirectError — both
        // are a DIFFERENT (timeout) error type, proving the timeout path
        // exists at all (its absence was the round-1 finding for MAL).
        expect(malOutcome.ok).toBe(false);
        expect(malOutcome.kind).toBe('other');
        expect(sharedOutcome.ok).toBe(false);
        expect(sharedOutcome.kind).toBe('other');
    });
});
