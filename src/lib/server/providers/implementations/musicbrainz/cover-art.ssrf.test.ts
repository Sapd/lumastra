// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security review 2026-09-12, P1. Both Cover Art Archive calls — the JSON index
 * and the image itself — went out through a bare `fetch`, which follows up to
 * 20 redirects on its own. The one-time `assertNotPrivateUrl` check on the
 * image URL therefore only covered the FIRST hop: a 302 could still walk the
 * request onto a link-local or RFC1918 address. These exercise the real
 * `safeFetch` hop loop, so the guard is asserted where it actually runs.
 *
 * DNS is stubbed to return no addresses, which sends safeFetch down its
 * unpinned branch (global `fetch`, still `redirect: 'manual'`) — the redirect
 * re-validation under test is identical on both branches, and this keeps the
 * suite off the network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:dns', () => {
    const promises = {
        lookup: vi.fn(async () => [] as Array<{ address: string; family: number }>),
    };
    return { promises, default: { promises } };
});

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

vi.mock('$lib/server/utils/ssrf-guard.js', () => ({
    assertNotPrivateUrl: vi.fn().mockResolvedValue(undefined),
}));

import { getAlbumArt, __clearCacheForTest } from './cover-art.js';

const IMAGE_URL = 'https://ia800207.us.archive.org/cover.jpg';

function indexResponse(imageUrl = IMAGE_URL): Response {
    return new Response(
        JSON.stringify({
            release: 'r',
            images: [
                {
                    types: ['Front'],
                    front: true,
                    back: false,
                    image: imageUrl,
                    thumbnails: {},
                },
            ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
    );
}

function imageResponse(): Response {
    return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
    });
}

/** A 3xx response. 3xx is not a null-body status, but keep the body empty. */
function redirectTo(location: string): Response {
    return new Response(null, { status: 302, headers: { location } });
}

describe('cover-art redirect re-validation', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        __clearCacheForTest();
    });

    it('never lets fetch follow a redirect on its own', async () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(indexResponse())
            .mockResolvedValueOnce(imageResponse());

        await getAlbumArt('mbid-plain');

        for (const call of fetchSpy.mock.calls) {
            expect((call[1] as RequestInit).redirect).toBe('manual');
        }
    });

    it('rejects an index redirect to a private address without issuing the request', async () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(redirectTo('http://127.0.0.1:6379/'));

        await expect(getAlbumArt('mbid-private-index')).resolves.toBeNull();
        // The redirected request must never have gone out.
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('rejects an image redirect to a link-local address without issuing the request', async () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(indexResponse())
            .mockResolvedValueOnce(redirectTo('http://169.254.169.254/latest/meta-data/'));

        await expect(getAlbumArt('mbid-private-image')).resolves.toBeNull();
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('follows a redirect to another public host', async () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(redirectTo('https://caa.example.org/release/x'))
            .mockResolvedValueOnce(indexResponse())
            .mockResolvedValueOnce(redirectTo('https://cdn.example.net/cover.jpg'))
            .mockResolvedValueOnce(imageResponse());

        const art = await getAlbumArt('mbid-public-redirect');

        expect(art?.buffer.length).toBe(3);
        expect(art?.contentType).toBe('image/jpeg');
        expect(fetchSpy).toHaveBeenCalledTimes(4);
    });

    it('allows a chain of five redirects', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        for (let i = 1; i <= 5; i++) {
            fetchSpy.mockResolvedValueOnce(redirectTo(`https://caa.example.org/hop${i}`));
        }
        fetchSpy.mockResolvedValueOnce(indexResponse());
        fetchSpy.mockResolvedValueOnce(imageResponse());

        const art = await getAlbumArt('mbid-five-hops');

        expect(art?.buffer.length).toBe(3);
        expect(fetchSpy).toHaveBeenCalledTimes(7);
    });

    it('rejects a sixth redirect hop', async () => {
        let n = 0;
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(async () => redirectTo(`https://caa.example.org/hop${++n}`));

        await expect(getAlbumArt('mbid-six-hops')).resolves.toBeNull();
        expect(fetchSpy).toHaveBeenCalledTimes(6);
    });
});
