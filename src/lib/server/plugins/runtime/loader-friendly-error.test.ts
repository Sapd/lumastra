// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit test — external plugin runtime SDK import → friendly error (Test 3).
 *
 * An external plugin that does `import { defineTask } from '@sapd/lumastra-plugin-sdk'`
 * at module-level will throw ERR_MODULE_NOT_FOUND when dynamically imported by
 * the loader (because the SDK is types-only and not published as a runtime package).
 *
 * loadExternalPlugin must catch this and log a friendly hint, not just the
 * generic "Failed to load external plugin" message.
 *
 * TODO: The current loader (loader.ts) logs the raw error via `logger.error`
 * without detecting ERR_MODULE_NOT_FOUND + '@sapd/lumastra-plugin-sdk' and
 * appending a friendly hint. The .skip below tracks that missing fix.
 * When the fix lands:
 *   1. Add a check in loadExternalPlugin's catch block for
 *      `error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('@sapd/lumastra-plugin-sdk')`
 *   2. Log an additional warning with the types-only hint.
 *   3. Remove the .skip here.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Mocks ──────────────────────────────────────────────────────────────────────

// Stub downstream registries and loaders that loader.ts touches at import time.
vi.mock('../../database/queries/metadata-aggregation.queries.js', () => ({
    setEffectiveFieldPriorities: vi.fn(),
}));
vi.mock('$lib/server/tasks/registry.js', () => ({
    // ID_PATTERN is consumed at module-eval time by the manifest schema
    // (external-install/manifest.ts), which the loader now imports transitively
    // via bundle-artifact.ts. Keep it in sync with the real registry export.
    ID_PATTERN: /^[a-z][a-z0-9-]*$/,
    registry: {
        registerTask: vi.fn(),
        registerProvider: vi.fn(),
        registerTrickplay: vi.fn(),
        registerWatchSync: vi.fn(),
        registerFeature: vi.fn(),
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

// Capture logger calls to inspect error messages. Use `vi.hoisted()` so the
// reference exists when the hoisted `vi.mock()` factory runs at import time.
const { mockError } = vi.hoisted(() => ({ mockError: vi.fn() }));
vi.mock('../../utils/logger.js', () => ({
    Logger: {
        for: () => ({
            info: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: mockError,
        }),
    },
}));

import { loadExternalPlugin } from './loader.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lumastra-plugin-test-'));
}

function writeTempPlugin(dir: string, code: string, pkg?: Record<string, unknown>): void {
    if (pkg) {
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    }
    fs.writeFileSync(path.join(dir, 'index.js'), code);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('loadExternalPlugin — runtime SDK import', () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        mockError.mockClear();
        for (const dir of tempDirs) {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch {
                // best-effort cleanup
            }
        }
        tempDirs.length = 0;
    });

    // TODO: Remove .skip when the loader detects ERR_MODULE_NOT_FOUND for
    // '@sapd/lumastra-plugin-sdk' and logs the types-only hint message.
    it.skip('logs a friendly "types-only / use import type" hint when the plugin imports the SDK at runtime', async () => {
        const dir = makeTempDir();
        tempDirs.push(dir);

        // This import will throw ERR_MODULE_NOT_FOUND because the SDK is
        // not published as a runtime npm package in the plugin's node_modules.
        writeTempPlugin(
            dir,
            `import { defineTask } from '@sapd/lumastra-plugin-sdk';\nexport default { id: 'bad', name: 'Bad' };\n`,
            { name: 'bad-plugin', main: 'index.js', type: 'module' },
        );

        const result = await loadExternalPlugin(dir);
        // Loader returns false on any load failure.
        expect(result).toBe(false);

        // The logger.error (or logger.warn) call should include the friendly
        // SDK hint. When the fix lands, one of the two calls will contain it.
        expect(mockError).toHaveBeenCalled();
        const allLogText = mockError.mock.calls
            .flat()
            .map((a) => (a instanceof Error ? a.message : JSON.stringify(a ?? '')))
            .join('\n');
        expect(allLogText).toMatch(/types.only|import type|lumastra-plugin-sdk/i);
    });

    it('returns false on a module-level throw without crashing the process', async () => {
        const dir = makeTempDir();
        tempDirs.push(dir);

        // Use a CJS throw so the dynamic import fails at evaluation time.
        writeTempPlugin(dir, `throw new Error('init bomb');\nmodule.exports = {};\n`, {
            name: 'throwing-plugin',
            main: 'index.js',
        });

        const result = await loadExternalPlugin(dir);
        // Must return false, not throw, and not exit the process.
        expect(result).toBe(false);
        expect(mockError).toHaveBeenCalled();
    });
});
