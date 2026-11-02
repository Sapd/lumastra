// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit test — multi-contract plugins (one bundle, several contracts).
 *
 * A default export shaped like the SDK's `PluginDefinition` (`{ tasks: [],
 * watchSyncs: [], … }`) must register EVERY element it carries, so a plugin
 * that wants a watch-sync plus its backfill task is one install rather than
 * three.
 *
 * Registration is all-or-nothing: there is no runtime unload, so a bundle
 * whose third element is invalid must not leave its first two registered.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('../../database/queries/metadata-aggregation.queries.js', () => ({
    setEffectiveFieldPriorities: vi.fn(),
}));

const { registerTask, registerWatchSync, registerFeature, hasPluginRegistered } = vi.hoisted(
    () => ({
        registerTask: vi.fn(),
        registerWatchSync: vi.fn(),
        registerFeature: vi.fn(),
        hasPluginRegistered: vi.fn((_id: string) => false),
    }),
);

vi.mock('$lib/server/tasks/registry.js', () => ({
    ID_PATTERN: /^[a-z][a-z0-9-]*$/,
    registry: {
        registerTask,
        registerWatchSync,
        registerFeature,
        hasPluginRegistered,
        registerProvider: vi.fn(),
        registerTrickplay: vi.fn(),
        registerIntegration: vi.fn(),
        registerMediaSource: vi.fn(),
        registerExternalService: vi.fn(),
        getAllProviders: vi.fn(() => []),
        getAllFeatures: vi.fn(() => []),
        getAllIntegrations: vi.fn(() => []),
        getAllTrickplays: vi.fn(() => []),
        getAllMediaSources: vi.fn(() => []),
        getAllWatchSyncs: vi.fn(() => []),
        getAllExternalServices: vi.fn(() => []),
        getAllTasks: vi.fn(() => []),
    },
}));
vi.mock('../../providers/normalize.js', () => ({
    registerProviderNormalizer: vi.fn(),
    unregisterProviderNormalizer: vi.fn(),
}));
vi.mock('../../providers/encode-id.js', () => ({
    registerProviderEncoder: vi.fn(),
    unregisterProviderEncoder: vi.fn(),
}));
vi.mock('../../utils/logger.js', () => ({
    Logger: {
        for: () => ({
            info: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        }),
    },
}));

import { loadExternalPlugin, detectSdkDefinitions } from './loader.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

/**
 * Write a plugin into `<tmp>/<name>/`. The directory basename matters: it is
 * the plugin's identity everywhere in the host, so the fixture must name the
 * directory after the plugin exactly as an install does.
 */
function writePlugin(name: string, body: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumastra-multi-contract-'));
    tempDirs.push(root);
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
    fs.writeFileSync(path.join(dir, 'index.js'), body);
    return dir;
}

// The loader runs the SDK validators over every detected contract, so these
// fixtures must be COMPLETE definitions, not merely detectable shapes.

/** A task def satisfying defineTask. */
const TASK_SRC = (id: string): string =>
    `{
        id: '${id}',
        name: '${id}',
        version: '1.0.0',
        processingVersion: 1,
        minAppVersion: '1.0.0',
        capabilities: {},
        resourceClass: 'io',
        inputSchema: { parse: function (v) { return v; }, safeParse: function (v) { return { success: true, data: v }; } },
        identityFor: function () { return 'global'; },
        execute: async function () { return { success: true }; },
    }`;

/** A watch-sync def satisfying defineWatchSync. */
const WATCH_SYNC_SRC = (id: string): string =>
    `{
        id: '${id}',
        name: '${id}',
        version: '1.0.0',
        providerName: '${id}',
        isAvailable: async function () { return true; },
        resolveIds: async function () { return []; },
        pushWatchState: async function () { return { pushed: 0 }; },
    }`;

afterEach(() => {
    registerTask.mockClear();
    registerWatchSync.mockClear();
    registerFeature.mockClear();
    hasPluginRegistered.mockReturnValue(false);
    for (const dir of tempDirs) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            // best-effort
        }
    }
    tempDirs.length = 0;
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('detectSdkDefinitions', () => {
    it('returns every contract carried by a PluginDefinition-shaped export', () => {
        const detected = detectSdkDefinitions({
            tasks: [{ id: 'trakt-backfill', inputSchema: {}, execute: () => {} }],
            watchSyncs: [{ id: 'trakt', pushWatchState: () => {} }],
        });

        expect(detected?.map((d) => d.kind)).toEqual(['task', 'watch-sync']);
        expect(detected?.map((d) => d.def.id)).toEqual(['trakt-backfill', 'trakt']);
    });

    it('still returns a single-element list for a bare single-contract export', () => {
        const detected = detectSdkDefinitions({
            id: 'solo',
            inputSchema: {},
            execute: () => {},
        });

        expect(detected).toHaveLength(1);
        expect(detected?.[0].kind).toBe('task');
    });

    it('detects a subtitle provider rather than a metadata provider', () => {
        // Both shapes carry `search`. The metadata-provider branch matches on
        // `search` ALONE, so without explicit ordering a subtitle provider is
        // swallowed by it and registered as the wrong contract entirely.
        const detected = detectSdkDefinitions({
            id: 'opensubs',
            search: async () => [],
            download: async () => ({ content: '', format: 'srt' }),
        });

        expect(detected?.[0].kind).toBe('subtitle-provider');
    });

    it('still detects a metadata provider that has search but no download', () => {
        const detected = detectSdkDefinitions({
            id: 'tmdb',
            search: async () => [],
            detail: async () => ({}),
        });

        expect(detected?.[0].kind).toBe('provider');
    });

    it('returns null for an aggregate whose every contract array is empty', () => {
        expect(detectSdkDefinitions({ tasks: [], watchSyncs: [] })).toBeNull();
    });

    it('returns null when an aggregate carries an element of no known shape', () => {
        expect(detectSdkDefinitions({ tasks: [{ id: 'nope', notAContract: true }] })).toBeNull();
    });
});

describe('loadExternalPlugin — multi-contract bundle', () => {
    it('registers every contract in the bundle', async () => {
        const dir = writePlugin(
            'trakt',
            `module.exports = {
                tasks: [${TASK_SRC('trakt-backfill')}],
                watchSyncs: [${WATCH_SYNC_SRC('trakt')}],
            };\n`,
        );

        const loaded = await loadExternalPlugin(dir);

        expect(loaded).toBe(true);
        expect(registerTask).toHaveBeenCalledTimes(1);
        expect(registerWatchSync).toHaveBeenCalledTimes(1);
    });

    it('registers nothing when a later element has a malformed id', async () => {
        const dir = writePlugin(
            'partial',
            `module.exports = {
                tasks: [${TASK_SRC('partial-ok')}],
                watchSyncs: [${WATCH_SYNC_SRC('Bad-ID')}],
            };\n`,
        );

        const loaded = await loadExternalPlugin(dir);

        expect(loaded).toBe(false);
        // The valid first element must NOT have been registered — there is no
        // unload primitive, so a half-registered bundle is unrecoverable.
        expect(registerTask).not.toHaveBeenCalled();
        expect(registerWatchSync).not.toHaveBeenCalled();
    });

    it('registers nothing when two elements claim the same id', async () => {
        const dir = writePlugin(
            'dup',
            `module.exports = {
                tasks: [${TASK_SRC('dup')}],
                watchSyncs: [${WATCH_SYNC_SRC('dup')}],
            };\n`,
        );

        const loaded = await loadExternalPlugin(dir);

        expect(loaded).toBe(false);
        expect(registerTask).not.toHaveBeenCalled();
        expect(registerWatchSync).not.toHaveBeenCalled();
    });

    it('rejects a bundle where no contract claims the plugin directory name', async () => {
        // The whole host identifies an installed plugin by its directory name
        // (`hasPluginRegistered(name)` decides loaded-vs-not, fresh-vs-upgrade,
        // and the admin card's kind badge). A bundle that registers only
        // `<name>-…` ids would be invisible to every one of those probes, so
        // one contract must anchor the name itself.
        const dir = writePlugin(
            'anchorless',
            `module.exports = {
                tasks: [${TASK_SRC('anchorless-one')}],
                watchSyncs: [${WATCH_SYNC_SRC('anchorless-two')}],
            };\n`,
        );

        const loaded = await loadExternalPlugin(dir);

        expect(loaded).toBe(false);
        expect(registerTask).not.toHaveBeenCalled();
        expect(registerWatchSync).not.toHaveBeenCalled();
    });

    it('accepts a bundle anchored by a contract named after the directory', async () => {
        const dir = writePlugin(
            'anchored',
            `module.exports = {
                tasks: [${TASK_SRC('anchored-backfill')}],
                watchSyncs: [${WATCH_SYNC_SRC('anchored')}],
            };\n`,
        );

        const loaded = await loadExternalPlugin(dir);

        expect(loaded).toBe(true);
        expect(registerTask).toHaveBeenCalledTimes(1);
        expect(registerWatchSync).toHaveBeenCalledTimes(1);
    });

    it('rejects an aggregate id outside the plugin namespace', async () => {
        const dir = writePlugin(
            'nsplugin',
            `module.exports = {
                tasks: [${TASK_SRC('nsplugin')}],
                watchSyncs: [${WATCH_SYNC_SRC('someone-elses-id')}],
            };\n`,
        );

        const loaded = await loadExternalPlugin(dir);

        expect(loaded).toBe(false);
        expect(registerTask).not.toHaveBeenCalled();
    });

    it('registers nothing when an id is already claimed by another plugin', async () => {
        hasPluginRegistered.mockImplementation((id: string) => id === 'squat-two');
        const dir = writePlugin(
            'squat',
            `module.exports = {
                tasks: [${TASK_SRC('squat')}],
                watchSyncs: [${WATCH_SYNC_SRC('squat-two')}],
            };\n`,
        );

        const loaded = await loadExternalPlugin(dir);

        expect(loaded).toBe(false);
        expect(registerTask).not.toHaveBeenCalled();
    });
});
