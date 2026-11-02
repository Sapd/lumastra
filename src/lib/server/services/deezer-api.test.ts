// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for the Deezer artist-image client.
 *
 * The behaviour under test is mostly about what it REFUSES to return. Deezer's
 * search is fuzzy and always hands back a popular artist with a real photo, so
 * every guard here is the difference between filling a coverage gap and
 * writing a stranger's face into the catalogue.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetchWithTimeout = vi.fn();
const mockSleep = vi.fn().mockResolvedValue(undefined);

vi.mock('$lib/server/utils/fetch-utils.js', () => ({
    fetchWithTimeout: (...args: unknown[]) => mockFetchWithTimeout(...args),
}));
vi.mock('$lib/server/utils/abortable-sleep.js', () => ({
    sleepOrReject: (ms: number, signal?: AbortSignal) => mockSleep(ms, signal),
}));
vi.mock('$lib/server/tasks/shared-rate-bucket.js', () => ({
    awaitSharedToken: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/server/utils/external-request-counter.js', () => ({
    trackExternalCall: (_url: string, run: () => Promise<Response>) => run(),
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    },
}));

import { searchArtistDeezer, searchAlbumDeezer } from './deezer-api.js';
import { EnrichmentSourceUnavailableError } from './artist-enrichment.types.js';

/** Mirrors RATE_LIMIT_MS in deezer-api.ts (200ms = 5 req/s). */
const RATE_LIMIT_MS = 200;

function pic(hash: string): string {
    return `https://cdn-images.dzcdn.net/images/artist/${hash}/1000x1000-000000-80-0-0.jpg`;
}

function okJson(body: unknown) {
    return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockSleep.mockResolvedValue(undefined);
});

describe('searchArtistDeezer', () => {
    it('returns the picture of an exact name match', async () => {
        mockFetchWithTimeout.mockResolvedValue(
            okJson({ data: [{ id: 1, name: 'DJ Fenwick', picture_xl: pic('abc') }] }),
        );

        const res = await searchArtistDeezer('DJ Fenwick');

        expect(res?.thumbUrl).toBe(pic('abc'));
    });

    it('fills ONLY image fields — Deezer carries no identity metadata', async () => {
        mockFetchWithTimeout.mockResolvedValue(
            okJson({ data: [{ id: 1, name: 'Wavetraxx', picture_xl: pic('abc') }] }),
        );

        const res = await searchArtistDeezer('Wavetraxx');

        expect(res).toEqual({
            thumbUrl: pic('abc'),
            fanartUrl: null,
            bannerUrl: null,
            musicBrainzId: null,
            biography: null,
            genre: null,
            countryCode: null,
        });
    });

    it('finds an exact match ranked below a more popular fuzzy neighbour', async () => {
        // Real shape: the query's true artist is outranked by a bigger name.
        mockFetchWithTimeout.mockResolvedValue(
            okJson({
                data: [
                    { id: 1, name: 'Sauzer', picture_xl: pic('wrong1') },
                    { id: 2, name: 'Dj Auler', picture_xl: pic('wrong2') },
                    { id: 3, name: 'DJ Fenwick', picture_xl: pic('right') },
                ],
            }),
        );

        const res = await searchArtistDeezer('DJ Fenwick');

        expect(res?.thumbUrl).toBe(pic('right'));
    });

    it('returns null rather than a fuzzy near-miss with a real photo', async () => {
        mockFetchWithTimeout.mockResolvedValue(
            okJson({ data: [{ id: 9, name: 'Wildstylez', picture_xl: pic('someoneelse') }] }),
        );

        expect(await searchArtistDeezer('Wildstyles')).toBeNull();
    });

    it('rejects the shared placeholder image (empty hash segment)', async () => {
        mockFetchWithTimeout.mockResolvedValue(
            okJson({
                data: [
                    {
                        id: 1,
                        name: 'Ghost Act',
                        picture_xl:
                            'https://cdn-images.dzcdn.net/images/artist//1000x1000-000000-80-0-0.jpg',
                    },
                ],
            }),
        );

        // Matching the right artist is not enough — a placeholder pointer would
        // pin the row to a blank square and preempt the catalog fallback.
        expect(await searchArtistDeezer('Ghost Act')).toBeNull();
    });

    it('falls back to a smaller size when the largest is a placeholder', async () => {
        mockFetchWithTimeout.mockResolvedValue(
            okJson({
                data: [
                    {
                        id: 1,
                        name: 'Half Art',
                        picture_xl:
                            'https://cdn-images.dzcdn.net/images/artist//1000x1000-000000-80-0-0.jpg',
                        picture_big: pic('real'),
                    },
                ],
            }),
        );

        expect((await searchArtistDeezer('Half Art'))?.thumbUrl).toBe(pic('real'));
    });

    // A failure must never read as "no such artist": the chain tombstones a
    // null for good, which is how a day of failed lookups left artists
    // without images permanently.
    it('reports a 200 response carrying an error payload as unavailable, not a miss', async () => {
        // Deezer signals quota exhaustion with HTTP 200 + {error:{...}}.
        mockFetchWithTimeout.mockResolvedValue(
            okJson({ error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } }),
        );

        await expect(searchArtistDeezer('Anything')).rejects.toBeInstanceOf(
            EnrichmentSourceUnavailableError,
        );
    });

    it('treats the DataException "no data" payload (code 800) as a miss', async () => {
        mockFetchWithTimeout.mockResolvedValue(
            okJson({ error: { type: 'DataException', message: 'no data', code: 800 } }),
        );

        expect(await searchArtistDeezer('Anything')).toBeNull();
    });

    it('accepts the "no data" code as a string too', async () => {
        mockFetchWithTimeout.mockResolvedValue(
            okJson({ error: { type: 'DataException', message: 'no data', code: '800' } }),
        );

        expect(await searchArtistDeezer('Anything')).toBeNull();
    });

    it.each([null, {}, { total: 0 }])(
        'reports a 200 body without a data array (%j) as unavailable',
        async (body) => {
            mockFetchWithTimeout.mockResolvedValue(okJson(body));

            await expect(searchArtistDeezer('Anything')).rejects.toBeInstanceOf(
                EnrichmentSourceUnavailableError,
            );
        },
    );

    it('reports a non-2xx response as unavailable', async () => {
        mockFetchWithTimeout.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });

        await expect(searchArtistDeezer('Anything')).rejects.toMatchObject({
            name: 'EnrichmentSourceUnavailableError',
            source: 'deezer',
            detail: 'HTTP 503',
        });
    });

    it('reports a transport error as unavailable', async () => {
        mockFetchWithTimeout.mockRejectedValue(new Error('ECONNRESET'));

        await expect(searchArtistDeezer('Anything')).rejects.toBeInstanceOf(
            EnrichmentSourceUnavailableError,
        );
    });

    it('rethrows an abort as-is, not as a provider failure', async () => {
        const controller = new AbortController();
        controller.abort();
        const abortErr = new Error('aborted');
        mockFetchWithTimeout.mockRejectedValue(abortErr);

        await expect(searchArtistDeezer('Anything', { signal: controller.signal })).rejects.toBe(
            abortErr,
        );
    });

    it('returns null for an empty result set', async () => {
        mockFetchWithTimeout.mockResolvedValue(okJson({ data: [] }));

        expect(await searchArtistDeezer('Zzzqqq Nonexistent')).toBeNull();
    });

    it('does not call out at all for a blank query', async () => {
        expect(await searchArtistDeezer('   ')).toBeNull();
        expect(mockFetchWithTimeout).not.toHaveBeenCalled();
    });

    it('url-encodes the query and bounds the candidate list', async () => {
        mockFetchWithTimeout.mockResolvedValue(okJson({ data: [] }));

        await searchArtistDeezer('AC/DC & Friends');

        const url = mockFetchWithTimeout.mock.calls[0][0] as string;
        expect(url).toContain('AC%2FDC%20%26%20Friends');
        expect(url).toContain('limit=5');
    });
});

describe('request pacing', () => {
    it('makes a concurrent second caller wait a full interval, not zero', async () => {
        // The pacing used to be a check-then-set on a module-level timestamp:
        // two callers in the same process both read it before either wrote, so
        // both concluded "plenty of time has passed" and fired together. The
        // scheduled drain is sequential, but an admin per-item retry locks on
        // the ITEM id, so a retry can overlap the drain or another retry.
        //
        // Time is pinned because `lastRequestTime` is module state shared with
        // every other test in this file; without that, how long a caller waits
        // is not reproducible.
        vi.useFakeTimers();
        try {
            mockFetchWithTimeout.mockResolvedValue(okJson({ data: [] }));

            // Warm-up stamps a known last-request time, then time advances by
            // LESS than one interval. That matters: the race only shows when
            // both callers take the sleep branch, because the buggy version
            // wrote the timestamp only AFTER awaiting its sleep, leaving the
            // stale value visible to whoever looked in the meantime.
            vi.setSystemTime(new Date(1_000_000));
            await searchArtistDeezer('Warmup');
            vi.setSystemTime(new Date(1_000_050)); // +50ms into a 200ms interval

            mockSleep.mockClear();
            await Promise.all([searchArtistDeezer('First'), searchArtistDeezer('Second')]);

            // Serialised: First waits out the remaining 150ms and reserves;
            // Second then sees a fresh timestamp and waits a whole interval.
            // Racing: both read the same stale timestamp and both wait 150ms,
            // firing together and doubling the outbound rate.
            const waits = mockSleep.mock.calls.map((c) => c[0] as number);
            expect(waits).toEqual([150, RATE_LIMIT_MS]);
            expect(mockFetchWithTimeout).toHaveBeenCalledTimes(3);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not wedge later callers when one is aborted mid-wait', async () => {
        // Pin time inside an interval so the aborted caller really is in its
        // pacing sleep (module state from earlier tests is otherwise stale).
        vi.useFakeTimers();
        try {
            mockFetchWithTimeout.mockResolvedValue(okJson({ data: [] }));
            vi.setSystemTime(new Date(2_000_000));
            await searchArtistDeezer('Warmup');
            vi.setSystemTime(new Date(2_000_050));

            const abortErr = new Error('aborted');
            mockSleep.mockRejectedValueOnce(abortErr);
            const controller = new AbortController();
            controller.abort();

            const first = searchArtistDeezer('Aborted', { signal: controller.signal });
            const second = searchArtistDeezer('Later');

            // The aborted caller gets its abort back, and the pacing chain keeps
            // running for everyone behind it.
            await expect(first).rejects.toBe(abortErr);
            await expect(second).resolves.toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('normalized artist lookup', () => {
    it.each([
        ['Gigi DAgostino', "Gigi D'Agostino", 'gigi d agostino'],
        ['Far*East Movement', 'Far East Movement', 'far east movement'],
    ])('retries %s and matches against the original full name', async (name, candidate, query) => {
        mockFetchWithTimeout
            .mockResolvedValueOnce(okJson({ data: [] }))
            .mockResolvedValueOnce(
                okJson({ data: [{ id: 1, name: candidate, picture_xl: pic('right') }] }),
            );
        expect((await searchArtistDeezer(name))?.thumbUrl).toBe(pic('right'));
        expect(new URL(mockFetchWithTimeout.mock.calls[1][0]).searchParams.get('q')).toBe(query);
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
    });

    it('rejects a near match on both searches', async () => {
        mockFetchWithTimeout.mockResolvedValue(
            okJson({
                data: [{ id: 1, name: "Gigi D'Agostino Jr.", picture_xl: pic('wrong') }],
            }),
        );
        expect(await searchArtistDeezer('Gigi DAgostino')).toBeNull();
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
    });

    it.each(['Makry', 'JTS', 'Makry & JTS'])(
        'rejects %s for a comma credit without retrying',
        async (name) => {
            mockFetchWithTimeout.mockResolvedValueOnce(
                okJson({
                    data: [{ id: 1, name, picture_xl: pic('wrong') }],
                }),
            );
            expect(await searchArtistDeezer('Makry, Jts')).toBeNull();
            expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
        },
    );

    it('accepts an exact joint credit', async () => {
        mockFetchWithTimeout.mockResolvedValueOnce(
            okJson({
                data: [{ id: 1, name: 'Makry, JTS', picture_xl: pic('right') }],
            }),
        );
        expect((await searchArtistDeezer('Makry, Jts'))?.thumbUrl).toBe(pic('right'));
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
    });

    it('preserves retryable errors on the looser query', async () => {
        mockFetchWithTimeout
            .mockResolvedValueOnce(okJson({ data: [] }))
            .mockResolvedValueOnce({ ok: false, status: 503 });
        await expect(searchArtistDeezer('Far*East Movement')).rejects.toMatchObject({
            source: 'deezer',
            detail: 'HTTP 503',
        });
    });
});

describe('searchAlbumDeezer', () => {
    const cover = 'https://cdn-images.dzcdn.net/images/cover/abc/1000x1000.jpg';
    const album = { title: 'Dance with Me', artist: { name: 'Steve Twain' }, cover_xl: cover };

    it('finds the example on one base-title retry, using the largest cover', async () => {
        mockFetchWithTimeout
            .mockResolvedValueOnce(okJson({ data: [] }))
            .mockResolvedValueOnce(okJson({ data: [{ ...album, cover_big: 'smaller' }] }));
        expect(
            (await searchAlbumDeezer('Steve Twain', 'Dance With Me - Incl Discotronic Remix'))
                ?.posterUrl,
        ).toBe(cover);
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
        const queries = mockFetchWithTimeout.mock.calls.map(([url]) =>
            new URL(url).searchParams.get('q'),
        );
        expect(queries).toEqual([
            'artist:"Steve Twain" album:"Dance With Me - Incl Discotronic Remix"',
            'artist:"Steve Twain" album:"dance with me"',
        ]);
    });

    it('keeps a successful full-title lookup to one request', async () => {
        mockFetchWithTimeout.mockResolvedValue(okJson({ data: [album] }));
        expect((await searchAlbumDeezer('Steve Twain', 'Dance With Me (Single)'))?.posterUrl).toBe(
            cover,
        );
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
    });

    it.each([
        { ...album, artist: { name: 'Different Artist' } },
        { ...album, artist: { name: 'Steve Twains' } },
        { ...album, title: 'Dance with You' },
        { ...album, artist: undefined },
    ])('rejects a different identity: %j', async (candidate) => {
        mockFetchWithTimeout.mockResolvedValue(okJson({ data: [candidate] }));
        expect(await searchAlbumDeezer('Steve Twain', 'Dance With Me')).toBeNull();
    });

    it('checks later results and folds artist punctuation without fuzzy matching', async () => {
        mockFetchWithTimeout.mockResolvedValue(
            okJson({
                data: [
                    { ...album, artist: { name: 'Other' } },
                    { ...album, artist: { name: 'Steve-Twain' } },
                ],
            }),
        );
        expect((await searchAlbumDeezer('Steve Twain', 'Dance With Me'))?.posterUrl).toBe(cover);
    });

    it('falls back to cover_big and rejects placeholders or missing covers', async () => {
        mockFetchWithTimeout.mockResolvedValueOnce(
            okJson({
                data: [
                    {
                        ...album,
                        cover_xl: 'https://cdn-images.dzcdn.net/images/cover//1000.jpg',
                        cover_big: cover,
                    },
                ],
            }),
        );
        expect((await searchAlbumDeezer('Steve Twain', 'Dance With Me'))?.posterUrl).toBe(cover);
        mockFetchWithTimeout.mockResolvedValue(okJson({ data: [{ ...album, cover_xl: null }] }));
        expect(await searchAlbumDeezer('Steve Twain', 'Dance With Me')).toBeNull();
    });

    it.each([
        { ok: false, status: 429 },
        okJson({ error: { code: 4, type: 'QuotaException' } }),
        okJson({}),
        {
            ok: true,
            json: async () => {
                throw new Error('bad JSON');
            },
        },
    ])('preserves retryable failure semantics', async (response) => {
        mockFetchWithTimeout.mockResolvedValue(response);
        await expect(searchAlbumDeezer('Steve Twain', 'Dance With Me')).rejects.toBeInstanceOf(
            EnrichmentSourceUnavailableError,
        );
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
    });

    it('treats no-data code 800 as a miss and shares the rate bucket', async () => {
        mockFetchWithTimeout.mockResolvedValue(okJson({ error: { code: 800 } }));
        expect(await searchAlbumDeezer('Steve Twain', 'Dance With Me')).toBeNull();
        const { awaitSharedToken } = await import('$lib/server/tasks/shared-rate-bucket.js');
        expect(awaitSharedToken).toHaveBeenCalledWith('svc:deezer', 5, undefined);
    });

    it('propagates caller cancellation without a second query', async () => {
        const controller = new AbortController();
        const error = new Error('stopped');
        mockFetchWithTimeout.mockImplementationOnce(async () => {
            controller.abort();
            throw error;
        });
        await expect(
            searchAlbumDeezer('Steve Twain', 'Dance With Me (Single)', {
                signal: controller.signal,
            }),
        ).rejects.toBe(error);
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
    });
});
