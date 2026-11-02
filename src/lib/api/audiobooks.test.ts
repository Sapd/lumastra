// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('$app/paths', () => ({ base: '' }));
vi.mock('./client.js', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
import { audiobookSessionTransport } from './audiobooks.js';
const fetchMock = vi.fn();
const input = {
    playbackSessionId: 'local-session',
    mediaId: 'media',
    bookPositionMs: 90000,
    listenedMs: 12000,
};
beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
describe('unified audiobook report transport', () => {
    it('maps position and heard audio to the common ms body, with increasing sequence', async () => {
        fetchMock.mockResolvedValue(new Response('{}'));
        await audiobookSessionTransport.reportProgress(input);
        await audiobookSessionTransport.closeSession({ ...input, isFinished: true });
        const [url, init] = fetchMock.mock.calls[0];
        const report = JSON.parse(init.body);
        const close = JSON.parse(fetchMock.mock.calls[1][1].body);
        expect(url).toBe('/api/play-sessions/local-session');
        expect(init).toMatchObject({ method: 'PUT', keepalive: true });
        expect(report).toMatchObject({
            positionMs: 90000,
            listenedDeltaMs: 12000,
            sessionElapsedMs: 12000,
            status: 'ACTIVE',
        });
        expect(report).not.toHaveProperty('mediaId');
        expect(close).toMatchObject({
            status: 'COMPLETED',
            finished: true,
            listenedDeltaMs: 12000,
            sessionElapsedMs: 24000,
        });
        expect(close.eventSeq).toBeGreaterThan(report.eventSeq);
    });
    it('sends natural completion through the unified progress report', async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
        await audiobookSessionTransport.reportProgress({
            ...input,
            status: 'COMPLETED',
            isFinished: true,
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/play-sessions/local-session');
        expect(init).toMatchObject({ method: 'PUT', keepalive: true });
        expect(JSON.parse(init.body)).toMatchObject({
            positionMs: input.bookPositionMs,
            listenedDeltaMs: input.listenedMs,
            status: 'COMPLETED',
            finished: true,
        });
    });
    it('preserves session-lost on a 404', async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
        expect(await audiobookSessionTransport.heartbeat({ ...input, status: 'PAUSED' })).toEqual({
            synced: false,
            sessionLost: true,
        });
    });
    it('does not treat a transport failure as a lost session', async () => {
        fetchMock.mockRejectedValue(new Error('offline'));
        expect(await audiobookSessionTransport.reportProgress(input)).toEqual({ synced: false });
    });
    it('preserves the superseded signal', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ action: 'superseded' })));
        expect(await audiobookSessionTransport.reportProgress(input)).toMatchObject({
            superseded: true,
        });
    });
    it('accepts terminal 204 without parsing JSON', async () => {
        fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
        expect(await audiobookSessionTransport.closeSession(input)).toEqual({ synced: true });
    });
    it.each(['throw', 'unsynced'])(
        'restores heard audio after %s without sessionLost',
        async (failure) => {
            const report = { ...input, playbackSessionId: `retry-${failure}` };
            if (failure === 'throw') fetchMock.mockRejectedValueOnce(new Error('offline'));
            else fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ synced: false })));
            expect((await audiobookSessionTransport.reportProgress(report)).synced).toBe(false);
            fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
            await audiobookSessionTransport.reportProgress({ ...report, listenedMs: 3000 });
            expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
                listenedDeltaMs: 15000,
                sessionElapsedMs: 15000,
            });
        },
    );
    it('releases the sequence entry after a session ends', async () => {
        const report = { ...input, playbackSessionId: 'sequence-cleanup' };
        fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));
        await audiobookSessionTransport.reportProgress(report);
        await audiobookSessionTransport.closeSession(report);
        await audiobookSessionTransport.reportProgress(report);
        expect(JSON.parse(fetchMock.mock.calls[2][1].body).eventSeq).toBe(1);
    });
});

describe('audiobook catalog reads', () => {
    it('uses stable filters and a separate facets endpoint', async () => {
        const { getAudiobookBrowse, getAudiobookFacets } = await import('./audiobooks.js');
        const { apiGet } = await import('./client.js');
        const params = {
            authorId: 'writer',
            narratorId: 'reader',
            seriesId: 'cycle',
            libraryGroupId: 'shelf',
            sort: 'year' as const,
            order: 'desc' as const,
            offset: 60,
        };
        getAudiobookBrowse(params);
        expect(apiGet).toHaveBeenLastCalledWith('/api/audiobooks', expect.anything(), { params });
        getAudiobookFacets({ ...params, collapse: 'series' });
        expect(apiGet).toHaveBeenLastCalledWith('/api/audiobooks/facets', expect.anything(), {
            params: {
                q: undefined,
                authorId: 'writer',
                narratorId: 'reader',
                seriesId: 'cycle',
                libraryGroupId: 'shelf',
                lang: undefined,
                collapse: 'series',
            },
        });
    });
    it('fetches series books by id and carries the next offset', async () => {
        const { getAudiobookResourceBooks } = await import('./audiobooks.js');
        const { apiGet } = await import('./client.js');
        getAudiobookResourceBooks('series', 'cycle', 60);
        expect(apiGet).toHaveBeenLastCalledWith(
            '/api/audiobooks/series/cycle/books',
            expect.anything(),
            { params: { offset: 60, limit: 60 } },
        );
    });
});

it('decodes shared TimelineChapter fields into the existing local download/player model', async () => {
    const { apiPost, apiGet } = await import('./client.js');
    vi.mocked(apiPost).mockResolvedValue({
        error: null,
        status: 201,
        data: {
            playbackSessionId: 'public-session',
            mediaId: 'book',
            delivery: {
                kind: 'multipart-audio',
                tracks: [],
                startPositionMs: 0,
                durationMs: 10000,
                chapters: [{ index: 7, name: 'The chapter', startMs: 1000, endMs: 10000 }],
            },
        },
    });
    vi.mocked(apiGet).mockResolvedValue({ data: { title: 'Book' }, error: null, status: 200 });
    const payload = await audiobookSessionTransport.openSession({
        mediaId: 'book',
        deviceId: 'device',
    });
    expect(payload.chapters).toEqual([
        { id: 7, title: 'The chapter', startMs: 1000, durationMs: 9000 },
    ]);
});
