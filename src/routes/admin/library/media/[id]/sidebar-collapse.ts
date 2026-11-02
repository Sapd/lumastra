// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Whether the media detail's hierarchy sidebar starts collapsed.
 *
 * The sidebar is a fixed 288px whether it lists five seasons or one album. On a
 * 1280px viewport that 288px is a fifth of the window, and the tab strip beside
 * it is already hiding three of eight tabs — so reserving it unconditionally
 * costs more than it returns.
 *
 * `Storage` is a parameter rather than a global so this is testable without a
 * DOM, matching `media-browser-storage.ts` on the browser route.
 */

export const SIDEBAR_COLLAPSE_STORAGE_KEY = 'admin-media-detail-sidebar-collapsed';

/** Below this the sidebar costs more than it returns regardless of content. */
const NARROW_VIEWPORT_PX = 1280;

/** At or below this many entries there is not enough hierarchy to navigate. */
const TRIVIAL_ENTRY_COUNT = 2;

/**
 * The entry-count half of the auto-collapse rule, usable on its own before a
 * viewport width is known (e.g. during SSR, where there is no `window`).
 *
 * `entryCount === null` means "the caller could not determine a count" —
 * NOT "there are zero entries". The two must not be conflated: a real zero is
 * a genuinely empty hierarchy and collapsing over it is correct, but an
 * unknown count must fail toward showing the operator their hierarchy, never
 * toward hiding it. Returning `false` here (rather than treating `null` like
 * `0`) is what prevents an unrelated data gap from silently collapsing a
 * sidebar that might have plenty to show — see `shouldAutoCollapse`'s tests
 * for the concrete case (an artist page with no server-computed album count).
 */
export function shouldAutoCollapseByEntryCount(entryCount: number | null): boolean {
    if (entryCount === null) return false;
    return entryCount <= TRIVIAL_ENTRY_COUNT;
}

/**
 * The default state when the operator has expressed no preference.
 *
 * An explicit preference always wins — see `loadSidebarCollapsed`, which returns
 * `null` precisely so the caller can tell "no preference" from "prefers open".
 */
export function shouldAutoCollapse(entryCount: number | null, viewportWidth: number): boolean {
    if (viewportWidth < NARROW_VIEWPORT_PX) return true;
    return shouldAutoCollapseByEntryCount(entryCount);
}

export function loadSidebarCollapsed(storage: Storage | null): boolean | null {
    if (!storage) return null;
    try {
        const raw = storage.getItem(SIDEBAR_COLLAPSE_STORAGE_KEY);
        if (raw === 'true') return true;
        if (raw === 'false') return false;
        return null;
    } catch {
        return null;
    }
}

export function saveSidebarCollapsed(storage: Storage | null, collapsed: boolean): void {
    if (!storage) return;
    try {
        storage.setItem(SIDEBAR_COLLAPSE_STORAGE_KEY, String(collapsed));
    } catch {
        /* preference just will not persist */
    }
}
