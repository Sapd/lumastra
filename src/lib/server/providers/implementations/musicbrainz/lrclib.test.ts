// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('$lib/server/utils/fetch-utils.js', () => ({
    fetchWithTimeout: vi.fn(),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        })),
    },
}));

import { fetchWithTimeout } from '$lib/server/utils/fetch-utils.js';
import { getLyrics, getLyricsByMusicBrainzId } from './lrclib.js';

const mockFetchWithTimeout = vi.mocked(fetchWithTimeout);

function mockResponse(body: unknown, ok = true, status = 200): Response {
    return {
        ok,
        status,
        statusText: ok ? 'OK' : 'Error',
        json: vi.fn().mockResolvedValue(body),
    } as unknown as Response;
}

describe('musicbrainz/lrclib', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    function advancePastRateLimit(): void {
        vi.advanceTimersByTime(300);
    }

    it.each(['7200', 'http-date'])('carries Retry-After to callers (%s)', async (value) => {
        await vi.advanceTimersByTimeAsync(1000);
        const header =
            value === 'http-date' ? new Date(Date.now() + 7_200_000).toUTCString() : value;
        const response = new Response(null, { status: 429, headers: { 'Retry-After': header } });
        const readHeader = response.headers.get.bind(response.headers);
        let parsedAt = 0;
        vi.spyOn(response.headers, 'get').mockImplementation((name) => {
            parsedAt = Date.now();
            return readHeader(name);
        });
        mockFetchWithTimeout.mockResolvedValue(response);
        const promise = getLyrics({ artistName: 'Artist', trackTitle: 'Track' });
        const assertion = expect(promise).rejects.toMatchObject({
            status: 429,
            retryAfterMs: expect.any(Number),
        });
        await vi.runAllTimersAsync();
        await assertion;
        await expect(promise).rejects.toMatchObject({
            retryAfterMs: value === 'http-date' ? Date.parse(header) - parsedAt : 7_200_000,
        });
    });

    describe('getLyrics', () => {
        it('returns lyrics on a successful response', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(
                mockResponse({ plainLyrics: 'la la la', syncedLyrics: '[00:01.00]la la la' }),
            );

            const promise = getLyrics({ artistName: 'Queen', trackTitle: 'Harbor Rhapsody' });
            vi.runAllTimers();
            const result = await promise;

            expect(result).toEqual({
                plainLyrics: 'la la la',
                syncedLyrics: '[00:01.00]la la la',
            });
        });

        it('returns null on a genuine 404 (no lyrics for this track)', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(mockResponse({}, false, 404));

            const promise = getLyrics({ artistName: 'Unknown', trackTitle: 'Unknown' });
            vi.runAllTimers();
            const result = await promise;

            expect(result).toBeNull();
        });

        it('returns null when both plain and synced lyrics are empty', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(
                mockResponse({ plainLyrics: null, syncedLyrics: null }),
            );

            const promise = getLyrics({ artistName: 'Artist', trackTitle: 'Track' });
            vi.runAllTimers();
            const result = await promise;

            expect(result).toBeNull();
        });
    });

    describe('LRCLIB validation limits', () => {
        it('getLyrics() returns null without fetching when duration exceeds 3600 s', async () => {
            const result = await getLyrics({
                artistName: 'DJ',
                trackTitle: 'Long Mix',
                duration: 4798,
            });

            expect(result).toBeNull();
            expect(mockFetchWithTimeout).not.toHaveBeenCalled();
        });

        it('getLyrics() still fetches at exactly 3600 s', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(mockResponse({ plainLyrics: 'x' }));

            const promise = getLyrics({ artistName: 'A', trackTitle: 'T', duration: 3600 });
            vi.runAllTimers();

            await expect(promise).resolves.toEqual({ plainLyrics: 'x', syncedLyrics: null });
        });

        it('getLyrics() treats a 400 ValidationError as a miss (null, no throw)', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(mockResponse({}, false, 400));

            const promise = getLyrics({ artistName: 'A', trackTitle: 'T', duration: 200 });
            vi.runAllTimers();

            await expect(promise).resolves.toBeNull();
        });
    });

    describe('getLyricsByMusicBrainzId', () => {
        it('returns lyrics on a successful response', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(
                mockResponse({ plainLyrics: 'lyrics text', syncedLyrics: null }),
            );

            const promise = getLyricsByMusicBrainzId('rec-mbid-1');
            vi.runAllTimers();
            const result = await promise;

            expect(result).toEqual({ plainLyrics: 'lyrics text', syncedLyrics: null });
        });

        it('returns null on a genuine 404', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(mockResponse({}, false, 404));

            const promise = getLyricsByMusicBrainzId('rec-mbid-missing');
            vi.runAllTimers();
            const result = await promise;

            expect(result).toBeNull();
        });
    });

    // -------------------------------------------------------------------------
    // Outage-masking regression (lrcGet)
    //
    // Before this fix, `lrcGet()` returned `null` on ANY non-ok HTTP response
    // (429, 5xx, other 4xx) — the same value it returns for LRCLIB's genuine
    // "no lyrics for this track" 404. `getLyrics()` /
    // `getLyricsByMusicBrainzId()` then returned `null` for a total LRCLIB
    // outage, indistinguishable from "no lyrics available", silently
    // swallowing the outage forever.
    //
    // Fixed contract: 404 still resolves to `null`; any other non-ok status
    // (429, 5xx) or a network-level rejection THROWS instead.
    // -------------------------------------------------------------------------
    describe('outage-masking regression', () => {
        it('getLyrics() propagates a thrown error on a total outage (503) instead of returning null', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(mockResponse({}, false, 503));

            const promise = getLyrics({ artistName: 'Artist', trackTitle: 'Track' });
            vi.runAllTimers();

            await expect(promise).rejects.toThrow(/LRCLIB request failed/i);
        });

        it('getLyrics() propagates a thrown error on rate-limiting (429)', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(mockResponse({}, false, 429));

            const promise = getLyrics({ artistName: 'Artist', trackTitle: 'Track' });
            vi.runAllTimers();

            await expect(promise).rejects.toThrow(/LRCLIB request failed/i);
        });

        it('getLyrics() propagates a network-level rejection instead of returning null', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockRejectedValue(new Error('Network error'));

            const promise = getLyrics({ artistName: 'Artist', trackTitle: 'Track' });
            vi.runAllTimers();

            await expect(promise).rejects.toThrow(/Network error/i);
        });

        it('getLyricsByMusicBrainzId() propagates a thrown error on a 5xx outage instead of returning null', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(mockResponse({}, false, 500));

            const promise = getLyricsByMusicBrainzId('rec-mbid-1');
            vi.runAllTimers();

            await expect(promise).rejects.toThrow(/LRCLIB request failed/i);
        });

        it('still resolves to null (no throw) on a genuine 404 for getLyricsByMusicBrainzId', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(mockResponse({}, false, 404));

            const promise = getLyricsByMusicBrainzId('rec-mbid-missing');
            vi.runAllTimers();
            const result = await promise;

            expect(result).toBeNull();
        });
    });
});
