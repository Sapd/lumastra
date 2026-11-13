// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isGateOpen, visibleNav, type NavGateContext } from '$lib/config/admin-nav';
import { tabItemsOf, type AdminSearchMeta } from '$lib/config/admin-search-meta';
import { configSections } from '$lib/config/schema';
import {
    boundedEditDistance,
    assertNoProtectedTierMetas,
    buildAdminPageIndex,
    getAdminPageIndex,
    makeIndexEntry,
    normalizeSearchText,
    routeOfMetaFile,
    searchAdminPages,
} from './admin-page-index';
import { buildCommandPaletteResults } from './command-palette';

const ALL: NavGateContext = {
    devToolsEnabled: true,
    features: { libraryUpload: true } as NavGateContext['features'],
    trainingAssignments: true,
    assessment: true,
    showcase: true,
};
const NONE: NavGateContext = {
    devToolsEnabled: false,
    features: {},
    trainingAssignments: false,
    assessment: false,
    showcase: false,
};

const index = buildAdminPageIndex({ navSections: visibleNav(ALL), gate: ALL });
const CLUSTER = '/admin/system/health?tab=cluster';

function hrefs(query: string): string[] {
    return searchAdminPages(index, query).map((m) => m.entry.href);
}

describe('routeOfMetaFile', () => {
    it('derives the URL from the file path and drops route groups', () => {
        expect(routeOfMetaFile('/src/routes/admin/search-meta.ts')).toBe('/admin');
        expect(routeOfMetaFile('/src/routes/admin/system/health/search-meta.ts')).toBe(
            '/admin/system/health',
        );
        expect(routeOfMetaFile('/src/routes/admin/(private)/reporting/search-meta.ts')).toBe(
            '/admin/reporting',
        );
    });
});

describe('isGateOpen', () => {
    it('applies the nav gating vocabulary', () => {
        expect(isGateOpen(undefined, NONE)).toBe(true);
        expect(isGateOpen({ devOnly: true }, NONE)).toBe(false);
        expect(isGateOpen({ devOnly: true }, ALL)).toBe(true);
        expect(isGateOpen({ privateModule: 'assessment' }, NONE)).toBe(false);
        expect(isGateOpen({ privateModule: 'assessment' }, ALL)).toBe(true);
        expect(isGateOpen({ featureFlag: 'libraryUpload' }, NONE)).toBe(false);
        expect(isGateOpen({ featureFlag: 'libraryUpload' }, ALL)).toBe(true);
    });
});

describe('tabItemsOf', () => {
    const meta: AdminSearchMeta = {
        title: () => 'Page',
        tabs: [
            { id: 'a', title: () => 'A' },
            { id: 'b', title: () => 'B', permission: { devOnly: true } },
        ],
    };
    it('lists every tab without a gate, and only the open ones with one', () => {
        expect(tabItemsOf(meta).map((t) => t.id)).toEqual(['a', 'b']);
        expect(tabItemsOf(meta, NONE).map((t) => t.id)).toEqual(['a']);
        expect(tabItemsOf(meta, ALL).map((t) => t.id)).toEqual(['a', 'b']);
    });
});

describe('protected-tier exclusion', () => {
    const source = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), 'admin-page-index.ts'),
        'utf8',
    );

    it('the glob excludes the literal "(private)" directory', () => {
        // Read the pattern out of the real import.meta.glob call, so this cannot drift.
        const literal = /'(!\/src\/routes\/admin\/[^']*private[^']*)'/.exec(source)?.[1];
        expect(literal).toBeTruthy();
        const pattern = (literal as string).slice(1).replace(/\\\\/g, '\\');
        const picomatch = createRequire(import.meta.url)('picomatch') as (
            glob: string,
        ) => (path: string) => boolean;
        const isExcluded = picomatch(pattern);
        expect(isExcluded('/src/routes/admin/(private)/trainings/search-meta.ts')).toBe(true);
        expect(isExcluded('/src/routes/admin/system/health/search-meta.ts')).toBe(false);
    });

    it('fails loudly if a protected-tier file is ever collected', () => {
        expect(() =>
            assertNoProtectedTierMetas(['/src/routes/admin/(private)/x/search-meta.ts']),
        ).toThrow(/License boundary/);
        expect(() =>
            assertNoProtectedTierMetas(['/src/routes/admin/system/health/search-meta.ts']),
        ).not.toThrow();
    });
});

describe('index memoisation', () => {
    it('reuses the index for the same inputs and rebuilds for new ones', () => {
        const nav = visibleNav(ALL);
        const first = getAdminPageIndex(nav, ALL);
        expect(getAdminPageIndex(nav, ALL)).toBe(first);
        expect(getAdminPageIndex(nav, { ...ALL })).not.toBe(first);
    });
});

describe('buildAdminPageIndex visibility', () => {
    const hidden = buildAdminPageIndex({ navSections: visibleNav(NONE), gate: NONE });

    it('hides what the nav hides, pages and (core indexes protected-tier pages from the nav)', () => {
        const all = hidden.map((e) => e.href);
        expect(all.some((h) => h.startsWith('/admin/developer'))).toBe(false);
        expect(all).not.toContain('/admin/trainings');
        expect(all).not.toContain('/admin/library/upload');
        expect(all).toContain('/admin/system/health');
    });

    it('shows them when the admin may open them', () => {
        const all = index.map((e) => e.href);
        expect(all).toContain('/admin/developer/cache');
        expect(all).toContain('/admin/trainings');
        expect(all).toContain('/admin/library/upload');
    });

    it('never renders an empty section label', () => {
        expect(index.every((e) => e.sectionTitle.length > 0)).toBe(true);
        const help = index.find((e) => e.href === '/admin/help/tasks');
        expect(help?.sectionTitle).toBe('More');
        expect(index.find((e) => e.href === '/admin/library/quarantine')?.sectionId).toBe(
            'library',
        );
    });

    it('lists non-nav routes under their nearest nav page', () => {
        const stuck = index.find((e) => e.href === '/admin/fix/stuck');
        expect(stuck?.sectionId).toBe('system');
    });
});

describe('normalizeSearchText', () => {
    it('lowercases and strips diacritics', () => {
        expect(normalizeSearchText('Übersicht')).toBe('ubersicht');
        expect(normalizeSearchText('Prüfungen')).toBe('prufungen');
        expect(normalizeSearchText('Straße')).toBe('strasse');
    });
});

describe('boundedEditDistance', () => {
    it('counts insertions, substitutions and transpositions as one edit', () => {
        expect(boundedEditDistance('cluster', 'clustr', 1)).toBe(1);
        expect(boundedEditDistance('health', 'heatlh', 1)).toBe(1);
        expect(boundedEditDistance('cluster', 'clusxer', 1)).toBe(1);
    });
    it('gives up beyond the bound', () => {
        expect(boundedEditDistance('cluster', 'proxy', 1)).toBe(2);
        expect(boundedEditDistance('a', 'abcd', 1)).toBe(2);
    });
});

describe('searchAdminPages', () => {
    it('puts the cluster tab first for "cluster"', () => {
        expect(hrefs('cluster')[0]).toBe(CLUSTER);
        expect(hrefs('Cluster')[0]).toBe(CLUSTER);
    });

    it.each([
        'clus',
        'clustr',
        'Knoten',
        'knoten',
        'nodes',
        'replicas',
        'Arbeitsspeicher',
        'memory',
        'RAM',
        'CPU',
        'host',
        'server',
        'worker',
        'proxy',
    ])('finds the cluster tab for "%s"', (query) => {
        expect(hrefs(query)).toContain(CLUSTER);
    });

    it('requires every token of a multi-word query to match', () => {
        expect(hrefs('health cluster')[0]).toBe(CLUSTER);
        expect(hrefs('cluster banana')).toEqual([]);
    });

    it('finds a page by a German synonym', () => {
        expect(hrefs('Benutzer')[0]).toBe('/admin/users');
        expect(hrefs('Kosten')[0]).toBe('/admin/system/cost');
    });

    it('finds the tabs of other pages', () => {
        expect(hrefs('quick picks')[0]).toBe('/admin/settings/music?tab=quick-picks');
        expect(hrefs('broken match')[0]).toBe('/admin/library/fix-matches?view=broken');
    });

    it('ranks exact title above prefix above substring above description', () => {
        const entry = (path: string, title: string, extra: { d?: string; k?: string[] } = {}) =>
            makeIndexEntry({
                kind: 'page',
                path,
                href: path,
                title,
                description: extra.d,
                sectionId: 's',
                sectionTitle: 'Sys',
                keywords: extra.k ?? [],
            });
        const entries = [
            entry('/a', 'Zeta cost', { d: 'nothing' }),
            entry('/b', 'Other', { d: 'about cost here' }),
            entry('/c', 'Costly thing'),
            entry('/d', 'Cost'),
            entry('/e', 'Other two', { k: ['cost'] }),
        ];
        expect(searchAdminPages(entries, 'cost').map((m) => m.entry.path)).toEqual([
            '/d',
            '/c',
            '/a',
            '/e',
            '/b',
        ]);
    });

    it('ranks a tab by its own title, not through its parent page', () => {
        const entries = [
            makeIndexEntry({
                kind: 'page',
                path: '/p',
                href: '/p',
                title: 'Parent',
                sectionId: 's',
                sectionTitle: 'Sys',
                keywords: [],
            }),
            makeIndexEntry({
                kind: 'tab',
                path: '/p',
                href: '/p?tab=t',
                title: 'Gadgets',
                parentTitle: 'Parent',
                sectionId: 's',
                sectionTitle: 'Sys',
                keywords: [],
            }),
        ];
        expect(searchAdminPages(entries, 'gadgets').map((m) => m.entry.href)).toEqual(['/p?tab=t']);
    });

    it('does not match every page on the route prefix', () => {
        expect(hrefs('admin')).not.toContain('/admin/system/cost');
        expect(hrefs('ad')).not.toContain('/admin/system/cost');
    });

    it('still matches a pasted route', () => {
        expect(hrefs('system/cost')).toContain('/admin/system/cost');
        expect(hrefs('/admin/system/cost')).toContain('/admin/system/cost');
    });

    it('caps the query length and token count', () => {
        expect(hrefs('cluster' + ' '.repeat(100) + 'banana')).toContain(CLUSTER);
        const many = Array(20).fill('cluster').join(' ');
        expect(hrefs(many)).toContain(CLUSTER);
        expect(searchAdminPages(index, 'a'.repeat(5000))).toEqual([]);
    });

    it('returns nothing for a blank query', () => {
        expect(searchAdminPages(index, '   ')).toEqual([]);
    });
});

describe('buildCommandPaletteResults with the real routes', () => {
    const base = {
        navSections: visibleNav(ALL),
        navGate: ALL,
        configSections,
        providerIndex: [],
        flags: { devFeaturesEnabled: true, showAdvanced: true },
    };

    it('lists the cluster tab first, as "Parent > Tab" data', () => {
        const r = buildCommandPaletteResults({ ...base, query: 'cluster' });
        expect(r.pages[0]).toMatchObject({
            kind: 'tab',
            href: CLUSTER,
            parentTitle: expect.any(String),
        });
    });

    it('shows pages only (no tabs) when the query is empty', () => {
        const r = buildCommandPaletteResults({ ...base, query: '' });
        expect(r.pages.every((p) => p.kind === 'page')).toBe(true);
    });
});

describe('hardware discovery destinations', () => {
    it.each([
        'hardware',
        'hardware transcode',
        'GPU',
        'NVENC',
        'QSV',
        'VAAPI',
        'AMF',
        'VideoToolbox',
        'encoder',
        'hardware encoding',
        'hardware decoding',
        'transcoding',
        'NVIDIA',
        'Intel',
        'Quick Sync',
        'AMD',
        'Hardwarebeschleunigung',
    ])('finds hardware settings and distinct anchored diagnostics for %s', (query) => {
        expect(hrefs(query)).toContain('/admin/settings/playback?category=ffmpeg-hardware');
        expect(hrefs(query)).toContain('/admin/system/health?tab=cluster#hardware-encoder-check');
    });
    it('does not turn a diagnostic search destination into a duplicate UI tab', async () => {
        const { searchMeta } = await import('../../../routes/admin/system/health/search-meta');
        expect(tabItemsOf(searchMeta).filter((tab) => tab.id === 'cluster')).toHaveLength(1);
    });
    it('keeps hardware settings as a category destination without adding a UI tab', async () => {
        const { searchMeta } = await import('../../../routes/admin/settings/playback/search-meta');
        expect(tabItemsOf(searchMeta)).toEqual([]);
        expect(searchMeta.destinations).toEqual([
            expect.objectContaining({ id: 'ffmpeg-hardware', param: 'category' }),
        ]);
    });
    it('keeps diagnostic destinations under their page admin gate', () => {
        const hidden = buildAdminPageIndex({ navSections: [], gate: NONE });
        expect(hidden.some((entry) => entry.href.endsWith('#hardware-encoder-check'))).toBe(false);
    });
});
