// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { AdminNavPage, AdminNavSection } from '$lib/config/admin-nav.js';
import * as m from '$lib/paraglide/messages.js';

/** A per-user "quick menu" pin (`admin_nav_pins` row, `+layout.server.ts` → `data.navPins`). */
export interface AdminNavPin {
    href: string;
    label: string;
    sortOrder: number;
}

/**
 * Returns true when `currentPath` matches the given route.
 * If a sibling route is a sub-path of this route, this route matches exactly
 * to avoid false highlights (e.g. /admin/livetv won't match /admin/livetv/channels).
 */
export function isRouteActive(
    route: string,
    currentPath: string,
    siblingRoutes: string[] = [],
): boolean {
    if (route === '/admin') return currentPath === '/admin';
    const hasSiblingChild = siblingRoutes.some((s) => s !== route && s.startsWith(route + '/'));
    if (hasSiblingChild) return currentPath === route;
    return currentPath === route || currentPath.startsWith(route + '/');
}

/**
 * Returns true when any route in the group matches currentPath.
 */
export function isGroupActive(routes: string[], currentPath: string): boolean {
    return routes.some((r) => isRouteActive(r, currentPath, routes));
}

/**
 * Resolve which ONE page path in a flat list of nav paths should render as
 * "active" for a given pathname (fixes the double-highlight bug where every
 * nav renderer used independent prefix matching per page — e.g. on
 * `/admin/users/sessions`, both `/admin/users` (prefix match) and
 * `/admin/users/sessions` (exact match) lit up simultaneously).
 *
 * Returns the LONGEST `path` such that `pathname === path` or
 * `pathname.startsWith(path + '/')`, so a nested sibling always wins over its
 * parent. `/admin` is special-cased to match only exactly (it is a prefix of
 * every admin route). Returns `null` when nothing matches.
 *
 * Callers should compute this ONCE per render over every visible page path
 * (across all sections, from the already gate-filtered manifest) and mark a
 * page active iff `page.path === winner` — never re-run the prefix check
 * per-page.
 */
export function resolveActiveNavPath(pathname: string, paths: readonly string[]): string | null {
    let best: string | null = null;
    let bestLen = -1;
    for (const path of paths) {
        const isMatch =
            path === '/admin'
                ? pathname === '/admin'
                : pathname === path || pathname.startsWith(path + '/');
        if (isMatch && path.length > bestLen) {
            best = path;
            bestLen = path.length;
        }
    }
    return best;
}

/**
 * Whether a pinned "quick menu" link (`AdminNavPin`) should render active.
 * Uses the same longest-match rule as {@link resolveActiveNavPath}, evaluated
 * independently per pin — a pin and the "real" nav entry for the same path
 * may legitimately both highlight at once (a pin is a standalone shortcut,
 * not part of the one-winner-per-section computation).
 */
export function isPinActive(pathname: string, pin: { href: string }): boolean {
    // A pin href may carry `?query`/`#anchor` (legacy self-heal targets such as
    // `/admin/library/fix-matches?view=broken`); the pathname is what matches.
    const pinPath = pin.href.split(/[?#]/)[0];
    return resolveActiveNavPath(pathname, [pinPath]) !== null;
}

/**
 * The href a section's header/landing link should use: the remembered
 * last-visited page for this section (feature: "remember last sub-page") if
 * it is still one of the section's CURRENTLY VISIBLE pages — a stale
 * remembered path (page removed, or hidden by a gate that changed since it
 * was stored) falls back to the section's default landing page (`pages[0]`).
 */
export function resolveSectionLandingPath(
    section: AdminNavSection,
    lastVisitedPath: string | null,
): string {
    if (lastVisitedPath && section.pages.some((p) => p.path === lastVisitedPath)) {
        return lastVisitedPath;
    }
    return section.pages[0].path;
}

/** localStorage key under which a section's last-visited page is remembered. */
export function lastSectionPageStorageKey(sectionId: string): string {
    return `admin:last-page:${sectionId}`;
}

const SETTINGS_GENERAL = [
    '/admin/settings',
    '/admin/settings/access',
    '/admin/settings/secrets',
    '/admin/settings/connections',
    '/admin/settings/providers',
];
const SETTINGS_MEDIA = [
    '/admin/settings/media',
    '/admin/settings/playback',
    '/admin/settings/music',
    '/admin/settings/livetv',
    '/admin/settings/audiobookshelf',
];

/** A labelled run of pages inside one section (Settings' General / Media / Experience). */
export interface AdminNavPageGroup {
    id: string;
    /** Null for a section that is not grouped. */
    label: string | null;
    pages: AdminNavPage[];
}

/**
 * The page groups a section renders in. Settings splits into General / Media /
 * Experience (the same grouping its in-page directory and the sidebar flyout
 * use, so the views agree); every other section is one unlabelled group.
 * Empty groups (everything gated away) are dropped.
 */
export function sectionPageGroups(section: AdminNavSection): AdminNavPageGroup[] {
    if (section.id !== 'settings') return [{ id: section.id, label: null, pages: section.pages }];
    return settingsPageGroups(section.pages).filter((group) => group.pages.length > 0);
}

/** Settings' three page groups, in display order (groups may be empty). */
export function settingsPageGroups(pages: AdminNavPage[]): AdminNavPageGroup[] {
    return [
        {
            id: 'general',
            label: m.admin_redesign_settings_general(),
            pages: pages.filter((p) => SETTINGS_GENERAL.includes(p.path)),
        },
        {
            id: 'media',
            label: m.admin_redesign_settings_media(),
            pages: pages.filter((p) => SETTINGS_MEDIA.includes(p.path)),
        },
        {
            id: 'experience',
            label: m.admin_redesign_settings_experience(),
            pages: pages.filter(
                (p) => !SETTINGS_GENERAL.includes(p.path) && !SETTINGS_MEDIA.includes(p.path),
            ),
        },
    ];
}
