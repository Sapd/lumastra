// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Each provider client must report its calls to the counter: inside a task
// scope (cost_breakdown) and on the request path (hourly Valkey stats).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/utils/fetch-utils.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/utils/fetch-utils.js')>()),
    fetchWithTimeout: vi.fn(),
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    },
}));
const hIncrBy = vi.hoisted(() => vi.fn(async () => 1));
vi.mock('$lib/server/cache/valkey.js', () => ({
    hIncrBy,
    hGetAll: vi.fn(async () => ({})),
    expire: vi.fn(async () => true),
}));

import { fetchWithTimeout } from '$lib/server/utils/fetch-utils.js';
import { withExternalRequestCount, withRequestPathCallScope } from './external-request-counter.js';
import { flushRequestPathCalls } from './external-request-stats.js';
import { searchRecording } from '$lib/server/providers/implementations/musicbrainz/api-client.js';
import { getLyrics } from '$lib/server/providers/implementations/musicbrainz/lrclib.js';

const mockFetch = vi.mocked(fetchWithTimeout);

function respond(status: number, body: unknown = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('provider clients report to the external-call counter', () => {
    beforeEach(() => {
        mockFetch.mockReset();
        hIncrBy.mockClear();
    });

    it('MusicBrainz: a 429 inside a task scope is counted as a rate-limited error', async () => {
        mockFetch.mockResolvedValueOnce(respond(429));
        const counts = await withExternalRequestCount(async () => {
            await searchRecording('Song', 'Artist').catch(() => undefined);
        });
        expect(counts.byHost.get('musicbrainz.org')).toBe(1);
        expect(counts.rateLimitedByHost.get('musicbrainz.org')).toBe(1);
        expect(counts.errorsByHost.get('musicbrainz.org')).toBe(1);
    });

    it('MusicBrainz: a 200 on the request path lands in the hourly stats', async () => {
        mockFetch.mockResolvedValueOnce(respond(200, { recordings: [] }));
        await withRequestPathCallScope(() => searchRecording('Song', 'Artist'));
        await flushRequestPathCalls();
        expect(hIncrBy).toHaveBeenCalledWith(
            expect.stringMatching(/^extcall:h:/),
            'musicbrainz.org|ok',
            1,
        );
    });

    it('LRCLIB: a network failure is counted as a network error', async () => {
        mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
        const counts = await withExternalRequestCount(async () => {
            await getLyrics({ artistName: 'A', trackTitle: 'B' }).catch(() => undefined);
        });
        expect(counts.byHost.get('lrclib.net')).toBe(1);
        expect(counts.errorsByHost.get('lrclib.net')).toBe(1);
    });
});
