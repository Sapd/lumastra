// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { albumSearchQueries, albumTitlesMatch, normalizeAlbumTitle } from './album-title-match.js';

describe('album title normalization', () => {
    it.each([
        ['Dance With Me - Incl Discotronic Remix', 'dance with me'],
        ['Dance With Me (incl. Discotronic Remix)', 'dance with me'],
        ['Dance With Me (Discotronic Remix)', 'dance with me'],
        ['Dance With Me (The Remixes)', 'dance with me'],
        ['Dance With Me (Extended Mix)', 'dance with me'],
        ['Dance With Me [Bonus Tracks]', 'dance with me'],
        ['Dance With Me (Bonus Tracks)', 'dance with me'],
        ['Dance With Me (Single)', 'dance with me'],
        ['Dance With Me - Single', 'dance with me'],
        ['Dance With Me EP', 'dance with me'],
        ['Dance With Me (Deluxe Version)', 'dance with me'],
        ['Dance With Me (Remastered 2024)', 'dance with me'],
        ['Dance With Me (2024 Remastered)', 'dance with me'],
        ['Dance With Me (20th Anniversary Edition)', 'dance with me'],
        ['Dance With Me (Deluxe Edition) [Bonus] - Single', 'dance with me'],
        ["Don't Stop: Now!", 'dont stop now'],
        ['Café—Album', 'café album'],
        ['Life (On Mars)', 'life on mars'],
        ['The Single Life', 'the single life'],
        ['Remix Culture', 'remix culture'],
        ['Song (Remixology)', 'song remixology'],
        ['The Mix', 'the mix'],
        ['EP', 'ep'],
    ])('normalizes %s', (title, expected) => {
        expect(normalizeAlbumTitle(title)).toBe(expected);
    });

    it('searches the full title before one base-title retry', () => {
        expect(albumSearchQueries('Dance With Me - Incl Discotronic Remix')).toEqual([
            'Dance With Me - Incl Discotronic Remix',
            'dance with me',
        ]);
        expect(albumSearchQueries('Dance With Me')).toEqual(['Dance With Me']);
        expect(albumSearchQueries('!!!')).toEqual([]);
    });

    it('requires equality of nonempty base titles', () => {
        expect(albumTitlesMatch('Dance With Me (Single)', 'Dance with Me')).toBe(true);
        expect(albumTitlesMatch('Dance With Me', 'Dance With You')).toBe(false);
        expect(albumTitlesMatch('Life (On Mars)', 'Life')).toBe(false);
        expect(albumTitlesMatch('(Single)', '[Bonus]')).toBe(false);
    });
});
