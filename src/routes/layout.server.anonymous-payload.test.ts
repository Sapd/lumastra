// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the ROOT layout hands a viewer who is not signed in, and which
 * admin-configured navigation it hands a signed-in one.
 *
 * The layout runs for anonymous visitors on /login, /setup and every 404, and
 * it shipped them the admin-configured sidebar, user-menu, footer and hero
 * links (URLs plus IdP group names), installed-plugin widget metadata and the
 * library kinds that exist. Signed-in users got every group-restricted link and
 * the browser hid the ones not meant for them. Found in the 2026-10-07
 * entry-point review.
 */

import { describe, expect, it, vi } from 'vitest';

const NAV_CONFIG = vi.hoisted((): Record<string, unknown> => {
    const items = [
        { id: 'open', label: 'Open', url: '/browse' },
        { id: 'staff', label: 'Grafana', url: 'https://grafana.internal', groups: ['Staff'] },
    ];
    return {
        SIDEBAR_LINKS: items,
        SIDEBAR_SECTIONS: [{ id: 'ops', label: 'Ops', groups: ['Staff'] }],
        USER_MENU_LINKS: items,
        FOOTER_LINKS: items,
        HERO_BUTTONS: items,
    };
});

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
vi.mock('$lib/server/config/config.service.js', () => ({
    get: (key: string) => NAV_CONFIG[key],
}));
vi.mock('$lib/server/operation-mode.js', () => ({
    operationMode: { getClientState: () => ({}), getState: () => ({}) },
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/library-types.queries.js', () => ({
    getActiveNonEntertainmentLibraries: vi.fn(async () => []),
    getActiveLibraryTypes: vi.fn(async () => ['music', 'movie']),
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
    listPluginWidgets: vi.fn(() => [{ id: 'plugin:shoutbox:main', title: 'Shoutbox' }]),
    // Real listPluginNavEntries is SYNCHRONOUS (returns PluginNavEntry[]
    // directly, not a Promise) — an `async` mock here used to be harmless
    // because the load never awaited or iterated it, but +layout.server.ts
    // now `.map()`s over `pluginNavEntries` to collect icon names for
    // `navIcons` (see resolve-nav-icons.ts), which throws on a Promise.
    listPluginNavEntries: vi.fn(() => []),
}));

vi.mock('$lib/server/services/metadata-attributions.service.js', () => ({
    getConfiguredMetadataAttributions: vi.fn(async () => ['tmdb', 'discogs']),
}));

const { load } = await import('./+layout.server.js');
const { getConfiguredMetadataAttributions } =
    await import('$lib/server/services/metadata-attributions.service.js');

async function runLoad(
    user: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
    return (await load({
        locals: { user },
        cookies: { get: () => undefined },
    } as never)) as Record<string, unknown>;
}

const NAV_KEYS = ['sidebarLinks', 'sidebarSections', 'userMenuLinks', 'footerLinks', 'heroButtons'];
const ids = (v: unknown): string[] => (v as Array<{ id: string }>).map((i) => i.id);

describe('root layout — anonymous visitor', () => {
    it('keeps branding available and the feature matrix private after helper extraction', async () => {
        const data = await runLoad(undefined);
        expect(data.branding).toMatchObject({
            appName: 'Lumastra',
            appDescription: 'Media Dashboard',
        });
        expect(data.features).toEqual({});
    });

    it.each(NAV_KEYS)('ships no %s', async (key) => {
        const data = await runLoad(undefined);
        expect(data[key]).toEqual([]);
    });

    it('ships no plugin widget metadata and no library inventory', async () => {
        vi.mocked(getConfiguredMetadataAttributions).mockClear();
        const data = await runLoad(undefined);
        expect(data.pluginWidgets).toEqual([]);
        expect(data.activeLibraryTypes).toEqual([]);
        expect(data.metadataAttributionProviders).toEqual([]);
        expect(getConfiguredMetadataAttributions).not.toHaveBeenCalled();
    });
});

describe('root layout — signed-in viewer', () => {
    const user = { userId: 'u1', username: 'alice', userGroups: ['users'], isAdmin: false };

    it('gets the unrestricted links but not the ones for a group they are not in', async () => {
        const data = await runLoad(user);
        for (const key of ['sidebarLinks', 'userMenuLinks', 'footerLinks', 'heroButtons']) {
            expect(ids(data[key]), key).toEqual(['open']);
        }
        expect(data.sidebarSections).toEqual([]);
    });

    it('a member of the group gets the restricted link too', async () => {
        const data = await runLoad({ ...user, userGroups: ['staff'] });
        expect(ids(data.sidebarLinks)).toEqual(['open', 'staff']);
    });

    it('returns the shared feature helper output', async () => {
        const { getServerFeatures } = await import('$lib/server/server-branding.js');
        expect((await runLoad(user)).features).toEqual(await getServerFeatures());
    });

    it.each([false, true])(
        'only advertises configured Live TV when this user is allowed (%s)',
        async (allowed) => {
            const branding = await import('$lib/server/server-branding.js');
            const features = await branding.getServerFeatures();
            vi.spyOn(branding, 'getServerFeatures').mockResolvedValueOnce({
                ...features,
                liveTV: true,
            });
            const data = await runLoad({ ...user, hasLiveTvPermission: allowed });
            expect(data.features).toMatchObject({ liveTV: allowed });
        },
    );

    it('keeps plugin widgets and library kinds (positive control)', async () => {
        const data = await runLoad(user);
        expect(data.pluginWidgets).toHaveLength(1);
        expect(data.activeLibraryTypes).toEqual(['music', 'movie']);
        expect(data.metadataAttributionProviders).toEqual(['tmdb', 'discogs']);
    });
});
