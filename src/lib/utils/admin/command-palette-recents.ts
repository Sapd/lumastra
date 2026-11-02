// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { isRecord } from '$lib/utils/data-extraction';

export interface RecentEntry {
    kind: 'page' | 'setting' | 'provider';
    href: string;
    label: string;
    sectionLabel?: string;
    timestamp: number;
}

const STORAGE_KEY = 'admin-command-palette-recents';
const MAX_RECENTS = 5;

function isRecentEntry(value: unknown): value is RecentEntry {
    if (!isRecord(value)) return false;
    return (
        (value.kind === 'page' || value.kind === 'setting' || value.kind === 'provider') &&
        typeof value.href === 'string' &&
        typeof value.label === 'string' &&
        typeof value.timestamp === 'number' &&
        (value.sectionLabel === undefined || typeof value.sectionLabel === 'string')
    );
}

/** Up to `MAX_RECENTS` recently-activated palette items, most recent first. */
export function getRecents(): RecentEntry[] {
    if (typeof localStorage === 'undefined') return [];
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isRecentEntry);
    } catch {
        return [];
    }
}

/**
 * Record an activation. Dedupes by `href` (re-activating an existing recent
 * bumps it to the front instead of duplicating), caps at `MAX_RECENTS`.
 * Never throws — recording a recent must never block navigation.
 */
export function recordRecent(entry: Omit<RecentEntry, 'timestamp'>): void {
    if (typeof localStorage === 'undefined') return;
    try {
        const existing = getRecents().filter((r) => r.href !== entry.href);
        const next: RecentEntry[] = [{ ...entry, timestamp: Date.now() }, ...existing].slice(
            0,
            MAX_RECENTS,
        );
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
        /* localStorage unavailable/full/private-browsing — never block navigation */
    }
}
