// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit test — hot-load (Variant A) for external plugins.
 *
 * Verifies that `reloadExternalPlugins`:
 *   1. Calls `loadExternalPlugin` ONLY for directories whose derived id is not
 *      already in the registry.
 *   2. Skips directories whose id is already registered (counts them in
 *      `skippedKnown`, does NOT attempt to load).
 *   3. Returns `newlyLoaded` containing the ids of dirs it loaded.
 *
 * The field-authority rewire path is exercised indirectly — when no new
 * provider is registered (the default mock has zero providers), it must NOT
 * be invoked. A separate assertion confirms `loadProviderSettings` was not
 * called.
 *
 * Strategy: `EXTERNAL_PLUGINS_DIR` is captured at module-load time, so we set
 * `process.env.PLUGINS_EXTERNAL_DIR` BEFORE the loader imports (via
 * `vi.hoisted`). Real temp directories on disk drive `discoverExternalPlugins`
 * — the registry's `hasPluginRegistered` is the lever that distinguishes
 * "known" vs "novel".
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type postgres from 'postgres';
import { PLUGIN_SDK_ABI } from '@sapd/lumastra-plugin-sdk';

// ── Set env BEFORE loader module loads ─────────────────────────────────────────

const pluginsRoot = vi.hoisted(() => {
    // `vi.hoisted()` runs before static imports are available, so we use
    // CommonJS `require()` for the bootstrap. The project's
    // `no-require-imports` lint rule is disabled inline for these three
    // lines only — no equivalent ESM idiom works in a hoisted factory.
    /* eslint-disable @typescript-eslint/no-require-imports */
    const dir = require('node:fs').mkdtempSync(
        require('node:path').join(require('node:os').tmpdir(), 'lumastra-hotload-root-'),
    );
    /* eslint-enable @typescript-eslint/no-require-imports */
    process.env.PLUGINS_EXTERNAL_DIR = dir;
    process.env.PLUGINS_ENABLED = 'true';
    return dir as string;
});

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
    hasPluginRegistered: vi.fn<(id: string) => boolean>(() => false),
    getAllProviders: vi.fn<() => unknown[]>(() => []),
    loadProviderSettings: vi.fn<typeof import('./field-authority-loader.js').loadProviderSettings>(
        async () => new Map(),
    ),
    buildSettings: vi.fn<
        typeof import('./field-authority-loader.js').buildFieldAuthorityConfigFromDefinitions
    >(() => ({ defaultPriorities: {} })),
    registerTask: vi.fn(),
    validateAt: vi.fn<(stage: 'startup' | 'reload') => void>(() => undefined),
    getExternalPlugin: vi.fn<(sql: unknown, name: string) => Promise<unknown>>(async () => null),
}));

vi.mock('../../database/queries/metadata-aggregation.queries.js', () => ({
    setEffectiveFieldPriorities: vi.fn(),
}));
// The loader now consults the external-plugins registry per dir. These fixtures
// are registry-LESS legacy drop-ins, so `getExternalPlugin` returns null and the
// loader takes the legacy `package.json#main` path (PLUGINS_REQUIRE_REGISTRY off).
vi.mock('../../database/queries/external-plugins.queries.js', () => ({
    getExternalPlugin: mocks.getExternalPlugin,
}));
vi.mock('$lib/server/tasks/registry.js', () => ({
    ID_PATTERN: /^[a-z][a-z0-9-]*$/,
    registry: {
        registerTask: mocks.registerTask,
        registerProvider: vi.fn(),
        registerTrickplay: vi.fn(),
        registerWatchSync: vi.fn(),
        registerFeature: vi.fn(),
        registerIntegration: vi.fn(),
        registerMediaSource: vi.fn(),
        registerExternalService: vi.fn(),
        getAllProviders: mocks.getAllProviders,
        getAllFeatures: vi.fn(() => []),
        getAllIntegrations: vi.fn(() => []),
        getAllTrickplays: vi.fn(() => []),
        getAllMediaSources: vi.fn(() => []),
        getAllWatchSyncs: vi.fn(() => []),
        getAllExternalServices: vi.fn(() => []),
        getAllTasks: vi.fn(() => []),
        hasPluginRegistered: mocks.hasPluginRegistered,
        validateAt: mocks.validateAt,
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
vi.mock('./field-authority-loader.js', () => ({
    loadProviderSettings: mocks.loadProviderSettings,
    buildFieldAuthorityConfigFromDefinitions: mocks.buildSettings,
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

import { loadAllPlugins, reloadExternalPlugins } from './loader.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function writePluginUnder(root: string, dirName: string, packageName: string): string {
    const dir = path.join(root, dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: packageName, main: 'index.js', type: 'module' }),
    );
    // A COMPLETE TaskDefinition. The loader duck-types on `execute` +
    // `inputSchema` to pick the kind, but then runs defineTask over it, so a
    // fixture missing contract-required fields is refused like a real plugin
    // would be.
    fs.writeFileSync(
        path.join(dir, 'index.js'),
        `export default {
            id: '${packageName}',
            name: '${packageName}',
            version: '1.0.0',
            processingVersion: 1,
            minAppVersion: '1.0.0',
            capabilities: {},
            resourceClass: 'io',
            inputSchema: { parse: (x) => x, safeParse: (x) => ({ success: true, data: x }) },
            identityFor: () => 'global',
            execute: async () => ({ success: true, itemsProcessed: 0 }),
        };\n`,
    );
    return dir;
}

function clearRoot(root: string): void {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            fs.rmSync(path.join(root, entry.name), {
                recursive: true,
                force: true,
            });
        }
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('reloadExternalPlugins — hot-load (Variant A)', () => {
    const sqlStub = {} as never;

    beforeAll(() => {
        // ensure clean slate even if a previous run left dirs behind
        clearRoot(pluginsRoot);
    });

    afterAll(() => {
        try {
            fs.rmSync(pluginsRoot, { recursive: true, force: true });
        } catch {
            // best-effort
        }
    });

    beforeEach(() => {
        mocks.hasPluginRegistered.mockReset();
        mocks.hasPluginRegistered.mockReturnValue(false);
        mocks.getAllProviders.mockReset();
        mocks.getAllProviders.mockReturnValue([]);
        mocks.loadProviderSettings.mockReset();
        mocks.loadProviderSettings.mockResolvedValue(new Map());
        mocks.buildSettings.mockReset();
        mocks.buildSettings.mockReturnValue({ defaultPriorities: {} });
        mocks.getExternalPlugin.mockReset();
        mocks.getExternalPlugin.mockResolvedValue(null);
        mocks.registerTask.mockReset();
        mocks.validateAt.mockReset();
        mocks.validateAt.mockReturnValue(undefined);
    });

    afterEach(() => {
        clearRoot(pluginsRoot);
    });

    it('loads novel dirs and skips dirs whose id is already registered', async () => {
        writePluginUnder(pluginsRoot, 'known-dir', 'known-plugin');
        writePluginUnder(pluginsRoot, 'novel-dir', 'novel-plugin');

        // Registry says `known-plugin` already exists; `novel-plugin` does not.
        mocks.hasPluginRegistered.mockImplementation((id: string) => id === 'known-plugin');

        const result = await reloadExternalPlugins(sqlStub);

        expect(result.discovered).toBe(2);
        expect(result.skippedKnown).toBe(1);
        expect(result.newlyLoaded).toEqual(['novel-plugin']);
        expect(result.loaded).toBe(1);
        expect(result.errors).toBe(0);
        expect(result.sdkImportErrors).toBe(0);

        // Only the novel plugin should have been registered as a task.
        expect(mocks.registerTask).toHaveBeenCalledTimes(1);

        // No new provider was registered → field-authority rewire MUST be a
        // no-op (avoids DB round-trips on the common path).
        expect(mocks.loadProviderSettings).not.toHaveBeenCalled();
    });

    it('returns an empty result when discovery yields no dirs', async () => {
        const result = await reloadExternalPlugins(sqlStub);

        expect(result.discovered).toBe(0);
        expect(result.skippedKnown).toBe(0);
        expect(result.newlyLoaded).toEqual([]);
        expect(mocks.registerTask).not.toHaveBeenCalled();
    });

    it('runs registry validateAt("reload") after registering new plugins and reports validationError: null on success', async () => {
        writePluginUnder(pluginsRoot, 'ok-dir', 'ok-plugin');

        const result = await reloadExternalPlugins(sqlStub);

        expect(mocks.validateAt).toHaveBeenCalledWith('reload');
        expect(result.validationError).toBeNull();
        // A validation failure must not roll back an already-successful load.
        expect(result.newlyLoaded).toEqual(['ok-plugin']);
        expect(result.loaded).toBe(1);
    });

    it('surfaces a registry validateAt("reload") failure via validationError without throwing or discarding the load', async () => {
        writePluginUnder(pluginsRoot, 'bad-dir', 'bad-plugin');
        mocks.validateAt.mockImplementation(() => {
            throw new Error(
                'TaskRegistry: pipeline "x" — task "bad-plugin" declares after: ["missing"] but "missing" is not in this pipeline',
            );
        });

        const result = await reloadExternalPlugins(sqlStub);

        // The bad registry state doesn't crash the hot-load call — it's
        // caught and surfaced, mirroring how per-plugin load errors surface
        // via `errors`/`sdkImportErrors` rather than throwing.
        expect(result.validationError).toContain('not in this pipeline');
        // The plugin itself still loaded — validateAt runs AFTER registration,
        // it does not gate/undo it (registry has no unregister primitive).
        expect(result.newlyLoaded).toEqual(['bad-plugin']);
        expect(result.loaded).toBe(1);
        expect(result.errors).toBe(0);
    });

    it('refuses to load a managed plugin whose persisted ABI is not the host ABI', async () => {
        // The install-time check cannot cover this: the plugin was admitted by
        // whatever host version installed it, which is not necessarily this one.
        writePluginUnder(pluginsRoot, 'abi-dir', 'abi-plugin');
        const entry = path.join(pluginsRoot, 'abi-dir', 'index.js');
        mocks.getExternalPlugin.mockImplementation(async () => ({
            name: 'abi-dir',
            version: '1.0.0',
            checksum: crypto.createHash('sha256').update(fs.readFileSync(entry)).digest('hex'),
            enabled: true,
            status: 'installed',
            bundle: null,
            sdkAbi: PLUGIN_SDK_ABI + 1,
        }));

        const result = await reloadExternalPlugins(sqlStub);

        expect(result.newlyLoaded).toEqual([]);
        expect(result.errors).toBe(1);
        expect(mocks.registerTask).not.toHaveBeenCalled();
    });

    it('loads a managed plugin whose persisted ABI is NULL (installed pre-column) on an ABI-1 host', async () => {
        writePluginUnder(pluginsRoot, 'legacy-abi-dir', 'legacy-abi-plugin');
        const entry = path.join(pluginsRoot, 'legacy-abi-dir', 'index.js');
        mocks.getExternalPlugin.mockImplementation(async () => ({
            name: 'legacy-abi-dir',
            version: '1.0.0',
            checksum: crypto.createHash('sha256').update(fs.readFileSync(entry)).digest('hex'),
            enabled: true,
            status: 'installed',
            bundle: null,
            sdkAbi: null,
        }));

        const result = await reloadExternalPlugins(sqlStub);

        expect(result.errors).toBe(0);
        expect(result.newlyLoaded).toEqual(['legacy-abi-plugin']);
    });

    it('retries failed boot wiring without replaying completed external registration', async () => {
        mocks.getExternalPlugin.mockResolvedValue(null);
        writePluginUnder(pluginsRoot, 'boot-retry', 'boot-retry');
        mocks.loadProviderSettings.mockRejectedValueOnce(new Error('temporary wiring failure'));

        await expect(loadAllPlugins(sqlStub)).rejects.toThrow('temporary wiring failure');
        expect(mocks.registerTask).toHaveBeenCalledTimes(1);
        await loadAllPlugins(sqlStub);
        expect(mocks.registerTask).toHaveBeenCalledTimes(1);
        expect(mocks.loadProviderSettings).toHaveBeenCalledTimes(2);
        await loadAllPlugins(sqlStub);
        expect(mocks.loadProviderSettings).toHaveBeenCalledTimes(2);
    });
    it('retries an unresolved registry lookup without replaying a completed plugin', async () => {
        vi.resetModules();
        const boot = await import('./loader.js');
        writePluginUnder(pluginsRoot, 'healthy-boot', 'healthy-boot');
        writePluginUnder(pluginsRoot, 'retry-boot', 'retry-boot');
        let failed = false;
        let lookups = 0;
        mocks.getExternalPlugin.mockImplementation(async (_sql, name) => {
            if (name === 'retry-boot' && ++lookups === 2 && !failed) {
                failed = true;
                throw new Error('registry SQL unavailable');
            }
            return null;
        });
        await expect(boot.loadAllPlugins(sqlStub)).rejects.toThrow('registry lookup unavailable');
        expect(mocks.registerTask).toHaveBeenCalledTimes(1);
        await boot.loadAllPlugins(sqlStub);
        expect(mocks.registerTask).toHaveBeenCalledTimes(2);
        expect(mocks.registerTask.mock.calls.map(([def]) => def.id)).toEqual([
            'healthy-boot',
            'retry-boot',
        ]);
    });

    it('propagates actual settings SQL failure then installs recovered operator overrides', async () => {
        vi.resetModules();
        const real = await vi.importActual<typeof import('./field-authority-loader.js')>(
            './field-authority-loader.js',
        );
        mocks.loadProviderSettings.mockImplementation(real.loadProviderSettings);
        mocks.buildSettings.mockImplementation(real.buildFieldAuthorityConfigFromDefinitions);
        mocks.getAllProviders.mockReturnValue([
            { id: 'first', metadata: { fieldAuthorities: { overview: 10 } } },
            { id: 'second', metadata: { fieldAuthorities: { overview: 20 } } },
        ]);
        const query = vi
            .fn<(...args: unknown[]) => Promise<unknown[]>>()
            .mockRejectedValueOnce(new Error('settings SQL unavailable'))
            .mockResolvedValue([
                { plugin_id: 'second', key: 'fieldAuthorities', value: { overview: 5 } },
            ]);
        const sql = Object.assign(query, {
            array: (value: unknown): unknown => value,
        }) as unknown as postgres.Sql;
        const { setEffectiveFieldPriorities } =
            await import('../../database/queries/metadata-aggregation.queries.js');
        vi.mocked(setEffectiveFieldPriorities).mockClear();
        const boot = await import('./loader.js');
        await expect(boot.loadAllPlugins(sql)).rejects.toThrow('settings SQL unavailable');
        expect(setEffectiveFieldPriorities).not.toHaveBeenCalled();
        await boot.loadAllPlugins(sql);
        expect(setEffectiveFieldPriorities).toHaveBeenCalledExactlyOnceWith({
            overview: ['second', 'first'],
        });
        expect(query).toHaveBeenCalledTimes(2);
        query.mockRejectedValueOnce(new Error('ordinary request SQL unavailable'));
        await expect(real.loadProviderSettings(sql, ['first'])).resolves.toEqual(new Map());
    });

    it('serializes boot behind admin loading and skips the plugin registered by admin', async () => {
        vi.resetModules();
        const boot = await import('./loader.js');
        const dir = writePluginUnder(pluginsRoot, 'admin-first', 'admin-first');
        let release = (): void => {};
        const lookup = new Promise<void>((resolve) => {
            release = resolve;
        });
        mocks.getExternalPlugin.mockImplementation(async () => {
            await lookup;
            return null;
        });
        const loaded = new Set<string>();
        mocks.registerTask.mockImplementation((def) => {
            loaded.add(def.id);
        });
        mocks.hasPluginRegistered.mockImplementation((id) => loaded.has(id));
        const admin = boot.loadAndWirePlugin(dir, sqlStub);
        const starting = boot.loadAllPlugins(sqlStub);
        expect(boot.loadAllPlugins(sqlStub)).toBe(starting);
        await Promise.resolve();
        expect(mocks.getExternalPlugin).toHaveBeenCalledTimes(1);
        release();
        await admin;
        await starting;
        expect(mocks.registerTask).toHaveBeenCalledTimes(1);
    });
    it('isolates an unreadable managed entry and still loads later healthy plugins without retrying the admission', async () => {
        vi.resetModules();
        const boot = await import('./loader.js');
        const bad = writePluginUnder(pluginsRoot, 'a-unreadable', 'a-unreadable');
        writePluginUnder(pluginsRoot, 'z-healthy', 'z-healthy');
        const entry = path.join(bad, 'index.js');
        const checksum = crypto.createHash('sha256').update(fs.readFileSync(entry)).digest('hex');
        mocks.getExternalPlugin.mockImplementation(async (_sql, name) =>
            name === 'a-unreadable'
                ? {
                      name,
                      version: '1.0.0',
                      checksum,
                      enabled: true,
                      status: 'installed',
                      bundle: null,
                      sdkAbi: PLUGIN_SDK_ABI,
                  }
                : null,
        );
        const read = fs.readFileSync.bind(fs);
        let refused = 0;
        const unreadable = vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
            if (String(args[0]) === entry) {
                refused++;
                throw Object.assign(new Error('permission denied reading managed index'), {
                    code: 'EACCES',
                });
            }
            return read(...args);
        });
        try {
            // Force a later wiring retry too: the retained rejected admission
            // must remain isolated rather than being read or executed again.
            mocks.loadProviderSettings.mockRejectedValueOnce(new Error('settings unavailable'));
            await expect(boot.loadAllPlugins(sqlStub)).rejects.toThrow('settings unavailable');
            await boot.loadAllPlugins(sqlStub);
            expect(refused).toBe(1);
            expect(boot.lastLoadError.get('a-unreadable')).toContain('permission denied');
            expect(mocks.registerTask).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({ id: 'z-healthy' }),
            );
            expect(mocks.loadProviderSettings).toHaveBeenCalledTimes(2);
        } finally {
            unreadable.mockRestore();
        }
    });
});
