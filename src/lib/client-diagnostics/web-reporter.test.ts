// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diagnosticEventBatchSchema } from '$lib/schemas/client-diagnostics.js';

const env = vi.hoisted(() => ({ browser: true }));
vi.mock('$app/environment', () => ({
    get browser() {
        return env.browser;
    },
    version: '2026.10.21-abc',
}));
vi.mock('$app/paths', () => ({ base: '' }));

const uuid = '6f1c1e0a-7b2d-4c7e-9a51-0d6c2b1f9e11';
const SECRETS = [
    'GRANTSECRET',
    'APIKEYSECRET',
    'TOKSECRET',
    'AbCdEf1234567890XyZq',
    'jane@example.com',
    'inception',
    'denis',
    'Ab3dE9',
];

type Reporter = typeof import('./web-reporter.js');
let r: Reporter;

function sentBatches(): { events: Record<string, unknown>[] }[] {
    return vi
        .mocked(fetch)
        .mock.calls.map(([, init]) => JSON.parse(init!.body as string) as { events: [] });
}
function sentEvents(): Record<string, unknown>[] {
    return sentBatches().flatMap((b) => b.events);
}
function allBodies(): string {
    return vi
        .mocked(fetch)
        .mock.calls.map(([, init]) => String(init!.body))
        .join('\n');
}
function expectValidBatches(): void {
    for (const batch of sentBatches()) {
        expect(diagnosticEventBatchSchema.safeParse(batch).success).toBe(true);
    }
}
const fail500 = (endpoint = `/api/media/${uuid}`, status = 500): void =>
    r.reportApiFailure({ endpoint, method: 'GET', outcome: 'status_5xx', status });

describe('web diagnostics reporter', () => {
    beforeEach(async () => {
        vi.resetModules();
        vi.useFakeTimers();
        env.browser = true;
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 202 })));
        r = await import('./web-reporter.js');
        r.setClientDiagnosticsEnabled(true);
    });
    afterEach(() => {
        r.resetClientDiagnosticsForTests();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    describe('redaction', () => {
        it('never sends a grant, token, api_key, name or path token from a failed URL', async () => {
            r.reportApiFailure({
                endpoint: `/api/media/${uuid}/stream/master.m3u8?grant=GRANTSECRET&api_key=APIKEYSECRET`,
                method: 'GET',
                outcome: 'status_5xx',
                status: 502,
                problemCode: 'bad_gateway',
                requestId: 'req-1',
            });
            r.reportApiFailure({
                endpoint:
                    'https://lumastra.test/api/share/AbCdEf1234567890XyZq/items?token=TOKSECRET#frag',
                method: 'POST',
                outcome: 'status_4xx',
                status: 404,
            });
            r.reportApiFailure({
                endpoint: '/api/items/tmdb:550:movie/rating',
                method: 'PUT',
                outcome: 'status_4xx',
                status: 409,
            });
            r.reportApiFailure({
                endpoint: '/api/search/inception',
                method: 'GET',
                outcome: 'status_5xx',
                status: 500,
            });
            r.reportApiFailure({
                endpoint: '/api/users/denis/avatar',
                method: 'GET',
                outcome: 'status_4xx',
                status: 404,
            });
            r.reportApiFailure({
                endpoint: '/api/media/Ab3dE9',
                method: 'GET',
                outcome: 'status_4xx',
                status: 404,
            });
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS);

            const body = allBodies();
            for (const secret of SECRETS) expect(body).not.toContain(secret);
            expect(body).not.toContain('tmdb:550');
            expect(body).not.toContain('?');
            const routes = sentEvents().map((e) => (e.payload as { route: string }).route);
            expect(routes).toEqual([
                '/api/media/:id/stream/master.m3u8',
                '/api/:id/:id/items',
                '/api/items/:id/rating',
                '/api/search/:id',
                '/api/users/:id/avatar',
                '/api/media/:id',
            ]);
            expectValidBatches();
        });

        it('scrubs credentials, query strings, tokens and e-mail addresses out of error text', async () => {
            const err = new Error(
                'GET https://lumastra.test/api/x?api_key=APIKEYSECRET failed for jane@example.com; ' +
                    'Authorization: Bearer TOKSECRET; ?grant=GRANTSECRET {"grant":"GRANTSECRET"} ' +
                    'key AbCdEf1234567890XyZqAbCdEf1234567890 for ' +
                    uuid,
            );
            err.stack = `Error: boom\n    at load (https://lumastra.test/_app/chunk.js?token=TOKSECRET:1:2)`;
            r.reportJsError('unhandled_rejection', err);
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS);

            const body = allBodies();
            for (const secret of SECRETS) expect(body).not.toContain(secret);
            const [event] = sentEvents();
            expect(event).toMatchObject({
                kind: 'js_error',
                platform: 'web',
                appVersion: '2026.10.21-abc',
                payload: { origin: 'unhandled_rejection', name: 'Error' },
            });
            // Media ids stay: they are what makes a report actionable.
            expect((event.payload as { message: string }).message).toContain(uuid);
            expectValidBatches();
        });

        it('scrubs a huge message without stalling and keeps it under the wire cap', async () => {
            const huge = new Error('/a'.repeat(500_000));
            const started = performance.now();
            r.reportJsError('window_error', huge);
            expect(performance.now() - started).toBeLessThan(1_000);
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS);
            expectValidBatches();
        });

        it('names the page by route template, never by the visited path', async () => {
            r.setClientDiagnosticsRoute('/(app)/search/[query]');
            r.reportJsError('window_error', new TypeError('x is undefined'));
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS);
            expect(sentEvents()[0].payload).toMatchObject({ route: '/(app)/search/[query]' });
        });

        it('falls back to the templated location before the router knows the route', async () => {
            vi.stubGlobal('location', { pathname: '/search/inception', origin: 'https://x.test' });
            r.reportJsError('window_error', new TypeError('early'));
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS);
            expect(sentEvents()[0].payload).toMatchObject({ route: '/search/:id' });
        });
    });

    describe('dedupe and occurrences', () => {
        it('folds repeats into one event and reports later repeats at most every interval', async () => {
            for (let i = 0; i < 5; i++) fail500();
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS);
            expect(sentEvents()).toHaveLength(1);
            expect(sentEvents()[0].occurrences).toBe(5);

            // Within the repeat interval: counted, not sent.
            for (let i = 0; i < 3; i++) fail500();
            await vi.advanceTimersByTimeAsync(60_000);
            expect(sentEvents()).toHaveLength(1);

            // After it: one follow-up carrying every suppressed repeat.
            await vi.advanceTimersByTimeAsync(r.REPEAT_INTERVAL_MS);
            fail500();
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS);
            expect(sentEvents()).toHaveLength(2);
            expect(sentEvents()[1].occurrences).toBe(4);
            expect(new Set(sentEvents().map((e) => e.eventId)).size).toBe(2);
        });

        it('keeps different statuses apart and folds numbers in error messages together', async () => {
            fail500(undefined, 500);
            fail500(undefined, 503);
            r.reportJsError('window_error', new Error('item 4821 missing'));
            r.reportJsError('window_error', new Error('item 9012 missing'));
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS);
            expect(sentEvents().filter((e) => e.kind === 'api_failures')).toHaveLength(2);
            const js = sentEvents().filter((e) => e.kind === 'js_error');
            expect(js).toHaveLength(1);
            expect(js[0].occurrences).toBe(2);
        });

        it('evicts an idle key instead of going silent once the key cap is reached', async () => {
            for (let i = 0; i < r.MAX_KEYS; i++) {
                r.recordDiagnostic(
                    `k${i}`,
                    () => ({
                        kind: 'js_error',
                        platform: 'web',
                        eventId: '',
                        occurredAt: Date.now(),
                        payload: { name: 'E', message: `m${i}`, origin: 'window_error' },
                    }),
                    i % 2 === 0 ? 'api' : 'js',
                );
            }
            await vi.advanceTimersByTimeAsync(r.RATE_WINDOW_MS + r.FLUSH_DELAY_MS * 10);
            vi.mocked(fetch).mockClear();
            r.reportJsError('window_error', new Error('a new regression'));
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS);
            expect(sentEvents().map((e) => (e.payload as { message: string }).message)).toEqual([
                'a new regression',
            ]);
        });
    });

    describe('rate limit and batching', () => {
        it('caps API failures per tab per window without starving error reports', async () => {
            for (let i = 0; i < 45; i++) fail500(undefined, 500 + i);
            r.reportJsError('window_error', new Error('still reported'));
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS * 3);
            expect(sentEvents().filter((e) => e.kind === 'api_failures')).toHaveLength(r.RATE_MAX);
            expect(sentEvents().filter((e) => e.kind === 'js_error')).toHaveLength(1);
            expectValidBatches();

            // A new window, a new budget.
            await vi.advanceTimersByTimeAsync(r.RATE_WINDOW_MS);
            fail500(undefined, 599);
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS);
            expect(sentEvents().filter((e) => e.kind === 'api_failures')).toHaveLength(
                r.RATE_MAX + 1,
            );
        });

        it('retries a rate-limited batch once, a minute later', async () => {
            vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 429 }));
            fail500();
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS);
            expect(fetch).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(fetch).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(5 * 60_000);
            expect(fetch).toHaveBeenCalledTimes(2);
        });

        it('sends a batch too large for keepalive as a plain request', async () => {
            for (let i = 0; i < 16; i++) {
                const e = new Error(`${String.fromCharCode(65 + i)} distinct ${'x'.repeat(400)}`);
                e.stack = 'y'.repeat(4_000);
                r.reportJsError('window_error', e);
            }
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS);
            const [, init] = vi.mocked(fetch).mock.calls[0];
            expect(init!.keepalive).toBe(false);
        });
    });

    describe('opt-out', () => {
        it('holds reports until the admin switch is known, then sends them', async () => {
            r.resetClientDiagnosticsForTests();
            fail500();
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS * 3);
            expect(fetch).not.toHaveBeenCalled();
            r.setClientDiagnosticsEnabled(true);
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS);
            expect(sentEvents()).toHaveLength(1);
        });

        it('sends nothing once the switch is off, and drops what was held', async () => {
            r.resetClientDiagnosticsForTests();
            r.reportJsError('window_error', new Error('queued before the layout knew'));
            r.setClientDiagnosticsEnabled(false);
            r.reportJsError('window_error', new Error('after'));
            fail500();
            r.reportUserFacingFailure({ key: 'music_playback_failed' });
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS * 2);
            expect(fetch).not.toHaveBeenCalled();
        });

        it('forgets counts from before a sign-out', async () => {
            fail500();
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS);
            fail500();
            fail500();
            r.setClientDiagnosticsEnabled(false);
            r.setClientDiagnosticsEnabled(true);
            fail500();
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS);
            expect(sentEvents()).toHaveLength(2);
            expect(sentEvents()[1].occurrences).toBe(1);
        });

        it('does nothing outside the browser', async () => {
            env.browser = false;
            r.reportJsError('window_error', new Error('ssr'));
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS);
            expect(fetch).not.toHaveBeenCalled();
        });
    });

    describe('expected failures and noise', () => {
        it('skips network failures while offline and never reports its own sink', async () => {
            vi.stubGlobal('navigator', { onLine: false });
            r.reportApiFailure({ endpoint: '/api/media', method: 'GET', outcome: 'network' });
            r.reportApiFailure({
                endpoint: '/api/diagnostics/events',
                method: 'POST',
                outcome: 'status_5xx',
                status: 500,
            });
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS);
            expect(fetch).not.toHaveBeenCalled();
        });

        it('ignores aborts, browser noise, extension and cross-origin scripts', async () => {
            r.reportJsError('unhandled_rejection', new DOMException('aborted', 'AbortError'));
            r.reportJsError(
                'window_error',
                new Error('ResizeObserver loop completed with undelivered notifications.'),
            );
            const ext = new Error('from an extension');
            ext.stack = 'Error\n    at x (chrome-extension://abcdef/content.js:1:1)';
            r.reportJsError('window_error', ext);
            vi.stubGlobal('location', { origin: 'https://lumastra.test', pathname: '/' });
            r.reportJsError('window_error', new Error('injected'), 'https://ads.example/x.js');
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS);
            expect(fetch).not.toHaveBeenCalled();
        });

        it('reports a rejected non-Error by type only', async () => {
            r.reportJsError('unhandled_rejection', { status: 500, body: 'secret body' });
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS);
            expect(sentEvents()[0].payload).toMatchObject({ name: 'object', message: '' });
            expect(allBodies()).not.toContain('secret body');
        });

        it('swallows transport failures', async () => {
            vi.mocked(fetch).mockRejectedValue(new TypeError('offline'));
            r.reportJsError('window_error', new Error('x'));
            await expect(vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS)).resolves.not.toThrow();
        });
    });

    describe('page lifecycle', () => {
        let win: EventTarget;
        let doc: EventTarget & { visibilityState: string };
        beforeEach(() => {
            win = new EventTarget();
            doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
            vi.stubGlobal('window', win);
            vi.stubGlobal('document', doc);
        });
        const network = (): void =>
            r.reportApiFailure({ endpoint: '/api/media', method: 'GET', outcome: 'network' });

        it('does not blame the server for requests cut off by leaving or hiding the page', async () => {
            fail500(); // installs the listeners
            win.dispatchEvent(new Event('beforeunload'));
            network();
            win.dispatchEvent(new Event('pageshow'));
            doc.visibilityState = 'hidden';
            network();
            doc.visibilityState = 'visible';
            doc.dispatchEvent(new Event('visibilitychange'));
            network(); // just resumed
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS);
            expect(
                sentEvents().filter(
                    (e) => e.payload && (e.payload as { outcome: string }).outcome === 'network',
                ),
            ).toHaveLength(0);

            await vi.advanceTimersByTimeAsync(5_000);
            network();
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS);
            expect(
                sentEvents().filter(
                    (e) => (e.payload as { outcome: string }).outcome === 'network',
                ),
            ).toHaveLength(1);
        });

        it('sends suppressed repeat counts when the tab closes', async () => {
            fail500();
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS);
            fail500();
            fail500();
            doc.visibilityState = 'hidden';
            doc.dispatchEvent(new Event('visibilitychange'));
            await vi.advanceTimersByTimeAsync(0);
            expect(sentEvents()).toHaveLength(1); // a mere hide inside the interval sends nothing
            win.dispatchEvent(new Event('pagehide'));
            await vi.advanceTimersByTimeAsync(0);
            expect(sentEvents()).toHaveLength(2);
            expect(sentEvents()[1].occurrences).toBe(2);
        });
    });

    describe('failures shown to the user', () => {
        it('reports the toast key with the API call that failed just before', async () => {
            r.setClientDiagnosticsRoute('/(app)/+page');
            r.reportApiFailure({
                endpoint: `/api/v1/play-sessions?grant=GRANTSECRET`,
                method: 'POST',
                outcome: 'status_4xx',
                status: 403,
                problemCode: 'forbidden',
            });
            r.reportUserFacingFailure({
                key: 'audiobook_session_failed',
                error: new Error('No AudiobookShelf link'),
            });
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS);
            const toast = sentEvents().find((e) => e.kind === 'js_error')!;
            expect(toast.payload).toMatchObject({
                origin: 'error_toast',
                toastKey: 'audiobook_session_failed',
                route: '/(app)/+page',
                message: 'No AudiobookShelf link',
                cause: {
                    method: 'POST',
                    route: '/api/v1/play-sessions',
                    outcome: 'status_4xx',
                    status: 403,
                    problemCode: 'forbidden',
                },
            });
            expect(allBodies()).not.toContain('GRANTSECRET');
            expectValidBatches();
        });

        it('lets the tagged report stand for the untagged toast the caller shows right after', async () => {
            r.reportUserFacingFailure({ key: 'audiobook_session_failed' });
            r.reportUserFacingFailure({});
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS);
            expect(sentEvents()).toHaveLength(1);

            await vi.advanceTimersByTimeAsync(10_000);
            r.reportUserFacingFailure({});
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS);
            expect(sentEvents()[1].payload).toMatchObject({ toastKey: 'untagged' });
        });

        it('drops a key that is display text rather than a message key', async () => {
            r.reportUserFacingFailure({ key: "Couldn't add My Private Title" });
            await vi.advanceTimersByTimeAsync(r.FLUSH_DELAY_MS);
            expect(sentEvents()[0].payload).toMatchObject({ toastKey: 'untagged' });
            expect(allBodies()).not.toContain('Private');
        });
    });
});
