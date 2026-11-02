// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    shouldAutoCollapse,
    shouldAutoCollapseByEntryCount,
    loadSidebarCollapsed,
    saveSidebarCollapsed,
    SIDEBAR_COLLAPSE_STORAGE_KEY,
} from './sidebar-collapse.js';

function memoryStorage(seed: Record<string, string> = {}): Storage {
    const map = new Map(Object.entries(seed));
    return {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, v),
        removeItem: (k: string) => void map.delete(k),
        clear: () => map.clear(),
        key: (i: number) => [...map.keys()][i] ?? null,
        get length() {
            return map.size;
        },
    } as Storage;
}

describe('shouldAutoCollapse', () => {
    it('collapses when the sidebar has almost nothing to show', () => {
        // An artist page with one album: 288px to render a single row.
        expect(shouldAutoCollapse(1, 1920)).toBe(true);
        expect(shouldAutoCollapse(2, 1920)).toBe(true);
    });

    it('stays open for a hierarchy worth navigating on a wide viewport', () => {
        expect(shouldAutoCollapse(5, 1920)).toBe(false);
    });

    it('collapses on a narrow viewport even with a full hierarchy', () => {
        // Below 1280 the tab strip is already hiding tabs; 288px of sidebar is
        // the more expendable of the two.
        expect(shouldAutoCollapse(5, 1279)).toBe(true);
        expect(shouldAutoCollapse(12, 1024)).toBe(true);
    });

    it('treats exactly 1280 as wide enough', () => {
        expect(shouldAutoCollapse(5, 1280)).toBe(false);
    });

    it('collapses an empty sidebar', () => {
        expect(shouldAutoCollapse(0, 1920)).toBe(true);
    });

    it('does not collapse an unknown entry count on a wide viewport', () => {
        // An unknown count (server could not compute one, e.g. the music
        // sidebar before this fix) must never be treated as "empty" -- that
        // silently hid hierarchies that had plenty to show. If the null
        // branch were removed, `null <= 2` coerces to `0 <= 2` and this
        // would wrongly come back `true`.
        expect(shouldAutoCollapse(null, 1920)).toBe(false);
    });

    it('still collapses an unknown entry count on a narrow viewport', () => {
        // The viewport half of the rule is independent of the count and must
        // still fire even when the count is unknown.
        expect(shouldAutoCollapse(null, 1024)).toBe(true);
    });
});

describe('shouldAutoCollapseByEntryCount', () => {
    it('treats an unknown count as "do not collapse"', () => {
        expect(shouldAutoCollapseByEntryCount(null)).toBe(false);
    });

    it('collapses at or below the trivial threshold', () => {
        expect(shouldAutoCollapseByEntryCount(0)).toBe(true);
        expect(shouldAutoCollapseByEntryCount(2)).toBe(true);
    });

    it('stays open above the trivial threshold', () => {
        expect(shouldAutoCollapseByEntryCount(3)).toBe(false);
    });
});

describe('loadSidebarCollapsed', () => {
    it('returns null when there is no stored preference, so the auto rule applies', () => {
        expect(loadSidebarCollapsed(memoryStorage())).toBeNull();
        expect(loadSidebarCollapsed(null)).toBeNull();
    });

    it('round-trips an explicit preference in both directions', () => {
        const s = memoryStorage();
        saveSidebarCollapsed(s, true);
        expect(loadSidebarCollapsed(s)).toBe(true);
        saveSidebarCollapsed(s, false);
        expect(loadSidebarCollapsed(s)).toBe(false);
    });

    it('returns null rather than throwing on a corrupt value', () => {
        expect(
            loadSidebarCollapsed(memoryStorage({ [SIDEBAR_COLLAPSE_STORAGE_KEY]: 'nonsense' })),
        ).toBeNull();
    });

    it('does not throw when storage itself throws', () => {
        const hostile = {
            getItem: () => {
                throw new DOMException('denied');
            },
            setItem: () => {
                throw new DOMException('denied');
            },
        } as unknown as Storage;
        expect(() => loadSidebarCollapsed(hostile)).not.toThrow();
        expect(loadSidebarCollapsed(hostile)).toBeNull();
        expect(() => saveSidebarCollapsed(hostile, true)).not.toThrow();
    });
});
