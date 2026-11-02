// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest';
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/utils/fetch-utils.js', () => ({ fetchWithTimeout: fetchMock }));
vi.mock('$lib/server/utils/abortable-sleep.js', () => ({
    sleepOrReject: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/server/tasks/shared-rate-bucket.js', () => ({
    awaitSharedToken: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/server/utils/external-request-counter.js', () => ({
    trackExternalCall: (_url: string, run: () => Promise<Response>) => run(),
}));
import { searchArtistDiscogs, searchReleaseDiscogs } from './discogs-api';
import { EnrichmentSourceUnavailableError } from './artist-enrichment.types.js';
beforeEach(() => {
    vi.resetAllMocks();
});
const match = {
    id: 42,
    type: 'artist',
    title: 'Artist',
    thumb: 'https://cdn.example/thumb.jpg',
    cover_image: 'https://cdn.example/cover.jpg',
    resource_url: 'https://evil.example',
};
describe('Discogs catalogue identity', () => {
    it.each(['http', 'network', 'json'])(
        'retains the artist source on %s detail failure',
        async (failure) => {
            fetchMock.mockResolvedValueOnce(Response.json({ results: [match] }));
            if (failure === 'network') fetchMock.mockRejectedValueOnce(new Error('offline'));
            else
                fetchMock.mockResolvedValueOnce(
                    failure === 'http'
                        ? new Response('', { status: 500 })
                        : new Response('invalid'),
                );
            const result = await searchArtistDiscogs('Artist', 'token');
            expect(result?.thumbUrl).toBe(match.cover_image);
            expect(result?.provenance?.thumbUrl?.url).toBe('https://www.discogs.com/artist/42');
            expect(fetchMock.mock.calls[1][0]).toBe('https://api.discogs.com/artists/42');
        },
    );
    it('keeps release identity and fallback credit', async () => {
        fetchMock
            .mockResolvedValueOnce(
                Response.json({
                    results: [{ ...match, type: 'release', title: 'Artist - Album' }],
                }),
            )
            .mockResolvedValueOnce(new Response('', { status: 503 }));
        const result = await searchReleaseDiscogs('Artist', 'Album', 'token');
        expect(result?.releaseId).toBe('42');
        expect(result?.provenance?.posterUrl?.url).toBe('https://www.discogs.com/release/42');
    });
    it('uses detail release identity for successfully fetched images', async () => {
        fetchMock
            .mockResolvedValueOnce(
                Response.json({
                    results: [{ ...match, type: 'release', title: 'Artist - Album' }],
                }),
            )
            .mockResolvedValueOnce(
                Response.json({
                    id: 42,
                    images: [
                        { type: 'primary', uri: 'https://cdn.example/poster.jpg' },
                        { type: 'secondary', uri: 'https://cdn.example/backdrop.jpg' },
                    ],
                }),
            );
        const result = await searchReleaseDiscogs('Artist', 'Album', 'token');
        expect(result?.provenance?.backdropUrl?.url).toBe('https://www.discogs.com/release/42');
    });
    it('rejects invalid search identities without issuing a detail request', async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ results: [{ ...match, id: -1 }] }));
        expect(await searchArtistDiscogs('Artist', 'token')).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
describe('searchArtistDiscogs failures', () => {
    // A failed search must not read as "no such artist": the enrichment chain
    // tombstones a null permanently.
    it('reports a rate-limited search as unavailable', async () => {
        fetchMock.mockResolvedValueOnce(new Response('', { status: 429 }));
        await expect(searchArtistDiscogs('Artist', 'token')).rejects.toMatchObject({
            source: 'discogs',
            detail: 'HTTP 429',
        });
    });
    it('reports a transport error on the search as unavailable', async () => {
        fetchMock.mockRejectedValueOnce(new Error('offline'));
        await expect(searchArtistDiscogs('Artist', 'token')).rejects.toBeInstanceOf(
            EnrichmentSourceUnavailableError,
        );
    });
    it('reports a failed detail fetch as unavailable when the match has no thumbnail', async () => {
        // Otherwise the chain sees a result without an image and records a
        // permanent no-match for an artist Discogs does have.
        fetchMock
            .mockResolvedValueOnce(
                Response.json({ results: [{ ...match, thumb: '', cover_image: '' }] }),
            )
            .mockResolvedValueOnce(new Response('', { status: 503 }));
        await expect(searchArtistDiscogs('Artist', 'token')).rejects.toMatchObject({
            source: 'discogs',
            detail: 'artist detail HTTP 503',
        });
    });
    it('returns null when Discogs answers without an exact match', async () => {
        fetchMock.mockResolvedValueOnce(
            Response.json({ results: [{ ...match, title: 'Someone Else' }] }),
        );
        expect(await searchArtistDiscogs('Artist', 'token')).toBeNull();
    });
});
describe('searchReleaseDiscogs failures', () => {
    // A failed search must not read as "no such release": album enrichment
    // tombstones a null permanently.
    const release = { ...match, type: 'release', title: 'Artist - Album' };
    it('reports a rate-limited search as unavailable', async () => {
        fetchMock.mockResolvedValueOnce(new Response('', { status: 429 }));
        await expect(searchReleaseDiscogs('Artist', 'Album', 'token')).rejects.toMatchObject({
            source: 'discogs',
            detail: 'HTTP 429',
        });
    });
    it('reports a transport error or a body without results as unavailable', async () => {
        fetchMock.mockRejectedValueOnce(new Error('offline'));
        await expect(searchReleaseDiscogs('Artist', 'Album', 'token')).rejects.toBeInstanceOf(
            EnrichmentSourceUnavailableError,
        );
        fetchMock.mockResolvedValueOnce(
            Response.json({ message: 'You are making requests too quickly.' }),
        );
        await expect(searchReleaseDiscogs('Artist', 'Album', 'token')).rejects.toMatchObject({
            detail: 'unexpected response body',
        });
    });
    it('reports a failed detail fetch as unavailable when the match has no cover', async () => {
        fetchMock
            .mockResolvedValueOnce(
                Response.json({ results: [{ ...release, thumb: '', cover_image: '' }] }),
            )
            .mockResolvedValueOnce(new Response('', { status: 503 }));
        await expect(searchReleaseDiscogs('Artist', 'Album', 'token')).rejects.toMatchObject({
            source: 'discogs',
            detail: 'release detail HTTP 503',
        });
    });
    it('returns null when Discogs answers without an exact match', async () => {
        fetchMock.mockResolvedValueOnce(
            Response.json({ results: [{ ...release, title: 'Artist - Other Album' }] }),
        );
        expect(await searchReleaseDiscogs('Artist', 'Album', 'token')).toBeNull();
    });
    it('returns null without a request when no token is set', async () => {
        expect(await searchReleaseDiscogs('Artist', 'Album', '')).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it('rethrows an abort as-is', async () => {
        const controller = new AbortController();
        controller.abort();
        const abortErr = new Error('aborted');
        fetchMock.mockRejectedValueOnce(abortErr);
        await expect(
            searchReleaseDiscogs('Artist', 'Album', 'token', { signal: controller.signal }),
        ).rejects.toBe(abortErr);
    });
});

describe('release identifiers and compilations', () => {
    const release = { ...match, type: 'release', title: 'Artist - Album' };
    beforeEach(() => {
        fetchMock.mockImplementation(async () => Response.json({ results: [] }));
    });
    it('accepts a barcode hit with a matching normalized title before title search', async () => {
        fetchMock
            .mockResolvedValueOnce(
                Response.json({ results: [{ ...release, title: 'Artist -  ALBUM  ' }] }),
            )
            .mockResolvedValueOnce(Response.json({ id: 42 }));
        const result = await searchReleaseDiscogs('Artist', 'Album', 'token', {
            barcode: '194111012158',
        });
        expect(result?.releaseId).toBe('42');
        expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('barcode')).toBe(
            '194111012158',
        );
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it('tries catalogue number after an empty barcode search', async () => {
        fetchMock
            .mockResolvedValueOnce(Response.json({ results: [] }))
            .mockResolvedValueOnce(Response.json({ results: [release] }))
            .mockResolvedValueOnce(Response.json({ id: 42 }));
        const result = await searchReleaseDiscogs('Artist', 'Album', 'token', {
            barcode: '194111012158',
            catalogueNumber: 'ZYX 83064-2',
        });
        expect(result?.releaseId).toBe('42');
        expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('catno')).toBe('ZYX 83064-2');
    });
    it('maps Various Artists to Discogs Various while keeping the album exact', async () => {
        fetchMock
            .mockResolvedValueOnce(
                Response.json({
                    results: [{ ...release, title: 'Various - Album', year: '2020' }],
                }),
            )
            .mockResolvedValueOnce(Response.json({ id: 42 }));
        expect(
            (await searchReleaseDiscogs('Various Artists', 'Album', 'token', { year: 2020 }))
                ?.releaseId,
        ).toBe('42');
        expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('artist')).toBe('Various');
    });
    it.each(['Artist - Album Deluxe', 'Other Artist - Album', 'Various - Album'])(
        'rejects non-exact title search result %s',
        async (title) => {
            fetchMock.mockResolvedValueOnce(Response.json({ results: [{ ...release, title }] }));
            expect(await searchReleaseDiscogs('Artist', 'Album', 'token')).toBeNull();
            expect(fetchMock).toHaveBeenCalledTimes(1);
        },
    );
    it('keeps compilation title searches exact', async () => {
        fetchMock.mockResolvedValueOnce(
            Response.json({ results: [{ ...release, title: 'Various - Album Deluxe' }] }),
        );
        expect(
            await searchReleaseDiscogs('Various Artists', 'Album', 'token', { year: 2020 }),
        ).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it.each([
        ['catno', 'Artist - A Different Album'],
        ['catno', 'Another Artist - Album'],
        ['barcode', 'Artist - A Different Album'],
    ])('rejects a %s hit for %s', async (kind, title) => {
        fetchMock.mockResolvedValueOnce(Response.json({ results: [{ ...release, title }] }));
        const options =
            kind === 'catno' ? { catalogueNumber: 'ZYX 83064-2' } : { barcode: '194111012158' };
        expect(await searchReleaseDiscogs('Artist', 'Album', 'token', options)).toBeNull();
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/releases/'))).toBe(
            false,
        );
    });
    it('matches catalogue titles and artists using Unicode and whitespace normalization', async () => {
        fetchMock
            .mockResolvedValueOnce(
                Response.json({
                    results: [{ ...release, title: '  ARTIST   NAME - Café  Album ' }],
                }),
            )
            .mockResolvedValueOnce(Response.json({ id: 42 }));
        expect(
            (
                await searchReleaseDiscogs('Artist Name', 'Café Album', 'token', {
                    catalogueNumber: 'CAT 1',
                })
            )?.releaseId,
        ).toBe('42');
    });
    it.each(['catno', 'barcode', 'title'])(
        'rejects a generic compilation %s hit with a different year and tracklist',
        async (kind) => {
            fetchMock.mockResolvedValueOnce(
                Response.json({
                    results: [
                        {
                            ...release,
                            title: 'Various - Dance Hits',
                            year: '1998',
                            barcode: ['9999999999999'],
                            tracklist: [{ title: 'Unrelated Track' }],
                        },
                    ],
                }),
            );
            const options = {
                year: 2020,
                ...(kind === 'catno'
                    ? { catalogueNumber: 'CAT 1' }
                    : kind === 'barcode'
                      ? { barcode: '194111012158' }
                      : {}),
            };
            expect(
                await searchReleaseDiscogs('Various Artists', 'Dance Hits', 'token', options),
            ).toBeNull();
            expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/releases/'))).toBe(
                false,
            );
        },
    );
    it('rejects a compilation when neither year nor matching barcode is known', async () => {
        fetchMock.mockResolvedValueOnce(
            Response.json({ results: [{ ...release, title: 'Various - Dance Hits' }] }),
        );
        expect(await searchReleaseDiscogs('Various Artists', 'Dance Hits', 'token')).toBeNull();
    });
    it('accepts an exact compilation title with the matching year', async () => {
        fetchMock
            .mockResolvedValueOnce(
                Response.json({
                    results: [{ ...release, title: 'Various - Dance Hits', year: '2020' }],
                }),
            )
            .mockResolvedValueOnce(Response.json({ id: 42 }));
        expect(
            (await searchReleaseDiscogs('Various Artists', 'Dance Hits', 'token', { year: 2020 }))
                ?.releaseId,
        ).toBe('42');
    });
    it('accepts an exact compilation title with a verified barcode despite a different year', async () => {
        fetchMock
            .mockResolvedValueOnce(
                Response.json({
                    results: [
                        {
                            ...release,
                            title: 'Various - Dance Hits',
                            year: '1998',
                            barcode: ['1941110 12158'],
                        },
                    ],
                }),
            )
            .mockResolvedValueOnce(Response.json({ id: 42 }));
        expect(
            (
                await searchReleaseDiscogs('Various Artists', 'Dance Hits', 'token', {
                    year: 2020,
                    barcode: '194111012158',
                })
            )?.releaseId,
        ).toBe('42');
    });
    it('rejects a compilation title variant even when year and barcode match', async () => {
        fetchMock.mockResolvedValueOnce(
            Response.json({
                results: [
                    {
                        ...release,
                        title: 'Various - Dance Hits Deluxe',
                        year: '2020',
                        barcode: ['194111012158'],
                    },
                ],
            }),
        );
        expect(
            await searchReleaseDiscogs('Various Artists', 'Dance Hits', 'token', {
                year: 2020,
                barcode: '194111012158',
            }),
        ).toBeNull();
    });
});

describe('artist name lookup', () => {
    it.each([
        ['Gigi DAgostino', "Gigi D'Agostino", 'gigi d agostino'],
        ['Far*East Movement', 'Far East Movement', 'far east movement'],
    ])('retries %s and accepts only the normalized full name', async (name, title, query) => {
        fetchMock
            .mockResolvedValueOnce(Response.json({ results: [] }))
            .mockResolvedValueOnce(Response.json({ results: [{ ...match, title }] }))
            .mockResolvedValueOnce(Response.json({ id: 42 }));
        expect((await searchArtistDiscogs(name, 'token'))?.thumbUrl).toBe(match.cover_image);
        expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('q')).toBe(query);
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('does not accept a similar artist after broadening the query', async () => {
        fetchMock.mockImplementation(async () =>
            Response.json({
                results: [{ ...match, title: "Gigi D'Agostino Jr." }],
            }),
        );
        expect(await searchArtistDiscogs('Gigi DAgostino', 'token')).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each(['Makry', 'JTS', 'Makry & JTS'])(
        'rejects %s for a comma credit without retrying',
        async (title) => {
            fetchMock.mockResolvedValueOnce(Response.json({ results: [{ ...match, title }] }));
            expect(await searchArtistDiscogs('Makry, Jts', 'token')).toBeNull();
            expect(fetchMock).toHaveBeenCalledTimes(1);
        },
    );

    it('accepts an exact joint credit', async () => {
        fetchMock
            .mockResolvedValueOnce(Response.json({ results: [{ ...match, title: 'Makry, JTS' }] }))
            .mockResolvedValueOnce(Response.json({ id: 42 }));
        expect((await searchArtistDiscogs('Makry, Jts', 'token'))?.thumbUrl).toBe(
            match.cover_image,
        );
    });

    it('preserves retryable errors on the looser query', async () => {
        fetchMock
            .mockResolvedValueOnce(Response.json({ results: [] }))
            .mockResolvedValueOnce(new Response('', { status: 429 }));
        await expect(searchArtistDiscogs('Far*East Movement', 'token')).rejects.toMatchObject({
            source: 'discogs',
            detail: 'HTTP 429',
        });
    });
});

describe('normalized album searches', () => {
    it('retries the full title once and accepts a punctuation-equivalent artist', async () => {
        fetchMock
            .mockResolvedValueOnce(Response.json({ results: [] }))
            .mockResolvedValueOnce(
                Response.json({
                    results: [{ ...match, type: 'release', title: 'Steve-Twain - Dance With Me' }],
                }),
            )
            .mockResolvedValueOnce(Response.json({ id: 42 }));
        expect(
            (
                await searchReleaseDiscogs(
                    'Steve Twain',
                    'Dance With Me - Incl Discotronic Remix',
                    'token',
                )
            )?.releaseId,
        ).toBe('42');
        expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('release_title')).toBe(
            'Dance With Me - Incl Discotronic Remix',
        );
        expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('release_title')).toBe(
            'dance with me',
        );
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('rejects a barcode hit from another artist even with the same title', async () => {
        fetchMock.mockImplementation(async () =>
            Response.json({
                results: [{ ...match, type: 'release', title: 'Different Artist - Album' }],
            }),
        );
        expect(
            await searchReleaseDiscogs('Artist', 'Album', 'token', { barcode: '194111012158' }),
        ).toBeNull();
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/releases/'))).toBe(
            false,
        );
    });
});
