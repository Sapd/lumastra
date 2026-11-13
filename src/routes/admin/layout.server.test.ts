// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The /admin layout load runs on every admin page, so anything it lets through
 * breaks the whole admin shell, not one page.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isRedirect } from '@sveltejs/kit';

vi.mock('$app/environment', () => ({ dev: false, browser: false, building: false }));

const flags = vi.hoisted(() => ({ showcase: false, training: false, assessment: false }));

vi.mock('$lib/server/config', () => ({
    config: {
        DEFAULT_USER: 'dev-admin',
        TMDB_API_KEY: '',
        MDBLIST_API_KEY: '',
        get FEATURE_PUBLIC_SHOWCASE() {
            return flags.showcase;
        },
        LIVETV_SOURCE: '',
        STREAM_PROXY_URL: '',
        SHOW_DEVELOPER_TOOLS: false,
    },
    features: {
        ffmpegAvailable: true,
        get trainingAssignments() {
            return flags.training;
        },
        get assessment() {
            return flags.assessment;
        },
    },
    devFeaturesEnabled: false,
}));

vi.mock('$lib/server/config/domains/ai.js', () => ({
    getAiConfig: () => ({ hasVoyage: false, hasOpenai: false }),
}));

const mockLoadProviderSearchIndex = vi.fn();
vi.mock('$lib/server/admin/provider-search-index', () => ({
    loadProviderSearchIndex: () => mockLoadProviderSearchIndex(),
}));

// The upload-tab probe is the only raw `sql` call the load makes.
const fakeSql = vi.fn(async () => [{ has: true }]);
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => fakeSql }));

const mockGetNavPins = vi.fn();
const mockUpdateNavPinHref = vi.fn();
vi.mock('$lib/server/database/queries', () => ({
    getNavPins: { all: (...a: unknown[]) => mockGetNavPins(...a) },
    adminNavPins: {
        updateNavPinHref: { execute: (...a: unknown[]) => mockUpdateNavPinHref(...a) },
    },
}));

vi.mock('$lib/server/database/queries/admin-ui-prefs.queries.js', () => ({
    getAdminUiPrefs: async () => null,
}));

const { load } = await import('./+layout.server.js');

type LoadResult = {
    features: Record<string, unknown>;
    navPins: Array<{ href: string; label: string }>;
    providerIndex: unknown[];
    defaultUser?: string;
};

async function runLoad(isAdmin = true): Promise<LoadResult> {
    return (await load({
        locals: { user: { userId: 'u1', username: 'admin', isAdmin }, principal: { isAdmin } },
        parent: async () => ({ features: {} }),
        depends: () => {},
    } as never)) as LoadResult;
}

function pin(href: string, label = href, sort_order = 0) {
    return { href, label, sort_order, created_at: new Date() };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetNavPins.mockResolvedValue([]);
    mockUpdateNavPinHref.mockResolvedValue(undefined);
    mockLoadProviderSearchIndex.mockResolvedValue([]);
});

describe('/admin layout load: nav entries of the private modules', () => {
    const original = process.env.LUMASTRA_PRIVATE_MODULES;
    beforeEach(() => {
        flags.showcase = true;
        flags.training = true;
        flags.assessment = true;
    });
    afterEach(() => {
        flags.showcase = flags.training = flags.assessment = false;
        if (original === undefined) delete process.env.LUMASTRA_PRIVATE_MODULES;
        else process.env.LUMASTRA_PRIVATE_MODULES = original;
    });

    it('with the feature flags on but the private gate off, no dead links: all three are hidden', async () => {
        delete process.env.LUMASTRA_PRIVATE_MODULES;
        const { features } = await runLoad();
        expect(features.showcase).toBe(false);
        expect(features.assessment).toBe(false);
        expect(features.trainingAssignments).toBe(false);
    });

    it('LUMASTRA_PRIVATE_MODULES=all shows them', async () => {
        process.env.LUMASTRA_PRIVATE_MODULES = 'all';
        const { features } = await runLoad();
        expect(features.showcase).toBe(true);
        expect(features.assessment).toBe(true);
        expect(features.trainingAssignments).toBe(true);
    });

    it('a list enables only what it names; training follows the assessment module', async () => {
        process.env.LUMASTRA_PRIVATE_MODULES = 'Showcase';
        let { features } = await runLoad();
        expect(features).toMatchObject({
            showcase: true,
            assessment: false,
            trainingAssignments: false,
        });
        process.env.LUMASTRA_PRIVATE_MODULES = 'assessment';
        ({ features } = await runLoad());
        expect(features).toMatchObject({
            showcase: false,
            assessment: true,
            trainingAssignments: true,
        });
    });

    it('the feature flag still has to be on as well', async () => {
        process.env.LUMASTRA_PRIVATE_MODULES = 'all';
        flags.showcase = false;
        flags.assessment = false;
        const { features } = await runLoad();
        expect(features.showcase).toBe(false);
        expect(features.assessment).toBe(false);
        expect(features.trainingAssignments).toBe(true);
    });
});

describe('/admin layout load', () => {
    it('redirects a non-admin', async () => {
        await expect(runLoad(false)).rejects.toSatisfy(isRedirect);
    });

    it('returns each pin href once when two legacy pins heal to the same page', async () => {
        // Both legacy paths map to /admin/tasks/runs; the renderers key on href.
        mockGetNavPins.mockResolvedValue([
            pin('/admin/runs', 'Runs (old)', 0),
            pin('/admin/operations/runs', 'Runs (older)', 1),
        ]);

        const data = await runLoad();

        expect(data.navPins.map((p) => p.href)).toEqual(['/admin/tasks/runs']);
    });

    it('drops a stored pin that is not an app-relative /admin path', async () => {
        mockGetNavPins.mockResolvedValue([
            pin('//evil.example/admin/users', 'x', 0),
            pin('/admin/users', 'Users', 1),
        ]);

        const data = await runLoad();

        expect(data.navPins.map((p) => p.href)).toEqual(['/admin/users']);
    });

    it('still renders the shell when the provider search index throws', async () => {
        mockLoadProviderSearchIndex.mockRejectedValue(new Error('plugin probe blew up'));

        const data = await runLoad();

        expect(data.providerIndex).toEqual([]);
    });

    it('does not ship DEFAULT_USER outside dev builds', async () => {
        const data = await runLoad();

        expect(data.defaultUser).toBeUndefined();
    });
});
