// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit test — security review 2026-09-12, C18.
 *
 * The `isolation:'worker'` pre-registration rejection (loader.ts's
 * identity/kind/isolation gate inside `importAndRegister`) only ran when the
 * caller supplied `LoadConstraints` — which, before this fix, only the
 * installer's FRESH-install branch did (`external-install/installer.ts`).
 * Boot (`loadExternalPlugins`), hot-reload (`reloadExternalPlugins`), and
 * `enable` all call `loadOneDir` / `loadAndWirePlugin` with NO constraints,
 * so a worker-isolated task that reached the registry any other way (an
 * upgrade staged for restart, or a hand-placed dir matching an existing
 * registry row) loaded cleanly on every one of those paths — the
 * fresh-install gate was the only one closed.
 *
 * `loadOneDir` already fetches the `external_plugins` row for identity/
 * checksum/ABI verification; this pins that it now ALSO derives
 * `{ expectedName: row.name, rejectWorkerIsolation: true }` from that row and
 * passes it to `importAndRegister`, so the isolation gate fires on every
 * load path a registry-managed plugin can take — not only a fresh install.
 *
 * Mocking strategy mirrors `loader-hot-reload.test.ts` (same suite, same
 * loader.ts, already exercises the registry-row + real-temp-file shape):
 * `getExternalPlugin` is mocked to return a registry row directly rather
 * than hitting a real database, and the plugin bundle is a real file on disk
 * so the loader's actual `import()` + SDK-contract detection run for real.
 * `loadAndWirePlugin(dir, sql)` — called with NO constraints, exactly as the
 * boot/reload/enable call sites do — is the entry point under test.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PLUGIN_SDK_ABI } from '@sapd/lumastra-plugin-sdk';

// ── Set env BEFORE loader module loads ─────────────────────────────────────

const pluginsRoot = vi.hoisted(() => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const dir = require('node:fs').mkdtempSync(
        require('node:path').join(require('node:os').tmpdir(), 'lumastra-isolation-gate-'),
    );
    /* eslint-enable @typescript-eslint/no-require-imports */
    process.env.PLUGINS_EXTERNAL_DIR = dir;
    process.env.PLUGINS_ENABLED = 'true';
    return dir as string;
});

// ── Mocks ────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
    hasPluginRegistered: vi.fn<(id: string) => boolean>(() => false),
    getAllProviders: vi.fn<() => unknown[]>(() => []),
    loadProviderSettings: vi.fn(async () => new Map()),
    registerTask: vi.fn(),
    validateAt: vi.fn<(stage: 'startup' | 'reload') => void>(() => undefined),
    getExternalPlugin: vi.fn<(sql: unknown, name: string) => Promise<unknown>>(async () => null),
}));

vi.mock('../../database/queries/metadata-aggregation.queries.js', () => ({
    setEffectiveFieldPriorities: vi.fn(),
}));
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
        registerSubtitleProvider: vi.fn(),
        registerLyricsProvider: vi.fn(),
        registerAuthProvider: vi.fn(),
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
    buildFieldAuthorityConfigFromDefinitions: vi.fn(() => ({
        defaultPriorities: {},
    })),
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
// wireAfterLoad() dynamically imports these two when a dir loaded, to re-run
// the trigger audit and start a worker for the newly-registered task. Both
// are real subsystems with real (slow/network-dependent) module-load side
// effects that have nothing to do with the isolation gate under test here —
// mocked out so this stays a fast, deterministic unit test.
vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    auditTriggerCoverage: vi.fn(),
}));
vi.mock('$lib/server/tasks/runner.js', () => ({
    getTaskRunner: () => null,
}));

import { loadAndWirePlugin } from './loader.js';

// ── Helpers ──────────────────────────────────────────────────────────────

/** A COMPLETE valid TaskDefinition — defineTask runs over it, so a fixture
 * missing a contract-required field would be refused like a real plugin. */
function writeTaskPlugin(dirName: string, id: string, extra = ''): string {
    const dir = path.join(pluginsRoot, dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'index.js'),
        `export default {
            id: '${id}',
            name: '${id}',
            version: '1.0.0',
            processingVersion: 1,
            minAppVersion: '1.0.0',
            capabilities: {},
            resourceClass: 'io',
            ${extra}
            inputSchema: { parse: (x) => x, safeParse: (x) => ({ success: true, data: x }) },
            identityFor: () => 'global',
            execute: async () => ({ success: true, itemsProcessed: 0 }),
        };\n`,
    );
    return dir;
}

function sha256(file: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function clearRoot(): void {
    for (const entry of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            fs.rmSync(path.join(pluginsRoot, entry.name), { recursive: true, force: true });
        }
    }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('loadAndWirePlugin — isolation gate fires on the no-constraints call shape [C18]', () => {
    const sqlStub = {} as never;

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
        mocks.loadProviderSettings.mockClear();
        mocks.registerTask.mockClear();
        mocks.validateAt.mockReset();
        mocks.validateAt.mockReturnValue(undefined);
        mocks.getExternalPlugin.mockReset();
    });

    afterEach(() => {
        clearRoot();
    });

    it('refuses a worker-isolated task via loadAndWirePlugin(dir, sql) with NO constraints — the boot/reload/enable call shape', async () => {
        const dir = writeTaskPlugin(
            'isolation-gate-plugin',
            'isolation-gate-plugin',
            "isolation: 'worker',",
        );
        const entry = path.join(dir, 'index.js');
        mocks.getExternalPlugin.mockImplementation(async () => ({
            name: 'isolation-gate-plugin',
            version: '1.0.0',
            checksum: sha256(entry),
            enabled: true,
            status: 'installed',
            bundle: null,
            sdkAbi: PLUGIN_SDK_ABI,
        }));

        // No third argument — exactly how `loadExternalPlugins()` (boot) and
        // `reloadExternalPlugins()` (hot-reload) call `loadOneDir`, and how
        // `enable` reaches `loadAndWirePlugin` when the manager passes no
        // explicit constraints.
        const res = await loadAndWirePlugin(dir, sqlStub);

        expect(res.loaded).toBe(false);
        expect(res.constraintViolation).toBe(true);
        expect(res.error).toContain("isolation: 'worker' is not supported");
        expect(mocks.registerTask).not.toHaveBeenCalled();
    });

    it('still loads an ordinary (non-worker) registered task via the same no-constraints call shape', async () => {
        const dir = writeTaskPlugin('ordinary-gate-plugin', 'ordinary-gate-plugin');
        const entry = path.join(dir, 'index.js');
        mocks.getExternalPlugin.mockImplementation(async () => ({
            name: 'ordinary-gate-plugin',
            version: '1.0.0',
            checksum: sha256(entry),
            enabled: true,
            status: 'installed',
            bundle: null,
            sdkAbi: PLUGIN_SDK_ABI,
        }));

        const res = await loadAndWirePlugin(dir, sqlStub);

        expect(res.loaded).toBe(true);
        expect(res.constraintViolation).toBeUndefined();
        expect(mocks.registerTask).toHaveBeenCalledTimes(1);
    });
});
