// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Seam test: the real root layout `load()` must resolve `navIcons` to ONLY
 * the icon names this viewer's navigation actually references — not the
 * full ~212-icon admin nav picker catalog (heroicon-catalog.ts /
 * navigationIconMap). See resolve-nav-icons.ts for the full rationale: this
 * is what lets Sidebar.svelte, UserMenuPopover.svelte and the homepage hero
 * buttons stop importing the eager catalog client-side.
 *
 * Follows the mocking pattern already established in
 * layout.server.payload-shape.test.ts (same file, same seam).
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/config', () => ({
    config: new Proxy({} as Record<string, unknown>, {
        // localsIsAdminOrArrManager reads the ARR manager groups.
        get: (_t, key) => (key === 'ARR_MANAGER_GROUPS' ? [] : undefined),
    }),
    features: {},
    BACKEND_ONLY_FEATURES: new Set<string>(),
}));
vi.mock('$lib/server/config/domains/ai.js', () => ({
    getAiConfig: () => ({
        assistantName: 'A',
        assistantAvatar: '',
        assistantPersona: '',
        assistantDailyLimitUser: 1,
        assistantDailyLimitAdmin: 1,
    }),
}));

// Config values driving the icon-bearing lists. Only SIDEBAR_LINKS and
// HERO_BUTTONS carry a configured icon name here — everything else stays
// empty, so the test can assert the resolved set is exactly what those two
// (plus the fixed library-type-template fallback set `resolveNavIcons`
// always includes) require, nothing more.
const CONFIG_VALUES: Record<string, unknown> = {
    SIDEBAR_LINKS: [{ label: 'Requests', url: '/requests', icon: 'clapperboard' }],
    HERO_BUTTONS: [
        { id: 'b1', action: 'link', label: 'Docs', icon: 'book-open', enabled: true, url: '/docs' },
    ],
};
vi.mock('$lib/server/config/config.service.js', () => ({
    get: (key: string) => CONFIG_VALUES[key],
}));
vi.mock('$lib/server/operation-mode.js', () => ({
    operationMode: { getClientState: () => ({}), getState: () => ({}) },
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => null }));
vi.mock('$lib/server/database/queries/library-types.queries.js', () => ({
    getActiveNonEntertainmentLibraries: vi.fn(async () => []),
    getActiveLibraryTypes: vi.fn(async () => []),
}));
vi.mock('$lib/server/database/queries/builders/media-access-boundary.js', () => ({
    boundaryCacheKey: () => 'k',
    denyAllAccess: () => ({}),
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn(async () => ({})),
    searchAccessBoundary: () => ({}),
}));
vi.mock('$lib/server/auth.js', () => ({ isAdminOrArrManager: () => false }));
vi.mock('$lib/server/database/queries/user-preferences.queries.js', () => ({
    loadFeedPrefsForUser: vi.fn(async () => ({})),
}));
vi.mock('$lib/server/services/music/radio-configured.service.js', () => ({
    isRadioConfigured: vi.fn(async () => false),
}));
vi.mock('$lib/server/licensing/feature-gate.js', () => ({
    isModuleLicensed: vi.fn(async () => false),
}));
vi.mock('$lib/server/theme/enabled-themes.js', () => ({
    getEnabledThemes: vi.fn(() => []),
    resolveActiveThemeId: () => 'default',
}));
vi.mock('$lib/server/plugins/runtime/widget-metadata.js', () => ({
    listPluginWidgets: vi.fn(async () => []),
    listPluginNavEntries: vi.fn(() => []),
}));

const { load } = await import('./+layout.server.js');

async function runLoad(): Promise<{ navIcons: Record<string, unknown> }> {
    return (await load({
        locals: { user: { userId: 'u1', username: 'alice', userGroups: [] } },
        cookies: { get: () => undefined },
    } as never)) as { navIcons: Record<string, unknown> };
}

describe('root layout load: navIcons', () => {
    it('resolves the configured SIDEBAR_LINKS icon name to a real IconSource', async () => {
        const { navIcons } = await runLoad();
        expect(navIcons.clapperboard).toBeDefined();
        expect(navIcons.clapperboard).toHaveProperty('default');
    });

    it('resolves the configured HERO_BUTTONS icon name to a real IconSource', async () => {
        const { navIcons } = await runLoad();
        expect(navIcons['book-open']).toBeDefined();
        expect(navIcons['book-open']).toHaveProperty('default');
    });

    it(
        'does NOT ship the full ~212-icon admin nav catalog — only configured names ' +
            '(+ the fixed library-type-template fallback set)',
        async () => {
            const { navIcons } = await runLoad();
            // The full catalog has 212 heroicon entries alone; a real install's
            // nav config resolves to a small handful. This is the acceptance bar
            // Task 9's fix round 1 exists for.
            expect(Object.keys(navIcons).length).toBeLessThan(20);
        },
    );

    it('does not include an icon name nothing in this payload configured', async () => {
        const { navIcons } = await runLoad();
        // 'trash' is a real heroicon-catalog key, but nothing above configured it.
        expect(navIcons).not.toHaveProperty('trash');
    });
});
