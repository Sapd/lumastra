// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/database/queries/jellyfin-filters.queries', () => ({
    getJellyfinGenres: vi.fn(),
}));

import {
    applyNameListQuery,
    genreId,
    genreIdCandidates,
    hasValidParentId,
    normalizeParentId,
    parseNameListQuery,
    programFlagsExcludeLibraryItems,
    type ProgramFlags,
} from './genres';

const url = (q: string): URL => new URL(`http://localhost/j/Genres?${q}`);
const NAMES = ['Drama', 'action', 'Ärger', 'Comedy', '9 Lives'];

function list(q: string): { page: string[]; total: number } {
    return applyNameListQuery(
        NAMES,
        parseNameListQuery(url(q)),
        (n) => n,
        (n) => n.length,
    );
}

describe('genre ids', () => {
    it('is the dashed md5 of the lower-cased trimmed name (the item GenreItems hex)', () => {
        expect(genreId(' Drama ')).toBe('cd672af2-3149-70ab-f37b-948f5b3af622');
        expect(genreId('Drama').replace(/-/g, '')).toBe(genreIdCandidates('Drama')[0]);
        expect(genreId('Drama')).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
    });

    it('still resolves the md5("genre:" + name) Id /Genres used to issue', () => {
        expect(genreIdCandidates('Drama')).toHaveLength(2);
        expect(genreIdCandidates('Drama')[1]).not.toBe(genreIdCandidates('Drama')[0]);
    });
});

describe('ParentId handling', () => {
    it('maps the user root folder to no parent', () => {
        expect(normalizeParentId('f27caa37e5142225cceded48f6553502')).toBeNull();
        expect(normalizeParentId('F27CAA37-E514-2225-CCED-ED48F6553502')).toBeNull();
        expect(normalizeParentId(' ')).toBeNull();
        expect(normalizeParentId('abc')).toBe('abc');
    });

    it('accepts GUIDs (dashed or compact) and absence, rejects anything else', () => {
        expect(hasValidParentId(url(''))).toBe(true);
        expect(hasValidParentId(url('ParentId='))).toBe(true);
        expect(hasValidParentId(url('parentId=0f8e2d3c4b5a69788796a5b4c3d2e1f0'))).toBe(true);
        expect(hasValidParentId(url('ParentId=0f8e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'))).toBe(true);
        expect(hasValidParentId(url('ParentId=library'))).toBe(false);
        expect(hasValidParentId(url("ParentId=1' OR 1=1"))).toBe(false);
    });
});

describe('applyNameListQuery', () => {
    it('sorts by name by default and pages', () => {
        expect(list('')).toEqual({
            page: ['9 Lives', 'action', 'Ärger', 'Comedy', 'Drama'],
            total: 5,
        });
        expect(list('StartIndex=1&Limit=2')).toEqual({ page: ['action', 'Ärger'], total: 5 });
    });

    it('SearchTerm ignores case and diacritics', () => {
        expect(list('SearchTerm=ARG').page).toEqual(['Ärger']);
        expect(list('searchTerm=o').page).toEqual(['action', 'Comedy']);
    });

    it('NameStartsWith (with # for non-letters), NameStartsWithOrGreater, NameLessThan', () => {
        expect(list('NameStartsWith=c').page).toEqual(['Comedy']);
        expect(list('NameStartsWith=%23').page).toEqual(['9 Lives', 'Ärger']);
        // The cut-off compares code points, the order is locale-aware.
        expect(list('NameStartsWithOrGreater=c').page).toEqual(['Ärger', 'Comedy', 'Drama']);
        expect(list('NameLessThan=c').page).toEqual(['9 Lives', 'action']);
    });

    it('SortBy/SortOrder pair per key; unknown keys are skipped', () => {
        expect(list('SortBy=SortName&SortOrder=Descending').page[0]).toBe('Drama');
        // Bogus takes Ascending, ChildCount Descending; ties fall back to name.
        expect(list('SortBy=Bogus,ChildCount&SortOrder=Ascending,Descending').page).toEqual([
            '9 Lives',
            'action',
            'Comedy',
            'Ärger',
            'Drama',
        ]);
        expect(list('SortBy=Random').page).toHaveLength(5);
    });

    it('IsFavorite=true is empty; EnableTotalRecordCount=false reports the page length', () => {
        expect(list('IsFavorite=true')).toEqual({ page: [], total: 0 });
        expect(list('IsFavorite=false').total).toBe(5);
        expect(list('Limit=2&EnableTotalRecordCount=false').total).toBe(2);
    });

    it('bad numbers fall back to defaults', () => {
        expect(list('StartIndex=-3&Limit=abc')).toMatchObject({ total: 5 });
        expect(list('StartIndex=-3&Limit=abc').page).toHaveLength(5);
    });

    it('IncludeItemTypes or Fields=ItemCounts turns item counts on', () => {
        expect(parseNameListQuery(url('')).itemCounts).toBe(false);
        expect(parseNameListQuery(url('IncludeItemTypes=Movie')).itemCounts).toBe(true);
        expect(
            parseNameListQuery(url('Fields=PrimaryImageAspectRatio,ItemCounts')).itemCounts,
        ).toBe(true);
    });
});

describe('programFlagsExcludeLibraryItems', () => {
    const none: ProgramFlags = {
        isMovie: null,
        isSeries: null,
        isKids: null,
        isNews: null,
        isSports: null,
        isAiring: null,
    };

    it('only the =false forms and IsMovie=true over movies keep library items', () => {
        expect(programFlagsExcludeLibraryItems(none, [])).toBe(false);
        expect(programFlagsExcludeLibraryItems({ ...none, isMovie: true }, [])).toBe(false);
        expect(programFlagsExcludeLibraryItems({ ...none, isMovie: true }, ['Movie'])).toBe(false);
        expect(programFlagsExcludeLibraryItems({ ...none, isMovie: true }, ['Series'])).toBe(true);
        expect(programFlagsExcludeLibraryItems({ ...none, isMovie: false }, ['Series'])).toBe(
            false,
        );
        expect(
            programFlagsExcludeLibraryItems(
                { ...none, isSeries: false, isKids: false, isNews: false, isSports: false },
                [],
            ),
        ).toBe(false);
        for (const flag of ['isSeries', 'isKids', 'isNews', 'isSports'] as const) {
            expect(programFlagsExcludeLibraryItems({ ...none, [flag]: true }, [])).toBe(true);
        }
        expect(programFlagsExcludeLibraryItems({ ...none, isAiring: false }, [])).toBe(true);
        expect(programFlagsExcludeLibraryItems({ ...none, isAiring: true }, [])).toBe(true);
    });
});
