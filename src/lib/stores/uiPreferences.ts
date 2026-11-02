// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * User UI Preferences Store
 *
 * Persists to localStorage across sessions.
 *
 * Dock visibility is NOT here: it lives in `dock.store.ts` with the rest of the
 * dock's display state, because the rail's width is the main content's gutter
 * and that has to be decided on the server. See the header there.
 */

import { writable, get } from 'svelte/store';
import { browser } from '$app/environment';
import { isRecord } from '$lib/utils/data-extraction';

const STORAGE_KEY = 'uiPreferences';

interface UIPreferences {
    showStreamTechInfo: boolean;
    heroAutoplayVideo: boolean;
    posterHoverPreview: boolean;
}

const defaultPreferences: UIPreferences = {
    showStreamTechInfo: true,
    heroAutoplayVideo: true,
    posterHoverPreview: true,
};

function loadPreferences(): UIPreferences {
    if (!browser) return defaultPreferences;

    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            const parsed: unknown = JSON.parse(stored);
            if (isRecord(parsed)) {
                return {
                    showStreamTechInfo:
                        typeof parsed.showStreamTechInfo === 'boolean'
                            ? parsed.showStreamTechInfo
                            : defaultPreferences.showStreamTechInfo,
                    heroAutoplayVideo:
                        typeof parsed.heroAutoplayVideo === 'boolean'
                            ? parsed.heroAutoplayVideo
                            : defaultPreferences.heroAutoplayVideo,
                    posterHoverPreview:
                        typeof parsed.posterHoverPreview === 'boolean'
                            ? parsed.posterHoverPreview
                            : defaultPreferences.posterHoverPreview,
                };
            }
        }
    } catch (error) {
        console.error('[UIPreferences] Failed to load preferences:', error);
    }

    return defaultPreferences;
}

function savePreferences(prefs: UIPreferences): void {
    if (!browser) return;

    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch (error) {
        console.error('[UIPreferences] Failed to save preferences:', error);
    }
}

function createUIPreferencesStore() {
    const { subscribe, set, update } = writable<UIPreferences>(defaultPreferences);

    return {
        subscribe,

        /**
         * Initialize store from localStorage (call on mount)
         */
        init() {
            const prefs = loadPreferences();
            set(prefs);
        },

        /**
         * Toggle stream tech info visibility on hover
         */
        toggleStreamTechInfo() {
            update((prefs) => {
                const newPrefs = {
                    ...prefs,
                    showStreamTechInfo: !prefs.showStreamTechInfo,
                };
                savePreferences(newPrefs);
                return newPrefs;
            });
        },

        /**
         * Toggle autoplaying video in the homepage hero
         */
        toggleHeroAutoplayVideo() {
            update((prefs) => {
                const newPrefs = {
                    ...prefs,
                    heroAutoplayVideo: !prefs.heroAutoplayVideo,
                };
                savePreferences(newPrefs);
                return newPrefs;
            });
        },

        /**
         * Toggle on-hover video previews on media posters
         */
        togglePosterHoverPreview() {
            update((prefs) => {
                const newPrefs = {
                    ...prefs,
                    posterHoverPreview: !prefs.posterHoverPreview,
                };
                savePreferences(newPrefs);
                return newPrefs;
            });
        },

        /**
         * Get current preferences (non-reactive)
         */
        get() {
            return get({ subscribe });
        },
    };
}

export const uiPreferences = createUIPreferencesStore();

// Derived stores for individual preferences
// (dock visibility: see `dockVisible` in $lib/stores/dock.store)

export const showStreamTechInfo = {
    subscribe: (fn: (value: boolean) => void) => {
        return uiPreferences.subscribe((prefs) => fn(prefs.showStreamTechInfo));
    },
};

export const heroAutoplayVideo = {
    subscribe: (fn: (value: boolean) => void) => {
        return uiPreferences.subscribe((prefs) => fn(prefs.heroAutoplayVideo));
    },
};

export const posterHoverPreview = {
    subscribe: (fn: (value: boolean) => void) => {
        return uiPreferences.subscribe((prefs) => fn(prefs.posterHoverPreview));
    },
};
