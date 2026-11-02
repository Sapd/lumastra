// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TheAudioDB artist and album search: a miss and a failure must stay
 * distinguishable.
 *
 * TheAudioDB retired its free key "2"; requests with it get HTTP 404
 * `{"Message":"Not found"}` for EVERY artist, while the current key "123"
 * answers a miss with HTTP 200 `{"artists":null}`. Reading the 404 as a miss
 * marked every artist checked since then as a permanent no-match.
 */

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
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    },
}));

import { searchArtist, searchAlbum } from './theaudiodb-api.js';
import { EnrichmentSourceUnavailableError } from './artist-enrichment.types.js';

beforeEach(() => vi.clearAllMocks());

describe('searchArtist', () => {
    it('uses the current free key', async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ artists: null }));
        await searchArtist('Some Act');
        expect(fetchMock.mock.calls[0][0]).toBe(
            'https://www.theaudiodb.com/api/v1/json/123/search.php?s=Some%20Act',
        );
    });

    it('returns null for a real miss (200, artists: null)', async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ artists: null }));
        expect(await searchArtist('Some Act')).toBeNull();
    });

    it('returns null when the only result is a different artist', async () => {
        fetchMock.mockResolvedValueOnce(
            Response.json({ artists: [{ strArtist: 'Some Other Act', strArtistThumb: 'x' }] }),
        );
        expect(await searchArtist('Some Act')).toBeNull();
    });

    it('returns the images of an exact match', async () => {
        fetchMock.mockResolvedValueOnce(
            Response.json({
                artists: [{ strArtist: 'Some Act', strArtistThumb: 'https://img/thumb.jpg' }],
            }),
        );
        expect((await searchArtist('some act'))?.thumbUrl).toBe('https://img/thumb.jpg');
    });

    it('reports the retired-key 404 as unavailable, not as a miss', async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ Message: 'Not found' }, { status: 404 }));
        await expect(searchArtist('Some Act')).rejects.toMatchObject({
            source: 'theaudiodb',
            detail: 'HTTP 404',
        });
    });

    it('reports a transport error or an unparseable body as unavailable', async () => {
        fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
        await expect(searchArtist('Some Act')).rejects.toBeInstanceOf(
            EnrichmentSourceUnavailableError,
        );
        fetchMock.mockResolvedValueOnce(new Response('<html>'));
        await expect(searchArtist('Some Act')).rejects.toBeInstanceOf(
            EnrichmentSourceUnavailableError,
        );
    });

    it('reports a 200 body without the artists key as unavailable', async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ Message: 'Not found' }));
        await expect(searchArtist('Some Act')).rejects.toMatchObject({
            detail: 'unexpected response body',
        });
    });

    it('rethrows an abort as-is', async () => {
        const controller = new AbortController();
        controller.abort();
        const abortErr = new Error('aborted');
        fetchMock.mockRejectedValueOnce(abortErr);
        await expect(searchArtist('Some Act', { signal: controller.signal })).rejects.toBe(
            abortErr,
        );
    });
});

describe('searchAlbum', () => {
    it('uses the current free key', async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ album: null }));
        await searchAlbum('Some Act', 'Some Album');
        expect(fetchMock.mock.calls[0][0]).toBe(
            'https://www.theaudiodb.com/api/v1/json/123/searchalbum.php?s=Some%20Act&a=Some%20Album',
        );
    });

    it('returns null for a real miss (200, album: null)', async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ album: null }));
        expect(await searchAlbum('Some Act', 'Some Album')).toBeNull();
    });

    it("returns null when the only result is another artist's album", async () => {
        fetchMock.mockResolvedValueOnce(
            Response.json({
                album: [{ strAlbum: 'Some Album', strArtist: 'Someone Else', strAlbumThumb: 'x' }],
            }),
        );
        expect(await searchAlbum('Some Act', 'Some Album')).toBeNull();
    });

    it('returns the cover and release group of an exact match', async () => {
        fetchMock.mockResolvedValueOnce(
            Response.json({
                album: [
                    {
                        strAlbum: 'Some Album',
                        strArtist: 'Some Act',
                        strAlbumThumb: 'https://img/cover.jpg',
                        strMusicBrainzID: 'rg-1',
                    },
                ],
            }),
        );
        expect(await searchAlbum('some act', 'some album')).toEqual({
            posterUrl: 'https://img/cover.jpg',
            backdropUrl: null,
            releaseGroupMbid: 'rg-1',
        });
    });

    it('reports the retired-key 404 as unavailable, not as a miss', async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ Message: 'Not found' }, { status: 404 }));
        await expect(searchAlbum('Some Act', 'Some Album')).rejects.toMatchObject({
            source: 'theaudiodb',
            detail: 'HTTP 404',
        });
    });

    it('reports a transport error or an unparseable body as unavailable', async () => {
        fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
        await expect(searchAlbum('Some Act', 'Some Album')).rejects.toBeInstanceOf(
            EnrichmentSourceUnavailableError,
        );
        fetchMock.mockResolvedValueOnce(new Response('<html>'));
        await expect(searchAlbum('Some Act', 'Some Album')).rejects.toBeInstanceOf(
            EnrichmentSourceUnavailableError,
        );
    });

    it('reports a 200 body without the album key as unavailable', async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ Message: 'Not found' }));
        await expect(searchAlbum('Some Act', 'Some Album')).rejects.toMatchObject({
            detail: 'unexpected response body',
        });
    });

    it('rethrows an abort as-is', async () => {
        const controller = new AbortController();
        controller.abort();
        const abortErr = new Error('aborted');
        fetchMock.mockRejectedValueOnce(abortErr);
        await expect(
            searchAlbum('Some Act', 'Some Album', { signal: controller.signal }),
        ).rejects.toBe(abortErr);
    });
});

describe('normalized album searches', () => {
    it('tries the full spelling before a base-title retry and checks every artist', async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ album: null })).mockResolvedValueOnce(
            Response.json({
                album: [
                    {
                        strAlbum: 'Dance With Me',
                        strArtist: 'Someone Else',
                        strAlbumThumb: 'wrong',
                    },
                    { strAlbum: 'Dance With Me', strArtist: 'Steve-Twain', strAlbumThumb: 'right' },
                ],
            }),
        );
        expect(
            (await searchAlbum('Steve Twain', 'Dance With Me - Incl Discotronic Remix'))?.posterUrl,
        ).toBe('right');
        expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('a')).toBe(
            'Dance With Me - Incl Discotronic Remix',
        );
        expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('a')).toBe('dance with me');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
