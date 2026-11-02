// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit test — external plugins are held to the SDK's own validation rules.
 *
 * The `defineX` helpers validate every rule the contracts declare, but a
 * builtin gets that for free (it calls them) and an external plugin never did:
 * the SDK is types-only at runtime, so an external author exports a plain
 * object that reaches the loader having been checked by nothing but duck-typing
 * on a method name.
 *
 * The visible consequence was `capabilities.browserUi` — the flag that is
 * supposed to disclose "this plugin executes its own JS in your dashboard" was
 * enforced solely inside `defineFeature()`, i.e. solely for the plugins that
 * were never the concern. The host now runs the matching validator itself.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('../../database/queries/metadata-aggregation.queries.js', () => ({
    setEffectiveFieldPriorities: vi.fn(),
}));

const { registerTask, registerFeature } = vi.hoisted(() => ({
    registerTask: vi.fn(),
    registerFeature: vi.fn(),
}));

vi.mock('$lib/server/tasks/registry.js', () => ({
    ID_PATTERN: /^[a-z][a-z0-9-]*$/,
    registry: {
        registerTask,
        registerFeature,
        hasPluginRegistered: vi.fn((_id: string) => false),
        registerProvider: vi.fn(),
        registerTrickplay: vi.fn(),
        registerWatchSync: vi.fn(),
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

const { mockError } = vi.hoisted(() => ({ mockError: vi.fn() }));
vi.mock('../../utils/logger.js', () => ({
    Logger: {
        for: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: mockError }),
    },
}));

import { loadExternalPlugin } from './loader.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function writePlugin(name: string, body: string): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumastra-sdk-validation-'));
    tempDirs.push(root);
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
    fs.writeFileSync(path.join(dir, 'index.js'), body);
    return dir;
}

/** A feature def literal; `extra` is spliced in at the top level. */
const FEATURE_SRC = (id: string, extra: string): string => `{
    id: '${id}',
    routes: [{ method: 'GET', path: '/ping', handler: async function () { return null; } }],
    ${extra}
}`;

/** A task def that satisfies every defineTask rule. */
const VALID_TASK_SRC = (id: string): string => `{
    id: '${id}',
    name: '${id}',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '1.0.0',
    capabilities: {},
    resourceClass: 'io',
    inputSchema: {
        parse: function (v) { return v; },
        safeParse: function (v) { return { success: true, data: v }; },
    },
    identityFor: function () { return 'global'; },
    execute: async function () { return { success: true }; },
}`;

afterEach(() => {
    registerTask.mockClear();
    registerFeature.mockClear();
    mockError.mockClear();
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

describe('loadExternalPlugin — SDK validation runs host-side', () => {
    it('refuses a feature contributing widgets without capabilities.browserUi', async () => {
        const dir = writePlugin(
            'sneaky',
            `module.exports = ${FEATURE_SRC(
                'sneaky',
                `widgets: [{ id: 'w', title: 'W', entry: '/widget.js' }],`,
            )};\n`,
        );

        const loaded = await loadExternalPlugin(dir);

        expect(loaded).toBe(false);
        expect(registerFeature).not.toHaveBeenCalled();
    });

    it('accepts the same feature once it declares browserUi', async () => {
        const dir = writePlugin(
            'honest',
            `module.exports = ${FEATURE_SRC(
                'honest',
                `capabilities: { browserUi: true },
                 widgets: [{ id: 'w', title: 'W', entry: '/widget.js' }],`,
            )};\n`,
        );

        const loaded = await loadExternalPlugin(dir);

        expect(loaded).toBe(true);
        expect(registerFeature).toHaveBeenCalledTimes(1);
    });

    it('refuses a widget that declares no entry path', async () => {
        const dir = writePlugin(
            'noentry',
            `module.exports = ${FEATURE_SRC(
                'noentry',
                `capabilities: { browserUi: true },
                 widgets: [{ id: 'w', title: 'W' }],`,
            )};\n`,
        );

        expect(await loadExternalPlugin(dir)).toBe(false);
        expect(registerFeature).not.toHaveBeenCalled();
    });

    it('refuses a task missing contract-required fields', async () => {
        // The shape the loader duck-types on (`execute` + `inputSchema`) is a
        // fraction of what TaskDefinition actually requires.
        const dir = writePlugin(
            'thin',
            `module.exports = { id: 'thin', inputSchema: {}, execute: async function () {} };\n`,
        );

        expect(await loadExternalPlugin(dir)).toBe(false);
        expect(registerTask).not.toHaveBeenCalled();
    });

    it('accepts a task that satisfies the whole contract', async () => {
        const dir = writePlugin('complete', `module.exports = ${VALID_TASK_SRC('complete')};\n`);

        expect(await loadExternalPlugin(dir)).toBe(true);
        expect(registerTask).toHaveBeenCalledTimes(1);
    });

    it('registers nothing when one element of a bundle fails validation', async () => {
        const dir = writePlugin(
            'mixed',
            `module.exports = {
                tasks: [${VALID_TASK_SRC('mixed')}],
                features: [${FEATURE_SRC(
                    'mixed-ui',
                    `widgets: [{ id: 'w', title: 'W', entry: '/widget.js' }],`,
                )}],
            };\n`,
        );

        const loaded = await loadExternalPlugin(dir);

        expect(loaded).toBe(false);
        // Validation must run over the WHOLE bundle before anything registers.
        expect(registerTask).not.toHaveBeenCalled();
        expect(registerFeature).not.toHaveBeenCalled();
    });

    it('names the failing rule in the load error', async () => {
        const dir = writePlugin(
            'diagnose',
            `module.exports = ${FEATURE_SRC(
                'diagnose',
                `widgets: [{ id: 'w', title: 'W', entry: '/widget.js' }],`,
            )};\n`,
        );

        await loadExternalPlugin(dir);

        const logged = mockError.mock.calls
            .map((args) =>
                args.map((a) => (a instanceof Error ? a.message : JSON.stringify(a))).join(' '),
            )
            .join('\n');
        // An operator gets a fixable message, not "failed to load".
        expect(logged).toContain('browserUi');
    });
});
