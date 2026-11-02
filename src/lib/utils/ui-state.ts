// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * UI state management utilities for localStorage-backed state
 */

import { browser } from '$app/environment';

function parseJson<T>(raw: string, fallback: T): T {
    try {
        return JSON.parse(raw) as T;
    } catch {
        // best-effort: corrupt stored JSON → caller-supplied fallback.
        return fallback;
    }
}

/**
 * Creates a collapse state handler with localStorage persistence
 * @param storageKey - localStorage key for persistence
 * @returns Object with methods to load and save collapse state
 *
 * @example
 * const collapseHandler = createCollapseHandler('watchlist-collapsed');
 * const isCollapsed = collapseHandler.loadState(); // Load from localStorage
 * collapseHandler.saveState(true); // Save to localStorage
 */
export function createCollapseHandler(storageKey: string) {
    return {
        /**
         * Loads collapse state from localStorage
         * @returns Saved collapse state or false if not found
         */
        loadState(): boolean {
            if (!browser) return false;

            try {
                const saved = localStorage.getItem(storageKey);
                if (!saved) return false;
                const parsed = parseJson<unknown>(saved, null);
                return typeof parsed === 'boolean' ? parsed : false;
            } catch (error) {
                console.warn(`Failed to load collapse state for ${storageKey}:`, error);
                return false;
            }
        },

        /**
         * Saves collapse state to localStorage
         * @param state - Collapse state to save
         */
        saveState(state: boolean): void {
            if (!browser) return;

            try {
                localStorage.setItem(storageKey, JSON.stringify(state));
            } catch (error) {
                console.warn(`Failed to save collapse state for ${storageKey}:`, error);
            }
        },

        /**
         * Toggles and saves collapse state
         * @param currentState - Current collapse state
         * @returns New collapse state
         */
        toggle(currentState: boolean): boolean {
            const newState = !currentState;
            this.saveState(newState);
            return newState;
        },
    };
}

/**
 * Creates a generic localStorage handler for any serializable value
 * @param storageKey - localStorage key
 * @param defaultValue - Default value if not found in storage
 * @returns Object with methods to get, set, and remove values
 *
 * @example
 * const episodeLimit = createStorageHandler('episode-limit', 10);
 * const limit = episodeLimit.get(); // Get from localStorage or return 10
 * episodeLimit.set(20); // Save to localStorage
 */
export function createStorageHandler<T>(storageKey: string, defaultValue: T) {
    return {
        /**
         * Gets value from localStorage
         * @returns Stored value or default value
         */
        get(): T {
            if (!browser) return defaultValue;

            try {
                const saved = localStorage.getItem(storageKey);
                return saved ? parseJson<T>(saved, defaultValue) : defaultValue;
            } catch (error) {
                console.warn(`Failed to load from storage (${storageKey}):`, error);
                return defaultValue;
            }
        },

        /**
         * Sets value in localStorage
         * @param value - Value to save
         */
        set(value: T): void {
            if (!browser) return;

            try {
                localStorage.setItem(storageKey, JSON.stringify(value));
            } catch (error) {
                console.warn(`Failed to save to storage (${storageKey}):`, error);
            }
        },

        /**
         * Removes value from localStorage
         */
        remove(): void {
            if (!browser) return;

            try {
                localStorage.removeItem(storageKey);
            } catch (error) {
                console.warn(`Failed to remove from storage (${storageKey}):`, error);
            }
        },
    };
}

/**
 * Saves a value to sessionStorage (temporary storage for current session)
 * @param key - Storage key
 * @param value - Value to save
 */
export function saveToSession<T>(key: string, value: T): void {
    if (!browser) return;

    try {
        sessionStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
        console.warn(`Failed to save to session storage (${key}):`, error);
    }
}

/**
 * Loads a value from sessionStorage
 * @param key - Storage key
 * @param defaultValue - Default value if not found
 * @returns Stored value or default value
 */
export function loadFromSession<T>(key: string, defaultValue: T): T {
    if (!browser) return defaultValue;

    try {
        const saved = sessionStorage.getItem(key);
        return saved ? parseJson<T>(saved, defaultValue) : defaultValue;
    } catch (error) {
        console.warn(`Failed to load from session storage (${key}):`, error);
        return defaultValue;
    }
}
