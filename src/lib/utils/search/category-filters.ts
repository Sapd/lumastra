// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Persisted search-category filters — a localStorage-backed set of the category
 * chips the user has toggled on in the search modal (e.g. Movies + Music). The
 * selection survives closing the modal and reloading the page so the user's
 * preferred search scope sticks.
 *
 * Client-only and best-effort: every accessor is guarded so SSR (no
 * localStorage) and storage failures (quota, privacy mode) degrade to an empty
 * selection rather than throwing.
 */

import { toInternalMediaType, toPublicMediaType } from '$lib/shared/media-type-domain';

const STORAGE_KEY = 'lumastra:search-category-filters:v1';

/** Persisted category-filter keys (empty means "search all categories"). */
export function getCategoryFilters(): string[] {
    if (typeof localStorage === 'undefined') return [];
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((v): v is string => typeof v === 'string');
    } catch {
        return [];
    }
}

/**
 * Persist the current category-filter selection. An empty array clears the
 * stored key so the default "search all" state doesn't linger.
 */
export function saveCategoryFilters(keys: Iterable<string>): void {
    if (typeof localStorage === 'undefined') return;
    try {
        const list = Array.from(keys);
        if (list.length === 0) {
            localStorage.removeItem(STORAGE_KEY);
            return;
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch {
        // ignore
    }
}

/**
 * URL query parameter that carries the category selection, so a search link
 * (`?q=…&types=movie,series`) reopens with the same chips pressed. Same name and
 * comma-separated shape as the `types` param of `GET /api/search`.
 */
export const CATEGORY_FILTERS_URL_PARAM = 'types';

/**
 * Chip key → URL token. The `tv` chip is written as the public `series` token
 * (what the search API documents); keys without a public media type
 * (`anfragen`, `livetv_program`, …) are written as-is.
 */
function toUrlToken(key: string): string {
    const publicType = toPublicMediaType(key);
    // Only rename when the round trip lands on the same chip: `music` must not
    // turn into a narrower public type.
    return publicType && toInternalMediaType(publicType) === key ? publicType : key;
}

/** URL token → chip key (`series` → `tv`); unknown tokens are kept for the caller to filter. */
function fromUrlToken(token: string): string {
    const lower = token.trim().toLowerCase();
    const internal = toInternalMediaType(lower);
    return internal && toUrlToken(internal) === lower ? internal : lower;
}

/**
 * Parse the `types` URL value into chip keys. Drops empty and unknown tokens
 * (when `knownKeys` is given) and duplicates; returns `null` when the param is
 * absent so callers can fall back to the persisted selection.
 */
export function parseCategoryFiltersParam(
    value: string | null,
    knownKeys?: ReadonlySet<string>,
): string[] | null {
    if (value === null) return null;
    const keys = new Set<string>();
    for (const token of value.split(',')) {
        if (!token.trim()) continue;
        const key = fromUrlToken(token);
        if (knownKeys && !knownKeys.has(key)) continue;
        keys.add(key);
    }
    return [...keys];
}

/** Format chip keys for the `types` URL param; `null` (= drop the param) when nothing is selected. */
export function formatCategoryFiltersParam(keys: Iterable<string>): string | null {
    const tokens = [...new Set(Array.from(keys, toUrlToken))].sort();
    return tokens.length > 0 ? tokens.join(',') : null;
}
