// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Search metadata for admin routes.
 *
 * Every admin route directory with a `+page.svelte` has a sibling
 * `search-meta.ts` exporting `searchMeta: AdminSearchMeta`. The admin command
 * palette index (`$lib/utils/admin/admin-page-index`) collects them with
 * `import.meta.glob`, so adding a page or a tab to the search needs no list
 * edit anywhere. The URL comes from the file path, not from the meta.
 *
 * A page that renders tabs builds its tab bar from `tabs` here, so the ids the
 * page reads from the URL and the ids the search links to are one definition.
 */

import { isGateOpen, type NavGateContext, type NavGatePermission } from '$lib/config/admin-nav';

/** Same gating vocabulary (and predicate) as `AdminNavPage`. */
export type AdminSearchPermission = NavGatePermission;

export interface AdminSearchTabMeta {
    /** The exact value the page reads from `?<param>=`. */
    id: string;
    /** Query parameter the page reads the tab from. Defaults to `tab`. */
    param?: string;
    /** Optional destination anchor; does not alter the tab identity. */
    hash?: string;
    title: () => string;
    description?: () => string;
    /** Search synonyms (any language). */
    keywords?: () => string[];
    permission?: AdminSearchPermission;
}

export interface AdminSearchMeta {
    title: () => string;
    description?: () => string;
    /** Search synonyms (EN + DE) matched besides title and description. */
    keywords?: () => string[];
    /**
     * Gating. A page that is not under a nav page MUST declare it (`{}` = open
     * to every admin): without a nav ancestor nothing else gates it, so the
     * index leaves it out until it says so.
     */
    permission?: AdminSearchPermission;
    tabs?: AdminSearchTabMeta[];
    /** Search-only deep links; excluded from the page's tab bar. */
    destinations?: AdminSearchTabMeta[];
}

/**
 * Wraps a message holding a comma-separated synonym list. Keyword messages
 * hold English and German terms in every locale, so a search matches either.
 */
export function kw(message: () => string): () => string[] {
    return () =>
        message()
            .split(',')
            .map((word) => word.trim())
            .filter(Boolean);
}

/**
 * The `{ id, label }` items a tab bar renders for a page's meta tabs. Pass the
 * admin's gate context to drop tabs they may not open, as the search index does.
 */
export function tabItemsOf(
    meta: AdminSearchMeta,
    gate?: NavGateContext,
): Array<{ id: string; label: string }> {
    return (meta.tabs ?? [])
        .filter((tab) => !gate || isGateOpen(tab.permission, gate))
        .map((tab) => ({ id: tab.id, label: tab.title() }));
}
