// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Recent searches — a small localStorage-backed MRU list of the user's recent
 * search queries, shown in the search modal's empty (zero-query) state.
 *
 * Client-only and best-effort: every accessor is guarded so SSR (no
 * localStorage) and storage failures (quota, privacy mode) degrade to an empty
 * list rather than throwing.
 */

const STORAGE_KEY = 'lumastra:recent-searches:v1';
const MAX_RECENT = 8;
const MIN_QUERY_LENGTH = 2;

function readRaw(): string[] {
    if (typeof localStorage === 'undefined') return [];
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((v): v is string => typeof v === 'string').slice(0, MAX_RECENT);
    } catch {
        return [];
    }
}

/** Current recent searches, most-recent first. */
export function getRecentSearches(): string[] {
    return readRaw();
}

/**
 * Record a query at the front of the MRU list (case-insensitive de-dupe),
 * trimmed and capped. No-ops for queries shorter than the search minimum.
 * Returns the updated list.
 */
export function addRecentSearch(query: string): string[] {
    const q = query.trim();
    if (typeof localStorage === 'undefined' || q.length < MIN_QUERY_LENGTH) {
        return readRaw();
    }
    try {
        const existing = readRaw().filter((item) => item.toLowerCase() !== q.toLowerCase());
        const next = [q, ...existing].slice(0, MAX_RECENT);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        return next;
    } catch {
        return readRaw();
    }
}

/** Clear all recent searches. */
export function clearRecentSearches(): void {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        // ignore
    }
}
