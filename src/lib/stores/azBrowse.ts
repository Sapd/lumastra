// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A-Z Browse Store
 *
 * Manages state and logic for A-Z (alphabetical) browse mode.
 * Extracted from browse/+page.svelte for reusability and separation of concerns.
 */

/* eslint-disable svelte/no-navigation-without-resolve -- Using resolve from $lib/paths wrapper */

import { writable, derived, get } from 'svelte/store';
import { browser } from '$app/environment';
import { goto } from '$app/navigation';
import { resolve } from '$lib/paths';
import * as browseApi from '$lib/api/browse';
import type { UniversalMediaItem } from '$lib/types/server-driven-ui';
import { isSeries } from '$lib/shared/media-types';
import type { LibraryItem } from '$lib/schemas/api-browse-responses';
import {
    type AudioFilterLang,
    type SubtitleFilterLang,
    AUDIO_FILTER_LANGUAGES,
    SUBTITLE_FILTER_LANGUAGES,
    parseLangCsv,
} from '$lib/shared/track-language.js';
import { RESOLUTION_TIERS, HDR_TIERS, CODEC_TIERS } from '$lib/shared/quality-filter.js';
// Re-exported from its SvelteKit-free home so `+page.ts` load functions can
// import the predicate without pulling in this store (and $app/navigation).
export { isAzRoutePath } from '$lib/shared/browse-filter-route.js';

/** Storage key for A-Z mode preference */
const AZ_MODE_STORAGE_KEY = 'browse-az-mode-preference';
/** Storage key for A-Z audio/subtitle language filter */
const AZ_LANG_FILTER_STORAGE_KEY = 'browse-az-lang-filter';
/** Storage key for A-Z sort + quality filter view preferences */
const AZ_VIEW_PREFS_STORAGE_KEY = 'browse-az-view-prefs';

/** A-Z media type filter */
export type AzMediaType = 'all' | 'movie' | 'tv';

/** Sort order for A-Z browse results */
export type BrowseSort =
    'title_asc' | 'title_desc' | 'added_desc' | 'year_desc' | 'year_asc' | 'rating_desc';

const BROWSE_SORTS: readonly BrowseSort[] = [
    'title_asc',
    'title_desc',
    'added_desc',
    'year_desc',
    'year_asc',
    'rating_desc',
];

/** Type guard validating a raw string against the BrowseSort enum */
function isBrowseSort(value: string | null | undefined): value is BrowseSort {
    return value != null && (BROWSE_SORTS as readonly string[]).includes(value);
}

/**
 * Filter a restored token array (from localStorage or a URL param) down to
 * the valid tier vocabulary, dropping anything unrecognized. Guards against a
 * stale/hand-edited localStorage blob or URL replaying a tier value that no
 * longer exists (or never did) reaching the API as an opaque, silently-empty
 * filter.
 */
function filterValidTiers<T extends string>(values: unknown, allowed: readonly T[]): T[] {
    if (!Array.isArray(values)) return [];
    return values.filter(
        (v): v is T => typeof v === 'string' && (allowed as readonly string[]).includes(v),
    );
}

/** Browse tab type (matches browse page) */
export type BrowseTab = 'all' | 'movies' | 'series' | 'channels';

/** Library info from the API */
export interface AzLibrary {
    id: string;
    name: string;
    itemCount?: number;
    mediaType?: 'movie' | 'tv' | 'mixed';
    icon?: string;
    description?: string;
}

/** A-Z browse state */
export interface AzBrowseState {
    /** Whether A-Z mode is active */
    enabled: boolean;
    /** Current media type filter */
    mediaType: AzMediaType;
    /** Currently selected group ID (null = all groups) */
    selectedGroupId: string | null;
    /** Currently selected jump-nav letter ('A'..'Z' or '#'); null = all letters */
    selectedLetter: string | null;
    // NO genre/tag. A filter belongs to the /browse/filter results view, which
    // holds it as route state and passes it to <AzBrowseView> as a prop. Keeping
    // it here is what let a filter leak onto `/browse?mode=az` — see buildUrl.
    /** Selected audio languages (subset of AUDIO_FILTER_LANGUAGES) */
    audioLangs: AudioFilterLang[];
    /** Selected subtitle languages (subset of SUBTITLE_FILTER_LANGUAGES) */
    subLangs: SubtitleFilterLang[];
    /** Include items with no language data of the filtered kind */
    includeUnknown: boolean;
    /** Sort order for browse results */
    sort: BrowseSort;
    /** Selected resolution tiers (e.g. '4K', '1080p', '720p', 'SD') */
    resolutions: string[];
    /** Selected HDR tiers (e.g. 'dolby_vision', 'hdr', 'sdr') */
    hdr: string[];
    /** Selected codec tiers (e.g. 'hevc', 'h264', 'av1', 'other') */
    codecs: string[];
    /** Include items with no quality data of the filtered kind */
    qualityIncludeUnknown: boolean;
    /** Current items loaded */
    items: UniversalMediaItem[];
    /** Loading state for items */
    loading: boolean;
    /** Current offset for pagination */
    offset: number;
    /** Total count of items */
    totalCount: number;
    /** Whether more items are available */
    hasMore: boolean;
    /** Available libraries */
    libraries: AzLibrary[];
    /** Loading state for libraries */
    librariesLoading: boolean;
}

const initialState: AzBrowseState = {
    enabled: false,
    mediaType: 'all',
    selectedGroupId: null,
    selectedLetter: null,
    audioLangs: [],
    subLangs: [],
    includeUnknown: false,
    sort: 'title_asc',
    resolutions: [],
    hdr: [],
    codecs: [],
    qualityIncludeUnknown: false,
    items: [],
    loading: false,
    offset: 0,
    totalCount: 0,
    hasMore: false,
    libraries: [],
    librariesLoading: false,
};

/**
 * Create an A-Z browse store instance.
 *
 * @param config - Optional configuration
 * @returns Store with A-Z browse methods
 */
export function createAzBrowseStore(config?: {
    pageSize?: number;
    /**
     * A sort this view owns instead of the remembered A-Z preference — the
     * Recently Added grid is newest-first by definition. It is the default when
     * the URL names none (and so is omitted from emitted URLs), and the sort is
     * never written to the remembered preference: `saveViewPrefs` persists sort
     * and quality tiers as one blob, so a quality change here would otherwise
     * save this view's sort as the user's A-Z sort.
     */
    ownSort?: BrowseSort;
}) {
    const pageSize = config?.pageSize ?? 50;
    const ownSort = config?.ownSort;
    const defaultSort: BrowseSort = ownSort ?? 'title_asc';
    const { subscribe, set, update } = writable<AzBrowseState>(initialState);

    function saveStoredPreference(key: string, value: string): void {
        try {
            localStorage.setItem(key, value);
        } catch {
            // Preferences are optional; blocked storage must not break Browse controls.
        }
    }

    /**
     * Save A-Z preference to localStorage
     */
    function savePreference(): void {
        if (!browser) return;
        const state = get({ subscribe });
        saveStoredPreference(AZ_MODE_STORAGE_KEY, JSON.stringify({ enabled: state.enabled }));
    }

    /**
     * Load A-Z preference from localStorage
     */
    function loadPreference(): boolean {
        if (!browser) return false;
        try {
            const stored = localStorage.getItem(AZ_MODE_STORAGE_KEY);
            if (stored) {
                const pref: unknown = JSON.parse(stored);
                return (
                    typeof pref === 'object' &&
                    pref !== null &&
                    (pref as { enabled?: boolean }).enabled === true
                );
            }
        } catch {
            /* expected: JSON.parse failure on malformed localStorage preference */
        }
        return false;
    }

    /**
     * Save A-Z audio/subtitle language filter to localStorage
     */
    function saveLangFilter(): void {
        if (!browser) return;
        const s = get({ subscribe });
        saveStoredPreference(
            AZ_LANG_FILTER_STORAGE_KEY,
            JSON.stringify({
                audioLangs: s.audioLangs,
                subLangs: s.subLangs,
                includeUnknown: s.includeUnknown,
            }),
        );
    }

    /**
     * Load A-Z audio/subtitle language filter from localStorage
     */
    function loadLangFilter(): Pick<
        AzBrowseState,
        'audioLangs' | 'subLangs' | 'includeUnknown'
    > | null {
        if (!browser) return null;
        try {
            const raw = localStorage.getItem(AZ_LANG_FILTER_STORAGE_KEY);
            if (!raw) return null;
            const p = JSON.parse(raw) as Partial<AzBrowseState>;
            return {
                audioLangs: filterValidTiers(p.audioLangs, AUDIO_FILTER_LANGUAGES),
                subLangs: filterValidTiers(p.subLangs, SUBTITLE_FILTER_LANGUAGES),
                includeUnknown: p.includeUnknown === true,
            };
        } catch {
            /* expected: JSON.parse failure on malformed localStorage preference */
            return null;
        }
    }

    /**
     * Set the audio/subtitle language filter and persist it
     */
    function setLanguageFilter(next: {
        audioLangs: AudioFilterLang[];
        subLangs: SubtitleFilterLang[];
        includeUnknown: boolean;
    }): void {
        update((s) => ({ ...s, ...next }));
        saveLangFilter();
    }

    /**
     * Save A-Z sort + quality filter view preferences to localStorage
     */
    function saveViewPrefs(): void {
        if (!browser) return;
        const s = get({ subscribe });
        saveStoredPreference(
            AZ_VIEW_PREFS_STORAGE_KEY,
            JSON.stringify({
                // An owned sort is the view's, not the user's: keep whatever
                // A-Z sort was remembered before.
                sort: ownSort ? (loadViewPrefs()?.sort ?? 'title_asc') : s.sort,
                resolutions: s.resolutions,
                hdr: s.hdr,
                codecs: s.codecs,
                qualityIncludeUnknown: s.qualityIncludeUnknown,
            }),
        );
    }

    /**
     * Load A-Z sort + quality filter view preferences from localStorage
     */
    function loadViewPrefs(): Pick<
        AzBrowseState,
        'sort' | 'resolutions' | 'hdr' | 'codecs' | 'qualityIncludeUnknown'
    > | null {
        if (!browser) return null;
        try {
            const raw = localStorage.getItem(AZ_VIEW_PREFS_STORAGE_KEY);
            if (!raw) return null;
            const p = JSON.parse(raw) as Partial<AzBrowseState>;
            return {
                sort: isBrowseSort(p.sort) ? p.sort : 'title_asc',
                resolutions: filterValidTiers(p.resolutions, RESOLUTION_TIERS),
                hdr: filterValidTiers(p.hdr, HDR_TIERS),
                codecs: filterValidTiers(p.codecs, CODEC_TIERS),
                qualityIncludeUnknown: p.qualityIncludeUnknown === true,
            };
        } catch {
            /* expected: JSON.parse failure on malformed localStorage preference */
            return null;
        }
    }

    /**
     * Set the sort order and persist it. Switching away from the title sorts
     * also clears any selected jump-nav letter — the letter rail is hidden for
     * non-title sorts, and a stale `selectedLetter` would otherwise linger in
     * state and leak into the URL via buildUrl on the next navigation.
     */
    function setSort(sort: BrowseSort): void {
        const isTitleSort = sort === 'title_asc' || sort === 'title_desc';
        update((s) => ({ ...s, sort, selectedLetter: isTitleSort ? s.selectedLetter : null }));
        saveViewPrefs();
    }

    /**
     * Set the quality filter (resolution/HDR/codec tiers) and persist it
     */
    function setQualityFilter(next: {
        resolutions: string[];
        hdr: string[];
        codecs: string[];
        qualityIncludeUnknown: boolean;
    }): void {
        update((s) => ({ ...s, ...next }));
        saveViewPrefs();
    }

    /**
     * Every grid dimension this store owns, as query params — WITHOUT `mode` and
     * without a path.
     *
     * Split out from {@link buildUrl} so /browse/filter can compose the same
     * dimensions onto its own route and add its own `tag`/`genre`, which this
     * store deliberately no longer knows about (see the note on buildUrl).
     *
     * Callers REPLACE the whole query string with this, so a dimension missing
     * from the list is silently dropped the next time any control fires.
     */
    function buildParams(activeTab: BrowseTab): URLSearchParams {
        const state = get({ subscribe });
        const params = new URLSearchParams();
        if (activeTab !== 'all') params.set('type', activeTab);
        if (state.selectedGroupId) params.set('libraryGroupId', state.selectedGroupId);
        if (state.selectedLetter) params.set('letter', state.selectedLetter);
        if (state.audioLangs.length) params.set('audio', state.audioLangs.join(','));
        if (state.subLangs.length) params.set('subs', state.subLangs.join(','));
        if (state.includeUnknown) params.set('includeUnknown', 'true');
        if (state.sort !== defaultSort) params.set('sort', state.sort);
        if (state.resolutions.length) params.set('res', state.resolutions.join(','));
        if (state.hdr.length) params.set('hdr', state.hdr.join(','));
        if (state.codecs.length) params.set('codec', state.codecs.join(','));
        if (state.qualityIncludeUnknown) params.set('qUnknown', 'true');
        return params;
    }

    /**
     * Build URL for A-Z mode with current filters.
     *
     * Emits NO `genre`/`tag`, and the store holds neither. A filter is a
     * property of the /browse/filter results view, not of A-Z mode, and this is
     * the mechanism that enforces it: A-Z's URL is rewritten from store state on
     * every control interaction, so as long as the state cannot express a filter,
     * no A-Z URL can either.
     *
     * That matters because this emits the `/browse?mode=az` form — the RAILS
     * route — which a redirect on /browse/az could never intercept. When the
     * store still carried genre/tag, one tap of a letter under
     * `/browse/az?tag=whodunit` produced `/browse?mode=az&tag=whodunit`: a
     * filtered A-Z view with no chip and no picker, i.e. the dead end this whole
     * design removes.
     */
    function buildUrl(activeTab: BrowseTab): string {
        const params = buildParams(activeTab);
        // `mode` first, matching the previous emission order byte for byte.
        const withMode = new URLSearchParams({ mode: 'az' });
        for (const [key, value] of params) withMode.set(key, value);
        return `/browse?${withMode.toString()}`;
    }

    /**
     * Load items from the API
     */
    async function loadItems(reset = false): Promise<void> {
        const state = get({ subscribe });
        if (state.loading) return;

        update((s) => ({
            ...s,
            loading: true,
            items: reset ? [] : s.items,
            offset: reset ? 0 : s.offset,
        }));

        try {
            const currentState = get({ subscribe });
            const { data } = await browseApi.getAzBrowse({
                letter: undefined,
                libraryGroupId: currentState.selectedGroupId ?? undefined,
                type: currentState.mediaType === 'all' ? undefined : currentState.mediaType,
                offset: currentState.offset,
                limit: pageSize,
            });

            // Cast to expected shape - the API returns the standard response format
            const response = data as {
                items?: UniversalMediaItem[];
                totalCount?: number;
                hasMore?: boolean;
                nextOffset?: number;
            } | null;

            update((s) => ({
                ...s,
                items: reset ? response?.items || [] : [...s.items, ...(response?.items || [])],
                totalCount: response?.totalCount ?? 0,
                hasMore: response?.hasMore ?? false,
                offset: response?.nextOffset ?? 0,
                loading: false,
            }));
        } catch (e) {
            console.error('Failed to load A-Z items:', e);
            update((s) => ({ ...s, loading: false }));
        }
    }

    /**
     * Load available libraries from the API
     */
    async function loadLibraries(): Promise<void> {
        const state = get({ subscribe });
        if (state.librariesLoading || state.libraries.length > 0) return;

        update((s) => ({ ...s, librariesLoading: true }));

        try {
            const { data } = await browseApi.getLibraries();

            // API wire format uses 'series' (public convention); this store's
            // AzLibrary type follows the storage/comparison convention ('tv') so
            // it lines up with AzMediaType ('all' | 'movie' | 'tv') comparisons
            // done by consumers (this store's toggle()/selectGroup() and
            // /browse/+page.svelte's handleTabChange()).
            const libraries: AzLibrary[] = (data?.libraries ?? []).map((lib: LibraryItem) => ({
                id: lib.id,
                name: lib.name,
                itemCount: lib.itemCount,
                mediaType: lib.mediaType === 'series' ? 'tv' : lib.mediaType,
                icon: lib.icon,
                description: lib.description,
            }));
            update((s) => ({
                ...s,
                libraries,
                librariesLoading: false,
            }));
        } catch (e) {
            console.error('Failed to load libraries:', e);
            update((s) => ({ ...s, librariesLoading: false }));
        }
    }

    /**
     * Select a group and reload items
     */
    function selectGroup(libraryGroupId: string | null, activeTab: BrowseTab): void {
        // Changing the library resets the letter filter (the previous letter may
        // have no items in the new library), matching AzBrowseView's behaviour.
        update((s) => ({ ...s, selectedGroupId: libraryGroupId, selectedLetter: null }));
        void goto(resolve(buildUrl(activeTab)), { replaceState: true });
        void loadItems(true);
    }

    /**
     * Toggle A-Z mode on/off
     */
    function toggle(activeTab: BrowseTab): void {
        update((s) => {
            const newEnabled = !s.enabled;

            if (newEnabled) {
                // Sync mediaType with activeTab: movies → movie, series → tv, all → all
                const newMediaType: AzMediaType = isSeries(activeTab)
                    ? 'tv'
                    : activeTab === 'movies'
                      ? 'movie'
                      : 'all';

                // Clear group selection if incompatible
                let selectedGroupId = s.selectedGroupId;
                if (selectedGroupId && newMediaType !== 'all') {
                    const selectedLib = s.libraries.find((lib) => lib.id === selectedGroupId);
                    if (
                        selectedLib &&
                        selectedLib.mediaType !== 'mixed' &&
                        selectedLib.mediaType !== newMediaType
                    ) {
                        selectedGroupId = null;
                    }
                }

                return {
                    ...s,
                    enabled: true,
                    mediaType: newMediaType,
                    selectedGroupId,
                };
            } else {
                return { ...s, enabled: false };
            }
        });

        const state = get({ subscribe });
        savePreference();

        if (state.enabled) {
            // Data fetching is owned by AzBrowseView: flipping `enabled` true
            // mounts <AzBrowseView>, whose onMount loads libraries + items. Firing
            // the store's loadLibraries/loadItems here too would double-fetch into
            // state that nothing renders — so only sync the URL.
            void goto(resolve(buildUrl(activeTab)), { replaceState: true });
        } else {
            // Preserve current tab when disabling A-Z
            const url = activeTab === 'all' ? '/browse' : `/browse?type=${activeTab}`;
            void goto(resolve(url), { replaceState: true });
        }
    }

    /**
     * Set media type filter
     */
    function setMediaType(mediaType: AzMediaType): void {
        update((s) => ({ ...s, mediaType }));
    }

    /**
     * Initialize from URL params.
     *
     * @param params - the query string to read
     * @param options.forceEnabled - treat this as A-Z regardless of `?mode=az`
     *   and of the stored preference. The /browse/az ROUTE is itself the mode
     *   signal (it carries no `mode` param), so its page passes
     *   `isAzRoutePath(url.pathname)` here. Without it every /browse/az link
     *   fell through to the preference branch and — with A-Z off, the default —
     *   rendered the ordinary rails page, silently ignoring the whole deep link.
     */
    function initFromUrl(params: URLSearchParams, options?: { forceEnabled?: boolean }): void {
        const mode = params.get('mode');
        const type = params.get('type');
        const libraryGroupId = params.get('libraryGroupId');
        const letter = params.get('letter');

        // Both signals take the SAME branch: a /browse/az deep link must honour
        // letter/libraryGroupId/sort/language/quality exactly like `?mode=az` does, not
        // merely flip `enabled`.
        const enabled =
            mode === 'discover'
                ? false
                : mode === 'az' || options?.forceEnabled === true || loadPreference();
        const mediaType: AzMediaType = isSeries(type) ? 'tv' : type === 'movies' ? 'movie' : 'all';

        const audioParam = params.get('audio');
        const subsParam = params.get('subs');
        const includeUnknownParam = params.get('includeUnknown') === 'true';
        const hasLangParams =
            audioParam !== null || subsParam !== null || params.has('includeUnknown');
        const fallback = hasLangParams ? null : loadLangFilter();

        const sortParam = params.get('sort');
        const resParam = params.get('res');
        const hdrParam = params.get('hdr');
        const codecParam = params.get('codec');
        const qUnknownParam = params.get('qUnknown') === 'true';
        const hasViewParams =
            sortParam !== null ||
            resParam !== null ||
            hdrParam !== null ||
            codecParam !== null ||
            params.has('qUnknown');
        const viewFallback = hasViewParams ? null : loadViewPrefs();

        // State/URL only — no fetching. <AzBrowseView> is the single fetch
        // owner: when azMode is enabled it mounts and loads its own libraries
        // + items (reacting to mediaType/libraryGroupId prop changes thereafter). The
        // store's items/totalCount/etc. are not rendered anywhere.
        update((s) => ({
            ...s,
            enabled,
            mediaType,
            selectedGroupId: libraryGroupId || null,
            selectedLetter: letter || null,
            audioLangs: hasLangParams
                ? parseLangCsv(audioParam ?? undefined, AUDIO_FILTER_LANGUAGES)
                : (fallback?.audioLangs ?? []),
            subLangs: hasLangParams
                ? parseLangCsv(subsParam ?? undefined, SUBTITLE_FILTER_LANGUAGES)
                : (fallback?.subLangs ?? []),
            includeUnknown: hasLangParams
                ? includeUnknownParam
                : (fallback?.includeUnknown ?? false),
            sort: isBrowseSort(sortParam)
                ? sortParam
                : hasViewParams || ownSort
                  ? defaultSort
                  : (viewFallback?.sort ?? 'title_asc'),
            resolutions: hasViewParams
                ? filterValidTiers(resParam?.split(',').filter(Boolean), RESOLUTION_TIERS)
                : (viewFallback?.resolutions ?? []),
            hdr: hasViewParams
                ? filterValidTiers(hdrParam?.split(',').filter(Boolean), HDR_TIERS)
                : (viewFallback?.hdr ?? []),
            codecs: hasViewParams
                ? filterValidTiers(codecParam?.split(',').filter(Boolean), CODEC_TIERS)
                : (viewFallback?.codecs ?? []),
            qualityIncludeUnknown: hasViewParams
                ? qUnknownParam
                : (viewFallback?.qualityIncludeUnknown ?? false),
        }));
    }

    /**
     * Reset store to initial state
     */
    function reset(): void {
        set(initialState);
    }

    return {
        subscribe,
        set,
        update,
        loadItems,
        loadLibraries,
        selectGroup,
        toggle,
        setMediaType,
        initFromUrl,
        buildUrl,
        buildParams,
        savePreference,
        loadPreference,
        setLanguageFilter,
        setSort,
        setQualityFilter,
        reset,
    };
}

// Convenience exports for consumers who just need the state reactively
export const azBrowseStore = createAzBrowseStore();

// Derived stores for common access patterns
export const azEnabled = derived(azBrowseStore, ($s) => $s.enabled);
export const azItems = derived(azBrowseStore, ($s) => $s.items);
export const azLoading = derived(azBrowseStore, ($s) => $s.loading);
export const azHasMore = derived(azBrowseStore, ($s) => $s.hasMore);
export const azLibraries = derived(azBrowseStore, ($s) => $s.libraries);
export const azSelectedGroupId = derived(azBrowseStore, ($s) => $s.selectedGroupId);
export const azTotalCount = derived(azBrowseStore, ($s) => $s.totalCount);
