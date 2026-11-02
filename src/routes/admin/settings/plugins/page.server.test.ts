// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getDbMock = vi.fn();
const listStateMock = vi.fn();
const isEnabledMock = vi.fn(() => true);
const getAllFeaturesMock = vi.fn((): { id: string }[] => []);

vi.mock('$lib/server/auth', () => ({ isUserAdmin: () => true }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => getDbMock() }));
vi.mock('$lib/server/services/external-plugin-manager.service.js', () => ({
    listExternalPluginsWithState: () => listStateMock(),
}));
vi.mock('$lib/server/plugins', () => ({ isExternalPluginsEnabled: () => isEnabledMock() }));
vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { getAllFeatures: () => getAllFeaturesMock(), getAllWatchSyncs: () => [] },
}));
vi.mock('$lib/server/plugins/runtime/admin-providers-listing', () => ({
    listAdminProviders: async () => [],
}));
vi.mock('$lib/server/config', () => ({
    devFeaturesEnabled: false,
    features: { holidays: false },
    config: {
        PLUGINS_EXTERNAL_INSTALL_ENABLED: true,
        PLUGINS_REQUIRE_REGISTRY: false,
    },
}));
vi.mock('$lib/server/plugins/demo-plugin-ids.js', () => ({
    DEMO_FEATURE_IDS: new Set<string>(),
    DEMO_INTEGRATION_IDS: new Set<string>(),
}));

import { load } from './+page.server.js';

// The framework-generated PageData type does not carry the new external-plugin
// fields, so cast the load result to the subset this posture test asserts.
interface LoadShape {
    externalPlugins: unknown[];
    trustedKeysConfigured: boolean;
    externalPluginsError: boolean;
    installEnabled: boolean;
    requireRegistry: boolean;
}
const runLoad = async (): Promise<LoadShape> => (await load(event)) as unknown as LoadShape;

// `isAdmin` is the gate the load reads — the authoritative verdict the admin
// layout resolves, not a group name (a pinned admin has no ADMIN_GROUPS entry).
const event = {
    locals: { user: { ownerIsAdmin: true, userGroups: ['admin'] }, principal: { isAdmin: true } },
} as never;

beforeEach(() => {
    vi.clearAllMocks();
    isEnabledMock.mockReturnValue(true);
});

describe('external plugins load posture', () => {
    it('null DB handle → empty list + error flag, no throw', async () => {
        getDbMock.mockReturnValue(null);
        const data = await runLoad();
        expect(data.externalPlugins).toEqual([]);
        expect(data.trustedKeysConfigured).toBe(false);
        expect(data.externalPluginsError).toBe(true);
    });
    it('live pool whose query REJECTS → caught, empty list + error flag, no throw', async () => {
        getDbMock.mockReturnValue({} as never);
        listStateMock.mockRejectedValue(new Error('ECONNREFUSED'));
        const data = await runLoad();
        expect(data.externalPlugins).toEqual([]);
        expect(data.trustedKeysConfigured).toBe(false);
        expect(data.externalPluginsError).toBe(true);
    });
    it('healthy DB → items + trustedKeysConfigured passthrough, no error flag', async () => {
        getDbMock.mockReturnValue({} as never);
        listStateMock.mockResolvedValue({
            items: [
                {
                    id: 'a',
                    name: 'a',
                    version: '1',
                    enabled: true,
                    status: 'installed',
                    loaded: true,
                    restartRequired: false,
                    isBundle: false,
                    bundleInvalid: false,
                    installedAt: 'x',
                    updatedAt: 'x',
                },
            ],
            trustedKeysConfigured: true,
        });
        const data = await runLoad();
        expect(data.externalPlugins).toHaveLength(1);
        expect(data.trustedKeysConfigured).toBe(true);
        expect(data.externalPluginsError).toBe(false);
        expect(data.installEnabled).toBe(true);
        expect(data.requireRegistry).toBe(false);
    });
    it('feature disabled → no query issued, no error flag', async () => {
        isEnabledMock.mockReturnValue(false);
        getDbMock.mockReturnValue({} as never);
        const data = await runLoad();
        expect(listStateMock).not.toHaveBeenCalled();
        expect(data.externalPluginsError).toBe(false);
        expect(data.externalPlugins).toEqual([]);
    });
});

describe('built-in feature cards', () => {
    it('holiday recommendations (off by default) is marked off with a link to its setting', async () => {
        getDbMock.mockReturnValue(null);
        getAllFeaturesMock.mockReturnValue([{ id: 'holiday-recommendations' }, { id: 'other' }]);
        const data = (await load(event)) as unknown as {
            featurePlugins: { id: string; setup?: { status: string; href: string } }[];
        };
        const holiday = data.featurePlugins.find((p) => p.id === 'holiday-recommendations');
        expect(holiday?.setup).toEqual({
            status: 'off',
            href: '/admin/settings/tasks?section=advanced-tasks&highlight=DISABLE_HOLIDAY_RECOMMENDATIONS',
        });
        expect(data.featurePlugins.find((p) => p.id === 'other')?.setup).toBeUndefined();
    });
});
