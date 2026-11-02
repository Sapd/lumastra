// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true }));

// Minimal in-memory localStorage stub for the default (node) vitest env,
// which has no localStorage global.
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

describe('azBrowse language filter', () => {
    it('round-trips language params through buildUrl and initFromUrl', async () => {
        const { createAzBrowseStore } = await import('./azBrowse.js');
        const store = createAzBrowseStore();
        store.setLanguageFilter({
            audioLangs: ['de', 'ja'],
            subLangs: ['en'],
            includeUnknown: true,
        });
        const url = store.buildUrl('all');
        expect(url).toContain('audio=de%2Cja');
        expect(url).toContain('subs=en');
        expect(url).toContain('includeUnknown=true');

        const fresh = createAzBrowseStore();
        fresh.initFromUrl(new URLSearchParams(url.split('?')[1]));
        const s = get(fresh);
        expect(s.audioLangs).toEqual(['de', 'ja']);
        expect(s.subLangs).toEqual(['en']);
        expect(s.includeUnknown).toBe(true);
    });

    it('hydrates from localStorage when the URL carries no language params', async () => {
        const { createAzBrowseStore } = await import('./azBrowse.js');
        const a = createAzBrowseStore();
        a.setLanguageFilter({ audioLangs: ['ko'], subLangs: [], includeUnknown: false });
        const b = createAzBrowseStore();
        b.initFromUrl(new URLSearchParams('mode=az'));
        expect(get(b).audioLangs).toEqual(['ko']);
    });

    it('restores the language filter from localStorage on a fresh /browse (no mode=az in URL)', async () => {
        const { createAzBrowseStore } = await import('./azBrowse.js');
        const a = createAzBrowseStore();
        a.setLanguageFilter({ audioLangs: ['de'], subLangs: ['en'], includeUnknown: true });

        const b = createAzBrowseStore();
        // Empty params: no `mode=az` at all, i.e. the plain `/browse` fresh-load path
        // that restores A-Z purely from the `browse-az-mode-preference` localStorage flag.
        b.initFromUrl(new URLSearchParams(''));
        const s = get(b);
        expect(s.audioLangs).toEqual(['de']);
        expect(s.subLangs).toEqual(['en']);
        expect(s.includeUnknown).toBe(true);
    });
});

describe('azBrowse sort + quality filter', () => {
    it('round-trips sort + quality params through buildUrl and initFromUrl', async () => {
        const { createAzBrowseStore } = await import('./azBrowse.js');
        const store = createAzBrowseStore();
        store.setSort('year_desc');
        store.setQualityFilter({
            resolutions: ['4K', '1080p'],
            hdr: ['hdr'],
            codecs: [],
            qualityIncludeUnknown: true,
        });
        const url = store.buildUrl('all');
        expect(url).toContain('sort=year_desc');
        expect(url).toContain('res=4K%2C1080p');
        expect(url).toContain('hdr=hdr');
        expect(url).toContain('qUnknown=true');

        const fresh = createAzBrowseStore();
        fresh.initFromUrl(new URLSearchParams(url.split('?')[1]));
        const s = get(fresh);
        expect(s.sort).toBe('year_desc');
        expect(s.resolutions).toEqual(['4K', '1080p']);
        expect(s.hdr).toEqual(['hdr']);
        expect(s.codecs).toEqual([]);
        expect(s.qualityIncludeUnknown).toBe(true);
    });

    it('omits the default sort (title_asc) from the URL', async () => {
        const { createAzBrowseStore } = await import('./azBrowse.js');
        const store = createAzBrowseStore();
        store.setSort('title_asc');
        const url = store.buildUrl('all');
        expect(url).not.toContain('sort=');
    });

    it('hydrates sort + quality from localStorage when the URL carries no view params (mode=az)', async () => {
        const { createAzBrowseStore } = await import('./azBrowse.js');
        const a = createAzBrowseStore();
        a.setSort('rating_desc');
        a.setQualityFilter({
            resolutions: ['720p'],
            hdr: [],
            codecs: ['hevc'],
            qualityIncludeUnknown: false,
        });

        const b = createAzBrowseStore();
        b.initFromUrl(new URLSearchParams('mode=az'));
        const s = get(b);
        expect(s.sort).toBe('rating_desc');
        expect(s.resolutions).toEqual(['720p']);
        expect(s.codecs).toEqual(['hevc']);
    });

    it('restores sort + quality from localStorage on a fresh /browse (no mode=az in URL)', async () => {
        const { createAzBrowseStore } = await import('./azBrowse.js');
        const a = createAzBrowseStore();
        a.setSort('added_desc');
        a.setQualityFilter({
            resolutions: ['SD'],
            hdr: ['dolby_vision'],
            codecs: [],
            qualityIncludeUnknown: true,
        });

        const b = createAzBrowseStore();
        b.initFromUrl(new URLSearchParams(''));
        const s = get(b);
        expect(s.sort).toBe('added_desc');
        expect(s.resolutions).toEqual(['SD']);
        expect(s.hdr).toEqual(['dolby_vision']);
        expect(s.qualityIncludeUnknown).toBe(true);
    });

    it('setSort clears selectedLetter when switching away from a title sort', async () => {
        const { createAzBrowseStore } = await import('./azBrowse.js');
        const store = createAzBrowseStore();
        store.update((s) => ({ ...s, selectedLetter: 'Z' }));
        expect(get(store).selectedLetter).toBe('Z');

        store.setSort('year_desc');
        expect(get(store).selectedLetter).toBeNull();

        const url = store.buildUrl('all');
        expect(url).not.toContain('letter=');
    });

    it('setSort keeps selectedLetter when switching between title sorts', async () => {
        const { createAzBrowseStore } = await import('./azBrowse.js');
        const store = createAzBrowseStore();
        store.update((s) => ({ ...s, selectedLetter: 'Z' }));

        store.setSort('title_desc');
        expect(get(store).selectedLetter).toBe('Z');
    });

    it('loadViewPrefs (via initFromUrl localStorage fallback) drops invalid quality tier tokens', async () => {
        const { createAzBrowseStore } = await import('./azBrowse.js');
        localStorage.setItem(
            'browse-az-view-prefs',
            JSON.stringify({
                sort: 'title_asc',
                resolutions: ['4K', 'xxx'],
                hdr: ['hdr', 'not-a-tier'],
                codecs: ['hevc', ''],
                qualityIncludeUnknown: false,
            }),
        );

        const store = createAzBrowseStore();
        store.initFromUrl(new URLSearchParams(''));
        const s = get(store);
        expect(s.resolutions).toEqual(['4K']);
        expect(s.hdr).toEqual(['hdr']);
        expect(s.codecs).toEqual(['hevc']);
    });

    it('initFromUrl drops invalid quality tier tokens carried directly in URL params', async () => {
        const { createAzBrowseStore } = await import('./azBrowse.js');
        const store = createAzBrowseStore();
        store.initFromUrl(
            new URLSearchParams('mode=az&res=4K,xxx&hdr=hdr,bogus&codec=hevc,made-up'),
        );
        const s = get(store);
        expect(s.resolutions).toEqual(['4K']);
        expect(s.hdr).toEqual(['hdr']);
        expect(s.codecs).toEqual(['hevc']);
    });
});
