// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `ownSort`: a view whose sort belongs to the URL, not to the remembered A-Z
 * view preference.
 *
 * The Recently Added grid (/browse/filter?view=recent) is newest-first by
 * definition. Without this it would either open in the user's remembered A-Z
 * sort (title order — not "recently added" at all), or, if it forced its own
 * sort into the shared store, the next quality-filter save would persist
 * `added_desc` as the user's A-Z preference: `saveViewPrefs` writes the sort
 * and the quality tiers as one blob.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true }));

/** azBrowse.ts's AZ_VIEW_PREFS_STORAGE_KEY (module-private). */
const key = 'browse-az-view-prefs';
let storage: Map<string, string>;

beforeEach(() => {
    storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => {
            storage.set(k, v);
        },
        removeItem: (k: string) => {
            storage.delete(k);
        },
        clear: () => storage.clear(),
    });
});

describe('azBrowse ownSort', () => {
    it('defaults to its own sort, ignoring the remembered one', async () => {
        storage.set(key, JSON.stringify({ sort: 'rating_desc', resolutions: ['4K'] }));
        const { createAzBrowseStore } = await import('./azBrowse.js');
        const store = createAzBrowseStore({ ownSort: 'added_desc' });

        store.initFromUrl(new URLSearchParams('view=recent'), { forceEnabled: true });

        expect(get(store).sort).toBe('added_desc');
        // Quality prefs still come from the remembered preference.
        expect(get(store).resolutions).toEqual(['4K']);
    });

    it('omits its default sort from the URL and round-trips any other', async () => {
        const { createAzBrowseStore } = await import('./azBrowse.js');
        const store = createAzBrowseStore({ ownSort: 'added_desc' });
        store.initFromUrl(new URLSearchParams(''), { forceEnabled: true });

        expect(store.buildParams('all').has('sort')).toBe(false);

        store.setSort('title_asc');
        const params = store.buildParams('all');
        expect(params.get('sort')).toBe('title_asc');

        const reloaded = createAzBrowseStore({ ownSort: 'added_desc' });
        reloaded.initFromUrl(params, { forceEnabled: true });
        expect(get(reloaded).sort).toBe('title_asc');
    });

    it('never writes its sort into the remembered preference', async () => {
        storage.set(key, JSON.stringify({ sort: 'year_desc' }));
        const { createAzBrowseStore } = await import('./azBrowse.js');
        const store = createAzBrowseStore({ ownSort: 'added_desc' });
        store.initFromUrl(new URLSearchParams(''), { forceEnabled: true });

        store.setSort('rating_desc');
        store.setQualityFilter({
            resolutions: ['1080p'],
            hdr: [],
            codecs: [],
            qualityIncludeUnknown: false,
        });

        const saved = JSON.parse(storage.get(key)!);
        expect(saved.sort).toBe('year_desc');
        // The quality change itself IS remembered — only the sort is owned.
        expect(saved.resolutions).toEqual(['1080p']);
    });

    it('leaves the default store unchanged: title_asc default, sort persisted', async () => {
        const { createAzBrowseStore } = await import('./azBrowse.js');
        const store = createAzBrowseStore();
        store.initFromUrl(new URLSearchParams(''), { forceEnabled: true });

        expect(get(store).sort).toBe('title_asc');
        store.setSort('added_desc');
        expect(store.buildParams('all').get('sort')).toBe('added_desc');
        expect(JSON.parse(storage.get(key)!).sort).toBe('added_desc');
    });
});
