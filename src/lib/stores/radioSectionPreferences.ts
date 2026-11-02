// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Radio Section Preferences Store
 *
 * Manages user preferences for the Internet Radio section on the /music page.
 * Persists to localStorage for persistence across sessions.
 */

import { writable, get } from 'svelte/store';
import { browser } from '$app/environment';
import { isRecord } from '$lib/utils/data-extraction';

const STORAGE_KEY = 'radioSection.preferences';

export type RadioSectionPosition = 'top' | 'auto' | 'bottom' | 'hidden';
export type RadioSectionCollapsed = 'auto' | 'collapsed' | 'expanded';

export interface RadioSectionPreferences {
    collapsed: RadioSectionCollapsed;
    position: RadioSectionPosition;
}

const defaultPreferences: RadioSectionPreferences = {
    collapsed: 'auto',
    position: 'auto',
};

function loadPreferences(): RadioSectionPreferences {
    if (!browser) return defaultPreferences;

    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            const parsed: unknown = JSON.parse(stored);
            if (isRecord(parsed)) {
                const collapsed = parsed.collapsed;
                const position = parsed.position;
                return {
                    collapsed:
                        collapsed === 'auto' ||
                        collapsed === 'collapsed' ||
                        collapsed === 'expanded'
                            ? (collapsed as RadioSectionCollapsed)
                            : defaultPreferences.collapsed,
                    position:
                        position === 'top' ||
                        position === 'auto' ||
                        position === 'bottom' ||
                        position === 'hidden'
                            ? (position as RadioSectionPosition)
                            : defaultPreferences.position,
                };
            }
        }
    } catch (error) {
        console.error('[RadioSectionPreferences] Failed to load preferences:', error);
    }

    return defaultPreferences;
}

function savePreferences(prefs: RadioSectionPreferences): void {
    if (!browser) return;

    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch (error) {
        console.error('[RadioSectionPreferences] Failed to save preferences:', error);
    }
}

function createRadioSectionPreferencesStore() {
    const { subscribe, set, update } = writable<RadioSectionPreferences>(defaultPreferences);

    return {
        subscribe,

        /**
         * Initialize store from localStorage (call on mount)
         */
        init(): void {
            const prefs = loadPreferences();
            set(prefs);
        },

        /**
         * Set the collapsed preference
         */
        setCollapsed(collapsed: RadioSectionCollapsed): void {
            update((prefs) => {
                const newPrefs = { ...prefs, collapsed };
                savePreferences(newPrefs);
                return newPrefs;
            });
        },

        /**
         * Set the position preference
         */
        setPosition(position: RadioSectionPosition): void {
            update((prefs) => {
                const newPrefs = { ...prefs, position };
                savePreferences(newPrefs);
                return newPrefs;
            });
        },

        /**
         * Get current preferences (non-reactive)
         */
        get(): RadioSectionPreferences {
            return get({ subscribe });
        },
    };
}

export const radioSectionPreferences = createRadioSectionPreferencesStore();
