// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { configSchema, configSections } from '$lib/config/schema';
import {
    filterSettings,
    normalizeSettingsSearch,
    SETTING_SEARCH_ALIASES,
    searchAllSettings,
    searchSectionSettings,
    settingMatchesSearch,
    sectionMatchesSearch,
    matchProviders,
    type ProviderSearchEntry,
} from './settings-search';
import { buildSettingDeepLink, buildProviderDeepLink } from './settings-search';
import type { SettingSearchMatch } from './settings-search';

describe('searchAllSettings', () => {
    const flags = { devFeaturesEnabled: true, showAdvanced: true };

    it('returns empty for a blank query', () => {
        expect(searchAllSettings(configSections, '   ', flags)).toEqual([]);
    });

    it('attributes a service connection to Connections and a metadata key to the Metadata page', () => {
        const sonarr = searchAllSettings(configSections, 'sonarr api key', flags);
        expect(sonarr.some((m) => m.pageHref === '/admin/settings/connections')).toBe(true);
        expect(sonarr.find((m) => m.pageHref === '/admin/settings/connections')?.section.id).toBe(
            'conn-sonarr',
        );
        const tmdb = searchAllSettings(configSections, 'tmdb api key', flags);
        expect(tmdb.find((m) => m.setting.key === 'TMDB_API_KEY')?.pageHref).toBe(
            '/admin/settings/providers',
        );
    });

    it('reaches every section, including the two that used to be orphans', () => {
        const matches = searchAllSettings(configSections, 'e', flags); // broad query
        expect(matches.some((m) => m.section.id === 'requests')).toBe(true);
        expect(matches.some((m) => m.section.id === 'licensing')).toBe(true);
    });

    it('respects visibility flags (advanced hidden when showAdvanced is false)', () => {
        const shown = searchAllSettings(configSections, 'e', {
            devFeaturesEnabled: true,
            showAdvanced: true,
        }).length;
        const hidden = searchAllSettings(configSections, 'e', {
            devFeaturesEnabled: false,
            showAdvanced: false,
        }).length;
        expect(hidden).toBeLessThanOrEqual(shown);
    });
});

describe('filterSettings — navigation section', () => {
    const flags = { devFeaturesEnabled: true, showAdvanced: true };
    const nav = configSections.filter((s) => s.id === 'navigation');

    it('still matches the custom-editor keyword aliases', () => {
        expect(filterSettings(nav, 'sidebar', flags).filteredSections).toHaveLength(1);
        expect(filterSettings(nav, 'footer', flags).filteredSections).toHaveLength(1);
    });

    it('matches its own real settings by label (keywords used to shadow them)', () => {
        // "Show Footer" and "Available Groups" are real, visible navigation
        // settings. The old keyword-only branch returned false for both, hiding the
        // section card while the jump list still offered a dead link into it.
        expect(filterSettings(nav, 'show footer', flags).filteredSections).toHaveLength(1);
        expect(filterSettings(nav, 'available groups', flags).filteredSections).toHaveLength(1);
    });

    it('still excludes the section for an unrelated query', () => {
        expect(filterSettings(nav, 'zzzznotathing', flags).filteredSections).toHaveLength(0);
    });

    it('every jump-list match is inside a section the page will render', () => {
        // The jump list and the section filter must agree, or clicking a result
        // scrolls to an element that was filtered out of the DOM.
        for (const query of ['show footer', 'available groups', 'sidebar navigation']) {
            const jumpable = searchSectionSettings(configSections, query, flags);
            const rendered = new Set(
                filterSettings(configSections, query, flags).filteredSections.map((s) => s.id),
            );
            for (const match of jumpable) {
                expect(rendered.has(match.section.id), `${query} -> ${match.setting.key}`).toBe(
                    true,
                );
            }
        }
    });
});

describe('settingMatchesSearch — fields covered', () => {
    const base = { key: 'FOO', label: 'Foo', description: 'Bar' };

    it('matches key, label and description', () => {
        expect(settingMatchesSearch(base, 'foo')).toBe(true);
        expect(settingMatchesSearch(base, 'bar')).toBe(true);
        expect(settingMatchesSearch(base, 'nope')).toBe(false);
    });

    it('matches a select OPTION label (top-level options)', () => {
        const setting = { ...base, options: [{ label: 'Tonemap to SDR' }] };
        expect(settingMatchesSearch(setting, 'tonemap')).toBe(true);
    });

    it('matches a select OPTION label nested under validation', () => {
        const setting = { ...base, validation: { options: [{ label: 'Software (keep HDR)' }] } };
        expect(settingMatchesSearch(setting, 'keep hdr')).toBe(true);
    });

    it('matches placeholder and suffix hints', () => {
        expect(
            settingMatchesSearch({ ...base, uiHints: { placeholder: 'rtmp://…' } }, 'rtmp'),
        ).toBe(true);
        expect(settingMatchesSearch({ ...base, uiHints: { suffix: 'megabits' } }, 'megabit')).toBe(
            true,
        );
    });

    it('finds a real schema setting by its dropdown option label', () => {
        // "Tonemap to SDR" is an option label of the HDR burn-in strategy setting;
        // the phrase appears in no label or key, so option matching is the only route.
        const matches = searchSectionSettings(configSections, 'tonemap to sdr', {
            devFeaturesEnabled: true,
            showAdvanced: true,
        });
        expect(matches.length).toBeGreaterThan(0);
    });
});

describe('sectionMatchesSearch', () => {
    it('matches label and description', () => {
        const section = { label: 'Music', description: 'Playback and lyrics' };
        expect(sectionMatchesSearch(section, 'lyrics')).toBe(true);
        expect(sectionMatchesSearch(section, 'music')).toBe(true);
    });

    it('matches helpText — some concepts are named only there', () => {
        const section = {
            label: 'Music',
            description: 'Playback and lyrics',
            helpText: 'Music Alchemy is the mixing desk for acoustic data.',
        };
        expect(sectionMatchesSearch(section, 'alchemy')).toBe(true);
        expect(sectionMatchesSearch(section, 'nothing here')).toBe(false);
    });
});

describe('searchSectionSettings (same-page jump list)', () => {
    const flags = { devFeaturesEnabled: true, showAdvanced: true };

    it('returns empty for a blank query', () => {
        expect(searchSectionSettings(configSections, '  ', flags)).toEqual([]);
    });

    it('is never narrowed by the deep-link page registry', () => {
        // A page renders whatever its loader asked for, whether or not the registry
        // knows about that section. The jump list must therefore NOT go through
        // getPageForSection() — otherwise a page's own matches would silently vanish
        // from its own jump list. searchAllSettings DOES gate on the registry (it has
        // to: it builds a cross-page link), so it can only ever return fewer.
        for (const section of configSections) {
            const local = searchSectionSettings([section], 'e', flags).length;
            const linkable = searchAllSettings([section], 'e', flags).length;
            expect(linkable, section.id).toBeLessThanOrEqual(local);
        }
    });

    it('never returns hidden settings (nothing to scroll to)', () => {
        const matches = searchSectionSettings(configSections, 'e', flags);
        expect(matches.some((m) => m.setting.uiHints?.hidden)).toBe(false);
    });

    it('respects visibility flags', () => {
        const shown = searchSectionSettings(configSections, 'e', flags).length;
        const hidden = searchSectionSettings(configSections, 'e', {
            devFeaturesEnabled: false,
            showAdvanced: false,
        }).length;
        expect(hidden).toBeLessThanOrEqual(shown);
    });
});

describe('matchProviders', () => {
    const index: ProviderSearchEntry[] = [
        {
            id: 'musicbrainz-metadata-provider',
            label: 'MusicBrainz',
            category: 'metadata',
            keywords: ['acoustid', 'fingerprint'],
            href: '/admin/settings/providers',
            settingsParam: 'musicbrainz-metadata-provider',
        },
        {
            id: 'tmdb-metadata-provider',
            label: 'TMDB',
            category: 'metadata',
            keywords: ['themoviedb'],
            href: '/admin/settings/providers',
            settingsParam: 'tmdb-metadata-provider',
        },
    ];

    it('matches by label case-insensitively', () => {
        expect(matchProviders(index, 'tmdb').map((e) => e.id)).toEqual(['tmdb-metadata-provider']);
    });

    it('matches by keyword alias (acoustid -> musicbrainz)', () => {
        expect(matchProviders(index, 'acoustid').map((e) => e.id)).toEqual([
            'musicbrainz-metadata-provider',
        ]);
    });

    it('returns nothing for a blank query', () => {
        expect(matchProviders(index, '  ')).toEqual([]);
    });
});

describe('deep-link builders', () => {
    const match = (over: Partial<SettingSearchMatch> = {}): SettingSearchMatch => ({
        setting: { key: 'FOO_KEY' } as SettingSearchMatch['setting'],
        section: { id: 'services' } as SettingSearchMatch['section'],
        pageHref: '/admin/settings/providers',
        pageLabel: 'Providers',
        ...over,
    });

    it('builds a setting deep-link without a tab', () => {
        expect(buildSettingDeepLink(match())).toBe(
            '/admin/settings/providers?section=services&highlight=FOO_KEY',
        );
    });

    it('builds a setting deep-link with a tab', () => {
        expect(buildSettingDeepLink(match({ tab: 'navigation' }))).toBe(
            '/admin/settings/providers?tab=navigation&section=services&highlight=FOO_KEY',
        );
    });

    it('builds a provider deep-link with settingsParam', () => {
        const entry: ProviderSearchEntry = {
            id: 'x',
            label: 'X',
            category: 'metadata',
            keywords: [],
            href: '/admin/settings/providers',
            settingsParam: 'musicbrainz-metadata-provider',
        };
        expect(buildProviderDeepLink(entry)).toBe(
            '/admin/settings/providers?settings=musicbrainz-metadata-provider',
        );
    });

    it('builds a provider deep-link without settingsParam', () => {
        const entry: ProviderSearchEntry = {
            id: 'x',
            label: 'X',
            category: 'library',
            keywords: [],
            href: '/admin/settings/plugins',
        };
        expect(buildProviderDeepLink(entry)).toBe('/admin/settings/plugins');
    });
});

describe('normalized token search and ranking', () => {
    const flags = { devFeaturesEnabled: true, showAdvanced: true };

    it('ignores case, accents and key separators', () => {
        expect(normalizeSettingsSearch('  GRÖẞE_API-Key  ')).toBe('grosse api key');
        expect(
            settingMatchesSearch(
                { key: 'FOO_BAR', label: 'Café Größe', description: 'Playback' },
                'bar cafe grosse',
            ),
        ).toBe(true);
    });

    it('matches all tokens across different fields regardless of order', () => {
        expect(
            settingMatchesSearch(
                { key: 'FOO_API', label: 'Connection', description: 'Secret' },
                'secret connection api',
            ),
        ).toBe(true);
        expect(
            settingMatchesSearch(
                { key: 'FOO_API', label: 'Connection', description: 'Secret' },
                'secret missing',
            ),
        ).toBe(false);
    });

    it('combines setting text with section context without losing the section card', () => {
        const setting = configSchema.find((s) => s.key === 'GPU_ACCELERATION')!;
        const section = configSections.find((s) => s.id === setting.section)!;
        const query = `${section.label} gpu`;
        expect(
            searchSectionSettings([section], query, flags).some(
                (m) => m.setting.key === setting.key,
            ),
        ).toBe(true);
        expect(filterSettings([section], query, flags).filteredSections).toContain(section);
    });

    it('validates every curated alias against the real schema', () => {
        for (const [key, aliases] of Object.entries(SETTING_SEARCH_ALIASES)) {
            expect(
                configSchema.some((s) => s.key === key),
                key,
            ).toBe(true);
            for (const alias of aliases) {
                expect(
                    searchSectionSettings(configSections, alias, flags).some(
                        (m) => m.setting.key === key,
                    ),
                    `${key}: ${alias}`,
                ).toBe(true);
            }
        }
    });

    it('ranks an exact setting key ahead of broad descriptions', () => {
        expect(
            searchSectionSettings(configSections, 'GPU_ACCELERATION', flags)[0]?.setting.key,
        ).toBe('GPU_ACCELERATION');
    });

    it('does not bypass hidden or dev-only policy through aliases', () => {
        const matches = searchSectionSettings(configSections, 'hardware acceleration', {
            devFeaturesEnabled: false,
            showAdvanced: false,
        });
        expect(matches.every((m) => !m.setting.uiHints?.hidden)).toBe(true);
    });
});
