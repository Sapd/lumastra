// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock $lib/server/utils/fetch-utils.js
vi.mock('$lib/server/utils/fetch-utils.js', () => ({
    fetchWithTimeout: vi.fn(),
}));

// Mock logger to suppress output
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
import {
    searchRecording,
    getRelease,
    getArtist,
    getReleaseGroup,
    type MBRecordingResult,
    type MBRelease,
    type MBArtist,
    type MBReleaseGroup,
} from './api-client.js';

const mockFetchWithTimeout = vi.mocked(fetchWithTimeout);

// MusicBrainz MBIDs are UUIDs — getRelease/getArtist/getReleaseGroup reject
// non-UUID-shaped input before making any request, so every test exercising
// the HTTP path must use a UUID-shaped mbid.
const VALID_MBID = 'b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d';

// Helper: build a mock Response
function mockResponse(body: unknown, ok = true, status = 200): Response {
    return {
        ok,
        status,
        statusText: ok ? 'OK' : 'Error',
        json: vi.fn().mockResolvedValue(body),
    } as unknown as Response;
}

describe('musicbrainz/api-client', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Use fake timers to skip rate-limit delays
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    // Helper: advance time past the rate-limit window so requests don't wait
    function advancePastRateLimit(): void {
        vi.advanceTimersByTime(1200);
    }

    // -------------------------------------------------------------------------
    // searchRecording
    // -------------------------------------------------------------------------
    describe('searchRecording', () => {
        it('returns recordings from a successful API response', async () => {
            advancePastRateLimit();
            const recordings: MBRecordingResult[] = [
                {
                    id: 'rec-id-1',
                    title: 'Harbor Rhapsody',
                    length: 354000,
                    score: 100,
                },
            ];
            mockFetchWithTimeout.mockResolvedValue(
                mockResponse({ count: 1, offset: 0, recordings }),
            );

            const promise = searchRecording('Harbor Rhapsody', 'Queen');
            vi.runAllTimers();
            const result = await promise;

            expect(result).toHaveLength(1);
            expect(result[0].title).toBe('Harbor Rhapsody');
        });

        it('builds query with artist when artist is provided', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(
                mockResponse({ count: 0, offset: 0, recordings: [] }),
            );

            const promise = searchRecording('Yesterday', 'The Lanterns');
            vi.runAllTimers();
            await promise;

            const calledUrl = mockFetchWithTimeout.mock.calls[0]?.[0] as string;
            expect(calledUrl).toContain('recording%3A%22Yesterday%22');
            expect(calledUrl).toContain('artist%3A%22The+Lanterns%22');
        });

        it('builds query without artist when artist is empty string', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(
                mockResponse({ count: 0, offset: 0, recordings: [] }),
            );

            const promise = searchRecording('Yesterday', '');
            vi.runAllTimers();
            await promise;

            const calledUrl = mockFetchWithTimeout.mock.calls[0]?.[0] as string;
            expect(calledUrl).not.toContain('AND+artist');
        });

        it('returns empty array when recordings is absent from response', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(mockResponse({ count: 0, offset: 0 }));

            const promise = searchRecording('Unknown Track', 'Unknown Artist');
            vi.runAllTimers();
            const result = await promise;

            expect(result).toEqual([]);
        });

        it('includes required inc params in URL', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(
                mockResponse({ count: 0, offset: 0, recordings: [] }),
            );

            const promise = searchRecording('Track', 'Artist');
            vi.runAllTimers();
            await promise;

            const calledUrl = mockFetchWithTimeout.mock.calls[0]?.[0] as string;
            expect(calledUrl).toContain('releases');
            expect(calledUrl).toContain('artist-credits');
        });
    });

    // -------------------------------------------------------------------------
    // getRelease
    // -------------------------------------------------------------------------
    describe('getRelease', () => {
        it('returns MBRelease on success', async () => {
            advancePastRateLimit();
            const release: MBRelease = {
                id: VALID_MBID,
                title: 'Abbey Road',
                date: '1969-09-26',
            };
            mockFetchWithTimeout.mockResolvedValue(mockResponse(release));

            const promise = getRelease(VALID_MBID);
            vi.runAllTimers();
            const result = await promise;

            expect(result).not.toBeNull();
            expect((result as MBRelease).title).toBe('Abbey Road');
            expect((result as MBRelease).date).toBe('1969-09-26');
        });

        it('includes the MBID in the request URL (encoded)', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(
                mockResponse({ id: VALID_MBID, title: 'Some Album' }),
            );

            const promise = getRelease(VALID_MBID);
            vi.runAllTimers();
            await promise;

            const calledUrl = mockFetchWithTimeout.mock.calls[0]?.[0] as string;
            expect(calledUrl).toContain(`release/${encodeURIComponent(VALID_MBID)}`);
        });

        it('returns null on a genuine 404 (no such release)', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(mockResponse({}, false, 404));

            const promise = getRelease(VALID_MBID);
            vi.runAllTimers();
            const result = await promise;

            expect(result).toBeNull();
        });

        it('requests correct inc params', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(
                mockResponse({ id: VALID_MBID, title: 'Album' }),
            );

            const promise = getRelease(VALID_MBID);
            vi.runAllTimers();
            await promise;

            const calledUrl = mockFetchWithTimeout.mock.calls[0]?.[0] as string;
            expect(calledUrl).toContain('artist-credits');
            expect(calledUrl).toContain('recordings');
            expect(calledUrl).toContain('release-groups');
        });
    });

    // -------------------------------------------------------------------------
    // getArtist
    // -------------------------------------------------------------------------
    describe('getArtist', () => {
        it('returns MBArtist on success', async () => {
            advancePastRateLimit();
            const artist: MBArtist = {
                id: VALID_MBID,
                name: 'Pink Harbor',
                'sort-name': 'Pink Harbor',
                type: 'Group',
                country: 'GB',
            };
            mockFetchWithTimeout.mockResolvedValue(mockResponse(artist));

            const promise = getArtist(VALID_MBID);
            vi.runAllTimers();
            const result = await promise;

            expect(result).not.toBeNull();
            expect((result as MBArtist).name).toBe('Pink Harbor');
            expect((result as MBArtist).country).toBe('GB');
        });

        it('includes the MBID in the request URL (encoded)', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(
                mockResponse({
                    id: VALID_MBID,
                    name: 'Artist',
                    'sort-name': 'Artist',
                }),
            );

            const promise = getArtist(VALID_MBID);
            vi.runAllTimers();
            await promise;

            const calledUrl = mockFetchWithTimeout.mock.calls[0]?.[0] as string;
            expect(calledUrl).toContain(`artist/${encodeURIComponent(VALID_MBID)}`);
        });

        it('returns null on a genuine 404 (no such artist)', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(mockResponse({}, false, 404));

            const promise = getArtist(VALID_MBID);
            vi.runAllTimers();
            const result = await promise;

            expect(result).toBeNull();
        });

        it('requests release-groups and tags in inc params', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(
                mockResponse({ id: VALID_MBID, name: 'B', 'sort-name': 'B' }),
            );

            const promise = getArtist(VALID_MBID);
            vi.runAllTimers();
            await promise;

            const calledUrl = mockFetchWithTimeout.mock.calls[0]?.[0] as string;
            expect(calledUrl).toContain('release-groups');
            expect(calledUrl).toContain('tags');
        });
    });

    // -------------------------------------------------------------------------
    // getReleaseGroup
    // -------------------------------------------------------------------------
    describe('getReleaseGroup', () => {
        it('returns MBReleaseGroup on success', async () => {
            advancePastRateLimit();
            const releaseGroup: MBReleaseGroup = {
                id: VALID_MBID,
                title: 'The Wall',
                'primary-type': 'Album',
                'first-release-date': '1979-11-30',
            };
            mockFetchWithTimeout.mockResolvedValue(mockResponse(releaseGroup));

            const promise = getReleaseGroup(VALID_MBID);
            vi.runAllTimers();
            const result = await promise;

            expect(result).not.toBeNull();
            expect((result as MBReleaseGroup).title).toBe('The Wall');
            expect((result as MBReleaseGroup)['primary-type']).toBe('Album');
        });

        it('includes the MBID in the request URL (encoded)', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(mockResponse({ id: VALID_MBID, title: 'RG' }));

            const promise = getReleaseGroup(VALID_MBID);
            vi.runAllTimers();
            await promise;

            const calledUrl = mockFetchWithTimeout.mock.calls[0]?.[0] as string;
            expect(calledUrl).toContain(`release-group/${encodeURIComponent(VALID_MBID)}`);
        });

        it('returns null on a genuine 404 (no such release group)', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(mockResponse({}, false, 404));

            const promise = getReleaseGroup(VALID_MBID);
            vi.runAllTimers();
            const result = await promise;

            expect(result).toBeNull();
        });
    });

    // -------------------------------------------------------------------------
    // Rate-limiting behaviour
    // -------------------------------------------------------------------------
    describe('rate limiting', () => {
        it('adds User-Agent header to all requests', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(
                mockResponse({ count: 0, offset: 0, recordings: [] }),
            );

            const promise = searchRecording('Track', 'Artist');
            vi.runAllTimers();
            await promise;

            const calledOptions = mockFetchWithTimeout.mock.calls[0]?.[1] as {
                headers?: Record<string, string>;
            };
            expect(calledOptions?.headers?.['User-Agent']).toMatch(/Lumastra/);
        });

        it('requests JSON format via Accept header', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(
                mockResponse({ count: 0, offset: 0, recordings: [] }),
            );

            const promise = searchRecording('Track', 'Artist');
            vi.runAllTimers();
            await promise;

            const calledOptions = mockFetchWithTimeout.mock.calls[0]?.[1] as {
                headers?: Record<string, string>;
            };
            expect(calledOptions?.headers?.['Accept']).toBe('application/json');
        });

        it('includes fmt=json in the query string', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(mockResponse({ id: VALID_MBID, title: 'B' }));

            const promise = getRelease(VALID_MBID);
            vi.runAllTimers();
            await promise;

            const calledUrl = mockFetchWithTimeout.mock.calls[0]?.[0] as string;
            expect(calledUrl).toContain('fmt=json');
        });
    });

    // -------------------------------------------------------------------------
    // Outage-masking regression (mbGet)
    //
    // Before this fix, `mbGet()` returned `null` on ANY non-ok HTTP response
    // (429, 5xx, other 4xx) — the same value it returns for MusicBrainz's
    // genuine "no such entity" 404. `searchRecording()`/`getRelease()`/etc.
    // then returned `[]`/`null` for a total MusicBrainz outage,
    // indistinguishable from "no matches"/"not found", which enrichment and
    // auto-match flows recorded as a confident negative.
    //
    // These tests lock in the fixed contract:
    //   - 404 (genuine no-data) still resolves to `null`;
    //   - any other non-ok status (429, 5xx) THROWS instead of returning
    //     null/[], and that throw propagates out of every public function;
    //   - a network-level rejection also propagates (not swallowed);
    //   - a malformed (non-UUID) mbid is rejected before any network call.
    // -------------------------------------------------------------------------
    describe('outage-masking regression', () => {
        it('searchRecording() propagates a thrown error on a total outage (503) instead of returning []', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(mockResponse({}, false, 503));

            const promise = searchRecording('Test Song', 'Test Artist');
            vi.runAllTimers();

            await expect(promise).rejects.toThrow(/MusicBrainz request failed/i);
        });

        it('searchRecording() propagates a thrown error on rate-limiting (429)', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(mockResponse({}, false, 429));

            const promise = searchRecording('Test Song', '');
            vi.runAllTimers();

            await expect(promise).rejects.toThrow(/MusicBrainz request failed/i);
        });

        it('searchRecording() propagates a network-level rejection instead of returning []', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockRejectedValue(new Error('Network error'));

            const promise = searchRecording('Track', 'Artist');
            vi.runAllTimers();

            await expect(promise).rejects.toThrow(/Network error/i);
        });

        it('getRelease() throws a distinguishable outage error on 500 (not "not found")', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(mockResponse({}, false, 500));

            const promise = getRelease(VALID_MBID);
            vi.runAllTimers();

            await expect(promise).rejects.toThrow(/MusicBrainz request failed/i);
        });

        it('getRelease() propagates a network-level rejection instead of returning null', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockRejectedValue(new Error('timeout'));

            const promise = getRelease(VALID_MBID);
            vi.runAllTimers();

            await expect(promise).rejects.toThrow(/timeout/i);
        });

        it('getArtist() throws on a 5xx outage instead of returning null', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(mockResponse({}, false, 503));

            const promise = getArtist(VALID_MBID);
            vi.runAllTimers();

            await expect(promise).rejects.toThrow(/MusicBrainz request failed/i);
        });

        it('getReleaseGroup() throws on a 5xx outage instead of returning null', async () => {
            advancePastRateLimit();
            mockFetchWithTimeout.mockResolvedValue(mockResponse({}, false, 500));

            const promise = getReleaseGroup(VALID_MBID);
            vi.runAllTimers();

            await expect(promise).rejects.toThrow(/MusicBrainz request failed/i);
        });

        it('rejects a malformed (non-UUID) mbid before making any network call — getRelease', async () => {
            const result = await getRelease('not-a-real-mbid');
            expect(result).toBeNull();
            expect(mockFetchWithTimeout).not.toHaveBeenCalled();
        });

        it('rejects a malformed (non-UUID) mbid before making any network call — getArtist', async () => {
            const result = await getArtist('also-not-a-mbid');
            expect(result).toBeNull();
            expect(mockFetchWithTimeout).not.toHaveBeenCalled();
        });

        it('rejects a malformed (non-UUID) mbid before making any network call — getReleaseGroup', async () => {
            const result = await getReleaseGroup('123');
            expect(result).toBeNull();
            expect(mockFetchWithTimeout).not.toHaveBeenCalled();
        });
    });
});
