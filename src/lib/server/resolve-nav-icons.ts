// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Resolves admin-configured navigation icon NAMES (strings stored in
 * SIDEBAR_LINKS/SIDEBAR_SECTIONS/USER_MENU_LINKS/HERO_BUTTONS config, plugin
 * nav entries, and per-library icon overrides) to their `IconSource` objects
 * on the SERVER, so the client only ever receives the handful of icons a
 * given install's navigation actually uses — not the full 212-icon admin nav
 * picker catalog (`heroicon-catalog.ts`, `navigationIconMap`).
 *
 * Why this exists: `navigationIconMap` (navigation-icons.ts) eagerly spreads
 * `heroiconCatalog`'s 212 icons at module scope. Sidebar.svelte (root
 * layout, every route), UserMenuPopover.svelte and the homepage hero buttons
 * used to import `navigationIconMap` directly so they could resolve an
 * admin-configured icon *name* (a string) to an `IconSource` at render time.
 * That forced all 212 icons onto every route's critical-path bundle
 * regardless of the hero-icon-split Vite plugin (see
 * hero-icon-vite-plugin.ts) — splitting heroicons into per-icon modules only
 * helps if the app's own import graph doesn't independently force the whole
 * set onto every page. This module is the fix: resolve on the server (where
 * importing the full catalog costs nothing — it never ships to the client),
 * and hand the client only the resolved subset via page data
 * (`+layout.server.ts`'s `navIcons`).
 *
 * `navigationIconMap` covers BOTH heroicons and Lumastra's own hand-rolled
 * icons (see lumastra-custom-icons.ts) under one kebab-case key space, so
 * this resolves either kind uniformly — the caller doesn't need to know
 * which an icon name refers to.
 */

import { navigationIconMap } from '$lib/components/admin/navigation/navigation-icons';
import type { IconSource } from 'svelte-hero-icons';

/** A legacy stored icon name Sidebar.svelte used to alias in the client
 * `iconMap` it built from `navigationIconMap`. `navigationIconMap` itself
 * has no 'chart-bar-square' key (only 'chart-bar') — resolve it here so the
 * alias lives in exactly one place and the client can stay a dumb lookup. */
const LEGACY_ICON_ALIASES: Record<string, string> = {
    'chart-bar-square': 'chart-bar',
};

/** An icon "name" that is actually a path (local `/icons/...svg` or an
 * absolute URL) rather than a `navigationIconMap` key — nothing to resolve,
 * the client renders it as an `<img>`/URL directly. */
function isCustomIconPath(icon: string): boolean {
    return icon.startsWith('/') || icon.startsWith('http://') || icon.startsWith('https://');
}

/**
 * Resolves every name in `names` against `navigationIconMap`, skipping
 * blanks, custom icon paths, duplicates, and any name with no match (the
 * client already treats a missing map entry as "render nothing / a neutral
 * fallback" — this preserves that behaviour exactly, just server-side).
 *
 * Returns a plain object (not a Map) since this is serialized straight into
 * SvelteKit page data.
 */
export function resolveNavIcons(
    names: Iterable<string | null | undefined>,
): Record<string, IconSource> {
    const resolved: Record<string, IconSource> = {};

    for (const raw of names) {
        if (!raw || raw in resolved || isCustomIconPath(raw)) {
            continue;
        }

        const lookupKey = LEGACY_ICON_ALIASES[raw] ?? raw;
        const icon = navigationIconMap[lookupKey];
        if (icon) {
            resolved[raw] = icon;
        }
    }

    return resolved;
}
