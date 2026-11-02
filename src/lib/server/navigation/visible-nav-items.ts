// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** The viewer fields the visibility rule reads. */
export interface NavViewer {
    isAdmin?: boolean;
    userGroups?: string[];
}

/**
 * The admin-configured navigation items (sidebar links and sections, user-menu
 * links, footer links, hero buttons) this viewer may see.
 *
 * Same rule the Sidebar applies when it renders (`hasPermission`): no `groups`
 * means everyone; `__ADMIN__` means admins only; otherwise admins, or a member
 * of any listed group (case-insensitive). Applied on the SERVER because the
 * root layout used to ship every item, with its URL and its IdP group names, to
 * every viewer and leave the filtering to the browser. An anonymous visitor
 * (/login, /setup, a 404) gets nothing: those pages render no app chrome.
 * Found in the 2026-10-07 entry-point review.
 */
export function visibleNavItems<T extends object>(
    items: readonly T[],
    viewer: NavViewer | undefined | null,
): T[] {
    if (!viewer) return [];
    const isAdmin = viewer.isAdmin === true;
    const mine = new Set((viewer.userGroups ?? []).map((g) => g.toLowerCase()));
    return items.filter((item) => {
        // Not every item type declares `groups` (hero buttons, user-menu links),
        // but the admin config can carry it on any of them.
        const raw = (item as { groups?: unknown }).groups;
        const groups = Array.isArray(raw)
            ? raw.filter((g): g is string => typeof g === 'string')
            : [];
        if (groups.length === 0) return true;
        if (groups.includes('__ADMIN__')) return isAdmin;
        if (isAdmin) return true;
        return groups.some((g) => mine.has(g.toLowerCase()));
    });
}
