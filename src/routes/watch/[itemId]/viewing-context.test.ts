// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /watch's educational and personal shells list the lessons or clips of the
 * series named by `?col=` / `?event=`. That id comes from the URL, so the list
 * must come from the access-checked loader: before the 2026-10-07 entry-point
 * review any signed-in user could read the titles and ids of a series they may
 * not see by putting its id in `?col=`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ getAccessibleSeriesWithEpisodes: vi.fn() }));

vi.mock('$lib/server/utils/non-entertainment-series-access.js', () => ({
    getAccessibleSeriesWithEpisodes: mocks.getAccessibleSeriesWithEpisodes,
}));

import { isSameOriginPath, resolveViewingContext } from './viewing-context';

const SQL = {} as never;
const USER = { userId: 'u-1', username: 'kid', isAdmin: false } as never;

function input(query: string, mediaType = 'educational') {
    return {
        url: new URL(`http://localhost/watch/item-1?${query}`),
        internalId: 'item-1',
        mediaType,
        seriesId: 'own-series',
        user: USER,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAccessibleSeriesWithEpisodes.mockResolvedValue({ series: null, episodes: [] });
});

describe('resolveViewingContext', () => {
    it.each([
        ['ctx=educational&col=forbidden-series', 'educational'],
        ['ctx=personal&event=forbidden-series', 'home_video'],
        ['ctx=personal&col=forbidden-series', 'home_video'],
    ])('loads ?%s through the access-checked helper for the viewer', async (query, type) => {
        await resolveViewingContext(SQL, input(query, type));
        expect(mocks.getAccessibleSeriesWithEpisodes).toHaveBeenCalledWith(
            SQL,
            'forbidden-series',
            USER,
            expect.any(Object),
        );
    });

    it('a series the viewer may not see contributes no lessons', async () => {
        const ctx = await resolveViewingContext(SQL, input('ctx=educational&col=forbidden-series'));
        expect(ctx).toMatchObject({ kind: 'educational', lessonIds: [], lessons: [] });
    });
});

describe('isSameOriginPath (returnPath)', () => {
    it.each(['/browse', '/library/home_video/abc?x=1', '/'])('accepts %s', (value) => {
        expect(isSameOriginPath(value)).toBe(true);
    });

    it.each([
        '//evil.example',
        '/\\evil.example',
        '/\t/evil.example',
        '/\n/evil.example',
        'https://evil.example',
        'evil',
    ])('refuses %j', (value) => {
        expect(isSameOriginPath(value)).toBe(false);
    });
});
