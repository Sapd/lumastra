// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Route predicates and redirect policy for the browse filter results view.
 *
 * A tag/genre filter is a DESTINATION (/browse/filter), not the A-Z display
 * mode. Two redirects enforce that, and both live in load functions so they
 * apply to SSR entry, client-side navigation and browser back alike:
 *
 *   /browse/az?tag=…      → /browse/filter?…   (links already in the wild)
 *   /browse/filter        → /browse            (no filter = nothing to show)
 *
 * The decision is a pure function precisely so it can be tested here: a
 * colocated `+page.test.ts` is forbidden (the `+` prefix is reserved for
 * SvelteKit's own exports) and the main vitest project runs in `node`.
 */

import { describe, it, expect } from 'vitest';
import {
    isAzRoutePath,
    isFilterRoutePath,
    filterRedirectTarget,
    genreBrowseHref,
    recentBrowseHref,
    isRecentView,
} from './browse-filter-route.js';

function target(href: string): string | null {
    return filterRedirectTarget(new URL(href, 'https://example.test'));
}

describe('isAzRoutePath', () => {
    it('recognises the /browse/az route, with or without a base path', () => {
        expect(isAzRoutePath('/browse/az')).toBe(true);
        expect(isAzRoutePath('/browse/az/')).toBe(true);
        expect(isAzRoutePath('/lumastra/browse/az')).toBe(true);
    });

    it('rejects the rails route and lookalikes', () => {
        expect(isAzRoutePath('/browse')).toBe(false);
        expect(isAzRoutePath('/browse/azores')).toBe(false);
        expect(isAzRoutePath('/browse/filter')).toBe(false);
        expect(isAzRoutePath('/')).toBe(false);
    });
});

describe('isFilterRoutePath', () => {
    it('recognises the /browse/filter route the same way', () => {
        expect(isFilterRoutePath('/browse/filter')).toBe(true);
        expect(isFilterRoutePath('/browse/filter/')).toBe(true);
        expect(isFilterRoutePath('/lumastra/browse/filter')).toBe(true);
        expect(isFilterRoutePath('/browse/filtered')).toBe(false);
        expect(isFilterRoutePath('/browse/az')).toBe(false);
    });
});

describe('unified catalog destinations', () => {
    it('keeps every dimension on old links', () => {
        const result = target(
            '/browse/filter?genre=Action&tag=heist&q=star&type=movies&groupId=kids&letter=S&audio=eng&subs=ger&res=4K&hdr=hdr&codec=hevc&sort=year_desc',
        );
        const params = new URLSearchParams(result!.split('?')[1]);
        expect(result!.startsWith('/browse?')).toBe(true);
        expect(params.get('mode')).toBe('az');
        for (const [key, value] of new URL(
            'https://example.test/browse/filter?genre=Action&tag=heist&q=star&type=movies&groupId=kids&letter=S&audio=eng&subs=ger&res=4K&hdr=hdr&codec=hevc&sort=year_desc',
        ).searchParams)
            expect(params.get(key)).toBe(value);
    });
    it('keeps unfiltered A–Z and cleared filters in the library', () => {
        expect(target('/browse/az')).toBe('/browse?mode=az');
        expect(target('/browse/filter')).toBe('/browse?mode=az');
        expect(target('/browse?mode=az')).toBeNull();
        expect(target('/browse')).toBeNull();
    });
    it('turns recent links into the same catalog sorted newest first', () => {
        expect(target('/browse/filter?view=recent&type=movies')).toBe(
            '/browse?type=movies&mode=az&sort=added_desc',
        );
        expect(recentBrowseHref('series')).toBe('/browse?type=series&sort=added_desc&mode=az');
        expect(isRecentView(new URLSearchParams('view=recent'))).toBe(true);
    });
    it('genre links retain their type and are real catalog destinations', () => {
        expect(genreBrowseHref('Action & Adventure', 'movies')).toBe(
            '/browse?type=movies&genre=Action+%26+Adventure&mode=az',
        );
        expect(genreBrowseHref('Comedy', 'channels')).toBe('/browse?genre=Comedy&mode=az');
    });
});
