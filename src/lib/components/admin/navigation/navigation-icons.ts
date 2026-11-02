// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { type IconSource } from 'svelte-hero-icons';
import { heroiconCatalog } from './heroicon-catalog';
import { lumastraCustomIconMap } from './lumastra-custom-icons';

// NOTE: this module (via heroicon-catalog.ts) imports ALL 212 heroicons the
// admin nav icon picker offers, at module scope. It is meant for the admin
// editor (full catalog, admin-only) and the SERVER (to resolve only the
// handful of names actually configured — see
// src/lib/server/resolve-nav-icons.ts and src/routes/+layout.server.ts's
// `navIcons`). Client code that runs on every route (Sidebar.svelte,
// UserMenuPopover.svelte, +page.svelte) must NOT import `navigationIconMap`
// from here — read the server-resolved `page.data.navIcons` instead, falling
// back to `lumastra-custom-icons.ts` only for the couple of hard-coded,
// non-configurable direct icon values those files also use.

// Heroicons come from the generated catalog (every icon the admin nav icon
// picker offers — see scripts/gen-navigation-icon-catalog.mjs), the custom
// Lumastra line icons are spread on top. Keys are Heroicons' own kebab names,
// so stored navigation configs keep resolving across regenerations.
export const navigationIconMap: Record<string, IconSource> = {
    ...heroiconCatalog,
    ...lumastraCustomIconMap,
};

export type NavigationIconKey = keyof typeof navigationIconMap;

export const defaultNavigationIcons: NavigationIconKey[] = Object.keys(
    navigationIconMap,
) as NavigationIconKey[];

/**
 * The full picker list for one surface: its suggested icons first (in the order
 * given), then everything else alphabetically. The picker groups on the same
 * split, so a surface keeps its short opinionated list at the top without
 * hiding the rest of the catalog behind it.
 */
export function iconsWithSuggestedFirst(suggested: readonly string[]): string[] {
    const known = suggested.filter((key) => key in navigationIconMap);
    const rest = Object.keys(navigationIconMap)
        .filter((key) => !known.includes(key))
        .sort();
    return [...known, ...rest];
}
