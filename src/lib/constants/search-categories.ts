// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Search Category Configuration
 *
 * Defines the SearchCategory domain model and all category data (ref: DL-004).
 *
 * Design: plain data (type + constant array + lookup functions).
 * A class is not used because CategoryConfig is a Zod schema (classes break JSON
 * serialization) and configuration data in this codebase uses plain objects and
 * utility functions (ref: DL-004).
 *
 * Lookup functions:
 *   getCategoryIcon(key)      - returns icon component (Film fallback for unknown keys)
 *   getPlaybackMediaType(key) - returns canonical lowercase media type or undefined
 *   categoryHasSimilar(key)   - returns whether similar-content suggestions are supported
 *
 * All category-related lookups use the utility functions exported from this file.
 */

import * as m from '$lib/paraglide/messages';
import {
    Film,
    Tv,
    BookOpen,
    Sparkles,
    Radio,
    PlayCircle,
    VideoCamera,
    AcademicCap,
    Folder,
    MusicalNote,
} from 'svelte-hero-icons';

// =============================================================================
// SearchCategory Domain Model
// =============================================================================

export interface SearchCategory {
    /** Category identifier (matches SearchMediaType values) */
    key: string;
    /** Localised display label getter */
    readonly label: string;
    /** Svelte Hero Icons component */
    icon: typeof Film;
    /** Tailwind text-color class */
    color: string;
    /** Tailwind icon-color class */
    iconColor: string;
    /**
     * Canonical lowercase media type for watch-party and onselectitem callbacks.
     * undefined for categories that have no playback equivalent (books, audiobooks, requests).
     */
    playbackMediaType?: 'movie' | 'tv' | 'episode' | 'tvchannel';
    /** Whether this category supports "similar content" suggestions */
    supportsSimilar: boolean;
    /**
     * True for categories backed by an external service (Kavita, Audiobookshelf, Jellyseerr).
     * These do not navigate to the internal media modal on click.
     */
    isExternalService: boolean;
}

// =============================================================================
// SEARCH_CATEGORIES constant array
// =============================================================================

/**
 * All search categories with their full metadata.
 * Labels are computed at call-time so paraglide translations are resolved after init.
 */
const buildSearchCategories = (): SearchCategory[] => [
    {
        key: 'tvchannel',
        get label() {
            return m.search_tv_channels();
        },
        icon: Radio,
        color: 'text-red-400',
        iconColor: 'text-red-400',
        playbackMediaType: 'tvchannel',
        supportsSimilar: false,
        isExternalService: false,
    },
    {
        key: 'livetv_program',
        get label() {
            return m.search_livetv_programs();
        },
        icon: Radio,
        color: 'text-red-400',
        iconColor: 'text-red-400',
        playbackMediaType: undefined,
        supportsSimilar: false,
        isExternalService: false,
    },
    {
        key: 'movie',
        get label() {
            return m.search_movies();
        },
        icon: Film,
        color: 'text-blue-400',
        iconColor: 'text-blue-400',
        playbackMediaType: 'movie',
        supportsSimilar: true,
        isExternalService: false,
    },
    {
        key: 'tv',
        get label() {
            return m.search_series();
        },
        icon: Tv,
        color: 'text-green-400',
        iconColor: 'text-green-400',
        playbackMediaType: 'tv',
        supportsSimilar: true,
        isExternalService: false,
    },
    {
        key: 'episode',
        get label() {
            return m.search_episodes();
        },
        icon: PlayCircle,
        color: 'text-emerald-400',
        iconColor: 'text-emerald-400',
        playbackMediaType: 'episode',
        supportsSimilar: true,
        isExternalService: false,
    },
    {
        key: 'book',
        get label() {
            return m.search_books();
        },
        icon: BookOpen,
        color: 'text-amber-400',
        iconColor: 'text-amber-400',
        playbackMediaType: undefined,
        supportsSimilar: false,
        isExternalService: true,
    },
    {
        key: 'manga',
        get label() {
            return m.search_manga();
        },
        icon: BookOpen,
        color: 'text-pink-400',
        iconColor: 'text-pink-400',
        playbackMediaType: undefined,
        supportsSimilar: false,
        isExternalService: true,
    },
    {
        key: 'comic',
        get label() {
            return m.search_comics();
        },
        icon: BookOpen,
        color: 'text-cyan-400',
        iconColor: 'text-cyan-400',
        playbackMediaType: undefined,
        supportsSimilar: false,
        isExternalService: true,
    },
    {
        key: 'audiobook',
        get label() {
            return m.search_audiobooks();
        },
        icon: BookOpen,
        color: 'text-orange-400',
        iconColor: 'text-orange-400',
        playbackMediaType: undefined,
        supportsSimilar: false,
        isExternalService: true,
    },
    {
        key: 'music',
        get label() {
            return m.search_music();
        },
        icon: MusicalNote,
        color: 'text-violet-400',
        iconColor: 'text-violet-400',
        playbackMediaType: undefined,
        supportsSimilar: true,
        isExternalService: false,
    },
    {
        key: 'anfragen',
        get label() {
            return m.search_requests();
        },
        icon: Sparkles,
        color: 'text-purple-400',
        iconColor: 'text-purple-400',
        playbackMediaType: undefined,
        supportsSimilar: false,
        isExternalService: true,
    },
    {
        key: 'home_video',
        get label() {
            return m.search_home_videos();
        },
        icon: VideoCamera,
        color: 'text-rose-400',
        iconColor: 'text-rose-400',
        playbackMediaType: undefined,
        supportsSimilar: false,
        isExternalService: false,
    },
    {
        key: 'training',
        get label() {
            return m.search_training();
        },
        icon: AcademicCap,
        color: 'text-teal-400',
        iconColor: 'text-teal-400',
        playbackMediaType: undefined,
        supportsSimilar: false,
        isExternalService: false,
    },
    {
        key: 'educational',
        get label() {
            return m.search_educational();
        },
        icon: BookOpen,
        color: 'text-indigo-400',
        iconColor: 'text-indigo-400',
        playbackMediaType: undefined,
        supportsSimilar: false,
        isExternalService: false,
    },
    {
        key: 'personal',
        get label() {
            return m.search_personal();
        },
        icon: Folder,
        color: 'text-stone-400',
        iconColor: 'text-stone-400',
        playbackMediaType: undefined,
        supportsSimilar: false,
        isExternalService: false,
    },
];

// =============================================================================
// Public API
// =============================================================================

// Memoised: buildSearchCategories() is pure static config; rebuild only once per module load.
// Getter-based `label` properties still resolve translations at access time — no re-allocation needed.
let _categoriesCache: SearchCategory[] | null = null;
function getCategories(): SearchCategory[] {
    if (!_categoriesCache) _categoriesCache = buildSearchCategories();
    return _categoriesCache;
}

/**
 * Get all search categories with localised labels.
 * Backward-compatible replacement for the original getSearchCategories().
 */
export const getSearchCategories = (): SearchCategory[] => getCategories();

/**
 * Look up a category by key.
 * Returns undefined when the key is not a known category.
 */
export function getSearchCategory(key: string): SearchCategory | undefined {
    return getCategories().find((c) => c.key === key);
}

/**
 * Get the icon component for a category key.
 * Falls back to Film when the key is not recognised.
 */
export function getCategoryIcon(key: string): typeof Film {
    return getSearchCategory(key)?.icon ?? Film;
}

/**
 * Get the canonical lowercase media type for a category key.
 * Returns undefined for categories without a playback mapping (books, audiobooks, requests).
 */
export function getPlaybackMediaType(
    key: string,
): 'movie' | 'tv' | 'episode' | 'tvchannel' | undefined {
    return getSearchCategory(key)?.playbackMediaType;
}

/**
 * Whether a category supports "similar content" suggestions.
 */
export function categoryHasSimilar(key: string): boolean {
    return getSearchCategory(key)?.supportsSimilar ?? false;
}
