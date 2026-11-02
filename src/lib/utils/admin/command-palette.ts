// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { IconSource } from 'svelte-hero-icons';
import type { AdminNavSection, NavGateContext } from '$lib/config/admin-nav';
import type { SectionDefinition, SettingVisibilityFlags } from '$lib/config/schema';
import {
    searchAllSettings,
    matchProviders,
    type SettingSearchMatch,
    type ProviderSearchEntry,
} from '$lib/utils/admin/settings-search';
import {
    getAdminPageIndex,
    searchAdminPages,
    type AdminPageIndexEntry,
} from '$lib/utils/admin/admin-page-index';

export interface PaletteDestination {
    /** 'tab' results land on a tab inside `path` (see `href`). */
    kind: 'page' | 'tab';
    path: string;
    /** `path`, or `path?<param>=<tab id>` for a tab. */
    href: string;
    title: string;
    /** Title of the page a tab lives on; shown as "Parent › Tab". */
    parentTitle?: string;
    description?: string;
    sectionId: string;
    sectionTitle: string;
    icon?: IconSource;
}

export interface PaletteResults {
    pages: PaletteDestination[];
    settings: SettingSearchMatch[];
    providers: ProviderSearchEntry[];
}

const DEFAULT_MAX_PER_GROUP = 8;

function toDestination(entry: AdminPageIndexEntry): PaletteDestination {
    return {
        kind: entry.kind,
        path: entry.path,
        href: entry.href,
        title: entry.title,
        parentTitle: entry.parentTitle,
        description: entry.description,
        sectionId: entry.sectionId,
        sectionTitle: entry.sectionTitle,
        icon: entry.icon,
    };
}

export function buildCommandPaletteResults(input: {
    navSections: AdminNavSection[];
    navGate: NavGateContext;
    configSections: SectionDefinition[];
    providerIndex: ProviderSearchEntry[];
    query: string;
    flags: SettingVisibilityFlags;
    maxPerGroup?: number;
}): PaletteResults {
    const cap = input.maxPerGroup ?? DEFAULT_MAX_PER_GROUP;
    const q = input.query.trim();

    if (!q) {
        // Browse mode: the nav manifest's pages in nav order (tabs only surface
        // through search), no settings/providers.
        const pages: PaletteDestination[] = input.navSections.flatMap((section) =>
            section.pages.map((page) => ({
                kind: 'page' as const,
                path: page.path,
                href: page.path,
                title: page.title(),
                description: page.description?.(),
                sectionId: section.id,
                sectionTitle: section.title(),
                icon: page.icon,
            })),
        );
        return { pages: pages.slice(0, cap * 8), settings: [], providers: [] };
    }

    const index = getAdminPageIndex(input.navSections, input.navGate);
    const rankedPages = searchAdminPages(index, q)
        .map((match) => toDestination(match.entry))
        .slice(0, cap);

    const settings = searchAllSettings(input.configSections, input.query, input.flags).slice(
        0,
        cap,
    );
    const providers = matchProviders(input.providerIndex, input.query).slice(0, cap);

    return { pages: rankedPages, settings, providers };
}
