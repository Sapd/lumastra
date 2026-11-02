// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Registry-less drop-in plugins in the admin list.
 *
 * A drop-in has no `external_plugins` row, so the listing — which was built
 * purely from those rows — showed nothing for it. On the production box every
 * loaded plugin is a drop-in, which meant the admin plugin page listed zero of
 * the plugins actually running.
 *
 * They are listed READ-ONLY on purpose: with no row there is nothing for
 * enable/disable/uninstall to act on (those endpoints look up a row and 404),
 * so offering the buttons would be offering failure. The card has to say the
 * plugin is managed on disk instead.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let rows: unknown[] = [];
vi.mock('$lib/server/database/queries/external-plugins.queries.js', () => ({
    listExternalPluginsIncludingPendingRemoval: vi.fn(async () => rows),
    getExternalPlugin: vi.fn(async () => null),
}));

let dropIns: Array<{
    name: string;
    version?: string;
    origin: 'bundled' | 'drop-in';
    shadowedCopy?: boolean;
}> = [];
vi.mock('$lib/server/plugins/runtime/loader.js', () => ({
    lastLoadError: new Map<string, string>(),
    listDropInPlugins: vi.fn(async () => dropIns),
}));

let registered = new Set<string>();
let featureVersion: string | undefined;
vi.mock('$lib/server/tasks/registry.js', () => ({
    ID_PATTERN: /^[a-z][a-z0-9-]*$/,
    registry: {
        hasPluginRegistered: (id: string) => registered.has(id),
        getTask: () => undefined,
        getProvider: () => undefined,
        getTrickplay: () => undefined,
        getWatchSync: () => undefined,
        getFeature: (id: string) =>
            id === 'shoutbox' ? { id, version: featureVersion } : undefined,
        getIntegration: () => undefined,
        getExternalService: () => undefined,
        getMediaSource: () => undefined,
        getSubtitleProvider: () => undefined,
        getLyricsProvider: () => undefined,
        getAuthProvider: () => undefined,
    },
}));

vi.mock('$lib/server/plugins/external-install/trust-anchors.js', () => ({
    buildEffectiveTrustedKeys: () => [],
    classifyKeyId: () => undefined,
}));

import { listExternalPluginsWithState } from './external-plugin-manager.service.js';

const sql = {} as never;

beforeEach(() => {
    rows = [];
    dropIns = [];
    registered = new Set();
    featureVersion = undefined;
});

describe('drop-ins appear', () => {
    it('lists a loaded drop-in that has no registry row', async () => {
        dropIns = [{ name: 'shoutbox', version: '2.1.0', origin: 'drop-in' }];
        registered.add('shoutbox');
        const { items } = await listExternalPluginsWithState(sql);
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ id: 'shoutbox', loaded: true, version: '2.1.0' });
    });

    it('reports its contract kind, so the card is not blank', async () => {
        dropIns = [{ name: 'shoutbox', origin: 'drop-in' }];
        registered.add('shoutbox');
        const { items } = await listExternalPluginsWithState(sql);
        expect(items[0].kind).toBe('feature');
    });

    it('takes the version from the DEFINITION the plugin registered', async () => {
        // A drop-in has no manifest, so package.json is usually absent — but
        // the loaded definition declares a version, and that is the number an
        // operator should see. Reading only package.json is why every drop-in
        // on the production box rendered as "vunknown".
        dropIns = [{ name: 'shoutbox', origin: 'drop-in' }];
        featureVersion = '2.4.0';
        registered.add('shoutbox');
        const { items } = await listExternalPluginsWithState(sql);
        expect(items[0].version).toBe('2.4.0');
    });

    it('prefers the definition over a package.json that disagrees', async () => {
        // The definition is what actually loaded; package.json is metadata
        // beside it and can be stale.
        dropIns = [{ name: 'shoutbox', version: '1.0.0-from-pkg', origin: 'drop-in' }];
        featureVersion = '2.4.0';
        registered.add('shoutbox');
        const { items } = await listExternalPluginsWithState(sql);
        expect(items[0].version).toBe('2.4.0');
    });

    it('falls back to package.json when the contract declares no version', async () => {
        dropIns = [{ name: 'shoutbox', version: '1.0.0-from-pkg', origin: 'drop-in' }];
        registered.add('shoutbox');
        const { items } = await listExternalPluginsWithState(sql);
        expect(items[0].version).toBe('1.0.0-from-pkg');
    });

    it('reports an EMPTY version when there is genuinely none — never a fake one', async () => {
        // '1.0.0' would be a fabrication and 'unknown' renders as "vunknown".
        // The UI decides how to show absence; the data layer must not invent.
        dropIns = [{ name: 'shoutbox', origin: 'drop-in' }];
        registered.add('shoutbox');
        const { items } = await listExternalPluginsWithState(sql);
        expect(items[0].version).toBe('');
    });

    it('shows a drop-in that FAILED to load, with loaded=false', async () => {
        // The most useful case: without this, a broken drop-in is invisible and
        // the operator has only the boot log to go on.
        dropIns = [{ name: 'broken', origin: 'drop-in' }];
        const { items } = await listExternalPluginsWithState(sql);
        expect(items[0]).toMatchObject({ id: 'broken', loaded: false });
    });
});

describe('drop-ins are marked as unmanaged', () => {
    it('carries source=drop-in so the UI can withhold lifecycle controls', async () => {
        dropIns = [{ name: 'shoutbox', origin: 'drop-in' }];
        registered.add('shoutbox');
        const { items } = await listExternalPluginsWithState(sql);
        expect(items[0].source).toBe('drop-in');
    });

    it('marks registry-managed rows as source=registry', async () => {
        rows = [
            {
                name: 'signed-one',
                version: '1.0.0',
                enabled: true,
                status: 'installed',
                capabilities: {},
                bundle: null,
                signingKeyId: 'k1',
                sdkAbi: 1,
                installedAt: '2026-01-01',
                updatedAt: '2026-01-01',
            },
        ];
        registered.add('signed-one');
        const { items } = await listExternalPluginsWithState(sql);
        expect(items[0].source).toBe('registry');
    });

    it('never reports a drop-in as needing a restart — there is nothing to toggle', async () => {
        dropIns = [{ name: 'shoutbox', origin: 'drop-in' }];
        registered.add('shoutbox');
        const { items } = await listExternalPluginsWithState(sql);
        expect(items[0].restartRequired).toBe(false);
    });
});

describe('the two sources do not collide', () => {
    it('a name with a registry row is listed ONCE, as registry-managed', async () => {
        // Belt and braces: `listDropInPlugins` already excludes rows, but a
        // duplicate here would render two cards for one plugin and give the
        // {#each} two identical keys.
        rows = [
            {
                name: 'shoutbox',
                version: '1.0.0',
                enabled: true,
                status: 'installed',
                capabilities: {},
                bundle: null,
                signingKeyId: null,
                sdkAbi: 1,
                installedAt: '2026-01-01',
                updatedAt: '2026-01-01',
            },
        ];
        dropIns = [{ name: 'shoutbox', origin: 'drop-in' }];
        registered.add('shoutbox');
        const { items } = await listExternalPluginsWithState(sql);
        expect(items).toHaveLength(1);
        expect(items[0].source).toBe('registry');
    });

    it('carries source=bundled for a plugin that ships in the image', async () => {
        dropIns = [{ name: 'shoutbox', origin: 'bundled', shadowedCopy: true }];
        const { items } = await listExternalPluginsWithState(sql);
        expect(items[0]).toMatchObject({ source: 'bundled', shadowedCopy: true });
    });
});
