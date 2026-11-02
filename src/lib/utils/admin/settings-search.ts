// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Settings Search Utility
 * Pure functions for filtering and searching settings/sections
 */

import { configSchema, configSections, getVisibleSettingsBySection } from '$lib/config/schema';
import type {
    ConfigSection,
    SectionDefinition,
    SettingDefinition,
    SettingVisibilityFlags,
} from '$lib/config/schema';
import { getPageForSection, ORPHAN_SECTION_IDS } from '$lib/config/admin-settings-pages';

// Navigation section keywords - show if query matches any of these
const NAVIGATION_KEYWORDS = ['navigation', 'sidebar', 'footer', 'menu', 'link', 'nav'];

/** Normalize accents, key separators and punctuation without evaluating localized labels early. */
export function normalizeSettingsSearch(value: string): string {
    return value
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .toLowerCase()
        .replace(/ß/g, 'ss')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

/** Curated synonyms point only to real schema keys; they never change visibility. */
export const SETTING_SEARCH_ALIASES: Readonly<Record<string, readonly string[]>> = {
    GPU_ACCELERATION: [
        'hardware acceleration',
        'hardware transcode',
        'hardware transcoding',
        'graphics card',
        'gpu',
        'grafikkarte',
        'hardwarebeschleunigung',
    ],
    HLS_BURN_IN_HDR_STRATEGY: ['tone mapping', 'tonemapping', 'hdr subtitles'],
    AUTH_OIDC_ENABLED: ['single sign on', 'sso', 'openid connect'],
    TRANSCODING_MODE: ['transcoding', 'video conversion', 'transkodierung'],
};

interface SearchableSetting {
    section?: string;
    key: string;
    label: string;
    description: string;
    options?: Array<{ label: string }>;
    validation?: { options?: Array<{ label: string }> };
    uiHints?: { placeholder?: string; suffix?: string };
}

function settingSearchFields(setting: SearchableSetting): string[] {
    return [
        setting.key,
        setting.label,
        setting.description,
        ...(setting.options ?? []).map((o) => o.label),
        ...(setting.validation?.options ?? []).map((o) => o.label),
        setting.uiHints?.placeholder ?? '',
        setting.uiHints?.suffix ?? '',
        ...(SETTING_SEARCH_ALIASES[setting.key] ?? []),
    ];
}

/** All tokens can match across fields and section context, in any order. */
export function settingMatchesSearch(
    setting: SearchableSetting,
    query: string,
    section?: { label: string; description: string; helpText?: string },
): boolean {
    section ??= configSections.find((candidate) => candidate.id === setting.section);
    const tokens = normalizeSettingsSearch(query).split(' ').filter(Boolean);
    const text = normalizeSettingsSearch(
        [
            ...settingSearchFields(setting),
            section?.label ?? '',
            section?.description ?? '',
            section?.helpText ?? '',
        ].join(' '),
    );
    return tokens.every((token) => text.includes(token));
}

export function sectionMatchesSearch(
    section: { label: string; description: string; helpText?: string },
    query: string,
): boolean {
    const text = normalizeSettingsSearch(
        [section.label, section.description, section.helpText ?? ''].join(' '),
    );
    return normalizeSettingsSearch(query)
        .split(' ')
        .filter(Boolean)
        .every((token) => text.includes(token));
}

function searchRank(match: SectionSettingMatch, query: string): number {
    const normalized = normalizeSettingsSearch(query);
    const key = normalizeSettingsSearch(match.setting.key);
    const label = normalizeSettingsSearch(match.setting.label);
    if (key === normalized || label === normalized) return 0;
    if (key.includes(normalized) || label.includes(normalized)) return 1;
    const tokens = normalized.split(' ');
    if (tokens.every((token) => `${key} ${label}`.includes(token))) return 2;
    return 3;
}

/**
 * Get count of settings matching the search query in a section.
 * When `flags` is provided, only currently-visible settings are counted, so search
 * does not surface advanced/dev-only settings that are hidden from the UI.
 */
export function getMatchingSettingsCount(
    sectionId: string,
    query: string,
    flags?: SettingVisibilityFlags,
    section?: SectionDefinition,
): number {
    if (!query) return 0;
    const settings = flags
        ? getVisibleSettingsBySection(sectionId, flags)
        : configSchema.filter((s) => s.section === sectionId);
    return settings.filter((s) => settingMatchesSearch(s, query, section)).length;
}

/**
 * Filter settings sections based on search query
 * Returns filtered sections and a set of section IDs that matched by name.
 * When `flags` is provided, sections are kept only if they have a visible matching
 * setting (or their name matches), respecting the advanced/dev-only visibility flags.
 */
export function filterSettings(
    sections: ConfigSection[],
    searchQuery: string,
    flags?: SettingVisibilityFlags,
): {
    filteredSections: ConfigSection[];
    sectionMatchedByName: Set<string>;
} {
    const normalizedQuery = searchQuery.toLowerCase().trim();

    if (!normalizedQuery) {
        return {
            filteredSections: sections,
            sectionMatchedByName: new Set(),
        };
    }

    // Track which sections matched by name (show all settings) vs by settings (filter)
    const sectionMatchedByName = new Set<string>(
        sections.filter((s) => sectionMatchesSearch(s, normalizedQuery)).map((s) => s.id),
    );

    // Filter sections that have at least one matching setting OR section name matches
    const filteredSections = sections.filter((section) => {
        // Check if section label/description matches
        if (sectionMatchedByName.has(section.id)) {
            return true;
        }

        // The navigation section ALSO answers to keyword aliases, because most of
        // its substance lives in a custom editor (sidebar/footer link lists) whose
        // labels aren't in the schema. This is an extra way in, not a replacement:
        // it used to `return` here, which meant a query naming a real navigation
        // setting ("Show Footer", "Available Groups") hid the whole section card —
        // while the jump list happily offered a link that then scrolled to nothing.
        if (
            section.id === 'navigation' &&
            NAVIGATION_KEYWORDS.some((keyword) => keyword.includes(normalizedQuery))
        ) {
            return true;
        }

        return getMatchingSettingsCount(section.id, normalizedQuery, flags, section) > 0;
    });

    return { filteredSections, sectionMatchedByName };
}

/**
 * Check if any input element is currently focused
 */
export function isInputFocused(): boolean {
    const active = document.activeElement;
    return (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement
    );
}

export interface SectionSettingMatch {
    setting: SettingDefinition;
    section: SectionDefinition;
}

export interface SettingSearchMatch extends SectionSettingMatch {
    pageHref: string;
    pageLabel: string;
    tab?: string;
}

/**
 * Flat search over the given sections, WITHOUT resolving which page owns them.
 *
 * Used for the "on this page" jump list: the page already knows its own sections,
 * and several settings pages (access, appearance, secrets, …) are deliberately not
 * in ADMIN_SETTINGS_PAGES — routing their own matches through `getPageForSection`
 * would silently drop them. Skips hidden settings (no rendered row to scroll to).
 */
export function searchSectionSettings(
    sections: SectionDefinition[],
    query: string,
    flags?: SettingVisibilityFlags,
): SectionSettingMatch[] {
    const normalized = query.toLowerCase().trim();
    if (!normalized) return [];

    const matches: SectionSettingMatch[] = [];
    for (const section of sections) {
        const settings = flags
            ? getVisibleSettingsBySection(section.id, flags)
            : configSchema.filter((s) => s.section === section.id);

        for (const setting of settings) {
            if (setting.uiHints?.hidden) continue;
            if (!settingMatchesSearch(setting, normalized, section)) continue;
            matches.push({ setting, section });
        }
    }
    return matches.sort((a, b) => searchRank(a, query) - searchRank(b, query));
}

/**
 * Flat search across ALL sections. Returns each VISIBLE matched setting with the
 * page it canonically lives on. Excludes hidden settings (no rendered row to scroll
 * to) and orphan sections (no page). Empty query returns nothing.
 */
export function searchAllSettings(
    sections: SectionDefinition[],
    query: string,
    flags?: SettingVisibilityFlags,
): SettingSearchMatch[] {
    const linkable = sections.filter(
        (section) => !ORPHAN_SECTION_IDS.has(section.id) && getPageForSection(section.id),
    );

    return searchSectionSettings(linkable, query, flags).map((match) => {
        // Non-null: `linkable` only kept sections that resolve to a page.
        const page = getPageForSection(match.section.id)!;
        return { ...match, pageHref: page.href, pageLabel: page.label, tab: page.tab };
    });
}

export interface ProviderSearchEntry {
    id: string;
    label: string;
    category: string;
    keywords: string[];
    href: string;
    /** When set, deep-link opens the provider's settings modal via ?settings=<value>. */
    settingsParam?: string;
}

/**
 * Substring match over provider label + keyword aliases. Empty query -> [].
 */
export function matchProviders(index: ProviderSearchEntry[], query: string): ProviderSearchEntry[] {
    const normalized = normalizeSettingsSearch(query);
    if (!normalized) return [];
    const tokens = normalized.split(' ');
    return index.filter((entry) => {
        const text = normalizeSettingsSearch([entry.label, ...entry.keywords].join(' '));
        return tokens.every((token) => text.includes(token));
    });
}

/** Deep-link to a specific setting: expands its section + scrolls + highlights on arrival. */
export function buildSettingDeepLink(match: SettingSearchMatch): string {
    const tab = match.tab ? `tab=${encodeURIComponent(match.tab)}&` : '';
    return `${match.pageHref}?${tab}section=${encodeURIComponent(match.section.id)}&highlight=${encodeURIComponent(match.setting.key)}`;
}

/** Deep-link to a provider: opens its settings modal via ?settings= when available. */
export function buildProviderDeepLink(entry: ProviderSearchEntry): string {
    return entry.settingsParam
        ? `${entry.href}?settings=${encodeURIComponent(entry.settingsParam)}`
        : entry.href;
}
