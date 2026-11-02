// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const recordRequestPathCall = vi.hoisted(() => vi.fn());
vi.mock('./external-request-stats.js', () => ({ recordRequestPathCall }));

import {
    classifyExternalCallStatus,
    countExternalCall,
    trackExternalCall,
    withExternalCallCounting,
    withExternalRequestCount,
} from './external-request-counter.js';

describe('classifyExternalCallStatus', () => {
    it('maps statuses onto outcome classes', () => {
        expect(classifyExternalCallStatus(200)).toBe('ok');
        expect(classifyExternalCallStatus(302)).toBe('ok');
        expect(classifyExternalCallStatus(404)).toBe('not_found');
        expect(classifyExternalCallStatus(429)).toBe('rate_limited');
        expect(classifyExternalCallStatus(503)).toBe('server_error');
        expect(classifyExternalCallStatus(null)).toBe('network_error');
    });
});

describe('external-request-counter scoped counting', () => {
    beforeEach(() => recordRequestPathCall.mockClear());

    it('counts calls per host with errors and 429s split out', async () => {
        const counts = await withExternalRequestCount(async () => {
            countExternalCall('https://api.themoviedb.org/3/movie/550', 200);
            countExternalCall('https://api.themoviedb.org/3/movie/551', 429);
            countExternalCall('https://api.themoviedb.org/3/movie/552', 500);
            countExternalCall('https://musicbrainz.org/ws/2/recording', null);
            return 'done';
        });

        expect(counts.result).toBe('done');
        expect(counts.total).toBe(4);
        expect(counts.byHost.get('api.themoviedb.org')).toBe(3);
        expect(counts.errorsByHost.get('api.themoviedb.org')).toBe(2);
        expect(counts.rateLimitedByHost.get('api.themoviedb.org')).toBe(1);
        expect(counts.errorsByHost.get('musicbrainz.org')).toBe(1);
        expect(counts.rateLimitedByHost.has('musicbrainz.org')).toBe(false);
        expect(recordRequestPathCall).not.toHaveBeenCalled();
    });

    it('buckets an unparseable URL under "unknown" rather than throwing', async () => {
        const counts = await withExternalRequestCount(async () => {
            countExternalCall('not a url', 200);
        });
        expect(counts.total).toBe(1);
        expect(counts.byHost.get('unknown')).toBe(1);
    });

    it('isolates counts between concurrent scopes', async () => {
        const slow = withExternalRequestCount(async () => {
            countExternalCall('https://api.themoviedb.org/a', 200);
            await new Promise((r) => setTimeout(r, 20));
            countExternalCall('https://api.themoviedb.org/b', 429);
        });
        const fast = withExternalRequestCount(async () => {
            countExternalCall('https://ws.audioscrobbler.com/2.0/', 200);
        });
        const [s, f] = await Promise.all([slow, fast]);
        expect(s.total).toBe(2);
        expect(s.rateLimitedByHost.get('api.themoviedb.org')).toBe(1);
        expect(f.total).toBe(1);
        expect(f.byHost.get('ws.audioscrobbler.com')).toBe(1);
    });
});

describe('external-request-counter request path', () => {
    beforeEach(() => recordRequestPathCall.mockClear());

    it('ignores background calls without a request or task scope', () => {
        countExternalCall('https://lrclib.net/api/get', 200);
        expect(recordRequestPathCall).not.toHaveBeenCalled();
    });

    it('records allowlisted provider hosts in an explicit request scope', async () => {
        const { withRequestPathCallScope } = await import('./external-request-counter.js');
        await withRequestPathCallScope(async () => {
            countExternalCall('https://coverartarchive.org/release/x/front', 429);
            countExternalCall('https://api.acoustid.org/v2/lookup', null);
        });
        expect(recordRequestPathCall).toHaveBeenCalledWith('coverartarchive.org', 'rate_limited');
        expect(recordRequestPathCall).toHaveBeenCalledWith('api.acoustid.org', 'network_error');
    });

    it('ignores non-provider hosts outside a task scope (Jellyfin, image uploads, etc.)', () => {
        countExternalCall('http://jellyfin.internal:8096/Items', 200);
        countExternalCall('https://example.com/poster.jpg', 200);
        expect(recordRequestPathCall).not.toHaveBeenCalled();
    });
});

describe('trackExternalCall / withExternalCallCounting', () => {
    beforeEach(() => recordRequestPathCall.mockClear());

    it('classifies the resolved response status', async () => {
        const counts = await withExternalRequestCount(async () => {
            const res = await trackExternalCall('https://lrclib.net/api/get', async () => {
                return new Response('{}', { status: 429 });
            });
            expect(res.status).toBe(429);
        });
        expect(counts.rateLimitedByHost.get('lrclib.net')).toBe(1);
        expect(counts.errorsByHost.get('lrclib.net')).toBe(1);
    });

    it('classifies a rejected call as a network error and rethrows', async () => {
        const counts = await withExternalRequestCount(async () => {
            await expect(
                trackExternalCall('https://lrclib.net/api/get', async () => {
                    throw new TypeError('fetch failed');
                }),
            ).rejects.toThrow('fetch failed');
        });
        expect(counts.byHost.get('lrclib.net')).toBe(1);
        expect(counts.errorsByHost.get('lrclib.net')).toBe(1);
        expect(counts.rateLimitedByHost.has('lrclib.net')).toBe(false);
    });

    it('does not count a rejection caused by the caller aborting', async () => {
        const controller = new AbortController();
        controller.abort();
        const counts = await withExternalRequestCount(async () => {
            await expect(
                trackExternalCall(
                    'https://lrclib.net/api/get',
                    async () => {
                        throw new DOMException('aborted', 'AbortError');
                    },
                    controller.signal,
                ),
            ).rejects.toThrow();
        });
        expect(counts.total).toBe(0);
    });

    it('wraps a typeof-fetch implementation so each SDK call is counted', async () => {
        const impl = vi.fn(async () => new Response('x', { status: 503 }));
        const wrapped = withExternalCallCounting(impl as unknown as typeof fetch);
        const counts = await withExternalRequestCount(async () => {
            await wrapped('https://api.openai.com/v1/embeddings', { method: 'POST' });
        });
        expect(impl).toHaveBeenCalledOnce();
        expect(counts.errorsByHost.get('api.openai.com')).toBe(1);
    });
});

it('keeps 404s separate from provider errors in task counts', async () => {
    const counts = await withExternalRequestCount(async () => {
        for (const host of ['lrclib.net', 'musicbrainz.org', 'api.deezer.com', 'image.tmdb.org']) {
            countExternalCall(`https://${host}/missing`, 404);
        }
    });
    expect(counts.total).toBe(4);
    expect(counts.errorsByHost.size).toBe(0);
});

it('honours a Request signal and lets init.signal override it', async () => {
    const controller = new AbortController();
    controller.abort();
    const input = new Request('https://api.openai.com/v1/embeddings', {
        signal: controller.signal,
    });
    const wrapped = withExternalCallCounting(async () => {
        throw new Error('aborted');
    });
    const counts = await withExternalRequestCount(async () => {
        await wrapped(input).catch(() => undefined);
        await wrapped(input, { signal: new AbortController().signal }).catch(() => undefined);
        await wrapped(input, { signal: null }).catch(() => undefined);
    });
    expect(counts.total).toBe(2);
    expect(counts.errorsByHost.get('api.openai.com')).toBe(2);
});

it('does not leak detached work from a completed request into live counts', async () => {
    const { withRequestPathCallScope } = await import('./external-request-counter.js');
    recordRequestPathCall.mockClear();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
        release = resolve;
    });
    let detached!: Promise<void>;
    await withRequestPathCallScope(async () => {
        detached = wait.then(() => countExternalCall('https://lrclib.net/api/get', 200));
    });
    release();
    await detached;
    expect(recordRequestPathCall).not.toHaveBeenCalled();
});
