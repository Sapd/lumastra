// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The admin listing probes third-party code to decide what to show.
 *
 * `isConfigured` / `isAvailable` / `isEnabled` are plugin-supplied, so each is
 * wrapped — and each is wrapped SEPARATELY. That separation is the property
 * worth pinning: a shared try/catch would let a throwing `isEnabled` force
 * `configured = false` even though `isConfigured` had already answered, and the
 * operator would see a correctly-configured plugin reported as unconfigured.
 * The code carries a comment saying so and had no test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const empty = {
    getAllProviders: () => [],
    getAllTasks: () => [],
    getAllFeatures: () => [],
    getAllIntegrations: () => [],
    getAllTrickplays: () => [],
    getAllWatchSyncs: () => [],
    getAllExternalServices: () => [],
    getAllMediaSources: () => [],
};

let overrides: Partial<typeof empty> = {};
vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: new Proxy(
        {},
        {
            get: (_t, prop: string) =>
                (overrides as Record<string, unknown>)[prop] ??
                (empty as Record<string, unknown>)[prop] ??
                (() => []),
        },
    ),
}));

vi.mock('$lib/server/tasks/plugin-context.js', () => ({
    buildPluginContext: () => ({ logger: { warn: vi.fn(), info: vi.fn() } }),
}));

vi.mock('../../utils/logger.js', () => ({
    Logger: { for: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { listAdminProviders } from './admin-providers-listing.js';

beforeEach(() => {
    overrides = {};
});

type Row = Awaited<ReturnType<typeof listAdminProviders>>[number];
const find = (rows: Row[], id: string): Row | undefined => rows.find((r) => r.provider === id);

describe('external service probes', () => {
    it('reports a configured service as configured', async () => {
        overrides = {
            getAllExternalServices: () =>
                [{ id: 'svc', name: 'Svc', isConfigured: async () => true }] as never,
        };
        expect(find(await listAdminProviders(), 'svc')?.configured).toBe(true);
    });

    it('falls back to isAvailable when isConfigured is absent', async () => {
        overrides = {
            getAllExternalServices: () =>
                [{ id: 'svc', name: 'Svc', isAvailable: async () => true }] as never,
        };
        expect(find(await listAdminProviders(), 'svc')?.configured).toBe(true);
    });

    it('a THROWING probe degrades to unconfigured instead of failing the whole listing', async () => {
        overrides = {
            getAllExternalServices: () =>
                [
                    {
                        id: 'boom',
                        name: 'Boom',
                        isConfigured: async () => {
                            throw new Error('nope');
                        },
                    },
                    { id: 'fine', name: 'Fine', isConfigured: async () => true },
                ] as never,
        };
        const rows = await listAdminProviders();
        expect(find(rows, 'boom')?.configured).toBe(false);
        // The listing is the operator's only view of what is installed — one
        // bad plugin must not empty it.
        expect(find(rows, 'fine')?.configured).toBe(true);
    });
});

describe('media source probes — where the two questions are asked separately', () => {
    // `externalServiceToEntry` has a single probe and hardcodes `enabled: true`;
    // it is `newMediaSourceToEntry` that asks BOTH isConfigured and isEnabled,
    // each in its own try/catch. Asserting the separation anywhere else passes
    // for the wrong reason.
    it('a throwing isEnabled does NOT drag configured down with it', async () => {
        overrides = {
            getAllMediaSources: () =>
                [
                    {
                        id: 'src',
                        name: 'Src',
                        capabilities: {},
                        isConfigured: async () => true,
                        isEnabled: async () => {
                            throw new Error('nope');
                        },
                    },
                ] as never,
        };
        // A shared catch would report a correctly-configured source as
        // unconfigured because an unrelated probe failed.
        expect(find(await listAdminProviders(), 'src')?.configured).toBe(true);
    });

    it('a throwing isConfigured still leaves isEnabled free to answer', async () => {
        overrides = {
            getAllMediaSources: () =>
                [
                    {
                        id: 'src',
                        name: 'Src',
                        capabilities: {},
                        isConfigured: async () => {
                            throw new Error('nope');
                        },
                        isEnabled: async () => true,
                    },
                ] as never,
        };
        const row = find(await listAdminProviders(), 'src');
        expect(row?.configured).toBe(false);
        expect(row?.enabled).toBe(true);
    });
});

describe('id collisions across contract types', () => {
    it('lists one row, not two, when an id is registered under two types', async () => {
        overrides = {
            getAllExternalServices: () => [{ id: 'dupe', name: 'A' }] as never,
            getAllTrickplays: () => [{ id: 'dupe', name: 'B', capabilities: {} }] as never,
        };
        const rows = await listAdminProviders();
        expect(rows.filter((r) => r.provider === 'dupe')).toHaveLength(1);
    });
});

describe('what the listing carries', () => {
    it('lists no plain task or feature — they are not providers', async () => {
        overrides = {
            getAllTasks: () =>
                [{ id: 'file-library-scan', name: 'Scan', capabilities: {} }] as never,
            getAllFeatures: () => [{ id: 'holiday' }] as never,
            getAllIntegrations: () => [{ id: 'discogs', capabilities: {} }] as never,
        };
        const rows = await listAdminProviders();
        expect(rows.map((r) => r.provider)).toEqual(['discogs']);
        expect(rows[0]).toMatchObject({ category: 'integration', kind: 'integration' });
    });

    it('categorises a trickplay provider as playback, not integration', async () => {
        overrides = {
            getAllTrickplays: () => [{ id: 'local-trickplay', capabilities: {} }] as never,
        };
        const rows = await listAdminProviders();
        expect(rows[0]).toMatchObject({ category: 'playback', kind: 'trickplay' });
    });
});
