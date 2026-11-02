// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { albumSeriesKey } from './music-album-series';

describe('albumSeriesKey', () => {
    it.each([
        ['Future Trance Vol.61', 'futuretrance', 61],
        ['Future Trance Vol. 62', 'futuretrance', 62],
        ['Future Trance Vol 69', 'futuretrance', 69],
        ['Future Trance 70', 'futuretrance', 70],
        ['TechnoBase.FM Vol. 14', 'technobasefm', 14],
        ['Technobase.Fm Vol.23', 'technobasefm', 23],
        ['TechnoBase FM Vol  12', 'technobasefm', 12],
        ['TechnoBase.FM, Volume 16', 'technobasefm', 16],
        ['TechnoBase FM Vol 9 (2014)', 'technobasefm', 9],
        ['Technobase.FM Vol 28 (Mixed & Unmixed)', 'technobasefm', 28],
        ['VA - TechnoBase FM Vol 13 (2016)', 'technobasefm', 13],
        ['TechnoBase.FM-Best Of Vol.2', 'technobasefmbestof', 2],
        ['TechnoBase FM - Best Of 3', 'technobasefmbestof', 3],
        ['Hands Up Essentials, Vol. 3', 'handsupessentials', 3],
        ['Coldharbour Selections Part 23', 'coldharbourselections', 23],
        ['Techno Top 100, Vol. 25', 'technotop100', 25],
    ])('%s → %s #%i', (title, key, volume) => {
        expect(albumSeriesKey(title)).toEqual({ key, volume });
    });

    it('treats "&" and "And" as the same stem', () => {
        expect(albumSeriesKey('Techno Top 100 The Best Of Hard & Jumpstyle Volume 17')?.key).toBe(
            albumSeriesKey('Techno Top 100 The Best Of Hard And Jumpstyle Volume 22')?.key,
        );
    });

    it.each([
        // "Top 100" is part of the name; discs of one release must not group.
        'Muziekfeest In De Sneeuw Top 100 (CD 2)',
        'Lounge Top 100',
        // Discs of one release.
        'Lounge Collection CD 2',
        'Lounge Collection Disc 1',
        'Lounge Collection Side 2',
        // Classical numbering is not a series.
        'Symphony No. 5',
        'Piano Concerto Nr. 1',
        // No number at all.
        'TechnoBase.FM Best Of',
        // Stem too short to mean anything.
        'Vol. 3',
        'CD 2',
        '21',
        '1989',
    ])('%s → no series', (title) => {
        expect(albumSeriesKey(title)).toBeNull();
    });
});
