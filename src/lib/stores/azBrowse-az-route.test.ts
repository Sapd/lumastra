// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The /browse/az route must imply A-Z mode.
 *
 * /browse/az/+page.svelte renders /browse/+page.svelte and claims "the parent
 * browse page will detect the /az path and enable A-Z mode automatically" —
 * but nothing ever did. `azMode` was `$azStore.enabled`, and initFromUrl only
 * set `enabled: true` for `?mode=az`; a /browse/az deep link (which carries no
 * `mode`, the route IS the mode) fell into the localStorage branch instead.
 *
 * With the A-Z preference off — the DEFAULT — every /browse/az link therefore
 * rendered the ordinary rails page. That is what made the tag/genre filter
 * picker look inert: it navigated to /browse/az?tag=whodunit correctly, the URL
 * changed, and the page came back showing Recently Added / Continue Watching
 * with the tag silently ignored.
 *
 * `forceEnabled` is the route's way to say "A-Z, regardless of preference", and
 * it must take the SAME branch as `mode=az` — not just flip `enabled` — or the
 * rest of a deep link (letter, libraryGroupId, sort, language/quality filters) would
 * still be dropped on that route.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true }));

const AZ_MODE_STORAGE_KEY = 'browse-az-mode-preference';

// Minimal in-memory localStorage stub for the default (node) vitest env.
let backing: Map<string, string>;
beforeEach(() => {
    backing = new Map<string, string>();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => backing.get(k) ?? null,
        setItem: (k: string, v: string) => {
            backing.set(k, v);
        },
        removeItem: (k: string) => {
            backing.delete(k);
        },
        clear: () => backing.clear(),
    });
});

function paramsOf(url: string): URLSearchParams {
    return new URLSearchParams(url.split('?')[1] ?? '');
}

describe('isAzRoutePath', () => {
    it('recognises the /browse/az route, with or without a base path', async () => {
        const { isAzRoutePath } = await import('./azBrowse.js');

        expect(isAzRoutePath('/browse/az')).toBe(true);
        // Trailing slash: SvelteKit's trailingSlash config can produce either.
        expect(isAzRoutePath('/browse/az/')).toBe(true);
        // Deployed under a base path.
        expect(isAzRoutePath('/lumastra/browse/az')).toBe(true);
    });

    it('does not match the rails route or unrelated paths', async () => {
        const { isAzRoutePath } = await import('./azBrowse.js');

        expect(isAzRoutePath('/browse')).toBe(false);
        expect(isAzRoutePath('/browse/genres')).toBe(false);
        expect(isAzRoutePath('/')).toBe(false);
        // Must not match a path that merely CONTAINS the segment.
        expect(isAzRoutePath('/browse/azores')).toBe(false);
    });
});

describe('initFromUrl forceEnabled (the /browse/az route)', () => {
    it('enables A-Z on /browse/az even when the stored preference is off', async () => {
        const { createAzBrowseStore } = await import('./azBrowse.js');
        // The default state for a user who never toggled A-Z on, and the exact
        // state observed on prod when the filter picker looked inert.
        localStorage.setItem(AZ_MODE_STORAGE_KEY, JSON.stringify({ enabled: false }));

        const store = createAzBrowseStore();
        store.initFromUrl(new URLSearchParams(''), { forceEnabled: true });

        expect(get(store).enabled).toBe(true);
    });

    it('honours a /browse/az deep link’s grid dimensions', async () => {
        const { createAzBrowseStore } = await import('./azBrowse.js');
        const store = createAzBrowseStore();

        store.initFromUrl(
            new URLSearchParams('type=movies&letter=M&libraryGroupId=lib-1&sort=year_desc'),
            {
                forceEnabled: true,
            },
        );

        const s = get(store);
        expect(s.enabled).toBe(true);
        expect(s.mediaType).toBe('movie');
        expect(s.selectedLetter).toBe('M');
        expect(s.selectedGroupId).toBe('lib-1');
        expect(s.sort).toBe('year_desc');

        // ...and buildUrl round-trips them, so the first control interaction
        // (which REPLACES the whole query string) cannot drop them.
        // `tag`/`genre` are deliberately absent from both — see
        // azBrowse-no-filter.test.ts.
        const params = paramsOf(store.buildUrl('movies'));
        expect(params.get('letter')).toBe('M');
        expect(params.get('libraryGroupId')).toBe('lib-1');
        expect(params.get('sort')).toBe('year_desc');
    });

    it('leaves the rails route alone: no forceEnabled means preference decides', async () => {
        const { createAzBrowseStore } = await import('./azBrowse.js');
        localStorage.setItem(AZ_MODE_STORAGE_KEY, JSON.stringify({ enabled: false }));

        const store = createAzBrowseStore();
        store.initFromUrl(new URLSearchParams('tag=whodunit'));

        expect(get(store).enabled).toBe(false);
    });

    it('still enables A-Z from the stored preference on /browse', async () => {
        const { createAzBrowseStore } = await import('./azBrowse.js');
        localStorage.setItem(AZ_MODE_STORAGE_KEY, JSON.stringify({ enabled: true }));

        const store = createAzBrowseStore();
        store.initFromUrl(new URLSearchParams(''));

        expect(get(store).enabled).toBe(true);
    });

    it('forceEnabled: false behaves exactly like an absent option', async () => {
        const { createAzBrowseStore } = await import('./azBrowse.js');
        // Seeded FALSE on purpose. With the preference true both branches of
        // `mode === 'az' || forceEnabled === true` yield enabled:true, so the
        // assertion would pass even if `false` were misread as truthy (e.g. a
        // `!== undefined` check). Only a false preference discriminates.
        localStorage.setItem(AZ_MODE_STORAGE_KEY, JSON.stringify({ enabled: false }));

        const store = createAzBrowseStore();
        store.initFromUrl(new URLSearchParams(''), { forceEnabled: false });

        expect(get(store).enabled).toBe(false);
    });
});

describe('restoring the unified catalog', () => {
    it('restores the media type and URL filters when Library is enabled by preference', async () => {
        const { createAzBrowseStore } = await import('./azBrowse.js');
        localStorage.setItem(AZ_MODE_STORAGE_KEY, JSON.stringify({ enabled: true }));
        const store = createAzBrowseStore();
        store.initFromUrl(new URLSearchParams('type=movies&letter=M&audio=en'));
        expect(get(store)).toMatchObject({
            enabled: true,
            mediaType: 'movie',
            selectedLetter: 'M',
            audioLangs: ['en'],
        });
    });

    it('clears old library and letter selections on a plain browse navigation', async () => {
        const { createAzBrowseStore } = await import('./azBrowse.js');
        const store = createAzBrowseStore();
        store.initFromUrl(new URLSearchParams('mode=az&type=series&libraryGroupId=old&letter=K'));
        store.initFromUrl(new URLSearchParams('mode=discover&type=movies'));
        expect(get(store)).toMatchObject({
            enabled: false,
            mediaType: 'movie',
            selectedGroupId: null,
            selectedLetter: null,
        });
    });

    it('drops unsupported language tokens instead of rendering undefined chips', async () => {
        const { createAzBrowseStore } = await import('./azBrowse.js');
        const store = createAzBrowseStore();
        store.initFromUrl(new URLSearchParams('mode=az&audio=en,invalid&subs=invalid,de'));
        expect(get(store)).toMatchObject({ audioLangs: ['en'], subLangs: ['de'] });
    });
});
