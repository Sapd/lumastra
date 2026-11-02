// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    loadBrowserReturn,
    saveBrowserReturn,
    loadSavedFilters,
    saveFilters,
    loadColumnVisibility,
    saveColumnVisibility,
    FILTERS_STORAGE_KEY,
    COLUMNS_STORAGE_KEY,
    PERSISTED_FILTER_PARAMS,
    STORAGE_VERSION,
    RESTORE_SUPPRESSING_PARAMS,
    shouldRestoreSavedFilters,
} from './media-browser-storage.js';

/**
 * Minimal in-memory Storage stand-in — no DOM needed.
 *
 * `accessDenied` models the browsers where the ACCESSOR ITSELF throws instead
 * of returning null: Safari/Firefox private browsing with site data blocked,
 * and a partitioned third-party iframe. Both `getItem` and `setItem` raise a
 * SecurityError there. Without it this stand-in can never throw, so every
 * `catch` block in the module under test was unreachable from the suite — and
 * a read path that hoisted its `getItem` OUT of the `try` (the exact mistake
 * `loadColumnVisibility` carries a comment against) would have gone unnoticed.
 */
function memoryStorage(
    seed: Record<string, string> = {},
    { accessDenied = false }: { accessDenied?: boolean } = {},
): Storage {
    const map = new Map(Object.entries(seed));
    const denied = (): never => {
        throw new Error('SecurityError: access to storage is denied in this context');
    };
    return {
        getItem: (k: string) => (accessDenied ? denied() : (map.get(k) ?? null)),
        setItem: (k: string, v: string) => (accessDenied ? denied() : void map.set(k, v)),
        removeItem: (k: string) => void map.delete(k),
        clear: () => map.clear(),
        key: (i: number) => [...map.keys()][i] ?? null,
        get length() {
            return map.size;
        },
    } as Storage;
}

const ALL_KEYS = ['title', 'type', 'year', 'author', 'series'];
const ALWAYS = ['title'];
const DEFAULTS = ['title', 'type', 'year'];

describe('loadSavedFilters', () => {
    it('returns an empty object when storage is unavailable', () => {
        expect(loadSavedFilters(null)).toEqual({});
    });

    it('returns an empty object when nothing is stored', () => {
        expect(loadSavedFilters(memoryStorage())).toEqual({});
    });

    it('returns only known filter params, ignoring anything else stored', () => {
        const s = memoryStorage({
            [FILTERS_STORAGE_KEY]: JSON.stringify({
                v: STORAGE_VERSION,
                filters: { domain: 'music', bogus: 'x' },
            }),
        });
        expect(loadSavedFilters(s)).toEqual({ domain: 'music' });
    });

    it('survives malformed JSON rather than throwing', () => {
        const s = memoryStorage({ [FILTERS_STORAGE_KEY]: 'not json' });
        expect(loadSavedFilters(s)).toEqual({});
    });

    it('ignores non-string and empty values', () => {
        const s = memoryStorage({
            [FILTERS_STORAGE_KEY]: JSON.stringify({
                v: STORAGE_VERSION,
                filters: { domain: 'music', type: '', sort: 5 },
            }),
        });
        expect(loadSavedFilters(s)).toEqual({ domain: 'music' });
    });

    it('drops a stored library id that is not a uuid', () => {
        // Restored into the URL on every bare visit, a bad id 500'd the
        // browser again and again until storage was cleared by hand.
        const id = '0b9a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
        const bad = memoryStorage({
            [FILTERS_STORAGE_KEY]: JSON.stringify({
                v: STORAGE_VERSION,
                filters: { domain: 'music', library: 'junk' },
            }),
        });
        expect(loadSavedFilters(bad)).toEqual({ domain: 'music' });
        const good = memoryStorage({
            [FILTERS_STORAGE_KEY]: JSON.stringify({ v: STORAGE_VERSION, filters: { library: id } }),
        });
        expect(loadSavedFilters(good)).toEqual({ library: id });
    });
});

describe('saveFilters', () => {
    it('round-trips through loadSavedFilters', () => {
        const s = memoryStorage();
        saveFilters(s, new URLSearchParams('domain=music&type=artist&page=3'));
        // `page` is not a persisted filter param.
        expect(loadSavedFilters(s)).toEqual({ domain: 'music', type: 'artist' });
    });

    it('does not throw when storage is unavailable', () => {
        expect(() => saveFilters(null, new URLSearchParams('domain=music'))).not.toThrow();
    });
});

describe('loadColumnVisibility', () => {
    it('returns the defaults when storage is unavailable', () => {
        expect(loadColumnVisibility(null, DEFAULTS, ALL_KEYS, ALWAYS)).toEqual(DEFAULTS);
    });

    it('returns the defaults when nothing is stored', () => {
        expect(loadColumnVisibility(memoryStorage(), DEFAULTS, ALL_KEYS, ALWAYS)).toEqual(DEFAULTS);
    });

    it('drops stored keys that are no longer real columns', () => {
        const s = memoryStorage({
            [COLUMNS_STORAGE_KEY]: JSON.stringify({ v: STORAGE_VERSION, keys: ['title', 'gone'] }),
        });
        expect(loadColumnVisibility(s, DEFAULTS, ALL_KEYS, ALWAYS)).toEqual(['title']);
    });

    it('always re-adds always-visible columns even if absent from the stored list', () => {
        const s = memoryStorage({
            [COLUMNS_STORAGE_KEY]: JSON.stringify({ v: STORAGE_VERSION, keys: ['year'] }),
        });
        expect(loadColumnVisibility(s, DEFAULTS, ALL_KEYS, ALWAYS)).toContain('title');
    });
});

describe('saveColumnVisibility', () => {
    it('round-trips', () => {
        const s = memoryStorage();
        saveColumnVisibility(s, ['title', 'year']);
        expect(loadColumnVisibility(s, DEFAULTS, ALL_KEYS, ALWAYS)).toEqual(['title', 'year']);
    });
});

describe('storage versioning', () => {
    it('discards a filter blob with no version (pre-versioning format)', () => {
        const s = memoryStorage({
            [FILTERS_STORAGE_KEY]: JSON.stringify({ domain: 'music', type: 'music' }),
        });
        expect(loadSavedFilters(s)).toEqual({});
    });

    it('discards a filter blob written by an older version', () => {
        const s = memoryStorage({
            [FILTERS_STORAGE_KEY]: JSON.stringify({
                v: STORAGE_VERSION - 1,
                filters: { domain: 'music', type: 'music' },
            }),
        });
        expect(loadSavedFilters(s)).toEqual({});
    });

    it('reads a blob written by the current version', () => {
        const s = memoryStorage();
        saveFilters(s, new URLSearchParams('domain=music&type=artist'));
        expect(loadSavedFilters(s)).toEqual({ domain: 'music', type: 'artist' });
    });

    it('discards a column blob with no version', () => {
        const s = memoryStorage({ [COLUMNS_STORAGE_KEY]: JSON.stringify(['title', 'year']) });
        expect(loadColumnVisibility(s, DEFAULTS, ALL_KEYS, ALWAYS)).toEqual(DEFAULTS);
    });

    it('reads a column blob written by the current version', () => {
        const s = memoryStorage();
        saveColumnVisibility(s, ['title', 'year']);
        expect(loadColumnVisibility(s, DEFAULTS, ALL_KEYS, ALWAYS)).toEqual(['title', 'year']);
    });
});

describe('storage that denies access (private browsing, partitioned iframe)', () => {
    // Every assertion here fails if its `catch` is removed: the stand-in throws
    // from the accessor itself, so an unguarded call propagates straight out.
    const denied = () => memoryStorage({}, { accessDenied: true });

    it('loadSavedFilters degrades to no saved filters when getItem throws', () => {
        expect(loadSavedFilters(denied())).toEqual({});
    });

    it('loadColumnVisibility degrades to the defaults when getItem throws', () => {
        expect(loadColumnVisibility(denied(), DEFAULTS, ALL_KEYS, ALWAYS)).toEqual(DEFAULTS);
    });

    it('saveFilters swallows a throwing setItem rather than breaking navigation', () => {
        // This runs inside a $effect on every URL change — an escaping throw
        // takes the whole page down on a filter click, not just persistence.
        expect(() => saveFilters(denied(), new URLSearchParams('domain=music'))).not.toThrow();
    });

    it('saveColumnVisibility swallows a throwing setItem rather than breaking the picker', () => {
        expect(() => saveColumnVisibility(denied(), ['title', 'year'])).not.toThrow();
    });
});

describe('deep-link params are not persisted, but DO suppress the restore', () => {
    it.each(['filter', 'added_since', 'updated_since'])('does not persist %s', (param) => {
        const s = memoryStorage();
        saveFilters(s, new URLSearchParams(`domain=video&${param}=some-value`));
        expect(loadSavedFilters(s)).toEqual({ domain: 'video' });
    });

    it('still persists ordinary filter params', () => {
        const s = memoryStorage();
        saveFilters(s, new URLSearchParams('domain=music&type=artist&locked=1&sort=title'));
        expect(loadSavedFilters(s)).toEqual({
            domain: 'music',
            type: 'artist',
            locked: '1',
            sort: 'title',
        });
    });

    // The two concerns are DIFFERENT lists. A bookmark of a bare
    // `?filter=file-issues` must not be treated as "no filters present" — if it
    // were, the restore would merge the saved domain/type on top and re-narrow
    // the very link that exists to show issues across every media type.
    it.each(['filter', 'added_since', 'updated_since'])('%s still suppresses restore', (param) => {
        expect(RESTORE_SUPPRESSING_PARAMS).toContain(param);
    });

    it('suppresses restore for every persisted param too', () => {
        for (const p of PERSISTED_FILTER_PARAMS) {
            expect(RESTORE_SUPPRESSING_PARAMS).toContain(p);
        }
    });
});

describe('shouldRestoreSavedFilters', () => {
    it('allows the restore on a bare navigation', () => {
        // The sidebar "Media" link — the whole reason the restore exists.
        expect(shouldRestoreSavedFilters(new URLSearchParams(''))).toBe(true);
    });

    it('allows the restore alongside params that are not filters at all', () => {
        expect(shouldRestoreSavedFilters(new URLSearchParams('page=3'))).toBe(true);
    });

    it('suppresses the restore for every persisted filter param', () => {
        for (const key of PERSISTED_FILTER_PARAMS) {
            expect(
                shouldRestoreSavedFilters(new URLSearchParams(`${key}=x`)),
                `${key} must suppress the restore`,
            ).toBe(false);
        }
    });

    // THE case this function exists for, and the one the superset property
    // proven above cannot reach: `filter` is a DEEP-LINK param, deliberately
    // absent from PERSISTED_FILTER_PARAMS. A gate consulting the persisted list
    // instead of the suppressing list reads this URL as "no filters present"
    // and merges the saved domain/type over it — re-narrowing the very link
    // that exists to show file issues across every media type. Swapping the
    // constant back is what this assertion catches.
    it('suppresses the restore for a bare ?filter=file-issues deep link', () => {
        expect(shouldRestoreSavedFilters(new URLSearchParams('filter=file-issues'))).toBe(false);
    });

    it.each(['added_since=24h', 'updated_since=7d'])(
        'suppresses the restore for the %s deep link',
        (search) => {
            expect(shouldRestoreSavedFilters(new URLSearchParams(search))).toBe(false);
        },
    );

    it('ignores a param that is present but empty', () => {
        // `?domain=` selects nothing — it is a cleared control, not a choice of
        // view, so it must not block the restore. Guards a "simplification" to
        // `params.has(key)`, which would treat it as a filter.
        expect(shouldRestoreSavedFilters(new URLSearchParams('domain='))).toBe(true);
        expect(shouldRestoreSavedFilters(new URLSearchParams('filter=&type='))).toBe(true);
    });

    it('sees a non-empty value in a repeated param', () => {
        // `get()` returns only the FIRST value, so a check built on it reads
        // this URL as empty and restores over an explicit `type=track`.
        expect(shouldRestoreSavedFilters(new URLSearchParams('type=&type=track'))).toBe(false);
    });
});

describe('saved view', () => {
    it('persists the selected view with the other filters', () => {
        const storage = memoryStorage();
        saveFilters(storage, new URLSearchParams('view=files&domain=music'));
        expect(loadSavedFilters(storage)).toMatchObject({ view: 'files', domain: 'music' });
    });

    it('does not restore over a triage hop from the detail page', () => {
        expect(shouldRestoreSavedFilters(new URLSearchParams('triage=first'))).toBe(false);
        expect(shouldRestoreSavedFilters(new URLSearchParams('view=lost'))).toBe(false);
    });
});

describe('explicit browser return', () => {
    it('round trips bounded selection, scroll, focus, layout and page size for the exact query', () => {
        const storage = memoryStorage();
        const state = {
            url: '/admin/library/media?q=Lantern&scope=title',
            selected: [['episode-a', { id: 'episode-a' }]] as Array<[string, { id: string }]>,
            scroll: 830,
            focusId: 'item-a',
            focusHref: '/admin/library/media/episode-a',
            layout: 'grid',
            pageSize: 100,
        };
        saveBrowserReturn(storage, state);
        expect(loadBrowserReturn(storage, state.url)).toEqual(state);
        expect(loadBrowserReturn(storage, '/admin/library/media?q=Other')).toBeNull();
    });
    it.each(['q=Lantern', 'scope=title', 'scope=metadata', 'restore=1'])(
        'does not overwrite an explicit destination with saved filters: %s',
        (query) => {
            expect(shouldRestoreSavedFilters(new URLSearchParams(query))).toBe(false);
        },
    );
});
