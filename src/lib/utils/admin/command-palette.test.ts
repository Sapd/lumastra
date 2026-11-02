// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { configSections } from '$lib/config/schema';
import { visibleNav, type NavGateContext } from '$lib/config/admin-nav';
import { buildCommandPaletteResults } from './command-palette';

const navGate: NavGateContext = {
    devToolsEnabled: true,
    features: {},
    trainingAssignments: false,
    assessment: false,
    showcase: false,
};
const navSections = visibleNav(navGate);
const flags = { devFeaturesEnabled: true, showAdvanced: true };
const base = { navSections, navGate, configSections, providerIndex: [], flags };

describe('buildCommandPaletteResults', () => {
    it('empty query returns every nav page in order, no settings/providers', () => {
        const r = buildCommandPaletteResults({ ...base, query: '  ' });
        expect(r.pages.map((p) => p.path)).toEqual(
            navSections.flatMap((s) => s.pages.map((p) => p.path)).slice(0, r.pages.length),
        );
        expect(r.pages[0].path).toBe('/admin');
        expect(r.settings).toEqual([]);
        expect(r.providers).toEqual([]);
    });

    it('matches a page by title', () => {
        const r = buildCommandPaletteResults({ ...base, query: 'audit log' });
        expect(r.pages[0].path).toBe('/admin/system/audit-log');
    });

    it('matches a page by description', () => {
        const r = buildCommandPaletteResults({ ...base, query: 'checks about itself' });
        expect(r.pages.some((p) => p.path === '/admin/system/health')).toBe(true);
    });

    it('routes settings matches through searchAllSettings', () => {
        const r = buildCommandPaletteResults({ ...base, query: 'api key' });
        expect(r.settings.length).toBeGreaterThan(0);
    });

    it('matches providers via keyword', () => {
        const idx = [
            {
                id: 'mb',
                label: 'MusicBrainz',
                category: 'metadata',
                keywords: ['acoustid'],
                href: '/admin/settings/providers',
                settingsParam: 'mb',
            },
        ];
        const r = buildCommandPaletteResults({ ...base, providerIndex: idx, query: 'acoustid' });
        expect(r.providers.map((p) => p.id)).toEqual(['mb']);
    });

    it('caps each group', () => {
        const r = buildCommandPaletteResults({ ...base, query: 'settings', maxPerGroup: 3 });
        expect(r.pages.length).toBe(3);
    });

    it('finds a tab and keeps it in the pages group, ahead of settings', () => {
        const r = buildCommandPaletteResults({ ...base, query: 'cluster' });
        expect(r.pages[0]).toMatchObject({ kind: 'tab', href: '/admin/system/health?tab=cluster' });
    });

    it('does not offer pages the nav hides', () => {
        const r = buildCommandPaletteResults({
            ...base,
            navGate: { ...navGate, devToolsEnabled: false },
            navSections: visibleNav({ ...navGate, devToolsEnabled: false }),
            query: 'crossfade',
        });
        expect(r.pages.some((p) => p.path.startsWith('/admin/developer'))).toBe(false);
    });
});
