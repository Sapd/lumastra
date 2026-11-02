// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The A-Z store must not be able to express a tag/genre filter.
 *
 * This file replaces `azBrowse-genre-tag.test.ts`, whose premise — that
 * `buildUrl` preserves genre/tag through a control change — is now exactly what
 * must NOT happen. The filter belongs to the /browse/filter results view; A-Z is
 * a display mode.
 *
 * Why the store is the enforcement point rather than a redirect: `buildUrl`
 * emits the `/browse?mode=az` form, which is the RAILS route. No load function
 * on /browse/az can intercept it. While the store still carried genre/tag, one
 * tap of a letter under `/browse/az?tag=whodunit` rewrote the address bar to
 * `/browse?mode=az&tag=whodunit` — a filtered A-Z view with no chip and no
 * picker, i.e. the dead end this design exists to remove. Making the state
 * incapable of holding a filter closes that by construction.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true }));

beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
            store.set(k, v);
        },
        removeItem: (k: string) => {
            store.delete(k);
        },
        clear: () => store.clear(),
    });
});

function paramsOf(url: string): URLSearchParams {
    return new URLSearchParams(url.split('?')[1] ?? '');
}

describe('azBrowse never emits a filter', () => {
    it('drops genre/tag from the URL even when they were in the incoming one', async () => {
        const { createAzBrowseStore } = await import('./azBrowse.js');
        const store = createAzBrowseStore();
        store.initFromUrl(new URLSearchParams('mode=az&tag=whodunit&genre=Mystery&letter=M'));

        const params = paramsOf(store.buildUrl('all'));

        expect(params.has('tag')).toBe(false);
        expect(params.has('genre')).toBe(false);
        // ...while everything the store DOES own still round-trips.
        expect(params.get('mode')).toBe('az');
        expect(params.get('letter')).toBe('M');
    });

    it('keeps no filter in state for anything else to read', async () => {
        const { createAzBrowseStore } = await import('./azBrowse.js');
        const store = createAzBrowseStore();
        store.initFromUrl(new URLSearchParams('mode=az&tag=whodunit&genre=Mystery'));

        // Via `unknown`: the point is that these keys are gone from the type,
        // so a direct cast is (correctly) rejected.
        const state = get(store) as unknown as Record<string, unknown>;
        expect(state.tag).toBeUndefined();
        expect(state.genre).toBeUndefined();
    });

    it('emits no filter on the /browse/az route branch either', async () => {
        const { createAzBrowseStore } = await import('./azBrowse.js');
        const store = createAzBrowseStore();
        store.initFromUrl(new URLSearchParams('tag=whodunit'), { forceEnabled: true });

        const params = paramsOf(store.buildUrl('all'));
        expect(params.has('tag')).toBe(false);
    });
});

describe('buildParams is buildUrl without the mode or the path', () => {
    it('carries every grid dimension the store owns', async () => {
        const { createAzBrowseStore } = await import('./azBrowse.js');
        const store = createAzBrowseStore();
        store.initFromUrl(
            new URLSearchParams(
                'mode=az&letter=M&libraryGroupId=lib-1&sort=year_desc&audio=en&subs=de' +
                    '&includeUnknown=true&res=4K&hdr=hdr&codec=hevc&qUnknown=true',
            ),
        );

        const params = store.buildParams('movies');

        expect(params.get('type')).toBe('movies');
        expect(params.get('letter')).toBe('M');
        expect(params.get('libraryGroupId')).toBe('lib-1');
        expect(params.get('sort')).toBe('year_desc');
        expect(params.get('audio')).toBe('en');
        expect(params.get('subs')).toBe('de');
        expect(params.get('includeUnknown')).toBe('true');
        expect(params.get('res')).toBe('4K');
        expect(params.get('hdr')).toBe('hdr');
        expect(params.get('codec')).toBe('hevc');
        expect(params.get('qUnknown')).toBe('true');
    });

    it('omits the mode, which is what lets the results view reuse it', async () => {
        const { createAzBrowseStore } = await import('./azBrowse.js');
        const store = createAzBrowseStore();
        store.initFromUrl(new URLSearchParams('mode=az'));

        expect(store.buildParams('all').has('mode')).toBe(false);
        expect(paramsOf(store.buildUrl('all')).get('mode')).toBe('az');
    });

    it('agrees with buildUrl on every shared dimension', async () => {
        // The two must not drift: buildUrl is defined in terms of buildParams,
        // and this pins that they stay that way.
        const { createAzBrowseStore } = await import('./azBrowse.js');
        const store = createAzBrowseStore();
        store.initFromUrl(
            new URLSearchParams('mode=az&letter=K&sort=rating_desc&libraryGroupId=g1'),
        );

        const fromUrl = paramsOf(store.buildUrl('series'));
        const fromParams = store.buildParams('series');

        fromParams.forEach((value, key) => expect(fromUrl.get(key)).toBe(value));
        // buildUrl adds exactly one thing on top.
        expect([...fromUrl.keys()].filter((k) => !fromParams.has(k))).toEqual(['mode']);
    });
});
