// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { parseItemsQuery } from './items-handler';
import { expandLanguageCodes } from './language-codes';

const ID_A = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ID_B = '7c9e6679742540de944be07fc1f90ae7';

function parse(query: string): ReturnType<typeof parseItemsQuery> {
    return parseItemsQuery(new URL(`http://localhost/j/Items?${query}`));
}

describe('parseItemsQuery: brief-09 list parameters', () => {
    it('reads ExcludeItemIds, AlbumIds and AlbumArtistIds as UUIDs, dropping malformed ones', () => {
        const q = parse(
            `ExcludeItemIds=${ID_A},nope&albumIds=${ID_B}&AlbumArtistIds=${ID_A.toUpperCase()}`,
        );
        expect(q.excludeIds).toEqual([ID_A]);
        expect(q.albumIds).toEqual(['7c9e6679-7425-40de-944b-e07fc1f90ae7']);
        expect(q.albumArtistIds).toEqual([ID_A]);
    });

    it('reads Tags and OfficialRatings pipe-delimited', () => {
        const q = parse('Tags=heist|paris,%20france&OfficialRatings=PG-13|TV-MA');
        // Tags split on pipes only: a keyword may contain a comma.
        expect(q.tags).toEqual(['heist', 'paris, france']);
        expect(q.officialRatings).toEqual(['PG-13', 'TV-MA']);
    });

    it('expands AudioLanguages / SubtitleLanguages to every ISO spelling', () => {
        const q = parse('AudioLanguages=ger&SubtitleLanguages=en,und');
        expect(q.audioLanguages).toEqual(expect.arrayContaining(['ger', 'deu', 'de']));
        expect(q.subtitleLanguages).toEqual(expect.arrayContaining(['en', 'eng', 'und']));
    });

    it('maps MaxOfficialRating to an age and ignores unknown ratings', () => {
        expect(parse('MaxOfficialRating=PG-13').maxAge).toBe(13);
        expect(parse('MaxOfficialRating=FSK%2016').maxAge).toBe(16);
        expect(parse('MaxOfficialRating=whatever').maxAge).toBeNull();
        expect(parse('MaxOfficialRating=NR').maxAge).toBeNull();
    });

    it('reads the name range, ImageTypes, HasParentalRating and CollapseBoxSetItems', () => {
        const q = parse(
            'NameLessThan=B&NameStartsWithOrGreater=a&ImageTypes=Backdrop,Logo&HasParentalRating=false&CollapseBoxSetItems=true',
        );
        expect(q.nameLessThan).toBe('B');
        expect(q.nameStartsWithOrGreater).toBe('a');
        expect(q.imageTypes).toEqual(['Backdrop', 'Logo']);
        expect(q.hasParentalRating).toBe(false);
        expect(q.collapseBoxSetItems).toBe(true);
    });
});

describe('parseItemsQuery: list caps', () => {
    const many = (n: number, f: (i: number) => string): string[] =>
        Array.from({ length: n }, (_, i) => f(i));
    const uuid = (i: number): string => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

    it('caps every list at 100 entries and de-duplicates', () => {
        const ids = [...many(300, uuid), uuid(1)].join(',');
        const q = parse(
            `ExcludeItemIds=${ids}&AlbumIds=${ids}&AlbumArtistIds=${ids}` +
                `&Tags=${many(300, (i) => `t${i}`).join('|')}|T1` +
                `&OfficialRatings=${many(300, (i) => `R${i}`).join('|')}` +
                `&AudioLanguages=${many(300, (i) => `x${i}`).join(',')}` +
                `&SubtitleLanguages=${many(300, (i) => `y${i}`).join(',')}` +
                `&ImageTypes=${many(300, (i) => `Img${i}`).join(',')}`,
        );
        expect(q.excludeIds).toHaveLength(100);
        expect(q.albumIds).toHaveLength(100);
        expect(q.albumArtistIds).toHaveLength(100);
        expect(q.tags).toHaveLength(100);
        expect(q.officialRatings).toHaveLength(100);
        expect(q.audioLanguages).toHaveLength(100);
        expect(q.subtitleLanguages).toHaveLength(100);
        expect(q.imageTypes).toHaveLength(100);
        expect(new Set(q.excludeIds).size).toBe(100);
    });

    it('de-duplicates repeated values (case-insensitively for tags, languages, image types)', () => {
        const q = parse(
            `ExcludeItemIds=${ID_A},${ID_A.toUpperCase()}&Tags=Heist|heist&AudioLanguages=ENG,eng` +
                '&ImageTypes=Backdrop,backdrop&OfficialRatings=PG|PG',
        );
        expect(q.excludeIds).toEqual([ID_A]);
        expect(q.tags).toEqual(['Heist']);
        expect(q.officialRatings).toEqual(['PG']);
        expect(q.imageTypes).toEqual(['Backdrop']);
        expect(q.audioLanguages.filter((c) => c === 'eng')).toHaveLength(1);
    });
});

describe('expandLanguageCodes', () => {
    it('keeps unknown codes as sent and lower-cases everything', () => {
        expect(expandLanguageCodes(['XYZ', ' FRE '])).toEqual(
            expect.arrayContaining(['xyz', 'fre', 'fra', 'fr']),
        );
        expect(expandLanguageCodes([''])).toEqual([]);
    });
});
