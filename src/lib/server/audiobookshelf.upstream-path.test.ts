// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `/api/image/audiobook/<id>` passes a request-controlled id into an
 * Audiobookshelf URL that carries the server API key. The requested URL must
 * stay under `/api/items/<one segment>/cover`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.mock('./utils/fetch-timeout.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./utils/fetch-timeout.js')>();
    return { ...actual, fetchWithTimeout: mockFetch };
});

const { AudiobookshelfClient } = await import('./audiobookshelf');

describe('AudiobookshelfClient.getBookImage upstream URL', () => {
    beforeEach(() => {
        mockFetch.mockReset().mockResolvedValue(new Response('x', { status: 200 }));
    });

    it.each(['../../api/users', 'a/../../users', 'a?x=1', 'a#b'])(
        'id %j cannot leave /api/items/<id>/cover',
        async (hostile) => {
            const client = new AudiobookshelfClient(
                () => 'http://abs.invalid',
                () => 'key',
            );
            await client.getBookImage(hostile).catch(() => undefined);
            for (const call of mockFetch.mock.calls) {
                const u = new URL(String(call[0]));
                expect(u.pathname).toMatch(/^\/api\/items\/[^/]+\/cover$/);
            }
        },
    );

    it('preserves a cover 404 response for the image service to classify', async () => {
        const missing = new Response(null, { status: 404 });
        mockFetch.mockResolvedValue(missing);
        const client = new AudiobookshelfClient('http://abs.invalid', 'key');
        await expect(client.getBookImage('removed-book')).resolves.toBe(missing);
    });

    it.each([401, 403, 500, 503])('keeps HTTP %i cover failures as errors', async (status) => {
        mockFetch.mockResolvedValue(new Response(null, { status }));
        const client = new AudiobookshelfClient('http://abs.invalid', 'key');
        await expect(client.getBookImage('book')).rejects.toThrow(`HTTP ${status}`);
    });

    it('a normal library item id is requested unchanged', async () => {
        const client = new AudiobookshelfClient(
            () => 'http://abs.invalid',
            () => 'key',
        );
        await client.getBookImage('li_abc123');
        expect(String(mockFetch.mock.calls[0][0])).toBe(
            'http://abs.invalid/api/items/li_abc123/cover',
        );
    });

    it.each(['http://proxy/audiobookshelf/', 'http://proxy//audiobookshelf//'])(
        'keeps the base path without duplicate slashes for %s',
        async (base) => {
            const client = new AudiobookshelfClient(base, 'key');
            await client.getBookImage('book');
            expect(String(mockFetch.mock.calls[0][0])).toBe(
                'http://proxy/audiobookshelf/api/items/book/cover',
            );
        },
    );

    it('result-returning calls report an unusable id as a failure instead of throwing', async () => {
        const client = new AudiobookshelfClient(
            () => 'http://abs.invalid',
            () => 'key',
        );
        const a = await client.listLibraryItemsMinified('..');
        const b = await client.getLibraryItemExpanded('..');
        expect(a.ok).toBe(false);
        expect(b.ok).toBe(false);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('AudiobookshelfClient.getProgressAs', () => {
    const client = new AudiobookshelfClient('http://abs.invalid/abs', 'operator-key');
    beforeEach(() => {
        mockFetch.mockReset();
    });
    it('reads a single book with the listener key and preserves finished state', async () => {
        const progress = {
            libraryItemId: 'book',
            currentTime: 100,
            isFinished: true,
            lastUpdate: 1000,
        };
        mockFetch.mockResolvedValue(Response.json(progress));
        expect(await client.getProgressAs('listener-key', 'book')).toEqual(progress);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch).toHaveBeenCalledWith(
            'http://abs.invalid/abs/api/me/progress/book',
            expect.objectContaining({ headers: { Authorization: 'Bearer listener-key' } }),
        );
    });
    it('treats an absent book progress row as empty', async () => {
        mockFetch.mockResolvedValue(new Response(null, { status: 404 }));
        expect(await client.getProgressAs('listener-key', 'book')).toBeUndefined();
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });
    it.each([405, 501])(
        'falls back to current-user progress on an unsupported endpoint (%i)',
        async (status) => {
            const progress = { libraryItemId: 'book', episodeId: null, isFinished: true };
            mockFetch
                .mockResolvedValueOnce(new Response(null, { status }))
                .mockResolvedValueOnce(Response.json({ mediaProgress: [progress] }));
            expect(await client.getProgressAs('listener-key', 'book')).toEqual(progress);
            expect(mockFetch).toHaveBeenCalledTimes(2);
        },
    );
    it.each([401, 503])(
        'propagates HTTP %i so open can use the session startTime',
        async (status) => {
            mockFetch.mockResolvedValue(new Response(null, { status }));
            await expect(client.getProgressAs('listener-key', 'book')).rejects.toThrow();
            expect(mockFetch).toHaveBeenCalledTimes(1);
        },
    );
});
